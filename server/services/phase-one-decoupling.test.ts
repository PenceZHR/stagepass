import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { runPipelineJob } from "./pipeline-job-runner-service.ts";
import type { PipelineJob } from "./pipeline-job-lease-service.ts";

const ROUTE_ROOT = path.join(
  process.cwd(),
  "app",
  "api",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
);

const QUEUED_ROUTES = [
  "spec",
  "tech-spec",
  "plan",
  "test-plan",
  "implement",
  "review",
  "check",
  "fix",
  "release",
  "retro",
];

describe("phase one route and worker decoupling", () => {
  it("keeps migrated routes enqueue-only", () => {
    for (const segment of QUEUED_ROUTES) {
      const content = fs.readFileSync(path.join(ROUTE_ROOT, segment, "route.ts"), "utf8");
      assert.match(content, /enqueue(?:PipelineJob|ProviderActionAtomically)\(\{/);
      assert.match(content, /jobId: job\.id/);
      assert.match(content, /status: "queued"/);
      assert.match(content, /status: 202/);
      assert.doesNotMatch(content, /setImmediate/);
    }
  });

  it("executes queued work only when the worker runner receives the job", async () => {
    const calls: string[] = [];
    const job: PipelineJob = {
      id: "PJOB-PHASE-ONE-DECOUPLING",
      changeId: "CHG-PHASE-ONE-DECOUPLING",
      phase: "spec",
      actionId: "run_spec",
      idempotencyKey: "phase-one-worker-key",
      status: "queued",
      leasedBy: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      attemptNo: 1,
      errorCode: null,
      errorSummary: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      startedAt: null,
      endedAt: null,
    };

    assert.deepEqual(calls, []);
    await runPipelineJob(job, {
      jobId: job.id,
      workerId: "phase-one-worker",
      leaseToken: "phase-one-lease",
      attemptNo: 1,
    }, {
      runnerMap: {
        "spec:run_spec": async (received) => {
          calls.push(`${received.changeId}:${received.idempotencyKey}`);
        },
      },
    });

    assert.deepEqual(calls, ["CHG-PHASE-ONE-DECOUPLING:phase-one-worker-key"]);
  });
});
