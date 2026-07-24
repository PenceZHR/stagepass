import type { CodexModelCatalogEntry } from "./codex-model-catalog-service";

export interface CodexSettings {
  model: string | null;
  reasoningEffort: string | null;
}

export class CodexSettingsError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "CodexSettingsError";
  }
}

export function findCatalogModel(
  catalog: readonly CodexModelCatalogEntry[],
  model: string | null,
): CodexModelCatalogEntry | null {
  if (model === null) {
    return catalog.find((entry) => entry.isDefault)
      ?? catalog.find((entry) => !entry.hidden)
      ?? null;
  }
  return catalog.find(
    (entry) => entry.model === model || entry.id === model,
  ) ?? null;
}

export function validateCodexSettings(
  catalog: readonly CodexModelCatalogEntry[],
  settings: CodexSettings,
): CodexSettings {
  const selected = findCatalogModel(catalog, settings.model);
  if (!selected) {
    throw new CodexSettingsError("codex_model_not_found");
  }
  if (
    settings.reasoningEffort !== null
    && !selected.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === settings.reasoningEffort,
    )
  ) {
    throw new CodexSettingsError(
      "codex_reasoning_effort_unsupported",
      `Reasoning effort ${settings.reasoningEffort} is not supported by ${selected.model}`,
    );
  }
  return {
    model: settings.model === null ? null : selected.model,
    reasoningEffort: settings.reasoningEffort,
  };
}

export function resolveCodexSettings(input: {
  command?: Partial<CodexSettings> | null;
  change?: Partial<CodexSettings> | null;
  project?: {
    defaultCodexModel?: string | null;
    defaultReasoningEffort?: string | null;
  } | null;
  codexDefault?: CodexSettings | null;
}): CodexSettings {
  return {
    model:
      input.command?.model
      ?? input.change?.model
      ?? input.project?.defaultCodexModel
      ?? input.codexDefault?.model
      ?? null,
    reasoningEffort:
      input.command?.reasoningEffort
      ?? input.change?.reasoningEffort
      ?? input.project?.defaultReasoningEffort
      ?? input.codexDefault?.reasoningEffort
      ?? null,
  };
}
