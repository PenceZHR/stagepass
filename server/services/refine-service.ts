import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
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
import { validateOutputSchema } from "./output-schema-validator";
import {
  parseRefineLineProtocol,
  stripRefineProtocol,
  type Requirement,
} from "./refine-line-protocol";

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

export type { Requirement } from "./refine-line-protocol";

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

/**
 * Second gate over the payload the line protocol assembles, the same shape of
 * check every other stage's `outputSchema` performs. Refine is a chat turn with
 * no run ledger, so it cannot go through runDocumentStage -- the schema is
 * applied here instead, but it is the identical validator
 * (output-schema-validator.ts).
 *
 * `additionalProperties: false` is load-bearing in both directions: it is what
 * makes the parser the ONLY thing that can put a key on a Requirement, and it
 * is what fails if a future edit widens the parser without widening the schema.
 */
export const REFINE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: ["functional", "non-functional", "constraint"] },
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["confirmed", "uncertain", "new"] },
        },
        required: ["id", "category", "title", "description", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["requirements"],
  additionalProperties: false,
};

class RefineOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineOutputError";
  }
}

const REFINE_RAW_CAPTURE_SCHEMA_VERSION = "refine_raw_capture/v1";
const RAW_TEXT_PREVIEW_CHARS = 4_000;

/**
 * Refine's stand-in for persistStageRawCapture, which it cannot use: that
 * writes an artifacts row keyed on a runId, and a refine chat turn has no run.
 * Shape follows prd-service's prdRawCapture for the same reason -- both are
 * chat-turn stages recording provenance on their own event.
 */
function refineRawCapture(result: AiRunResult, rawText: string, parseError: string | null) {
  return {
    schemaVersion: REFINE_RAW_CAPTURE_SCHEMA_VERSION,
    structuredOutputSource: parseError ? "none" : "line_protocol",
    parseError,
    rawTextHash: createHash("sha256").update(rawText, "utf8").digest("hex"),
    rawTextPreview: rawText.slice(0, RAW_TEXT_PREVIEW_CHARS),
    rawTextLength: rawText.length,
    rawTextTruncated: rawText.length > RAW_TEXT_PREVIEW_CHARS,
    // The rule this stage now enforces, recorded as an observation rather than
    // an assumption: the model must not have authored JSON at all.
    modelDeclaredStructuredOutput: result.structuredOutput !== undefined,
  };
}

/**
 * A turn whose output the parser refused must still leave evidence. Without
 * this the failure is a thrown string and the reply is gone -- the same
 * unfalsifiable state tech_spec was in, where the provider had already gone
 * terminal and nothing on disk said what it actually wrote.
 */
async function recordRefineOutputFailure(
  changeId: string,
  result: AiRunResult,
  rawText: string,
  parseError: string,
): Promise<void> {
  const evtId = await nextId(events, "EVT");
  db.insert(events).values({
    id: evtId,
    changeId,
    runId: null,
    type: "chat_assistant",
    message: `Refine 输出被拒绝：${parseError}`.slice(0, 500),
    rawJson: JSON.stringify({
      status: "failed",
      reason: "invalid_refine_output",
      requirements: [],
      rawCapture: refineRawCapture(result, rawText, parseError),
    }),
    createdAt: nowISO(),
  }).run();
}

/**
 * The line protocol is the only accepted source of refine requirements.
 *
 * This replaces a ```requirements fenced JSON.parse whose sole check was
 * `Array.isArray(parsed)`, plus a second AI call (EXTRACTION_PROMPT) that asked
 * the model for "只输出一个 JSON 数组" and JSON.parse'd the first `[...]` it
 * could regex out of the reply. Both were the model authoring the structure,
 * and neither validated a single field -- so a malformed item reached
 * confirmRequirements() and was rendered verbatim into spec.md. The extraction
 * call is gone rather than ported: it was a whole extra provider round trip
 * whose only job was to re-ask for the payload, which the same-thread retry in
 * refineTurn already does, in the thread that has the context.
 */
function parseRefineRequirements(rawText: string): Requirement[] {
  const parsed = parseRefineLineProtocol(rawText);
  if (!parsed.ok) throw new RefineOutputError(parsed.message);
  const schema = validateOutputSchema(REFINE_OUTPUT_SCHEMA, parsed.payload);
  if (schema !== true) {
    throw new RefineOutputError(`refine output failed schema validation: ${schema.message}`);
  }
  return parsed.payload.requirements;
}

/** parseRefineRequirements, with the raw capture written before the throw escapes. */
async function parseRefineRequirementsOrRecord(
  changeId: string,
  result: AiRunResult,
  rawText: string,
): Promise<Requirement[]> {
  try {
    return parseRefineRequirements(rawText);
  } catch (error) {
    if (!(error instanceof RefineOutputError)) throw error;
    await recordRefineOutputFailure(changeId, result, rawText, error.message);
    throw error;
  }
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
  // The chat shows `reply`, which now also carries the protocol: strip it so the
  // human reads prose, not machine syntax.
  const cleanReply = stripRefineProtocol(reply);
  let rawText = reply;
  let requirements = await parseRefineRequirementsOrRecord(changeId, result, reply);

  // Same-thread retry: a turn that asked only clarifying questions has nothing
  // to extract yet, which the parser reports as an empty list rather than an
  // error. Re-asking in the thread that holds the context is the one recovery
  // path; the separate JSON-extractor call that used to sit ahead of it is gone
  // (see parseRefineRequirements).
  if (requirements.length === 0 && result.threadId) {
    log.info({ changeId }, "No REQ lines in reply, asking AI to retry with requirements");
    const retryResult = await runRefineReadOnly(engine, {
      changeId,
      repoPath: project.repoPath,
      phase: "refine",
      threadId: result.threadId,
      prompt: "你的上一条回复没有包含任何 REQ: 行。请根据目前对话中已知的信息，重新输出你的回复，"
        + "末尾必须包含至少一条 REQ: id | functional/non-functional/constraint | confirmed/uncertain/new | 标题 | 描述 行。"
        + "不要输出 JSON。",
      sandboxMode: "read-only",
    });
    const retryReqs = await parseRefineRequirementsOrRecord(changeId, retryResult, retryResult.summary);
    if (retryReqs.length > 0) {
      requirements = retryReqs;
      rawText = retryResult.summary;
      log.info({ changeId, count: retryReqs.length }, "Retry succeeded");
    }
  }

  // Record assistant reply as event (store requirements in rawJson).
  //
  // The raw capture rides along on this event for the same reason every
  // ledger-backed stage writes one: refine has no runs row, so this event is the
  // only place a settled turn can be audited from. Without it, "the model
  // drifted" and "the parser is wrong" are indistinguishable after the fact --
  // which is exactly the hole tech_spec had.
  const asstEvtId = await nextId(events, "EVT");
  db.insert(events).values({
    id: asstEvtId,
    changeId,
    runId: null,
    type: "chat_assistant",
    message: cleanReply.length > 500 ? cleanReply.substring(0, 500) + "..." : cleanReply,
    rawJson: JSON.stringify({
      fullReply: cleanReply,
      requirements,
      rawCapture: refineRawCapture(result, rawText, null),
    }),
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
