import type { AiEngineAdapter, AiProvider } from "./ai-engine-types";

type AiEngineLoader = () => AiEngineAdapter;

const defaultLoader: AiEngineLoader = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LazyCodexDesktopEngine } = require("./codex-desktop-engine");
  return new LazyCodexDesktopEngine();
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

export function setCodexDesktopEngineLoaderForTest(
  loader: AiEngineLoader | null,
): () => void {
  const previous = loaderOverride;
  loaderOverride = loader;
  return () => {
    loaderOverride = previous;
  };
}
