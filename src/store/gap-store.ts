import type Database from "better-sqlite3";

import {
  applyRound,
  blockersFrom,
  waive,
  waivedFrom,
  type Gap,
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
  severity: Gap["severity"];
  title: string;
  status: Gap["status"];
  opened_round: number;
  resolution: string | null;
}

export class GapStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  all(changeId: string, phase: Phase): Gap[] {
    const rows = this.database.prepare(
      `SELECT id, severity, title, status, opened_round, resolution
         FROM gaps WHERE change_id = ? AND phase = ? ORDER BY opened_round, id`,
    ).all(changeId, phase) as GapRow[];
    return rows.map((row) => ({
      id: row.id,
      severity: row.severity,
      title: row.title,
      status: row.status,
      openedRound: row.opened_round,
      resolution: row.resolution,
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

  private write(changeId: string, phase: Phase, gaps: readonly Gap[]): void {
    const at = this.now().toISOString();
    const upsert = this.database.prepare(
      `INSERT INTO gaps
         (id, change_id, phase, severity, title, status, opened_round, resolution, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (change_id, phase, id) DO UPDATE SET
         severity = excluded.severity,
         title = excluded.title,
         status = excluded.status,
         opened_round = excluded.opened_round,
         resolution = excluded.resolution,
         updated_at = excluded.updated_at`,
    );
    this.database.transaction(() => {
      for (const gap of gaps) {
        upsert.run(
          gap.id, changeId, phase, gap.severity, gap.title,
          gap.status, gap.openedRound, gap.resolution, at,
        );
      }
    })();
  }
}
