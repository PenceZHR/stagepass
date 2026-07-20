import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "../server/db/index.ts";

import {
  readWorkerHeartbeat,
  updateSupervisorHealth,
  type SupervisedProcessRecord,
} from "../server/services/supervisor-health-service.ts";
import {
  processIdentityProbe,
  type ProcessIdentityProbe,
} from "../server/services/process-identity-service.ts";

const DEFAULT_HEALTH_URL = "http://127.0.0.1:3000/api/health";
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 500;
const DEFAULT_WORKER_STALE_AFTER_MS = 30_000;
const DEFAULT_WORKER_MONITOR_INTERVAL_MS = 5_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
const CRASH_LOOP_LIMIT = 5;
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000] as const;

export type SupervisorEventName =
  | "dev_server_starting"
  | "dev_server_started"
  | "dev_server_exit"
  | "dev_server_restarting"
  | "dev_server_port_listening"
  | "dev_server_port_not_listening"
  | "dev_server_health_failed"
  | "pipeline_worker_starting"
  | "pipeline_worker_started"
  | "pipeline_worker_exit"
  | "pipeline_worker_restarting"
  | "pipeline_worker_stale"
  | "pipeline_worker_heartbeat_rejected"
  | "dev_supervisor_signal"
  | "process_identity_mismatch"
  | "process_identity_capture_failed"
  | "process_identity_quarantine_failed"
  | "process_identity_quarantine_terminated"
  | "controlled_termination_started"
  | "controlled_termination_escalated"
  | "controlled_termination_completed"
  | "process_group_signal_esrch"
  | "process_group_signal_failed"
  | "worker_monitor_failed"
  | "supervisor_log_flush_failed"
  | "supervisor_unmanaged_process"
  | "supervisor_child_crash_loop";

export type SupervisorEventFields = Record<string, unknown>;

export interface SupervisorChild extends EventEmitter {
  pid?: number;
  stdout?: Readable | null;
  stderr?: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ChildFactory = () => SupervisorChild;

export interface WorkerInstanceIdentity {
  workerId: string;
  instanceNonce: string;
}

export type WorkerChildFactory = (identity: WorkerInstanceIdentity) => SupervisorChild;
export type WorkerMonitorScheduler = (
  tick: () => Promise<void>,
  intervalMs: number,
) => () => void;

export interface SupervisorDecisionEvent {
  event: string;
  observedAt: string;
  fields: Record<string, unknown>;
}

export interface DevSupervisorOptions {
  cwd?: string;
  logDir?: string;
  serverLogFilePath?: string;
  workerLogFilePath?: string;
  supervisorLogFilePath?: string;
  healthFilePath?: string;
  childFactory?: ChildFactory;
  workerChildFactory?: WorkerChildFactory;
  workerIdentityFactory?: () => WorkerInstanceIdentity;
  superviseWorker?: boolean;
  healthCheck?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  healthTimeoutMs?: number;
  healthPollIntervalMs?: number;
  workerHeartbeatFilePath?: string;
  workerStaleAfterMs?: number;
  workerMonitorIntervalMs?: number;
  workerMonitorScheduler?: WorkerMonitorScheduler;
  terminationGraceMs?: number;
  decisionCollector?: (decision: SupervisorDecisionEvent) => void;
  processIdentityProbe?: ProcessIdentityProbe;
  processGroupSignaler?: (pgid: number, signal: NodeJS.Signals) => void;
  logStreamFactory?: (filePath: string) => Writable;
}

export interface DevSupervisor {
  start(): Promise<void>;
  checkWorkerHealth(): Promise<void>;
  stop(signal: NodeJS.Signals): Promise<void>;
  waitForIdle(): Promise<void>;
}

export class SupervisorUnmanagedProcessError extends Error {
  readonly code = "supervisor_unmanaged_process";

  constructor(
    readonly role: "next" | "pipeline-worker",
    readonly pid: number | null,
    readonly reason: string,
  ) {
    super(`Supervisor cannot safely manage ${role} pid ${pid ?? "unknown"}; manual process cleanup required: ${reason}`);
    this.name = "SupervisorUnmanagedProcessError";
  }
}

class SupervisorLogFlushError extends Error {
  readonly code = "supervisor_log_flush_failed";

  constructor(
    readonly role: "next" | "pipeline-worker",
    readonly reason: string,
  ) {
    super(`Supervisor ${role} log flush failed: ${reason}`);
    this.name = "SupervisorLogFlushError";
  }
}

export function ensureLogDir(logDir: string): void {
  fs.mkdirSync(logDir, { recursive: true });
}

export function appendSupervisorEvent(
  supervisorLogFilePath: string,
  event: SupervisorEventName,
  fields: SupervisorEventFields = {},
): void {
  ensureLogDir(path.dirname(supervisorLogFilePath));
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  });
  fs.appendFileSync(supervisorLogFilePath, `${line}\n`, "utf-8");
}

export function computeBackoffMs(restartCount: number): number {
  return BACKOFF_MS[Math.min(Math.max(restartCount, 0), BACKOFF_MS.length - 1)];
}

export function isCrashLoop(
  crashTimestampsMs: number[],
  nowMs: number,
  windowMs = CRASH_LOOP_WINDOW_MS,
  limit = CRASH_LOOP_LIMIT,
): boolean {
  return crashTimestampsMs.filter((timestamp) => nowMs - timestamp <= windowMs).length >= limit;
}

export function createDefaultChildFactory(cwd: string): ChildFactory {
  const nextEntry = path.join(cwd, "node_modules", "next", "dist", "bin", "next");
  return () =>
    spawn(process.execPath, [nextEntry, "dev"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
}

export function createDefaultWorkerChildFactory(
  cwd: string,
  workerHeartbeatFilePath: string,
): WorkerChildFactory {
  const tsxLoader = path.join(cwd, "node_modules", "tsx", "dist", "loader.mjs");
  const workerEntry = path.join(cwd, "scripts", "pipeline-worker.ts");
  return (identity) =>
    spawn(process.execPath, ["--import", tsxLoader, workerEntry], {
      cwd,
      env: {
        ...process.env,
        PIPELINE_WORKER_HEARTBEAT_FILE: workerHeartbeatFilePath,
        PIPELINE_WORKER_ID: identity.workerId,
        PIPELINE_WORKER_INSTANCE_NONCE: identity.instanceNonce,
        PIPELINE_WORKER_STDOUT_ONLY: "1",
        STAGEPASS_DB_BOOTSTRAPPED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
}

export type ProcessGroupSignalResult =
  | { ok: true; delivery: "sent" | "target_missing" }
  | {
    ok: false;
    error: "process_identity_mismatch";
    reason: string;
  }
  | {
    ok: false;
    error: "process_signal_failed";
    reason: string;
    signalCode: string;
  };

function identitiesMatch(
  expected: SupervisedProcessRecord["identity"],
  observed: SupervisedProcessRecord["identity"],
): boolean {
  return expected.pid === observed.pid
    && expected.ppid === observed.ppid
    && expected.pgid === observed.pgid
    && expected.nonce === observed.nonce
    && expected.processStartTime === observed.processStartTime
    && expected.cwd === observed.cwd
    && JSON.stringify(expected.command) === JSON.stringify(observed.command);
}

function digestSensitiveValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export async function signalValidatedProcessGroup(
  record: SupervisedProcessRecord,
  signal: NodeJS.Signals,
  probe: ProcessIdentityProbe = processIdentityProbe,
  signaler: (pgid: number, signal: NodeJS.Signals) => void = (pgid, sentSignal) => {
    process.kill(-pgid, sentSignal);
  },
): Promise<ProcessGroupSignalResult> {
  let validation: Awaited<ReturnType<ProcessIdentityProbe["validate"]>>;
  try {
    validation = await probe.validate(record.identity);
  } catch (error) {
    return {
      ok: false,
      error: "process_identity_mismatch",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!validation.ok) {
    return { ok: false, error: "process_identity_mismatch", reason: validation.reason };
  }
  if (!identitiesMatch(record.identity, validation.observed)) {
    return { ok: false, error: "process_identity_mismatch", reason: "observed_identity_mismatch" };
  }
  const pgid = record.identity.pgid;
  if (!Number.isInteger(pgid) || pgid === null || pgid <= 1 || pgid !== record.identity.pid) {
    return { ok: false, error: "process_identity_mismatch", reason: "unsafe_process_group" };
  }
  try {
    signaler(pgid, signal);
    return { ok: true, delivery: "sent" };
  } catch (error) {
    const signalCode = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNKNOWN";
    if (signalCode === "ESRCH") {
      return { ok: true, delivery: "target_missing" };
    }
    return {
      ok: false,
      error: "process_signal_failed",
      reason: error instanceof Error ? error.message : String(error),
      signalCode,
    };
  }
}

async function defaultHealthCheck(): Promise<boolean> {
  try {
    const response = await fetch(DEFAULT_HEALTH_URL);
    return response.ok;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeServerOutput(
  stream: Readable | null | undefined,
  consoleStream: NodeJS.WriteStream,
  logStream: Writable,
): void {
  stream?.on("data", (chunk: Buffer | string) => {
    consoleStream.write(chunk);
    logStream.write(chunk);
  });
}

async function waitForPortListening(options: {
  healthCheck: () => Promise<boolean>;
  beforeHealthCheck?: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
  startedAtMs: number;
}): Promise<boolean> {
  while (Date.now() - options.startedAtMs <= options.timeoutMs) {
    if (options.beforeHealthCheck && !(await options.beforeHealthCheck())) {
      return false;
    }
    if (await options.healthCheck()) {
      return true;
    }
    await options.sleep(options.pollIntervalMs);
  }
  return false;
}

export function createSupervisor(options: DevSupervisorOptions = {}): DevSupervisor {
  const cwd = options.cwd ?? process.cwd();
  const logDir = options.logDir ?? path.join(cwd, "logs");
  const serverLogFilePath = options.serverLogFilePath ?? path.join(logDir, "dev-server.log");
  const workerLogFilePath = options.workerLogFilePath ?? path.join(logDir, "pipeline-worker.log");
  const supervisorLogFilePath =
    options.supervisorLogFilePath ?? path.join(logDir, "dev-supervisor.log");
  const healthFilePath = options.healthFilePath ?? path.join(logDir, "supervisor-health.json");
  const workerHeartbeatFilePath = options.workerHeartbeatFilePath
    ?? path.join(logDir, "pipeline-worker-heartbeat.json");
  const childFactory = options.childFactory ?? createDefaultChildFactory(cwd);
  const workerChildFactory = options.workerChildFactory
    ?? createDefaultWorkerChildFactory(cwd, workerHeartbeatFilePath);
  const workerIdentityFactory = options.workerIdentityFactory ?? (() => ({
    workerId: `pipeline-worker-${randomUUID()}`,
    instanceNonce: randomUUID(),
  }));
  const superviseWorker = options.superviseWorker ?? false;
  const healthCheck = options.healthCheck ?? defaultHealthCheck;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const healthPollIntervalMs =
    options.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
  const identityProbe = options.processIdentityProbe ?? processIdentityProbe;
  const processGroupSignaler = options.processGroupSignaler ?? ((pgid, signal) => {
    process.kill(-pgid, signal);
  });
  const workerStaleAfterMs = options.workerStaleAfterMs ?? DEFAULT_WORKER_STALE_AFTER_MS;
  const workerMonitorIntervalMs = options.workerMonitorIntervalMs
    ?? DEFAULT_WORKER_MONITOR_INTERVAL_MS;
  const workerMonitorScheduler = options.workerMonitorScheduler ?? ((tick, intervalMs) => {
    const timer = setInterval(() => {
      void tick().catch(() => {});
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  });
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const decisionCollector = options.decisionCollector;
  const logStreamFactory = options.logStreamFactory ?? ((filePath: string) => {
    const fd = fs.openSync(filePath, "a");
    return fs.createWriteStream(filePath, { fd, autoClose: true });
  });

  let child: SupervisorChild | null = null;
  let workerChild: SupervisorChild | null = null;
  let restartCount = 0;
  let workerRestartCount = 0;
  let stopping = false;
  let pendingWork: Promise<void> = Promise.resolve();
  let workerPendingWork: Promise<void> = Promise.resolve();
  let serverLogStream: Writable | null = null;
  let workerLogStream: Writable | null = null;
  let childStartedAt: string | null = null;
  let workerStartedAt: string | null = null;
  let childRecord: SupervisedProcessRecord | null = null;
  let workerRecord: SupervisedProcessRecord | null = null;
  let workerInstanceIdentity: WorkerInstanceIdentity | null = null;
  let crashTimestampsMs: number[] = [];
  let workerCrashTimestampsMs: number[] = [];
  let disposeWorkerMonitor: (() => void) | null = null;
  let workerMonitorRunning = false;
  let unmanagedFatalError: SupervisorUnmanagedProcessError | null = null;
  let logFlushFatalError: SupervisorLogFlushError | null = null;
  const exitedChildren = new WeakSet<SupervisorChild>();
  const inFlightTerminations = new Map<string, Promise<boolean>>();
  const pendingLogClosures = new Set<Promise<void>>();

  function collectDecision(event: string, fields: Record<string, unknown> = {}): void {
    decisionCollector?.({
      event,
      observedAt: now().toISOString(),
      fields,
    });
  }

  function recordLogFlushError(
    role: "next" | "pipeline-worker",
    error: unknown,
  ): SupervisorLogFlushError {
    const reason = error instanceof Error ? error.message : String(error);
    const fatal = logFlushFatalError ?? new SupervisorLogFlushError(role, reason);
    logFlushFatalError = fatal;
    stopping = true;
    stopWorkerMonitor();
    const recordedAt = now().toISOString();
    appendSupervisorEvent(supervisorLogFilePath, "supervisor_log_flush_failed", {
      role,
      error: fatal.code,
      reason,
    });
    updateSupervisorHealth(healthFilePath, {
      [role === "next" ? "next" : "worker"]: {
        error: { code: fatal.code, reason, recordedAt },
      },
      updatedAt: recordedAt,
    });
    return fatal;
  }

  function closeLogStream(
    role: "next" | "pipeline-worker",
    stream: Writable | null,
  ): Promise<void> {
    if (!stream || stream.writableEnded) return Promise.resolve();
    const closure = finished(stream)
      .then(() => undefined)
      .catch((error) => {
        throw recordLogFlushError(role, error);
      });
    pendingLogClosures.add(closure);
    void closure.catch(() => {});
    stream.end();
    return closure;
  }

  async function waitForLogClosures(): Promise<void> {
    const closures = [...pendingLogClosures];
    try {
      await Promise.all(closures);
    } finally {
      closures.forEach((closure) => pendingLogClosures.delete(closure));
    }
  }

  function markUnmanagedProcess(
    role: "next" | "pipeline-worker",
    target: SupervisorChild,
    reason: string,
  ): SupervisorUnmanagedProcessError {
    const error = unmanagedFatalError ?? new SupervisorUnmanagedProcessError(
      role,
      target.pid ?? null,
      reason,
    );
    unmanagedFatalError = error;
    stopping = true;
    stopWorkerMonitor();
    const recordedAt = now().toISOString();
    appendSupervisorEvent(supervisorLogFilePath, "supervisor_unmanaged_process", {
      role,
      pid: target.pid ?? null,
      error: error.code,
      reason,
      requiresManualCleanup: true,
    });
    updateSupervisorHealth(healthFilePath, role === "next" ? {
      next: {
        record: null,
        lastHealthAt: null,
        portListening: false,
        crashLoop: true,
        error: {
          code: error.code,
          reason,
          recordedAt,
        },
      },
      updatedAt: recordedAt,
    } : {
      worker: {
        record: null,
        lastHealthAt: null,
        heartbeat: null,
        crashLoop: true,
        error: {
          code: error.code,
          reason,
          recordedAt,
        },
      },
      updatedAt: recordedAt,
    });
    return error;
  }

  function recordIdentityError(
    role: "next" | "pipeline-worker",
    code: "process_identity_mismatch" | "process_identity_capture_failed",
    reason: string,
  ): void {
    const recordedAt = now().toISOString();
    appendSupervisorEvent(supervisorLogFilePath, code, {
      role,
      error: code,
      reason,
    });
    updateSupervisorHealth(healthFilePath, {
      [role === "next" ? "next" : "worker"]: {
        error: { code, reason, recordedAt },
      },
      updatedAt: recordedAt,
    });
  }

  function recordWorkerHeartbeatError(reason: string): void {
    const recordedAt = now().toISOString();
    appendSupervisorEvent(supervisorLogFilePath, "pipeline_worker_heartbeat_rejected", {
      error: "worker_heartbeat_mismatch",
      reason,
    });
    updateSupervisorHealth(healthFilePath, {
      worker: {
        error: {
          code: "worker_heartbeat_mismatch",
          reason,
          recordedAt,
        },
      },
      updatedAt: recordedAt,
    });
  }

  function recordProcessSignalError(
    role: "next" | "pipeline-worker",
    signal: NodeJS.Signals,
    signalCode: string,
    reason: string,
  ): void {
    const recordedAt = now().toISOString();
    appendSupervisorEvent(supervisorLogFilePath, "process_group_signal_failed", {
      role,
      signal,
      signalCode,
      error: "process_signal_failed",
      reason,
    });
    updateSupervisorHealth(healthFilePath, {
      [role === "next" ? "next" : "worker"]: {
        error: {
          code: "process_signal_failed",
          reason: `${signalCode}:${reason}`,
          recordedAt,
        },
      },
      updatedAt: recordedAt,
    });
  }

  function recordWorkerMonitorError(error: unknown): void {
    const recordedAt = now().toISOString();
    const reason = error instanceof Error ? error.message : String(error);
    appendSupervisorEvent(supervisorLogFilePath, "worker_monitor_failed", {
      error: "worker_monitor_failed",
      reason,
    });
    updateSupervisorHealth(healthFilePath, {
      worker: {
        error: { code: "worker_monitor_failed", reason, recordedAt },
      },
      updatedAt: recordedAt,
    });
  }

  async function captureRecord(
    role: "next" | "pipeline-worker",
    launched: SupervisorChild,
    startedAt: string,
  ): Promise<SupervisedProcessRecord | null> {
    const pid = launched.pid;
    if (!pid || pid <= 1) {
      recordIdentityError(role, "process_identity_capture_failed", "missing_child_pid");
      throw markUnmanagedProcess(role, launched, "missing_child_pid");
    }
    const spawnIdentityConstraints = {
      ppid: process.pid,
      pgid: pid,
      cwd: fs.realpathSync(cwd),
    };
    try {
      const identity = await identityProbe.capture(pid, spawnIdentityConstraints);
      if (identity.pgid !== identity.pid) {
        recordIdentityError(role, "process_identity_capture_failed", "unsafe_process_group");
        throw markUnmanagedProcess(role, launched, "unsafe_process_group");
      }
      return {
        role,
        identity,
        startedAt,
        lastHeartbeatAt: null,
      };
    } catch (error) {
      const expectedCaptureReason = error instanceof Error ? error.message : String(error);
      recordIdentityError(
        role,
        "process_identity_capture_failed",
        `expected_capture:${expectedCaptureReason}`,
      );
      const stillHeld = role === "next" ? child === launched : workerChild === launched;
      if (!stillHeld) return null;

      let quarantineRecord: SupervisedProcessRecord;
      try {
        const identity = await identityProbe.capture(pid, spawnIdentityConstraints);
        quarantineRecord = {
          role,
          identity,
          startedAt,
          lastHeartbeatAt: null,
        };
      } catch (quarantineError) {
        const reason = `quarantine_capture:${quarantineError instanceof Error
          ? quarantineError.message
          : String(quarantineError)}`;
        recordIdentityError(role, "process_identity_capture_failed", reason);
        appendSupervisorEvent(supervisorLogFilePath, "process_identity_quarantine_failed", {
          role,
          phase: "capture",
          error: "process_identity_capture_failed",
          reason,
        });
        throw markUnmanagedProcess(role, launched, reason);
      }

      const quarantineTerminated = await terminateControlled({
        role,
        record: quarantineRecord,
        target: launched,
        reason: "quarantine_identity_cleanup",
      });
      if (!quarantineTerminated) {
        const reason = "quarantine_validate:controlled_termination_rejected";
        recordIdentityError(role, "process_identity_mismatch", reason);
        appendSupervisorEvent(supervisorLogFilePath, "process_identity_quarantine_failed", {
          role,
          phase: "validate",
          error: "process_identity_mismatch",
          reason,
          pid: quarantineRecord.identity.pid,
          pgid: quarantineRecord.identity.pgid,
        });
        throw markUnmanagedProcess(role, launched, reason);
      }

      appendSupervisorEvent(supervisorLogFilePath, "process_identity_quarantine_terminated", {
        role,
        signal: "SIGTERM",
        pid: quarantineRecord.identity.pid,
        pgid: quarantineRecord.identity.pgid,
      });
      return null;
    }
  }

  async function signalRecord(
    role: "next" | "pipeline-worker",
    record: SupervisedProcessRecord,
    signal: NodeJS.Signals,
  ): Promise<ProcessGroupSignalResult> {
    const result = await signalValidatedProcessGroup(
      record,
      signal,
      identityProbe,
      processGroupSignaler,
    );
    collectDecision("process_group_signal_result", {
      role,
      signal,
      pid: record.identity.pid,
      pgid: record.identity.pgid,
      ...result,
    });
    if (result.ok) {
      if (result.delivery === "target_missing") {
        appendSupervisorEvent(supervisorLogFilePath, "process_group_signal_esrch", {
          role,
          signal,
          pid: record.identity.pid,
          pgid: record.identity.pgid,
        });
      }
      return result;
    }
    if (result.error === "process_identity_mismatch") {
      recordIdentityError(role, "process_identity_mismatch", result.reason);
    } else {
      recordProcessSignalError(role, signal, result.signalCode, result.reason);
    }
    return result;
  }

  function createChildExitWaiter(
    target: SupervisorChild,
    timeoutMs: number | null,
  ): { promise: Promise<boolean>; cancel: () => void } {
    if (exitedChildren.has(target)) {
      return { promise: Promise.resolve(true), cancel: () => {} };
    }
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let resolvePromise!: (exited: boolean) => void;
    const onExit = () => settle(true);
    const settle = (exited: boolean) => {
      if (settled) return;
      settled = true;
      target.off("exit", onExit);
      if (timer) clearTimeout(timer);
      resolvePromise(exited);
      collectDecision("child_exit_latch", {
        pid: target.pid ?? null,
        exited,
        timeoutMs,
      });
    };
    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
      target.once("exit", onExit);
      if (timeoutMs !== null) {
        timer = setTimeout(() => settle(false), timeoutMs);
      }
    });
    return { promise, cancel: () => settle(false) };
  }

  async function reconcileMissingSignalTarget(
    role: "next" | "pipeline-worker",
    record: SupervisedProcessRecord,
    signal: NodeJS.Signals,
  ): Promise<boolean> {
    let validation: Awaited<ReturnType<ProcessIdentityProbe["validate"]>>;
    try {
      validation = await identityProbe.validate(record.identity);
    } catch (error) {
      recordProcessSignalError(
        role,
        signal,
        "ESRCH_RECONCILIATION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
    if (!validation.ok && validation.reason === "pid_missing") return true;
    if (!validation.ok) {
      recordIdentityError(role, "process_identity_mismatch", validation.reason);
      return false;
    }
    if (!identitiesMatch(record.identity, validation.observed)) {
      recordIdentityError(role, "process_identity_mismatch", "observed_identity_mismatch");
      return false;
    }
    recordProcessSignalError(
      role,
      signal,
      "ESRCH_TARGET_STILL_PRESENT",
      "Process identity remained live after ESRCH",
    );
    return false;
  }

  function strongIdentityKey(record: SupervisedProcessRecord): string {
    const identity = record.identity;
    return JSON.stringify([
      identity.pid,
      identity.ppid,
      identity.pgid,
      identity.nonce,
      identity.processStartTime,
      identity.cwd,
      identity.command,
    ]);
  }

  function terminateControlled(input: {
    role: "next" | "pipeline-worker";
    record: SupervisedProcessRecord;
    target: SupervisorChild;
    reason: string;
    signal?: NodeJS.Signals;
  }): Promise<boolean> {
    const key = strongIdentityKey(input.record);
    const existing = inFlightTerminations.get(key);
    if (existing) {
      collectDecision("controlled_termination_joined", {
        role: input.role,
        pid: input.record.identity.pid,
        requestedSignal: input.signal ?? "SIGTERM",
      });
      return existing;
    }
    const termination: Promise<boolean> = runControlledTermination(input).finally(() => {
      if (inFlightTerminations.get(key) === termination) {
        inFlightTerminations.delete(key);
      }
    });
    inFlightTerminations.set(key, termination);
    return termination;
  }

  async function runControlledTermination(input: {
    role: "next" | "pipeline-worker";
    record: SupervisedProcessRecord;
    target: SupervisorChild;
    reason: string;
    signal?: NodeJS.Signals;
  }): Promise<boolean> {
    const initialSignal = input.signal ?? "SIGTERM";
    const gracefulExit = createChildExitWaiter(input.target, terminationGraceMs);
    appendSupervisorEvent(supervisorLogFilePath, "controlled_termination_started", {
      role: input.role,
      reason: input.reason,
      signal: initialSignal,
      pid: input.record.identity.pid,
      pgid: input.record.identity.pgid,
    });
    collectDecision("controlled_termination_started", {
      role: input.role,
      reason: input.reason,
      signal: initialSignal,
      pid: input.record.identity.pid,
    });
    const initialDelivery = await signalRecord(input.role, input.record, initialSignal);
    if (!initialDelivery.ok) {
      gracefulExit.cancel();
      return false;
    }
    const gracefullyExited = await gracefulExit.promise;
    collectDecision("controlled_termination_grace_complete", {
      role: input.role,
      signal: initialSignal,
      delivery: initialDelivery.delivery,
      exited: gracefullyExited,
      pid: input.record.identity.pid,
    });
    if (
      initialDelivery.delivery === "target_missing"
      && !gracefullyExited
      && !await reconcileMissingSignalTarget(input.role, input.record, initialSignal)
    ) {
      return false;
    }
    if (gracefullyExited || initialDelivery.delivery === "target_missing") {
      appendSupervisorEvent(supervisorLogFilePath, "controlled_termination_completed", {
        role: input.role,
        reason: input.reason,
        signal: initialSignal,
        escalated: false,
        pid: input.record.identity.pid,
        pgid: input.record.identity.pgid,
      });
      return true;
    }

    const forcedExit = createChildExitWaiter(input.target, terminationGraceMs);
    const forcedDelivery = await signalRecord(input.role, input.record, "SIGKILL");
    if (!forcedDelivery.ok) {
      forcedExit.cancel();
      return false;
    }
    appendSupervisorEvent(supervisorLogFilePath, "controlled_termination_escalated", {
      role: input.role,
      reason: input.reason,
      signal: "SIGKILL",
      pid: input.record.identity.pid,
      pgid: input.record.identity.pgid,
    });
    collectDecision("controlled_termination_escalated", {
      role: input.role,
      signal: "SIGKILL",
      delivery: forcedDelivery.delivery,
      pid: input.record.identity.pid,
    });
    const forciblyExited = await forcedExit.promise;
    collectDecision("controlled_termination_force_complete", {
      role: input.role,
      delivery: forcedDelivery.delivery,
      exited: forciblyExited,
      pid: input.record.identity.pid,
    });
    if (
      forcedDelivery.delivery === "target_missing"
      && !forciblyExited
      && !await reconcileMissingSignalTarget(input.role, input.record, "SIGKILL")
    ) {
      return false;
    }
    if (!forciblyExited && forcedDelivery.delivery === "sent") {
      recordProcessSignalError(
        input.role,
        "SIGKILL",
        "EXIT_TIMEOUT",
        "Process did not emit exit after SIGKILL",
      );
      return false;
    }
    appendSupervisorEvent(supervisorLogFilePath, "controlled_termination_completed", {
      role: input.role,
      reason: input.reason,
      signal: "SIGKILL",
      escalated: true,
      pid: input.record.identity.pid,
      pgid: input.record.identity.pgid,
    });
    return true;
  }

  async function monitorWorkerHealth(): Promise<void> {
    if (stopping || workerMonitorRunning || !workerRecord) return;
    workerMonitorRunning = true;
    const monitoredRecord = workerRecord;
    const monitoredInstanceIdentity = workerInstanceIdentity;
    const monitoredChild = workerChild;
    try {
      const validation = await identityProbe.validate(monitoredRecord.identity);
      collectDecision("worker_identity_validation", {
        pid: monitoredRecord.identity.pid,
        ok: validation.ok,
        reason: validation.ok ? null : validation.reason,
      });
      if (!validation.ok || !identitiesMatch(monitoredRecord.identity, validation.observed)) {
        recordIdentityError(
          "pipeline-worker",
          "process_identity_mismatch",
          validation.ok ? "observed_identity_mismatch" : validation.reason,
        );
        return;
      }

      const heartbeat = readWorkerHeartbeat(workerHeartbeatFilePath);
      const observedAtMs = heartbeat ? Date.parse(heartbeat.observedAt) : Number.NaN;
      const startedAtMs = Date.parse(monitoredRecord.startedAt);
      const observedNowMs = now().getTime();
      const heartbeatBelongsToWorker = heartbeat !== null
        && monitoredInstanceIdentity !== null
        && heartbeat.pid === monitoredRecord.identity.pid
        && heartbeat.workerId === monitoredInstanceIdentity.workerId
        && heartbeat.instanceNonce === monitoredInstanceIdentity.instanceNonce
        && heartbeat.workerNonce === monitoredInstanceIdentity.instanceNonce
        && Number.isFinite(observedAtMs)
        && observedAtMs >= startedAtMs
        && observedAtMs <= observedNowMs;
      if (heartbeat && !heartbeatBelongsToWorker) {
        recordWorkerHeartbeatError("worker_heartbeat_owner_or_time_mismatch");
      }
      if (heartbeatBelongsToWorker) {
        monitoredRecord.lastHeartbeatAt = heartbeat.observedAt;
        updateSupervisorHealth(healthFilePath, {
          worker: {
            record: monitoredRecord,
            heartbeat,
            lastHealthAt: heartbeat.observedAt,
            error: null,
          },
          updatedAt: now().toISOString(),
        });
      }

      const livenessAt = heartbeatBelongsToWorker
        ? observedAtMs
        : Date.parse(monitoredRecord.lastHeartbeatAt ?? monitoredRecord.startedAt);
      const stale = !Number.isFinite(livenessAt)
        || now().getTime() - livenessAt > workerStaleAfterMs;
      collectDecision("worker_health_check", {
        heartbeatPath: workerHeartbeatFilePath,
        recordPid: monitoredRecord.identity.pid,
        heartbeatPid: heartbeat?.pid ?? null,
        ownerMatch: heartbeatBelongsToWorker,
        observedAt: heartbeat?.observedAt ?? null,
        observedNow: new Date(observedNowMs).toISOString(),
        ageMs: Number.isFinite(livenessAt) ? observedNowMs - livenessAt : null,
        staleAfterMs: workerStaleAfterMs,
        fresh: !stale,
      });
      if (
        !stale
        || stopping
        || workerRecord !== monitoredRecord
        || !monitoredChild
        || workerChild !== monitoredChild
      ) return;

      appendSupervisorEvent(supervisorLogFilePath, "pipeline_worker_stale", {
        pid: monitoredRecord.identity.pid,
        pgid: monitoredRecord.identity.pgid,
        workerId: heartbeatBelongsToWorker ? heartbeat.workerId : null,
        workerNonceDigest: heartbeatBelongsToWorker
          ? digestSensitiveValue(heartbeat.workerNonce)
          : null,
        instanceNonceDigest: heartbeatBelongsToWorker
          ? digestSensitiveValue(heartbeat.instanceNonce)
          : null,
        lastHeartbeatAt: heartbeatBelongsToWorker ? heartbeat.observedAt : null,
        staleAfterMs: workerStaleAfterMs,
      });
      const terminated = await terminateControlled({
        role: "pipeline-worker",
        record: monitoredRecord,
        target: monitoredChild,
        reason: "worker_heartbeat_stale",
      });
      if (!terminated) {
        markUnmanagedProcess(
          "pipeline-worker",
          monitoredChild,
          "worker_heartbeat_stale:controlled_termination_rejected",
        );
      }
    } finally {
      workerMonitorRunning = false;
    }
  }

  async function runWorkerMonitorTick(): Promise<void> {
    try {
      await monitorWorkerHealth();
    } catch (error) {
      recordWorkerMonitorError(error);
    }
  }

  function startWorkerMonitor(): void {
    if (stopping || disposeWorkerMonitor) return;
    disposeWorkerMonitor = workerMonitorScheduler(
      runWorkerMonitorTick,
      workerMonitorIntervalMs,
    );
    collectDecision("worker_monitor_started", { intervalMs: workerMonitorIntervalMs });
  }

  function stopWorkerMonitor(): void {
    if (!disposeWorkerMonitor) return;
    disposeWorkerMonitor();
    disposeWorkerMonitor = null;
    collectDecision("worker_monitor_stopped");
  }

  async function launchChild(): Promise<void> {
    ensureLogDir(logDir);
    const startedAt = now().toISOString();
    childStartedAt = startedAt;
    appendSupervisorEvent(supervisorLogFilePath, "dev_server_starting", {
      restartCount,
      startedAt,
    });

    serverLogStream = logStreamFactory(serverLogFilePath);
    const launchedChild = childFactory();
    child = launchedChild;
    writeServerOutput(launchedChild.stdout, process.stdout, serverLogStream);
    writeServerOutput(launchedChild.stderr, process.stderr, serverLogStream);

    launchedChild.once("exit", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      exitedChildren.add(launchedChild);
      collectDecision("child_exit_observed", {
        role: "next",
        pid: launchedChild.pid ?? null,
        exitCode,
        signal,
      });
      pendingWork = handleChildExit(exitCode, signal);
    });

    const capturedRecord = await captureRecord("next", launchedChild, startedAt);
    if (child !== launchedChild) return;
    if (stopping) return;
    childRecord = capturedRecord;
    if (!capturedRecord) {
      updateSupervisorHealth(healthFilePath, {
        next: {
          record: null,
          restartCount,
          lastHealthAt: null,
          portListening: false,
        },
        updatedAt: now().toISOString(),
      });
      return;
    }

    appendSupervisorEvent(supervisorLogFilePath, "dev_server_started", {
      pid: capturedRecord.identity.pid,
      pgid: capturedRecord.identity.pgid,
      restartCount,
      startedAt,
    });
    updateSupervisorHealth(healthFilePath, {
      next: {
        record: capturedRecord,
        restartCount,
        lastHealthAt: null,
        portListening: false,
        crashLoop: false,
        error: null,
      },
      updatedAt: now().toISOString(),
    });

    const listening = await waitForPortListening({
      healthCheck,
      beforeHealthCheck: async () => {
        const validation = await identityProbe.validate(capturedRecord.identity);
        if (validation.ok && identitiesMatch(capturedRecord.identity, validation.observed)) {
          return true;
        }
        recordIdentityError(
          "next",
          "process_identity_mismatch",
          validation.ok ? "observed_identity_mismatch" : validation.reason,
        );
        return false;
      },
      sleep,
      timeoutMs: healthTimeoutMs,
      pollIntervalMs: healthPollIntervalMs,
      startedAtMs: Date.now(),
    });

    if (stopping || child !== launchedChild) {
      return;
    }

    if (listening) {
      const lastHealthAt = now().toISOString();
      const validation = await identityProbe.validate(capturedRecord.identity);
      if (!validation.ok || !identitiesMatch(capturedRecord.identity, validation.observed)) {
        recordIdentityError(
          "next",
          "process_identity_mismatch",
          validation.ok ? "observed_identity_mismatch" : validation.reason,
        );
        return;
      }
      capturedRecord.lastHeartbeatAt = lastHealthAt;
      appendSupervisorEvent(supervisorLogFilePath, "dev_server_port_listening", {
        pid: launchedChild.pid ?? null,
        restartCount,
        startedAt,
        lastHealthAt,
      });
      updateSupervisorHealth(healthFilePath, {
        next: {
          record: capturedRecord,
          restartCount,
          lastHealthAt,
          portListening: true,
        },
        updatedAt: lastHealthAt,
      });
      return;
    }

    const endedAt = now().toISOString();
    appendSupervisorEvent(supervisorLogFilePath, "dev_server_port_not_listening", {
      pid: launchedChild.pid ?? null,
      restartCount,
      startedAt,
      endedAt,
    });
    appendSupervisorEvent(supervisorLogFilePath, "dev_server_health_failed", {
      pid: launchedChild.pid ?? null,
      restartCount,
      startedAt,
      endedAt,
    });
    updateSupervisorHealth(healthFilePath, {
      next: {
        record: capturedRecord,
        restartCount,
        portListening: false,
      },
      updatedAt: endedAt,
    });
    const terminated = await terminateControlled({
      role: "next",
      record: capturedRecord,
      target: launchedChild,
      reason: "health_check_failed",
    });
    if (!terminated) {
      throw markUnmanagedProcess(
        "next",
        launchedChild,
        "health_check_failed:controlled_termination_rejected",
      );
    }
  }

  async function handleChildExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const endedAt = now().toISOString();
    const exitedChild = child;
    child = null;
    childRecord = null;
    const logClosure = closeLogStream("next", serverLogStream);
    serverLogStream = null;

    appendSupervisorEvent(supervisorLogFilePath, "dev_server_exit", {
      pid: exitedChild?.pid ?? null,
      exitCode,
      signal,
      restartCount,
      startedAt: childStartedAt,
      endedAt,
    });
    updateSupervisorHealth(healthFilePath, {
      next: {
        record: null,
        restartCount,
        lastExit: {
          exitCode,
          signal,
          endedAt,
        },
        lastHealthAt: null,
        portListening: false,
      },
      updatedAt: endedAt,
    });

    await logClosure;

    if (stopping) {
      return;
    }

    const abnormalExit = exitCode !== 0 || signal !== null;
    if (!abnormalExit) {
      return;
    }

    const nowMs = now().getTime();
    crashTimestampsMs = [...crashTimestampsMs, nowMs].filter(
      (timestamp) => nowMs - timestamp <= CRASH_LOOP_WINDOW_MS,
    );
    if (isCrashLoop(crashTimestampsMs, nowMs)) {
      appendSupervisorEvent(supervisorLogFilePath, "supervisor_child_crash_loop", {
        pid: exitedChild?.pid ?? null,
        exitCode,
        signal,
        restartCount,
        startedAt: childStartedAt,
        endedAt,
      });
      updateSupervisorHealth(healthFilePath, {
        next: {
          record: null,
          restartCount,
          portListening: false,
          crashLoop: true,
        },
        updatedAt: endedAt,
      });
      return;
    }

    const backoffMs = computeBackoffMs(restartCount);
    restartCount += 1;
    appendSupervisorEvent(supervisorLogFilePath, "dev_server_restarting", {
      pid: exitedChild?.pid ?? null,
      exitCode,
      signal,
      restartCount,
      backoffMs,
      startedAt: childStartedAt,
      endedAt,
    });
    updateSupervisorHealth(healthFilePath, {
      next: {
        record: null,
        restartCount,
        portListening: false,
      },
      updatedAt: endedAt,
    });

    await sleep(backoffMs);
    if (!stopping) {
      await launchChild();
    }
  }

  async function launchWorker(): Promise<void> {
    if (stopping) return;
    ensureLogDir(logDir);
    const startedAt = now().toISOString();
    workerStartedAt = startedAt;
    appendSupervisorEvent(supervisorLogFilePath, "pipeline_worker_starting", {
      restartCount: workerRestartCount,
      startedAt,
    });

    workerLogStream = logStreamFactory(workerLogFilePath);
    const launchedIdentity = workerIdentityFactory();
    workerInstanceIdentity = launchedIdentity;
    const launchedWorker = workerChildFactory(launchedIdentity);
    workerChild = launchedWorker;
    writeServerOutput(launchedWorker.stdout, process.stdout, workerLogStream);
    writeServerOutput(launchedWorker.stderr, process.stderr, workerLogStream);

    launchedWorker.once("exit", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      exitedChildren.add(launchedWorker);
      collectDecision("child_exit_observed", {
        role: "pipeline-worker",
        pid: launchedWorker.pid ?? null,
        exitCode,
        signal,
      });
      workerPendingWork = handleWorkerExit(exitCode, signal);
    });

    const capturedRecord = await captureRecord("pipeline-worker", launchedWorker, startedAt);
    if (workerChild !== launchedWorker) return;
    if (stopping) return;
    workerRecord = capturedRecord;
    if (!capturedRecord) {
      updateSupervisorHealth(healthFilePath, {
        worker: {
          record: null,
          restartCount: workerRestartCount,
          lastHealthAt: null,
          heartbeat: null,
        },
        updatedAt: now().toISOString(),
      });
      return;
    }

    appendSupervisorEvent(supervisorLogFilePath, "pipeline_worker_started", {
      pid: capturedRecord.identity.pid,
      pgid: capturedRecord.identity.pgid,
      workerId: launchedIdentity.workerId,
      instanceNonceDigest: digestSensitiveValue(launchedIdentity.instanceNonce),
      restartCount: workerRestartCount,
      startedAt,
    });
    updateSupervisorHealth(healthFilePath, {
      worker: {
        record: capturedRecord,
        restartCount: workerRestartCount,
        lastHealthAt: null,
        heartbeat: null,
        crashLoop: false,
        error: null,
      },
      updatedAt: startedAt,
    });
  }

  async function handleWorkerExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const endedAt = now().toISOString();
    const exitedWorker = workerChild;
    workerChild = null;
    workerRecord = null;
    workerInstanceIdentity = null;
    const logClosure = closeLogStream("pipeline-worker", workerLogStream);
    workerLogStream = null;

    appendSupervisorEvent(supervisorLogFilePath, "pipeline_worker_exit", {
      pid: exitedWorker?.pid ?? null,
      exitCode,
      signal,
      restartCount: workerRestartCount,
      startedAt: workerStartedAt,
      endedAt,
    });
    updateSupervisorHealth(healthFilePath, {
      worker: {
        record: null,
        restartCount: workerRestartCount,
        lastExit: {
          exitCode,
          signal,
          endedAt,
        },
        lastHealthAt: null,
        heartbeat: null,
      },
      updatedAt: endedAt,
    });

    await logClosure;

    if (stopping) {
      return;
    }

    const nowMs = now().getTime();
    workerCrashTimestampsMs = [...workerCrashTimestampsMs, nowMs].filter(
      (timestamp) => nowMs - timestamp <= CRASH_LOOP_WINDOW_MS,
    );
    if (isCrashLoop(workerCrashTimestampsMs, nowMs)) {
      appendSupervisorEvent(supervisorLogFilePath, "supervisor_child_crash_loop", {
        child: "worker",
        pid: exitedWorker?.pid ?? null,
        exitCode,
        signal,
        restartCount: workerRestartCount,
        startedAt: workerStartedAt,
        endedAt,
      });
      updateSupervisorHealth(healthFilePath, {
        worker: {
          record: null,
          restartCount: workerRestartCount,
          crashLoop: true,
        },
        updatedAt: endedAt,
      });
      return;
    }

    const backoffMs = computeBackoffMs(workerRestartCount);
    workerRestartCount += 1;
    appendSupervisorEvent(supervisorLogFilePath, "pipeline_worker_restarting", {
      pid: exitedWorker?.pid ?? null,
      exitCode,
      signal,
      restartCount: workerRestartCount,
      backoffMs,
      startedAt: workerStartedAt,
      endedAt,
    });
    updateSupervisorHealth(healthFilePath, {
      worker: {
        record: null,
        restartCount: workerRestartCount,
      },
      updatedAt: endedAt,
    });

    await sleep(backoffMs);
    if (!stopping) {
      await launchWorker();
    }
  }

  return {
    async start() {
      if (unmanagedFatalError) throw unmanagedFatalError;
      if (logFlushFatalError) throw logFlushFatalError;
      await launchChild();
      if (stopping) {
        if (unmanagedFatalError) throw unmanagedFatalError;
        return;
      }
      if (superviseWorker) {
        await launchWorker();
        if (stopping) {
          if (unmanagedFatalError) throw unmanagedFatalError;
          return;
        }
        startWorkerMonitor();
      }
    },
    async checkWorkerHealth() {
      await runWorkerMonitorTick();
    },
    async stop(signal: NodeJS.Signals) {
      stopping = true;
      stopWorkerMonitor();
      appendSupervisorEvent(supervisorLogFilePath, "dev_supervisor_signal", {
        pid: child?.pid ?? null,
        workerPid: workerChild?.pid ?? null,
        signal,
        restartCount,
        workerRestartCount,
      });
      const terminations: Array<{
        role: "next" | "pipeline-worker";
        target: SupervisorChild;
        result: Promise<boolean>;
      }> = [];
      if (child && !childRecord) {
        markUnmanagedProcess("next", child, `supervisor_shutdown:${signal}:identity_unavailable`);
      }
      if (workerChild && !workerRecord) {
        markUnmanagedProcess(
          "pipeline-worker",
          workerChild,
          `supervisor_shutdown:${signal}:identity_unavailable`,
        );
      }
      if (child && childRecord) {
        terminations.push({
          role: "next",
          target: child,
          result: terminateControlled({
            role: "next",
            record: childRecord,
            target: child,
            reason: `supervisor_shutdown:${signal}`,
            signal,
          }),
        });
      }
      if (workerChild && workerRecord) {
        terminations.push({
          role: "pipeline-worker",
          target: workerChild,
          result: terminateControlled({
            role: "pipeline-worker",
            record: workerRecord,
            target: workerChild,
            reason: `supervisor_shutdown:${signal}`,
            signal,
          }),
        });
      }
      const results = await Promise.all(terminations.map(({ result }) => result));
      results.forEach((terminated, index) => {
        if (!terminated) {
          const termination = terminations[index];
          markUnmanagedProcess(
            termination.role,
            termination.target,
            `supervisor_shutdown:${signal}:controlled_termination_rejected`,
          );
        }
      });
      const lifecycleResults = await Promise.allSettled([pendingWork, workerPendingWork]);
      let closureError: unknown = null;
      try {
        await waitForLogClosures();
      } catch (error) {
        closureError = error;
      }
      if (unmanagedFatalError) throw unmanagedFatalError;
      if (logFlushFatalError) throw logFlushFatalError;
      if (closureError) throw closureError;
      const lifecycleFailure = lifecycleResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (lifecycleFailure) throw lifecycleFailure.reason;
    },
    async waitForIdle() {
      const lifecycleResults = await Promise.allSettled([pendingWork, workerPendingWork]);
      await waitForLogClosures();
      const lifecycleFailure = lifecycleResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (lifecycleFailure) throw lifecycleFailure.reason;
    },
  };
}

async function main(): Promise<void> {
  migrateDatabase();
  process.env.STAGEPASS_DB_BOOTSTRAPPED = "1";
  const supervisor = createSupervisor({ superviseWorker: true });
  let shutdown: Promise<void> | null = null;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      shutdown ??= supervisor.stop(signal)
        .then(() => {
          process.exitCode = 0;
        })
        .catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
    });
  }
  await supervisor.start();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export function createFakeSupervisorChild(pid: number): SupervisorChild {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
}
