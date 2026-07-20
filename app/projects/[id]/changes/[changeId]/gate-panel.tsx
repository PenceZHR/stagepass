"use client";

import {
  findPipelineAction,
  pipelineActionDisabledReason,
  type PipelineActionContract,
} from "./pipeline-action-contract";
import { isPostRoutedAction } from "./pipeline-action-commands";
import { SpecBattlefield } from "./spec-battlefield";
import { ProducedFile } from "./produced-file";
import type { GateName, GateStatus } from "./gate-types";
import type { ReviewPhase } from "./change-phase-map";
import type { StageActionView } from "./stage-action-bar";
import type { BattleDecisionAction, SpecBattleGateState, SpecBattleState } from "./spec-battle-types";

function formatGateName(gate: GateName | null): string {
  if (gate === "intake") return "Intake";
  if (gate === "spec") return "Spec";
  if (gate === "tech_spec") return "Tech Spec";
  if (gate === "merge") return "Merge";
  return "Gate";
}

function gateApprovalActionId(gate: GateName | null): string | null {
  if (gate === "intake") return "approve_intake";
  if (gate === "spec") return "approve_spec";
  if (gate === "tech_spec") return "approve_tech_spec";
  if (gate === "merge") return "approve_merge";
  return null;
}

export function gateApprovalAction(gateStatus: GateStatus | null): PipelineActionContract | null {
  const actionId = gateApprovalActionId(gateStatus?.gate ?? null);
  return gateStatus?.actions?.find((action) => action.actionId === actionId) ?? null;
}

function gateRejectActionId(gate: GateName | null): string | null {
  if (gate === "intake") return "reject_intake";
  if (gate === "spec") return "reject_spec";
  if (gate === "tech_spec") return "reject_tech_spec";
  if (gate === "merge") return "reject_merge";
  return null;
}

export function gateRejectAction(gateStatus: GateStatus | null): PipelineActionContract | null {
  const actionId = gateRejectActionId(gateStatus?.gate ?? null);
  return gateStatus?.actions?.find((action) => action.actionId === actionId) ?? null;
}

/**
 * Run/retry actions surfaced on a gate stage panel alongside approve/reject.
 *
 * GatePanel renders nothing at all when the change is not sitting at the gate, so
 * a TechSpec stage whose run died mid-flight (machine sleep -> stale_lease_fenced)
 * used to offer no reachable control: the action contract enables retry_tech_spec,
 * but the only buttons on the panel were the gate approve/reject pair, correctly
 * disabled with "Action contract unavailable."
 *
 * Spec is intentionally absent. Its panel renders the Spec battlefield, which owns
 * its own restart/accept-risk commands, and the PRD stage already offers run_spec;
 * re-surfacing them here would duplicate working controls.
 */
const GATE_STAGE_RUN_ACTION_IDS: Partial<Record<ReviewPhase, string[]>> = {
  TechSpec: ["run_tech_spec", "retry_tech_spec"],
};

function gateStageRunActionRole(actionId: string): StageActionView["role"] {
  return actionId.startsWith("retry_") ? "secondary" : "primary";
}

/**
 * Narrows `actionIds` to the contract actions a stage panel can safely offer.
 *
 * Two ways a stage button becomes a lie, both filtered here:
 *   - the contract never returned the action, so it could only ever render as a
 *     permanently disabled "Action contract unavailable" button;
 *   - the action has no ACTION_ENDPOINTS entry, so `handleAction` has nowhere to
 *     POST it and the click does nothing.
 */
export function selectRoutableStageRunActions(
  actions: PipelineActionContract[] | undefined,
  actionIds: readonly string[],
): PipelineActionContract[] {
  return actionIds
    .map((actionId) => findPipelineAction(actions, actionId))
    .filter((action): action is PipelineActionContract => action !== null)
    .filter((action) => isPostRoutedAction(action.actionId));
}

/**
 * Builds the action bar for the Spec/TechSpec gate stage: the gate approve/reject
 * pair first (so approve keeps the primary slot when the change is at the gate),
 * then whichever generation actions the contract actually offers.
 */
export function buildGateStageActions(input: {
  phase: ReviewPhase;
  gateStatus: GateStatus | null;
  approveLabel: string;
  rejectLabel: string;
  gateBusy: boolean;
  runBusy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRunAction: (actionId: string) => void;
}): StageActionView[] {
  const approveAction = gateApprovalAction(input.gateStatus);
  const rejectAction = gateRejectAction(input.gateStatus);
  const approveDisabledReason = pipelineActionDisabledReason(approveAction);
  const rejectDisabledReason = pipelineActionDisabledReason(rejectAction);

  const runActions = selectRoutableStageRunActions(
    input.gateStatus?.actions,
    GATE_STAGE_RUN_ACTION_IDS[input.phase] ?? [],
  ).map((action) => {
    const disabledReason = pipelineActionDisabledReason(action);

    return {
      id: `gate-${action.actionId}`,
      label: action.label,
      role: gateStageRunActionRole(action.actionId),
      enabled: disabledReason === null,
      busy: input.runBusy,
      disabledReason,
      sourceActionId: action.actionId,
      onAction: () => input.onRunAction(action.actionId),
    } satisfies StageActionView;
  });

  return [
    {
      id: `gate-${approveAction?.actionId ?? "approve"}`,
      label: input.approveLabel,
      role: "primary",
      enabled: approveDisabledReason === null,
      busy: input.gateBusy,
      disabledReason: approveDisabledReason,
      sourceActionId: approveAction?.actionId,
      onAction: input.onApprove,
    },
    {
      id: `gate-${rejectAction?.actionId ?? "reject"}`,
      label: input.rejectLabel,
      role: "destructive",
      enabled: rejectDisabledReason === null,
      busy: input.gateBusy,
      disabledReason: rejectDisabledReason,
      sourceActionId: rejectAction?.actionId,
      onAction: input.onReject,
    },
    ...runActions,
  ];
}

function formatArtifactName(filePath: string | null): string {
  if (!filePath) return "No pending artifact";
  return filePath.split("/").pop() || filePath;
}

function formatArtifactHint(filePath: string | null): string {
  if (!filePath) return "当前 Gate 由就绪检查决定，没有单独待确认文件。";
  return `待确认产物：${formatArtifactName(filePath)}`;
}

function unavailableSpecBattleAction(reason: string) {
  return { available: false, reason };
}

export function buildActiveSpecBattleGateState(battleState: SpecBattleState | null): SpecBattleGateState | null {
  const latestRound = battleState?.latestRound;
  if (!latestRound || !["not_started", "red_running", "blue_running", "failed"].includes(latestRound.status)) return null;

  const runningAction = unavailableSpecBattleAction("round_running");
  const waitingAction = unavailableSpecBattleAction("round_not_started");
  const failedAction = unavailableSpecBattleAction("round_failed");
  const action = latestRound.status === "failed"
    ? failedAction
    : latestRound.status === "not_started"
      ? waitingAction
      : runningAction;
  return {
    roundId: latestRound.id,
    roundStatus: latestRound.status,
    reportFresh: false,
    staleReason: latestRound.status,
    counts: battleState.counts,
    actions: {
      approve: action,
      requestChanges: action,
      returnToSpec: action,
      waiveP1: action,
      terminalBlock: false,
    },
  };
}

export const buildRunningSpecBattleGateState = buildActiveSpecBattleGateState;

export function GatePanel({
  projectId,
  changeId,
  gateStatus,
  specBattleFallback,
  specBattleState,
  loading,
  busy,
  error,
  onStopBattle,
  onAcceptRisk,
  onBattleDecision,
  onRestartBattle,
  onRegenerateReport,
}: {
  projectId: string;
  changeId: string;
  gateStatus: GateStatus | null;
  specBattleFallback: SpecBattleGateState | null;
  specBattleState: SpecBattleState | null;
  loading: boolean;
  busy: boolean;
  error: string;
  onStopBattle: () => void;
  onAcceptRisk: (targetId?: string | null) => void;
  onBattleDecision: (action: BattleDecisionAction, targetId?: string | null) => void;
  onRestartBattle: () => void;
  onRegenerateReport: () => void;
}) {
  const specBattle = gateStatus?.specBattle ?? specBattleFallback;
  const approveAction = gateApprovalAction(gateStatus);
  const runTechSpecAction = findPipelineAction(gateStatus?.actions, "run_tech_spec");
  if (((gateStatus?.gate === "spec" && specBattle) || specBattleFallback) && specBattle) {
    return (
      <SpecBattlefield
        projectId={projectId}
        changeId={changeId}
        specBattle={specBattle}
        battleState={specBattleState}
        approveAction={approveAction}
        runTechSpecAction={runTechSpecAction}
        busy={busy}
        loading={loading}
        error={error}
        onAcceptRisk={onAcceptRisk}
        onStopBattle={onStopBattle}
        onBattleDecision={onBattleDecision}
        onRestartBattle={onRestartBattle}
        onRegenerateReport={onRegenerateReport}
      />
    );
  }

  if (!gateStatus?.atGate) return null;

  const mergeChecks = gateStatus.mergeChecks;

  return (
    <section className="space-y-4" aria-label={`${formatGateName(gateStatus.gate)} gate facts`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
              待确认
            </span>
            <h3 className="font-medium">{formatGateName(gateStatus.gate)} Gate</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Status: <span className="font-mono text-foreground">{gateStatus.status}</span>
          </p>
        </div>
      </div>

      <div className="rounded-md border bg-muted/20 p-3">
        <h4 className="mb-2 text-sm font-medium">Gate facts</h4>
        <div className="text-xs">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-background px-1.5 py-0.5 font-mono">
              {gateStatus.pendingArtifact ? (
                <ProducedFile
                  projectId={projectId}
                  changeId={changeId}
                  path={gateStatus.pendingArtifact}
                  label={formatArtifactName(gateStatus.pendingArtifact)}
                />
              ) : (
                formatArtifactName(gateStatus.pendingArtifact)
              )}
            </span>
            {!gateStatus.pendingArtifact && (
              <span className="text-muted-foreground">Merge gate uses readiness checks.</span>
            )}
          </div>
          <p className="rounded bg-background p-2 text-muted-foreground">
            {formatArtifactHint(gateStatus.pendingArtifact)}
          </p>
        </div>
      </div>

      {mergeChecks && (
        <div className="grid gap-2 text-xs md:grid-cols-3">
          <span className={mergeChecks.qaPassed ? "text-green-700" : "text-red-600"}>
            QA {mergeChecks.qaPassed ? "passed" : "pending"}
          </span>
          <span className={mergeChecks.reviewPassed ? "text-green-700" : "text-red-600"}>
            Review {mergeChecks.reviewPassed ? "passed" : "pending"}
          </span>
          <span className={mergeChecks.docsComplete ? "text-green-700" : "text-red-600"}>
            Docs {mergeChecks.docsComplete ? "complete" : "missing"}
          </span>
          <span className={mergeChecks.requirementGapsPassed !== false ? "text-green-700" : "text-red-600"}>
            Requirements {mergeChecks.mergeBlockingRequirementGaps ?? 0} blocking
          </span>
          {mergeChecks.missing.length > 0 && (
            <p className="md:col-span-3 text-muted-foreground">
              Missing: {mergeChecks.missing.join(", ")}
            </p>
          )}
        </div>
      )}

    </section>
  );
}
