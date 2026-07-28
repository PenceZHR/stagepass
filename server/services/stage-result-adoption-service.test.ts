import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AiRunResult } from "./ai-engine-types";
import {
  adoptConvergedStageResult,
  StageResultAdoptionError,
} from "./stage-result-adoption-service";

function converged(text = "正式结果"): AiRunResult {
  return {
    threadId: "THREAD-1",
    runId: "ATTEMPT-1",
    summary: text,
    success: true,
    changedFiles: [],
    items: [],
  } as AiRunResult;
}

const context = {
  jobId: "PJOB-1",
  workerId: "worker-1",
  leaseToken: "lease-1",
  attemptNo: 1,
};

describe("stage result adoption", () => {
  it("routes a PRD-phase result to the intake stage with the reply adopted", async () => {
    const calls: Array<{ changeId: string; adopted?: string }> = [];

    await adoptConvergedStageResult({
      changeId: "CHG-1",
      phase: "prd",
      result: converged("正式 PRD"),
      context,
      seal: () => {},
      stages: {
        prd: async (changeId, _context, adoptedResult) => {
          calls.push({ changeId, adopted: adoptedResult.summary });
          return adoptedResult;
        },
      },
    });

    assert.deepEqual(calls, [{ changeId: "CHG-1", adopted: "正式 PRD" }]);
  });

  it("resolves the persisted phase through the shared stage policy", async () => {
    const seen: string[] = [];
    const seal = () => {};
    const stages = {
      prd: async (changeId: string, _c: unknown, adopted: AiRunResult) => {
        seen.push("prd");
        return adopted;
      },
      spec: async (changeId: string, _c: unknown, adopted: AiRunResult) => {
        seen.push("spec");
        return adopted;
      },
    };

    // "intake" and "spec_verdict" are persisted phase names, not stage ids.
    await adoptConvergedStageResult({
      changeId: "CHG-1", phase: "intake", result: converged(), context, stages, seal,
    });
    await adoptConvergedStageResult({
      changeId: "CHG-1", phase: "spec_verdict", result: converged(), context, stages, seal,
    });

    assert.deepEqual(seen, ["prd", "spec"]);
  });

  /**
   * Every test above injects its own stage map, so they pass whatever the
   * PRODUCTION map contains -- which is how Spec stayed unadoptable without a
   * single test noticing. A Spec round that asked the human anything could then
   * only be abandoned by `retry_spec`; the answers the human gave had nothing
   * left to complete. This asserts the real map.
   */
  it("can adopt for every stage whose clarification loop is wired up", async () => {
    const { productionStageAdopters } = await import("./stage-result-adoption-service");

    const adoptable = Object.keys(await productionStageAdopters()).sort();
    // The four design phases that can park a round on the human, plus PRD.
    // Build/Review/QA and the rest are deliberately absent: they produce their
    // result by acting on the repository, so a reply text is not their output
    // and adopting one would record a document the run never made.
    assert.deepEqual(adoptable, ["plan", "prd", "spec", "tech_spec", "test_plan"]);
  });

  // Silently dropping the reply would strand the change with its answers
  // spent and nothing persisted, which is exactly the failure this whole
  // convergence path exists to remove.
  it("fails loudly when no stage can adopt the phase", async () => {
    await assert.rejects(
      () => adoptConvergedStageResult({
        changeId: "CHG-1",
        phase: "some_unmapped_phase",
        result: converged(),
        context,
        stages: {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof StageResultAdoptionError);
        assert.equal(error.code, "stage_adoption_unsupported_phase");
        return true;
      },
    );
  });
});
