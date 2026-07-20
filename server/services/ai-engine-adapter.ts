import type { AiEngineAdapter, AiProvider } from "./ai-engine-types";

type AiEngineLoader = () => AiEngineAdapter;

/**
 * These require() calls are deliberate, not a circular-dependency workaround:
 * neither engine module imports this adapter. They defer loading each provider
 * engine (codex-cli-engine, claude-engine — each lazily spawns its own CLI)
 * until that provider is
 * actually selected, so a run with one provider never pays for — or fails on —
 * the other's engine module. A static top-level import would eagerly load both; a dynamic
 * import() would force getAiEngine (and every caller) to become async. Keep the
 * sync require until the engine API is intentionally made async.
 */
const defaultLoaders: Record<AiProvider, AiEngineLoader> = {
  codex: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCodexCliEngine } = require("./codex-cli-engine");
    return getCodexCliEngine();
  },
  claude: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getClaudeEngine } = require("./claude-engine");
    return getClaudeEngine();
  },
};

const loaderOverrides: Partial<Record<AiProvider, AiEngineLoader>> = {};

export function getAiEngine(provider: AiProvider): AiEngineAdapter {
  const loader = loaderOverrides[provider] ?? defaultLoaders[provider];
  return loader();
}

export function setAiEngineLoaderForTest(
  provider: AiProvider,
  loader: AiEngineLoader | null,
): () => void {
  const previous = loaderOverrides[provider];
  if (loader) {
    loaderOverrides[provider] = loader;
  } else {
    delete loaderOverrides[provider];
  }
  return () => {
    if (previous) {
      loaderOverrides[provider] = previous;
    } else {
      delete loaderOverrides[provider];
    }
  };
}
