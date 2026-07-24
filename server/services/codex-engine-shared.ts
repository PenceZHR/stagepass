import fs from "node:fs";
import path from "node:path";

import { createChildLogger } from "../logger";
import type { AiRunInput, AiRunItem, AiRunPhase } from "./ai-engine-types";
import {
  processIdentityProbe,
  type ProcessIdentityProbe,
} from "./process-identity-service";

const log = createChildLogger("codex-engine-shared");
const DEFAULT_CODEX_HEARTBEAT_MS = 15_000;

let codexProcessIdentityProbeForTest: ProcessIdentityProbe | null = null;

export function setCodexProcessIdentityProbeForTest(
  probe: ProcessIdentityProbe | null,
): () => void {
  const previous = codexProcessIdentityProbeForTest;
  codexProcessIdentityProbeForTest = probe;
  return () => {
    codexProcessIdentityProbeForTest = previous;
  };
}

export function getCodexProcessIdentityProbe(): ProcessIdentityProbe {
  return codexProcessIdentityProbeForTest ?? processIdentityProbe;
}

export const CODEX_BIN_ENV = "STAGEPASS_CODEX_BIN";

export function resolveCodexBin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[CODEX_BIN_ENV]?.trim();
  return override && override.length > 0 ? override : "codex";
}

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
          description:
            "Verifies that applied fixes actually resolve the reported findings.",
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
  lines.push(
    `developer_instructions = """\n${agent.developer_instructions}\n"""`,
  );
  if (agent.sandbox_mode) {
    lines.push(`sandbox_mode = "${agent.sandbox_mode}"`);
  }
  if (agent.model_reasoning_effort) {
    lines.push(
      `model_reasoning_effort = "${agent.model_reasoning_effort}"`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function ensureAgentFiles(
  repoPath: string,
  phase: AiRunPhase,
): string[] {
  const agents = getAgentsForPhase(phase);
  if (agents.length === 0) return [];

  const agentsDir = path.join(repoPath, ".codex", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  const written: string[] = [];
  for (const agent of agents) {
    fs.writeFileSync(
      path.join(agentsDir, `${agent.name}.toml`),
      toToml(agent),
      "utf8",
    );
    written.push(agent.name);
  }

  log.info({ phase, agents: written }, "Wrote Codex agent TOML files");
  return written;
}

export function cleanupAgentFiles(repoPath: string): void {
  const agentsDir = path.join(repoPath, ".codex", "agents");
  if (!fs.existsSync(agentsDir)) return;
  try {
    for (const file of fs.readdirSync(agentsDir)) {
      fs.unlinkSync(path.join(agentsDir, file));
    }
    fs.rmdirSync(agentsDir);
  } catch {
    // Best-effort cleanup must not replace the provider result.
  }
}

export function buildMultiAgentPrompt(
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

export function extractChangedFiles(items: AiRunItem[]): string[] {
  const files: string[] = [];
  for (const item of items) {
    if (item.type !== "file_change") continue;
    const changes = Array.isArray(item.changes) ? item.changes : [];
    for (const change of changes) {
      if (change?.path && !files.includes(change.path)) files.push(change.path);
    }
  }
  return files;
}

let runCounter = 0;

export function generateRunId(): string {
  runCounter += 1;
  return `RUN-${String(runCounter).padStart(3, "0")}`;
}

export function isTimeoutMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("timeout") || normalized.includes("aborted");
}

const CODEX_TRANSPORT_ERROR_MARKERS = [
  "stream disconnected",
  "error sending request",
] as const;

export function codexStderrTail(stderr: string): string {
  return stderr.trim().length === 0
    ? ""
    : sanitizeCodexErrorMessage(stderr.slice(-200));
}

export function hasCodexTransportEvidence(message: string): boolean {
  const normalized = message.toLowerCase();
  return CODEX_TRANSPORT_ERROR_MARKERS.some((marker) =>
    normalized.includes(marker)
  );
}

export class CodexRunFailure extends Error {
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

export function sanitizeCodexErrorMessage(error: unknown): string {
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
  const parsed = Number.parseInt(
    process.env.STAGEPASS_CODEX_HEARTBEAT_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CODEX_HEARTBEAT_MS;
}

export function startCodexHeartbeat(options: {
  lifecycle: NonNullable<AiRunInput["lifecycle"]>;
  pid: number | null;
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
        stopped = true;
        if (interval) clearInterval(interval);
        const failure =
          error instanceof Error ? error : new Error(String(error));
        options.onLifecycleFailure(failure);
        log.error(
          {
            pid: options.pid,
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
