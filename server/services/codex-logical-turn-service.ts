import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  codexLogicalTurns,
  codexThreadBindings,
  pipelineJobs,
  projectAiRuns,
  projects,
} from "../db/schema";
import {
  dispatchSurfaceForRole,
  type CodexLogicalTurnStartContext,
  type CodexLogicalTurnRole,
  type CodexManagedOwner,
} from "./codex-desktop-bridge-types";
import { isLiveProjectAiRunLease } from "./project-ai-run-service";

export type CodexLogicalTurn = typeof codexLogicalTurns.$inferSelect;

const INPUT_KEYS = new Set([
  "owner",
  "phase",
  "role",
  "round",
  "ordinal",
  "request",
  "interactionId",
  "commandId",
]);

export class CodexLogicalTurnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexLogicalTurnError";
  }
}

export interface ResolveLogicalTurnInput {
  owner: CodexManagedOwner;
  phase: string;
  role: Exclude<CodexLogicalTurnRole, "shell_materialization">;
  round: number;
  ordinal: number;
  request?: Record<string, unknown>;
  interactionId?: string;
  commandId?: string;
}

type LogicalTurnTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function correlation(logicalTurnId: string): string {
  return `sp-${createHash("sha256").update(logicalTurnId).digest("base64url")}`;
}

function isLogicalSlotUniqueConstraint(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (
    code !== "SQLITE_CONSTRAINT_UNIQUE"
    && code !== "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) {
    return false;
  }
  const message = error instanceof Error ? error.message : "";
  const logicalTable = "codex_logical_turns.";
  const pipelineSlot = [
    "pipeline_job_id",
    "phase",
    "role",
    "round",
    "ordinal",
  ].every((column) => message.includes(`${logicalTable}${column}`));
  const projectSlot = [
    "project_ai_run_id",
    "phase",
    "role",
    "round",
    "ordinal",
  ].every((column) => message.includes(`${logicalTable}${column}`));
  const turnSlot = message.includes(`${logicalTable}turn_slot`);
  return pipelineSlot || projectSlot || turnSlot;
}

function requireInput(input: ResolveLogicalTurnInput): void {
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) {
      throw new CodexLogicalTurnError(
        "logical_turn_input_invalid",
        `Caller-controlled logical identity field is forbidden: ${key}`,
      );
    }
  }
  if (!input.phase.trim()) {
    throw new CodexLogicalTurnError("logical_turn_input_invalid", "phase is required");
  }
  if (
    !Number.isSafeInteger(input.round)
    || input.round < 0
    || !Number.isSafeInteger(input.ordinal)
    || input.ordinal < 0
  ) {
    throw new CodexLogicalTurnError(
      "logical_turn_input_invalid",
      "round and ordinal must be non-negative integers",
    );
  }
  const wake = input.role === "interaction_wakeup";
  if (wake !== Boolean(input.interactionId && input.commandId)) {
    throw new CodexLogicalTurnError(
      "logical_turn_input_invalid",
      "interaction wakeup requires interactionId and commandId",
    );
  }
}

function ownerKey(owner: CodexManagedOwner): string {
  return owner.kind === "pipeline_job"
    ? `pipeline_job:${owner.pipelineJobId}`
    : `project_ai_run:${owner.projectAiRunId}`;
}

function resolveOwner(
  tx: LogicalTurnTransaction,
  input: ResolveLogicalTurnInput,
  now: number,
): {
  pipelineJobId: string | null;
  projectAiRunId: string | null;
  bindingId: string;
} {
  if (input.owner.kind === "pipeline_job") {
    const job = tx.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, input.owner.pipelineJobId)).get();
    if (
      !job
      || job.status !== "running"
      || !job.leasedBy
      || !job.leaseToken
      || !job.leaseExpiresAt
      || Date.parse(job.leaseExpiresAt) <= now
    ) {
      throw new CodexLogicalTurnError(
        "owner_lease_not_live",
        "Pipeline job lease is not live",
      );
    }
    const change = tx.select().from(changes)
      .where(eq(changes.id, job.changeId)).get();
    if (!change) throw new CodexLogicalTurnError("owner_not_found", "Pipeline change missing");
    const binding = tx.select().from(codexThreadBindings).where(and(
      eq(codexThreadBindings.scopeKind, "change"),
      eq(codexThreadBindings.scopeId, change.id),
    )).get();
    if (!binding?.threadId || binding.status === "provisioning" || binding.status === "detached") {
      throw new CodexLogicalTurnError("binding_not_ready", "Change binding is not ready");
    }
    return {
      pipelineJobId: job.id,
      projectAiRunId: null,
      bindingId: binding.bindingId,
    };
  }

  const run = tx.select().from(projectAiRuns)
    .where(eq(projectAiRuns.id, input.owner.projectAiRunId)).get();
  if (!run || !isLiveProjectAiRunLease(run, new Date(now))) {
    throw new CodexLogicalTurnError(
      "owner_lease_not_live",
      "Project AI run lease is not live",
    );
  }
  const scopeKind = run.kind === "prd_turn" ? "project_prd" : "project_context";
  const binding = tx.select().from(codexThreadBindings).where(and(
    eq(codexThreadBindings.scopeKind, scopeKind),
    eq(codexThreadBindings.scopeId, run.projectId),
  )).get();
  if (!binding?.threadId || binding.status === "provisioning" || binding.status === "detached") {
    throw new CodexLogicalTurnError("binding_not_ready", "Project binding is not ready");
  }
  return {
    pipelineJobId: null,
    projectAiRunId: run.id,
    bindingId: binding.bindingId,
  };
}

function slotFor(input: ResolveLogicalTurnInput): string {
  const discriminator = input.role === "interaction_wakeup"
    ? `:${input.interactionId}:${input.commandId}`
    : "";
  return [
    ownerKey(input.owner),
    input.phase.trim(),
    input.role,
    input.round,
    input.ordinal,
  ].join(":") + discriminator;
}

function readConflict(
  tx: LogicalTurnTransaction,
  input: ResolveLogicalTurnInput,
): CodexLogicalTurn | null {
  return input.owner.kind === "pipeline_job"
    ? tx.select().from(codexLogicalTurns).where(and(
        eq(codexLogicalTurns.pipelineJobId, input.owner.pipelineJobId),
        eq(codexLogicalTurns.phase, input.phase.trim()),
        eq(codexLogicalTurns.role, input.role),
        eq(codexLogicalTurns.round, input.round),
        eq(codexLogicalTurns.ordinal, input.ordinal),
      )).get() ?? null
    : tx.select().from(codexLogicalTurns).where(and(
        eq(codexLogicalTurns.projectAiRunId, input.owner.projectAiRunId),
        eq(codexLogicalTurns.phase, input.phase.trim()),
        eq(codexLogicalTurns.role, input.role),
        eq(codexLogicalTurns.round, input.round),
        eq(codexLogicalTurns.ordinal, input.ordinal),
      )).get() ?? null;
}

export async function resolveLogicalTurn(
  input: ResolveLogicalTurnInput,
): Promise<CodexLogicalTurn> {
  requireInput(input);
  const turnSlot = slotFor(input);
  const canonicalRequestJson = canonicalJson({
    owner: input.owner,
    phase: input.phase.trim(),
    role: input.role,
    round: input.round,
    ordinal: input.ordinal,
    interactionId: input.interactionId ?? null,
    commandId: input.commandId ?? null,
    request: input.request ?? {},
  });
  const canonicalRequestHash = hash(canonicalRequestJson);
  const timestamp = new Date().toISOString();

  function matches(
    existing: CodexLogicalTurn,
    owner: ReturnType<typeof resolveOwner>,
  ): boolean {
    return existing.turnSlot === turnSlot
      && existing.bindingId === owner.bindingId
      && existing.canonicalRequestHash === canonicalRequestHash
      && existing.interactionId === (input.interactionId ?? null)
      && existing.commandId === (input.commandId ?? null)
      && existing.pipelineJobId === owner.pipelineJobId
      && existing.projectAiRunId === owner.projectAiRunId
      && existing.phase === input.phase.trim()
      && existing.role === input.role
      && existing.round === input.round
      && existing.ordinal === input.ordinal
      && existing.dispatchSurface === dispatchSurfaceForRole(input.role);
  }

  try {
    return db.transaction((tx) => {
      const owner = resolveOwner(tx, input, Date.now());
      const existing = readConflict(tx, input);
      if (existing) {
        if (!matches(existing, owner)) {
          throw new CodexLogicalTurnError(
            "logical_turn_request_conflict",
            "Logical slot already exists with a different canonical request",
          );
        }
        return existing;
      }
      const logicalTurnId = randomUUID();
      tx.insert(codexLogicalTurns).values({
        logicalTurnId,
        pipelineJobId: owner.pipelineJobId,
        projectAiRunId: owner.projectAiRunId,
        bindingId: owner.bindingId,
        interactionId: input.interactionId ?? null,
        commandId: input.commandId ?? null,
        phase: input.phase.trim(),
        role: input.role,
        round: input.round,
        ordinal: input.ordinal,
        turnSlot,
        runCorrelationId: correlation(logicalTurnId),
        canonicalRequestJson,
        canonicalRequestHash,
        dispatchSurface: dispatchSurfaceForRole(input.role),
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      return tx.select().from(codexLogicalTurns)
        .where(eq(codexLogicalTurns.logicalTurnId, logicalTurnId)).get()!;
    });
  } catch (error) {
    if (error instanceof CodexLogicalTurnError) throw error;
    if (!isLogicalSlotUniqueConstraint(error)) throw error;
    return db.transaction((tx) => {
      const owner = resolveOwner(tx, input, Date.now());
      const existing = readConflict(tx, input);
      if (existing && matches(existing, owner)) return existing;
      throw new CodexLogicalTurnError(
        "logical_turn_request_conflict",
        "Logical slot insert conflicted with a different request",
      );
    });
  }
}

export function logicalTurnSlot(
  input: Omit<ResolveLogicalTurnInput, "request">,
): Omit<ResolveLogicalTurnInput, "request"> {
  requireInput(input);
  return { ...input };
}

export async function resolveSpecLogicalTurns(input: {
  pipelineJobId: string;
  round: number;
  requests?: Partial<Record<"spec_writer" | "spec_critic" | "spec_verdict", Record<string, unknown>>>;
}) {
  const owner = { kind: "pipeline_job" as const, pipelineJobId: input.pipelineJobId };
  const roles = ["spec_writer", "spec_critic", "spec_verdict"] as const;
  const result: CodexLogicalTurn[] = [];
  for (const role of roles) {
    result.push(await resolveLogicalTurn({
      owner,
      phase: "Spec",
      role,
      round: input.round,
      ordinal: 0,
      request: input.requests?.[role],
    }));
  }
  return result;
}

export function resolveBuildTurn(input: {
  pipelineJobId: string;
  round: number;
  retry?: number;
  request?: Record<string, unknown>;
}) {
  return resolveLogicalTurn({
    owner: { kind: "pipeline_job", pipelineJobId: input.pipelineJobId },
    phase: "Build",
    role: "build",
    round: input.round,
    ordinal: 0,
    request: input.request,
  });
}

export function resolveFixTurn(input: {
  pipelineJobId: string;
  round: number;
  retry?: number;
  request?: Record<string, unknown>;
}) {
  return resolveLogicalTurn({
    owner: { kind: "pipeline_job", pipelineJobId: input.pipelineJobId },
    phase: "Fix",
    role: "fix",
    round: input.round,
    ordinal: 0,
    request: input.request,
  });
}

export function resolveProjectPrdTurn(projectAiRunId: string) {
  return resolveLogicalTurn({
    owner: { kind: "project_ai_run", projectAiRunId },
    phase: "PRD",
    role: "prd_turn",
    round: 0,
    ordinal: 0,
  });
}

export async function resolveContextInitTurns(projectAiRunId: string) {
  const owner = { kind: "project_ai_run" as const, projectAiRunId };
  return [
    await resolveLogicalTurn({
      owner,
      phase: "Context",
      role: "context_select",
      round: 0,
      ordinal: 0,
    }),
    await resolveLogicalTurn({
      owner,
      phase: "Context",
      role: "context_generate",
      round: 0,
      ordinal: 0,
    }),
  ] as const;
}

export function readLogicalTurn(logicalTurnId: string): CodexLogicalTurn | null {
  return db.select().from(codexLogicalTurns)
    .where(eq(codexLogicalTurns.logicalTurnId, logicalTurnId)).get() ?? null;
}

/**
 * Reconstructs the complete Desktop start context from durable Server state.
 * Callers never supply thread, cwd, owner, slot, or correlation identity.
 */
export async function readLogicalTurnForStart(
  logicalTurnId: string,
): Promise<CodexLogicalTurnStartContext> {
  return db.transaction((tx) => {
    const logical = tx.select().from(codexLogicalTurns)
      .where(eq(codexLogicalTurns.logicalTurnId, logicalTurnId)).get();
    if (!logical) {
      throw new CodexLogicalTurnError(
        "logical_turn_not_found",
        `Logical turn not found: ${logicalTurnId}`,
      );
    }
    if (Boolean(logical.pipelineJobId) === Boolean(logical.projectAiRunId)) {
      throw new CodexLogicalTurnError(
        "logical_turn_owner_invalid",
        "Logical turn owner must satisfy XOR",
      );
    }
    const binding = tx.select().from(codexThreadBindings)
      .where(eq(codexThreadBindings.bindingId, logical.bindingId)).get();
    if (
      !binding?.threadId
      || !["ready", "running", "waiting_human"].includes(binding.status)
    ) {
      throw new CodexLogicalTurnError(
        "binding_not_ready",
        "Canonical Codex binding is not ready",
      );
    }
    const now = Date.now();
    let owner: CodexManagedOwner;
    let projectId: string;
    let workerId: string;
    let leaseToken: string;
    let ownerAttempt: number;
    let ownerEpoch: number;
    let leaseExpiresAt: string;
    let deadlineAt: string;
    if (logical.pipelineJobId) {
      const job = tx.select().from(pipelineJobs)
        .where(eq(pipelineJobs.id, logical.pipelineJobId)).get();
      const change = job
        ? tx.select().from(changes).where(eq(changes.id, job.changeId)).get()
        : null;
      if (
        !job
        || !change
        || !["leased", "running"].includes(job.status)
        || !job.leasedBy
        || !job.leaseToken
        || !job.leaseExpiresAt
        || Date.parse(job.leaseExpiresAt) <= now
      ) {
        throw new CodexLogicalTurnError(
          "logical_turn_owner_lease_stale",
          "Pipeline job owner lease is stale",
        );
      }
      if (
        binding.scopeKind !== "change"
        || binding.scopeId !== change.id
        || binding.changeId !== change.id
        || binding.projectId !== change.projectId
      ) {
        throw new CodexLogicalTurnError(
          "logical_turn_binding_scope_drift",
          "Pipeline owner no longer owns the recorded Change binding",
        );
      }
      owner = { kind: "pipeline_job", pipelineJobId: job.id };
      projectId = change.projectId;
      workerId = job.leasedBy;
      leaseToken = job.leaseToken;
      ownerAttempt = job.attemptNo;
      ownerEpoch = job.attemptNo;
      leaseExpiresAt = job.leaseExpiresAt;
      deadlineAt = job.effectDeadlineAt ?? job.leaseExpiresAt;
    } else {
      const run = tx.select().from(projectAiRuns)
        .where(eq(projectAiRuns.id, logical.projectAiRunId!)).get();
      if (!run || !isLiveProjectAiRunLease(run, new Date(now))) {
        throw new CodexLogicalTurnError(
          "logical_turn_owner_lease_stale",
          "Project AI owner lease is stale",
        );
      }
      const expectedScope = run.kind === "prd_turn"
        ? "project_prd"
        : "project_context";
      if (
        binding.scopeKind !== expectedScope
        || binding.scopeId !== run.projectId
        || binding.projectId !== run.projectId
        || binding.changeId !== null
      ) {
        throw new CodexLogicalTurnError(
          "logical_turn_binding_scope_drift",
          "Project AI owner no longer owns the recorded project binding",
        );
      }
      if (
        (run.kind === "prd_turn"
          && (logical.phase !== "PRD" || logical.role !== "prd_turn"))
        || (run.kind === "context_init"
          && (
            logical.phase !== "Context"
            || !["context_select", "context_generate"].includes(logical.role)
          ))
      ) {
        throw new CodexLogicalTurnError(
          "logical_turn_project_kind_drift",
          "Project AI run kind no longer matches the logical turn",
        );
      }
      owner = { kind: "project_ai_run", projectAiRunId: run.id };
      projectId = run.projectId;
      workerId = run.workerId!;
      leaseToken = run.leaseToken!;
      ownerAttempt = run.ownerAttempt;
      ownerEpoch = run.ownerEpoch;
      leaseExpiresAt = run.leaseExpiresAt!;
      deadlineAt = run.deadlineAt;
    }
    const project = tx.select().from(projects)
      .where(eq(projects.id, projectId)).get();
    if (!project) {
      throw new CodexLogicalTurnError("owner_not_found", "Binding project is missing");
    }
    let parsed: ResolveLogicalTurnInput;
    try {
      parsed = JSON.parse(logical.canonicalRequestJson) as ResolveLogicalTurnInput;
    } catch {
      throw new CodexLogicalTurnError(
        "logical_turn_request_invalid",
        "Canonical logical request is not valid JSON",
      );
    }
    const canonical = canonicalJson(parsed);
    if (
      canonical !== logical.canonicalRequestJson
      || hash(canonical) !== logical.canonicalRequestHash
      || canonicalJson(parsed.owner) !== canonicalJson(owner)
      || parsed.phase !== logical.phase
      || parsed.role !== logical.role
      || parsed.round !== logical.round
      || parsed.ordinal !== logical.ordinal
      || (parsed.interactionId ?? null) !== logical.interactionId
      || (parsed.commandId ?? null) !== logical.commandId
      || slotFor(parsed) !== logical.turnSlot
      || correlation(logical.logicalTurnId) !== logical.runCorrelationId
      || dispatchSurfaceForRole(logical.role) !== logical.dispatchSurface
    ) {
      throw new CodexLogicalTurnError(
        "logical_turn_canonical_drift",
        "Persisted logical identity no longer matches its canonical request",
      );
    }
    const request = parsed.request ?? {};
    if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
      throw new CodexLogicalTurnError(
        "logical_turn_request_invalid",
        "Canonical logical request has no prompt",
      );
    }
    const scopeKind = binding.scopeKind;
    return {
      logicalTurnId: logical.logicalTurnId,
      owner,
      projectId,
      scopeKind,
      scopeId: binding.scopeId,
      phase: logical.phase,
      role: logical.role,
      round: logical.round,
      ordinal: logical.ordinal,
      turnSlot: logical.turnSlot,
      runCorrelationId: logical.runCorrelationId,
      dispatchSurface: logical.dispatchSurface,
      request: {
        threadId: binding.threadId,
        cwd: typeof request.cwd === "string" ? request.cwd : project.repoPath,
        prompt: request.prompt,
        ...(typeof request.model === "string" ? { model: request.model } : {}),
        ...(typeof request.reasoningEffort === "string"
          ? { reasoningEffort: request.reasoningEffort }
          : {}),
        approvalPolicy: "never",
        sandboxMode: request.sandboxMode === "workspace-write"
          ? "workspace-write"
          : "read-only",
      },
      fence: {
        logicalTurnId: logical.logicalTurnId,
        owner,
        projectId,
        scopeKind,
        scopeId: binding.scopeId,
        workerId,
        leaseToken,
        ownerAttempt,
        ownerEpoch,
        dispatchSurface: logical.dispatchSurface,
        purpose: logical.role === "interaction_present"
          ? "interaction_present"
          : logical.role === "interaction_wakeup"
            ? "interaction_wakeup"
            : "stage_run",
        deadlineAt,
        leaseExpiresAt,
      },
    };
  });
}

export const productionCodexLogicalTurnPort = {
  resolve: async () => {
    throw new CodexLogicalTurnError(
      "logical_turn_resolver_required",
      "Use the typed Server logical-turn resolvers",
    );
  },
  readForStart: readLogicalTurnForStart,
};
