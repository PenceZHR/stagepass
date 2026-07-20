import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { runMigrations } from "../db/migrate";
import { processIdentityProbe, type ProcessIdentity } from "./process-identity-service";
import { readSupervisorHealth } from "./supervisor-health-service";

export const CRASH_ACCEPTANCE_CASES = [
  "delete-logs",
  "sqlite-lock",
  "restart-recovery",
  "kill-worker",
  "kill-next",
  "kill-provider",
] as const;

export type CrashAcceptanceCase = (typeof CRASH_ACCEPTANCE_CASES)[number];

export interface CrashAcceptanceOptions {
  caseName: CrashAcceptanceCase;
  changeId?: string;
  runId?: string;
  execute?: boolean;
}

export interface CrashAcceptanceResult {
  caseName: CrashAcceptanceCase;
  passed: true;
  dbPath: string;
  assertions: string[];
  identities: ProcessIdentity[];
  evidence: AcceptanceEvidence[];
}

export type AcceptanceEvidence =
  | { kind: "http"; changeId: string; runId: string | null; attemptNo: number | null; reason: string | null; detailStatus: number; eventCount: number; sseChangeId: string | null; enabledActions: Array<string | undefined> }
  | { kind: "recovery-row"; changeId: string; runId: string; provider: string; job: string; run: string; stage: string; change: string; eventType: string; eventCount: number }
  | { kind: "logs"; files: Array<{ name: string; exists: boolean; bytes: number }>; supervisorEvents: string[] }
  | { kind: "processes"; identities: Array<{ pid: number; pgid: number | null; nonce: string }> };

export interface RegisteredProcess {
  child: ChildProcess;
  identity: ProcessIdentity;
  stdout?: string;
  stderr?: string;
  closed?: boolean;
  outcome?: ChildOutcomeDeferred;
}

interface ProbeResult { stdout: string; stderr: string }
interface ChildOutcome { code: number | null; error?: Error }
interface ChildOutcomeDeferred { promise: Promise<ChildOutcome>; settled(): boolean }

const SOURCE_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SOURCE_FILE), "../..");
const REAL_DB_PATH = path.resolve(PROJECT_ROOT, "server/db/ship.db");
const REAL_DB_FILES = [REAL_DB_PATH, `${REAL_DB_PATH}-wal`, `${REAL_DB_PATH}-shm`];
const requireRuntime = createRequire(import.meta.url);
export const ACCEPTANCE_OUTER_TIMEOUT_MS = 120_000;
export const ACCEPTANCE_PROVIDER_TIMEOUT_MS = 60_000;

function acceptanceProviderTimeoutMs(): number {
  const requested = Number(process.env.STAGEPASS_ACCEPTANCE_PROVIDER_TIMEOUT_MS);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, ACCEPTANCE_PROVIDER_TIMEOUT_MS)
    : ACCEPTANCE_PROVIDER_TIMEOUT_MS;
}

interface HarnessSupervisor {
  start(): Promise<void>;
  stop(signal: NodeJS.Signals): Promise<void>;
}

function checksum(file: string): { hash: string | null; mtimeMs: number | null } {
  if (!fs.existsSync(file)) return { hash: null, mtimeMs: null };
  const stat = fs.statSync(file);
  return {
    hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    mtimeMs: stat.mtimeMs,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function createChildOutcomeDeferred(child: ChildProcess): ChildOutcomeDeferred {
  let isSettled = false;
  let resolveOutcome!: (outcome: ChildOutcome) => void;
  const promise = new Promise<ChildOutcome>((resolve) => { resolveOutcome = resolve; });
  const settle = (outcome: ChildOutcome) => {
    if (isSettled) return;
    isSettled = true;
    resolveOutcome(outcome);
  };
  child.once("error", (error) => settle({ code: null, error }));
  child.once("close", (code) => settle({ code }));
  return { promise, settled: () => isSettled };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("acceptance_wait_timeout");
}

async function signalValidated(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
  const validation = await processIdentityProbe.validate(identity);
  if (!validation.ok) throw new Error(`signal_identity_rejected:${validation.reason}`);
  assert.equal(identity.pgid, identity.pid);
  process.kill(-identity.pgid, signal);
}

async function signalValidatedProvider(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
  const validation = await processIdentityProbe.validate(identity);
  if (!validation.ok) throw new Error(`provider_signal_identity_rejected:${validation.reason}`);
  process.kill(identity.pid, signal);
}

async function runFenceProbe(registry: ResourceRegistry, dbPath: string, context: Record<string, string | number>, output: string): Promise<string[]> {
  await registry.runProbe(["--child", "fence-probe"], {
    STAGEPASS_DB_PATH: dbPath, STAGEPASS_FENCE_CONTEXT: JSON.stringify(context), STAGEPASS_FENCE_OUTPUT: output,
  });
  return JSON.parse(fs.readFileSync(output, "utf8")) as string[];
}

async function runTerminalProbe(registry: ResourceRegistry, dbPath: string, input: Record<string, unknown>, output: string): Promise<Record<string, unknown>> {
  await registry.runProbe(["--child", "terminal-probe"], {
    STAGEPASS_DB_PATH: dbPath,
    STAGEPASS_SQLITE_BUSY_TIMEOUT_MS: "0",
    STAGEPASS_TERMINAL_INPUT: JSON.stringify(input),
    STAGEPASS_TERMINAL_OUTPUT: output,
  });
  return JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
}

function businessSnapshot(dbPath: string, changeId: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = ["provider_run_processes", "pipeline_jobs", "runs", "stage_runs", "changes", "events"];
    return Object.fromEntries(tables.map((table) => [table,
      db.prepare(`SELECT * FROM ${table} WHERE ${table === "changes" ? "id" : "change_id"}=? ORDER BY id`).all(changeId)]));
  } finally {
    db.close();
  }
}

function seedTerminalExecution(dbPath: string, changeId: string, suffix: string): Record<string, string | number> {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const context = { jobId: `JOB-TERMINAL-${suffix}`, workerId: `worker-terminal-${suffix}`, leaseToken: `lease-terminal-${suffix}`, attemptNo: 1 };
  const runId = `RUN-TERMINAL-${suffix}`;
  try {
    db.prepare("INSERT INTO pipeline_jobs (id,change_id,phase,action_id,status,leased_by,lease_expires_at,heartbeat_at,attempt_no,created_at,started_at,lease_token,worker_nonce) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(context.jobId, changeId, "tech_spec", "run_tech_spec", "running", context.workerId,
        new Date(Date.now() + 60_000).toISOString(), now, 1, now, now, context.leaseToken, context.workerId);
    db.prepare("INSERT INTO runs (id,change_id,phase,status,started_at,job_id,worker_id,lease_token,attempt_no) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(runId, changeId, "tech_spec", "running", now, context.jobId, context.workerId, context.leaseToken, 1);
    db.prepare("INSERT INTO stage_runs (id,change_id,phase,attempt_no,status,started_at) VALUES (?,?,?,?,?,?)")
      .run(`STG-TERMINAL-${suffix}`, changeId, "TechSpec", 1, "running", now);
  } finally {
    db.close();
  }
  return { ...context, changeId, runId };
}

async function waitForProcessClose(record: RegisteredProcess, timeoutMs: number): Promise<boolean> {
  if (!alive(record.identity.pid) && (record.outcome?.settled() || record.closed || record.child.exitCode !== null || record.child.signalCode !== null)) return true;
  if (!record.outcome) return false;
  const completed = await Promise.race([
    record.outcome.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  record.closed = record.outcome.settled();
  return completed && !alive(record.identity.pid);
}

export async function terminateValidatedProcess(record: RegisteredProcess, timeoutMs = 1_000): Promise<void> {
  if (!alive(record.identity.pid)) return;
  const send = async (signal: NodeJS.Signals) => {
    const validation = await processIdentityProbe.validate(record.identity);
    if (!validation.ok) throw new Error(`cleanup_identity_rejected:${validation.reason}`);
    assert.equal(record.identity.pgid, record.identity.pid);
    process.kill(-record.identity.pgid, signal);
  };
  await send("SIGTERM");
  if (await waitForProcessClose(record, timeoutMs)) return;
  await send("SIGKILL");
  if (!await waitForProcessClose(record, timeoutMs)) {
    throw new Error(`cleanup_process_still_alive:${record.identity.pid}`);
  }
}

async function randomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export class ResourceRegistry {
  readonly processes: RegisteredProcess[] = [];
  readonly timers = new Set<NodeJS.Timeout>();
  readonly databases = new Set<Database.Database>();
  readonly ports = new Set<number>();
  readonly supervisors: HarnessSupervisor[] = [];
  readonly replacementTrackers: Array<() => void> = [];
  readonly finalizers: Array<() => void> = [];
  constructor(readonly root: string, private readonly cleanupTimeoutMs = 8_000) {}

  async spawn(role: "identity-holder" | "provider-runner" | "locker", env: Record<string, string | undefined>): Promise<RegisteredProcess> {
    const child = spawn(process.execPath, ["--import", "tsx", SOURCE_FILE, "--child", role], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env, STAGEPASS_HARNESS_ROLE: role },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outcome = createChildOutcomeDeferred(child);
    assert(child.pid && child.pid > 1, `${role} child did not receive a PID`);
    const identity = await processIdentityProbe.capture(child.pid, {
      ppid: process.pid,
      pgid: child.pid,
      cwd: fs.realpathSync(PROJECT_ROOT),
    });
    const record: RegisteredProcess = { child, identity, stdout: "", stderr: "", outcome, closed: outcome.settled() };
    void outcome.promise.then(() => { record.closed = true; });
    const collect = (field: "stdout" | "stderr", chunk: Buffer | string) => {
      record[field] = `${record[field] ?? ""}${String(chunk)}`.slice(-64 * 1024);
    };
    child.stdout?.on("data", (chunk) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk) => collect("stderr", chunk));
    this.processes.push(record);
    return record;
  }

  async runProbe(args: string[], env: Record<string, string | undefined>, timeoutMs = 10_000): Promise<ProbeResult> {
    const child = spawn(process.execPath, ["--import", "tsx", SOURCE_FILE, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outcome = createChildOutcomeDeferred(child);
    assert(child.pid && child.pid > 1, "probe child did not receive a PID");
    const identity = await processIdentityProbe.capture(child.pid, {
      ppid: process.pid,
      pgid: child.pid,
      cwd: fs.realpathSync(PROJECT_ROOT),
    });
    const record: RegisteredProcess = { child, identity, stdout: "", stderr: "", outcome, closed: outcome.settled() };
    void outcome.promise.then(() => { record.closed = true; });
    this.processes.push(record);
    const maxBytes = 64 * 1024;
    let outputBytes = 0;
    let violation: Error | null = null;
    let terminating: Promise<void> | null = null;
    const terminate = (error: Error) => {
      violation ??= error;
      terminating ??= terminateValidatedProcess(record, Math.max(100, Math.min(timeoutMs, 1_000)));
    };
    const collect = (field: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text);
      record[field] = `${record[field] ?? ""}${text}`.slice(-maxBytes);
      if (outputBytes > maxBytes) {
        terminate(new Error("probe_output_limit"));
      }
    };
    child.stdout?.on("data", (chunk) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk) => collect("stderr", chunk));
    const timer = setTimeout(() => terminate(new Error("probe_timeout")), timeoutMs);
    this.timers.add(timer);
    try {
      const completed = await outcome.promise;
      if (terminating) await terminating;
      if (violation) throw violation;
      if (completed.error) throw completed.error;
      if (completed.code !== 0) throw new Error(`probe_exit:${completed.code}:${record.stderr?.slice(-1000) ?? ""}`);
      return { stdout: record.stdout ?? "", stderr: record.stderr ?? "" };
    } finally {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
  }

  addDb(db: Database.Database): Database.Database {
    this.databases.add(db);
    return db;
  }

  addTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
    this.timers.add(timer);
    return timer;
  }

  addPort(port: number): number {
    this.ports.add(port);
    return port;
  }

  addSupervisor(supervisor: HarnessSupervisor): HarnessSupervisor {
    this.supervisors.push(supervisor);
    return supervisor;
  }

  addReplacementTracker(tracker: () => void): void {
    this.replacementTrackers.push(tracker);
  }

  addFinalizer(finalizer: () => void): void {
    this.finalizers.push(finalizer);
  }

  async cleanup(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    const cleanupErrors: Error[] = [];
    let safeToDeleteRoot = true;
    for (const tracker of this.replacementTrackers) {
      try { tracker(); } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    }
    for (const supervisor of [...this.supervisors].reverse()) {
      try {
        await supervisor.stop("SIGTERM");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    for (const record of [...this.processes].reverse()) {
      try {
        await terminateValidatedProcess(record, this.cleanupTimeoutMs);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      await waitFor(() => this.processes.every((record) => !alive(record.identity.pid)), this.cleanupTimeoutMs);
      for (const record of this.processes) assert.equal(alive(record.identity.pid), false);
    } catch (error) {
      safeToDeleteRoot = false;
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    for (const db of this.databases) {
      try {
        if (db.open) db.close();
        assert.equal(db.open, false);
      } catch (error) {
        safeToDeleteRoot = false;
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    for (const finalizer of [...this.finalizers].reverse()) {
      try { finalizer(); } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    }
    for (const port of this.ports) {
      try {
        const probe = net.createServer();
        await new Promise<void>((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
        });
      } catch (error) {
        safeToDeleteRoot = false;
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (safeToDeleteRoot) {
      try {
        fs.rmSync(this.root, { recursive: true, force: true });
        assert.equal(fs.existsSync(this.root), false);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "crash acceptance cleanup failed");
  }
}

function seedFixture(dbPath: string, changeId: string, runId: string): void {
  const repoPath = path.join(path.dirname(dbPath), "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
  execFileSync("git", ["-c", "user.name=stagepass", "-c", "user.email=stagepass@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: repoPath });
  const db = new Database(dbPath);
  try {
    runMigrations(db);
    const now = new Date(Date.now() - 60_000).toISOString();
    db.prepare("INSERT INTO projects (id,name,repo_path,context_status,context_provider,prd_status,prd_provider,git_enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("PRJ-ACCEPTANCE", "Crash acceptance", repoPath, "ready", "claude", "ready", "claude", 1, now, now);
    db.prepare("INSERT INTO changes (id,project_id,title,status,provider,fix_iterations,suspended_by_prd,docs_complete,retro_done,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(changeId, "PRJ-ACCEPTANCE", "Crash fixture", "SPECCING", "claude", 0, 0, 0, 0, now, now);
    db.prepare("INSERT INTO runs (id,change_id,phase,status,started_at) VALUES (?,?,?,?,?)")
      .run(runId, changeId, "spec", "running", now);
    db.prepare("INSERT INTO events (id,change_id,run_id,type,message,created_at) VALUES (?,?,?,?,?,?)")
      .run(`EVT-${randomUUID()}`, changeId, runId, "acceptance_started", "fixture", now);
  } finally {
    db.close();
  }
}

async function queryActions(registry: ResourceRegistry, dbPath: string, changeId: string, output: string): Promise<Array<{ actionId?: string; enabled?: boolean }>> {
  await registry.runProbe(["--child", "action-probe"], {
    STAGEPASS_DB_PATH: dbPath, STAGEPASS_ACTION_CHANGE: changeId, STAGEPASS_ACTION_OUTPUT: output,
  });
  return JSON.parse(fs.readFileSync(output, "utf8")) as Array<{ actionId?: string; enabled?: boolean }>;
}

async function assertHttp(registry: ResourceRegistry, dbPath: string, port: number, assertions: string[], changeId = "CHG-delete-logs", evidence?: AcceptanceEvidence[]): Promise<void> {
  const base = `/api/projects/PRJ-ACCEPTANCE/changes/${encodeURIComponent(changeId)}`;
  const fetchBounded = (pathname: string) => fetch(`http://127.0.0.1:${port}${base}${pathname}`, {
    signal: AbortSignal.timeout(3_000),
  });
  const detail = await fetchBounded("");
  assert.equal(detail.status, 200);
  const detailJson = await detail.json() as { id?: string; latestRun?: { id?: string; attemptNo?: number; summary?: string } | null };
  assert.ok(detailJson.id);
  assertions.push("GET detail=200");

  const events = await fetchBounded("/events");
  assert.equal(events.status, 200);
  const eventJson = await events.json() as unknown[];
  assert.ok(Array.isArray(eventJson));
  assertions.push("GET events=200");

  const stream = await fetchBounded("/events/stream");
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  let sseTimer: NodeJS.Timeout | null = null;
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      sseTimer = setTimeout(() => reject(new Error("sse_read_timeout")), 3_000);
    }),
  ]).finally(() => {
    if (sseTimer) clearTimeout(sseTimer);
  });
  const sseText = new TextDecoder().decode(first.value);
  await reader.cancel();
  assert.match(sseText, /^data:/);
  const firstFrame = sseText.split("\n\n", 1)[0];
  const ssePayload = JSON.parse(firstFrame.slice(5).trim()) as { changeId?: string; message?: string };
  assertions.push("SSE initial event observed");

  const actionJson = await queryActions(registry, dbPath, changeId, path.join(path.dirname(dbPath), `actions-${changeId}.json`));
  assert.ok(Array.isArray(actionJson));
  assertions.push("action contract observed");
  if (evidence) {
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      const prior = evidence[index];
      if (prior.kind === "http" && prior.changeId === changeId) evidence.splice(index, 1);
    }
  }
  evidence?.push({
    kind: "http",
    changeId,
    detailStatus: detail.status,
    runId: detailJson.latestRun?.id ?? null,
    attemptNo: detailJson.latestRun?.attemptNo ?? null,
    reason: ssePayload.message ?? detailJson.latestRun?.summary ?? null,
    eventCount: eventJson.length,
    sseChangeId: ssePayload.changeId ?? null,
    enabledActions: actionJson.filter((action) => action.enabled).map((action) => action.actionId),
  });
}

interface MatrixRow {
  changeId: string;
  runId: string;
  eventType: string;
  expected: {
    provider: "completed" | "orphaned" | "stopped";
    job: "failed";
    run: "failed";
    stage: "failed";
    change: "SPEC_READY" | "PLAN_APPROVED";
    retryAction: "retry_tech_spec" | "retry_build";
  };
}

function seedRecoveryMatrix(dbPath: string, identities: ProcessIdentity[]): MatrixRow[] {
  const rows = [
    { key: "no-start", phase: "tech_spec", provider: "missing", eventType: "provider_start_missing", providerAfter: "orphaned", changeAfter: "SPEC_READY", retryAction: "retry_tech_spec" },
    { key: "terminal", phase: "tech_spec", provider: "completed", eventType: "business_run_reconciled", providerAfter: "completed", changeAfter: "SPEC_READY", retryAction: "retry_tech_spec" },
    { key: "legacy", phase: "implement", provider: "missing", eventType: "legacy_lifecycle_missing", providerAfter: "orphaned", changeAfter: "PLAN_APPROVED", retryAction: "retry_build" },
    { key: "pid-missing", phase: "tech_spec", provider: "pid_missing", eventType: "provider_process_orphaned", providerAfter: "orphaned", changeAfter: "SPEC_READY", retryAction: "retry_tech_spec" },
    { key: "identity", phase: "tech_spec", provider: "identity", eventType: "provider_identity_mismatch", providerAfter: "orphaned", changeAfter: "SPEC_READY", retryAction: "retry_tech_spec" },
    { key: "ppid-dead", phase: "tech_spec", provider: "ppid_dead", eventType: "provider_parent_missing", providerAfter: "orphaned", changeAfter: "SPEC_READY", retryAction: "retry_tech_spec" },
    { key: "ppid-mismatch", phase: "tech_spec", provider: "ppid_mismatch", eventType: "provider_parent_mismatch", providerAfter: "orphaned", changeAfter: "SPEC_READY", retryAction: "retry_tech_spec" },
    { key: "heartbeat", phase: "tech_spec", provider: "heartbeat", eventType: "provider_heartbeat_stale", providerAfter: "orphaned", changeAfter: "SPEC_READY", retryAction: "retry_tech_spec" },
    { key: "lease", phase: "tech_spec", provider: "lease", eventType: "stale_lease_fenced", providerAfter: "stopped", changeAfter: "SPEC_READY", retryAction: "retry_tech_spec" },
  ] as const;
  const db = new Database(dbPath);
  const old = new Date(Date.now() - 120_000).toISOString();
  const future = new Date(Date.now() + 120_000).toISOString();
  try {
    db.exec("DELETE FROM provider_run_processes; DELETE FROM stage_runs; DELETE FROM pipeline_jobs;");
    return rows.map((row, index) => {
      const changeId = `CHG-MATRIX-${index + 1}`;
      const runId = `RUN-MATRIX-${index + 1}`;
      const jobId = `JOB-MATRIX-${index + 1}`;
      const terminalJob = row.provider === "lease";
      db.prepare("INSERT INTO changes (id,project_id,title,status,provider,fix_iterations,suspended_by_prd,docs_complete,retro_done,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(changeId, "PRJ-ACCEPTANCE", row.key, row.phase === "implement" ? "IMPLEMENTING" : "TECHSPECCING", "claude", 0, 0, 0, 0, old, old);
      db.prepare("INSERT INTO pipeline_jobs (id,change_id,phase,action_id,status,leased_by,lease_expires_at,heartbeat_at,attempt_no,created_at,started_at,ended_at,lease_token,worker_nonce) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(jobId, changeId, row.phase, row.phase === "implement" ? "run_build" : "run_tech_spec",
          terminalJob ? "failed" : "running", "worker-matrix", terminalJob ? null : future, old, 1, old, old,
          terminalJob ? old : null, `lease-${index}`, `nonce-${index}`);
      db.prepare("INSERT INTO runs (id,change_id,phase,status,started_at,job_id,worker_id,lease_token,attempt_no) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(runId, changeId, row.phase, "running", old, jobId, "worker-matrix", `lease-${index}`, 1);
      db.prepare("INSERT INTO stage_runs (id,change_id,phase,attempt_no,status,started_at) VALUES (?,?,?,?,?,?)")
        .run(`STG-MATRIX-${index + 1}`, changeId, row.phase === "implement" ? "Build" : "TechSpec", 1, "running", old);
      if (row.phase === "implement") {
        db.prepare("INSERT INTO stage_gates (id,change_id,phase,status,blockers_json,freshness_json,required_actions_json,source_db_hash,gate_version,computed_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(`GATE-MATRIX-${index + 1}`, changeId, "TestPlan", "passed", "[]", JSON.stringify({ fresh: true }), "[]", "testplan-source-hash", 1, old);
      }
      if (row.provider !== "missing") {
        const identity = identities[Math.max(0, index - 4)] ?? identities[0];
        const pid = row.provider === "pid_missing" ? 999_991 : identity.pid;
        const ppid = row.provider === "ppid_dead" ? 999_992 : row.provider === "ppid_mismatch" ? identities.at(-1)!.pid : identity.ppid;
        const command = row.provider === "identity" ? ["definitely-not-the-observed-command"] : identity.command;
        db.prepare(`INSERT INTO provider_run_processes
          (id,change_id,run_id,phase,provider,pid,ppid,status,started_at,last_heartbeat_at,job_id,worker_id,lease_token,attempt_no,process_nonce,process_start_time,process_ppid,process_pgid,process_cwd,process_command_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(`PRP-MATRIX-${index + 1}`, changeId, runId, row.phase, "claude", pid, identity.ppid ?? process.pid,
            row.provider === "completed" ? "completed" : "running", old, row.provider === "heartbeat" ? old : future,
            jobId, "worker-matrix", `lease-${index}`, 1, identity.nonce, identity.processStartTime, ppid,
            identity.pgid, identity.cwd, JSON.stringify(command));
      }
      return {
        changeId, runId, eventType: row.eventType,
        expected: {
          provider: row.providerAfter, job: "failed", run: "failed", stage: "failed",
          change: row.changeAfter, retryAction: row.retryAction,
        },
      };
    });
  } finally {
    db.close();
  }
}

async function assertRecoveryMatrix(registry: ResourceRegistry, dbPath: string, port: number, rows: MatrixRow[], assertions: string[], evidence: AcceptanceEvidence[]): Promise<void> {
  for (const row of rows) await assertHttp(registry, dbPath, port, assertions, row.changeId, evidence);
  const db = new Database(dbPath, { readonly: true });
  try {
    for (const row of rows) {
      const provider = db.prepare("SELECT status FROM provider_run_processes WHERE run_id=?").get(row.runId) as { status: string } | undefined;
      const job = db.prepare("SELECT status FROM pipeline_jobs WHERE change_id=?").get(row.changeId) as { status: string };
      const run = db.prepare("SELECT status FROM runs WHERE id=?").get(row.runId) as { status: string };
      const stage = db.prepare("SELECT status FROM stage_runs WHERE change_id=?").get(row.changeId) as { status: string };
      const change = db.prepare("SELECT status FROM changes WHERE id=?").get(row.changeId) as { status: string };
      const eventCount = (db.prepare("SELECT count(*) count FROM events WHERE change_id=? AND type=?").get(row.changeId, row.eventType) as { count: number }).count;
      const actions = await queryActions(registry, dbPath, row.changeId, path.join(path.dirname(dbPath), `matrix-actions-${row.changeId}.json`));
      const snapshot = {
        provider: provider?.status,
        job: job.status,
        run: run.status,
        stage: stage.status,
        change: change.status,
        eventType: row.eventType,
        eventCount,
        retryAction: row.expected.retryAction,
        retryEnabled: actions.find((action) => action.actionId === row.expected.retryAction)?.enabled ?? false,
      };
      assert.deepEqual(snapshot, { ...row.expected, eventType: row.eventType, eventCount: 1, retryEnabled: true });
      evidence.push({ kind: "recovery-row", changeId: row.changeId, runId: row.runId,
        provider: provider?.status ?? "synthetic_missing", job: job.status, run: run.status,
        stage: stage.status, change: change.status, eventType: row.eventType, eventCount });
    }
  } finally {
    db.close();
  }
  for (const row of rows) await assertHttp(registry, dbPath, port, assertions, row.changeId, evidence);
  const verify = new Database(dbPath, { readonly: true });
  try {
    for (const row of rows) {
      const count = (verify.prepare("SELECT count(*) count FROM events WHERE change_id=? AND type=?").get(row.changeId, row.eventType) as { count: number }).count;
      assert.equal(count, 1, `${row.changeId}:event must be exactly once`);
    }
  } finally {
    verify.close();
  }
  assertions.push("Task11 eight-row matrix reconciled with split parent cases and exactly-once events");
}

function validateEvidence(dbPath: string, evidence: AcceptanceEvidence[]): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    for (const item of evidence) {
      if (item.kind !== "http") continue;
      const change = db.prepare("SELECT id FROM changes WHERE id=?").get(item.changeId) as { id: string } | undefined;
      assert.equal(change?.id, item.changeId);
      if (item.sseChangeId !== null) assert.equal(item.sseChangeId, item.changeId);
      if (item.runId !== null) {
        const run = db.prepare("SELECT id,attempt_no attemptNo FROM runs WHERE id=? AND change_id=?").get(item.runId, item.changeId) as { id: string; attemptNo: number | null } | undefined;
        assert.deepEqual(run, { id: item.runId, attemptNo: item.attemptNo });
      }
      assert.ok(item.eventCount >= 1);
      assert.ok(item.reason !== null);
    }
  } finally {
    db.close();
  }
}

// Cases whose assertions depend on the worker recovery sweep reconciling a
// business run after a provider/process failure. Only these accelerate the
// sweep; others (e.g. sqlite-lock) rely on the default cadence so recovery does
// not fence an in-flight lease mid-test.
const FAST_RECOVERY_SWEEP_CASES = new Set<CrashAcceptanceCase>([
  "kill-provider",
  "restart-recovery",
]);

async function startFixtureProcesses(
  registry: ResourceRegistry,
  dbPath: string,
  logDir: string,
  port: number,
  changeId: string,
  runId: string,
  caseName: CrashAcceptanceCase,
): Promise<{ app: RegisteredProcess; worker: RegisteredProcess; supervisor: HarnessSupervisor }> {
  const tsconfigPath = path.join(PROJECT_ROOT, "tsconfig.json");
  registry.addFinalizer(() => {
    const parsed = JSON.parse(fs.readFileSync(tsconfigPath, "utf8")) as { include?: string[] };
    const filtered = parsed.include?.filter((entry) => !path.resolve(entry).startsWith(path.resolve(registry.root))) ?? [];
    if (filtered.length !== (parsed.include?.length ?? 0)) {
      parsed.include = filtered;
      fs.writeFileSync(tsconfigPath, `${JSON.stringify(parsed, null, 2)}\n`);
    }
  });
  const common = {
    STAGEPASS_DB_PATH: dbPath,
    STAGEPASS_LOG_DIR: logDir,
    STAGEPASS_FIXTURE_CHANGE: changeId,
    STAGEPASS_FIXTURE_RUN: runId,
    STAGEPASS_NEXT_DIST_DIR: path.join(registry.root, ".next"),
  };
  let appChild: ChildProcess | null = null;
  let workerChild: ChildProcess | null = null;
  let appOutcome: ChildOutcomeDeferred | null = null;
  let workerOutcome: ChildOutcomeDeferred | null = null;
  let appStderr = "";
  const healthFile = path.join(logDir, "supervisor-health.json");
  const heartbeatFile = path.join(logDir, "pipeline-worker-heartbeat.json");
  const { createSupervisor } = requireRuntime("../../scripts/dev-supervisor.ts") as {
    createSupervisor(options: Record<string, unknown>): HarnessSupervisor;
  };
  const supervisor = registry.addSupervisor(createSupervisor({
    cwd: PROJECT_ROOT,
    logDir,
    healthFilePath: healthFile,
    workerHeartbeatFilePath: heartbeatFile,
    superviseWorker: true,
    childFactory: () => {
      appChild = spawn(process.execPath, [path.join(PROJECT_ROOT, "node_modules/next/dist/bin/next"), "dev", "-p", String(port), "-H", "127.0.0.1"], {
        cwd: PROJECT_ROOT, env: { ...process.env, ...common, STAGEPASS_FIXTURE_PORT: String(port) },
        detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      appOutcome = createChildOutcomeDeferred(appChild);
      appChild.stderr?.on("data", (chunk) => {
        appStderr = `${appStderr}${String(chunk)}`.slice(-8 * 1024);
      });
      return appChild;
    },
    workerChildFactory: (identity: { workerId: string; instanceNonce: string }) => {
      const workerBarrier = path.join(registry.root, "worker-runner.barrier");
      workerChild = spawn(process.execPath, ["--import", "tsx", path.join(PROJECT_ROOT, "scripts/pipeline-worker.ts")], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env, ...common,
          PIPELINE_WORKER_HEARTBEAT_FILE: heartbeatFile,
          PIPELINE_WORKER_ID: identity.workerId,
          PIPELINE_WORKER_INSTANCE_NONCE: identity.instanceNonce,
          PIPELINE_WORKER_PROCESS_HEARTBEAT_MS: "100",
          PIPELINE_WORKER_POLL_MS: "100",
          PIPELINE_WORKER_JOB_HEARTBEAT_MS: "100",
          // Reads no longer trigger recovery; business reconciliation is owned by
          // the worker sweep. Cases that assert reconciliation sweep fast enough
          // to observe it; others keep the default cadence so recovery does not
          // fence an in-flight lease mid-test.
          ...(FAST_RECOVERY_SWEEP_CASES.has(caseName)
            ? { PIPELINE_WORKER_RECOVERY_SWEEP_MS: "500" }
            : {}),
          PIPELINE_WORKER_STDOUT_ONLY: "1",
          STAGEPASS_ACCEPTANCE_MODE: "1",
          STAGEPASS_ACCEPTANCE_ROOT: registry.root,
          STAGEPASS_WORKER_BARRIER: workerBarrier,
        },
        detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      workerOutcome = createChildOutcomeDeferred(workerChild);
      return workerChild;
    },
    healthCheck: async () => fetch(`http://127.0.0.1:${port}/api/projects/PRJ-ACCEPTANCE/changes/${encodeURIComponent(changeId)}`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok).catch(() => false),
    healthPollIntervalMs: 50,
    healthTimeoutMs: 10_000,
    workerMonitorIntervalMs: 100,
    workerStaleAfterMs: 2_000,
    terminationGraceMs: 5_000,
  }));
  await supervisor.start();
  await waitFor(() => Boolean(readSupervisorHealth(healthFile)?.next.record && readSupervisorHealth(healthFile)?.worker.record));
  await waitFor(async () => fetch(
    `http://127.0.0.1:${port}/api/projects/PRJ-ACCEPTANCE/changes/${encodeURIComponent(changeId)}`,
    { signal: AbortSignal.timeout(500) },
  ).then((response) => response.ok).catch(() => false), 10_000).catch((error) => {
    throw new Error(`fixture_app_not_ready:${appStderr}:${String(error)}`);
  });
  const health = readSupervisorHealth(healthFile)!;
  assert(appChild && workerChild && health.next.record && health.worker.record);
  assert(appOutcome && workerOutcome);
  const app = { child: appChild, identity: health.next.record.identity, outcome: appOutcome };
  const worker = { child: workerChild, identity: health.worker.record.identity, outcome: workerOutcome };
  registry.processes.push(app, worker);
  registry.addReplacementTracker(() => {
    const current = readSupervisorHealth(healthFile);
    const candidates = [
      current?.next.record && appChild && appOutcome ? { child: appChild, identity: current.next.record.identity, outcome: appOutcome } : null,
      current?.worker.record && workerChild && workerOutcome ? { child: workerChild, identity: current.worker.record.identity, outcome: workerOutcome } : null,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (!registry.processes.some((record) => record.identity.nonce === candidate.identity.nonce)) {
        registry.processes.push(candidate);
      }
    }
  });
  return { app, worker, supervisor };
}

function seedProviderExecution(dbPath: string, input: {
  changeId: string; runId: string; jobId: string; workerId: string; leaseToken: string;
}): void {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  try {
    if (input.changeId !== (db.prepare("SELECT id FROM changes LIMIT 1").get() as { id: string }).id) {
      db.prepare("INSERT INTO changes (id,project_id,title,status,provider,fix_iterations,suspended_by_prd,docs_complete,retro_done,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(input.changeId, "PRJ-ACCEPTANCE", input.changeId, "TECHSPECCING", "claude", 0, 0, 0, 0, now, now);
    } else {
      db.prepare("UPDATE changes SET status='TECHSPECCING' WHERE id=?").run(input.changeId);
    }
    db.prepare("INSERT INTO pipeline_jobs (id,change_id,phase,action_id,status,leased_by,lease_expires_at,heartbeat_at,attempt_no,created_at,started_at,lease_token,worker_nonce) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(input.jobId, input.changeId, "tech_spec", "run_tech_spec", "running", input.workerId,
        new Date(Date.now() + 120_000).toISOString(), now, 1, now, now, input.leaseToken, input.workerId);
    const existingRun = db.prepare("SELECT id FROM runs WHERE id=?").get(input.runId);
    if (existingRun) {
      db.prepare("UPDATE runs SET phase='tech_spec',status='running',started_at=?,ended_at=NULL,job_id=?,worker_id=?,lease_token=?,attempt_no=1 WHERE id=?")
        .run(now, input.jobId, input.workerId, input.leaseToken, input.runId);
    } else {
      db.prepare("INSERT INTO runs (id,change_id,phase,status,started_at,job_id,worker_id,lease_token,attempt_no) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(input.runId, input.changeId, "tech_spec", "running", now, input.jobId, input.workerId, input.leaseToken, 1);
    }
    db.prepare("INSERT INTO stage_runs (id,change_id,phase,attempt_no,status,started_at) VALUES (?,?,?,?,?,?)")
      .run(`STG-${input.runId}`, input.changeId, "TechSpec", 1, "running", now);
  } finally {
    db.close();
  }
}

export async function runHungProviderTimeoutProbe(timeoutMs = 200): Promise<{
  providerStatus: string;
  jobStatus: string;
  processExited: boolean;
  rootRemoved: boolean;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-provider-timeout-"));
  const dbPath = path.join(root, "probe.db");
  const logDir = path.join(root, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const sqlite = new Database(dbPath);
  runMigrations(sqlite);
  sqlite.close();
  const execution = {
    changeId: "CHG-HUNG-PROVIDER",
    runId: "RUN-HUNG-PROVIDER",
    jobId: "JOB-HUNG-PROVIDER",
    workerId: "worker-hung-provider",
    leaseToken: "lease-hung-provider",
  };
  seedFixture(dbPath, execution.changeId, execution.runId);
  seedProviderExecution(dbPath, execution);
  const transportBin = path.join(root, "hung-claude-transport");
  fs.writeFileSync(transportBin, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
  const registry = new ResourceRegistry(root, 2_000);
  let processExited = false;
  let providerStatus = "missing";
  let jobStatus = "missing";
  try {
    const runner = await registry.spawn("provider-runner", {
      STAGEPASS_DB_PATH: dbPath,
      STAGEPASS_LOG_DIR: logDir,
      STAGEPASS_ACCEPTANCE_MODE: "1",
      STAGEPASS_ACCEPTANCE_ROOT: root,
      STAGEPASS_CLAUDE_TRANSPORT_BIN: transportBin,
      STAGEPASS_ACCEPTANCE_PROVIDER_TIMEOUT_MS: String(timeoutMs),
      STAGEPASS_PROVIDER_EXECUTION: JSON.stringify(execution),
    });
    const outcome = runner.outcome?.promise;
    assert.ok(outcome);
    await Promise.race([
      outcome,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hung_provider_timeout_probe_deadline")), 8_000)),
    ]);
    processExited = !alive(runner.identity.pid);
    const probeDb = new Database(dbPath, { readonly: true });
    providerStatus = String((probeDb.prepare("SELECT status FROM provider_run_processes WHERE run_id=? ORDER BY started_at DESC LIMIT 1")
      .get(execution.runId) as { status: string }).status);
    jobStatus = String((probeDb.prepare("SELECT status FROM pipeline_jobs WHERE id=?")
      .get(execution.jobId) as { status: string }).status);
    probeDb.close();
  } finally {
    await registry.cleanup();
  }
  return { providerStatus, jobStatus, processExited, rootRemoved: !fs.existsSync(root) };
}

interface SelectedProviderTarget { processId: string; identity: ProcessIdentity }

async function selectProviderTarget(dbPath: string, changeId: string, runId: string): Promise<SelectedProviderTarget> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT * FROM provider_run_processes WHERE change_id=? AND run_id=? AND status='running'").all(changeId, runId) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1, "provider selector must match exactly one running row");
    const row = rows[0];
    const identity: ProcessIdentity = {
      pid: Number(row.pid), ppid: Number(row.process_ppid), pgid: Number(row.process_pgid),
      nonce: String(row.process_nonce), processStartTime: String(row.process_start_time),
      cwd: String(row.process_cwd), command: JSON.parse(String(row.process_command_json)) as string[],
    };
    const validation = await processIdentityProbe.validate(identity);
    if (!validation.ok) throw new Error(`provider_selector_identity_rejected:${validation.reason}`);
    return { processId: String(row.id), identity };
  } finally {
    db.close();
  }
}

export async function runCrashAcceptance(options: CrashAcceptanceOptions): Promise<CrashAcceptanceResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `stagepass-${options.caseName}-`));
  const registry = new ResourceRegistry(root);
  const dbPath = path.join(root, "fixture.db");
  const logDir = path.join(root, "logs");
  const changeId = options.changeId ?? `CHG-${options.caseName.toUpperCase()}`;
  const runId = options.runId ?? `RUN-${options.caseName.toUpperCase()}`;
  const assertions: string[] = [];
  const evidence: AcceptanceEvidence[] = [];
  const realBefore = REAL_DB_FILES.map((file) => ({ file, ...checksum(file) }));
  assert.notEqual(path.resolve(dbPath), REAL_DB_PATH);
  seedFixture(dbPath, changeId, runId);
  assertions.push("temporary DB isolated from ship.db");

  try {
    const port = registry.addPort(await randomPort());
    const { app, worker } = await startFixtureProcesses(registry, dbPath, logDir, port, changeId, runId, options.caseName);
    const healthFile = path.join(logDir, "supervisor-health.json");
    await assertHttp(registry, dbPath, port, assertions, changeId, evidence);

    if (options.caseName === "delete-logs") {
      fs.rmSync(logDir, { recursive: true, force: true });
      await signalValidated(app.identity, "SIGKILL");
      await signalValidated(worker.identity, "SIGKILL");
      await waitFor(() => ["dev-server.log", "pipeline-worker.log", "dev-supervisor.log"]
        .every((name) => fs.existsSync(path.join(logDir, name))));
      await waitFor(() => {
        const health = readSupervisorHealth(healthFile);
        return Boolean(health?.next.record && health.next.record.identity.pid !== app.identity.pid
          && health.next.portListening && health.worker.record
          && health.worker.record.identity.pid !== worker.identity.pid);
      });
      await waitFor(async () => fetch(`http://127.0.0.1:${port}/api/projects/PRJ-ACCEPTANCE/changes/${encodeURIComponent(changeId)}`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok).catch(() => false));
      await assertHttp(registry, dbPath, port, assertions, changeId, evidence);
      assertions.push("three log files recreated");
    } else if (options.caseName === "sqlite-lock") {
      const shortExecution = seedTerminalExecution(dbPath, changeId, "SHORT");
      const shortOutput = path.join(root, "terminal-short.json");
      await runTerminalProbe(registry, dbPath, { action: "start", ...shortExecution }, shortOutput);
      const shortReady = path.join(root, "short-lock.ready");
      await registry.spawn("locker", {
        STAGEPASS_DB_PATH: dbPath,
        STAGEPASS_LOCK_READY: shortReady,
        STAGEPASS_LOCK_HOLD_MS: "150",
      });
      await waitFor(() => fs.existsSync(shortReady));
      assert.deepEqual(await runTerminalProbe(registry, dbPath, { action: "finish", ...shortExecution }, shortOutput), { ok: true });
      assert.deepEqual(await runTerminalProbe(registry, dbPath, { action: "finish", ...shortExecution }, shortOutput), {
        ok: false, code: "stale_lease_fence", label: null, attempts: null, elapsedMs: null, sqliteCode: null,
      });
      const shortDb = new Database(dbPath, { readonly: true });
      const shortSnapshot = {
        provider: (shortDb.prepare("SELECT status FROM provider_run_processes WHERE run_id=?").get(shortExecution.runId) as { status: string }).status,
        job: (shortDb.prepare("SELECT status FROM pipeline_jobs WHERE id=?").get(shortExecution.jobId) as { status: string }).status,
        run: (shortDb.prepare("SELECT status FROM runs WHERE id=?").get(shortExecution.runId) as { status: string }).status,
        events: (shortDb.prepare("SELECT count(*) count FROM events WHERE run_id=? AND type='provider_process_failed'").get(shortExecution.runId) as { count: number }).count,
      };
      shortDb.close();
      assert.deepEqual(shortSnapshot, { provider: "failed", job: "failed", run: "failed", events: 1 });

      const longExecution = seedTerminalExecution(dbPath, changeId, "LONG");
      const longOutput = path.join(root, "terminal-long.json");
      await runTerminalProbe(registry, dbPath, { action: "start", ...longExecution }, longOutput);
      const longReady = path.join(root, "long-lock.ready");
      const longLocker = await registry.spawn("locker", {
        STAGEPASS_DB_PATH: dbPath,
        STAGEPASS_LOCK_READY: longReady,
        STAGEPASS_LOCK_HOLD_MS: "3000",
      });
      await waitFor(() => fs.existsSync(longReady));
      const beforeLong = businessSnapshot(dbPath, changeId);
      const longResult = await runTerminalProbe(registry, dbPath, { action: "finish", ...longExecution }, longOutput);
      assert.deepEqual({
        ok: longResult.ok,
        code: longResult.code,
        label: longResult.label,
        attempts: longResult.attempts,
        sqliteCode: longResult.sqliteCode,
        elapsedPositive: Number(longResult.elapsedMs) > 0,
      }, {
        ok: false,
        code: "sqlite_write_busy",
        label: "provider-run.finish",
        attempts: 6,
        sqliteCode: "SQLITE_BUSY",
        elapsedPositive: true,
      });
      assert.deepEqual(businessSnapshot(dbPath, changeId), beforeLong);
      await waitFor(() => !alive(longLocker.identity.pid));
      assertions.push("short lock wrote business terminal exactly once; long lock typed metadata and zero drift");
      await assertHttp(registry, dbPath, port, assertions, changeId, evidence);
    } else if (options.caseName === "kill-worker") {
      const workerBarrier = path.join(root, "worker-runner.barrier");
      fs.writeFileSync(workerBarrier, "hold");
      const leaseDb = new Database(dbPath);
      const queuedAt = new Date().toISOString();
      leaseDb.prepare("INSERT INTO pipeline_jobs (id,change_id,phase,action_id,status,attempt_no,created_at) VALUES (?,?,?,?,?,?,?)")
        .run("JOB-WORKER-TAKEOVER", changeId, "tech_spec", "run_tech_spec", "queued", 1, queuedAt);
      leaseDb.close();
      await waitFor(() => {
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare("SELECT status FROM pipeline_jobs WHERE id='JOB-WORKER-TAKEOVER'").get() as { status: string };
        db.close();
        return row.status === "running";
      });
      const contextDb = new Database(dbPath, { readonly: true });
      const oldContext = contextDb.prepare("SELECT id jobId, leased_by workerId, lease_token leaseToken, attempt_no attemptNo FROM pipeline_jobs WHERE id='JOB-WORKER-TAKEOVER'").get() as Record<string, string | number>;
      contextDb.close();
      await waitFor(() => {
        if (!fs.existsSync(`${workerBarrier}.started`)) return false;
        const started = JSON.parse(fs.readFileSync(`${workerBarrier}.started`, "utf8")) as { attemptNo: number };
        return started.attemptNo === Number(oldContext.attemptNo);
      });
      const heartbeatDb = new Database(dbPath, { readonly: true });
      const oldHeartbeat = (heartbeatDb.prepare("SELECT heartbeat_at heartbeatAt FROM pipeline_jobs WHERE id='JOB-WORKER-TAKEOVER'").get() as { heartbeatAt: string }).heartbeatAt;
      heartbeatDb.close();
      assert.ok(oldHeartbeat);
      const before = worker.identity;
      await signalValidated(before, "SIGKILL");
      await waitFor(() => !alive(before.pid));
      const expireDb = new Database(dbPath);
      expireDb.prepare("UPDATE pipeline_jobs SET lease_expires_at=? WHERE id='JOB-WORKER-TAKEOVER'").run(new Date(Date.now() - 1_000).toISOString());
      expireDb.close();
      await waitFor(() => {
        const record = readSupervisorHealth(healthFile)?.worker.record;
        return Boolean(record && record.identity.pid !== before.pid && alive(record.identity.pid));
      });
      const replacement = readSupervisorHealth(healthFile)!.worker.record!;
      assert.notEqual(replacement.identity.nonce, before.nonce);
      await waitFor(() => {
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare("SELECT attempt_no attemptNo, leased_by workerId FROM pipeline_jobs WHERE id='JOB-WORKER-TAKEOVER'").get() as { attemptNo: number; workerId: string };
        db.close();
        return row.attemptNo > Number(oldContext.attemptNo) && row.workerId !== oldContext.workerId;
      });
      await waitFor(() => {
        if (!fs.existsSync(`${workerBarrier}.started`)) return false;
        const started = JSON.parse(fs.readFileSync(`${workerBarrier}.started`, "utf8")) as { attemptNo: number; workerId: string };
        return started.attemptNo > Number(oldContext.attemptNo) && started.workerId !== oldContext.workerId;
      });
      const fenceCodes = await runFenceProbe(registry, dbPath, oldContext, path.join(root, "fence-probe.json"));
      assert.deepEqual(fenceCodes, ["stale_lease_fence", "stale_lease_fence", "stale_lease_fence", "stale_lease_fence"]);
      fs.rmSync(workerBarrier, { force: true });
      await waitFor(() => {
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare("SELECT status FROM pipeline_jobs WHERE id='JOB-WORKER-TAKEOVER'").get() as { status: string };
        db.close();
        return row.status === "succeeded";
      });
      await assertHttp(registry, dbPath, port, assertions, changeId, evidence);
      assertions.push("production worker lease taken over; old heartbeat/complete/fail/execution context fenced");
    } else if (options.caseName === "kill-next") {
      const workerBefore = worker.identity;
      await signalValidated(app.identity, "SIGKILL");
      await waitFor(() => !alive(app.identity.pid));
      await waitFor(() => {
        const record = readSupervisorHealth(healthFile)?.next.record;
        return Boolean(record && record.identity.pid !== app.identity.pid && alive(record.identity.pid)
          && readSupervisorHealth(healthFile)?.next.portListening);
      });
      await waitFor(async () => fetch(`http://127.0.0.1:${port}/api/projects/PRJ-ACCEPTANCE/changes/${encodeURIComponent(changeId)}`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok).catch(() => false));
      const replacement = readSupervisorHealth(healthFile)!.next.record!;
      assert.notEqual(replacement.identity.nonce, app.identity.nonce);
      assert.equal((await processIdentityProbe.validate(workerBefore)).ok, true);
      await assertHttp(registry, dbPath, port, assertions, changeId, evidence);
      assertions.push("app identity replaced while worker stayed alive");
    } else if (options.caseName === "kill-provider") {
      if (!options.changeId || !options.runId) throw new Error("kill-provider requires explicit changeId and runId");
      const transportBin = path.join(root, "offline-claude-transport");
      fs.writeFileSync(transportBin, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
      const targetExecution = { changeId, runId, jobId: "JOB-PROVIDER-TARGET", workerId: "provider-runner-target", leaseToken: "lease-provider-target" };
      const nonTargetExecution = { changeId: "CHG-PROVIDER-NON-TARGET", runId: "RUN-PROVIDER-NON-TARGET", jobId: "JOB-PROVIDER-NON-TARGET", workerId: "provider-runner-non-target", leaseToken: "lease-provider-non-target" };
      seedProviderExecution(dbPath, targetExecution);
      seedProviderExecution(dbPath, nonTargetExecution);
      const providerRunnerEnv = {
        STAGEPASS_DB_PATH: dbPath,
        STAGEPASS_LOG_DIR: logDir,
        STAGEPASS_ACCEPTANCE_MODE: "1",
        STAGEPASS_ACCEPTANCE_ROOT: root,
        STAGEPASS_CLAUDE_TRANSPORT_BIN: transportBin,
      };
      await registry.spawn("provider-runner", { ...providerRunnerEnv, STAGEPASS_PROVIDER_EXECUTION: JSON.stringify(targetExecution) });
      await registry.spawn("provider-runner", { ...providerRunnerEnv, STAGEPASS_PROVIDER_EXECUTION: JSON.stringify(nonTargetExecution) });
      await waitFor(() => {
        const db = new Database(dbPath, { readonly: true });
        const count = (db.prepare("SELECT count(*) count FROM provider_run_processes WHERE status='running' AND run_id IN (?,?)").get(runId, nonTargetExecution.runId) as { count: number }).count;
        db.close();
        return count === 2;
      });
      const selected = await selectProviderTarget(dbPath, changeId, runId);
      const nonTarget = await selectProviderTarget(dbPath, nonTargetExecution.changeId, nonTargetExecution.runId);
      if (!options.execute) {
        assert.equal(alive(selected.identity.pid), true);
        assert.equal(alive(nonTarget.identity.pid), true);
        assertions.push("shared selector validated target/non-target; dry-run emitted no signal");
      } else {
        await signalValidatedProvider(selected.identity, "SIGKILL");
        await waitFor(() => !alive(selected.identity.pid));
        assert.equal((await processIdentityProbe.validate(nonTarget.identity)).ok, true);
        await waitFor(() => {
          const db = new Database(dbPath, { readonly: true });
          const status = (db.prepare("SELECT status FROM provider_run_processes WHERE id=?").get(selected.processId) as { status: string }).status;
          db.close();
          return status !== "running";
        }, 20_000).catch((error) => {
          const db = new Database(dbPath, { readonly: true });
          const providerRow = db.prepare("SELECT status,summary,exit_code exitCode,signal FROM provider_run_processes WHERE id=?").get(selected.processId);
          const jobRow = db.prepare("SELECT status,error_code errorCode,error_summary errorSummary FROM pipeline_jobs WHERE id=?").get(targetExecution.jobId);
          db.close();
          const runner = registry.processes.find((record) => record.identity.command.join(" ").includes("provider-runner"));
          throw new Error(`provider_terminal_timeout:${JSON.stringify({ providerRow, jobRow, runnerStderr: runner?.stderr?.slice(-2000), cause: String(error) })}`);
        });
        // Business reconciliation is now owned by the worker recovery sweep, not
        // by read routes; wait for the sweep to reconcile the business run before
        // asserting the recovered projection.
        await waitFor(() => {
          const db = new Database(dbPath, { readonly: true });
          const status = (db.prepare("SELECT status FROM runs WHERE id=?").get(runId) as { status: string }).status;
          db.close();
          return status !== "running";
        }, 30_000).catch((error) => {
          const db = new Database(dbPath, { readonly: true });
          const runRow = db.prepare("SELECT status FROM runs WHERE id=?").get(runId);
          db.close();
          const workerRecord = registry.processes.find((record) => record.identity.command.join(" ").includes("pipeline-worker"));
          throw new Error(`business_reconcile_timeout:${JSON.stringify({ runRow, workerStderr: workerRecord?.stderr?.slice(-2000), cause: String(error) })}`);
        });
        await assertHttp(registry, dbPath, port, assertions, changeId, evidence);
        const recoveredDb = new Database(dbPath, { readonly: true });
        const providerState = recoveredDb.prepare("SELECT status,summary FROM provider_run_processes WHERE id=?").get(selected.processId) as { status: string; summary: string | null };
        const runStatus = (recoveredDb.prepare("SELECT status FROM runs WHERE id=?").get(runId) as { status: string }).status;
        const jobStatus = (recoveredDb.prepare("SELECT status FROM pipeline_jobs WHERE id=?").get(targetExecution.jobId) as { status: string }).status;
        const stageStatus = (recoveredDb.prepare("SELECT status FROM stage_runs WHERE change_id=?").get(changeId) as { status: string }).status;
        const changeStatus = (recoveredDb.prepare("SELECT status FROM changes WHERE id=?").get(changeId) as { status: string }).status;
        const reconciliationEvents = (recoveredDb.prepare("SELECT count(*) count FROM events WHERE change_id=? AND type='business_run_reconciled'").get(changeId) as { count: number }).count;
        recoveredDb.close();
        const providerActions = await queryActions(registry, dbPath, changeId, path.join(root, "provider-actions.json"));
        assert.deepEqual({
          provider: providerState,
          job: jobStatus,
          run: runStatus,
          stage: stageStatus,
          change: changeStatus,
          event: { type: "business_run_reconciled", count: reconciliationEvents },
          retryTechSpec: providerActions.find((action) => action.actionId === "retry_tech_spec")?.enabled ?? false,
        }, {
          provider: { status: "failed", summary: "Claude SDK exited with code null: " },
          job: "failed",
          run: "failed",
          stage: "failed",
          change: "SPEC_READY",
          event: { type: "business_run_reconciled", count: 1 },
          retryTechSpec: true,
        });
        assert.equal(alive(nonTarget.identity.pid), true);
        assertions.push("shared selector killed only target; non-target identity survived; worker sweep reconciled target business run");
      }
      if (!options.execute) await assertHttp(registry, dbPath, port, assertions, changeId, evidence);
    } else {
      const providers: ProcessIdentity[] = [];
      for (let index = 0; index < 6; index += 1) {
        providers.push((await registry.spawn("identity-holder", { STAGEPASS_DB_PATH: dbPath })).identity);
      }
      const matrix = seedRecoveryMatrix(dbPath, providers);
      await signalValidated(app.identity, "SIGKILL");
      await waitFor(() => !alive(app.identity.pid));
      await waitFor(() => {
        const record = readSupervisorHealth(healthFile)?.next.record;
        return Boolean(record && record.identity.pid !== app.identity.pid && alive(record.identity.pid)
          && readSupervisorHealth(healthFile)?.next.portListening);
      });
      await waitFor(async () => fetch(`http://127.0.0.1:${port}/api/projects/PRJ-ACCEPTANCE/changes/${encodeURIComponent(changeId)}`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok).catch(() => false));
      const replacement = readSupervisorHealth(healthFile)!.next.record!;
      assert.notEqual(replacement.identity.nonce, app.identity.nonce);
      await assertRecoveryMatrix(registry, dbPath, port, matrix, assertions, evidence);
      assertions.push("restart executed complete recovery matrix");
    }

    assert.deepEqual(REAL_DB_FILES.map((file) => ({ file, ...checksum(file) })), realBefore);
    const supervisorLog = path.join(logDir, "dev-supervisor.log");
    for (const name of ["dev-supervisor.log", "dev-server.log", "pipeline-worker.log"]) {
      const file = path.join(logDir, name);
      if (fs.existsSync(file)) {
        assert.doesNotMatch(fs.readFileSync(file, "utf8"), /pipeline_worker_loop_error/);
      }
    }
    assertions.push("production logs contain no pipeline_worker_loop_error");
    evidence.push({
      kind: "logs",
      files: ["dev-supervisor.log", "dev-server.log", "pipeline-worker.log"].map((name) => ({
        name,
        exists: fs.existsSync(path.join(logDir, name)),
        bytes: fs.existsSync(path.join(logDir, name)) ? fs.statSync(path.join(logDir, name)).size : 0,
      })),
      supervisorEvents: fs.existsSync(supervisorLog)
        ? fs.readFileSync(supervisorLog, "utf8").split("\n").filter(Boolean).slice(-30)
        : [],
    });
    evidence.push({ kind: "processes", identities: registry.processes.map((p) => ({ pid: p.identity.pid, pgid: p.identity.pgid, nonce: p.identity.nonce })) });
    validateEvidence(dbPath, evidence);
    return { caseName: options.caseName, passed: true, dbPath, assertions, identities: registry.processes.map((p) => p.identity), evidence };
  } finally {
    await registry.cleanup();
    assert.deepEqual(REAL_DB_FILES.map((file) => ({ file, ...checksum(file) })), realBefore);
  }
}

async function childMain(role: string): Promise<void> {
  if (role === "terminal-probe") {
    const input = JSON.parse(process.env.STAGEPASS_TERMINAL_INPUT!) as {
      action: "start" | "finish"; changeId: string; runId: string; jobId: string;
      workerId: string; leaseToken: string; attemptNo: number;
    };
    const output = process.env.STAGEPASS_TERMINAL_OUTPUT!;
    const context = { jobId: input.jobId, workerId: input.workerId, leaseToken: input.leaseToken, attemptNo: input.attemptNo };
    const [{ startProviderRun, finishProviderRun }, { failPipelineJob }, { StaleLeaseFenceError }] = await Promise.all([
      import("./provider-run-lifecycle-service"),
      import("./pipeline-job-lease-service"),
      import("./job-execution-context"),
    ]);
    try {
      if (input.action === "start") {
        startProviderRun({
          changeId: input.changeId, runId: input.runId, phase: "tech_spec", provider: "claude",
          pid: null, ppid: process.ppid, executionContext: context,
        });
      } else {
        finishProviderRun({
          runId: input.runId, phase: "tech_spec", status: "failed", pid: null,
          summary: "sqlite terminal acceptance", executionContext: context, closeBusinessRun: true,
        });
        try {
          failPipelineJob({ ...context, errorCode: "provider_run_failed", errorSummary: "sqlite terminal acceptance" });
        } catch (error) {
          if (!(error instanceof StaleLeaseFenceError)) throw error;
        }
      }
      fs.writeFileSync(output, JSON.stringify({ ok: true }));
    } catch (error) {
      const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
      fs.writeFileSync(output, JSON.stringify({
        ok: false,
        code: value.code ?? "unknown_error",
        label: value.label ?? null,
        attempts: value.attempts ?? null,
        elapsedMs: value.elapsedMs ?? null,
        sqliteCode: value.sqliteCode ?? null,
      }));
    }
    return;
  }
  if (role === "provider-runner") {
    const input = JSON.parse(process.env.STAGEPASS_PROVIDER_EXECUTION!) as {
      changeId: string; runId: string; jobId: string; workerId: string; leaseToken: string;
    };
    const [{ getPipelineEngine, createProviderLifecycleSink }, { failPipelineJob }] = await Promise.all([
      import("./pipeline-engine-service"),
      import("./pipeline-job-lease-service"),
    ]);
    const context = { jobId: input.jobId, workerId: input.workerId, leaseToken: input.leaseToken, attemptNo: 1 };
    const engine = await getPipelineEngine("claude");
    const result = await engine.run({
      changeId: input.changeId,
      prompt: "acceptance transport barrier",
      repoPath: PROJECT_ROOT,
      phase: "tech_spec",
      sandboxMode: "read-only",
      timeoutMs: acceptanceProviderTimeoutMs(),
      lifecycle: createProviderLifecycleSink({
        ...context,
        changeId: input.changeId,
        runId: input.runId,
        phase: "tech_spec",
        provider: "claude",
        closeBusinessRunOnProviderFailure: false,
      }),
    });
    if (!result.success) {
      try {
        failPipelineJob({ ...context, errorCode: result.providerErrorCode ?? "provider_run_failed", errorSummary: result.summary.slice(0, 1000) });
      } catch {}
    }
    return;
  }
  if (role === "action-probe") {
    const { computeActions } = await import("./action-contract-service");
    fs.writeFileSync(process.env.STAGEPASS_ACTION_OUTPUT!, JSON.stringify(computeActions(process.env.STAGEPASS_ACTION_CHANGE!)));
    return;
  }
  if (role === "fence-probe") {
    const context = JSON.parse(process.env.STAGEPASS_FENCE_CONTEXT!) as {
      jobId: string; workerId: string; leaseToken: string; attemptNo: number;
    };
    const [{ heartbeatPipelineJob, completePipelineJob, failPipelineJob }, { assertCurrentExecutionFence }] = await Promise.all([
      import("./pipeline-job-lease-service"),
      import("./execution-fence-service"),
    ]);
    const operations = [
      () => heartbeatPipelineJob(context),
      () => completePipelineJob(context),
      () => failPipelineJob({ ...context, errorCode: "old", errorSummary: "old" }),
      () => assertCurrentExecutionFence(context),
    ];
    const codes = operations.map((operation) => {
      try {
        operation();
        return "unexpected_success";
      } catch (error) {
        return error && typeof error === "object" && "code" in error ? String(error.code) : "unknown_error";
      }
    });
    fs.writeFileSync(process.env.STAGEPASS_FENCE_OUTPUT!, JSON.stringify(codes));
    return;
  }
  if (role === "locker") {
    const db = new Database(process.env.STAGEPASS_DB_PATH!);
    db.pragma("busy_timeout=0");
    db.exec("BEGIN IMMEDIATE");
    fs.writeFileSync(process.env.STAGEPASS_LOCK_READY!, String(process.pid));
    setTimeout(() => {
      db.exec("COMMIT");
      db.close();
      process.exit(0);
    }, Number(process.env.STAGEPASS_LOCK_HOLD_MS));
    return;
  }

  if (role === "identity-holder") {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
    return;
  }
  if (role === "hung-probe") {
    process.stdout.write("hung-probe-ready\n");
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
    return;
  }
  if (role === "immediate-probe") {
    process.stdout.write("immediate-probe-ok\n");
    return;
  }
  if (role === "overflow-probe") {
    process.stdout.write("x".repeat(65 * 1024));
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
    return;
  }
  throw new Error(`unknown_harness_child_role:${role}`);
}

if (process.argv[2] === "--child") {
  void childMain(process.argv[3] ?? "").catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
