import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
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
  findings,
  humanDecisions,
  prdBriefings,
  prdDrafts,
  projects,
  redFixClaims,
  requirementGaps,
  runs,
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
  warReports,
} from "../db/schema.ts";
import {
  applySpecBattleDecision,
  claimSpecBattleRedRun,
  completeBlueCritique,
  completeRedSpecRound,
  startSpecBattleRound,
} from "./spec-battle-service.ts";
import {
  generateSpecReport,
  generateWarReport,
  getSpecReportFreshness,
} from "./spec-battle-report-service.ts";
import { renderMirrorsFromDb } from "./artifact-mirror-service.ts";
import {
  completeStageRun,
  computeSourceDbHash,
  recomputeStageGate,
  startStageRun,
} from "./stage-authority-service.ts";

const PROJECT_ID = "PRJ-SPEC-REPORT";
const CHANGE_ID = "CHG-SPEC-REPORT";

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
  db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(warReports).where(eq(warReports.changeId, CHANGE_ID)).run();
  db.delete(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).run();
  db.delete(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).run();
  db.delete(redFixClaims).where(eq(redFixClaims.changeId, CHANGE_ID)).run();
  db.delete(requirementGaps).where(eq(requirementGaps.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).run();
  db.delete(briefingQuestions).where(eq(briefingQuestions.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(repoPath: string) {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Spec Report",
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
    title: "Spec Report change",
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

  const shipDir = path.join(repoPath, ".ship");
  const changeDir = path.join(shipDir, "changes", CHANGE_ID);
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(shipDir, "prd.md"), "# Baseline PRD\n");
  fs.writeFileSync(path.join(changeDir, "change-request.md"), "# Change\n");
  fs.writeFileSync(path.join(changeDir, "prd-delta.md"), "# PRD Delta\n");
  seedLockedPrdAuthority(repoPath);
}

function seedLockedPrdAuthority(repoPath: string) {
  const now = new Date().toISOString();
  const briefing = {
    id: "PBR-SPEC-REPORT",
    changeId: CHANGE_ID,
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
      id: "BQ-SPEC-REPORT",
      changeId: CHANGE_ID,
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
    id: "PDR-SPEC-REPORT",
    changeId: CHANGE_ID,
    version: 1,
    markdown: "# DB PRD Draft\n\n## 目标\n做战前会议室。\n",
    sourceQuestionIdsJson: JSON.stringify(["BQ-SPEC-REPORT"]),
    unresolvedQuestionIdsJson: JSON.stringify(["BQ-SPEC-REPORT"]),
    draftHash: "db-fixture-draft",
    createdAt: now,
  };

  db.insert(prdBriefings).values(briefing).run();
  db.insert(briefingQuestions).values(questions).run();
  db.insert(prdDrafts).values(draft).run();
  const sourceDbHash = computeSourceDbHash({
    changeId: CHANGE_ID,
    phase: "PRD",
    rows: [
      { table: "prd_briefings", row: briefing },
      { table: "briefing_questions", rows: questions },
      { table: "prd_drafts.latest", row: draft },
    ],
  });
  const run = startStageRun({
    changeId: CHANGE_ID,
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
    changeId: CHANGE_ID,
    phase: "PRD",
    status: "pass",
    blockers: [],
    freshness: { source: "db", lockedAt: now },
    requiredActions: [],
    sourceDbHash,
  });
  renderMirrorsFromDb({
    changeId: CHANGE_ID,
    repoPath,
    mirrors: [
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
        artifactType: "briefing_questions",
        fileName: "briefing-questions.json",
        schemaVersion: "prd-briefing.v1",
        sourceDbHash,
        payload: questions,
      },
    ],
  });
}

function blueJson(severity: "P0" | "P1" | "P2", id = `gap-${severity}`) {
  return JSON.stringify({
    gapReviews: [],
    requirementGaps: [
      {
        canonicalGapId: id,
        title: `${severity} 缺口`,
        category: "acceptance",
        severity,
        evidence: "验收标准不足",
        affectedArtifacts: ["prd-delta.md"],
        proposedSpecPatch: "补齐验收标准",
        specBlocking: severity === "P0" || severity === "P1",
        mergeBlocking: severity === "P0" || severity === "P1",
      },
    ],
  });
}

function redFixJson(id: string) {
  return JSON.stringify({
    prdDeltaMarkdown: "# Red Spec\n\n已补齐验收标准。\n",
    fixClaims: [
      {
        canonicalGapId: id,
        claimStatus: "fixed",
        claimSummary: "补齐缺失验收标准",
        evidence: "prd-delta.md 已加入可验证验收标准",
        artifactPath: "prd-delta.md",
      },
    ],
  });
}

function blueResolvedReviewJson(id: string) {
  return JSON.stringify({
    gapReviews: [
      {
        canonicalGapId: id,
        verdict: "resolved",
        reviewSummary: "验收标准已补齐",
        evidence: "复核 prd-delta.md 后确认缺口关闭",
        resolutionEvidence: "新增验收标准覆盖原 P1 缺口",
        downgradedTo: null,
      },
    ],
    requirementGaps: [],
  });
}

async function seedRound(severity: "P0" | "P1" | "P2", id?: string) {
  const round = await startSpecBattleRound(CHANGE_ID);
  await claimSpecBattleRedRun({
    changeId: CHANGE_ID,
    idempotencyKey: `spec-report-seed-${round.roundId}`,
  });
  await completeRedSpecRound({ changeId: CHANGE_ID, roundId: round.roundId, markdown: "# Red Spec\n" });
  await completeBlueCritique({ changeId: CHANGE_ID, roundId: round.roundId, blueJson: blueJson(severity, id) });
  return round.roundId;
}

describe("spec-battle-report-service", { concurrency: false }, () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "spec-battle-report-"));
    seedChange(repoPath);
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("generates a deterministic spec report row, artifact, and markdown", async () => {
    await seedRound("P0");

    const result = await generateSpecReport(CHANGE_ID);

    const row = db.select().from(warReports).where(eq(warReports.id, result.reportId)).get();
    assert.ok(row);
    assert.equal(row.type, "phase_report");
    assert.equal(row.status, "generated");
    assert.equal(row.blockingP0, 1);
    assert.equal(row.blockingP1, 0);
    assert.equal(row.nonBlockingP2, 0);
    assert.equal(fs.existsSync(result.path), true);
    const content = fs.readFileSync(result.path, "utf-8");
    assert.match(content, /Gate Verdict/);
    assert.match(content, /Required Next Action/);
    assert.match(content, /Requirement Gaps/);
    assert.match(content, /Human Decisions/);
    assert.match(content, /Round History/);

    const artifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.changeId, CHANGE_ID))
      .all()
      .find((item) => item.type === "spec_report");
    assert.equal(artifact?.path, result.path);
  });

  it("counts Requirement Gaps only and records source hashes", async () => {
    await seedRound("P2");
    db.insert(findings).values({
      id: `FND-SPEC-REPORT-${Date.now()}`,
      changeId: CHANGE_ID,
      runId: null,
      roundId: null,
      phase: "Spec",
      source: "requirement_critic",
      severity: "P0",
      category: "ordinary",
      title: "普通 finding 不应进入 counts",
      file: null,
      line: null,
      evidence: null,
      requiredFix: null,
      status: "open",
      createdAt: new Date().toISOString(),
      updatedAt: null,
    }).run();

    const result = await generateSpecReport(CHANGE_ID);

    assert.equal(result.counts.blockingP0, 0);
    assert.equal(result.counts.nonBlockingP2, 1);
    const sourceHashes = JSON.parse(result.sourceHashesJson);
    for (const key of [
      "prdStageSourceDbHash",
      "round",
      "gapRows",
      "decisions",
      "claims",
      "reviews",
      "findings",
      "params",
      "rounds",
    ]) {
      assert.equal(typeof sourceHashes[key], "string", key);
    }
    for (const fileKey of ["redArtifact", "blueArtifact", "prdDelta", "baselinePrd", "prdDraft", "briefingQuestions"]) {
      assert.equal(sourceHashes[fileKey], undefined, `${fileKey} must not participate in DB report freshness`);
    }
  });

  it("includes round delta, fix claims, gap reviews, and ledger sections", async () => {
    const canonicalGapId = "acceptance-gap";
    await seedRound("P1", canonicalGapId);
    await generateSpecReport(CHANGE_ID);

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "request_changes",
      targetType: "gate",
      targetId: null,
      reason: "请我方代理修复 P1 验收缺口",
    });

    const secondRound = db
      .select()
      .from(battleRounds)
      .where(eq(battleRounds.changeId, CHANGE_ID))
      .all()
      .sort((a, b) => b.roundNo - a.roundNo)[0];
    assert.ok(secondRound);
    await claimSpecBattleRedRun({
      changeId: CHANGE_ID,
      idempotencyKey: `spec-report-seed-${secondRound.id}`,
    });
    await completeRedSpecRound({
      changeId: CHANGE_ID,
      roundId: secondRound.id,
      markdown: redFixJson(canonicalGapId),
    });
    await completeBlueCritique({
      changeId: CHANGE_ID,
      roundId: secondRound.id,
      blueJson: blueResolvedReviewJson(canonicalGapId),
    });

    const result = await generateSpecReport(CHANGE_ID);
    const content = fs.readFileSync(result.path, "utf-8");

    assert.match(content, /## Round Delta/);
    assert.match(content, /本轮已解决/);
    assert.match(content, /仍在阻断/);
    assert.match(content, /新发现/);
    assert.match(content, /未复核/);
    assert.match(content, /## 我方修复声明/);
    assert.match(content, /## 反方复核/);
    assert.match(content, /## Gap Ledger/);
    assert.match(content, new RegExp(`本轮已解决[\\s\\S]*${canonicalGapId}`));
    assert.match(content, new RegExp(`我方修复声明[\\s\\S]*${canonicalGapId}`));
    assert.match(content, new RegExp(`反方复核[\\s\\S]*${canonicalGapId}`));
  });

  it("marks old reports stale after Waive P1 and rejects approving the stale report", async () => {
    await seedRound("P1", "waivable-gap");
    await generateSpecReport(CHANGE_ID);

    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "waive_p1",
      targetType: "requirement_gap",
      targetId: "waivable-gap",
      reason: "接受 P1 风险",
    });

    const freshness = getSpecReportFreshness(CHANGE_ID);
    assert.equal(freshness.reportFresh, false);
    await assert.rejects(
      () => applySpecBattleDecision({
        changeId: CHANGE_ID,
        action: "approve",
        targetType: "gate",
        targetId: null,
        reason: null,
      }),
      /report_stale/
    );
  });

  it("treats a regenerated phase report as fresh when an older stale report shares its timestamp", async () => {
    await seedRound("P1", "timestamp-collision-gap");
    const staleCreatedAt = new Date().toISOString();
    db.insert(warReports).values({
      id: "WRP-SPEC-REPORT-STALE-COLLISION",
      changeId: CHANGE_ID,
      roundId: null,
      phase: "Spec",
      type: "phase_report",
      status: "stale",
      path: path.join(repoPath, ".ship", "changes", CHANGE_ID, "reports", "old-spec-report.md"),
      sourceHashesJson: JSON.stringify({ staleReason: "waive_p1" }),
      reportHash: "old-report-hash",
      blockingP0: 0,
      blockingP1: 1,
      nonBlockingP2: 0,
      overriddenP0: 0,
      openRequirementGaps: 1,
      generatedBy: "BATTLE_REPORTER",
      aiPolished: 0,
      createdAt: staleCreatedAt,
      updatedAt: staleCreatedAt,
    }).run();

    const regenerated = await generateSpecReport(CHANGE_ID);
    const regeneratedRow = db.select().from(warReports).where(eq(warReports.id, regenerated.reportId)).get();
    assert.ok(regeneratedRow);
    db.update(warReports)
      .set({ createdAt: staleCreatedAt })
      .where(eq(warReports.id, regenerated.reportId))
      .run();

    const freshness = getSpecReportFreshness(CHANGE_ID);
    assert.equal(freshness.reportId, regenerated.reportId);
    assert.equal(freshness.reportFresh, true);
    assert.equal(freshness.staleReason, null);
  });

  it("keeps report freshness independent of changed file mirrors", async () => {
    const missingFreshness = getSpecReportFreshness(CHANGE_ID);
    assert.equal(missingFreshness.reportFresh, false);
    assert.equal(missingFreshness.staleReason, "report_missing");
    assert.equal(missingFreshness.reportId, null);

    await seedRound("P2");
    await generateSpecReport(CHANGE_ID);
    fs.writeFileSync(
      path.join(repoPath, ".ship", "changes", CHANGE_ID, "prd-delta.md"),
      "# Changed PRD Delta\n"
    );

    const freshness = getSpecReportFreshness(CHANGE_ID);
    assert.equal(freshness.reportFresh, true);
    assert.equal(freshness.staleReason, null);
  });

  it("marks the change-level war report stale when a new spec report is generated", async () => {
    await seedRound("P2");
    const war = await generateWarReport(CHANGE_ID);
    await generateSpecReport(CHANGE_ID);

    const oldWar = db.select().from(warReports).where(eq(warReports.id, war.reportId)).get();
    assert.equal(oldWar?.status, "stale");
  });
});
