import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { runMigrations } from "../db/migrate.ts";
import * as dbSchema from "../db/schema.ts";
import { runs } from "../db/schema.ts";
import {
  nextRunLedgerId,
  setRunLedgerDbForTest,
  type RunLedgerDb,
} from "./run-ledger-repository.ts";

function createRunLedgerTestDb(): RunLedgerDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  runMigrations(sqlite);
  return drizzle(sqlite, { schema: dbSchema }) as unknown as RunLedgerDb;
}

function seedRun(database: RunLedgerDb, id: string): void {
  database
    .insert(runs)
    .values({ id, changeId: "CHG-RUN-LEDGER-TEST", phase: "generate_plan", status: "running" })
    .run();
}

describe("run-ledger-repository injectable connection", () => {
  it("routes nextRunLedgerId's read through the injected db (seam is honored)", () => {
    const seamDb = createRunLedgerTestDb();
    seedRun(seamDb, "RUN-001");
    seedRun(seamDb, "RUN-002");

    const restore = setRunLedgerDbForTest(seamDb);
    try {
      // No connection arg: the default path must read the injected seam db,
      // not the module-global singleton.
      assert.equal(nextRunLedgerId("RUN"), "RUN-003");
    } finally {
      restore();
    }

    // Injecting a different db switches the read source, proving the seam is live.
    const otherDb = createRunLedgerTestDb();
    seedRun(otherDb, "RUN-050");
    const restoreOther = setRunLedgerDbForTest(otherDb);
    try {
      assert.equal(nextRunLedgerId("RUN"), "RUN-051");
    } finally {
      restoreOther();
    }
  });

  it("allocates the next id within the caller's transaction, not the global handle", () => {
    // The injected "global" handle already holds RUN-001 committed. A stale
    // global read would allocate RUN-002 -- colliding with the row the caller's
    // own uncommitted transaction is about to hold.
    const seamDb = createRunLedgerTestDb();
    seedRun(seamDb, "RUN-001");
    const restore = setRunLedgerDbForTest(seamDb);

    // The caller's transaction runs on a SEPARATE connection: it writes
    // RUN-001 and RUN-002 without committing, then allocates the next id.
    const callerDb = createRunLedgerTestDb();
    try {
      callerDb.transaction((tx) => {
        const txDb = tx as unknown as RunLedgerDb;
        seedRun(txDb, "RUN-001");
        seedRun(txDb, "RUN-002");
        // Threading the tx: nextRunLedgerId must observe the two uncommitted
        // rows and return RUN-003. Reading the global seam handle (RUN-001
        // only) would return RUN-002 -- a collision with the in-flight row.
        assert.equal(nextRunLedgerId("RUN", txDb), "RUN-003");
      });
    } finally {
      restore();
    }
  });
});
