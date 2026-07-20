import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { writeSupervisorHealth } from "@/server/services/supervisor-health-service";
import {
  ensureStartupRecovery,
  resetStartupRecoveryForTest,
  setStartupRecoveryDependenciesForTest,
} from "@/server/services/startup-recovery-service";
import { GET, setHealthRouteDependenciesForTest } from "./route.ts";

describe("health route", { concurrency: false }, () => {
  let tempDir: string;
  let originalLogDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "health-route-"));
    originalLogDir = process.env.STAGEPASS_LOG_DIR;
    process.env.STAGEPASS_LOG_DIR = path.join(tempDir, "logs");
    resetStartupRecoveryForTest();
    setHealthRouteDependenciesForTest(null);
  });

  afterEach(() => {
    resetStartupRecoveryForTest();
    setHealthRouteDependenciesForTest(null);
    if (originalLogDir === undefined) {
      delete process.env.STAGEPASS_LOG_DIR;
    } else {
      process.env.STAGEPASS_LOG_DIR = originalLogDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns service, recovery, worker, db, log, and stale metadata", async () => {
    let recoveryCalls = 0;
    setStartupRecoveryDependenciesForTest({
      logDir: path.join(tempDir, "logs"),
      now: () => new Date("2026-07-10T02:00:00.000Z"),
      checkDb: () => {},
      recover: async (execute) => {
        recoveryCalls += 1;
        return ({
        recovered: [],
        failed: [],
        observed: execute
          ? []
          : [{ kind: "stale", processId: "p1", runId: "r1", changeId: "c1", phase: "spec", reason: "stale" }],
        observedAt: "2026-07-10T02:00:00.000Z",
        });
      },
    });
    setHealthRouteDependenciesForTest({ probeDb: () => {}, inspectStaleRunning: () => 1 });
    fs.mkdirSync(path.join(tempDir, "logs"), { recursive: true });
    const nextIdentity = {
      pid: 111, ppid: 1, pgid: 111, nonce: "next-nonce",
      processStartTime: "2026-07-10T01:59:00.000Z", cwd: process.cwd(), command: ["next"],
    };
    const workerIdentity = {
      pid: 222, ppid: 1, pgid: 222, nonce: "worker-nonce",
      processStartTime: "2026-07-10T01:59:00.000Z", cwd: process.cwd(), command: ["worker"],
    };
    writeSupervisorHealth(path.join(tempDir, "logs", "supervisor-health.json"), {
      next: {
        record: {
          role: "next", identity: nextIdentity, startedAt: "2026-07-10T01:59:00.000Z",
          lastHeartbeatAt: "2026-07-10T02:00:00.000Z",
        },
        restartCount: 0,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:00:00.000Z",
        portListening: true,
        crashLoop: false,
        error: null,
      },
      worker: {
        record: {
          role: "pipeline-worker", identity: workerIdentity, startedAt: "2026-07-10T01:59:00.000Z",
          lastHeartbeatAt: "2026-07-10T02:00:01.000Z",
        },
        restartCount: 0,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:00:01.000Z",
        heartbeat: {
          pid: 222, workerId: "worker-1", workerNonce: "worker-nonce", instanceNonce: "instance-1",
          observedAt: "2026-07-10T02:00:01.000Z", health: "healthy", fatalKind: null,
          currentJob: null, lastJobAt: null,
        },
        crashLoop: false,
        error: null,
      },
      updatedAt: "2026-07-10T02:00:01.000Z",
    });

    const response = await GET();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "stagepass");
    assert.equal(typeof body.timestamp, "string");
    assert.equal(Number.isNaN(Date.parse(body.timestamp)), false);
    assert.equal(typeof body.uptime, "number");
    assert.equal(body.db.ok, true);
    assert.equal(body.logs.exists, true);
    assert.equal("path" in body.logs, false);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(JSON.stringify(body), /\/Users\/[^/]+|\\Users\\[^\\]+/);
    assert.equal(body.recovery.lastRunAt, null);
    assert.equal(recoveryCalls, 0);
    assert.equal(body.staleRunning.count, 1);
    assert.equal(body.worker.mode, "external_worker");
    assert.equal(body.worker.healthy, true);
    assert.equal(body.worker.lastHeartbeatAt, "2026-07-10T02:00:01.000Z");
    assert.equal(body.supervisor.next.portListening, true);
    assert.equal(body.supervisor.worker.crashLoop, false);
  });

  it("does not execute startup recovery from the health GET", async () => {
    let recoveryCalls = 0;
    setStartupRecoveryDependenciesForTest({
      logDir: path.join(tempDir, "logs"),
      checkDb: () => {
        throw new Error("sensitive sqlite /absolute/path unavailable");
      },
      recover: async () => {
        recoveryCalls += 1;
        throw new Error("must not run from GET");
      },
    });
    setHealthRouteDependenciesForTest({ probeDb: () => {}, inspectStaleRunning: () => 0 });

    const response = await GET();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.db.ok, true);
    assert.equal(body.recovery.status, "idle");
    assert.equal(recoveryCalls, 0);
    assert.doesNotMatch(JSON.stringify(body), /sqlite|absolute\/path/i);
  });

  it("returns unhealthy when the current DB probe fails after startup recovery", async () => {
    setStartupRecoveryDependenciesForTest({
      logDir: path.join(tempDir, "logs"),
      checkDb: () => {},
      recover: async () => ({ recovered: [], failed: [], observed: [], observedAt: "2026-07-10T02:00:00.000Z" }),
    });
    setHealthRouteDependenciesForTest({
      probeDb: () => {
        throw new Error("sensitive sqlite trigger /absolute/path failed");
      },
      inspectStaleRunning: () => 0,
    });

    const response = await GET();
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.db.ok, false);
    assert.deepEqual(body.db.error, {
      code: "DATABASE_UNAVAILABLE",
      message: "Database health probe failed",
    });
    assert.doesNotMatch(JSON.stringify(body), /sqlite|trigger|absolute\/path/i);
  });

  it("returns unhealthy partial metadata when startup recovery defers work", async () => {
    setStartupRecoveryDependenciesForTest({
      logDir: path.join(tempDir, "logs"),
      checkDb: () => {},
      recover: async (execute) => ({
        recovered: [], failed: [], observed: [], observedAt: "2026-07-10T02:00:00.000Z",
        processedCandidates: execute ? 1 : 0,
        truncated: execute,
        deferred: execute ? [{ reason: "time_budget", count: 3 }] : [],
      }),
    });
    await ensureStartupRecovery();

    const response = await GET();
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.recovery.status, "partial");
    assert.equal(body.recovery.partial, true);
    assert.equal(body.recovery.deferredCount, 3);
    assert.deepEqual(body.recovery.error, {
      code: "STARTUP_RECOVERY_INCOMPLETE",
      message: "Startup recovery is incomplete",
    });
    assert.doesNotMatch(JSON.stringify(body), /time_budget|candidate_limit/i);
  });
});
