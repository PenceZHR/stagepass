import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { changes, projects, stageActions } from "../db/schema";
import type { ContractPhase, PipelineActionContract } from "../services/action-contract-types";

export type ActionContractRepositoryDb = typeof db;
type ActionContractConnection = Pick<ActionContractRepositoryDb, "select" | "insert" | "update">;

export type ActionContractChangeRecord = typeof changes.$inferSelect;
export type ActionContractProjectRecord = typeof projects.$inferSelect;
export type StageActionRecord = typeof stageActions.$inferSelect;

let actionContractRepositoryDbForTest: ActionContractRepositoryDb | null = null;

export function setActionContractRepositoryDbForTest(
  nextDb: ActionContractRepositoryDb,
): () => void {
  const previous = actionContractRepositoryDbForTest;
  actionContractRepositoryDbForTest = nextDb;
  return () => {
    actionContractRepositoryDbForTest = previous;
  };
}

function getActionContractRepositoryDb(): ActionContractRepositoryDb {
  return actionContractRepositoryDbForTest ?? db;
}

export function createActionContractRepository(connection: ActionContractConnection) {
  function findChange(changeId: string): ActionContractChangeRecord | undefined {
    return connection.select().from(changes).where(eq(changes.id, changeId)).get();
  }

  function findProject(projectId: string): ActionContractProjectRecord | undefined {
    return connection.select().from(projects).where(eq(projects.id, projectId)).get();
  }

  function findProjectForChange(changeId: string): ActionContractProjectRecord | null {
    const change = findChange(changeId);
    if (!change) return null;
    return findProject(change.projectId) ?? null;
  }

  function getRepoPathForChange(changeId: string): string | null {
    return findProjectForChange(changeId)?.repoPath ?? null;
  }

  function findStageAction(
    changeId: string,
    phase: ContractPhase,
    actionId: string,
  ): StageActionRecord | undefined {
    return connection
      .select()
      .from(stageActions)
      .where(
        and(
          eq(stageActions.changeId, changeId),
          eq(stageActions.phase, phase),
          eq(stageActions.actionId, actionId),
        ),
      )
      .get();
  }

  function persistStageActionContract(
    changeId: string,
    action: PipelineActionContract,
    computedAt: string,
  ): void {
    const existing = findStageAction(changeId, action.phase, action.actionId);
    const values = {
      changeId,
      phase: action.phase,
      actionId: action.actionId,
      enabled: action.enabled ? 1 : 0,
      reasonCode: action.reasonCode,
      reason: action.reason,
      blockersJson: JSON.stringify(action.blockers),
      gateVersion: Number.parseInt(action.gateVersion, 10) || 0,
      sourceDbHash: action.sourceDbHash,
      requiresIdempotencyKey: action.requiresIdempotencyKey ? 1 : 0,
      computedAt,
    };

    if (existing) {
      connection.update(stageActions).set(values).where(eq(stageActions.id, existing.id)).run();
      return;
    }

    connection
      .insert(stageActions)
      .values({ id: actionAuditId(changeId, action.phase, action.actionId), ...values })
      .run();
  }

  return {
    findChange,
    findProject,
    findProjectForChange,
    getRepoPathForChange,
    findStageAction,
    persistStageActionContract,
  };
}

export type ActionContractRepository = ReturnType<typeof createActionContractRepository>;

export function actionAuditId(changeId: string, phase: ContractPhase, actionId: string): string {
  const digest = createHash("sha256")
    .update(`${changeId}\0${phase}\0${actionId}`)
    .digest("hex")
    .slice(0, 24);
  return `STG-ACT-${digest}`;
}

function currentActionContractRepository(): ActionContractRepository {
  return createActionContractRepository(getActionContractRepositoryDb());
}

export const actionContractRepository: ActionContractRepository = {
  findChange: (...args) => currentActionContractRepository().findChange(...args),
  findProject: (...args) => currentActionContractRepository().findProject(...args),
  findProjectForChange: (...args) =>
    currentActionContractRepository().findProjectForChange(...args),
  getRepoPathForChange: (...args) =>
    currentActionContractRepository().getRepoPathForChange(...args),
  findStageAction: (...args) => currentActionContractRepository().findStageAction(...args),
  persistStageActionContract: (...args) =>
    currentActionContractRepository().persistStageActionContract(...args),
};
