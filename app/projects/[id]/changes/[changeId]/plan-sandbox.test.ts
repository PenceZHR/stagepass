import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const componentSource = readFileSync(resolve(__dirname, "plan-sandbox.tsx"), "utf-8");
const typesSource = readFileSync(resolve(__dirname, "plan-sandbox-types.ts"), "utf-8");
const testPlanComponentSource = readFileSync(resolve(__dirname, "testplan-sandbox.tsx"), "utf-8");
const dataHookSource = readFileSync(resolve(__dirname, "use-change-detail-data.ts"), "utf-8");
const clientSource = readFileSync(resolve(__dirname, "change-api-client.ts"), "utf-8");
const changeCommandsSource = readFileSync(resolve(__dirname, "use-change-commands.ts"), "utf-8");
const phaseMapSource = readFileSync(resolve(__dirname, "change-phase-map.ts"), "utf-8");
const pipelineActionCommandsSource = readFileSync(
  resolve(__dirname, "pipeline-action-commands.ts"),
  "utf-8",
);

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const planBranchSource = sourceBetween(
  pageSource,
  ") : showingPlanSandbox ? (",
  ") : showingPrdBriefingRoom ? (",
);

describe("Plan Sandbox UI", () => {
  it("defines the Plan sandbox state contract used by the page and component", () => {
    assert.match(typesSource, /export interface PlanSandboxState/);
    assert.match(typesSource, /export interface PlanRisk/);
    assert.match(typesSource, /export interface PlanGate/);
    assert.match(typesSource, /planName\?: string/);
    assert.match(typesSource, /status\?: "pending" \| "blocked" \| "done"/);
    assert.match(typesSource, /PlanRiskSeverity = "P0" \| "P1" \| "P2"/);
  });

  it("renders a focused Plan sandbox instead of the generic action strip", () => {
    assert.match(componentSource, /export function PlanSandbox/);
    assert.match(componentSource, /data-plan-workspace/);
    assert.match(componentSource, /任务地图/);
    assert.match(componentSource, /反方拦截/);
    assert.match(componentSource, /执行许可/);
    assert.match(componentSource, /当前 Change/);
    assert.match(componentSource, /计划名称/);
    assert.match(componentSource, /taskStatusCopy/);
    assert.match(componentSource, /接受 P1/);
    assert.doesNotMatch(componentSource, /Plan 作战沙盘/);
    assert.doesNotMatch(componentSource, /作战沙盘/);
    assert.doesNotMatch(componentSource, /战报/);
    assert.doesNotMatch(componentSource, /<section className="mb-6 overflow-hidden rounded-lg border bg-background"/);
  });

  it("keeps Plan workspace proportions task-first instead of three cramped columns", () => {
    assert.match(componentSource, /sm:grid-cols-\[14rem_minmax\(0,1fr\)\]/);
    assert.match(componentSource, /<div className="space-y-4">/);
    assert.match(componentSource, /<div className="grid gap-4 xl:grid-cols-2">/);
    assert.match(componentSource, /<p className="min-w-0 break-words text-sm font-medium leading-5">/);
    assert.ok(
      componentSource.indexOf("<h4 className=\"text-sm font-semibold\">执行许可</h4>") <
        componentSource.indexOf("<h4 className=\"text-sm font-semibold\">任务地图</h4>"),
      "gate status should stay visible before the long task map",
    );
    assert.ok(
      componentSource.indexOf("<h4 className=\"text-sm font-semibold\">执行许可</h4>") <
        componentSource.indexOf("<h4 className=\"text-sm font-semibold\">反方拦截</h4>"),
      "gate status should lead the plan overview before risk details",
    );
    assert.doesNotMatch(componentSource, /xl:grid-cols-\[minmax\(0,1\.05fr\)_minmax\(0,1fr\)_20rem\]/);
    assert.doesNotMatch(componentSource, /2xl:grid-cols-\[minmax\(0,1fr\)_22rem\]/);
  });

  it("does not render duplicated Plan command buttons inside the workspace", () => {
    assert.doesNotMatch(componentSource, /changeStatus: string/);
    assert.doesNotMatch(componentSource, /error\?: string/);
    assert.doesNotMatch(componentSource, /actionError\?: string/);
    assert.doesNotMatch(componentSource, /onGeneratePlan: \(\) => void/);
    assert.doesNotMatch(componentSource, /onApprovePlan: \(\) => void/);
    assert.doesNotMatch(componentSource, /onRunTestPlan: \(\) => void/);
    assert.doesNotMatch(componentSource, /onRunImplement: \(\) => void/);
    assert.doesNotMatch(componentSource, /onRegenerateReport: \(\) => void/);
    assert.doesNotMatch(componentSource, /onClick=\{onGeneratePlan\}/);
    assert.doesNotMatch(componentSource, /onClick=\{onRegenerateReport\}/);
    assert.doesNotMatch(componentSource, /onClick=\{onApprovePlan\}/);
    assert.doesNotMatch(componentSource, /onClick=\{onRunTestPlan\}/);
    assert.doesNotMatch(componentSource, /onClick=\{onRunImplement\}/);
    assert.doesNotMatch(componentSource, /approveAction\?\.label/);
    assert.doesNotMatch(componentSource, /生成计划/);
    assert.doesNotMatch(componentSource, /批准计划/);
    assert.doesNotMatch(componentSource, /刷新计划审查/);
    assert.doesNotMatch(componentSource, /执行测试计划/);
    assert.doesNotMatch(componentSource, /开始 Build/);
    assert.doesNotMatch(componentSource, /\(error \|\| actionError\)/);
  });

  it("keeps TestPlan actions in TestPlan and leaves Build start to the Build stage", () => {
    assert.doesNotMatch(componentSource, /latestRunPhase\?: string \| null/);
    assert.doesNotMatch(componentSource, /latestRunStatus\?: string \| null/);
    assert.doesNotMatch(componentSource, /testPlanCompleted\?: boolean/);
    assert.doesNotMatch(componentSource, /const testPlanAction = findPipelineAction\(actions, "run_test_plan"\)/);
    assert.doesNotMatch(componentSource, /const buildAction = findPipelineAction\(actions, "run_build"\)/);
    assert.doesNotMatch(componentSource, /const testPlanDisabled = disabled \|\| testPlanAction\?\.enabled !== true/);
    assert.doesNotMatch(componentSource, /const buildDisabled = disabled \|\| buildAction\?\.enabled !== true/);
    assert.doesNotMatch(componentSource, /const showRunTestPlan = changeStatus === "PLAN_APPROVED"/);
    assert.doesNotMatch(componentSource, /const showRunImplement = changeStatus === "PLAN_APPROVED"/);
    assert.doesNotMatch(componentSource, /开始实现/);
    assert.doesNotMatch(componentSource, /changeStatus === "PLAN_APPROVED" && \(\s*<>/);
    assert.match(pageSource, /makePlanStageAction\("run_test_plan", "生成测试计划", "primary", \(\) => handleAction\("run_test_plan"\)\)/);
    assert.doesNotMatch(pageSource, /makePlanStageAction\("run_build", "开始 Build"/);
    assert.doesNotMatch(pageSource, /latestRunPhase=\{change\.latestRun\?\.phase \?\? null\}/);
    assert.doesNotMatch(pageSource, /latestRunStatus=\{change\.latestRun\?\.status \?\? null\}/);
    assert.doesNotMatch(pageSource, /testPlanCompleted=\{change\.testPlanCompleted\}/);
  });

  it("keeps disabled action reason rendering out of the Plan workspace command area", () => {
    assert.doesNotMatch(componentSource, /key=\{reason\}/);
    assert.doesNotMatch(componentSource, /\.map\(\(reason, index\) => \(/);
    assert.doesNotMatch(componentSource, /key=\{`\$\{reason\}-\$\{index\}`\}/);
  });

  it("loads Plan sandbox state and wires report, waiver, and approval actions", () => {
    assert.match(pageSource, /import \{ PlanSandbox \} from "\.\/plan-sandbox";/);
    assert.match(dataHookSource, /import type \{ PlanSandboxState \} from "\.\/plan-sandbox-types";/);
    assert.match(dataHookSource, /const \[planSandboxState, setPlanSandboxState\] = useState<PlanSandboxState \| null>/);
    assert.match(dataHookSource, /const loadPlanSandboxState = useCallback/);
    assert.match(dataHookSource, /\.getPlanSandbox\(\)/);
    assert.match(pageSource, /\/plan-sandbox\/report/);
    assert.match(pageSource, /\/plan-sandbox\/decision/);
    assert.match(changeCommandsSource, /\/approve-plan/);
    assert.match(changeCommandsSource, /findPipelineAction\(gateStatus\?\.actions, "approve_plan"\)/);
    assert.match(pageSource, /handleApprovePlanSandbox/);
    const planSandboxCallStart = pageSource.indexOf("<PlanSandbox");
    assert.notEqual(planSandboxCallStart, -1, "PlanSandbox call should exist");
    const planSandboxCallEnd = pageSource.indexOf("/>", planSandboxCallStart);
    assert.notEqual(planSandboxCallEnd, -1, "PlanSandbox call should be self-closing");
    const planSandboxCall = pageSource.slice(planSandboxCallStart, planSandboxCallEnd);

    assert.match(planSandboxCall, /state=\{planSandboxState\}/);
    assert.match(planSandboxCall, /actions=\{pipelineActions\}/);
    assert.match(planSandboxCall, /busy=\{gateBusy \|\| running\}/);
    assert.match(planSandboxCall, /loading=\{gateLoading\}/);
    assert.match(planSandboxCall, /onWaiveRisk=\{handleWaivePlanRisk\}/);
    assert.doesNotMatch(planSandboxCall, /changeStatus=\{change\.status\}/);
    assert.doesNotMatch(planSandboxCall, /latestRunPhase=/);
    assert.doesNotMatch(planSandboxCall, /latestRunStatus=/);
    assert.doesNotMatch(planSandboxCall, /testPlanCompleted=/);
    assert.doesNotMatch(planSandboxCall, /error=/);
    assert.doesNotMatch(planSandboxCall, /actionError=/);
    assert.doesNotMatch(planSandboxCall, /onGeneratePlan=/);
    assert.doesNotMatch(planSandboxCall, /onApprovePlan=/);
    assert.doesNotMatch(planSandboxCall, /onRunTestPlan=/);
    assert.doesNotMatch(planSandboxCall, /onRunImplement=/);
    assert.doesNotMatch(planSandboxCall, /onRegenerateReport=/);
  });

  it("loads and renders TestPlan sandbox state separately from PlanSandbox", () => {
    assert.match(pageSource, /import \{ TestPlanSandbox \} from "\.\/testplan-sandbox";/);
    assert.match(pageSource, /const showingPlanSandbox = activeSelectedPhase === "Plan"/);
    assert.match(pageSource, /const showingTestPlanSandbox = activeSelectedPhase === "TestPlan"/);
    assert.match(pageSource, /<TestPlanSandbox/);
    assert.match(dataHookSource, /testPlanSandboxState/);
    assert.match(dataHookSource, /loadTestPlanSandboxState/);
    assert.match(changeCommandsSource, /loadTestPlanSandboxState/);
    assert.match(clientSource, /getTestPlanSandbox/);
    assert.match(testPlanComponentSource, /export function TestPlanSandbox/);
    assert.match(testPlanComponentSource, /Coverage Items/);
    assert.match(testPlanComponentSource, /Risk Mappings/);
    assert.match(testPlanComponentSource, /Required Commands/);
    assert.match(testPlanComponentSource, /Manual Checks/);
    assert.doesNotMatch(testPlanComponentSource, /implementationSteps/);
    assert.doesNotMatch(testPlanComponentSource, /planName/);
  });

  it("treats Plan as a real pipeline phase on the page", () => {
    const phasesStart = phaseMapSource.indexOf("export const PHASES = [");
    const phasesEnd = phaseMapSource.indexOf("] as const;", phasesStart);
    const phasesBlock = phaseMapSource.slice(phasesStart, phasesEnd);
    assert.match(phasesBlock, /"Plan"/);
    assert.match(phasesBlock, /"Intake"[\s\S]*"Spec"[\s\S]*"TechSpec"[\s\S]*"Plan"[\s\S]*"TestPlan"/);
    assert.match(phaseMapSource, /DRAFT: \{ phase: "Plan", state: "waiting" \}/);
    assert.match(phaseMapSource, /PLANNING: \{ phase: "Plan", state: "running" \}/);
    assert.match(phaseMapSource, /PLAN_READY: \{ phase: "Plan", state: "done" \}/);
    assert.match(phaseMapSource, /PLAN_APPROVED: \{ phase: "Plan", state: "done" \}/);
    assert.match(phaseMapSource, /TESTPLAN_DONE: \{ phase: "TestPlan", state: "done" \}/);
    assert.match(pageSource, /const showingPlanSandbox = activeSelectedPhase === "Plan"/);
    assert.match(pageSource, /const showingTestPlanSandbox = activeSelectedPhase === "TestPlan"/);
    assert.doesNotMatch(pageSource, /showingPlanSandbox = activeSelectedPhase === "Plan" \|\| change\.status === "TESTPLAN_DONE"/);
  });

  it("mirrors distinct Plan and TestPlan primary actions into the shared stage header", () => {
    assert.match(pageSource, /import type \{ StageActionView \} from "\.\/stage-action-bar";/);
    assert.match(pageSource, /const planStageActions = useMemo<StageActionView\[\]>\(\(\) =>/);
    assert.match(pageSource, /activeSelectedPhase === "TestPlan"/);
    assert.match(pageSource, /makePlanStageAction\("run_plan", "生成计划", "primary", \(\) => handleAction\("run_plan"\)\)/);
    assert.match(pageSource, /makePlanStageAction\("approve_plan", "批准计划", "primary", handleApprovePlanSandbox\)/);
    assert.match(pageSource, /makePlanStageAction\("regenerate_plan_report", "刷新计划审查", "secondary", handleRegeneratePlanSandboxReport\)/);
    assert.doesNotMatch(pageSource, /生成作战计划/);
    assert.doesNotMatch(pageSource, /批准作战计划/);
    assert.doesNotMatch(pageSource, /刷新战报/);
    assert.match(pageSource, /makePlanStageAction\("run_test_plan", "生成测试计划", "primary", \(\) => handleAction\("run_test_plan"\)\)/);
    assert.match(pageSource, /makePlanStageAction\("approve_plan", "确认测试计划", "primary", handleApprovePlanSandbox\)/);
    assert.doesNotMatch(pageSource, /makePlanStageAction\("run_build", "开始 Build"/);
    assert.match(pageSource, /const planStageBusy = gateBusy \|\| running;/);
    assert.match(pageSource, /busy: planStageBusy,/);
    assert.match(pageSource, /planStageBusy,/);
    assert.match(pageSource, /const planStageActionError = gateError \|\| actionError;/);
    assert.match(pageSource, /actions=\{planStageActions\}/);
    assert.match(pageSource, /actionError=\{planStageActionError\}/);
    assert.doesNotMatch(planBranchSource, /actionError=\{gateError\}/);
  });

  /**
   * The 0d6d6d6b gap one stage over. A Plan run killed mid-flight leaves the
   * change at PLANNING, which pipeline-ui-model maps to this same sandbox panel
   * -- where run_plan and approve_plan are both correctly disabled. The backend
   * offers retry_plan (it recovers the stranded status and reruns), but the
   * Plan action bar was hardcoded to run/approve/regenerate, so nothing drew
   * it and the user saw a fully disabled bar with no path forward.
   *
   * retry_plan being listed in GENERAL_ACTION_IDS does not cover this: that
   * fallback bar renders only in the terminal else of the panel ternary, and
   * showingPlanSandbox short-circuits ahead of it for every Plan-phase change.
   */
  it("offers retry_plan on the Plan stage panel so a killed Plan run is not a dead end", () => {
    assert.match(
      pageSource,
      /makePlanStageAction\("retry_plan", "重新生成计划", "secondary", \(\) => handleAction\("retry_plan"\)\)/,
    );
    // It has to sit in the Plan branch, not the TestPlan one above it.
    const planBranchStart = pageSource.indexOf('if (activeSelectedPhase === "Plan") {');
    assert.notEqual(planBranchStart, -1);
    const planBranch = pageSource.slice(planBranchStart, pageSource.indexOf("];", planBranchStart));
    assert.match(planBranch, /makePlanStageAction\("retry_plan"/);
    // And it must resolve to a real endpoint, or the button is inert
    // (the silent-no-op 0d6d6d6b closed).
    assert.match(pipelineActionCommandsSource, /retry_plan: "plan"/);
  });

  /**
   * The identical gap one stage earlier. TESTPLANNING maps to the TestPlan
   * sandbox panel (pipeline-ui-model STATUS_STAGE), where run_test_plan
   * (requiredStatus PLAN_APPROVED) and approve_plan (PLAN_READY/TESTPLAN_DONE)
   * are both correctly disabled -- so a TestPlan run killed mid-flight left the
   * user staring at a fully disabled bar.
   *
   * retry_test_plan was already declared on the stage (pipeline-ui-model
   * actionIds) and listed in GENERAL_ACTION_IDS, but neither draws it:
   * showingTestPlanSandbox short-circuits the panel ternary ahead of the
   * fallback contract-action bar, exactly as showingPlanSandbox does for Plan.
   */
  it("offers retry_test_plan on the TestPlan stage panel so a killed TestPlan run is not a dead end", () => {
    const testPlanBranchStart = pageSource.indexOf('if (activeSelectedPhase === "TestPlan") {');
    assert.notEqual(testPlanBranchStart, -1);
    const testPlanBranch = pageSource.slice(
      testPlanBranchStart,
      pageSource.indexOf("];", testPlanBranchStart),
    );
    assert.match(testPlanBranch, /makePlanStageAction\("retry_test_plan"/);
    // And it must resolve to a real endpoint, or the button is inert.
    assert.match(pipelineActionCommandsSource, /retry_test_plan: "test-plan"/);
  });
});
