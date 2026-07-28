import { and, desc, eq } from "drizzle-orm";

import { db } from "../db";
import { codexLogicalTurns, codexThreadBindings } from "../db/schema";
import { resolveStageClarificationPolicy } from "../../lib/stage-clarification-policy";
import { changeStageScopeId } from "./codex-desktop-bridge-types";

export type CodexThreadBinding = typeof codexThreadBindings.$inferSelect;

type BindingDb = Pick<typeof db, "select">;

/**
 * The Codex task a stage owns.
 *
 * Stages are keyed by their clarification policy id, so every persisted phase
 * name an alias covers ("intake", "spec_verdict", "generate_plan") resolves to
 * the same stage task rather than opening a new one per internal phase.
 *
 * A change that started before per-stage tasks existed has a single
 * change-wide binding; it stays visible here so those changes can finish.
 */
export function resolveStageBinding(
  changeId: string,
  phase: string,
  database: BindingDb = db,
): CodexThreadBinding | null {
  const policy = resolveStageClarificationPolicy(phase);
  const stageId = policy.id === "generic" ? phase : policy.id;
  const stageBinding = database.select().from(codexThreadBindings).where(and(
    eq(codexThreadBindings.scopeKind, "change_stage"),
    eq(codexThreadBindings.scopeId, changeStageScopeId(changeId, stageId)),
  )).get();
  if (stageBinding) return stageBinding;

  const shared = database.select().from(codexThreadBindings).where(and(
    eq(codexThreadBindings.scopeKind, "change"),
    eq(codexThreadBindings.scopeId, changeId),
  )).get();
  if (!shared) return null;

  // A change-wide task belongs to whichever stage last ran on it. Handing it
  // to every stage is what made a stage that never started look as though it
  // already had a task, leaving no way to start it.
  const lastTurn = database.select().from(codexLogicalTurns)
    .where(eq(codexLogicalTurns.bindingId, shared.bindingId))
    .orderBy(desc(codexLogicalTurns.createdAt), desc(codexLogicalTurns.logicalTurnId))
    .get();
  if (!lastTurn) return null;
  const lastStage = resolveStageClarificationPolicy(lastTurn.phase);
  const lastStageId = lastStage.id === "generic" ? lastTurn.phase : lastStage.id;
  return lastStageId === stageId ? shared : null;
}
