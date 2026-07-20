import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(resolve(__dirname, "build-sandbox.tsx"), "utf-8");
const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const phaseMapSource = readFileSync(resolve(__dirname, "change-phase-map.ts"), "utf-8");
const pipelineActionCommandsSource = readFileSync(resolve(__dirname, "pipeline-action-commands.ts"), "utf-8");

describe("BuildSandbox UI", () => {
  it("renders the three Build workspace panels", () => {
    assert.match(componentSource, /Git Base Camp/);
    assert.match(componentSource, /Build 进度 \/ 差异/);
    assert.match(componentSource, /反方 Audit \/ 收编许可/);
    assert.doesNotMatch(componentSource, /<h2[^>]*>[^<]*任务地图/);
  });

  it("uses neutral Build workspace wording instead of Implement or report metaphors as primary UI copy", () => {
    assert.match(componentSource, /工作区/);
    assert.match(componentSource, /Build 结果/);
    assert.match(componentSource, /收编/);
    assert.doesNotMatch(componentSource, />[^<]*Implement[^<]*</);
    assert.doesNotMatch(componentSource, />IMPLEMENTING</);
    assert.doesNotMatch(componentSource, />IMPLEMENTED</);
    assert.doesNotMatch(componentSource, /Build 战报/);
    assert.doesNotMatch(componentSource, /战报/);
  });

  it("shows approve_absorb only for a latest run awaiting human absorption", () => {
    assert.match(componentSource, /findPipelineAction\(actions, buildRun\?\.purpose === "fix" \? "adopt_fix" : "adopt_build"\)/);
    assert.match(componentSource, /const canApproveAbsorb = approveAbsorbAction\?\.enabled === true/);
    assert.match(componentSource, /批准收编/);
    assert.match(componentSource, /runBuildAction\("approve_absorb"\)/);
  });

  it("exposes start, adopt, and reject actions as shared StageActionView actions", () => {
    assert.match(componentSource, /buildActionErrorSignature/);
    assert.match(componentSource, /shouldShowBuildStartAction/);
    assert.match(componentSource, /shouldShowBuildAdoptAction/);
    assert.match(componentSource, /shouldShowBuildRejectAction/);
    assert.match(componentSource, /import type \{ StageActionView \} from "\.\/stage-action-bar";/);
    assert.match(componentSource, /onStageActionsChange\?: \(actions: StageActionView\[\]\) => void/);
    assert.match(componentSource, /onStageActionError\?: \(error: string \| null\) => void/);
    assert.match(componentSource, /const stageActions = useMemo<StageActionView\[\]>\(\(\) => \{/);
    assert.match(componentSource, /if \(showStartBuildAction\)/);
    assert.match(componentSource, /if \(showApproveAbsorbAction\)/);
    assert.match(componentSource, /if \(showRejectBuildAction\)/);
    assert.match(componentSource, /id: "build-start"/);
    assert.match(componentSource, /sourceActionId: startBuildAction\?\.actionId/);
    assert.match(componentSource, /onAction: runBuildStart/);
    assert.match(componentSource, /id: "build-adopt"/);
    assert.match(componentSource, /sourceActionId: approveAbsorbAction\?\.actionId/);
    assert.match(componentSource, /onAction: \(\) => runBuildAction\("approve_absorb"\)/);
    assert.match(componentSource, /id: "build-reject"/);
    assert.match(componentSource, /role: "destructive"/);
    assert.match(componentSource, /sourceActionId: rejectBuildAction\?\.actionId/);
    assert.match(componentSource, /onAction: \(\) => runBuildAction\("reject_build"\)/);
    assert.match(componentSource, /onStageActionsChange\?\.\(stageActions\)/);
    assert.match(componentSource, /onStageActionsChange\?\.\(\[\]\)/);
    assert.match(componentSource, /onStageActionError\?\.\(error\)/);
    assert.match(componentSource, /onStageActionError\?\.\(null\)/);
  });

  it("clears stale action errors only when the visible Build action signature changes", () => {
    assert.match(componentSource, /const stageActionSignature = useMemo\(/);
    assert.match(componentSource, /buildActionErrorSignature\(\{ buildRun, slots: stageActions \}\)/);
    // Error reset happens during render (React's recommended pattern), not in an effect.
    assert.match(componentSource, /const \[prevStageActionSignature, setPrevStageActionSignature\] = useState\(stageActionSignature\)/);
    assert.match(componentSource, /if \(prevStageActionSignature !== stageActionSignature\) \{[\s\S]*?setError\(null\);[\s\S]*?\}/);
    assert.doesNotMatch(componentSource, /buildActionErrorSignature\(\{[\s\S]*busyAction/);
    assert.doesNotMatch(componentSource, /buildActionErrorSignature\(\{[\s\S]*canStartBuild/);
    assert.doesNotMatch(componentSource, /buildActionErrorSignature\(\{[\s\S]*canApproveAbsorb/);
    assert.doesNotMatch(componentSource, /buildActionErrorSignature\(\{[\s\S]*canRejectBuild/);
  });

  it("lets StageFrame own Build status and command placement", () => {
    assert.doesNotMatch(componentSource, /aria-label="Build 施工沙盘"/);
    assert.doesNotMatch(componentSource, /<span className=\{`rounded-md border px-2 py-1 text-xs font-semibold \$\{status\.tone\}`\}/);
    assert.doesNotMatch(componentSource, /<h3 className="text-base font-semibold">Build 施工沙盘<\/h3>/);
    assert.doesNotMatch(componentSource, /刷新战况/);
    assert.doesNotMatch(componentSource, /<div className="grid gap-2">[\s\S]*runBuildStart[\s\S]*runBuildAction\("approve_absorb"\)[\s\S]*runBuildAction\("reject_build"\)/);
  });

  it("can reject the current build round without making it the primary action", () => {
    assert.match(componentSource, /请求修改/);
    assert.match(componentSource, /runBuildAction\("reject_build"\)/);
    assert.match(componentSource, /id: "build-reject"/);
    assert.match(componentSource, /role: "destructive"/);
  });

  it("only enables reject_build for backend-supported build statuses", () => {
    assert.match(componentSource, /const rejectBuildAction = findPipelineAction\(actions, "reject_build"\)/);
    assert.match(componentSource, /const canRejectBuild = rejectBuildAction\?\.enabled === true/);
    assert.doesNotMatch(componentSource, /buildRun\.status !== "adopted" && buildRun\.status !== "rejected"/);
  });

  it("preserves action errors when a failed POST is followed by a refresh", () => {
    assert.match(componentSource, /preserveError\?: boolean/);
    assert.match(componentSource, /await load\(\{ preserveError: !actionSucceeded \}\)/);
    assert.match(componentSource, /if \(!preserveError\) setError\(null\)/);
  });

  it("passes backend disabled reasons into shared stage actions", () => {
    assert.match(componentSource, /disabledReason: startBuildReason/);
    assert.match(componentSource, /disabledReason: approveAbsorbReason/);
    assert.match(componentSource, /disabledReason: rejectBuildReason/);
    assert.doesNotMatch(componentSource, /key=\{reason\}/);
  });

  // Was "locally disables Build absorb while Git Base Camp is dirty", pinning
  // `baseCamp.status === "ready"` and the string 主仓需清理后才能收编 Build.
  // That local guard was stricter than every other authority and turned the
  // stage into a trap: the untracked files are the Build's own output, the only
  // remedy the UI offers is a commit, and adoptFix refuses once HEAD leaves the
  // run's base commit -- so taking the advice killed the absorb for good with
  // git_head_drift. checkGitBaseCamp already reports that churn as a warning
  // with `blockers: []`, and adoptFix has its own dirty-workspace tolerance that
  // fails with a precise conflict when the patch genuinely cannot apply.
  // Verified against the live pipeline: with the tree still dirty, the absorb
  // succeeded and the change reached IMPLEMENTED.
  it("blocks Build absorb on Git Base Camp blockers, not on a merely dirty tree", () => {
    assert.match(componentSource, /function buildAbsorbBaseCampReason/);
    assert.match(componentSource, /if \(baseCamp\.blockers\.length > 0\) return baseCamp\.blockers\.join\("; "\);/);
    // A dirty-but-unblocked base camp falls through to null, leaving the absorb
    // governed by the action contract and the adopt service alone.
    assert.doesNotMatch(componentSource, /baseCamp\.status === "ready"/);
    assert.doesNotMatch(componentSource, /主仓需清理后才能收编 Build/);
    // An unverifiable HEAD stays a hard local stop: without it there is no base
    // commit to compare the fix against.
    assert.match(componentSource, /if \(!baseCamp\.headSha\) return "Git HEAD could not be verified before absorbing Build output\.";/);
    assert.match(componentSource, /const absorbBaseCampReason = buildAbsorbBaseCampReason\(baseCamp\)/);
    assert.match(componentSource, /const approveAbsorbReason = absorbBaseCampReason \?\? pipelineActionDisabledReason\(approveAbsorbAction\)/);
    assert.match(componentSource, /const canApproveAbsorb = approveAbsorbAction\?\.enabled === true && absorbBaseCampReason === null/);
  });

  it("displays build changed files, deviations, and blockers", () => {
    assert.match(componentSource, /buildRun\?\.changedFiles/);
    assert.match(componentSource, /buildRun\?\.deviations/);
    assert.match(componentSource, /buildRun\?\.blockers/);
  });

  it("keeps build artifact paths out of the default UI", () => {
    const artifactSectionStart = componentSource.indexOf("产物状态");
    assert.notEqual(artifactSectionStart, -1, "artifact status section should exist");
    const artifactSectionEnd = componentSource.indexOf("</section>", artifactSectionStart);
    assert.notEqual(artifactSectionEnd, -1, "artifact status section should end before the audit panel closes");
    const artifactSection = componentSource.slice(artifactSectionStart, artifactSectionEnd);

    assert.match(artifactSection, /artifactStatus\(buildRun\?\.reportPath\)/);
    assert.match(artifactSection, /artifactStatus\(buildRun\?\.auditPath\)/);
    assert.match(artifactSection, /artifactStatus\(buildRun\?\.patchPath\)/);
    assert.doesNotMatch(artifactSection, /break-all font-mono/);
    assert.doesNotMatch(artifactSection, /report: \{buildRun\?\.reportPath/);
    assert.doesNotMatch(artifactSection, /audit: \{buildRun\?\.auditPath/);
    assert.doesNotMatch(artifactSection, /patch: \{buildRun\?\.patchPath/);
  });

  it("does not report Base Camp stable while the Build workspace state is still loading", () => {
    assert.match(componentSource, /loading \|\| !baseCamp/);
    assert.match(componentSource, /Git Base Camp 侦测中/);
    assert.match(componentSource, /Base Camp 稳定/);
  });

  it("loads Build workspace state through the Task 7 API and refreshes the parent after actions", () => {
    assert.match(componentSource, /\/build-workspace`\)/);
    assert.match(componentSource, /method: "POST"/);
    assert.match(componentSource, /await load\(\{ preserveError: !actionSucceeded \}\)/);
    assert.match(componentSource, /await Promise\.resolve\(onChanged\(\)\)/);
  });

  it("refreshes Review Center state after adopting a Build workspace", () => {
    const handlerStart = pageSource.indexOf("const handleBuildSandboxChanged = useCallback(() => {");
    assert.notEqual(handlerStart, -1, "Build sandbox change handler should exist");
    const handlerEnd = pageSource.indexOf("  const handleSelectPhase", handlerStart);
    assert.notEqual(handlerEnd, -1, "Build sandbox change handler should end before phase selection");
    const handlerSource = pageSource.slice(handlerStart, handlerEnd);

    assert.match(handlerSource, /loadReviewCenterState\(\)/);
  });

  it("can start or restart Build directly from the Build sandbox", () => {
    assert.match(componentSource, /runBuildStart/);
    assert.match(componentSource, /\/implement`/);
    assert.match(componentSource, /canStartBuild/);
    assert.match(componentSource, /function selectBuildStartAction/);
    assert.match(componentSource, /findPipelineAction\(actions, "run_build"\)/);
    assert.match(componentSource, /findPipelineAction\(actions, "retry_build"\)/);
    assert.doesNotMatch(componentSource, /findPipelineAction\(actions, "run_build"\) \?\? findPipelineAction\(actions, "retry_build"\)/);
    assert.match(componentSource, /const canStartBuild = startBuildAction\?\.enabled === true/);
    assert.match(componentSource, /baseCamp\.warnings/);
    assert.match(componentSource, /Base Camp warning/);
    assert.match(componentSource, /开始 Build/);
  });

  it("shows the active running retry blocker without dispatching implement", () => {
    assert.match(componentSource, /reasonCode === "build_run_running"/);
    assert.match(componentSource, /Build run is still recorded as running\. Recovery is required before retry\./);
    assert.match(componentSource, /const disabledReason = pipelineActionDisabledReason\(contractAction\)/);
    assert.match(componentSource, /if \(disabledReason\) \{[\s\S]*setError\(disabledReason\);[\s\S]*return;[\s\S]*\}/);
    assert.match(componentSource, /fetch\(`\/api\/projects\/\$\{projectId\}\/changes\/\$\{changeId\}\/implement`/);
  });

  it("imports and renders BuildSandbox only for selected Build or explicit Build/Fix awaiting human absorption", () => {
    assert.match(pageSource, /import \{ BuildSandbox \} from "\.\/build-sandbox";/);
    assert.match(phaseMapSource, /function hasFailedBuildRun\(change: ChangeDetail\)/);
    assert.match(phaseMapSource, /change\.latestRun\?\.phase === "implement" && change\.latestRun\.status === "failed"/);
    assert.match(phaseMapSource, /function isBuildOrFixAwaitingHuman\(change: ChangeDetail\)/);
    assert.match(phaseMapSource, /change\.latestRun\?\.phase === "implement" \|\| change\.latestRun\?\.phase === "fix_findings"/);
    assert.match(phaseMapSource, /change\.latestRun\.status === "completed"/);
    assert.match(phaseMapSource, /function getDefaultReviewPhaseForChange\(change: ChangeDetail(?:,[\s\S]*?)?\)/);
    assert.match(phaseMapSource, /getReviewPhaseForRunPhase\(change\.latestRun\.phase\) \?\? getDefaultReviewPhase\(change\.status(?:,[\s\S]*?)?\)/);
    assert.match(pageSource, /const selectedStage = uiPipelineState\?\.selectedStage \?\? null;/);
    assert.match(pageSource, /const activeSelectedPhase = selectedStage\?\.reviewPhase \?\? "Retro";/);
    assert.match(pageSource, /const showingBuildSandbox = activeSelectedPhase === "Build" \|\| activeSelectedPhase === "Fix";/);
    assert.doesNotMatch(pageSource, /buildOrFixAwaitingHuman/);
    assert.doesNotMatch(pageSource, /showingBuildSandbox = explicitSelectedPhase === "Build" \|\| buildOrFixAwaitingHuman/);
    assert.doesNotMatch(pageSource, /const showingBuildSandbox = activeSelectedPhase === "Build" \|\| buildOrFixAwaitingHuman;/);
    assert.doesNotMatch(pageSource, /showingBuildSandbox = activeSelectedPhase === "Build" \|\|[\s\S]*change\.status === "IMPLEMENTING";/);
    assert.doesNotMatch(pageSource, /const showingBuildSandbox =[\s\S]*hasFailedBuildRun\(change\);/);
    assert.doesNotMatch(pageSource, /\["PLAN_APPROVED", "IMPLEMENTING", "IMPLEMENTED"\]\.includes\(change\.status\)/);
    assert.match(pageSource, /<BuildSandbox/);
    assert.match(pageSource, /projectId=\{projectId\}/);
    assert.match(pageSource, /changeId=\{changeId\}/);
    assert.match(pageSource, /onStageActionsChange=\{setBuildStageActions\}/);
    assert.match(pageSource, /onChanged=\{handleBuildSandboxChanged\}/);
    assert.match(pageSource, /refreshToken=\{`\$\{change\.status\}:\$\{change\.latestRun\?\.id \?\? "none"\}:\$\{change\.latestRun\?\.status \?\? "none"\}:\$\{change\.updatedAt \?\? ""\}`\}/);
  });

  it("passes BuildSandbox actions through the shared PhaseStageShell action zone", () => {
    assert.match(pageSource, /const \[buildStageActions, setBuildStageActions\] = useState<StageActionView\[\]>\(\[\]\);/);
    assert.match(pageSource, /const buildOrFixStageActions = useMemo<StageActionView\[\]>\(\(\) =>/);
    assert.match(pageSource, /findPipelineAction\(gateStatus\?\.actions, "fix_blockers"\)/);
    assert.match(pageSource, /pipelineActionDisabledReason\(fixBlockersAction\)/);
    assert.match(pageSource, /id: "fix-fix_blockers"/);
    assert.match(pageSource, /sourceActionId: "fix_blockers"/);
    assert.match(pageSource, /busy: running/);
    assert.match(pageSource, /onAction: \(\) => handleAction\("fix_blockers"\)/);
    // These three returns used to be a bare `buildStageActions`. Git actions are
    // now appended to every one of them, which is the whole point: committing is
    // what unblocks adopting a Fix, so it has to sit in the same action zone as
    // the adopt button instead of in a workspace panel screens further down.
    // What these assertions actually pin -- build actions reach the shared zone,
    // fix_blockers is prepended only when enabled -- is unchanged, and git
    // actions trail rather than displace the stage's own next step.
    assert.match(pageSource, /if \(activeSelectedPhase !== "Fix"\) return \[\.\.\.buildStageActions, \.\.\.gitStageActions\];/);
    assert.match(pageSource, /const hasFixBlockerAction = disabledReason === null;/);
    assert.match(pageSource, /if \(!hasFixBlockerAction\) return \[\.\.\.buildStageActions, \.\.\.gitStageActions\];/);
    assert.match(pageSource, /return \[fixBlockersStageAction, \.\.\.buildStageActions, \.\.\.gitStageActions\];/);
    assert.match(pageSource, /const buildOrFixStageActionError = activeSelectedPhase === "Fix"[\s\S]*actionError/);
    assert.match(pageSource, /<PhaseStageShell[\s\S]*phase=\{activeSelectedPhase === "Fix" \? "Fix" : "Build"\}[\s\S]*actions=\{buildOrFixStageActions\}[\s\S]*actionError=\{buildOrFixStageActionError\}[\s\S]*<BuildSandbox/);
    assert.match(pageSource, /onStageActionError=\{setBuildStageActionError\}/);
    assert.doesNotMatch(pageSource, /pipelineActions\.filter\(\(action\) => action\.phase === "Fix"\)/);
  });

  it("does not prepend disabled fix_blockers ahead of BuildSandbox actions in Fix", () => {
    const actionBlockStart = pageSource.indexOf("const buildOrFixStageActions = useMemo<StageActionView[]>(() => {");
    assert.notEqual(actionBlockStart, -1, "buildOrFixStageActions block should exist");
    const actionBlockEnd = pageSource.indexOf("  const buildOrFixStageActionError", actionBlockStart);
    assert.notEqual(actionBlockEnd, -1, "buildOrFixStageActions block should end before error wiring");
    const actionBlock = pageSource.slice(actionBlockStart, actionBlockEnd);

    assert.match(actionBlock, /const hasFixBlockerAction = disabledReason === null;/);
    // Same early return as above, now carrying the git actions with it. The
    // assertion still pins the thing this test is named for: a disabled
    // fix_blockers must not be built or prepended.
    assert.match(actionBlock, /if \(!hasFixBlockerAction\) return \[\.\.\.buildStageActions, \.\.\.gitStageActions\];/);
    assert.doesNotMatch(actionBlock, /const fixBlockersStageAction[\s\S]*if \(!hasFixBlockerAction\)/);
  });

  it("uses a stable empty pipeline action fallback to avoid BuildSandbox action effect loops", () => {
    assert.match(pageSource, /type PipelineActionContract/);
    assert.match(pageSource, /const EMPTY_PIPELINE_ACTIONS: PipelineActionContract\[\] = \[\];/);
    assert.match(pageSource, /const pipelineActions = gateStatus\?\.actions \?\? EMPTY_PIPELINE_ACTIONS;/);
    assert.doesNotMatch(pageSource, /gateStatus\?\.actions \?\? \[\]/);
  });

  it("refreshes BuildSandbox workspace state when parent change data changes", () => {
    assert.match(componentSource, /refreshToken\?: string \| number \| null/);
    assert.match(componentSource, /useEffect\(\(\) => \{[\s\S]*Promise\.resolve\(\)\.then\(\(\) => \{[\s\S]*void load\(\);[\s\S]*\}, \[load, refreshToken\]\)/);
  });

  it("keeps Build start out of TestPlan while preserving the separate stage sandboxes", () => {
    assert.match(pageSource, /const showingPlanSandbox = activeSelectedPhase === "Plan"/);
    assert.match(pageSource, /const showingTestPlanSandbox = activeSelectedPhase === "TestPlan"/);
    assert.doesNotMatch(pageSource, /showingPlanSandbox = activeSelectedPhase === "Plan" \|\| change\.status === "TESTPLAN_DONE"/);
    assert.match(pageSource, /const activeSelectedPhase = selectedStage\?\.reviewPhase \?\? "Retro";/);
    assert.match(pageSource, /makePlanStageAction\("run_test_plan", "生成测试计划", "primary", \(\) => handleAction\("run_test_plan"\)\)/);
    assert.doesNotMatch(pageSource, /makePlanStageAction\("run_build", "开始 Build"/);
    assert.match(pageSource, /<TestPlanSandbox/);

    const planSandboxCallStart = pageSource.indexOf("<PlanSandbox");
    assert.notEqual(planSandboxCallStart, -1, "PlanSandbox call should exist");
    const planSandboxCallEnd = pageSource.indexOf("/>", planSandboxCallStart);
    assert.notEqual(planSandboxCallEnd, -1, "PlanSandbox call should be self-closing");
    const planSandboxCall = pageSource.slice(planSandboxCallStart, planSandboxCallEnd);
    assert.doesNotMatch(planSandboxCall, /onRunTestPlan=/);
    assert.doesNotMatch(planSandboxCall, /onRunImplement=/);
  });

  it("keeps IMPLEMENTED action buttons available instead of routing directly to BuildSandbox", () => {
    assert.match(pageSource, /visibleContractActions\.map\(\(action\) => \(/);
    assert.match(pageSource, /onClick=\{\(\) => handleAction\(action\.actionId\)\}/);
    assert.doesNotMatch(pageSource, /showingBuildSandbox = .*IMPLEMENTED/);
  });

  it("keeps Review actions gated to IMPLEMENTED rather than IMPLEMENTING", () => {
    assert.match(pipelineActionCommandsSource, /run_review: "review"/);
    assert.match(pipelineActionCommandsSource, /enter_qa: "check"/);
    assert.match(pageSource, /visibleContractActions/);
  });

  it("does not treat Build awaiting human absorption as a running page state", () => {
    assert.match(phaseMapSource, /function isBuildOrFixAwaitingHuman\(change: ChangeDetail\)/);
    assert.match(phaseMapSource, /change\.latestRun\?\.phase === "implement"/);
    assert.match(phaseMapSource, /change\.latestRun\?\.phase === "fix_findings"/);
    assert.match(phaseMapSource, /change\.latestRun\.status === "completed"/);
    assert.match(phaseMapSource, /Build\/Fix 待收编/);
    const runningStart = pageSource.indexOf("const isRunning = hasActiveRun || [");
    assert.notEqual(runningStart, -1);
    const runningEnd = pageSource.indexOf("].includes(change.status)", runningStart);
    assert.notEqual(runningEnd, -1);
    const runningBlock = pageSource.slice(runningStart, runningEnd);
    assert.doesNotMatch(runningBlock, /"IMPLEMENTING"/);
  });
});
