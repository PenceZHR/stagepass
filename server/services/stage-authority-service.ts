import { createHash, randomUUID } from "node:crypto";

import {
  setStageAuthorityRepositoryDbForTest,
  stageAuthorityRepository,
  withStageAuthorityTransaction,
} from "../repositories/stage-authority-repository";
import type {
  StageAuthorityDb,
  StageGateRecord,
  StageReportRecord,
  StageAuthorityRepository,
  StageRunRecord,
  StageStateRecord,
} from "../repositories/stage-authority-repository";
import type { Provider } from "./provider-selection-service";

export type {
  StageAuthorityDb,
  StageGateRecord,
  StageReportRecord,
  StageRunRecord,
  StageStateRecord,
} from "../repositories/stage-authority-repository";

export type PipelinePhase =
  | "PRD"
  | "Spec"
  | "TechSpec"
  | "Plan"
  | "TestPlan"
  | "Build"
  | "Review"
  | "QA"
  | "Merge";

export type StageRunStatus =
  | "running"
  | "passed"
  | "issues_found"
  | "failed"
  | "invalid_output"
  | "data_inconsistent"
  | "stale";

type CompleteStageRunStatus = StageRunStatus | "passed_with_warnings";
type StageStoredReportStatus = CompleteStageRunStatus | "legacy_incomplete";

export function setStageAuthorityServiceDbForTest(nextDb: StageAuthorityDb): () => void {
  return setStageAuthorityRepositoryDbForTest(nextDb);
}

export interface StartStageRunInput {
  changeId: string;
  phase: PipelinePhase;
  id?: string;
  attemptNo?: number;
  status?: "running";
  idempotencyKey?: string | null;
  inputDbHash?: string | null;
  sourceLineage?: unknown;
  startedAt?: string;
  provider?: Provider | null;
}

export interface CompleteStageRunInput {
  runId: string;
  reportId?: string;
  status: CompleteStageRunStatus;
  counts?: unknown;
  outputDbHash?: string | null;
  reportDbHash?: string | null;
  isFresh?: boolean;
  staleReason?: string | null;
  errorCode?: string | null;
  completedAt?: string;
  generatedAt?: string;
}

export interface RecomputeStageGateInput {
  changeId: string;
  phase: PipelinePhase;
  id?: string;
  status: string;
  blockers?: unknown;
  freshness?: unknown;
  requiredActions?: unknown;
  sourceDbHash?: string | null;
  rows?: unknown[];
  gateVersion?: number;
  computedAt?: string;
}

export interface StageAuthoritySnapshot {
  changeId: string;
  phase: PipelinePhase;
  state: StageStateRecord | null;
  latestAttempt: StageRunRecord | null;
  latestReport: StageReportRecord | null;
  latestValidReport: StageReportRecord | null;
  latestGate: StageGateRecord | null;
}

const VALID_REPORT_STATUSES = new Set<StageStoredReportStatus>([
  "passed",
  "issues_found",
  "passed_with_warnings",
]);

function nowISO(): string {
  return new Date().toISOString();
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
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

function nextStageRunId(): string {
  return `STG-RUN-${randomUUID()}`;
}

function nextStageReportId(repository = stageAuthorityRepository): string {
  return repository.nextStageReportId();
}

function nextStageGateId(repository = stageAuthorityRepository): string {
  return repository.nextStageGateId();
}

function nextStageStateId(repository = stageAuthorityRepository): string {
  return repository.nextStageStateId();
}

function timeMs(value: string | null): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function newestByTimestamp<T>(
  rows: T[],
  pick: (row: T) => string | null,
  tieBreak?: (a: T, b: T) => number,
): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const timeDiff = timeMs(pick(b)) - timeMs(pick(a));
    if (timeDiff !== 0) return timeDiff;
    return tieBreak?.(a, b) ?? 0;
  })[0];
}

function reportAttemptNo(report: StageReportRecord, runsById: Map<string, StageRunRecord>): number {
  if (!report.sourceRunId) return -1;
  return runsById.get(report.sourceRunId)?.attemptNo ?? -1;
}

function isValidReport(
  report: StageReportRecord,
  runsById: Map<string, StageRunRecord>,
): boolean {
  if (!VALID_REPORT_STATUSES.has(report.status as StageStoredReportStatus)) return false;
  if (report.isFresh !== 1) return false;
  if (!report.reportDbHash) return false;
  if (!report.sourceRunId) return false;
  return runsById.has(report.sourceRunId);
}

function selectLatestAttempt(runs: StageRunRecord[]): StageRunRecord | null {
  if (runs.length === 0) return null;
  return [...runs].sort((a, b) => {
    if (b.attemptNo !== a.attemptNo) return b.attemptNo - a.attemptNo;
    const startedDiff = timeMs(b.startedAt) - timeMs(a.startedAt);
    if (startedDiff !== 0) return startedDiff;
    return b.id.localeCompare(a.id);
  })[0];
}

function selectLatestReport(
  reports: StageReportRecord[],
  latestAttempt: StageRunRecord | null,
): StageReportRecord | null {
  if (reports.length === 0) return null;
  const latestAttemptReports = latestAttempt
    ? reports.filter((report) => report.sourceRunId === latestAttempt.id)
    : [];
  return newestByTimestamp(
    latestAttemptReports.length > 0 ? latestAttemptReports : reports,
    (report) => report.generatedAt,
    (a, b) => b.id.localeCompare(a.id),
  );
}

function selectLatestValidReport(
  reports: StageReportRecord[],
  runsById: Map<string, StageRunRecord>,
): StageReportRecord | null {
  const validReports = reports.filter((report) => isValidReport(report, runsById));
  if (validReports.length === 0) return null;
  return [...validReports].sort((a, b) => {
    const attemptDiff = reportAttemptNo(b, runsById) - reportAttemptNo(a, runsById);
    if (attemptDiff !== 0) return attemptDiff;
    const generatedDiff = timeMs(b.generatedAt) - timeMs(a.generatedAt);
    if (generatedDiff !== 0) return generatedDiff;
    return b.id.localeCompare(a.id);
  })[0];
}

function toRunStatus(status: CompleteStageRunStatus): StageRunStatus {
  return status === "passed_with_warnings" ? "passed" : status;
}

function stringifyNullable(value: unknown): string | null {
  return value === undefined ? null : stableJson(value);
}

function computeSnapshotWithRepository(
  repository: StageAuthorityRepository,
  changeId: string,
  phase: PipelinePhase,
): StageAuthoritySnapshot {
  const runs = repository.listStageRuns(changeId, phase);
  const reports = repository.listStageReports(changeId, phase);
  const gates = repository.listStageGates(changeId, phase);
  const state = repository.getStageState(changeId, phase);
  const latestAttempt = selectLatestAttempt(runs);
  const latestReport = selectLatestReport(reports, latestAttempt);
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const latestValidReport = selectLatestValidReport(reports, runsById);
  const latestGate = newestByTimestamp(gates, (gate) => gate.computedAt, (a, b) => {
    if (b.gateVersion !== a.gateVersion) return b.gateVersion - a.gateVersion;
    return b.id.localeCompare(a.id);
  });

  return {
    changeId,
    phase,
    state,
    latestAttempt,
    latestReport,
    latestValidReport,
    latestGate,
  };
}

function deriveStateStatus(snapshot: StageAuthoritySnapshot): string {
  if (snapshot.latestAttempt?.status === "running") return "running";
  return (
    snapshot.latestGate?.status ??
    snapshot.latestReport?.status ??
    snapshot.latestAttempt?.status ??
    "empty"
  );
}

function upsertStageStateWithRepository(
  repository: StageAuthorityRepository,
  snapshot: StageAuthoritySnapshot,
  updatedAt = nowISO(),
): StageStateRecord | null {
  const existing = snapshot.state;
  const derivedValues = {
    status: deriveStateStatus(snapshot),
    latestRunId: snapshot.latestAttempt?.id ?? null,
    latestReportId: snapshot.latestReport?.id ?? null,
    latestGateId: snapshot.latestGate?.id ?? null,
    latestValidReportId: snapshot.latestValidReport?.id ?? null,
    dbHash: snapshot.latestGate?.sourceDbHash ?? snapshot.latestValidReport?.reportDbHash ?? null,
  };

  if (existing) {
    const unchanged =
      existing.status === derivedValues.status &&
      existing.latestRunId === derivedValues.latestRunId &&
      existing.latestReportId === derivedValues.latestReportId &&
      existing.latestGateId === derivedValues.latestGateId &&
      existing.latestValidReportId === derivedValues.latestValidReportId &&
      existing.dbHash === derivedValues.dbHash;
    if (unchanged) return existing;

    const nextValues = {
      ...derivedValues,
      version: existing.version + 1,
      updatedAt,
    };
    return repository.upsertStageState({ ...existing, ...nextValues });
  }

  if (
    !snapshot.latestAttempt &&
    !snapshot.latestReport &&
    !snapshot.latestValidReport &&
    !snapshot.latestGate
  ) {
    return null;
  }

  const inserted = {
    id: nextStageStateId(repository),
    changeId: snapshot.changeId,
    phase: snapshot.phase,
    ...derivedValues,
    version: 1,
    updatedAt,
  };
  return repository.upsertStageState(inserted);
}

function recomputeStageStateWithRepository(
  repository: StageAuthorityRepository,
  changeId: string,
  phase: PipelinePhase,
): StageAuthoritySnapshot {
  const snapshot = computeSnapshotWithRepository(repository, changeId, phase);
  const state = upsertStageStateWithRepository(repository, snapshot);
  return { ...snapshot, state };
}

export function computeSourceDbHash(input: {
  changeId: string;
  phase: PipelinePhase;
  rows: unknown[];
}): string {
  const normalizedRows = input.rows
    .map((row) => sortForStableJson(row))
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return createHash("sha256")
    .update(stableJson({ changeId: input.changeId, phase: input.phase, rows: normalizedRows }))
    .digest("hex");
}

export function startStageRun(input: StartStageRunInput): StageRunRecord {
  const run = withStageAuthorityTransaction((repository) => {
    if (!repository.changeExists(input.changeId)) {
      throw new Error(`Change not found: ${input.changeId}`);
    }

    const phaseRuns = repository.listStageRuns(input.changeId, input.phase);
    if (input.idempotencyKey) {
      const existingRun = phaseRuns.find((run) => run.idempotencyKey === input.idempotencyKey);
      if (existingRun) return existingRun;
    }

    const attemptNo =
      input.attemptNo ??
      phaseRuns.reduce((max, existingRun) => Math.max(max, existingRun.attemptNo), 0) + 1;
    const duplicateAttempt = phaseRuns.find((run) => run.attemptNo === attemptNo);
    if (duplicateAttempt) {
      throw new Error(
        `Stage run attempt already exists: ${input.changeId} ${input.phase} #${attemptNo}`,
      );
    }

    const nextRun: StageRunRecord = {
      id: input.id ?? nextStageRunId(),
      changeId: input.changeId,
      phase: input.phase,
      attemptNo,
      status: input.status ?? "running",
      idempotencyKey: input.idempotencyKey ?? null,
      inputDbHash: input.inputDbHash ?? null,
      outputDbHash: null,
      sourceLineageJson:
        input.sourceLineage === undefined ? null : stableJson(input.sourceLineage),
      errorCode: null,
      provider: input.provider ?? null,
      startedAt: input.startedAt ?? nowISO(),
      completedAt: null,
    };

    repository.insertStageRun(nextRun);
    recomputeStageStateWithRepository(repository, input.changeId, input.phase);
    return nextRun;
  });
  return run;
}

export function completeStageRun(input: CompleteStageRunInput): StageReportRecord {
  return withStageAuthorityTransaction((repository) => {
    const run = repository.getStageRun(input.runId);
    if (!run) {
      throw new Error(`Stage run not found: ${input.runId}`);
    }

    const completedAt = input.completedAt ?? nowISO();
    const runStatus = toRunStatus(input.status);
    repository.completeStageRun(run.id, {
      status: runStatus,
      outputDbHash: input.outputDbHash ?? input.reportDbHash ?? null,
      errorCode: input.errorCode ?? null,
      completedAt,
    });

    const report: StageReportRecord = {
      id: input.reportId ?? nextStageReportId(repository),
      changeId: run.changeId,
      phase: run.phase,
      sourceRunId: run.id,
      status: input.status,
      countsJson: stringifyNullable(input.counts),
      isFresh: input.isFresh === false ? 0 : 1,
      staleReason: input.staleReason ?? null,
      reportDbHash: input.reportDbHash ?? null,
      generatedAt: input.generatedAt ?? completedAt,
    };

    repository.insertStageReport(report);
    recomputeStageStateWithRepository(repository, run.changeId, run.phase as PipelinePhase);
    return report;
  });
}

export function recomputeStageGate(input: RecomputeStageGateInput): StageGateRecord {
  return withStageAuthorityTransaction((repository) => {
    if (!repository.changeExists(input.changeId)) {
      throw new Error(`Change not found: ${input.changeId}`);
    }

    const sourceDbHash =
      input.sourceDbHash ??
      computeSourceDbHash({
        changeId: input.changeId,
        phase: input.phase,
        rows: input.rows ?? [],
      });
    const record: StageGateRecord = {
      id: input.id ?? nextStageGateId(repository),
      changeId: input.changeId,
      phase: input.phase,
      status: input.status,
      blockersJson: stringifyNullable(input.blockers),
      freshnessJson: stringifyNullable(input.freshness),
      requiredActionsJson: stringifyNullable(input.requiredActions),
      sourceDbHash,
      gateVersion: input.gateVersion ?? repository.nextGateVersion(input.changeId, input.phase),
      computedAt: input.computedAt ?? nowISO(),
    };

    repository.insertStageGate(record);
    recomputeStageStateWithRepository(repository, input.changeId, input.phase);
    return record;
  });
}

export function getStageAuthority(
  changeId: string,
  phase: PipelinePhase,
): StageAuthoritySnapshot {
  return withStageAuthorityTransaction((repository) =>
    recomputeStageStateWithRepository(repository, changeId, phase),
  );
}

export function peekStageAuthority(
  changeId: string,
  phase: PipelinePhase,
): StageAuthoritySnapshot {
  return computeSnapshotWithRepository(stageAuthorityRepository, changeId, phase);
}
