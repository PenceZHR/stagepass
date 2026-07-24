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

  it("keeps operational Plan and TestPlan controls in the shared stage shell", () => {
    assert.match(page, /showingPlanSandbox/);
    assert.match(page, /showingTestPlanSandbox/);
    assert.match(page, /retry_plan/);
    assert.match(page, /retry_test_plan/);
    assert.match(page, /<PhaseStageShell[\s\S]*?<PlanSandbox/);
    assert.match(page, /<PhaseStageShell[\s\S]*?<TestPlanSandbox/);
  });
});
