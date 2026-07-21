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
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
  warReports,
} from "../db/schema.ts";
import type { ChangeStatus } from "../types/enums.ts";
import {
  applySpecBattleDecision,
  claimSpecBattleRedRun,
  completeBlueCritique,
  completeRedSpecRound,
  getSpecBattleState,
  SpecBattleError,
  startSpecBattleRound,
} from "./spec-battle-service.ts";
import { generateSpecReport } from "./spec-battle-report-service.ts";
import { deleteChange, deleteChangeRecords } from "./change-service.ts";
import { getActions } from "./action-contract-service.ts";
import { inspectArtifactMirrors, renderMirrorsFromDb } from "./artifact-mirror-service.ts";
import {
  completeStageRun,
  computeSourceDbHash,
  recomputeStageGate,
  startStageRun,
} from "./stage-authority-service.ts";

const PROJECT_ID = "PRJ-SPEC-BATTLE";
const CHANGE_ID = "CHG-SPEC-BATTLE";
const OTHER_CHANGE_ID = "CHG-SPEC-BATTLE-OTHER";

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
  cleanupChangeRows(OTHER_CHANGE_ID);
  cleanupChangeRows(CHANGE_ID);
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function cleanupChangeRows(changeId: string) {
  deleteChangeRecords(changeId);
  db.delete(stageActions).where(eq(stageActions.changeId, changeId)).run();
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, changeId)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, changeId)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, changeId)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, changeId)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, changeId)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, changeId)).run();
  db.delete(warReports).where(eq(warReports.changeId, changeId)).run();
  db.delete(humanDecisions).where(eq(humanDecisions.changeId, changeId)).run();
  db.delete(redFixClaims).where(eq(redFixClaims.changeId, changeId)).run();
  db.delete(blueGapReviews).where(eq(blueGapReviews.changeId, changeId)).run();
  db.delete(requirementGaps).where(eq(requirementGaps.changeId, changeId)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, changeId)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, changeId)).run();
  db.delete(briefingQuestions).where(eq(briefingQuestions.changeId, changeId)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, changeId)).run();
  db.delete(changes).where(eq(changes.id, changeId)).run();
}

function seedChange(repoPath: string, status: ChangeStatus = "INTAKE_READY") {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Spec Battle",
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
    title: "Spec Battle change",
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

  const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, "change-request.md"), "# Change\n");
  fs.writeFileSync(path.join(changeDir, "prd-intent.md"), "# PRD Intent\n");
  fs.writeFileSync(
    path.join(changeDir, "briefing-questions.json"),
    `${JSON.stringify({ deferred: [{ question: "Who approves rollout?" }] }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(changeDir, "prd-draft.md"), "# PRD Draft\n");
  fs.writeFileSync(path.join(changeDir, "prd-gate.json"), `${JSON.stringify({ status: "locked" })}\n`);
  fs.writeFileSync(path.join(changeDir, "prd-delta.md"), "# PRD\n");
  seedLockedPrdAuthority(repoPath);
}

function seedLockedPrdAuthority(repoPath: string, changeId = CHANGE_ID, idSuffix = "SPEC-BATTLE") {
  const now = new Date().toISOString();
  const briefing = {
    id: `PBR-${idSuffix}`,
    changeId,
    status: "locked",
    intentText: "我要做一个战前会议室。",
    finalReviewJson: JSON.stringify({
      verdict: "ready",
      blockingQuestionIds: [],
      riskSummary: "无关键风险。",
      recommendedNextAction: "lock_prd",
    }),
    sourceHashesJson: JSON.stringify({
      currentInputHash: "db-fixture-input",
      draftInputHash: "db-fixture-input",
      finalReviewInputHash: "db-fixture-input",
      finalReviewDraftHash: "db-fixture-draft",
    }),
    lockedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const questions = [
    {
      id: "BQ-SPEC-BATTLE",
      changeId,
      category: "rollout",
      severity: "important",
      question: "谁审批发布？",
      whyItMatters: "审批人影响验收路径。",
      suggestedDefault: "项目 owner 审批。",
      status: "deferred",
      answer: "进入 Spec Battle 再确认。",
      source: "ai_blue",
      createdAt: now,
      updatedAt: now,
    },
  ];
  const draft = {
    id: "PDR-SPEC-BATTLE",
    changeId,
    version: 1,
    markdown: "# DB PRD Draft\n\n## 目标\n做战前会议室。\n",
    sourceQuestionIdsJson: JSON.stringify([`BQ-${idSuffix}`]),
    unresolvedQuestionIdsJson: JSON.stringify([`BQ-${idSuffix}`]),
    draftHash: "db-fixture-draft",
    createdAt: now,
  };
  questions[0].id = `BQ-${idSuffix}`;

  db.insert(prdBriefings).values(briefing).run();
  db.insert(briefingQuestions).values(questions).run();
  db.insert(prdDrafts).values(draft).run();
  const sourceDbHash = computeSourceDbHash({
    changeId,
    phase: "PRD",
    rows: [
      { table: "prd_briefings", row: briefing },
      { table: "briefing_questions", rows: questions },
      { table: "prd_drafts.latest", row: draft },
    ],
  });
  const run = startStageRun({
    changeId,
    phase: "PRD",
    inputDbHash: sourceDbHash,
    sourceLineage: { fixture: "locked-prd" },
  });
  completeStageRun({
    runId: run.id,
    status: "passed",
    counts: { questions: questions.length, deferredQuestions: 1, blockers: 0, draftVersion: 1 },
    reportDbHash: sourceDbHash,
  });
  recomputeStageGate({
    changeId,
    phase: "PRD",
    status: "pass",
    blockers: [],
    freshness: { source: "db", lockedAt: now },
    requiredActions: [],
    sourceDbHash,
  });
  renderMirrorsFromDb({
    changeId,
    repoPath,
    mirrors: [
      {
        phase: "PRD",
        artifactType: "prd_intent",
        fileName: "prd-intent.md",
        schemaVersion: "prd-briefing.v1",
        sourceDbHash,
        content: briefing.intentText,
      },
      {
        phase: "PRD",
        artifactType: "briefing_questions",
        fileName: "briefing-questions.json",
        schemaVersion: "prd-briefing.v1",
        sourceDbHash,
        payload: questions,
      },
      {
        phase: "PRD",
        artifactType: "prd_draft",
        fileName: "prd-draft.md",
        schemaVersion: "prd-briefing.v1",
        sourceDbHash,
        content: draft.markdown,
      },
      {
        phase: "PRD",
        artifactType: "prd_gate",
        fileName: "prd-gate.json",
        schemaVersion: "prd-briefing.v1",
        sourceDbHash,
        payload: { canLock: true, blockingQuestionIds: [], deferredQuestionIds: [`BQ-${idSuffix}`] },
      },
    ],
  });
}

function blueJson(severity: "P0" | "P1" | "P2" = "P0", canonicalGapId = "missing-state") {
  return JSON.stringify({
    gapReviews: [],
    requirementGaps: [
      {
        canonicalGapId,
        title: "状态矩阵缺失",
        category: "state",
        severity,
        evidence: "没有定义关键状态",
        affectedArtifacts: ["prd-delta.md"],
        proposedSpecPatch: "补齐状态矩阵",
        specBlocking: severity === "P0" || severity === "P1",
        mergeBlocking: severity === "P0" || severity === "P1",
      },
    ],
  });
}

// Red hands over the payload its line protocol assembled, not a JSON string it
// authored. The assertions below are unchanged: they still pin that the claims
// reach red_fix_claims and drive blue's review. Only the transport changed --
// and with it the failure mode where an unparseable string dropped every claim
// without a word.
function redPayload(canonicalGapId = "missing-state") {
  return {
    markdown: "# Spec v2\n\n补齐状态矩阵。\n",
    fixClaims: [
      {
        canonicalGapId,
        claimStatus: "fixed" as const,
        claimSummary: "已补齐状态矩阵",
        evidence: "新增 Ready/Running/Failed 状态与转换规则",
        artifactPath: "prd-delta.md",
      },
    ],
  };
}

function blueReviewJson(options: {
  canonicalGapId?: string;
  verdict: "resolved" | "still_open" | "downgraded" | "needs_human_decision";
  evidence?: string;
  resolutionEvidence?: string | null;
  downgradedTo?: "P1" | "P2" | null;
  requirementGaps?: Array<Record<string, unknown>>;
}) {
  const requirementGaps = (options.requirementGaps ?? []).map((gap) => {
    const severity = gap.severity;
    const blockingSeverity = severity === "P0" || severity === "P1";
    return {
      ...gap,
      affectedArtifacts: Array.isArray(gap.affectedArtifacts) ? gap.affectedArtifacts : [],
      proposedSpecPatch: gap.proposedSpecPatch ?? null,
      specBlocking: typeof gap.specBlocking === "boolean" ? gap.specBlocking : blockingSeverity,
      mergeBlocking: typeof gap.mergeBlocking === "boolean" ? gap.mergeBlocking : blockingSeverity,
    };
  });

  return JSON.stringify({
    gapReviews: [
      {
        canonicalGapId: options.canonicalGapId ?? "missing-state",
        verdict: options.verdict,
        reviewSummary: "反方复核旧缺口",
        evidence: options.evidence ?? "复核证据",
        resolutionEvidence: options.resolutionEvidence ?? null,
        downgradedTo: options.downgradedTo ?? null,
      },
    ],
    requirementGaps,
  });
}

async function readyRoundWithGap(severity: "P0" | "P1" | "P2" = "P0") {
  const started = await startSpecBattleRound(CHANGE_ID);
  claimRoundForTest(started.roundId);
  await completeRedSpecRound({ changeId: CHANGE_ID, roundId: started.roundId, markdown: "# Spec\n" });
  await completeBlueCritique({ changeId: CHANGE_ID, roundId: started.roundId, blueJson: blueJson(severity) });
  return started.roundId;
}

function claimRoundForTest(roundId: string) {
  return claimSpecBattleRedRun({ changeId: CHANGE_ID, idempotencyKey: `test-claim-${roundId}` });
}

describe("spec-battle-service", { concurrency: false }, () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "spec-battle-service-"));
    seedChange(repoPath);
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("starts round 1 from INTAKE_READY and creates the input snapshot", async () => {
    const result = await startSpecBattleRound(CHANGE_ID);

    assert.equal(result.roundNo, 1);
    assert.equal(result.status, "not_started");
    const row = db.select().from(battleRounds).where(eq(battleRounds.id, result.roundId)).get();
    assert.ok(row);
    assert.equal(row.status, "not_started");
    const snapshot = JSON.parse(row.inputSnapshotJson);
    assert.equal(snapshot.authority, "db");
    assert.equal(typeof snapshot.sourceDbHash, "string");
    assert.equal(snapshot.prd.status, "locked");
    assert.equal(snapshot.prd.markdown.includes("DB PRD Draft"), true);
    assert.deepEqual(snapshot.deferredQuestions.map((item: { id: string }) => item.id), ["BQ-SPEC-BATTLE"]);
    assert.deepEqual(snapshot.currentSpecDb.openSpecBlockingGapIds, []);
  });

  it("does not allow completing red output before the round is claimed", async () => {
    const result = await startSpecBattleRound(CHANGE_ID);

    await assert.rejects(
      () => completeRedSpecRound({ changeId: CHANGE_ID, roundId: result.roundId, markdown: "# Spec\n" }),
      /round_not_ready/,
    );
  });

  for (const scenario of ["deleted", "tampered", "wrong_path", "symlink"] as const) {
    it(`reruns Red instead of trusting a ${scenario} failed-round artifact`, async () => {
      const started = await startSpecBattleRound(CHANGE_ID);
      claimRoundForTest(started.roundId);
      await completeRedSpecRound({
        changeId: CHANGE_ID,
        roundId: started.roundId,
        markdown: "# Trusted Red\n",
      });
      const round = db.select().from(battleRounds).where(eq(battleRounds.id, started.roundId)).get();
      assert.ok(round?.redArtifactPath);
      if (scenario === "deleted") {
        fs.unlinkSync(round.redArtifactPath);
      } else if (scenario === "tampered") {
        fs.writeFileSync(round.redArtifactPath, "# Tampered Red\n");
      } else if (scenario === "wrong_path") {
        const outsidePath = path.join(repoPath, "outside-red.md");
        fs.writeFileSync(outsidePath, "# Trusted Red\n");
        db.update(battleRounds).set({ redArtifactPath: outsidePath })
          .where(eq(battleRounds.id, started.roundId)).run();
      } else {
        const outsidePath = path.join(repoPath, "outside-red.md");
        fs.writeFileSync(outsidePath, "# Trusted Red\n");
        fs.unlinkSync(round.redArtifactPath);
        fs.symlinkSync(outsidePath, round.redArtifactPath);
      }
      db.update(battleRounds).set({ status: "failed" })
        .where(eq(battleRounds.id, started.roundId)).run();

      claimSpecBattleRedRun({
        changeId: CHANGE_ID,
        idempotencyKey: `retry-untrusted-${scenario}`,
      });

      const retried = db.select().from(battleRounds).where(eq(battleRounds.id, started.roundId)).get();
      assert.equal(retried?.status, "red_running");
      assert.equal(retried?.redArtifactPath, null);
      assert.equal(retried?.redArtifactHash, null);
    });
  }

  it("blocks creating another round while the latest round is waiting to start", async () => {
    await startSpecBattleRound(CHANGE_ID);

    await assert.rejects(
      () => startSpecBattleRound(CHANGE_ID),
      /round_running/,
    );
  });

  it("starts from locked PRD DB baseline when PRD mirrors are tampered", async () => {
    const actionBefore = getActions(CHANGE_ID).find((action) => action.actionId === "approve_intake");
    fs.writeFileSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "prd-draft.md"), "# File mirror lie\n");
    const warningsBefore = inspectArtifactMirrors(CHANGE_ID, "PRD");
    const actionAfterTamper = getActions(CHANGE_ID).find((action) => action.actionId === "approve_intake");

    assert.equal(
      warningsBefore.some((warning) => warning.artifactType === "prd_draft" && warning.mirrorStatus === "mismatch"),
      true,
    );
    assert.equal(actionAfterTamper?.enabled, actionBefore?.enabled);
    assert.equal(actionAfterTamper?.sourceDbHash, actionBefore?.sourceDbHash);

    const result = await startSpecBattleRound(CHANGE_ID);
    const round = db.select().from(battleRounds).where(eq(battleRounds.id, result.roundId)).get();
    assert.ok(round);
    const snapshot = JSON.parse(round.inputSnapshotJson);
    assert.equal(snapshot.authority, "db");
    assert.equal(snapshot.prd.markdown.includes("DB PRD Draft"), true);
    assert.equal(snapshot.prd.markdown.includes("File mirror lie"), false);
    assert.equal(snapshot.mirrorWarnings.some((warning: { artifactType: string; mirrorStatus: string }) =>
      warning.artifactType === "prd_draft" && warning.mirrorStatus === "mismatch"
    ), true);
  });

  it("deletes changes with spec battle ledger rows without foreign key failures", async () => {
    const roundId = await readyRoundWithGap("P1");
    const gap = db
      .select()
      .from(requirementGaps)
      .where(eq(requirementGaps.changeId, CHANGE_ID))
      .get();
    assert.ok(gap);
    const now = new Date().toISOString();

    db.insert(redFixClaims).values({
      id: "RFC-DELETE-001",
      changeId: CHANGE_ID,
      roundId,
      gapId: gap.id,
      canonicalGapId: gap.canonicalGapId,
      claimStatus: "fixed",
      claimSummary: "补齐状态矩阵",
      evidence: "red evidence",
      artifactPath: "prd-delta.md",
      sourceHashesJson: JSON.stringify({ test: true }),
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(blueGapReviews).values({
      id: "BGR-DELETE-001",
      changeId: CHANGE_ID,
      roundId,
      gapId: gap.id,
      canonicalGapId: gap.canonicalGapId,
      verdict: "still_open",
      reviewSummary: "仍缺边界条件",
      evidence: "blue evidence",
      resolutionEvidence: null,
      downgradedTo: null,
      sourceHashesJson: JSON.stringify({ test: true }),
      createdAt: now,
      updatedAt: now,
    }).run();

    await generateSpecReport(CHANGE_ID);
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "waive_p1",
      targetType: "requirement_gap",
      targetId: gap.id,
      reason: "测试删除链路",
    });

    assert.equal(db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).all().length > 0, true);
    assert.equal(db.select().from(requirementGaps).where(eq(requirementGaps.changeId, CHANGE_ID)).all().length > 0, true);
    assert.equal(db.select().from(redFixClaims).where(eq(redFixClaims.changeId, CHANGE_ID)).all().length > 0, true);
    assert.equal(db.select().from(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).all().length > 0, true);
    assert.equal(db.select().from(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).all().length > 0, true);
    assert.equal(db.select().from(warReports).where(eq(warReports.changeId, CHANGE_ID)).all().length > 0, true);

    db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
    db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
    db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
    db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
    db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
    db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
    await deleteChange(CHANGE_ID);

    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(requirementGaps).where(eq(requirementGaps.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(redFixClaims).where(eq(redFixClaims.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(warReports).where(eq(warReports.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID)), false);
  });

  it("rejects a new round while the current round is running", async () => {
    await startSpecBattleRound(CHANGE_ID);

    await assert.rejects(
      () => startSpecBattleRound(CHANGE_ID),
      (err: Error) => err instanceof SpecBattleError && err.code === "round_running"
    );
  });

  it("writes Spec red markdown artifact as bare Markdown", async () => {
    const round = await startSpecBattleRound(CHANGE_ID);
    claimRoundForTest(round.roundId);

    await completeRedSpecRound({
      changeId: CHANGE_ID,
      roundId: round.roundId,
      markdown: "# Spec Red\n\nPlain markdown body.\n",
    });

    const artifactPath = path.join(
      repoPath,
      ".ship",
      "changes",
      CHANGE_ID,
      "rounds",
      "spec-round-01-red.md"
    );
    const fileContent = fs.readFileSync(artifactPath, "utf-8");
    assert.equal(fileContent.startsWith("{"), false);
    assert.match(fileContent, /^#/);
  });

  it("enforces maxSpecRounds", async () => {
    await readyRoundWithGap("P2");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "继续细化 P2",
    });
    let nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(nextRound);
    claimRoundForTest(nextRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: nextRound.id, markdown: "# Spec v2\n" });
    await completeBlueCritique({ changeId: CHANGE_ID, roundId: nextRound.id, blueJson: blueJson("P2") });
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "继续细化 P2",
    });
    nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(nextRound);
    claimRoundForTest(nextRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: nextRound.id, markdown: "# Spec v3\n" });
    await completeBlueCritique({ changeId: CHANGE_ID, roundId: nextRound.id, blueJson: blueJson("P2") });

    await assert.rejects(
      () => startSpecBattleRound(CHANGE_ID),
      (err: Error) => err instanceof SpecBattleError && err.code === "round_limit_reached"
    );
  });

  it("upserts blue output by canonicalGapId without duplicate gaps", async () => {
    const roundId = await readyRoundWithGap("P1");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "同一缺口进入下一轮",
    });
    const nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(nextRound);
    claimRoundForTest(nextRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: nextRound.id, markdown: "# Spec v2\n" });
    await completeBlueCritique({ changeId: CHANGE_ID, roundId: nextRound.id, blueJson: blueJson("P1") });

    const rows = db
      .select()
      .from(requirementGaps)
      .where(and(
        eq(requirementGaps.changeId, CHANGE_ID),
        eq(requirementGaps.canonicalGapId, "missing-state")
      ))
      .all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].firstSeenRoundId, roundId);
    assert.equal(rows[0].lastEvaluatedRoundId, nextRound.id);

    const mirror = path.join(repoPath, ".ship", "changes", CHANGE_ID, "requirement-gaps.json");
    assert.equal(fs.existsSync(mirror), true);
  });

  it("resolves an old P1 gap when blue review verdict is resolved", async () => {
    await readyRoundWithGap("P1");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "我方代理修复后反方复核",
    });
    const nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(nextRound);
    claimRoundForTest(nextRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: nextRound.id, redOutput: redPayload() });

    await completeBlueCritique({
      changeId: CHANGE_ID,
      roundId: nextRound.id,
      blueJson: blueReviewJson({
        verdict: "resolved",
        evidence: "反方确认状态矩阵完整",
        resolutionEvidence: "PRD 已包含状态矩阵和转换规则",
      }),
    });

    const state = getSpecBattleState(CHANGE_ID);
    const gap = db.select().from(requirementGaps).where(eq(requirementGaps.canonicalGapId, "missing-state")).get();
    assert.equal(state.counts.blockingP1, 0);
    assert.equal(state.roundDelta.resolvedThisRound, 1);
    assert.equal(state.roundDelta.stillOpen, 0);
    assert.equal(state.roundDelta.newlyFound, 0);
    assert.equal(state.roundDelta.notRechecked, 0);
    assert.equal(state.fixClaims.length >= 1, true);
    assert.equal(state.gapReviews.length >= 1, true);
    assert.equal(gap?.status, "resolved");
    assert.equal(gap?.resolvedByRoundId, nextRound.id);
    assert.equal(gap?.resolutionEvidence, "PRD 已包含状态矩阵和转换规则");
  });

  it("keeps an old P1 gap open when blue omits a gap review", async () => {
    await readyRoundWithGap("P1");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "反方漏复核",
    });
    const nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(nextRound);
    claimRoundForTest(nextRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: nextRound.id, redOutput: redPayload() });

    await completeBlueCritique({
      changeId: CHANGE_ID,
      roundId: nextRound.id,
      blueJson: JSON.stringify({ gapReviews: [], requirementGaps: [] }),
    });

    const state = getSpecBattleState(CHANGE_ID);
    const gap = db.select().from(requirementGaps).where(eq(requirementGaps.canonicalGapId, "missing-state")).get();
    assert.equal(state.counts.blockingP1, 1);
    assert.equal(state.roundDelta.resolvedThisRound, 0);
    assert.equal(state.roundDelta.stillOpen, 1);
    assert.equal(state.roundDelta.newlyFound, 0);
    assert.equal(state.roundDelta.notRechecked, 1);
    assert.equal(gap?.status, "open");
  });

  it("counts newly found gaps in the latest round delta", async () => {
    const round = await startSpecBattleRound(CHANGE_ID);
    claimRoundForTest(round.roundId);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: round.roundId, markdown: "# Spec\n" });
    await completeBlueCritique({ changeId: CHANGE_ID, roundId: round.roundId, blueJson: blueJson("P1", "new-round-gap") });

    const state = getSpecBattleState(CHANGE_ID);
    assert.equal(state.roundDelta.resolvedThisRound, 0);
    assert.equal(state.roundDelta.stillOpen, 0);
    assert.equal(state.roundDelta.newlyFound, 1);
    assert.equal(state.roundDelta.notRechecked, 0);
  });

  it("keeps red DB state ready when the red artifact write fails after commit", async () => {
    await readyRoundWithGap("P1");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "红方声明修复",
    });
    const nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(nextRound);
    claimRoundForTest(nextRound.id);

    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (typeof file === "string" && file.endsWith("spec-round-02-red.md")) {
        throw new Error("red artifact write failed");
      }
      return originalWriteFileSync(file, data, options);
    }) as typeof fs.writeFileSync;

    try {
      await completeRedSpecRound({ changeId: CHANGE_ID, roundId: nextRound.id, redOutput: redPayload() });
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    const persistedRound = db.select().from(battleRounds).where(eq(battleRounds.id, nextRound.id)).get();
    const claims = db.select().from(redFixClaims).where(eq(redFixClaims.roundId, nextRound.id)).all();
    const postCommitEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "spec_post_commit_side_effect_failed" &&
        event.rawJson?.includes("\"sideEffect\":\"red_artifact_write\"")
      );

    assert.equal(persistedRound?.status, "blue_running");
    assert.match(persistedRound?.redArtifactPath ?? "", /spec-round-02-red\.md$/);
    assert.equal(typeof persistedRound?.redArtifactHash, "string");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].canonicalGapId, "missing-state");
    assert.ok(postCommitEvent);
  });

  it("keeps blue DB state ready when the blue artifact write fails after commit", async () => {
    const round = await startSpecBattleRound(CHANGE_ID);
    claimRoundForTest(round.roundId);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: round.roundId, markdown: "# Spec\n" });

    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (typeof file === "string" && file.endsWith("spec-round-01-blue.json")) {
        throw new Error("blue artifact write failed");
      }
      return originalWriteFileSync(file, data, options);
    }) as typeof fs.writeFileSync;

    try {
      await completeBlueCritique({
        changeId: CHANGE_ID,
        roundId: round.roundId,
        blueJson: blueReviewJson({
          verdict: "needs_human_decision",
          requirementGaps: [
            {
              canonicalGapId: "post-commit-gap",
              title: "Post commit gap",
              category: "state",
              severity: "P1",
              evidence: "Persist before artifact",
              affectedArtifacts: ["prd-delta.md"],
              proposedSpecPatch: "Patch it",
            },
          ],
        }),
      });
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    const reviews = db.select().from(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).all();
    const gaps = db.select().from(requirementGaps).where(eq(requirementGaps.changeId, CHANGE_ID)).all();
    const persistedRound = db.select().from(battleRounds).where(eq(battleRounds.id, round.roundId)).get();

    assert.equal(reviews.length, 1);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].canonicalGapId, "post-commit-gap");
    assert.equal(persistedRound?.status, "report_ready");
    assert.match(persistedRound?.blueArtifactPath ?? "", /spec-round-01-blue\.json$/);
    assert.equal(typeof persistedRound?.blueArtifactHash, "string");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "SPEC_READY");
    assert.equal(
      db
        .select()
        .from(events)
        .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, "spec_post_commit_side_effect_failed")))
        .all().length,
      1
    );
  });

  it("writes the blue artifact only after blue DB writes are committed", async () => {
    const round = await startSpecBattleRound(CHANGE_ID);
    claimRoundForTest(round.roundId);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: round.roundId, markdown: "# Spec\n" });

    let gapCountAtBlueArtifactWrite: number | null = null;
    let roundStatusAtBlueArtifactWrite: string | null = null;
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (typeof file === "string" && file.endsWith("spec-round-01-blue.json")) {
        gapCountAtBlueArtifactWrite = db
          .select()
          .from(requirementGaps)
          .where(eq(requirementGaps.changeId, CHANGE_ID))
          .all().length;
        roundStatusAtBlueArtifactWrite = db
          .select()
          .from(battleRounds)
          .where(eq(battleRounds.id, round.roundId))
          .get()?.status ?? null;
      }
      return originalWriteFileSync(file, data, options);
    }) as typeof fs.writeFileSync;

    try {
      await completeBlueCritique({ changeId: CHANGE_ID, roundId: round.roundId, blueJson: blueJson("P1", "artifact-order-gap") });
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(gapCountAtBlueArtifactWrite, 1);
    assert.equal(roundStatusAtBlueArtifactWrite, "report_ready");
  });

  it("does not write blue DB rows for invalid blue critique input", async () => {
    const round = await startSpecBattleRound(CHANGE_ID);
    claimRoundForTest(round.roundId);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: round.roundId, markdown: "# Spec\n" });

    await assert.rejects(
      () => completeBlueCritique({
        changeId: CHANGE_ID,
        roundId: round.roundId,
        blueJson: JSON.stringify({ gapReviews: [{ canonicalGapId: "invalid-gap" }] }),
      }),
      /Invalid input/
    );

    assert.equal(db.select().from(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(requirementGaps).where(eq(requirementGaps.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(
      db.select().from(battleRounds).where(eq(battleRounds.id, round.roundId)).get()?.status,
      "blue_running"
    );
  });

  it("does not reopen a gap resolved by a same-round blue review", async () => {
    await readyRoundWithGap("P1");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "同轮 review 与 requirementGaps 冲突",
    });
    const nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(nextRound);
    claimRoundForTest(nextRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: nextRound.id, redOutput: redPayload() });

    await completeBlueCritique({
      changeId: CHANGE_ID,
      roundId: nextRound.id,
      blueJson: blueReviewJson({
        verdict: "resolved",
        resolutionEvidence: "反方确认已修复",
        requirementGaps: [
          {
            canonicalGapId: "missing-state",
            title: "状态矩阵缺失",
            category: "state",
            severity: "P1",
            evidence: "同一反方 JSON 误重复上报",
            affectedArtifacts: ["prd-delta.md"],
            proposedSpecPatch: "补齐状态矩阵",
          },
        ],
      }),
    });

    const state = getSpecBattleState(CHANGE_ID);
    const gap = db.select().from(requirementGaps).where(eq(requirementGaps.canonicalGapId, "missing-state")).get();
    assert.equal(state.counts.blockingP1, 0);
    assert.equal(gap?.status, "resolved");
    assert.equal(gap?.resolvedByRoundId, nextRound.id);
  });

  it("stores red JSON fix claims and writes the red-fix-claims mirror", async () => {
    await readyRoundWithGap("P1");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "红方声明修复",
    });
    const nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(nextRound);

    claimRoundForTest(nextRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: nextRound.id, redOutput: redPayload() });

    const artifactPath = path.join(
      repoPath,
      ".ship",
      "changes",
      CHANGE_ID,
      "rounds",
      "spec-round-02-red.md"
    );
    const fileContent = fs.readFileSync(artifactPath, "utf-8");
    assert.equal(fileContent, "# Spec v2\n\n补齐状态矩阵。\n");
    assert.equal(fileContent.startsWith("{"), false);
    assert.match(fileContent, /^#/);

    const claims = db.select().from(redFixClaims).where(eq(redFixClaims.changeId, CHANGE_ID)).all();
    assert.equal(claims.length, 1);
    assert.equal(claims[0].canonicalGapId, "missing-state");
    assert.equal(claims[0].claimStatus, "fixed");

    const mirror = path.join(repoPath, ".ship", "changes", CHANGE_ID, "red-fix-claims.json");
    assert.equal(fs.existsSync(mirror), true);
  });

  it("includes open spec blockers and ledger mirrors in the next round input snapshot", async () => {
    await readyRoundWithGap("P1");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "下一轮要带入阻塞缺口",
    });

    const nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(nextRound);
    const snapshot = JSON.parse(nextRound.inputSnapshotJson);
    assert.equal(snapshot.authority, "db");
    assert.deepEqual(snapshot.currentSpecDb.openSpecBlockingGapIds, ["missing-state"]);
    assert.equal(typeof snapshot.sourceDbHash, "string");
    assert.equal(snapshot.prd.markdown.includes("DB PRD Draft"), true);
  });

  it("requires target or reason for request_changes", async () => {
    await readyRoundWithGap("P2");

    await assert.rejects(
      () => applySpecBattleDecision({
        changeId: CHANGE_ID,
        action: "request_changes",
        targetType: null,
        targetId: null,
        reason: null,
      }),
      (err: Error) => err instanceof SpecBattleError && err.code === "decision_reason_required"
    );
  });

  it("returns to spec by superseding the current blocker round and starting the next round", async () => {
    const roundId = await readyRoundWithGap("P0");

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "return_to_spec",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "补齐状态",
    });

    const oldRound = db.select().from(battleRounds).where(eq(battleRounds.id, roundId)).get();
    const latest = getSpecBattleState(CHANGE_ID).latestRound;
    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(oldRound?.status, "superseded");
    assert.equal(latest?.roundNo, 2);
    assert.equal(latest?.status, "not_started");
    assert.equal(change?.status, "SPECCING");
  });

  it("rolls back the whole return-to-spec transition when the new round insert fails", async () => {
    const roundId = await readyRoundWithGap("P0");

    db.run(sql.raw(`
      CREATE TRIGGER task_c_block_new_round
      BEFORE INSERT ON battle_rounds
      WHEN NEW.round_no = 2
      BEGIN SELECT RAISE(ABORT, 'forced'); END
    `));
    try {
      await assert.rejects(
        () => applySpecBattleDecision({
          changeId: CHANGE_ID,
          action: "return_to_spec",
          targetType: "requirement_gap",
          targetId: "missing-state",
          reason: "补齐状态",
        }),
        /forced/,
      );

      const oldRound = db.select().from(battleRounds).where(eq(battleRounds.id, roundId)).get();
      const rounds = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).all();
      const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
      const decisions = db.select().from(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).all();

      assert.equal(oldRound?.status, "report_ready");
      assert.equal(rounds.length, 1);
      assert.equal(change?.status, "SPEC_READY");
      assert.equal(decisions.length, 0);
    } finally {
      db.run(sql.raw("DROP TRIGGER IF EXISTS task_c_block_new_round"));
    }
  });

  it("allows another human-requested round on final-round P0", async () => {
    await readyRoundWithGap("P2");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "再来一轮",
    });
    const finalRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(finalRound);
    claimRoundForTest(finalRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: finalRound.id, markdown: "# Spec v2\n" });
    await completeBlueCritique({ changeId: CHANGE_ID, roundId: finalRound.id, blueJson: blueJson("P0") });

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "return_to_spec",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "最终轮 P0",
    });

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const nextRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.equal(change?.status, "SPECCING");
    assert.equal(change?.blockedPhase, null);
    assert.equal(nextRound?.roundNo, 3);
    assert.equal(nextRound?.status, "not_started");
  });

  it("lets a human request another pass on final-round P1 blockers", async () => {
    await readyRoundWithGap("P2");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "进入最终轮",
    });
    const finalRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(finalRound);
    claimRoundForTest(finalRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: finalRound.id, markdown: "# Spec v2\n" });
    await completeBlueCritique({ changeId: CHANGE_ID, roundId: finalRound.id, blueJson: blueJson("P1") });
    await generateSpecReport(CHANGE_ID);

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "return_to_spec",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "最终轮 P1 仍需修改",
    });

    const latest = getSpecBattleState(CHANGE_ID).latestRound;
    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(finalRound.id === latest?.id, false);
    assert.equal(latest?.roundNo, 3);
    assert.equal(latest?.status, "not_started");
    assert.equal(change?.status, "SPECCING");
  });

  it("waives only effective P1 gaps and writes human decision mirror", async () => {
    await readyRoundWithGap("P1");

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "waive_p1",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "接受风险",
    });

    const gap = db.select().from(requirementGaps).where(eq(requirementGaps.canonicalGapId, "missing-state")).get();
    assert.equal(gap?.status, "waived");
    assert.equal(gap?.waiverReason, "接受风险");
    const mirror = path.join(repoPath, ".ship", "changes", CHANGE_ID, "human-decisions.json");
    assert.equal(JSON.parse(fs.readFileSync(mirror, "utf-8")).length, 1);
  });

  it("does not let HUMAN_COMMANDER directly mark a gap resolved", async () => {
    await readyRoundWithGap("P1");

    await assert.rejects(
      () => applySpecBattleDecision({
        changeId: CHANGE_ID,
        action: "approve",
        targetType: "requirement_gap",
        targetId: "missing-state",
        reason: "人工直接关闭",
      }),
      (err: Error) => err instanceof SpecBattleError && err.code === "human_cannot_resolve_gap"
    );
  });

  it("rejects approval before the current round has a report", async () => {
    await startSpecBattleRound(CHANGE_ID);

    await assert.rejects(
      () => applySpecBattleDecision({
        changeId: CHANGE_ID,
        action: "approve",
        targetType: "gate",
        targetId: null,
        reason: null,
      }),
      (err: Error) => err instanceof SpecBattleError && err.code === "round_not_ready"
    );
  });

  it("rejects approval when the spec report has not been generated", async () => {
    await readyRoundWithGap("P2");

    await assert.rejects(
      () => applySpecBattleDecision({
        changeId: CHANGE_ID,
        action: "approve",
        targetType: "gate",
        targetId: null,
        reason: null,
      }),
      (err: Error) => err instanceof SpecBattleError && err.code === "report_missing"
    );
  });

  it("records the approved spec report hash", async () => {
    await readyRoundWithGap("P2");
    const report = await generateSpecReport(CHANGE_ID);

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "approve",
      targetType: "gate",
      targetId: null,
      reason: null,
    });

    const decision = db.select().from(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).get();
    assert.equal(decision?.reportHash, report.reportHash);
  });

  it("marks the Spec gate approved when approving a fresh no-blocker report", async () => {
    await readyRoundWithGap("P2");
    await generateSpecReport(CHANGE_ID);

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "approve",
      targetType: "gate",
      targetId: null,
      reason: null,
    });

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const round = getSpecBattleState(CHANGE_ID).latestRound;
    assert.equal(round?.status, "closed");
    assert.equal(change?.gateState, "spec");
    assert.equal(change?.status, "SPEC_READY");
  });

  it("keeps the approved Spec report fresh so TechSpec can start", async () => {
    await readyRoundWithGap("P2");
    await generateSpecReport(CHANGE_ID);

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "approve",
      targetType: "gate",
      targetId: null,
      reason: null,
    });

    const state = getSpecBattleState(CHANGE_ID);
    const runTechSpec = getActions(CHANGE_ID).find((action) => action.actionId === "run_tech_spec");

    assert.equal(state.latestRound?.status, "closed");
    assert.equal(state.reportFresh, true);
    assert.equal(state.staleReason, null);
    assert.equal(runTechSpec?.enabled, true);
    assert.equal(runTechSpec?.reasonCode, null);
  });

  it("keeps Spec gate and action contract stable when Spec mirrors are tampered", async () => {
    await readyRoundWithGap("P2");
    await generateSpecReport(CHANGE_ID);

    const gateBefore = db
      .select()
      .from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Spec")))
      .all()
      .at(-1);
    const actionBefore = getActions(CHANGE_ID).find((action) => action.actionId === "approve_spec");
    assert.ok(gateBefore);
    assert.equal(gateBefore.status, "pass");

    fs.writeFileSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "requirement-gaps.json"), "[]\n");
    const warnings = inspectArtifactMirrors(CHANGE_ID, "Spec");
    const gateAfter = db.select().from(stageGates).where(eq(stageGates.id, gateBefore.id)).get();
    const actionAfter = getActions(CHANGE_ID).find((action) => action.actionId === "approve_spec");

    assert.equal(
      warnings.some((warning) => warning.artifactType === "requirement_gaps" && warning.mirrorStatus === "mismatch"),
      true,
    );
    assert.equal(gateAfter?.status, gateBefore.status);
    assert.equal(gateAfter?.sourceDbHash, gateBefore.sourceDbHash);
    assert.equal(actionAfter?.enabled, actionBefore?.enabled);
    assert.equal(actionAfter?.sourceDbHash, actionBefore?.sourceDbHash);
  });

  it("idempotently repairs a closed approved no-blocker Spec gate", async () => {
    await readyRoundWithGap("P2");
    await generateSpecReport(CHANGE_ID);
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "approve",
      targetType: "gate",
      targetId: null,
      reason: null,
    });
    db.update(changes)
      .set({ gateState: "intake", status: "SPEC_READY" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    const reportsBeforeRepair = db
      .select()
      .from(warReports)
      .where(and(eq(warReports.changeId, CHANGE_ID), eq(warReports.type, "phase_report")))
      .all();
    db.update(warReports)
      .set({ status: "stale", updatedAt: new Date().toISOString() })
      .where(and(eq(warReports.changeId, CHANGE_ID), eq(warReports.type, "phase_report")))
      .run();

    const staleState = getSpecBattleState(CHANGE_ID);
    assert.equal(staleState.latestRound?.status, "closed");
    assert.equal(staleState.reportFresh, false);
    assert.equal(staleState.staleReason, "report_stale");
    sleepSync(2);

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "approve",
      targetType: "gate",
      targetId: null,
      reason: null,
    });

    const decisions = db.select().from(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).all();
    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const state = getSpecBattleState(CHANGE_ID);
    const reportsAfterRepair = db
      .select()
      .from(warReports)
      .where(and(eq(warReports.changeId, CHANGE_ID), eq(warReports.type, "phase_report")))
      .all();
    const runTechSpec = getActions(CHANGE_ID).find((action) => action.actionId === "run_tech_spec");
    assert.equal(decisions.filter((decision) => decision.action === "approve").length, 1);
    assert.equal(change?.gateState, "spec");
    assert.equal(change?.status, "SPEC_READY");
    assert.equal(state.reportFresh, true);
    assert.equal(state.staleReason, null);
    assert.equal(reportsAfterRepair.length, reportsBeforeRepair.length + 1);
    assert.equal(runTechSpec?.enabled, true);
    assert.equal(runTechSpec?.reasonCode, null);
  });

  it("blocks final-round P0 approval attempts", async () => {
    await readyRoundWithGap("P2");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "requirement_gap",
      targetId: "missing-state",
      reason: "再来一轮",
    });
    const finalRound = getSpecBattleState(CHANGE_ID).latestRound;
    assert.ok(finalRound);
    claimRoundForTest(finalRound.id);
    await completeRedSpecRound({ changeId: CHANGE_ID, roundId: finalRound.id, markdown: "# Spec v2\n" });
    await completeBlueCritique({ changeId: CHANGE_ID, roundId: finalRound.id, blueJson: blueJson("P0") });
    await generateSpecReport(CHANGE_ID);

    await assert.rejects(
      () => applySpecBattleDecision({
        changeId: CHANGE_ID,
        action: "approve",
        targetType: "gate",
        targetId: null,
        reason: null,
      }),
      (err: Error) => err instanceof SpecBattleError && err.code === "gate_blocked"
    );
    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(change?.status, "SPEC_READY");
    assert.equal(change?.blockedPhase, null);
  });

  it("rejects completing blue critique for another change round", async () => {
    const otherChangeId = OTHER_CHANGE_ID;
    const now = new Date().toISOString();
    db.insert(changes).values({
      id: otherChangeId,
      projectId: PROJECT_ID,
      title: "Other change",
      status: "INTAKE_READY",
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
    try {
      db.insert(battleRounds).values({
        id: "BRD-SPEC-BATTLE-OTHER",
        changeId: otherChangeId,
        phase: "Spec",
        template: "SPEC_BATTLE_MVP",
        roundNo: 1,
        status: "blue_running",
        redUnit: "SPEC_WRITER",
        blueUnit: "REQUIREMENT_CRITIC",
        inputSnapshotJson: JSON.stringify({ authority: "db" }),
        paramsJson: JSON.stringify({ maxSpecRounds: 3, allowP1Waiver: true }),
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

      await assert.rejects(
        () => completeBlueCritique({ changeId: CHANGE_ID, roundId: "BRD-SPEC-BATTLE-OTHER", blueJson: blueJson("P0") }),
        (err: Error) => err instanceof SpecBattleError && err.code === "round_change_mismatch"
      );
    } finally {
      cleanupChangeRows(otherChangeId);
    }
  });
});
