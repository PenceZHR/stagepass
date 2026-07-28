import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { runMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import {
  changes,
  codexInteractions,
  codexThreadBindings,
  pipelineJobs,
  projects,
  stageGates,
} from "../db/schema";
import type { CodexNativeFlags } from "../config/codex-native-flags";
import { HumanInteractionBroker } from "./human-interaction-broker";
import {
  createCodexInteractionRepository,
  InteractionStateConflictError,
} from "../repositories/codex-interaction-repository";

const NOW = "2026-07-24T00:00:00.000Z";

function flags(enabled = true): CodexNativeFlags {
  return {
    desktopBridge: true,
    mcpInteractions: true,
    codexDecisionSurfaceMaster: enabled,
    codexDecisionPhases: enabled ? ["Intake"] : [],
    codexDecisionRolloutError: null,
  };
}

function fixture() {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  sqlite.pragma("foreign_keys = ON");
  const database = drizzle(sqlite, { schema });
  database.insert(projects).values({
    id: "PRJ-1",
    name: "Project",
    repoPath: "/tmp/task7",
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
    scopeKind: "change_stage",
    scopeId: "CHG-1:prd",
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
  database.insert(stageGates).values({
    id: "GATE-1",
    changeId: "CHG-1",
    phase: "intake",
    status: "waiting",
    sourceDbHash: "db-7",
    gateVersion: 7,
    computedAt: NOW,
  }).run();
  return { sqlite, database };
}

function input() {
  return {
    changeId: "CHG-1",
    phase: "Intake" as const,
    kind: "gate_decision" as const,
    title: "Approve intake",
    summary: "Review current gate",
    actionIds: ["approve_intake"],
    gateVersion: "7",
    sourceDbHash: "db-7",
    payload: {
      safe: "visible",
      authorization: "Bearer top-secret",
      stderr: "/Users/private/SECRET_VALUE",
    },
    expiresAt: "2026-07-25T00:00:00.000Z",
  };
}

describe("human interaction broker", () => {
  it("deduplicates interaction and presentation job in one transaction", () => {
    const { sqlite, database } = fixture();
    try {
      const broker = new HumanInteractionBroker(database, flags());
      const first = broker.ensureInteraction(input())!;
      const duplicate = broker.ensureInteraction(input())!;
      assert.equal(duplicate.id, first.id);
      assert.equal(database.select().from(codexInteractions).all().length, 1);
      assert.equal(database.select().from(pipelineJobs).all().length, 1);
      assert.doesNotMatch(JSON.stringify(first.payload), /Bearer|SECRET_VALUE|\/Users\//);
      assert.equal("invocationNonceHash" in first, false);
    } finally {
      sqlite.close();
    }
  });

  it("creates nothing when rollout is disabled", () => {
    const { sqlite, database } = fixture();
    try {
      const broker = new HumanInteractionBroker(database, flags(false));
      assert.equal(broker.ensureInteraction(input()), null);
      assert.equal(database.select().from(codexInteractions).all().length, 0);
      assert.equal(database.select().from(pipelineJobs).all().length, 0);
    } finally {
      sqlite.close();
    }
  });

  it("expires stale cards with CAS and cancels presentation", () => {
    const { sqlite, database } = fixture();
    try {
      const broker = new HumanInteractionBroker(database, flags());
      const interaction = broker.ensureInteraction(input())!;
      assert.equal(broker.reconcileChange("CHG-1", {
        gateVersion: "8",
        sourceDbHash: "db-8",
      }), 1);
      assert.equal(broker.get(interaction.id)?.status, "expired");
      assert.equal(database.select().from(pipelineJobs).all()[0]?.status, "cancelled");
      assert.throws(
        () => createCodexInteractionRepository(database)
          .markPresented(interaction.id, "pending"),
        InteractionStateConflictError,
      );
    } finally {
      sqlite.close();
    }
  });
});
