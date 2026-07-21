import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { withSqliteWriteRetry } from "../db/write-boundary";
import {
  battleRounds,
  blueGapReviews,
  briefingQuestions,
  changes,
  events,
  humanDecisions,
  prdBriefings,
  prdDrafts,
  projects,
  redFixClaims,
  requirementGaps,
  runs,
  warReports,
} from "../db/schema";
import type { ChangeStatus } from "../types";
import {
  computeGapCounts,
  effectiveSeverity,
  getSpecActionAvailability,
  isMergeBlockingGap,
  isSpecBlockingGap,
  type RuleGap,
} from "./spec-battle-rules";
import {
  allRounds,
  currentBlockingGaps,
  getBlueGapReviews,
  getDecisions,
  getGaps,
  getRedFixClaims,
  latestRound,
  toRuleGap,
} from "./spec-battle-row-readers";
import { generateSpecReport, getLatestSpecReportForDecision } from "./spec-battle-report-service";
import { inspectArtifactMirrors, renderMirrorsFromDb } from "./artifact-mirror-service";
import {
  parseBlueCritiqueOutput,
  validateBlueCritiqueOutput,
  validateRedSpecLinePayload,
  type ParsedBlueCritiqueOutput,
  type ParsedRedSpecOutput,
} from "./spec-battle-ledger";
import type { SpecRedLinePayload } from "./spec-red-line-protocol";
import { prdStageHashQuestionRows } from "./prd-briefing-ledger";
import {
  completeStageRun,
  computeSourceDbHash,
  getStageAuthority,
  recomputeStageGate,
  startStageRun,
} from "./stage-authority-service";
import { transitionChangeStatus, transitionChangeStatusWithDb } from "./change-status-service";
import type { Provider } from "./provider-selection-service";

export interface BattleParams {
  maxSpecRounds: 1 | 2 | 3 | 4 | 5;
  allowP1Waiver: boolean;
}

export const DEFAULT_BATTLE_PARAMS: BattleParams = {
  maxSpecRounds: 3,
  allowP1Waiver: true,
};

export interface SpecBattleDecisionInput {
  changeId: string;
  action: "approve" | "request_changes" | "return_to_spec" | "waive_p1";
  targetType: "gate" | "requirement_gap" | "finding" | null;
  targetId: string | null;
  reason: string | null;
}

export interface StartSpecBattleRoundResult {
  roundId: string;
  roundNo: number;
  status: string;
}

export interface SpecBattleRedRunClaimResult {
  claimed: boolean;
  reason: "claimed" | "spec_round_running";
  roundId: string;
  roundNo: number;
  runId: string | null;
  previousStatus: string;
  createdRound?: boolean;
}

export interface SpecBattleState {
  latestRound: typeof battleRounds.$inferSelect | null;
  rounds: Array<typeof battleRounds.$inferSelect>;
  gaps: Array<typeof requirementGaps.$inferSelect>;
  fixClaims: Array<typeof redFixClaims.$inferSelect>;
  gapReviews: Array<typeof blueGapReviews.$inferSelect>;
  decisions: Array<typeof humanDecisions.$inferSelect>;
  reportFresh: boolean;
  staleReason: string | null;
  counts: ReturnType<typeof computeGapCounts>;
  roundDelta: {
    resolvedThisRound: number;
    stillOpen: number;
    newlyFound: number;
    notRechecked: number;
  };
}

export class SpecBattleError extends Error {
  constructor(
    public readonly code: string,
    message = code
  ) {
    super(message);
    this.name = "SpecBattleError";
  }
}

type AnyTableWithId = {
  id: unknown;
};

function nowISO(): string {
  return new Date().toISOString();
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nextRandomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function recordPostCommitSideEffectFailure(input: {
  changeId: string;
  roundId: string;
  sideEffect: string;
  error: unknown;
}): void {
  try {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    db.insert(events).values({
      id: nextRandomId("EVT"),
      changeId: input.changeId,
      runId: null,
      type: "spec_post_commit_side_effect_failed",
      message: `${input.sideEffect} failed after DB commit: ${message}`,
      rawJson: JSON.stringify({
        sideEffect: input.sideEffect,
        roundId: input.roundId,
        message,
      }),
      createdAt: nowISO(),
    }).run();
  } catch {
    // Best-effort telemetry only. The DB-first state has already committed.
  }
}

function runPostCommitSideEffect(input: {
  changeId: string;
  roundId: string;
  sideEffect: string;
  run: () => void;
}): void {
  try {
    input.run();
  } catch (err) {
    recordPostCommitSideEffectFailure({
      changeId: input.changeId,
      roundId: input.roundId,
      sideEffect: input.sideEffect,
      error: err,
    });
  }
}

async function nextId(table: AnyTableWithId, prefix: string): Promise<string> {
  void table;
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function getChange(changeId: string) {
  return db.select().from(changes).where(eq(changes.id, changeId)).get();
}

function getProjectForChange(changeId: string) {
  const change = getChange(changeId);
  if (!change) throw new SpecBattleError("change_not_found", `Change not found: ${changeId}`);

  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new SpecBattleError("project_not_found", `Project not found: ${change.projectId}`);

  return { change, project };
}

function changeDir(repoPath: string, changeId: string): string {
  return path.join(repoPath, ".ship", "changes", changeId);
}

function roundPrefix(roundNo: number): string {
  return `spec-round-${String(roundNo).padStart(2, "0")}`;
}

function roundArtifactPath(repoPath: string, changeId: string, roundNo: number, suffix: string): string {
  return path.join(changeDir(repoPath, changeId), "rounds", `${roundPrefix(roundNo)}-${suffix}`);
}

function hasTrustedRedArtifact(input: {
  repoPath: string;
  changeId: string;
  roundNo: number;
  artifactPath: string | null;
  artifactHash: string | null;
}): boolean {
  if (!input.artifactPath || !input.artifactHash) return false;
  const expectedPath = path.resolve(roundArtifactPath(
    input.repoPath,
    input.changeId,
    input.roundNo,
    "red.md",
  ));
  if (path.resolve(input.artifactPath) !== expectedPath) return false;
  try {
    const stat = fs.lstatSync(expectedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const repoRealPath = fs.realpathSync(input.repoPath);
    const artifactRealPath = fs.realpathSync(expectedPath);
    if (!artifactRealPath.startsWith(`${repoRealPath}${path.sep}`)) return false;
    return sha256Text(fs.readFileSync(expectedPath, "utf-8")) === input.artifactHash;
  } catch {
    return false;
  }
}

const PASSING_STAGE_GATE_STATUSES = new Set(["pass", "passed", "passed_with_warnings"]);

function latestPrdDraft(changeId: string): typeof prdDrafts.$inferSelect | null {
  return db
    .select()
    .from(prdDrafts)
    .where(eq(prdDrafts.changeId, changeId))
    .all()
    .sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

function prdAuthorityRows(changeId: string) {
  const briefing = db.select().from(prdBriefings).where(eq(prdBriefings.changeId, changeId)).get() ?? null;
  // Same key as prd-briefing-service.getQuestions: oldest round first. The PRD
  // stage hash no longer depends on this (prdStageHashQuestionRows normalizes
  // its own order), but `deferredQuestions` below is handed to Spec Battle as a
  // list, and it should reach it in the order the briefing room shows it.
  const questions = db
    .select()
    .from(briefingQuestions)
    .where(eq(briefingQuestions.changeId, changeId))
    .all()
    .sort((a, b) =>
      a.roundNo - b.roundNo
      || a.createdAt.localeCompare(b.createdAt)
      || a.id.localeCompare(b.id));
  return {
    briefing,
    questions,
    latestDraft: latestPrdDraft(changeId),
  };
}

function prdSourceDbHash(changeId: string): string {
  const rows = prdAuthorityRows(changeId);
  return computeSourceDbHash({
    changeId,
    phase: "PRD",
    rows: [
      { table: "prd_briefings", row: rows.briefing },
      { table: "briefing_questions", rows: prdStageHashQuestionRows(rows.questions) },
      { table: "prd_drafts.latest", row: rows.latestDraft },
    ],
  });
}

function assertLockedPrdDbBaseline(changeId: string) {
  const prdRows = prdAuthorityRows(changeId);
  if (!prdRows.briefing || prdRows.briefing.status !== "locked") {
    throw new SpecBattleError("prd_baseline_missing", "Spec Battle requires a locked PRD DB baseline");
  }
  if (!prdRows.latestDraft) {
    throw new SpecBattleError("prd_baseline_missing", "Spec Battle requires a locked PRD draft DB row");
  }

  const prdStage = getStageAuthority(changeId, "PRD");
  const prdGate = prdStage.latestGate;
  if (!prdGate) {
    throw new SpecBattleError("prd_gate_missing", "Spec Battle requires a PRD DB gate");
  }
  if (!PASSING_STAGE_GATE_STATUSES.has(prdGate.status)) {
    throw new SpecBattleError("prd_gate_blocked", `PRD gate is ${prdGate.status}`);
  }

  const currentPrdSourceHash = prdSourceDbHash(changeId);
  if (prdGate.sourceDbHash !== currentPrdSourceHash) {
    throw new SpecBattleError("prd_gate_stale", "PRD gate source hash is stale");
  }

  return {
    briefing: prdRows.briefing,
    questions: prdRows.questions,
    latestDraft: prdRows.latestDraft,
    prdGate,
    prdSourceDbHash: currentPrdSourceHash,
  };
}

function specAuthorityRows(changeId: string) {
  return {
    rounds: allRounds(changeId),
    gaps: getGaps(changeId),
    fixClaims: getRedFixClaims(changeId),
    gapReviews: getBlueGapReviews(changeId),
    decisions: getDecisions(changeId),
    reports: db
      .select()
      .from(warReports)
      .where(and(eq(warReports.changeId, changeId), eq(warReports.phase, "Spec")))
      .all()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  };
}

function specSourceDbHash(changeId: string): string {
  const prdStage = getStageAuthority(changeId, "PRD");
  const rows = specAuthorityRows(changeId);
  return computeSourceDbHash({
    changeId,
    phase: "Spec",
    rows: [
      { table: "stage_gates.PRD.source", sourceDbHash: prdStage.latestGate?.sourceDbHash ?? null },
      { table: "battle_rounds", rows: rows.rounds },
      { table: "requirement_gaps", rows: rows.gaps },
      { table: "red_fix_claims", rows: rows.fixClaims },
      { table: "blue_gap_reviews", rows: rows.gapReviews },
      { table: "human_decisions", rows: rows.decisions },
      { table: "war_reports.Spec", rows: rows.reports },
    ],
  });
}

function readDbAuthoritySnapshot(changeId: string) {
  const prd = assertLockedPrdDbBaseline(changeId);
  const rows = specAuthorityRows(changeId);
  const deferredQuestions = prd.questions.filter((question) => question.status === "deferred");
  const sourceDbHash = computeSourceDbHash({
    changeId,
    phase: "Spec",
    rows: [
      { table: "stage_gates.PRD", id: prd.prdGate.id, sourceDbHash: prd.prdGate.sourceDbHash },
      { table: "prd_briefings.locked", row: prd.briefing },
      { table: "prd_drafts.latest", row: prd.latestDraft },
      { table: "briefing_questions.deferred", rows: prdStageHashQuestionRows(deferredQuestions) },
      { table: "battle_rounds", rows: rows.rounds },
      { table: "requirement_gaps", rows: rows.gaps },
      { table: "red_fix_claims", rows: rows.fixClaims },
      { table: "blue_gap_reviews", rows: rows.gapReviews },
      { table: "human_decisions", rows: rows.decisions },
      { table: "war_reports.Spec", rows: rows.reports },
    ],
  });

  return {
    authority: "db",
    sourceDbHash,
    prd: {
      briefingId: prd.briefing.id,
      status: prd.briefing.status,
      lockedAt: prd.briefing.lockedAt,
      draftId: prd.latestDraft.id,
      draftVersion: prd.latestDraft.version,
      draftHash: prd.latestDraft.draftHash,
      markdown: prd.latestDraft.markdown,
      prdGateId: prd.prdGate.id,
      prdGateStatus: prd.prdGate.status,
      prdGateSourceDbHash: prd.prdGate.sourceDbHash,
      prdSourceDbHash: prd.prdSourceDbHash,
    },
    deferredQuestions: deferredQuestions.map((question) => ({
      id: question.id,
      severity: question.severity,
      question: question.question,
      suggestedDefault: question.suggestedDefault,
      answer: question.answer,
    })),
    currentSpecDb: {
      rounds: rows.rounds.map((round) => ({ id: round.id, roundNo: round.roundNo, status: round.status })),
      openSpecBlockingGapIds: currentBlockingGaps(changeId).map((gap) => gap.canonicalGapId),
    },
    mirrorWarnings: inspectArtifactMirrors(changeId, "PRD"),
  };
}

function assertCurrentRound(changeId: string, round: typeof battleRounds.$inferSelect) {
  if (round.changeId !== changeId) {
    throw new SpecBattleError("round_change_mismatch");
  }
  const current = latestRound(changeId);
  if (!current || current.id !== round.id) {
    throw new SpecBattleError("round_not_current");
  }
}

function computeStateRoundDelta(
  round: typeof battleRounds.$inferSelect | null,
  gaps: Array<typeof requirementGaps.$inferSelect>,
  reviews: Array<typeof blueGapReviews.$inferSelect>
): SpecBattleState["roundDelta"] {
  if (!round) {
    return {
      resolvedThisRound: 0,
      stillOpen: 0,
      newlyFound: 0,
      notRechecked: 0,
    };
  }

  const latestReviews = reviews.filter((review) => review.roundId === round.id);
  const reviewsByCanonicalGapId = new Map(
    latestReviews.map((review) => [review.canonicalGapId, review])
  );
  const previousBlocking = gaps.filter((gap) => {
    const severity = effectiveSeverity(toRuleGap(gap));
    return gap.firstSeenRoundId !== round.id &&
      (severity === "P0" || severity === "P1") &&
      gap.status !== "waived" &&
      gap.status !== "overridden" &&
      !(gap.status === "resolved" && gap.resolvedByRoundId !== round.id);
  });
  const unresolvedReviewVerdicts = new Set(["still_open", "downgraded", "needs_human_decision"]);

  return {
    resolvedThisRound: latestReviews.filter((review) => review.verdict === "resolved").length,
    stillOpen: previousBlocking.filter((gap) => {
      const review = reviewsByCanonicalGapId.get(gap.canonicalGapId);
      return !review || unresolvedReviewVerdicts.has(review.verdict);
    }).length,
    newlyFound: gaps.filter((gap) => gap.firstSeenRoundId === round.id).length,
    notRechecked: previousBlocking.filter((gap) => !reviewsByCanonicalGapId.has(gap.canonicalGapId)).length,
  };
}

function refreshMirrors(changeId: string) {
  const { project } = getProjectForChange(changeId);
  const sourceDbHash = specSourceDbHash(changeId);
  renderMirrorsFromDb({
    changeId,
    repoPath: project.repoPath,
    mirrors: [
      {
        phase: "Spec",
        artifactType: "requirement_gaps",
        fileName: "requirement-gaps.json",
        schemaVersion: "spec-battle.v1",
        sourceDbHash,
        payload: getGaps(changeId),
      },
      {
        phase: "Spec",
        artifactType: "red_fix_claims",
        fileName: "red-fix-claims.json",
        schemaVersion: "spec-battle.v1",
        sourceDbHash,
        payload: getRedFixClaims(changeId),
      },
      {
        phase: "Spec",
        artifactType: "blue_gap_reviews",
        fileName: "blue-gap-reviews.json",
        schemaVersion: "spec-battle.v1",
        sourceDbHash,
        payload: getBlueGapReviews(changeId),
      },
      {
        phase: "Spec",
        artifactType: "human_decisions",
        fileName: "human-decisions.json",
        schemaVersion: "spec-battle.v1",
        sourceDbHash,
        payload: getDecisions(changeId),
      },
    ],
  });
}

function specGateBlockers(changeId: string): Array<{ id: string; severity: "P0" | "P1"; title: string }> {
  return currentBlockingGaps(changeId).map((gap) => ({
    id: gap.id,
    severity: effectiveSeverity(toRuleGap(gap)) as "P0" | "P1",
    title: gap.title,
  }));
}

function syncSpecStageAuthority(changeId: string, provider?: Provider): void {
  const rows = specAuthorityRows(changeId);
  const sourceDbHash = specSourceDbHash(changeId);
  const counts = computeGapCounts(rows.gaps.map(toRuleGap));
  const blockers = specGateBlockers(changeId);
  const freshness = getLatestSpecReportForDecision(changeId);
  const status = blockers.length > 0 ? "blocked" : freshness.reportFresh ? "pass" : "pending";
  const run = startStageRun({
    changeId,
    phase: "Spec",
    inputDbHash: sourceDbHash,
    sourceLineage: {
      tables: ["battle_rounds", "requirement_gaps", "red_fix_claims", "blue_gap_reviews", "human_decisions"],
      prdSourceDbHash: getStageAuthority(changeId, "PRD").latestGate?.sourceDbHash ?? null,
    },
    provider: provider ?? null,
  });
  completeStageRun({
    runId: run.id,
    status: status === "pass" ? "passed" : "issues_found",
    counts,
    reportDbHash: sourceDbHash,
    staleReason: freshness.reportFresh ? null : freshness.staleReason,
  });
  recomputeStageGate({
    changeId,
    phase: "Spec",
    status,
    blockers,
    freshness: {
      source: "db",
      reportFresh: freshness.reportFresh,
      staleReason: freshness.staleReason,
      reportId: freshness.reportId,
      prdSourceDbHash: getStageAuthority(changeId, "PRD").latestGate?.sourceDbHash ?? null,
    },
    requiredActions: status === "pass" ? [] : blockers,
    sourceDbHash,
  });
}

/**
 * Recomputes the Spec gate and mirrors after something OUTSIDE a round changed
 * `requirement_gaps`.
 *
 * Same shape as the `waive_p1` branch of applySpecBattleDecision, which is the
 * existing precedent for a human action that closes a gap between rounds. It
 * deliberately does not call `markSpecBattleReportsStale`: the war report keys
 * its freshness off `reportSourceHashes`, which hashes the gap rows, so a
 * changed gap already reports `source_changed` on its own. Stamping the report
 * stale as well would write to `war_reports`, which is itself inside
 * `specSourceDbHash` -- moving a hash to record a fact the hash already implies.
 */
export function resyncSpecStageAfterGapChange(changeId: string): void {
  syncSpecStageAuthority(changeId);
  refreshMirrors(changeId);
}

function updateChangeStatus(changeId: string, status: ChangeStatus, blockedPhase?: string | null) {
  transitionChangeStatus({
    changeId,
    to: status,
    blockedPhase,
    message: `Spec battle status -> ${status}`,
    rawJson: { source: "spec_battle" },
  });
}

function findGapByTarget(changeId: string, targetId: string | null) {
  if (!targetId) return null;
  return getGaps(changeId).find((gap) => gap.id === targetId || gap.canonicalGapId === targetId) ?? null;
}

async function recordDecision(input: SpecBattleDecisionInput, roundId: string | null, reportHash: string | null) {
  const id = await nextId(humanDecisions, "DEC");
  db.insert(humanDecisions).values({
    id,
    changeId: input.changeId,
    roundId,
    gate: input.action === "approve" ? "spec" : "spec",
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    reportHash,
    createdBy: "human",
    createdAt: nowISO(),
  }).run();
}

function markSpecGateApproved(changeId: string) {
  db.update(changes)
    .set({
      gateState: "spec",
      updatedAt: nowISO(),
    })
    .where(eq(changes.id, changeId))
    .run();
}

function hasApprovedSpecGateDecision(changeId: string, roundId: string): boolean {
  return getDecisions(changeId).some((decision) => {
    return decision.roundId === roundId &&
      decision.gate === "spec" &&
      decision.action === "approve" &&
      decision.targetType === "gate";
  });
}

function hasNoSpecBlockers(changeId: string): boolean {
  const counts = computeGapCounts(getGaps(changeId).map(toRuleGap));
  return counts.blockingP0 === 0 && counts.blockingP1 === 0;
}

function computeNewSpecRoundRow(
  changeId: string,
  params: BattleParams,
  id: string
): { roundNo: number; row: typeof battleRounds.$inferInsert } {
  const inputSnapshot = readDbAuthoritySnapshot(changeId);
  const rounds = allRounds(changeId);
  const roundNo = (rounds.at(-1)?.roundNo ?? 0) + 1;
  const now = nowISO();
  return {
    roundNo,
    row: {
      id,
      changeId,
      phase: "Spec",
      template: "SPEC_BATTLE_MVP",
      roundNo,
      status: "not_started",
      redUnit: "SPEC_WRITER",
      blueUnit: "REQUIREMENT_CRITIC",
      inputSnapshotJson: JSON.stringify(inputSnapshot),
      paramsJson: JSON.stringify(params),
      redArtifactPath: null,
      redArtifactHash: null,
      blueArtifactPath: null,
      blueArtifactHash: null,
      reportPath: null,
      supersededByRoundId: null,
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function createRound(changeId: string, params: BattleParams): Promise<StartSpecBattleRoundResult> {
  getProjectForChange(changeId);
  const id = await nextId(battleRounds, "BRD");
  const { roundNo, row } = computeNewSpecRoundRow(changeId, params, id);

  db.insert(battleRounds).values(row).run();

  updateChangeStatus(changeId, "SPECCING");
  syncSpecStageAuthority(changeId);
  refreshMirrors(changeId);
  return { roundId: id, roundNo, status: "not_started" };
}

export async function startSpecBattleRound(
  changeId: string,
  params: BattleParams = DEFAULT_BATTLE_PARAMS
): Promise<StartSpecBattleRoundResult> {
  const { change } = getProjectForChange(changeId);
  const rounds = allRounds(changeId);
  if (rounds.length >= params.maxSpecRounds) {
    throw new SpecBattleError("round_limit_reached");
  }
  if (!["INTAKE_READY", "SPECCING"].includes(change.status)) {
    throw new SpecBattleError("invalid_status", `Invalid status: ${change.status}`);
  }

  const current = rounds.at(-1);
  if (current && ["not_started", "red_running", "blue_running"].includes(current.status)) {
    throw new SpecBattleError("round_running");
  }

  return createRound(changeId, params);
}

function parseSpecRunClaim(rawJson: string | null): {
  idempotencyKey?: string;
  roundId?: string;
  runId?: string;
} | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const claim = (parsed as { specRunClaim?: unknown }).specRunClaim;
    if (!claim || typeof claim !== "object") return null;
    return claim as { idempotencyKey?: string; roundId?: string; runId?: string };
  } catch {
    return null;
  }
}

export function claimSpecBattleRedRun(input: {
  changeId: string;
  idempotencyKey?: string;
  provider?: Provider;
}): SpecBattleRedRunClaimResult {
  const { change, project } = getProjectForChange(input.changeId);
  const idempotencyKey = input.idempotencyKey?.trim() || nextRandomId("spec-run");

  const claim: SpecBattleRedRunClaimResult = db.transaction((tx) => {
    const rounds = tx
      .select()
      .from(battleRounds)
      .where(eq(battleRounds.changeId, input.changeId))
      .all()
      .sort((a, b) => a.roundNo - b.roundNo || a.createdAt.localeCompare(b.createdAt));
    let round = rounds.at(-1);
    let createdRound = false;
    if (!round) {
      if (!["INTAKE_READY", "SPECCING"].includes(change.status)) {
        throw new SpecBattleError("invalid_status", `Invalid status: ${change.status}`);
      }
      if (rounds.length >= DEFAULT_BATTLE_PARAMS.maxSpecRounds) {
        throw new SpecBattleError("round_limit_reached");
      }
      const inputSnapshot = readDbAuthoritySnapshot(input.changeId);
      const now = nowISO();
      const roundId = nextRandomId("BRD");
      tx.insert(battleRounds).values({
        id: roundId,
        changeId: input.changeId,
        phase: "Spec",
        template: "SPEC_BATTLE_MVP",
        roundNo: 1,
        status: "not_started",
        redUnit: "SPEC_WRITER",
        blueUnit: "REQUIREMENT_CRITIC",
        inputSnapshotJson: JSON.stringify(inputSnapshot),
        paramsJson: JSON.stringify(DEFAULT_BATTLE_PARAMS),
        redArtifactPath: null,
        redArtifactHash: null,
        blueArtifactPath: null,
        blueArtifactHash: null,
        reportPath: null,
        supersededByRoundId: null,
        startedAt: now,
        endedAt: null,
        createdAt: now,
        updatedAt: now,
      }).run();
      transitionChangeStatusWithDb(tx as unknown as typeof db, {
        changeId: input.changeId,
        to: "SPECCING",
        message: "Spec battle claimed red run",
        rawJson: { source: "spec_battle_claim" },
      });
      round = tx.select().from(battleRounds).where(eq(battleRounds.id, roundId)).get();
      createdRound = true;
    }
    if (!round) throw new SpecBattleError("round_not_found");

    const existingClaim = tx
      .select()
      .from(events)
      .where(and(eq(events.changeId, input.changeId), eq(events.type, "spec_run_claim")))
      .all()
      .map((event) => parseSpecRunClaim(event.rawJson))
      .find((claim) => claim?.idempotencyKey === idempotencyKey);
    if (existingClaim?.roundId === round.id) {
      return {
        claimed: false,
        reason: "spec_round_running",
        roundId: round.id,
        roundNo: round.roundNo,
        runId: existingClaim.runId ?? null,
        previousStatus: round.status,
        createdRound,
      };
    }

    if (round.status === "red_running" || round.status === "blue_running") {
      const activeSpecRun = tx
        .select()
        .from(runs)
        .where(and(eq(runs.changeId, input.changeId), eq(runs.phase, "spec"), eq(runs.status, "running")))
        .all()
        .at(-1);
      return {
        claimed: false,
        reason: "spec_round_running",
        roundId: round.id,
        roundNo: round.roundNo,
        runId: activeSpecRun?.id ?? null,
        previousStatus: round.status,
        createdRound,
      };
    }

    if (round.status !== "not_started" && round.status !== "failed") {
      throw new SpecBattleError("round_not_ready");
    }

    const resumeBlue = round.status === "failed"
      && hasTrustedRedArtifact({
        repoPath: project.repoPath,
        changeId: input.changeId,
        roundNo: round.roundNo,
        artifactPath: round.redArtifactPath,
        artifactHash: round.redArtifactHash,
      })
      && !round.blueArtifactPath
      && !round.blueArtifactHash;
    const now = nowISO();
    const runId = nextRandomId("RUN");
    tx.insert(runs).values({
      id: runId,
      changeId: input.changeId,
      phase: "spec",
      status: "running",
      startedAt: now,
      endedAt: null,
      summary: null,
      provider: input.provider ?? (change.provider as Provider),
    }).run();
    tx.insert(events).values({
      id: nextRandomId("EVT"),
      changeId: input.changeId,
      runId,
      type: "spec_run_claim",
      message: resumeBlue ? "Spec blue provider retry claimed" : "Spec red provider run claimed",
      rawJson: JSON.stringify({
        specRunClaim: {
          schemaVersion: "spec_run_claim/v1",
          idempotencyKey,
          roundId: round.id,
          runId,
          previousStatus: round.status,
          resumedPhase: resumeBlue ? "spec_critic" : "spec",
        },
      }),
      createdAt: now,
    }).run();
    const updateResult = tx.update(battleRounds)
      .set({
        status: resumeBlue ? "blue_running" : "red_running",
        redArtifactPath: resumeBlue ? round.redArtifactPath : null,
        redArtifactHash: resumeBlue ? round.redArtifactHash : null,
        blueArtifactPath: null,
        blueArtifactHash: null,
        reportPath: null,
        endedAt: null,
        updatedAt: now,
      })
      .where(and(eq(battleRounds.id, round.id), eq(battleRounds.status, round.status)))
      .run();
    if (updateResult.changes !== 1) {
      throw new SpecBattleError("spec_round_claim_conflict");
    }

    return {
      claimed: true,
      reason: "claimed",
      roundId: round.id,
      roundNo: round.roundNo,
      runId,
      previousStatus: round.status,
      createdRound,
    };
  });
  if (claim.createdRound) {
    syncSpecStageAuthority(input.changeId, input.provider);
    refreshMirrors(input.changeId);
  }
  return claim;
}

type CompleteRedSpecRoundInput = {
  changeId: string;
  roundId: string;
  provider?: Provider;
} & (
  | { markdown: string; redOutput?: never }
  | { redOutput: SpecRedLinePayload; markdown?: never }
);

/**
 * The two variants are two different things a caller can hand over, and telling
 * them apart is the fix for the round that used to lose every fix claim.
 *
 * A single `markdown: string` parameter used to mean whichever of three things
 * JSON.parse happened to make of it: a payload when it parsed, a literal
 * document when it did not, and -- for a real payload with one stray line
 * appended -- a literal document that swallowed the claims and reported
 * nothing. Production round 7 carried 11 claims through that path on the sole
 * grounds that RedSpecOutputSchema tolerated unknown keys.
 *
 * `markdown` is now taken literally: a document, zero claims. Nothing is parsed
 * out of it, so nothing can be silently lost from it.
 */
function normalizedRedOutput(input: CompleteRedSpecRoundInput): ParsedRedSpecOutput {
  if (input.redOutput !== undefined) {
    const validated = validateRedSpecLinePayload(input.redOutput);
    if (!validated.success) throw validated.error;
    return {
      prdDeltaMarkdown: validated.data.markdown,
      fixClaims: validated.data.fixClaims,
    };
  }
  return { prdDeltaMarkdown: input.markdown, fixClaims: [] };
}

export async function completeRedSpecRound(input: CompleteRedSpecRoundInput): Promise<void> {
  const { project } = getProjectForChange(input.changeId);
  const redOutput = normalizedRedOutput(input);
  const now = nowISO();
  const redHash = sha256Text(redOutput.prdDeltaMarkdown);

  const { filePath } = db.transaction((tx) => {
    const round = tx.select().from(battleRounds).where(eq(battleRounds.id, input.roundId)).get();
    if (!round) throw new SpecBattleError("round_not_found");
    if (round.changeId !== input.changeId) throw new SpecBattleError("round_change_mismatch");
    const current = tx
      .select()
      .from(battleRounds)
      .where(eq(battleRounds.changeId, input.changeId))
      .all()
      .sort((a, b) => a.roundNo - b.roundNo || a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    if (!current || current.id !== round.id) throw new SpecBattleError("round_not_current");
    if (round.status !== "red_running") throw new SpecBattleError("round_not_ready");

    const filePath = roundArtifactPath(project.repoPath, input.changeId, round.roundNo, "red.md");
    for (const claim of redOutput.fixClaims) {
      const gap = tx
        .select()
        .from(requirementGaps)
        .where(and(
          eq(requirementGaps.changeId, input.changeId),
          eq(requirementGaps.canonicalGapId, claim.canonicalGapId)
        ))
        .get();
      const id = nextRandomId("RFC");
      tx.insert(redFixClaims).values({
        id,
        changeId: input.changeId,
        roundId: input.roundId,
        gapId: gap?.id ?? null,
        canonicalGapId: claim.canonicalGapId,
        claimStatus: claim.claimStatus,
        claimSummary: claim.claimSummary,
        evidence: claim.evidence,
        artifactPath: claim.artifactPath,
        sourceHashesJson: JSON.stringify({ roundId: input.roundId, redHash }),
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    tx.update(battleRounds)
      .set({
        status: "blue_running",
        redArtifactPath: filePath,
        redArtifactHash: redHash,
        updatedAt: now,
      })
      .where(eq(battleRounds.id, input.roundId))
      .run();

    return { filePath };
  });

  runPostCommitSideEffect({
    changeId: input.changeId,
    roundId: input.roundId,
    sideEffect: "red_artifact_write",
    run: () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, redOutput.prdDeltaMarkdown);
    },
  });
  runPostCommitSideEffect({
    changeId: input.changeId,
    roundId: input.roundId,
    sideEffect: "refresh_mirrors",
    run: () => refreshMirrors(input.changeId),
  });
  runPostCommitSideEffect({
    changeId: input.changeId,
    roundId: input.roundId,
    sideEffect: "sync_spec_stage_authority",
    run: () => syncSpecStageAuthority(input.changeId, input.provider),
  });
}

type CompleteBlueCritiqueInput = {
  changeId: string;
  roundId: string;
  provider?: Provider;
} & (
  | { blueJson: string; blueCritique?: never }
  | { blueCritique: ParsedBlueCritiqueOutput; blueJson?: never }
);

function normalizedBlueCritique(input: CompleteBlueCritiqueInput): ParsedBlueCritiqueOutput {
  if ("blueCritique" in input) {
    const validated = validateBlueCritiqueOutput(input.blueCritique);
    if (!validated.success) throw validated.error;
    return validated.data;
  }
  return parseBlueCritiqueOutput(input.blueJson);
}

export async function completeBlueCritique(input: CompleteBlueCritiqueInput): Promise<void> {
  const { project } = getProjectForChange(input.changeId);
  const parsed = normalizedBlueCritique(input);

  const now = nowISO();
  const blueHash = sha256Text(JSON.stringify(parsed));
  const sourceHashesJson = JSON.stringify({ roundId: input.roundId, blueHash });

  const { bluePath } = db.transaction((tx) => {
    const round = tx.select().from(battleRounds).where(eq(battleRounds.id, input.roundId)).get();
    if (!round) throw new SpecBattleError("round_not_found");
    if (round.changeId !== input.changeId) throw new SpecBattleError("round_change_mismatch");
    const current = tx
      .select()
      .from(battleRounds)
      .where(eq(battleRounds.changeId, input.changeId))
      .all()
      .sort((a, b) => a.roundNo - b.roundNo || a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    if (!current || current.id !== round.id) throw new SpecBattleError("round_not_current");
    if (round.status !== "blue_running") throw new SpecBattleError("round_not_ready");

    const bluePath = roundArtifactPath(project.repoPath, input.changeId, round.roundNo, "blue.json");
    const resolvedByReviewCanonicalGapIds = new Set<string>();
    for (const review of parsed.gapReviews) {
      const gap = tx
        .select()
        .from(requirementGaps)
        .where(and(
          eq(requirementGaps.changeId, input.changeId),
          eq(requirementGaps.canonicalGapId, review.canonicalGapId)
        ))
        .get();
      const id = nextRandomId("BGR");
      tx.insert(blueGapReviews).values({
        id,
        changeId: input.changeId,
        roundId: input.roundId,
        gapId: gap?.id ?? null,
        canonicalGapId: review.canonicalGapId,
        verdict: review.verdict,
        reviewSummary: review.reviewSummary,
        evidence: review.evidence,
        resolutionEvidence: review.resolutionEvidence,
        downgradedTo: review.downgradedTo,
        sourceHashesJson,
        createdAt: now,
        updatedAt: now,
      }).run();

      if (!gap) continue;

      if (review.verdict === "resolved") {
        tx.update(requirementGaps)
          .set({
            lastEvaluatedRoundId: input.roundId,
            resolvedByRoundId: input.roundId,
            status: "resolved",
            resolutionEvidence: review.resolutionEvidence ?? review.evidence,
            specBlocking: 0,
            mergeBlocking: 0,
            sourceHashesJson,
            updatedAt: now,
            closedAt: now,
          })
          .where(eq(requirementGaps.id, gap.id))
          .run();
        resolvedByReviewCanonicalGapIds.add(review.canonicalGapId);
        continue;
      }

      if (review.verdict === "downgraded" && review.downgradedTo) {
        const downgradedRuleGap: RuleGap = {
          id: gap.id,
          originalSeverity: gap.originalSeverity as RuleGap["originalSeverity"],
          severity: gap.severity as RuleGap["severity"],
          downgradedTo: review.downgradedTo,
          status: "downgraded",
        };
        tx.update(requirementGaps)
          .set({
            lastEvaluatedRoundId: input.roundId,
            status: "downgraded",
            downgradedTo: review.downgradedTo,
            downgradeReason: review.reviewSummary,
            specBlocking: isSpecBlockingGap(downgradedRuleGap) ? 1 : 0,
            mergeBlocking: isMergeBlockingGap(downgradedRuleGap) ? 1 : 0,
            sourceHashesJson,
            updatedAt: now,
            closedAt: null,
          })
          .where(eq(requirementGaps.id, gap.id))
          .run();
        continue;
      }

      if (review.verdict === "still_open" || review.verdict === "needs_human_decision") {
        const openRuleGap: RuleGap = {
          ...toRuleGap(gap),
          status: "open",
        };
        tx.update(requirementGaps)
          .set({
            lastEvaluatedRoundId: input.roundId,
            status: "open",
            evidence: review.evidence,
            specBlocking: isSpecBlockingGap(openRuleGap) ? 1 : 0,
            mergeBlocking: isMergeBlockingGap(openRuleGap) ? 1 : 0,
            sourceHashesJson,
            updatedAt: now,
            closedAt: null,
          })
          .where(eq(requirementGaps.id, gap.id))
          .run();
      }
    }

    for (const item of parsed.requirementGaps ?? []) {
      if (resolvedByReviewCanonicalGapIds.has(item.canonicalGapId)) continue;

      const existing = tx
        .select()
        .from(requirementGaps)
        .where(and(
          eq(requirementGaps.changeId, input.changeId),
          eq(requirementGaps.canonicalGapId, item.canonicalGapId)
        ))
        .get();

      const ruleGap: RuleGap = {
        id: existing?.id ?? item.canonicalGapId,
        severity: item.severity,
        originalSeverity: (existing?.originalSeverity as RuleGap["originalSeverity"] | undefined) ?? item.severity,
        downgradedTo: (existing?.downgradedTo as RuleGap["downgradedTo"] | undefined) ?? null,
        status: "open",
      };

      const patch = {
        lastEvaluatedRoundId: input.roundId,
        title: item.title,
        category: item.category,
        evidence: item.evidence,
        affectedArtifactsJson: JSON.stringify(item.affectedArtifacts ?? []),
        proposedSpecPatch: item.proposedSpecPatch ?? null,
        severity: item.severity,
        status: "open",
        specBlocking: isSpecBlockingGap(ruleGap) ? 1 : 0,
        mergeBlocking: isMergeBlockingGap(ruleGap) ? 1 : 0,
        sourceHashesJson,
        updatedAt: now,
        closedAt: null,
      };

      if (existing) {
        tx.update(requirementGaps)
          .set(patch)
          .where(eq(requirementGaps.id, existing.id))
          .run();
      } else {
        const id = nextRandomId("GAP");
        tx.insert(requirementGaps).values({
          id,
          changeId: input.changeId,
          canonicalGapId: item.canonicalGapId,
          firstSeenRoundId: input.roundId,
          lastEvaluatedRoundId: input.roundId,
          resolvedByRoundId: null,
          sourcePhase: "Spec",
          sourceUnit: "REQUIREMENT_CRITIC",
          title: item.title,
          category: item.category,
          evidence: item.evidence,
          affectedArtifactsJson: JSON.stringify(item.affectedArtifacts ?? []),
          proposedSpecPatch: item.proposedSpecPatch ?? null,
          severity: item.severity,
          originalSeverity: item.severity,
          downgradedTo: null,
          status: "open",
          resolutionEvidence: null,
          waiverReason: null,
          downgradeReason: null,
          overrideReason: null,
          specBlocking: isSpecBlockingGap(ruleGap) ? 1 : 0,
          mergeBlocking: isMergeBlockingGap(ruleGap) ? 1 : 0,
          sourceHashesJson,
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        }).run();
      }
    }

    tx.update(battleRounds)
      .set({
        status: "report_ready",
        blueArtifactPath: bluePath,
        blueArtifactHash: blueHash,
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(battleRounds.id, input.roundId))
      .run();

    transitionChangeStatusWithDb(tx as unknown as typeof db, {
      changeId: input.changeId,
      to: "SPEC_READY",
      message: "Spec battle status -> SPEC_READY",
      rawJson: { source: "spec_battle" },
    });

    return { bluePath };
  });

  runPostCommitSideEffect({
    changeId: input.changeId,
    roundId: input.roundId,
    sideEffect: "blue_artifact_write",
    run: () => {
      fs.mkdirSync(path.dirname(bluePath), { recursive: true });
      fs.writeFileSync(bluePath, `${JSON.stringify(parsed, null, 2)}\n`);
    },
  });
  runPostCommitSideEffect({
    changeId: input.changeId,
    roundId: input.roundId,
    sideEffect: "sync_spec_stage_authority",
    run: () => syncSpecStageAuthority(input.changeId, input.provider),
  });
  runPostCommitSideEffect({
    changeId: input.changeId,
    roundId: input.roundId,
    sideEffect: "refresh_mirrors",
    run: () => refreshMirrors(input.changeId),
  });
}

export function failSpecBattleRound(input: {
  changeId: string;
  roundId: string;
  reason: string;
}): void {
  const round = db.select().from(battleRounds).where(eq(battleRounds.id, input.roundId)).get();
  if (!round) throw new SpecBattleError("round_not_found");
  assertCurrentRound(input.changeId, round);

  db.update(battleRounds)
    .set({
      status: "failed",
      endedAt: nowISO(),
      updatedAt: nowISO(),
    })
    .where(eq(battleRounds.id, input.roundId))
    .run();
  syncSpecStageAuthority(input.changeId);
}

export async function applySpecBattleDecision(input: SpecBattleDecisionInput): Promise<void> {
  const { change } = getProjectForChange(input.changeId);
  const round = latestRound(input.changeId);
  if (!round) throw new SpecBattleError("round_not_found");
  if (
    input.action === "approve" &&
    input.targetType === "gate" &&
    change.status === "SPEC_READY" &&
    round.status === "closed" &&
    hasApprovedSpecGateDecision(input.changeId, round.id) &&
    hasNoSpecBlockers(input.changeId)
  ) {
    if (!getLatestSpecReportForDecision(input.changeId).reportFresh) {
      await generateSpecReport(input.changeId);
    }
    markSpecGateApproved(input.changeId);
    syncSpecStageAuthority(input.changeId);
    refreshMirrors(input.changeId);
    return;
  }
  if (change.status !== "SPEC_READY" || round.status !== "report_ready") {
    throw new SpecBattleError("round_not_ready");
  }
  const params = { ...DEFAULT_BATTLE_PARAMS, ...JSON.parse(round.paramsJson) } as BattleParams;
  const state = getSpecBattleState(input.changeId);
  const report = getLatestSpecReportForDecision(input.changeId);
  const availability = getSpecActionAvailability({
    gaps: state.gaps.map(toRuleGap),
    reportFresh: report.reportFresh,
    currentRoundNo: round.roundNo,
    maxSpecRounds: params.maxSpecRounds,
    allowP1Waiver: params.allowP1Waiver,
  });

  if (input.action === "request_changes" && !input.targetId && !input.reason) {
    throw new SpecBattleError("decision_reason_required");
  }

  if (input.action === "approve" && input.targetType === "requirement_gap") {
    throw new SpecBattleError("human_cannot_resolve_gap");
  }

  if (input.action === "approve") {
    if (!availability.approve.available) {
      if (availability.terminalBlock) {
        updateChangeStatus(input.changeId, "BLOCKED", "spec");
        syncSpecStageAuthority(input.changeId);
        refreshMirrors(input.changeId);
      }
      throw new SpecBattleError(report.staleReason ?? availability.approve.reason ?? "gate_blocked");
    }
    await recordDecision(input, round.id, report.reportHash ?? null);
    db.update(battleRounds)
      .set({ status: "closed", endedAt: nowISO(), updatedAt: nowISO() })
      .where(eq(battleRounds.id, round.id))
      .run();
    await generateSpecReport(input.changeId);
    markSpecGateApproved(input.changeId);
    syncSpecStageAuthority(input.changeId);
    refreshMirrors(input.changeId);
    return;
  }

  if (input.action === "waive_p1") {
    if (!input.reason) throw new SpecBattleError("decision_reason_required");
    if (!availability.waiveP1.available) {
      if (availability.terminalBlock) {
        updateChangeStatus(input.changeId, "BLOCKED", "spec");
        syncSpecStageAuthority(input.changeId);
        refreshMirrors(input.changeId);
      }
      throw new SpecBattleError(availability.waiveP1.reason ?? "waive_not_allowed");
    }
    const gap = findGapByTarget(input.changeId, input.targetId);
    if (!gap || effectiveSeverity(toRuleGap(gap)) !== "P1" || !["open", "downgraded"].includes(gap.status)) {
      throw new SpecBattleError("waive_not_allowed");
    }
    await recordDecision(input, round.id, null);
    db.update(requirementGaps)
      .set({
        status: "waived",
        waiverReason: input.reason,
        specBlocking: 0,
        mergeBlocking: 0,
        updatedAt: nowISO(),
        closedAt: nowISO(),
      })
      .where(eq(requirementGaps.id, gap.id))
      .run();
    markSpecBattleReportsStale(input.changeId, "waive_p1");
    syncSpecStageAuthority(input.changeId);
    refreshMirrors(input.changeId);
    return;
  }

  const action = input.action === "return_to_spec" ? availability.returnToSpec : availability.requestChanges;
  if (!action.available) {
    if (availability.terminalBlock) {
      await recordDecision(input, round.id, null);
      updateChangeStatus(input.changeId, "BLOCKED", "spec");
      syncSpecStageAuthority(input.changeId);
      refreshMirrors(input.changeId);
      return;
    }
    throw new SpecBattleError(action.reason ?? "action_not_allowed");
  }

  const decisionId = await nextId(humanDecisions, "DEC");
  const newRoundId = await nextId(battleRounds, "BRD");
  const { row: newRoundRow } = computeNewSpecRoundRow(input.changeId, params, newRoundId);

  withSqliteWriteRetry("spec-battle.return-to-spec-transition", () =>
    db.transaction((tx) => {
      tx.insert(humanDecisions).values({
        id: decisionId,
        changeId: input.changeId,
        roundId: round.id,
        gate: "spec",
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        reportHash: null,
        createdBy: "human",
        createdAt: nowISO(),
      }).run();

      tx.update(battleRounds)
        .set({ status: "superseded", updatedAt: nowISO() })
        .where(eq(battleRounds.id, round.id))
        .run();

      const currentChange = tx.select().from(changes).where(eq(changes.id, input.changeId)).get();
      if (currentChange?.status === "SPEC_READY") {
        transitionChangeStatusWithDb(tx as unknown as typeof db, {
          changeId: input.changeId,
          to: "INTAKE_READY",
          message: "Spec battle status -> INTAKE_READY",
          rawJson: { source: "spec_battle" },
        });
      }

      tx.insert(battleRounds).values(newRoundRow).run();
    })
  );

  updateChangeStatus(input.changeId, "SPECCING");
  syncSpecStageAuthority(input.changeId);
  refreshMirrors(input.changeId);
  syncSpecStageAuthority(input.changeId);
  refreshMirrors(input.changeId);
}

export function getSpecBattleState(changeId: string): SpecBattleState {
  const gaps = getGaps(changeId);
  const fixClaims = getRedFixClaims(changeId);
  const gapReviews = getBlueGapReviews(changeId);
  const currentRound = latestRound(changeId);
  const freshness = getLatestSpecReportForDecision(changeId);
  return {
    latestRound: currentRound,
    rounds: allRounds(changeId),
    gaps,
    fixClaims,
    gapReviews,
    decisions: getDecisions(changeId),
    reportFresh: freshness.reportFresh,
    staleReason: freshness.staleReason,
    counts: computeGapCounts(gaps.map(toRuleGap)),
    roundDelta: computeStateRoundDelta(currentRound, gaps, gapReviews),
  };
}

export function markSpecBattleReportsStale(changeId: string, reason: string): void {
  db.update(warReports)
    .set({ status: "stale", updatedAt: nowISO(), sourceHashesJson: JSON.stringify({ staleReason: reason }) })
    .where(eq(warReports.changeId, changeId))
    .run();
}
