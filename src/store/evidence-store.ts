import type Database from "better-sqlite3";

import { EMPTY_EVIDENCE, type Blocker, type Evidence } from "../domain/gate";
import type { Phase } from "../domain/phase";

/**
 * What a phase produced, as the gate sees it.
 *
 * Evidence is per (change, phase) and is replaced wholesale when a phase runs
 * again: a second round's findings supersede the first round's, they do not
 * merge with them. What must NOT be lost across a re-run is a blocker that is
 * still true, and that is the round's job to re-report -- 「旧问题必须被明确复核，
 * 不能因为重新生成文档而消失」. Keeping stale blockers alive here instead would
 * make the gate refuse forever on problems nobody can find.
 */
export class EvidenceStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  read(changeId: string, phase: Phase): Evidence {
    const row = this.database.prepare(
      "SELECT artifact_ids, blockers, waived_ids FROM change_evidence WHERE change_id = ? AND phase = ?",
    ).get(changeId, phase) as
      | { artifact_ids: string; blockers: string; waived_ids: string }
      | undefined;
    // A phase that has not run has no evidence, and no evidence is not an
    // error -- it is precisely why the gate refuses to approve it.
    if (!row) return EMPTY_EVIDENCE;
    return {
      artifactIds: JSON.parse(row.artifact_ids) as string[],
      blockers: JSON.parse(row.blockers) as Blocker[],
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
