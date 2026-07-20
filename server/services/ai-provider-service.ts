import type { AiProvider } from "../types";

export function resolveProvider(
  explicitProvider?: AiProvider,
  defaultProvider?: AiProvider | null
): AiProvider {
  return explicitProvider ?? defaultProvider ?? "codex";
}

export function shouldPersistProvider(
  explicitProvider: AiProvider | undefined,
  saveAsDefault: boolean | undefined
): boolean {
  return !!explicitProvider && saveAsDefault === true;
}
