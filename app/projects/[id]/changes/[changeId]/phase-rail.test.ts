import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPhaseRailStages } from "./phase-rail";

const __dirname = dirname(fileURLToPath(import.meta.url));
const phaseRailSource = readFileSync(resolve(__dirname, "phase-rail.tsx"), "utf-8");

describe("phase rail", () => {
  it("renders the canonical user-facing stage labels without exposing Check as a primary label", () => {
    const stages = buildPhaseRailStages({
      status: "DRAFT",
      selectedPhase: "Plan",
    });

    assert.deepEqual(stages.map((stage) => stage.label), [
      "Refine",
      "PRD",
      "Spec",
      "Tech Spec",
      "Plan",
      "Test Plan",
      "Build",
      "Review",
      "Fix",
      "QA",
      "Merge",
      "Retro",
      "Done",
    ]);
    assert.equal(stages.some((stage) => stage.label === "Check"), false);
  });

  it("maps important statuses to the expected user-facing rail stage", () => {
    const cases: Array<[string, string, string]> = [
      ["REFINING", "Refine", "running"],
      ["DRAFT", "Plan", "waiting"],
      ["INTAKE_PENDING", "PRD", "waiting"],
      ["TESTPLAN_DONE", "Test Plan", "needs_review"],
      ["CHECK_FAILED", "QA", "failed"],
      ["SCOPE_FAILED", "QA", "failed"],
      ["FIXING", "Fix", "running"],
      ["LOCAL_READY", "QA", "complete"],
      ["MERGE_READY", "Merge", "needs_review"],
      ["RETRO_PENDING", "Retro", "waiting"],
      ["DONE", "Done", "complete"],
    ];

    for (const [status, label, state] of cases) {
      const selectedStage = buildPhaseRailStages({
        status,
      }).find((stage) => stage.selected);

      assert.equal(selectedStage?.label, label, status);
      assert.equal(selectedStage?.state, state, status);
    }
  });

  it("keeps mobile and desktop rails on one computed model and shared item path", () => {
    assert.match(phaseRailSource, /buildUiPipelineState/);
    assert.match(phaseRailSource, /function PipelineStageItem/);
    assert.match(phaseRailSource, /<PipelineStageItem[\s\S]*variant="mobile"/);
    assert.match(phaseRailSource, /<PipelineStageItem[\s\S]*variant="desktop"/);
  });

  it("selects stages by reviewPhase instead of UI stage id", () => {
    assert.match(phaseRailSource, /onSelectPhase\(stage\.reviewPhase\)/);
    assert.doesNotMatch(phaseRailSource, /onSelectPhase\(stage\.id\)/);
  });
});
