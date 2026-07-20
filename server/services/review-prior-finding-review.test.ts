import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";

import { runMigrations } from "../db/migrate.ts";
import {
  artifacts,
  buildRunRecords,
  changes,
  findings,
  projects,
  reviewAttempts,
  reviewPriorFindingReviews,
  runs,
} from "../db/schema.ts";
import {
  completeReviewAttemptFromStructuredOutput,
  setReviewRunServiceDbForTest,
  startReviewRun,
} from "./review-run-service.ts";

const PROJECT_ID = "PRJ-PRIOR-REVIEW";
const CHANGE_ID = "CHG-PRIOR-REVIEW";

function seedChange(db: ReturnType<typeof drizzle>) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Review prior finding review",
    repoPath: "/tmp/review-prior-finding-review",
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
    title: "Review prior finding review",
    status: "IMPLEMENTED",
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

function insertArtifact(db: ReturnType<typeof drizzle>, id = "ART-RAW") {
  db.insert(artifacts).values({
    id,
    changeId: CHANGE_ID,
    runId: null,
    type: "review_raw_output",
    path: `/tmp/${id}.json`,
    createdAt: "2026-06-29T00:00:00.000Z",
  }).run();
}

function insertRun(db: ReturnType<typeof drizzle>, id = "RUN-NEW") {
  db.insert(runs).values({
    id,
    changeId: CHANGE_ID,
    phase: "review",
    status: "running",
    startedAt: "2026-06-29T00:00:00.000Z",
    endedAt: null,
    summary: null,
  }).run();
}

function insertAdoptedBuildRun(db: ReturnType<typeof drizzle>) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(buildRunRecords).values({
    id: "BRR-PRIOR-001",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-1",
    status: "adopted",
    headSha: "HEAD-1",
    baseHeadSha: "BASE-1",
    baseCommit: "BASE-1",
    patchHash: "patch-hash-1",
    changedFilesHash: "files-hash-1",
    adoptedHeadSha: "HEAD-1",
    adoptionDecisionId: "build-1-adoption",
    adoptedAt: now,
    artifactHash: "patch-artifact-1",
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
}

function insertReviewFinding(
  db: ReturnType<typeof drizzle>,
  values: { id: string; severity: "P0" | "P1" | "P2"; status?: string },
) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(findings).values({
    id: values.id,
    changeId: CHANGE_ID,
    runId: null,
    source: "review",
    severity: values.severity,
    category: "bug",
    title: values.id,
    file: "src/app.ts",
    line: 1,
    evidence: `${values.id} evidence`,
    requiredFix: `${values.id} required fix`,
    status: values.status ?? "open",
    createdAt: now,
    updatedAt: now,
  }).run();
}

describe("review prior finding review completion", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;
  let restoreDb: (() => void) | null = null;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite);
    db = drizzle(sqlite);
    restoreDb = setReviewRunServiceDbForTest(db);
    seedChange(db);
    insertArtifact(db);
    insertRun(db);
    insertAdoptedBuildRun(db);
  });

  afterEach(() => {
    restoreDb?.();
    sqlite.close();
  });

  it("marks missing frozen open P0/P1 reviews as not_rechecked and keeps blockers open", () => {
    insertReviewFinding(db, { id: "FND-OLD-P0", severity: "P0" });
    insertReviewFinding(db, { id: "FND-OLD-P1", severity: "P1" });
    const { attempt } = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "missing-prior" });

    const result = completeReviewAttemptFromStructuredOutput({
      attemptId: attempt.id,
      runId: "RUN-NEW",
      rawOutputArtifactId: "ART-RAW",
      structuredOutput: {
        approved: true,
        summary: "Review omitted one prior blocker.",
        findings: [],
        priorFindingReviews: [
          {
            priorFindingId: "FND-OLD-P0",
            verdict: "fixed",
            evidence: "The P0 no longer reproduces.",
            requiredFix: null,
            reviewerNotes: "Fixed by the latest build.",
          },
        ],
      },
    });

    const attemptRow = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, attempt.id)).get();
    assert.equal(result.reviewStatus, "issues_found");
    assert.equal(attemptRow?.reviewStatus, "issues_found");
    assert.equal(attemptRow?.rawOutputArtifactId, "ART-RAW");
    assert.equal(db.select().from(findings).where(eq(findings.reviewAttemptId, attempt.id)).all().length, 0);
    assert.deepEqual(
      db
        .select()
        .from(reviewPriorFindingReviews)
        .where(eq(reviewPriorFindingReviews.attemptId, attempt.id))
        .all()
        .map((row) => ({ priorFindingId: row.priorFindingId, verdict: row.verdict })),
      [
        { priorFindingId: "FND-OLD-P0", verdict: "fixed" },
        { priorFindingId: "FND-OLD-P1", verdict: "not_rechecked" },
      ],
    );
    assert.equal(db.select().from(findings).where(eq(findings.id, "FND-OLD-P0")).get()?.status, "fixed");
    assert.equal(db.select().from(findings).where(eq(findings.id, "FND-OLD-P1")).get()?.status, "open");
  });

  it("writes legal verdicts transactionally and fixed closes the old finding", () => {
    insertReviewFinding(db, { id: "FND-OLD-P0", severity: "P0" });
    insertReviewFinding(db, { id: "FND-OLD-P1", severity: "P1" });
    const { attempt } = startReviewRun({
      changeId: CHANGE_ID,
      idempotencyKey: "legal-verdicts",
      sourceBuildRunId: "build-1",
      sourceHeadSha: "HEAD-1",
    });

    const result = completeReviewAttemptFromStructuredOutput({
      attemptId: attempt.id,
      runId: "RUN-NEW",
      rawOutputArtifactId: "ART-RAW",
      structuredOutput: {
        approved: false,
        summary: "One blocker fixed, one blocker remains open, and one new P2 was found.",
        findings: [
          {
            severity: "P2",
            category: "maintainability",
            file: "src/app.ts",
            line: 2,
            title: "Keep an eye on naming",
            evidence: "src/app.ts still uses a placeholder export.",
            requiredFix: null,
          },
        ],
        priorFindingReviews: [
          {
            priorFindingId: "FND-OLD-P0",
            verdict: "fixed",
            evidence: "The P0 no longer reproduces on the adopted build.",
            requiredFix: null,
            reviewerNotes: "Closed by explicit recheck.",
          },
          {
            priorFindingId: "FND-OLD-P1",
            verdict: "still_open",
            evidence: "The P1 behavior still reproduces.",
            requiredFix: "Finish the remaining fix.",
            reviewerNotes: "Still blocks QA.",
          },
        ],
      },
    });

    assert.equal(result.reviewStatus, "issues_found");
    assert.equal(result.findings.length, 1);
    const newFinding = db.select().from(findings).where(eq(findings.reviewAttemptId, attempt.id)).get();
    assert.equal(newFinding?.sourceBuildRunId, "build-1");
    assert.equal(newFinding?.sourceHeadSha, "HEAD-1");
    assert.equal(newFinding?.waivable, 0);
    assert.equal(db.select().from(findings).where(eq(findings.id, "FND-OLD-P0")).get()?.status, "fixed");
    assert.equal(db.select().from(findings).where(eq(findings.id, "FND-OLD-P1")).get()?.status, "open");
    assert.deepEqual(
      db
        .select()
        .from(reviewPriorFindingReviews)
        .where(eq(reviewPriorFindingReviews.attemptId, attempt.id))
        .all()
        .map((row) => ({ priorFindingId: row.priorFindingId, verdict: row.verdict })),
      [
        { priorFindingId: "FND-OLD-P0", verdict: "fixed" },
        { priorFindingId: "FND-OLD-P1", verdict: "still_open" },
      ],
    );
  });

  it("rejects illegal prior verdicts without inserting new findings or settling pending reviews", () => {
    insertReviewFinding(db, { id: "FND-OLD-P1", severity: "P1" });
    const { attempt } = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "illegal-verdict" });

    assert.throws(
      () =>
        completeReviewAttemptFromStructuredOutput({
          attemptId: attempt.id,
          runId: "RUN-NEW",
          rawOutputArtifactId: "ART-RAW",
          structuredOutput: {
            approved: false,
            summary: "Illegal prior verdict.",
            findings: [
              {
                severity: "P1",
                category: "bug",
                file: null,
                line: null,
                title: "New blocker should not be half-written",
                evidence: "This finding is valid on its own.",
                requiredFix: "Fix it.",
              },
            ],
            priorFindingReviews: [
              {
                priorFindingId: "FND-OLD-P1",
                verdict: "resolved",
                evidence: "Not an allowed verdict.",
                requiredFix: null,
                reviewerNotes: "Bad verdict.",
              },
            ],
          },
        }),
      /invalid_review_output/,
    );

    assert.equal(db.select().from(findings).where(eq(findings.reviewAttemptId, attempt.id)).all().length, 0);
    assert.equal(
      db
        .select()
        .from(reviewPriorFindingReviews)
        .where(eq(reviewPriorFindingReviews.attemptId, attempt.id))
        .get()?.verdict,
      "pending",
    );
    assert.equal(db.select().from(findings).where(eq(findings.id, "FND-OLD-P1")).get()?.status, "open");
  });

  it("requires prior verdicts to include evidence or notes", () => {
    insertReviewFinding(db, { id: "FND-OLD-P1", severity: "P1" });
    const { attempt } = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "empty-prior-support" });

    assert.throws(
      () =>
        completeReviewAttemptFromStructuredOutput({
          attemptId: attempt.id,
          runId: "RUN-NEW",
          rawOutputArtifactId: "ART-RAW",
          structuredOutput: {
            approved: false,
            summary: "Prior verdict lacks support.",
            findings: [],
            priorFindingReviews: [
              {
                priorFindingId: "FND-OLD-P1",
                verdict: "not_rechecked",
                evidence: null,
                requiredFix: null,
                reviewerNotes: null,
              },
            ],
          },
        }),
      /invalid_review_output: priorFindingReviews require evidence or reviewerNotes/,
    );

    assert.equal(
      db
        .select()
        .from(reviewPriorFindingReviews)
        .where(eq(reviewPriorFindingReviews.attemptId, attempt.id))
        .get()?.verdict,
      "pending",
    );
    assert.equal(db.select().from(findings).where(eq(findings.id, "FND-OLD-P1")).get()?.status, "open");
  });

  it("requires still_open and downgraded prior verdicts to include an actionable requiredFix", () => {
    insertReviewFinding(db, { id: "FND-OLD-P0", severity: "P0" });
    insertReviewFinding(db, { id: "FND-OLD-P1", severity: "P1" });
    const { attempt } = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "prior-required-fix" });

    assert.throws(
      () =>
        completeReviewAttemptFromStructuredOutput({
          attemptId: attempt.id,
          runId: "RUN-NEW",
          rawOutputArtifactId: "ART-RAW",
          structuredOutput: {
            approved: false,
            summary: "Prior verdict lacks required follow-up.",
            findings: [],
            priorFindingReviews: [
              {
                priorFindingId: "FND-OLD-P0",
                verdict: "still_open",
                evidence: "The old P0 still reproduces.",
                requiredFix: "",
                reviewerNotes: "Still blocking.",
              },
              {
                priorFindingId: "FND-OLD-P1",
                verdict: "downgraded",
                evidence: "The old P1 is now only a P2.",
                requiredFix: null,
                reviewerNotes: "Needs non-blocking cleanup.",
              },
            ],
          },
        }),
      /invalid_review_output: still_open and downgraded priorFindingReviews require requiredFix/,
    );

    assert.deepEqual(
      db
        .select()
        .from(reviewPriorFindingReviews)
        .where(eq(reviewPriorFindingReviews.attemptId, attempt.id))
        .all()
        .map((row) => row.verdict),
      ["pending", "pending"],
    );
  });
});
