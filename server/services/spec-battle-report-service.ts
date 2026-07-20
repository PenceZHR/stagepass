import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "../db";
import {
  artifacts,
  battleRounds,
  blueGapReviews,
  changes,
  findings,
  humanDecisions,
  projects,
  redFixClaims,
  requirementGaps,
  warReports,
} from "../db/schema";
import { inspectArtifactMirrors, renderMirrorsFromDb } from "./artifact-mirror-service";
import { computeRoundDelta, type LedgerGap } from "./spec-battle-ledger";
import { computeGapCounts, isMergeBlockingGap, isSpecBlockingGap, type RuleGap } from "./spec-battle-rules";
import {
  completeStageRun,
  computeSourceDbHash,
  getStageAuthority,
  recomputeStageGate,
  startStageRun,
} from "./stage-authority-service";

export interface SpecReportResult {
  reportId: string;
  path: string;
  reportHash: string;
  sourceHashesJson: string;
  counts: ReturnType<typeof computeGapCounts>;
}

export type WarReportResult = SpecReportResult;

export interface ReportFreshness {
  reportFresh: boolean;
  staleReason: string | null;
  reportId: string | null;
  reportHash?: string | null;
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

async function nextId(table: AnyTableWithId, prefix: string): Promise<string> {
  void table;
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function getChangeAndProject(changeId: string) {
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new Error(`Project not found: ${change.projectId}`);
  return { change, project };
}

function changeDir(repoPath: string, changeId: string): string {
  return path.join(repoPath, ".ship", "changes", changeId);
}

function reportsDir(repoPath: string, changeId: string): string {
  return path.join(changeDir(repoPath, changeId), "reports");
}

function toRuleGap(gap: typeof requirementGaps.$inferSelect): RuleGap {
  return {
    id: gap.id,
    severity: gap.severity as RuleGap["severity"],
    originalSeverity: gap.originalSeverity as RuleGap["originalSeverity"],
    downgradedTo: gap.downgradedTo as RuleGap["downgradedTo"],
    status: gap.status as RuleGap["status"],
  };
}

function toLedgerGap(gap: typeof requirementGaps.$inferSelect): LedgerGap {
  return {
    id: gap.id,
    canonicalGapId: gap.canonicalGapId,
    severity: gap.severity as LedgerGap["severity"],
    originalSeverity: gap.originalSeverity as LedgerGap["originalSeverity"],
    downgradedTo: gap.downgradedTo as LedgerGap["downgradedTo"],
    status: gap.status as LedgerGap["status"],
    firstSeenRoundId: gap.firstSeenRoundId,
    lastEvaluatedRoundId: gap.lastEvaluatedRoundId,
  };
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? "").localeCompare(b ?? "");
}

function latestRound(changeId: string) {
  return db
    .select()
    .from(battleRounds)
    .where(eq(battleRounds.changeId, changeId))
    .all()
    .sort((a, b) => b.roundNo - a.roundNo)[0] ?? null;
}

function rowsForReport(changeId: string) {
  const rounds = db
    .select()
    .from(battleRounds)
    .where(eq(battleRounds.changeId, changeId))
    .all()
    .sort((a, b) => a.roundNo - b.roundNo);
  const gaps = db
    .select()
    .from(requirementGaps)
    .where(eq(requirementGaps.changeId, changeId))
    .all()
    .sort((a, b) => compareText(a.canonicalGapId, b.canonicalGapId) || compareText(a.id, b.id));
  const decisions = db
    .select()
    .from(humanDecisions)
    .where(eq(humanDecisions.changeId, changeId))
    .all()
    .sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id));
  const claims = db
    .select()
    .from(redFixClaims)
    .where(eq(redFixClaims.changeId, changeId))
    .all()
    .sort(
      (a, b) =>
        compareText(a.roundId, b.roundId) ||
        compareText(a.canonicalGapId, b.canonicalGapId) ||
        compareText(a.id, b.id)
    );
  const reviews = db
    .select()
    .from(blueGapReviews)
    .where(eq(blueGapReviews.changeId, changeId))
    .all()
    .sort(
      (a, b) =>
        compareText(a.roundId, b.roundId) ||
        compareText(a.canonicalGapId, b.canonicalGapId) ||
        compareText(a.id, b.id)
    );
  const specFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((finding) => finding.phase === "Spec")
    .sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id));
  return { rounds, gaps, decisions, claims, reviews, findings: specFindings };
}

function rowHash(label: string, value: unknown): string {
  return sha256Text(JSON.stringify({ label, value }));
}

function reportSourceHashes(changeId: string) {
  const { rounds, gaps, decisions, claims, reviews, findings: specFindings } = rowsForReport(changeId);
  const round = latestRound(changeId);
  const prdStage = getStageAuthority(changeId, "PRD");
  return {
    prdStageSourceDbHash: prdStage.latestGate?.sourceDbHash ?? "missing",
    round: rowHash("battle_rounds.latest", round ?? null),
    gapRows: rowHash("requirement_gaps", gaps),
    decisions: rowHash("human_decisions", decisions),
    claims: rowHash("red_fix_claims", claims),
    reviews: rowHash("blue_gap_reviews", reviews),
    findings: rowHash("findings.Spec", specFindings),
    params: rowHash("battle_rounds.latest.params", round?.paramsJson ?? "{}"),
    rounds: rowHash("battle_rounds", rounds),
  };
}

function reportSourceDbHash(changeId: string): string {
  const rows = rowsForReport(changeId);
  const prdStage = getStageAuthority(changeId, "PRD");
  return computeSourceDbHash({
    changeId,
    phase: "Spec",
    rows: [
      { table: "stage_gates.PRD.source", sourceDbHash: prdStage.latestGate?.sourceDbHash ?? null },
      { table: "battle_rounds", rows: rows.rounds },
      { table: "requirement_gaps", rows: rows.gaps },
      { table: "red_fix_claims", rows: rows.claims },
      { table: "blue_gap_reviews", rows: rows.reviews },
      { table: "human_decisions", rows: rows.decisions },
      { table: "findings.Spec", rows: rows.findings },
    ],
  });
}

function syncSpecReportStageAuthority(input: {
  changeId: string;
  counts: ReturnType<typeof computeGapCounts>;
  reportDbHash: string;
  reportId: string;
}): void {
  const blockers = db
    .select()
    .from(requirementGaps)
    .where(eq(requirementGaps.changeId, input.changeId))
    .all()
    .filter((gap) => isSpecBlockingGap(toRuleGap(gap)))
    .map((gap) => ({
      id: gap.id,
      severity: (gap.downgradedTo ?? gap.severity) as "P0" | "P1",
      title: gap.title,
    }));
  const status = blockers.length > 0 ? "blocked" : "pass";
  const run = startStageRun({
    changeId: input.changeId,
    phase: "Spec",
    inputDbHash: input.reportDbHash,
    sourceLineage: {
      reportId: input.reportId,
      prdSourceDbHash: getStageAuthority(input.changeId, "PRD").latestGate?.sourceDbHash ?? null,
    },
  });
  completeStageRun({
    runId: run.id,
    status: status === "pass" ? "passed" : "issues_found",
    counts: input.counts,
    reportDbHash: input.reportDbHash,
  });
  recomputeStageGate({
    changeId: input.changeId,
    phase: "Spec",
    status,
    blockers,
    freshness: {
      source: "db",
      reportId: input.reportId,
      prdSourceDbHash: getStageAuthority(input.changeId, "PRD").latestGate?.sourceDbHash ?? null,
    },
    requiredActions: status === "pass" ? [] : blockers,
    sourceDbHash: input.reportDbHash,
  });
}

function latestPhaseReport(changeId: string) {
  return db
    .select()
    .from(warReports)
    .where(and(eq(warReports.changeId, changeId), eq(warReports.type, "phase_report")))
    .all()
    .sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      Number(b.status === "generated") - Number(a.status === "generated") ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      b.id.localeCompare(a.id)
    )[0] ?? null;
}

function formatGap(gap: typeof requirementGaps.$inferSelect): string {
  const rule = toRuleGap(gap);
  const specBlocking = isSpecBlockingGap(rule) ? "blocks-spec" : "spec-ok";
  const mergeBlocking = isMergeBlockingGap(rule) ? "blocks-merge" : "merge-ok";
  return `- [${gap.severity}/${gap.status}/${specBlocking}/${mergeBlocking}] ${gap.canonicalGapId}: ${gap.title}`;
}

function formatGapId(item: { id?: string | null; canonicalGapId?: string | null }): string {
  return item.canonicalGapId ?? item.id ?? "unknown-gap";
}

function formatClaim(claim: typeof redFixClaims.$inferSelect): string {
  const artifact = claim.artifactPath ? ` (${claim.artifactPath})` : "";
  return `- [${claim.claimStatus}] ${formatGapId(claim)}${artifact}: ${claim.claimSummary} - ${claim.evidence}`;
}

function formatReview(review: typeof blueGapReviews.$inferSelect): string {
  const downgraded = review.downgradedTo ? ` -> ${review.downgradedTo}` : "";
  const resolution = review.resolutionEvidence ? ` Resolution: ${review.resolutionEvidence}` : "";
  return `- [${review.verdict}${downgraded}] ${formatGapId(review)}: ${review.reviewSummary} - ${review.evidence}${resolution}`;
}

function formatDecision(decision: typeof humanDecisions.$inferSelect): string {
  return `- ${decision.action} ${decision.targetType ?? "gate"} ${decision.targetId ?? ""}${decision.reason ? ` - ${decision.reason}` : ""}`;
}

function formatRound(round: typeof battleRounds.$inferSelect): string {
  return `- Round ${round.roundNo}: ${round.status}`;
}

function verdict(counts: ReturnType<typeof computeGapCounts>): string {
  if (counts.blockingP0 > 0 || counts.blockingP1 > 0) return "blocked";
  return "pending-approval";
}

function nextAction(counts: ReturnType<typeof computeGapCounts>): string {
  if (counts.blockingP0 > 0) return "Return to Spec or Request Changes";
  if (counts.blockingP1 > 0) return "Waive P1 or Request Changes";
  return "Approve";
}

function parseAffectedArtifacts(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function effectiveLedgerSeverity(gap: Pick<LedgerGap, "severity" | "downgradedTo">): LedgerGap["severity"] {
  return gap.downgradedTo ?? gap.severity;
}

function formatLedgerGap(
  gap: LedgerGap,
  gapsByCanonicalGapId: Map<string, typeof requirementGaps.$inferSelect>
): string {
  const row = gapsByCanonicalGapId.get(gap.canonicalGapId);
  const title = row?.title ? `: ${row.title}` : "";
  return `- [${effectiveLedgerSeverity(gap)}/${gap.status}] ${gap.canonicalGapId}${title}`;
}

function formatNewGap(gap: {
  canonicalGapId: string;
  severity: string;
  title: string;
  evidence: string;
}): string {
  return `- [${gap.severity}] ${gap.canonicalGapId}: ${gap.title} - ${gap.evidence}`;
}

function isPreviousBlockingGapForRound(
  gap: typeof requirementGaps.$inferSelect,
  roundId: string
): boolean {
  const ledgerGap = toLedgerGap(gap);
  const severity = effectiveLedgerSeverity(ledgerGap);
  if (gap.firstSeenRoundId === roundId) return false;
  if (severity !== "P0" && severity !== "P1") return false;
  if (gap.status === "waived" || gap.status === "overridden") return false;
  if (gap.status === "resolved" && gap.resolvedByRoundId !== roundId) return false;
  return true;
}

async function insertArtifact(changeId: string, type: "spec_report" | "war_report", filePath: string) {
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

async function insertReportRow({
  changeId,
  roundId,
  phase,
  type,
  filePath,
  sourceHashesJson,
  reportHash,
  counts,
}: {
  changeId: string;
  roundId: string | null;
  phase: "Spec" | "Change";
  type: "phase_report" | "change_report";
  filePath: string;
  sourceHashesJson: string;
  reportHash: string;
  counts: ReturnType<typeof computeGapCounts>;
}) {
  const id = await nextId(warReports, "WRP");
  db.insert(warReports).values({
    id,
    changeId,
    roundId,
    phase,
    type,
    status: "generated",
    path: filePath,
    sourceHashesJson,
    reportHash,
    blockingP0: counts.blockingP0,
    blockingP1: counts.blockingP1,
    nonBlockingP2: counts.nonBlockingP2,
    overriddenP0: counts.overriddenP0,
    openRequirementGaps: counts.openRequirementGaps,
    generatedBy: "BATTLE_REPORTER",
    aiPolished: 0,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  }).run();
  return id;
}

export async function generateSpecReport(changeId: string): Promise<SpecReportResult> {
  const { project } = getChangeAndProject(changeId);
  const { rounds, gaps, decisions, claims, reviews } = rowsForReport(changeId);
  const round = latestRound(changeId);
  const counts = computeGapCounts(gaps.map(toRuleGap));
  inspectArtifactMirrors(changeId, "PRD");
  inspectArtifactMirrors(changeId, "Spec");
  const sourceHashes = reportSourceHashes(changeId);
  const sourceHashesJson = JSON.stringify(sourceHashes);
  const dir = reportsDir(project.repoPath, changeId);
  const filePath = path.join(dir, "spec-report.md");
  const latestRoundClaims = round ? claims.filter((claim) => claim.roundId === round.id) : [];
  const latestRoundReviews = round ? reviews.filter((review) => review.roundId === round.id) : [];
  const previousBlockingGaps = round
    ? gaps.filter((gap) => isPreviousBlockingGapForRound(gap, round.id)).map(toLedgerGap)
    : [];
  const latestNewGaps = round
    ? gaps
        .filter((gap) => gap.firstSeenRoundId === round.id)
        .map((gap) => ({
          canonicalGapId: gap.canonicalGapId,
          title: gap.title,
          category: gap.category,
          severity: gap.severity as "P0" | "P1" | "P2",
          evidence: gap.evidence,
          affectedArtifacts: parseAffectedArtifacts(gap.affectedArtifactsJson),
          proposedSpecPatch: gap.proposedSpecPatch,
          specBlocking: gap.specBlocking === 1,
          mergeBlocking: gap.mergeBlocking === 1,
        }))
    : [];
  const roundDelta = round
    ? computeRoundDelta({
        roundId: round.id,
        previousBlockingGaps,
        fixClaims: latestRoundClaims.map((claim) => ({
          canonicalGapId: claim.canonicalGapId,
          claimStatus: claim.claimStatus as "fixed" | "partially_fixed" | "not_fixed" | "needs_human_decision",
          claimSummary: claim.claimSummary,
          evidence: claim.evidence,
          artifactPath: claim.artifactPath,
        })),
        gapReviews: latestRoundReviews.map((review) => ({
          canonicalGapId: review.canonicalGapId,
          verdict: review.verdict as "resolved" | "still_open" | "downgraded" | "needs_human_decision",
          reviewSummary: review.reviewSummary,
          evidence: review.evidence,
          resolutionEvidence: review.resolutionEvidence,
          downgradedTo: review.downgradedTo as "P1" | "P2" | null,
        })),
        newGaps: latestNewGaps,
      })
    : null;
  const gapsByCanonicalGapId = new Map(gaps.map((gap) => [gap.canonicalGapId, gap]));

  const content = [
    "# Spec Battle Report",
    "",
    "## Gate Verdict",
    verdict(counts),
    "",
    "## Required Next Action",
    nextAction(counts),
    "",
    "## Counts",
    `- Blocking P0: ${counts.blockingP0}`,
    `- Blocking P1: ${counts.blockingP1}`,
    `- Non-blocking P2: ${counts.nonBlockingP2}`,
    `- Overridden P0: ${counts.overriddenP0}`,
    "",
    "## Round Delta",
    `- 本轮已解决: ${roundDelta?.resolvedThisRound.length ?? 0}`,
    `- 仍在阻断: ${roundDelta?.stillOpen.length ?? 0}`,
    `- 新发现: ${roundDelta?.newlyFound.length ?? 0}`,
    `- 未复核: ${roundDelta?.notRechecked.length ?? 0}`,
    "",
    "### 本轮已解决",
    ...(roundDelta?.resolvedThisRound.length
      ? roundDelta.resolvedThisRound.map((gap) => formatLedgerGap(gap, gapsByCanonicalGapId))
      : ["- None"]),
    "",
    "### 仍在阻断",
    ...(roundDelta?.stillOpen.length
      ? roundDelta.stillOpen.map((gap) => formatLedgerGap(gap, gapsByCanonicalGapId))
      : ["- None"]),
    "",
    "### 新发现",
    ...(roundDelta?.newlyFound.length ? roundDelta.newlyFound.map(formatNewGap) : ["- None"]),
    "",
    "### 未复核",
    ...(roundDelta?.notRechecked.length
      ? roundDelta.notRechecked.map((gap) => formatLedgerGap(gap, gapsByCanonicalGapId))
      : ["- None"]),
    "",
    "## 我方修复声明",
    ...(latestRoundClaims.length ? latestRoundClaims.map(formatClaim) : ["- None"]),
    "",
    "## 反方复核",
    ...(latestRoundReviews.length ? latestRoundReviews.map(formatReview) : ["- None"]),
    "",
    "## Gap Ledger",
    ...(gaps.length ? gaps.map(formatGap) : ["- None"]),
    "",
    "## Requirement Gaps",
    ...(gaps.length ? gaps.map(formatGap) : ["- None"]),
    "",
    "## Human Decisions",
    ...(decisions.length ? decisions.map(formatDecision) : ["- None"]),
    "",
    "## Round History",
    ...(rounds.length ? rounds.map(formatRound) : ["- None"]),
    "",
  ].join("\n");

  const reportHash = sha256Text(content);
  db.update(warReports)
    .set({ status: "stale", updatedAt: nowISO() })
    .where(and(eq(warReports.changeId, changeId), eq(warReports.type, "change_report")))
    .run();

  const reportId = await insertReportRow({
    changeId,
    roundId: round?.id ?? null,
    phase: "Spec",
    type: "phase_report",
    filePath,
    sourceHashesJson,
    reportHash,
    counts,
  });
  renderMirrorsFromDb({
    changeId,
    repoPath: project.repoPath,
    mirrors: [
      {
        phase: "Spec",
        artifactType: "spec_report",
        path: filePath,
        schemaVersion: "spec-report.v1",
        sourceDbHash: reportSourceDbHash(changeId),
        content,
      },
    ],
  });
  await insertArtifact(changeId, "spec_report", filePath);
  syncSpecReportStageAuthority({
    changeId,
    counts,
    reportDbHash: reportSourceDbHash(changeId),
    reportId,
  });

  return { reportId, path: filePath, reportHash, sourceHashesJson, counts };
}

export async function generateWarReport(changeId: string): Promise<WarReportResult> {
  const { project } = getChangeAndProject(changeId);
  const { rounds, gaps, decisions } = rowsForReport(changeId);
  const round = latestRound(changeId);
  const counts = computeGapCounts(gaps.map(toRuleGap));
  const sourceHashesJson = JSON.stringify(reportSourceHashes(changeId));
  const dir = reportsDir(project.repoPath, changeId);
  const filePath = path.join(dir, "war-report.md");
  const content = [
    "# Change War Report",
    "",
    "## Spec Battle Verdict",
    verdict(counts),
    "",
    "## Requirement Gaps",
    ...(gaps.length ? gaps.map(formatGap) : ["- None"]),
    "",
    "## Human Decisions",
    ...(decisions.length ? decisions.map(formatDecision) : ["- None"]),
    "",
    "## Round History",
    ...(rounds.length ? rounds.map(formatRound) : ["- None"]),
    "",
  ].join("\n");
  const reportHash = sha256Text(content);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
  const reportId = await insertReportRow({
    changeId,
    roundId: round?.id ?? null,
    phase: "Change",
    type: "change_report",
    filePath,
    sourceHashesJson,
    reportHash,
    counts,
  });
  await insertArtifact(changeId, "war_report", filePath);

  return { reportId, path: filePath, reportHash, sourceHashesJson, counts };
}

export function getSpecReportFreshness(changeId: string): ReportFreshness {
  const report = latestPhaseReport(changeId);

  if (!report) {
    return { reportFresh: false, staleReason: "report_missing", reportId: null, reportHash: null };
  }

  if (report.status === "stale") {
    return {
      reportFresh: false,
      staleReason: "report_stale",
      reportId: report.id,
      reportHash: report.reportHash,
    };
  }

  const currentSourceHashesJson = JSON.stringify(reportSourceHashes(changeId));
  if (report.sourceHashesJson !== currentSourceHashesJson) {
    return {
      reportFresh: false,
      staleReason: "source_changed",
      reportId: report.id,
      reportHash: report.reportHash,
    };
  }

  return {
    reportFresh: true,
    staleReason: null,
    reportId: report.id,
    reportHash: report.reportHash,
  };
}

export function getLatestSpecReportForDecision(changeId: string): ReportFreshness {
  return getSpecReportFreshness(changeId);
}
