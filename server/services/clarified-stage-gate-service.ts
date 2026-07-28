import { eq } from "drizzle-orm";

import { db } from "../db";
import { changes, stageGates } from "../db/schema";
import { writeClarifiedPrdBaseline } from "./clarified-prd-baseline-service";
import {
  resolveStageClarificationPolicy,
  type StageClarificationId,
} from "../../lib/stage-clarification-policy";
import {
  completeStageRun,
  computeSourceDbHash,
  recomputeStageGate,
  startStageRun,
} from "./stage-authority-service";
import type { PipelinePhase } from "./stage-authority-service";

/**
 * Stages whose gate the clarification loop is allowed to settle by itself,
 * with the gate phase and the change gate state each one implies.
 *
 * PRD is here because its gate is derived from the briefing tables -- the
 * web questionnaire the card loop replaces. A change whose PRD converged
 * through cards has no briefing to lock, so without this it reaches
 * INTAKE_READY with every exit disabled: approving wants a gate snapshot
 * nothing produces, and locking a briefing is only offered before the stage
 * ran.
 *
 * Every other stage keeps deriving its gate from its own evidence (rubrics,
 * reports, review findings). Sealing those here would clear them on the mere
 * fact that questions stopped.
 */
const SEALABLE: Partial<Record<StageClarificationId, {
  gatePhase: PipelinePhase;
  gateState: string;
}>> = {
  prd: { gatePhase: "PRD", gateState: "intake" },
};

export function sealClarifiedStageGate(input: {
  changeId: string;
  phase: string;
  /** The stage's converged reply, recorded as its DB baseline where one exists. */
  document?: string;
}): void {
  const policy = resolveStageClarificationPolicy(input.phase);
  const sealable = policy.id === "generic" ? undefined : SEALABLE[policy.id];
  if (!sealable) return;

  // PRD is DB-first: its baseline tables are what every later stage reads, so
  // the stage records them and lets the PRD authority compute the gate. Sealing
  // a gate of our own here would disagree with the hash Spec recomputes.
  if (policy.id === "prd") {
    writeClarifiedPrdBaseline({
      changeId: input.changeId,
      document: input.document ?? "",
    });
    db.update(changes).set({
      gateState: sealable.gateState,
      updatedAt: new Date().toISOString(),
    }).where(eq(changes.id, input.changeId)).run();
    return;
  }

  const sourceDbHash = computeSourceDbHash({
    changeId: input.changeId,
    phase: sealable.gatePhase,
    rows: [{ source: "clarification_loop", phase: policy.id }],
  });
  const existing = db.select().from(stageGates)
    .where(eq(stageGates.changeId, input.changeId)).all()
    .find((gate) =>
      gate.phase === sealable.gatePhase && gate.sourceDbHash === sourceDbHash);
  if (existing) return;

  const run = startStageRun({
    changeId: input.changeId,
    phase: sealable.gatePhase,
    inputDbHash: sourceDbHash,
    sourceLineage: { source: "clarification_loop", phase: policy.id },
    idempotencyKey: `clarified-stage:${input.changeId}:${sealable.gatePhase}`,
  });
  completeStageRun({
    runId: run.id,
    status: "passed",
    counts: {},
    reportDbHash: sourceDbHash,
  });
  recomputeStageGate({
    changeId: input.changeId,
    phase: sealable.gatePhase,
    status: "pass",
    blockers: [],
    freshness: { source: "clarification_loop" },
    requiredActions: [],
    sourceDbHash,
  });
  db.update(changes).set({
    gateState: sealable.gateState,
    updatedAt: new Date().toISOString(),
  }).where(eq(changes.id, input.changeId)).run();
}
