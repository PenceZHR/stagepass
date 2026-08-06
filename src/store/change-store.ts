import type Database from "better-sqlite3";

import {
  assertStateValid,
  transition,
  type ChangeAction,
  type ChangeState,
  type PhaseStatus,
} from "../domain/change-state";
import {
  DEFAULT_GRAPH,
  isPhase,
  phaseGraphOf,
  type Phase,
  type PhaseGraph,
} from "../domain/phase";

/**
 * The only code in the tree that writes a Change's position.
 *
 * Every transition is applied by `transition()` -- the pure machine -- and
 * persisted together with its ledger row in one transaction. There is no
 * second path, and `ck_changes_ledger` makes the database refuse one.
 *
 * ## Why the state is re-validated on the way out of the database
 *
 * A row is not automatically a state the machine would have produced. It could
 * predate a schema change, or have been edited by hand. `assertStateValid`
 * runs on read so a state the machine could not have reached is a loud failure
 * at the moment it is loaded, not a silent input to the next transition.
 */

export class ChangeNotFoundError extends Error {
  constructor(readonly changeId: string) {
    super(`No Change with id ${changeId}`);
    this.name = "ChangeNotFoundError";
  }
}

export interface ChangeRecord {
  readonly id: string;
  /** The project it belongs to, or null. Nothing decidable reads this. */
  readonly projectId: string | null;
  /** What a person calls it, or null. Nothing decidable reads this either. */
  readonly title: string | null;
  /**
   * 人到底要什么，他自己答出来的话。null = 还没录入。
   *
   * 和 `title` 的区别：**模型读这个。** 它是 PRD 阶段红方的任务书。
   */
  readonly brief: string | null;
  readonly state: ChangeState;
  /** How many ledger entries this Change has. Its creation is entry 0. */
  readonly seq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 账本里的一站：只有 phase 和 status —— **表里存的就只有这两样**。
 *
 * 原来这儿谎报成完整的 `ChangeState`（`returnPhase: null` 硬编出来的），于是一条
 * Fix 行读出来是一个 `assertStateValid` 都过不了的假状态。账本答的是「它在哪、
 * 什么状态」，栈是当下的事实，不是历史的一部分 —— 类型收窄到表能作证的范围。
 */
export interface LedgerStop {
  readonly phase: Phase;
  readonly status: PhaseStatus;
}

export interface LedgerEntry {
  readonly seq: number;
  readonly action: ChangeAction | "create";
  readonly from: LedgerStop | null;
  readonly to: LedgerStop;
  /** 这一步为什么发生（打回的理由等），人的话。null = 这一步没带理由。 */
  readonly reason: string | null;
  readonly at: string;
}

interface ChangeRow {
  id: string;
  project_id: string | null;
  title: string | null;
  brief: string | null;
  phase: string;
  status: string;
  return_stack: string;
  seq: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  seq: number;
  action: string;
  from_phase: string | null;
  from_status: string | null;
  to_phase: string;
  to_status: string;
  reason: string | null;
  at: string;
}

function toPhase(value: string): Phase {
  if (!isPhase(value)) throw new Error(`Unknown phase in database: ${value}`);
  return value;
}

function toState(row: {
  phase: string;
  status: string;
  return_stack: string;
}): ChangeState {
  const parsed: unknown = JSON.parse(row.return_stack);
  if (!Array.isArray(parsed)) {
    throw new Error(`return_stack is not a list: ${row.return_stack}`);
  }
  const state: ChangeState = {
    phase: toPhase(row.phase),
    status: row.status as PhaseStatus,
    returnStack: parsed.map((entry) => toPhase(String(entry))),
  };
  assertStateValid(state);
  return state;
}

export interface ChangeStoreOptions {
  now?: () => Date;
}

export class ChangeStore {
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    options: ChangeStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Start a Change.
   *
   * `projectId` and `title` are optional because a Change is complete without
   * them: nothing in the state machine, the gate or the fence reads either.
   * They carry what a PERSON needs to recognise it, which is why they may be
   * absent everywhere the machinery is proved.
   */
  create(
    changeId: string,
    belonging: { projectId?: string; title?: string } = {},
  ): ChangeRecord {
    const at = this.now().toISOString();
    // 起点跟着项目的图走（§4.5）：一个只走 Build->Review->Done 的项目，它的
    // Change 生在 Build，不是 PRD。没有项目就是全序，起点还是 PRD。
    const first = this.graphFor(belonging.projectId ?? null).order[0]!;
    this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO changes
           (id, project_id, title, phase, status, return_stack, seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', '[]', 0, ?, ?)`,
      ).run(
        changeId,
        belonging.projectId ?? null,
        belonging.title ?? null,
        first,
        at,
        at,
      );
      // Entry 0 is the creation itself, so the ledger explains where a Change
      // started rather than only how it moved afterwards.
      this.database.prepare(
        `INSERT INTO change_events
           (change_id, seq, action, from_phase, from_status, to_phase, to_status, at)
         VALUES (?, 0, 'create', NULL, NULL, ?, 'pending', ?)`,
      ).run(changeId, first, at);
    })();
    return this.read(changeId);
  }

  /**
   * 这个项目的阶段图。null / 没设 = 全序（DEFAULT_GRAPH）。
   *
   * 校验在读取时发生（`phaseGraphOf` 会拒绝重排、缺 Done、不认识的名字）——
   * 一个存坏的 phase_order 在第一次被用到时炸出来，而不是把 Change 引进一张
   * 走不通的图里。
   */
  private graphFor(projectId: string | null): PhaseGraph {
    if (projectId === null) return DEFAULT_GRAPH;
    const row = this.database.prepare(
      "SELECT phase_order FROM projects WHERE id = ?",
    ).get(projectId) as { phase_order: string | null } | undefined;
    if (!row || row.phase_order === null) return DEFAULT_GRAPH;
    return phaseGraphOf(JSON.parse(row.phase_order) as string[]);
  }

  /** 这个 Change 走的图。闸门要拿它判 sendBack 的合法性（command-store）。 */
  graphOf(changeId: string): PhaseGraph {
    return this.graphFor(this.read(changeId).projectId);
  }

  read(changeId: string): ChangeRecord {
    const row = this.database.prepare(
      "SELECT c.*, b.brief FROM changes c LEFT JOIN change_briefs b ON b.change_id = c.id WHERE c.id = ?",
    ).get(changeId) as ChangeRow | undefined;
    if (!row) throw new ChangeNotFoundError(changeId);
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      brief: row.brief,
      state: toState(row),
      seq: row.seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 记下人答出来的需求。
   *
   * **写的是 change_briefs，不是 changes。** 实测撞出来的：`changes` 上那两条触发器
   * 要求每一次 UPDATE 都是一次状态转移（seq 必须 +1），而录入需求不是转移 —— 没有
   * action 可记。做成一列就得放宽触发器；换一张表，触发器一个字都不用动。
   */
  setBrief(changeId: string, brief: string): ChangeRecord {
    // 先确认 Change 在，否则外键会以一个不说明问题的报错抛出来。
    this.read(changeId);
    this.database.prepare(
      `INSERT INTO change_briefs (change_id, brief, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (change_id) DO UPDATE SET
         brief = excluded.brief, updated_at = excluded.updated_at`,
    ).run(changeId, brief, this.now().toISOString());
    return this.read(changeId);
  }

  /** Every Change, or every Change in one project. What a list column shows. */
  list(projectId?: string): ChangeRecord[] {
    const rows = (projectId === undefined
      ? this.database.prepare(
          `SELECT c.*, b.brief FROM changes c
             LEFT JOIN change_briefs b ON b.change_id = c.id ORDER BY c.created_at`,
        ).all()
      : this.database.prepare(
          `SELECT c.*, b.brief FROM changes c
             LEFT JOIN change_briefs b ON b.change_id = c.id
            WHERE c.project_id = ? ORDER BY c.created_at`,
        ).all(projectId)) as ChangeRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      brief: row.brief,
      state: toState(row),
      seq: row.seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Apply an action. Throws `IllegalTransitionError` without touching the
   * database when the machine refuses it, so a rejected action leaves no trace
   * and no partial write.
   */
  apply(
    changeId: string,
    action: ChangeAction,
    options: {
      /** `sendBack` 的目标（打回哪一份上游文档）。别的动作不读。 */
      to?: Phase;
      /** 这一步为什么发生，人的话。进账本的 reason 列，环上历史箭头读它。 */
      reason?: string;
    } = {},
  ): ChangeRecord {
    const current = this.read(changeId);
    const next = transition(current.state, action, {
      ...(options.to === undefined ? {} : { to: options.to }),
      graph: this.graphFor(current.projectId),
    });
    const at = this.now().toISOString();
    const seq = current.seq + 1;

    this.database.transaction(() => {
      // Ledger first: `ck_changes_ledger` looks for this row when the update
      // below fires, so writing it second would abort every legal transition.
      this.database.prepare(
        `INSERT INTO change_events
           (change_id, seq, action, from_phase, from_status, to_phase, to_status, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        changeId,
        seq,
        action,
        current.state.phase,
        current.state.status,
        next.phase,
        next.status,
        options.reason ?? null,
        at,
      );
      const changed = this.database.prepare(
        `UPDATE changes
            SET phase = ?, status = ?, return_stack = ?, seq = ?, updated_at = ?
          WHERE id = ? AND seq = ?`,
      ).run(
        next.phase,
        next.status,
        JSON.stringify(next.returnStack),
        seq,
        at,
        changeId,
        current.seq,
      ).changes;
      // Compare-and-set on seq: two workers applying an action to the same
      // Change cannot both win, and the loser fails loudly instead of
      // overwriting a transition it never saw.
      if (changed !== 1) {
        throw new Error(`change_seq_conflict:${changeId}`);
      }
    })();
    return this.read(changeId);
  }

  /**
   * 把一个 Change 连同它的全部痕迹删掉。
   *
   * ## 顺序是外键定的，不是我排的
   *
   * 有十三张表引用 `changes(id)`，而 `answers` 引用 `questions`、`rubric_criteria`
   * 和 `rubric_assessments` 引用 `rubrics`、`turns` 还引用 `jobs` —— **漏一张就是
   * 外键报错或者一堆指向不存在的 Change 的孤儿行**。所以这份名单按拓扑序写死，
   * 而不是「看着删」。
   *
   * 加了新表却忘了往这里加一行，会在删的时候当场 FOREIGN KEY 报错 —— 那比静默留下
   * 孤儿行好，但仍然是要靠人记得。`change-store.test.ts` 里那条「删完一张表都不剩」
   * 盯着这件事。
   *
   * ## 一个事务，要么全删要么全不删
   *
   * 删到一半失败留下的东西没人认得出来 —— 它既不是一个活着的 Change，也不是没有。
   *
   * ## 那两个触发器不挡这条路
   *
   * `ck_changes_ledger` / `ck_changes_seq_advances` 都是 `AFTER UPDATE`，管的是
   * 「状态变了必须有账」。删除不是状态变化，是这条记录不再存在 —— 账本跟着一起走。
   */
  delete(changeId: string): void {
    const wipe = this.database.transaction(() => {
      // 先删「引用别人的」，再删被引用的。
      this.database.prepare(
        `DELETE FROM answers WHERE question_id IN
           (SELECT id FROM questions WHERE change_id = ?)`,
      ).run(changeId);
      this.database.prepare(
        `DELETE FROM rubric_criteria WHERE rubric_id IN
           (SELECT id FROM rubrics WHERE change_id = ?)`,
      ).run(changeId);
      for (const table of [
        "turns", "jobs", "rubric_assessments", "rubrics", "questions",
        "commands", "gaps", "round_notes", "round_worklist",
        "change_bindings", "change_briefs", "change_evidence", "change_events",
      ]) {
        this.database.prepare(`DELETE FROM ${table} WHERE change_id = ?`).run(changeId);
      }
      this.database.prepare("DELETE FROM changes WHERE id = ?").run(changeId);
    });
    wipe();
  }

  ledger(changeId: string): LedgerEntry[] {
    const rows = this.database.prepare(
      "SELECT * FROM change_events WHERE change_id = ? ORDER BY seq",
    ).all(changeId) as EventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      action: row.action as ChangeAction | "create",
      from: row.from_phase === null || row.from_status === null
        ? null
        : {
            phase: toPhase(row.from_phase),
            status: row.from_status as PhaseStatus,
          },
      to: {
        phase: toPhase(row.to_phase),
        status: row.to_status as PhaseStatus,
      },
      reason: row.reason,
      at: row.at,
    }));
  }
}
