# Unified AI Output Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify every pipeline stage's AI output path so malformed provider output is captured, repaired or rejected consistently, never silently blocks the user, and DB remains the only source of truth while JSON/Markdown mirrors stay stable for the frontend.

**Architecture:** Providers return raw and optional structured data through a narrow adapter contract. Every stage declares a `StageAiOutputContract`, then a single ingestion service extracts, validates, records lineage, writes DB state first, and renders mirrors afterward. Progress and failure are emitted through versioned `stage_progress` events so UI and Action Contract can explain and retry failures deterministically.

**Tech Stack:** TypeScript, Next.js App Router, Drizzle ORM, SQLite, Zod, Node test runner via `npx tsx --test`, existing Codex SDK adapter, existing Claude CLI adapter.

---

## Scope

This plan implements the shared output contract and applies it first to the high-risk paths that currently block users when AI output is malformed:

- PRD Briefing: questions, draft, final review.
- Review: raw output artifact and terminal attempt coverage.
- Markdown file candidates used by PRD draft, Spec red output, Release, and Retro.
- Codex and Claude adapter metadata so downstream code can tell how schema was delivered and where the usable structured value came from.
- UI/API progress visibility for `stage_progress`.

Later migrations for Plan, TestPlan, TechSpec, Refine, Context Init, Commit helper, and Build/Fix streamed stages must reuse the same contracts and ingestion service.

## File Structure

Create:

- `server/services/stage-ai-output-contract.ts`
  Owns public type contracts: output modes, schema delivery, structured output source, stage progress payload, lineage schema, error codes, contract interface, and helper signatures.

- `server/services/stage-ai-output-ingestion-service.ts`
  Owns extraction order, file candidate scanning, markdown candidate normalization, repair pass orchestration, DB-first persistence handoff, raw capture recording, and mirror rendering handoff.

- `server/services/stage-progress-service.ts`
  Owns `stage_progress` event emission and raw JSON envelope formatting.

- `server/services/stage-ai-output-ingestion-service.test.ts`
  Unit coverage for extraction order, markdown normalization, file candidate recovery, repair pass, raw capture lineage, and timeout recovered from file.

- `server/services/stage-progress-service.test.ts`
  Unit coverage for event payload shape and raw JSON storage format.

- `app/projects/[id]/changes/[changeId]/stage-progress-events.test.ts`
  Frontend/API consumer coverage for parsing `stage_progress` events.

Modify:

- `server/types/enums.ts`
  Add `stage_progress` to `EventType`.

- `server/types/models.ts`
  Continue using `EventType`; no new enum fork.

- `server/services/state-machine-enums.test.ts`
  Assert `EventType.safeParse("stage_progress").success === true`.

- `server/services/ai-engine-types.ts`
  Add adapter metadata fields to `AiRunInput` and `AiRunResult`.

- `server/services/codex-engine.ts`
  Preserve native `outputSchema` calls and report `schemaDelivery: "provider_native"`.

- `server/services/codex-engine.test.ts`
  Assert `thread.run(prompt, { outputSchema })` and streamed runs pass `outputSchema`.

- `server/services/claude-engine.ts`
  Preserve schema prompt injection and report `schemaDelivery: "schema_prompt"` when schema is appended.

- `server/services/claude-engine.test.ts`
  Assert `--append-system-prompt` contains the schema and stdout result extraction is classified correctly.

- `server/services/pipeline-prd-briefing-stage-service.ts`
  Route questions, draft, and final review through the ingestion service.

- `server/services/prd-briefing-ledger.ts`
  Export schemas for questions, draft markdown envelope, and final review.

- `server/services/prd-briefing-service.ts`
  Accept validated normalized objects and expose latest stage progress in state.

- `server/services/pipeline-document-stage-runner-service.ts`
  Use the contract for markdown-oriented document stages.

- `server/services/pipeline-service.ts`
  Preserve Review raw output artifact linkage across every terminal path and integrate timeout recovered from file.

- `server/services/review-run-service.ts`
  Keep `rawOutputArtifactId` as the Review attempt authority and accept the ingestion raw artifact id.

- `server/services/action-contract-service.ts`
  Read stage output failures and retryability from stage progress, stage runs, and existing legacy runs.

- `app/api/projects/[id]/changes/[changeId]/prd-briefing/route.ts`
  Include stage progress in PRD briefing state responses.

- `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx`
  Display process/failure information from stage progress.

- `app/projects/[id]/changes/[changeId]/event-stream-panel.tsx`
  Parse and render `stage_progress` event payloads.

## Final Contracts

Add these definitions to `server/services/stage-ai-output-contract.ts`:

```ts
export type AiOutputMode = "json_schema" | "markdown" | "text";

export type SchemaDelivery =
  | "provider_native"
  | "schema_prompt"
  | "none";

export type StructuredOutputSource =
  | "provider_native"
  | "text_extracted"
  | "file_candidate"
  | "repair_pass"
  | "none";

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
  | "invalid_review_output"
  | "invalid_stage_output"
  | "file_candidate_invalid"
  | "repair_failed"
  | "mirror_write_failed"
  | "provider_timeout_recovered_from_file";

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
```

Rules:

- `AiOutputMode` describes what the stage asks for and accepts.
- `SchemaDelivery` describes how schema instructions reached the provider.
- `StructuredOutputSource` describes where the accepted normalized value came from.
- `schema_prompt` must never appear in `StructuredOutputSource`.
- `StageProgressStatus` is an independent union. It does not reuse `StageRunStatus`, `RunStatus`, or `ChangeStatus`.
- `StageSourceLineageV1` must be created only through `buildStageSourceLineage(input)`.
- `stage_runs.sourceLineageJson` must store stable JSON for `StageSourceLineageV1`.
- `.md` candidates normalize to `{ markdown }` only inside ingestion and validation. Mirror files remain bare Markdown.

## Task 1: Add Contract Types And Adapter Metadata

**Files:**
- Create: `server/services/stage-ai-output-contract.ts`
- Modify: `server/services/ai-engine-types.ts`
- Test: `server/services/ai-engine-adapter.test.ts`

- [ ] **Step 1: Add contract type tests**

Add assertions that `StructuredOutputSource` excludes `schema_prompt` by testing the exported source list or a parser helper.

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRUCTURED_OUTPUT_SOURCES } from "./stage-ai-output-contract.ts";

describe("stage AI output contract", () => {
  it("does not classify schema_prompt as a structured output source", () => {
    assert.equal(STRUCTURED_OUTPUT_SOURCES.includes("schema_prompt" as never), false);
  });
});
```

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/ai-engine-adapter.test.ts
```

Expected: FAIL until `STRUCTURED_OUTPUT_SOURCES` exists.

- [ ] **Step 2: Create `stage-ai-output-contract.ts`**

Implement the final contracts from the "Final Contracts" section and export constant lists:

```ts
export const STRUCTURED_OUTPUT_SOURCES = [
  "provider_native",
  "text_extracted",
  "file_candidate",
  "repair_pass",
  "none",
] as const;
```

- [ ] **Step 3: Extend `AiRunInput` and `AiRunResult`**

In `server/services/ai-engine-types.ts`, add:

```ts
import type {
  AiOutputMode,
  SchemaDelivery,
  StructuredOutputSource,
} from "./stage-ai-output-contract.ts";

export interface AiRunRawCaptureInput {
  enabled: boolean;
  artifactType: string;
  fileName: string;
}
```

Then extend existing interfaces:

```ts
export interface AiRunInput {
  // existing fields stay unchanged
  outputSchema?: unknown;
  outputMode?: AiOutputMode;
  rawCapture?: AiRunRawCaptureInput;
}

export interface AiRunResult {
  // existing fields stay unchanged
  structuredOutput?: unknown;
  structuredOutputSource?: StructuredOutputSource;
  schemaDelivery?: SchemaDelivery;
  schemaCapabilityInvoked?: boolean;
  rawProviderResult?: unknown;
  providerErrorCode?: string | null;
}
```

Keep the new fields optional in this task so existing callers compile before stage migrations.

- [ ] **Step 4: Run type and adapter tests**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/ai-engine-adapter.test.ts
```

Expected: PASS.

## Task 2: Add Stage Progress Event Contract

**Files:**
- Modify: `server/types/enums.ts`
- Modify: `server/services/state-machine-enums.test.ts`
- Create: `server/services/stage-progress-service.ts`
- Create: `server/services/stage-progress-service.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/event-stream-panel.tsx`
- Create: `app/projects/[id]/changes/[changeId]/stage-progress-events.test.ts`

- [ ] **Step 1: Test `EventType` includes `stage_progress`**

Add to `server/services/state-machine-enums.test.ts`:

```ts
it("includes stage_progress event type", () => {
  assert.equal(EventType.safeParse("stage_progress").success, true);
});
```

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/state-machine-enums.test.ts
```

Expected: FAIL until enum is updated.

- [ ] **Step 2: Add enum value**

In `server/types/enums.ts`, add `"stage_progress"` to `EventType`.

- [ ] **Step 3: Implement progress event service**

Create `server/services/stage-progress-service.ts` with a single write boundary:

```ts
import type { Database } from "better-sqlite3";
import type { StageProgressEventPayload } from "./stage-ai-output-contract.ts";

export interface EmitStageProgressInput {
  db: Database;
  projectId: string;
  changeId: string;
  payload: StageProgressEventPayload;
}

export function stageProgressRawJson(payload: StageProgressEventPayload): string {
  return JSON.stringify({ stageProgress: payload });
}
```

Wire the repository/event insert using the existing event insert helper used elsewhere in the project. Direct DB writes must use `stageProgressRawJson(payload)`.

- [ ] **Step 4: Test raw JSON envelope**

Create `server/services/stage-progress-service.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stageProgressRawJson } from "./stage-progress-service.ts";

describe("stage progress service", () => {
  it("writes stage progress rawJson as { stageProgress }", () => {
    const rawJson = stageProgressRawJson({
      schemaVersion: "stage_progress/v1",
      phase: "prd_briefing_questions",
      runId: "RUN-1",
      stageRunId: "STAGE-1",
      attemptNo: 1,
      status: "ingesting",
      source: "provider_native",
      message: "Extracting provider output",
    });

    assert.deepEqual(JSON.parse(rawJson), {
      stageProgress: {
        schemaVersion: "stage_progress/v1",
        phase: "prd_briefing_questions",
        runId: "RUN-1",
        stageRunId: "STAGE-1",
        attemptNo: 1,
        status: "ingesting",
        source: "provider_native",
        message: "Extracting provider output",
      },
    });
  });
});
```

- [ ] **Step 5: Add frontend parser test**

Create a small parser helper near `event-stream-panel.tsx`, then test it in `stage-progress-events.test.ts`:

```ts
it("parses stage_progress rawJson from API and SSE event items", () => {
  const parsed = parseStageProgressRawJson(JSON.stringify({
    stageProgress: {
      schemaVersion: "stage_progress/v1",
      phase: "prd_briefing_questions",
      runId: "RUN-1",
      status: "failed",
      source: "none",
      message: "invalid_stage_output",
    },
  }));

  assert.equal(parsed?.status, "failed");
  assert.equal(parsed?.message, "invalid_stage_output");
});
```

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/state-machine-enums.test.ts server/services/stage-progress-service.test.ts
```

Expected: PASS.

## Task 3: Add Source Lineage Builder

**Files:**
- Modify: `server/services/stage-ai-output-contract.ts`
- Modify: `server/services/stage-authority-service.ts`
- Test: `server/services/stage-ai-output-ingestion-service.test.ts`

- [ ] **Step 1: Write lineage helper tests**

In `server/services/stage-ai-output-ingestion-service.test.ts`, add tests:

```ts
it("builds versioned source lineage with raw capture and normalized hashes", () => {
  const lineage = buildStageSourceLineage({
    sourceDbHashes: { prdBriefing: "hash-db" },
    inputDbHash: "hash-input",
    legacyRunId: "RUN-1",
    stageRunId: "STAGE-1",
    attemptNo: 1,
    provider: "claude",
    aiOutputMode: "json_schema",
    schemaDelivery: "schema_prompt",
    structuredOutputSource: "text_extracted",
    rawCaptureId: "ART-RAW",
    rawOutputArtifactId: "ART-RAW",
    rawText: "{\"ok\":true}",
    normalizedOutput: { ok: true },
    prompt: "prompt body",
    outputSchema: { type: "object" },
  });

  assert.equal(lineage.schemaVersion, "stage_source_lineage/v1");
  assert.equal(lineage.aiOutput.rawCaptureId, "ART-RAW");
  assert.equal(lineage.aiOutput.schemaDelivery, "schema_prompt");
  assert.equal(lineage.aiOutput.structuredOutputSource, "text_extracted");
  assert.ok(lineage.aiOutput.rawTextHash);
  assert.ok(lineage.aiOutput.normalizedOutputHash);
  assert.ok(lineage.promptHash);
  assert.ok(lineage.outputSchemaHash);
});
```

Expected: FAIL until helper exists.

- [ ] **Step 2: Implement `buildStageSourceLineage`**

Add a helper in `stage-ai-output-contract.ts`:

```ts
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
```

Use the project's existing stable JSON/hash utility if present. If the existing helper is not exported, add a local `stableStringify` and SHA-256 helper in this contract file.

- [ ] **Step 3: Route `stage_runs.sourceLineageJson` through the helper**

Update `server/services/stage-authority-service.ts` so stage run creation/update receives a `StageSourceLineageV1` object or stable JSON generated by `buildStageSourceLineage`. Do not allow callers to pass arbitrary lineage objects on new ingestion paths.

- [ ] **Step 4: Run lineage tests**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/stage-ai-output-ingestion-service.test.ts
```

Expected: PASS for lineage tests.

## Task 4: Build The Ingestion Service

**Files:**
- Create: `server/services/stage-ai-output-ingestion-service.ts`
- Modify: `server/services/stage-ai-output-contract.ts`
- Test: `server/services/stage-ai-output-ingestion-service.test.ts`

- [ ] **Step 1: Add extraction order tests**

Add tests proving this priority:

1. `provider_native`
2. fenced JSON
3. naked JSON
4. allowed file candidate
5. repair pass

```ts
it("prefers provider_native output before text and files", async () => {
  const result = await ingestStageAiOutput(fakeInput({
    aiResult: {
      structuredOutput: { source: "native" },
      summary: "```json\n{\"source\":\"text\"}\n```",
      structuredOutputSource: "provider_native",
      schemaDelivery: "provider_native",
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.structuredOutputSource, "provider_native");
  assert.deepEqual(result.structuredOutput, { source: "native" });
});
```

- [ ] **Step 2: Implement extraction functions**

In `stage-ai-output-ingestion-service.ts`, implement small pure helpers:

```ts
export function extractFencedJson(text: string): unknown | null;
export function extractNakedJson(text: string): unknown | null;
export function normalizeMarkdownCandidate(path: string, content: string): unknown;
```

`normalizeMarkdownCandidate(path, content)` must return `{ markdown: content }` for `.md` paths.

- [ ] **Step 3: Add file candidate restrictions**

Allowed file candidates must satisfy all conditions:

- Path is explicitly listed by the stage contract.
- Path stays under `.ship/changes/{changeId}` or the contract's explicit safe root.
- Path is not a symlink.
- File size is at most 1 MB.
- File changed between the before/after file snapshot when provider failed or timed out.

- [ ] **Step 4: Add markdown normalization tests**

Add tests:

```ts
it("normalizes markdown candidates internally without changing mirror content", async () => {
  const candidate = normalizeMarkdownCandidate(".ship/changes/CH/prd-draft.md", "# Draft");
  assert.deepEqual(candidate, { markdown: "# Draft" });
});
```

Add one test each for:

- `prd-draft.md`
- Spec red markdown candidate
- `release-note.md`
- `retro.md`

- [ ] **Step 5: Add repair pass behavior**

Repair pass runs only after provider structured output, text extraction, and allowed file candidates fail. The repair call must use:

- `outputMode: "json_schema"`
- the same `outputSchema`
- read-only sandbox for provider calls that support it
- timeout at or below 60 seconds
- `schemaDelivery` set from the provider result
- `structuredOutputSource: "repair_pass"` only if the repaired normalized output passes schema and business validation

- [ ] **Step 6: Add timeout recovered from file envelope**

When the provider returns `provider_timeout` but an allowed file candidate validates, the raw artifact must include:

```ts
{
  schemaVersion: "stage_ai_raw_output/v1",
  providerErrorCode: "provider_timeout",
  recoveredFromFile: true,
  candidate: {
    path: string,
    hash: string
  },
  normalizedPayload: unknown,
  validation: {
    schemaValid: true,
    businessValid: true
  }
}
```

The ingestion result must return `errorCode: "provider_timeout_recovered_from_file"` and `ok: true`.

- [ ] **Step 7: Run ingestion tests**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/stage-ai-output-ingestion-service.test.ts
```

Expected: PASS.

## Task 5: Update Codex And Claude Adapters

**Files:**
- Modify: `server/services/codex-engine.ts`
- Modify: `server/services/claude-engine.ts`
- Modify: `server/services/codex-engine.test.ts`
- Modify: `server/services/claude-engine.test.ts`

- [ ] **Step 1: Add Codex output schema tests**

In `server/services/codex-engine.test.ts`, mock the Codex client and assert:

```ts
it("passes outputSchema to thread.run", async () => {
  const outputSchema = { type: "object", required: ["ok"] };
  await engine.run({ prompt: "Return JSON", phase: "plan", outputSchema });
  assert.deepEqual(threadRunOptions.outputSchema, outputSchema);
});

it("passes outputSchema to runStreamed", async () => {
  const outputSchema = { type: "object", required: ["ok"] };
  const events = engine.runStreamed({ prompt: "Return JSON", phase: "plan", outputSchema });
  for await (const _event of events) break;
  assert.deepEqual(streamedOptions.outputSchema, outputSchema);
});
```

- [ ] **Step 2: Classify Codex metadata**

Update `CodexSdkEngine` results:

- `schemaDelivery: input.outputSchema ? "provider_native" : "none"`
- `schemaCapabilityInvoked: Boolean(input.outputSchema)`
- `structuredOutputSource: structuredOutput ? "provider_native" : parsedFromFinalResponse ? "text_extracted" : "none"`
- `providerErrorCode: "provider_run_failed"` or `"provider_timeout"` on failures.

- [ ] **Step 3: Add Claude schema prompt tests**

In `server/services/claude-engine.test.ts`, assert:

```ts
it("sets schemaDelivery schema_prompt via append system prompt", async () => {
  const outputSchema = { type: "object", required: ["ok"] };
  await engine.run({ prompt: "Return JSON", phase: "plan", outputSchema });
  assert.ok(spawnArgs.includes("--append-system-prompt"));
  assert.match(spawnArgs.join(" "), /required/);
});
```

- [ ] **Step 4: Classify Claude metadata**

Update `ClaudeSdkEngine` results:

- `schemaDelivery: input.outputSchema ? "schema_prompt" : "none"`
- `schemaCapabilityInvoked: Boolean(input.outputSchema)`
- `structuredOutputSource: extracted ? "text_extracted" : "none"`
- `providerErrorCode: "provider_run_failed"` or `"provider_timeout"` on failures.

- [ ] **Step 5: Run adapter tests**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/codex-engine.test.ts server/services/claude-engine.test.ts server/services/ai-engine-adapter.test.ts
```

Expected: PASS.

## Task 6: Integrate PRD Briefing MVP

**Files:**
- Modify: `server/services/prd-briefing-ledger.ts`
- Modify: `server/services/prd-briefing-service.ts`
- Modify: `server/services/pipeline-prd-briefing-stage-service.ts`
- Modify: `server/services/prd-briefing-service.test.ts`
- Modify: `server/services/intake-ui-flow.test.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/prd-briefing/route.ts`
- Modify: `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx`

- [ ] **Step 1: Export schemas**

In `prd-briefing-ledger.ts`, export:

```ts
export const BriefingQuestionsOutputSchema = z.array(/* existing question schema */);
export const PrdBriefingDraftOutputSchema = z.object({
  markdown: z.string().min(1),
}).strict();
export const FinalReviewOutputSchema = z.object(/* existing final review shape */).strict();
```

- [ ] **Step 2: Test all three stages route through ingestion**

In `prd-briefing-service.test.ts`, add tests:

- `generates questions through stage AI output ingestion`
- `generates draft through markdown envelope ingestion`
- `generates final review through stage AI output ingestion`
- `records failed stage progress when async generation rejects`

- [ ] **Step 3: Replace ad hoc parsing**

In `pipeline-prd-briefing-stage-service.ts`, remove local parsing based on `summary.trim()` or `startsWith("{")`. For each stage, call `ingestStageAiOutput` with a stage contract:

- `prd_briefing_questions`
- `prd_briefing_draft`
- `prd_briefing_final_review`

Allowed files:

- `.ship/changes/{changeId}/briefing-questions.json`
- `.ship/changes/{changeId}/prd-draft.md`
- `.ship/changes/{changeId}/prd-draft.json`
- `.ship/changes/{changeId}/prd-final-review.json`

- [ ] **Step 4: Persist DB before mirror**

Each PRD briefing contract must call existing DB update methods first:

- questions: save validated questions to PRD briefing DB state.
- draft: save validated markdown into PRD draft DB state.
- final review: save validated final review into PRD briefing DB state.

Only after DB write succeeds may the mirror renderer write `.ship` JSON/Markdown.

- [ ] **Step 5: Add stage progress to route and UI**

`GET /prd-briefing` must return latest `stageProgress`. The room UI must show:

- running provider state
- ingesting state
- repairing state
- invalid output failure
- provider timeout recovered from file warning

- [ ] **Step 6: Run PRD briefing tests**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/prd-briefing-service.test.ts server/services/intake-ui-flow.test.ts
```

Expected: PASS.

## Task 7: Enforce Review Raw Artifact Coverage

**Files:**
- Modify: `server/services/pipeline-service.ts`
- Modify: `server/services/review-run-service.ts`
- Modify: `server/services/pipeline-service.test.ts`

- [ ] **Step 1: Add terminal path tests**

In `pipeline-service.test.ts`, add or strengthen tests:

- `records raw output artifact for successful Review`
- `records raw output artifact for invalid Review output`
- `records raw output artifact for provider failure`
- `recovers provider timeout from file candidate and keeps rawOutputArtifactId non-empty`

Each test must assert:

```ts
assert.ok(attempt?.rawOutputArtifactId);
```

- [ ] **Step 2: Preserve raw artifact on success**

Ensure Review success writes raw artifact first, then creates/completes `review_attempts` with `rawOutputArtifactId`.

- [ ] **Step 3: Preserve raw artifact on invalid output**

When Review output fails schema or business validation, write raw artifact with:

- raw provider text or structured output
- normalized payload when available
- validation result
- `errorCode: "invalid_review_output"`

- [ ] **Step 4: Preserve raw artifact on provider failure**

When provider fails before valid output exists, write raw artifact envelope with:

- provider
- provider error code
- sanitized provider summary
- run id
- attempt number

- [ ] **Step 5: Preserve raw artifact on timeout recovered from file**

When provider times out but a file candidate validates:

- attempt terminal status must be successful or recovered according to existing Review status conventions.
- `rawOutputArtifactId` must be non-empty.
- raw artifact must include timeout envelope, candidate path/hash, normalized payload, and validation result.

- [ ] **Step 6: Run Review tests**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/pipeline-service.test.ts
```

Expected: PASS.

## Task 8: Preserve Bare Markdown Mirrors

**Files:**
- Modify: `server/services/pipeline-document-stage-runner-service.ts`
- Modify: `server/services/pipeline-release-retro-stage-service.ts`
- Modify: Spec red parser call site in `server/services/pipeline-service.ts` or the current extracted Spec battle service
- Modify: `server/services/phase-artifact-service.test.ts`
- Modify: `server/services/retro-service.test.ts`
- Modify: `server/services/spec-battle-service.test.ts`

- [ ] **Step 1: Add mirror preservation tests**

Add tests proving these mirror files remain bare Markdown:

- `prd-draft.md`
- Spec red markdown artifact
- `release-note.md`
- `retro.md`

Assertion pattern:

```ts
assert.equal(fileContent.startsWith("{"), false);
assert.match(fileContent, /^#/);
```

- [ ] **Step 2: Normalize internally only**

All `.md` file candidates must use:

```ts
const normalized = { markdown: fileContent };
```

before schema and business validation. Do not persist this envelope to `.md` mirrors.

- [ ] **Step 3: Map markdown envelope to existing domain fields**

For Spec red output, map `{ markdown }` into the existing field expected by `parseRedSpecOutput`, such as `prdDeltaMarkdown`, inside the contract adapter. Do not teach `parseRedSpecOutput` to accept multiple unrelated shapes.

- [ ] **Step 4: Run markdown tests**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/phase-artifact-service.test.ts server/services/retro-service.test.ts server/services/spec-battle-service.test.ts
```

Expected: PASS.

## Task 9: Wire Action Contract Retry Semantics

**Files:**
- Modify: `server/services/action-contract-service.ts`
- Modify: `server/services/action-contract-service.test.ts`
- Modify: `server/services/action-contract-types.ts`

- [ ] **Step 1: Add failure/retry tests**

Add tests:

- `offers retry when stage output is invalid`
- `offers retry when provider timed out`
- `shows recovered warning when provider timeout recovered from file`
- `does not block when mirror write fails after DB persistence`

- [ ] **Step 2: Read stage authority first**

Action Contract should read:

1. latest `stage_runs` and `stage_progress`
2. Review attempt state for Review phases
3. legacy `runs` and `events` as fallback

- [ ] **Step 3: Map error codes**

Map retryable failures:

- `provider_timeout`
- `provider_run_failed`
- `invalid_stage_output`
- `invalid_review_output`
- `file_candidate_invalid`
- `repair_failed`

Map non-blocking warning:

- `provider_timeout_recovered_from_file`

Map degraded mirror state:

- `mirror_write_failed`

- [ ] **Step 4: Run Action Contract tests**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/action-contract-service.test.ts
```

Expected: PASS.

## Task 10: Full Verification

**Files:**
- Verify all files modified by prior tasks.

- [ ] **Step 1: Run focused test suite**

Run:

```bash
npx tsx --test --test-concurrency=1 \
  server/services/state-machine-enums.test.ts \
  server/services/stage-progress-service.test.ts \
  server/services/stage-ai-output-ingestion-service.test.ts \
  server/services/codex-engine.test.ts \
  server/services/claude-engine.test.ts \
  server/services/prd-briefing-service.test.ts \
  server/services/intake-ui-flow.test.ts \
  server/services/pipeline-service.test.ts \
  server/services/action-contract-service.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Manual smoke path**

Run one PRD briefing flow with Claude and one with Codex. Confirm:

- UI displays provider running, ingesting, and completed states.
- If provider output is invalid, UI displays failure reason and retry action.
- DB records are updated before JSON/Markdown mirrors.
- `.md` mirrors remain bare Markdown.
- `stage_runs.sourceLineageJson.schemaVersion === "stage_source_lineage/v1"`.
- `EventType.safeParse("stage_progress").success === true`.

## Implementation Order

1. Contract types and adapter metadata.
2. Stage progress event contract.
3. Source lineage builder.
4. Ingestion service core.
5. Codex and Claude adapter metadata.
6. PRD Briefing MVP integration.
7. Review raw artifact coverage.
8. Bare Markdown mirror preservation.
9. Action Contract retry semantics.
10. Focused and full verification.

## Acceptance Checklist

- [ ] `StructuredOutputSource` does not contain `schema_prompt`.
- [ ] `SchemaDelivery` records Codex native schema delivery and Claude prompt schema delivery.
- [ ] `EventType.safeParse("stage_progress").success === true`.
- [ ] Every `stage_progress` event stores `rawJson` as `{ "stageProgress": ... }`.
- [ ] Every ingestion-managed `stage_runs.sourceLineageJson` uses `schemaVersion: "stage_source_lineage/v1"`.
- [ ] Every Review terminal path keeps `review_attempts.rawOutputArtifactId` non-empty.
- [ ] Provider timeout recovered from file records timeout envelope, candidate path/hash, normalized payload, and validation result.
- [ ] `.md` candidates normalize internally to `{ markdown }`.
- [ ] `.md` mirrors remain bare Markdown.
- [ ] PRD Briefing questions, draft, and final review no longer parse AI output ad hoc.
- [ ] UI shows process and failure reason instead of appearing stuck.
- [ ] Action Contract exposes retry for malformed AI output and provider failures.
- [ ] Focused test suite passes.
- [ ] `pnpm test` passes.
