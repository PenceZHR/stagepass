import fs from "node:fs";
import path from "node:path";

import type { ProcessIdentity } from "./process-identity-service";

export type SupervisedProcessRole = "next" | "pipeline-worker";

export interface SupervisedProcessRecord {
  role: SupervisedProcessRole;
  identity: ProcessIdentity;
  startedAt: string;
  lastHeartbeatAt: string | null;
}

export interface SupervisorChildLastExit {
  exitCode: number | null;
  signal: string | null;
  endedAt: string;
}

export interface SupervisorHealthError {
  code:
    | "process_identity_mismatch"
    | "process_identity_capture_failed"
    | "process_signal_failed"
    | "supervisor_unmanaged_process"
    | "supervisor_log_flush_failed"
    | "worker_monitor_failed"
    | "worker_heartbeat_mismatch";
  reason: string;
  recordedAt: string;
}

export interface WorkerHeartbeatCurrentJob {
  jobId: string;
  attemptNo: number;
  leaseTokenDigest: string;
}

export interface WorkerHeartbeat {
  pid: number;
  workerId: string;
  workerNonce: string;
  instanceNonce: string;
  observedAt: string;
  health: "healthy" | "fatal";
  fatalKind: "uncaughtException" | "unhandledRejection" | null;
  currentJob: WorkerHeartbeatCurrentJob | null;
  lastJobAt: string | null;
}

export interface SupervisorNextHealthState {
  /** @deprecated Migration-only derived view; never persisted. */
  readonly pid?: number | null;
  record: SupervisedProcessRecord | null;
  restartCount: number;
  lastExit: SupervisorChildLastExit | null;
  lastHealthAt: string | null;
  portListening: boolean;
  crashLoop: boolean;
  error: SupervisorHealthError | null;
}

export interface SupervisorWorkerHealthState {
  /** @deprecated Migration-only derived view; never persisted. */
  readonly pid?: number | null;
  record: SupervisedProcessRecord | null;
  restartCount: number;
  lastExit: SupervisorChildLastExit | null;
  lastHealthAt: string | null;
  heartbeat: WorkerHeartbeat | null;
  crashLoop: boolean;
  error: SupervisorHealthError | null;
}

export interface SupervisorHealthState {
  next: SupervisorNextHealthState;
  worker: SupervisorWorkerHealthState;
  updatedAt: string;
}

export interface SupervisorHealthPatch {
  next?: Partial<SupervisorNextHealthState>;
  worker?: Partial<SupervisorWorkerHealthState>;
  updatedAt?: string;
}

function defaultHealthState(updatedAt = new Date().toISOString()): SupervisorHealthState {
  return {
    next: {
      record: null,
      restartCount: 0,
      lastExit: null,
      lastHealthAt: null,
      portListening: false,
      crashLoop: false,
      error: null,
    },
    worker: {
      record: null,
      restartCount: 0,
      lastExit: null,
      lastHealthAt: null,
      heartbeat: null,
      crashLoop: false,
      error: null,
    },
    updatedAt,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isDateString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isOptionalDate(value: unknown): value is string | null {
  return value === null || isDateString(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!isObject(value)) return false;
  return hasExactKeys(value, ["pid", "ppid", "pgid", "nonce", "processStartTime", "cwd", "command"])
    && Number.isInteger(value.pid) && Number(value.pid) > 0
    && (value.ppid === null || (Number.isInteger(value.ppid) && Number(value.ppid) > 0))
    && Number.isInteger(value.pgid) && value.pgid === value.pid
    && isNonEmptyString(value.nonce)
    && isDateString(value.processStartTime)
    && isNonEmptyString(value.cwd)
    && Array.isArray(value.command)
    && value.command.length > 0
    && value.command.every(isNonEmptyString);
}

const PROCESS_SIGNALS = new Set<string>([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP",
  "SIGILL", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL",
  "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS",
  "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1",
  "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK",
  "SIGLOST", "SIGINFO",
]);

function isSupervisedProcessRecord(value: unknown): value is SupervisedProcessRecord {
  if (!isObject(value)) return false;
  return hasExactKeys(value, ["role", "identity", "startedAt", "lastHeartbeatAt"])
    && (value.role === "next" || value.role === "pipeline-worker")
    && isProcessIdentity(value.identity)
    && isDateString(value.startedAt)
    && isOptionalDate(value.lastHeartbeatAt);
}

function isLastExit(value: unknown): value is SupervisorChildLastExit {
  if (!isObject(value)) return false;
  return hasExactKeys(value, ["exitCode", "signal", "endedAt"])
    && (value.exitCode === null || isNonNegativeInteger(value.exitCode))
    && (value.signal === null || (isNonEmptyString(value.signal) && PROCESS_SIGNALS.has(value.signal)))
    && isDateString(value.endedAt);
}

const HEALTH_ERROR_CODES: readonly SupervisorHealthError["code"][] = [
  "process_identity_mismatch",
  "process_identity_capture_failed",
  "process_signal_failed",
  "supervisor_unmanaged_process",
  "supervisor_log_flush_failed",
  "worker_monitor_failed",
  "worker_heartbeat_mismatch",
];

function isHealthError(value: unknown): value is SupervisorHealthError {
  if (!isObject(value)) return false;
  return hasExactKeys(value, ["code", "reason", "recordedAt"])
    && HEALTH_ERROR_CODES.includes(value.code as SupervisorHealthError["code"])
    && isNonEmptyString(value.reason)
    && isDateString(value.recordedAt);
}

function isWorkerHeartbeat(value: unknown): value is WorkerHeartbeat {
  if (!isObject(value)) return false;
  const currentJob = value.currentJob;
  const validCurrentJob = currentJob === null || (
    isObject(currentJob)
    && hasExactKeys(currentJob, ["jobId", "attemptNo", "leaseTokenDigest"])
    && isNonEmptyString(currentJob.jobId)
    && isNonNegativeInteger(currentJob.attemptNo)
    && isNonEmptyString(currentJob.leaseTokenDigest)
  );
  const validFatalState = value.health === "healthy"
    ? value.fatalKind === null
    : value.health === "fatal"
      && (value.fatalKind === "uncaughtException" || value.fatalKind === "unhandledRejection");
  return hasExactKeys(value, [
    "pid",
    "workerId",
    "workerNonce",
    "instanceNonce",
    "observedAt",
    "health",
    "fatalKind",
    "currentJob",
    "lastJobAt",
  ])
    && Number.isInteger(value.pid) && Number(value.pid) > 0
    && isNonEmptyString(value.workerId)
    && isNonEmptyString(value.workerNonce)
    && isNonEmptyString(value.instanceNonce)
    && isDateString(value.observedAt)
    && validFatalState
    && validCurrentJob
    && isOptionalDate(value.lastJobAt);
}

function withLegacyPidViews(state: SupervisorHealthState): SupervisorHealthState {
  Object.defineProperty(state.next, "pid", {
    configurable: true,
    enumerable: false,
    value: state.next.record?.identity.pid ?? null,
  });
  Object.defineProperty(state.worker, "pid", {
    configurable: true,
    enumerable: false,
    value: state.worker.record?.identity.pid ?? null,
  });
  return state;
}

function isCurrentHealthState(value: unknown): value is SupervisorHealthState {
  if (!isObject(value) || !hasExactKeys(value, ["next", "worker", "updatedAt"])) return false;
  if (!isObject(value.next) || !isObject(value.worker)) return false;
  const next = value.next;
  const worker = value.worker;
  const nextRecord: SupervisedProcessRecord | null | undefined = next.record === null
    ? null
    : isSupervisedProcessRecord(next.record) && next.record.role === "next"
      ? next.record
      : undefined;
  const workerRecord: SupervisedProcessRecord | null | undefined = worker.record === null
    ? null
    : isSupervisedProcessRecord(worker.record) && worker.record.role === "pipeline-worker"
      ? worker.record
      : undefined;
  const heartbeat: WorkerHeartbeat | null | undefined = worker.heartbeat === null
    ? null
    : isWorkerHeartbeat(worker.heartbeat)
      ? worker.heartbeat
      : undefined;
  const validNextRecord = nextRecord !== undefined;
  const validWorkerRecord = workerRecord !== undefined;
  const nextLivenessConsistent = validNextRecord && (nextRecord === null
    ? next.portListening === false && next.lastHealthAt === null
    : nextRecord.lastHeartbeatAt === next.lastHealthAt
      && (!next.portListening || next.lastHealthAt !== null));
  const workerLivenessConsistent = validWorkerRecord && heartbeat !== undefined
    && (workerRecord === null
      ? heartbeat === null && worker.lastHealthAt === null
      : workerRecord.lastHeartbeatAt === worker.lastHealthAt
        && (heartbeat === null
          || heartbeat.pid === workerRecord.identity.pid
            && heartbeat.observedAt === worker.lastHealthAt));
  return hasExactKeys(next, [
    "record", "restartCount", "lastExit", "lastHealthAt", "portListening", "crashLoop", "error",
  ])
    && hasExactKeys(worker, [
      "record", "restartCount", "lastExit", "lastHealthAt", "heartbeat", "crashLoop", "error",
    ])
    && validNextRecord
    && validWorkerRecord
    && nextLivenessConsistent
    && workerLivenessConsistent
    && isNonNegativeInteger(next.restartCount)
    && isNonNegativeInteger(worker.restartCount)
    && (next.lastExit === null || isLastExit(next.lastExit))
    && (worker.lastExit === null || isLastExit(worker.lastExit))
    && isOptionalDate(next.lastHealthAt)
    && isOptionalDate(worker.lastHealthAt)
    && typeof next.portListening === "boolean"
    && typeof next.crashLoop === "boolean"
    && typeof worker.crashLoop === "boolean"
    && (next.error === null || isHealthError(next.error))
    && (worker.error === null || isHealthError(worker.error))
    && (worker.heartbeat === null || isWorkerHeartbeat(worker.heartbeat))
    && isDateString(value.updatedAt);
}

function parseLegacyHealthState(value: unknown): SupervisorHealthState | null {
  if (!isObject(value) || !hasExactKeys(value, ["next", "worker", "updatedAt"])) return null;
  if (!isObject(value.next) || !isObject(value.worker) || !isDateString(value.updatedAt)) return null;
  const next = value.next;
  const worker = value.worker;
  if (!hasExactKeys(next, [
    "pid", "restartCount", "lastExit", "lastHealthAt", "portListening", "crashLoop",
  ]) || !hasExactKeys(worker, [
    "pid", "restartCount", "lastExit", "lastHealthAt", "crashLoop",
  ])) return null;
  if (!Number.isInteger(next.pid) || Number(next.pid) <= 0
    || !Number.isInteger(worker.pid) || Number(worker.pid) <= 0
    || !isNonNegativeInteger(next.restartCount)
    || !isNonNegativeInteger(worker.restartCount)
    || !(next.lastExit === null || isLastExit(next.lastExit))
    || !(worker.lastExit === null || isLastExit(worker.lastExit))
    || !isOptionalDate(next.lastHealthAt)
    || !isOptionalDate(worker.lastHealthAt)
    || typeof next.portListening !== "boolean"
    || typeof next.crashLoop !== "boolean"
    || typeof worker.crashLoop !== "boolean") return null;

  return withLegacyPidViews({
    next: {
      record: null,
      restartCount: next.restartCount as number,
      lastExit: next.lastExit as SupervisorChildLastExit | null,
      lastHealthAt: null,
      portListening: false,
      crashLoop: next.crashLoop as boolean,
      error: null,
    },
    worker: {
      record: null,
      restartCount: worker.restartCount as number,
      lastExit: worker.lastExit as SupervisorChildLastExit | null,
      lastHealthAt: null,
      heartbeat: null,
      crashLoop: worker.crashLoop as boolean,
      error: null,
    },
    updatedAt: value.updatedAt,
  });
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export function writeSupervisorHealth(filePath: string, state: SupervisorHealthState): void {
  if (!isCurrentHealthState(state)) {
    throw new TypeError("Refusing to persist invalid supervisor health state");
  }
  atomicWriteJson(filePath, state);
}

export function readSupervisorHealth(filePath: string): SupervisorHealthState | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (isCurrentHealthState(parsed)) return withLegacyPidViews(parsed);
    return parseLegacyHealthState(parsed);
  } catch {
    return null;
  }
}

export function updateSupervisorHealth(
  filePath: string,
  patch: SupervisorHealthPatch,
): SupervisorHealthState {
  const current = readSupervisorHealth(filePath) ?? defaultHealthState();
  const updated: SupervisorHealthState = {
    next: {
      ...current.next,
      ...(patch.next ?? {}),
    },
    worker: {
      ...current.worker,
      ...(patch.worker ?? {}),
    },
    updatedAt: patch.updatedAt ?? current.updatedAt,
  };

  writeSupervisorHealth(filePath, updated);
  return updated;
}

export function writeWorkerHeartbeat(filePath: string, heartbeat: WorkerHeartbeat): void {
  atomicWriteJson(filePath, heartbeat);
}

export function readWorkerHeartbeat(filePath: string): WorkerHeartbeat | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return isWorkerHeartbeat(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
