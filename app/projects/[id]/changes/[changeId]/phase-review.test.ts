import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StageEvidencePanel } from "./stage-evidence-panel";
import {
  ReviewReportCenter,
  buildReviewStageActions,
  resolveReviewRunCommand,
  resolveWaiveP1Target,
  selectWaivableP1Findings,
  waiveP1TargetHint,
  type ReviewCenterAction,
  type ReviewCenterResponse,
  type ReviewFindingView,
} from "./review-report-center";
import {
  SpecBattlefield,
  resolveWaiveP1Gap,
  selectWaivableP1Gaps,
  waiveP1GapHint,
} from "./spec-battlefield";
import type {
  RequirementGap,
  SpecBattleGateState,
  SpecBattleState,
} from "./spec-battle-types";
import { OperationalPhasePanel } from "./operational-phase-panel";
import { buildGateStageActions, selectRoutableStageRunActions } from "./gate-panel";
import { buildDeliveryStageActions } from "./delivery-stage-actions";
import { resolvePipelineActionCommand } from "./pipeline-action-commands";
import type { GateStatus } from "./gate-types";
import {
  PARENT_POLLING_CHANGE_STATUSES,
  REWORKABLE_REVIEW_PHASES,
  STATUS_TO_PHASE,
  getDefaultReviewPhaseForChange,
  getReviewPhaseForRunPhase,
  shouldPollChangeDetailParent,
  summarizeFailedRunForBanner,
} from "./change-phase-map";
import type { ChangeDetail } from "./change-detail-types";
import type { PipelineActionContract } from "./pipeline-action-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const gatePanelSource = readFileSync(resolve(__dirname, "gate-panel.tsx"), "utf-8");
const phaseReviewPanelSource = readFileSync(resolve(__dirname, "phase-review-panel.tsx"), "utf-8");
const stageEvidencePanelSource = readFileSync(resolve(__dirname, "stage-evidence-panel.tsx"), "utf-8");
const artifactsPanelSource = readFileSync(resolve(__dirname, "artifacts-panel.tsx"), "utf-8");
const phaseRailSource = readFileSync(resolve(__dirname, "phase-rail.tsx"), "utf-8");
const phaseStageShellSource = readFileSync(resolve(__dirname, "phase-stage-shell.tsx"), "utf-8");
const stageFrameSource = readFileSync(resolve(__dirname, "stage-frame.tsx"), "utf-8");
const pipelineUiModelSource = readFileSync(resolve(__dirname, "pipeline-ui-model.ts"), "utf-8");
const pipelinePageShellSource = readFileSync(resolve(__dirname, "pipeline-page-shell.tsx"), "utf-8");
const failedRunBannerSource = readFileSync(resolve(__dirname, "failed-run-banner.tsx"), "utf-8");
const pipelineActionsSource = readFileSync(resolve(__dirname, "use-pipeline-actions.ts"), "utf-8");
// The request-building and drift-retry rules moved out of the hook into this
// React-free module so they could be exercised directly; see
// pipeline-action-runner.test.ts. The pins below follow the logic.
const pipelineActionRunnerSource = readFileSync(resolve(__dirname, "pipeline-action-runner.ts"), "utf-8");
const pipelineActionCommandsSource = readFileSync(resolve(__dirname, "pipeline-action-commands.ts"), "utf-8");
const gateTypesSource = readFileSync(resolve(__dirname, "gate-types.ts"), "utf-8");
const changeApiSource = readFileSync(resolve(__dirname, "change-api-client.ts"), "utf-8");
const changeDetailDataHookSource = readFileSync(resolve(__dirname, "use-change-detail-data.ts"), "utf-8");
const changeCommandsSource = readFileSync(resolve(__dirname, "use-change-commands.ts"), "utf-8");
const specBattleTypes = readFileSync(resolve(__dirname, "spec-battle-types.ts"), "utf-8");
const prdBriefingRoomSource = readFileSync(resolve(__dirname, "prd-briefing-room.tsx"), "utf-8");
const stageGitPanelSource = readFileSync(resolve(__dirname, "stage-git-panel.tsx"), "utf-8");
const gitWorkspacePanelSource = readFileSync(resolve(__dirname, "../../git-workspace-panel.tsx"), "utf-8");
const projectPageSource = readFileSync(resolve(__dirname, "../../page.tsx"), "utf-8");
const gitWorkspaceRouteSource = readFileSync(
  resolve(__dirname, "../../../../api/projects/[id]/git/workspace/route.ts"),
  "utf-8",
);

function reviewFinding(id: string, overrides: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return {
    id,
    changeId: "CHG-001",
    runId: "RUN-001",
    source: "review",
    severity: "P1",
    category: "correctness",
    title: `finding ${id}`,
    file: `src/${id}.ts`,
    line: 12,
    evidence: "evidence",
    requiredFix: null,
    status: "open",
    waivable: true,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: null,
    isLegacyIncomplete: false,
    isNotRechecked: false,
    ...overrides,
  };
}

function reviewCenterResponse(findings: ReviewFindingView[]): ReviewCenterResponse {
  return {
    headlineStatus: "blocked_p1",
    qaAllowed: false,
    latestAttempt: null,
    latestValidReview: null,
    counts: {
      p0: 0,
      p1: findings.filter((f) => f.severity === "P1" && f.status === "open").length,
      p2: 0,
      waived: 0,
    },
    gate: {
      status: "blocked_p1",
      canEnterQa: false,
      reason: null,
      sourceBuildRunId: null,
      latestBuildRunId: "RUN-BUILD-1",
    },
    findings,
    waivers: [],
    mirrorWarnings: [],
    actions: {
      canRunReview: false,
      canRetryReview: true,
      canFixBlockers: true,
      canWaiveP1: true,
      canEnterQa: false,
      canStopChange: true,
    },
    advancedDetails: { latestAttempt: null, latestValidReview: null },
  };
}

function renderReviewCenter(findings: ReviewFindingView[]): string {
  return renderToStaticMarkup(
    createElement(ReviewReportCenter, {
      projectId: "PRJ-001",
      changeId: "CHG-001",
      busy: false,
      actions: [reviewPipelineAction("waive_review_p1", true)],
      initialState: reviewCenterResponse(findings),
      onRunReview: () => {},
      onEnterQa: () => {},
      onFixBlockers: () => {},
      onBlockChange: () => {},
    }),
  );
}

function requirementGap(id: string, overrides: Partial<RequirementGap> = {}): RequirementGap {
  return {
    id,
    canonicalGapId: `GAP-${id.toUpperCase()}`,
    title: `gap ${id}`,
    category: "requirement",
    severity: "P1",
    originalSeverity: "P1",
    downgradedTo: null,
    status: "open",
    evidence: "evidence",
    proposedSpecPatch: null,
    ...overrides,
  };
}

function specBattleGateState(): SpecBattleGateState {
  return {
    roundId: "RND-001",
    roundStatus: "closed",
    reportFresh: true,
    staleReason: null,
    counts: {
      blockingP0: 0,
      blockingP1: 1,
      nonBlockingP2: 0,
      overriddenP0: 0,
      openRequirementGaps: 1,
      mergeBlockingRequirementGaps: 1,
    },
    actions: {
      approve: { available: false, reason: "blocked_p1" },
      requestChanges: { available: true, reason: null },
      returnToSpec: { available: true, reason: null },
      waiveP1: { available: true, reason: null },
      terminalBlock: false,
    },
  };
}

function specBattleState(gaps: RequirementGap[]): SpecBattleState {
  const gate = specBattleGateState();
  return {
    latestRound: {
      id: "RND-001",
      roundNo: 1,
      status: "closed",
      redUnit: "red",
      blueUnit: "blue",
      redArtifactPath: null,
      blueArtifactPath: null,
      reportPath: null,
      startedAt: "2026-07-20T00:00:00.000Z",
      endedAt: "2026-07-20T00:01:00.000Z",
    },
    rounds: [],
    gaps,
    fixClaims: [],
    gapReviews: [],
    decisions: [],
    reportFresh: true,
    staleReason: null,
    counts: gate.counts,
    roundDelta: { resolvedThisRound: 0, stillOpen: gaps.length, newlyFound: 0, notRechecked: 0 },
  };
}

function renderSpecBattlefield(gaps: RequirementGap[]): string {
  return renderToStaticMarkup(
    createElement(SpecBattlefield, {
      projectId: "PRJ-001",
      changeId: "CHG-001",
      specBattle: specBattleGateState(),
      battleState: specBattleState(gaps),
      approveAction: { enabled: false, reasonCode: "blocked_p1", reason: "存在 P1" },
      runTechSpecAction: { enabled: false, reasonCode: "blocked_p1", reason: "存在 P1" },
      busy: false,
      loading: false,
      onAcceptRisk: () => {},
      onStopBattle: () => {},
      onBattleDecision: () => {},
      onRestartBattle: () => {},
      onRegenerateReport: () => {},
    }),
  );
}

function reviewCenterAction(
  id: ReviewCenterAction["id"],
  enabled: boolean,
  reason: string | null = enabled ? null : "disabled",
): ReviewCenterAction {
  return {
    id,
    enabled,
    reason,
    idempotencyRequired: true,
  };
}

function reviewCenterActions(
  overrides: Partial<ReviewCenterResponse["actions"]> = {},
): ReviewCenterResponse["actions"] {
  return {
    run_review: reviewCenterAction("run_review", true),
    retry_review: reviewCenterAction("retry_review", false, "Retry is only available for failed or stale Review state."),
    fix_blockers: reviewCenterAction("fix_blockers", false),
    waive_review_p1: reviewCenterAction("waive_review_p1", false),
    enter_qa: reviewCenterAction("enter_qa", false),
    stop_change: reviewCenterAction("stop_change", true),
    recompute_report: reviewCenterAction("recompute_report", false),
    rebuild_mirror: reviewCenterAction("rebuild_mirror", false),
    canRunReview: true,
    canRetryReview: false,
    canFixBlockers: false,
    canWaiveP1: false,
    canEnterQa: false,
    canStopChange: true,
    ...overrides,
  };
}

function pipelineAction(actionId: "run_review" | "retry_review", enabled: boolean): PipelineActionContract {
  return reviewPipelineAction(actionId, enabled);
}

function reviewPipelineAction(actionId: string, enabled: boolean, reason: string | null = enabled ? null : "Pipeline action disabled."): PipelineActionContract {
  return {
    actionId,
    phase: "Review",
    label: actionId === "run_review" ? "开始反方审查" : actionId,
    enabled,
    reasonCode: enabled ? null : "not_allowed",
    reason,
    blockers: [],
    warnings: [],
    gateVersion: "gate-v1",
    sourceDbHash: "hash-v1",
    requiresIdempotencyKey: true,
  };
}

function gatePipelineAction(
  actionId: string,
  enabled: boolean,
  label = actionId,
  reason: string | null = enabled ? null : "Pipeline action disabled.",
): PipelineActionContract {
  return {
    actionId,
    phase: "Plan",
    label,
    enabled,
    reasonCode: enabled ? null : "not_allowed",
    reason,
    blockers: [],
    warnings: [],
    gateVersion: "gate-v1",
    sourceDbHash: "hash-v1",
    requiresIdempotencyKey: true,
  };
}

/**
 * CHG-015 after `stale_lease_fenced`: the change is stranded at TECHSPECCING, so
 * it is not sitting at any gate and the contract carries only the retry.
 */
function strandedTechSpecGateStatus(actions: PipelineActionContract[]): GateStatus {
  return {
    atGate: false,
    gate: null,
    status: "TECHSPECCING",
    pendingArtifact: null,
    actions,
  };
}

describe("phase review UI", () => {
  it("renders a manual Git panel for every selected change phase without joining pipeline action errors", () => {
    assert.match(src, /import \{ StageGitPanel \} from "\.\/stage-git-panel";/);
    assert.match(src, /<StageGitPanel[\s\S]*?projectId=\{projectId\}[\s\S]*?selectedPhase=\{activeSelectedPhase\}[\s\S]*?\/>/);
    // Was pinned as a single-line `<GitWorkspacePanel projectId={projectId}`.
    // The panel now also receives changeId and the change's git contracts, so
    // the JSX wraps. Only the formatting moved -- that it is handed the project
    // is still pinned here, and the change scoping has its own test below.
    assert.match(stageGitPanelSource, /<GitWorkspacePanel[\s\S]*?projectId=\{projectId\}/);
    assert.match(gitWorkspacePanelSource, /loadStatus/);
    assert.match(gitWorkspacePanelSource, /\/api\/projects\/\$\{projectId\}\/git\/workspace/);
    assert.match(gitWorkspacePanelSource, /刷新/);
    assert.match(gitWorkspacePanelSource, /setResult\("刷新 Git 状态失败"\)/);
    assert.doesNotMatch(stageGitPanelSource, /setActionError/);
    assert.doesNotMatch(gitWorkspacePanelSource, /setActionError/);
  });

  /**
   * The Git panel used to be handed only a projectId, so a commit made from a
   * change's Build/Fix stage was indistinguishable from one made on the project
   * page: it could not be attributed to the change, and the AI message
   * suggestion (which has always accepted change context) was asked for one
   * without any. Both hops of the changeId are pinned here -- page -> panel and
   * panel -> workspace panel -- because dropping either silently restores the
   * old behaviour with no other visible symptom.
   */
  it("scopes the stage Git panel to the change it is rendered under", () => {
    assert.match(src, /<StageGitPanel[\s\S]*?changeId=\{changeId\}[\s\S]*?\/>/);
    assert.match(src, /<StageGitPanel[\s\S]*?commitAction=\{findPipelineAction\(pipelineActions, "commit_changes"\)\}[\s\S]*?\/>/);
    assert.match(stageGitPanelSource, /changeId,/);
    assert.match(stageGitPanelSource, /<GitWorkspacePanel[\s\S]*?changeId=\{changeId\}/);
    assert.match(gitWorkspacePanelSource, /body: JSON\.stringify\(changeId \? \{ changeId \} : \{\}\)/);
  });

  /**
   * "git 要集成在每个页面" -- the panel has to be able to finish the job wherever
   * it is mounted, because the alternative is the round trip the user objected
   * to: notice on a change's Fix stage that the repo is not initialised,
   * navigate to the project page, open its Git section, click 初始化 in
   * GitSetupPanel, navigate back.
   *
   * The state that made that round trip mandatory was invisible: getWorkingTreeStatus
   * answers `clean: true` for a path that is not a repository, so the panel drew
   * "工作区干净，没有未提交的改动" on precisely the projects the pipeline was
   * refusing with "Path is not a git repository."
   */
  it("names the not-a-repository state and offers init from the workspace panel itself", () => {
    assert.match(gitWorkspacePanelSource, /if \(!status\.isRepo\) \{/);
    assert.match(gitWorkspacePanelSource, /该路径不是 Git 仓库/);
    assert.match(gitWorkspacePanelSource, /初始化 Git 仓库/);
    assert.match(gitWorkspacePanelSource, /async function handleInit\(\)/);
    // With a change in scope the init goes through the contract action; without
    // one (project page) it falls back to the project-level endpoint.
    assert.match(gitWorkspacePanelSource, /changeId && initAction/);
    assert.match(gitWorkspacePanelSource, /createPipelinePreflightPayload\(initAction\)/);
    assert.match(gitWorkspacePanelSource, /\{ action: "init" \}/);
    // isRepo must be carried separately from `clean`, and must default to true so
    // a failed status read never offers to `git init` over a live repository.
    assert.match(gitWorkspacePanelSource, /isRepo: data\.isRepo !== false/);
    assert.match(gitWorkspaceRouteSource, /isRepo: repo/);
    assert.match(gitWorkspaceRouteSource, /hasCommits: repo \? hasCommits\(project\.repoPath\) : false/);
  });

  it("mounts the Git workspace panel on every project-scoped page", () => {
    // Change page: rendered outside every stage branch, so it is present for all
    // phases -- pinned by its position after the last stage conditional.
    assert.match(src, /\)\}\s*\{\/\*[\s\S]*?\*\/\}\s*<StageGitPanel/);
    // Project page: same component, no change in scope.
    assert.match(projectPageSource, /<GitWorkspacePanel projectId=\{projectId\} \/>/);
    // The two pages above are the only project-scoped ones; / redirects to
    // /projects, and /projects is a multi-project list with no single repo.
    assert.match(readFileSync(resolve(__dirname, "../../../../page.tsx"), "utf-8"), /redirect\("\/projects"\)/);
  });

  it("passes selected Git paths to commit_changes from the workspace panel", () => {
    assert.match(gitWorkspacePanelSource, /action: "commit_changes"/);
    assert.match(gitWorkspacePanelSource, /paths: Array\.from\(selectedPaths\)/);
  });

  /**
   * With a change in scope the panel must commit through the change-scoped
   * contract route, not the project-level endpoint: only that path runs
   * preflight, so only that path refuses a commit whose contract has gone stale.
   * The project-level body is still reachable, and must stay so -- the same
   * panel is mounted on the project page where there is no change.
   */
  it("commits through the change contract route when the Git panel has a change in scope", () => {
    assert.match(
      gitWorkspacePanelSource,
      /url: `\/api\/projects\/\$\{projectId\}\/changes\/\$\{changeId\}\/git`/,
    );
    assert.match(gitWorkspacePanelSource, /createPipelinePreflightPayload\(commitAction, \{/);
    assert.match(gitWorkspacePanelSource, /changeId && commitAction/);
  });

  it("renders phase bar items as buttons that can select review phases", () => {
    const phaseBarStart = phaseRailSource.indexOf("function PhaseBar");
    assert.notEqual(phaseBarStart, -1, "PhaseBar should exist");

    const phaseBarEnd = phaseRailSource.indexOf("function VerticalPhaseRail", phaseBarStart);
    const phaseBarSource = phaseRailSource.slice(phaseBarStart, phaseBarEnd);

    assert.match(phaseBarSource, /onSelectPhase/);
    assert.match(phaseBarSource, /selectedPhase/);
    assert.match(phaseBarSource, /<PipelineStageItem/);
  });

  it("keeps selectedPhase as local page state for in-page switching", () => {
    assert.match(src, /const \[selectedPhase, setSelectedPhase\] = useState/);
    assert.match(pipelinePageShellSource, /<PhaseBar[\s\S]*selectedPhase=\{selectedPhase\}[\s\S]*onSelectPhase=\{onSelectPhase\}/);
  });

  it("wires the page through one selected pipeline stage result", () => {
    assert.match(src, /import \{ buildUiPipelineState \} from "\.\/pipeline-ui-model";/);
    assert.match(src, /import \{ PipelinePageShell \} from "\.\/pipeline-page-shell";/);
    assert.equal(src.match(/buildUiPipelineState\(/g)?.length, 1);
    assert.match(src, /const uiPipelineState = useMemo\(\(\) => change \? buildUiPipelineState\(\{[\s\S]*change,[\s\S]*selectedPhase: explicitSelectedPhase,[\s\S]*phaseOverviews,[\s\S]*reviewCenterState,[\s\S]*gateStatus,[\s\S]*specBattleState,[\s\S]*\}\) : null/);
    assert.match(src, /const selectedStage = uiPipelineState\?\.selectedStage \?\? null;/);
    assert.match(src, /const activeSelectedPhase = selectedStage\?\.reviewPhase \?\? "Retro";/);
    assert.match(src, /const fetchPhase = selectedStage\?\.recordPhase \?\? null;/);
    assert.match(src, /if \(!change \|\| !fetchPhase\) return;/);
    assert.match(src, /encodeURIComponent\(fetchPhase\)/);
    assert.doesNotMatch(src, /reviewCenterNeedsAttention \? "Review" : getDefaultReviewPhaseForChange/);
  });

  it("renders Retro through the stage shell with only the general run_retro action", () => {
    const retroBranchStart = src.indexOf("showingRetroStage ? (");
    assert.notEqual(retroBranchStart, -1, "Retro stage branch should exist");
    const retroBranchEnd = src.indexOf(") : showingDoneStage ? (", retroBranchStart);
    assert.notEqual(retroBranchEnd, -1, "Retro branch should be followed by Done branch");
    const retroBranch = src.slice(retroBranchStart, retroBranchEnd);

    assert.match(src, /const showingRetroStage = selectedStage\.id === "retro";/);
    assert.match(src, /const retroStageAction = findPipelineAction\(pipelineActions, "run_retro"\);/);
    assert.match(src, /const retroStageActions = useMemo<StageActionView\[\]>/);
    assert.match(src, /sourceActionId: "run_retro"/);
    assert.match(src, /onAction: \(\) => handleAction\("run_retro"\)/);
    assert.doesNotMatch(src, /pipelineActions\.filter\(\(action\) => action\.phase === "Merge"\)[\s\S]*run_retro/);

    assert.match(retroBranch, /<PhaseStageShell/);
    assert.match(retroBranch, /phase="Retro"/);
    assert.match(retroBranch, /state=\{selectedStageState\}/);
    assert.match(retroBranch, /actions=\{retroStageActions\}/);
    assert.match(retroBranch, /actionError=\{actionError\}/);
    assert.match(retroBranch, /records=\{renderPhaseRecords\("Retro", "retro-records"\)\}/);
    assert.match(retroBranch, /data-retro-stage/);
  });

  // This case used to be "renders Done as a read-only completion StageFrame
  // without phase records or actions", and it pinned three things that are now
  // wrong on purpose: that the Done branch renders a bare <StageFrame>, that it
  // carries no `actions={...}`, and that it calls no `renderPhaseRecords`.
  //
  // All three described Done while Done was only a label. It is a stage now: it
  // runs the delivery stage, owns delivery.md and answers the Done producer
  // rubric, so it needs the action bar to be startable, the phase records to
  // show its run, and the rubric drawer -- none of which a StageFrame can
  // render. Keeping the old assertions would have pinned the empty shell the
  // pipeline used to end on, which is exactly the gap this stage closes.
  //
  // What survives unchanged: DoneCompletionPanel and its content, shown once the
  // change actually reaches DONE.
  // The behaviour behind the delivery button, driven rather than grepped. The
  // assertions below this one read page.tsx as text; that is this file's house
  // style and fine for wiring, but it cannot see whether the button works.
  // Measured: forcing `enabled: false` (delivery unclickable under every
  // condition) left all 83 assertions green, while a pure rename of the memo
  // turned them red. These five drive buildDeliveryStageActions directly.
  it("enables the delivery button exactly when the action contract does", () => {
    const contract = (over: Partial<PipelineActionContract> = {}): PipelineActionContract => ({
      actionId: "run_delivery",
      phase: "Merge",
      label: "生成交付单",
      enabled: true,
      reasonCode: null,
      reason: null,
      blockers: [],
      warnings: [],
      gateVersion: "1",
      sourceDbHash: "hash",
      requiresIdempotencyKey: true,
      requiresProvider: true,
      providerSelectable: true,
      defaultProvider: "codex",
      ...over,
    });

    const [enabled] = buildDeliveryStageActions({
      deliveryAction: contract(), busy: false, onAction: () => {},
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.disabledReason, null);

    const [denied] = buildDeliveryStageActions({
      deliveryAction: contract({ enabled: false, reason: "Retro is not complete" }),
      busy: false,
      onAction: () => {},
    });
    assert.equal(denied.enabled, false, "a denied contract must not yield a pressable button");
    assert.equal(denied.disabledReason, "Retro is not complete", "the user must be told why");

    // The 2.1 failure mode: the whole contract goes missing. The button must
    // fail closed, not fall through to enabled.
    const [missing] = buildDeliveryStageActions({
      deliveryAction: null, busy: false, onAction: () => {},
    });
    assert.equal(missing.enabled, false);
    assert.equal(missing.disabledReason, "Action contract unavailable.");
    assert.equal(missing.label, "生成交付单", "the label survives a missing contract");
  });

  it("dispatches run_delivery and carries the busy flag through", () => {
    const dispatched: string[] = [];
    const [action] = buildDeliveryStageActions({
      deliveryAction: null, busy: true, onAction: (id) => dispatched.push(id),
    });

    assert.equal(action.busy, true, "a running pipeline must show the button as busy");
    assert.equal(action.sourceActionId, "run_delivery");
    assert.equal(action.id, "done-run_delivery");
    action.onAction();
    assert.deepEqual(dispatched, ["run_delivery"], "the button must fire exactly run_delivery");
  });

  it("renders Done as a real delivery stage, and the completion panel only once DONE", () => {
    const doneBranchStart = src.indexOf("showingDoneStage ? (");
    assert.notEqual(doneBranchStart, -1, "Done stage branch should exist");
    const doneBranchEnd = src.indexOf(") : showingBuildSandbox ? (", doneBranchStart);
    assert.notEqual(doneBranchEnd, -1, "Done branch should be before normal stage branches");
    const doneBranch = src.slice(doneBranchStart, doneBranchEnd);

    assert.match(src, /const showingDoneStage = selectedStage\.id === "done";/);
    assert.match(src, /function DoneCompletionPanel/);

    // A stage, through the same shell as every other stage.
    assert.match(doneBranch, /<PhaseStageShell/);
    assert.match(doneBranch, /phase="Done"/);
    assert.match(doneBranch, /actions=\{deliveryStageActions\}/);
    assert.match(doneBranch, /records=\{renderPhaseRecords\("Done", "done-records"\)\}/);
    assert.doesNotMatch(doneBranch, /<PhaseReviewPanel/);

    // The completion panel is the DONE state, not the stage itself: while the
    // change sits at DELIVERY_PENDING the branch must offer to produce the
    // delivery note rather than announce the change is finished.
    assert.match(doneBranch, /change\.status === "DONE"/);
    assert.match(doneBranch, /<DoneCompletionPanel/);
    assert.match(doneBranch, /data-delivery-stage/);

    assert.match(src, /Change id/);
    assert.match(src, /Branch/);
    assert.match(src, /visibleChangeStatus\(change\)/);
    assert.doesNotMatch(src, /<dd className="font-medium">\{change\.status\}<\/dd>/);
  });

  it("shares the selected stage across page shell rails, header, and workspace", () => {
    assert.match(src, /<PipelinePageShell[\s\S]*selectedStage=\{selectedStage\}[\s\S]*stages=\{uiPipelineState\.stages\}[\s\S]*selectedPhase=\{activeSelectedPhase\}/);
    assert.match(pipelinePageShellSource, /selectedStage: UiStage;/);
    assert.match(pipelinePageShellSource, /Stage: <strong className="text-foreground">\{selectedStage\.label\}<\/strong>/);
    assert.match(pipelinePageShellSource, /<PhaseBar[\s\S]*stages=\{stages\}[\s\S]*selectedPhase=\{selectedPhase\}/);
    assert.match(pipelinePageShellSource, /<VerticalPhaseRail[\s\S]*stages=\{stages\}[\s\S]*selectedPhase=\{selectedPhase\}/);
    assert.match(src, /const selectedStageState = selectedStage\.state;/);
    assert.match(src, /<PhaseStageShell[\s\S]*state=\{selectedStageState\}/);
  });

  it("defaults failed async stages to the failed phase and shows a sanitized failure summary", () => {
    assert.equal(getReviewPhaseForRunPhase("tech_spec"), "TechSpec");
    assert.equal(getReviewPhaseForRunPhase("test_plan"), "TestPlan");
    assert.equal(getReviewPhaseForRunPhase("implement"), "Build");
    assert.equal(getReviewPhaseForRunPhase("prd_briefing_final_review"), "Intake");
    assert.equal(getReviewPhaseForRunPhase("unknown"), null);
    assert.equal(
      getDefaultReviewPhaseForChange({
        status: "TECHSPECCING",
        latestRun: { id: "run-1", phase: "tech_spec", status: "failed" },
      } as ChangeDetail),
      "TechSpec",
    );
    assert.equal(
      summarizeFailedRunForBanner({
        id: "run-2",
        phase: "review",
        status: "failed",
        summary: JSON.stringify({ sanitizedErrorSummary: "执行失败: /Users/me/project/report.json" }),
      }),
      "执行失败: [已隐藏路径]",
    );
    assert.equal(
      summarizeFailedRunForBanner({
        id: "run-3",
        phase: "review",
        status: "failed",
        summary: JSON.stringify({ reportPath: "/Users/me/report.json", rawJson: "{}" }),
      }),
      "后台任务失败，请查看该阶段记录。",
    );
    assert.match(src, /const latestFailedRun = change\.latestRun\?\.status === "failed" \? change\.latestRun : null/);
    assert.match(failedRunBannerSource, /执行失败/);
    assert.match(failedRunBannerSource, /查看失败阶段/);
    assert.match(failedRunBannerSource, /summarizeFailedRunForBanner\(run\)/);
    assert.match(src, /<FailedRunBanner/);
    assert.doesNotMatch(src, /\{latestFailedRun\.summary \|\| "后台任务失败，请查看该阶段记录。"\}/);
  });

  it("renders a desktop vertical phase rail in a sticky right sidebar", () => {
    const railStart = phaseRailSource.indexOf("function VerticalPhaseRail");
    assert.notEqual(railStart, -1, "VerticalPhaseRail should exist");

    const railSource = phaseRailSource.slice(railStart);

    assert.match(railSource, /onSelectPhase/);
    assert.match(railSource, /selectedPhase/);
    assert.match(railSource, /<button/);
    assert.match(pipelinePageShellSource, /<aside className="hidden lg:block">/);
    assert.match(pipelinePageShellSource, /className="sticky top-6"/);
  });

  it("keeps Spec Battle inside the standard page shell rails and header metadata", () => {
    assert.match(src, /isSpecBattleMode=\{isSpecBattleMode\}/);
    assert.doesNotMatch(pipelinePageShellSource, /isSpecBattleMode \? "mx-auto max-w-5xl" : "mx-auto max-w-6xl"/);
    assert.doesNotMatch(pipelinePageShellSource, /isSpecBattleMode \? "grid gap-6" : "grid gap-6 lg:grid-cols-\[minmax\(0,1fr\)_13rem\]"/);
    assert.doesNotMatch(pipelinePageShellSource, /\{!isSpecBattleMode && \(/);
    assert.match(pipelinePageShellSource, /Status: <strong className="text-foreground">\{visibleChangeStatus\(change\)\}<\/strong>/);
    assert.match(pipelinePageShellSource, /Stage: <strong className="text-foreground">\{selectedStage\.label\}<\/strong>/);
    assert.match(pipelinePageShellSource, /<VerticalPhaseRail/);
  });

  it("uses one shared stage shell for phase-specific page surfaces", () => {
    assert.match(src, /import \{ PhaseStageShell \} from "\.\/phase-stage-shell";/);
    assert.match(phaseStageShellSource, /export function PhaseStageShell/);
    assert.match(phaseStageShellSource, /Pipeline Stage/);
    assert.match(phaseStageShellSource, /data-phase-stage=\{phase\}/);
    assert.match(phaseStageShellSource, /Latest Run:/);
    assert.match(phaseStageShellSource, /phaseRecordsLabel\(phase\)/);

    assert.match(src, /<PhaseStageShell[\s\S]*phase="Intake"[\s\S]*<PrdBriefingRoom/);
    assert.match(src, /<PhaseStageShell[\s\S]*phase="TestPlan"[\s\S]*<TestPlanSandbox/);
    assert.match(src, /<PhaseStageShell[\s\S]*phase="Plan"[\s\S]*<PlanSandbox/);
    assert.match(src, /<PhaseStageShell[\s\S]*phase=\{activeSelectedPhase === "Fix" \? "Fix" : "Build"\}[\s\S]*<BuildSandbox/);
    assert.match(src, /<PhaseStageShell[\s\S]*phase="Review"[\s\S]*<ReviewReportCenter/);
    assert.match(src, /<PhaseStageShell[\s\S]*phase=\{activeSelectedPhase\}[\s\S]*actions=\{gateStageActions\}[\s\S]*<GatePanel/);
    assert.match(src, /<PhaseStageShell[\s\S]*phase=\{activeSelectedPhase\}[\s\S]*<OperationalPhasePanel/);
    assert.match(src, /<PhaseStageShell[\s\S]*phase=\{activeSelectedPhase\}[\s\S]*<RefineChatPanel/);
  });

  it("keeps internal phase names while presenting PRD and QA in the shared shell", () => {
    assert.match(phaseStageShellSource, /Intake: \{[\s\S]*label: "PRD"/);
    assert.match(phaseStageShellSource, /Check: \{[\s\S]*label: "QA"/);
    assert.match(phaseStageShellSource, /export function phaseDisplayName/);
    assert.match(src, /phase="Intake"[\s\S]*<PrdBriefingRoom/);
    assert.match(src, /phase=\{activeSelectedPhase\}[\s\S]*<OperationalPhasePanel/);
  });

  it("fetches read-only phase review data through the phases endpoint", () => {
    assert.match(src, /import \{ PhaseReviewPanel,[^}]*type PhaseReviewResponse \} from "\.\/phase-review-panel";/);
    assert.doesNotMatch(src, /function PhaseReviewPanel/);
    assert.match(phaseReviewPanelSource, /export function PhaseReviewPanel/);
    assert.match(phaseReviewPanelSource, /new URLSearchParams\(\{ phase \}\)/);
    assert.match(phaseReviewPanelSource, /\/phases\?\$\{query\.toString\(\)\}/);
    assert.doesNotMatch(phaseReviewPanelSource, /handleAction/);
    assert.doesNotMatch(phaseReviewPanelSource, /ACTION_ENDPOINTS/);
  });

  it("uses phase availability to disable review buttons", () => {
    const phaseBarStart = phaseRailSource.indexOf("function PhaseBar");
    assert.notEqual(phaseBarStart, -1, "PhaseBar should exist");

    const phaseBarEnd = phaseRailSource.indexOf("function VerticalPhaseRail", phaseBarStart);
    const phaseBarSource = phaseRailSource.slice(phaseBarStart, phaseBarEnd);

    assert.match(phaseBarSource, /phaseOverviews/);
    assert.match(phaseRailSource, /stage\.selectable/);
    assert.match(phaseRailSource, /disabled=\{!canSelect\}/);
  });

  it("supports selecting a run and reworking through the dedicated endpoint", () => {
    assert.match(phaseReviewPanelSource, /selectedRunId/);
    assert.match(phaseReviewPanelSource, /query\.set\("runId", selectedRunId\)/);
    assert.match(phaseReviewPanelSource, /\/rework/);
    assert.match(phaseReviewPanelSource, /Rework This Phase/);
  });

  it("only offers Rework on phases the backend actually supports", () => {
    // Gate the button so non-reworkable phases (Intake/Spec/TechSpec/Review/Merge/Retro)
    // never fire a /rework that the endpoint rejects with 400.
    assert.match(phaseReviewPanelSource, /const canRework = REWORKABLE_REVIEW_PHASES\.includes\(phase\)/);
    assert.match(phaseReviewPanelSource, /\{canRework && \(/);

    // The client whitelist must EXACTLY match the backend's ReworkReviewPhase union —
    // too permissive re-introduces the 400; too strict hides a working action.
    const reworkServiceSource = readFileSync(
      resolve(process.cwd(), "server/services/change-rework-service.ts"),
      "utf-8",
    );
    const unionMatch = reworkServiceSource.match(/export type ReworkReviewPhase =([^;]+);/);
    assert.ok(unionMatch, "ReworkReviewPhase union should be present in change-rework-service.ts");
    const backendPhases = [...unionMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    const clientPhases = [...REWORKABLE_REVIEW_PHASES].sort();
    assert.deepEqual(clientPhases, backendPhases);
  });

  it("renders phase artifacts, runs, and events through the shared StageEvidencePanel", () => {
    assert.match(stageEvidencePanelSource, /export function StageEvidencePanel/);
    assert.match(stageEvidencePanelSource, /sections\.map/);
    assert.match(stageEvidencePanelSource, /StageEvidenceEmpty/);
    assert.match(stageEvidencePanelSource, /actionSlot/);
    assert.match(stageEvidencePanelSource, /loading/);
    assert.match(stageEvidencePanelSource, /error/);

    assert.match(phaseReviewPanelSource, /function usePhaseReviewData/);
    assert.match(phaseReviewPanelSource, /function PhaseEvidenceView/);
    assert.match(phaseReviewPanelSource, /<StageEvidencePanel/);
    assert.match(phaseReviewPanelSource, /id: "artifacts"/);
    assert.match(phaseReviewPanelSource, /id: "runs"/);
    assert.match(phaseReviewPanelSource, /id: "events"/);
    assert.match(phaseReviewPanelSource, /const commonEmptyLabel = "No evidence for this section yet\."/);
    assert.match(phaseReviewPanelSource, /emptyLabel: commonEmptyLabel/);
    assert.match(phaseReviewPanelSource, /disabled=\{loading \|\| reworking \|\| isChangeRunning \|\| !hasContent\}/);
    assert.match(phaseReviewPanelSource, /aria-label="Select phase review run"/);
    assert.doesNotMatch(phaseReviewPanelSource, /<div className="rounded-lg border p-4 md:col-span-2">/);
    assert.doesNotMatch(phaseReviewPanelSource, /<div className="rounded-lg border p-4">\s*<h3 className="mb-2 font-medium">Run Summary<\/h3>/);
    assert.doesNotMatch(phaseReviewPanelSource, /<div className="rounded-lg border p-4">\s*<h3 className="mb-2 font-medium">Events<\/h3>/);
  });

  it("keeps StageEvidencePanel loading and error states separate from empty section output", () => {
    const sections = [
      {
        id: "artifacts",
        title: "Artifacts",
        count: 0,
        emptyLabel: "No evidence for this section yet.",
        children: createElement("div", null, "artifact body"),
      },
    ];

    const loadingHtml = renderToStaticMarkup(
      createElement(StageEvidencePanel, {
        title: "Evidence",
        loading: true,
        sections,
      }),
    );
    assert.match(loadingHtml, /Loading\.\.\./);
    assert.doesNotMatch(loadingHtml, /No evidence for this section yet\./);
    assert.doesNotMatch(loadingHtml, /Artifacts/);

    const errorHtml = renderToStaticMarkup(
      createElement(StageEvidencePanel, {
        title: "Evidence",
        error: "Failed to load evidence.",
        sections,
      }),
    );
    assert.match(errorHtml, /Failed to load evidence\./);
    assert.doesNotMatch(errorHtml, /No evidence for this section yet\./);
    assert.doesNotMatch(errorHtml, /Artifacts/);

    const emptyHtml = renderToStaticMarkup(
      createElement(StageEvidencePanel, {
        title: "Evidence",
        sections,
      }),
    );
    assert.match(emptyHtml, /Artifacts/);
    assert.match(emptyHtml, /No evidence for this section yet\./);
  });

  it("uses a shared editable phase artifact component", () => {
    const componentPath = resolve(__dirname, "editable-phase-artifact.tsx");
    const component = readFileSync(componentPath, "utf-8");

    assert.match(component, /export function EditablePhaseArtifact/);
    assert.match(component, /impactLabel/);
    assert.match(component, /editablePath/);
    assert.match(component, /\/phase-artifacts/);
    assert.match(component, /JSON\.parse/);
    assert.match(component, /import \{ useEffect, useState \} from "react";/);
    assert.match(component, /if \(readOnly && editing\) \{/);
    assert.match(component, /setDraft\(artifact\.content \?\? ""\);[\s\S]*setError\(""\);[\s\S]*setEditing\(false\);/);
    assert.match(component, /if \(!canEdit\) return;/);
    assert.match(phaseReviewPanelSource, /EditablePhaseArtifact/);
    assert.match(phaseReviewPanelSource, /reloadToken/);
    assert.match(phaseReviewPanelSource, /phaseArtifactReadOnly/);
    assert.match(phaseReviewPanelSource, /onArtifactSaved/);
    assert.doesNotMatch(phaseReviewPanelSource, /<pre className="max-h-96 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">/);
  });

  it("keeps phase artifacts read-only while the latest run is running", () => {
    assert.match(phaseReviewPanelSource, /latestRunStatus\?: string \| null/);
    assert.match(phaseReviewPanelSource, /latestRunStatus === "running"/);
    assert.match(phaseReviewPanelSource, /\.includes\(changeStatus\) \|\| latestRunStatus === "running"/);
    assert.match(src, /const latestRunStatusLabel = change\.latestRun\?\.status \?\? null;/);
    assert.match(src, /latestRunStatus=\{latestRunStatusLabel\}/);
  });

  it("keeps legacy artifact modal separate from canonical phase artifact editing", () => {
    const component = readFileSync(resolve(__dirname, "editable-phase-artifact.tsx"), "utf-8");

    assert.match(src, /import \{ ArtifactsPanel \} from "\.\/artifacts-panel";/);
    assert.match(src, /<ArtifactsPanel projectId=\{projectId\} changeId=\{changeId\} changeStatus=\{change\.status\} \/>/);
    assert.match(src, /import \{ PhaseReviewPanel,[^}]*type PhaseReviewResponse \} from "\.\/phase-review-panel";/);
    assert.match(phaseReviewPanelSource, /EditablePhaseArtifact/);
    assert.match(phaseReviewPanelSource, /phaseArtifactReadOnly/);
    assert.doesNotMatch(src, /function ArtifactsPanel/);
    assert.match(artifactsPanelSource, /export function ArtifactsPanel/);
    assert.match(artifactsPanelSource, /\/artifacts\/\$\{viewingContent\.id\}\/content/);
    assert.match(component, /\/phase-artifacts/);
  });

  it("renders Spec Battle as a two-panel battlefield instead of the old gate card", () => {
    const component = readFileSync(resolve(__dirname, "spec-battlefield.tsx"), "utf-8");
    const gateStart = gatePanelSource.indexOf("function GatePanel");
    assert.notEqual(gateStart, -1, "GatePanel should exist");
    const gateSource = gatePanelSource.slice(gateStart);
    const specBranchStart = gateSource.indexOf("const specBattle = gateStatus?.specBattle ?? specBattleFallback");
    assert.notEqual(specBranchStart, -1, "Spec battle branch should exist");
    const specBranchEnd = gateSource.indexOf("if (!gateStatus?.atGate)", specBranchStart);
    const specBranch = gateSource.slice(specBranchStart, specBranchEnd);

    assert.match(src, /import \{[\s\S]*GatePanel[\s\S]*buildRunningSpecBattleGateState[\s\S]*gateApprovalAction[\s\S]*\} from "\.\/gate-panel";/);
    assert.match(changeCommandsSource, /import \{ gateApprovalAction, gateRejectAction \} from "\.\/gate-panel";/);
    assert.match(src, /<GatePanel/);
    assert.doesNotMatch(src, /showingGatePanel/);
    assert.doesNotMatch(src, /\{showingGatePanel && \(/);
    assert.match(gatePanelSource, /import \{ SpecBattlefield \} from "\.\/spec-battlefield";/);
    assert.match(specBranch, /specBattleFallback/);
    assert.match(specBranch, /gateStatus\?\.specBattle \?\? specBattleFallback/);
    assert.match(specBranch, /<SpecBattlefield/);
    assert.match(specBranch, /onAcceptRisk=\{onAcceptRisk\}/);
    assert.match(gateSource, /const runTechSpecAction = findPipelineAction\(gateStatus\?\.actions, "run_tech_spec"\)/);
    assert.match(specBranch, /runTechSpecAction=\{runTechSpecAction\}/);
    assert.match(specBranch, /onStopBattle=\{onStopBattle\}/);
    assert.match(specBranch, /onBattleDecision=\{onBattleDecision\}/);
    assert.match(specBranch, /onRestartBattle=\{onRestartBattle\}/);
    assert.match(specBranch, /onRegenerateReport=\{onRegenerateReport\}/);
    assert.match(specBranch, /battleState=\{specBattleState\}/);
    assert.doesNotMatch(specBranch, />Approve</);
    assert.doesNotMatch(specBranch, />打回</);
    assert.doesNotMatch(specBranch, /产物预览/);
    assert.doesNotMatch(gateSource, /<h4 className="text-sm font-medium">Spec Battle<\/h4>/);

    assert.match(component, /Spec 回合战场/);
    assert.match(component, />战场</);
    assert.match(component, />本轮战报</);
    assert.match(component, /本轮已解决/);
    assert.match(component, /仍在阻断/);
    assert.match(component, /新发现/);
    assert.match(component, /未复核/);
    assert.match(component, /roundDelta\.notRechecked > 0/);
    assert.match(component, /旧问题没有完成消账/);
    assert.match(component, /我方修复声明 \/ 反方复核/);
    assert.match(component, /继续对抗一轮/);
    assert.match(component, /继续追加一轮/);
    assert.match(component, /重跑本轮/);
    assert.match(component, /onRestartBattle\(\)/);
    assert.match(component, /刷新战报/);
    assert.match(component, /批准进入 TechSpec/);
    assert.match(component, /接受风险并通过/);
    assert.match(component, /先刷新战报/);
    assert.match(component, /!specBattle\.reportFresh/);
    assert.match(component, /终止 Battle/);
    assert.match(component, /高级详情/);
    assert.match(component, /Requirement Gaps/);
    assert.doesNotMatch(component, /固定单位/);
    assert.doesNotMatch(component, /Spec Battle RTS Command/);
    assert.doesNotMatch(component, /要求修改/);
    assert.doesNotMatch(component, /退回 Spec/);
    assert.doesNotMatch(component, /豁免 P1/);
    assert.doesNotMatch(component, /P1 豁免目标/);
    assert.doesNotMatch(component, /证据链/);
    assert.doesNotMatch(component, /人工命令记录/);
    assert.doesNotMatch(component, /approve \/ request \/ return \/ waive/);
    assert.doesNotMatch(component, /onBattleDecision\("approve"\)/);
    assert.doesNotMatch(component, /onBattleDecision\("reject"\)/);
  });

  it("shows Generate TechSpec in Spec Battle when run_tech_spec is enabled", () => {
    const component = readFileSync(resolve(__dirname, "spec-battlefield.tsx"), "utf-8");

    assert.match(component, /runTechSpecAction\?: \{/);
    assert.match(component, /const canRunTechSpec = runTechSpecAction\?\.enabled === true/);
    assert.match(component, /const canAcceptRisk = !reportStale && \(canApproveGate \|\| canRunTechSpec \|\| canAcceptP1Risk\)/);
    assert.match(component, /canApproveGate[\s\S]*\? "批准进入 TechSpec"[\s\S]*: canRunTechSpec[\s\S]*\? "生成 TechSpec"/);
    assert.match(component, /canApproveGate[\s\S]*\? "批准 Spec Gate，并自动启动 TechSpec"[\s\S]*: canRunTechSpec[\s\S]*\? "Spec 已批准，启动 TechSpec"/);
    assert.match(component, /variant=\{canApproveGate \|\| canRunTechSpec \? "default" : "outline"\}/);
    assert.match(component, /disabled=\{disabled \|\| roundRunning \|\| !canAcceptRisk\}/);
  });

  it("keeps P1 risk target selection inside advanced details", () => {
    const component = readFileSync(resolve(__dirname, "spec-battlefield.tsx"), "utf-8");

    assert.match(component, /<details className=/);
    assert.match(component, /id="accept-risk-gap"/);
    assert.match(component, /p1Targets\.map/);
    assert.match(component, /\["open", "downgraded"\]\.includes\(gap\.status\)/);
    assert.match(component, /selectedP1Gap/);
    assert.doesNotMatch(component, /waive-gap-target/);
    assert.doesNotMatch(component, /waiveUnavailableReason/);
    assert.doesNotMatch(component, /targetId.*<input/);
    assert.doesNotMatch(component, /gap id/i);
    // The picker is a naming device before it is a choosing device, so it must
    // not hide below two candidates: "接受风险并通过" waives one specific gap
    // either way, and at `> 1` the lone-target case waived it unnamed.
    assert.match(component, /\{p1Targets\.length > 0 && \(/);
    assert.doesNotMatch(component, /p1Targets\.length > 1/);
  });

  it("offers every open or downgraded P1 gap as a waiver target, not just the first", () => {
    const targets = selectWaivableP1Gaps([
      requirementGap("g-p0", { severity: "P0" }),
      requirementGap("g-a"),
      requirementGap("g-resolved", { status: "resolved" }),
      requirementGap("g-b"),
      requirementGap("g-waived", { status: "waived" }),
      requirementGap("g-p2", { severity: "P2" }),
      // A P0 downgraded to P1 is waivable: effectiveSeverity, not the raw column,
      // decides what the P1 waiver may land on.
      requirementGap("g-down", { severity: "P0", downgradedTo: "P1", status: "downgraded" }),
    ]);

    assert.deepEqual(targets.map((gap) => gap.id), ["g-a", "g-b", "g-down"]);
    assert.deepEqual(selectWaivableP1Gaps(undefined), []);
    assert.deepEqual(selectWaivableP1Gaps(null), []);
  });

  it("waives the gap the human picked instead of whichever happens to sort first", () => {
    const targets = selectWaivableP1Gaps([
      requirementGap("g-a"),
      requirementGap("g-b"),
      requirementGap("g-c"),
    ]);

    assert.equal(resolveWaiveP1Gap(targets, "g-c")?.id, "g-c");
    assert.equal(resolveWaiveP1Gap(targets, "g-b")?.id, "g-b");
  });

  it("defaults the waiver target to the first candidate before anything is picked", () => {
    const targets = selectWaivableP1Gaps([requirementGap("g-a"), requirementGap("g-b")]);

    assert.equal(resolveWaiveP1Gap(targets, "")?.id, "g-a");
    assert.equal(resolveWaiveP1Gap(targets, null)?.id, "g-a");
  });

  it("drops a stale pick instead of waiving a gap that stopped being a candidate", () => {
    const targets = selectWaivableP1Gaps([
      requirementGap("g-a"),
      requirementGap("g-b", { status: "resolved" }),
      requirementGap("g-c", { severity: "P2" }),
    ]);

    // g-b was picked and then closed by a later round; g-c was never a P1.
    assert.equal(resolveWaiveP1Gap(targets, "g-b")?.id, "g-a");
    assert.equal(resolveWaiveP1Gap(targets, "g-c")?.id, "g-a");
    assert.equal(resolveWaiveP1Gap([], "g-a"), null);
  });

  it("spells out that accepting the risk covers only the picked gap", () => {
    assert.equal(waiveP1GapHint(1), "「接受风险并通过」只对这一项生效。");
    assert.equal(waiveP1GapHint(0), "「接受风险并通过」只对这一项生效。");
    assert.match(waiveP1GapHint(3), /只对选中的这一项生效/);
    assert.match(waiveP1GapHint(3), /其余 2 项仍然阻断/);
    assert.match(waiveP1GapHint(2), /其余 1 项仍然阻断/);
  });

  it("renders one option per waivable P1 gap, so the target can actually be changed", () => {
    const html = renderSpecBattlefield([
      // A P0 sorts ahead of both P1s: the default target must be the first
      // *candidate*, never just the first gap in the report.
      requirementGap("g-p0", { title: "必修", severity: "P0" }),
      requirementGap("g-a", { canonicalGapId: "GAP-007", title: "缺少并发边界" }),
      requirementGap("g-b", { canonicalGapId: "GAP-021", title: "回滚路径未定义" }),
      requirementGap("g-resolved", { title: "已解决", status: "resolved" }),
      requirementGap("g-p2", { title: "小问题", severity: "P2" }),
    ]);

    const picker = html.slice(html.indexOf('id="accept-risk-gap"'));
    assert.match(html, /id="accept-risk-gap"/);
    assert.match(picker, /<option value="g-a" selected="">GAP-007 · 缺少并发边界<\/option>/);
    assert.match(picker, /<option value="g-b">GAP-021 · 回滚路径未定义<\/option>/);
    assert.doesNotMatch(picker, /<option value="g-p0"/);
    assert.doesNotMatch(picker, /<option value="g-resolved"/);
    assert.doesNotMatch(picker, /<option value="g-p2"/);
    assert.match(html, /只对选中的这一项生效/);
    assert.match(html, /其余 1 项仍然阻断/);
  });

  it("renders the picker for a lone waivable P1 gap too, so it is named before it is waived", () => {
    const html = renderSpecBattlefield([
      requirementGap("g-only", { canonicalGapId: "GAP-042", title: "唯一的 P1" }),
      requirementGap("g-resolved", { title: "已解决", status: "resolved" }),
    ]);

    assert.match(html, /id="accept-risk-gap"/);
    assert.match(html, /<option value="g-only"[^>]*>GAP-042 · 唯一的 P1<\/option>/);
    assert.match(html, /只对这一项生效/);
  });

  it("hides the gap picker entirely when nothing is waivable", () => {
    const html = renderSpecBattlefield([requirementGap("g-resolved", { status: "resolved" })]);

    assert.doesNotMatch(html, /accept-risk-gap/);
    assert.doesNotMatch(html, /只对这一项生效/);
  });

  it("routes non-battle gate approval through the shared StageFrame action zone", () => {
    const gateStart = gatePanelSource.indexOf("function GatePanel");
    assert.notEqual(gateStart, -1, "GatePanel should exist");
    const gateSource = gatePanelSource.slice(gateStart);

    assert.match(gatePanelSource, /type PipelineActionContract/);
    assert.match(gatePanelSource, /import type \{ GateName, GateStatus \} from "\.\/gate-types";/);
    assert.match(gateTypesSource, /actions\?: PipelineActionContract\[\]/);
    assert.match(gatePanelSource, /function gateApprovalActionId/);
    assert.match(gatePanelSource, /function gateRejectActionId/);
    assert.doesNotMatch(src, /function gateApprovalActionId/);
    assert.doesNotMatch(src, /function gateRejectActionId/);
    assert.match(src, /useChangeCommands/);
    assert.match(changeCommandsSource, /GATE_NEXT_STAGE_ACTION_IDS/);
    assert.match(changeCommandsSource, /intake:\s*"run_spec"/);
    assert.match(changeCommandsSource, /spec:\s*"run_tech_spec"/);
    assert.match(changeCommandsSource, /tech_spec:\s*"run_plan"/);
    assert.match(changeCommandsSource, /const approveAction = gateApprovalAction\(gateStatus\)/);
    assert.match(changeCommandsSource, /const rejectAction = gateRejectAction\(gateStatus\)/);
    // The approve/reject pair is assembled by buildGateStageActions in gate-panel;
    // the page only supplies labels and handlers.
    assert.match(src, /const gateStageActions = useMemo<StageActionView\[\]>/);
    assert.match(src, /buildGateStageActions\(\{/);
    assert.match(gatePanelSource, /const approveAction = gateApprovalAction\(input\.gateStatus\)/);
    assert.match(gatePanelSource, /const rejectAction = gateRejectAction\(input\.gateStatus\)/);
    assert.match(gatePanelSource, /pipelineActionDisabledReason\(approveAction\)/);
    assert.match(gatePanelSource, /pipelineActionDisabledReason\(rejectAction\)/);
    assert.match(src, /approveLabel: gateApproveLabel/);
    assert.match(src, /rejectLabel: gateRejectLabel/);
    assert.match(src, /onApprove: handleApproveGate/);
    assert.match(src, /onReject: handleRejectGate/);
    assert.match(gatePanelSource, /onAction: input\.onApprove/);
    assert.match(gatePanelSource, /onAction: input\.onReject/);
    assert.match(src, /actions=\{gateStageActions\}/);
    assert.match(src, /actionError=\{gateError\}/);
    assert.match(gateSource, /approveAction=\{approveAction\}/);
    assert.doesNotMatch(gateSource, /approveAction\?\.enabled !== true/);
    assert.doesNotMatch(gateSource, /rejectAction\?\.enabled !== true/);
    assert.doesNotMatch(gateSource, />Approve</);
    assert.doesNotMatch(gateSource, />打回</);
    assert.doesNotMatch(gateSource, /Submitting\.\.\./);
    assert.doesNotMatch(gateSource, /产物预览/);
    assert.match(changeCommandsSource, /expectedGateVersion: approveAction\?\.gateVersion/);
    assert.match(changeCommandsSource, /expectedSourceDbHash: approveAction\?\.sourceDbHash/);
    assert.match(changeCommandsSource, /createPipelinePreflightPayload\(nextAction\)/);
    assert.match(changeCommandsSource, /createPipelinePreflightPayload\(rejectAction, \{ gate: gateStatus\.gate \}\)/);
    assert.match(changeCommandsSource, /idempotencyKey:/);
    const component = readFileSync(resolve(__dirname, "spec-battlefield.tsx"), "utf-8");
    assert.match(component, /const canApproveGate = approveAction\?\.enabled === true/);
    assert.doesNotMatch(component, /const canApproveGate = specBattle\.actions\.approve\.available/);
  });

  it("renders Spec and Tech Spec gates as first-class StageFrame branches", () => {
    assert.match(src, /const showingSpecOrTechSpecGate = activeSelectedPhase === "Spec" \|\| activeSelectedPhase === "TechSpec"/);
    assert.match(src, /const gateApproveLabel = activeSelectedPhase === "Spec"[\s\S]*"批准 Spec"[\s\S]*activeSelectedPhase === "TechSpec"[\s\S]*"批准 Tech Spec"[\s\S]*"批准 PRD"/);
    assert.match(src, /const gateRejectLabel = activeSelectedPhase === "Spec"[\s\S]*"退回 Spec"[\s\S]*activeSelectedPhase === "TechSpec"[\s\S]*"退回 Tech Spec"[\s\S]*"退回 PRD"/);

    const gateBranchStart = src.indexOf("showingSpecOrTechSpecGate ? (");
    assert.notEqual(gateBranchStart, -1, "Spec/TechSpec gate branch should exist");
    const gateBranchEnd = src.indexOf(") : showingReviewReportCenter ? (", gateBranchStart);
    assert.notEqual(gateBranchEnd, -1, "Spec/TechSpec gate branch should end before Review");
    const gateBranch = src.slice(gateBranchStart, gateBranchEnd);

    assert.match(gateBranch, /<PhaseStageShell/);
    assert.match(gateBranch, /phase=\{activeSelectedPhase\}/);
    assert.match(gateBranch, /actions=\{gateStageActions\}/);
    assert.match(gateBranch, /actionError=\{gateError\}/);
    assert.match(gateBranch, /records=\{renderPhaseRecords\(activeSelectedPhase, "gate-records"\)\}/);
    assert.match(gateBranch, /<GatePanel/);
    assert.match(gateBranch, /specBattleFallback=\{activeSpecBattleFallback\}/);

    const legacyFallbackStart = src.indexOf("{/* Action Buttons */}");
    assert.notEqual(legacyFallbackStart, -1, "legacy fallback should remain for non-stage surfaces only");
    const legacyFallback = src.slice(legacyFallbackStart);
    assert.doesNotMatch(gateBranch, /Action Buttons/);
    assert.doesNotMatch(gateBranch, /Live Panels/);
    assert.doesNotMatch(legacyFallback, /activeSelectedPhase === "Spec"/);
    assert.doesNotMatch(legacyFallback, /activeSelectedPhase === "TechSpec"/);
  });

  it("keeps the battlefield readable with a simple two-column desktop layout", () => {
    const component = readFileSync(resolve(__dirname, "spec-battlefield.tsx"), "utf-8");

    assert.match(component, /lg:grid-cols-\[minmax\(0,0\.95fr\)_minmax\(0,1\.05fr\)\]/);
    assert.doesNotMatch(component, /xl:grid-cols-\[13rem_minmax\(0,1fr\)_16rem\]/);
    assert.doesNotMatch(component, /2xl:grid-cols-\[13rem_minmax\(32rem,1fr\)_16rem\]/);
  });

  it("renders Review as a StageFrame workspace with raw phase records collapsed", () => {
    const component = readFileSync(resolve(__dirname, "review-report-center.tsx"), "utf-8");

    assert.match(src, /import \{ ReviewReportCenter \} from "\.\/review-report-center";/);
    assert.match(src, /const showingReviewReportCenter = activeSelectedPhase === "Review"/);
    assert.match(src, /<ReviewReportCenter/);
    assert.match(src, /const handleRunReviewAction = useCallback\(\(actionId: "run_review" \| "retry_review"\) => \{[\s\S]*handleAction\(actionId\)/);
    assert.match(src, /const handleEnterQaAction = useCallback\(\(\) => \{[\s\S]*handleAction\("enter_qa"\)/);
    assert.match(phaseStageShellSource, /phaseRecordsLabel\(phase\)/);
    assert.match(changeDetailDataHookSource, /import type \{ ReviewCenterResponse \} from "\.\/review-report-center";/);
    assert.match(changeApiSource, /getReviewCenter: async \(\) => readJson<ReviewCenterResponse>/);
    assert.match(changeDetailDataHookSource, /\.getReviewCenter\(\)/);
    assert.match(changeDetailDataHookSource, /setReviewCenterState\(data\)/);
    assert.match(src, /buildUiPipelineState\(\{[\s\S]*reviewCenterState,/);

    const reviewBranchStart = src.indexOf("showingReviewReportCenter ? (");
    assert.notEqual(reviewBranchStart, -1, "Review report center branch should exist");
    const reviewBranchEnd = src.indexOf(") : showingReviewPhase ? (", reviewBranchStart);
    const reviewBranch = src.slice(reviewBranchStart, reviewBranchEnd);
    assert.match(reviewBranch, /<PhaseStageShell/);
    assert.match(reviewBranch, /actions=\{reviewStageActions\}/);
    assert.match(reviewBranch, /actionError=\{reviewStageActionError \|\| actionError\}/);
    assert.match(reviewBranch, /blockers=\{reviewStageBlockers\}/);
    assert.match(reviewBranch, /records=\{renderPhaseRecords\("Review", "review-records"\)\}/);
    assert.match(reviewBranch, /onRunReview=\{handleRunReviewAction\}/);
    assert.match(reviewBranch, /onEnterQa=\{handleEnterQaAction\}/);
    assert.match(reviewBranch, /onFixBlockers=\{handleFixBlockersAction\}/);
    assert.match(reviewBranch, /onBlockChange=\{handleStopChangeAction\}/);
    assert.match(reviewBranch, /onStageActionsChange=\{setReviewStageActions\}/);
    assert.match(reviewBranch, /onStageActionError=\{setReviewStageActionError\}/);
    assert.match(phaseStageShellSource, /<details className="rounded-lg border bg-background p-4">/);

    assert.match(component, /import type \{ StageActionView \} from "\.\/stage-action-bar";/);
    assert.match(component, /onStageActionsChange\?: \(actions: StageActionView\[\]\) => void/);
    assert.match(component, /onStageActionError\?: \(error: string \| null\) => void/);
    assert.match(component, /Review 结果/);
    assert.match(component, /Review 事实/);
    assert.doesNotMatch(component, /反方战报/);
    assert.doesNotMatch(component, /战报事实/);
    assert.doesNotMatch(component, /指挥动作/);
    assert.doesNotMatch(component, /关卡状态/);
    assert.match(component, /latestAttempt/);
    assert.match(component, /latestValidReview/);
    assert.match(component, /headlineStatus/);
    assert.match(component, /qaAllowed/);
    assert.match(component, /advancedDetails/);
    assert.match(component, /mirrorWarnings/);
    assert.match(component, /findPipelineAction\(actions, "recompute_report"\)/);
    assert.match(component, /findPipelineAction\(actions, "rebuild_mirror"\)/);
    assert.match(component, /findPipelineAction\(actions, "waive_review_p1"\)/);
    assert.match(component, /const runReviewCommand = useMemo\(\(\) => resolveReviewRunCommand/);
    assert.match(component, /const stageActions = useMemo<StageActionView\[\]>\(\(\) => buildReviewStageActions/);
    assert.match(component, /onStageActionsChange\?\.\(stageActions\)/);
    assert.match(component, /onStageActionsChange\?\.\(\[\]\)/);
    assert.match(component, /onStageActionError\?\.\(error \|\| null\)/);
    assert.match(component, /onStageActionError\?\.\(null\)/);
    assert.doesNotMatch(component, /getAction\(state/);
    assert.match(component, /\/review-report\/recompute/);
    assert.match(component, /\/review-artifacts\/rebuild/);
    assert.match(component, /最近尝试/);
    assert.match(component, /上一轮有效 Review/);
    assert.match(component, /历史不完整 Review/);
    assert.doesNotMatch(component, /rawOutputPath/);
    assert.doesNotMatch(component, /reportPath/);
    assert.doesNotMatch(component, /findingsPath/);
    assert.match(component, /\/review-center/);
    assert.match(component, /开始反方审查/);
    assert.match(component, /进入 QA/);
    assert.match(component, /接受 P1 风险/);
    assert.doesNotMatch(component, /<section className=\{`rounded-lg border p-4 \$\{gateCopy\.tone\}`\}>/);
    assert.doesNotMatch(component, /CHECK_FAILED/);
    assert.doesNotMatch(component, /Run Summary/);
    assert.doesNotMatch(component, /Events/);
    assert.doesNotMatch(component, /review-findings\.json/);
  });

  it("renders QA and Merge actions and readiness blockers through the shared StageFrame", () => {
    const operationalPanel = readFileSync(resolve(__dirname, "operational-phase-panel.tsx"), "utf-8");
    const operationalBranchStart = src.indexOf("showingOperationalPhaseSummary ? (");
    assert.notEqual(operationalBranchStart, -1, "Operational phase branch should exist");
    const operationalBranchEnd = src.indexOf(") : (", operationalBranchStart);
    const operationalBranch = src.slice(operationalBranchStart, operationalBranchEnd);

    assert.match(src, /const operationalStageActions = useMemo<StageActionView\[\]>/);
    assert.match(src, /const operationalStageBlockers = useMemo<StageBlockerView\[\]>/);
    assert.match(src, /const operationalActionIds = useMemo\(\(\) => selectedStage\?\.actionIds \?\? \[\]/);
    assert.match(src, /action\.phase === operationalContractPhase[\s\S]*operationalActionIds\.includes\(action\.actionId\)/);
    assert.doesNotMatch(src, /showingGatePanel/);
    assert.doesNotMatch(src, /\{showingGatePanel && \(/);
    assert.match(src, /<OperationalPhasePanel[\s\S]*mergeChecks=\{activeSelectedPhase === "Merge" \? gateStatus\?\.mergeChecks : undefined\}/);
    assert.doesNotMatch(src, /!\(showingOperationalPhaseSummary && gateStatus\?\.gate === "merge"\)/);
    assert.match(src, /action\.actionId === "approve_merge"[\s\S]*\? handleApproveGate/);
    assert.match(src, /action\.actionId === "reject_merge"[\s\S]*\? handleRejectGate/);
    assert.match(src, /const mergeReadinessBlockers = activeSelectedPhase === "Merge"[\s\S]*buildMergeReadinessBlockers\(gateStatus\?\.mergeChecks\)/);
    assert.match(src, /\.\.\.mergeReadinessBlockers/);
    assert.match(src, /sourceActionId: action\.actionId/);
    assert.match(src, /disabledReason === null/);
    assert.match(src, /: \(\) => handleAction\(action\.actionId\)/);
    assert.match(src, /onAction,/);
    assert.match(operationalBranch, /actions=\{operationalStageActions\}/);
    assert.match(operationalBranch, /actionError=\{operationalStageActionError\}/);
    assert.match(operationalBranch, /blockers=\{operationalStageBlockers\}/);
    assert.match(operationalBranch, /records=\{renderPhaseRecords\(activeSelectedPhase, "operational-records"\)\}/);
    assert.match(operationalBranch, /<OperationalPhasePanel/);

    assert.match(operationalPanel, /phase === "Check" \? "QA 工作区" : "Merge 工作区"/);
    assert.doesNotMatch(operationalPanel, /QA 战报/);
    assert.doesNotMatch(operationalPanel, /Merge 指挥台/);
    assert.doesNotMatch(operationalPanel, /StageFrame/);
    assert.match(operationalPanel, /phase === "Check" \? "验证当前变更" : "准备合并"/);
    assert.doesNotMatch(operationalPanel, /import \{ Button \}/);
    assert.doesNotMatch(operationalPanel, /onAction/);
    assert.doesNotMatch(operationalPanel, /<Button/);
    assert.doesNotMatch(operationalPanel, /disabledReasons/);
  });

  it("keeps Merge readiness facts visible in the workspace when the GatePanel is hidden", () => {
    const html = renderToStaticMarkup(
      createElement(OperationalPhasePanel, {
        phase: "Merge",
        actionCount: 3,
        mergeChecks: {
          qaPassed: true,
          reviewPassed: true,
          docsComplete: true,
          requirementGapsPassed: true,
          mergeBlockingRequirementGaps: 0,
          canMerge: true,
          missing: [],
        },
      }),
    );

    assert.match(html, /aria-label="Merge readiness facts"/);
    assert.match(html, /QA passed/);
    assert.match(html, /Review passed/);
    assert.match(html, /Docs complete/);
    assert.match(html, /Requirements 0 blocking/);
  });

  it("does not leak Merge readiness facts into the QA workspace", () => {
    const html = renderToStaticMarkup(
      createElement(OperationalPhasePanel, {
        phase: "Check",
        actionCount: 2,
        mergeChecks: {
          qaPassed: true,
          reviewPassed: true,
          docsComplete: true,
          requirementGapsPassed: true,
          mergeBlockingRequirementGaps: 0,
          canMerge: true,
          missing: [],
        },
      }),
    );

    assert.doesNotMatch(html, /Merge readiness facts/);
    assert.doesNotMatch(html, /QA passed/);
    assert.doesNotMatch(html, /Review passed/);
    assert.doesNotMatch(html, /Docs complete/);
    assert.doesNotMatch(html, /Requirements 0 blocking/);
  });

  it("keeps Retro actions out of Merge StageFrame operational actions and blockers", () => {
    assert.match(src, /action\.phase === operationalContractPhase[\s\S]*operationalActionIds\.includes\(action\.actionId\)/);
    assert.match(pipelineUiModelSource, /actionIds: \["approve_merge", "reject_merge", "merge"\]/);

    const operationalActionStart = src.indexOf("const operationalActions = useMemo");
    assert.notEqual(operationalActionStart, -1, "operationalActions memo should exist");
    const operationalActionEnd = src.indexOf("const operationalStageActions", operationalActionStart);
    const operationalActionSource = src.slice(operationalActionStart, operationalActionEnd);
    assert.doesNotMatch(operationalActionSource, /run_retro/);
    assert.doesNotMatch(operationalActionSource, /action\.phase === operationalContractPhase\)\s*$/);
  });

  it("builds shared Review stage actions with consistent disabled reasons", () => {
    const calls: string[] = [];
    const actions = buildReviewStageActions({
      runReviewCommand: {
        actionId: "retry_review",
        label: "重新审查",
        enabled: true,
        disabledReason: null,
      },
      actionBusy: false,
      p1Target: "finding-p1",
      waiveReason: null,
      fixReason: "Fix requires open P0/P1 findings.",
      enterQaReason: "Open P1 findings must be fixed or accepted.",
      stopReason: "Only active changes can be stopped.",
      recomputeReason: "Report is already fresh.",
      waiveAction: reviewPipelineAction("waive_review_p1", true),
      fixAction: reviewPipelineAction("fix_blockers", false, "Fix requires open P0/P1 findings."),
      enterQaAction: reviewPipelineAction("enter_qa", false, "Open P1 findings must be fixed or accepted."),
      stopAction: reviewPipelineAction("stop_change", false, "Only active changes can be stopped."),
      recomputeAction: reviewPipelineAction("recompute_report", false, "Report is already fresh."),
      onRunReview: (actionId) => calls.push(actionId),
      onWaiveP1: () => calls.push("waive_review_p1"),
      onFixBlockers: () => calls.push("fix_blockers"),
      onRecomputeReport: () => calls.push("recompute_report"),
      onEnterQa: () => calls.push("enter_qa"),
      onBlockChange: () => calls.push("stop_change"),
    });

    assert.deepEqual(
      actions.map((action) => [action.sourceActionId, action.disabledReason]),
      [
        ["retry_review", null],
        ["waive_review_p1", null],
        ["fix_blockers", "Fix requires open P0/P1 findings."],
        ["recompute_report", "Report is already fresh."],
        ["enter_qa", "Open P1 findings must be fixed or accepted."],
        ["stop_change", "Only active changes can be stopped."],
      ],
    );
    assert.equal(actions.find((action) => action.sourceActionId === "stop_change")?.role, "destructive");
    actions[0].onAction();
    actions[1].onAction();
    assert.deepEqual(calls, ["retry_review", "waive_review_p1"]);
  });

  it("offers every waivable open P1 as a waiver target, not just the first", () => {
    const targets = selectWaivableP1Findings([
      reviewFinding("f-p0", { severity: "P0" }),
      reviewFinding("f-a"),
      reviewFinding("f-fixed", { status: "fixed" }),
      reviewFinding("f-b"),
      reviewFinding("f-locked", { waivable: false }),
      reviewFinding("f-p2", { severity: "P2" }),
      reviewFinding("f-c"),
    ]);

    assert.deepEqual(targets.map((finding) => finding.id), ["f-a", "f-b", "f-c"]);
    assert.deepEqual(selectWaivableP1Findings(undefined), []);
  });

  it("waives the P1 the human picked instead of whichever happens to sort first", () => {
    const targets = selectWaivableP1Findings([
      reviewFinding("f-a"),
      reviewFinding("f-b"),
      reviewFinding("f-c"),
    ]);

    assert.equal(resolveWaiveP1Target(targets, "f-c")?.id, "f-c");
    assert.equal(resolveWaiveP1Target(targets, "f-b")?.id, "f-b");
  });

  it("defaults the waiver target to the first candidate before anything is picked", () => {
    const targets = selectWaivableP1Findings([reviewFinding("f-a"), reviewFinding("f-b")]);

    assert.equal(resolveWaiveP1Target(targets, "")?.id, "f-a");
    assert.equal(resolveWaiveP1Target(targets, null)?.id, "f-a");
  });

  it("drops a stale pick instead of waiving a finding that stopped being a candidate", () => {
    const targets = selectWaivableP1Findings([
      reviewFinding("f-a"),
      reviewFinding("f-b", { status: "waived" }),
      reviewFinding("f-c", { waivable: false }),
    ]);

    // f-b was picked and then waived elsewhere; f-c was never waivable at all.
    assert.equal(resolveWaiveP1Target(targets, "f-b")?.id, "f-a");
    assert.equal(resolveWaiveP1Target(targets, "f-c")?.id, "f-a");
    assert.equal(resolveWaiveP1Target([], "f-a"), null);
  });

  it("names a lone P1 target too, instead of hiding the picker below two candidates", () => {
    const component = readFileSync(resolve(__dirname, "review-report-center.tsx"), "utf-8");

    assert.match(component, /const p1Targets = useMemo\(\(\) => selectWaivableP1Findings\(state\?\.findings\)/);
    assert.match(component, /resolveWaiveP1Target\(p1Targets, selectedP1FindingId\)/);
    assert.match(component, /\{p1Targets\.length > 0 && \(/);
    // Gating the picker on `> 1` waives a lone target without ever naming it on
    // screen. spec-battlefield shipped that trap and has since been pulled onto
    // `> 0` as well; neither surface may drift back.
    assert.doesNotMatch(component, /p1Targets\.length > 1/);
    assert.match(component, /id="waive-review-p1-target"/);
    assert.match(component, /p1Targets\.map/);
    assert.match(component, /value=\{p1Target \?\? ""\}/);
    assert.match(component, /onChange=\{\(event\) => setSelectedP1FindingId\(event\.target\.value\)\}/);
    // The picker is live exactly when the waive button is: same two conditions.
    assert.match(component, /disabled=\{actionBusy \|\| waiveReason !== null\}/);
    // Opening the dialog pins the target, so a refresh cannot slide the waiver
    // onto another finding while the reason is being typed.
    assert.match(
      component,
      /const waiveP1 = useCallback\(async \(\) => \{[\s\S]*?setSelectedP1FindingId\(p1Target\);[\s\S]*?setWaiveDialogOpen\(true\);/,
    );

    assert.equal(waiveP1TargetHint(1), "「接受 P1 风险」只对这一项生效。");
    assert.match(waiveP1TargetHint(3), /只对选中的这一项生效，其余 2 项仍然阻断/);
  });

  it("renders one option per waivable P1, so the target can actually be changed", () => {
    const html = renderReviewCenter([
      // A P0 sorts ahead of both P1s: the default target must be the first
      // *candidate*, never just the first finding in the report.
      reviewFinding("f-p0", { title: "必修", severity: "P0", waivable: false }),
      reviewFinding("f-a", { title: "空指针", file: "server/a.ts", line: 7 }),
      reviewFinding("f-b", { title: "并发写", file: "server/b.ts", line: 21 }),
      reviewFinding("f-done", { title: "已修", status: "fixed" }),
      reviewFinding("f-locked", { title: "不可豁免", waivable: false }),
    ]);

    const picker = html.slice(html.indexOf('id="waive-review-p1-target"'));
    assert.match(html, /id="waive-review-p1-target"/);
    assert.match(picker, /<option value="f-a" selected="">server\/a\.ts:7 · 空指针<\/option>/);
    assert.match(picker, /<option value="f-b">server\/b\.ts:21 · 并发写<\/option>/);
    assert.doesNotMatch(picker, /<option value="f-p0"/);
    assert.doesNotMatch(picker, /<option value="f-done"/);
    assert.doesNotMatch(picker, /<option value="f-locked"/);
    assert.match(html, /其余 1 项仍然阻断/);
  });

  it("renders the picker for a lone waivable P1 too, so it is named before it is waived", () => {
    const html = renderReviewCenter([
      reviewFinding("f-only", { title: "唯一的 P1", file: "server/only.ts", line: 3 }),
      reviewFinding("f-done", { title: "已修", status: "fixed" }),
    ]);

    assert.match(html, /id="waive-review-p1-target"/);
    assert.match(html, /<option value="f-only"[^>]*>server\/only\.ts:3 · 唯一的 P1<\/option>/);
    assert.match(html, /只对这一项生效/);
  });

  it("hides the picker entirely when nothing is waivable", () => {
    const html = renderReviewCenter([reviewFinding("f-done", { status: "fixed" })]);

    assert.doesNotMatch(html, /waive-review-p1-target/);
  });

  it("maps only open P0/P1 Review findings to StageFrame blockers", () => {
    assert.match(src, /const \[reviewStageActions, setReviewStageActions\] = useState<StageActionView\[\]>\(\[\]\);/);
    assert.match(src, /const \[reviewStageActionError, setReviewStageActionError\] = useState<string \| null>\(null\);/);
    assert.match(src, /const reviewStageBlockers = useMemo/);
    assert.match(src, /reviewCenterState\?\.findings \?\? \[\]/);
    assert.match(src, /finding\.status === "open" && \(finding\.severity === "P0" \|\| finding\.severity === "P1"\)/);
    assert.match(src, /severity: finding\.severity === "P0" \? "error" : "warning"/);
    assert.match(src, /label: `\$\{finding\.severity\}: \$\{finding\.title\}`/);
    assert.match(src, /\[reviewCenterState\?\.findings\]/);
    assert.doesNotMatch(src, /finding\.severity === "P2"[\s\S]*data-blocker/);
  });

  it("disables the Review retry command from review-center actions while Review is running", () => {
    const command = resolveReviewRunCommand({
      gate: "running",
      centerActions: reviewCenterActions({
        run_review: reviewCenterAction("run_review", false, "Review is already running."),
        retry_review: reviewCenterAction(
          "retry_review",
          false,
          "Retry is only available for failed or stale Review state.",
        ),
        canRunReview: false,
        canRetryReview: false,
      }),
      pipelineActions: [pipelineAction("retry_review", true)],
    });

    assert.equal(command.actionId, "retry_review");
    assert.equal(command.label, "重新审查");
    assert.equal(command.enabled, false);
    assert.equal(command.disabledReason, "Retry is only available for failed or stale Review state.");
  });

  it("keeps Review retry disabled while running before review-center actions load", () => {
    const command = resolveReviewRunCommand({
      gate: "running",
      pipelineActions: [pipelineAction("retry_review", true)],
    });

    assert.equal(command.actionId, "retry_review");
    assert.equal(command.label, "重新审查");
    assert.equal(command.enabled, false);
    assert.equal(command.disabledReason, "Review is still running.");
  });

  it("keeps Review retry enabled after failure when review-center and pipeline contracts allow it", () => {
    const command = resolveReviewRunCommand({
      gate: "failed",
      centerActions: reviewCenterActions({
        retry_review: reviewCenterAction("retry_review", true),
        canRetryReview: true,
      }),
      pipelineActions: [pipelineAction("retry_review", true)],
    });

    assert.equal(command.actionId, "retry_review");
    assert.equal(command.label, "重新审查");
    assert.equal(command.enabled, true);
    assert.equal(command.disabledReason, null);
  });

  it("keeps Review advanced details and advanced actions as sibling sections", () => {
    const component = readFileSync(resolve(__dirname, "review-report-center.tsx"), "utf-8");

    const reportSectionStart = component.indexOf("<h3 className=\"font-medium\">Review 结果</h3>");
    assert.notEqual(reportSectionStart, -1, "Review report section should exist");
    const detailsSummaryStart = component.indexOf("<summary className=\"cursor-pointer font-medium\">高级详情</summary>", reportSectionStart);
    assert.notEqual(detailsSummaryStart, -1, "Review advanced details section should exist");
    const detailsClose = component.indexOf("</details>", detailsSummaryStart);
    assert.notEqual(detailsClose, -1, "Review advanced details section should close");
    const actionSummaryStart = component.indexOf("<summary className=\"cursor-pointer font-medium\">高级动作</summary>", reportSectionStart);
    assert.notEqual(actionSummaryStart, -1, "Review advanced action section should exist");
    assert.ok(detailsClose < actionSummaryStart, "Review advanced actions must not be nested inside advanced details");

    const advancedDetails = component.slice(detailsSummaryStart, detailsClose);
    assert.match(advancedDetails, /mirrorWarnings/);
    assert.match(advancedDetails, /镜像需要处理/);
    assert.doesNotMatch(advancedDetails, /高级动作/);
    assert.doesNotMatch(advancedDetails, /rebuildAction/);
    assert.doesNotMatch(advancedDetails, /\/review-artifacts\/rebuild/);
    assert.doesNotMatch(advancedDetails, /重建镜像/);

    const advancedActions = component.slice(actionSummaryStart);
    assert.match(advancedActions, /rebuildAction/);
    assert.match(advancedActions, /\/review-artifacts\/rebuild/);
    assert.match(advancedActions, /重建镜像/);
  });

  it("refreshes both gate and battle state after report and human battle commands", () => {
    const reportStart = src.indexOf("const handleRegenerateSpecBattleReport");
    assert.notEqual(reportStart, -1, "handleRegenerateSpecBattleReport should exist");
    const reportEnd = src.indexOf("const handleSpecBattleDecision", reportStart);
    const reportSource = src.slice(reportStart, reportEnd);

    assert.match(reportSource, /\/spec-battle\/report/);
    assert.match(reportSource, /loadGateStatus\(\)/);
    assert.match(reportSource, /loadSpecBattleState\(\)/);

    const decisionStart = src.indexOf("const handleSpecBattleDecision");
    assert.notEqual(decisionStart, -1, "handleSpecBattleDecision should exist");
    const decisionEnd = src.indexOf("const handleSelectPhase", decisionStart);
    const decisionSource = src.slice(decisionStart, decisionEnd);

    assert.match(decisionSource, /\/spec-battle\/decision/);
    assert.match(decisionSource, /\/spec/);
    assert.match(decisionSource, /continueActions/);
    assert.match(decisionSource, /新一轮已创建，但启动失败，请点击启动本轮重试。/);
    assert.match(decisionSource, /load\(\)/);
    assert.match(decisionSource, /loadGateStatus\(\)/);
    assert.match(decisionSource, /loadSpecBattleState\(\)/);
  });

  it("keeps the Spec battlefield visible while a battle round is running", () => {
    assert.match(src, /buildRunningSpecBattleGateState/);
    assert.match(src, /activeSpecBattleFallback/);
    assert.match(src, /change\.status === "SPECCING"/);
    assert.match(src, /change\.status === "BLOCKED" && change\.blockedPhase === "spec"/);
    assert.match(src, /specBattleFallback=\{activeSpecBattleFallback\}/);
    assert.match(gatePanelSource, /buildRunningSpecBattleGateState/);
    assert.match(gatePanelSource, /buildActiveSpecBattleGateState/);
    assert.match(gatePanelSource, /battleState\?\.latestRound/);
    assert.match(gatePanelSource, /\["not_started", "red_running", "blue_running", "failed"\]\.includes\(latestRound\.status\)/);
    assert.match(gatePanelSource, /gateStatus\?\.specBattle \?\? specBattleFallback/);
    const component = readFileSync(resolve(__dirname, "spec-battlefield.tsx"), "utf-8");
    assert.match(component, /Battle 失败/);
    assert.match(component, /等待启动/);
    assert.match(component, /本轮已创建，等待启动我方修订。/);
    assert.match(component, /启动本轮/);
  });

  it("does not present running Spec Battle rounds as stale reports", () => {
    const component = readFileSync(resolve(__dirname, "spec-battlefield.tsx"), "utf-8");

    assert.match(component, /const runningRoundStatuses = \["red_running", "blue_running"\]/);
    assert.match(component, /const specBattleRunningStatus = runningRoundStatuses\.includes\(specBattle\.roundStatus \?\? ""\) \? specBattle\.roundStatus : null/);
    assert.match(component, /const latestRoundRunningStatus = runningRoundStatuses\.includes\(latestRound\?\.status \?\? ""\) \? latestRound\?\.status \?\? null : null/);
    assert.match(component, /const runningRoundStatus = specBattleRunningStatus \?\? latestRoundRunningStatus/);
    assert.match(component, /const roundRunning = Boolean\(runningRoundStatus\)/);
    assert.match(component, /const currentRoundStatus = runningRoundStatus \?\? specBattle\.roundStatus \?\? latestRound\?\.status \?\? ""/);
    assert.match(component, /const roundWaitingToStart = currentRoundStatus === "not_started"/);
    assert.match(component, /const reportStale = !roundRunning && !roundWaitingToStart && !specBattle\.reportFresh/);
    assert.match(component, /roundRunning\s*\?\s*"当前回合仍在运行，战报会在我方修订和反方审查完成后自动结算；完成后也可以手动刷新。"/);
    assert.match(component, /roundRunning\s*\?\s*"等待战报"/);
    assert.match(component, /roundRunning\s*\?\s*"回合完成后再判断是否可以进入 TechSpec"/);
    assert.match(component, /roundRunning\s*\?\s*"回合运行中不可刷新；请等待本轮战报生成"/);
    assert.match(component, /label="刷新战报"[\s\S]*disabled=\{disabled \|\| roundRunning\}/);
    assert.match(component, /disabled=\{disabled \|\| roundRunning \|\| !canAcceptRisk\}/);
    assert.match(component, /const canContinue = Boolean\(continueAction\) && !roundRunning/);
    assert.match(component, /roundRunning\s*\?\s*"等待本轮完成后再继续对抗"/);
    assert.match(component, /disabled=\{disabled \|\| roundRunning \|\| \(!roundWaitingToStart && !roundFailed && !canContinue\)\}/);
    assert.match(component, /if \(roundRunning\) return;/);
    assert.match(changeCommandsSource, /const runAction = findPipelineAction\(gateStatus\?\.actions, "run_spec"\)/);
    assert.match(changeCommandsSource, /const retryAction = findPipelineAction\(gateStatus\?\.actions, "retry_spec"\)/);
    assert.match(changeCommandsSource, /const action = retryAction\?\.enabled \? retryAction : runAction/);
    assert.match(component, /roundRunning[\s\S]*\? \{[\s\S]*\.\.\.specBattle,[\s\S]*roundStatus: currentRoundStatus,[\s\S]*\}[\s\S]*: specBattle/);
    assert.match(component, /reportStale\s*\?\s*"战报已过期，请先刷新战报，再判断是否可以进入 TechSpec。"/);
    assert.match(component, /reportStale\s*\?\s*"先刷新战报"/);
  });

  it("exposes a visible delete action on the change detail header", () => {
    assert.match(src, /import \{ useParams, useRouter \} from "next\/navigation";/);
    assert.match(src, /const router = useRouter\(\);/);
    assert.match(src, /const \[deleteBusy, setDeleteBusy\] = useState\(false\);/);
    assert.match(src, /async function handleDeleteChange\(\)/);
    assert.match(src, /method: "DELETE"/);
    assert.match(src, /router\.push\(`\/projects\/\$\{projectId\}`\)/);
    assert.match(pipelinePageShellSource, /删除 Change/);
    assert.match(pipelinePageShellSource, /aria-label=\{`删除 \$\{change\.id\}`\}/);
  });

  it("separates the Change ID and title in the detail header", () => {
    const headerStart = pipelinePageShellSource.indexOf("function PipelinePageHeader");
    assert.notEqual(headerStart, -1, "Change detail header should exist");
    const headerSource = pipelinePageShellSource.slice(headerStart, pipelinePageShellSource.indexOf("{deleteError &&", headerStart));

    assert.match(headerSource, /flex flex-col items-start gap-3 sm:flex-row sm:justify-between/);
    assert.match(headerSource, /<h1 className="[^"]*leading-snug sm:text-2xl/);
    assert.match(headerSource, /<h1 className="[^"]*min-w-0/);
    assert.match(headerSource, /<h1 className="[^"]*flex-1/);
    assert.match(headerSource, /<span className="[^"]*font-mono[^"]*text-muted-foreground/);
    assert.match(headerSource, /<span className="[^"]*block shrink-0[^"]*font-mono/);
    assert.match(headerSource, /\{change\.id\}/);
    assert.match(headerSource, /<span className="[^"]*min-w-0[^"]*break-words/);
    assert.match(headerSource, /<span className="[^"]*block[^"]*break-words/);
    assert.match(headerSource, /\{change\.title\}/);
    assert.doesNotMatch(headerSource, /mr-2/);
  });

  it("stops Spec Battle through the block endpoint instead of gate rejection", () => {
    const stopStart = src.indexOf("const handleStopSpecBattle");
    assert.notEqual(stopStart, -1, "handleStopSpecBattle should exist");
    const stopEnd = src.indexOf("const handleRegenerateSpecBattleReport", stopStart);
    const stopSource = src.slice(stopStart, stopEnd);

    assert.match(stopSource, /\/block/);
    assert.match(stopSource, /phase: "spec"/);
    assert.match(stopSource, /Spec Battle terminated by human/);
    assert.match(src, /onStopBattle=\{handleStopSpecBattle\}/);
    assert.doesNotMatch(src, /onStopBattle=\{handleRejectGate\}/);
  });

  it("accepts P1 risk through waive, report refresh, and fresh approve", () => {
    const acceptStart = src.indexOf("const handleAcceptSpecBattleRisk");
    assert.notEqual(acceptStart, -1, "handleAcceptSpecBattleRisk should exist");
    const acceptEnd = src.indexOf("const handleSelectPhase", acceptStart);
    const acceptSource = src.slice(acceptStart, acceptEnd);

    assert.match(acceptSource, /action: "waive_p1"/);
    assert.match(acceptSource, /\/spec-battle\/report/);
    assert.match(acceptSource, /\/gate\/approve/);
    assert.match(acceptSource, /expectedGateVersion: approveAction\?\.gateVersion/);
    assert.match(acceptSource, /expectedSourceDbHash: approveAction\?\.sourceDbHash/);
    assert.match(acceptSource, /idempotencyKey:/);
    assert.doesNotMatch(acceptSource, /action: "approve"/);
    assert.match(specBattleTypes, /export type BattleDecisionAction = "request_changes" \| "return_to_spec" \| "waive_p1"/);
    assert.doesNotMatch(specBattleTypes, /BattleDecisionAction = "approve"/);
    assert.match(src, /onAcceptRisk=\{handleAcceptSpecBattleRisk\}/);
  });

  it("starts TechSpec after Spec Battle approval succeeds", () => {
    const acceptStart = src.indexOf("const handleAcceptSpecBattleRisk");
    assert.notEqual(acceptStart, -1, "handleAcceptSpecBattleRisk should exist");
    const acceptEnd = src.indexOf("const handleRegeneratePlanSandboxReport", acceptStart);
    const acceptSource = src.slice(acceptStart, acceptEnd);

    assert.match(acceptSource, /startTechSpecAfterSpecApproval/);
    assert.match(acceptSource, /\/tech-spec/);
    assert.doesNotMatch(src, /const ACTION_ENDPOINTS/);
    assert.doesNotMatch(pipelineActionsSource, /const ACTION_ENDPOINTS/);
    assert.match(pipelineActionCommandsSource, /run_tech_spec: "tech-spec"/);
    assert.match(pipelineActionCommandsSource, /retry_tech_spec: "tech-spec"/);
    assert.doesNotMatch(pipelineActionCommandsSource, /approve_tech_spec: "tech-spec"/);
    assert.match(src, /visibleContractActions/);
    assert.doesNotMatch(src, /change\.status === "SPEC_READY" && change\.gateState !== "spec"/);
    assert.match(pipelineActionRunnerSource, /resolvePipelineActionCommand\(actionId\)/);
    assert.match(pipelineActionRunnerSource, /findPipelineAction\(actions, actionId\)/);
    assert.match(pipelineActionRunnerSource, /createPipelinePreflightPayload\(contractAction\)/);
    assert.match(pipelineActionsSource, /runPipelineAction\(\{/);
    assert.match(src, /usePipelineActions\(\{/);
    assert.match(src, /actions: gateStatus\?\.actions/);
    assert.match(src, /refresh: refreshAfterAction/);
    assert.doesNotMatch(acceptSource, /console\.error/);
  });

  it("starts TechSpec directly when run_tech_spec is already enabled", () => {
    const acceptStart = src.indexOf("const handleAcceptSpecBattleRisk");
    assert.notEqual(acceptStart, -1, "handleAcceptSpecBattleRisk should exist");
    const acceptEnd = src.indexOf("const handleRegeneratePlanSandboxReport", acceptStart);
    const acceptSource = src.slice(acceptStart, acceptEnd);

    assert.match(acceptSource, /const runTechSpecAction = findPipelineAction\(gateStatus\?\.actions, "run_tech_spec"\)/);
    assert.match(acceptSource, /const canRunTechSpec = runTechSpecAction\?\.enabled === true/);

    const approveIndex = acceptSource.indexOf("if (canApprove)");
    const runIndex = acceptSource.indexOf("else if (canRunTechSpec)");
    const waiveIndex = acceptSource.indexOf("else if (canWaiveP1 && targetId)");
    assert.ok(approveIndex !== -1 && runIndex !== -1 && waiveIndex !== -1, "direct run branch should be present");
    assert.ok(approveIndex < runIndex && runIndex < waiveIndex, "approve should remain the happy path before direct run");

    const directRunBranch = acceptSource.slice(runIndex, waiveIndex);
    assert.match(directRunBranch, /await startTechSpecAfterSpecApproval\(\)/);
    assert.match(directRunBranch, /techSpecStarted = true/);
    assert.doesNotMatch(directRunBranch, /postGateApprove/);
    assert.doesNotMatch(directRunBranch, /postDecision/);
    assert.doesNotMatch(directRunBranch, /window\.prompt/);
    assert.match(acceptSource, /if \(!techSpecStarted\) \{[\s\S]*await startTechSpecAfterSpecApproval\(\)/);
  });

  it("surfaces an enabled retry_tech_spec on the TechSpec stage panel when the run died away from the gate", () => {
    const clicked: string[] = [];
    const actions = buildGateStageActions({
      phase: "TechSpec",
      gateStatus: strandedTechSpecGateStatus([
        gatePipelineAction("retry_tech_spec", true, "重新生成 TechSpec"),
      ]),
      approveLabel: "批准 Tech Spec",
      rejectLabel: "退回 Tech Spec",
      gateBusy: false,
      runBusy: false,
      onApprove: () => clicked.push("approve"),
      onReject: () => clicked.push("reject"),
      onRunAction: (actionId) => clicked.push(actionId),
    });

    const retry = actions.find((action) => action.sourceActionId === "retry_tech_spec");
    assert.ok(retry, "retry_tech_spec should render on the TechSpec stage panel");
    assert.equal(retry.enabled, true);
    assert.equal(retry.disabledReason, null);
    assert.equal(retry.label, "重新生成 TechSpec");

    // Reachable: it is the only thing the human can press, since the gate pair is
    // correctly closed while the change is not at the gate.
    assert.deepEqual(
      actions.filter((action) => action.enabled).map((action) => action.sourceActionId),
      ["retry_tech_spec"],
    );

    // Wired: pressing it asks the page to run that exact action id, and that id
    // resolves to a real endpoint rather than dropping on the floor.
    retry.onAction();
    assert.deepEqual(clicked, ["retry_tech_spec"]);
    assert.equal(resolvePipelineActionCommand("retry_tech_spec")?.endpoint, "tech-spec");
  });

  it("never offers a stage run action that no endpoint is wired to", () => {
    // rebuild_mirror is a real contract action with no ACTION_ENDPOINTS entry:
    // routing it through handleAction would POST nowhere, so a button for it would
    // look enabled and silently do nothing.
    assert.equal(resolvePipelineActionCommand("rebuild_mirror"), null);

    const selected = selectRoutableStageRunActions(
      [
        gatePipelineAction("retry_tech_spec", true),
        gatePipelineAction("rebuild_mirror", true),
      ],
      ["retry_tech_spec", "rebuild_mirror"],
    );

    assert.deepEqual(selected.map((action) => action.actionId), ["retry_tech_spec"]);
  });

  it("drops stage run actions the contract never returned instead of rendering dead buttons", () => {
    const actions = buildGateStageActions({
      phase: "TechSpec",
      gateStatus: strandedTechSpecGateStatus([gatePipelineAction("retry_tech_spec", true)]),
      approveLabel: "批准 Tech Spec",
      rejectLabel: "退回 Tech Spec",
      gateBusy: false,
      runBusy: false,
      onApprove: () => {},
      onReject: () => {},
      onRunAction: () => {},
    });

    // run_tech_spec is a TechSpec stage action but absent from this contract.
    assert.equal(actions.some((action) => action.sourceActionId === "run_tech_spec"), false);
  });

  it("keeps the gate approve button primary and leaves the Spec battlefield panel untouched", () => {
    const atGate = buildGateStageActions({
      phase: "TechSpec",
      gateStatus: {
        atGate: true,
        gate: "tech_spec",
        status: "TECHSPEC_READY",
        pendingArtifact: "docs/tech-spec.md",
        actions: [
          gatePipelineAction("approve_tech_spec", true, "批准 TechSpec"),
          gatePipelineAction("reject_tech_spec", true, "打回 TechSpec"),
          gatePipelineAction("retry_tech_spec", true, "重新生成 TechSpec"),
        ],
      },
      approveLabel: "批准 Tech Spec",
      rejectLabel: "退回 Tech Spec",
      gateBusy: false,
      runBusy: false,
      onApprove: () => {},
      onReject: () => {},
      onRunAction: () => {},
    });

    // Approve is emitted first so getOrderedStageActions gives it the primary slot.
    assert.equal(atGate[0].sourceActionId, "approve_tech_spec");
    assert.equal(atGate[0].role, "primary");
    assert.equal(atGate.find((action) => action.sourceActionId === "retry_tech_spec")?.role, "secondary");

    // Spec keeps exactly the two gate buttons: its battlefield owns restart/accept-risk.
    const spec = buildGateStageActions({
      phase: "Spec",
      gateStatus: {
        atGate: true,
        gate: "spec",
        status: "SPEC_READY",
        pendingArtifact: "docs/spec.md",
        actions: [
          gatePipelineAction("approve_spec", true, "批准 Spec"),
          gatePipelineAction("reject_spec", true, "打回 Spec"),
          gatePipelineAction("run_spec", true, "开始 Spec 对抗"),
          gatePipelineAction("retry_spec", true, "重新 Spec 对抗"),
        ],
      },
      approveLabel: "批准 Spec",
      rejectLabel: "退回 Spec",
      gateBusy: false,
      runBusy: false,
      onApprove: () => {},
      onReject: () => {},
      onRunAction: () => {},
    });

    assert.deepEqual(spec.map((action) => action.sourceActionId), ["approve_spec", "reject_spec"]);
  });

  it("surfaces an error instead of silently dropping an unroutable pipeline action", () => {
    const handlerStart = pipelineActionRunnerSource.indexOf("const command = resolvePipelineActionCommand(actionId)");
    assert.notEqual(handlerStart, -1, "the runner should resolve a command");
    const handlerSource = pipelineActionRunnerSource.slice(handlerStart, handlerStart + 400);

    assert.match(handlerSource, /if \(!command\) \{/);
    assert.match(handlerSource, /outcome: "blocked"/);
    assert.doesNotMatch(handlerSource, /if \(!command\) return false;/);
    // ...and the hook has to render whatever the runner reports, or the
    // unroutable action is silently swallowed one layer up instead.
    assert.match(pipelineActionsSource, /setActionError\(effect\.actionError\)/);
  });

  it("routes Tech Spec Gate approval into Plan generation, not TestPlan", () => {
    assert.match(changeCommandsSource, /tech_spec:\s*"plan"/);
    assert.match(changeCommandsSource, /tech_spec:\s*"run_plan"/);
    assert.match(changeCommandsSource, /spec:\s*"run_tech_spec"/);
    assert.doesNotMatch(changeCommandsSource, /tech_spec:\s*"test-plan"/);
    assert.match(pipelineActionCommandsSource, /run_test_plan: "test-plan"/);
  });

  it("imports and renders the PRD Briefing Room component", () => {
    const component = readFileSync(resolve(__dirname, "prd-briefing-room.tsx"), "utf-8");
    const types = readFileSync(resolve(__dirname, "prd-briefing-types.ts"), "utf-8");

    assert.match(src, /import \{ PrdBriefingRoom \} from "\.\/prd-briefing-room";/);
    assert.match(changeDetailDataHookSource, /import type \{ PrdBriefingState \} from "\.\/prd-briefing-types";/);
    assert.match(component, /export function PrdBriefingRoom/);
    assert.match(types, /export interface PrdBriefingState/);
  });

  it("shows PRD Briefing Room first when the selected phase is Intake", () => {
    assert.match(src, /const showingPrdBriefingRoom = activeSelectedPhase === "Intake"/);
    assert.match(src, /showingPrdBriefingRoom \? \(/);
    assert.match(src, /<PrdBriefingRoom/);
    assert.match(src, /initialState=\{prdBriefingState\}/);
    assert.match(src, /onLocked=\{handlePrdBriefingLocked\}/);
  });

  it("wraps PRD in the shared StageFrame shell driven by selected-stage state", () => {
    const prdBranchStart = src.indexOf(") : showingPrdBriefingRoom ? (");
    assert.notEqual(prdBranchStart, -1, "PRD branch should exist");
    const prdBranchEnd = src.indexOf(") : showingSpecOrTechSpecGate ? (", prdBranchStart);
    assert.notEqual(prdBranchEnd, -1, "PRD branch should end before the next stage branch");
    const prdBranch = src.slice(prdBranchStart, prdBranchEnd);

    assert.match(src, /const selectedStageState = selectedStage\.state;/);
    assert.match(phaseStageShellSource, /import \{ StageFrame/);
    assert.match(phaseStageShellSource, /<StageFrame/);
    assert.match(phaseStageShellSource, /Intake: \{[\s\S]*label: "PRD"[\s\S]*title: "PRD Briefing"/);
    assert.match(phaseStageShellSource, /export function phaseDisplayName/);

    assert.match(prdBranch, /<PhaseStageShell/);
    assert.match(prdBranch, /phase="Intake"/);
    assert.match(prdBranch, /state=\{selectedStageState\}/);
    assert.match(prdBranch, /statusLabel=\{stageStatusLabel\}/);
    assert.match(prdBranch, /latestRunStatus=\{latestRunStatusLabel\}/);
    assert.match(prdBranch, /actions=\{prdBriefingStageActions\}/);
    assert.match(prdBranch, /records=\{renderPhaseRecords\("Intake", "prd-records"\)\}/);
    assert.match(prdBranch, /<PrdBriefingRoom[\s\S]*initialState=\{prdBriefingState\}[\s\S]*onLocked=\{handlePrdBriefingLocked\}[\s\S]*onStageActionsChange=\{setPrdStageActions\}/);
    assert.ok(
      prdBranch.indexOf("<PhaseStageShell") < prdBranch.indexOf("<PrdBriefingRoom"),
      "PrdBriefingRoom should be nested as workspace content",
    );
    assert.ok(
      prdBranch.indexOf("<PrdBriefingRoom") < prdBranch.indexOf("</PhaseStageShell>"),
      "PrdBriefingRoom should close inside PhaseStageShell",
    );
    assert.doesNotMatch(prdBranch, /<main[\s>]/);
    assert.doesNotMatch(prdBranch, /<PipelinePageShell/);
    assert.doesNotMatch(prdBranch, /phase="PRD"/);
    assert.doesNotMatch(phaseStageShellSource, /Intake: \{[\s\S]*label: "Intake"/);
    assert.match(src, /const \[prdStageActions, setPrdStageActions\] = useState<StageActionView\[\]>\(\[\]\);/);
    assert.match(prdBriefingRoomSource, /onStageActionsChange\?: \(actions: StageActionView\[\]\) => void/);
    assert.match(prdBriefingRoomSource, /label: isLocked \? "PRD 已锁定" : "锁定 PRD"/);
    assert.match(prdBriefingRoomSource, /onStageActionsChange\?\.\(stageActions\)/);
    assert.match(prdBriefingRoomSource, /onStageActionsChange\?\.\(\[\]\)/);
    assert.doesNotMatch(prdBriefingRoomSource, /锁定 PRD，进入 Intake Gate/);
    assert.doesNotMatch(prdBriefingRoomSource, /Intake Gate/);
  });

  it("keeps the PRD workspace usable when stage evidence is present", () => {
    const component = readFileSync(resolve(__dirname, "prd-briefing-room.tsx"), "utf-8");

    assert.match(component, /data-prd-briefing-workspace/);
    assert.match(component, /data-prd-intent-panel/);
    assert.match(component, /data-prd-draft-panel/);
    assert.match(component, /<article className="max-h-\[34rem\]/);
    assert.doesNotMatch(component, /<h2 className="text-lg font-semibold">PRD Briefing Room<\/h2>/);
    assert.doesNotMatch(component, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(20rem,0\.9fr\)\]/);
    assert.doesNotMatch(component, /<pre className=/);
    assert.doesNotMatch(stageFrameSource, /xl:grid-cols-\[minmax\(0,1fr\)_minmax\(18rem,24rem\)\]/);
  });

  it("wires the PRD briefing API actions into the component", () => {
    const component = readFileSync(resolve(__dirname, "prd-briefing-room.tsx"), "utf-8");

    assert.match(component, /\/prd-briefing/);
    assert.match(component, /body: JSON\.stringify\(\{ rawText/);
    assert.match(component, /kind: "questions" \| "draft" \| "final-review"/);
    assert.match(component, /\/prd-briefing\/\$\{kind\}`/);
    assert.match(component, /startAiJob\("questions"\)/);
    assert.match(component, /\/prd-briefing\/questions\/\$\{questionId\}`/);
    assert.match(component, /body: JSON\.stringify\(\{ action, value \}\)/);
    assert.match(component, /startAiJob\("draft"\)/);
    assert.match(component, /startAiJob\("final-review"\)/);
    assert.match(component, /\/prd-briefing\/lock`/);
  });

  it("polls PRD briefing state after async AI jobs and refreshes page state after lock", () => {
    const component = readFileSync(resolve(__dirname, "prd-briefing-room.tsx"), "utf-8");

    assert.match(changeDetailDataHookSource, /const loadPrdBriefingState = useCallback/);
    assert.match(src, /handlePrdBriefingLocked/);
    assert.match(src, /load\(\)/);
    assert.match(src, /loadGateStatus\(\)/);
    assert.match(src, /loadSpecBattleState\(\)/);
    assert.match(component, /setInterval/);
    assert.match(component, /startPolling/);
    assert.match(component, /pollingAction/);
    assert.match(component, /actionLocked/);
    assert.match(component, /jobComplete/);
  });

  it("keeps parent page polling conditional on active background work", () => {
    assert.equal(shouldPollChangeDetailParent({
      change: null,
      running: true,
      gateBusy: false,
      specBattleState: null,
      reviewCenterState: null,
    }), true);
    assert.equal(shouldPollChangeDetailParent({
      change: null,
      running: false,
      gateBusy: true,
      specBattleState: null,
      reviewCenterState: null,
    }), true);
    assert.equal(shouldPollChangeDetailParent({
      change: { status: "PLAN_APPROVED", latestRun: { id: "run-1", phase: "implement", status: "running" } } as ChangeDetail,
      running: false,
      gateBusy: false,
      specBattleState: null,
      reviewCenterState: null,
    }), true);
    for (const status of ["PLANNING", "REVIEWING", "FIXING", "CHECKING", "SPECCING", "TECHSPECCING", "TESTPLANNING", "MERGING"]) {
      assert.equal(PARENT_POLLING_CHANGE_STATUSES.has(status), true, `${status} should poll parent detail`);
      assert.equal(shouldPollChangeDetailParent({
        change: { status } as ChangeDetail,
        running: false,
        gateBusy: false,
        specBattleState: null,
        reviewCenterState: null,
      }), true, `${status} should poll parent detail`);
    }
    assert.equal(PARENT_POLLING_CHANGE_STATUSES.has("IMPLEMENTING"), false);
    assert.equal(PARENT_POLLING_CHANGE_STATUSES.has("RETRO_PENDING"), false);
    assert.equal(shouldPollChangeDetailParent({
      change: { status: "PLAN_APPROVED" } as ChangeDetail,
      running: false,
      gateBusy: false,
      specBattleState: { latestRound: { status: "red_running" } } as never,
      reviewCenterState: null,
    }), true);
    assert.equal(shouldPollChangeDetailParent({
      change: { status: "SPECCING" } as ChangeDetail,
      running: false,
      gateBusy: false,
      specBattleState: { latestRound: { status: "not_started" } } as never,
      reviewCenterState: null,
    }), false);
    assert.equal(shouldPollChangeDetailParent({
      change: { status: "PLAN_APPROVED" } as ChangeDetail,
      running: false,
      gateBusy: false,
      specBattleState: null,
      reviewCenterState: { headlineStatus: "running" } as ReviewCenterResponse,
    }), true);
    assert.equal(shouldPollChangeDetailParent({
      change: { status: "PLAN_APPROVED" } as ChangeDetail,
      running: false,
      gateBusy: false,
      specBattleState: null,
      reviewCenterState: null,
    }), false);
    assert.match(src, /shouldPollChangeDetailParent\(\{/);
    assert.doesNotMatch(src, /STATUS_TO_PHASE\[change\.status\]\?\.state === "running"/);

    const initialRefreshStart = changeDetailDataHookSource.indexOf("await refreshChangeDetailPage();");
    assert.notEqual(initialRefreshStart, -1, "initial full refresh should remain");
    const initialRefreshEffect = changeDetailDataHookSource.slice(
      changeDetailDataHookSource.lastIndexOf("useEffect", initialRefreshStart),
      changeDetailDataHookSource.indexOf("}, [refreshChangeDetailPage]);", initialRefreshStart)
    );
    assert.doesNotMatch(initialRefreshEffect, /setInterval/);

    const pollingGuardStart = src.indexOf("if (!shouldPollParent) return;");
    assert.notEqual(pollingGuardStart, -1, "parent polling should be gated");
    const pollingEffectEnd = "}, [shouldPollParent, refreshChangeDetailPage]);";
    const pollingEffect = src.slice(
      src.lastIndexOf("useEffect", pollingGuardStart),
      src.indexOf(pollingEffectEnd, pollingGuardStart) + pollingEffectEnd.length
    );
    assert.match(pollingEffect, /setInterval\(\(\) =>/);
    assert.match(pollingEffect, /void refreshChangeDetailPage\(\)/);
    assert.match(pollingEffect, /\[shouldPollParent, refreshChangeDetailPage\]/);
  });

  it("does not render RETRO_PENDING as Pipeline running without an active run", () => {
    assert.deepEqual(STATUS_TO_PHASE.RETRO_PENDING, { phase: "Retro", state: "waiting" });
    assert.notEqual(STATUS_TO_PHASE.RETRO_PENDING.state, "running");
    assert.equal(shouldPollChangeDetailParent({
      change: { status: "RETRO_PENDING" } as ChangeDetail,
      running: false,
      gateBusy: false,
      specBattleState: null,
      reviewCenterState: null,
    }), false);
    assert.equal(shouldPollChangeDetailParent({
      change: { status: "RETRO_PENDING", latestRun: { id: "run-1", phase: "retro", status: "running" } } as ChangeDetail,
      running: false,
      gateBusy: false,
      specBattleState: null,
      reviewCenterState: null,
    }), true);

    const runningBlockStart = src.indexOf("const isRunning = hasActiveRun || [");
    assert.notEqual(runningBlockStart, -1, "Pipeline running summary should be explicit");
    const runningBlockSource = src.slice(
      runningBlockStart,
      src.indexOf("].includes(change.status)", runningBlockStart)
    );
    assert.match(src, /const hasActiveRun = change\.latestRun\?\.status === "running"/);
    assert.doesNotMatch(runningBlockSource, /"RETRO_PENDING"/);

    const railStart = phaseRailSource.indexOf("function VerticalPhaseRail");
    assert.notEqual(railStart, -1, "vertical pipeline rail should exist");
    const railSource = phaseRailSource.slice(railStart);
    assert.match(railSource, /isRunning: boolean/);
    assert.match(railSource, /\{isRunning && \(/);
    assert.match(railSource, /Running/);
  });

  it("keeps PRD Briefing loading from accepting or overwriting dirty intent text", () => {
    const component = readFileSync(resolve(__dirname, "prd-briefing-room.tsx"), "utf-8");

    assert.match(component, /rawTextDirtyRef/);
    assert.match(component, /handleRawTextChange/);
    assert.match(component, /!rawTextDirtyRef\.current/);
    assert.match(component, /disabled=\{loading \|\| isLocked \|\| actionLocked\}/);
    assert.match(component, /const actionLocked = loading \|\| busyAction !== null \|\| pollingAction !== null \|\| runInProgress/);
  });
});
