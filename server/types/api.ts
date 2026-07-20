import { z } from "zod";
import { AiProvider, Phase } from "./enums";

export const CreateProjectInput = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  gitEnabled: z.boolean().optional().default(false),
  contextProvider: AiProvider.default("codex"),
  prdProvider: AiProvider.default("codex"),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const ProviderSelectionInput = z.object({
  provider: AiProvider.optional(),
  saveAsDefault: z.boolean().optional().default(false),
});
export type ProviderSelectionInput = z.infer<typeof ProviderSelectionInput>;

export const PrdActionInput = z.object({
  action: z.enum(["start", "turn", "save"]),
  message: z.string().optional(),
  prd: z.unknown().optional(),
  provider: AiProvider.optional(),
  saveAsDefault: z.boolean().optional().default(false),
});
export type PrdActionInput = z.infer<typeof PrdActionInput>;

export const CreateChangeInput = z.object({
  title: z.string().min(1),
  provider: AiProvider.default("codex"),
});
export type CreateChangeInput = z.infer<typeof CreateChangeInput>;

export const ReworkChangeInput = z.object({
  phase: Phase.extract(["Refine", "Plan", "TestPlan", "Build", "Implement", "Check", "Fix"]),
});
export type ReworkChangeInput = z.infer<typeof ReworkChangeInput>;
