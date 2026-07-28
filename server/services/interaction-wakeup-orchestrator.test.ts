import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

process.env.STAGEPASS_DB_PATH =
  `/private/tmp/stagepass-task10-${process.pid}-${Date.now()}.sqlite`;

import { runMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import {
  changes,
  codexFollowerStartAttempts,
  codexInteractions,
  codexLogicalTurns,
  codexThreadBindings,
  codexTurnExecutions,
  pipelineCommandReceipts,
  pipelineJobs,
  projects,
} from "../db/schema";
describe("interaction wakeup main path", () => {
  it("lets concurrent recovery reuse one job, logical turn, attempt, and Host dispatch", async () => {
    const sqlite = new Database(process.env.STAGEPASS_DB_PATH!);
    try {
      runMigrations(sqlite);
      sqlite.pragma("foreign_keys = ON");
      const database = drizzle(sqlite, { schema });
      const now = new Date();
      const nowText = now.toISOString();
      const deadline = new Date(now.getTime() + 60 * 60_000).toISOString();
      database.insert(projects).values({
        id: "PRJ-1",
        name: "Project",
        repoPath: "/tmp/task10-project",
        createdAt: nowText,
        updatedAt: nowText,
      }).run();
      database.insert(changes).values({
        id: "CHG-1",
        projectId: "PRJ-1",
        title: "Change",
        status: "INTAKE_READY",
        createdAt: nowText,
        updatedAt: nowText,
      }).run();
      database.insert(codexThreadBindings).values({
        bindingId: "BIND-1",
        scopeKind: "change_stage",
        scopeId: "CHG-1:prd",
        projectId: "PRJ-1",
        changeId: "CHG-1",
        threadId: "THREAD-1",
        title: "Change",
        status: "waiting_human",
        bridgeProtocolVersion: "v1",
        lastSeenAt: nowText,
        createdAt: nowText,
        updatedAt: nowText,
      }).run();
      database.insert(codexInteractions).values({
        id: "INT-1",
        changeId: "CHG-1",
        bindingId: "BIND-1",
        codexThreadId: "THREAD-1",
        phase: "Intake",
        kind: "requirement_choice",
        gateVersion: 1,
        sourceDbHash: "db",
        payloadJson: JSON.stringify({
          schemaVersion: "stagepass.choice-receipt/v2",
          cardInteractionId: "prd-concrete-batch-1",
          batchTitle: "第 1 批 · 运行前必须确认",
          answers: [
            {
              questionId: "target-player",
              question: "这个小游戏第一版主要给谁玩？",
              selectedOptionIds: ["solo"],
              selectedLabels: ["单人玩家"],
            },
            {
              questionId: "lose-condition",
              question: "哪些情况应立即判定失败？",
              selectedOptionIds: ["timeout", "collision"],
              selectedLabels: ["倒计时结束", "碰到障碍"],
            },
          ],
        }),
        formJson: "{\"fields\":[]}",
        status: "completed",
        idempotencyKey: "interaction",
        completedAt: nowText,
        expiresAt: deadline,
        createdAt: nowText,
        updatedAt: nowText,
      }).run();
      database.insert(pipelineCommandReceipts).values({
        commandId: "CMD-1",
        changeId: "CHG-1",
        interactionId: "INT-1",
        codexThreadId: "THREAD-1",
        action: "approve_intake",
        actorKind: "human",
        actorSurface: "codex_mcp_app",
        idempotencyKey: "command",
        requestHash: "request",
        status: "completed",
        resultJson: "{}",
        createdAt: nowText,
        completedAt: nowText,
      }).run();
      database.insert(pipelineJobs).values({
        id: "PJOB-WAKE-CMD-1",
        changeId: "CHG-1",
        phase: "Intake",
        actionId: "continue_stagepass_interaction",
        idempotencyKey: "interaction-wakeup:CMD-1",
        status: "queued",
        attemptNo: 1,
        provider: "codex",
        jobKind: "interaction_wakeup",
        effectType: "interaction_wakeup",
        interactionId: "INT-1",
        commandId: "CMD-1",
        effectSchemaVersion: "stagepass.pipeline-effect/v1",
        effectPayloadJson: JSON.stringify({
          schemaVersion: "stagepass.pipeline-effect/v1",
          kind: "interaction_wakeup",
          interactionId: "INT-1",
          commandId: "CMD-1",
        }),
        effectDeadlineAt: deadline,
        createdAt: nowText,
      }).run();
      const delivered: string[] = [];
      const [
        { InteractionWakeupOrchestrator },
        { InteractionWakeupRecoveryService },
      ] = await Promise.all([
        import("./interaction-wakeup-orchestrator"),
        import("./interaction-wakeup-recovery-service"),
      ]);
      const orchestrator = new InteractionWakeupOrchestrator({
        database,
        now: () => new Date(),
        hostClient: {
          async sendUiMessage(input) {
            delivered.push(input.text);
            return { turnId: "TURN-WAKE-1" };
          },
        },
      });
      const recovery = new InteractionWakeupRecoveryService({
        database,
        orchestrator,
        now: () => new Date(),
        workerId: "wake-recovery",
      });

      await Promise.all([
        recovery.recoverPending(),
        recovery.recoverPending(),
      ]);

      assert.equal(delivered.length, 1);
      assert.match(delivered[0]!, /^STAGEPASS_SELECTION_CONFIRMED/);
      assert.match(delivered[0]!, /interactionId=prd-concrete-batch-1/);
      assert.match(delivered[0]!, /answersJson=\[\{"questionId":"target-player"/);
      assert.match(delivered[0]!, /"selectedLabels":\["单人玩家"\]/);
      assert.match(delivered[0]!, /仍有阻塞运行的问题/);
      assert.match(delivered[0]!, /present_stagepass_choices/);
      assert.match(delivered[0]!, /每批最多 10 个/);
      assert.match(delivered[0]!, /没有阻塞项/);
      assert.match(delivered[0]!, /\[stagepass-run:.*:attempt:.*\]/);
      assert.equal(database.select().from(pipelineJobs).all().length, 1);
      assert.equal(database.select().from(codexLogicalTurns).all().length, 1);
      assert.equal(database.select().from(codexFollowerStartAttempts).all().length, 1);
      assert.equal(database.select().from(codexTurnExecutions).all().length, 1);
    } finally {
      const { closeDatabaseHandle } = await import("../db");
      closeDatabaseHandle();
      sqlite.close();
    }
  });
});
