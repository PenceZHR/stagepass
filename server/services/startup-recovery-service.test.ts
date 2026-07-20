import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ensureStartupRecovery,
  getStartupRecoverySnapshot,
  resetStartupRecoveryForTest,
  setStartupRecoveryDependenciesForTest,
} from "./startup-recovery-service";

describe("startup-recovery-service", { concurrency: false }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-recovery-"));
    resetStartupRecoveryForTest();
  });

  afterEach(() => {
    resetStartupRecoveryForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs startup recovery once and records a completed snapshot", async () => {
    let recoverCalls = 0;
    setStartupRecoveryDependenciesForTest({
      logDir: path.join(tempDir, "logs"),
      now: () => new Date("2026-07-10T01:00:00.000Z"),
      checkDb: () => {},
      recover: async (execute) => {
        recoverCalls += 1;
        return {
          recovered: execute
            ? [{ kind: "recovered", processId: "p1", runId: "r1", changeId: "c1", phase: "spec", reason: "stale" }]
            : [],
          failed: [],
          observed: execute
            ? []
            : [{ kind: "stale", processId: "p2", runId: "r2", changeId: "c1", phase: "spec", reason: "stale" }],
          observedAt: "2026-07-10T01:00:00.000Z",
        };
      },
    });

    const [first, second] = await Promise.all([ensureStartupRecovery(), ensureStartupRecovery()]);

    assert.equal(first.lastRunAt, "2026-07-10T01:00:00.000Z");
    assert.equal(second.lastRunAt, first.lastRunAt);
    assert.equal(first.recoveredCount, 1);
    assert.equal(first.failedCount, 0);
    assert.equal(first.staleCount, 1);
    assert.equal(recoverCalls, 2, "execute and post-recovery dry-run should run once each");
    assert.equal(getStartupRecoverySnapshot().status, "completed");
    assert.equal(fs.existsSync(path.join(tempDir, "logs", "startup-recovery.log")), true);
  });

  it("exposes recovery failures and allows a later retry", async () => {
    let shouldFail = true;
    setStartupRecoveryDependenciesForTest({
      logDir: path.join(tempDir, "logs"),
      now: () => new Date("2026-07-10T01:10:00.000Z"),
      checkDb: () => {
        if (shouldFail) throw new Error("db unavailable");
      },
      recover: async () => ({
        recovered: [],
        failed: [],
        observed: [],
        observedAt: "2026-07-10T01:10:00.000Z",
      }),
    });

    try {
      await ensureStartupRecovery();
      assert.fail("expected startup recovery to fail");
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /db unavailable/);
    }
    assert.equal(getStartupRecoverySnapshot().status, "failed");
    assert.equal(getStartupRecoverySnapshot().error, "db unavailable");

    shouldFail = false;
    const result = await ensureStartupRecovery();

    assert.equal(result.ok, true);
    assert.equal(getStartupRecoverySnapshot().status, "completed");
  });

  it("reports partial per-run recovery failures instead of claiming startup success", async () => {
    setStartupRecoveryDependenciesForTest({
      logDir: path.join(tempDir, "logs"),
      checkDb: () => {},
      recover: async () => ({
        recovered: [{
          kind: "recovered",
          processId: "PRP-RECOVERED",
          runId: "RUN-RECOVERED",
          changeId: "CHG-RECOVERED",
          phase: "tech_spec",
          reason: "provider_start_missing",
          reasonCode: "provider_start_missing",
        }],
        failed: [{
          runId: "RUN-BROKEN",
          changeId: "CHG-BROKEN",
          phase: "spec",
          code: "recovery_failed",
          error: "injected failure",
        }],
        observed: [],
        observedAt: "2026-07-10T01:20:00.000Z",
      }),
    });

    await assert.rejects(() => ensureStartupRecovery(), /1 run recovery failed/);
    const current = getStartupRecoverySnapshot();
    assert.equal(current.status, "failed");
    assert.equal(current.recoveredCount, 1);
    assert.equal(current.failedCount, 1);
    assert.match(current.error ?? "", /RUN-BROKEN/);
  });

  it("records deferred recovery as partial and allows the next call to retry", async () => {
    let executeCalls = 0;
    const seenCursors: Array<{ startedAt: string; id: string } | undefined> = [];
    setStartupRecoveryDependenciesForTest({
      logDir: path.join(tempDir, "logs"),
      checkDb: () => {},
      recover: async (execute, cursor) => {
        if (!execute) return {
          recovered: [], failed: [], observed: [], observedAt: "2026-07-10T01:30:00.000Z",
          processedCandidates: 0, truncated: false, deferred: [],
        };
        executeCalls += 1;
        seenCursors.push(cursor);
        return {
          recovered: [], failed: [], observed: [], observedAt: "2026-07-10T01:30:00.000Z",
          processedCandidates: 1,
          truncated: executeCalls === 1,
          deferred: executeCalls === 1
            ? [{ reason: "candidate_limit" as const, count: 2 }]
            : [],
          nextCursor: executeCalls === 1
            ? { startedAt: "2026-07-10T01:29:00.000Z", id: "RUN-CURSOR" }
            : null,
        };
      },
    });

    const partial = await ensureStartupRecovery();
    assert.equal(partial.ok, false);
    assert.equal(partial.partial, true);
    assert.equal(partial.deferredCount, 2);
    assert.equal(getStartupRecoverySnapshot().status, "partial");
    assert.equal(getStartupRecoverySnapshot().deferredCount, 2);

    const completed = await ensureStartupRecovery();
    assert.equal(completed.ok, true);
    assert.equal(executeCalls, 2);
    assert.deepEqual(seenCursors, [
      undefined,
      { startedAt: "2026-07-10T01:29:00.000Z", id: "RUN-CURSOR" },
    ]);
    assert.equal(getStartupRecoverySnapshot().status, "completed");
  });
});
