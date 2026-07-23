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
  waiveSpecP1Decision,
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
  resolveDeliveryActionAuthority,
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

const rejectIntake: ActionPolicy = ({ snapshot }) =>
  withSnapshotGateFields(
    { enabled: true, reasonCode: null, reason: null, blockers: [] },
    snapshot,
  );

const ACTION_POLICIES: ReadonlyMap<string, ActionPolicy> = new Map<string, ActionPolicy>([
  ["run_prd", ({ snapshot }) => prdRunDecision(snapshot)],
  ["retry_prd", ({ changeStatus, snapshot }) =>
    ["INTAKE_PENDING", "BLOCKED"].includes(changeStatus) ? prdRunDecision(snapshot) : notAtGate()],

  // Rejecting Intake is an exit from the PRD gate, not a consumer of its
  // verdict. The requiredStatus filter above has already proved the change is
  // at INTAKE_READY; carrying the snapshot here keeps preflight freshness
  // checks without letting a blocked rubric verdict disable its own escape.
  ["reject_intake", rejectIntake],

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
  // waive_spec_p1 needs its own policy: without one it falls through to
  // gateDecision("Spec"), which disables anything whose gate is blocked -- and a
  // P1 waiver is only ever used WHILE the gate is blocked.
  ["waive_spec_p1", ({ changeId }) => waiveSpecP1Decision(changeId)],

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

  // Mirrors resolveDeliveryActionAuthority exactly. The read path and the
  // enqueue path have to agree in BOTH directions: reporting the action
  // disabled where a POST would accept it strands the reader on a phantom
  // blocker, and reporting it enabled where a POST would 409 promises an action
  // that cannot be dispatched.
  ["run_delivery", ({ db, changeId }) => {
    const authority = resolveDeliveryActionAuthority(db, changeId);
    return {
      enabled: Boolean(authority),
      reasonCode: authority ? null : "delivery_retro_authority_unavailable",
      reason: authority ? null : "Retro has not completed, or its authority has drifted",
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

/**
 * A change that has been delivered is finished. Nothing below may restart it.
 *
 * Measured on a copy of the shipped database: a change parked at DONE still
 * offered seven actions with `enabled: true, reasonCode: null`, and `enter_qa`
 * was not merely offered -- POSTing it answered **202** and queued a
 * local_check job against the delivered change. The action contract is the only
 * thing standing between the UI and that, because each policy answers about its
 * own stage and none of them asks whether the change is still open at all.
 *
 * Deliberately not every action. Regenerating a report or rebuilding a mirror on
 * a finished change is a legitimate read-back, and blanket-disabling would take
 * away the only way to get those artifacts re-rendered. What is refused is
 * anything that would move the change or start new work.
 */
const TERMINAL_CHANGE_STATUSES: ReadonlySet<string> = new Set(["DONE"]);

const ACTIONS_REFUSED_ON_TERMINAL_CHANGE: ReadonlySet<string> = new Set([
  "enter_qa",
  "stop_change",
  "commit_changes",
  "waive_spec_p1",
  "waive_plan_p1",
  // The two operations below have no ACTION_DEFINITIONS entry, so they never
  // pass through decideAction at all -- their routes call the service directly.
  // They are listed here anyway so this set stays the one statement of "what a
  // finished change refuses", and `changeTerminalRefusal` lets those routes read
  // it. Measured against a copy of the shipped database: POSTing /rework to a
  // DONE change reached reworkChange and died on "FOREIGN KEY constraint
  // failed", while /block -- same change, same instant -- correctly answered 409
  // change_terminal. The only thing standing between a terminal change and an
  // unauthorized rework was an unrelated FK bug.
  "rework",
  "spec_battle_decision",
]);

/**
 * Why a finished change refuses an operation, or null if it does not.
 *
 * Exported so the routes that bypass the action contract entirely can still
 * honour the same rule from the same set, rather than growing a second copy of
 * it. `decideAction` below is the other caller.
 */
export function changeTerminalRefusal(
  changeStatus: string,
  actionId: string,
): { reasonCode: string; reason: string } | null {
  if (!TERMINAL_CHANGE_STATUSES.has(changeStatus)) return null;
  if (!ACTIONS_REFUSED_ON_TERMINAL_CHANGE.has(actionId)) return null;
  return {
    reasonCode: "change_terminal",
    reason: `Change is ${changeStatus} and cannot be advanced further`,
  };
}

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
  // Ahead of every policy: this is a fact about the change, not about any one
  // stage, and no per-stage policy is positioned to notice it.
  const terminalRefusal = changeTerminalRefusal(changeStatus, definition.actionId);
  if (terminalRefusal) {
    return { enabled: false, ...terminalRefusal, blockers: [] };
  }

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
