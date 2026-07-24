import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";

import {
  createHostAttestedMcpChannel,
} from "../../mcp/supervisor";
import { runMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import {
  changes,
  codexInteractions,
  codexThreadBindings,
  projects,
} from "../db/schema";
import {
  McpPresentationAuthError,
  McpPresentationAuthService,
} from "./mcp-presentation-auth-service";

const NOW = "2026-07-24T00:00:00.000Z";

async function channel(sourceThreadId: string) {
  return createHostAttestedMcpChannel({
    hostPid: 42,
    hostBundleIdentifier: "com.openai.codex",
    hostTeamIdentifier: "2DC432GLL2",
    sourceThreadId,
    mcpBundleDigest: "a".repeat(64),
    launchRecordId: `launch-${sourceThreadId}`,
  }, { verify: async () => true });
}

function fixture() {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  sqlite.pragma("foreign_keys = ON");
  const database = drizzle(sqlite, { schema });
  database.insert(projects).values({
    id: "PRJ-1",
    name: "Project",
    repoPath: "/tmp/task8",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  database.insert(changes).values({
    id: "CHG-1",
    projectId: "PRJ-1",
    title: "Change",
    status: "INTAKE_READY",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  database.insert(codexThreadBindings).values({
    bindingId: "BIND-1",
    scopeKind: "change",
    scopeId: "CHG-1",
    projectId: "PRJ-1",
    changeId: "CHG-1",
    threadId: "THREAD-1",
    title: "Change",
    status: "ready",
    bridgeProtocolVersion: "v1",
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  database.insert(codexInteractions).values({
    id: "INT-1",
    changeId: "CHG-1",
    bindingId: "BIND-1",
    codexThreadId: "THREAD-1",
    phase: "Intake",
    kind: "gate_decision",
    gateVersion: 7,
    sourceDbHash: "db-7",
    payloadJson: JSON.stringify({
      title: "Decision",
      summary: "Choose",
      actionIds: ["reject_intake"],
      payload: {},
    }),
    formJson: JSON.stringify({ fields: [] }),
    status: "pending",
    idempotencyKey: "idem-1",
    requestHash: "private",
    expiresAt: "2026-07-25T00:00:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  return { sqlite, database };
}

describe("MCP presentation authorization", () => {
  it("binds presentation to source, stores only hash, and rotates on retry", async () => {
    const { sqlite, database } = fixture();
    try {
      const service = new McpPresentationAuthService(
        database,
        () => new Date(NOW),
      );
      assert.throws(
        () => service.present({} as never, "INT-1"),
        (error: unknown) =>
          error instanceof McpPresentationAuthError
          && error.code === "presentation_auth_channel_unavailable",
      );
      const wrong = await channel("THREAD-OTHER");
      assert.throws(
        () => service.present(wrong, "INT-1"),
        (error: unknown) =>
          error instanceof McpPresentationAuthError
          && error.code === "source_thread_mismatch",
      );

      const host = await channel("THREAD-1");
      const first = service.present(host, "INT-1");
      const firstHash = createHash("sha256")
        .update(first.privateInvocationNonce).digest("hex");
      assert.equal(
        database.select().from(codexInteractions)
          .where(eq(codexInteractions.id, "INT-1")).get()
          ?.invocationNonceHash,
        firstHash,
      );
      assert.equal("requestHash" in first.envelope, false);

      const second = service.present(host, "INT-1");
      assert.notEqual(second.privateInvocationNonce, first.privateInvocationNonce);
      assert.notEqual(
        database.select().from(codexInteractions)
          .where(eq(codexInteractions.id, "INT-1")).get()
          ?.invocationNonceHash,
        firstHash,
      );
      assert.equal(service.status(host, "INT-1").id, "INT-1");
    } finally {
      sqlite.close();
    }
  });
});
