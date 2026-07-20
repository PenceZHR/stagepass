import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import {
  artifacts,
  changes,
  findings,
  projects,
  reviewArtifactMirrors,
  reviewAttempts,
  reviewReports,
} from "../db/schema";
import { settlementFindingsForReviewAttempt } from "./review-report-service";

type ReviewArtifactMirrorDb = typeof import("../db/index").db;
type ReviewReport = typeof reviewReports.$inferSelect;
type ReviewAttempt = typeof reviewAttempts.$inferSelect;
type ReviewFinding = typeof findings.$inferSelect;
type Artifact = typeof artifacts.$inferSelect;
type ReviewArtifactMirror = typeof reviewArtifactMirrors.$inferSelect;

export type ReviewMirrorKind = "review_report" | "review_findings";
export type ReviewMirrorStatus = "ok" | "missing" | "mismatch" | "generation_failed";

export interface ReviewMirrorInspection {
  kind: ReviewMirrorKind;
  status: ReviewMirrorStatus;
  path: string;
  schemaVersion: string;
  sourceDbHash: string;
  expectedContentHash: string;
  recordedContentHash: string | null;
  artifactId: string | null;
  warnings: string[];
}

export interface ReviewRawOutputArtifactMetadata {
  id: string;
  type: string;
  path: string;
  createdAt: string;
}

export interface ReviewMirrorInspectionResult {
  reportId: string;
  changeId: string;
  mirrors: ReviewMirrorInspection[];
  warnings: string[];
  rawOutputArtifact: ReviewRawOutputArtifactMetadata | null;
}

export interface ReviewMirrorRebuildResult extends ReviewMirrorInspectionResult {
  rebuilt: ReviewMirrorKind[];
}

interface MirrorContext {
  db: ReviewArtifactMirrorDb;
  report: ReviewReport;
  attempt: ReviewAttempt;
  repoPath: string;
  changeId: string;
  settlementFindings: ReviewFinding[];
}

interface ExpectedMirror {
  kind: ReviewMirrorKind;
  type: string;
  fileName: string;
  schemaVersion: string;
  sourceDbHash: string;
  path: string;
  content: string;
  contentHash: string;
}

const requireDefaultDb = createRequire(import.meta.url);
let reviewArtifactMirrorDbForTest: ReviewArtifactMirrorDb | null = null;
let defaultReviewArtifactMirrorDb: ReviewArtifactMirrorDb | null = null;

export function setReviewArtifactMirrorServiceDbForTest(
  nextDb: ReviewArtifactMirrorDb,
): () => void {
  const previous = reviewArtifactMirrorDbForTest;
  reviewArtifactMirrorDbForTest = nextDb;
  return () => {
    reviewArtifactMirrorDbForTest = previous;
  };
}

function getReviewArtifactMirrorDb(): ReviewArtifactMirrorDb {
  if (reviewArtifactMirrorDbForTest) return reviewArtifactMirrorDbForTest;
  if (!defaultReviewArtifactMirrorDb) {
    defaultReviewArtifactMirrorDb = (
      requireDefaultDb("../db/index") as typeof import("../db/index")
    ).db;
  }
  return defaultReviewArtifactMirrorDb;
}

function nowISO(): string {
  return new Date().toISOString();
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortForStableJson(value), null, 2)}\n`;
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortForStableJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function nextPrefixedId(ids: string[], prefix: string): string {
  const used = new Set(ids);
  let maxNum = 0;
  for (const id of ids) {
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) maxNum = Math.max(maxNum, Number.parseInt(match[1], 10));
  }

  let nextNum = maxNum + 1;
  let candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

function nextArtifactId(db: ReviewArtifactMirrorDb): string {
  return nextPrefixedId(
    db.select({ id: artifacts.id }).from(artifacts).all().map((row) => row.id),
    "ART",
  );
}

function nextMirrorId(db: ReviewArtifactMirrorDb): string {
  return nextPrefixedId(
    db.select({ id: reviewArtifactMirrors.id }).from(reviewArtifactMirrors).all().map((row) => row.id),
    "RAM",
  );
}

function changeArtifactDir(repoPath: string, changeId: string): string {
  return path.join(repoPath, ".ship", "changes", changeId);
}

function readContext(reportId: string): MirrorContext {
  const db = getReviewArtifactMirrorDb();
  const report = db.select().from(reviewReports).where(eq(reviewReports.id, reportId)).get();
  if (!report) throw new Error(`Review report not found: ${reportId}`);

  const attempt = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, report.attemptId)).get();
  if (!attempt || attempt.changeId !== report.changeId) {
    throw new Error(`Review report points to a missing or mismatched attempt: ${reportId}`);
  }

  const change = db.select().from(changes).where(eq(changes.id, report.changeId)).get();
  if (!change) throw new Error(`Change not found for review report: ${report.changeId}`);

  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new Error(`Project not found for change: ${change.id}`);

  const reviewFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, report.changeId))
    .all()
    .filter((finding) => finding.source === "review");

  return {
    db,
    report,
    attempt,
    repoPath: project.repoPath,
    changeId: report.changeId,
    settlementFindings: settlementFindingsForReviewAttempt(attempt, reviewFindings),
  };
}

function mirrorFindingPayload(finding: ReviewFinding) {
  return {
    id: finding.id,
    changeId: finding.changeId,
    runId: finding.runId,
    reviewAttemptId: finding.reviewAttemptId,
    sourceBuildRunId: finding.sourceBuildRunId,
    sourceHeadSha: finding.sourceHeadSha,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    file: finding.file,
    line: finding.line,
    evidence: finding.evidence,
    requiredFix: finding.requiredFix,
    status: finding.status,
    waivable: finding.waivable === 1,
    waivedBy: finding.waivedBy,
    waivedAt: finding.waivedAt,
    waiverDecisionId: finding.waiverDecisionId,
    legacyState: finding.legacyState,
    legacyFindingKey: finding.legacyFindingKey,
    findingVersion: finding.findingVersion,
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
  };
}

function renderReportMarkdown(context: MirrorContext): string {
  const { attempt, report, settlementFindings } = context;
  const staleReasons = report.staleReason ? safeParseStringArray(report.staleReason) : [];
  const lines = [
    "# Review Report",
    "",
    `Report ID: ${report.id}`,
    `Attempt ID: ${attempt.id}`,
    `Attempt No: ${attempt.attemptNo}`,
    `Run ID: ${attempt.runId ?? "n/a"}`,
    `Conclusion: ${report.reviewConclusion ?? "n/a"}`,
    `Gate Status: ${report.gateStatus}`,
    `QA Allowed: ${report.qaAllowed === 1 ? "yes" : "no"}`,
    `Source Build Run ID: ${report.sourceBuildRunId ?? "n/a"}`,
    `Source Head SHA: ${report.sourceHeadSha ?? "n/a"}`,
    `Generated At: ${report.generatedAt}`,
    "",
    "## Counts",
    "",
    `- Blocking P0: ${report.blockingP0}`,
    `- Blocking P1: ${report.blockingP1}`,
    `- Waived P1: ${report.waivedP1}`,
    `- P2: ${report.p2Count}`,
    "",
    "## Stale Reasons",
    "",
    staleReasons.length === 0 ? "None." : staleReasons.map((reason) => `- ${reason}`).join("\n"),
    "",
    "## Findings",
    "",
    settlementFindings.length === 0
      ? "No findings."
      : settlementFindings
          .map((finding) => {
            const location = finding.file
              ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
              : "n/a";
            return [
              `- ${finding.severity} ${finding.id}: ${finding.title}`,
              `  - Status: ${finding.status}`,
              `  - Location: ${location}`,
              `  - Evidence: ${finding.evidence ?? "n/a"}`,
              `  - Required Fix: ${finding.requiredFix ?? "n/a"}`,
            ].join("\n");
          })
          .join("\n"),
    "",
  ];
  return lines.join("\n");
}

function safeParseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [value];
  } catch {
    return [value];
  }
}

/**
 * Mirrors live in their own directory, under their own artifact types.
 *
 * The Review stage's post-commit writer also emits review-report.md and
 * review-findings.json into the change dir, in a different shape. These are
 * two different artifacts that happened to share a filename: one is a run's
 * output snapshot, the other is the DB→file evidence projection. Writing both
 * to one path meant whoever ran last won, so the mirror hash could never be
 * trusted. Keeping them apart is what makes the mirror's hash loop meaningful.
 */
function mirrorArtifactDir(repoPath: string, changeId: string): string {
  return path.join(changeArtifactDir(repoPath, changeId), "mirrors");
}

function expectedMirrors(context: MirrorContext): ExpectedMirror[] {
  const baseDir = mirrorArtifactDir(context.repoPath, context.changeId);
  const findingsContent = stableJson(context.settlementFindings.map(mirrorFindingPayload));
  const reportContent = renderReportMarkdown(context);
  const findingsDbHash =
    context.report.findingsDbHash ?? sha256Text(stableJson(context.settlementFindings.map(mirrorFindingPayload)));

  return [
    {
      kind: "review_report",
      type: "review_report_mirror",
      fileName: "review-report.md",
      schemaVersion: "review-report/v1",
      sourceDbHash: context.report.reportDbHash,
      path: path.join(baseDir, "review-report.md"),
      content: reportContent,
      contentHash: sha256Text(reportContent),
    },
    {
      kind: "review_findings",
      type: "review_findings_mirror",
      fileName: "review-findings.json",
      schemaVersion: "review-findings/v1",
      sourceDbHash: findingsDbHash,
      path: path.join(baseDir, "review-findings.json"),
      content: findingsContent,
      contentHash: sha256Text(findingsContent),
    },
  ];
}

function existingMirror(
  db: ReviewArtifactMirrorDb,
  reportId: string,
  kind: ReviewMirrorKind,
): ReviewArtifactMirror | null {
  const rows = db
    .select()
    .from(reviewArtifactMirrors)
    .where(and(eq(reviewArtifactMirrors.reportId, reportId), eq(reviewArtifactMirrors.kind, kind)))
    .all();
  rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return rows[0] ?? null;
}

function existingArtifact(
  db: ReviewArtifactMirrorDb,
  changeId: string,
  type: string,
  filePath: string,
): Artifact | null {
  return (
    db
      .select()
      .from(artifacts)
      .where(
        and(eq(artifacts.changeId, changeId), eq(artifacts.type, type), eq(artifacts.path, filePath)),
      )
      .get() ?? null
  );
}

function upsertArtifact(
  db: ReviewArtifactMirrorDb,
  context: MirrorContext,
  expected: ExpectedMirror,
): Artifact {
  const existing = existingArtifact(db, context.changeId, expected.type, expected.path);
  if (existing) return existing;

  const id = nextArtifactId(db);
  db.insert(artifacts)
    .values({
      id,
      changeId: context.changeId,
      runId: context.attempt.runId,
      type: expected.type,
      path: expected.path,
      createdAt: nowISO(),
    })
    .run();
  const inserted = db.select().from(artifacts).where(eq(artifacts.id, id)).get();
  if (!inserted) throw new Error(`Failed to create artifact for ${expected.kind}`);
  return inserted;
}

function upsertMirror(
  db: ReviewArtifactMirrorDb,
  context: MirrorContext,
  expected: ExpectedMirror,
  values: {
    artifactId: string | null;
    status: ReviewMirrorStatus;
    /**
     * sha256 of the bytes actually on disk, when we read them. content_hash is
     * the hash the DB expects; artifact_hash is what the file really is. Keeping
     * them separate is what makes the loop three-way — on a mismatch you can see
     * both sides instead of two copies of the expectation.
     */
    actualHash?: string | null;
    lastCheckedAt?: string | null;
    lastRebuiltAt?: string | null;
    errorCode?: string | null;
  },
): ReviewArtifactMirror {
  const existing = existingMirror(db, context.report.id, expected.kind);
  const now = nowISO();
  const rowValues = {
    changeId: context.changeId,
    artifactId: values.artifactId,
    path: expected.path,
    schemaVersion: expected.schemaVersion,
    sourceDbHash: expected.sourceDbHash,
    contentHash: values.status === "ok" ? expected.contentHash : existing?.contentHash ?? null,
    mirrorStatus: values.status,
    lastCheckedAt: values.lastCheckedAt ?? existing?.lastCheckedAt ?? null,
    lastRebuiltAt: values.lastRebuiltAt ?? existing?.lastRebuiltAt ?? null,
    errorCode: values.errorCode ?? null,
    artifactPath: expected.path,
    artifactHash: values.actualHash ?? existing?.artifactHash ?? null,
  };

  if (existing) {
    db.update(reviewArtifactMirrors).set(rowValues).where(eq(reviewArtifactMirrors.id, existing.id)).run();
    const updated = db.select().from(reviewArtifactMirrors).where(eq(reviewArtifactMirrors.id, existing.id)).get();
    if (!updated) throw new Error(`Failed to update review mirror ${existing.id}`);
    return updated;
  }

  const id = nextMirrorId(db);
  db.insert(reviewArtifactMirrors)
    .values({
      id,
      reportId: context.report.id,
      kind: expected.kind,
      createdAt: now,
      ...rowValues,
    })
    .run();
  const inserted = db.select().from(reviewArtifactMirrors).where(eq(reviewArtifactMirrors.id, id)).get();
  if (!inserted) throw new Error(`Failed to create review mirror for ${expected.kind}`);
  return inserted;
}

function inspectExpectedMirror(context: MirrorContext, expected: ExpectedMirror): ReviewMirrorInspection {
  const db = context.db;
  const mirror = existingMirror(db, context.report.id, expected.kind);
  const warnings: string[] = [];
  let status: ReviewMirrorStatus = "ok";
  let actualHash: string | null = null;
  const mirrorPath = mirror?.path ?? expected.path;

  if (!mirror) {
    status = "missing";
    warnings.push(`${expected.kind}:mirror_row_missing`);
  } else if (!mirror.path || !fs.existsSync(mirror.path)) {
    status = mirror.mirrorStatus === "generation_failed" ? "generation_failed" : "missing";
    warnings.push(
      mirror.mirrorStatus === "generation_failed"
        ? `${expected.kind}:generation_failed`
        : `${expected.kind}:file_missing`,
    );
  } else {
    actualHash = sha256Text(fs.readFileSync(mirror.path, "utf-8"));
    if (actualHash !== expected.contentHash || mirror.contentHash !== expected.contentHash) {
      status = "mismatch";
      warnings.push(`${expected.kind}:content_hash_mismatch`);
    }
    if (mirror.sourceDbHash !== expected.sourceDbHash || mirror.schemaVersion !== expected.schemaVersion) {
      status = "mismatch";
      warnings.push(`${expected.kind}:source_db_mismatch`);
    }
  }

  // A mirror row created by a previous inspect kept artifact_id NULL forever,
  // because only the rebuild path ever resolved the artifact. Look the artifact
  // up here too. This is a read, not an insert: inspect must not mint artifacts.
  const artifactId =
    mirror?.artifactId
    ?? existingArtifact(db, context.changeId, expected.type, expected.path)?.id
    ?? null;

  upsertMirror(db, context, expected, {
    artifactId,
    status,
    actualHash,
    lastCheckedAt: nowISO(),
    errorCode: status === "ok" ? null : status,
  });

  return {
    kind: expected.kind,
    status,
    path: mirrorPath,
    schemaVersion: expected.schemaVersion,
    sourceDbHash: expected.sourceDbHash,
    expectedContentHash: expected.contentHash,
    recordedContentHash: actualHash ?? mirror?.contentHash ?? null,
    artifactId,
    warnings,
  };
}

function rawOutputMetadata(context: MirrorContext): ReviewRawOutputArtifactMetadata | null {
  if (!context.attempt.rawOutputArtifactId) return null;
  const artifact = context.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, context.attempt.rawOutputArtifactId))
    .get();
  if (!artifact) return null;
  return {
    id: artifact.id,
    type: artifact.type,
    path: artifact.path,
    createdAt: artifact.createdAt,
  };
}

function errorCodeFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 120) || "generation_failed";
}

export function inspectReviewMirrors(reportId: string): ReviewMirrorInspectionResult {
  const context = readContext(reportId);
  const mirrors = expectedMirrors(context).map((expected) => inspectExpectedMirror(context, expected));
  const warnings = mirrors.flatMap((mirror) => mirror.warnings).sort();
  return {
    reportId,
    changeId: context.changeId,
    mirrors,
    warnings,
    rawOutputArtifact: rawOutputMetadata(context),
  };
}

export function rebuildReviewMirrors(reportId: string): ReviewMirrorRebuildResult {
  const context = readContext(reportId);
  const rebuilt: ReviewMirrorKind[] = [];

  for (const expected of expectedMirrors(context)) {
    try {
      fs.mkdirSync(path.dirname(expected.path), { recursive: true });
      fs.writeFileSync(expected.path, expected.content, "utf-8");
      const artifact = upsertArtifact(context.db, context, expected);
      upsertMirror(context.db, context, expected, {
        artifactId: artifact.id,
        status: "ok",
        // We just wrote these bytes, so what is on disk is the expected content.
        actualHash: sha256Text(fs.readFileSync(expected.path, "utf-8")),
        lastCheckedAt: nowISO(),
        lastRebuiltAt: nowISO(),
        errorCode: null,
      });
      rebuilt.push(expected.kind);
    } catch (error) {
      recordReviewMirrorFailure(reportId, expected.kind, error);
    }
  }

  return {
    ...inspectReviewMirrors(reportId),
    rebuilt,
  };
}

export function recordReviewMirrorFailure(
  reportId: string,
  kind: ReviewMirrorKind,
  error: unknown,
): ReviewArtifactMirror {
  const context = readContext(reportId);
  const expected = expectedMirrors(context).find((candidate) => candidate.kind === kind);
  if (!expected) throw new Error(`Unsupported review mirror kind: ${kind}`);
  return upsertMirror(context.db, context, expected, {
    artifactId: existingMirror(context.db, reportId, kind)?.artifactId ?? null,
    status: "generation_failed",
    lastCheckedAt: nowISO(),
    errorCode: errorCodeFrom(error),
  });
}
