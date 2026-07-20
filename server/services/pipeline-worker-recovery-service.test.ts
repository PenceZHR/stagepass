import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPipelineWorkerRecoverySweeper,
  startPipelineWorkerRecoveryScheduler,
} from "./pipeline-worker-recovery-service";

describe("pipeline-worker-recovery-service", () => {
  it("runs recovery immediately, throttles successful sweeps, and never blocks leasing on failure", async () => {
    let nowMs = 1_000;
    let calls = 0;
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const sweep = createPipelineWorkerRecoverySweeper({
      intervalMs: 5_000,
      nowMs: () => nowMs,
      recover: async () => {
        calls += 1;
        if (calls === 2) throw new Error("recovery unavailable");
        return {
          recovered: calls === 1 ? [{ runId: "RUN-1" }] : [],
          failed: [],
          deferred: [],
          truncated: false,
        };
      },
      log: (event, fields) => logs.push({ event, fields }),
    });

    assert.equal(await sweep(), true);
    assert.equal(calls, 1);
    assert.equal(await sweep(), false);
    assert.equal(calls, 1);

    nowMs += 5_000;
    assert.equal(await sweep(), true);
    assert.equal(calls, 2);
    assert.equal(logs.some((entry) => entry.event === "pipeline_worker_recovery_failed"), true);

    nowMs += 5_000;
    assert.equal(await sweep(), true);
    assert.equal(calls, 3);
    assert.equal(logs.filter((entry) => entry.event === "pipeline_worker_recovery_completed").length, 2);
  });

  it("keeps sweeping while the job loop is awaiting a long-running job", async () => {
    let calls = 0;
    const stop = startPipelineWorkerRecoveryScheduler({
      intervalMs: 10,
      recover: async () => {
        calls += 1;
        return { recovered: [], failed: [], deferred: [], truncated: false };
      },
      log: () => {},
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.ok(calls >= 3, `expected periodic recovery during a long job, received ${calls}`);
    } finally {
      await stop();
    }
    const stoppedAt = calls;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, stoppedAt);
  });

  it("drains an in-flight recovery before shutdown resolves", async () => {
    let release: (() => void) | null = null;
    let completed = false;
    const stop = startPipelineWorkerRecoveryScheduler({
      intervalMs: 10_000,
      recover: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        completed = true;
        return { recovered: [], failed: [], deferred: [], truncated: false };
      },
      log: () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release?.();
    await stopping;
    assert.equal(completed, true);
    assert.equal(stopped, true);
  });
});
