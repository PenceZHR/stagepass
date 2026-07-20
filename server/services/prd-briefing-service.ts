import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import path from "path";

import { db } from "../db";
import {
  artifacts,
  briefingQuestions,
  changes,
  events,
  prdBriefings,
  prdDrafts,
  projects,
  runs,
} from "../db/schema";
import { withSqliteWriteRetry } from "../db/write-boundary";
import { renderMirrorsFromDb } from "./artifact-mirror-service";
import {
  applyQuestionAction,
  BriefingQuestionsOutputSchema,
  computePrdGate,
  FinalReviewOutputSchema,
  parseBriefingQuestionsOutput,
  parseFinalReviewOutput,
  prdBriefingInputHash,
  prdStageHashQuestionRows,
  readPrdBriefingSourceHashes,
  type BriefingQuestionsOutput,
  type FinalReviewOutput,
  type GateQuestion,
  type PrdBriefingSourceHashes,
  type PrdGateResult,
} from "./prd-briefing-ledger";
import { reapplyRubricStageGateBlockers } from "./rubric-gate-adapters";
import type { StageProgressEventPayload } from "./stage-ai-output-contract";
import {
  completeStageRun,
  computeSourceDbHash,
  recomputeStageGate,
  startStageRun,
} from "./stage-authority-service";
import { transitionChangeStatusWithDb } from "./change-status-service";
import type { Provider } from "./provider-selection-service";

type AnyTableWithId = {
  id: unknown;
};

type SourceHashes = PrdBriefingSourceHashes;

export interface PrdBriefingState {
  briefing: typeof prdBriefings.$inferSelect | null;
  questions: Array<typeof briefingQuestions.$inferSelect>;
  latestDraft: typeof prdDrafts.$inferSelect | null;
  gate: PrdGateResult;
  finalReview: FinalReviewOutput | null;
  activeRun: typeof runs.$inferSelect | null;
  stageProgress: StageProgressEventPayload | null;
}

export class PrdBriefingError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "PrdBriefingError";
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function nextId(table: AnyTableWithId, prefix: string): Promise<string> {
  void table;
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

const readSourceHashes = readPrdBriefingSourceHashes;

function getChange(changeId: string) {
  return db.select().from(changes).where(eq(changes.id, changeId)).get();
}

function getProjectForChange(changeId: string) {
  const change = getChange(changeId);
  if (!change) throw new PrdBriefingError("change_not_found", `Change not found: ${changeId}`);

  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new PrdBriefingError("project_not_found", `Project not found: ${change.projectId}`);

  return { change, project };
}

function changeDir(repoPath: string, changeId: string): string {
  return path.join(repoPath, ".ship", "changes", changeId);
}

function latestDraft(changeId: string): typeof prdDrafts.$inferSelect | null {
  return db.select().from(prdDrafts).where(eq(prdDrafts.changeId, changeId)).all()
    .sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

function prdAuthorityRows(changeId: string) {
  return {
    briefing: currentBriefing(changeId),
    questions: getQuestions(changeId),
    latestDraft: latestDraft(changeId),
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

function sourceInputHash(
  briefing: typeof prdBriefings.$inferSelect | null,
  questions: Array<typeof briefingQuestions.$inferSelect>,
): string {
  return prdBriefingInputHash(briefing, questions);
}

function gateQuestions(rows: Array<typeof briefingQuestions.$inferSelect>): GateQuestion[] {
  return rows.map((row) => ({
    id: row.id,
    severity: row.severity as GateQuestion["severity"],
    status: row.status as GateQuestion["status"],
  }));
}

function assertMutable(briefing: typeof prdBriefings.$inferSelect | null): void {
  if (briefing?.status === "locked") {
    throw new PrdBriefingError("prd_briefing_locked", "PRD briefing is locked");
  }
}

function finalReviewFromBriefing(briefing: typeof prdBriefings.$inferSelect | null): FinalReviewOutput | null {
  if (!briefing?.finalReviewJson) return null;
  return parseFinalReviewOutput(briefing.finalReviewJson);
}

function currentBriefing(changeId: string): typeof prdBriefings.$inferSelect | null {
  return db.select().from(prdBriefings).where(eq(prdBriefings.changeId, changeId)).get() ?? null;
}

async function ensureBriefing(changeId: string, status = "intent_captured"): Promise<typeof prdBriefings.$inferSelect> {
  const existing = currentBriefing(changeId);
  if (existing) return existing;

  const now = nowISO();
  const id = await nextId(prdBriefings, "PBR");
  db.insert(prdBriefings).values({
    id,
    changeId,
    status,
    intentText: "",
    finalReviewJson: null,
    sourceHashesJson: "{}",
    lockedAt: null,
    createdAt: now,
    updatedAt: now,
  }).run();

  return currentBriefing(changeId) ?? (() => {
    throw new PrdBriefingError("briefing_create_failed");
  })();
}

type PrdBriefingDb = typeof db;

/**
 * Any handle that can read. Callers pass the module singleton for ordinary
 * queries, or -- crucially -- their in-flight transaction handle, so a read
 * that a write in the same transaction depends on observes that transaction's
 * own uncommitted rows and is serialised against every other writer.
 */
type PrdBriefingReadConnection = Pick<PrdBriefingDb, "select">;

/**
 * Every card of every round, oldest round first. There is deliberately no
 * "current round only" reader: each gate below asks its question of the whole
 * accumulated set, because an unanswered card from round 1 is exactly as
 * blocking as one from round 3.
 *
 * Round leads the sort, then the pre-existing (createdAt, id) key. For rows
 * written before rounds existed the round is uniformly 1, so the order -- and
 * therefore every already-stamped digest -- is unchanged.
 */
function getQuestionsWithDb(
  connection: PrdBriefingReadConnection,
  changeId: string,
): Array<typeof briefingQuestions.$inferSelect> {
  return connection.select().from(briefingQuestions).where(eq(briefingQuestions.changeId, changeId)).all()
    .sort((a, b) =>
      a.roundNo - b.roundNo
      || a.createdAt.localeCompare(b.createdAt)
      || a.id.localeCompare(b.id));
}

function getQuestions(changeId: string): Array<typeof briefingQuestions.$inferSelect> {
  return getQuestionsWithDb(db, changeId);
}

/**
 * Rounds are dense and 1-based; the first generation for a change opens round 1.
 *
 * Takes a connection rather than reading the singleton because the number it
 * returns is only valid for as long as nothing else appends: read it outside
 * the transaction that writes it and the value is a guess about a past state.
 * `(change_id, round_no)` is a non-unique index, so a stale guess does not
 * fail -- it silently files a second generation's cards under the first
 * generation's round. Callers that are about to write MUST pass the
 * transaction handle.
 */
function nextQuestionRoundNoWithDb(
  connection: PrdBriefingReadConnection,
  changeId: string,
): number {
  const rounds = getQuestionsWithDb(connection, changeId).map((question) => question.roundNo);
  return rounds.length === 0 ? 1 : Math.max(...rounds) + 1;
}

function latestIntakeRun(changeId: string): typeof runs.$inferSelect | null {
  return db.select().from(runs)
    .where(and(eq(runs.changeId, changeId), eq(runs.phase, "intake")))
    .all()
    .sort((a, b) => {
      const aTime = a.startedAt ?? "";
      const bTime = b.startedAt ?? "";
      return bTime.localeCompare(aTime) || b.id.localeCompare(a.id);
    })[0] ?? null;
}

function latestStageProgress(changeId: string): StageProgressEventPayload | null {
  const rows = db.select().from(events).where(eq(events.changeId, changeId)).all()
    .filter((event) => event.type === "stage_progress" && event.rawJson)
    .sort((a, b) => {
      const time = b.createdAt.localeCompare(a.createdAt);
      return time !== 0 ? time : b.id.localeCompare(a.id);
    });

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.rawJson ?? "") as { stageProgress?: unknown };
      const stageProgress = parsed.stageProgress as Partial<StageProgressEventPayload> | undefined;
      if (
        stageProgress?.schemaVersion === "stage_progress/v1"
        && typeof stageProgress.phase === "string"
        && typeof stageProgress.runId === "string"
        && typeof stageProgress.status === "string"
        && typeof stageProgress.source === "string"
      ) {
        return stageProgress as StageProgressEventPayload;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function currentInputHash(changeId: string): string {
  return sourceInputHash(currentBriefing(changeId), getQuestions(changeId));
}

function draftIsFresh(input: {
  briefing: typeof prdBriefings.$inferSelect | null;
  questions: Array<typeof briefingQuestions.$inferSelect>;
  latest: typeof prdDrafts.$inferSelect | null;
  hashes: SourceHashes;
}): boolean {
  return input.latest !== null && input.hashes.draftInputHash === sourceInputHash(input.briefing, input.questions);
}

function finalReviewIsFresh(input: {
  briefing: typeof prdBriefings.$inferSelect | null;
  questions: Array<typeof briefingQuestions.$inferSelect>;
  latest: typeof prdDrafts.$inferSelect | null;
  hashes: SourceHashes;
}): boolean {
  return Boolean(
    input.briefing?.finalReviewJson
      && input.latest
      && input.hashes.finalReviewInputHash === sourceInputHash(input.briefing, input.questions)
      && input.hashes.finalReviewDraftHash === input.latest.draftHash,
  );
}

export interface RecordedDecision {
  id: string;
  status: string;
  answer: string | null;
}

function recordedDecisionsWithDb(
  connection: PrdBriefingReadConnection,
  changeId: string,
): RecordedDecision[] {
  return getQuestionsWithDb(connection, changeId)
    .filter((question) => question.status !== "open")
    .map((question) => ({ id: question.id, status: question.status, answer: question.answer }));
}

/**
 * What `assertQuestionsCanBeReplaced` became.
 *
 * The old guard was a PRE-condition: it refused to generate questions at all
 * once any card carried a human action, because generation replaced the whole
 * set and would have destroyed those answers. That was the correct defence of
 * the wrong model -- it also meant one answer ended the interrogation, since
 * the only way to ask again was to discard what had been decided.
 *
 * Generation now appends a round, so nothing is overwritten and there is no
 * longer anything to refuse. The protection does not disappear with the
 * refusal, though; it moves and gets stricter. It is now a POST-condition,
 * checked inside the same transaction as the append: every card that carried a
 * recorded decision before must still exist afterwards with the same status and
 * the same answer. A precondition can only refuse what it was told to look for,
 * and stops protecting the moment someone reintroduces a delete; this rejects
 * the write itself, whatever caused it, and rolls the round back.
 *
 * The error code is unchanged so the /gate reason vocabulary and the dispatch
 * path keep naming the same failure.
 *
 * Exported only so its own tests can reach it. Nothing else calls it: the
 * append cannot currently produce a state this rejects, and the snapshot it
 * compares against is taken inside the same synchronous transaction, so no
 * interleaving write can either. That is what makes it a guard against a
 * regression that has not happened yet -- and what made it, until its call
 * site got its own tests, unkillable: deleting the call outright kept the
 * suite green, the same evidence one would get if it did nothing at all.
 *
 * Two things therefore have to be held down separately, and are. This function
 * is unit-tested directly for what it rejects. Its CALL SITE is tested by
 * injecting a SQLite trigger that corrupts a decided card from inside the
 * append's own transaction -- proving the guard runs, runs before the commit,
 * and takes the round back out with it. Without the second, the protection
 * this comment claims would only be a comment.
 */
export function assertRecordedDecisionsPreserved(
  before: RecordedDecision[],
  after: Array<typeof briefingQuestions.$inferSelect>,
): void {
  const byId = new Map(after.map((question) => [question.id, question]));
  for (const decision of before) {
    const current = byId.get(decision.id);
    if (!current) {
      throw new PrdBriefingError(
        "questions_have_human_actions",
        `Question generation destroyed a card with a recorded human action: ${decision.id}`,
      );
    }
    if (current.status !== decision.status || current.answer !== decision.answer) {
      throw new PrdBriefingError(
        "questions_have_human_actions",
        `Question generation overwrote a recorded human action: ${decision.id}`,
      );
    }
  }
}

function assertIntentCaptured(changeId: string): typeof prdBriefings.$inferSelect {
  const briefing = currentBriefing(changeId);
  assertMutable(briefing);
  if (!briefing?.intentText.trim()) {
    throw new PrdBriefingError("intent_required", "PRD briefing requires a saved human intent first");
  }
  return briefing;
}

function assertQuestionsGenerated(changeId: string): Array<typeof briefingQuestions.$inferSelect> {
  const questions = getQuestions(changeId);
  if (questions.length === 0) {
    throw new PrdBriefingError("questions_required", "PRD draft requires AI questions first");
  }
  return questions;
}

function assertCriticalQuestionsHandled(questions: Array<typeof briefingQuestions.$inferSelect>): void {
  const openCritical = questions.filter(
    (question) => question.severity === "critical" && question.status === "open",
  );
  if (openCritical.length > 0) {
    throw new PrdBriefingError(
      "critical_questions_open",
      `PRD draft requires all critical questions to be handled first: ${openCritical.map((question) => question.id).join(", ")}`,
    );
  }
}

function assertFreshDraft(changeId: string): {
  latest: typeof prdDrafts.$inferSelect;
  inputHash: string;
} {
  getProjectForChange(changeId);
  const briefing = currentBriefing(changeId);
  assertMutable(briefing);

  const questions = getQuestions(changeId);
  const latest = latestDraft(changeId);
  const hashes = readSourceHashes(briefing?.sourceHashesJson);
  const inputHash = sourceInputHash(briefing, questions);
  if (!latest || hashes.draftInputHash !== inputHash) {
    throw new PrdBriefingError("fresh_prd_draft_required", "Final review requires a fresh PRD draft");
  }

  return { latest, inputHash };
}

function updateSourceHashes(changeId: string, patch: SourceHashes = {}): void {
  const briefing = currentBriefing(changeId);
  if (!briefing) return;
  const hashes = {
    ...readSourceHashes(briefing.sourceHashesJson),
    ...patch,
    currentInputHash: currentInputHash(changeId),
  };
  db.update(prdBriefings)
    .set({ sourceHashesJson: JSON.stringify(hashes), updatedAt: nowISO() })
    .where(eq(prdBriefings.changeId, changeId))
    .run();
}

async function insertBriefingArtifact(changeId: string, type: string, filePath: string): Promise<void> {
  const existing = db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.changeId, changeId), eq(artifacts.path, filePath)))
    .get();
  if (existing) return;

  const id = await nextId(artifacts, "ART");
  db.insert(artifacts).values({
    id,
    changeId,
    runId: null,
    type,
    path: filePath,
    createdAt: nowISO(),
  }).run();
}

async function registerBriefingArtifacts(changeId: string, dir: string): Promise<void> {
  await insertBriefingArtifact(changeId, "prd_intent", path.join(dir, "prd-intent.md"));
  await insertBriefingArtifact(changeId, "briefing_questions", path.join(dir, "briefing-questions.json"));
  await insertBriefingArtifact(changeId, "prd_draft", path.join(dir, "prd-draft.md"));
  await insertBriefingArtifact(changeId, "prd_gate", path.join(dir, "prd-gate.json"));
}

async function refreshPrdBriefingMirrors(changeId: string): Promise<void> {
  const { project } = getProjectForChange(changeId);
  const dir = changeDir(project.repoPath, changeId);
  const state = getPrdBriefingState(changeId);
  const sourceDbHash = prdSourceDbHash(changeId);

  renderMirrorsFromDb({
    changeId,
    repoPath: project.repoPath,
    mirrors: [
      {
        phase: "PRD",
        artifactType: "prd_intent",
        fileName: "prd-intent.md",
        schemaVersion: "prd-briefing.v1",
        sourceDbHash,
        content: state.briefing?.intentText ?? "",
      },
      {
        phase: "PRD",
        artifactType: "briefing_questions",
        fileName: "briefing-questions.json",
        schemaVersion: "prd-briefing.v1",
        sourceDbHash,
        payload: state.questions,
      },
      {
        phase: "PRD",
        artifactType: "prd_draft",
        fileName: "prd-draft.md",
        schemaVersion: "prd-briefing.v1",
        sourceDbHash,
        content: state.latestDraft?.markdown ?? "",
      },
      {
        phase: "PRD",
        artifactType: "prd_gate",
        fileName: "prd-gate.json",
        schemaVersion: "prd-briefing.v1",
        sourceDbHash,
        payload: state.gate,
      },
    ],
  });
  await registerBriefingArtifacts(changeId, dir);
}

function prdGateBlockers(state: PrdBriefingState): Array<{ id: string; severity: "P0" | "P1"; title: string }> {
  const blockers: Array<{ id: string; severity: "P0" | "P1"; title: string }> = [];
  const openCriticalQuestionIds = new Set(
    state.questions
      .filter((question) => question.severity === "critical" && question.status === "open")
      .map((question) => question.id)
  );
  for (const questionId of openCriticalQuestionIds) {
    blockers.push({
      id: questionId,
      severity: "P1",
      title: "Critical PRD question is still open",
    });
  }
  if (!state.latestDraft) {
    blockers.push({ id: "prd-draft", severity: "P1", title: "PRD draft is missing" });
  } else if (!state.gate.draftFresh) {
    blockers.push({ id: "prd-draft", severity: "P1", title: "PRD draft is stale" });
  }
  if (state.latestDraft && state.gate.draftFresh && state.briefing?.status !== "locked") {
    if (!state.gate.finalReviewFresh) {
      blockers.push({ id: "final-review", severity: "P1", title: "Fresh PRD final review is missing" });
    } else if (
      state.finalReview?.verdict === "needs_answer"
      || (state.finalReview?.blockingQuestionIds.length ?? 0) > 0
    ) {
      const finalReviewQuestionIds = state.finalReview?.blockingQuestionIds ?? [];
      if (finalReviewQuestionIds.length === 0) {
        blockers.push({
          id: "final-review",
          severity: "P1",
          title: "PRD final review requires more answers",
        });
      }
      for (const questionId of finalReviewQuestionIds) {
        if (openCriticalQuestionIds.has(questionId)) continue;
        blockers.push({
          id: questionId,
          severity: "P1",
          title: "PRD final review requires this answer",
        });
      }
    }
  }
  return blockers;
}

function prdStageStatus(state: PrdBriefingState): "pass" | "blocked" | "pending" {
  if (state.briefing?.status === "locked") return "pass";
  const blockers = prdGateBlockers(state);
  if (blockers.length > 0) return "blocked";
  return state.briefing ? "pending" : "blocked";
}

function syncPrdStageAuthority(changeId: string, provider?: Provider): void {
  const state = getPrdBriefingState(changeId);
  const sourceDbHash = prdSourceDbHash(changeId);
  const blockers = prdGateBlockers(state);
  const status = prdStageStatus(state);
  const run = startStageRun({
    changeId,
    phase: "PRD",
    inputDbHash: sourceDbHash,
    sourceLineage: {
      tables: ["prd_briefings", "briefing_questions", "prd_drafts.latest"],
      latestDraftId: state.latestDraft?.id ?? null,
    },
    provider: provider ?? null,
  });
  completeStageRun({
    runId: run.id,
    status: status === "pass" ? "passed" : "issues_found",
    counts: {
      questions: state.questions.length,
      deferredQuestions: state.gate.deferredQuestionIds.length,
      blockers: blockers.length,
      draftVersion: state.latestDraft?.version ?? null,
    },
    reportDbHash: sourceDbHash,
  });
  recomputeStageGate({
    changeId,
    phase: "PRD",
    status,
    blockers,
    freshness: {
      source: "db",
      draftFresh: state.gate.draftFresh,
      finalReview: state.finalReview?.verdict ?? null,
      lockedAt: state.briefing?.lockedAt ?? null,
    },
    requiredActions: status === "pass" ? [] : blockers,
    sourceDbHash,
  });
  reapplyRubricStageGateBlockers(changeId, "PRD");
}

async function insertEvent(input: {
  changeId: string;
  type: string;
  message: string;
  rawJson?: unknown;
}): Promise<void> {
  const id = await nextId(events, "EVT");
  db.insert(events).values({
    id,
    changeId: input.changeId,
    runId: null,
    type: input.type,
    message: input.message,
    rawJson: input.rawJson ? JSON.stringify(input.rawJson) : null,
    createdAt: nowISO(),
  }).run();
}

export function getPrdBriefingState(changeId: string): PrdBriefingState {
  const briefing = currentBriefing(changeId);
  const questions = getQuestions(changeId);
  const latest = latestDraft(changeId);
  const hashes = readSourceHashes(briefing?.sourceHashesJson);
  const finalReview = finalReviewFromBriefing(briefing);
  const freshFinalReview = finalReviewIsFresh({ briefing, questions, latest, hashes });
  const gate = computePrdGate({
    hasDraft: latest !== null,
    draftFresh: draftIsFresh({ briefing, questions, latest, hashes }),
    questions: gateQuestions(questions),
    finalReview: {
      fresh: freshFinalReview,
      verdict: finalReview?.verdict ?? null,
      blockingQuestionIds: finalReview?.blockingQuestionIds ?? [],
    },
    locked: briefing?.status === "locked",
  });

  return {
    briefing,
    questions,
    latestDraft: latest,
    gate,
    finalReview,
    activeRun: latestIntakeRun(changeId),
    stageProgress: latestStageProgress(changeId),
  };
}

export function assertCanStartPrdBriefingQuestions(changeId: string): void {
  getProjectForChange(changeId);
  assertIntentCaptured(changeId);
  assertNoRunningPrdBriefingRun(changeId);
  // No replace guard: a new round appends, so recorded answers are never at
  // risk here. assertRecordedDecisionsPreserved enforces that at write time.
}

export function assertCanStartPrdBriefingDraft(changeId: string): void {
  getProjectForChange(changeId);
  assertIntentCaptured(changeId);
  const questions = assertQuestionsGenerated(changeId);
  assertCriticalQuestionsHandled(questions);
  assertNoRunningPrdBriefingRun(changeId);
}

export function assertCanStartPrdBriefingFinalReview(changeId: string): void {
  assertNoRunningPrdBriefingRun(changeId);
  assertFreshDraft(changeId);
}

export function assertNoRunningPrdBriefingRun(changeId: string): void {
  const runningRun = db
    .select()
    .from(runs)
    .where(and(eq(runs.changeId, changeId), eq(runs.phase, "intake"), eq(runs.status, "running")))
    .get();
  if (runningRun) {
    throw new PrdBriefingError("prd_briefing_job_running", "PRD briefing AI job is already running");
  }
}

export async function savePrdIntent(input: {
  changeId: string;
  rawText: string;
}): Promise<PrdBriefingState> {
  getProjectForChange(input.changeId);
  const text = input.rawText.trim();
  if (!text) throw new PrdBriefingError("empty_intent", "PRD intent requires non-empty text");

  const briefing = await ensureBriefing(input.changeId);
  assertMutable(briefing);

  db.update(prdBriefings)
    .set({
      status: "intent_captured",
      intentText: text,
      updatedAt: nowISO(),
    })
    .where(eq(prdBriefings.changeId, input.changeId))
    .run();
  updateSourceHashes(input.changeId);
  syncPrdStageAuthority(input.changeId);
  await refreshPrdBriefingMirrors(input.changeId);
  return getPrdBriefingState(input.changeId);
}

type CompleteQuestionGenerationInput = {
  changeId: string;
  provider?: Provider;
} & (
  | { blueJson: string; questionsOutput?: never }
  | { blueJson?: never; questionsOutput: BriefingQuestionsOutput }
);

function normalizeQuestionGenerationOutput(
  input: CompleteQuestionGenerationInput,
): ReturnType<typeof parseBriefingQuestionsOutput> {
  if ("questionsOutput" in input && input.questionsOutput !== undefined) {
    const parsed = BriefingQuestionsOutputSchema.parse(input.questionsOutput);
    return { questions: parsed.questions };
  }
  return parseBriefingQuestionsOutput(input.blueJson);
}

export async function completeQuestionGeneration(input: CompleteQuestionGenerationInput): Promise<PrdBriefingState> {
  getProjectForChange(input.changeId);
  assertIntentCaptured(input.changeId);
  const briefing = await ensureBriefing(input.changeId, "questions_ready");
  assertMutable(briefing);

  let parsed: ReturnType<typeof parseBriefingQuestionsOutput>;
  try {
    parsed = normalizeQuestionGenerationOutput(input);
  } catch (error) {
    throw new PrdBriefingError("invalid_briefing_questions", error instanceof Error ? error.message : undefined);
  }

  // Ids are minted out here because nextId is async and a better-sqlite3
  // transaction body has to be synchronous. Nothing else is read out here:
  // every value the append depends on is derived inside the transaction from
  // the transaction's own handle.
  //
  // That is not tidiness. `await` is an interleaving point, and there is one
  // between this line and the transaction below, so two generations in a
  // single process -- never mind two processes -- both used to read the round
  // number here, both see the same number, and both write it. The retry
  // wrapper made it worse: it re-runs this closure, and a round number
  // computed outside would be re-used unchanged on every attempt, which is
  // precisely the state the retry exists to escape.
  const mintedIds: string[] = [];
  for (let index = 0; index < parsed.questions.length; index += 1) {
    mintedIds.push(await nextId(briefingQuestions, "BQ"));
  }
  const now = nowISO();

  withSqliteWriteRetry("prd-briefing.append-question-round", () =>
    db.transaction((tx) => {
      const readConnection = tx as unknown as PrdBriefingReadConnection;
      // Snapshot at the start of the transaction that writes: this is what the
      // post-condition holds the append to. Taken here rather than at function
      // entry so it answers "did MY write damage a decision" and not "has
      // anyone anywhere touched a decision since I started" -- the latter
      // rejects a perfectly good round because a human answered a card while
      // the generation was in flight, and throws the round away to protect an
      // answer that was never in danger.
      const preservedDecisions = recordedDecisionsWithDb(readConnection, input.changeId);
      const roundNo = nextQuestionRoundNoWithDb(readConnection, input.changeId);
      parsed.questions.forEach((item, index) => {
        tx.insert(briefingQuestions).values({
          id: mintedIds[index],
          changeId: input.changeId,
          roundNo,
          category: item.category,
          severity: item.severity,
          question: item.question,
          whyItMatters: item.whyItMatters,
          suggestedDefault: item.suggestedDefault,
          status: "open",
          answer: null,
          source: "ai_blue",
          createdAt: now,
          updatedAt: now,
        }).run();
      });
      assertRecordedDecisionsPreserved(
        preservedDecisions,
        tx.select().from(briefingQuestions)
          .where(eq(briefingQuestions.changeId, input.changeId)).all(),
      );
      tx.update(prdBriefings)
        .set({ status: "questions_ready", updatedAt: nowISO() })
        .where(eq(prdBriefings.changeId, input.changeId))
        .run();
    })
  );
  updateSourceHashes(input.changeId);
  syncPrdStageAuthority(input.changeId, input.provider);
  await refreshPrdBriefingMirrors(input.changeId);
  return getPrdBriefingState(input.changeId);
}

export async function applyBriefingQuestionAction(input: {
  changeId: string;
  questionId: string;
  action: "answer" | "accept_assumption" | "defer";
  value: string;
}): Promise<PrdBriefingState> {
  getProjectForChange(input.changeId);
  assertMutable(currentBriefing(input.changeId));

  const question = db
    .select()
    .from(briefingQuestions)
    .where(and(eq(briefingQuestions.changeId, input.changeId), eq(briefingQuestions.id, input.questionId)))
    .get();
  if (!question) throw new PrdBriefingError("question_not_found", `Question not found: ${input.questionId}`);

  let actionResult: ReturnType<typeof applyQuestionAction>;
  try {
    actionResult = applyQuestionAction(input);
  } catch (error) {
    throw new PrdBriefingError("invalid_question_action", error instanceof Error ? error.message : undefined);
  }

  db.update(briefingQuestions)
    .set({
      status: actionResult.status,
      answer: actionResult.answer,
      updatedAt: nowISO(),
    })
    .where(and(eq(briefingQuestions.changeId, input.changeId), eq(briefingQuestions.id, input.questionId)))
    .run();
  updateSourceHashes(input.changeId);
  syncPrdStageAuthority(input.changeId);
  await refreshPrdBriefingMirrors(input.changeId);
  return getPrdBriefingState(input.changeId);
}

export async function completePrdDraft(input: {
  changeId: string;
  markdown: string;
  provider?: Provider;
}): Promise<PrdBriefingState> {
  getProjectForChange(input.changeId);
  assertIntentCaptured(input.changeId);
  const questions = assertQuestionsGenerated(input.changeId);
  assertCriticalQuestionsHandled(questions);
  const briefing = await ensureBriefing(input.changeId, "draft_ready");
  assertMutable(briefing);

  const markdown = input.markdown.trim();
  if (!markdown) throw new PrdBriefingError("empty_prd_draft", "PRD draft requires non-empty markdown");

  const latest = latestDraft(input.changeId);
  const id = await nextId(prdDrafts, "PDR");
  db.insert(prdDrafts).values({
    id,
    changeId: input.changeId,
    version: (latest?.version ?? 0) + 1,
    markdown,
    sourceQuestionIdsJson: JSON.stringify(questions.map((question) => question.id)),
    unresolvedQuestionIdsJson: JSON.stringify(
      questions.filter((question) => question.status === "open" || question.status === "deferred").map((question) => question.id),
    ),
    draftHash: sha256Text(markdown),
    createdAt: nowISO(),
  }).run();

  const draftInputHash = currentInputHash(input.changeId);
  db.update(prdBriefings)
    .set({ status: "draft_ready", updatedAt: nowISO() })
    .where(eq(prdBriefings.changeId, input.changeId))
    .run();
  updateSourceHashes(input.changeId, { draftInputHash });
  syncPrdStageAuthority(input.changeId, input.provider);
  await refreshPrdBriefingMirrors(input.changeId);
  return getPrdBriefingState(input.changeId);
}

type CompleteFinalReviewInput = {
  changeId: string;
  provider?: Provider;
} & (
  | { reviewJson: string; reviewOutput?: never }
  | { reviewJson?: never; reviewOutput: FinalReviewOutput }
);

function normalizeFinalReviewOutput(input: CompleteFinalReviewInput): FinalReviewOutput {
  if ("reviewOutput" in input && input.reviewOutput !== undefined) {
    return FinalReviewOutputSchema.parse(input.reviewOutput);
  }
  return parseFinalReviewOutput(input.reviewJson);
}

export async function completeFinalReview(input: CompleteFinalReviewInput): Promise<PrdBriefingState> {
  const freshDraft = assertFreshDraft(input.changeId);
  const briefing = await ensureBriefing(input.changeId, "final_review_ready");
  assertMutable(briefing);

  let parsed: FinalReviewOutput;
  try {
    parsed = normalizeFinalReviewOutput(input);
  } catch (error) {
    throw new PrdBriefingError("invalid_final_review", error instanceof Error ? error.message : undefined);
  }

  db.update(prdBriefings)
    .set({
      status: "final_review_ready",
      finalReviewJson: JSON.stringify(parsed),
      updatedAt: nowISO(),
    })
    .where(eq(prdBriefings.changeId, input.changeId))
    .run();
  updateSourceHashes(input.changeId, {
    finalReviewInputHash: freshDraft.inputHash,
    finalReviewDraftHash: freshDraft.latest.draftHash,
  });
  syncPrdStageAuthority(input.changeId, input.provider);
  await refreshPrdBriefingMirrors(input.changeId);
  return getPrdBriefingState(input.changeId);
}

export async function lockPrdBriefing(input: {
  changeId: string;
}): Promise<PrdBriefingState> {
  getProjectForChange(input.changeId);
  const state = getPrdBriefingState(input.changeId);
  if (!state.briefing) throw new PrdBriefingError("briefing_not_found", `Briefing not found: ${input.changeId}`);
  if (state.questions.length === 0) {
    throw new PrdBriefingError("questions_required", "PRD lock requires an AI question round");
  }
  const openCriticalQuestionIds = state.questions.filter(
    (question) => question.severity === "critical" && question.status === "open"
  );
  if (
    state.latestDraft
    && state.gate.draftFresh
    && openCriticalQuestionIds.length === 0
    && !state.gate.finalReviewFresh
  ) {
    throw new PrdBriefingError("fresh_final_review_required", "PRD lock requires a fresh final review");
  }
  if (
    state.latestDraft
    && state.gate.draftFresh
    && openCriticalQuestionIds.length === 0
    && (
      state.finalReview?.verdict === "needs_answer"
      || (state.finalReview?.blockingQuestionIds.length ?? 0) > 0
    )
  ) {
    throw new PrdBriefingError("final_review_blocks_lock", "Final review does not allow PRD lock");
  }
  if (!state.gate.canLock) {
    const detail = state.gate.blockingQuestionIds.length > 0
      ? `PRD gate blocks lock: ${state.gate.blockingQuestionIds.join(", ")}`
      : prdGateBlockers(state).map((blocker) => blocker.title).join("; ") || "PRD draft is missing or stale";
    throw new PrdBriefingError("prd_gate_blocked", detail);
  }
  const hashes = readSourceHashes(state.briefing.sourceHashesJson);
  if (!finalReviewIsFresh({
    briefing: state.briefing,
    questions: state.questions,
    latest: state.latestDraft,
    hashes,
  })) {
    throw new PrdBriefingError("fresh_final_review_required", "PRD lock requires a fresh final review");
  }
  const finalReview = finalReviewFromBriefing(state.briefing);
  const allowedVerdict = finalReview?.verdict === "ready" || finalReview?.verdict === "risky_but_allowed";
  if (!allowedVerdict || (finalReview?.blockingQuestionIds.length ?? 0) > 0) {
    throw new PrdBriefingError("final_review_blocks_lock", "Final review does not allow PRD lock");
  }

  const now = nowISO();
  withSqliteWriteRetry("prd-briefing.lock", () =>
    db.transaction((tx) => {
      tx.update(prdBriefings)
        .set({ status: "locked", lockedAt: now, updatedAt: now })
        .where(eq(prdBriefings.changeId, input.changeId))
        .run();
      transitionChangeStatusWithDb(tx as unknown as typeof db, {
        changeId: input.changeId,
        to: "INTAKE_READY",
        gateState: "intake",
        message: "PRD briefing locked",
        rawJson: { source: "prd_briefing_lock" },
      });
    })
  );

  syncPrdStageAuthority(input.changeId);
  await refreshPrdBriefingMirrors(input.changeId);
  const lockedState = getPrdBriefingState(input.changeId);
  await insertEvent({
    changeId: input.changeId,
    type: "prd_briefing_locked",
    message: `PRD briefing locked for ${input.changeId}`,
    rawJson: { gate: lockedState.gate },
  });
  return lockedState;
}
