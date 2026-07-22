import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  buildRecordSourceHead,
  latestApprovedBuildRecord,
} from "./build-record-identity.ts";

/**
 * The ordinary Fix state: build-1 has been absorbed, build-2 is approved and
 * waiting to be. `adopted_at` is NULL on build-2 because
 * `recordInputFromBuildRunFile` only fills it in for `adopted` rows, and build-2
 * is the newer row by `updated_at`.
 */
const ABSORBED_BUILD = {
  id: "BRR-1",
  buildRunId: "build-1",
  status: "adopted",
  adoptedAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
  headSha: "a".repeat(40),
  baseHeadSha: "0".repeat(40),
  baseCommit: "0".repeat(40),
  adoptedHeadSha: "a".repeat(40),
};

const AWAITING_ABSORB_BUILD = {
  id: "BRR-2",
  buildRunId: "build-2",
  status: "approved_for_absorb",
  adoptedAt: null,
  updatedAt: "2026-07-20T00:00:00.000Z",
  headSha: null,
  baseHeadSha: "b".repeat(40),
  baseCommit: "b".repeat(40),
  adoptedHeadSha: null,
};

describe("build-record-identity", () => {
  it("picks the newer approved_for_absorb build over an older adopted one", () => {
    const picked = latestApprovedBuildRecord([ABSORBED_BUILD, AWAITING_ABSORB_BUILD]);

    assert.equal(picked?.id, "BRR-2");
  });

  it("is insensitive to input order", () => {
    const forward = latestApprovedBuildRecord([ABSORBED_BUILD, AWAITING_ABSORB_BUILD]);
    const reversed = latestApprovedBuildRecord([AWAITING_ABSORB_BUILD, ABSORBED_BUILD]);

    assert.equal(forward?.id, reversed?.id);
  });

  it("disagrees with SQL NULL-last ordering, which is why this selection may not be pushed into SQL", () => {
    // Executable evidence for the rule above rather than a comment claiming it.
    // `recovery-business-evidence` used to select this row with
    // `ORDER BY adopted_at DESC, updated_at DESC, id DESC`. SQLite sorts NULL
    // last under DESC, so a NULL adopted_at loses to every adopted row no matter
    // how much newer it is -- and since every approved_for_absorb row has a NULL
    // adopted_at by construction, the disagreement is the normal case, not a
    // boundary. If a future change moves this ordering back into SQL, this test
    // is the one that should stop it.
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE build_run_records (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        adopted_at TEXT,
        updated_at TEXT
      );
    `);
    const insert = sqlite.prepare(
      "INSERT INTO build_run_records (id, status, adopted_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const row of [ABSORBED_BUILD, AWAITING_ABSORB_BUILD]) {
      insert.run(row.id, row.status, row.adoptedAt, row.updatedAt);
    }

    const sqlPick = sqlite
      .prepare(`
        SELECT id FROM build_run_records
        WHERE status IN ('approved_for_absorb', 'adopted')
        ORDER BY adopted_at DESC, updated_at DESC, id DESC
        LIMIT 1
      `)
      .get() as { id: string };
    sqlite.close();

    const jsPick = latestApprovedBuildRecord([ABSORBED_BUILD, AWAITING_ABSORB_BUILD]);

    assert.equal(sqlPick.id, "BRR-1", "SQL NULL-last ordering picks the older absorbed build");
    assert.equal(jsPick?.id, "BRR-2", "the shared selection picks the newer approved build");
    assert.notEqual(sqlPick.id, jsPick?.id, "the two orderings genuinely disagree on this input");
  });

  it("resolves an approved_for_absorb build to its base commit, not null", () => {
    // adopted_head_sha and head_sha are both NULL until absorb, so a reader
    // spelling this rule as `headSha ?? adoptedHeadSha` gets null here -- which
    // is what made selfHealMissingReviewGate skip its head-equality check and
    // write a passed Review gate.
    assert.equal(buildRecordSourceHead(AWAITING_ABSORB_BUILD), "b".repeat(40));
    assert.notEqual(buildRecordSourceHead(AWAITING_ABSORB_BUILD), null);
  });

  it("resolves an adopted build to the commit it was absorbed onto", () => {
    assert.equal(buildRecordSourceHead(ABSORBED_BUILD), "a".repeat(40));
  });

  it("ignores build runs that are neither approved nor adopted", () => {
    const rejected = { ...AWAITING_ABSORB_BUILD, id: "BRR-3", status: "rejected", updatedAt: "2026-07-21T00:00:00.000Z" };

    assert.equal(latestApprovedBuildRecord([ABSORBED_BUILD, rejected])?.id, "BRR-1");
    assert.equal(latestApprovedBuildRecord([rejected]), null);
  });
});
