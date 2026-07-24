import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { pipelineCommandOutbox, pipelineJobs } from "../db/schema";
import { dispatchExistingPipelineJob } from "./job-dispatch-service";

type OutboxDb = typeof db;

export class PipelineCommandOutboxError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PipelineCommandOutboxError";
  }
}

export interface PipelineCommandOutboxDispatcherDependencies {
  database?: OutboxDb;
  dispatchExisting?: typeof dispatchExistingPipelineJob;
  now?: () => Date;
}

export class PipelineCommandOutboxDispatcher {
  private readonly database: OutboxDb;
  private readonly dispatchExisting: typeof dispatchExistingPipelineJob;
  private readonly now: () => Date;

  constructor(
    dependencies: PipelineCommandOutboxDispatcherDependencies = {},
  ) {
    this.database = dependencies.database ?? db;
    this.dispatchExisting = dependencies.dispatchExisting
      ?? dispatchExistingPipelineJob;
    this.now = dependencies.now ?? (() => new Date());
  }

  async dispatch(effectId: string): Promise<{
    effectId: string;
    pipelineJobId: string;
    status: "dispatched";
  }> {
    const effect = this.database.select().from(pipelineCommandOutbox)
      .where(eq(pipelineCommandOutbox.id, effectId)).get();
    if (!effect) throw new PipelineCommandOutboxError("outbox_effect_not_found");
    if (effect.effectType !== "interaction_wakeup") {
      throw new PipelineCommandOutboxError("outbox_effect_unsupported");
    }
    let payload: { pipelineJobId?: unknown; commandId?: unknown };
    try {
      payload = JSON.parse(effect.effectPayloadJson) as typeof payload;
    } catch {
      throw new PipelineCommandOutboxError("outbox_effect_payload_invalid");
    }
    if (
      typeof payload.pipelineJobId !== "string"
      || payload.commandId !== effect.commandId
    ) {
      throw new PipelineCommandOutboxError("outbox_effect_payload_invalid");
    }
    const job = this.database.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, payload.pipelineJobId)).get();
    if (
      !job
      || job.jobKind !== "interaction_wakeup"
      || job.commandId !== effect.commandId
      || job.interactionId !== effect.interactionId
    ) {
      throw new PipelineCommandOutboxError("outbox_job_identity_mismatch");
    }
    if (effect.status === "dispatched") {
      return {
        effectId,
        pipelineJobId: job.id,
        status: "dispatched",
      };
    }
    try {
      await this.dispatchExisting(job.id);
    } catch (error) {
      this.database.update(pipelineCommandOutbox).set({
        attemptCount: effect.attemptCount + 1,
        lastErrorCode: error instanceof Error
          ? error.message.slice(0, 80)
          : "outbox_dispatch_failed",
        updatedAt: this.now().toISOString(),
      }).where(and(
        eq(pipelineCommandOutbox.id, effect.id),
        eq(pipelineCommandOutbox.status, "pending"),
      )).run();
      throw error;
    }
    const timestamp = this.now().toISOString();
    this.database.update(pipelineCommandOutbox).set({
      status: "dispatched",
      attemptCount: effect.attemptCount + 1,
      lastErrorCode: null,
      updatedAt: timestamp,
      dispatchedAt: timestamp,
    }).where(and(
      eq(pipelineCommandOutbox.id, effect.id),
      eq(pipelineCommandOutbox.status, "pending"),
    )).run();
    return {
      effectId,
      pipelineJobId: job.id,
      status: "dispatched",
    };
  }
}
