import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

import { and, eq } from "drizzle-orm";

import {
  buildRunRecords,
  changes,
  findings,
  mergeApprovals,
  mergeBlockers,
  mergeReadiness,
  projects,
  qaRuns,
  requirementGaps,
  reviewReports,
  reviewState,
  stageGates,
} from "../db/schema";
import { recomputeStageGate, type PipelinePhase } from "./stage-authority-service";
import { hasUncommittedChanges } from "./git-service";
import { assertTrustedAdoptedBuildState } from "./build-workspace-service";

const GIT_COMMAND_TIMEOUT_MS = 30_000;

export type MergeReadinessDb = typeof import("../db/index").db;
type BuildRunRecord = typeof buildRunRecords.$inferSelect;
type QaRunRecord = typeof qaRuns.$inferSelect;
type ReviewReportRecord = typeof reviewReports.$inferSelect;
type StageGateRecord = typeof stageGates.$inferSelect;

export interface MergeReadinessBlocker {
  id: string;
  blockerType: string;
  severity: "P0" | "P1" | "P2";
  title: string;
  reasonCode: string;
  sourceTable: string | null;
  sourceId: string | null;
}

export interface MergeReadiness {
  id: string;
  changeId: string;
  status: "ready" | "blocked";
  sourceDbHash: string;
  sourceHeadSha: string | null;
  blockers: MergeReadinessBlocker[];
  computedAt: string;
}

export interface AssertCanMergeInput {
  changeId: string;
  expectedHeadSha?: string | null;
}

export interface ComputeMergeReadinessInput {
  changeId: string;
  requireApproval?: boolean;
  persist?: boolean;
  db?: MergeReadinessDb;
}

export class MergeReadinessError extends Error {
  public readonly status = 409;

  constructor(public readonly readiness: MergeReadiness) {
    super(readiness.blockers[0]?.title ?? "Merge is not ready");
    this.name = "MergeReadinessError";
  }
}

const REQUIRED_GATE_PHASES: PipelinePhase[] = [
  "PRD",
  "Spec",
  "Plan",
  "TestPlan",
  "Build",
  "Review",
  "QA",
];
const PASSING_GATE_STATUSES = new Set(["pass", "passed", "passed_with_warnings", "passed_with_waived_p1"]);

const requireDefaultDb = createRequire(import.meta.url);
let mergeReadinessDbForTest: MergeReadinessDb | null = null;
let defaultMergeReadinessDb: MergeReadinessDb | null = null;
let headProbeForTest: ((repoPath: string) => string | null) | null = null;
let dirtyProbeForTest: ((repoPath: string) => boolean) | null = null;

export function setMergeReadinessDbForTest(nextDb: MergeReadinessDb): () => void {
  const previous = mergeReadinessDbForTest;
  mergeReadinessDbForTest = nextDb;
  return () => {
    mergeReadinessDbForTest = previous;
  };
}

export function setMergeReadinessHeadProbeForTest(
  nextProbe: (repoPath: string) => string | null,
): () => void {
  const previous = headProbeForTest;
  headProbeForTest = nextProbe;
  return () => {
    headProbeForTest = previous;
  };
}

export function setMergeReadinessDirtyProbeForTest(
  nextProbe: (repoPath: string) => boolean,
): () => void {
  const previous = dirtyProbeForTest;
  dirtyProbeForTest = nextProbe;
  return () => {
    dirtyProbeForTest = previous;
  };
}

function getMergeReadinessDb(): MergeReadinessDb {
  if (mergeReadinessDbForTest) return mergeReadinessDbForTest;
  if (!defaultMergeReadinessDb) {
    defaultMergeReadinessDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultMergeReadinessDb;
}

function nowISO(): string {
  return new Date().toISOString();
}

function nextId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortStable((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function hashRows(rows: unknown[]): string {
  return createHash("sha256").update(stableJson(rows)).digest("hex");
}

function probeGitHead(repoPath: string): string | null {
  if (headProbeForTest) return headProbeForTest(repoPath);
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: GIT_COMMAND_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
}

function latestByTime<T>(rows: T[], timestamp: (row: T) => string | null, tieBreak: (left: T, right: T) => number): T | null {
  return [...rows].sort((left, right) => {
    const time = Date.parse(timestamp(right) ?? "") - Date.parse(timestamp(left) ?? "");
    if (Number.isFinite(time) && time !== 0) return time;
    return tieBreak(left, right);
  })[0] ?? null;
}

function latestStageGate(db: MergeReadinessDb, changeId: string, phase: PipelinePhase): StageGateRecord | null {
  const rows = db
    .select()
    .from(stageGates)
    .where(and(eq(stageGates.changeId, changeId), eq(stageGates.phase, phase)))
    .all();
  return latestByTime(rows, (row) => row.computedAt, (left, right) => {
    if (right.gateVersion !== left.gateVersion) return right.gateVersion - left.gateVersion;
    return right.id.localeCompare(left.id);
  });
}

function latestMergeReadinessRow(
  db: MergeReadinessDb,
  changeId: string,
): typeof mergeReadiness.$inferSelect | null {
  const rows = db.select().from(mergeReadiness).where(eq(mergeReadiness.changeId, changeId)).all();
  return latestByTime(rows, (row) => row.computedAt, (left, right) => right.id.localeCompare(left.id));
}

function latestApprovedBuild(db: MergeReadinessDb, changeId: string): BuildRunRecord | null {
  const rows = db
    .select()
    .from(buildRunRecords)
    .where(eq(buildRunRecords.changeId, changeId))
    .all();
  return latestByTime(
    rows.filter((row) => row.status === "approved_for_absorb" || row.status === "adopted"),
    (row) => row.adoptedAt ?? row.updatedAt,
    (left, right) => right.id.localeCompare(left.id)
  );
}

function latestQaRun(db: MergeReadinessDb, changeId: string): QaRunRecord | null {
  const rows = db.select().from(qaRuns).where(eq(qaRuns.changeId, changeId)).all();
  return latestByTime(rows, (row) => row.completedAt ?? row.startedAt, (left, right) => right.id.localeCompare(left.id));
}

function buildIdentity(record: BuildRunRecord | null): string | null {
  if (!record) return null;
  return record.buildRunId ?? record.id;
}

/**
 * The workspace run number the DB-approved BuildRun names, or undefined when the
 * record does not name one.
 *
 * `buildIdentity` falls back to `record.id`, a `BRR-<hash>` in a different
 * namespace, and `build_run_id` is nullable, so the parse must be allowed to
 * fail. Undefined leaves the caller on newest-on-disk semantics -- today's
 * behaviour, which refuses a dirty worktree whenever the newest run is not the
 * adopted one. That is the conservative answer, and inventing a run number to
 * pin would be the dangerous one.
 */
function buildRunNumber(record: BuildRunRecord | null): number | undefined {
  const identity = buildIdentity(record);
  const match = identity ? /^build-(\d+)$/.exec(identity) : null;
  if (!match) return undefined;
  const runNumber = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(runNumber) && runNumber > 0 ? runNumber : undefined;
}

function reviewReportById(db: MergeReadinessDb, reportId: string | null): ReviewReportRecord | null {
  if (!reportId) return null;
  return db.select().from(reviewReports).where(eq(reviewReports.id, reportId)).get() ?? null;
}

function selfHealMissingBuildGate(
  changeId: string,
  gate: StageGateRecord | null,
  build: BuildRunRecord | null,
  computedAt: string,
): StageGateRecord | null {
  if (gate || buildBlockers(build).length > 0 || !build) return gate;
  return recomputeStageGate({
    changeId,
    phase: "Build",
    status: "passed",
    blockers: [],
    freshness: {
      fresh: true,
      sourceBuildRunId: buildIdentity(build),
      sourceHeadSha: build.adoptedHeadSha ?? build.headSha,
      recoveredFrom: "merge_readiness_missing_gate",
    },
    requiredActions: [],
    rows: [{
      table: "build_run_records",
      id: build.id,
      buildRunId: buildIdentity(build),
      status: build.status,
      patchHash: build.patchHash,
      changedFilesHash: build.changedFilesHash,
      adoptedHeadSha: build.adoptedHeadSha,
      adoptionDecisionId: build.adoptionDecisionId,
      adoptedAt: build.adoptedAt,
    }],
    computedAt,
  });
}

function selfHealMissingReviewGate(
  changeId: string,
  gate: StageGateRecord | null,
  build: BuildRunRecord | null,
  report: ReviewReportRecord | null,
  computedAt: string,
): StageGateRecord | null {
  if (gate || !report || report.qaAllowed !== 1 || !PASSING_GATE_STATUSES.has(report.gateStatus)) {
    return gate;
  }
  const latestBuildId = buildIdentity(build);
  if (!latestBuildId || report.sourceBuildRunId !== latestBuildId) return gate;
  const latestBuildHead = build?.headSha ?? build?.adoptedHeadSha ?? null;
  if (latestBuildHead && report.sourceHeadSha && report.sourceHeadSha !== latestBuildHead) return gate;

  return recomputeStageGate({
    changeId,
    phase: "Review",
    status: "passed",
    blockers: [],
    freshness: {
      fresh: true,
      sourceBuildRunId: report.sourceBuildRunId,
      sourceHeadSha: report.sourceHeadSha,
      sourceReviewReportId: report.id,
      recoveredFrom: "merge_readiness_missing_gate",
    },
    requiredActions: [],
    rows: [{
      table: "review_reports",
      id: report.id,
      gateStatus: report.gateStatus,
      qaAllowed: report.qaAllowed,
      reportDbHash: report.reportDbHash,
      sourceBuildRunId: report.sourceBuildRunId,
      sourceHeadSha: report.sourceHeadSha,
    }],
    computedAt,
  });
}

function normalizeSeverity(value: unknown): MergeReadinessBlocker["severity"] {
  return value === "P0" || value === "P1" || value === "P2" ? value : "P1";
}

function blocker(input: Omit<MergeReadinessBlocker, "id"> & { id?: string }): MergeReadinessBlocker {
  return {
    id: input.id ?? input.sourceId ?? input.reasonCode,
    blockerType: input.blockerType,
    severity: input.severity,
    title: input.title,
    reasonCode: input.reasonCode,
    sourceTable: input.sourceTable,
    sourceId: input.sourceId,
  };
}

function gateBlocker(phase: PipelinePhase, gate: StageGateRecord | null): MergeReadinessBlocker | null {
  const phaseCode = phase === "TestPlan" ? "test_plan" : phase.toLowerCase();
  if (!gate) {
    return blocker({
      blockerType: "stage_gate",
      severity: "P1",
      title: `${phase} gate is missing`,
      reasonCode: `${phaseCode}_gate_missing`,
      sourceTable: "stage_gates",
      sourceId: null,
    });
  }
  if (!PASSING_GATE_STATUSES.has(gate.status)) {
    const reasonCode = gate.status === "stale" ? `${phaseCode}_stale` : `${phaseCode}_gate_${gate.status}`;
    return blocker({
      blockerType: "stage_gate",
      severity: "P1",
      title: `${phase} gate is ${gate.status}`,
      reasonCode,
      sourceTable: "stage_gates",
      sourceId: gate.id,
    });
  }
  if (!gateFresh(gate)) {
    return blocker({
      blockerType: "stage_gate",
      severity: "P1",
      title: `${phase} gate is stale`,
      reasonCode: `${phaseCode}_stale`,
      sourceTable: "stage_gates",
      sourceId: gate.id,
    });
  }
  return null;
}

function gateFresh(gate: StageGateRecord): boolean {
  if (!gate.freshnessJson) return true;
  try {
    const freshness = JSON.parse(gate.freshnessJson) as { fresh?: unknown };
    return freshness.fresh !== false;
  } catch {
    return false;
  }
}

function buildBlockers(build: BuildRunRecord | null): MergeReadinessBlocker[] {
  if (!build) {
    return [
      blocker({
        blockerType: "build",
        severity: "P1",
        title: "Latest adopted BuildRun is missing",
        reasonCode: "build_adoption_missing",
        sourceTable: "build_run_records",
        sourceId: null,
      }),
    ];
  }
  if (build.status === "approved_for_absorb") {
    const hasApprovedArtifact =
      Boolean(build.buildRunId) &&
      Boolean(build.baseHeadSha) &&
      Boolean(build.baseCommit) &&
      Boolean(build.patchHash) &&
      Boolean(build.changedFilesHash);
    if (hasApprovedArtifact) return [];
  }
  const hasCompleteAdoption =
    Boolean(build.buildRunId) &&
    Boolean(build.baseHeadSha) &&
    Boolean(build.baseCommit) &&
    Boolean(build.patchHash) &&
    Boolean(build.changedFilesHash) &&
    Boolean(build.adoptedHeadSha) &&
    Boolean(build.adoptionDecisionId) &&
    Boolean(build.adoptedAt);
  if (hasCompleteAdoption && build.headSha === build.adoptedHeadSha) return [];
  return [
    blocker({
      blockerType: "build",
      severity: "P1",
      title: "Latest adopted BuildRun is stale or incomplete",
      reasonCode: "build_adoption_stale",
      sourceTable: "build_run_records",
      sourceId: build.id,
    }),
  ];
}

function buildSourceHead(build: BuildRunRecord | null): string | null {
  if (!build) return null;
  if (build.status === "approved_for_absorb") return build.baseCommit ?? build.baseHeadSha ?? null;
  return build.adoptedHeadSha ?? build.headSha ?? build.baseCommit ?? null;
}

function gitWorktreeDirty(repoPath: string): boolean {
  if (dirtyProbeForTest) return dirtyProbeForTest(repoPath);
  try {
    return hasUncommittedChanges(repoPath);
  } catch {
    return true;
  }
}

function qaBlockers(qa: QaRunRecord | null, latestBuildId: string | null, latestReviewReportId: string | null): MergeReadinessBlocker[] {
  if (!qa) {
    return [
      blocker({
        blockerType: "qa",
        severity: "P1",
        title: "QA result is missing",
        reasonCode: "qa_result_missing",
        sourceTable: "qa_runs",
        sourceId: null,
      }),
    ];
  }
  const blockers: MergeReadinessBlocker[] = [];
  if (qa.status !== "passed") {
    blockers.push(blocker({
      blockerType: "qa",
      severity: "P1",
      title: `QA result is ${qa.status}`,
      reasonCode: "qa_result_stale",
      sourceTable: "qa_runs",
      sourceId: qa.id,
    }));
  }
  if (!qa.sourceBuildRunId || qa.sourceBuildRunId !== latestBuildId) {
    blockers.push(blocker({
      blockerType: "qa",
      severity: "P1",
      title: "QA source BuildRun is stale",
      reasonCode: "qa_result_stale",
      sourceTable: "qa_runs",
      sourceId: qa.id,
    }));
  }
  if (!qa.sourceReviewReportId || qa.sourceReviewReportId !== latestReviewReportId) {
    blockers.push(blocker({
      blockerType: "qa",
      severity: "P1",
      title: "QA source Review report is stale",
      reasonCode: "qa_result_stale",
      sourceTable: "qa_runs",
      sourceId: qa.id,
    }));
  }
  return blockers;
}

function writeReadiness(
  db: MergeReadinessDb,
  changeId: string,
  computedAt: string,
  sourceDbHash: string,
  sourceHeadSha: string | null,
  blockers: MergeReadinessBlocker[],
): MergeReadiness {
  const status = blockers.length === 0 ? "ready" : "blocked";

  // computeMergeReadiness(persist: true) runs on every action-contract read, not
  // just when something changed -- e.g. once for display, again moments later
  // as an approve/merge preflight re-validates. Before gateVersion actually
  // incremented (stage-authority-service.ts), writing a fresh row every time was
  // invisible. Now it would bump the Merge gate's version on every call with
  // nothing behind it, so any "read the fence once, compare later" caller sees
  // spurious drift. Skip the write when nothing sourceDbHash covers has changed.
  // existingGate.status uses the stage_gates vocabulary ("passed"/"blocked");
  // existingReadiness.status uses MergeReadiness's ("ready"/"blocked"). Compare
  // `status` only against existingReadiness -- comparing it against
  // existingGate.status would read "ready" !== "passed" as a change on every
  // single non-blocked call.
  const existingGate = latestStageGate(db, changeId, "Merge");
  const existingReadiness = latestMergeReadinessRow(db, changeId);
  if (
    existingGate
    && existingGate.sourceDbHash === sourceDbHash
    && existingReadiness
    && existingReadiness.sourceDbHash === sourceDbHash
    && existingReadiness.status === status
  ) {
    return {
      id: existingReadiness.id,
      changeId,
      status: existingReadiness.status as MergeReadiness["status"],
      sourceDbHash,
      sourceHeadSha: existingReadiness.sourceHeadSha,
      blockers,
      computedAt: existingReadiness.computedAt,
    };
  }

  const readiness: MergeReadiness = {
    id: nextId("MRG-RDY"),
    changeId,
    status,
    sourceDbHash,
    sourceHeadSha,
    blockers,
    computedAt,
  };
  db.insert(mergeReadiness).values({
    id: readiness.id,
    changeId,
    status: readiness.status,
    sourceDbHash,
    sourceHeadSha,
    blockersJson: JSON.stringify(blockers),
    computedAt,
  }).run();
  for (const item of blockers) {
    db.insert(mergeBlockers).values({
      id: nextId("MRG-BLK"),
      mergeReadinessId: readiness.id,
      blockerType: item.blockerType,
      severity: item.severity,
      title: item.title,
      sourceTable: item.sourceTable,
      sourceId: item.sourceId,
      createdAt: computedAt,
    }).run();
  }
  recomputeStageGate({
    changeId,
    phase: "Merge",
    status: readiness.status === "ready" ? "passed" : "blocked",
    blockers,
    freshness: { fresh: readiness.status === "ready", sourceHeadSha },
    requiredActions: readiness.status === "ready" ? [] : ["resolve_merge_blockers"],
    sourceDbHash,
    rows: [{ table: "merge_readiness", id: readiness.id, status: readiness.status, sourceDbHash }],
    computedAt,
  });
  return readiness;
}

export function computeMergeReadiness(input: string | ComputeMergeReadinessInput): MergeReadiness {
  const changeId = typeof input === "string" ? input : input.changeId;
  const requireApproval = typeof input === "string" ? true : input.requireApproval ?? true;
  const persist = typeof input === "string" ? true : input.persist ?? true;
  const db = typeof input === "string" ? getMergeReadinessDb() : input.db ?? getMergeReadinessDb();
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  const computedAt = nowISO();
  const blockers: MergeReadinessBlocker[] = [];
  const build = latestApprovedBuild(db, changeId);
  const review = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get();
  const latestReviewReportId = review?.latestValidReviewReportId ?? null;
  const latestReviewReport = reviewReportById(db, latestReviewReportId);
  const gates = REQUIRED_GATE_PHASES.map((phase) => {
    let gate = latestStageGate(db, changeId, phase);
    if (persist && phase === "Build") gate = selfHealMissingBuildGate(changeId, gate, build, computedAt);
    if (persist && phase === "Review") gate = selfHealMissingReviewGate(changeId, gate, build, latestReviewReport, computedAt);
    return { phase, gate };
  });
  for (const { phase, gate } of gates) {
    const item = gateBlocker(phase, gate);
    if (item) blockers.push(item);
  }

  blockers.push(...buildBlockers(build));

  if (!latestReviewReportId) {
    blockers.push(blocker({
      blockerType: "review",
      severity: "P1",
      title: "Latest valid Review report is missing",
      reasonCode: "review_not_ready",
      sourceTable: "review_state",
      sourceId: changeId,
    }));
  }

  const qa = latestQaRun(db, changeId);
  blockers.push(...qaBlockers(qa, buildIdentity(build), latestReviewReportId));

  const openFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((finding) => finding.status === "open" && (finding.severity === "P0" || finding.severity === "P1"));
  for (const finding of openFindings) {
    blockers.push(blocker({
      blockerType: "finding",
      severity: normalizeSeverity(finding.severity),
      title: finding.title,
      reasonCode: finding.severity === "P0" ? "review_open_p0" : "review_open_p1",
      sourceTable: "findings",
      sourceId: finding.id,
    }));
  }

  const mergeBlockingGaps = db
    .select()
    .from(requirementGaps)
    .where(eq(requirementGaps.changeId, changeId))
    .all()
    .filter((gap) => gap.mergeBlocking === 1 && gap.status !== "resolved");
  for (const gap of mergeBlockingGaps) {
    blockers.push(blocker({
      blockerType: "requirement_gap",
      severity: normalizeSeverity(gap.downgradedTo ?? gap.severity),
      title: gap.title,
      reasonCode: "requirement_gap_blocker",
      sourceTable: "requirement_gaps",
      sourceId: gap.id,
    }));
  }

  const approval = db.select().from(mergeApprovals).where(eq(mergeApprovals.changeId, changeId)).get();
  if (requireApproval && !approval) {
    blockers.push(blocker({
      blockerType: "approval",
      severity: "P1",
      title: "Human merge approval is missing",
      reasonCode: "merge_approval_missing",
      sourceTable: "merge_approvals",
      sourceId: null,
    }));
  }

  const currentHead = probeGitHead(project.repoPath);
  const buildHead = buildSourceHead(build);
  if (!currentHead) {
    blockers.push(blocker({
      blockerType: "git",
      severity: "P1",
      title: "Git HEAD could not be verified",
      reasonCode: "git_head_unavailable",
      sourceTable: "projects",
      sourceId: project.id,
    }));
  } else if (buildHead && currentHead !== buildHead) {
    blockers.push(blocker({
      blockerType: "git",
      severity: "P1",
      title: "Git HEAD drifted from the approved Build base",
      reasonCode: "head_drift",
      sourceTable: "projects",
      sourceId: project.id,
    }));
  }
  let trustedAdoptedWorktree = false;
  const worktreeDirty = currentHead ? gitWorktreeDirty(project.repoPath) : false;
  if (worktreeDirty) {
    try {
      // Pin the run to the one `latestApprovedBuild` already resolved from
      // build_run_records. Unpinned, this reads the newest build-N.json on disk,
      // so a failed fix run shadows the adopted build and raises a P1 against a
      // workspace the rest of this computation is happily merging. The assert
      // still re-reads that run from disk and still requires an adopted status,
      // matching HEAD, an exactly-applied patch and a matching DB record -- this
      // only chooses which run it asks about.
      assertTrustedAdoptedBuildState({
        repoPath: project.repoPath,
        changeId,
        runNumber: buildRunNumber(build),
      });
      trustedAdoptedWorktree = true;
    } catch {
      trustedAdoptedWorktree = false;
    }
  }
  if (worktreeDirty && !trustedAdoptedWorktree) {
    blockers.push(blocker({
      blockerType: "git",
      severity: "P1",
      title: "Git working tree has uncommitted changes",
      reasonCode: "git_worktree_dirty",
      sourceTable: "projects",
      sourceId: project.id,
    }));
  }
  if (qa?.sourceHeadSha && buildHead && qa.sourceHeadSha !== buildHead) {
    blockers.push(blocker({
      blockerType: "qa",
      severity: "P1",
      title: "QA source HEAD is stale",
      reasonCode: "qa_result_stale",
      sourceTable: "qa_runs",
      sourceId: qa.id,
    }));
  }

  const sourceRows = [
    { table: "changes", id: change.id, status: change.status },
    ...gates.map(({ phase, gate }) => ({ table: "stage_gates", phase, id: gate?.id ?? null, status: gate?.status ?? null, sourceDbHash: gate?.sourceDbHash ?? null })),
    {
      table: "build_run_records",
      id: build?.id ?? null,
      buildRunId: buildIdentity(build),
      status: build?.status ?? null,
      baseCommit: build?.baseCommit ?? null,
      patchHash: build?.patchHash ?? null,
      changedFilesHash: build?.changedFilesHash ?? null,
      adoptedHeadSha: build?.adoptedHeadSha ?? null,
    },
    { table: "review_state", latestValidReviewReportId: latestReviewReportId },
    { table: "qa_runs", id: qa?.id ?? null, status: qa?.status ?? null, sourceBuildRunId: qa?.sourceBuildRunId ?? null, sourceReviewReportId: qa?.sourceReviewReportId ?? null, sourceHeadSha: qa?.sourceHeadSha ?? null },
    { table: "merge_approvals", id: approval?.id ?? null },
    ...openFindings.map((finding) => ({ table: "findings", id: finding.id, severity: finding.severity, status: finding.status })),
    ...mergeBlockingGaps.map((gap) => ({ table: "requirement_gaps", id: gap.id, severity: gap.severity, status: gap.status })),
    { table: "git", currentHead },
  ];
  const sourceDbHash = hashRows(sourceRows);
  if (!persist) {
    return {
      id: nextId("MRG-RDY"),
      changeId,
      status: blockers.length === 0 ? "ready" : "blocked",
      sourceDbHash,
      sourceHeadSha: currentHead,
      blockers,
      computedAt,
    };
  }
  return writeReadiness(db, changeId, computedAt, sourceDbHash, currentHead, blockers);
}

export function assertCanMerge(input: AssertCanMergeInput): MergeReadiness {
  const readiness = computeMergeReadiness(input.changeId);
  if (input.expectedHeadSha && readiness.sourceHeadSha !== input.expectedHeadSha) {
    throw new MergeReadinessError({
      ...readiness,
      status: "blocked",
      blockers: [
        blocker({
          blockerType: "git",
          severity: "P1",
          title: "Git HEAD drifted since the merge action contract was issued",
          reasonCode: "head_drift",
          sourceTable: "projects",
          sourceId: null,
        }),
        ...readiness.blockers,
      ],
    });
  }
  if (readiness.status !== "ready") {
    throw new MergeReadinessError(readiness);
  }
  return readiness;
}
