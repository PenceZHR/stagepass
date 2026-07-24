import { createHash, randomBytes } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import {
  assertHostAttestedMcpChannel,
  type HostAttestedMcpChannel,
} from "../../mcp/supervisor";
import { db } from "../db";
import { codexInteractions, codexThreadBindings } from "../db/schema";
import { createCodexInteractionRepository } from "../repositories/codex-interaction-repository";
import type { InteractionEnvelope } from "./interaction-types";

type PresentationDb = typeof db;

export type PublicInteractionEnvelope = Omit<
  InteractionEnvelope,
  "requestHash" | "idempotencyKey"
>;

export class McpPresentationAuthError extends Error {
  constructor(
    readonly code:
      | "presentation_auth_channel_unavailable"
      | "source_thread_mismatch"
      | "interaction_not_found"
      | "interaction_not_available"
      | "interaction_presentation_conflict",
    readonly status = code === "interaction_not_found" ? 404 : 403,
  ) {
    super(code);
    this.name = "McpPresentationAuthError";
  }
}

const SENSITIVE_KEY =
  /(requestHash|idempotencyKey|invocationNonce|nonceHash|authorization|token|secret|cookie|stderr|private)/i;
const SENSITIVE_VALUE = /(Bearer\s+|sk-[A-Za-z0-9]|\/Users\/|[A-Za-z]:\\Users\\)/i;

function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return undefined;
  if (typeof value === "string") {
    return SENSITIVE_VALUE.test(value) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) return value.map((child) => redact(child));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([childKey]) => !SENSITIVE_KEY.test(childKey))
        .map(([childKey, child]) => [childKey, redact(child, childKey)]),
    );
  }
  return value;
}

export function publicInteractionEnvelope(
  interaction: InteractionEnvelope,
): PublicInteractionEnvelope {
  const safe = { ...interaction } as Record<string, unknown>;
  delete safe.requestHash;
  delete safe.idempotencyKey;
  return redact(safe) as PublicInteractionEnvelope;
}

function requireHostChannel(channel: HostAttestedMcpChannel): void {
  try {
    assertHostAttestedMcpChannel(channel);
  } catch {
    throw new McpPresentationAuthError(
      "presentation_auth_channel_unavailable",
    );
  }
}

export class McpPresentationAuthService {
  constructor(
    private readonly database: PresentationDb = db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  status(
    channel: HostAttestedMcpChannel,
    interactionId: string,
  ): PublicInteractionEnvelope {
    requireHostChannel(channel);
    const interaction = createCodexInteractionRepository(this.database)
      .getInteraction(interactionId);
    if (!interaction) {
      throw new McpPresentationAuthError("interaction_not_found", 404);
    }
    this.assertSource(interactionId, channel.sourceThreadId);
    return publicInteractionEnvelope(interaction);
  }

  present(
    channel: HostAttestedMcpChannel,
    interactionId: string,
  ): {
    envelope: PublicInteractionEnvelope;
    privateInvocationNonce: string;
  } {
    requireHostChannel(channel);
    const sourceThreadId = channel.sourceThreadId;
    const rawNonce = randomBytes(32).toString("base64url");
    const nonceHash = createHash("sha256").update(rawNonce).digest("hex");
    const now = this.now();
    const nowIso = now.toISOString();
    const result = this.database.transaction((tx) => {
      const row = tx.select().from(codexInteractions)
        .where(eq(codexInteractions.id, interactionId)).get();
      if (!row) {
        throw new McpPresentationAuthError("interaction_not_found", 404);
      }
      const binding = tx.select().from(codexThreadBindings)
        .where(eq(codexThreadBindings.bindingId, row.bindingId)).get();
      if (
        row.codexThreadId !== sourceThreadId
        || binding?.threadId !== sourceThreadId
      ) {
        throw new McpPresentationAuthError("source_thread_mismatch");
      }
      if (
        !["pending", "presented"].includes(row.status)
        || Date.parse(row.expiresAt) <= now.getTime()
      ) {
        throw new McpPresentationAuthError(
          "interaction_not_available",
          409,
        );
      }
      const nonceExpiresAt = new Date(Math.min(
        Date.parse(row.expiresAt),
        now.getTime() + 10 * 60_000,
      )).toISOString();
      const changed = tx.update(codexInteractions).set({
        status: "presented",
        invocationNonceHash: nonceHash,
        sourceThreadId,
        nonceExpiresAt,
        nonceConsumedAt: null,
        presentedAt: row.presentedAt ?? nowIso,
        updatedAt: nowIso,
      }).where(and(
        eq(codexInteractions.id, interactionId),
        inArray(codexInteractions.status, ["pending", "presented"]),
        eq(codexInteractions.updatedAt, row.updatedAt),
      )).run().changes;
      if (changed !== 1) {
        throw new McpPresentationAuthError(
          "interaction_presentation_conflict",
          409,
        );
      }
      return createCodexInteractionRepository(tx).getInteraction(interactionId)!;
    });
    return {
      envelope: publicInteractionEnvelope(result),
      privateInvocationNonce: rawNonce,
    };
  }

  private assertSource(interactionId: string, sourceThreadId: string): void {
    const row = this.database.select().from(codexInteractions)
      .where(eq(codexInteractions.id, interactionId)).get();
    if (!row) throw new McpPresentationAuthError("interaction_not_found", 404);
    const binding = this.database.select().from(codexThreadBindings)
      .where(eq(codexThreadBindings.bindingId, row.bindingId)).get();
    if (
      row.codexThreadId !== sourceThreadId
      || row.sourceThreadId !== sourceThreadId
      || binding?.threadId !== sourceThreadId
    ) {
      throw new McpPresentationAuthError("source_thread_mismatch");
    }
  }
}

export const mcpPresentationAuthService = new McpPresentationAuthService();
