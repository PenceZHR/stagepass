import { eq, and } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { changes, events, artifacts, findings, projects } from "../db/schema";
import { getAiEngine } from "./ai-engine-adapter";
import type { AiEngineAdapter, AiRunInput, AiRunResult, AiProvider } from "./ai-engine-types";
import { assemblePrompt } from "./prompt-service";
import { createChildLogger } from "../logger";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  validateReadOnlyStage,
  type StageViolationResult,
} from "./stage-guard-service";
import {
  transitionChangeStatus,
  transitionChangeStatusWithDb,
} from "./change-status-service";
import {
  recordProviderSession,
  resolveProviderSession,
} from "./provider-session-service";
import type { Provider } from "./provider-selection-service";

const log = createChildLogger("refine-service");

function nowISO(): string {
  return new Date().toISOString();
}

function nextId(
  table: typeof events | typeof artifacts | typeof findings,
  prefix: string,
  idDb: Pick<typeof db, "select"> = db,
): string {
  const rows = idDb.select({ id: table.id }).from(table).all();
  let maxNum = 0;
  for (const row of rows) {
    const match = (row.id as string).match(/\d+$/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[0], 10));
  }
  return `${prefix}-${String(maxNum + 1).padStart(3, "0")}`;
}

class StageBoundaryViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageBoundaryViolationError";
  }
}

async function blockRefineViolation(changeId: string, violation: StageViolationResult): Promise<never> {
  const now = nowISO();
  transitionChangeStatus({
    changeId,
    to: "BLOCKED",
    blockedPhase: "refine",
    message: "Refine stage boundary violation",
    rawJson: { source: "refine_scope", violation },
  });

  const fId = await nextId(findings, "FND");
  db.insert(findings).values({
    id: fId,
    changeId,
    runId: null,
    source: "scope",
    severity: "P0",
    category: "stage-boundary",
    title: "refine stage boundary violation",
    file: violation.files[0] ?? null,
    line: null,
    evidence: violation.files.join(", "),
    requiredFix: "Revert the files changed during refine and restart requirements clarification.",
    status: "open",
    createdAt: now,
  }).run();

  const evtId = await nextId(events, "EVT");
  db.insert(events).values({
    id: evtId,
    changeId,
    runId: null,
    type: "scope_check_failed",
    message: violation.message,
    rawJson: JSON.stringify(violation),
    createdAt: now,
  }).run();

  throw new StageBoundaryViolationError(violation.message);
}

async function runRefineReadOnly(
  engine: AiEngineAdapter,
  input: AiRunInput
): Promise<AiRunResult> {
  const beforeAi = captureWorkspaceSnapshot(input.repoPath);
  const result = await engine.run(input);
  const afterAi = captureWorkspaceSnapshot(input.repoPath);
  const violation = validateReadOnlyStage(
    "refine",
    diffWorkspaceSnapshots(beforeAi, afterAi)
  );
  if (violation.blocked) {
    await blockRefineViolation(input.changeId, violation);
  }
  return result;
}

export interface Requirement {
  id: string;
  category: "functional" | "non-functional" | "constraint";
  title: string;
  description: string;
  status: "confirmed" | "uncertain" | "new";
}

export interface RefineTurnResult {
  reply: string;
  requirements: Requirement[];
}

export interface ConfirmResult {
  spec: string;
}

function assertRefineEntryStatus(changeId: string, status: string): asserts status is "REFINING" | "INTAKE_PENDING" {
  if (status !== "REFINING" && status !== "INTAKE_PENDING") {
    throw new Error(
      `Change ${changeId} is not available for Refine (current: ${status})`,
    );
  }
}

function parseRequirements(reply: string): Requirement[] {
  const match = reply.match(/```requirements\n([\s\S]*?)```/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1].trim());
    if (Array.isArray(parsed)) return parsed;
  } catch {
    log.warn("Failed to parse requirements JSON from AI reply");
  }
  return [];
}

function stripRequirementsBlock(reply: string): string {
  return reply.replace(/```requirements\n[\s\S]*?```/, "").trim();
}

const EXTRACTION_PROMPT = `你是一个 JSON 提取器。根据下面的对话内容，提取出所有已知或可推断的需求条目。

只输出一个 JSON 数组，不要有任何其他文字。格式：
[{"id":"REQ-1","category":"functional","title":"...","description":"...","status":"new"}]

category: functional | non-functional | constraint
status: confirmed（用户明确说了的）| new（可推断但未确认）

对话内容：
`;

async function extractRequirementsFallback(
  engine: AiEngineAdapter,
  repoPath: string,
  changeId: string,
  conversationText: string
): Promise<Requirement[]> {
  try {
    const result = await runRefineReadOnly(engine, {
      changeId,
      repoPath,
      phase: "refine",
      prompt: EXTRACTION_PROMPT + conversationText,
      sandboxMode: "read-only",
    });

    const text = result.summary.trim();
    // Try to find JSON array in the response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        log.info({ changeId, count: parsed.length }, "Fallback extraction succeeded");
        return parsed;
      }
    }
  } catch (err) {
    if (err instanceof StageBoundaryViolationError) {
      throw err;
    }
    log.warn({ changeId, err }, "Fallback extraction failed");
  }
  return [];
}

export async function refineTurn(
  projectId: string,
  changeId: string,
  userMessage: string,
  requestedProvider?: Provider,
): Promise<RefineTurnResult> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);
  assertRefineEntryStatus(changeId, change.status);
  const provider = requestedProvider ?? (change.provider as Provider);
  const sessionId = resolveProviderSession({
    changeId,
    provider,
    sessionKind: "general",
  });

  // Record user message as event
  const userEvtId = await nextId(events, "EVT");
  db.insert(events).values({
    id: userEvtId,
    changeId,
    runId: null,
    type: "chat_user",
    message: userMessage,
    rawJson: null,
    createdAt: nowISO(),
  }).run();

  // Build prompt
  const systemPrompt = assemblePrompt("refine", {
    changeId,
    repoPath: project.repoPath,
  });

  const fullPrompt = sessionId
    ? userMessage
    : `${systemPrompt}\n\n用户的想法：${userMessage}`;

  const engine = getAiEngine(provider as AiProvider);
  const result = await runRefineReadOnly(engine, {
    changeId,
    repoPath: project.repoPath,
    phase: "refine",
    threadId: sessionId ?? undefined,
    prompt: fullPrompt,
    sandboxMode: "read-only",
  });

  const threadId = result.threadId?.trim();
  if (threadId && threadId.toLowerCase() !== "unknown") {
    recordProviderSession({
      changeId,
      provider,
      sessionKind: "general",
      externalSessionId: threadId,
      lastRunId: null,
    });
    if (provider === "codex") {
      db.update(changes)
        .set({ codexThreadId: threadId })
        .where(eq(changes.id, changeId))
        .run();
    }
  }

  const reply = result.summary;
  let requirements = parseRequirements(reply);
  const cleanReply = stripRequirementsBlock(reply);

  // Fallback 1: separate extraction call
  if (requirements.length === 0) {
    log.info({ changeId }, "No requirements block in reply, running extraction fallback");
    requirements = await extractRequirementsFallback(engine, project.repoPath, changeId, cleanReply);
  }

  // Fallback 2: ask AI to retry in the same thread
  if (requirements.length === 0 && result.threadId) {
    log.info({ changeId }, "Extraction fallback also empty, asking AI to retry with requirements");
    const retryResult = await runRefineReadOnly(engine, {
      changeId,
      repoPath: project.repoPath,
      phase: "refine",
      threadId: result.threadId,
      prompt: "你的上一条回复缺少了 ```requirements 代码块。请根据目前对话中已知的信息，重新输出你的回复，末尾必须包含 ```requirements JSON 数组。",
      sandboxMode: "read-only",
    });
    const retryReqs = parseRequirements(retryResult.summary);
    if (retryReqs.length > 0) {
      requirements = retryReqs;
      log.info({ changeId, count: retryReqs.length }, "Retry succeeded");
    }
  }

  // Record assistant reply as event (store requirements in rawJson)
  const asstEvtId = await nextId(events, "EVT");
  db.insert(events).values({
    id: asstEvtId,
    changeId,
    runId: null,
    type: "chat_assistant",
    message: cleanReply.length > 500 ? cleanReply.substring(0, 500) + "..." : cleanReply,
    rawJson: JSON.stringify({ fullReply: cleanReply, requirements }),
    createdAt: nowISO(),
  }).run();

  // Deduplicate requirements by id
  const reqMap = new Map<string, Requirement>();
  for (const r of requirements) reqMap.set(r.id, r);
  requirements = Array.from(reqMap.values());

  log.info({ changeId, reqCount: requirements.length }, "Refine turn completed");
  return { reply: cleanReply, requirements };
}

export async function confirmRequirements(
  projectId: string,
  changeId: string,
  requirements: Requirement[]
): Promise<ConfirmResult> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);
  assertRefineEntryStatus(changeId, change.status);

  // Generate spec from confirmed requirements
  const functional = requirements.filter(r => r.category === "functional");
  const nonFunctional = requirements.filter(r => r.category === "non-functional");
  const constraints = requirements.filter(r => r.category === "constraint");

  const specLines: string[] = [
    `# ${change.title}`,
    "",
    "## 目标",
    change.title,
    "",
    "## 具体需求",
    ...functional.map(r => `- **${r.title}**: ${r.description}`),
    ...nonFunctional.map(r => `- [非功能] **${r.title}**: ${r.description}`),
    "",
    "## 边界条件",
    ...(constraints.length > 0
      ? constraints.map(r => `- ${r.description}`)
      : ["- 无额外约束"]),
    "",
    "## 验收标准",
    ...functional.map(r => `- ${r.title} 功能正常工作`),
  ];

  const spec = specLines.join("\n");

  // Stage the mirror before opening the DB transaction. It is renamed only after
  // every guarded DB mutation succeeds.
  const changeDir = path.join(project.repoPath, ".ship", "changes", changeId);
  fs.mkdirSync(changeDir, { recursive: true });
  const specPath = path.join(changeDir, "spec.md");
  const stagingDir = fs.mkdtempSync(path.join(changeDir, ".spec-stage-"));
  const stagedSpecPath = path.join(stagingDir, "spec.md");
  let previousSpec: Buffer | null = null;
  let mirrorReplaced = false;

  try {
    previousSpec = fs.existsSync(specPath) ? fs.readFileSync(specPath) : null;
    fs.writeFileSync(stagedSpecPath, spec);
    db.transaction((transaction) => {
      const tx = transaction as unknown as typeof db;
      const current = tx.select().from(changes).where(eq(changes.id, changeId)).get();
      if (!current || current.status !== change.status) {
        throw new Error(`Change ${changeId} status changed while confirming requirements`);
      }

      tx.delete(artifacts)
        .where(and(eq(artifacts.changeId, changeId), eq(artifacts.type, "spec")))
        .run();

      // The delete acquires SQLite's write lock. Rechecking afterwards gives the
      // confirmation a CAS boundary before any replacement artifact is stored.
      const claimed = tx.select().from(changes).where(eq(changes.id, changeId)).get();
      if (!claimed || claimed.status !== change.status) {
        throw new Error(`Change ${changeId} status changed while confirming requirements`);
      }

      if (change.status === "REFINING") {
        transitionChangeStatusWithDb(tx, {
          changeId,
          to: "DRAFT",
          message: "Status → DRAFT (requirements confirmed)",
          rawJson: { requirements },
        });
      }

      const artId = nextId(artifacts, "ART", tx);
      tx.insert(artifacts).values({
        id: artId,
        changeId,
        runId: null,
        type: "spec",
        path: specPath,
        createdAt: nowISO(),
      }).run();

      fs.renameSync(stagedSpecPath, specPath);
      mirrorReplaced = true;
    });
  } catch (error) {
    if (mirrorReplaced) {
      if (previousSpec !== null) fs.writeFileSync(specPath, previousSpec);
      else fs.rmSync(specPath, { force: true });
    }
    throw error;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  log.info(
    { changeId, reqCount: requirements.length, status: change.status },
    change.status === "REFINING"
      ? "Requirements confirmed, transitioning to DRAFT"
      : "Requirements confirmed, preserving PRD briefing entry state",
  );
  return { spec };
}
