import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildStageSourceLineage,
  STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION,
  terminalStageProgressStatus,
} from "./stage-ai-output-contract.ts";
import { applyLineProtocol, guardLineProtocolSchema } from "./ai-line-protocol.ts";
import { parsePlanLineProtocol } from "./plan-line-protocol.ts";
import {
  extractFencedJson,
  extractNakedJson,
  ingestStageAiOutput,
  normalizeMarkdownCandidate,
  type CandidateFileReadResult,
  type StageAiOutputIngestionInput,
  type StageAiOutputIngestionResult,
} from "./stage-ai-output-ingestion-service.ts";
import {
  persistStageRawCapture,
  type PersistStageRawCaptureInput,
} from "./stage-raw-capture-service.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("stage AI output ingestion service foundations", () => {
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

  it("persists stage raw capture as a run artifact and summary event", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "stage-raw-capture-"));
    tempDirs.push(repoPath);
    const artifacts: unknown[] = [];
    const events: { rawJson: string; type: string }[] = [];

    const input: PersistStageRawCaptureInput = {
      repoPath,
      changeId: "CH",
      runId: "RUN-1",
      envelope: {
        schemaVersion: STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION,
        phase: "plan",
        provider: "codex",
        schemaDelivery: "schema_prompt",
        structuredOutputSource: "none",
        errorCode: "invalid_stage_output",
        providerErrorCode: null,
        rawText: "full raw provider output",
        rawTextHash: hashString("full raw provider output"),
        rawTextPreview: "full raw provider output",
        normalizedPayload: { b: 2, a: 1 },
      },
      ledger: {
        nextId: (prefix) => (prefix === "ART" ? "ART-001" : "EVT-001"),
        insertArtifact: (row) => {
          artifacts.push(row);
        },
        insertEvent: (row) => {
          events.push(row);
        },
        nowISO: () => "2026-07-07T00:00:00.000Z",
      },
      // @ts-expect-error raw capture path must remain deterministic and not accept fileName overrides.
      fileName: "overridden-raw-output.json",
    };

    const result = await persistStageRawCapture(input);

    const expectedPath = path.join(
      repoPath,
      ".ship",
      "changes",
      "CH",
      "runs",
      "RUN-1",
      "raw-ai-output.json",
    );
    assert.equal(result.artifactId, "ART-001");
    assert.equal(result.eventId, "EVT-001");
    assert.equal(result.artifactPath, expectedPath);
    assert.ok(fs.existsSync(expectedPath));
    assert.equal(
      fs.existsSync(
        path.join(
          repoPath,
          ".ship",
          "changes",
          "CH",
          "runs",
          "RUN-1",
          "overridden-raw-output.json",
        ),
      ),
      false,
    );
    assert.equal(JSON.parse(fs.readFileSync(expectedPath, "utf8")).rawText, "full raw provider output");
    assert.deepEqual(artifacts, [
      {
        id: "ART-001",
        changeId: "CH",
        runId: "RUN-1",
        type: "stage_raw_output",
        path: expectedPath,
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "stage_raw_output");

    const raw = JSON.parse(events[0].rawJson) as {
      stageRawOutput: Record<string, unknown>;
    };
    assert.equal(raw.stageRawOutput.artifactId, "ART-001");
    assert.equal(raw.stageRawOutput.artifactPath, expectedPath);
    assert.equal(raw.stageRawOutput.artifactHash, result.artifactHash);
    assert.equal(raw.stageRawOutput.phase, "plan");
    assert.equal(raw.stageRawOutput.provider, "codex");
    assert.equal(raw.stageRawOutput.structuredOutputSource, "none");
    assert.equal(raw.stageRawOutput.rawTextHash, hashString("full raw provider output"));
    assert.equal(raw.stageRawOutput.rawTextLength, "full raw provider output".length);
    assert.equal("rawTextPreview" in raw.stageRawOutput, false);
    assert.ok(raw.stageRawOutput.normalizedPayloadHash);
    assert.equal("rawText" in raw.stageRawOutput, false);
    assert.equal("normalizedPayload" in raw.stageRawOutput, false);
  });

  it("persists concurrent raw captures with unique ledger ids", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "stage-raw-capture-"));
    tempDirs.push(repoPath);
    const artifacts: Array<{ id: string }> = [];
    const events: Array<{ id: string }> = [];
    const input = (runId: string): PersistStageRawCaptureInput => ({
      repoPath,
      changeId: "CH-CONCURRENT",
      runId,
      envelope: {
        schemaVersion: STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION,
        phase: "test_plan",
        provider: "codex",
        schemaDelivery: "provider_native",
        structuredOutputSource: "none",
        errorCode: "provider_run_failed",
        providerErrorCode: "provider_run_failed",
        rawText: `provider failed for ${runId}`,
      },
      ledger: {
        nextId: (prefix) => `${prefix}-001`,
        insertArtifact: (row) => {
          if (artifacts.some((artifact) => artifact.id === row.id)) {
            throw new Error(`duplicate artifact id: ${row.id}`);
          }
          artifacts.push({ id: row.id });
        },
        insertEvent: (row) => {
          if (events.some((event) => event.id === row.id)) {
            throw new Error(`duplicate event id: ${row.id}`);
          }
          events.push({ id: row.id });
        },
        nowISO: () => "2026-07-07T00:00:00.000Z",
      },
    });

    await Promise.all([
      persistStageRawCapture(input("RUN-A")),
      persistStageRawCapture(input("RUN-B")),
    ]);

    assert.equal(artifacts.length, 2);
    assert.equal(events.length, 2);
    assert.equal(new Set(artifacts.map((artifact) => artifact.id)).size, 2);
    assert.equal(new Set(events.map((event) => event.id)).size, 2);
  });

  it("ingests concurrent outputs and writes two raw capture ledger entries", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "stage-raw-capture-"));
    tempDirs.push(repoPath);
    const artifacts: Array<{ id: string }> = [];
    const events: Array<{ id: string }> = [];
    const ledger: PersistStageRawCaptureInput["ledger"] = {
      nextId: (prefix) => `${prefix}-001`,
      insertArtifact: (row) => {
        if (artifacts.some((artifact) => artifact.id === row.id)) {
          throw new Error(`duplicate artifact id: ${row.id}`);
        }
        artifacts.push({ id: row.id });
      },
      insertEvent: (row) => {
        if (events.some((event) => event.id === row.id)) {
          throw new Error(`duplicate event id: ${row.id}`);
        }
        events.push({ id: row.id });
      },
      nowISO: () => "2026-07-07T00:00:00.000Z",
    };

    const ingest = (runId: string) =>
      ingestStageAiOutput({
        ...fakeInput({
          changeId: "CH-CONCURRENT-INGEST",
          aiResult: {
            summary: "provider crashed",
            success: false,
            providerErrorCode: "provider_run_failed",
            providerErrorDetail: "backend unavailable",
          },
          contract: {
            writeRawCapture: (envelope) =>
              persistStageRawCapture({
                repoPath,
                changeId: "CH-CONCURRENT-INGEST",
                runId,
                envelope,
                ledger,
              }),
          },
        }),
        changeId: "CH-CONCURRENT-INGEST",
        runId,
        phase: "test_plan",
        provider: "codex",
      });

    const results = await Promise.all([ingest("RUN-A"), ingest("RUN-B")]);

    assert.deepEqual(results.map((result) => result.errorCode), [
      "provider_run_failed",
      "provider_run_failed",
    ]);
    assert.equal(artifacts.length, 2);
    assert.equal(events.length, 2);
    assert.equal(new Set(artifacts.map((artifact) => artifact.id)).size, 2);
    assert.equal(new Set(events.map((event) => event.id)).size, 2);
  });

  it("rejects unsafe raw capture change and run path segments", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "stage-raw-capture-"));
    tempDirs.push(repoPath);
    const baseInput: PersistStageRawCaptureInput = {
      repoPath,
      changeId: "CH",
      runId: "RUN-1",
      envelope: {
        schemaVersion: STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION,
        rawText: "raw",
      },
      ledger: {
        nextId: (prefix) => (prefix === "ART" ? "ART-001" : "EVT-001"),
        insertArtifact: () => undefined,
        insertEvent: () => undefined,
        nowISO: () => "2026-07-07T00:00:00.000Z",
      },
    };

    for (const changeId of ["", "../CH", "CH/1", "CH\\1"]) {
      await assert.rejects(
        persistStageRawCapture({ ...baseInput, changeId }),
        /Invalid raw capture changeId path segment/,
      );
    }

    for (const runId of ["", "../RUN-1", "RUN/1", "RUN\\1"]) {
      await assert.rejects(
        persistStageRawCapture({ ...baseInput, runId }),
        /Invalid raw capture runId path segment/,
      );
    }
  });

  it("prefers provider_native output before text and files", async () => {
    let fileReads = 0;
    const captures: RawCaptureForTest[] = [];

    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          structuredOutput: { source: "native" },
          summary: "```json\n{\"source\":\"text\"}\n```",
          success: true,
          structuredOutputSource: "provider_native",
          schemaDelivery: "provider_native",
        },
        contract: {
          writeRawCapture: async (envelope) => {
            captures.push(envelope as RawCaptureForTest);
          },
          readCandidateFile: async () => {
            fileReads += 1;
            return candidateFile(".ship/changes/CH/output.json", "{\"source\":\"file\"}");
          },
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.structuredOutputSource, "provider_native");
    assert.deepEqual(result.structuredOutput, { source: "native" });
    assert.equal(fileReads, 0);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].schemaVersion, "stage_ai_raw_output/v1");
    assert.equal(captures[0].structuredOutputSource, "provider_native");
    assert.equal(captures[0].schemaDelivery, "provider_native");
    assert.equal(captures[0].errorCode, null);
    assert.equal(captures[0].rawTextHash, hashString("```json\n{\"source\":\"text\"}\n```"));
    assert.equal(captures[0].rawTextPreview, "```json\n{\"source\":\"text\"}\n```");
    assert.deepEqual(captures[0].normalizedPayload, { source: "native" });
    assert.deepEqual(captures[0].validation, {
      schemaValid: true,
      businessValid: true,
    });
  });

  it("extracts fenced JSON before naked JSON", async () => {
    assert.deepEqual(extractFencedJson("```json\n{\"source\":\"fenced\"}\n```"), {
      source: "fenced",
    });
    assert.deepEqual(extractFencedJson("```\n{\"source\":\"plain-fence\"}\n```"), {
      source: "plain-fence",
    });
    assert.deepEqual(extractNakedJson(" { \"source\": \"naked\" } "), {
      source: "naked",
    });
    assert.equal(extractNakedJson("prefix { \"source\": \"slice\" } suffix"), null);

    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          summary: "```json\n{\"source\":\"fenced\"}\n```\n{\"source\":\"naked\"}",
          success: true,
          schemaDelivery: "schema_prompt",
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.structuredOutputSource, "text_extracted");
    assert.deepEqual(result.structuredOutput, { source: "fenced" });
  });

  it("tries naked JSON after fenced JSON validation fails", async () => {
    const summary = JSON.stringify([
      "```[0]```",
      { source: "naked-valid" },
    ]);
    const attempts: unknown[] = [];

    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          summary,
          success: true,
          schemaDelivery: "schema_prompt",
        },
        contract: {
          validateSchema: (value) => {
            attempts.push(value);
            return Array.isArray(value) && value.length === 2;
          },
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.structuredOutputSource, "text_extracted");
    assert.deepEqual(result.structuredOutput, [
      "```[0]```",
      { source: "naked-valid" },
    ]);
    assert.deepEqual(attempts, [
      [0],
      [
        "```[0]```",
        { source: "naked-valid" },
      ],
    ]);
  });

  it("normalizes prd-draft.md file candidates to markdown before validation", async () => {
    assert.deepEqual(
      normalizeMarkdownCandidate(".ship/changes/CH/prd-draft.md", "# Draft"),
      { markdown: "# Draft" },
    );

    const seen = await ingestMarkdownCandidate(".ship/changes/CH/prd-draft.md", "# Draft");
    assert.deepEqual(seen.businessValues, [{ markdown: "# Draft" }]);
  });

  it("normalizes spec red markdown candidates before business validation", async () => {
    const seen = await ingestMarkdownCandidate(".ship/changes/CH/spec-red.md", "# Spec red");

    assert.deepEqual(seen.businessValues, [{ markdown: "# Spec red" }]);
  });

  it("normalizes release-note.md and retro.md candidates before business validation", async () => {
    const releaseSeen = await ingestMarkdownCandidate(
      ".ship/changes/CH/release-note.md",
      "# Release",
    );
    const retroSeen = await ingestMarkdownCandidate(".ship/changes/CH/retro.md", "# Retro");

    assert.deepEqual(releaseSeen.businessValues, [{ markdown: "# Release" }]);
    assert.deepEqual(retroSeen.businessValues, [{ markdown: "# Retro" }]);
  });

  it("runs repair pass only after structured text and allowed files fail", async () => {
    const attempts: string[] = [];

    const result = await ingestStageAiOutput(
      fakeInput({
        outputSchema: { type: "object" },
        aiResult: {
          structuredOutput: { source: "provider-invalid" },
          summary: "```json\n{\"source\":\"text-invalid\"}\n```",
          success: true,
          schemaDelivery: "schema_prompt",
        },
        contract: {
          allowedCandidateFiles: [".ship/changes/CH/output.json"],
          validateSchema: (value) => {
            attempts.push(`schema:${(value as { source?: string }).source}`);
            return (value as { source?: string }).source === "repair";
          },
          validateBusiness: (value) => {
            attempts.push(`business:${(value as { source?: string }).source}`);
            return true;
          },
          readCandidateFile: async () =>
            candidateFile(".ship/changes/CH/output.json", "{\"source\":\"file-invalid\"}"),
          repair: async (input) => {
            assert.equal(input.outputMode, "json_schema");
            assert.deepEqual(input.outputSchema, { type: "object" });
            assert.equal(input.sandboxMode, "read-only");
            assert.ok(input.timeoutMs <= 60_000);
            return { source: "repair" };
          },
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.structuredOutputSource, "repair_pass");
    assert.deepEqual(result.structuredOutput, { source: "repair" });
    assert.deepEqual(attempts, [
      "schema:provider-invalid",
      "schema:text-invalid",
      "schema:file-invalid",
      "schema:repair",
      "business:repair",
    ]);
  });

  it("records provider_timeout_recovered_from_file envelope", async () => {
    const captures: RawCaptureForTest[] = [];
    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          summary: "",
          success: false,
          providerErrorCode: "provider_timeout",
          schemaDelivery: "schema_prompt",
        },
        contract: {
          allowedCandidateFiles: [".ship/changes/CH/output.json"],
          writeRawCapture: async (envelope) => {
            captures.push(envelope as RawCaptureForTest);
          },
          readCandidateFile: async () =>
            candidateFile(".ship/changes/CH/output.json", "{\"source\":\"file\"}"),
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.errorCode, "provider_timeout_recovered_from_file");
    assert.equal(result.structuredOutputSource, "file_candidate");
    assert.deepEqual(result.structuredOutput, { source: "file" });
    assert.equal(result.rawCaptureEnvelope?.schemaVersion, "stage_ai_raw_output/v1");
    assert.equal(result.rawCaptureEnvelope?.providerErrorCode, "provider_timeout");
    assert.equal(result.rawCaptureEnvelope?.recoveredFromFile, true);
    assert.equal(result.rawCaptureEnvelope?.candidate?.path, ".ship/changes/CH/output.json");
    assert.ok(result.rawCaptureEnvelope?.candidate?.hash);
    assert.deepEqual(result.rawCaptureEnvelope?.normalizedPayload, { source: "file" });
    assert.deepEqual(result.rawCaptureEnvelope?.validation, {
      schemaValid: true,
      businessValid: true,
    });
    assert.equal(captures.length, 1);
    assert.equal(captures[0].errorCode, "provider_timeout_recovered_from_file");
    assert.equal(captures[0].structuredOutputSource, "file_candidate");
    assert.equal(captures[0].recoveredFromFile, true);
  });

  it("writes raw capture for invalid structured output", async () => {
    const captures: RawCaptureForTest[] = [];

    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          summary: "not json",
          success: true,
          schemaDelivery: "schema_prompt",
        },
        contract: {
          writeRawCapture: async (envelope) => {
            captures.push(envelope as RawCaptureForTest);
          },
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_stage_output");
    assert.equal(captures.length, 1);
    assert.equal(captures[0].structuredOutputSource, "none");
    assert.equal(captures[0].schemaDelivery, "schema_prompt");
    assert.equal(captures[0].errorCode, "invalid_stage_output");
    assert.equal(captures[0].rawTextHash, hashString("not json"));
    assert.equal(captures[0].rawTextPreview, "not json");
  });

  it("writes raw capture for provider failure", async () => {
    const captures: RawCaptureForTest[] = [];

    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          summary: "provider crashed with sk-live-secret-token and Bearer bearer-secret-token",
          success: false,
          providerErrorCode: "provider_run_failed",
          providerErrorDetail:
            "backend unavailable api_key=secret-key token=plain-token cookie=session-id authorization=Basic basic-secret password=pw client_secret=client-secret private_key=private-secret {\"token\":\"json-token\",\"client_secret\":\"json-client-secret\",\"cookie\":\"json-session\",\"authorization\":\"Basic json-basic-secret\"}",
        },
        contract: {
          writeRawCapture: async (envelope) => {
            captures.push(envelope as RawCaptureForTest);
          },
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "provider_run_failed");
    assert.equal(captures.length, 1);
    assert.equal(captures[0].structuredOutputSource, "none");
    assert.equal(captures[0].providerErrorCode, "provider_run_failed");
    assert.equal(captures[0].errorCode, "provider_run_failed");
    assert.match(captures[0].sanitizedErrorSummary ?? "", /api_key=\[REDACTED\]/);
    assert.match(captures[0].sanitizedErrorSummary ?? "", /token=\[REDACTED\]/);
    assert.match(captures[0].sanitizedErrorSummary ?? "", /cookie=\[REDACTED\]/);
    assert.match(captures[0].sanitizedErrorSummary ?? "", /authorization=\[REDACTED\]/);
    assert.match(captures[0].sanitizedErrorSummary ?? "", /password=\[REDACTED\]/);
    assert.match(captures[0].sanitizedErrorSummary ?? "", /client_secret=\[REDACTED\]/);
    assert.match(captures[0].sanitizedErrorSummary ?? "", /private_key=\[REDACTED\]/);
    assert.equal(captures[0].rawText, captures[0].sanitizedErrorSummary);
    assert.equal(captures[0].rawTextHash, hashString(captures[0].rawText ?? ""));
    assert.doesNotMatch(
      JSON.stringify(captures[0]),
      /sk-live-secret-token|bearer-secret-token|secret-key|plain-token|session-id|basic-secret|password=pw|client-secret|private-secret|json-token|json-client-secret|json-session|json-basic-secret/i,
    );
  });

  it("rejects provider failure structured, text, and repair outputs by default", async () => {
    let repairCalls = 0;
    const captures: RawCaptureForTest[] = [];

    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          structuredOutput: { source: "native" },
          structuredOutputSource: "provider_native",
          summary: "```json\n{\"source\":\"text\"}\n```",
          success: false,
          providerErrorCode: "provider_auth_failed",
          providerErrorDetail: "auth failed",
          schemaDelivery: "provider_native",
        },
        contract: {
          repair: async () => {
            repairCalls += 1;
            return { source: "repair" };
          },
          writeRawCapture: async (envelope) => {
            captures.push(envelope as RawCaptureForTest);
          },
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "provider_run_failed");
    assert.equal(result.structuredOutputSource, "none");
    assert.equal(repairCalls, 0);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].structuredOutputSource, "none");
    assert.equal(captures[0].providerErrorCode, "provider_auth_failed");
    assert.deepEqual(captures[0].normalizedPayload, undefined);
  });

  it("writes raw capture for repair failure", async () => {
    const captures: RawCaptureForTest[] = [];

    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          summary: "{\"source\":\"invalid\"}",
          success: true,
          schemaDelivery: "schema_prompt",
        },
        contract: {
          validateSchema: () => false,
          repair: async () => {
            throw new Error("repair model unavailable");
          },
          writeRawCapture: async (envelope) => {
            captures.push(envelope as RawCaptureForTest);
          },
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "repair_failed");
    assert.equal(captures.length, 1);
    assert.equal(captures[0].structuredOutputSource, "none");
    assert.equal(captures[0].errorCode, "repair_failed");
    assert.match(captures[0].sanitizedErrorSummary ?? "", /repair model unavailable/);
    assert.equal(captures[0].rawTextHash, hashString("{\"source\":\"invalid\"}"));
  });

  it("keeps ingestion compatible when raw capture writer is absent", async () => {
    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          structuredOutput: { source: "native" },
          summary: "ignored",
          success: true,
          structuredOutputSource: "provider_native",
          schemaDelivery: "provider_native",
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.structuredOutput, { source: "native" });
    assert.equal(result.rawCaptureEnvelope?.structuredOutputSource, "provider_native");
  });

  it("rejects disallowed, symlink, oversized, or unchanged file candidates", async () => {
    await assertFileCandidateRejected(".ship/changes/CH/disallowed.json", {
      allowedCandidateFiles: [".ship/changes/CH/allowed.json"],
    });
    await assertFileCandidateRejected(".ship/changes/OTHER/output.json", {
      allowedCandidateFiles: [".ship/changes/OTHER/output.json"],
    });
    await assertFileCandidateRejected(".ship/changes/CH/output.json", {
      file: { isSymlink: true },
    });
    await assertFileCandidateRejected(".ship/changes/CH/output.json", {
      file: { sizeBytes: 1_048_577 },
    });
    await assertFileCandidateRejected(".ship/changes/CH/output.json", {
      file: { changed: false },
    });
  });

  /**
   * A read-only sandbox is the case where an unchanged candidate is *most*
   * suspect, not least: the provider physically could not have written the file,
   * so anything found there is stagepass's own mirror, and adopting it re-stamps
   * stale content as this run's fresh output. The check was once gated on
   * `&& !input.contract.sandboxReadOnly`, which disabled it exactly there.
   */
  it("rejects an unchanged file candidate even when the sandbox was read-only", async () => {
    await assertFileCandidateRejected(".ship/changes/CH/output.json", {
      sandboxReadOnly: true,
      file: { changed: false },
    });
  });

  /**
   * The other half of the same contract: read-only mode must not become a blanket
   * refusal either. A candidate this run demonstrably wrote is still adoptable,
   * so the fix above cannot be "reject everything under read-only".
   */
  it("still accepts a changed file candidate when the sandbox was read-only", async () => {
    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: { summary: "", success: false },
        contract: {
          allowedCandidateFiles: [".ship/changes/CH/output.json"],
          sandboxReadOnly: true,
          readCandidateFile: async () =>
            candidateFile(".ship/changes/CH/output.json", "{\"source\":\"file\"}", { changed: true }),
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.structuredOutputSource, "file_candidate");
  });
});

/**
 * guardLineProtocolSchema decides authority by object identity
 * (`value !== state.payload`), so it silently rejects every legitimate payload
 * the moment ingestion clones or round-trips a declared structuredOutput.
 * That coupling spans two modules with nothing enforcing it, so pin it here:
 * ingestion must hand validateSchema the very object it was given.
 */
describe("declared structuredOutput identity (line-protocol guard contract)", () => {
  it("passes the exact object reference through to validateSchema and validateBusiness", async () => {
    const payload = { findings: [], approved: true };
    const seenBySchema: unknown[] = [];
    const seenByBusiness: unknown[] = [];

    const result = await ingestStageAiOutput(
      fakeInput({
        aiResult: {
          summary: "FINDING lines here",
          success: true,
          structuredOutput: payload,
          structuredOutputSource: "line_protocol",
        },
        contract: {
          validateSchema: (value) => {
            seenBySchema.push(value);
            return true;
          },
          validateBusiness: (value) => {
            seenByBusiness.push(value);
            return true;
          },
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(seenBySchema.length, 1);
    assert.equal(seenBySchema[0], payload, "validateSchema must receive the same reference, not a copy");
    assert.equal(seenByBusiness[0], payload, "validateBusiness must receive the same reference, not a copy");
    assert.equal(result.structuredOutput, payload, "the accepted output must stay the same reference");
    assert.equal(result.structuredOutputSource, "line_protocol");
  });
});

/**
 * Attribution ordering: "did the provider deliver a reply?" is answered before
 * "is the reply well-formed?", and neither answer is allowed to borrow the
 * other's vocabulary. The bug this pins reported a provider killed by a machine
 * going to sleep as `line_protocol schema invalid: expected a MARKDOWN<< … >>
 * MARKDOWN block` — blaming the model for output it never produced.
 *
 * Both directions are pinned. A one-directional test would be satisfied by
 * relabelling every format error as a network fault, which is the same bug
 * pointing the other way.
 */
describe("failure attribution: delivery before format", () => {
  /**
   * Wires the modules exactly as pipeline-plan-stage-service does (a NON-briefing
   * call site, since the guard lives in the shared callee and every site
   * inherits it): applyLineProtocol -> guardLineProtocolSchema -> ingestion,
   * with the real plan parser and no candidate files.
   */
  async function ingestThroughPlanCallSite(
    aiResult: StageAiOutputIngestionInput["aiResult"],
  ): Promise<StageAiOutputIngestionResult> {
    const lineProtocol = applyLineProtocol(
      aiResult as unknown as Parameters<typeof applyLineProtocol>[0],
      (rawText, ctx) => {
        const parsed = parsePlanLineProtocol(rawText, ctx);
        return parsed.ok
          ? { ok: true as const, payload: parsed.payload as unknown as Record<string, unknown> }
          : parsed;
      },
      { changeId: "CH", repoPath: process.cwd() },
    );
    return ingestStageAiOutput({
      changeId: "CH",
      phase: "generate_plan",
      outputSchema: { type: "object" },
      aiResult: lineProtocol.result as unknown as StageAiOutputIngestionInput["aiResult"],
      contract: {
        allowedCandidateFiles: [],
        sandboxReadOnly: true,
        validateSchema: (value) =>
          guardLineProtocolSchema(lineProtocol.state, () => true, "generate_plan")(value),
        validateBusiness: () => true,
      },
    });
  }

  it("reports a killed provider run as an empty response, not a format error", async () => {
    // What the engine now hands ingestion for the RUN-230 shape.
    const result = await ingestThroughPlanCallSite({
      summary: "Codex run failed: codex produced no assistant message (exit null, signal SIGTERM)",
      success: false,
      providerErrorCode: "provider_empty_response",
      providerErrorDetail: "codex produced no assistant message (exit null, signal SIGTERM)",
      exitCode: null,
      signal: "SIGTERM",
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "provider_empty_response");
    assert.notEqual(result.structuredOutputSource, "line_protocol");
    assert.equal(
      result.sanitizedErrorSummary.includes("MARKDOWN"),
      false,
      "must not describe an absent reply as a malformed block",
    );
    // The user-facing half: causes listed, none asserted.
    assert.equal(result.sanitizedErrorSummary.includes("没有返回任何内容"), true);
    // Forensics survive into the artifact, so the next post-mortem is not guesswork.
    assert.equal(result.rawCaptureEnvelope?.providerSignal, "SIGTERM");
    assert.equal(result.rawCaptureEnvelope?.providerExitCode, null);
  });

  /**
   * The belt to the engine's brace. Any engine that reports success while
   * delivering nothing (claude's exit-0-with-no-result path, and anything added
   * later) is caught here rather than falling through to a format verdict.
   */
  it("reports an empty reply as an empty response even when the engine claimed success", async () => {
    const result = await ingestThroughPlanCallSite({ summary: "", success: true });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "provider_empty_response");
    assert.notEqual(result.structuredOutputSource, "line_protocol");
  });

  it("passes a transport fault through instead of flattening it", async () => {
    const result = await ingestThroughPlanCallSite({
      summary: "Codex run failed: Codex turn failed: stream disconnected before completion",
      success: false,
      providerErrorCode: "provider_transport_error",
      providerErrorDetail: "stream disconnected before completion: error sending request for url",
    });

    assert.equal(result.errorCode, "provider_transport_error");
    // The copy must name the provider link, not the model's output. Asserting on
    // "通信失败" rather than the full sentence keeps this pinned to the meaning
    // instead of the wording -- the sentence is user-facing copy and will be
    // retuned; the attribution it carries is the contract.
    assert.equal(result.sanitizedErrorSummary.includes("与模型服务的通信失败"), true);
  });

  /**
   * The other direction, and the one a careless fix breaks: the model DID reply,
   * the reply DID violate the protocol, and that must still be reported as a
   * stage-output problem. Relabelling this as a provider/transport failure would
   * send the user to check their network over a genuine format defect.
   */
  it("still reports a real reply that violates the protocol as invalid stage output", async () => {
    const result = await ingestThroughPlanCallSite({
      summary: "I looked at the repo and here is my plan, written as prose instead of protocol lines.",
      success: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_stage_output");
    assert.equal(
      result.errorCode.startsWith("provider_"),
      false,
      "a format defect must never be attributed to the provider",
    );
  });

  it("keeps blaming the model when the reply is only structurally wrong", async () => {
    // Real protocol keywords, structurally broken: an unterminated block.
    const result = await ingestThroughPlanCallSite({
      summary: ["PLAN: do the thing", "NOTES<<", "an unterminated block swallows the rest"].join("\n"),
      success: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_stage_output");
  });

  it("leaves the timeout code alone", async () => {
    const result = await ingestThroughPlanCallSite({
      summary: "Codex run failed: provider_timeout: codex timed out after 900000ms",
      success: false,
      providerErrorCode: "provider_timeout",
    });

    assert.equal(result.errorCode, "provider_timeout");
  });

  /**
   * The last hop to the human. `invalid_output` renders as "输出格式无效" — the
   * model's fault — so a provider that never replied must never reach it, or the
   * whole attribution fix stops at the UI boundary.
   */
  it("renders every provider-side failure as failed, never as invalid output", () => {
    for (const code of [
      "provider_run_failed",
      "provider_timeout",
      "provider_transport_error",
      "provider_empty_response",
    ]) {
      assert.equal(terminalStageProgressStatus(code), "failed", `${code} must render as failed`);
    }
    for (const code of ["invalid_stage_output", "invalid_review_output", "file_candidate_invalid"]) {
      assert.equal(
        terminalStageProgressStatus(code),
        "invalid_output",
        `${code} describes output the model actually produced`,
      );
    }
    // An unknown code is output the model produced until proven otherwise.
    assert.equal(terminalStageProgressStatus(undefined), "invalid_output");
  });
});

function fakeInput(
  overrides: Partial<StageAiOutputIngestionInput> & {
    contract?: Partial<StageAiOutputIngestionInput["contract"]>;
    aiResult?: Partial<StageAiOutputIngestionInput["aiResult"]>;
  } = {},
): StageAiOutputIngestionInput {
  return {
    changeId: "CH",
    outputSchema: overrides.outputSchema ?? { type: "object" },
    aiResult: {
      summary: "{}",
      success: true,
      schemaDelivery: "none",
      ...overrides.aiResult,
    },
    contract: {
      allowedCandidateFiles: [],
      validateSchema: () => true,
      validateBusiness: () => true,
      ...overrides.contract,
    },
  };
}

function candidateFile(
  path: string,
  content: string,
  overrides: Partial<CandidateFileReadResult> = {},
): CandidateFileReadResult {
  return {
    path,
    content,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    isSymlink: false,
    changed: true,
    ...overrides,
  };
}

interface RawCaptureForTest {
  schemaVersion: string;
  schemaDelivery?: string;
  structuredOutputSource?: string;
  errorCode?: string | null;
  providerErrorCode?: string | null;
  recoveredFromFile?: boolean;
  rawText?: string;
  rawTextHash?: string;
  rawTextPreview?: string;
  sanitizedErrorSummary?: string;
  normalizedPayload?: unknown;
  validation?: {
    schemaValid: boolean;
    businessValid: boolean;
  };
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function ingestMarkdownCandidate(path: string, content: string): Promise<{
  businessValues: unknown[];
}> {
  const businessValues: unknown[] = [];

  const result = await ingestStageAiOutput(
    fakeInput({
      aiResult: { summary: "", success: true },
      contract: {
        allowedCandidateFiles: [path],
        validateSchema: () => true,
        validateBusiness: (value) => {
          businessValues.push(value);
          return true;
        },
        readCandidateFile: async () => candidateFile(path, content),
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.structuredOutputSource, "file_candidate");
  assert.deepEqual(result.structuredOutput, { markdown: content });
  return { businessValues };
}

async function assertFileCandidateRejected(
  path: string,
  options: {
    allowedCandidateFiles?: string[];
    safeRoot?: string;
    sandboxReadOnly?: boolean;
    file?: Partial<CandidateFileReadResult>;
  } = {},
): Promise<void> {
  const result = await ingestStageAiOutput(
    fakeInput({
      aiResult: { summary: "", success: false },
      contract: {
        allowedCandidateFiles: options.allowedCandidateFiles ?? [path],
        safeRoot: options.safeRoot,
        sandboxReadOnly: options.sandboxReadOnly,
        readCandidateFile: async () =>
          candidateFile(path, "{\"source\":\"file\"}", options.file),
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.structuredOutputSource, "none");
}
