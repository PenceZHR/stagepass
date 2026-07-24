import { z } from "zod";

import {
  CODEX_DECISION_INTERACTION_KINDS,
  CODEX_DECISION_PHASES,
} from "../config/codex-decision-rollout";
import { CodexInteractionStatus } from "../types/enums";

export const InteractionKind = z.enum(CODEX_DECISION_INTERACTION_KINDS);
export type InteractionKind = z.infer<typeof InteractionKind>;

export const InteractionFormControlType = z.enum([
  "text",
  "textarea",
  "radio",
  "select",
  "checkbox",
  "confirmation",
]);

const InteractionFormOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
}).strict();
export const InteractionFormFieldSchema = z.object({
  id: z.string().min(1),
  type: InteractionFormControlType,
  label: z.string().min(1),
  required: z.boolean(),
  description: z.string().optional(),
  options: z.array(InteractionFormOptionSchema).optional(),
}).strict();

export const InteractionFormSchema = z.object({
  fields: z.array(InteractionFormFieldSchema),
}).strict();
export type InteractionForm = z.infer<typeof InteractionFormSchema>;

export const InteractionEnvelopeSchema = z.object({
  schemaVersion: z.literal("stagepass.interaction/v1"),
  id: z.string().min(1),
  changeId: z.string().min(1),
  projectId: z.string().min(1),
  codexThreadId: z.string().min(1),
  phase: z.enum(CODEX_DECISION_PHASES),
  kind: InteractionKind,
  title: z.string().min(1),
  summary: z.string(),
  actionIds: z.array(z.string().min(1)),
  gateVersion: z.string().min(1),
  sourceDbHash: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  form: InteractionFormSchema,
  status: CodexInteractionStatus,
  idempotencyKey: z.string().min(1),
  expectedHeadSha: z.string().nullable(),
  requestHash: z.string().min(1),
  presentedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  supersededById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type InteractionEnvelope = z.infer<typeof InteractionEnvelopeSchema>;

export type PublicInteractionEnvelope = InteractionEnvelope;

export const InteractionPresentationEffectSchema = z.object({
  schemaVersion: z.literal("stagepass.pipeline-effect/v1"),
  kind: z.literal("interaction_present"),
  interactionId: z.string().min(1),
}).strict();
