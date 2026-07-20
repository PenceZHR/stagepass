import type {
  ActionContractDb,
  ActionDecision,
  ActionDefinition,
} from "./action-contract-types";
import {
  getStageAuthority,
  peekStageAuthority,
  type StageAuthoritySnapshot,
} from "./stage-authority-service";
import {
  gateDecision,
  legacyOnlyDecision,
  withSnapshotGateFields,
} from "./action-contract-common-policy";
import {
  approveSpecDecision,
  prdRunDecision,
  specRunDecision,
  techSpecRunDecision,
} from "./action-contract-design-policy";
import {
  adoptBuildRunDecision,
  buildBaseCampDecision,
  rejectBuildRunDecision,
  retryBuildDecision,
  reviewBuildAdoptionDecision,
} from "./action-contract-build-policy";
import { commitChangesDecision, initGitRepoDecision } from "./action-contract-git-policy";
import { reviewControlDecision } from "./action-contract-review-policy";
import { enterQaDecision, retryQaDecision } from "./action-contract-qa-policy";
import {
  approveMergeDecision,
  approveMergeDecisionFromPersistedReadiness,
  mergeDecision,
  mergeDecisionFromPersistedReadiness,
} from "./action-contract-merge-policy";
import { selfHealLegacyTestPlanApprovalForBuild } from "./action-contract-self-heal-bindings";
import {
  resolveBriefingActionAuthority,
  resolveRetroActionAuthority,
} from "./provider-action-authority-service";

/**
 * Routes one action definition to the phase policy that can decide it, and
 * returns that policy's declarative ActionDecision. This is the per-phase branch
 * chain that used to live in the action-contract facade; the facade is now just
 * the registry aggregation around it.
 *
 * The options shape is inlined rather than importing the facade's
 * ActionBuildOptions — that would put the facade back on this module's import
 * path, and the whole point of the split is that decisions do not depend on the
 * aggregator.
 */
export interface DecisionRouterOptions {
  selfHeal: boolean;
  recomputeMergeReadiness: boolean;
}

/**
 * A policy decides one action from the shared context, or returns null to fall
 * through to the phase's plain gate decision.
 */
type ActionPolicy = (context: DecisionContext) => ActionDecision | null;

interface DecisionContext {
  db: ActionContractDb;
  changeId: string;
  changeStatus: string;
  changeGateState: string | null;
  repoPath: string;
  definition: ActionDefinition;
  snapshot: StageAuthoritySnapshot;
  options: DecisionRouterOptions;
  readStageAuthority: typeof getStageAuthority;
  /**
   * The phase's plain gate decision. Lazy and memoized on purpose: most actions
   * are decided without it, and computing it eagerly for all 43 definitions
   * would read the review/QA state on every one.
   */
  base: () => ActionDecision;
}

function notAtGate(): ActionDecision {
  return { enabled: false, reasonCode: "not_at_gate", reason: "not_at_gate", blockers: [] };
}

/**
 * Spec is decided before the required-status gate, because specRunDecision has
 * to explain *why* the change is not at the Spec gate rather than be short
 * circuited by it.
 */
const PRE_STATUS_GATE_POLICIES: ReadonlyMap<string, ActionPolicy> = new Map<string, ActionPolicy>([
  ["run_spec", ({ definition, changeId, changeStatus, changeGateState, snapshot }) =>
    specRunDecision(definition.actionId, changeId, changeStatus, changeGateState, snapshot)],
  ["retry_spec", ({ definition, changeId, changeStatus, changeGateState, snapshot }) =>
    specRunDecision(definition.actionId, changeId, changeStatus, changeGateState, snapshot)],
  // fix_blockers decides its own status window (FIX_ENTRY_STATUSES) and names
  // the statuses in the reason, so it has to run BEFORE the flat requiredStatus
  // filter below would replace that with a bare not_at_gate. The definition
  // still carries requiredStatus, because the enqueue authority is a separate
  // enforcement point that has no other status guard and skips its filter
  // entirely when the field is unset.
  ["fix_blockers", ({ db, changeId, definition, changeStatus }) =>
    reviewControlDecision(db, changeId, definition.actionId, changeStatus)],
]);

const reviewControl: ActionPolicy = ({ db, changeId, definition, changeStatus }) =>
  reviewControlDecision(db, changeId, definition.actionId, changeStatus);

const planGate: ActionPolicy = ({ changeGateState }) =>
  changeGateState !== "tech_spec"
    ? {
      enabled: false,
      reasonCode: "tech_spec_gate_unapproved",
      reason: "TechSpec gate must be approved before Plan generation",
      blockers: [],
    }
    : null;

const techSpecRun: ActionPolicy = ({ changeId, changeGateState, snapshot }) =>
  techSpecRunDecision(changeId, changeGateState, snapshot);

const reviewRun: ActionPolicy = ({ db, changeId, definition }) =>
  reviewBuildAdoptionDecision(
    db,
    changeId,
    { enabled: true, reasonCode: null, reason: null, blockers: [] },
    definition.actionId === "retry_review",
  );

const buildRun: ActionPolicy = ({ db, changeId, changeStatus, repoPath, options, base }) => {
  const gate = options.selfHeal
    ? selfHealLegacyTestPlanApprovalForBuild(db, changeId, changeStatus, base())
    : base();
  return buildBaseCampDecision(changeId, repoPath, gate);
};

const buildRetry: ActionPolicy = ({ db, changeId, changeStatus, repoPath, options, base }) => {
  const gate = options.selfHeal
    ? selfHealLegacyTestPlanApprovalForBuild(db, changeId, changeStatus, base())
    : base();
  return buildBaseCampDecision(changeId, repoPath, retryBuildDecision(db, changeId, changeStatus, gate));
};

const buildAdopt: ActionPolicy = ({ db, changeId, repoPath }) =>
  buildBaseCampDecision(changeId, repoPath, adoptBuildRunDecision(db, changeId));

/**
 * The PRD briefing sub-steps are the *producers* of the PRD stage gate, so they
 * must not consume it as a precondition. Without this policy they fall through
 * to base() -- gateDecision("PRD") -- which reports the PRD gate's own blockers
 * against them. That inverts the causality most visibly on the final review: a
 * change with no fresh final review carries the "Fresh PRD final review is
 * missing" blocker, and the action that exists to clear that blocker was
 * reported as blocked by it, while the dispatch path accepted the POST and the
 * UI button worked. The read path could not recover from the fall-through
 * either, because the enqueue-authority overlay only narrows an already-enabled
 * decision and is skipped entirely once policy has decided false.
 *
 * Deriving from resolveBriefingActionAuthority -- the same authority the job
 * dispatcher enforces at enqueue time -- keeps the served `enabled` in
 * agreement with what a POST would actually do, and carries the briefing's own
 * (draft version, draft hash) identity instead of the PRD gate's.
 */
const briefingRun: ActionPolicy = ({ db, changeId, definition }) => {
  const authority = resolveBriefingActionAuthority(db, changeId, definition.actionId);
  return {
    enabled: authority.enabled,
    reasonCode: authority.reasonCode,
    reason: authority.enabled ? null : `PRD briefing step is unavailable: ${authority.reasonCode}`,
    // Deliberately empty: the PRD gate's blockers describe the gate this step
    // feeds, not a precondition of the step itself.
    blockers: [],
    gateVersion: authority.gateVersion,
    sourceDbHash: authority.sourceDbHash,
  };
};

const ACTION_POLICIES: ReadonlyMap<string, ActionPolicy> = new Map<string, ActionPolicy>([
  ["run_prd", ({ snapshot }) => prdRunDecision(snapshot)],
  ["retry_prd", ({ changeStatus, snapshot }) =>
    ["INTAKE_PENDING", "BLOCKED"].includes(changeStatus) ? prdRunDecision(snapshot) : notAtGate()],

  ["run_prd_briefing_questions", briefingRun],
  ["run_prd_briefing_draft", briefingRun],
  ["run_prd_briefing_final_review", briefingRun],

  ["run_plan", planGate],
  ["retry_plan", planGate],

  ["run_tech_spec", techSpecRun],
  ["retry_tech_spec", techSpecRun],

  // Only decided here at the TestPlan gate; otherwise it falls through to base.
  ["approve_plan", ({ changeId, changeStatus, readStageAuthority }) => {
    if (changeStatus !== "TESTPLAN_DONE") return null;
    const testPlanAuthority = readStageAuthority(changeId, "TestPlan");
    return withSnapshotGateFields(gateDecision("TestPlan", testPlanAuthority), testPlanAuthority);
  }],

  ["run_review", reviewRun],
  ["retry_review", reviewRun],

  // fix_blockers is decided in PRE_STATUS_GATE_POLICIES instead, ahead of the
  // requiredStatus filter.
  ["waive_review_p1", reviewControl],
  ["recompute_report", reviewControl],
  ["rebuild_mirror", reviewControl],
  ["stop_change", reviewControl],

  ["enter_qa", ({ db, changeId, readStageAuthority }) =>
    enterQaDecision(db, changeId, readStageAuthority(changeId, "TestPlan")) ?? {
      enabled: false,
      reasonCode: "review_not_allowed",
      reason: "Review is not ready for QA",
      blockers: [],
    }],
  ["run_qa", ({ db, changeId, readStageAuthority }) =>
    enterQaDecision(db, changeId, readStageAuthority(changeId, "TestPlan")) ?? {
      enabled: false,
      reasonCode: "review_not_allowed",
      reason: "Review is not ready for QA",
      blockers: [],
    }],
  ["retry_qa", ({ db, changeId, changeStatus, snapshot, readStageAuthority }) =>
    retryQaDecision(db, changeId, changeStatus, snapshot, readStageAuthority(changeId, "TestPlan"))],

  ["approve_merge", ({ db, changeId, options }) =>
    options.recomputeMergeReadiness
      ? approveMergeDecision(db, changeId)
      : approveMergeDecisionFromPersistedReadiness(db, changeId)],
  ["merge", ({ db, changeId, options }) =>
    options.recomputeMergeReadiness
      ? mergeDecision(changeId, true)
      : mergeDecisionFromPersistedReadiness(db, changeId)],

  ["run_retro", ({ db, changeId }) => {
    const authority = resolveRetroActionAuthority(db, changeId);
    return {
      enabled: Boolean(authority),
      reasonCode: authority ? null : "retro_release_authority_unavailable",
      reason: authority ? null : "Release authority is unavailable or has drifted",
      blockers: [],
      gateVersion: authority?.gateVersion,
      sourceDbHash: authority?.sourceDbHash,
    };
  }],

  ["run_build", buildRun],
  ["retry_build", buildRetry],
  ["approve_spec", ({ db, changeId, base }) => approveSpecDecision(db, changeId, base())],
  ["adopt_build", buildAdopt],
  ["adopt_fix", buildAdopt],
  ["reject_build", ({ db, changeId }) => rejectBuildRunDecision(db, changeId)],

  // Decided purely from the working tree; they never consult base(), because the
  // Build stage gate has no bearing on whether a path is a repository or whether
  // there is anything to commit. See action-contract-git-policy for why they
  // also carry their own (gateVersion, sourceDbHash) instead of the gate's.
  ["init_git_repo", ({ changeId, repoPath }) => initGitRepoDecision(repoPath, changeId)],
  ["commit_changes", ({ changeId, repoPath }) => commitChangesDecision(repoPath, changeId)],
]);

export function decideAction(
  db: ActionContractDb,
  changeId: string,
  changeStatus: string,
  changeGateState: string | null,
  repoPath: string,
  definition: ActionDefinition,
  snapshot: StageAuthoritySnapshot,
  options: DecisionRouterOptions,
): ActionDecision {
  const legacyOnly = legacyOnlyDecision(db, changeId, snapshot);
  if (legacyOnly) return legacyOnly;

  let memoizedBase: ActionDecision | null = null;
  const context: DecisionContext = {
    db,
    changeId,
    changeStatus,
    changeGateState,
    repoPath,
    definition,
    snapshot,
    options,
    readStageAuthority: options.selfHeal || options.recomputeMergeReadiness
      ? getStageAuthority
      : peekStageAuthority,
    base: () => (memoizedBase ??= gateDecision(definition.phase, snapshot)),
  };

  const preStatusGate = PRE_STATUS_GATE_POLICIES.get(definition.actionId);
  if (preStatusGate) {
    const decided = preStatusGate(context);
    if (decided) return decided;
  }

  const requiredStatuses = Array.isArray(definition.requiredStatus)
    ? definition.requiredStatus
    : definition.requiredStatus
      ? [definition.requiredStatus]
      : [];
  if (requiredStatuses.length > 0 && !requiredStatuses.includes(changeStatus)) {
    return notAtGate();
  }

  return ACTION_POLICIES.get(definition.actionId)?.(context) ?? context.base();
}
