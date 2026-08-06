import type Database from "better-sqlite3";

import {
  applyRound,
  blockersFrom,
  dismiss,
  raise,
  respond,
  waive,
  waivedFrom,
  type Gap,
  type GapResponse,
  type RespondResult,
  type RoundOutcome,
} from "../domain/gap";
import type { Phase } from "../domain/phase";
import type { Blocker } from "../domain/gate";

/**
 * Where problems live between rounds.
 *
 * The gate reads open rows here rather than a list attached to the round that
 * produced them. That is the whole difference: a round's findings are an event,
 * and a gap is a state, and only the second one can survive a round that
 * forgets to mention it.
 *
 * Every rule about what may change is in `domain/gap.ts` and proved offline.
 * This reads, calls that, and writes back.
 */

interface GapRow {
  id: string;
  kind: Gap["kind"];
  severity: Gap["severity"];
  title: string;
  status: Gap["status"];
  opened_round: number;
  resolution: string | null;
  note: string | null;
  closed_by: Gap["closedBy"];
  /** 列名和域字段不同名，理由写在 `db/schema.ts` 建表那儿（`where` 是 SQL 保留字）。 */
  found_where: string | null;
  found_why: string | null;
}

export class GapStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  all(changeId: string, phase: Phase): Gap[] {
    const rows = this.database.prepare(
      `SELECT id, kind, severity, title, status, opened_round, resolution, note,
              closed_by, found_where, found_why
         FROM gaps WHERE change_id = ? AND phase = ? ORDER BY opened_round, id`,
    ).all(changeId, phase) as GapRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      status: row.status,
      openedRound: row.opened_round,
      resolution: row.resolution,
      note: row.note,
      closedBy: row.closed_by,
      where: row.found_where,
      why: row.found_why,
    }));
  }

  /** What the gate sees: open gaps, whatever their severity. */
  blockers(changeId: string, phase: Phase): Blocker[] {
    return blockersFrom(this.all(changeId, phase));
  }

  /** Gaps a human accepted, which a delivery note has to list. */
  waived(changeId: string, phase: Phase): Gap[] {
    return waivedFrom(this.all(changeId, phase));
  }

  /**
   * 这个 Change 上**人已经表过态**的所有条目，跨阶段。
   *
   * ## 为什么跨阶段
   *
   * 每个阶段一条新线程、一个新反方，从零开始怀疑 —— 而人在 Spec 里裁过的事，
   * TechSpec 的反方结构上看不见。2026-08-02 实测：去重语义被重提 5 次、范围定义
   * 3 次，每次烧一轮 turn 加一次裁决。
   *
   * ## 为什么只有人裁过的
   *
   * 「已裁定」的定义就是人表过态。模型自己关掉的仍然可以被重新发现、重开
   * （见 `domain/gap.ts` 的 `applyRound`）—— 那按定义就不算裁定过，进这份清单
   * 会让下一轮误以为它不许再提。
   *
   * 两种都要，因为它们说的是两句不同的话：`closed_by='human'` 是「这条不成立」，
   * `waived` 是「问题还在，我接受这个风险」。
   */
  humanSettled(changeId: string): (Gap & { phase: Phase })[] {
    const rows = this.database.prepare(
      `SELECT id, kind, severity, title, status, opened_round, resolution, note,
              closed_by, found_where, found_why, phase
         FROM gaps
        WHERE change_id = ?
          AND (closed_by = 'human' OR status = 'waived')
        ORDER BY phase, opened_round, id`,
    ).all(changeId) as (GapRow & { phase: Phase })[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      status: row.status,
      openedRound: row.opened_round,
      resolution: row.resolution,
      note: row.note,
      closedBy: row.closed_by,
      where: row.found_where,
      why: row.found_why,
      phase: row.phase,
    }));
  }

  /**
   * Settle a round.
   *
   * Throws before writing anything if the round's verdicts are not coherent
   * with what is open -- a partially applied round would leave the gate reading
   * a state no round ever produced.
   */
  settleRound(
    changeId: string,
    phase: Phase,
    outcome: RoundOutcome,
  ): Gap[] {
    const next = applyRound(this.all(changeId, phase), outcome);
    this.write(changeId, phase, next);
    return next;
  }

  /** A person deciding to live with a problem, on the record. */
  waive(
    changeId: string,
    phase: Phase,
    gapId: string,
    reason: string,
  ): Gap[] {
    const next = waive(this.all(changeId, phase), gapId, reason);
    this.write(changeId, phase, next);
    return next;
  }

  /** 人驳回一条问题：这条不成立。落 closed，理由必填。 */
  dismiss(
    changeId: string,
    phase: Phase,
    gapId: string,
    reason: string,
  ): Gap[] {
    const next = dismiss(this.all(changeId, phase), gapId, reason);
    this.write(changeId, phase, next);
    return next;
  }

  /**
   * 人对每一条 open gap 的表态，一次落盘。
   *
   * 返回没落地的那些 —— 人已经答完走了，静默跳过等于他点了一下什么都没发生。
   */
  respond(
    changeId: string,
    phase: Phase,
    responses: Readonly<Record<string, GapResponse>>,
  ): RespondResult {
    const result = respond(this.all(changeId, phase), responses);
    this.write(changeId, phase, result.gaps);
    return result;
  }

  /**
   * 人自己提一个问题。返回**新开那一条**，因为调用方要把 id 说回给人。
   *
   * 号由 `raise` 从库里现有的 `HUMAN-` 里顺出来，所以两次调用之间不会撞号。
   */
  raise(changeId: string, phase: Phase, title: string, round: number): Gap {
    const next = raise(this.all(changeId, phase), { title, round });
    this.write(changeId, phase, next);
    return next[next.length - 1]!;
  }

  /**
   * 把上层算好的 gaps 写回去。
   *
   * ## 这不是在开后门
   *
   * 这个类的职责从一开始就是「读、调用 domain 里的规则、写回」（见文件开头）。
   * `settleRound` 和 `waive` 各自内联了一条规则，而 rubric 的规则住在 L5 的
   * `domain/rubric-gaps.ts` —— 这个 store 是 L1，**不能 import 它**（护栏会红，
   * 而分层纪律说的正是这件事）。所以规则由上层调用，落盘走这里。
   *
   * ## 但它确实放宽了一件事，写下来免得被当成默许
   *
   * 在这之前，「所有变更都经过 applyRound 或 waive」是可以靠读这个文件确认的；
   * 现在不能了。**代价的对冲是：允许调用它的规则，本身必须是离线可穷举证明的纯
   * 函数** —— 目前只有 `domain/gap.ts` 和 `domain/rubric-gaps.ts` 两处。
   *
   * 要在这里塞一段现算现写的逻辑之前，先把那段逻辑挪进一个纯模块。
   */
  replace(changeId: string, phase: Phase, gaps: readonly Gap[]): void {
    this.write(changeId, phase, gaps);
  }

  private write(changeId: string, phase: Phase, gaps: readonly Gap[]): void {
    const at = this.now().toISOString();
    const upsert = this.database.prepare(
      `INSERT INTO gaps
         (id, change_id, phase, kind, severity, title, status, opened_round,
          resolution, note, closed_by, found_where, found_why, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (change_id, phase, id) DO UPDATE SET
         kind = excluded.kind,
         severity = excluded.severity,
         title = excluded.title,
         status = excluded.status,
         opened_round = excluded.opened_round,
         resolution = excluded.resolution,
         note = excluded.note,
         closed_by = excluded.closed_by,
         found_where = excluded.found_where,
         found_why = excluded.found_why,
         updated_at = excluded.updated_at`,
    );
    this.database.transaction(() => {
      for (const gap of gaps) {
        upsert.run(
          gap.id, changeId, phase, gap.kind, gap.severity, gap.title,
          gap.status, gap.openedRound, gap.resolution, gap.note, gap.closedBy,
          gap.where, gap.why, at,
        );
      }
    })();
  }
}
