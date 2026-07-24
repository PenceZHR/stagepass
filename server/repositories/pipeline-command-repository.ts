import { and, eq, gt, isNull } from "drizzle-orm";

import type { db } from "../db";
import {
  changes,
  codexInteractions,
  humanDecisions,
  pipelineCommandOutbox,
  pipelineCommandReceipts,
  pipelineJobs,
} from "../db/schema";
import type {
  PipelineCommand,
  PipelineCommandResult,
} from "../services/pipeline-command-types";

export type PipelineCommandConnection = Pick<
  typeof db,
  "select" | "insert" | "update"
>;

export function createPipelineCommandRepository(
  connection: PipelineCommandConnection,
) {
  return {
    findChange(changeId: string) {
      return connection
        .select()
        .from(changes)
        .where(eq(changes.id, changeId))
        .get();
    },

    findInteraction(interactionId: string) {
      return connection
        .select()
        .from(codexInteractions)
        .where(eq(codexInteractions.id, interactionId))
        .get();
    },

    readReceiptByIdempotency(changeId: string, idempotencyKey: string) {
      return connection
        .select()
        .from(pipelineCommandReceipts)
        .where(
          and(
            eq(pipelineCommandReceipts.changeId, changeId),
            eq(pipelineCommandReceipts.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
    },

    insertAcceptedReceipt(input: {
      command: PipelineCommand;
      canonicalActionId: string;
      requestHash: string;
      now: string;
    }) {
      connection
        .insert(pipelineCommandReceipts)
        .values({
          commandId: input.command.commandId,
          changeId: input.command.changeId,
          interactionId: input.command.actor.interactionId ?? null,
          codexThreadId: input.command.actor.codexThreadId ?? null,
          action: input.canonicalActionId,
          actorKind: input.command.actor.kind,
          actorSurface: input.command.actor.surface,
          idempotencyKey: input.command.idempotencyKey,
          requestHash: input.requestHash,
          status: "accepted",
          resultJson: null,
          errorCode: null,
          createdAt: input.now,
          completedAt: null,
        })
        .run();
    },

    claimInteraction(interactionId: string, now: string): boolean {
      const changed = connection
        .update(codexInteractions)
        .set({ status: "submitting", updatedAt: now })
        .where(
          and(
            eq(codexInteractions.id, interactionId),
            eq(codexInteractions.status, "presented"),
          ),
        )
        .run();
      return changed.changes === 1;
    },

    claimAuthenticatedInteraction(input: {
      interactionId: string;
      invocationNonceHash: string;
      sourceThreadId: string;
      now: string;
    }): boolean {
      const changed = connection
        .update(codexInteractions)
        .set({
          status: "submitting",
          nonceConsumedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(codexInteractions.id, input.interactionId),
            eq(codexInteractions.status, "presented"),
            eq(codexInteractions.invocationNonceHash, input.invocationNonceHash),
            eq(codexInteractions.sourceThreadId, input.sourceThreadId),
            isNull(codexInteractions.nonceConsumedAt),
            gt(codexInteractions.nonceExpiresAt, input.now),
          ),
        )
        .run();
      return changed.changes === 1;
    },

    completeReceipt(commandId: string, result: PipelineCommandResult, now: string) {
      connection
        .update(pipelineCommandReceipts)
        .set({
          status: "completed",
          resultJson: JSON.stringify(result),
          completedAt: now,
        })
        .where(eq(pipelineCommandReceipts.commandId, commandId))
        .run();
    },

    completeInteraction(interactionId: string, now: string) {
      connection
        .update(codexInteractions)
        .set({ status: "completed", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(codexInteractions.id, interactionId),
            eq(codexInteractions.status, "submitting"),
          ),
        )
        .run();
    },

    insertHumanDecision(input: {
      id: string;
      command: PipelineCommand;
      canonicalActionId: string;
      phase: string;
      reportHash: string;
      now: string;
    }) {
      connection
        .insert(humanDecisions)
        .values({
          id: input.id,
          changeId: input.command.changeId,
          roundId: null,
          gate: input.phase,
          action: input.canonicalActionId,
          targetType: "change",
          targetId: input.command.changeId,
          reason:
            typeof input.command.payload.reason === "string"
              ? input.command.payload.reason
              : null,
          reportHash: input.reportHash,
          createdBy: "human",
          interactionId: input.command.actor.interactionId ?? null,
          actorSurface: input.command.actor.surface,
          codexThreadId: input.command.actor.codexThreadId ?? null,
          commandId: input.command.commandId,
          createdAt: input.now,
        })
        .run();
    },

    ensureOutboxEffect(input: {
      id: string;
      commandId: string;
      interactionId: string | null;
      effectType: string;
      payload: Record<string, unknown>;
      now: string;
    }) {
      connection
        .insert(pipelineCommandOutbox)
        .values({
          id: input.id,
          commandId: input.commandId,
          interactionId: input.interactionId,
          effectType: input.effectType,
          effectPayloadJson: JSON.stringify(input.payload),
          status: "pending",
          attemptCount: 0,
          lastErrorCode: null,
          createdAt: input.now,
          updatedAt: input.now,
          dispatchedAt: null,
        })
        .onConflictDoNothing()
        .run();
    },

    ensureInteractionWake(input: {
      command: PipelineCommand;
      phase: string;
      now: string;
      deadlineAt: string;
    }): string {
      const interactionId = input.command.actor.interactionId;
      if (!interactionId) {
        throw new Error("interaction_wakeup_requires_interaction");
      }
      const jobId = `PJOB-WAKE-${input.command.commandId}`;
      const effect = {
        schemaVersion: "stagepass.pipeline-effect/v1",
        kind: "interaction_wakeup",
        interactionId,
        commandId: input.command.commandId,
      } as const;
      connection.insert(pipelineJobs).values({
        id: jobId,
        changeId: input.command.changeId,
        phase: input.phase,
        actionId: "continue_stagepass_interaction",
        idempotencyKey: `interaction-wakeup:${input.command.commandId}`,
        status: "queued",
        attemptNo: 1,
        provider: "codex",
        jobKind: "interaction_wakeup",
        effectType: "interaction_wakeup",
        interactionId,
        commandId: input.command.commandId,
        effectSchemaVersion: effect.schemaVersion,
        effectPayloadJson: JSON.stringify(effect),
        nextTurnOrdinal: 0,
        effectDeadlineAt: input.deadlineAt,
        createdAt: input.now,
      }).onConflictDoNothing().run();
      this.ensureOutboxEffect({
        id: `PCO-${input.command.commandId}-interaction_wakeup`,
        commandId: input.command.commandId,
        interactionId,
        effectType: "interaction_wakeup",
        payload: { ...effect, pipelineJobId: jobId },
        now: input.now,
      });
      return jobId;
    },
  };
}

export type PipelineCommandRepository = ReturnType<
  typeof createPipelineCommandRepository
>;
