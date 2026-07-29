import type Database from "better-sqlite3";

import { EMPTY_EVIDENCE, type Blocker, type Evidence } from "../domain/gate";
import type { Phase } from "../domain/phase";
import { GapStore } from "./gap-store";

/**
 * What a phase produced, as the gate sees it.
 *
 * Artifacts are per (change, phase) and are replaced when a phase runs again:
 * they are the round's own output, and a later round's supersede an earlier
 * one's.
 *
 * Problems are not, and that asymmetry is the point. They live in `gaps`, where
 * a round that never mentions one leaves it open --「旧问题必须被明确复核，不能
 * 因为重新生成文档而消失」. This class used to hold them too and replace them
 * wholesale, which meant a second round could resolve a problem by forgetting
 * it. Closing one now has to be said out loud, with a reason.
 */
export class EvidenceStore {
  private readonly gaps: GapStore;

  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.gaps = new GapStore(database, now);
  }

  read(changeId: string, phase: Phase): Evidence {
    const row = this.database.prepare(
      "SELECT artifact_ids, blockers, waived_ids FROM change_evidence WHERE change_id = ? AND phase = ?",
    ).get(changeId, phase) as
      | { artifact_ids: string; blockers: string; waived_ids: string }
      | undefined;
    // A phase that has not run has no evidence, and no evidence is not an
    // error -- it is precisely why the gate refuses to approve it.
    // Blockers come from `gaps`, never from this table. A round's findings are
    // an event and a gap is a state, and only the second survives a round that
    // forgets to mention it. `blockers` here is kept for rows written before
    // gaps existed and is unioned rather than dropped.
    const fromGaps = this.gaps.blockers(changeId, phase);
    if (!row) {
      return fromGaps.length === 0
        ? EMPTY_EVIDENCE
        : { ...EMPTY_EVIDENCE, blockers: fromGaps };
    }
    const legacy = JSON.parse(row.blockers) as Blocker[];
    const seen = new Set(fromGaps.map((blocker) => blocker.id));
    return {
      artifactIds: JSON.parse(row.artifact_ids) as string[],
      blockers: [...fromGaps, ...legacy.filter((each) => !seen.has(each.id))],
      waivedBlockerIds: JSON.parse(row.waived_ids) as string[],
    };
  }

  put(changeId: string, phase: Phase, evidence: Evidence): void {
    const at = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO change_evidence
         (change_id, phase, artifact_ids, blockers, waived_ids, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (change_id, phase) DO UPDATE SET
         artifact_ids = excluded.artifact_ids,
         blockers = excluded.blockers,
         waived_ids = excluded.waived_ids,
         updated_at = excluded.updated_at`,
    ).run(
      changeId,
      phase,
      JSON.stringify(evidence.artifactIds),
      JSON.stringify(evidence.blockers),
      JSON.stringify(evidence.waivedBlockerIds),
      at,
    );
  }

  /**
   * Accept a P1 that a human decided to live with.
   *
   * Separate from `put` because it is a different kind of write: a round
   * reports what it found, a person decides what to tolerate, and a later round
   * re-reporting the same blocker must not silently un-accept it.
   */
  waive(changeId: string, phase: Phase, blockerId: string): void {
    const current = this.read(changeId, phase);
    if (current.waivedBlockerIds.includes(blockerId)) return;
    this.put(changeId, phase, {
      ...current,
      waivedBlockerIds: [...current.waivedBlockerIds, blockerId],
    });
  }
}
