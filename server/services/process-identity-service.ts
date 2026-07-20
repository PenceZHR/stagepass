import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

export interface ProcessIdentity {
  pid: number;
  ppid: number | null;
  pgid: number | null;
  nonce: string;
  processStartTime: string;
  cwd: string;
  command: string[];
}

export type ProcessIdentityField = keyof ProcessIdentity;

export type ProcessIdentityProbeFailureReason =
  | "probe_timeout"
  | "probe_output_limit"
  | "probe_failed";

export interface ProcessIdentityCommandOptions {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  killSignal: NodeJS.Signals;
}

export type ProcessIdentityCommandRunner = (
  file: string,
  args: readonly string[],
  options: ProcessIdentityCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface PlatformProcessIdentityProbeOptions {
  commandRunner?: ProcessIdentityCommandRunner;
  timeoutMs?: number;
}

export class ProcessIdentityProbeError extends Error {
  constructor(readonly code: ProcessIdentityProbeFailureReason) {
    super(
      code === "probe_timeout"
        ? "Process identity probe timed out"
        : code === "probe_output_limit"
          ? "Process identity probe output exceeded limit"
          : "Process identity probe failed",
    );
    this.name = "ProcessIdentityProbeError";
  }
}

export class ProcessIdentityMismatchError extends Error {
  readonly code = "process_identity_mismatch";

  constructor(
    readonly field: ProcessIdentityField,
    readonly expected: ProcessIdentity[ProcessIdentityField],
    readonly observed: ProcessIdentity[ProcessIdentityField],
  ) {
    super(`Process identity mismatch for ${field}`);
    this.name = "ProcessIdentityMismatchError";
  }
}

export interface ProcessIdentityProbe {
  capture(pid: number, expected?: Partial<ProcessIdentity>): Promise<ProcessIdentity>;
  validate(expected: ProcessIdentity): Promise<ProcessIdentityValidationResult>;
}

export type ProcessIdentityValidationFailureReason =
  | "pid_missing"
  | "pid_reused"
  | "ppid_dead"
  | "ppid_mismatch"
  | "cwd_mismatch"
  | "command_mismatch"
  | "nonce_mismatch"
  | ProcessIdentityProbeFailureReason;

export type ProcessIdentityValidationResult =
  | { ok: true; observed: ProcessIdentity }
  | {
    ok: false;
    reason: ProcessIdentityValidationFailureReason;
    observed?: Partial<ProcessIdentity>;
  };

const execFileAsync = promisify(execFile);
const DEFAULT_PROBE_TIMEOUT_MS = 750;
const PROBE_MAX_BUFFER_BYTES = 32 * 1024;
const PROBE_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
type BoundedCommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

class ProcessMissingError extends Error {}
class ProcessCommandExitError extends Error {}

interface ObservedProcess {
  ppid: number | null;
  pgid: number | null;
  processStartTime: string;
  command: string[];
}

function isErrorRecord(error: unknown): error is Record<string, unknown> {
  return error !== null && typeof error === "object";
}

function commandFailure(error: unknown): Error {
  if (error instanceof ProcessIdentityProbeError) return error;
  if (isErrorRecord(error) && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new ProcessIdentityProbeError("probe_output_limit");
  }
  if (
    isErrorRecord(error)
    && (error.killed === true || error.code === "ETIMEDOUT" || error.code === "ERR_CHILD_PROCESS_TIMEOUT")
  ) {
    return new ProcessIdentityProbeError("probe_timeout");
  }
  if (isErrorRecord(error) && typeof error.code === "number") {
    return new ProcessCommandExitError();
  }
  return new ProcessIdentityProbeError("probe_failed");
}

const defaultCommandRunner: ProcessIdentityCommandRunner = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], options);
  return { stdout: String(stdout), stderr: String(stderr) };
};

function boundedCommandRunner(
  runner: ProcessIdentityCommandRunner,
  timeoutMs: number,
): BoundedCommandRunner {
  const commandOptions: ProcessIdentityCommandOptions = {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: PROBE_MAX_BUFFER_BYTES,
    killSignal: PROBE_KILL_SIGNAL,
  };
  return async (file, args) => {
    try {
      return await runner(file, args, commandOptions);
    } catch (error) {
      throw commandFailure(error);
    }
  };
}

async function observeWithPs(
  pid: number,
  runCommand: BoundedCommandRunner,
): Promise<ObservedProcess> {
  try {
    const { stdout } = await runCommand(
      "ps",
      ["-o", "ppid=", "-o", "pgid=", "-o", "lstart=", "-o", "command=", "-p", String(pid)],
    );
    const line = stdout.trim();
    const match = line.match(
      /^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
    );
    if (!match) throw new ProcessMissingError(`Process ${pid} is not observable`);
    return {
      ppid: Number(match[1]) || null,
      pgid: Number(match[2]) || null,
      processStartTime: new Date(match[3]).toISOString(),
      command: [match[4]],
    };
  } catch (error) {
    if (error instanceof ProcessMissingError || error instanceof ProcessIdentityProbeError) {
      throw error;
    }
    throw new ProcessMissingError(`Process ${pid} is not observable`);
  }
}

/**
 * lsof's -F field output escapes bytes >= 0x80 (and other specials) as literal
 * `\xNN` sequences. A repo under a non-ASCII directory (e.g. a CJK-named path
 * like `/home/dev/项目`) therefore comes back as ASCII escapes that never
 * `===` the real UTF-8 path from fs.realpathSync, making every cwd identity
 * check fail. Decode the escapes back into the real path before comparing.
 */
export function decodeLsofName(raw: string): string {
  if (!raw.includes("\\x")) return raw;
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; ) {
    if (
      raw[i] === "\\" && raw[i + 1] === "x"
      && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 2, i + 4))
    ) {
      bytes.push(parseInt(raw.slice(i + 2, i + 4), 16));
      i += 4;
    } else {
      bytes.push(raw.charCodeAt(i) & 0xff);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf-8");
}

async function observeCwd(pid: number, runCommand: BoundedCommandRunner): Promise<string> {
  if (pid === process.pid) return process.cwd();
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      throw new ProcessMissingError(`Process ${pid} cwd is not observable`);
    }
  }

  try {
    const { stdout } = await runCommand(
      "lsof",
      ["-a", "-d", "cwd", "-Fn", "-p", String(pid)],
    );
    const cwdLine = stdout.split(/\r?\n/).find((line) => line.startsWith("n"));
    if (!cwdLine) throw new ProcessMissingError(`Process ${pid} cwd is not observable`);
    return decodeLsofName(cwdLine.slice(1));
  } catch (error) {
    if (error instanceof ProcessMissingError || error instanceof ProcessIdentityProbeError) {
      throw error;
    }
    throw new ProcessMissingError(`Process ${pid} cwd is not observable`);
  }
}

async function observeLinuxCommand(pid: number): Promise<string[] | null> {
  if (process.platform !== "linux") return null;
  try {
    const command = await readFile(`/proc/${pid}/cmdline`);
    const args = command.toString("utf8").split("\0").filter(Boolean);
    return args.length > 0 ? args : null;
  } catch {
    return null;
  }
}

function identityNonce(identity: Omit<ProcessIdentity, "nonce">): string {
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 32);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && String(error.code) === "EPERM",
    );
  }
}

function identityFieldMatches(
  field: ProcessIdentityField,
  expected: ProcessIdentity[ProcessIdentityField],
  observed: ProcessIdentity[ProcessIdentityField],
): boolean {
  if (field === "command") {
    return JSON.stringify(observed) === JSON.stringify(expected);
  }
  return observed === expected;
}

function assertExpectedIdentity(
  observed: ProcessIdentity,
  expected: Partial<ProcessIdentity>,
): void {
  const fields: ProcessIdentityField[] = [
    "pid",
    "ppid",
    "pgid",
    "cwd",
    "command",
    "processStartTime",
    "nonce",
  ];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(expected, field)) continue;
    const expectedValue = expected[field] as ProcessIdentity[ProcessIdentityField];
    const observedValue = observed[field] as ProcessIdentity[ProcessIdentityField];
    if (!identityFieldMatches(field, expectedValue, observedValue)) {
      throw new ProcessIdentityMismatchError(field, expectedValue, observedValue);
    }
  }
}

class PlatformProcessIdentityProbe implements ProcessIdentityProbe {
  private readonly runCommand: BoundedCommandRunner;

  constructor(options: PlatformProcessIdentityProbeOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Process identity probe timeout must be a positive finite number");
    }
    this.runCommand = boundedCommandRunner(options.commandRunner ?? defaultCommandRunner, timeoutMs);
  }

  async capture(pid: number, expected?: Partial<ProcessIdentity>): Promise<ProcessIdentity> {
    const observed = await observeWithPs(pid, this.runCommand);
    const cwd = await observeCwd(pid, this.runCommand);
    const command = await observeLinuxCommand(pid) ?? observed.command;
    const identityWithoutNonce = {
      pid,
      ppid: observed.ppid,
      pgid: observed.pgid,
      processStartTime: observed.processStartTime,
      cwd,
      command,
    };
    const identity = {
      ...identityWithoutNonce,
      nonce: identityNonce(identityWithoutNonce),
    };
    if (expected) assertExpectedIdentity(identity, expected);
    return identity;
  }

  async validate(expected: ProcessIdentity): Promise<ProcessIdentityValidationResult> {
    let observed: ProcessIdentity;
    try {
      observed = await this.capture(expected.pid);
    } catch (error) {
      if (error instanceof ProcessMissingError) {
        return { ok: false, reason: "pid_missing" };
      }
      if (error instanceof ProcessIdentityProbeError) {
        return { ok: false, reason: error.code };
      }
      throw error;
    }

    if (observed.processStartTime !== expected.processStartTime) {
      return { ok: false, reason: "pid_reused", observed };
    }
    if (expected.ppid !== null && !processExists(expected.ppid)) {
      return { ok: false, reason: "ppid_dead", observed };
    }
    if (observed.ppid !== expected.ppid) {
      return { ok: false, reason: "ppid_mismatch", observed };
    }
    if (observed.cwd !== expected.cwd) {
      return { ok: false, reason: "cwd_mismatch", observed };
    }
    if (JSON.stringify(observed.command) !== JSON.stringify(expected.command)) {
      return { ok: false, reason: "command_mismatch", observed };
    }
    if (observed.nonce !== expected.nonce) {
      return { ok: false, reason: "nonce_mismatch", observed };
    }
    return { ok: true, observed };
  }
}

export function createPlatformProcessIdentityProbe(
  options: PlatformProcessIdentityProbeOptions = {},
): ProcessIdentityProbe {
  return new PlatformProcessIdentityProbe(options);
}

export const processIdentityProbe: ProcessIdentityProbe = createPlatformProcessIdentityProbe();
