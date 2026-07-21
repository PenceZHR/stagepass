import { and, desc, eq, inArray } from "drizzle-orm";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  artifacts,
  apiSnapshots,
  briefingQuestions,
  buildRunRecords,
  changes,
  pipelineJobs,
  planSnapshots,
  prdBriefings,
  prdDrafts,
  projects,
  qaCommandResults,
  qaEvidence,
  qaFailures,
  qaRuns,
  releaseNoteState,
  requiredValidationCommands,
  runs,
  stageGates,
  stageRuns,
  testplanCoverageItems,
  testplanManualChecks,
  testplanRiskMappings,
  testplanSnapshots,
  techspecSnapshots,
} from "../db/schema";
import { ACTION_DEFINITIONS } from "./action-contract-registry-service";
import { prdBriefingInputHash, readPrdBriefingSourceHashes } from "./prd-briefing-ledger";
import type { EnqueuePipelineJobInput } from "./pipeline-job-types";
import { computeSourceDbHash } from "./stage-authority-service";
import { latestApprovedBuildRecord, reviewBuildSourceHash } from "./action-contract-build-policy";
import { assertBuildRecordFresh } from "./build-run-record-service";
import { buildRunId, resolveApprovedBuildRun } from "./build-workspace-service";
import { reviewControlDecision, trustedLatestReviewReportSource } from "./action-contract-review-policy";
import type { ActionContractDb } from "./action-contract-types";
import { computeMergeReadiness, type MergeReadinessDb } from "./merge-readiness-service";

type AuthorityDb = Pick<typeof import("../db").db, "select">;

export interface ProviderActionAuthority {
  actionId: string;
  enabled: boolean;
  gateVersion: string;
  sourceDbHash: string;
  reasonCode: string | null;
}

const BRIEFING_ACTIONS = new Set([
  "run_prd_briefing_questions",
  "run_prd_briefing_draft",
  "run_prd_briefing_final_review",
]);

const BUSINESS_PHASE_BY_AUTHORITY_PHASE: Record<string, string> = {
  Spec: "spec",
  TechSpec: "tech_spec",
  Plan: "generate_plan",
  TestPlan: "test_plan",
  Build: "implement",
  Review: "review",
  QA: "local_check",
  Merge: "release",
};

const AUTHORITATIVE_DESIGN_STATUSES = new Set(["approved", "pass", "passed"]);

function hasUniqueTechSpecSnapshotSource(
  db: AuthorityDb,
  changeId: string,
  sourceDbHash: string,
): boolean | null {
  const rawTechSpecs = db.select({
    id: techspecSnapshots.id,
    status: techspecSnapshots.status,
    contentDbHash: techspecSnapshots.contentDbHash,
  }).from(techspecSnapshots).where(eq(techspecSnapshots.changeId, changeId)).all();
  const rawApis = db.select({
    id: apiSnapshots.id,
    status: apiSnapshots.status,
    contractDbHash: apiSnapshots.contractDbHash,
  }).from(apiSnapshots).where(eq(apiSnapshots.changeId, changeId)).all();
  if (rawTechSpecs.length === 0 && rawApis.length === 0) return null;
  const techSpecs = rawTechSpecs
    .filter((row) => AUTHORITATIVE_DESIGN_STATUSES.has(row.status) && Boolean(row.contentDbHash));
  const apis = rawApis
    .filter((row) => AUTHORITATIVE_DESIGN_STATUSES.has(row.status) && Boolean(row.contractDbHash));
  let matches = 0;
  for (const techSpec of techSpecs) {
    for (const api of apis) {
      const candidateHash = computeSourceDbHash({
        changeId,
        phase: "TechSpec",
        rows: [
          { table: "techspec_snapshots", id: techSpec.id, contentDbHash: techSpec.contentDbHash },
          { table: "api_snapshots", id: api.id, contractDbHash: api.contractDbHash },
        ],
      });
      if (candidateHash === sourceDbHash) matches += 1;
      if (matches > 1) return false;
    }
  }
  return matches === 1;
}

type SnapshotSourceResolver = (db: AuthorityDb, changeId: string, sourceDbHash: string) => boolean | null;

function hasUniqueTestPlanSnapshotSource(
  db: AuthorityDb,
  changeId: string,
  sourceDbHash: string,
): boolean | null {
  const snapshots = db.select().from(testplanSnapshots)
    .where(eq(testplanSnapshots.changeId, changeId)).all();
  const commands = db.select().from(requiredValidationCommands).where(and(
    eq(requiredValidationCommands.changeId, changeId),
    eq(requiredValidationCommands.phase, "TestPlan"),
  )).all();
  if (snapshots.length === 0 && commands.length === 0) return null;

  const approved = snapshots
    .filter((snapshot) => snapshot.status === "approved" && snapshot.approvalState === "approved")
    .sort((left, right) => {
      const byApproved = (right.approvedAt ?? right.createdAt).localeCompare(left.approvedAt ?? left.createdAt);
      return byApproved !== 0 ? byApproved : right.id.localeCompare(left.id);
    });
  const snapshot = approved[0];
  if (!snapshot) return false;
  if (approved[1] && (approved[1].approvedAt ?? approved[1].createdAt) ===
      (snapshot.approvedAt ?? snapshot.createdAt)) return false;
  const coverageItems = db.select().from(testplanCoverageItems)
    .where(eq(testplanCoverageItems.testplanSnapshotId, snapshot.id)).all();
  const riskMappings = db.select().from(testplanRiskMappings)
    .where(eq(testplanRiskMappings.testplanSnapshotId, snapshot.id)).all();
  const snapshotCommands = commands.filter((command) => command.sourceSnapshotId === snapshot.id);
  const manualChecks = db.select().from(testplanManualChecks)
    .where(eq(testplanManualChecks.testplanSnapshotId, snapshot.id)).all();
  if (snapshotCommands.filter((command) => command.required === 1).length === 0) return false;
  return computeSourceDbHash({
    changeId,
    phase: "TestPlan",
    rows: [snapshot, ...coverageItems, ...riskMappings, ...snapshotCommands, ...manualChecks],
  }) === sourceDbHash;
}

function hasCurrentQaTestPlanPrerequisite(db: AuthorityDb, changeId: string): boolean {
  const gate = db.select().from(stageGates).where(and(
    eq(stageGates.changeId, changeId), eq(stageGates.phase, "TestPlan"),
  )).orderBy(desc(stageGates.computedAt), desc(stageGates.gateVersion), desc(stageGates.id)).get();
  if (!gate?.sourceDbHash || !isPassingGateStatus(gate.status)) return false;
  return hasUniqueTestPlanSnapshotSource(db, changeId, gate.sourceDbHash) === true;
}

const SNAPSHOT_SOURCE_RESOLVERS: Partial<Record<string, SnapshotSourceResolver>> = {
  TechSpec: hasUniqueTechSpecSnapshotSource,
  Plan: hasUniquePlanSnapshotSource,
  TestPlan: hasUniqueTestPlanSnapshotSource,
  QA: hasUniqueQaSnapshotSource,
};

// Plan authority is the DB plan snapshot, not run bookkeeping: gate.sourceDbHash
// is written as the latest snapshot's content hash (persistPlanSnapshot), and
// plan_snapshots rows are created both by provider runs and by human report
// recomputes (regeneratePlanReport), so no stable mapping onto business `runs`
// exists. Matching against the latest snapshot (same ordering as
// latestPlanSnapshot) both authorizes retried/recomputed plans and denies a
// gate whose hash no longer reflects the current plan content.
function hasUniquePlanSnapshotSource(
  db: AuthorityDb,
  changeId: string,
  sourceDbHash: string,
): boolean | null {
  const snapshots = db.select({
    id: planSnapshots.id,
    snapshotDbHash: planSnapshots.snapshotDbHash,
    createdAt: planSnapshots.createdAt,
  }).from(planSnapshots).where(eq(planSnapshots.changeId, changeId)).all();
  if (snapshots.length === 0) return null;
  const latest = [...snapshots].sort((left, right) => {
    const byCreated = right.createdAt.localeCompare(left.createdAt);
    return byCreated !== 0 ? byCreated : right.id.localeCompare(left.id);
  })[0]!;
  return latest.snapshotDbHash === sourceDbHash;
}

function hasUniqueQaSnapshotSource(
  db: AuthorityDb,
  changeId: string,
  sourceDbHash: string,
): boolean | null {
  const qaRunRows = db.select().from(qaRuns).where(eq(qaRuns.changeId, changeId)).all();
  if (qaRunRows.length === 0) return null;
  let matches = 0;
  for (const run of qaRunRows) {
    const commands = db.select().from(qaCommandResults).where(eq(qaCommandResults.qaRunId, run.id)).all();
    const failures = db.select().from(qaFailures).where(eq(qaFailures.qaRunId, run.id)).all();
    const evidence = db.select().from(qaEvidence).where(eq(qaEvidence.qaRunId, run.id)).all();
    const candidate = computeSourceDbHash({
      changeId,
      phase: "QA",
      rows: [
        { table: "qa_runs", ...run },
        ...commands.map((row) => ({ table: "qa_command_results", ...row })),
        ...failures.map((row) => ({ table: "qa_failures", ...row })),
        ...evidence.map((row) => ({ table: "qa_evidence", ...row })),
      ],
    });
    if (candidate === sourceDbHash) matches += 1;
    if (matches > 1) return false;
  }
  return matches === 1;
}

function resolveBuildSnapshotSource(db: AuthorityDb, changeId: string): string | null {
  const change = db.select({ projectId: changes.projectId }).from(changes)
    .where(eq(changes.id, changeId)).get();
  if (!change) return null;
  const project = db.select({ repoPath: projects.repoPath }).from(projects)
    .where(eq(projects.id, change.projectId)).get();
  if (!project) return null;
  const approved = db.select().from(buildRunRecords).where(eq(buildRunRecords.changeId, changeId)).all()
    .filter((record) => record.status === "approved_for_absorb" || record.status === "adopted")
    .sort((left, right) => {
      const byAdopted = (right.adoptedAt ?? right.updatedAt ?? "").localeCompare(left.adoptedAt ?? left.updatedAt ?? "");
      if (byAdopted !== 0) return byAdopted;
      const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
      return byUpdated !== 0 ? byUpdated : right.id.localeCompare(left.id);
    });
  const latest = latestApprovedBuildRecord(db as unknown as Parameters<typeof latestApprovedBuildRecord>[0], changeId);
  if (!latest || latest.status !== "adopted" || approved[0]?.id !== latest.id) return null;
  if (approved[1] &&
      (approved[1].adoptedAt ?? approved[1].updatedAt) === (latest.adoptedAt ?? latest.updatedAt) &&
      approved[1].updatedAt === latest.updatedAt) return null;
  if (!latest.baseHeadSha || !latest.baseCommit || !latest.patchHash || !latest.changedFilesHash ||
      !latest.adoptedHeadSha || !latest.adoptionDecisionId || !latest.adoptedAt || !latest.artifactHash) return null;
  // The approved run, not the newest on disk: a failed fix run writes a
  // higher-numbered build-N.json, and matching that against the DB's approved
  // record made run_review/retry_review silently lose authority forever. A newer
  // run that is still live or undecided still withholds it (blockedBy => run is
  // null), because re-Review must not pre-empt a build in flight.
  const fileRun = resolveApprovedBuildRun(project.repoPath, changeId).run;
  if (!fileRun || fileRun.status !== "adopted" || buildRunId(fileRun) !== (latest.buildRunId ?? latest.id)) return null;
  if (fileRun.adoptedHeadSha !== latest.adoptedHeadSha || fileRun.adoptionDecisionId !== latest.adoptionDecisionId ||
      fileRun.patchSha256 !== latest.patchHash || fileRun.changedFilesHash !== latest.changedFilesHash ||
      fileRun.baseHeadSha !== latest.baseHeadSha || fileRun.baseCommit !== latest.baseCommit) return null;
  // DB is authoritative for read-time review authority: the adopted build_run_records
  // row (headSha === latest.adoptedHeadSha) is the trust anchor, not a live worktree
  // check. Post-adoption working-tree tampering is re-caught downstream at execution
  // (the review-stage/merge git reads are intentionally kept).
  try {
    assertBuildRecordFresh(changeId, latest.adoptedHeadSha);
  } catch {
    return null;
  }
  return reviewBuildSourceHash(latest);
}

type DirectActionAuthorityResolver = (
  db: AuthorityDb,
  changeId: string,
) => { gateVersion: string; sourceDbHash: string } | null;

function trustedRegularFileSha256(repoPath: string, expectedPath: string): string | null {
  const absoluteRepo = path.resolve(repoPath);
  const absoluteExpected = path.resolve(expectedPath);
  if (absoluteExpected !== expectedPath || !absoluteExpected.startsWith(`${absoluteRepo}${path.sep}`)) return null;
  let cursor = absoluteRepo;
  try {
    if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    for (const segment of path.relative(absoluteRepo, absoluteExpected).split(path.sep)) {
      cursor = path.join(cursor, segment);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return null;
    }
    if (!fs.lstatSync(absoluteExpected).isFile()) return null;
    const realRepo = fs.realpathSync(absoluteRepo);
    const realFile = fs.realpathSync(absoluteExpected);
    if (!realFile.startsWith(`${realRepo}${path.sep}`)) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(absoluteExpected)).digest("hex");
  } catch {
    return null;
  }
}

export function resolveRetroActionAuthority(
  db: AuthorityDb,
  changeId: string,
): { gateVersion: string; sourceDbHash: string } | null {
  const change = db.select({ projectId: changes.projectId }).from(changes)
    .where(eq(changes.id, changeId)).get();
  if (!change) return null;
  const project = db.select({ repoPath: projects.repoPath }).from(projects)
    .where(eq(projects.id, change.projectId)).get();
  if (!project) return null;
  const gate = db.select().from(stageGates).where(and(
    eq(stageGates.changeId, changeId), eq(stageGates.phase, "Merge"),
  )).orderBy(desc(stageGates.computedAt), desc(stageGates.gateVersion), desc(stageGates.id)).get();
  if (!gate?.sourceDbHash || !isPassingGateStatus(gate.status)) return null;
  const releaseRuns = db.select().from(runs).where(and(
    eq(runs.changeId, changeId), eq(runs.phase, "release"), eq(runs.status, "completed"),
  )).all().sort((left, right) => {
    const byEnded = (right.endedAt ?? right.startedAt ?? "").localeCompare(
      left.endedAt ?? left.startedAt ?? "",
    );
    return byEnded !== 0 ? byEnded : right.id.localeCompare(left.id);
  });
  const releaseRun = releaseRuns[0];
  if (!releaseRun?.endedAt) return null;
  if (releaseRuns[1] && (releaseRuns[1].endedAt ?? releaseRuns[1].startedAt ?? "") === releaseRun.endedAt) return null;
  const releaseArtifacts = db.select().from(artifacts).where(and(
    eq(artifacts.changeId, changeId), eq(artifacts.runId, releaseRun.id),
    eq(artifacts.type, "release_note"),
  )).all();
  if (releaseArtifacts.length !== 1) return null;
  const artifact = releaseArtifacts[0]!;
  const expectedRunPath = path.join(
    path.resolve(project.repoPath), ".ship", "changes", changeId, "runs", releaseRun.id, "release-note.md",
  );
  const expectedCurrentPath = path.join(
    path.resolve(project.repoPath), ".ship", "changes", changeId, "release-note.md",
  );
  if (path.resolve(artifact.path) !== expectedRunPath || artifact.path !== expectedRunPath) return null;
  // The run-scoped copy is still structurally validated (must be a regular,
  // in-root, non-symlinked file), but its bytes are no longer the content
  // authority: the immutable approved-content hash lives in release_note_state.
  const runSha256 = trustedRegularFileSha256(project.repoPath, expectedRunPath);
  if (!runSha256) return null;
  const releaseState = db.select({ approvedContentHash: releaseNoteState.approvedContentHash })
    .from(releaseNoteState)
    .where(and(
      eq(releaseNoteState.changeId, changeId),
      eq(releaseNoteState.runId, releaseRun.id),
      eq(releaseNoteState.artifactId, artifact.id),
    )).get();
  const approvedContentHash = releaseState?.approvedContentHash;
  // No approved-content hash on record (legacy/in-flight release): deny, mirroring
  // the pre-DB behaviour of denying when the run copy's hash was unavailable.
  if (!approvedContentHash) return null;
  const currentSha256 = trustedRegularFileSha256(project.repoPath, expectedCurrentPath);
  if (!currentSha256 || currentSha256 !== approvedContentHash) return null;
  const sourceDbHash = computeSourceDbHash({
    changeId,
    phase: "Merge",
    rows: [
      { table: "stage_gates", id: `${changeId}:Merge`, gateVersion: gate.gateVersion, status: gate.status,
        sourceDbHash: gate.sourceDbHash },
      { table: "runs", id: releaseRun.id, changeId: releaseRun.changeId, phase: releaseRun.phase,
        status: releaseRun.status, endedAt: releaseRun.endedAt, jobId: releaseRun.jobId,
        workerId: releaseRun.workerId, leaseToken: releaseRun.leaseToken, attemptNo: releaseRun.attemptNo },
      { table: "artifacts", id: artifact.id, changeId: artifact.changeId, runId: artifact.runId,
        type: artifact.type, path: artifact.path },
      { table: "release_files", id: artifact.id, approvedContentHash, currentSha256 },
    ],
  });
  return { gateVersion: String(gate.gateVersion), sourceDbHash };
}

/**
 * What the Done (delivery) stage stands on: a Retro that actually finished.
 *
 * It needs its own resolver for the same reason `run_retro` does. Without one
 * the generic fallback in `resolveProviderActionAuthority` reads the Merge stage
 * gate and then tries to pair it with a `stage_runs` row for phase Merge --
 * legacy machinery for Merge's own producer, which delivery is not. The
 * observed result is `authority_source_missing` at every DELIVERY_PENDING
 * change: an action the runner would happily accept, permanently greyed out.
 *
 * The fence is the retro run's identity rather than the Merge gate's, because
 * the Merge gate is not what changed since retro ran -- the retro is. Re-running
 * Retro therefore invalidates a delivery click that was handed out against the
 * previous one, which is the only drift this action has.
 */
export function resolveDeliveryActionAuthority(
  db: AuthorityDb,
  changeId: string,
): { gateVersion: string; sourceDbHash: string } | null {
  const change = db.select({ retroDone: changes.retroDone }).from(changes)
    .where(eq(changes.id, changeId)).get();
  // `retroDone` is written inside the retro stage's own afterSuccessfulResult,
  // so it is the one flag that means "retro reached its end", not "a retro run
  // exists".
  if (!change || change.retroDone !== 1) return null;
  const retroRuns = db.select().from(runs).where(and(
    eq(runs.changeId, changeId), eq(runs.phase, "retro"), eq(runs.status, "completed"),
  )).all().sort((left, right) => {
    const byEnded = (right.endedAt ?? right.startedAt ?? "").localeCompare(
      left.endedAt ?? left.startedAt ?? "",
    );
    return byEnded !== 0 ? byEnded : right.id.localeCompare(left.id);
  });
  const retroRun = retroRuns[0];
  if (!retroRun?.endedAt) return null;
  // Two retro runs settling at the same instant leave no defensible "the" run to
  // fence against, so refuse rather than pick one -- the same rule
  // resolveRetroActionAuthority applies to release runs.
  if (retroRuns[1] && (retroRuns[1].endedAt ?? retroRuns[1].startedAt ?? "") === retroRun.endedAt) {
    return null;
  }
  const sourceDbHash = computeSourceDbHash({
    changeId,
    phase: "Merge",
    rows: [
      {
        table: "runs", id: retroRun.id, changeId: retroRun.changeId, phase: retroRun.phase,
        status: retroRun.status, endedAt: retroRun.endedAt, jobId: retroRun.jobId,
        workerId: retroRun.workerId, leaseToken: retroRun.leaseToken, attemptNo: retroRun.attemptNo,
      },
    ],
  });
  return { gateVersion: "0", sourceDbHash };
}

const DIRECT_ACTION_AUTHORITY_RESOLVERS: Partial<Record<string, DirectActionAuthorityResolver>> = {
  fix_blockers: (db, changeId) => {
    const change = db.select({ status: changes.status }).from(changes)
      .where(eq(changes.id, changeId)).get();
    const decision = reviewControlDecision(
      db as unknown as ActionContractDb,
      changeId,
      "fix_blockers",
      change?.status,
    );
    if (!decision.enabled || !decision.gateVersion || !decision.sourceDbHash) return null;
    return { gateVersion: decision.gateVersion, sourceDbHash: decision.sourceDbHash };
  },
  run_review: (db, changeId) => {
    const sourceDbHash = resolveBuildSnapshotSource(db, changeId);
    return sourceDbHash ? { gateVersion: "0", sourceDbHash } : null;
  },
  retry_review: (db, changeId) => {
    const sourceDbHash = resolveBuildSnapshotSource(db, changeId);
    return sourceDbHash ? { gateVersion: "0", sourceDbHash } : null;
  },
  enter_qa: (db, changeId) => trustedLatestReviewReportSource(
    db as unknown as ActionContractDb,
    changeId,
  ),
  run_qa: (db, changeId) => trustedLatestReviewReportSource(
    db as unknown as ActionContractDb,
    changeId,
  ),
  merge: (db, changeId) => {
    const readiness = computeMergeReadiness({
      changeId,
      requireApproval: true,
      persist: false,
      db: db as unknown as MergeReadinessDb,
    });
    if (readiness.status !== "ready") return null;
    const gate = db.select().from(stageGates).where(and(
      eq(stageGates.changeId, changeId), eq(stageGates.phase, "Merge"),
    )).orderBy(desc(stageGates.computedAt), desc(stageGates.gateVersion), desc(stageGates.id)).get();
    if (!gate || !isPassingGateStatus(gate.status) || gate.sourceDbHash !== readiness.sourceDbHash) return null;
    return { gateVersion: String(gate.gateVersion), sourceDbHash: readiness.sourceDbHash };
  },
  run_retro: resolveRetroActionAuthority,
  run_delivery: resolveDeliveryActionAuthority,
};

function disabled(actionId: string, reasonCode: string): ProviderActionAuthority {
  return { actionId, enabled: false, gateVersion: "0", sourceDbHash: "__missing_gate__", reasonCode };
}

export function isPassingGateStatus(status: string): boolean {
  return ["pass", "passed", "approved"].includes(status);
}

/**
 * Decides one PRD briefing sub-step from the briefing's own state, mirroring the
 * dispatch precondition its POST enforces:
 *
 *   run_prd_briefing_questions    -> assertCanStartPrdBriefingQuestions
 *   run_prd_briefing_draft        -> assertCanStartPrdBriefingDraft
 *   run_prd_briefing_final_review -> assertCanStartPrdBriefingFinalReview
 *
 * Exported because the read path needs it too. Briefing sub-steps *produce* the
 * PRD stage gate, so they cannot be decided by it -- see the `briefingRun`
 * policy in action-contract-decision-router.
 *
 * The mirror has to hold in BOTH directions. Reporting a step disabled that a
 * POST would accept strands the reader on a phantom blocker (b77c0b2d);
 * reporting one enabled that a POST would 409 is the same defect in reverse --
 * /gate promises an action that cannot be dispatched. Every branch below names
 * the assertion it stands in for, so the two stay reconcilable by reading.
 */
export function resolveBriefingActionAuthority(
  db: AuthorityDb,
  changeId: string,
  actionId: string,
): ProviderActionAuthority {
  const briefing = db.select().from(prdBriefings).where(eq(prdBriefings.changeId, changeId)).get();
  // assertMutable, which all three steps reach: questions and draft through
  // assertIntentCaptured, the final review through assertFreshDraft. A locked
  // briefing is immutable, so no sub-step may run against it. The UI agrees --
  // canAskQuestions/canDraft/canFinalReview each end in `&& !isLocked`.
  if (briefing?.status === "locked") return disabled(actionId, "prd_briefing_locked");
  // assertIntentCaptured
  if (!briefing?.intentText.trim()) return disabled(actionId, "prd_intent_missing");
  // assertNoRunningPrdBriefingRun
  const active = db.select({ id: runs.id }).from(runs).where(and(
    eq(runs.changeId, changeId), eq(runs.phase, "intake"), eq(runs.status, "running"),
  )).get();
  if (active) return disabled(actionId, "provider_job_running");

  const questions = db.select().from(briefingQuestions).where(eq(briefingQuestions.changeId, changeId)).all();
  const draft = db.select().from(prdDrafts).where(eq(prdDrafts.changeId, changeId))
    .orderBy(desc(prdDrafts.version), desc(prdDrafts.createdAt)).get();

  // run_prd_briefing_questions has no precondition of its own beyond the three
  // above. It used to be disabled with prd_questions_have_human_actions once
  // any card was acted on, mirroring assertQuestionsCanBeReplaced; generation
  // now appends a round instead of replacing the set, so an answered card no
  // longer stands in the way of asking again -- and reporting it disabled here
  // would be a phantom-DISABLED verdict against a POST that accepts.
  if (actionId === "run_prd_briefing_draft") {
    // assertQuestionsGenerated / assertCriticalQuestionsHandled. Both read the
    // whole card set, so an open critical card from ANY round still blocks --
    // opening a new round cannot be used to walk past an unanswered one.
    if (questions.length === 0) return disabled(actionId, "prd_questions_missing");
    if (questions.some((question) => question.severity === "critical" && question.status === "open")) {
      return disabled(actionId, "prd_critical_questions_open");
    }
  }
  if (actionId === "run_prd_briefing_final_review") {
    // assertFreshDraft: the draft must exist *and* still match the briefing's
    // current inputs. Existence alone is not the precondition -- answering one
    // more question moves the input hash and POST then fails closed with
    // fresh_prd_draft_required, which is also what the UI reads as `draftFresh`.
    if (!draft) return disabled(actionId, "prd_draft_missing");
    const hashes = readPrdBriefingSourceHashes(briefing.sourceHashesJson);
    if (hashes.draftInputHash !== prdBriefingInputHash(briefing, questions)) {
      return disabled(actionId, "prd_draft_stale");
    }
  }
  const source = draft?.draftHash ?? briefing.sourceHashesJson ?? briefing.updatedAt;
  return { actionId, enabled: true, gateVersion: String(draft?.version ?? 0), sourceDbHash: source, reasonCode: null };
}

export function evaluateProviderActionAuthority(
  db: AuthorityDb,
  input: EnqueuePipelineJobInput,
): ProviderActionAuthority {
  const change = db.select().from(changes).where(eq(changes.id, input.changeId)).get();
  if (!change) return disabled(input.actionId, "change_not_found");
  if (BRIEFING_ACTIONS.has(input.actionId)) {
    return resolveBriefingActionAuthority(db, input.changeId, input.actionId);
  }

  const definition = ACTION_DEFINITIONS.find((entry) => entry.actionId === input.actionId);
  if (!definition) return disabled(input.actionId, "action_not_registered");
  const required = Array.isArray(definition.requiredStatus)
    ? definition.requiredStatus
    : definition.requiredStatus ? [definition.requiredStatus] : [];
  if (required.length > 0 && !required.includes(change.status)) {
    return disabled(input.actionId, "change_status_mismatch");
  }
  const activeJob = db.select({ id: pipelineJobs.id }).from(pipelineJobs).where(and(
    eq(pipelineJobs.changeId, input.changeId),
    eq(pipelineJobs.phase, input.phase),
    inArray(pipelineJobs.status, ["queued", "leased", "running"]),
  )).get();
  if (activeJob) return disabled(input.actionId, "provider_job_running");
  const activeRun = db.select({ id: runs.id }).from(runs).where(and(
    eq(runs.changeId, input.changeId), eq(runs.phase, input.phase), eq(runs.status, "running"),
  )).get();
  if (activeRun && !input.actionId.startsWith("retry_")) {
    return disabled(input.actionId, "provider_run_running");
  }
  if (input.actionId === "retry_qa") {
    const reviewAuthority = trustedLatestReviewReportSource(db as unknown as ActionContractDb, input.changeId);
    if (!reviewAuthority || !hasCurrentQaTestPlanPrerequisite(db, input.changeId)) {
      return disabled(input.actionId, "qa_prerequisite_authority_invalid");
    }
  }
  const directAuthorityResolver = DIRECT_ACTION_AUTHORITY_RESOLVERS[input.actionId];
  if (directAuthorityResolver) {
    const directAuthority = directAuthorityResolver(db, input.changeId);
    if (!directAuthority) {
      const reasonCode = input.actionId === "run_review" || input.actionId === "retry_review"
        ? "review_build_authority_invalid"
        : "action_source_authority_invalid";
      return disabled(input.actionId, reasonCode);
    }
    if (input.actionId === "enter_qa" || input.actionId === "run_qa") {
      if (!hasCurrentQaTestPlanPrerequisite(db, input.changeId)) {
        return disabled(input.actionId, "qa_testplan_authority_invalid");
      }
    }
    return {
      actionId: input.actionId,
      enabled: true,
      gateVersion: directAuthority.gateVersion,
      sourceDbHash: directAuthority.sourceDbHash,
      reasonCode: null,
    };
  }

  const phase = definition.snapshotPhase ?? definition.phase;
  const gate = db.select().from(stageGates).where(and(
    eq(stageGates.changeId, input.changeId), eq(stageGates.phase, phase),
  )).orderBy(desc(stageGates.computedAt), desc(stageGates.gateVersion), desc(stageGates.id)).get();
  const gateVersion = String(gate?.gateVersion ?? 0);
  const sourceDbHash = gate?.sourceDbHash ?? "__missing_gate__";
  if (definition.snapshotPhase && !gate) {
    return disabled(input.actionId, "authority_gate_missing");
  }
  if (definition.snapshotPhase && !gate?.sourceDbHash) {
    return disabled(input.actionId, "authority_gate_source_missing");
  }
  const retryingFailedQa = input.actionId === "retry_qa" && phase === "QA" && gate?.status === "failed";
  if (gate && !isPassingGateStatus(gate.status) && !retryingFailedQa) {
    return disabled(input.actionId, "gate_not_passed");
  }
  if (gate?.sourceDbHash) {
    if (phase === "PRD") {
      const briefing = db.select({ id: prdBriefings.id, status: prdBriefings.status })
        .from(prdBriefings).where(eq(prdBriefings.changeId, input.changeId)).get();
      const draft = db.select({ id: prdDrafts.id }).from(prdDrafts)
        .where(eq(prdDrafts.changeId, input.changeId)).orderBy(desc(prdDrafts.version)).get();
      if (!briefing || !draft || briefing.status !== "locked") {
        return disabled(input.actionId, "prd_authority_incomplete");
      }
      return { actionId: input.actionId, enabled: true, gateVersion, sourceDbHash, reasonCode: null };
    }
    const snapshotResolver = SNAPSHOT_SOURCE_RESOLVERS[phase];
    if (snapshotResolver) {
      const snapshotAuthority = snapshotResolver(db, input.changeId, gate.sourceDbHash);
      if (snapshotAuthority === false) {
        return disabled(input.actionId, "authority_source_ambiguous");
      }
      if (snapshotAuthority === true) {
        return { actionId: input.actionId, enabled: true, gateVersion, sourceDbHash, reasonCode: null };
      }
    }
    // Legacy fallback for phases (or rows) that predate the DB content
    // snapshots consulted above. It pairs stage_runs with business runs by
    // attemptNo, which is only sound for never-retried stages:
    // stage_runs.attemptNo is the governance attempt (increments per retry
    // and per report recompute) while runs.attemptNo is the lease-fence
    // attempt, hardcoded to 1 at enqueue (job-dispatch-service). Phases with
    // a SNAPSHOT_SOURCE_RESOLVERS entry never reach this block when snapshot
    // rows exist; do not extend the attempt pairing to new phases.
    const sourceRuns = db.select({
      id: stageRuns.id,
      attemptNo: stageRuns.attemptNo,
      status: stageRuns.status,
    }).from(stageRuns).where(and(
      eq(stageRuns.changeId, input.changeId),
      eq(stageRuns.phase, phase),
      eq(stageRuns.outputDbHash, gate.sourceDbHash),
    )).all();
    if (sourceRuns.length === 0) return disabled(input.actionId, "authority_source_missing");
    if (sourceRuns.length !== 1) return disabled(input.actionId, "authority_source_ambiguous");
    const sourceRun = sourceRuns[0]!;
    if (phase === "Spec") {
      // Spec governance runs are written by syncSpecStageAuthority on every
      // battle-round sync and human decision, with no business run at all, so
      // no run pairing can exist. The matched stage run's own status is the
      // strongest check available until Spec gets a content resolver.
      if (!isPassingGateStatus(sourceRun.status)) {
        return disabled(input.actionId, "authority_source_not_passed");
      }
      return { actionId: input.actionId, enabled: true, gateVersion, sourceDbHash, reasonCode: null };
    }
    const expectedBusinessPhase = BUSINESS_PHASE_BY_AUTHORITY_PHASE[phase];
    const businessRuns = db.select({ id: runs.id }).from(runs).where(and(
      eq(runs.changeId, input.changeId),
      eq(runs.phase, expectedBusinessPhase),
      eq(runs.attemptNo, sourceRun.attemptNo),
      eq(runs.status, "completed"),
    )).all();
    if (businessRuns.length !== 1) return disabled(input.actionId, "authority_business_run_ambiguous");
    const sourceArtifacts = db.select({ id: artifacts.id }).from(artifacts).where(and(
      eq(artifacts.changeId, input.changeId), eq(artifacts.runId, businessRuns[0]!.id),
    )).all();
    if (sourceArtifacts.length === 0) return disabled(input.actionId, "authority_artifact_missing");
  }
  return { actionId: input.actionId, enabled: true, gateVersion, sourceDbHash, reasonCode: null };
}
