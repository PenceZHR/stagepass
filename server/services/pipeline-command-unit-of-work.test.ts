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
  humanDecisions,
  pipelineCommandOutbox,
  pipelineCommandReceipts,
  pipelineJobs,
  projects,
} from "../db/schema";
import { canonicalPipelineCommandRequestHash } from "./pipeline-command-gateway";
import { PipelineCommandUnitOfWork } from "./pipeline-command-unit-of-work";
import type { PipelineCommand } from "./pipeline-command-types";
import {
  PipelineCommandOutboxDispatcher,
} from "./pipeline-command-outbox-dispatcher";
import {
  InteractionWakeupRecoveryService,
} from "./interaction-wakeup-recovery-service";

describe("pipeline command unit of work", () => {
  it("claims once and completes decision, receipt, interaction and outbox atomically", async () => {
    const sqlite = new Database(":memory:");
    try {
      runMigrations(sqlite);
      sqlite.pragma("foreign_keys = ON");
      const database = drizzle(sqlite, { schema });
      const now = "2026-07-24T00:00:00.000Z";
      database.insert(projects).values({
        id: "PRJ-1",
        name: "Project",
        repoPath: "/tmp/task5-project",
        createdAt: now,
        updatedAt: now,
      }).run();
      database.insert(changes).values({
        id: "CHG-1",
        projectId: "PRJ-1",
        title: "Change",
        status: "INTAKE_READY",
        createdAt: now,
        updatedAt: now,
      }).run();
      database.insert(codexThreadBindings).values({
        bindingId: "BIND-1",
        scopeKind: "change",
        scopeId: "CHG-1",
        projectId: "PRJ-1",
        changeId: "CHG-1",
        threadId: "THREAD-1",
        title: "Change",
        status: "waiting_human",
        bridgeProtocolVersion: "v1",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
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
        payloadJson: JSON.stringify({ actionIds: ["approve_intake"] }),
        status: "presented",
        idempotencyKey: "interaction-key",
        presentedAt: now,
        expiresAt: "2026-07-25T00:00:00.000Z",
        createdAt: now,
        updatedAt: now,
      }).run();

      const command: PipelineCommand = {
        commandId: "CMD-1",
        projectId: "PRJ-1",
        changeId: "CHG-1",
        actionId: "approve_intake",
        expectedGateVersion: "7",
        expectedSourceDbHash: "db-7",
        expectedHeadSha: null,
        idempotencyKey: "command-key",
        requestHash: "",
        actor: {
          kind: "human",
          surface: "codex_mcp_app",
          codexThreadId: "THREAD-1",
          interactionId: "INT-1",
        },
        payload: {},
      };
      command.requestHash = canonicalPipelineCommandRequestHash(command);
      const unit = new PipelineCommandUnitOfWork(
        database,
        () => new Date(now),
      );
      unit.claim(command, "approve_intake", command.requestHash);
      assert.equal(
        database.select().from(codexInteractions).all()[0]?.status,
        "submitting",
      );
      assert.equal(
        database.select().from(pipelineCommandReceipts).all()[0]?.status,
        "accepted",
      );

      const result = await unit.complete(command, {
        canonicalActionId: "approve_intake",
        phase: "Intake",
        gateVersion: "7",
        sourceDbHash: "db-7",
        sourceHeadSha: null,
        humanDecision: true,
        mutate: ({ tx }) => {
          tx.update(changes)
            .set({ gateState: "intake" })
            .run();
          return {
            changeStatus: "INTAKE_READY",
            outboxEffects: [
              { effectType: "interaction_wakeup", payload: { commandId: "CMD-1" } },
            ],
          };
        },
      });

      assert.equal(result.humanDecisionId, "DEC-CMD-CMD-1");
      assert.equal(database.select().from(humanDecisions).all().length, 1);
      assert.equal(database.select().from(pipelineCommandOutbox).all().length, 1);
      const wake = database.select().from(pipelineJobs).all();
      assert.equal(wake.length, 1);
      assert.equal(wake[0]?.jobKind, "interaction_wakeup");
      assert.equal(wake[0]?.commandId, "CMD-1");
      assert.equal(
        database.select().from(pipelineCommandReceipts).all()[0]?.status,
        "completed",
      );
      assert.equal(
        database.select().from(codexInteractions).all()[0]?.status,
        "completed",
      );
      const dispatched: string[] = [];
      const outbox = new PipelineCommandOutboxDispatcher({
        database,
        now: () => new Date(now),
        dispatchExisting: async (jobId) => {
          dispatched.push(jobId);
          return database.select().from(pipelineJobs).all()[0]!;
        },
      });
      await outbox.dispatch("PCO-CMD-1-interaction_wakeup");
      await outbox.dispatch("PCO-CMD-1-interaction_wakeup");
      assert.deepEqual(dispatched, ["PJOB-WAKE-CMD-1"]);

      const recovered: string[] = [];
      const recovery = new InteractionWakeupRecoveryService({
        database,
        now: () => new Date("2026-07-24T00:01:00.000Z"),
        workerId: "wake-recovery",
        orchestrator: {
          async run(jobId) {
            recovered.push(jobId);
            return {} as never;
          },
        },
      });
      await recovery.recoverPending();
      await recovery.recoverPending();
      assert.deepEqual(recovered, ["PJOB-WAKE-CMD-1"]);
    } finally {
      sqlite.close();
    }
  });
});
