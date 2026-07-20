import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { changeProviderSessions, changes, providerRunProcesses } from "../db/schema";
import type { Provider } from "./provider-selection-service";

export type ProviderSessionKind = "general" | "spec_writer" | "spec_critic" | string;

export interface ProviderSessionKey {
  changeId: string;
  provider: Provider;
  sessionKind: ProviderSessionKind;
}

export interface RecordProviderSessionInput extends ProviderSessionKey {
  externalSessionId: string;
  lastRunId?: string | null;
}

function nowISO(): string {
  return new Date().toISOString();
}

function findSession(input: ProviderSessionKey): typeof changeProviderSessions.$inferSelect | null {
  return db.select().from(changeProviderSessions).where(and(
    eq(changeProviderSessions.changeId, input.changeId),
    eq(changeProviderSessions.provider, input.provider),
    eq(changeProviderSessions.sessionKind, input.sessionKind),
  )).get() ?? null;
}

/**
 * Resolve a provider-scoped external session. A legacy thread is imported
 * into the Codex/general slot only when a completed Codex lifecycle row proves
 * its provider provenance. Historically the field also held Claude sessions,
 * so its name alone is not sufficient evidence.
 */
export function resolveProviderSession(input: ProviderSessionKey): string | null {
  const existing = findSession(input);
  if (existing) return existing.externalSessionId;
  if (input.provider !== "codex" || input.sessionKind !== "general") return null;

  const legacy = db.select({ codexThreadId: changes.codexThreadId })
    .from(changes).where(eq(changes.id, input.changeId)).get()?.codexThreadId;
  if (!legacy?.trim()) return null;

  const provenCodexSession = db.select({ id: providerRunProcesses.id })
    .from(providerRunProcesses)
    .where(and(
      eq(providerRunProcesses.changeId, input.changeId),
      eq(providerRunProcesses.provider, "codex"),
      eq(providerRunProcesses.status, "completed"),
      eq(providerRunProcesses.externalRef, legacy),
    ))
    .get();
  if (!provenCodexSession) return null;

  const timestamp = nowISO();
  db.transaction((tx) => {
    const current = tx.select().from(changeProviderSessions).where(and(
      eq(changeProviderSessions.changeId, input.changeId),
      eq(changeProviderSessions.provider, input.provider),
      eq(changeProviderSessions.sessionKind, input.sessionKind),
    )).get();
    if (current) return;
    tx.insert(changeProviderSessions).values({
      changeId: input.changeId,
      provider: input.provider,
      sessionKind: input.sessionKind,
      externalSessionId: legacy,
      lastRunId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
  });
  return findSession(input)?.externalSessionId ?? legacy;
}

export function recordProviderSession(input: RecordProviderSessionInput): void {
  const externalSessionId = input.externalSessionId.trim();
  if (!externalSessionId) throw new Error("externalSessionId is required");
  const timestamp = nowISO();
  db.insert(changeProviderSessions).values({
    changeId: input.changeId,
    provider: input.provider,
    sessionKind: input.sessionKind,
    externalSessionId,
    lastRunId: input.lastRunId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoUpdate({
    target: [
      changeProviderSessions.changeId,
      changeProviderSessions.provider,
      changeProviderSessions.sessionKind,
    ],
    set: {
      externalSessionId,
      lastRunId: input.lastRunId ?? null,
      updatedAt: timestamp,
    },
  }).run();
}
