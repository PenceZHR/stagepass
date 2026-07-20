import { createHash } from "node:crypto";
import path from "node:path";

import {
  STAGE_AI_OUTPUT_ERROR_COPY,
  STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION,
  type AiOutputMode,
  type SchemaDelivery,
  type StageAiOutputErrorCode,
  type StageAiRawCaptureEnvelope,
  type StructuredOutputSource,
} from "./stage-ai-output-contract";

const MAX_CANDIDATE_BYTES = 1024 * 1024;
const RAW_TEXT_PREVIEW_CHARS = 4_000;

export interface StageAiOutputIngestionAiResult {
  structuredOutput?: unknown;
  summary: string;
  success: boolean;
  providerErrorCode?: string | null;
  providerErrorDetail?: string;
  structuredOutputSource?: StructuredOutputSource;
  schemaDelivery?: SchemaDelivery;
  /** Process forensics from the engine; recorded in the raw capture envelope. */
  exitCode?: number | null;
  signal?: string | null;
  stderrTail?: string;
}

export interface CandidateFileReadResult {
  path: string;
  content: string;
  sizeBytes: number;
  isSymlink: boolean;
  changed: boolean;
}

export interface StageAiOutputRepairInput {
  outputMode: Extract<AiOutputMode, "json_schema">;
  outputSchema: unknown;
  sandboxMode: "read-only";
  timeoutMs: number;
  schemaDelivery: SchemaDelivery;
  sanitizedErrorSummary: string;
}

type ValidationResult =
  | boolean
  | {
      ok?: boolean;
      success?: boolean;
      valid?: boolean;
      error?: unknown;
      message?: string;
    };

type MaybePromise<T> = T | Promise<T>;
type CandidateFileMaybe = CandidateFileReadResult | null | undefined;

export interface StageAiOutputIngestionContract {
  validateSchema(value: unknown): MaybePromise<ValidationResult>;
  validateBusiness(value: unknown): MaybePromise<ValidationResult>;
  allowedCandidateFiles: string[];
  safeRoot?: string;
  /**
   * Records that the stage ran the provider under a read-only sandbox. It must
   * never relax a candidate-file check: read-only means the provider could not
   * have authored the candidate, which makes every candidate found there more
   * suspect, not less. See the `!file.changed` rejection below.
   */
  sandboxReadOnly?: boolean;
  allowSource?(source: StructuredOutputSource, file?: CandidateFileReadResult): boolean;
  readCandidateFile?(path: string): MaybePromise<CandidateFileMaybe>;
  repair?(input: StageAiOutputRepairInput): MaybePromise<unknown>;
  writeRawCapture?: (envelope: StageAiRawCaptureEnvelope) => MaybePromise<unknown>;
}

export interface StageAiOutputIngestionInput {
  changeId: string;
  runId?: string;
  phase?: string;
  provider?: string;
  outputSchema?: unknown;
  aiResult: StageAiOutputIngestionAiResult;
  contract: StageAiOutputIngestionContract;
}

export interface StageAiOutputIngestionResult {
  ok: boolean;
  structuredOutput?: unknown;
  structuredOutputSource: StructuredOutputSource;
  schemaDelivery: SchemaDelivery;
  errorCode?: StageAiOutputErrorCode;
  sanitizedErrorSummary: string;
  rawCaptureEnvelope?: StageAiRawCaptureEnvelope;
}

interface AcceptedOutput {
  value: unknown;
  source: StructuredOutputSource;
  file?: CandidateFileReadResult;
  validation: {
    schemaValid: boolean;
    businessValid: boolean;
  };
}

interface ValidationOutcome {
  ok: boolean;
  message?: string;
}

export function extractFencedJson(text: string): unknown | null {
  for (const block of fencedCodeBlocks(text)) {
    const parsed = parseJsonObjectOrArray(block);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

export function extractNakedJson(text: string): unknown | null {
  return parseJsonObjectOrArray(text.trim());
}

export function normalizeMarkdownCandidate(candidatePath: string, content: string): unknown {
  if (candidatePath.toLowerCase().endsWith(".md")) {
    return { markdown: content };
  }

  return JSON.parse(content) as unknown;
}

export async function ingestStageAiOutput(
  input: StageAiOutputIngestionInput,
): Promise<StageAiOutputIngestionResult> {
  const schemaDelivery = input.aiResult.schemaDelivery ?? "none";
  const failures: string[] = [];
  const providerFailed = !input.aiResult.success;

  if (!providerFailed) {
    const providerAccepted = await validatePotentialOutput(
      input,
      providerNativeStructuredOutput(input.aiResult),
      "provider_native",
      failures,
    );
    if (providerAccepted) {
      return successResult(providerAccepted, schemaDelivery, input);
    }

    const declaredStructured = declaredStructuredOutput(input.aiResult);
    const declaredAccepted = await validatePotentialOutput(
      input,
      declaredStructured?.value,
      declaredStructured?.source ?? "text_extracted",
      failures,
    );
    if (declaredAccepted) {
      return successResult(declaredAccepted, schemaDelivery, input);
    }

    const fenced = extractFencedJson(input.aiResult.summary);
    const fencedAccepted = await validatePotentialOutput(input, fenced, "text_extracted", failures);
    if (fencedAccepted) {
      return successResult(fencedAccepted, schemaDelivery, input);
    }

    const naked = extractNakedJson(input.aiResult.summary);
    const nakedAccepted = await validatePotentialOutput(input, naked, "text_extracted", failures);
    if (nakedAccepted) {
      return successResult(nakedAccepted, schemaDelivery, input);
    }
  } else {
    failures.push("provider output rejected after provider failure");
  }

  const fileAccepted = await readAndValidateAllowedFileCandidate(input, failures);
  if (fileAccepted) {
    return successResult(fileAccepted, schemaDelivery, input);
  }

  if (!providerFailed) {
    const repairAccepted = await runRepairPass(input, schemaDelivery, failures);
    if (repairAccepted) {
      return successResult(repairAccepted, schemaDelivery, input);
    }
  } else {
    failures.push("repair rejected after provider failure");
  }

  const errorCode = inferErrorCode(input, failures);
  const detail = errorDetailFor(errorCode, input, failures);
  const sanitizedErrorSummary = sanitizeErrorSummary(`${errorCode}: ${detail}`);
  const rawCaptureEnvelope = buildRawCaptureEnvelope(input, {
    schemaDelivery,
    structuredOutputSource: "none",
    errorCode,
    sanitizedErrorSummary,
    rawText: providerFailed ? sanitizedErrorSummary : undefined,
  });
  await writeRawCapture(input, rawCaptureEnvelope);

  return {
    ok: false,
    structuredOutputSource: "none",
    schemaDelivery,
    errorCode,
    sanitizedErrorSummary,
    rawCaptureEnvelope,
  };
}

function fencedCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fencePattern = /```([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(text)) !== null) {
    const body = match[1];
    const normalized = normalizeFenceBody(body);
    if (normalized !== null) {
      blocks.push(normalized);
    }
  }

  return blocks;
}

function normalizeFenceBody(body: string): string | null {
  const firstNewline = body.indexOf("\n");
  if (firstNewline === -1) {
    return body.trim();
  }

  const firstLine = body.slice(0, firstNewline).trim();
  const rest = body.slice(firstNewline + 1);
  if (firstLine === "" || /^json\b/i.test(firstLine)) {
    return rest.trim();
  }
  if (startsJsonObjectOrArray(firstLine)) {
    return body.trim();
  }

  return null;
}

function parseJsonObjectOrArray(text: string): unknown | null {
  const candidate = text.trim();
  if (!startsJsonObjectOrArray(candidate) || !endsJsonObjectOrArray(candidate)) {
    return null;
  }

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function startsJsonObjectOrArray(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[");
}

function endsJsonObjectOrArray(value: string): boolean {
  return value.endsWith("}") || value.endsWith("]");
}

function providerNativeStructuredOutput(aiResult: StageAiOutputIngestionAiResult): unknown {
  if (aiResult.structuredOutput === undefined) {
    return undefined;
  }
  if ((aiResult.structuredOutputSource ?? "provider_native") !== "provider_native") {
    return undefined;
  }
  return aiResult.structuredOutput;
}

function declaredStructuredOutput(
  aiResult: StageAiOutputIngestionAiResult,
): { value: unknown; source: StructuredOutputSource } | null {
  const source = aiResult.structuredOutputSource;
  if (
    aiResult.structuredOutput === undefined
    || source === undefined
    || source === "provider_native"
    || source === "none"
  ) {
    return null;
  }

  return {
    value: aiResult.structuredOutput,
    source,
  };
}

async function validatePotentialOutput(
  input: StageAiOutputIngestionInput,
  value: unknown,
  source: StructuredOutputSource,
  failures: string[],
  file?: CandidateFileReadResult,
): Promise<AcceptedOutput | null> {
  if (value === undefined || value === null) {
    return null;
  }
  if (input.contract.allowSource && !input.contract.allowSource(source, file)) {
    failures.push(`${source} rejected by contract`);
    return null;
  }

  const schema = await runValidator(input.contract.validateSchema, value);
  if (!schema.ok) {
    failures.push(`${source} schema invalid${schema.message ? `: ${schema.message}` : ""}`);
    return null;
  }

  const business = await runValidator(input.contract.validateBusiness, value);
  if (!business.ok) {
    failures.push(`${source} business invalid${business.message ? `: ${business.message}` : ""}`);
    return null;
  }

  return {
    value,
    source,
    file,
    validation: {
      schemaValid: true,
      businessValid: true,
    },
  };
}

async function readAndValidateAllowedFileCandidate(
  input: StageAiOutputIngestionInput,
  failures: string[],
): Promise<AcceptedOutput | null> {
  if (!input.contract.readCandidateFile || input.contract.allowedCandidateFiles.length === 0) {
    return null;
  }

  const allowed = new Set(input.contract.allowedCandidateFiles.map(normalizeCandidatePath));
  for (const requestedPath of input.contract.allowedCandidateFiles) {
    const normalizedRequestedPath = normalizeCandidatePath(requestedPath);
    if (!isAllowedCandidatePath(normalizedRequestedPath, allowed, input)) {
      failures.push(`file candidate rejected: ${requestedPath}`);
      continue;
    }

    const file = await input.contract.readCandidateFile(requestedPath);
    if (!file) {
      failures.push(`file candidate missing: ${requestedPath}`);
      continue;
    }

    const normalizedFilePath = normalizeCandidatePath(file.path);
    if (!isAllowedCandidatePath(normalizedFilePath, allowed, input)) {
      failures.push(`file candidate rejected: ${file.path}`);
      continue;
    }
    if (file.isSymlink) {
      failures.push(`file candidate is symlink: ${file.path}`);
      continue;
    }
    if (file.sizeBytes > MAX_CANDIDATE_BYTES) {
      failures.push(`file candidate oversized: ${file.path}`);
      continue;
    }
    // An unchanged candidate was not written by this run, so it cannot be this
    // run's output -- it is whatever was already on disk, which for every stage
    // here is stagepass's own DB mirror. Adopting it re-stamps stale content as
    // fresh. This must hold hardest under a read-only sandbox, where the
    // provider physically could not have authored the file at all; gating it on
    // sandbox mode (as this once did, inverted) disabled the check exactly where
    // it was load-bearing. Cf. pipeline-review-stage-service: a candidate proves
    // freshness but not authorship, so a timed-out provider fails closed
    // "instead of promoting a mirror file to DB authority".
    if (!file.changed) {
      failures.push(`file candidate unchanged: ${file.path}`);
      continue;
    }

    let normalizedPayload: unknown;
    try {
      normalizedPayload = normalizeMarkdownCandidate(normalizedFilePath, file.content);
    } catch (error) {
      failures.push(`file candidate parse failed: ${formatUnknownError(error)}`);
      continue;
    }

    const accepted = await validatePotentialOutput(
      input,
      normalizedPayload,
      "file_candidate",
      failures,
      file,
    );
    if (accepted) {
      return accepted;
    }
  }

  return null;
}

function isAllowedCandidatePath(
  candidatePath: string,
  allowedCandidateFiles: Set<string>,
  input: StageAiOutputIngestionInput,
): boolean {
  if (candidatePath.startsWith("/") || candidatePath.startsWith("../")) {
    return false;
  }
  if (!allowedCandidateFiles.has(candidatePath)) {
    return false;
  }

  const safeRoot = normalizeSafeRoot(input.contract.safeRoot ?? `.ship/changes/${input.changeId}`);
  return candidatePath.startsWith(`${safeRoot}/`);
}

function normalizeCandidatePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function normalizeSafeRoot(safeRoot: string): string {
  return normalizeCandidatePath(safeRoot).replace(/\/+$/, "");
}

async function runRepairPass(
  input: StageAiOutputIngestionInput,
  schemaDelivery: SchemaDelivery,
  failures: string[],
): Promise<AcceptedOutput | null> {
  if (!input.contract.repair) {
    return null;
  }

  let repaired: unknown;
  try {
    repaired = await input.contract.repair({
      outputMode: "json_schema",
      outputSchema: input.outputSchema,
      sandboxMode: "read-only",
      timeoutMs: 60_000,
      schemaDelivery,
      sanitizedErrorSummary: sanitizeErrorSummary(failures.join("; ")),
    });
  } catch (error) {
    failures.push(`repair failed: ${formatUnknownError(error)}`);
    return null;
  }

  return validatePotentialOutput(input, repaired, "repair_pass", failures);
}

async function successResult(
  accepted: AcceptedOutput,
  schemaDelivery: SchemaDelivery,
  input: StageAiOutputIngestionInput,
): Promise<StageAiOutputIngestionResult> {
  const providerFailed = !input.aiResult.success;
  const isTimeoutRecoveredFromFile =
    input.aiResult.providerErrorCode === "provider_timeout" && accepted.source === "file_candidate";
  const errorCode = isTimeoutRecoveredFromFile ? "provider_timeout_recovered_from_file" : undefined;
  const providerFailureSummary = providerFailed
    ? sanitizeErrorSummary(
      `${errorCode ?? input.aiResult.providerErrorCode ?? "provider_run_failed"}: ${
        input.aiResult.providerErrorDetail ?? input.aiResult.summary
      }`,
    )
    : undefined;
  const rawCaptureEnvelope = buildRawCaptureEnvelope(input, {
    schemaDelivery,
    structuredOutputSource: accepted.source,
    errorCode: errorCode ?? null,
    sanitizedErrorSummary: providerFailureSummary,
    rawText: providerFailureSummary,
    normalizedPayload: accepted.value,
    validation: accepted.validation,
    recoveredFromFile: providerFailed && accepted.source === "file_candidate",
    repairPass: accepted.source === "repair_pass",
    file: accepted.file,
  });
  await writeRawCapture(input, rawCaptureEnvelope);

  return {
    ok: true,
    structuredOutput: accepted.value,
    structuredOutputSource: accepted.source,
    schemaDelivery,
    errorCode,
    sanitizedErrorSummary: "",
    rawCaptureEnvelope,
  };
}

function buildRawCaptureEnvelope(
  input: StageAiOutputIngestionInput,
  options: {
    schemaDelivery: SchemaDelivery;
    structuredOutputSource: StructuredOutputSource;
    errorCode?: StageAiOutputErrorCode | null;
    sanitizedErrorSummary?: string;
    normalizedPayload?: unknown;
    validation?: StageAiRawCaptureEnvelope["validation"];
    recoveredFromFile?: boolean;
    repairPass?: boolean;
    file?: CandidateFileReadResult;
    rawText?: string;
  },
): StageAiRawCaptureEnvelope {
  const rawText = options.rawText ?? input.aiResult.summary;
  const envelope: StageAiRawCaptureEnvelope = {
    schemaVersion: STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION,
    changeId: input.changeId,
    schemaDelivery: options.schemaDelivery,
    structuredOutputSource: options.structuredOutputSource,
    errorCode: options.errorCode ?? null,
    providerErrorCode: input.aiResult.providerErrorCode ?? null,
    rawText,
    rawTextHash: hashString(rawText),
    rawTextPreview: previewText(rawText),
    rawTextLength: rawText.length,
    rawTextTruncated: rawText.length > RAW_TEXT_PREVIEW_CHARS,
  };

  // Process forensics ride along on every capture, not just failures: proving a
  // run exited 0 is as diagnostic as proving it was signalled, and the previous
  // envelope had nowhere to put either, so a post-mortem had only "0 characters
  // came back" to work with.
  if (input.aiResult.exitCode !== undefined) {
    envelope.providerExitCode = input.aiResult.exitCode;
  }
  if (input.aiResult.signal !== undefined) {
    envelope.providerSignal = input.aiResult.signal;
  }
  if (input.aiResult.stderrTail) {
    envelope.providerStderrTail = sanitizeErrorSummary(input.aiResult.stderrTail);
  }

  if (input.runId !== undefined) {
    envelope.runId = input.runId;
  }
  if (input.phase !== undefined) {
    envelope.phase = input.phase;
  }
  if (input.provider !== undefined) {
    envelope.provider = input.provider;
  }
  if (options.sanitizedErrorSummary !== undefined) {
    envelope.sanitizedErrorSummary = options.sanitizedErrorSummary;
  }
  if (options.recoveredFromFile !== undefined) {
    envelope.recoveredFromFile = options.recoveredFromFile;
  }
  if (options.repairPass !== undefined) {
    envelope.repairPass = options.repairPass;
  }
  if (options.file !== undefined) {
    envelope.candidate = {
      path: options.file.path,
      hash: hashString(options.file.content),
    };
  }
  if (options.normalizedPayload !== undefined) {
    envelope.normalizedPayload = options.normalizedPayload;
  }
  if (options.validation !== undefined) {
    envelope.validation = options.validation;
  }

  return envelope;
}

async function writeRawCapture(
  input: StageAiOutputIngestionInput,
  envelope: StageAiRawCaptureEnvelope,
): Promise<void> {
  if (!input.contract.writeRawCapture) {
    return;
  }

  await input.contract.writeRawCapture(envelope);
}

function previewText(value: string): string {
  return value.slice(0, RAW_TEXT_PREVIEW_CHARS);
}

async function runValidator(
  validator: (value: unknown) => MaybePromise<ValidationResult>,
  value: unknown,
): Promise<ValidationOutcome> {
  try {
    return normalizeValidationResult(await validator(value));
  } catch (error) {
    return { ok: false, message: formatUnknownError(error) };
  }
}

function normalizeValidationResult(result: ValidationResult): ValidationOutcome {
  if (typeof result === "boolean") {
    return { ok: result };
  }

  const ok = result.ok ?? result.success ?? result.valid ?? false;
  return {
    ok,
    message: ok ? undefined : extractValidationMessage(result),
  };
}

function extractValidationMessage(result: Exclude<ValidationResult, boolean>): string | undefined {
  if (typeof result.message === "string") {
    return result.message;
  }
  if (result.error !== undefined) {
    return formatUnknownError(result.error);
  }
  return undefined;
}

/**
 * Provider-side codes an engine may set that name the failure better than
 * "provider_run_failed" ever could. Passing them through is the whole point:
 * flattening them here is how a dropped connection became indistinguishable
 * from a model that wrote bad output.
 */
const PASSTHROUGH_PROVIDER_ERROR_CODES = new Set<StageAiOutputErrorCode>([
  "provider_timeout",
  "provider_transport_error",
  "provider_empty_response",
]);

/** Did the provider deliver any reply text at all? */
function hasProviderReply(aiResult: StageAiOutputIngestionAiResult): boolean {
  return aiResult.summary.trim().length > 0;
}

function inferErrorCode(
  input: StageAiOutputIngestionInput,
  failures: string[],
): StageAiOutputErrorCode {
  const providerErrorCode = input.aiResult.providerErrorCode;
  if (providerErrorCode && PASSTHROUGH_PROVIDER_ERROR_CODES.has(providerErrorCode as StageAiOutputErrorCode)) {
    return providerErrorCode as StageAiOutputErrorCode;
  }
  if (!input.aiResult.success) {
    return "provider_run_failed";
  }
  // "The provider reported success but handed us nothing" is a delivery
  // failure, not an output-format failure -- there is no output to have a
  // format. This MUST precede every branch below: each of them names a defect
  // in text the model wrote, and blaming the model for an absent reply is the
  // exact misattribution this ordering exists to prevent. The non-line-protocol
  // fork has always required a non-empty summary before trusting a reply
  // (prepareAiResultForIngestion); this is the same rule, applied to everyone.
  if (!hasProviderReply(input.aiResult)) {
    return "provider_empty_response";
  }
  if (
    failures.some(
      (failure) => failure.startsWith("repair ") || failure.startsWith("repair_pass "),
    )
  ) {
    return "repair_failed";
  }
  if (input.phase === "review") {
    return "invalid_review_output";
  }
  if (failures.some((failure) => failure.startsWith("file candidate"))) {
    return "file_candidate_invalid";
  }
  return "invalid_stage_output";
}

/**
 * The human-facing half of the error. For codes whose identifier alone tells a
 * user nothing actionable we lead with plain-language copy, then append what is
 * actually known -- and nothing that is merely suspected. An empty reply gets a
 * list of possible causes, never an assertion of one.
 */
function errorDetailFor(
  errorCode: StageAiOutputErrorCode,
  input: StageAiOutputIngestionInput,
  failures: string[],
): string {
  const copy = STAGE_AI_OUTPUT_ERROR_COPY[errorCode];
  if (!copy) {
    return !input.aiResult.success
      ? (input.aiResult.providerErrorDetail ?? input.aiResult.summary)
      : failures.join("; ");
  }
  const evidence = [
    input.aiResult.providerErrorDetail,
    processExitEvidence(input.aiResult),
  ].filter((part): part is string => Boolean(part && part.length > 0));
  return evidence.length > 0 ? `${copy} [${evidence.join(" | ")}]` : copy;
}

/** "exit=null signal=SIGTERM" — the difference between killed and quiet. */
function processExitEvidence(aiResult: StageAiOutputIngestionAiResult): string | null {
  if (aiResult.exitCode === undefined && aiResult.signal === undefined) return null;
  return `exit=${aiResult.exitCode ?? "null"} signal=${aiResult.signal ?? "null"}`;
}

function sanitizeErrorSummary(value: string): string {
  return redactSecrets(value).replace(/\s+/g, " ").trim().slice(0, 500);
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(
      /(["']?)\bauthorization\1\s*[:=]\s*["']?(?:basic|bearer)\s+[^\s"',;}]+/gi,
      "$1authorization$1=[REDACTED]",
    )
    .replace(
      /(["']?)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|token|cookie|authorization|password|secret)\1\s*[:=]\s*["']?[^"',\s;}]+/gi,
      "$1$2$1=[REDACTED]",
    );
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
