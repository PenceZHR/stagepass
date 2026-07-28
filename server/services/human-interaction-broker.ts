import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import {
  isCodexDecisionSurfaceEnabled,
  type CodexDecisionInteractionKind,
  type CodexDecisionPhase,
} from "../config/codex-decision-rollout";
import {
  readCodexNativeFlags,
  type CodexNativeFlags,
} from "../config/codex-native-flags";
import { db } from "../db";
import { resolveStageBinding } from "./codex-stage-binding-resolver";
import {
  changes,
  codexInteractions,
  codexThreadBindings,
  events,
  pipelineJobs,
  stageActions,
  stageGates,
} from "../db/schema";
import {
  createCodexInteractionRepository,
  type InteractionIdentity,
} from "../repositories/codex-interaction-repository";
import {
  InteractionFormSchema,
  type InteractionEnvelope,
  type InteractionForm,
} from "./interaction-types";

export type HumanInteractionBrokerDb = typeof db;

export interface EnsureInteractionInput {
  changeId: string;
  phase: CodexDecisionPhase;
  kind: CodexDecisionInteractionKind;
  title: string;
  summary: string;
  actionIds: string[];
  gateVersion: string;
  sourceDbHash: string;
  payload?: Record<string, unknown>;
  form?: InteractionForm;
  expectedHeadSha?: string | null;
  idempotencyKey?: string;
  expiresAt?: string;
}

export interface ReconcileInteractionContract {
  gateVersion: string;
  sourceDbHash: string;
}

export type DesignInteractionPhase =
  /**
   * PRD's gate decision, which had no server-opened card at all.
   *
   * The intake stage told the model in its prompt to present the approval card
   * itself. A card the server never opened has no interaction to authenticate
   * against, so the approval it collected was refused by the command gateway as
   * `submit_auth_required` -- every time, for every change. Putting PRD here
   * makes its decision arrive the same way Spec's does: opened by the server,
   * against a contract read from stage authority.
   */
  | "PRD"
  | "Spec"
  | "TechSpec"
  | "Plan"
  | "TestPlan";

export interface DesignInteractionFactProjection {
  roundNo?: number;
  reportHash?: string;
  artifactContentHash?: string;
  openGaps?: Array<{
    id: string;
    severity: "P0" | "P1" | "P2";
    evidenceIds: string[];
    proposedPatch: string | null;
  }>;
  blockers: Array<{
    id: string;
    severity: "P0" | "P1" | "P2";
    title: string;
  }>;
  risks: Array<{
    id: string;
    severity: "P0" | "P1" | "P2";
    title: string;
  }>;
  freshness: Record<string, unknown> & { fresh: boolean };
}

export interface ProjectDesignInteractionInput {
  changeId: string;
  phase: DesignInteractionPhase;
  kind: "gate_decision" | "risk_waiver";
  title: string;
  summary: string;
  actionIds: string[];
  contract: ReconcileInteractionContract;
  facts: DesignInteractionFactProjection;
  expectedHeadSha?: string | null;
}

export interface BuildInteractionFactProjection {
  buildRunId: string;
  purpose: "build" | "fix";
  baseCommit: string;
  sourceHeadSha: string;
  patchHash: string;
  changedFilesHash: string;
  changedFiles: string[];
  deviations: Array<{
    file: string;
    reason: string;
    severityHint: string;
  }>;
  blockers: string[];
  warnings: string[];
  diffReference: string | null;
}

export interface ProjectBuildInteractionInput {
  changeId: string;
  phase: "Build" | "Fix";
  title: string;
  summary: string;
  contract: ReconcileInteractionContract;
  facts: BuildInteractionFactProjection;
}

export interface ReviewInteractionFactProjection {
  reportId: string;
  reportHash: string;
  sourceBuildRunId: string;
  sourceHeadSha: string;
  findings: Array<{
    id: string;
    severity: "P0" | "P1" | "P2";
    title: string;
    status: string;
    waiverEligible: boolean;
  }>;
}

export interface QaInteractionFactProjection {
  testPlanSnapshotId: string;
  testPlanHash: string;
  qaRunId: string;
  sourceHeadSha: string;
  commandResults: Array<{
    id: string;
    status: string;
    evidenceIds: string[];
  }>;
  manualChecks: Array<{
    id: string;
    title: string;
    required: boolean;
  }>;
  freshness: Record<string, unknown> & { fresh: boolean };
}

export interface MergeInteractionFactProjection {
  readinessId: string;
  readinessHash: string;
  sourceHeadSha: string;
  blockers: Array<{
    id: string;
    severity: "P0" | "P1" | "P2";
    title?: string;
    reasonCode?: string;
  }>;
  acceptedRisk: Array<{ id: string; reason: string }>;
  approvalEligible: boolean;
}

interface ProjectReleaseInteractionInput<TFacts> {
  changeId: string;
  title: string;
  summary: string;
  contract: ReconcileInteractionContract;
  facts: TFacts;
}

export function projectReviewInteraction(
  input: ProjectReleaseInteractionInput<ReviewInteractionFactProjection>,
): EnsureInteractionInput {
  if (
    !input.facts.reportId
    || !input.facts.reportHash
    || !input.facts.sourceBuildRunId
    || !input.facts.sourceHeadSha
  ) throw new Error("review_interaction_facts_incomplete");
  return {
    changeId: input.changeId,
    phase: "Review",
    kind: "review_resolution",
    title: input.title,
    summary: input.summary,
    actionIds: ["waive_review_p1", "fix_blockers", "stop_change", "enter_qa"],
    gateVersion: input.contract.gateVersion,
    sourceDbHash: input.contract.sourceDbHash,
    expectedHeadSha: input.facts.sourceHeadSha,
    payload: {
      reportId: input.facts.reportId,
      reportHash: input.facts.reportHash,
      sourceBuildRunId: input.facts.sourceBuildRunId,
      sourceHeadSha: input.facts.sourceHeadSha,
      findings: input.facts.findings.slice(0, 100).map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title.slice(0, 1_024),
        status: finding.status.slice(0, 64),
        waiverEligible: finding.waiverEligible,
      })),
    },
    form: { fields: [] },
  };
}

export function projectQaInteraction(
  input: ProjectReleaseInteractionInput<QaInteractionFactProjection>,
): EnsureInteractionInput {
  if (
    !input.facts.testPlanSnapshotId
    || !input.facts.testPlanHash
    || !input.facts.qaRunId
    || !input.facts.sourceHeadSha
  ) throw new Error("qa_interaction_facts_incomplete");
  return {
    changeId: input.changeId,
    phase: "QA",
    kind: "gate_decision",
    title: input.title,
    summary: input.summary,
    actionIds: ["retry_qa", "record_qa_manual_check", "request_qa_fix"],
    gateVersion: input.contract.gateVersion,
    sourceDbHash: input.contract.sourceDbHash,
    expectedHeadSha: input.facts.sourceHeadSha,
    payload: {
      testPlanSnapshotId: input.facts.testPlanSnapshotId,
      testPlanHash: input.facts.testPlanHash,
      qaRunId: input.facts.qaRunId,
      sourceHeadSha: input.facts.sourceHeadSha,
      commandResults: input.facts.commandResults.slice(0, 100),
      manualChecks: input.facts.manualChecks.slice(0, 100),
      freshness: input.facts.freshness,
    },
    form: { fields: [] },
  };
}

export function projectMergeInteraction(
  input: ProjectReleaseInteractionInput<MergeInteractionFactProjection>,
): EnsureInteractionInput {
  if (
    !input.facts.readinessId
    || !input.facts.readinessHash
    || !input.facts.sourceHeadSha
  ) throw new Error("merge_interaction_facts_incomplete");
  return {
    changeId: input.changeId,
    phase: "Merge",
    kind: "merge_decision",
    title: input.title,
    summary: input.summary,
    actionIds: [
      "approve_merge",
      "reject_merge",
      "override_merge",
      "request_rework",
    ],
    gateVersion: input.contract.gateVersion,
    sourceDbHash: input.contract.sourceDbHash,
    expectedHeadSha: input.facts.sourceHeadSha,
    payload: {
      readinessId: input.facts.readinessId,
      readinessHash: input.facts.readinessHash,
      sourceHeadSha: input.facts.sourceHeadSha,
      blockers: input.facts.blockers.slice(0, 100),
      acceptedRisk: input.facts.acceptedRisk.slice(0, 100),
      approvalEligible: input.facts.approvalEligible,
    },
    form: { fields: [] },
  };
}

function boundedStrings(values: string[]): string[] {
  return [...new Set(values)].slice(0, 100).map((value) => value.slice(0, 1_024));
}

function sanitizedDiffReference(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/").slice(0, 1_024);
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").includes("..")
  ) {
    return "[redacted]";
  }
  return normalized;
}

/**
 * Projects only bounded Build/Fix evidence. The diff itself remains an
 * artifact and is represented by a sanitized reference.
 */
export function projectBuildInteraction(
  input: ProjectBuildInteractionInput,
): EnsureInteractionInput {
  if (
    !input.facts.buildRunId
    || !input.facts.baseCommit
    || !input.facts.sourceHeadSha
    || !input.facts.patchHash
    || !input.facts.changedFilesHash
  ) {
    throw new Error("build_interaction_facts_incomplete");
  }
  if (
    (input.phase === "Build" && input.facts.purpose !== "build")
    || (input.phase === "Fix" && input.facts.purpose !== "fix")
  ) {
    throw new Error("build_interaction_phase_mismatch");
  }
  const actionId =
    input.facts.purpose === "fix" ? "adopt_fix" : "adopt_build";
  return {
    changeId: input.changeId,
    phase: input.phase,
    kind: "build_adoption",
    title: input.title,
    summary: input.summary,
    actionIds: [actionId, "reject_build"],
    gateVersion: input.contract.gateVersion,
    sourceDbHash: input.contract.sourceDbHash,
    expectedHeadSha: input.facts.sourceHeadSha,
    payload: {
      buildRunId: input.facts.buildRunId,
      purpose: input.facts.purpose,
      baseCommit: input.facts.baseCommit,
      sourceHeadSha: input.facts.sourceHeadSha,
      patchHash: input.facts.patchHash,
      changedFilesHash: input.facts.changedFilesHash,
      changedFiles: boundedStrings(input.facts.changedFiles),
      deviations: input.facts.deviations.slice(0, 100).map((deviation) => ({
        file: deviation.file.slice(0, 1_024),
        reason: deviation.reason.slice(0, 256),
        severityHint: deviation.severityHint.slice(0, 64),
      })),
      blockers: boundedStrings(input.facts.blockers),
      warnings: boundedStrings(input.facts.warnings),
      diffReference: sanitizedDiffReference(input.facts.diffReference),
    },
    form: { fields: [] },
  };
}

/**
 * Converts authoritative design-stage facts into the generic interaction
 * envelope input. It deliberately carries only evidence/reference fields; the
 * MCP App stays schema-driven and never owns stage transition logic.
 */
export function projectDesignInteraction(
  input: ProjectDesignInteractionInput,
): EnsureInteractionInput {
  // PRD is identified the same way Spec is -- by the round that settled -- and
  // not by an artifact hash. Its stage writes `change-request.md`, but the thing
  // the human is ruling on is the round, and demanding a content hash here
  // would make the card impossible to open for the one phase that never had one.
  if (input.phase === "Spec" || input.phase === "PRD") {
    if (
      !Number.isInteger(input.facts.roundNo)
      || !input.facts.reportHash
    ) {
      throw new Error("spec_interaction_facts_incomplete");
    }
  } else if (!input.facts.artifactContentHash) {
    throw new Error("design_artifact_hash_missing");
  }
  return {
    changeId: input.changeId,
    phase: input.phase,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    actionIds: [...new Set(input.actionIds)],
    gateVersion: input.contract.gateVersion,
    sourceDbHash: input.contract.sourceDbHash,
    expectedHeadSha: input.expectedHeadSha ?? null,
    payload: {
      actionIds: [...new Set(input.actionIds)],
      currentRound: input.facts.roundNo,
      reportHash: input.facts.reportHash,
      artifactContentHash: input.facts.artifactContentHash,
      openGaps: input.facts.openGaps ?? [],
      blockers: input.facts.blockers,
      risks: input.facts.risks,
      freshness: input.facts.freshness,
    },
    form: { fields: [] },
  };
}

const SECRET_KEY = /(token|secret|password|authorization|cookie|nonce|stderr|private)/i;
const SECRET_VALUE = /(Bearer\s+|sk-[A-Za-z0-9]|SECRET_VALUE|\/Users\/|[A-Za-z]:\\Users\\)/i;

function sanitize(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return SECRET_VALUE.test(value) ? "[redacted]" : value.slice(0, 8_192);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([childKey, child]) => [childKey, sanitize(child, childKey)]),
    );
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [childKey, canonicalize(child)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function eventId(type: string): string {
  return `EVT-${type}-${randomUUID()}`;
}

function eventRaw(interaction: InteractionEnvelope) {
  return {
    interactionId: interaction.id,
    kind: interaction.kind,
    phase: interaction.phase,
    status: interaction.status,
    actionIds: interaction.actionIds,
    gateVersion: interaction.gateVersion,
    sourceDbHash: interaction.sourceDbHash,
  };
}

export class HumanInteractionBroker {
  constructor(
    private readonly database: HumanInteractionBrokerDb = db,
    private readonly flags: CodexNativeFlags = readCodexNativeFlags(),
  ) {}

  get(id: string): InteractionEnvelope | null {
    return createCodexInteractionRepository(this.database).getInteraction(id);
  }

  ensureInteraction(input: EnsureInteractionInput): InteractionEnvelope | null {
    if (!isCodexDecisionSurfaceEnabled(
      { phase: input.phase, kind: input.kind },
      this.flags,
    )) return null;
    if (!/^[0-9]+$/.test(input.gateVersion)) {
      throw new Error("interaction_gate_version_invalid");
    }

    const form = InteractionFormSchema.parse(input.form ?? { fields: [] });
    const payload = sanitize({
      ...(input.payload ?? {}),
      actionIds: [...new Set(input.actionIds)],
    }) as Record<string, unknown>;
    const identity: InteractionIdentity = {
      changeId: input.changeId,
      kind: input.kind,
      gateVersion: input.gateVersion,
      sourceDbHash: input.sourceDbHash,
    };
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = input.expiresAt
      ?? new Date(now.getTime() + 10 * 60_000).toISOString();

    return this.database.transaction((tx) => {
      const repository = createCodexInteractionRepository(tx);
      const existing = repository.findActiveInteraction(identity);
      if (existing) {
        this.ensurePresentationJob(tx, existing, expiresAt);
        return existing;
      }
      const change = tx.select().from(changes)
        .where(eq(changes.id, input.changeId)).get();
      if (!change) throw new Error("interaction_change_missing");
      const binding = resolveStageBinding(input.changeId, input.phase, tx);
      if (
        !binding?.threadId
        || !["ready", "running", "waiting_human"].includes(binding.status)
      ) throw new Error("interaction_binding_not_ready");

      const gate = tx.select().from(stageGates).where(and(
        eq(stageGates.changeId, input.changeId),
        eq(stageGates.gateVersion, Number.parseInt(input.gateVersion, 10)),
        eq(stageGates.sourceDbHash, input.sourceDbHash),
      )).get();
      const actionCount = input.actionIds.length === 0
        ? 0
        : tx.select().from(stageActions).where(and(
            eq(stageActions.changeId, input.changeId),
            eq(stageActions.gateVersion, Number.parseInt(input.gateVersion, 10)),
            eq(stageActions.sourceDbHash, input.sourceDbHash),
            inArray(stageActions.actionId, input.actionIds),
          )).all().length;
      if (!gate && actionCount !== input.actionIds.length) {
        throw new Error("interaction_source_contract_stale");
      }

      const requestHash = hash({
        ...identity,
        phase: input.phase,
        actionIds: input.actionIds,
        expectedHeadSha: input.expectedHeadSha ?? null,
        payload,
        form,
      });
      const interaction = repository.createInteraction({
        ...identity,
        id: `INT-${randomUUID()}`,
        bindingId: binding.bindingId,
        codexThreadId: binding.threadId,
        projectId: change.projectId,
        phase: input.phase,
        title: input.title,
        summary: input.summary,
        actionIds: [...new Set(input.actionIds)],
        payload,
        form,
        idempotencyKey: input.idempotencyKey ?? `interaction:${requestHash}`,
        expectedHeadSha: input.expectedHeadSha ?? null,
        requestHash,
        expiresAt,
        createdAt,
      });
      this.ensurePresentationJob(tx, interaction, expiresAt);
      tx.insert(events).values({
        id: eventId("interaction-created"),
        changeId: interaction.changeId,
        runId: null,
        type: "interaction_created",
        message: `Interaction created: ${interaction.kind}`,
        rawJson: JSON.stringify(eventRaw(interaction)),
        createdAt,
      }).run();
      return interaction;
    });
  }

  reconcileChange(
    changeId: string,
    current: ReconcileInteractionContract,
  ): number {
    const now = new Date().toISOString();
    return this.database.transaction((tx) => {
      const stale = tx.select().from(codexInteractions).where(and(
        eq(codexInteractions.changeId, changeId),
        inArray(codexInteractions.status, ["pending", "presented"]),
      )).all().filter((row) =>
        String(row.gateVersion) !== current.gateVersion
        || row.sourceDbHash !== current.sourceDbHash
      );
      for (const row of stale) {
        const changed = tx.update(codexInteractions).set({
          status: "expired",
          invocationNonceHash: null,
          nonceExpiresAt: null,
          updatedAt: now,
        }).where(and(
          eq(codexInteractions.id, row.id),
          inArray(codexInteractions.status, ["pending", "presented"]),
        )).run().changes;
        if (changed !== 1) continue;
        tx.update(pipelineJobs).set({
          status: "cancelled",
          endedAt: now,
          errorCode: "interaction_expired",
          errorSummary: "Interaction source contract changed",
        }).where(and(
          eq(pipelineJobs.interactionId, row.id),
          eq(pipelineJobs.jobKind, "interaction_present"),
          inArray(pipelineJobs.status, ["queued", "leased", "running"]),
        )).run();
        const projected = createCodexInteractionRepository(tx).getInteraction(row.id)!;
        tx.insert(events).values({
          id: eventId("interaction-expired"),
          changeId,
          runId: null,
          type: "interaction_expired",
          message: `Interaction expired: ${row.kind}`,
          rawJson: JSON.stringify(eventRaw(projected)),
          createdAt: now,
        }).run();
      }
      return stale.length;
    });
  }

  ensureDesignInteraction(
    input: ProjectDesignInteractionInput,
  ): InteractionEnvelope | null {
    return this.ensureInteraction(projectDesignInteraction(input));
  }

  ensureBuildInteraction(
    input: ProjectBuildInteractionInput,
  ): InteractionEnvelope | null {
    return this.ensureInteraction(projectBuildInteraction(input));
  }

  private ensurePresentationJob(
    tx: Parameters<Parameters<HumanInteractionBrokerDb["transaction"]>[0]>[0],
    interaction: InteractionEnvelope,
    deadlineAt: string,
  ): void {
    tx.insert(pipelineJobs).values({
      id: `PJOB-${randomUUID()}`,
      changeId: interaction.changeId,
      phase: interaction.phase,
      actionId: "present_interaction",
      idempotencyKey: `interaction_present:${interaction.id}`,
      status: "queued",
      leasedBy: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      attemptNo: 1,
      errorCode: null,
      errorSummary: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      leaseToken: null,
      workerNonce: null,
      provider: "codex",
      jobKind: "interaction_present",
      effectType: "interaction_present",
      interactionId: interaction.id,
      commandId: null,
      effectSchemaVersion: "stagepass.pipeline-effect/v1",
      effectPayloadJson: JSON.stringify({
        schemaVersion: "stagepass.pipeline-effect/v1",
        kind: "interaction_present",
        interactionId: interaction.id,
      }),
      nextTurnOrdinal: 0,
      effectDeadlineAt: deadlineAt,
    }).onConflictDoNothing().run();
  }
}

export const humanInteractionBroker = new HumanInteractionBroker();
