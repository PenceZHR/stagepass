import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

process.env.STAGEPASS_DB_PATH =
  `/private/tmp/stagepass-wake-retry-${process.pid}-${Date.now()}.sqlite`;

import { runMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import {
  changes,
  codexInteractions,
  codexThreadBindings,
  pipelineCommandReceipts,
  pipelineJobs,
  projects,
} from "../db/schema";

function seed(database: ReturnType<typeof drizzle>, deadlineAt: string) {
  const nowText = new Date().toISOString();
  database.insert(projects).values({
    id: "PRJ-1", name: "P", repoPath: "/tmp/wake-retry",
    createdAt: nowText, updatedAt: nowText,
  }).run();
  database.insert(changes).values({
    id: "CHG-1", projectId: "PRJ-1", title: "C", status: "INTAKE_PENDING",
    createdAt: nowText, updatedAt: nowText,
  }).run();
  database.insert(codexThreadBindings).values({
    bindingId: "BIND-1", scopeKind: "change_stage", scopeId: "CHG-1:prd",
    projectId: "PRJ-1", changeId: "CHG-1", threadId: "THREAD-1", title: "C",
    status: "ready", bridgeProtocolVersion: "v1", lastSeenAt: nowText,
    createdAt: nowText, updatedAt: nowText,
  }).run();
  database.insert(codexInteractions).values({
    id: "INT-1", changeId: "CHG-1", bindingId: "BIND-1",
    codexThreadId: "THREAD-1", phase: "prd", kind: "requirement_choice",
    gateVersion: 1, sourceDbHash: "db", payloadJson: "{}",
    status: "completed", idempotencyKey: "i", completedAt: nowText,
    expiresAt: deadlineAt, createdAt: nowText, updatedAt: nowText,
  }).run();
  database.insert(pipelineCommandReceipts).values({
    commandId: "CMD-1", changeId: "CHG-1", interactionId: "INT-1",
    codexThreadId: "THREAD-1", action: "record_stagepass_choice",
    actorKind: "human", actorSurface: "codex_mcp_app", idempotencyKey: "c",
    requestHash: "r", status: "completed", resultJson: "{}",
    createdAt: nowText, completedAt: nowText,
  }).run();
  database.insert(pipelineJobs).values({
    id: "PJOB-WAKE-CMD-1", changeId: "CHG-1", phase: "prd",
    actionId: "continue_stagepass_interaction",
    idempotencyKey: "interaction-wakeup:CMD-1",
    status: "failed",
    errorCode: "pipeline_job_failed",
    errorSummary: "observation crashed",
    attemptNo: 1,
    endedAt: nowText,
    provider: "codex", jobKind: "interaction_wakeup",
    effectType: "interaction_wakeup", interactionId: "INT-1",
    commandId: "CMD-1",
    effectSchemaVersion: "stagepass.pipeline-effect/v1",
    effectPayloadJson: JSON.stringify({
      schemaVersion: "stagepass.pipeline-effect/v1",
      kind: "interaction_wakeup",
      interactionId: "INT-1",
      commandId: "CMD-1",
    }),
    effectDeadlineAt: deadlineAt,
    createdAt: nowText,
  }).run();
}

async function recoveryOver(
  database: ReturnType<typeof drizzle>,
  runs: string[],
) {
  const { InteractionWakeupRecoveryService } = await import(
    "./interaction-wakeup-recovery-service"
  );
  return new InteractionWakeupRecoveryService({
    database,
    orchestrator: {
      async run(jobId: string) {
        runs.push(jobId);
        return {
          status: "already_dispatched" as const,
          pipelineJobId: jobId,
          logicalTurnId: "LT-1",
          attemptId: "AT-1",
          turnId: "TURN-1",
          convergence: "converged" as const,
        };
      },
    },
    now: () => new Date(),
    workerId: "retry-worker",
  });
}

describe("interaction wakeup retry", () => {
  // The wakeup now owns persisting the stage result, so a crash mid-observation
  // strands a decision the human already made. Its own budget is the bound.
  it("retries a failed wakeup while its effect budget is still live", async () => {
    const sqlite = new Database(process.env.STAGEPASS_DB_PATH!);
    try {
      runMigrations(sqlite);
      sqlite.pragma("foreign_keys = ON");
      const database = drizzle(sqlite, { schema });
      seed(database, new Date(Date.now() + 20 * 60_000).toISOString());
      const runs: string[] = [];

      await (await recoveryOver(database, runs)).recoverPending();

      assert.deepEqual(runs, ["PJOB-WAKE-CMD-1"]);
    } finally {
      const { closeDatabaseHandle } = await import("../db");
      closeDatabaseHandle();
      sqlite.close();
    }
  });

  it("leaves a failed wakeup alone once its budget is spent", async () => {
    process.env.STAGEPASS_DB_PATH =
      `/private/tmp/stagepass-wake-retry-spent-${process.pid}-${Date.now()}.sqlite`;
    const sqlite = new Database(process.env.STAGEPASS_DB_PATH!);
    try {
      runMigrations(sqlite);
      sqlite.pragma("foreign_keys = ON");
      const database = drizzle(sqlite, { schema });
      seed(database, new Date(Date.now() - 60_000).toISOString());
      const runs: string[] = [];

      await (await recoveryOver(database, runs)).recoverPending();

      assert.deepEqual(runs, []);
    } finally {
      const { closeDatabaseHandle } = await import("../db");
      closeDatabaseHandle();
      sqlite.close();
    }
  });
});

describe("interaction wakeup recovery lease", () => {
  // run() now watches a whole continuation turn, which outlives the recovery
  // lease. Without a heartbeat the next sweep re-acquires the same job, fences
  // the attempt still running, and the pair livelocks forever.
  it("keeps its lease alive while a long recovery is still running", async () => {
    process.env.STAGEPASS_DB_PATH =
      `/private/tmp/stagepass-wake-hb-${process.pid}-${Date.now()}.sqlite`;
    const sqlite = new Database(process.env.STAGEPASS_DB_PATH!);
    try {
      runMigrations(sqlite);
      sqlite.pragma("foreign_keys = ON");
      const database = drizzle(sqlite, { schema });
      seed(database, new Date(Date.now() + 20 * 60_000).toISOString());
      const { InteractionWakeupRecoveryService } = await import(
        "./interaction-wakeup-recovery-service"
      );
      let leaseDuringRun = "";
      const service = new InteractionWakeupRecoveryService({
        database,
        leaseMs: 200,
        heartbeatMs: 20,
        workerId: "hb-worker",
        orchestrator: {
          async run(jobId: string) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            leaseDuringRun = database.select().from(pipelineJobs)
              .all()[0]!.leaseExpiresAt!;
            return {
              status: "already_dispatched" as const,
              pipelineJobId: jobId,
              logicalTurnId: "LT-1",
              attemptId: "AT-1",
              turnId: "TURN-1",
              convergence: "converged" as const,
            };
          },
        },
      });

      await service.recoverPending();

      assert.ok(
        Date.parse(leaseDuringRun) > Date.now(),
        `lease expired mid-run: ${leaseDuringRun}`,
      );
    } finally {
      const { closeDatabaseHandle } = await import("../db");
      closeDatabaseHandle();
      sqlite.close();
    }
  });
});
