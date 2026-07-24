import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { changes, codexInteractions } from "../db/schema";
import {
  InteractionEnvelopeSchema,
  InteractionFormSchema,
  type InteractionEnvelope,
  type InteractionForm,
  type InteractionKind,
} from "../services/interaction-types";
import type { CodexDecisionPhase } from "../config/codex-decision-rollout";

type InteractionConnection = Pick<typeof db, "select" | "insert" | "update">;

export class InteractionStateConflictError extends Error {
  readonly code = "interaction_state_conflict" as const;

  constructor() {
    super("interaction_state_conflict");
    this.name = "InteractionStateConflictError";
  }
}

export interface InteractionIdentity {
  changeId: string;
  kind: InteractionKind;
  gateVersion: string;
  sourceDbHash: string;
}

export interface CreateInteractionInput extends InteractionIdentity {
  id: string;
  bindingId: string;
  codexThreadId: string;
  projectId: string;
  phase: CodexDecisionPhase;
  title: string;
  summary: string;
  actionIds: string[];
  payload: Record<string, unknown>;
  form: InteractionForm;
  idempotencyKey: string;
  expectedHeadSha: string | null;
  requestHash: string;
  expiresAt: string;
  createdAt: string;
}

type StoredDisplay = {
  title: string;
  summary: string;
  actionIds: string[];
  payload: Record<string, unknown>;
};

function parseRow(
  connection: Pick<typeof db, "select">,
  row: typeof codexInteractions.$inferSelect,
): InteractionEnvelope {
  const change = connection.select({ projectId: changes.projectId })
    .from(changes)
    .where(eq(changes.id, row.changeId))
    .get();
  if (!change) throw new Error("interaction_change_missing");
  const display = JSON.parse(row.payloadJson) as StoredDisplay;
  return InteractionEnvelopeSchema.parse({
    schemaVersion: "stagepass.interaction/v1",
    id: row.id,
    changeId: row.changeId,
    projectId: change.projectId,
    codexThreadId: row.codexThreadId,
    phase: row.phase,
    kind: row.kind,
    title: display.title,
    summary: display.summary,
    actionIds: display.actionIds,
    gateVersion: String(row.gateVersion),
    sourceDbHash: row.sourceDbHash,
    payload: display.payload,
    form: InteractionFormSchema.parse(row.formJson ? JSON.parse(row.formJson) : { fields: [] }),
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    expectedHeadSha: row.expectedHeadSha,
    requestHash: row.requestHash,
    presentedAt: row.presentedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
    supersededById: row.supersededById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function expectOne(changesCount: number): void {
  if (changesCount !== 1) throw new InteractionStateConflictError();
}

export function createCodexInteractionRepository(
  connection: InteractionConnection = db,
) {
  return {
    createInteraction(input: CreateInteractionInput): InteractionEnvelope {
      connection.insert(codexInteractions).values({
        id: input.id,
        changeId: input.changeId,
        bindingId: input.bindingId,
        codexThreadId: input.codexThreadId,
        phase: input.phase,
        kind: input.kind,
        gateVersion: Number.parseInt(input.gateVersion, 10),
        sourceDbHash: input.sourceDbHash,
        payloadJson: JSON.stringify({
          title: input.title,
          summary: input.summary,
          actionIds: input.actionIds,
          payload: input.payload,
        } satisfies StoredDisplay),
        formJson: JSON.stringify(input.form),
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        invocationNonceHash: null,
        sourceThreadId: null,
        nonceExpiresAt: null,
        nonceConsumedAt: null,
        expectedHeadSha: input.expectedHeadSha,
        requestHash: input.requestHash,
        supersededById: null,
        presentedAt: null,
        completedAt: null,
        expiresAt: input.expiresAt,
        supersededAt: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      }).run();
      return this.getInteraction(input.id)!;
    },

    getInteraction(id: string): InteractionEnvelope | null {
      const row = connection.select().from(codexInteractions)
        .where(eq(codexInteractions.id, id)).get();
      return row ? parseRow(connection, row) : null;
    },

    findActiveInteraction(identity: InteractionIdentity): InteractionEnvelope | null {
      const row = connection.select().from(codexInteractions).where(and(
        eq(codexInteractions.changeId, identity.changeId),
        eq(codexInteractions.kind, identity.kind),
        eq(codexInteractions.gateVersion, Number.parseInt(identity.gateVersion, 10)),
        eq(codexInteractions.sourceDbHash, identity.sourceDbHash),
        inArray(codexInteractions.status, ["pending", "presented", "submitting"]),
      )).get();
      return row ? parseRow(connection, row) : null;
    },

    markPresented(id: string, expectedStatus: "pending"): InteractionEnvelope {
      const now = new Date().toISOString();
      expectOne(connection.update(codexInteractions).set({
        status: "presented",
        presentedAt: now,
        updatedAt: now,
      }).where(and(
        eq(codexInteractions.id, id),
        eq(codexInteractions.status, expectedStatus),
      )).run().changes);
      return this.getInteraction(id)!;
    },

    completeInteraction(id: string, commandId: string): InteractionEnvelope {
      const now = new Date().toISOString();
      void commandId;
      expectOne(connection.update(codexInteractions).set({
        status: "completed",
        completedAt: now,
        nonceConsumedAt: now,
        updatedAt: now,
      }).where(and(
        eq(codexInteractions.id, id),
        eq(codexInteractions.status, "submitting"),
      )).run().changes);
      return this.getInteraction(id)!;
    },

    expireInteraction(id: string, supersededById?: string): InteractionEnvelope {
      const now = new Date().toISOString();
      const terminal = supersededById ? "superseded" : "expired";
      expectOne(connection.update(codexInteractions).set({
        status: terminal,
        supersededById: supersededById ?? null,
        supersededAt: supersededById ? now : null,
        invocationNonceHash: null,
        nonceExpiresAt: null,
        updatedAt: now,
      }).where(and(
        eq(codexInteractions.id, id),
        inArray(codexInteractions.status, ["pending", "presented"]),
      )).run().changes);
      return this.getInteraction(id)!;
    },
  };
}

export const codexInteractionRepository = createCodexInteractionRepository();
