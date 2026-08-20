import type Database from "better-sqlite3";

import {
  assertStageRoundArtifact,
  type StageRoundArtifact,
} from "../domain/stage-artifact";
import type { Phase } from "../domain/phase";

interface StageArtifactRow {
  change_id: string;
  phase: string;
  round: number;
  job_id: string;
  artifact_ids: string;
  commit_sha: string | null;
  source: string;
  files_json: string;
  upstream_json: string;
  settled_at: string;
}

function parseJson<T>(text: string, identity: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`stage_artifact_malformed:${identity}`);
  }
}

function fromRow(row: StageArtifactRow): StageRoundArtifact {
  const identity = `${row.change_id}/${row.phase}/${row.round}`;
  const artifact: StageRoundArtifact = {
    changeId: row.change_id,
    phase: row.phase as Phase,
    round: row.round,
    jobId: row.job_id,
    artifactIds: parseJson<readonly string[]>(row.artifact_ids, identity),
    commit: row.commit_sha,
    source: row.source as StageRoundArtifact["source"],
    files: parseJson<StageRoundArtifact["files"]>(row.files_json, identity),
    upstream: parseJson<StageRoundArtifact["upstream"]>(row.upstream_json, identity),
    settledAt: row.settled_at,
  };
  try {
    assertStageRoundArtifact(artifact);
  } catch {
    throw new Error(`stage_artifact_malformed:${identity}`);
  }
  return artifact;
}

export class StageArtifactStore {
  constructor(private readonly database: Database.Database) {}

  record(artifact: StageRoundArtifact): void {
    assertStageRoundArtifact(artifact);
    if (artifact.settledAt === null) throw new Error("stage_artifact_invalid:settledAt");
    const existing = this.read(artifact.changeId, artifact.phase, artifact.round);
    if (existing !== null) {
      if (JSON.stringify(existing) === JSON.stringify(artifact)) return;
      throw new Error(
        `stage_artifact_conflict:${artifact.changeId}/${artifact.phase}/${artifact.round}`,
      );
    }
    this.database.prepare(
      `INSERT INTO stage_round_artifacts
         (change_id, phase, round, job_id, artifact_ids, commit_sha, source,
          files_json, upstream_json, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifact.changeId,
      artifact.phase,
      artifact.round,
      artifact.jobId,
      JSON.stringify(artifact.artifactIds),
      artifact.commit,
      artifact.source,
      JSON.stringify(artifact.files),
      JSON.stringify(artifact.upstream),
      artifact.settledAt,
    );
  }

  read(changeId: string, phase: Phase, round: number): StageRoundArtifact | null {
    const row = this.database.prepare(
      `SELECT change_id, phase, round, job_id, artifact_ids, commit_sha, source,
              files_json, upstream_json, settled_at
         FROM stage_round_artifacts
        WHERE change_id = ? AND phase = ? AND round = ?`,
    ).get(changeId, phase, round) as StageArtifactRow | undefined;
    return row === undefined ? null : fromRow(row);
  }

  list(changeId: string, phase: Phase): StageRoundArtifact[] {
    const rows = this.database.prepare(
      `SELECT change_id, phase, round, job_id, artifact_ids, commit_sha, source,
              files_json, upstream_json, settled_at
         FROM stage_round_artifacts
        WHERE change_id = ? AND phase = ?
        ORDER BY round DESC`,
    ).all(changeId, phase) as StageArtifactRow[];
    return rows.map(fromRow);
  }
}
