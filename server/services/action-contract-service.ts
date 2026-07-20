import { createRequire } from "node:module";

import {
  actionContractRepository,
  setActionContractRepositoryDbForTest,
} from "../repositories/action-contract-repository";
import { persistActionContractRow } from "./action-contract-persistence-service";
import { decideAction } from "./action-contract-decision-router";
import { ACTION_DEFINITIONS } from "./action-contract-registry-service";
import {
  MISSING_GATE_SOURCE_DB_HASH,
} from "./action-contract-common-policy";
// Kept on the facade: it was exported here before the primitives were sunk.
export { MISSING_GATE_SOURCE_DB_HASH };
import {
  activeJobPhaseForAction,
  activePipelineJobPhases,
  applyStageOutputRetry,
  latestStageOutputSignal,
  retryOutputPhase,
  warningPhaseForDefinition,
  type StageOutputSignal,
} from "./action-contract-stage-signal-policy";
import {
  selfHealStuckCheckingQa,
} from "./action-contract-self-heal-bindings";
import type {
  ActionContractDb,
  ContractPhase,
  PipelineActionContract,
} from "./action-contract-types";
import { pipelineJobSelectionForAction } from "./pipeline-job-types";
import {
  evaluateProviderActionAuthority,
  type ProviderActionAuthority,
} from "./provider-action-authority-service";
import {
  getStageAuthority,
  peekStageAuthority,
  type PipelinePhase,
  type StageAuthoritySnapshot,
} from "./stage-authority-service";
import { computeMergeReadiness } from "./merge-readiness-service";

export type { PipelineActionContract } from "./action-contract-types";


export interface ComputeActionsOptions {
  selfHeal?: boolean;
  recomputeMergeReadiness?: boolean;
}

interface ActionBuildOptions extends Required<ComputeActionsOptions> {
  persist: boolean;
}

const requireDefaultDb = createRequire(import.meta.url);
let actionContractDbForTest: ActionContractDb | null = null;
let defaultActionContractDb: ActionContractDb | null = null;

export function setActionContractServiceDbForTest(nextDb: ActionContractDb): () => void {
  const previous = actionContractDbForTest;
  const restoreRepositoryDb = setActionContractRepositoryDbForTest(nextDb);
  actionContractDbForTest = nextDb;
  return () => {
    actionContractDbForTest = previous;
    restoreRepositoryDb();
  };
}

function getActionContractDb(): ActionContractDb {
  if (actionContractDbForTest) return actionContractDbForTest;
  if (!defaultActionContractDb) {
    defaultActionContractDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultActionContractDb;
}

export function actionRequiresIdempotencyKey(actionId: string): boolean {
  return (
    actionId.startsWith("run_") ||
    actionId.startsWith("retry_") ||
    actionId.startsWith("adopt_") ||
    actionId.startsWith("reject_") ||
    actionId.startsWith("waive_") ||
    actionId.startsWith("approve_") ||
    actionId === "enter_qa" ||
    actionId === "merge" ||
    actionId === "recompute_report" ||
    actionId === "rebuild_mirror"
  );
}

function nowISO(): string {
  return new Date().toISOString();
}

export function persistActionContract(
  changeId: string,
  action: PipelineActionContract,
  computedAt = nowISO(),
): void {
  persistActionContractRow(getActionContractDb(), changeId, action, computedAt);
}

/**
 * Overlays the job dispatcher's enqueue-time authority on a policy-enabled
 * action so the served contract reflects what a POST will actually accept.
 * The two evaluations are intentionally distinct implementations (policy =
 * UX-facing gate/state reasoning, authority = enqueue integrity fence), but
 * the contract must never advertise an action the fence would 409: the
 * authority verdict wins on enabled/gateVersion/sourceDbHash. Policy-disabled
 * actions are returned as-is -- the overlay only tightens, never loosens.
 */
function enqueueAuthorityOverlay(
  db: ActionContractDb,
  changeId: string,
  actionId: string,
  policyEnabled: boolean,
): ProviderActionAuthority | null {
  if (!policyEnabled) return null;
  const selection = pipelineJobSelectionForAction(actionId);
  if (!selection) return null;
  return evaluateProviderActionAuthority(
    db as unknown as Parameters<typeof evaluateProviderActionAuthority>[0],
    { ...selection, changeId },
  );
}

function buildActions(changeId: string, options: ActionBuildOptions): PipelineActionContract[] {
  const db = getActionContractDb();
  const change = actionContractRepository.findChange(changeId);
  if (!change) {
    throw new Error(`Change not found: ${changeId}`);
  }
  const effectiveChange = options.selfHeal ? selfHealStuckCheckingQa(db, change) : change;
  const project = actionContractRepository.findProject(effectiveChange.projectId);
  if (!project) {
    throw new Error(`Project not found: ${effectiveChange.projectId}`);
  }

  const snapshots = new Map<ContractPhase, StageAuthoritySnapshot>();
  const stageOutputSignals = new Map<PipelinePhase, StageOutputSignal>();
  const activeJobPhases = activePipelineJobPhases(db, changeId);
  const signalFor = (phase: PipelinePhase): StageOutputSignal => {
    const existing = stageOutputSignals.get(phase);
    if (existing) return existing;
    const next = latestStageOutputSignal(db, changeId, phase);
    stageOutputSignals.set(phase, next);
    return next;
  };
  const actions = ACTION_DEFINITIONS.map((definition) => {
    if (
      options.recomputeMergeReadiness &&
      (definition.actionId === "approve_merge" || definition.actionId === "merge")
    ) {
      computeMergeReadiness(changeId);
      snapshots.delete("Merge");
    }
    const snapshotPhase = definition.snapshotPhase ?? definition.phase;
    let snapshot = snapshots.get(snapshotPhase as ContractPhase);
    if (!snapshot) {
      snapshot = options.selfHeal || options.recomputeMergeReadiness || options.persist
        ? getStageAuthority(changeId, snapshotPhase as PipelinePhase)
        : peekStageAuthority(changeId, snapshotPhase as PipelinePhase);
      snapshots.set(snapshotPhase as ContractPhase, snapshot);
    }
    const baseDecision = decideAction(
      db,
      changeId,
      effectiveChange.status,
      effectiveChange.gateState,
      project.repoPath,
      definition,
      snapshot,
      options,
    );
    const retryPhase = retryOutputPhase(definition.actionId);
    const retrySignal = retryPhase ? signalFor(retryPhase) : null;
    const retryDecision = retryPhase && definition.actionId !== "retry_build"
      ? applyStageOutputRetry(baseDecision, retrySignal, snapshot)
      : baseDecision;
    const activeJobPhase = activeJobPhaseForAction(db, definition.actionId);
    const decision = activeJobPhase && activeJobPhases.has(activeJobPhase)
      ? {
        enabled: false,
        reasonCode: "provider_job_running",
        reason: "A provider job for this stage is still running",
        blockers: [],
      }
      : retryDecision;
    const warnings = signalFor(warningPhaseForDefinition(definition, retryPhase)).warnings;
    const authority = enqueueAuthorityOverlay(db, changeId, definition.actionId, decision.enabled);
    const authorityDenied = authority !== null && !authority.enabled;
    return {
      actionId: definition.actionId,
      phase: definition.phase,
      label: definition.label,
      enabled: decision.enabled && !authorityDenied,
      reasonCode: authorityDenied ? authority.reasonCode : decision.reasonCode,
      reason: authorityDenied
        ? `Enqueue authority denies this action: ${authority.reasonCode}`
        : decision.reason,
      blockers: decision.blockers,
      warnings,
      gateVersion: authority?.enabled
        ? authority.gateVersion
        : decision.gateVersion ?? String(snapshot.latestGate?.gateVersion ?? 0),
      sourceDbHash: authority?.enabled
        ? authority.sourceDbHash
        : decision.sourceDbHash ?? snapshot.latestGate?.sourceDbHash ?? MISSING_GATE_SOURCE_DB_HASH,
      requiresIdempotencyKey: actionRequiresIdempotencyKey(definition.actionId),
      requiresProvider: definition.requiresProvider === true,
      providerSelectable: definition.providerSelectable === true,
      defaultProvider: (effectiveChange.provider === "claude" ? "claude" : "codex") as "codex" | "claude",
    };
  });

  if (options.persist) {
    const computedAt = nowISO();
    for (const action of actions) {
      persistActionContract(changeId, action, computedAt);
    }
  }
  return actions;
}

export function computeActions(
  changeId: string,
  options: ComputeActionsOptions = {},
): PipelineActionContract[] {
  return buildActions(changeId, {
    selfHeal: options.selfHeal ?? false,
    recomputeMergeReadiness: options.recomputeMergeReadiness ?? false,
    persist: false,
  });
}

export function refreshActions(changeId: string): PipelineActionContract[] {
  return buildActions(changeId, {
    selfHeal: true,
    recomputeMergeReadiness: true,
    persist: true,
  });
}

export const getActions = refreshActions;
