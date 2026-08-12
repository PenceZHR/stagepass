import type Database from "better-sqlite3";

import {
  assertStateValid,
  SendBackTargetError,
  transition,
  type ChangeAction,
  type ChangeState,
  type PhaseStatus,
} from "../domain/change-state";
import {
  DEFAULT_GRAPH,
  isPhase,
  parallelTwinOf,
  phaseGraphOf,
  upstreamOf,
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
      /**
       * 打回时**孪生阶段一起重来**（环 v3，用户 2026-08-12 拍）：给打回落点的
       * 孪生开一个 pending 座位，两轨并行重跑。只有 `sendBack` 读它。
       *
       * 默认不带 —— 批 4 那条「sendBack 到达不开孪生座」的理由原样成立（QA 说
       * 代码错了时测试轨往往是好的，自动拖它重来是替人做决定）；这个参数正是
       * 把那个决定还给人的入口。
       */
      withTwin?: boolean;
      /** 这一步为什么发生，人的话。进账本的 reason 列，环上历史箭头读它。 */
      reason?: string;
    } = {},
  ): ChangeRecord {
    const current = this.read(changeId);
    const graph = this.graphFor(current.projectId);
    /*
     * **「两轨一起重来」的合法性在动手之前判**（环 v3）。三条都得成立：
     * 落点有孪生、孪生在这个 Change 的图上、而且**发起方够得着它**（upstreamOf
     * —— Build 打回 BuildPlan 时 TestPlan 不在 Build 的上游里，组合就不合法；
     * 题面那侧同一条判据不摆这个选项，这里是防绕过题面的调用方）。
     */
    if (action === "sendBack" && options.withTwin === true) {
      const twin = options.to === undefined ? null : parallelTwinOf(options.to);
      if (twin === null || !graph.order.includes(twin)
        || !upstreamOf(current.state.phase, graph).includes(twin)) {
        throw new SendBackTargetError(
          "target_not_upstream",
          `${current.state.phase} -> ${options.to ?? "?"} 的孪生不可及`,
        );
      }
    }
    const next = transition(current.state, action, {
      ...(options.to === undefined ? {} : { to: options.to }),
      graph,
    });
    const at = this.now().toISOString();
    const seq = current.seq + 1;

    /*
     * **主线走到一个开着的并行座位上，就把座位的进度收编进来**（批 3）。
     *
     * 座位（change_states）在主线停在别处时替这个阶段攒轮次：evidence / gaps /
     * rubric 都已经按 (change, phase) 落在各自的表里，主线一到，缺的只有 status。
     * 收编 = 到达时的 status 用座位的（settled 就是 settled，人可以直接裁决，
     * 不用把并行跑过的轮再跑一遍），座位那一行删掉 —— 一个阶段从此只有一个座。
     *
     * 只在**到达**（换了阶段、落点是 pending）时收编：start/settle/fail/retry
     * 不换阶段，closed 是终点，都轮不到它。ledger 的 to_status 记收编后的值 ——
     * 账本说的必须是真发生的那一步。
     *
     * **sendBack 到达不收编 status**（批 4 · 审计 P0 第 4 条）：打回的意思是
     * 「这份产物错了，重做」，把座位攒下的 settled 直接接过来，打回的意见一轮
     * 没跑就变成「可以批准了」。座位那一行照样删（一个阶段只有一个座），攒下的
     * evidence / gaps 都在各自的表里 —— 重开的那一轮对着它们干活。
     */
    const arriving = next.phase !== current.state.phase && next.status === "pending";
    const seat = arriving
      ? (this.database.prepare(
          "SELECT status FROM change_states WHERE change_id = ? AND phase = ?",
        ).get(changeId, next.phase) as { status: PhaseStatus } | undefined) ?? null
      : null;
    const landed = action === "sendBack" ? next.status : seat?.status ?? next.status;

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
        landed,
        options.reason ?? (seat === null ? null : "adopted_parallel_progress"),
        at,
      );
      if (seat !== null) {
        this.database.prepare(
          "DELETE FROM change_states WHERE change_id = ? AND phase = ?",
        ).run(changeId, next.phase);
      }
      /*
       * **关掉的 Change 一个座位都不许留**（批 4 · 审计 P0 第 2/6 条）：
       * closed 之后没有任何一条路会再收编它们，留着就是一个能起 Codex、写
       * evidence、而且永远清不掉的孤儿。
       *
       * **主线越过去的座位一并清**：人跳过式批准（§8.10 选远目标）把一个开着的
       * 座位甩在主线身后 —— 它的阶段已经不在「主线还会到达」的名单里，永远等不到
       * 收编。清的是座位那一行（阶段的 evidence / gaps 原样在表里），人的跳过
       * 本身就在账本上，这一步是它的直接后果，不是第二个决定。
       */
      if (next.status === "closed") {
        this.database.prepare(
          "DELETE FROM change_states WHERE change_id = ?",
        ).run(changeId);
      } else if (action === "sendBack" && next.phase !== current.state.phase) {
        /*
         * **打回清全部座位**（2026-08-12，用户点名的「并行状态回转」）。
         *
         * 只清身后不够：主线在 Build、Test 座位并行跑到 settled，打回 BuildPlan
         * 时 Test 在落点**前方**，按下面那条规则会活下来 —— 而重走到 Test 是
         * approve 到达，**到达即收编**，旧世界的 settled 被原样接过来：测试从没
         * 对着新计划重写过，状态却说「可以直接批准」。这正是 P0 第 4 条
         * （sendBack 到达不收编）防住了落点、没防住落点下游的同一个病。
         *
         * 打回宣告的是「上游产物作废」—— 此前并行攒下的每一个 settled 都建立在
         * 作废的前提上，没有一个例外，所以全清。evidence / gaps 照旧留表（重走的
         * 轮对着它们干活）；重走穿过分叉点时，上面那条开孪生座的规则会把座位
         * 重新开出来 —— 新座位攒的才是新世界的轮次。
         *
         * 顺序要紧：先清，紧接着「两轨一起重来」才开孪生座 —— 反过来刚开的座
         * 会被自己这一步清掉。
         */
        this.database.prepare(
          "DELETE FROM change_states WHERE change_id = ?",
        ).run(changeId);
      } else if (next.phase !== current.state.phase) {
        const ahead = graph.order.slice(graph.order.indexOf(next.phase) + 1);
        this.database.prepare(
          `DELETE FROM change_states WHERE change_id = ?
             AND phase NOT IN (${ahead.map(() => "?").join(",") || "''"})`,
        ).run(changeId, ...ahead);
      }
      /*
       * **钻石的分叉**（批 4）：批准落到 BuildPlan / Build 时，给孪生阶段
       * （TestPlan / Test）开座位 —— 两轨从这儿开始并行。只在 approve 到达时开
       * （sendBack 到达是打回重开，孪生该不该跟着重来由人裁）；孪生不在这个
       * Change 的图上就不开（跳过阶段是合法的，§4.5）。
       */
      /*
       * 开孪生座的两种到达（环 v3）：**批准落到分叉点**（批 4 的自动分叉），或
       * **人打回时点了「两轨一起重来」**（合法性上面已经判过）。别的到达不开。
       */
      const twin = arriving
        && (action === "approve" || (action === "sendBack" && options.withTwin === true))
        ? parallelTwinOf(next.phase) : null;
      if (twin !== null && graph.order.includes(twin)) {
        this.database.prepare(
          `INSERT OR IGNORE INTO change_states
             (change_id, phase, status, opened_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?)`,
        ).run(changeId, twin, at, at);
      }
      const changed = this.database.prepare(
        `UPDATE changes
            SET phase = ?, status = ?, return_stack = ?, seq = ?, updated_at = ?
          WHERE id = ? AND seq = ?`,
      ).run(
        next.phase,
        landed,
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
        "change_bindings", "change_briefs", "change_evidence", "change_states",
        "change_events",
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
