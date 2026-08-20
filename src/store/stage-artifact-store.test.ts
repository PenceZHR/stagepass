import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { prepareSchema, SCHEMA_SQL } from "../db/schema";
import type { StageRoundArtifact } from "../domain/stage-artifact";
import { ChangeStore } from "./change-store";
import { StageArtifactStore } from "./stage-artifact-store";

const R1: StageRoundArtifact = {
  changeId: "CHG-1",
  phase: "Build",
  round: 1,
  jobId: "JOB-1",
  artifactIds: ["a1b2c3d"],
  commit: "a1b2c3d",
  source: "recorded",
  files: [
    { path: "src/a.ts", role: "delivery", change: "added" },
    {
      path: "docs/stagepass/CHG-1/Build-r1.md",
      role: "producer",
      change: "added",
    },
  ],
  upstream: [{ phase: "Arch", artifactIds: ["docs/stagepass/CHG-1/Arch-r1.md"] }],
  settledAt: "2026-08-16T12:00:00.000Z",
};

function open(): { database: Database.Database; store: StageArtifactStore } {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database).create("CHG-1");
  return { database, store: new StageArtifactStore(database) };
}

describe("stage artifact store", () => {
  it("records exact replay idempotently and rejects conflicting replay", () => {
    const { database, store } = open();
    try {
      store.record(R1);
      store.record(R1);
      assert.equal(store.list("CHG-1", "Build").length, 1);
      assert.throws(
        () => store.record({ ...R1, files: [] }),
        /stage_artifact_conflict:CHG-1\/Build\/1/,
      );
    } finally {
      database.close();
    }
  });

  it("lists newest first and reads one exact round", () => {
    const { database, store } = open();
    try {
      store.record(R1);
      store.record({
        ...R1,
        round: 2,
        jobId: "JOB-2",
        artifactIds: ["b2c3d4e"],
        commit: "b2c3d4e",
        settledAt: "2026-08-16T13:00:00.000Z",
      });
      assert.deepEqual(store.list("CHG-1", "Build").map((row) => row.round), [2, 1]);
      assert.equal(store.read("CHG-1", "Build", 1)?.jobId, "JOB-1");
      assert.equal(store.read("CHG-1", "Build", 99), null);
    } finally {
      database.close();
    }
  });

  it("fails loudly on malformed persisted JSON", () => {
    const { database, store } = open();
    try {
      store.record(R1);
      database.prepare(
        "UPDATE stage_round_artifacts SET files_json = '[' WHERE change_id = 'CHG-1'",
      ).run();
      assert.throws(() => store.read("CHG-1", "Build", 1), /stage_artifact_malformed/);
    } finally {
      database.close();
    }
  });

  it("prepareSchema adds the ledger to an old database", () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE legacy (id TEXT PRIMARY KEY)");
      prepareSchema(database);
      assert.ok(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stage_round_artifacts'",
      ).get());
    } finally {
      database.close();
    }
  });

  it("Change deletion removes manifest rows", () => {
    const { database, store } = open();
    try {
      store.record(R1);
      new ChangeStore(database).delete("CHG-1");
      const row = database.prepare(
        "SELECT count(*) AS count FROM stage_round_artifacts",
      ).get() as { count: number };
      assert.equal(row.count, 0);
    } finally {
      database.close();
    }
  });
});
