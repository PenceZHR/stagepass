import type { db } from "../db";
import {
  createPipelineCommandRepository,
  type PipelineCommandConnection,
} from "../repositories/pipeline-command-repository";
import type {
  PipelineCommand,
  PipelineCommandHandlerResult,
  PipelineCommandResult,
} from "./pipeline-command-types";
import { PipelineCommandError } from "./pipeline-command-types";

type PipelineCommandDb = typeof db;

export interface PipelineCommandCompletionContext {
  tx: PipelineCommandConnection;
  decisionId: string | null;
}

export interface AuthenticatedInteractionClaim {
  invocationNonceHash: string;
  sourceThreadId: string;
}

export class PipelineCommandUnitOfWork {
  constructor(
    private readonly database: Pick<PipelineCommandDb, "transaction">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  claim(
    command: PipelineCommand,
    canonicalActionId: string,
    canonicalRequestHash: string,
    authenticatedInteraction?: AuthenticatedInteractionClaim,
  ): void {
    this.database.transaction((tx) => {
      const repository = createPipelineCommandRepository(tx);
      const now = this.clock().toISOString();
      if (command.actor.interactionId) {
        const claimed = authenticatedInteraction
          ? repository.claimAuthenticatedInteraction({
              interactionId: command.actor.interactionId,
              invocationNonceHash:
                authenticatedInteraction.invocationNonceHash,
              sourceThreadId: authenticatedInteraction.sourceThreadId,
              now,
            })
          : repository.claimInteraction(command.actor.interactionId, now);
        if (!claimed) {
          throw new PipelineCommandError(
            authenticatedInteraction
              ? "invocation_nonce_invalid"
              : "interaction_not_presented",
            "Interaction is no longer available for submission",
          );
        }
      }
      repository.insertAcceptedReceipt({
        command,
        canonicalActionId,
        requestHash: canonicalRequestHash,
        now,
      });
    });
  }

  complete(
    command: PipelineCommand,
    input: {
      canonicalActionId: string;
      phase: string;
      gateVersion: string;
      sourceDbHash: string;
      sourceHeadSha: string | null;
      humanDecision: boolean;
      mutate: (
        context: PipelineCommandCompletionContext,
      ) => PipelineCommandHandlerResult;
    },
  ): Promise<PipelineCommandResult> {
    return Promise.resolve(
      this.database.transaction((tx) => {
        const repository = createPipelineCommandRepository(tx);
        const decisionId = input.humanDecision
          ? `DEC-CMD-${command.commandId}`
          : null;
        const now = this.clock().toISOString();
        if (decisionId) {
          repository.insertHumanDecision({
            id: decisionId,
            command,
            canonicalActionId: input.canonicalActionId,
            phase: input.phase,
            reportHash: input.sourceDbHash,
            now,
          });
        }
        const mutation = input.mutate({ tx, decisionId });
        if (command.actor.interactionId) {
          const interaction = repository.findInteraction(
            command.actor.interactionId,
          );
          if (!interaction) throw new Error("interaction_not_found");
          repository.ensureInteractionWake({
            command,
            phase: input.phase,
            now,
            deadlineAt: interaction.expiresAt
              ?? new Date(this.clock().getTime() + 60 * 60 * 1_000)
                .toISOString(),
          });
        }

        const result: PipelineCommandResult = {
          commandId: command.commandId,
          status: "completed",
          changeStatus: mutation.changeStatus,
          gateVersion: input.gateVersion,
          sourceDbHash: input.sourceDbHash,
          sourceHeadSha: input.sourceHeadSha,
          interactionId: command.actor.interactionId ?? null,
          humanDecisionId: mutation.humanDecisionId ?? decisionId,
          enqueuedJobId: mutation.enqueuedJobId ?? null,
        };
        repository.completeReceipt(command.commandId, result, now);
        if (command.actor.interactionId) {
          repository.completeInteraction(command.actor.interactionId, now);
        }
        for (const [index, effect] of (
          mutation.outboxEffects ?? []
        ).entries()) {
          repository.ensureOutboxEffect({
            id: `PCO-${command.commandId}-${index}`,
            commandId: command.commandId,
            interactionId: command.actor.interactionId ?? null,
            effectType: effect.effectType,
            payload: effect.payload,
            now,
          });
        }
        return result;
      }),
    );
  }
}
