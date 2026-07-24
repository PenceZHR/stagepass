import fs from "node:fs";

import { createCodexAppServerShellControl } from "./codex-app-server-shell-control";
import {
  defaultCodexDesktopDiscoveryDependencies,
  discoverCodexDesktopIpcEndpoint,
} from "./codex-desktop-ipc-discovery";
import type { CodexModel } from "./codex-desktop-bridge-types";

const DEFAULT_CATALOG_TTL_MS = 60_000;

export interface CodexReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModelCatalogEntry {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
}

export interface ListCodexModelsOptions {
  cwd?: string;
  ttlMs?: number;
}

interface CatalogCacheEntry {
  expiresAt: number;
  value?: CodexModelCatalogEntry[];
  pending?: Promise<CodexModelCatalogEntry[]>;
}

const catalogCache = new Map<string, CatalogCacheEntry>();
let shellModelListerForTest: (() => Promise<CodexModel[]>) | null = null;

function catalogCwd(cwd: string | undefined): string {
  const candidate = cwd ?? process.cwd();
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

async function fetchHybridCodexModels(): Promise<CodexModelCatalogEntry[]> {
  const models = shellModelListerForTest
    ? await shellModelListerForTest()
    : await (async () => {
        const endpoint = await discoverCodexDesktopIpcEndpoint(
          defaultCodexDesktopDiscoveryDependencies(),
        );
        return createCodexAppServerShellControl({
          appServerBinary: endpoint.appServerBinary,
        }).listModels();
      })();
  return models.map((entry, index) => ({
    id: entry.id,
    model: entry.model,
    displayName: entry.displayName,
    description: entry.displayName,
    isDefault: index === 0,
    hidden: false,
    defaultReasoningEffort: entry.defaultReasoningEffort ?? "medium",
    supportedReasoningEfforts: (entry.supportedReasoningEfforts ?? []).map(
      (reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }),
    ),
  }));
}

export async function listCodexModels(
  options: ListCodexModelsOptions = {},
): Promise<CodexModelCatalogEntry[]> {
  const cwd = catalogCwd(options.cwd);
  const key = `desktop-shell\0${cwd}`;
  const now = Date.now();
  const ttlMs =
    typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs)
      ? Math.max(0, options.ttlMs)
      : DEFAULT_CATALOG_TTL_MS;
  const cached = catalogCache.get(key);
  if (cached && cached.expiresAt > now) {
    if (cached.value) return cached.value;
    if (cached.pending) return cached.pending;
  }

  const pending = fetchHybridCodexModels();
  catalogCache.set(key, { expiresAt: now + ttlMs, pending });
  try {
    const value = await pending;
    catalogCache.set(key, { expiresAt: Date.now() + ttlMs, value });
    return value;
  } catch (error) {
    if (catalogCache.get(key)?.pending === pending) catalogCache.delete(key);
    throw error;
  }
}

/** Test-only cache reset; production callers rely on TTL expiry. */
export function resetCodexModelCatalogCacheForTest(): void {
  catalogCache.clear();
}

export function setCodexShellModelListerForTest(
  lister: (() => Promise<CodexModel[]>) | null,
): () => void {
  const previous = shellModelListerForTest;
  shellModelListerForTest = lister;
  catalogCache.clear();
  return () => {
    shellModelListerForTest = previous;
    catalogCache.clear();
  };
}
