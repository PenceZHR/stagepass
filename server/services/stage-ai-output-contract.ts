import { createHash } from "node:crypto";

export type AiOutputMode = "json_schema" | "markdown" | "text";

export type SchemaDelivery = "provider_native" | "schema_prompt" | "none";

export type StructuredOutputSource =
  | "provider_native"
  /** Deterministically assembled by stagepass from a line-oriented protocol the model wrote (the model never authors JSON). */
  | "line_protocol"
  | "text_extracted"
  | "file_candidate"
  | "repair_pass"
  | "none";

export const STRUCTURED_OUTPUT_SOURCES = [
  "provider_native",
  "line_protocol",
  "text_extracted",
  "file_candidate",
  "repair_pass",
  "none",
] as const satisfies readonly StructuredOutputSource[];

export type StageProgressStatus =
  | "started"
  | "provider_running"
  | "ingesting"
  | "file_candidate"
  | "repairing"
  | "completed"
  | "failed"
  | "invalid_output"
  | "mirror_write_failed";

export type StageAiOutputErrorCode =
  | "provider_timeout"
  | "provider_run_failed"
  /**
   * The transport between stagepass and the model service broke. Only ever set
   * on HARD evidence (a codex `turn.failed` naming a disconnect, or a claude
   * HTTP status / connect failure) -- never inferred from "we got nothing back",
   * which is what provider_empty_response is for.
   */
  | "provider_transport_error"
  /**
   * The provider process ended without ever delivering an assistant reply. The
   * cause is deliberately NOT claimed: a killed process, a slept machine and a
   * dropped connection are indistinguishable from here, and guessing is how the
   * model ended up blamed for output it never produced.
   */
  | "provider_empty_response"
  | "invalid_review_output"
  | "invalid_stage_output"
  | "file_candidate_invalid"
  | "repair_failed"
  | "mirror_write_failed"
  | "provider_timeout_recovered_from_file";

/**
 * Codes that mean "the provider never delivered a usable reply", as opposed to
 * "the model replied and the reply was wrong". Every StageProgressStatus mapping
 * must render these as `failed`, never `invalid_output` -- the latter reads to a
 * human as "the model's fault" and sends them to fix the prompt instead of the
 * network, the machine's sleep settings, or the supervisor.
 */
export const PROVIDER_FAILURE_STAGE_ERROR_CODES = new Set<StageAiOutputErrorCode>([
  "provider_run_failed",
  "provider_timeout",
  "provider_transport_error",
  "provider_empty_response",
]);

export function isProviderFailureStageErrorCode(code: string | undefined | null): boolean {
  return code !== undefined && code !== null
    && PROVIDER_FAILURE_STAGE_ERROR_CODES.has(code as StageAiOutputErrorCode);
}

/**
 * The terminal StageProgressStatus for a failed ingestion. `invalid_output`
 * reads to a human as "the model got it wrong", so it is reserved for codes that
 * describe output the model actually produced; anything meaning "no usable reply
 * arrived" renders as `failed`. Shared rather than re-derived per stage, so a
 * newly added provider-side code cannot silently default to blaming the model.
 */
export function terminalStageProgressStatus(
  errorCode: string | undefined | null,
): Extract<StageProgressStatus, "failed" | "invalid_output"> {
  return isProviderFailureStageErrorCode(errorCode) ? "failed" : "invalid_output";
}

/**
 * User-visible copy for the codes a human cannot decode from the identifier
 * alone. Deliberately states what IS known and, for an empty reply, lists
 * possible causes without asserting one.
 */
export const STAGE_AI_OUTPUT_ERROR_COPY: Partial<Record<StageAiOutputErrorCode, string>> = {
  // Covers the whole transport set honestly: a severed connection (stream
  // disconnected / ConnectionRefused) AND a server that refused or was
  // overloaded (429/5xx). Saying "连接中断" for a 429 would send the user to
  // check their network when the connection was fine -- the same
  // over-attribution this whole change exists to remove.
  provider_transport_error: "与模型服务的通信失败（连接中断或服务端暂时不可用），可直接重试。",
  provider_empty_response:
    "本次运行没有返回任何内容。常见原因：网络中断、机器休眠、进程被重启。可直接重试。",
};

export const STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION = "stage_ai_raw_output/v1";

export interface StageAiRawCaptureEnvelope {
  schemaVersion: typeof STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION;
  changeId?: string;
  runId?: string;
  phase?: string;
  provider?: string;
  schemaDelivery?: SchemaDelivery;
  structuredOutputSource?: StructuredOutputSource;
  errorCode?: StageAiOutputErrorCode | null;
  providerErrorCode?: string | null;
  sanitizedErrorSummary?: string;
  rawText?: string;
  rawTextHash?: string;
  rawTextPreview?: string;
  rawTextLength?: number;
  rawTextTruncated?: boolean;
  /**
   * Process forensics for the provider run behind this capture. Without these
   * the envelope could record "0 characters came back" but nothing about WHY,
   * so every post-mortem was guesswork: `signal: "SIGTERM"` with a null exit
   * code is a killed process, a nonzero exit code is a provider that gave up,
   * and a clean 0 with no reply is a provider that simply said nothing.
   */
  providerExitCode?: number | null;
  providerSignal?: string | null;
  /** Tail of the provider's stderr, already truncated and secret-redacted. */
  providerStderrTail?: string;
  recoveredFromFile?: boolean;
  repairPass?: boolean;
  candidate?: {
    path: string;
    hash: string;
  };
  candidateAudit?: {
    path: string;
    sha256: string | null;
    sizeBytes: number | null;
    changed: boolean;
    freshness: "fresh" | "stale" | "missing" | "unsafe";
    symlinkDisposition: "not_symlink" | "rejected_symlink" | "unknown";
    reportedByProvider: boolean;
    rejectionReason: string;
  };
  normalizedPayload?: unknown;
  validation?: {
    schemaValid: boolean;
    businessValid: boolean;
  };
}

export interface StageProgressEventPayload {
  schemaVersion: "stage_progress/v1";
  phase: string;
  runId: string;
  stageRunId?: string;
  attemptNo?: number;
  status: StageProgressStatus;
  message?: string;
  source: StructuredOutputSource | "stage_authority" | "review_attempt";
}

export interface StageSourceLineageV1 {
  schemaVersion: "stage_source_lineage/v1";
  sourceDbHashes: Record<string, string>;
  inputDbHash: string | null;
  legacyRunId: string;
  stageRunId: string;
  attemptNo: number;
  aiOutput: {
    rawCaptureId: string | null;
    rawOutputArtifactId?: string | null;
    provider: "codex" | "claude";
    aiOutputMode: AiOutputMode;
    schemaDelivery: SchemaDelivery;
    structuredOutputSource: StructuredOutputSource;
    rawTextHash?: string;
    normalizedOutputHash?: string;
    candidatePath?: string;
    candidateHash?: string;
    recoveredFromFile?: boolean;
    repairPass?: boolean;
  };
  errorCode?: StageAiOutputErrorCode;
  promptHash?: string;
  outputSchemaHash?: string;
}

export interface MarkdownCandidateOutput {
  markdown: string;
}

export interface BuildStageSourceLineageInput {
  sourceDbHashes: Record<string, string>;
  inputDbHash: string | null;
  legacyRunId: string;
  stageRunId: string;
  attemptNo: number;
  provider: "codex" | "claude";
  aiOutputMode: AiOutputMode;
  schemaDelivery: SchemaDelivery;
  structuredOutputSource: StructuredOutputSource;
  rawCaptureId: string | null;
  rawOutputArtifactId?: string | null;
  rawText?: string;
  normalizedOutput?: unknown;
  candidatePath?: string;
  candidateContent?: string;
  recoveredFromFile?: boolean;
  repairPass?: boolean;
  errorCode?: StageAiOutputErrorCode;
  prompt?: string;
  outputSchema?: unknown;
}

export function buildStageSourceLineage(
  input: BuildStageSourceLineageInput,
): StageSourceLineageV1 {
  const aiOutput: StageSourceLineageV1["aiOutput"] = {
    rawCaptureId: input.rawCaptureId,
    provider: input.provider,
    aiOutputMode: input.aiOutputMode,
    schemaDelivery: input.schemaDelivery,
    structuredOutputSource: input.structuredOutputSource,
  };

  if (input.rawOutputArtifactId !== undefined) {
    aiOutput.rawOutputArtifactId = input.rawOutputArtifactId;
  }
  if (input.rawText !== undefined) {
    aiOutput.rawTextHash = hashString(input.rawText);
  }
  if (input.normalizedOutput !== undefined) {
    aiOutput.normalizedOutputHash = hashStableValue(input.normalizedOutput);
  }
  if (input.candidatePath !== undefined) {
    aiOutput.candidatePath = input.candidatePath;
  }
  if (input.candidateContent !== undefined) {
    aiOutput.candidateHash = hashString(input.candidateContent);
  }
  if (input.recoveredFromFile !== undefined) {
    aiOutput.recoveredFromFile = input.recoveredFromFile;
  }
  if (input.repairPass !== undefined) {
    aiOutput.repairPass = input.repairPass;
  }

  const lineage: StageSourceLineageV1 = {
    schemaVersion: "stage_source_lineage/v1",
    sourceDbHashes: sortStringRecord(input.sourceDbHashes),
    inputDbHash: input.inputDbHash,
    legacyRunId: input.legacyRunId,
    stageRunId: input.stageRunId,
    attemptNo: input.attemptNo,
    aiOutput,
  };

  if (input.errorCode !== undefined) {
    lineage.errorCode = input.errorCode;
  }
  if (input.prompt !== undefined) {
    lineage.promptHash = hashString(input.prompt);
  }
  if (input.outputSchema !== undefined) {
    lineage.outputSchemaHash = hashStableValue(input.outputSchema);
  }

  return lineage;
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function sortStringRecord(value: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = value[key];
  }
  return result;
}
