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
import { readCodexNativeFlags } from "../config/codex-native-flags";
import { runDocumentStage } from "./pipeline-document-stage-runner-service";
import {
  runDelegatedPhaseStage,
  type DelegatedPhaseDescriptor,
} from "./pipeline-delegated-phase-stage";
import {
  TECH_SPEC_DELEGATED_ROUND,
  TEST_PLAN_DELEGATED_ROUND,
} from "./delegated-round-phases";
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
// Declared in a leaf module so the delegated-round phase descriptors can name
// these without importing this stage service (that would be a cycle, and a
// cycle makes these schemas `undefined` at module-init). Re-exported here
// because callers already import TECH_SPEC_OUTPUT_SCHEMA from this module.
export {
  DESIGN_SECTIONS_SCHEMA,
  TECH_SPEC_OUTPUT_SCHEMA,
  TESTPLAN_OUTPUT_SCHEMA,
} from "./design-stage-output-schemas";
import {
  TECH_SPEC_OUTPUT_SCHEMA,
  TESTPLAN_OUTPUT_SCHEMA,
} from "./design-stage-output-schemas";

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

/**
 * Writes the TechSpec and API snapshot rows and their mirrors -- everything
 * except the gate.
 *
 * Split out so the delegated round can reuse it. The round must NOT reuse the
 * producer path's gate write: that one passes unconditionally, which is right
 * for a producer nobody critiques and wrong the moment blue can raise a
 * blocking gap. The round writes its own gate from the round's gaps
 * (syncDelegatedRoundStageAuthority) and everything up to that point is
 * identical, so it lives here rather than in two copies.
 *
 * Returns the `rows` the gate hashes, so whichever caller writes the gate hashes
 * exactly the same snapshot identity.
 */
export async function writeTechSpecAndApiSnapshots(input: {
  changeId: string;
  project: Project;
  runId: string;
  result: AiRunResult;
}): Promise<{ rows: Array<Record<string, unknown>> }> {
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
  const rows: Array<Record<string, unknown>> = [
    { table: "techspec_snapshots", id: techSpec.id, contentDbHash: techSpec.contentDbHash },
    { table: "api_snapshots", id: api.id, contractDbHash: api.contractDbHash },
  ];

  const techSpecMarkdown = renderDesignSnapshotMarkdown("TechSpec DB Snapshot", techSpec);
  const apiMarkdown = renderDesignSnapshotMarkdown("API DB Snapshot", api);
  renderTechSpecMirrors({
    project: input.project,
    changeId: input.changeId,
    generatedAt: reviewedAt,
    techSpec,
    api,
    techSpecMarkdown,
    apiMarkdown,
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
  return { rows };
}

async function persistTechSpecAndApiSnapshots(input: {
  changeId: string;
  project: Project;
  runId: string;
  result: AiRunResult;
}): Promise<{ skipDefaultArtifactWrite: true }> {
  const { rows } = await writeTechSpecAndApiSnapshots(input);

  const sourceDbHash = recomputeStageGate({
    changeId: input.changeId,
    phase: "TechSpec",
    status: "passed",
    blockers: [],
    freshness: { fresh: true },
    requiredActions: [],
    rows,
  }).sourceDbHash;
  // Before getActions: the action contract is computed from the gate, so a
  // rubric blocker appended afterwards would not reach the buttons until
  // something else happened to recompute it.
  reapplyRubricStageGateBlockers(input.changeId, "TechSpec");
  getActions(input.changeId);

  log.info({ changeId: input.changeId, sourceDbHash }, "TechSpec/API snapshots persisted");
  return { skipDefaultArtifactWrite: true };
}

function renderTechSpecMirrors(input: {
  project: Project;
  changeId: string;
  generatedAt: string;
  techSpec: { schemaVersion: string; contentDbHash: string; content: unknown };
  api: { schemaVersion: string; contractDbHash: string; contract: unknown };
  techSpecMarkdown: string;
  apiMarkdown: string;
}): void {
  renderMirrorsFromDb({
    repoPath: input.project.repoPath,
    changeId: input.changeId,
    generatedAt: input.generatedAt,
    mirrors: [
      {
        phase: "TechSpec",
        artifactType: "tech_spec_delta",
        fileName: "tech-spec-delta.md",
        schemaVersion: input.techSpec.schemaVersion,
        sourceDbHash: input.techSpec.contentDbHash,
        content: input.techSpecMarkdown,
      },
      {
        phase: "TechSpec",
        artifactType: "tech_spec_delta_json",
        fileName: "tech-spec-delta.json",
        schemaVersion: input.techSpec.schemaVersion,
        sourceDbHash: input.techSpec.contentDbHash,
        payload: input.techSpec.content,
      },
      {
        phase: "TechSpec",
        artifactType: "api_spec_delta",
        fileName: "api-spec-delta.md",
        schemaVersion: input.api.schemaVersion,
        sourceDbHash: input.api.contractDbHash,
        content: input.apiMarkdown,
      },
      {
        phase: "TechSpec",
        artifactType: "api_spec_delta_json",
        fileName: "api-spec-delta.json",
        schemaVersion: input.api.schemaVersion,
        sourceDbHash: input.api.contractDbHash,
        payload: input.api.contract,
      },
    ],
  });
}

/**
 * TechSpec as a delegated round.
 *
 * `persistRed` hands red's document to the phase's existing snapshot writer, so
 * the round and the single-turn path produce the same rows from the same
 * payload. What it deliberately does NOT do is call the producer path's
 * `recomputeStageGate({ status: "passed" })`: blue can raise a blocking gap, and
 * the gate is written from the round's gaps afterwards
 * (syncDelegatedRoundStageAuthority).
 */
function runTechSpecDelegatedRound(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
  adoptedResult?: AiRunResult,
): Promise<AiRunResult> {
  return runDelegatedPhaseStage({
    descriptor: TECH_SPEC_DELEGATED_ROUND as DelegatedPhaseDescriptor,
    changeId,
    context,
    provider: provider ?? context.provider ?? "codex",
    runningStatus: "TECHSPECCING",
    // The same status the single-turn path's `successStatus` reaches.
    settledStatus: "TECHSPEC_READY",
    failureStatus: "SPEC_READY",
    adoptedResult,
    persistRed: writeTechSpecAndApiSnapshots,
  });
}

export async function runTechSpec(
  changeId: string,
  _context?: JobExecutionContext,
  provider?: Provider,
  /** A judge turn this task already produced, once its questions converged. */
  adoptedResult?: AiRunResult,
): Promise<AiRunResult> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const battle = getSpecBattleState(changeId);
  if (change.gateState !== "spec" || battle.latestRound?.status !== "closed") {
    throw new Error("Spec gate is not approved");
  }
  // The delegated form replaces the whole single-turn producer path: red writes
  // the tech spec, blue critiques it, and the judge answers the verdict rubric,
  // all inside one turn. The flag is named for Spec because Spec is where it
  // started; it has controlled the delegated FORM rather than the Spec phase
  // since the generic layer landed.
  if (readCodexNativeFlags().specJudgeSubAgents && _context) {
    return runTechSpecDelegatedRound(changeId, _context, provider, adoptedResult);
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
    // §3: tech_spec is TechSpec's producer. With the delegated round off it is
    // also the only role, so the critic and verdict rubrics this phase now ships
    // go unanswered here -- the same shape Spec has on its own non-delegated
    // path, and the reason the round is what answers them.
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
  const { snapshot } = createTestPlanSnapshotRows(input);
  // The producer path approves as it writes, because a producer with no critic
  // has nobody who could object. The delegated round must NOT come through here
  // -- see writeTestPlanSnapshot.
  const gate = approveTestPlan({
    changeId: input.changeId,
    actor: "system",
    approvedAt: snapshot.createdAt,
  });
  await writeTestPlanRunArtifact({
    ...input,
    snapshot,
    gateStatus: gate.status,
    gateSourceDbHash: gate.sourceDbHash ?? "",
  });
  return { skipDefaultArtifactWrite: true };
}

/**
 * The TestPlan snapshot without the approval.
 *
 * `approveTestPlan` is the producer path's shortcut: it writes the snapshot AND
 * passes the gate in one call, which is correct only while nothing can object.
 * A delegated round's blue can object, so the round writes the snapshot here and
 * lets `syncDelegatedRoundStageAuthority` decide the gate from its gaps.
 */
export function writeTestPlanSnapshot(input: {
  changeId: string;
  result: AiRunResult;
  provider?: Provider;
}): { snapshot: ReturnType<typeof createTestPlanSnapshot>; rows: Array<Record<string, unknown>> } {
  return createTestPlanSnapshotRows(input);
}

function createTestPlanSnapshotRows(input: {
  changeId: string;
  result: AiRunResult;
  provider?: Provider;
}): { snapshot: ReturnType<typeof createTestPlanSnapshot>; rows: Array<Record<string, unknown>> } {
  const snapshotInput = requireValidTestPlanStructuredOutput(
    input.changeId,
    input.result.structuredOutput,
  );
  const snapshot = createTestPlanSnapshot({
    ...snapshotInput,
    provider: input.provider,
    createdAt: nowISO(),
  });
  return {
    snapshot,
    rows: [{ table: "testplan_snapshots", id: snapshot.id, snapshotDbHash: snapshot.snapshotDbHash }],
  };
}

export async function writeTestPlanRunArtifact(input: {
  changeId: string;
  project: Project;
  runId: string;
  snapshot: ReturnType<typeof createTestPlanSnapshot>;
  gateStatus: string;
  gateSourceDbHash: string;
}): Promise<void> {
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
      `snapshotId: ${input.snapshot.id}`,
      `gate: ${input.gateStatus}`,
      `sourceDbHash: ${input.gateSourceDbHash}`,
      "",
      input.snapshot.testIntent,
      "",
    ].join("\n"),
  );
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

/** TestPlan as a delegated round. Same shape as TechSpec's; see that comment. */
function runTestPlanDelegatedRound(
  changeId: string,
  context: JobExecutionContext,
  provider: Provider,
  adoptedResult?: AiRunResult,
): Promise<AiRunResult> {
  return runDelegatedPhaseStage({
    descriptor: TEST_PLAN_DELEGATED_ROUND as DelegatedPhaseDescriptor,
    changeId,
    context,
    provider,
    runningStatus: "TESTPLANNING",
    settledStatus: "TESTPLAN_DONE",
    failureStatus: "PLAN_APPROVED",
    adoptedResult,
    // `writeTestPlanSnapshot` rather than `persistTestPlanSnapshot`: the latter
    // calls `approveTestPlan`, which passes the gate as it writes. A round whose
    // critic has not been read yet must not approve anything.
    persistRed: async (input) => writeTestPlanSnapshot({
      changeId: input.changeId,
      result: input.result,
      provider,
    }),
  });
}

export async function runTestPlan(
  changeId: string,
  _context?: JobExecutionContext,
  provider?: Provider,
  adoptedResult?: AiRunResult,
): Promise<AiRunResult> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const selectedProvider = provider ?? _context?.provider ?? (change.provider as Provider);
  if (readCodexNativeFlags().specJudgeSubAgents && _context) {
    return runTestPlanDelegatedRound(changeId, _context, selectedProvider, adoptedResult);
  }
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
