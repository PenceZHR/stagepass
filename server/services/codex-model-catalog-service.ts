import fs from "node:fs";

import { CodexAppServerClient } from "./codex-app-server-client";
import { resolveCodexBin } from "./codex-engine-shared";

const DEFAULT_CATALOG_TTL_MS = 60_000;
const MODEL_LIST_PAGE_SIZE = 100;
const CLOSE_GRACE_MS = 500;

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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`codex model catalog entry is missing ${key}`);
  }
  return value;
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`codex model catalog entry is missing ${key}`);
  }
  return value;
}

function parseReasoningEfforts(value: unknown): CodexReasoningEffortOption[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "codex model catalog entry is missing supportedReasoningEfforts",
    );
  }
  return value.map((raw) => {
    const option = asRecord(raw);
    return {
      reasoningEffort: requiredString(option, "reasoningEffort"),
      description: requiredString(option, "description"),
    };
  });
}

function parseModel(value: unknown): CodexModelCatalogEntry {
  const model = asRecord(value);
  return {
    id: requiredString(model, "id"),
    model: requiredString(model, "model"),
    displayName: requiredString(model, "displayName"),
    description: requiredString(model, "description"),
    isDefault: requiredBoolean(model, "isDefault"),
    hidden: requiredBoolean(model, "hidden"),
    defaultReasoningEffort: requiredString(model, "defaultReasoningEffort"),
    supportedReasoningEfforts: parseReasoningEfforts(
      model.supportedReasoningEfforts,
    ),
  };
}

function catalogCwd(cwd: string | undefined): string {
  const candidate = cwd ?? process.cwd();
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

async function fetchCodexModels(cwd: string): Promise<CodexModelCatalogEntry[]> {
  const client = CodexAppServerClient.spawn({
    bin: resolveCodexBin(),
    cwd,
    env: process.env,
    onNotification: () => {},
    onServerRequest: async () => ({ decision: "decline" }),
  });

  const models: CodexModelCatalogEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  try {
    await client.initialize();
    do {
      const response = asRecord(
        await client.request("model/list", {
          cursor,
          includeHidden: false,
          limit: MODEL_LIST_PAGE_SIZE,
        }),
      );
      const data = response.data;
      if (!Array.isArray(data)) {
        throw new Error("codex model/list response is missing data");
      }
      models.push(...data.map(parseModel));
      const nextCursor =
        typeof response.nextCursor === "string" && response.nextCursor.length > 0
          ? response.nextCursor
          : null;
      if (nextCursor) {
        if (seenCursors.has(nextCursor)) {
          throw new Error("codex model/list returned a repeated cursor");
        }
        seenCursors.add(nextCursor);
      }
      cursor = nextCursor;
    } while (cursor);
    return models;
  } finally {
    await client.close(CLOSE_GRACE_MS).catch(() => {});
  }
}

export async function listCodexModels(
  options: ListCodexModelsOptions = {},
): Promise<CodexModelCatalogEntry[]> {
  const cwd = catalogCwd(options.cwd);
  const key = `${resolveCodexBin()}\0${cwd}`;
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

  const pending = fetchCodexModels(cwd);
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
