import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const CHANGE_SERVICE = path.join(process.cwd(), "server", "services", "change-service.ts");
const CHANGE_PAGE = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "page.tsx"
);
const CHANGE_PHASE_MAP = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "change-phase-map.ts"
);
const PIPELINE_ACTIONS_HOOK = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "use-pipeline-actions.ts"
);
// Request building moved out of the hook into this React-free module so the
// gate-version-drift retry could be tested without a renderer.
const PIPELINE_ACTION_RUNNER = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "pipeline-action-runner.ts"
);
const PIPELINE_ACTION_COMMANDS = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "pipeline-action-commands.ts"
);
const REFINE_CHAT_PANEL = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "refine-chat-panel.tsx"
);
const PROJECT_PAGE = path.join(process.cwd(), "app", "projects", "[id]", "page.tsx");

describe("intake-first change flow", () => {
  it("creates new changes at the intake entry status", () => {
    const content = fs.readFileSync(CHANGE_SERVICE, "utf-8");

    assert.match(content, /const initialStatus = "INTAKE_PENDING"/);
    assert.doesNotMatch(content, /const initialStatus = hasSpec \? "DRAFT" : "REFINING"/);
  });

  it("uses action contracts without treating INTAKE_PENDING as already running", () => {
    const content = fs.readFileSync(CHANGE_PAGE, "utf-8");

    assert.match(content, /visibleContractActions/);
    assert.match(content, /approve_intake/);
    assert.match(content, /const hasActiveRun = change\.latestRun\?\.status === "running"/);

    const runningBlockStart = content.indexOf("const isRunning = hasActiveRun || [");
    assert.notEqual(runningBlockStart, -1);
    const runningBlockEnd = content.indexOf("].includes(change.status)", runningBlockStart);
    assert.notEqual(runningBlockEnd, -1);
    const runningBlock = content.slice(runningBlockStart, runningBlockEnd);
    assert.doesNotMatch(runningBlock, /"INTAKE_PENDING"/);
  });

  it("keeps the late-stage UI bridge selectable", () => {
    const content = fs.readFileSync(CHANGE_PHASE_MAP, "utf-8");
    const actionHook = fs.readFileSync(PIPELINE_ACTIONS_HOOK, "utf-8");
    const actionCommands = fs.readFileSync(PIPELINE_ACTION_COMMANDS, "utf-8");

    const phasesStart = content.indexOf("const PHASES = [");
    assert.notEqual(phasesStart, -1);
    const phasesEnd = content.indexOf("] as const;", phasesStart);
    assert.notEqual(phasesEnd, -1);
    const phasesBlock = content.slice(phasesStart, phasesEnd);
    assert.match(phasesBlock, /"Intake"[\s\S]*"Spec"[\s\S]*"TechSpec"[\s\S]*"Plan"[\s\S]*"TestPlan"/);

    const reviewPhasesStart = content.indexOf("const REVIEW_PHASES: ReviewPhase[] = [");
    assert.notEqual(reviewPhasesStart, -1);
    const reviewPhasesEnd = content.indexOf("];", reviewPhasesStart);
    assert.notEqual(reviewPhasesEnd, -1);
    const reviewPhasesBlock = content.slice(reviewPhasesStart, reviewPhasesEnd);
    assert.match(
      reviewPhasesBlock,
      /"Refine"[\s\S]*"Intake"[\s\S]*"Spec"[\s\S]*"TechSpec"[\s\S]*"Plan"[\s\S]*"TestPlan"[\s\S]*"Build"[\s\S]*"Implement"[\s\S]*"Review"[\s\S]*"Check"[\s\S]*"Fix"[\s\S]*"Merge"[\s\S]*"Retro"/
    );

    assert.match(content, /TESTPLAN_DONE: \{ phase: "TestPlan", state: "done" \}/);
    assert.doesNotMatch(content, /TESTPLAN_DONE: \{ phase: "Plan"/);
    assert.match(fs.readFileSync(PIPELINE_ACTION_RUNNER, "utf-8"), /resolvePipelineActionCommand\(actionId\)/);
    assert.match(actionHook, /runPipelineAction\(\{/);
    assert.match(actionCommands, /run_test_plan: "test-plan"/);
    assert.match(actionCommands, /run_build: "implement"/);
    assert.match(actionCommands, /approve_plan: "approve-plan"/);
    assert.match(content, /LOCAL_READY: \{ phase: "Check", state: "done" \}/);
    assert.match(actionCommands, /enter_qa: "check"/);
  });

  it("keeps intake statuses styled on the project change board", () => {
    const content = fs.readFileSync(PROJECT_PAGE, "utf-8");

    assert.match(content, /"INTAKE_READY"[\s\S]*\.includes\(status\)\) return "info"/);
    assert.match(content, /function statusVariant\(status: string\)/);
    assert.match(content, /variant=\{statusVariant\(c\.status\)\}/);
  });

  it("keeps change deletion visible on the project change board", () => {
    const content = fs.readFileSync(PROJECT_PAGE, "utf-8");
    const deleteLabelStart = content.indexOf("aria-label={`删除 ${c.id}`}");
    assert.notEqual(deleteLabelStart, -1, "delete button should have an accessible label");

    const deleteButtonStart = content.lastIndexOf("<button", deleteLabelStart);
    assert.notEqual(deleteButtonStart, -1, "delete button should open");
    const deleteButtonEnd = content.indexOf("</button>", deleteButtonStart);
    assert.notEqual(deleteButtonEnd, -1, "delete button should close");
    const deleteButton = content.slice(deleteButtonStart, deleteButtonEnd);

    assert.match(deleteButton, /删除/);
    assert.match(deleteButton, /inline-flex/);
    assert.doesNotMatch(deleteButton, /\bhidden\b/);
    assert.doesNotMatch(deleteButton, /group-hover:inline-flex/);
  });

  it("navigates to the new change detail after creation", () => {
    const projectPage = fs.readFileSync(PROJECT_PAGE, "utf-8");
    const dialogPage = fs.readFileSync(
      path.join(process.cwd(), "app", "projects", "[id]", "create-change-dialog.tsx"),
      "utf-8"
    );

    assert.match(projectPage, /useRouter/);
    assert.match(projectPage, /router\.push\(`\/projects\/\$\{projectId\}\/changes\/\$\{change\.id\}`\)/);
    assert.match(projectPage, /<CreateChangeDialog projectId=\{projectId\} onCreated=\{handleChangeCreated\} \/>/);
    assert.match(dialogPage, /onCreated: \(change: \{ id: string \}\) => void/);
    assert.match(dialogPage, /const change = await readJsonResponse\(res\)/);
    assert.match(dialogPage, /onCreated\(\{ id: change\.id \}\)/);
  });

  it("labels requirement confirmation as entering Spec", () => {
    const content = fs.readFileSync(REFINE_CHAT_PANEL, "utf-8");

    assert.match(content, /"确认需求，进入 Spec"/);
    assert.doesNotMatch(content, /"确认需求，进入 Plan"/);
  });

  it("keeps a New Change entry visible while PRD status is still loading", () => {
    const content = fs.readFileSync(PROJECT_PAGE, "utf-8");

    assert.match(content, /const canCreateChange = prdStatus === "ready" \|\| project\?\.prdStatus === "ready"/);
    assert.match(content, /const prdStatusLoading = !project/);
    assert.match(content, /const newChangeDisabled = prdStatusLoading \|\| !canCreateChange/);
    assert.match(content, /canCreateChange \? \(/);
    assert.match(content, /disabled=\{newChangeDisabled\}/);
    assert.match(content, /New Change/);
  });
});
