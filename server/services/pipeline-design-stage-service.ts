import { eq } from "drizzle-orm";

import { db } from "../db";
import { changes } from "../db/schema";
import { createChildLogger } from "../logger";
import type { Change, ChangeStatus, Project } from "../types";
import type { AiRunResult } from "./ai-engine-types";
import type { JobExecutionContext } from "./job-execution-context";
import type { Provider } from "./provider-selection-service";
import { getActions } from "./action-contract-service";
import { renderMirrorsFromDb } from "./artifact-mirror-service";
import { runDocumentStage } from "./pipeline-document-stage-runner-service";
import { nowISO, writeRunOnlyArtifactBestEffort } from "./pipeline-run-ledger-service";
import { reapplyRubricStageGateBlockers } from "./rubric-gate-adapters";
import { getSpecBattleState } from "./spec-battle-service";
import { recomputeStageGate } from "./stage-authority-service";
import { parseTechSpecLineProtocol } from "./techspec-line-protocol";
import { parseTestPlanLineProtocol } from "./testplan-line-protocol";
import {
  createTechSpecAndApiSnapshots,
  normalizeDesignSections,
  type ApiSnapshot,
  type NormalizedDesignSections,
  type TechSpecSnapshot,
} from "./techspec-api-snapshot-service";
import {
  approveTestPlan,
  createTestPlanSnapshot,
  type CreateTestPlanSnapshotInput,
} from "./testplan-snapshot-service";

const log = createChildLogger("pipeline-design-stage-service");

/**
 * One design-sections group (a TechSpec content or an API contract), as the
 * line protocol assembles it. Sections stay `unknown[]` in
 * NormalizedDesignSections, so this schema is the only place the record shape
 * is pinned -- and it is pinned as the SECOND gate over stagepass's own
 * assembly, never handed to the provider (runDocumentStage suppresses
 * outputSchema whenever lineProtocol is set).
 */
const DESIGN_SECTIONS_SCHEMA = {
  type: "object",
  properties: {
    interfaces: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          change: { type: "string" },
        },
        required: ["name", "type", "change"],
        additionalProperties: false,
      },
    },
    dataContracts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          requiredFields: { type: "array", items: { type: "string" } },
          constraints: { type: "array", items: { type: "string" } },
        },
        required: ["name", "requiredFields", "constraints"],
        additionalProperties: false,
      },
    },
    migrationNotes: { type: "array", items: { type: "string" } },
    buildInputs: { type: "array", items: { type: "string" } },
    reviewInputs: { type: "array", items: { type: "string" } },
  },
  required: ["interfaces", "dataContracts", "migrationNotes", "buildInputs", "reviewInputs"],
  additionalProperties: false,
};

/**
 * `apiContract` is optional on purpose: a reply with no API_* line omits it, and
 * persistTechSpecAndApiSnapshots then derives the API contract from the tech
 * spec exactly as it does today (deriveApiContractFromTechSpec). Making it
 * required would have quietly retired the derive path that every existing
 * change actually used.
 */
export const TECH_SPEC_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    techSpec: DESIGN_SECTIONS_SCHEMA,
    apiContract: DESIGN_SECTIONS_SCHEMA,
  },
  required: ["techSpec"],
  additionalProperties: false,
};

const TESTPLAN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    testIntent: { type: "string" },
    coverageItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          itemKey: { type: "string" },
          title: { type: "string" },
          requirementRef: { type: ["string", "null"] },
          testType: { type: "string" },
          priority: { type: "string", enum: ["P0", "P1", "P2"] },
        },
        required: ["itemKey", "title", "requirementRef", "testType", "priority"],
        additionalProperties: false,
      },
    },
    riskMappings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          coverageItemKey: { type: "string" },
          riskRef: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          mitigation: { type: "string" },
        },
        required: ["coverageItemKey", "riskRef", "severity", "mitigation"],
        additionalProperties: false,
      },
    },
    requiredCommands: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          required: { type: "boolean" },
        },
        required: ["command", "required"],
        additionalProperties: false,
      },
    },
    manualChecks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: ["string", "null"] },
          required: { type: "boolean" },
        },
        required: ["title", "description", "required"],
        additionalProperties: false,
      },
    },
  },
  required: ["testIntent", "coverageItems", "riskMappings", "requiredCommands", "manualChecks"],
  additionalProperties: false,
};

function getChange(changeId: string): Change | undefined {
  return db.select().from(changes).where(eq(changes.id, changeId)).get() as Change | undefined;
}

function requireValidTestPlanStructuredOutput(
  changeId: string,
  value: unknown,
): CreateTestPlanSnapshotInput {
  if (!value || typeof value !== "object") {
    throw new Error("TestPlan generation requires AI structuredOutput");
  }
  const candidate = value as Partial<CreateTestPlanSnapshotInput>;
  if (typeof candidate.testIntent !== "string" || !candidate.testIntent.trim()) {
    throw new Error("TestPlan structuredOutput missing testIntent");
  }
  if (!Array.isArray(candidate.coverageItems) || candidate.coverageItems.length === 0) {
    throw new Error("TestPlan structuredOutput missing coverageItems");
  }
  if (!Array.isArray(candidate.riskMappings)) {
    throw new Error("TestPlan structuredOutput missing riskMappings");
  }
  if (!Array.isArray(candidate.requiredCommands) || candidate.requiredCommands.length === 0) {
    throw new Error("TestPlan structuredOutput missing requiredCommands");
  }
  if (!Array.isArray(candidate.manualChecks)) {
    throw new Error("TestPlan structuredOutput missing manualChecks");
  }

  return {
    changeId,
    status: "draft",
    testIntent: candidate.testIntent,
    coverageItems: candidate.coverageItems,
    riskMappings: candidate.riskMappings,
    requiredCommands: candidate.requiredCommands,
    manualChecks: candidate.manualChecks,
    schemaVersion: "testplan/v1",
  };
}

export function renderDesignSnapshotMarkdown(title: string, snapshot: TechSpecSnapshot | ApiSnapshot): string {
  const sections =
    "content" in snapshot ? snapshot.content : snapshot.contract;
  return [
    `# ${title}`,
    "",
    `schemaVersion: ${snapshot.schemaVersion}`,
    `status: ${snapshot.status}`,
    `sourceDbHash: ${"contentDbHash" in snapshot ? snapshot.contentDbHash : snapshot.contractDbHash}`,
    "",
    "## interfaces",
    "```json",
    JSON.stringify(sections.interfaces, null, 2),
    "```",
    "",
    "## dataContracts",
    "```json",
    JSON.stringify(sections.dataContracts, null, 2),
    "```",
    "",
    "## migrationNotes",
    "```json",
    JSON.stringify(sections.migrationNotes, null, 2),
    "```",
    "",
    "## buildInputs",
    "```json",
    JSON.stringify(sections.buildInputs, null, 2),
    "```",
    "",
    "## reviewInputs",
    "```json",
    JSON.stringify(sections.reviewInputs, null, 2),
    "```",
    "",
  ].join("\n");
}

function candidateObject(candidate: unknown): Record<string, unknown> | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

/**
 * The stage's structuredOutput is now mandatory.
 *
 * This used to read `input.result.structuredOutput ?? input.result.summary`.
 * With no `outputSchema` on the stage, runDocumentStage skipped ingestion
 * entirely, so `structuredOutput` was ALWAYS undefined and the fallback was the
 * only live branch: the raw reply text went to normalizeDesignSections, which
 * throws DesignSnapshotValidationError for anything that is not a JSON object.
 * The stage therefore could not fail cleanly -- the throw happened after the
 * provider was terminal, and because ingestion never ran there was no raw
 * capture to diff the drift against. Refusing a non-object here keeps the
 * failure inside the ingestion path, which writes the capture first.
 */
function requireTechSpecStructuredOutput(value: unknown): Record<string, unknown> {
  const record = candidateObject(value);
  if (!record) {
    throw new Error("TechSpec generation requires AI structuredOutput");
  }
  return record;
}

function selectTechSpecCandidate(candidate: unknown): unknown {
  const record = candidateObject(candidate);
  return record?.techSpec ?? record?.techspec ?? record?.technicalSpec ?? candidate;
}

function selectApiCandidate(candidate: unknown): unknown | null {
  const record = candidateObject(candidate);
  if (!record) return null;
  return record.apiContract ?? record.apiSpec ?? record.api ?? record.contract ?? null;
}

function deriveApiContractFromTechSpec(content: NormalizedDesignSections): NormalizedDesignSections {
  return {
    interfaces: content.interfaces,
    dataContracts: content.dataContracts,
    migrationNotes: content.migrationNotes,
    buildInputs: content.buildInputs,
    reviewInputs: content.reviewInputs,
  };
}

async function persistTechSpecAndApiSnapshots(input: {
  changeId: string;
  project: Project;
  runId: string;
  result: AiRunResult;
}): Promise<{ skipDefaultArtifactWrite: true }> {
  const reviewedAt = nowISO();
  const candidate = requireTechSpecStructuredOutput(input.result.structuredOutput);
  const techSpecCandidate = selectTechSpecCandidate(candidate);
  const normalizedTechSpec = normalizeDesignSections(techSpecCandidate);
  const apiCandidate = selectApiCandidate(candidate) ?? deriveApiContractFromTechSpec(normalizedTechSpec);
  const normalizedApi = normalizeDesignSections(apiCandidate);
  const { techSpec, api } = createTechSpecAndApiSnapshots({
    changeId: input.changeId,
    status: "approved",
    sourceSpecHash: input.result.threadId ?? input.runId,
    techSpecSchemaVersion: "techspec/v1",
    apiSchemaVersion: "api/v1",
    reviewedAt,
    createdAt: reviewedAt,
    techSpecContent: normalizedTechSpec,
    apiContract: normalizedApi,
  });

  const sourceDbHash = recomputeStageGate({
    changeId: input.changeId,
    phase: "TechSpec",
    status: "passed",
    blockers: [],
    freshness: { fresh: true },
    requiredActions: [],
    rows: [
      { table: "techspec_snapshots", id: techSpec.id, contentDbHash: techSpec.contentDbHash },
      { table: "api_snapshots", id: api.id, contractDbHash: api.contractDbHash },
    ],
  }).sourceDbHash;
  // Before getActions: the action contract is computed from the gate, so a
  // rubric blocker appended afterwards would not reach the buttons until
  // something else happened to recompute it.
  reapplyRubricStageGateBlockers(input.changeId, "TechSpec");
  getActions(input.changeId);

  const techSpecMarkdown = renderDesignSnapshotMarkdown("TechSpec DB Snapshot", techSpec);
  const apiMarkdown = renderDesignSnapshotMarkdown("API DB Snapshot", api);
  renderMirrorsFromDb({
    repoPath: input.project.repoPath,
    changeId: input.changeId,
    generatedAt: reviewedAt,
    mirrors: [
      {
        phase: "TechSpec",
        artifactType: "tech_spec_delta",
        fileName: "tech-spec-delta.md",
        schemaVersion: techSpec.schemaVersion,
        sourceDbHash: techSpec.contentDbHash,
        content: techSpecMarkdown,
      },
      {
        phase: "TechSpec",
        artifactType: "tech_spec_delta_json",
        fileName: "tech-spec-delta.json",
        schemaVersion: techSpec.schemaVersion,
        sourceDbHash: techSpec.contentDbHash,
        payload: techSpec.content,
      },
      {
        phase: "TechSpec",
        artifactType: "api_spec_delta",
        fileName: "api-spec-delta.md",
        schemaVersion: api.schemaVersion,
        sourceDbHash: api.contractDbHash,
        content: apiMarkdown,
      },
      {
        phase: "TechSpec",
        artifactType: "api_spec_delta_json",
        fileName: "api-spec-delta.json",
        schemaVersion: api.schemaVersion,
        sourceDbHash: api.contractDbHash,
        payload: api.contract,
      },
    ],
  });

  await writeRunOnlyArtifactBestEffort(
    input.project.repoPath,
    input.changeId,
    input.runId,
    "tech_spec",
    "tech_spec_delta",
    "tech-spec-delta.md",
    techSpecMarkdown,
  );
  await writeRunOnlyArtifactBestEffort(
    input.project.repoPath,
    input.changeId,
    input.runId,
    "tech_spec",
    "api_spec_delta",
    "api-spec-delta.md",
    apiMarkdown,
  );
  log.info({ changeId: input.changeId, sourceDbHash }, "TechSpec/API snapshots persisted");
  return { skipDefaultArtifactWrite: true };
}

export async function runTechSpec(
  changeId: string,
  _context?: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const battle = getSpecBattleState(changeId);
  if (change.gateState !== "spec" || battle.latestRound?.status !== "closed") {
    throw new Error("Spec gate is not approved");
  }
  return runDocumentStage(changeId, {
    phase: "tech_spec",
    promptPhase: "tech_spec",
    allowedStatuses: ["SPEC_READY"],
    runningStatus: "TECHSPECCING",
    successStatus: "TECHSPEC_READY",
    failureStatus: "SPEC_READY",
    artifactType: "tech_spec_delta",
    artifactFileName: "tech-spec-delta.md",
    successSummary: "Tech spec completed",
    provider,
    sessionKind: "general",
    // §3: tech_spec is TechSpec's producer, and the phase has no critic.
    rubricPhase: "TechSpec",
    additionalPromptFileName: "api-spec.md",
    outputSchema: TECH_SPEC_OUTPUT_SCHEMA,
    // The model writes protocol lines, never JSON; the schema above stays as
    // the second gate over the deterministically assembled payload. Setting
    // either one alone is not enough: without outputSchema runDocumentStage
    // skips the whole ingest/validate/raw-capture block, which is how this
    // stage ended up with no raw capture at all.
    lineProtocol: {
      parse: (rawText) => {
        const parsed = parseTechSpecLineProtocol(rawText);
        return parsed.ok
          ? { ok: true, payload: parsed.payload as unknown as Record<string, unknown> }
          : parsed;
      },
    },
    afterSuccessfulResult: persistTechSpecAndApiSnapshots,
  });
}

async function persistTestPlanSnapshot(input: {
  changeId: string;
  project: Project;
  runId: string;
  result: AiRunResult;
  provider?: Provider;
}): Promise<{ skipDefaultArtifactWrite: true }> {
  const snapshotInput = requireValidTestPlanStructuredOutput(
    input.changeId,
    input.result.structuredOutput,
  );
  const snapshot = createTestPlanSnapshot({
    ...snapshotInput,
    provider: input.provider,
    createdAt: nowISO(),
  });
  const gate = approveTestPlan({
    changeId: input.changeId,
    actor: "system",
    approvedAt: snapshot.createdAt,
  });
  await writeRunOnlyArtifactBestEffort(
    input.project.repoPath,
    input.changeId,
    input.runId,
    "test_plan",
    "test_plan_delta",
    "test-plan-delta.md",
    [
      "# TestPlan DB Snapshot",
      "",
      `snapshotId: ${snapshot.id}`,
      `gate: ${gate.status}`,
      `sourceDbHash: ${gate.sourceDbHash}`,
      "",
      snapshot.testIntent,
      "",
    ].join("\n"),
  );
  return { skipDefaultArtifactWrite: true };
}

/**
 * Exactly what runDocumentStage's assertStatus accepts for this stage, named so
 * the action contract can mirror it instead of guessing
 * (`retry_test_plan`'s requiredStatus).
 *
 * TESTPLANNING is deliberately absent: it is the stage's own running status, and
 * letting the guard accept it would make "TESTPLANNING" stop meaning "a
 * test_plan run is in flight". A change stranded there is repaired to
 * `failureStatus` first (recoverStrandedRunningStatus), then runs through this
 * guard unchanged -- so the contract advertises this list plus TESTPLANNING,
 * while the guard keeps taking only this list.
 */
const TEST_PLAN_ALLOWED_STATUSES: ChangeStatus[] = ["PLAN_APPROVED"];

export async function runTestPlan(
  changeId: string,
  _context?: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const selectedProvider = provider ?? _context?.provider ?? (change.provider as Provider);
  return runDocumentStage(changeId, {
    phase: "test_plan",
    promptPhase: "test_plan",
    allowedStatuses: TEST_PLAN_ALLOWED_STATUSES,
    runningStatus: "TESTPLANNING",
    successStatus: "TESTPLAN_DONE",
    failureStatus: "PLAN_APPROVED",
    artifactType: "test_plan_delta",
    artifactFileName: "test-plan-delta.md",
    successSummary: "Test plan completed",
    provider: selectedProvider,
    sessionKind: "general",
    // §3: test_plan is TestPlan's producer, and the phase has no critic.
    rubricPhase: "TestPlan",
    outputSchema: TESTPLAN_OUTPUT_SCHEMA,
    // The model writes protocol lines, never JSON; the schema above stays as
    // the second gate over the deterministically assembled payload.
    lineProtocol: {
      parse: (rawText, ctx) => {
        const parsed = parseTestPlanLineProtocol(rawText, ctx);
        return parsed.ok
          ? { ok: true, payload: parsed.payload as unknown as Record<string, unknown> }
          : parsed;
      },
    },
    afterSuccessfulResult: (input) => persistTestPlanSnapshot({ ...input, provider: selectedProvider }),
  });
}
