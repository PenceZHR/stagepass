import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "app", "projects", "[id]", "changes", "[changeId]");
const component = fs.readFileSync(path.join(root, "plan-sandbox.tsx"), "utf8");
const page = fs.readFileSync(path.join(root, "page.tsx"), "utf8");

describe("Plan evidence surface", () => {
  it("renders plan steps, risks and report evidence", () => {
    assert.match(component, /PlanSandboxState/);
    assert.match(component, /plan\?\.implementationSteps/);
    assert.match(component, /state\?\.risks/);
    assert.match(component, /reportFresh/);
  });

  it("does not submit Plan business decisions from the component", () => {
    assert.doesNotMatch(component, /fetch\(|approve_plan|waive_plan_p1/);
  });

  it("keeps Plan and TestPlan generation in Codex instead of mounting Web sandboxes", () => {
    assert.match(page, /<StageCodexWorkspace/);
    assert.match(page, /stageId=\{selectedStage\.id\}/);
    assert.doesNotMatch(page, /showingPlanSandbox|showingTestPlanSandbox/);
    assert.doesNotMatch(page, /retry_plan|retry_test_plan/);
    assert.doesNotMatch(page, /<PlanSandbox|<TestPlanSandbox/);
  });
});
