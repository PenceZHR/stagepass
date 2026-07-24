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
} from "../db/schema";
import {
  InteractionPresentationError,
  InteractionPresentationOrchestrator,
} from "./interaction-presentation-orchestrator";

const NOW = "2026-07-24T00:00:00.000Z";

function fixture(deadline = "2026-07-25T00:00:00.000Z") {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  const database = drizzle(sqlite, { schema });
  database.insert(projects).values({
    id: "PRJ-1", name: "P", repoPath: "/tmp/task7-orchestrator",
    createdAt: NOW, updatedAt: NOW,
  }).run();
  database.insert(changes).values({
    id: "CHG-1", projectId: "PRJ-1", title: "C",
    status: "INTAKE_READY", createdAt: NOW, updatedAt: NOW,
  }).run();
  database.insert(codexThreadBindings).values({
    bindingId: "BIND-1", scopeKind: "change", scopeId: "CHG-1",
    projectId: "PRJ-1", changeId: "CHG-1", threadId: "THREAD-1",
    title: "C", status: "ready", bridgeProtocolVersion: "v1",
    lastSeenAt: NOW, createdAt: NOW, updatedAt: NOW,
  }).run();
  database.insert(codexInteractions).values({
    id: "INT-1", changeId: "CHG-1", bindingId: "BIND-1",
    codexThreadId: "THREAD-1", phase: "Intake", kind: "gate_decision",
    gateVersion: 1, sourceDbHash: "db", payloadJson: JSON.stringify({
      title: "T", summary: "S", actionIds: ["approve"], payload: {},
    }), formJson: JSON.stringify({ fields: [] }), status: "pending",
    idempotencyKey: "i", requestHash: "r", expiresAt: deadline,
    createdAt: NOW, updatedAt: NOW,
  }).run();
  database.insert(pipelineJobs).values({
    id: "PJOB-1", changeId: "CHG-1", phase: "Intake",
    actionId: "present_interaction", status: "running",
    leasedBy: "worker", leaseToken: "lease", workerNonce: "nonce",
    leaseExpiresAt: "2026-07-25T00:00:00.000Z", heartbeatAt: NOW,
    attemptNo: 1, provider: "codex", jobKind: "interaction_present",
    effectType: "interaction_present", interactionId: "INT-1",
    effectSchemaVersion: "stagepass.pipeline-effect/v1",
    effectPayloadJson: JSON.stringify({
      schemaVersion: "stagepass.pipeline-effect/v1",
      kind: "interaction_present",
      interactionId: "INT-1",
    }),
    nextTurnOrdinal: 0, effectDeadlineAt: deadline, createdAt: NOW,
  }).run();
  return { sqlite, database };
}

describe("interaction presentation orchestrator", () => {
  it("allocates one ordinal, calls engine with logicalTurnId only, and stays pending", async () => {
    const { sqlite, database } = fixture();
    try {
      const calls: unknown[] = [];
      const orchestrator = new InteractionPresentationOrchestrator({
        database,
        now: () => new Date("2026-07-24T00:01:00.000Z"),
        resolveTurn: async () => ({ logicalTurnId: "LOGICAL-1" }) as never,
        engine: {
          async run(value) {
            calls.push(value);
            return { summary: "", items: [], changedFiles: [] };
          },
          async *runStreamed() {},
        },
      });
      const result = await orchestrator.run("PJOB-1", {
        jobId: "PJOB-1", workerId: "worker", leaseToken: "lease", attemptNo: 1,
      });
      assert.deepEqual(calls, [{ logicalTurnId: "LOGICAL-1" }]);
      assert.equal(result.ordinal, 0);
      assert.equal(result.interaction.status, "pending");
      assert.equal(database.select().from(pipelineJobs).all()[0]?.nextTurnOrdinal, 1);
    } finally {
      sqlite.close();
    }
  });

  it("fails interaction and job when deadline is exhausted", async () => {
    const { sqlite, database } = fixture("2026-07-23T00:00:00.000Z");
    try {
      const orchestrator = new InteractionPresentationOrchestrator({
        database,
        now: () => new Date("2026-07-24T00:01:00.000Z"),
      });
      await assert.rejects(
        () => orchestrator.run("PJOB-1", {
          jobId: "PJOB-1", workerId: "worker", leaseToken: "lease", attemptNo: 1,
        }),
        (error) => error instanceof InteractionPresentationError
          && error.code === "interaction_presentation_deadline_exhausted",
      );
      assert.equal(database.select().from(codexInteractions).all()[0]?.status, "failed");
      assert.equal(database.select().from(pipelineJobs).all()[0]?.status, "failed");
    } finally {
      sqlite.close();
    }
  });
});
