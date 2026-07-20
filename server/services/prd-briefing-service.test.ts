import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";

import { db } from "../db/index.ts";
import {
  artifacts,
  artifactMirrors,
  briefingQuestions,
  changes,
  events,
  prdBriefings,
  prdDrafts,
  pipelineJobs,
  projects,
  providerRunProcesses,
  runs,
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
} from "../db/schema.ts";
import type { ChangeStatus } from "../types/enums.ts";
import { getActions } from "./action-contract-service.ts";
import { deleteChange, deleteChangeRecords } from "./change-service.ts";
import { inspectArtifactMirrors } from "./artifact-mirror-service.ts";
import {
  applyBriefingQuestionAction,
  assertCanStartPrdBriefingDraft,
  assertCanStartPrdBriefingQuestions,
  assertRecordedDecisionsPreserved,
  completeFinalReview,
  completePrdDraft,
  completeQuestionGeneration,
  getPrdBriefingState,
  lockPrdBriefing,
  PrdBriefingError,
  savePrdIntent,
} from "./prd-briefing-service.ts";
import type { BriefingQuestionInput } from "./prd-briefing-ledger.ts";

const PROJECT_ID = "PRJ-PRD-BRIEFING";
const CHANGE_ID = "CHG-PRD-BRIEFING";

db.run(sql`PRAGMA busy_timeout = 5000`);

const DB_TEST_LOCK_DIR = path.join(os.tmpdir(), "cc-ai-task6-db-test.lock");
let releaseDbTestLock: (() => void) | null = null;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireDbTestLock(): () => void {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(DB_TEST_LOCK_DIR);
      return () => fs.rmSync(DB_TEST_LOCK_DIR, { recursive: true, force: true });
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : null;
      if (code !== "EEXIST") throw error;
      const stats = fs.statSync(DB_TEST_LOCK_DIR, { throwIfNoEntry: false });
      if (stats && Date.now() - stats.mtimeMs > 60000) {
        fs.rmSync(DB_TEST_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      sleepSync(50);
    }
  }
  throw new Error("Timed out waiting for shared SQLite test lock");
}

before(() => {
  releaseDbTestLock = acquireDbTestLock();
});

after(() => {
  releaseDbTestLock?.();
  releaseDbTestLock = null;
});

function cleanupRows() {
  deleteChangeRecords(CHANGE_ID);
  db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).run();
  db.delete(briefingQuestions).where(eq(briefingQuestions.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(repoPath: string, status: ChangeStatus = "INTAKE_PENDING") {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "PRD Briefing",
    repoPath,
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "PRD Briefing change",
    status,
    provider: "codex",
    codexThreadId: null,
    fixIterations: 0,
    blockedPhase: null,
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    gateState: null,
    docsComplete: 0,
    retroDone: 0,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function question(severity: "critical" | "important" | "optional" = "critical"): BriefingQuestionInput {
  return {
    category: "goal",
    severity,
    question: "谁是目标用户？",
    whyItMatters: "目标用户不清会导致验收标准不可判断。",
    suggestedDefault: "默认目标用户是项目 owner。",
  };
}

function finalReviewJson(input: {
  verdict?: "ready" | "needs_answer" | "risky_but_allowed";
  blockingQuestionIds?: string[];
} = {}) {
  return JSON.stringify({
    verdict: input.verdict ?? "ready",
    blockingQuestionIds: input.blockingQuestionIds ?? [],
    riskSummary: "无关键风险。",
    recommendedNextAction: input.verdict === "needs_answer" ? "answer_questions" : "lock_prd",
  });
}

async function seedQuestion(severity: "critical" | "important" | "optional" = "critical") {
  await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });
  const state = await completeQuestionGeneration({
    changeId: CHANGE_ID,
    blueJson: JSON.stringify({ questions: [question(severity)] }),
  });
  return state.questions[0].id;
}

function changeFile(repoPath: string, fileName: string) {
  return path.join(repoPath, ".ship", "changes", CHANGE_ID, fileName);
}

describe("prd-briefing-service", { concurrency: false }, () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "prd-briefing-service-"));
    seedChange(repoPath);
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("creates a briefing state and writes prd-intent mirror", async () => {
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });
    const state = getPrdBriefingState(CHANGE_ID);

    assert.equal(state.briefing?.status, "intent_captured");
    assert.equal(state.briefing?.intentText, "我要做一个战前会议室。");
    assert.equal(fs.readFileSync(changeFile(repoPath, "prd-intent.md"), "utf-8"), "我要做一个战前会议室。");
  });

  it("stores AI-generated questions and writes briefing-questions mirror", async () => {
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });
    await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question()] }),
    });

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.briefing?.status, "questions_ready");
    assert.equal(state.questions.length, 1);
    assert.equal(state.questions[0].status, "open");
    assert.equal(state.gate.canLock, false);

    const mirror = JSON.parse(fs.readFileSync(changeFile(repoPath, "briefing-questions.json"), "utf-8"));
    assert.equal(mirror.length, 1);
    assert.equal(mirror[0].severity, "critical");
  });

  it("accepts validated question output objects without legacy JSON strings", async () => {
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });

    await completeQuestionGeneration({
      changeId: CHANGE_ID,
      questionsOutput: { questions: [question("important")] },
    });

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.questions.length, 1);
    assert.equal(state.questions[0].severity, "important");
  });

  it("requires saved human intent before starting AI questions", async () => {
    await assert.rejects(
      async () => assertCanStartPrdBriefingQuestions(CHANGE_ID),
      (error) => error instanceof PrdBriefingError && error.code === "intent_required",
    );

    await assert.rejects(
      () => completeQuestionGeneration({
        changeId: CHANGE_ID,
        blueJson: JSON.stringify({ questions: [question()] }),
      }),
      (error) => error instanceof PrdBriefingError && error.code === "intent_required",
    );
  });

  it("applies answer, assumption, and defer actions", async () => {
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });
    const generated = await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question("critical"), question("important"), question("optional")] }),
    });
    const [criticalId, importantId, optionalId] = generated.questions.map((row) => row.id);

    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId: criticalId,
      action: "answer",
      value: "由 owner 审批。",
    });
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId: importantId,
      action: "accept_assumption",
      value: "默认 owner 审批。",
    });
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId: optionalId,
      action: "defer",
      value: "进入 Spec Battle 再确认。",
    });

    const state = getPrdBriefingState(CHANGE_ID);
    assert.deepEqual(state.questions.map((row) => row.status), ["answered", "assumption_accepted", "deferred"]);
    assert.equal(state.gate.deferredQuestionIds.length, 1);
  });

  /**
   * The defect this whole round dimension exists for. The briefing is meant to
   * be interrogated over many rounds, but generation used to DELETE the card
   * set and re-insert it, so assertQuestionsCanBeReplaced had to refuse the
   * moment any card carried a recorded human action -- otherwise regeneration
   * would have destroyed the user's decisions. Answering one card therefore
   * ended the interrogation at exactly one round.
   *
   * Generation now appends. Asserted together with the answer surviving,
   * because "a second round is possible" is only the fix if the first round's
   * recorded decision is still there afterwards.
   */
  it("appends a second round instead of refusing once a card has been answered", async () => {
    const criticalId = await seedQuestion("critical");
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId: criticalId,
      action: "answer",
      value: "由 owner 审批。",
    });

    await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question("important")] }),
    });

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.questions.length, 2, "the second round must be added, not swapped in");
    assert.deepEqual(state.questions.map((row) => row.roundNo), [1, 2]);

    const round1 = state.questions[0];
    assert.equal(round1.id, criticalId);
    assert.equal(round1.status, "answered");
    assert.equal(round1.answer, "由 owner 审批。", "the round 1 answer must survive round 2");
    assert.equal(state.questions[1].status, "open");
  });

  /**
   * The protection assertQuestionsCanBeReplaced used to provide, restated as a
   * post-condition. Every card carrying a decision -- answered, assumption
   * accepted, or deferred -- must come through a new round byte-identical.
   * Appending cannot destroy them, and if a future change makes it able to,
   * this rejects the write rather than reporting success over lost decisions.
   */
  it("preserves every recorded human decision across a new round", async () => {
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });
    const generated = await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question("critical"), question("important"), question("optional")] }),
    });
    const [answeredId, assumedId, deferredId] = generated.questions.map((row) => row.id);
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID, questionId: answeredId, action: "answer", value: "由 owner 审批。",
    });
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID, questionId: assumedId, action: "accept_assumption", value: "默认 owner 审批。",
    });
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID, questionId: deferredId, action: "defer", value: "进入 Spec Battle 再确认。",
    });
    const before = getPrdBriefingState(CHANGE_ID).questions
      .map((row) => ({ id: row.id, status: row.status, answer: row.answer, roundNo: row.roundNo }));

    await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question("important")] }),
    });

    const after = getPrdBriefingState(CHANGE_ID).questions;
    assert.equal(after.length, 4);
    assert.deepEqual(
      after.slice(0, 3).map((row) => ({
        id: row.id, status: row.status, answer: row.answer, roundNo: row.roundNo,
      })),
      before,
      "a new round must not touch any recorded decision",
    );
  });

  /**
   * The post-condition itself, driven directly.
   *
   * The test above proves a correct append leaves decisions alone, but it
   * cannot prove the guard is what would stop an incorrect one: deleting the
   * assertRecordedDecisionsPreserved call and changing nothing else leaves the
   * whole suite green, because the append has no route to a state it rejects.
   * That is exactly the evidence a no-op guard would produce. Since the guard
   * exists to catch a regression that does not exist yet, the only way to hold
   * it to its claim is to hand it the bad state on purpose.
   */
  describe("assertRecordedDecisionsPreserved", () => {
    const decided = (overrides: Partial<typeof briefingQuestions.$inferSelect> = {}) => ({
      id: "BQ-DECIDED",
      changeId: CHANGE_ID,
      roundNo: 1,
      category: "goal",
      severity: "critical",
      question: "谁批准？",
      whyItMatters: "验收标准不可判断。",
      suggestedDefault: null,
      status: "answered",
      answer: "由 owner 审批。",
      source: "ai_blue",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      ...overrides,
    } as typeof briefingQuestions.$inferSelect);
    const before = [{ id: "BQ-DECIDED", status: "answered", answer: "由 owner 审批。" }];

    it("accepts a round that only adds cards", () => {
      assert.doesNotThrow(() => assertRecordedDecisionsPreserved(before, [
        decided(),
        decided({ id: "BQ-NEW", roundNo: 2, status: "open", answer: null }),
      ]));
    });

    it("rejects a round that destroyed a decided card", () => {
      assert.throws(
        () => assertRecordedDecisionsPreserved(before, [
          decided({ id: "BQ-NEW", roundNo: 2, status: "open", answer: null }),
        ]),
        (error) => error instanceof PrdBriefingError
          && error.code === "questions_have_human_actions"
          && /destroyed/.test(error.message),
      );
    });

    it("rejects a round that reopened a decided card", () => {
      assert.throws(
        () => assertRecordedDecisionsPreserved(before, [
          decided({ status: "open", answer: null }),
        ]),
        (error) => error instanceof PrdBriefingError
          && error.code === "questions_have_human_actions"
          && /overwrote/.test(error.message),
      );
    });

    it("rejects a round that rewrote the answer text while keeping the status", () => {
      assert.throws(
        () => assertRecordedDecisionsPreserved(before, [
          decided({ answer: "由 AI 代答。" }),
        ]),
        (error) => error instanceof PrdBriefingError
          && error.code === "questions_have_human_actions"
          && /overwrote/.test(error.message),
      );
    });
  });

  it("numbers each generated round in order", async () => {
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });
    for (const severity of ["optional", "optional", "optional"] as const) {
      await completeQuestionGeneration({
        changeId: CHANGE_ID,
        blueJson: JSON.stringify({ questions: [question(severity)] }),
      });
    }

    assert.deepEqual(getPrdBriefingState(CHANGE_ID).questions.map((row) => row.roundNo), [1, 2, 3]);
  });

  /**
   * The semantic judgement: an open card from an earlier round is NOT
   * superseded by a later round. It stays open, stays answerable, and keeps
   * blocking. If a new round retired the old one, generating questions would be
   * a way to walk past an unanswered critical card -- the draft gate would be
   * satisfied by asking a different question rather than by answering the one
   * that was asked.
   */
  it("keeps an earlier round's open critical card blocking after a new round", async () => {
    await seedQuestion("critical");
    await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question("optional")] }),
    });

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.questions[0].roundNo, 1);
    assert.equal(state.questions[0].status, "open", "a new round must not retire an older card");
    assert.deepEqual(state.gate.blockingQuestionIds, [state.questions[0].id]);

    await assert.rejects(
      async () => assertCanStartPrdBriefingDraft(CHANGE_ID),
      (error) => error instanceof PrdBriefingError && error.code === "critical_questions_open",
      "opening a new round must not unblock a draft the older round blocks",
    );
    await assert.rejects(
      () => completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" }),
      (error) => error instanceof PrdBriefingError && error.code === "critical_questions_open",
    );
  });

  it("still lets an earlier round's open card be answered after a new round exists", async () => {
    const criticalId = await seedQuestion("critical");
    await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question("optional")] }),
    });

    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId: criticalId,
      action: "answer",
      value: "由 owner 审批。",
    });

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.questions[0].status, "answered");
    assert.deepEqual(state.gate.blockingQuestionIds, []);
    assert.doesNotThrow(() => assertCanStartPrdBriefingDraft(CHANGE_ID));
  });

  it("no longer refuses a question round because a card carries a human action", async () => {
    const criticalId = await seedQuestion("critical");
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId: criticalId,
      action: "answer",
      value: "由 owner 审批。",
    });

    assert.doesNotThrow(() => assertCanStartPrdBriefingQuestions(CHANGE_ID));
  });

  /**
   * The draft consumes the accumulated card set, not just the newest round:
   * every round's processed cards are its source, and every round's unresolved
   * cards are carried as unresolved.
   */
  it("draws the PRD draft from the processed cards of every round", async () => {
    const criticalId = await seedQuestion("critical");
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID, questionId: criticalId, action: "answer", value: "由 owner 审批。",
    });
    await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question("important"), question("optional")] }),
    });
    const round2 = getPrdBriefingState(CHANGE_ID).questions.filter((row) => row.roundNo === 2);
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID, questionId: round2[0].id, action: "accept_assumption", value: "默认 owner 审批。",
    });

    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" });

    const state = getPrdBriefingState(CHANGE_ID);
    const sourceIds = JSON.parse(state.latestDraft?.sourceQuestionIdsJson ?? "[]") as string[];
    const unresolvedIds = JSON.parse(state.latestDraft?.unresolvedQuestionIdsJson ?? "[]") as string[];

    assert.deepEqual(
      sourceIds,
      [criticalId, round2[0].id, round2[1].id],
      "the draft's source must span both rounds, oldest round first",
    );
    assert.deepEqual(unresolvedIds, [round2[1].id], "the still-open round 2 card stays unresolved");

    // The draft reads the card set through this mirror, so the round each card
    // belongs to has to reach it for later-round-wins to be decidable at all.
    const mirror = JSON.parse(
      fs.readFileSync(changeFile(repoPath, "briefing-questions.json"), "utf-8"),
    ) as Array<{ id: string; roundNo: number }>;
    assert.deepEqual(mirror.map((row) => row.roundNo), [1, 2, 2]);
    assert.deepEqual(mirror.map((row) => row.id), sourceIds);
  });

  it("blocks draft while critical question is open", async () => {
    await seedQuestion("critical");

    await assert.rejects(
      () => completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" }),
      (error) => error instanceof PrdBriefingError && error.code === "critical_questions_open",
    );
  });

  it("rejects draft generation before AI questions and before critical questions are handled", async () => {
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });

    await assert.rejects(
      async () => assertCanStartPrdBriefingDraft(CHANGE_ID),
      (error) => error instanceof PrdBriefingError && error.code === "questions_required",
    );
    await assert.rejects(
      () => completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD" }),
      (error) => error instanceof PrdBriefingError && error.code === "questions_required",
    );

    await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question("critical")] }),
    });
    await assert.rejects(
      async () => assertCanStartPrdBriefingDraft(CHANGE_ID),
      (error) => error instanceof PrdBriefingError && error.code === "critical_questions_open",
    );
    await assert.rejects(
      () => completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD" }),
      (error) => error instanceof PrdBriefingError && error.code === "critical_questions_open",
    );
  });

  it("requires an AI question round before locking PRD", async () => {
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });
    const briefing = db.select().from(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).get();
    assert.ok(briefing);
    db.insert(prdDrafts).values({
      id: "PDR-NO-QUESTIONS",
      changeId: CHANGE_ID,
      version: 1,
      markdown: "# PRD",
      sourceQuestionIdsJson: "[]",
      unresolvedQuestionIdsJson: "[]",
      draftHash: "draft",
      createdAt: new Date().toISOString(),
    }).run();
    db.update(prdBriefings)
      .set({
        finalReviewJson: finalReviewJson(),
        sourceHashesJson: JSON.stringify({
          currentInputHash: JSON.parse(briefing.sourceHashesJson).currentInputHash,
          draftInputHash: JSON.parse(briefing.sourceHashesJson).currentInputHash,
          finalReviewInputHash: JSON.parse(briefing.sourceHashesJson).currentInputHash,
          finalReviewDraftHash: "draft",
        }),
      })
      .where(eq(prdBriefings.changeId, CHANGE_ID))
      .run();

    await assert.rejects(
      () => lockPrdBriefing({ changeId: CHANGE_ID }),
      (error) => error instanceof PrdBriefingError && error.code === "questions_required",
    );
  });

  it("exposes the latest intake run in briefing state", async () => {
    const now = new Date().toISOString();
    db.insert(runs).values({
      id: "RUN-PRD-BRIEFING",
      changeId: CHANGE_ID,
      phase: "intake",
      status: "running",
      startedAt: now,
      endedAt: null,
      summary: null,
    }).run();

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.activeRun?.id, "RUN-PRD-BRIEFING");
    assert.equal(state.activeRun?.status, "running");
  });

  it("exposes the latest PRD briefing stage progress in state", async () => {
    const now = new Date().toISOString();
    db.insert(runs).values({
      id: "RUN-PRD-STAGE",
      changeId: CHANGE_ID,
      phase: "intake",
      status: "failed",
      startedAt: now,
      endedAt: now,
      summary: "Invalid output",
    }).run();
    db.insert(events).values({
      id: "EVT-PRD-STAGE-PROGRESS",
      changeId: CHANGE_ID,
      runId: "RUN-PRD-STAGE",
      type: "stage_progress",
      message: "Invalid output",
      rawJson: JSON.stringify({
        stageProgress: {
          schemaVersion: "stage_progress/v1",
          phase: "prd_briefing_questions",
          runId: "RUN-PRD-STAGE",
          status: "invalid_output",
          source: "none",
          message: "invalid_stage_output: schema mismatch",
        },
      }),
      createdAt: now,
    }).run();

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.stageProgress?.status, "invalid_output");
    assert.equal(state.stageProgress?.phase, "prd_briefing_questions");
    assert.match(state.stageProgress?.message ?? "", /schema mismatch/);
  });

  it("deletes PRD briefing records and mirrors with the change", async () => {
    const lifecycleNow = new Date().toISOString();
    db.insert(pipelineJobs).values({
      id: "JOB-PRD-DELETE",
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      status: "failed",
      attemptNo: 1,
      errorCode: "provider_run_failed",
      createdAt: lifecycleNow,
      endedAt: lifecycleNow,
    }).run();
    db.insert(runs).values({
      id: "RUN-PRD-DELETE",
      changeId: CHANGE_ID,
      phase: "spec",
      status: "failed",
      jobId: "JOB-PRD-DELETE",
      attemptNo: 1,
      startedAt: lifecycleNow,
      endedAt: lifecycleNow,
    }).run();
    db.insert(providerRunProcesses).values({
      id: "PRP-PRD-DELETE",
      changeId: CHANGE_ID,
      runId: "RUN-PRD-DELETE",
      phase: "spec",
      provider: "claude",
      ppid: process.pid,
      status: "failed",
      startedAt: lifecycleNow,
      endedAt: lifecycleNow,
      jobId: "JOB-PRD-DELETE",
      attemptNo: 1,
    }).run();

    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });
    await completeQuestionGeneration({
      changeId: CHANGE_ID,
      blueJson: JSON.stringify({ questions: [question("optional")] }),
    });
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" });

    assert.equal(db.select().from(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).all().length, 1);
    assert.equal(db.select().from(briefingQuestions).where(eq(briefingQuestions.changeId, CHANGE_ID)).all().length, 1);
    assert.equal(db.select().from(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).all().length, 1);
    assert.equal(fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID)), true);

    db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
    db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
    db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
    db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
    db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
    db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
    await deleteChange(CHANGE_ID);

    assert.equal(db.select().from(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(briefingQuestions).where(eq(briefingQuestions.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length, 0);
    assert.equal(fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID)), false);
  });

  it("rolls back dependent record deletion when the final run delete fails", () => {
    const now = new Date().toISOString();
    db.insert(pipelineJobs).values({
      id: "JOB-PRD-DELETE-ROLLBACK",
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      status: "failed",
      attemptNo: 1,
      createdAt: now,
      endedAt: now,
    }).run();
    db.insert(runs).values({
      id: "RUN-PRD-DELETE-ROLLBACK",
      changeId: CHANGE_ID,
      phase: "spec",
      status: "failed",
      jobId: "JOB-PRD-DELETE-ROLLBACK",
      attemptNo: 1,
      startedAt: now,
      endedAt: now,
    }).run();
    db.insert(providerRunProcesses).values({
      id: "PRP-PRD-DELETE-ROLLBACK",
      changeId: CHANGE_ID,
      runId: "RUN-PRD-DELETE-ROLLBACK",
      phase: "spec",
      provider: "claude",
      ppid: process.pid,
      status: "failed",
      startedAt: now,
      endedAt: now,
      jobId: "JOB-PRD-DELETE-ROLLBACK",
      attemptNo: 1,
    }).run();

    db.run(sql`
      CREATE TEMP TRIGGER fail_change_run_delete
      BEFORE DELETE ON runs
      WHEN OLD.id = 'RUN-PRD-DELETE-ROLLBACK'
      BEGIN
        SELECT RAISE(ABORT, 'forced run delete failure');
      END
    `);
    try {
      assert.throws(() => deleteChangeRecords(CHANGE_ID));
    } finally {
      db.run(sql`DROP TRIGGER IF EXISTS fail_change_run_delete`);
    }

    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).all().length, 1);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 1);
    assert.equal(db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all().length, 1);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length, 1);
  });

  it("rejects deleting a change while a techspec run is active", async () => {
    db.update(changes).set({ status: "TECHSPECCING" }).where(eq(changes.id, CHANGE_ID)).run();

    await assert.rejects(
      () => deleteChange(CHANGE_ID),
      /Cannot delete change in TECHSPECCING state/
    );
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length, 1);
  });

  it("stores final review JSON in DB and state", async () => {
    const questionId = await seedQuestion("critical");
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId,
      action: "answer",
      value: "面向普通开发者。",
    });
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" });
    await completeFinalReview({
      changeId: CHANGE_ID,
      reviewJson: finalReviewJson(),
    });

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.briefing?.status, "final_review_ready");
    assert.equal(state.finalReview?.verdict, "ready");
  });

  it("accepts validated final review output objects without legacy JSON strings", async () => {
    const questionId = await seedQuestion("critical");
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId,
      action: "answer",
      value: "面向普通开发者。",
    });
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" });

    await completeFinalReview({
      changeId: CHANGE_ID,
      reviewOutput: {
        verdict: "ready",
        blockingQuestionIds: [],
        riskSummary: "无关键风险。",
        recommendedNextAction: "lock_prd",
      },
    });

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.finalReview?.verdict, "ready");
  });

  it("requires a fresh draft before completing final review", async () => {
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个战前会议室。" });

    await assert.rejects(
      () => completeFinalReview({ changeId: CHANGE_ID, reviewJson: finalReviewJson() }),
      (error) => error instanceof PrdBriefingError && error.code === "fresh_prd_draft_required",
    );

    const questionId = await seedQuestion("critical");
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId,
      action: "answer",
      value: "面向普通开发者。",
    });
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" });
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "我要做一个更新后的战前会议室。" });

    await assert.rejects(
      () => completeFinalReview({ changeId: CHANGE_ID, reviewJson: finalReviewJson() }),
      (error) => error instanceof PrdBriefingError && error.code === "fresh_prd_draft_required",
    );
  });

  it("requires a fresh allowed final review before locking", async () => {
    const questionId = await seedQuestion("critical");
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId,
      action: "answer",
      value: "面向普通开发者。",
    });
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" });

    await assert.rejects(
      () => lockPrdBriefing({ changeId: CHANGE_ID }),
      (error) => error instanceof PrdBriefingError && error.code === "fresh_final_review_required",
    );

    await completeFinalReview({
      changeId: CHANGE_ID,
      reviewJson: finalReviewJson({ verdict: "needs_answer", blockingQuestionIds: [questionId] }),
    });
    const blockedState = getPrdBriefingState(CHANGE_ID);
    assert.equal(blockedState.gate.canLock, false);
    assert.deepEqual(blockedState.gate.blockingQuestionIds, [questionId]);
    assert.equal(blockedState.gate.finalReviewFresh, true);
    assert.equal(blockedState.gate.finalReviewVerdict, "needs_answer");
    const blockedGateMirror = JSON.parse(fs.readFileSync(changeFile(repoPath, "prd-gate.json"), "utf-8"));
    assert.equal(blockedGateMirror.canLock, false);
    assert.equal(blockedGateMirror.finalReviewVerdict, "needs_answer");
    await assert.rejects(
      () => lockPrdBriefing({ changeId: CHANGE_ID }),
      (error) => error instanceof PrdBriefingError && error.code === "final_review_blocks_lock",
    );

    await completeFinalReview({
      changeId: CHANGE_ID,
      reviewJson: finalReviewJson({ verdict: "risky_but_allowed" }),
    });
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId,
      action: "answer",
      value: "更新为团队内部开发者。",
    });
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室 v2。" });

    await assert.rejects(
      () => lockPrdBriefing({ changeId: CHANGE_ID }),
      (error) => error instanceof PrdBriefingError && error.code === "fresh_final_review_required",
    );
  });

  it("locks PRD, writes gate mirror, registers artifacts, and transitions change to INTAKE_READY", async () => {
    const questionId = await seedQuestion("critical");
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId,
      action: "answer",
      value: "面向普通开发者。",
    });
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" });
    await completeFinalReview({ changeId: CHANGE_ID, reviewJson: finalReviewJson() });
    await lockPrdBriefing({ changeId: CHANGE_ID });

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(change?.status, "INTAKE_READY");
    assert.equal(change?.gateState, "intake");

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.briefing?.status, "locked");
    assert.equal(state.gate.canLock, true);

    const gateMirror = JSON.parse(fs.readFileSync(changeFile(repoPath, "prd-gate.json"), "utf-8"));
    assert.equal(gateMirror.canLock, true);

    const artifactRows = db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all();
    assert.deepEqual(
      artifactRows.map((row) => row.type).sort(),
      ["briefing_questions", "prd_draft", "prd_gate", "prd_intent"],
    );
    assert.deepEqual(artifactRows.map((row) => row.runId), [null, null, null, null]);
    assert.ok(artifactRows.every((row) => fs.existsSync(row.path)));

    const lockedEvent = db.select().from(events)
      .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, "prd_briefing_locked")))
      .get();
    assert.ok(lockedEvent);

    const prdReport = db.select().from(stageReports)
      .where(and(eq(stageReports.changeId, CHANGE_ID), eq(stageReports.phase, "PRD")))
      .all()
      .at(-1);
    const prdGate = db.select().from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "PRD")))
      .all()
      .at(-1);
    assert.equal(prdReport?.status, "passed");
    assert.equal(prdGate?.status, "pass");
    assert.equal(typeof prdGate?.sourceDbHash, "string");

    const actionBefore = getActions(CHANGE_ID).find((action) => action.actionId === "approve_intake");
    const runSpecAction = getActions(CHANGE_ID).find((action) => action.actionId === "run_spec");
    assert.equal(runSpecAction?.enabled, true);
    assert.equal(runSpecAction?.reasonCode, null);
    assert.equal(runSpecAction?.sourceDbHash, prdGate?.sourceDbHash);
    fs.writeFileSync(changeFile(repoPath, "prd-draft.md"), "# Tampered file mirror\n");
    const warnings = inspectArtifactMirrors(CHANGE_ID, "PRD");
    const gateAfter = db.select().from(stageGates).where(eq(stageGates.id, prdGate.id)).get();
    const actionAfter = getActions(CHANGE_ID).find((action) => action.actionId === "approve_intake");
    assert.equal(warnings.some((warning) => warning.artifactType === "prd_draft" && warning.mirrorStatus === "mismatch"), true);
    assert.equal(gateAfter?.status, prdGate.status);
    assert.equal(gateAfter?.sourceDbHash, prdGate.sourceDbHash);
    assert.equal(actionAfter?.enabled, actionBefore?.enabled);
    assert.equal(actionAfter?.sourceDbHash, actionBefore?.sourceDbHash);
  });

  it("does not leave the briefing locked when the status transition fails", async () => {
    const questionId = await seedQuestion("critical");
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId,
      action: "answer",
      value: "面向普通开发者。",
    });
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\n做战前会议室。" });
    await completeFinalReview({ changeId: CHANGE_ID, reviewJson: finalReviewJson() });

    db.run(sql`
      CREATE TEMP TRIGGER task_d_block_status_transition
      BEFORE UPDATE ON changes
      WHEN NEW.status = 'INTAKE_READY' AND NEW.id = 'CHG-PRD-BRIEFING'
      BEGIN
        SELECT RAISE(ABORT, 'forced status transition failure');
      END
    `);
    try {
      await assert.rejects(() => lockPrdBriefing({ changeId: CHANGE_ID }));
      const briefing = db.select().from(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).get();
      assert.notEqual(briefing?.status, "locked");
    } finally {
      db.run(sql`DROP TRIGGER IF EXISTS task_d_block_status_transition`);
    }
  });
});
