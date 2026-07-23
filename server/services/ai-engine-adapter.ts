import type { AiEngineAdapter, AiProvider } from "./ai-engine-types";

type AiEngineLoader = () => AiEngineAdapter;

/**
 * The require() is deliberate: it defers loading codex-cli-engine (which
 * lazily spawns the codex CLI) until an engine is actually requested, and
 * keeps getAiEngine synchronous. Keep the sync require until the engine API
 * is intentionally made async.
 */
const defaultLoader: AiEngineLoader = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCodexCliEngine } = require("./codex-cli-engine");
  return getCodexCliEngine();
};

let loaderOverride: AiEngineLoader | null = null;

export function getAiEngine(): AiEngineAdapter {
  return (loaderOverride ?? defaultLoader)();
}

export function setAiEngineLoaderForTest(
  _provider: AiProvider,
  loader: AiEngineLoader | null,
): () => void {
  const previous = loaderOverride;
  loaderOverride = loader;
  return () => {
    loaderOverride = previous;
  };
}
