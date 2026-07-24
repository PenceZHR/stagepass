import { and, desc, eq } from "drizzle-orm";

import { db } from "../db";
import {
  codexInteractions,
  codexLogicalTurns,
  pipelineJobs,
} from "../db/schema";
import type { AiEngineAdapter, AiRunInput } from "./ai-engine-types";
import { createProductionCodexDesktopEngine } from "./codex-desktop-engine";
import { resolveLogicalTurn } from "./codex-logical-turn-service";
import type { JobExecutionContext } from "./job-execution-context";
import {
  InteractionPresentationEffectSchema,
  type InteractionEnvelope,
} from "./interaction-types";
import { createCodexInteractionRepository } from "../repositories/codex-interaction-repository";

export class InteractionPresentationError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "InteractionPresentationError";
  }
}

type PresentationDb = typeof db;

export interface InteractionPresentationDependencies {
  database?: PresentationDb;
  engine?: AiEngineAdapter;
  resolveTurn?: typeof resolveLogicalTurn;
  now?: () => Date;
}

export interface InteractionPresentationResult {
  interaction: InteractionEnvelope;
  logicalTurnId: string;
  ordinal: number;
  hostPresentationRequired: true;
}

export class InteractionPresentationOrchestrator {
  private readonly database: PresentationDb;
  private readonly resolveTurn: typeof resolveLogicalTurn;
  private readonly now: () => Date;

  constructor(private readonly dependencies: InteractionPresentationDependencies = {}) {
    this.database = dependencies.database ?? db;
    this.resolveTurn = dependencies.resolveTurn ?? resolveLogicalTurn;
    this.now = dependencies.now ?? (() => new Date());
  }

  async run(
    jobId: string,
    context: JobExecutionContext,
  ): Promise<InteractionPresentationResult> {
    const allocated = this.allocate(jobId, context);
    const logical = allocated.logical ?? await this.resolveTurn({
      owner: { kind: "pipeline_job", pipelineJobId: jobId },
      phase: allocated.interaction.phase,
      role: "interaction_present",
      round: 0,
      ordinal: allocated.ordinal,
      interactionId: allocated.interaction.id,
      request: {
        interactionId: allocated.interaction.id,
        instruction:
          "StagePass has a human interaction ready. Call\n"
          + "present_stagepass_interaction with the interactionId supplied in this turn's\n"
          + "structured StagePass context.\n"
          + "Do not decide, approve, reject, waive, or submit on the user's behalf.",
      },
    });
    const engine = this.dependencies.engine ?? await createProductionCodexDesktopEngine();
    await engine.run({ logicalTurnId: logical.logicalTurnId } as AiRunInput);

    // Terminal follower output is delivery evidence only. Task 8's protected,
    // Host-attested present facade owns pending -> presented and job completion.
    const current = createCodexInteractionRepository(this.database)
      .getInteraction(allocated.interaction.id);
    if (!current) throw new InteractionPresentationError("interaction_not_found");
    return {
      interaction: current,
      logicalTurnId: logical.logicalTurnId,
      ordinal: allocated.ordinal,
      hostPresentationRequired: true,
    };
  }

  private allocate(jobId: string, context: JobExecutionContext): {
    interaction: InteractionEnvelope;
    ordinal: number;
    logical: typeof codexLogicalTurns.$inferSelect | null;
  } {
    const now = this.now();
    const result = this.database.transaction((tx) => {
      const job = tx.select().from(pipelineJobs).where(eq(pipelineJobs.id, jobId)).get();
      if (
        !job
        || job.jobKind !== "interaction_present"
        || job.effectType !== "interaction_present"
        || !job.effectPayloadJson
        || !job.interactionId
      ) throw new InteractionPresentationError("interaction_presentation_payload_invalid");
      const effect = InteractionPresentationEffectSchema.parse(
        JSON.parse(job.effectPayloadJson),
      );
      if (
        effect.interactionId !== job.interactionId
        || job.effectSchemaVersion !== effect.schemaVersion
      ) throw new InteractionPresentationError("interaction_presentation_payload_invalid");
      if (!job.effectDeadlineAt || Date.parse(job.effectDeadlineAt) <= now.getTime()) {
        tx.update(pipelineJobs).set({
          status: "failed",
          endedAt: now.toISOString(),
          errorCode: "interaction_presentation_deadline_exhausted",
          errorSummary: "Interaction presentation deadline exhausted",
        }).where(and(
          eq(pipelineJobs.id, jobId),
          eq(pipelineJobs.status, job.status),
        )).run();
        tx.update(codexInteractions).set({
          status: "failed",
          updatedAt: now.toISOString(),
        }).where(and(
          eq(codexInteractions.id, job.interactionId),
          eq(codexInteractions.status, "pending"),
        )).run();
        return { errorCode: "interaction_presentation_deadline_exhausted" as const };
      }
      if (
        job.status !== "running"
        || job.leasedBy !== context.workerId
        || job.leaseToken !== context.leaseToken
        || job.attemptNo !== context.attemptNo
        || !job.leaseExpiresAt
        || Date.parse(job.leaseExpiresAt) <= now.getTime()
      ) throw new InteractionPresentationError("interaction_presentation_lease_stale");
      const interaction = createCodexInteractionRepository(tx)
        .getInteraction(job.interactionId);
      if (!interaction || interaction.status !== "pending") {
        throw new InteractionPresentationError("interaction_not_pending");
      }

      const liveLogical = tx.select().from(codexLogicalTurns).where(and(
        eq(codexLogicalTurns.pipelineJobId, jobId),
        eq(codexLogicalTurns.interactionId, job.interactionId),
        eq(codexLogicalTurns.role, "interaction_present"),
      )).orderBy(desc(codexLogicalTurns.ordinal)).get() ?? null;
      if (liveLogical && ["pending", "running"].includes(liveLogical.status)) {
        return {
          interaction,
          ordinal: liveLogical.ordinal,
          logical: liveLogical,
        };
      }

      const ordinal = job.nextTurnOrdinal;
      const changed = tx.update(pipelineJobs).set({
        nextTurnOrdinal: ordinal + 1,
      }).where(and(
        eq(pipelineJobs.id, jobId),
        eq(pipelineJobs.status, "running"),
        eq(pipelineJobs.leaseToken, context.leaseToken),
        eq(pipelineJobs.attemptNo, context.attemptNo),
        eq(pipelineJobs.nextTurnOrdinal, ordinal),
      )).run().changes;
      if (changed !== 1) {
        throw new InteractionPresentationError("interaction_presentation_ordinal_conflict");
      }
      return { interaction, ordinal, logical: null };
    });
    if ("errorCode" in result) {
      throw new InteractionPresentationError(result.errorCode!);
    }
    return result;
  }
}

export async function runInteractionPresentation(
  jobId: string,
  context: JobExecutionContext,
): Promise<InteractionPresentationResult> {
  return new InteractionPresentationOrchestrator().run(jobId, context);
}
