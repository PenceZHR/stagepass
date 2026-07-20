import { eq, and, notInArray, isNull, or } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { projects, changes, events } from "../db/schema";
import { getAiEngine } from "./ai-engine-adapter";
import type { AiEngineAdapter, AiRunInput, AiRunResult } from "./ai-engine-types";
import { assemblePrompt } from "./prompt-service";
import { initializeProjectContext } from "./context-init-service";
import { resolveProvider } from "./ai-provider-service";
import { createChildLogger } from "../logger";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  type WorkspaceMutation,
  type StageViolationResult,
} from "./stage-guard-service";
import {
  readStructuredPrd,
  savePrd,
  validatePrd,
  upgradeLegacyMarkdown,
} from "./prd-document-service";
import { StructuredPrdSchema, type StructuredPrd, type PrdValidationResult } from "../types/prd";
import { parsePrdLineProtocol, stripPrdProtocol } from "./prd-line-protocol";
import type { PrdStatus, ChangeStatus, AiProvider } from "../types";
import { transitionChangeStatus } from "./change-status-service";
import {
  DEFAULT_AI_PROVIDER_TIMEOUT_MS,
  resolveAiProviderTimeoutMs,
} from "./ai-timeout-policy";

const log = createChildLogger("prd-service");

function nowISO(): string {
  return new Date().toISOString();
}

async function nextEventId(): Promise<string> {
  const rows = db.select({ id: events.id }).from(events).all();
  const used = new Set<string>();
  let maxNum = 0;
  for (const row of rows) {
    const id = row.id as string;
    used.add(id);
    const match = id.match(/^EVT-(\d+)$/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }
  let nextNum = maxNum + 1;
  let candidate = `EVT-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `EVT-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

export interface PrdTurnResult {
  assistantMessage: string;
  prdContent: string | null;
  done: boolean;
}

export class PrdTurnFailedError extends Error {
  constructor(message: string, public readonly statusCode = 502) {
    super(message);
    this.name = "PrdTurnFailedError";
  }
}

const VALID_TRANSITIONS: Record<PrdStatus, PrdStatus[]> = {
  none: ["drafting"],
  drafting: ["ready", "failed"],
  ready: ["revising"],
  revising: ["ready", "failed"],
  failed: ["drafting", "revising"],
};

function assertTransition(current: PrdStatus, next: PrdStatus): void {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed || !allowed.includes(next)) {
    throw new Error(`Invalid PRD status transition: ${current} → ${next}`);
  }
}

function updatePrdStatus(projectId: string, status: PrdStatus): void {
  db.update(projects)
    .set({ prdStatus: status, updatedAt: nowISO() })
    .where(eq(projects.id, projectId))
    .run();
}

function getProjectOrThrow(projectId: string) {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

function getPrdPath(repoPath: string): string {
  return path.join(repoPath, ".ship", "prd.md");
}

function readPrd(repoPath: string): string | null {
  const prdPath = getPrdPath(repoPath);
  if (!fs.existsSync(prdPath)) return null;
  return fs.readFileSync(prdPath, "utf-8");
}

function getPrdEngine(provider: AiProvider): AiEngineAdapter {
  return getAiEngine(provider);
}

async function writePrdAssistantEvent(
  projectId: string,
  message: string,
  provider: AiProvider,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const evtId = await nextEventId();
  db.insert(events).values({
    id: evtId,
    changeId: null,
    runId: null,
    type: "prd_assistant",
    message,
    rawJson: JSON.stringify({ projectId, phase: "prd", provider, ...extra }),
    createdAt: nowISO(),
  }).run();
}

async function failPrdTurn(
  projectId: string,
  message: string,
  provider: AiProvider,
  failedFrom: "drafting" | "revising",
  extra: Record<string, unknown> = {},
  statusCode = 502
): Promise<never> {
  await writePrdAssistantEvent(projectId, message, provider, {
    status: "failed",
    failedFrom,
    ...extra,
  });
  updatePrdStatus(projectId, "failed");
  throw new PrdTurnFailedError(message, statusCode);
}

const PRD_ALLOWED_FILES = [".ship/prd.md", ".ship/prd.json", ".ship/prd-sources.md"];

export function validatePrdStage(mutations: WorkspaceMutation[]): StageViolationResult {
  const violatingFiles = mutations
    .map((m) => m.path)
    .filter((p) => !PRD_ALLOWED_FILES.includes(p));

  return {
    blocked: violatingFiles.length > 0,
    stage: "refine" as const,
    files: violatingFiles,
    message: violatingFiles.length > 0
      ? `PRD stage modified files outside allowed set: ${violatingFiles.join(", ")}`
      : "",
  };
}

export interface PrdMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

const DEFAULT_PRD_TIMEOUT_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;

function getPrdTimeoutMs(): number {
  return resolveAiProviderTimeoutMs("STAGEPASS_PRD_TIMEOUT_MS", DEFAULT_PRD_TIMEOUT_MS);
}

function isProviderTimeoutResult(result: AiRunResult): boolean {
  if (result.providerErrorCode === "provider_timeout") return true;
  const detail = `${result.providerErrorDetail ?? ""}\n${result.summary ?? ""}`.toLowerCase();
  return detail.includes("provider_timeout") ||
    detail.includes("timed out") ||
    detail.includes("operation was aborted") ||
    detail.includes("aborted");
}

function prdEngineFailureMessage(result: AiRunResult): string {
  const detail = result.providerErrorDetail?.trim() || result.summary?.trim();
  if (isProviderTimeoutResult(result)) {
    const suffix = detail ? `原始错误：${detail}` : "请稍后重试。";
    return `PRD 生成失败：AI 引擎超时或被中止。${suffix}`;
  }
  return detail
    ? `PRD 生成失败：${detail}`
    : "PRD 生成失败：AI 引擎没有返回可用的错误详情，请稍后重试。";
}

function safeStructuredPrd(value: unknown): StructuredPrd | null {
  const parsed = StructuredPrdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

interface PrdCandidate {
  structured: StructuredPrd;
  source: "lineProtocol";
  validation: PrdValidationResult;
}

/**
 * Raw capture for a project-scoped stage.
 *
 * Every change-scoped line-protocol stage records the model's reply through
 * persistStageRawCapture(), which is what makes "what did the model actually
 * write?" answerable after the fact. That machinery cannot be reused here:
 * `artifacts.change_id` is NOT NULL with a foreign key into `changes`, and this
 * stage is project-scoped (there is no change row to hang an artifact on). So
 * the same evidence rides on the project-scoped prd_assistant event instead --
 * the raw reply plus how it was interpreted.
 */
function prdRawCapture(result: AiRunResult, parseError: string | null) {
  const rawText = result.summary ?? "";
  return {
    schemaVersion: "prd_raw_capture/v1",
    structuredOutputSource: parseError ? "none" : "lineProtocol",
    parseError,
    rawText,
    rawTextLength: rawText.length,
    // The rule this stage exists to enforce, recorded as an observation rather
    // than an assumption: the model must not have authored JSON at all.
    modelDeclaredStructuredOutput: result.structuredOutput !== undefined,
  };
}

/**
 * The line protocol is the only accepted source of a PRD.
 *
 * This stage used to resolve a candidate from whichever channel answered first:
 * provider-native structuredOutput, a .ship/prd.json the model wrote by hand, a
 * .ship/prd.md parsed back into structure, or PRD-shaped markdown in the chat
 * summary. Every one of those is the model authoring the document's structure
 * itself — the failure class this protocol removes. stagepass now assembles the
 * payload from protocol lines and writes both artifacts via savePrd(), so those
 * channels are refused rather than resurrected. `parseError` carries the
 * parser's message into the turn's failure detail so a retry can act on it.
 *
 * The refusal is structural: parsing protocol lines out of `summary` is the
 * only branch here, so there is nothing for a model-authored payload to travel
 * through. `result.structuredOutput` is deliberately never read -- if a future
 * edit reintroduces it as a fallback, the "refuses to resurrect
 * model-authored structuredOutput" test fails.
 */
function resolvePrdCandidate(
  result: AiRunResult,
): { candidate: PrdCandidate | null; parseError: string | null } {
  const parsed = parsePrdLineProtocol(result.summary ?? "");
  if (!parsed.ok) {
    return { candidate: null, parseError: parsed.message };
  }
  // Second gate: StructuredPrdSchema still validates the payload stagepass
  // assembled, exactly as it validated a model-authored one.
  const structured = safeStructuredPrd(parsed.payload);
  if (!structured) {
    return { candidate: null, parseError: "assembled PRD failed StructuredPrdSchema" };
  }
  return {
    candidate: {
      structured,
      source: "lineProtocol",
      validation: validatePrd(structured),
    },
    parseError: null,
  };
}

function getLatestFailedPrdEventRaw(projectId: string): Record<string, unknown> | null {
  const row = db
    .select()
    .from(events)
    .where(and(isNull(events.changeId), eq(events.type, "prd_assistant")))
    .all()
    .filter((event) => {
      try {
        const raw = JSON.parse(event.rawJson || "{}");
        return raw.projectId === projectId && raw.status === "failed";
      } catch {
        return false;
      }
    })
    .sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    )[0];

  if (!row?.rawJson) return null;
  try {
    return JSON.parse(row.rawJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getLatestFailedFrom(projectId: string): "drafting" | "revising" | null {
  const raw = getLatestFailedPrdEventRaw(projectId);
  return raw?.failedFrom === "revising" ? "revising" : raw?.failedFrom === "drafting" ? "drafting" : null;
}

function getProviderTimeoutResumeThreadId(
  projectId: string,
  provider: AiProvider,
): string | undefined {
  const raw = getLatestFailedPrdEventRaw(projectId);
  if (
    raw?.reason !== "provider_timeout"
    || raw.provider !== provider
    || typeof raw.engineThreadId !== "string"
  ) {
    return undefined;
  }
  const threadId = raw.engineThreadId.trim();
  return threadId && threadId.toLowerCase() !== "unknown" ? threadId : undefined;
}

function inferFailedRetryState(projectId: string, repoPath: string): "drafting" | "revising" {
  const previous = getLatestFailedFrom(projectId);
  if (previous) return previous;
  return readStructuredPrd(projectId) || readPrd(repoPath)?.trim() ? "revising" : "drafting";
}

function prdValidationDraftMessage(validation: PrdValidationResult): string {
  const errors = validation.issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return "";
  const preview = errors.slice(0, 3).map((issue) => `- ${issue.message}`).join("\n");
  const suffix = errors.length > 3 ? `\n- 另有 ${errors.length - 3} 个校验问题` : "";
  return `\n\n已保存为 PRD 草稿，但仍有校验问题，确认前需要补齐：\n${preview}${suffix}`;
}

export function getPrdHistory(projectId: string): PrdMessage[] {
  const rows = db
    .select()
    .from(events)
    .where(
      and(
        isNull(events.changeId),
        or(
          eq(events.type, "prd_user"),
          eq(events.type, "prd_assistant")
        )
      )
    )
    .all()
    .filter((e) => {
      try {
        const raw = JSON.parse(e.rawJson || "{}");
        return raw.projectId === projectId;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return rows.map((e) => ({
    role: e.type === "prd_user" ? "user" as const : "assistant" as const,
    content: e.message || "",
    createdAt: e.createdAt,
  }));
}

export async function startPrd(projectId: string): Promise<void> {
  const project = getProjectOrThrow(projectId);
  assertTransition(project.prdStatus as PrdStatus, "drafting");
  updatePrdStatus(projectId, "drafting");
  log.info({ projectId }, "PRD drafting started");
}

export async function prdTurn(
  projectId: string,
  userMessage: string,
  provider?: AiProvider
): Promise<PrdTurnResult> {
  const project = getProjectOrThrow(projectId);
  const activePrdStatus = project.prdStatus === "failed"
    ? inferFailedRetryState(projectId, project.repoPath)
    : project.prdStatus as PrdStatus;

  if (activePrdStatus !== "drafting" && activePrdStatus !== "revising") {
    throw new Error(`Cannot run PRD turn in status: ${project.prdStatus}`);
  }
  if (project.prdStatus === "failed") {
    updatePrdStatus(projectId, activePrdStatus);
  }

  const resolvedProvider = resolveProvider(
    provider,
    project.prdProvider as AiProvider | null | undefined
  );
  const retryThreadId = project.prdStatus === "failed"
    ? getProviderTimeoutResumeThreadId(projectId, resolvedProvider)
    : undefined;

  // Save user message to events for history persistence
  const userEvtId = await nextEventId();
  db.insert(events).values({
    id: userEvtId,
    changeId: null,
    runId: null,
    type: "prd_user",
    message: userMessage,
    rawJson: JSON.stringify({ projectId, phase: "prd", provider: resolvedProvider }),
    createdAt: nowISO(),
  }).run();

  const engine = getPrdEngine(resolvedProvider);
  const prdContent = readPrd(project.repoPath);
  const contextBlock = prdContent ? `\n\n## 当前 PRD 内容\n\n${prdContent}\n` : "";

  // Build conversation history from events
  const history = getPrdHistory(projectId);
  const historyBlock = history.length > 0
    ? `\n\n## 对话历史\n\n${history.map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`).join("\n\n")}\n`
    : "";

  const prompt = assemblePrompt("prd", {
    changeId: "__prd__",
    repoPath: project.repoPath,
  }) + contextBlock + historyBlock + `\n\n## 用户最新消息\n\n${userMessage}`;

  const snapshotBefore = captureWorkspaceSnapshot(project.repoPath);

  const input: AiRunInput = {
    changeId: "__prd__",
    repoPath: project.repoPath,
    phase: "refine",
    prompt,
    // Line-protocol stage: the model writes protocol lines in its reply, never
    // JSON, and no longer writes .ship/prd.* itself — stagepass renders both
    // artifacts from the assembled payload, so this turn only needs to read.
    outputMode: "json_schema",
    sandboxMode: "read-only",
    timeoutMs: getPrdTimeoutMs(),
    threadId: retryThreadId,
  };

  let result: AiRunResult;
  try {
    result = await engine.run(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failPrdTurn(projectId, `PRD 生成失败：${message}`, resolvedProvider, activePrdStatus, {
      reason: "engine_exception",
    });
  }

  if (result.success !== true) {
    const message = prdEngineFailureMessage(result);
    const reason = isProviderTimeoutResult(result) ? "provider_timeout" : "engine_failed";
    return failPrdTurn(projectId, message, resolvedProvider, activePrdStatus, {
      runId: result.runId,
      engineThreadId: result.threadId,
      reason,
    });
  }

  // The chat shows `summary`, which now also carries the protocol: strip it so
  // the human reads prose, not machine syntax.
  const assistantMessage = stripPrdProtocol(result.summary ?? "");

  const snapshotAfter = captureWorkspaceSnapshot(project.repoPath);
  const mutations = diffWorkspaceSnapshots(snapshotBefore, snapshotAfter);

  if (mutations.length > 0) {
    const violation = validatePrdStage(mutations);
    if (violation.blocked) {
      log.warn({ projectId, files: violation.files }, "PRD stage boundary violation");
      return failPrdTurn(
        projectId,
        `PRD 阶段越界：只允许修改 .ship/prd.md，但还修改了: ${violation.files.join(", ")}`,
        resolvedProvider,
        activePrdStatus,
        {
          runId: result.runId,
          engineThreadId: result.threadId,
          reason: "stage_boundary_violation",
          files: violation.files,
        },
        409
      );
    }
  }

  const { candidate, parseError } = resolvePrdCandidate(result);
  if (!candidate) {
    const reason = result.summary?.trim() ? "unparseable_prd_content" : "empty_prd_content";
    const message = reason === "empty_prd_content"
      ? "PRD 生成没有返回有效回复。PRD 生成没有产出文档内容，请补充需求后重试。"
      : `PRD 生成产物无法解析为 PRD 文档，请补充需求后重试。${parseError ? `（${parseError}）` : ""}`;
    return failPrdTurn(projectId, message, resolvedProvider, activePrdStatus, {
      runId: result.runId,
      engineThreadId: result.threadId,
      reason,
      rawCapture: prdRawCapture(result, parseError),
    });
  }

  savePrd(projectId, candidate.structured, project.repoPath);
  const updatedPrd = readPrd(project.repoPath);
  const finalAssistantMessage = (assistantMessage || "PRD 草稿已更新。")
    + prdValidationDraftMessage(candidate.validation);

  await writePrdAssistantEvent(projectId, finalAssistantMessage, resolvedProvider, {
    status: "completed",
    runId: result.runId,
    engineThreadId: result.threadId,
    prdSource: candidate.source,
    validation: candidate.validation,
    rawCapture: prdRawCapture(result, null),
  });

  return {
    assistantMessage: finalAssistantMessage,
    prdContent: updatedPrd,
    done: false,
  };
}

export async function confirmPrd(projectId: string): Promise<PrdValidationResult> {
  const project = getProjectOrThrow(projectId);
  assertTransition(project.prdStatus as PrdStatus, "ready");

  const prdContent = readPrd(project.repoPath);
  if (!prdContent || prdContent.trim().length === 0) {
    throw new Error("Cannot confirm PRD: no PRD content found");
  }

  // Try structured validation if available
  const structured = readStructuredPrd(projectId);
  if (structured) {
    const validation = validatePrd(structured);
    if (!validation.valid) {
      return validation;
    }
  }

  updatePrdStatus(projectId, "ready");

  // Sync to DB if structured exists but markdown wasn't saved yet
  if (structured && !project.prdMarkdown) {
    savePrd(projectId, structured, project.repoPath);
  }

  const evtId = await nextEventId();
  db.insert(events).values({
    id: evtId,
    changeId: null,
    runId: null,
    type: "change_status_changed",
    message: `PRD confirmed for project ${projectId}`,
    rawJson: JSON.stringify({ projectId, prdStatus: "ready" }),
    createdAt: nowISO(),
  }).run();

  initializeProjectContext(
    projectId,
    resolveProvider(undefined, project.contextProvider as AiProvider | null | undefined)
  ).catch((err) => {
    log.error({ projectId, err }, "Context init after PRD confirm failed");
  });

  log.info({ projectId }, "PRD confirmed, context init triggered");
  return { valid: true, issues: [] };
}

const TERMINAL_STATUSES: ChangeStatus[] = ["LOCAL_READY", "BLOCKED", "DONE"];

export async function startPrdRevision(projectId: string): Promise<void> {
  const project = getProjectOrThrow(projectId);
  assertTransition(project.prdStatus as PrdStatus, "revising");

  const activeChanges = db
    .select()
    .from(changes)
    .where(
      and(
        eq(changes.projectId, projectId),
        notInArray(changes.status, TERMINAL_STATUSES)
      )
    )
    .all();

  const now = nowISO();
  for (const change of activeChanges) {
    db.update(changes)
      .set({
        preSuspendStatus: change.status,
        suspendedByPrd: 1,
        updatedAt: now,
      })
      .where(eq(changes.id, change.id))
      .run();
    transitionChangeStatus({
      changeId: change.id,
      to: "BLOCKED",
      blockedPhase: "prd",
      message: `Suspended by PRD revision (was ${change.status})`,
      rawJson: { reason: "prd_revision" },
    });
  }

  updatePrdStatus(projectId, "revising");
  log.info({ projectId, suspendedCount: activeChanges.length }, "PRD revision started, changes suspended");
}

export async function confirmPrdRevision(projectId: string): Promise<PrdValidationResult> {
  const project = getProjectOrThrow(projectId);
  assertTransition(project.prdStatus as PrdStatus, "ready");

  const prdContent = readPrd(project.repoPath);
  if (!prdContent || prdContent.trim().length === 0) {
    throw new Error("Cannot confirm PRD revision: no PRD content found");
  }

  const structured = readStructuredPrd(projectId);
  if (structured) {
    const validation = validatePrd(structured);
    if (!validation.valid) {
      return validation;
    }
  }

  const suspendedChanges = db
    .select()
    .from(changes)
    .where(
      and(
        eq(changes.projectId, projectId),
        eq(changes.suspendedByPrd, 1)
      )
    )
    .all();

  const now = nowISO();
  for (const change of suspendedChanges) {
    const restoreStatus = (change.preSuspendStatus || "DRAFT") as ChangeStatus;
    transitionChangeStatus({
      changeId: change.id,
      to: restoreStatus,
      message: `Restored after PRD revision (→ ${restoreStatus})`,
      rawJson: { reason: "prd_revision_complete" },
    });
    db.update(changes)
      .set({
        suspendedByPrd: 0,
        preSuspendStatus: null,
        updatedAt: now,
      })
      .where(eq(changes.id, change.id))
      .run();
  }

  updatePrdStatus(projectId, "ready");
  log.info({ projectId, restoredCount: suspendedChanges.length }, "PRD revision confirmed, changes restored");
  return { valid: true, issues: [] };
}

export async function getPrdStatus(projectId: string): Promise<{
  status: PrdStatus;
  prdProvider: AiProvider;
  content: string | null;
  structured: StructuredPrd | null;
  validation: PrdValidationResult | null;
}> {
  const project = getProjectOrThrow(projectId);
  const content = readPrd(project.repoPath);
  const structured = readStructuredPrd(projectId);
  const validation = structured ? validatePrd(structured) : null;
  return {
    status: project.prdStatus as PrdStatus,
    prdProvider: resolveProvider(undefined, project.prdProvider as AiProvider | null | undefined),
    content,
    structured,
    validation,
  };
}

export async function upgradePrd(projectId: string): Promise<StructuredPrd> {
  const project = getProjectOrThrow(projectId);

  // Prefer structured JSON from disk if valid
  const jsonPath = path.join(project.repoPath, ".ship", "prd.json");
  if (fs.existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const parsed = StructuredPrdSchema.parse(raw);
      savePrd(projectId, parsed, project.repoPath);
      log.info({ projectId }, "PRD synced from .ship/prd.json to DB");
      return parsed;
    } catch (err) {
      log.warn({ projectId, err }, "Failed to parse .ship/prd.json, falling back to markdown");
    }
  }

  const markdown = readPrd(project.repoPath);
  if (!markdown) {
    throw new Error("No existing PRD to upgrade");
  }
  const structured = upgradeLegacyMarkdown(markdown);
  savePrd(projectId, structured, project.repoPath);
  log.info({ projectId }, "Legacy PRD upgraded to structured format");
  return structured;
}

export async function saveStructuredPrd(projectId: string, prd: StructuredPrd): Promise<void> {
  const project = getProjectOrThrow(projectId);
  savePrd(projectId, prd, project.repoPath);
}
