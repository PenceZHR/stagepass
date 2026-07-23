import type { AiEngineAdapter, AiProvider } from "./ai-engine-types";

type AiEngineLoader = () => AiEngineAdapter;

/**
 * The require() is deliberate: it defers loading the app-server engine until
 * an engine is actually requested and keeps getAiEngine synchronous.
 */
const defaultLoader: AiEngineLoader = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCodexAppServerEngine } = require("./codex-app-server-engine");
  return getCodexAppServerEngine();
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
