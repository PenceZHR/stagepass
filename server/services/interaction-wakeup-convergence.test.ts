import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

process.env.STAGEPASS_DB_PATH =
  `/private/tmp/stagepass-wake-converge-${process.pid}-${Date.now()}.sqlite`;

import { runMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import {
  changes,
  codexBindingRunLeases,
  codexFollowerStartAttempts,
  codexInteractions,
  codexLogicalTurns,
  codexThreadBindings,
  codexTurnExecutions,
  events,
  pipelineCommandReceipts,
  pipelineJobs,
  projects,
} from "../db/schema";
import type { AiRunResult } from "./ai-engine-types";

function turnResult(overrides: Partial<AiRunResult> = {}): AiRunResult {
  return {
    threadId: "THREAD-1",
    runId: "ATTEMPT-1",
    summary: "正式 PRD 文本",
    success: true,
    changedFiles: [],
    items: [],
    ...overrides,
  } as AiRunResult;
}

async function fixture() {
  // One database file for the whole file: the services under test resolve the
  // global handle's path once, so swapping it mid-process points them at an
  // unmigrated file. Each case re-seeds from empty instead.
  const sqlite = new Database(process.env.STAGEPASS_DB_PATH!);
  runMigrations(sqlite);
  sqlite.pragma("foreign_keys = ON");
  const database = drizzle(sqlite, { schema });
  for (const table of [
    events,
    codexTurnExecutions,
    codexFollowerStartAttempts,
    codexBindingRunLeases,
    codexLogicalTurns,
    pipelineJobs,
    pipelineCommandReceipts,
    codexInteractions,
    codexThreadBindings,
    changes,
    projects,
  ]) database.delete(table).run();
  const now = new Date();
  const nowText = now.toISOString();
  const deadline = new Date(now.getTime() + 60 * 60_000).toISOString();

  database.insert(projects).values({
    id: "PRJ-1",
    name: "Project",
    repoPath: "/tmp/wake-converge",
    createdAt: nowText,
    updatedAt: nowText,
  }).run();
  database.insert(changes).values({
    id: "CHG-1",
    projectId: "PRJ-1",
    title: "Change",
    status: "INTAKE_PENDING",
    createdAt: nowText,
    updatedAt: nowText,
  }).run();
  database.insert(codexThreadBindings).values({
    bindingId: "BIND-1",
    scopeKind: "change_stage",
    scopeId: `CHG-1:prd`,
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
    phase: "prd",
    kind: "requirement_choice",
    gateVersion: 1,
    sourceDbHash: "db",
    payloadJson: JSON.stringify({
      schemaVersion: "stagepass.choice-receipt/v2",
      cardInteractionId: "prd-batch-1",
      answers: [{
        questionId: "target-player",
        question: "谁来玩？",
        selectedOptionIds: ["solo"],
        selectedLabels: ["单人玩家"],
      }],
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
    action: "record_stagepass_choice",
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
    phase: "prd",
    actionId: "continue_stagepass_interaction",
    idempotencyKey: "interaction-wakeup:CMD-1",
    status: "running",
    leasedBy: "worker-1",
    leaseToken: "lease-1",
    attemptNo: 1,
    leaseExpiresAt: deadline,
    heartbeatAt: nowText,
    startedAt: nowText,
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
  return { sqlite, database };
}

const context = {
  jobId: "PJOB-WAKE-CMD-1",
  workerId: "worker-1",
  leaseToken: "lease-1",
  attemptNo: 1,
};

async function orchestratorWith(
  database: ReturnType<typeof fixture>["database"],
  overrides: {
    observeTurn?: (logicalTurnId: string) => Promise<AiRunResult>;
    adoptResult?: (input: {
      changeId: string;
      phase: string;
      result: AiRunResult;
    }) => Promise<void>;
  },
) {
  const { InteractionWakeupOrchestrator } = await import(
    "./interaction-wakeup-orchestrator"
  );
  return new InteractionWakeupOrchestrator({
    database,
    now: () => new Date(),
    hostClient: {
      async sendUiMessage() {
        return { turnId: "TURN-WAKE-1" };
      },
    },
    ...overrides,
  });
}

describe("interaction wakeup convergence", () => {
  it("adopts the stage result once the continuation stops asking", async () => {
    const { sqlite, database } = await fixture();
    try {
      const adopted: Array<{ changeId: string; phase: string; text: string }> = [];
      const orchestrator = await orchestratorWith(database, {
        observeTurn: async () => turnResult({ summary: "正式 PRD 文本" }),
        adoptResult: async (input) => {
          adopted.push({
            changeId: input.changeId,
            phase: input.phase,
            text: input.result.summary!,
          });
        },
      });

      const outcome = await orchestrator.run("PJOB-WAKE-CMD-1", context);

      assert.equal(outcome.convergence, "converged");
      assert.deepEqual(adopted, [
        { changeId: "CHG-1", phase: "prd", text: "正式 PRD 文本" },
      ]);
    } finally {
      const { closeDatabaseHandle } = await import("../db");
      closeDatabaseHandle();
      sqlite.close();
    }
  });

  it("leaves the stage alone while the task is still asking", async () => {
    const { sqlite, database } = await fixture();
    try {
      let adoptions = 0;
      const orchestrator = await orchestratorWith(database, {
        observeTurn: async () => turnResult({
          items: [{
            type: "mcp_tool_call",
            name: "stagepass-card/present_stagepass_choices",
            status: "completed",
            id: "ITEM-1",
          }],
        }),
        adoptResult: async () => { adoptions += 1; },
      });

      const outcome = await orchestrator.run("PJOB-WAKE-CMD-1", context);

      assert.equal(outcome.convergence, "asked_again");
      assert.equal(adoptions, 0);
    } finally {
      const { closeDatabaseHandle } = await import("../db");
      closeDatabaseHandle();
      sqlite.close();
    }
  });

  // The answers are already spent: a second adoption would write the stage
  // artifact twice and drive the gate from a status it no longer holds.
  it("adopts a converged reply only once per confirmed decision", async () => {
    const { sqlite, database } = await fixture();
    try {
      let adoptions = 0;
      const orchestrator = await orchestratorWith(database, {
        observeTurn: async () => turnResult(),
        adoptResult: async () => { adoptions += 1; },
      });

      await orchestrator.run("PJOB-WAKE-CMD-1", context);
      const second = await orchestrator.run("PJOB-WAKE-CMD-1", context);

      assert.equal(adoptions, 1);
      assert.equal(second.convergence, "already_adopted");
      assert.equal(
        database.select().from(events).all()
          .filter((row) => row.type === "stage_result_adopted").length,
        1,
      );
    } finally {
      const { closeDatabaseHandle } = await import("../db");
      closeDatabaseHandle();
      sqlite.close();
    }
  });

  it("refuses to adopt a continuation turn that never completed", async () => {
    const { sqlite, database } = await fixture();
    try {
      let adoptions = 0;
      const orchestrator = await orchestratorWith(database, {
        observeTurn: async () => turnResult({
          success: false,
          providerErrorCode: "interrupted",
        }),
        adoptResult: async () => { adoptions += 1; },
      });

      const outcome = await orchestrator.run("PJOB-WAKE-CMD-1", context);

      assert.equal(outcome.convergence, "inconclusive");
      assert.equal(adoptions, 0);
    } finally {
      const { closeDatabaseHandle } = await import("../db");
      closeDatabaseHandle();
      sqlite.close();
    }
  });
});
