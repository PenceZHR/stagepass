import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { runPipelineJob } from "./pipeline-job-runner-service";
import { parsePipelineJobPayload, type PipelineJobRecord } from "./pipeline-job-types";
import type { JobExecutionContext } from "./job-execution-context";

function job(overrides: Partial<PipelineJobRecord> = {}): PipelineJobRecord {
  return {
    id: "PJOB-RUNNER",
    changeId: "CHG-RUNNER",
    phase: "spec",
    actionId: "run_spec",
    idempotencyKey: "runner-key",
    status: "running",
    leasedBy: "worker-1",
    leaseExpiresAt: "2026-07-10T00:01:00.000Z",
    heartbeatAt: "2026-07-10T00:00:30.000Z",
    attemptNo: 1,
    errorCode: null,
    errorSummary: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    startedAt: "2026-07-10T00:00:30.000Z",
    endedAt: null,
    ...overrides,
  };
}

function context(): JobExecutionContext {
  return {
    jobId: "PJOB-RUNNER",
    workerId: "worker-1",
    leaseToken: "lease-token-1",
    attemptNo: 1,
  };
}

function payload(overrides: Partial<PipelineJobRecord> = {}) {
  return parsePipelineJobPayload(job(overrides));
}

describe("pipeline-job-runner-service", () => {
  it("dispatches to an injected runner map by phase and action", async () => {
    const calls: string[] = [];
    const executionContext = context();
    await runPipelineJob(payload(), executionContext, {
      runnerMap: {
        "spec:run_spec": async (pipelineJob, receivedContext) => {
          calls.push(`${pipelineJob.changeId}:${pipelineJob.idempotencyKey}`);
          assert.equal(receivedContext, executionContext);
        },
      },
    });

    assert.deepEqual(calls, ["CHG-RUNNER:runner-key"]);
  });

  it("passes the leased immutable provider to provider-backed stage calls", async () => {
    const executionContext = context();
    const calls: unknown[][] = [];
    const pipeline = new Proxy<Record<string, (...args: unknown[]) => Promise<void>>>({}, {
      get() {
        return async (...args: unknown[]) => {
          calls.push(args);
        };
      },
    });

    await runPipelineJob(
      payload({ provider: "claude", phase: "spec", actionId: "run_spec" }),
      executionContext,
      { pipeline } as never,
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.[2], {
      idempotencyKey: "runner-key",
      provider: "claude",
    });
  });

  it("surfaces runner failures for the worker to mark failed", async () => {
    await assert.rejects(
      () =>
        runPipelineJob(payload({ phase: "review", actionId: "run_review" }), context(), {
          runnerMap: {
            "review:run_review": async () => {
              throw new Error("review exploded");
            },
          },
        }),
      /review exploded/,
    );
  });

  it("rejects an unknown lease-row phase before runner lookup", async () => {
    await assert.rejects(
      () =>
        runPipelineJob(
          { job: { ...job(), phase: "unknown_phase" }, created: false } as never,
          context(),
          {
          runnerMap: {
            unknown_phase: async () => {
              assert.fail("unknown phases must fail closed");
            },
          },
          },
        ),
      /Unsupported pipeline job phase: unknown_phase/,
    );
  });

  it("rejects a known phase paired with another phase's action", async () => {
    let called = false;
    await assert.rejects(
      () =>
        runPipelineJob(
          { job: { ...job(), phase: "spec", actionId: "run_review" }, created: false } as never,
          context(),
          {
          runnerMap: {
            "spec:run_review": async () => {
              called = true;
            },
          },
          },
        ),
      /Unsupported pipeline job phase\/action pair: spec:run_review/,
    );
    assert.equal(called, false);
  });

  it("does not fall back to phase, action, or runner-name keys", async () => {
    for (const fallbackKey of ["spec", "run_spec", "runSpec"]) {
      let called = false;
      await assert.rejects(
        () =>
          runPipelineJob(payload(), context(), {
            runnerMap: {
              [fallbackKey]: async () => {
                called = true;
              },
            },
          }),
        /Unsupported pipeline job action: spec:run_spec/,
      );
      assert.equal(called, false, `${fallbackKey} fallback must not run`);
    }
  });

  it("dispatches all Task 9 phases only when the worker runner consumes them", async () => {
    const calls: string[] = [];
    const runnerMap = {
      "intake:run_prd": async () => calls.push("intake"),
      "prd_briefing_questions:run_prd_briefing_questions": async () => calls.push("questions"),
      "prd_briefing_draft:run_prd_briefing_draft": async () => calls.push("draft"),
      "prd_briefing_final_review:run_prd_briefing_final_review": async () => calls.push("final-review"),
    };
    const cases = [
      ["intake", "run_prd", "intake"],
      ["prd_briefing_questions", "run_prd_briefing_questions", "questions"],
      ["prd_briefing_draft", "run_prd_briefing_draft", "draft"],
      ["prd_briefing_final_review", "run_prd_briefing_final_review", "final-review"],
    ] as const;

    assert.deepEqual(calls, []);
    for (const [phase, actionId, expected] of cases) {
      await runPipelineJob(payload({ phase, actionId }), context(), { runnerMap });
      assert.equal(calls.at(-1), expected);
    }
    assert.deepEqual(calls, ["intake", "questions", "draft", "final-review"]);
  });

  it("uses the real worker dispatch map and preserves one execution identity for every stage", async () => {
    const executionContext = context();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const pipeline = new Proxy<Record<string, (...args: unknown[]) => Promise<void>>>({}, {
      get(_target, property) {
        return async (...args: unknown[]) => {
          calls.push({ method: String(property), args });
        };
      },
    });
    const cases = [
      ["intake", "run_prd", "runIntake"],
      ["intake", "retry_prd", "runIntake"],
      ["prd_briefing_questions", "run_prd_briefing_questions", "runPrdBriefingQuestions"],
      ["prd_briefing_draft", "run_prd_briefing_draft", "runPrdBriefingDraft"],
      ["prd_briefing_final_review", "run_prd_briefing_final_review", "runPrdBriefingFinalReview"],
      ["spec", "run_spec", "runSpec"],
      ["spec", "retry_spec", "runSpec"],
      ["tech_spec", "run_tech_spec", "runTechSpec"],
      ["tech_spec", "retry_tech_spec", "runTechSpec"],
      ["generate_plan", "run_plan", "generatePlan"],
      ["generate_plan", "retry_plan", "generatePlan"],
      ["test_plan", "run_test_plan", "runTestPlan"],
      ["test_plan", "retry_test_plan", "runTestPlan"],
      ["implement", "run_build", "runImplementStreamed"],
      ["implement", "retry_build", "retryBuildStreamed"],
      ["review", "run_review", "runReview"],
      ["review", "retry_review", "runReview"],
      ["local_check", "enter_qa", "runCheck"],
      ["local_check", "run_qa", "runCheck"],
      ["local_check", "retry_qa", "runCheck"],
      ["fix_findings", "fix_blockers", "runFixStreamed"],
      ["fix_findings", "run_fix", "runFixStreamed"],
      ["fix_findings", "retry_fix", "runFixStreamed"],
      ["release", "run_release", "runRelease"],
      ["release", "merge", "runRelease"],
      ["retro", "run_retro", "runRetro"],
    ] as const;

    for (const [phase, actionId, method] of cases) {
      await runPipelineJob(payload({ phase, actionId }), executionContext, { pipeline } as never);
      const call = calls.at(-1);
      assert.equal(call?.method, method);
      assert.equal(call?.args[0], "CHG-RUNNER");
      assert.equal(call?.args[1], executionContext);
    }

    assert.equal(calls.length, cases.length);
  });

  it("keeps the reviewed Task 9 transitional runner signature", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "pipeline-job-runner-service.ts"),
      "utf8",
    ).replace(/\s+/g, " ");

    assert.match(
      source,
      /runPipelineJob\( job: PipelineJobPayload, context: JobExecutionContext, options: RunPipelineJobOptions = \{\}, \): Promise<void>/,
    );
    assert.doesNotMatch(source, /PipelineJob \| PipelineJobPayload/);
  });

  it("keeps long-running pipeline calls out of route source files", () => {
    const routeRoot = path.join(
      process.cwd(),
      "app",
      "api",
      "projects",
      "[id]",
      "changes",
      "[changeId]",
    );
    const routePaths = [
      "spec/route.ts",
      "tech-spec/route.ts",
      "plan/route.ts",
      "test-plan/route.ts",
      "implement/route.ts",
      "review/route.ts",
      "check/route.ts",
      "fix/route.ts",
      "release/route.ts",
      "retro/route.ts",
      "intake/route.ts",
      "prd-briefing/questions/route.ts",
      "prd-briefing/draft/route.ts",
      "prd-briefing/final-review/route.ts",
    ];
    const forbidden = [
      "runSpec(",
      "runTechSpec(",
      "generatePlan(",
      "runTestPlan(",
      "runImplementStreamed(",
      "runReview(",
      "runCheck(",
      "runFixStreamed(",
      "runRelease(",
      "runRetro(",
      "runIntake(",
      "runPrdBriefingQuestions(",
      "runPrdBriefingDraft(",
      "runPrdBriefingFinalReview(",
      'import("@/server/services/pipeline-service")',
      "setImmediate(",
    ];

    for (const routePath of routePaths) {
      const source = fs.readFileSync(path.join(routeRoot, routePath), "utf-8");
      for (const pattern of forbidden) {
        assert.equal(
          source.includes(pattern),
          false,
          `${routePath} should not contain ${pattern}`,
        );
      }
    }
  });
});
