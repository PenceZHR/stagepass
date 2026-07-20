import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runLedgerRepository } from "../repositories/run-ledger-repository";
import type { StageAiRawCaptureEnvelope } from "./stage-ai-output-contract";

const STAGE_RAW_OUTPUT_EVENT_SCHEMA_VERSION = "stage_raw_output_event/v1";
const STAGE_RAW_OUTPUT_ARTIFACT_TYPE = "stage_raw_output";
const DEFAULT_RAW_OUTPUT_FILE_NAME = "raw-ai-output.json";
const MAX_LEDGER_INSERT_ATTEMPTS = 5;

type LedgerPrefix = "ART" | "EVT";
type MaybePromise<T> = T | Promise<T>;

export interface StageRawCaptureLedger {
  nextId(prefix: LedgerPrefix): MaybePromise<string>;
  insertArtifact(row: {
    id: string;
    changeId: string;
    runId: string;
    type: string;
    path: string;
    createdAt: string;
  }): MaybePromise<void>;
  insertEvent(row: {
    id: string;
    changeId: string;
    runId: string;
    type: string;
    message: string;
    rawJson: string;
    createdAt: string;
  }): MaybePromise<void>;
  nowISO(): string;
}

export interface PersistStageRawCaptureInput {
  repoPath: string;
  changeId: string;
  runId: string;
  envelope: StageAiRawCaptureEnvelope;
  ledger?: StageRawCaptureLedger;
}

export interface PersistStageRawCaptureResult {
  artifactId: string;
  eventId: string;
  artifactPath: string;
  artifactHash: string;
}

export async function persistStageRawCapture(
  input: PersistStageRawCaptureInput,
): Promise<PersistStageRawCaptureResult> {
  assertSafePathSegment(input.changeId, "changeId");
  assertSafePathSegment(input.runId, "runId");

  const ledger = input.ledger ?? defaultLedger;
  const artifactPath = rawCaptureArtifactPath(input);
  const artifactEnvelope = {
    ...input.envelope,
    changeId: input.envelope.changeId ?? input.changeId,
    runId: input.envelope.runId ?? input.runId,
  };
  const artifactContent = formatJson(artifactEnvelope);
  const artifactHash = hashString(artifactContent);
  const createdAt = ledger.nowISO();

  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, artifactContent);

  const artifactId = await insertArtifactWithUniqueId(ledger, {
    changeId: input.changeId,
    runId: input.runId,
    type: STAGE_RAW_OUTPUT_ARTIFACT_TYPE,
    path: artifactPath,
    createdAt,
  });

  const eventId = await insertEventWithUniqueId(ledger, {
    changeId: input.changeId,
    runId: input.runId,
    type: STAGE_RAW_OUTPUT_ARTIFACT_TYPE,
    message: stageRawOutputMessage(artifactEnvelope),
    rawJson: JSON.stringify({
      stageRawOutput: stageRawOutputEventPayload({
        envelope: artifactEnvelope,
        artifactId,
        artifactPath,
        artifactHash,
      }),
    }),
    createdAt,
  });

  return {
    artifactId,
    eventId,
    artifactPath,
    artifactHash,
  };
}

async function insertArtifactWithUniqueId(
  ledger: StageRawCaptureLedger,
  row: Omit<Parameters<StageRawCaptureLedger["insertArtifact"]>[0], "id">,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_LEDGER_INSERT_ATTEMPTS; attempt += 1) {
    const id = await ledgerIdForAttempt(ledger, "ART", attempt);
    try {
      await ledger.insertArtifact({ id, ...row });
      return id;
    } catch (error) {
      if (!isDuplicateLedgerIdError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to allocate raw capture artifact id");
}

async function insertEventWithUniqueId(
  ledger: StageRawCaptureLedger,
  row: Omit<Parameters<StageRawCaptureLedger["insertEvent"]>[0], "id">,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_LEDGER_INSERT_ATTEMPTS; attempt += 1) {
    const id = await ledgerIdForAttempt(ledger, "EVT", attempt);
    try {
      await ledger.insertEvent({ id, ...row });
      return id;
    } catch (error) {
      if (!isDuplicateLedgerIdError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to allocate raw capture event id");
}

async function ledgerIdForAttempt(
  ledger: StageRawCaptureLedger,
  prefix: LedgerPrefix,
  attempt: number,
): Promise<string> {
  if (attempt === 0) {
    return ledger.nextId(prefix);
  }
  return randomLedgerId(prefix);
}

function randomLedgerId(prefix: LedgerPrefix): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

function isDuplicateLedgerIdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /unique constraint failed/i.test(message)
    || /constraint failed/i.test(message)
    || /duplicate/i.test(message)
    || /primary key/i.test(message)
  );
}

function rawCaptureArtifactPath(input: PersistStageRawCaptureInput): string {
  return path.join(
    input.repoPath,
    ".ship",
    "changes",
    input.changeId,
    "runs",
    input.runId,
    DEFAULT_RAW_OUTPUT_FILE_NAME,
  );
}

function stageRawOutputEventPayload(input: {
  envelope: StageAiRawCaptureEnvelope;
  artifactId: string;
  artifactPath: string;
  artifactHash: string;
}): Record<string, unknown> {
  const { envelope } = input;
  return omitUndefined({
    schemaVersion: STAGE_RAW_OUTPUT_EVENT_SCHEMA_VERSION,
    artifactId: input.artifactId,
    artifactPath: input.artifactPath,
    artifactHash: input.artifactHash,
    changeId: envelope.changeId,
    runId: envelope.runId,
    phase: envelope.phase,
    provider: envelope.provider,
    schemaDelivery: envelope.schemaDelivery,
    structuredOutputSource: envelope.structuredOutputSource,
    errorCode: envelope.errorCode ?? null,
    providerErrorCode: envelope.providerErrorCode ?? null,
    sanitizedErrorSummary: envelope.sanitizedErrorSummary,
    rawTextHash: envelope.rawTextHash ?? hashOptionalString(envelope.rawText),
    rawTextLength: envelope.rawTextLength ?? envelope.rawText?.length,
    rawTextTruncated: envelope.rawTextTruncated,
    candidate: envelope.candidate,
    recoveredFromFile: envelope.recoveredFromFile,
    repairPass: envelope.repairPass,
    normalizedPayloadHash:
      envelope.normalizedPayload === undefined
        ? undefined
        : hashStableValue(envelope.normalizedPayload),
    validation: envelope.validation,
  });
}

function stageRawOutputMessage(envelope: StageAiRawCaptureEnvelope): string {
  const source = envelope.structuredOutputSource ?? "none";
  const status = envelope.errorCode ? ` (${envelope.errorCode})` : "";
  return `Stage raw output captured from ${source}${status}`;
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashOptionalString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : hashString(value);
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSafePathSegment(value: string, label: "changeId" | "runId"): void {
  if (value.trim() === "" || value.includes("..") || /[/\\]/.test(value)) {
    throw new Error(`Invalid raw capture ${label} path segment: ${value}`);
  }
}

function hashStableValue(value: unknown): string {
  return hashString(stableStringify(value));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined || typeof item === "function" || typeof item === "symbol"
        ? null
        : normalizeForStableJson(item),
    );
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        continue;
      }
      result[key] = normalizeForStableJson(item);
    }
    return result;
  }

  return null;
}

const defaultLedger: StageRawCaptureLedger = {
  nextId: (prefix) => randomLedgerId(prefix),
  insertArtifact: (row) => runLedgerRepository.insertArtifact(row),
  insertEvent: (row) => runLedgerRepository.insertEvent(row),
  nowISO: () => new Date().toISOString(),
};
