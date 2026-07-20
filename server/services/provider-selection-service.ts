import { AiProvider } from "../types/enums";
import type { z } from "zod";

export type Provider = z.infer<typeof AiProvider>;

/** Actions whose execution invokes an external AI provider. */
export const PROVIDER_BACKED_ACTION_IDS = new Set<string>([
  "run_prd",
  "retry_prd",
  "run_prd_briefing_questions",
  "run_prd_briefing_draft",
  "run_prd_briefing_final_review",
  "run_spec",
  "retry_spec",
  "run_tech_spec",
  "retry_tech_spec",
  "run_plan",
  "retry_plan",
  "run_test_plan",
  "retry_test_plan",
  "run_build",
  "retry_build",
  "run_review",
  "retry_review",
  "fix_blockers",
  "merge",
  "run_retro",
]);

export class ProviderSelectionError extends Error {
  constructor(
    public readonly code: "invalid_provider" | "provider_not_applicable",
    message: string,
  ) {
    super(message);
    this.name = "ProviderSelectionError";
  }
}

export function isProviderBackedAction(actionId: string): boolean {
  return PROVIDER_BACKED_ACTION_IDS.has(actionId);
}

export function parseRequestedProvider(value: unknown): Provider | undefined {
  if (value === undefined) return undefined;
  const parsed = AiProvider.safeParse(value);
  if (!parsed.success) {
    throw new ProviderSelectionError(
      "invalid_provider",
      "provider must be exactly codex or claude",
    );
  }
  return parsed.data;
}

export function resolveProviderSelection(
  requested: Provider | undefined,
  changeDefault: Provider | null | undefined,
): Provider {
  return requested ?? changeDefault ?? "codex";
}

export function assertProviderApplicable(
  actionId: string,
  requested: Provider | undefined,
): void {
  if (requested !== undefined && !isProviderBackedAction(actionId)) {
    throw new ProviderSelectionError(
      "provider_not_applicable",
      `provider is not applicable to ${actionId}`,
    );
  }
}
