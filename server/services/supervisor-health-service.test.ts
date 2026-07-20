import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  readSupervisorHealth,
  readWorkerHeartbeat,
  updateSupervisorHealth,
  writeWorkerHeartbeat,
  writeSupervisorHealth,
  type SupervisorHealthState,
} from "./supervisor-health-service.ts";
import type { ProcessIdentity } from "./process-identity-service.ts";

function identity(pid: number): ProcessIdentity {
  return {
    pid,
    ppid: process.pid,
    pgid: pid,
    nonce: `identity-${pid}`,
    processStartTime: "2026-07-10T01:02:00.000Z",
    cwd: "/tmp/cc-ai",
    command: [process.execPath, "worker.js"],
  };
}

describe("supervisor health service", () => {
  let tempDir: string;
  let healthFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-health-"));
    healthFile = path.join(tempDir, "logs", "supervisor-health.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("atomically writes and reads supervisor health JSON", () => {
    const state: SupervisorHealthState = {
      next: {
        record: {
          role: "next",
          identity: identity(12345),
          startedAt: "2026-07-10T01:02:00.000Z",
          lastHeartbeatAt: "2026-07-10T01:02:04.000Z",
        },
        restartCount: 2,
        lastExit: {
          exitCode: 1,
          signal: null,
          endedAt: "2026-07-10T01:02:03.000Z",
        },
        lastHealthAt: "2026-07-10T01:02:04.000Z",
        portListening: true,
        crashLoop: false,
        error: null,
      },
      worker: {
        record: {
          role: "pipeline-worker",
          identity: identity(23456),
          startedAt: "2026-07-10T01:02:00.000Z",
          lastHeartbeatAt: "2026-07-10T01:02:04.000Z",
        },
        restartCount: 1,
        lastExit: null,
        lastHealthAt: "2026-07-10T01:02:04.000Z",
        heartbeat: null,
        crashLoop: false,
        error: null,
      },
      updatedAt: "2026-07-10T01:02:04.000Z",
    };

    writeSupervisorHealth(healthFile, state);

    assert.deepEqual(readSupervisorHealth(healthFile), state);
    assert.equal(fs.existsSync(healthFile), true);
    assert.deepEqual(
      fs.readdirSync(path.dirname(healthFile)).filter((name) => name.includes(".tmp")),
      [],
    );
  });

  it("returns null when the health file does not exist", () => {
    assert.equal(readSupervisorHealth(healthFile), null);
  });

  it("patches an existing state without dropping nested next fields", () => {
    writeSupervisorHealth(healthFile, {
      next: {
        record: {
          role: "next",
          identity: identity(222),
          startedAt: "2026-07-10T02:00:00.000Z",
          lastHeartbeatAt: null,
        },
        restartCount: 1,
        lastExit: null,
        lastHealthAt: null,
        portListening: false,
        crashLoop: false,
        error: null,
      },
      worker: {
        record: {
          role: "pipeline-worker",
          identity: identity(333),
          startedAt: "2026-07-10T02:00:00.000Z",
          lastHeartbeatAt: null,
        },
        restartCount: 4,
        lastExit: null,
        lastHealthAt: null,
        heartbeat: null,
        crashLoop: false,
        error: null,
      },
      updatedAt: "2026-07-10T02:00:00.000Z",
    });

    const updated = updateSupervisorHealth(healthFile, {
      next: {
        record: {
          role: "next",
          identity: identity(222),
          startedAt: "2026-07-10T02:00:00.000Z",
          lastHeartbeatAt: "2026-07-10T02:00:05.000Z",
        },
        lastHealthAt: "2026-07-10T02:00:05.000Z",
        portListening: true,
      },
      worker: {
        record: {
          role: "pipeline-worker",
          identity: identity(333),
          startedAt: "2026-07-10T02:00:00.000Z",
          lastHeartbeatAt: "2026-07-10T02:00:06.000Z",
        },
        lastHealthAt: "2026-07-10T02:00:06.000Z",
      },
      updatedAt: "2026-07-10T02:00:05.000Z",
    });

    assert.deepEqual(updated, {
      next: {
        record: {
          role: "next",
          identity: identity(222),
          startedAt: "2026-07-10T02:00:00.000Z",
          lastHeartbeatAt: "2026-07-10T02:00:05.000Z",
        },
        restartCount: 1,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:00:05.000Z",
        portListening: true,
        crashLoop: false,
        error: null,
      },
      worker: {
        record: {
          role: "pipeline-worker",
          identity: identity(333),
          startedAt: "2026-07-10T02:00:00.000Z",
          lastHeartbeatAt: "2026-07-10T02:00:06.000Z",
        },
        restartCount: 4,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:00:06.000Z",
        heartbeat: null,
        crashLoop: false,
        error: null,
      },
      updatedAt: "2026-07-10T02:00:05.000Z",
    });
    assert.deepEqual(readSupervisorHealth(healthFile), updated);
  });

  it("creates a default worker health section when patching a missing file", () => {
    const updated = updateSupervisorHealth(healthFile, {
      worker: {
        record: {
          role: "pipeline-worker",
          identity: identity(555),
          startedAt: "2026-07-10T02:10:00.000Z",
          lastHeartbeatAt: "2026-07-10T02:10:00.000Z",
        },
        restartCount: 1,
        lastHealthAt: "2026-07-10T02:10:00.000Z",
      },
      updatedAt: "2026-07-10T02:10:00.000Z",
    });

    assert.equal(updated.worker.record?.identity.pid, 555);
    assert.equal(updated.worker.restartCount, 1);
    assert.equal(updated.worker.crashLoop, false);
    assert.equal(updated.next.record, null);
    assert.equal(updated.next.portListening, false);
  });

  it("migrates legacy pid-only health on read and writes only record-based process state", () => {
    fs.mkdirSync(path.dirname(healthFile), { recursive: true });
    fs.writeFileSync(healthFile, JSON.stringify({
      next: {
        pid: 121,
        restartCount: 2,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:20:00.000Z",
        portListening: true,
        crashLoop: false,
      },
      worker: {
        pid: 122,
        restartCount: 3,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:20:01.000Z",
        crashLoop: false,
      },
      updatedAt: "2026-07-10T02:20:01.000Z",
    }), "utf-8");

    const migrated = readSupervisorHealth(healthFile);

    assert.equal(migrated?.next.record, null);
    assert.equal(migrated?.worker.record, null);
    assert.equal(migrated?.next.restartCount, 2);
    assert.equal(migrated?.worker.restartCount, 3);

    const nextIdentity = identity(221);
    const workerIdentity = identity(222);
    const updated = updateSupervisorHealth(healthFile, {
      next: {
        record: {
          role: "next",
          identity: nextIdentity,
          startedAt: "2026-07-10T02:21:00.000Z",
          lastHeartbeatAt: "2026-07-10T02:21:01.000Z",
        },
        lastHealthAt: "2026-07-10T02:21:01.000Z",
      },
      worker: {
        record: {
          role: "pipeline-worker",
          identity: workerIdentity,
          startedAt: "2026-07-10T02:21:00.000Z",
          lastHeartbeatAt: "2026-07-10T02:21:02.000Z",
        },
        lastHealthAt: "2026-07-10T02:21:02.000Z",
      },
      updatedAt: "2026-07-10T02:21:02.000Z",
    });

    assert.equal(updated.next.record?.identity.pid, 221);
    assert.equal(updated.worker.record?.identity.pid, 222);
    const persisted = JSON.parse(fs.readFileSync(healthFile, "utf-8"));
    assert.equal("pid" in persisted.next, false);
    assert.equal("pid" in persisted.worker, false);
    assert.equal(persisted.next.record.identity.pgid, 221);
    assert.equal(persisted.worker.record.role, "pipeline-worker");
  });

  it("supports sequential role migration from legacy without carrying stale liveness", () => {
    fs.mkdirSync(path.dirname(healthFile), { recursive: true });
    fs.writeFileSync(healthFile, JSON.stringify({
      next: {
        pid: 301,
        restartCount: 2,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:30:00.000Z",
        portListening: true,
        crashLoop: false,
      },
      worker: {
        pid: 302,
        restartCount: 3,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:30:01.000Z",
        crashLoop: false,
      },
      updatedAt: "2026-07-10T02:30:01.000Z",
    }), "utf-8");

    const nextMigrated = updateSupervisorHealth(healthFile, {
      next: {
        record: {
          role: "next",
          identity: identity(401),
          startedAt: "2026-07-10T02:31:00.000Z",
          lastHeartbeatAt: null,
        },
      },
      updatedAt: "2026-07-10T02:31:00.000Z",
    });

    assert.equal(nextMigrated.next.record?.identity.pid, 401);
    assert.equal(nextMigrated.next.lastHealthAt, null);
    assert.equal(nextMigrated.next.portListening, false);
    assert.equal(nextMigrated.worker.record, null);
    assert.equal(nextMigrated.worker.lastHealthAt, null);
    assert.equal(nextMigrated.worker.heartbeat, null);

    const workerMigrated = updateSupervisorHealth(healthFile, {
      worker: {
        record: {
          role: "pipeline-worker",
          identity: identity(402),
          startedAt: "2026-07-10T02:32:00.000Z",
          lastHeartbeatAt: null,
        },
      },
      updatedAt: "2026-07-10T02:32:00.000Z",
    });

    assert.equal(workerMigrated.next.record?.identity.pid, 401);
    assert.equal(workerMigrated.worker.record?.identity.pid, 402);
    assert.deepEqual(readSupervisorHealth(healthFile), workerMigrated);
    const persisted = JSON.parse(fs.readFileSync(healthFile, "utf-8"));
    assert.equal("pid" in persisted.next, false);
    assert.equal("pid" in persisted.worker, false);
  });

  it("rejects partial current health instead of synthesizing missing fields", () => {
    fs.mkdirSync(path.dirname(healthFile), { recursive: true });
    const partials: unknown[] = [
      {},
      { next: {}, worker: {} },
      {
        next: {
          record: null,
          restartCount: 0,
          lastExit: null,
          lastHealthAt: null,
          portListening: false,
          crashLoop: false,
          error: null,
        },
        worker: {
          record: null,
          restartCount: 0,
          lastExit: null,
          lastHealthAt: null,
          heartbeat: null,
          crashLoop: false,
          error: null,
        },
      },
    ];

    for (const partial of partials) {
      fs.writeFileSync(healthFile, JSON.stringify(partial), "utf-8");
      assert.equal(readSupervisorHealth(healthFile), null);
    }
  });

  it("rejects malformed current identities, dates, exits, and errors", () => {
    const valid: SupervisorHealthState = {
      next: {
        record: {
          role: "next",
          identity: identity(123),
          startedAt: "2026-07-10T01:02:00.000Z",
          lastHeartbeatAt: null,
        },
        restartCount: 0,
        lastExit: null,
        lastHealthAt: null,
        portListening: false,
        crashLoop: false,
        error: null,
      },
      worker: {
        record: null,
        restartCount: 0,
        lastExit: null,
        lastHealthAt: null,
        heartbeat: null,
        crashLoop: false,
        error: null,
      },
      updatedAt: "2026-07-10T01:02:00.000Z",
    };
    const invalidValues = [
      { ...valid, next: { ...valid.next, record: { ...valid.next.record!, identity: { ...valid.next.record!.identity, pid: 0 } } } },
      { ...valid, next: { ...valid.next, record: { ...valid.next.record!, identity: { ...valid.next.record!.identity, nonce: "" } } } },
      { ...valid, next: { ...valid.next, record: { ...valid.next.record!, startedAt: "not-a-date" } } },
      { ...valid, updatedAt: "not-a-date" },
      { ...valid, next: { ...valid.next, lastExit: { exitCode: "1", signal: null, endedAt: valid.updatedAt } } },
      { ...valid, next: { ...valid.next, error: { code: "unknown", reason: "bad", recordedAt: valid.updatedAt } } },
    ];
    fs.mkdirSync(path.dirname(healthFile), { recursive: true });

    for (const invalid of invalidValues) {
      fs.writeFileSync(healthFile, JSON.stringify(invalid), "utf-8");
      assert.equal(readSupervisorHealth(healthFile), null);
    }
  });

  it("rejects semantically contradictory current health combinations", () => {
    const observedAt = "2026-07-10T01:02:00.000Z";
    const nextRecord = {
      role: "next" as const,
      identity: identity(401),
      startedAt: observedAt,
      lastHeartbeatAt: observedAt,
    };
    const workerRecord = {
      role: "pipeline-worker" as const,
      identity: identity(402),
      startedAt: observedAt,
      lastHeartbeatAt: observedAt,
    };
    const heartbeat = {
      pid: 402,
      workerId: "worker-402",
      workerNonce: "nonce-402",
      instanceNonce: "nonce-402",
      observedAt,
      health: "healthy" as const,
      fatalKind: null,
      currentJob: null,
      lastJobAt: null,
    };
    const valid: SupervisorHealthState = {
      next: {
        record: nextRecord,
        restartCount: 0,
        lastExit: null,
        lastHealthAt: observedAt,
        portListening: true,
        crashLoop: false,
        error: null,
      },
      worker: {
        record: workerRecord,
        restartCount: 0,
        lastExit: null,
        lastHealthAt: observedAt,
        heartbeat,
        crashLoop: false,
        error: null,
      },
      updatedAt: observedAt,
    };
    const invalidValues: unknown[] = [
      { ...valid, next: { ...valid.next, record: { ...nextRecord, identity: { ...nextRecord.identity, pgid: null } } } },
      { ...valid, next: { ...valid.next, record: { ...nextRecord, identity: { ...nextRecord.identity, pgid: 999 } } } },
      { ...valid, next: { ...valid.next, lastExit: { exitCode: -1, signal: null, endedAt: observedAt } } },
      { ...valid, next: { ...valid.next, lastExit: { exitCode: null, signal: "NOT_A_SIGNAL", endedAt: observedAt } } },
      { ...valid, next: { ...valid.next, record: null, portListening: true } },
      { ...valid, next: { ...valid.next, record: null, portListening: false, lastHealthAt: observedAt } },
      { ...valid, worker: { ...valid.worker, record: null } },
      { ...valid, worker: { ...valid.worker, record: null, heartbeat: null, lastHealthAt: observedAt } },
      { ...valid, worker: { ...valid.worker, heartbeat: { ...heartbeat, pid: 999 } } },
    ];
    fs.mkdirSync(path.dirname(healthFile), { recursive: true });

    for (const invalid of invalidValues) {
      fs.writeFileSync(healthFile, JSON.stringify(invalid), "utf-8");
      assert.equal(readSupervisorHealth(healthFile), null);
    }
  });

  it("accepts only the exact legacy pid-only migration shape", () => {
    const legacy = {
      next: {
        pid: 121,
        restartCount: 2,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:20:00.000Z",
        portListening: true,
        crashLoop: false,
      },
      worker: {
        pid: 122,
        restartCount: 3,
        lastExit: null,
        lastHealthAt: "2026-07-10T02:20:01.000Z",
        crashLoop: false,
      },
      updatedAt: "2026-07-10T02:20:01.000Z",
    };
    fs.mkdirSync(path.dirname(healthFile), { recursive: true });

    for (const invalid of [
      { ...legacy, updatedAt: undefined },
      { ...legacy, next: { ...legacy.next, pid: 0 } },
      { ...legacy, worker: { ...legacy.worker, unexpected: true } },
      { ...legacy, next: { ...legacy.next, lastHealthAt: "invalid" } },
    ]) {
      fs.writeFileSync(healthFile, JSON.stringify(invalid), "utf-8");
      assert.equal(readSupervisorHealth(healthFile), null);
    }
  });

  it("cleans up the atomic temp file when the final rename fails", () => {
    fs.mkdirSync(healthFile, { recursive: true });
    const state: SupervisorHealthState = {
      next: {
        record: null,
        restartCount: 0,
        lastExit: null,
        lastHealthAt: null,
        portListening: false,
        crashLoop: false,
        error: null,
      },
      worker: {
        record: null,
        restartCount: 0,
        lastExit: null,
        lastHealthAt: null,
        heartbeat: null,
        crashLoop: false,
        error: null,
      },
      updatedAt: "2026-07-10T02:20:01.000Z",
    };

    assert.throws(() => writeSupervisorHealth(healthFile, state));
    assert.deepEqual(
      fs.readdirSync(path.dirname(healthFile)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  it("atomically round-trips complete worker heartbeats and rejects incomplete JSON", () => {
    const heartbeatFile = path.join(tempDir, "logs", "pipeline-worker-heartbeat.json");
    const heartbeat = {
      pid: 321,
      workerId: "pipeline-worker-321",
      workerNonce: "worker-nonce-321",
      instanceNonce: "worker-nonce-321",
      observedAt: "2026-07-10T02:30:00.000Z",
      health: "healthy" as const,
      fatalKind: null,
      currentJob: {
        jobId: "JOB-321",
        attemptNo: 2,
        leaseTokenDigest: "aabbccddeeff0011",
      },
      lastJobAt: "2026-07-10T02:29:59.000Z",
    };

    writeWorkerHeartbeat(heartbeatFile, heartbeat);

    assert.deepEqual(readWorkerHeartbeat(heartbeatFile), heartbeat);
    assert.deepEqual(
      fs.readdirSync(path.dirname(heartbeatFile)).filter((name) => name.includes(".tmp")),
      [],
    );

    fs.writeFileSync(heartbeatFile, JSON.stringify({
      ...heartbeat,
      workerNonce: undefined,
    }), "utf-8");
    assert.equal(readWorkerHeartbeat(heartbeatFile), null);

    fs.writeFileSync(heartbeatFile, "{partial", "utf-8");
    assert.equal(readWorkerHeartbeat(heartbeatFile), null);
  });
});
