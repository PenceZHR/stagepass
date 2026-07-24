import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/server/db";
import {
  codexBindingRunLeases,
  codexThreadBindings,
  codexTurnExecutions,
  pipelineCommandReceipts,
  pipelineJobs,
} from "@/server/db/schema";
import { getProductionCodexDesktopBridge } from "@/server/services/codex-desktop-engine";

export interface InterruptTarget {
  bindingId: string;
  threadId: string;
  turnId: string;
  pipelineJobId: string;
}

export interface InterruptCodexDependencies {
  readTarget(
    projectId: string,
    changeId: string,
    now: Date,
  ): InterruptTarget | null;
  interrupt(target: InterruptTarget): Promise<void>;
  record(input: {
    projectId: string;
    changeId: string;
    target: InterruptTarget;
  }): string;
  now(): Date;
}

function defaults(): InterruptCodexDependencies {
  return {
    readTarget(projectId, changeId, now) {
      const binding = db.select().from(codexThreadBindings).where(and(
        eq(codexThreadBindings.scopeKind, "change"),
        eq(codexThreadBindings.scopeId, changeId),
        eq(codexThreadBindings.projectId, projectId),
        eq(codexThreadBindings.changeId, changeId),
        eq(codexThreadBindings.status, "running"),
      )).get();
      if (!binding?.threadId || !binding.lastTurnId) return null;
      const lease = db.select().from(codexBindingRunLeases)
        .where(eq(codexBindingRunLeases.bindingId, binding.bindingId)).get();
      if (!lease || Date.parse(lease.leaseExpiresAt) <= now.getTime()) return null;
      const execution = db.select().from(codexTurnExecutions).where(and(
        eq(codexTurnExecutions.logicalTurnId, lease.logicalTurnId),
        eq(codexTurnExecutions.threadId, binding.threadId),
        eq(codexTurnExecutions.turnId, binding.lastTurnId),
        eq(codexTurnExecutions.status, "running"),
      )).get();
      if (!execution?.pipelineJobId) return null;
      const job = db.select().from(pipelineJobs).where(and(
        eq(pipelineJobs.id, execution.pipelineJobId),
        eq(pipelineJobs.changeId, changeId),
        eq(pipelineJobs.status, "running"),
        eq(pipelineJobs.leaseToken, execution.leaseToken),
      )).get();
      if (!job?.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now.getTime()) {
        return null;
      }
      return {
        bindingId: binding.bindingId,
        threadId: binding.threadId,
        turnId: binding.lastTurnId,
        pipelineJobId: job.id,
      };
    },
    interrupt: async ({ threadId, turnId }) => {
      await (await getProductionCodexDesktopBridge()).interruptTurn({
        threadId,
        turnId,
      });
    },
    record({ changeId, target }) {
      const commandId = `CMD-${randomUUID()}`;
      const now = new Date().toISOString();
      db.insert(pipelineCommandReceipts).values({
        commandId,
        changeId,
        interactionId: null,
        codexThreadId: target.threadId,
        action: "interrupt_turn",
        actorKind: "system",
        actorSurface: "stagepass_web_ops",
        idempotencyKey: `interrupt:${target.threadId}:${target.turnId}`,
        requestHash: createHash("sha256")
          .update(`${changeId}\0${target.threadId}\0${target.turnId}`)
          .digest("hex"),
        status: "completed",
        resultJson: JSON.stringify({
          interrupted: true,
          threadId: target.threadId,
          turnId: target.turnId,
          pipelineJobId: target.pipelineJobId,
        }),
        errorCode: null,
        createdAt: now,
        completedAt: now,
      }).run();
      return commandId;
    },
    now: () => new Date(),
  };
}

export async function handleInterruptCodex(
  projectId: string,
  changeId: string,
  dependencies: InterruptCodexDependencies = defaults(),
): Promise<NextResponse> {
  const target = dependencies.readTarget(projectId, changeId, dependencies.now());
  if (!target) {
    return NextResponse.json({ error: "active_codex_turn_not_found" }, { status: 409 });
  }
  try {
    await dependencies.interrupt(target);
    const commandId = dependencies.record({ projectId, changeId, target });
    return NextResponse.json({
      interrupted: true,
      commandId,
      threadId: target.threadId,
      turnId: target.turnId,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "codex_interrupt_failed",
        message: error instanceof Error ? error.message : "Interrupt failed",
      },
      { status: 503 },
    );
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id, changeId } = await params;
  return handleInterruptCodex(id, changeId);
}
