import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { createChildLogger } from "../logger";
import {
  processIdentityProbe,
  type ProcessIdentityProbe,
} from "./process-identity-service";
import { parseStructuredOutputText } from "./ai-structured-output-service";
import type {
  AiEngineAdapter,
  AiRunInput,
  AiRunItem,
  AiRunPhase,
  AiRunResult,
  AiSandboxMode,
  AiStreamEvent,
} from "./ai-engine-types";

/**
 * Codex CLI engine — drives the `codex` binary directly via `spawn`, replacing
 * the @openai/codex-sdk wrapper it previously used. That SDK spawned the same
 * binary internally but seals the child process away: its public API exposes no
 * pid and no signal control (only an AbortSignal). Spawning ourselves is the only
 * way to get the real pid + identity + SIGTERM/SIGKILL that let codex runs join
 * the same process-lifecycle/recovery machinery as claude-engine, instead of
 * being the `pid === null` second-class citizen the recovery service special-cases.
 */

const log = createChildLogger("codex-cli-engine");

const CODEX_FORCE_KILL_GRACE_MS = 50;
const DEFAULT_CODEX_HEARTBEAT_MS = 15_000;
/**
 * How long the streaming path waits for the child's `close` after its stdout has
 * already drained. stdout EOF means codex is done writing, so `close` normally
 * lands in the same tick; the cap exists only so a child that somehow never
 * reaps cannot wedge the generator -- which is the hang the old fire-and-forget
 * exit observer avoided by never awaiting the exit facts at all (and therefore
 * never reporting them).
 */
const CODEX_STREAM_EXIT_GRACE_MS = 2_000;

// --- Test seams -------------------------------------------------------------

type CodexSpawn = typeof spawn;
let codexSpawnForTest: CodexSpawn | null = null;
let codexProcessIdentityProbeForTest: ProcessIdentityProbe | null = null;

export function setCodexCliSpawnForTest(spawnImpl: CodexSpawn | null): () => void {
  const previous = codexSpawnForTest;
  codexSpawnForTest = spawnImpl;
  return () => {
    codexSpawnForTest = previous;
  };
}

export function setCodexCliProcessIdentityProbeForTest(
  probe: ProcessIdentityProbe | null,
): () => void {
  const previous = codexProcessIdentityProbeForTest;
  codexProcessIdentityProbeForTest = probe;
  return () => {
    codexProcessIdentityProbeForTest = previous;
  };
}

function getCodexSpawn(): CodexSpawn {
  return codexSpawnForTest ?? spawn;
}

function getCodexProcessIdentityProbe(): ProcessIdentityProbe {
  return codexProcessIdentityProbeForTest ?? processIdentityProbe;
}

// --- Binary resolution ------------------------------------------------------

/** Env var that overrides the codex binary path. */
export const CODEX_BIN_ENV = "STAGEPASS_CODEX_BIN";

/**
 * Resolve the codex CLI binary. Env-configured with a sensible default:
 * explicit `STAGEPASS_CODEX_BIN` wins; otherwise return the bare name `codex` and
 * let the OS resolve it on PATH. No hardcoded machine-specific path (unlike the
 * old SDK engine's `/opt/homebrew/bin/codex`), so a fresh clone runs anywhere
 * codex is installed — or wherever STAGEPASS_CODEX_BIN points.
 */
export function resolveCodexBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CODEX_BIN_ENV]?.trim();
  return override && override.length > 0 ? override : "codex";
}

// --- Output schema temp file ------------------------------------------------

export interface CodexOutputSchemaFile {
  /** Path to the written schema.json, or undefined when no schema was given. */
  schemaPath?: string;
  /** Remove the temp dir. Always safe to call; best-effort. */
  cleanup: () => void;
}

/**
 * Write a JSON schema to a temp file so it can be passed via `--output-schema`.
 * Mirrors @openai/codex-sdk's createOutputSchemaFile so structured-output
 * behaviour is unchanged. The caller must invoke `cleanup()` after the run.
 */
export function createCodexOutputSchemaFile(schema: unknown): CodexOutputSchemaFile {
  if (schema === undefined) {
    return { cleanup: () => {} };
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("outputSchema must be a plain JSON object");
  }

  const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-output-schema-"));
  const schemaPath = path.join(schemaDir, "schema.json");
  const cleanup = () => {
    try {
      fs.rmSync(schemaDir, { recursive: true, force: true });
    } catch {
      // best-effort: temp dir cleanup failures must not fail the run
    }
  };

  try {
    fs.writeFileSync(schemaPath, JSON.stringify(schema), "utf8");
    return { schemaPath, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// --- argv construction ------------------------------------------------------

export interface BuildCodexArgsInput {
  repoPath: string;
  /** Defaults to "workspace-write", matching the old SDK engine. */
  sandboxMode?: AiSandboxMode;
  /** When set, resume an existing codex thread instead of starting fresh. */
  threadId?: string;
  /** Path from createCodexOutputSchemaFile(), passed to --output-schema. */
  outputSchemaFile?: string;
}

/**
 * Build the argv for `codex exec`. Targets the codex CLI's current surface
 * (>= 0.144): the JSONL flag is `--json` (the SDK-era `--experimental-json` was
 * removed), and `resume` is a subcommand of `exec` whose session id is a trailing
 * positional: `codex exec resume [OPTIONS] <SESSION_ID>`. The prompt is
 * deliberately NOT included here — it is written to the child's stdin by the caller.
 *
 * `resume`'s own `--help` (verified against codex-cli 0.144.4) has no `-s/--sandbox`
 * and no `-C/--cd` — both are fresh-run-only; resuming inherits the original
 * session's sandbox policy and cwd. Omitting them for resume is safe: the child
 * process's OS-level working directory is set independently via `spawn(..., {cwd})`
 * in run()/runStreamed(), regardless of any `--cd` argv. Passing either to `resume`
 * makes the CLI exit 2 ("unexpected argument '--sandbox' found").
 *
 *   codex exec --json --sandbox <mode> --cd <dir> --skip-git-repo-check [--output-schema <file>]
 *   codex exec resume --json --skip-git-repo-check [--output-schema <file>] <sessionId>
 *
 * Because resume inherits the ORIGINAL session's sandbox policy, a run that
 * needs "workspace-write" must never resume: the pipeline's shared sessions
 * are created by read-only document stages (PRD/Spec/TechSpec/Plan) in the
 * project repo, so resuming one inside a build/fix worktree silently strips
 * write access — codex then reports a read-only sandbox and produces zero
 * file changes ("Build workspace produced no changes"). Write-phase runs also
 * execute in per-run worktrees, so cross-run session continuity is
 * structurally wrong for them anyway.
 */
export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  const sandboxMode: AiSandboxMode = input.sandboxMode ?? "workspace-write";
  const isResume = Boolean(input.threadId) && sandboxMode !== "workspace-write";
  // `resume` must come right after `exec`; the session id trails the options.
  const args: string[] = isResume ? ["exec", "resume"] : ["exec"];
  args.push("--json");

  if (!isResume) {
    args.push("--sandbox", sandboxMode);

    if (input.repoPath) {
      args.push("--cd", input.repoPath);
    }
  }

  // The old SDK path always set skipGitRepoCheck: true; keep that behaviour.
  args.push("--skip-git-repo-check");

  if (input.outputSchemaFile) {
    args.push("--output-schema", input.outputSchemaFile);
  }

  if (isResume && input.threadId) {
    args.push(input.threadId);
  }

  return args;
}

// --- Multi-agent (Codex native agents via .codex/agents/*.toml) -------------
// Carried over from the former SDK engine: provider-agnostic file writes + prompt
// augmentation, so implement/fix phases still spawn a reviewer/verifier agent.

interface CodexAgentDef {
  name: string;
  description: string;
  developer_instructions: string;
  sandbox_mode?: string;
  model_reasoning_effort?: string;
}

function getAgentsForPhase(phase: AiRunPhase): CodexAgentDef[] {
  switch (phase) {
    case "implement":
      return [
        {
          name: "reviewer",
          description:
            "Independent code reviewer that checks implementation quality, security, and correctness.",
          developer_instructions: `Review the code changes for bugs, security issues, logic errors, and code quality problems.
Be specific about file paths and line numbers.
Do NOT modify any files — only report findings.`,
          sandbox_mode: "read-only",
        },
      ];
    case "fix":
    case "fix_findings":
      return [
        {
          name: "verifier",
          description: "Verifies that applied fixes actually resolve the reported findings.",
          developer_instructions: `Read the finding description and the changed code.
Confirm whether the fix addresses the issue.
Report any remaining concerns.`,
          sandbox_mode: "read-only",
          model_reasoning_effort: "high",
        },
      ];
    default:
      return [];
  }
}

function toToml(agent: CodexAgentDef): string {
  const lines: string[] = [];
  lines.push(`name = "${agent.name}"`);
  lines.push(`description = "${agent.description.replace(/"/g, '\\"')}"`);
  lines.push(`developer_instructions = """\n${agent.developer_instructions}\n"""`);
  if (agent.sandbox_mode) {
    lines.push(`sandbox_mode = "${agent.sandbox_mode}"`);
  }
  if (agent.model_reasoning_effort) {
    lines.push(`model_reasoning_effort = "${agent.model_reasoning_effort}"`);
  }
  return lines.join("\n") + "\n";
}

function ensureAgentFiles(repoPath: string, phase: AiRunPhase): string[] {
  const agents = getAgentsForPhase(phase);
  if (agents.length === 0) return [];

  const agentsDir = path.join(repoPath, ".codex", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  const written: string[] = [];
  for (const agent of agents) {
    const filePath = path.join(agentsDir, `${agent.name}.toml`);
    fs.writeFileSync(filePath, toToml(agent), "utf-8");
    written.push(agent.name);
  }

  log.info({ phase, agents: written }, "Wrote Codex agent TOML files");
  return written;
}

function cleanupAgentFiles(repoPath: string): void {
  const agentsDir = path.join(repoPath, ".codex", "agents");
  if (!fs.existsSync(agentsDir)) return;
  try {
    const files = fs.readdirSync(agentsDir);
    for (const f of files) {
      fs.unlinkSync(path.join(agentsDir, f));
    }
    fs.rmdirSync(agentsDir);
  } catch {
    // best-effort cleanup
  }
}

function buildMultiAgentPrompt(
  basePrompt: string,
  agentNames: string[],
  phase: AiRunPhase,
): string {
  if (agentNames.length === 0) return basePrompt;

  if (phase === "implement") {
    return `${basePrompt}

After completing the implementation, use the "${agentNames[0]}" agent to review all changed files for bugs, security issues, and logic errors. Report any findings at the end.`;
  }

  if (phase === "fix" || phase === "fix_findings") {
    return `${basePrompt}

After applying fixes, use the "${agentNames[0]}" agent to verify each fix actually resolves the reported issue.`;
  }

  return basePrompt;
}

// --- Event / result helpers (codex JSONL -> engine types) -------------------

interface CodexThreadEvent {
  type: string;
  thread_id?: string;
  item?: Record<string, unknown> & { type?: string; text?: string };
  error?: { message?: string };
  [key: string]: unknown;
}

function toAiRunItem(item: Record<string, unknown>): AiRunItem {
  return { ...item } as AiRunItem;
}

function toAiStreamEvent(event: CodexThreadEvent): AiStreamEvent {
  if (event.item) {
    return { ...event, item: toAiRunItem(event.item) } as AiStreamEvent;
  }
  return { ...event } as AiStreamEvent;
}

function extractChangedFiles(items: AiRunItem[]): string[] {
  const files: string[] = [];
  for (const item of items) {
    if (item.type === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const change of changes) {
        if (change?.path && !files.includes(change.path)) {
          files.push(change.path);
        }
      }
    }
  }
  return files;
}

let runCounter = 0;
function generateRunId(): string {
  runCounter++;
  return `RUN-${String(runCounter).padStart(3, "0")}`;
}

function isTimeoutMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("timeout") || normalized.includes("aborted");
}

/**
 * Substrings codex puts in a `turn.failed` message when the HTTP transport to
 * the model service broke, verified against real rows, e.g.
 *   "Codex turn failed: stream disconnected before completion: error sending
 *    request for url (https://chatgpt.com/backend-api/codex/responses)"
 *
 * Kept deliberately short. Every entry has to be evidence of a TRANSPORT
 * failure specifically -- anything vaguer turns provider_transport_error into
 * the new catch-all bucket and re-creates the over-attribution this whole
 * change exists to remove. Real messages also embed localized prose around
 * these markers, so match on the stable English transport fragment only.
 */
const CODEX_TRANSPORT_ERROR_MARKERS = [
  "stream disconnected",
  "error sending request",
] as const;

/** Redacted tail of the child's stderr, or "" when it wrote nothing. */
function codexStderrTail(stderr: string): string {
  return stderr.trim().length === 0 ? "" : sanitizeCodexErrorMessage(stderr.slice(-200));
}

function hasCodexTransportEvidence(message: string): boolean {
  const normalized = message.toLowerCase();
  return CODEX_TRANSPORT_ERROR_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Carries the provider-side facts out of spawnAndCollect() so run()'s catch can
 * report WHY the run failed instead of flattening everything to
 * provider_run_failed with a null exit code.
 */
class CodexRunFailure extends Error {
  readonly providerErrorCode: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;

  constructor(
    message: string,
    detail: {
      providerErrorCode: string;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderrTail?: string;
    },
  ) {
    super(message);
    this.name = "CodexRunFailure";
    this.providerErrorCode = detail.providerErrorCode;
    this.exitCode = detail.exitCode ?? null;
    this.signal = detail.signal ?? null;
    this.stderrTail = detail.stderrTail ?? "";
  }
}

/** Redact obvious secrets from a provider error before it is stored/surfaced. */
function sanitizeCodexErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown provider error";
  return (
    raw
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500) || "unknown provider error"
  );
}

function codexHeartbeatMs(): number {
  const parsed = Number.parseInt(process.env.STAGEPASS_CODEX_HEARTBEAT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_HEARTBEAT_MS;
}

/**
 * Start the provider heartbeat timer for a codex run.
 *
 * `Promise.resolve().then(...)` is load-bearing, not ceremony. The lifecycle
 * contract is `onHeartbeat(event): void | Promise<void>`
 * (ai-engine-types.ts:57) and the implementation the pipeline actually passes
 * in is the SYNCHRONOUS one: pipeline-engine-service.ts's `onHeartbeat` calls
 * `heartbeatProviderLease()` inline, and every write beneath it is
 * better-sqlite3, which is synchronous. So a fenced lease threw straight into
 * the timer callback, where `void expr` discards the value but catches
 * nothing -- an uncaughtException that killed the entire pipeline worker
 * (`pipeline_worker_fatal`). The supervisor then restarted it, the
 * replacement fenced the dead worker's in-flight jobs, and their still-live
 * codex heartbeats killed the replacement in turn. Attaching a bare
 * `.catch()` to the call would NOT have fixed it: `onHeartbeat` throws before
 * it returns a promise to attach to. Wrapping in `Promise.resolve().then()`
 * converts the synchronous throw into a rejection, which is exactly the shape
 * claude-engine.ts:1008 already uses -- this engine was the only one missing
 * it.
 *
 * The failure is reported, never swallowed. Losing the lease means the run no
 * longer owns its slot, so `onLifecycleFailure` aborts it: silently streaming
 * on would turn a real ownership loss into invisible zombie work. The engine
 * stays deliberately lease-agnostic (it does not import StaleLeaseFenceError,
 * and neither does claude-engine) -- it reports the error it was handed and
 * lets the stage layer, whose `assertCurrentExecutionFence` re-checks
 * ownership at every write boundary, decide what a fence means.
 */
function startCodexHeartbeat(options: {
  lifecycle: NonNullable<AiRunInput["lifecycle"]>;
  pid: number | null;
  /** Read per tick: the thread id is only learned once codex emits it. */
  externalRef: () => string | null;
  onLifecycleFailure: (error: Error) => void;
}): ReturnType<typeof setInterval> {
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  const started = setInterval(() => {
    if (stopped) return;
    void Promise.resolve()
      .then(() =>
        options.lifecycle.onHeartbeat({
          provider: "codex",
          pid: options.pid,
          externalRef: options.externalRef(),
          observedAt: new Date().toISOString(),
        }),
      )
      .catch((error: unknown) => {
        if (stopped) return;
        // Heartbeating a lease we have provably lost is pointless and noisy,
        // and every extra tick was another crash in the old code. Stop first,
        // so the abort below can never be re-entered by a later tick.
        stopped = true;
        if (interval) clearInterval(interval);
        const failure = error instanceof Error ? error : new Error(String(error));
        // The abort is recorded before anything cosmetic: this is the exact
        // callback whose escaping throw killed the worker, so the load-bearing
        // effect must not sit behind a line that could itself fail.
        options.onLifecycleFailure(failure);
        log.error(
          {
            pid: options.pid,
            // A definite fence ("stale_lease_fence") and a database that
            // stayed wedged through withSqliteWriteRetry's whole budget
            // ("sqlite_write_busy") both end the run, but they need different
            // operator responses, so the class that distinguishes them is
            // carried into the log rather than flattened away.
            errorName: failure.name,
            errorCode: (failure as { code?: unknown }).code ?? null,
            err: failure.message,
          },
          "Codex provider heartbeat failed; aborting the run",
        );
      });
  }, codexHeartbeatMs());
  interval = started;
  started.unref();
  return started;
}

interface RawCodexResult {
  items: Array<Record<string, unknown>>;
  finalResponse: string;
  threadId: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

/**
 * Non-blocking record of how the child ended, for the moments where waiting is
 * not an option -- a mid-stream `turn.failed`, or a lifecycle error raised while
 * codex is still running. This listener just captures the exit facts if and when
 * they arrive, leaving nulls if they never do.
 */
interface ProcessExitObserver {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

function observeProcessExit(proc: ChildProcess): ProcessExitObserver {
  const observer = { exitCode: proc.exitCode, signal: proc.signalCode };
  proc.once("close", (code, signal) => {
    observer.exitCode = code;
    observer.signal = signal;
  });
  return observer;
}

/** Resolve when the child process has fully exited. */
function awaitProcessClose(
  proc: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
      return;
    }
    proc.once("close", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * awaitProcessClose with a ceiling. The streaming path calls this once its
 * stdout has drained, so the exit code and signal it reports are the real ones
 * instead of the nulls every codex `implement` / `fix_findings` row carries
 * today; the ceiling guarantees a child that never reaps costs a bounded wait
 * rather than an unbounded one.
 */
function awaitProcessCloseWithin(
  proc: ChildProcess,
  graceMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal });
    };
    proc.once("close", onClose);
    timer = setTimeout(() => {
      proc.off("close", onClose);
      resolve({ code: proc.exitCode, signal: proc.signalCode });
    }, graceMs);
    timer.unref();
  });
}

// --- Engine -----------------------------------------------------------------

export class CodexCliEngine implements AiEngineAdapter {
  async run(input: AiRunInput): Promise<AiRunResult> {
    const schemaFile = createCodexOutputSchemaFile(input.outputSchema);
    const agentNames = ensureAgentFiles(input.repoPath, input.phase);
    const prompt = buildMultiAgentPrompt(input.prompt, agentNames, input.phase);
    const schemaDelivery = input.outputSchema ? "provider_native" : "none";
    const schemaCapabilityInvoked = Boolean(input.outputSchema);

    let terminalEmitted = false;
    const emitTerminal = async (
      event: Parameters<NonNullable<AiRunInput["lifecycle"]>["onTerminal"]>[0],
    ): Promise<void> => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      await input.lifecycle?.onTerminal(event);
    };

    try {
      const raw = await this.spawnAndCollect(input, schemaFile.schemaPath, prompt);

      const items = raw.items.map(toAiRunItem);
      const changedFiles = extractChangedFiles(items);
      const parsed = input.outputSchema
        ? parseStructuredOutputText(raw.finalResponse)
        : { value: undefined, source: null as string | null };

      const runResult: AiRunResult = {
        threadId: raw.threadId ?? input.threadId ?? "unknown",
        runId: generateRunId(),
        summary: raw.finalResponse,
        success: true,
        changedFiles,
        structuredOutput: parsed.value,
        structuredOutputSource: parsed.source ? "text_extracted" : "none",
        schemaDelivery,
        schemaCapabilityInvoked,
        exitCode: raw.exitCode,
        signal: raw.signal,
        stderrTail: raw.stderrTail,
        items,
      };

      log.info(
        { changeId: input.changeId, changedFiles: changedFiles.length },
        "Codex CLI run completed",
      );
      await emitTerminal({
        provider: "codex",
        pid: null,
        exitCode: raw.exitCode,
        signal: raw.signal,
        status: "completed",
        summary: runResult.summary || "Codex run completed",
        endedAt: new Date().toISOString(),
      });
      return runResult;
    } catch (err) {
      const message = sanitizeCodexErrorMessage(err);
      const failure = err instanceof CodexRunFailure ? err : null;
      log.error(
        {
          changeId: input.changeId,
          phase: input.phase,
          err: message,
          exitCode: failure?.exitCode ?? null,
          signal: failure?.signal ?? null,
        },
        "Codex CLI run failed",
      );
      const runResult: AiRunResult = {
        threadId: input.threadId ?? "unknown",
        runId: generateRunId(),
        summary: `Codex run failed: ${message}`,
        success: false,
        changedFiles: [],
        structuredOutputSource: "none",
        schemaDelivery,
        schemaCapabilityInvoked,
        providerErrorCode: failure?.providerErrorCode
          ?? (isTimeoutMessage(message) ? "provider_timeout" : "provider_run_failed"),
        providerErrorDetail: message,
        exitCode: failure?.exitCode ?? null,
        signal: failure?.signal ?? null,
        stderrTail: failure?.stderrTail,
        items: [],
      };
      await emitTerminal({
        provider: "codex",
        pid: null,
        exitCode: failure?.exitCode ?? null,
        signal: failure?.signal ?? null,
        status: "failed",
        summary: runResult.summary,
        endedAt: new Date().toISOString(),
      });
      return runResult;
    } finally {
      schemaFile.cleanup();
      cleanupAgentFiles(input.repoPath);
    }
  }

  /**
   * Spawn `codex exec`, stream its JSONL to the lifecycle sink with a real pid,
   * and aggregate the event stream into a raw result (mirrors the SDK's
   * thread.run aggregation). Throws on turn.failed / timeout / nonzero-exit so
   * run() can map it to a failure AiRunResult.
   */
  private async spawnAndCollect(
    input: AiRunInput,
    schemaFile: string | undefined,
    prompt: string,
  ): Promise<RawCodexResult> {
    const bin = resolveCodexBin();
    const args = buildCodexArgs({
      repoPath: input.repoPath,
      sandboxMode: input.sandboxMode,
      threadId: input.threadId,
      outputSchemaFile: schemaFile,
    });

    // Normalize for process-identity's cwd check: on macOS a temp dir like
    // /var/folders/... is a symlink to /private/var/... and the spawned process
    // reports the resolved path, so spawn AND compare against the resolved path.
    let processCwd = input.repoPath;
    try {
      processCwd = fs.realpathSync(input.repoPath);
    } catch {
      // keep the raw path if it cannot be resolved
    }

    const proc = getCodexSpawn()(bin, args, {
      cwd: processCwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = proc.pid ?? null;

    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let threadId = input.threadId ?? null;
    /** Set when the lifecycle sink failed; the run is unwound and reports it. */
    let lifecycleFailure: Error | null = null;
    const stopTimers = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
    };
    /** SIGTERM now, SIGKILL after the grace -- the escalation used elsewhere here. */
    const killChild = () => {
      try {
        proc.kill("SIGTERM");
      } catch {}
      if (forceKillTimeout) return;
      forceKillTimeout = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, CODEX_FORCE_KILL_GRACE_MS);
      forceKillTimeout.unref();
    };

    try {
      // --- Process identity + lifecycle start (this is the whole point) ---
      if (input.lifecycle) {
        if (pid === null) {
          try {
            proc.kill("SIGKILL");
          } catch {}
          throw new Error("spawned codex process did not expose a pid");
        }
        let identity;
        try {
          identity = await getCodexProcessIdentityProbe().capture(pid, {
            ppid: process.pid,
            cwd: processCwd,
          });
        } catch (error) {
          try {
            proc.kill("SIGTERM");
          } catch {}
          forceKillTimeout = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {}
          }, CODEX_FORCE_KILL_GRACE_MS);
          throw error;
        }
        await input.lifecycle.onProcessStarted({
          provider: "codex",
          pid,
          ppid: process.pid,
          externalRef: threadId,
          identity,
          startedAt: new Date().toISOString(),
        });
        heartbeatInterval = startCodexHeartbeat({
          lifecycle: input.lifecycle,
          pid,
          externalRef: () => threadId,
          onLifecycleFailure: (error) => {
            lifecycleFailure ??= error;
            // The run has lost its claim on the slot, so stop the provider
            // rather than let it keep producing work nobody owns. Reaping the
            // child is also what ends the readline loop below and unwinds the
            // run -- the same mechanism the wall-clock timeout relies on.
            killChild();
          },
        });
      }

      if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          killChild();
        }, input.timeoutMs);
      }

      // Prompt goes on stdin, not argv.
      proc.stdin?.write(prompt);
      proc.stdin?.end();

      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // --- Aggregate the JSONL event stream (mirrors SDK thread.run) ---
      const items: Array<Record<string, unknown>> = [];
      let finalResponse = "";
      let turnFailure: { message?: string } | null = null;

      const rl = readline.createInterface({ input: proc.stdout! });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: CodexThreadEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // ignore any non-JSON noise on stdout
        }
        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
        } else if (event.type === "item.completed" && event.item) {
          items.push(event.item);
          if (event.item.type === "agent_message" && typeof event.item.text === "string") {
            finalResponse = event.item.text;
          }
        } else if (event.type === "turn.failed") {
          turnFailure = event.error ?? { message: "turn failed" };
        }
      }

      const { code, signal } = await awaitProcessClose(proc);
      // sanitizeCodexErrorMessage() substitutes "unknown provider error" for an
      // empty input, which would be a lie here: no stderr means no stderr.
      const stderrTail = codexStderrTail(stderr);
      const processFacts = { exitCode: code, signal, stderrTail };

      // Reported FIRST, and as itself. A lifecycle failure is the root cause of
      // every downstream symptom this run will show (a reaped child, no
      // agent_message), so letting `!finalResponse` win the race would blame
      // the provider for an empty reply it never had the chance to give, and
      // bury the real reason. Rethrowing the original error rather than
      // wrapping it in CodexRunFailure keeps `err instanceof
      // StaleLeaseFenceError` answerable for callers that can see it -- this
      // engine never has to know what a fence is.
      if (lifecycleFailure) throw lifecycleFailure;
      if (timedOut) {
        throw new CodexRunFailure(`provider_timeout: codex timed out after ${input.timeoutMs}ms`, {
          ...processFacts,
          providerErrorCode: "provider_timeout",
        });
      }
      if (turnFailure) {
        const message = sanitizeCodexErrorMessage(turnFailure.message);
        throw new CodexRunFailure(`Codex turn failed: ${message}`, {
          ...processFacts,
          providerErrorCode: hasCodexTransportEvidence(message)
            ? "provider_transport_error"
            : "provider_run_failed",
        });
      }
      // No agent_message means the provider delivered no reply, and a run with
      // no reply is a FAILED run -- whatever the exit code, and however many
      // reasoning items it managed to emit first. That `items.length === 0`
      // conjunct used to live here is what let a SIGTERM'd run (reasoning
      // emitted, agent_message never) return success with summary: "", so the
      // line-protocol parser was handed an empty document and reported the only
      // thing it could: a format error. The model was then blamed for output it
      // never produced. Ask "did the provider deliver a reply?" first; only then
      // is "is the reply well-formed?" a meaningful question.
      if (!finalResponse) {
        throw new CodexRunFailure(
          `codex produced no assistant message (exit ${code ?? "null"}`
          + `${signal ? `, signal ${signal}` : ""})`
          + `${stderrTail ? `: ${stderrTail}` : ""}`,
          {
            ...processFacts,
            // Hard evidence only. A nonzero exit or a signal proves the process
            // died, NOT that the network did, so it stays provider_empty_response.
            providerErrorCode: hasCodexTransportEvidence(stderrTail)
              ? "provider_transport_error"
              : "provider_empty_response",
          },
        );
      }

      return { items, finalResponse, threadId, exitCode: code, signal, stderrTail };
    } finally {
      stopTimers();
    }
  }

  async *runStreamed(input: AiRunInput): AsyncGenerator<AiStreamEvent> {
    const schemaFile = createCodexOutputSchemaFile(input.outputSchema);
    const agentNames = ensureAgentFiles(input.repoPath, input.phase);
    const prompt = buildMultiAgentPrompt(input.prompt, agentNames, input.phase);
    const bin = resolveCodexBin();
    const args = buildCodexArgs({
      repoPath: input.repoPath,
      sandboxMode: input.sandboxMode,
      threadId: input.threadId,
      outputSchemaFile: schemaFile.schemaPath,
    });

    let processCwd = input.repoPath;
    try {
      processCwd = fs.realpathSync(input.repoPath);
    } catch {
      // keep the raw path if it cannot be resolved
    }

    const proc = getCodexSpawn()(bin, args, {
      cwd: processCwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = proc.pid ?? null;
    let threadId = input.threadId ?? null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    /**
     * Whether the provider delivered anything at all. Deliberately NOT "did it
     * produce an agent_message": build and fix deliver their result as file
     * mutations, and a build that rewrote twenty files while saying almost
     * nothing is a success. Porting run()'s `!finalResponse => failure` rule
     * here would fail those. The workspace diff is the authority on whether a
     * build produced work (build-workspace-service.ts collectBuildResult already
     * fails a run whose diff is empty); the engine's job is only to report
     * whether the RUN reached its end, which is what the checks below ask.
     */
    let deliveredEvents = 0;
    /** Set when the lifecycle sink failed; the stream is unwound and reports it. */
    let lifecycleFailure: Error | null = null;
    const exit = observeProcessExit(proc);
    // The streaming path never read stderr at all, so a codex that died with a
    // reason printed there produced a terminal event with no reason in it.
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const stopTimers = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = null;
      if (timeout) clearTimeout(timeout);
      timeout = null;
    };
    /**
     * SIGTERM now, SIGKILL after the grace -- the same escalation run() uses.
     * The streaming path never killed at all: its finally cleared the heartbeat
     * and emitted a terminal event but left `codex exec` alive, so every
     * abnormal exit (startup timeout, consumer failure, turn.failed) orphaned a
     * child still holding the build worktree open.
     */
    const killChild = () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try {
        proc.kill("SIGTERM");
      } catch {}
      if (forceKillTimeout) return;
      forceKillTimeout = setTimeout(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, CODEX_FORCE_KILL_GRACE_MS);
      forceKillTimeout.unref();
    };

    let terminalEmitted = false;
    const emitTerminal = async (
      event: Omit<
        Parameters<NonNullable<AiRunInput["lifecycle"]>["onTerminal"]>[0],
        "exitCode" | "signal"
      >,
    ): Promise<void> => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      await input.lifecycle?.onTerminal({
        ...event,
        exitCode: exit.exitCode,
        signal: exit.signal,
      });
    };

    try {
      if (input.lifecycle && pid !== null) {
        const identity = await getCodexProcessIdentityProbe().capture(pid, {
          ppid: process.pid,
          cwd: processCwd,
        });
        await input.lifecycle.onProcessStarted({
          provider: "codex",
          pid,
          ppid: process.pid,
          externalRef: threadId,
          identity,
          startedAt: new Date().toISOString(),
        });
        heartbeatInterval = startCodexHeartbeat({
          lifecycle: input.lifecycle,
          pid,
          externalRef: () => threadId,
          onLifecycleFailure: (error) => {
            lifecycleFailure ??= error;
            // Lost the slot: stop the provider instead of streaming work
            // nobody owns into a stage that no longer has the right to write.
            killChild();
          },
        });
      }

      // The wall-clock kill the streaming path never had. `input.timeoutMs` was
      // accepted and silently dropped, so `fix` ran with no time bound of any
      // kind and `build` was bounded only on its FIRST event
      // (consumeBuildStreamWithStartupTimeout); a provider that went quiet after
      // event one hung the stage forever. No default is invented here: the
      // budget is exactly what the caller passes, matching run() and claude's
      // runStreamed, so a legitimately long build keeps its full allowance.
      if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          killChild();
        }, input.timeoutMs);
      }

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      const rl = readline.createInterface({ input: proc.stdout! });
      for await (const line of rl) {
        // Checked per line, not just after the loop: the child is being reaped
        // but its buffered stdout can still be drained, and yielding events for
        // a run that has lost its slot is the zombie work this abort exists to
        // prevent.
        if (lifecycleFailure) throw lifecycleFailure;
        if (!line.trim()) continue;
        let event: CodexThreadEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
        }
        if (event.type === "turn.failed") {
          const message = sanitizeCodexErrorMessage(event.error?.message);
          // Same evidence rule as run(): only codex's own transport wording
          // earns provider_transport_error.
          const providerErrorCode = hasCodexTransportEvidence(message)
            ? "provider_transport_error"
            : "provider_run_failed";
          throw new CodexRunFailure(`${providerErrorCode}: Codex turn failed: ${message}`, {
            providerErrorCode,
            exitCode: exit.exitCode,
            signal: exit.signal,
            stderrTail: codexStderrTail(stderr),
          });
        }
        deliveredEvents += 1;
        yield toAiStreamEvent(event);
      }

      // --- The stream drained. Was that a completion, or a death? ------------
      // Until now it was unconditionally a completion: stdout closing ended the
      // loop and the generator reported "completed" whether codex had finished
      // its turn or been killed mid-edit. A half-applied build then reached
      // collectBuildResult, which sees only a non-empty diff and hands it to the
      // human as a finished build.
      const stderrTail = codexStderrTail(stderr);
      const { code, signal } = await awaitProcessCloseWithin(proc, CODEX_STREAM_EXIT_GRACE_MS);
      const processFacts = { exitCode: code, signal, stderrTail };
      const evidence = `(exit ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`
        + `${stderrTail ? `: ${stderrTail}` : ""}`;
      // Hard evidence only, exactly as in run(): a dead process proves the
      // process died, not that the network did.
      const classify = (fallback: string): string =>
        hasCodexTransportEvidence(stderrTail) ? "provider_transport_error" : fallback;
      // The error code is carried in the message text as well as on the error,
      // because a streamed stage has no AiRunResult to put providerErrorCode on
      // -- the run summary is the only channel action-contract's
      // extractKnownCodeFromText can read it from. claude's runStreamed does the
      // same ("provider_run_failed: Claude SDK stream exited with code N").
      const failure = (providerErrorCode: string, what: string): CodexRunFailure =>
        new CodexRunFailure(`${providerErrorCode}: ${what} ${evidence}`, {
          ...processFacts,
          providerErrorCode,
        });

      // Same precedence as run(): the lifecycle failure is the cause, the dead
      // child and the missing events are its symptoms. Propagated as itself so
      // the stage services' `err instanceof StaleLeaseFenceError` handlers --
      // which deliberately rethrow a fence instead of writing a failure record
      // to rows the run no longer owns -- still recognise it.
      if (lifecycleFailure) throw lifecycleFailure;
      if (timedOut) {
        throw failure("provider_timeout", `codex stream timed out after ${input.timeoutMs}ms`);
      }
      if (deliveredEvents === 0) {
        // Nothing was delivered at all, so "empty response" is literally true
        // and claims no cause -- the one case where run()'s empty-reply code
        // transfers to a stream whose payload is file mutations.
        throw failure(classify("provider_empty_response"), "codex stream produced no events");
      }
      if (signal !== null) {
        // A signal is unambiguous: nothing completes a turn by dying to one.
        // This is the RUN-230 shape (macOS DarkWake -> supervisor SIGTERM).
        // A nonzero EXIT CODE is deliberately not a failure here: run() does not
        // treat it as one either, and this system has recorded claude runs that
        // exited 1 having delivered their whole result, so failing on it would
        // discard good build patches.
        throw failure(classify("provider_run_failed"), "codex was killed mid-stream");
      }

      await emitTerminal({
        provider: "codex",
        pid: null,
        status: "completed",
        summary: "Codex stream completed",
        endedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = sanitizeCodexErrorMessage(err);
      const stderrTail = codexStderrTail(stderr);
      log.error(
        {
          changeId: input.changeId,
          phase: input.phase,
          err: message,
          exitCode: exit.exitCode,
          signal: exit.signal,
          stderrTail,
        },
        "Codex CLI stream failed",
      );
      await emitTerminal({
        provider: "codex",
        pid: null,
        status: "failed",
        summary: message,
        endedAt: new Date().toISOString(),
      });
      throw err instanceof Error ? err : new Error(message);
    } finally {
      stopTimers();
      // Every unwind of this generator lands here: normal completion, a thrown
      // failure, a consumer `break`, or an iterator.return() that the generator
      // was able to act on. On a completion the child is already gone and
      // killChild() is a no-op; on any other path this is what stops `codex
      // exec` outliving the stage that started it. Note the force-kill
      // escalation is armed AFTER stopTimers() on purpose, so the SIGKILL
      // survives cleanup rather than being cancelled by it.
      //
      // One shape does NOT reach here promptly: a return() requested while a
      // next() is still pending is queued behind that next(), so the finally
      // waits for it (measured in "bounds the orphan window when the consumer
      // bails on a pending next()"). The wall-clock timeout above is what bounds
      // that case -- previously nothing did, and the child was orphaned for good.
      killChild();
      await emitTerminal({
        provider: "codex",
        pid: null,
        status: "stopped",
        summary: "Codex stream stopped by consumer",
        endedAt: new Date().toISOString(),
      });
      cleanupAgentFiles(input.repoPath);
      schemaFile.cleanup();
    }
  }
}

let engineInstance: AiEngineAdapter | null = null;

export function getCodexCliEngine(): AiEngineAdapter {
  if (!engineInstance) {
    engineInstance = new CodexCliEngine();
  }
  return engineInstance;
}
