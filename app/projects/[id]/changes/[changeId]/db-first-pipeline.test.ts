import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PAGE_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "page.tsx",
);
const PLAN_SANDBOX_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "plan-sandbox.tsx",
);
const BUILD_SANDBOX_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "build-sandbox.tsx",
);
const REVIEW_CENTER_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "review-report-center.tsx",
);
const GATE_PANEL_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "gate-panel.tsx",
);
const PIPELINE_ACTION_CONTRACT_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "pipeline-action-contract.ts",
);
const PIPELINE_ACTIONS_HOOK_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "use-pipeline-actions.ts",
);
// The hook delegates request building and the drift retry to this React-free
// module, so the contract-driven-payload pins below read it instead.
const PIPELINE_ACTION_RUNNER_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "pipeline-action-runner.ts",
);
const PIPELINE_ACTION_COMMANDS_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "pipeline-action-commands.ts",
);
const PIPELINE_UI_MODEL_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "pipeline-ui-model.ts",
);
const CHANGE_COMMANDS_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "use-change-commands.ts",
);
const OPERATIONAL_PHASE_PANEL_PATH = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "operational-phase-panel.tsx",
);
const ACTION_CONTRACT_REGISTRY_PATH = path.join(
  process.cwd(),
  "server",
  "services",
  "action-contract-registry-service.ts",
);

function backendActionIds(): Set<string> {
  const source = fs.readFileSync(ACTION_CONTRACT_REGISTRY_PATH, "utf-8");
  return new Set(
    Array.from(source.matchAll(/actionId:\s*"([^"]+)"/g)).map((match) => match[1]),
  );
}

function frontendReferencedActionIds(): Set<string> {
  const sources = [
    fs.readFileSync(PAGE_PATH, "utf-8"),
    fs.readFileSync(PLAN_SANDBOX_PATH, "utf-8"),
    fs.readFileSync(BUILD_SANDBOX_PATH, "utf-8"),
    fs.readFileSync(REVIEW_CENTER_PATH, "utf-8"),
  ];
  return new Set(
    sources.flatMap((source) =>
      Array.from(source.matchAll(/findPipelineAction\([^,]+,\s*"([^"]+)"/g)).map((match) => match[1])
    ),
  );
}

describe("db-first pipeline UI contracts", () => {
  it("keeps QA entry wired to backend action contracts instead of artifact/log text", () => {
    const actionContract = fs.readFileSync(PIPELINE_ACTION_CONTRACT_PATH, "utf-8");
    const actionHook = fs.readFileSync(PIPELINE_ACTIONS_HOOK_PATH, "utf-8");
    const checkRoute = fs.readFileSync(
      path.join(
        process.cwd(),
        "app",
        "api",
        "projects",
        "[id]",
        "changes",
        "[changeId]",
        "check",
        "route.ts",
      ),
      "utf-8",
    );

    assert.match(actionContract, /interface PipelineActionContract/);
    assert.match(actionHook, /type PipelineActionContract/);
    assert.match(actionHook, /actions\?: PipelineActionContract\[\]/);
    assert.match(checkRoute, /assertCanRunCheck/);
    assert.match(checkRoute, /PreflightBlockedError/);
    assert.match(checkRoute, /err\.envelope\.error !== "action_not_allowed"/);
    assert.doesNotMatch(checkRoute, /qa-log\.md|local-check\.json|review-report\.md/);
  });

  it("does not derive business command buttons from ChangeStatus or artifact presence", () => {
    const source = fs.readFileSync(PAGE_PATH, "utf-8");
    const actionRunner = fs.readFileSync(PIPELINE_ACTION_RUNNER_PATH, "utf-8");
    const plan = fs.readFileSync(PLAN_SANDBOX_PATH, "utf-8");
    const build = fs.readFileSync(BUILD_SANDBOX_PATH, "utf-8");

    assert.match(source, /visibleContractActions/);
    assert.doesNotMatch(source, /visibleActions/);
    assert.doesNotMatch(source, /ACTION_ENDPOINTS: Record<string, string> = \{\s*"Run /);
    assert.match(source, /const visibleContractActions = pipelineActions\.filter/);
    assert.match(actionRunner, /findPipelineAction\(actions, actionId\)/);

    assert.match(plan, /actions\?: PipelineActionContract\[\]/);
    assert.match(source, /const planStageActions = useMemo<StageActionView\[\]>\(\(\) =>/);
    assert.match(source, /makePlanStageAction\("run_plan", "生成计划", "primary", \(\) => handleAction\("run_plan"\)\)/);
    assert.match(source, /makePlanStageAction\("approve_plan", "批准计划", "primary", handleApprovePlanSandbox\)/);
    assert.match(source, /makePlanStageAction\("regenerate_plan_report", "刷新计划审查", "secondary", handleRegeneratePlanSandboxReport\)/);
    assert.match(source, /makePlanStageAction\("run_test_plan", "生成测试计划", "primary", \(\) => handleAction\("run_test_plan"\)\)/);
    assert.doesNotMatch(source, /makePlanStageAction\("run_build", "开始 Build"/);
    assert.doesNotMatch(plan, /const approveAction = findPipelineAction\(actions, "approve_plan"\)/);
    assert.doesNotMatch(plan, /const approveDisabled = disabled \|\| approveAction\?\.enabled !== true/);
    assert.doesNotMatch(plan, /findPipelineAction\(actions, "run_test_plan"\)/);
    assert.doesNotMatch(plan, /findPipelineAction\(actions, "run_build"\)/);
    assert.doesNotMatch(plan, /const approveDisabled = disabled \|\| planAlreadyApproved \|\| !state\?\.gate\.canApprove/);
    assert.doesNotMatch(plan, /const reportDisabled = disabled \|\| !state\?\.plan/);
    assert.doesNotMatch(plan, /const showRunTestPlan = changeStatus === "PLAN_APPROVED"/);

    assert.match(build, /actions\?: PipelineActionContract\[\]/);
    assert.match(build, /const canStartBuild = startBuildAction\?\.enabled === true/);
    assert.match(build, /const canApproveAbsorb = approveAbsorbAction\?\.enabled === true/);
    assert.doesNotMatch(build, /const canStartBuild = !buildRun \|\| buildRun\.status === "rejected"/);
    assert.doesNotMatch(build, /const canApproveAbsorb = buildRun\?\.status === "awaiting_human"/);
  });

  it("wires Retro as a general pipeline action", () => {
    const source = fs.readFileSync(PAGE_PATH, "utf-8");
    const actionCommands = fs.readFileSync(PIPELINE_ACTION_COMMANDS_PATH, "utf-8");

    assert.match(actionCommands, /run_retro:\s*"retro"/);
    assert.match(source, /GENERAL_ACTION_IDS[\s\S]*"run_retro"/);
  });

  it("sends preflight payloads from the same action contract used by the buttons", () => {
    const changeCommands = fs.readFileSync(CHANGE_COMMANDS_PATH, "utf-8");
    const build = fs.readFileSync(BUILD_SANDBOX_PATH, "utf-8");
    const actionContract = fs.readFileSync(PIPELINE_ACTION_CONTRACT_PATH, "utf-8");
    const actionHook = fs.readFileSync(PIPELINE_ACTIONS_HOOK_PATH, "utf-8");
    const actionRunner = fs.readFileSync(PIPELINE_ACTION_RUNNER_PATH, "utf-8");

    assert.match(actionRunner, /resolvePipelineActionCommand\(actionId\)/);
    // The payload is still built from the contract, and both the first attempt
    // and the drift retry go through this one expression.
    assert.match(actionRunner, /withSelectedProvider\(createPipelinePreflightPayload\(contractAction\), contractAction, provider\)/);
    assert.match(actionHook, /body: JSON\.stringify\(payload\)/);
    assert.match(actionContract, /actionId: action\?\.actionId/);
    assert.match(changeCommands, /const approveAction = findPipelineAction\(gateStatus\?\.actions, "approve_plan"\)/);
    assert.match(changeCommands, /body: JSON\.stringify\(createPipelinePreflightPayload\(approveAction\)\)/);
    assert.match(build, /body: JSON\.stringify\(createPipelinePreflightPayload\(contractAction, \{/);
    assert.match(build, /expectedHeadSha: state\?\.baseCamp\.headSha \?\? undefined/);
    assert.match(build, /body: JSON\.stringify\(createPipelinePreflightPayload\(contractAction, \{/);
  });

  it("keeps Review actions contract-backed without legacy boolean fallback", () => {
    const review = fs.readFileSync(REVIEW_CENTER_PATH, "utf-8");

    assert.match(review, /actions\?: PipelineActionContract\[\]/);
    assert.match(review, /function resolveReviewRunCommand/);
    assert.match(review, /pipelineActionDisabledReason\(findPipelineAction\(input\.pipelineActions, actionId\)\)/);
    assert.match(review, /const enterQaAction = findPipelineAction\(actions, "enter_qa"\)/);
    assert.match(review, /const waiveAction = findPipelineAction\(actions, "waive_review_p1"\)/);
    assert.match(review, /const fixAction = findPipelineAction\(actions, "fix_blockers"\)/);
    assert.doesNotMatch(review, /state\?\.actions\?\.\[id\]/);
    assert.doesNotMatch(review, /getAction\(state/);
    assert.doesNotMatch(review, /reviewActionDisabledReason/);
    assert.doesNotMatch(review, /Boolean\(legacy\?\.canRunReview\)/);
    assert.doesNotMatch(review, /Boolean\(legacy\?\.canEnterQa\)/);
    assert.doesNotMatch(review, /recompute_report: Boolean\(state\?\.latestAttempt\)/);
  });

  it("keeps Merge approval and Review commands behind canonical preflight action ids", () => {
    const source = fs.readFileSync(PAGE_PATH, "utf-8");
    const changeCommands = fs.readFileSync(CHANGE_COMMANDS_PATH, "utf-8");
    const gatePanel = fs.readFileSync(GATE_PANEL_PATH, "utf-8");
    const fixRoute = fs.readFileSync(
      path.join(process.cwd(), "app", "api", "projects", "[id]", "changes", "[changeId]", "fix", "route.ts"),
      "utf-8",
    );
    const blockRoute = fs.readFileSync(
      path.join(process.cwd(), "app", "api", "projects", "[id]", "changes", "[changeId]", "block", "route.ts"),
      "utf-8",
    );
    const waiveRoute = fs.readFileSync(
      path.join(
        process.cwd(),
        "app",
        "api",
        "projects",
        "[id]",
        "changes",
        "[changeId]",
        "findings",
        "[findingId]",
        "waive",
        "route.ts",
      ),
      "utf-8",
    );

    assert.match(gatePanel, /if \(gate === "merge"\) return "approve_merge"/);
    assert.match(gatePanel, /if \(gate === "merge"\) return "reject_merge"/);
    assert.match(changeCommands, /const mergeAction = findPipelineAction\(latestGateStatus\.actions, "merge"\)/);
    assert.match(changeCommands, /createPipelinePreflightPayload\(rejectAction, \{ gate: gateStatus\.gate \}\)/);
    assert.match(changeCommands, /body: nextStageBody/);
    assert.doesNotMatch(source, /usesReviewCenterOnlyAction/);
    assert.match(fixRoute, /actionId: "fix_blockers"/);
    assert.match(blockRoute, /actionId: "stop_change"/);
    assert.match(waiveRoute, /actionId: "waive_review_p1"/);
  });

  it("keeps QA and Merge first screens free of raw live panels", () => {
    const source = fs.readFileSync(PAGE_PATH, "utf-8");
    const operationalPanel = fs.readFileSync(OPERATIONAL_PHASE_PANEL_PATH, "utf-8");

    assert.match(source, /const showingOperationalPhaseSummary = activeSelectedPhase === "Check" \|\| activeSelectedPhase === "Merge"/);
    assert.match(source, /records=\{renderPhaseRecords\(activeSelectedPhase, "operational-records"\)\}/);
    assert.match(source, /actions=\{operationalStageActions\}/);
    assert.match(source, /blockers=\{operationalStageBlockers\}/);
    assert.match(source, /actionError=\{operationalStageActionError\}/);
    assert.doesNotMatch(source, /showingGatePanel/);
    assert.doesNotMatch(source, /\{showingGatePanel && \(/);
    assert.doesNotMatch(source, /!\(showingOperationalPhaseSummary && gateStatus\?\.gate === "merge"\)/);
    assert.match(source, /const mergeReadinessBlockers = activeSelectedPhase === "Merge"[\s\S]*buildMergeReadinessBlockers\(gateStatus\?\.mergeChecks\)/);
    assert.match(source, /mergeChecks=\{activeSelectedPhase === "Merge" \? gateStatus\?\.mergeChecks : undefined\}/);
    assert.match(operationalPanel, /phase === "Check" \? "QA 工作区" : "Merge 工作区"/);
    assert.doesNotMatch(operationalPanel, /QA 战报/);
    assert.doesNotMatch(operationalPanel, /Merge 指挥台/);
    assert.match(operationalPanel, /Merge readiness facts/);
    assert.match(operationalPanel, /QA passed/);
    assert.match(operationalPanel, /Review passed/);
    assert.match(operationalPanel, /Docs complete/);
    assert.match(operationalPanel, /Requirements/);
    assert.match(operationalPanel, /原始运行记录在下方折叠区/);
    assert.match(operationalPanel, /避免首屏暴露底层路径或日志/);
    assert.doesNotMatch(operationalPanel, /<Button/);
    assert.doesNotMatch(operationalPanel, /pipelineActionDisabledReason/);
  });

  it("renders disabled action reasons with stable unique keys", () => {
    const source = fs.readFileSync(PAGE_PATH, "utf-8");
    const review = fs.readFileSync(REVIEW_CENTER_PATH, "utf-8");
    const operationalPanel = fs.readFileSync(OPERATIONAL_PHASE_PANEL_PATH, "utf-8");

    assert.doesNotMatch(source, /<p key=\{reason\}>/);
    assert.doesNotMatch(review, /<p key=\{reason\}>/);
    assert.doesNotMatch(operationalPanel, /key=\{`\$\{action\.actionId\}:\$\{reason\}`\}/);
    assert.match(source, /id: `operational-blocker-\$\{action\.actionId\}`/);
    assert.doesNotMatch(review, /key=\{`\$\{reason\}:\$\{index\}`\}/);
  });

  it("filters operational actions by the selected stage action ids", () => {
    const source = fs.readFileSync(PAGE_PATH, "utf-8");
    const uiModel = fs.readFileSync(PIPELINE_UI_MODEL_PATH, "utf-8");

    assert.match(source, /const operationalActionIds = useMemo\(\(\) => selectedStage\?\.actionIds \?\? \[\]/);
    assert.match(source, /action\.phase === operationalContractPhase[\s\S]*operationalActionIds\.includes\(action\.actionId\)/);
    assert.match(uiModel, /actionIds: \["approve_merge", "reject_merge", "merge"\]/);
  });

  it("only references action ids that exist in the backend action contract", () => {
    const backend = backendActionIds();
    const missing = Array.from(frontendReferencedActionIds()).filter((actionId) => !backend.has(actionId));

    assert.deepEqual(missing, []);
  });
});
