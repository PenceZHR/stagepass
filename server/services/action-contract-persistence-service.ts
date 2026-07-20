import {
  actionAuditId as repositoryActionAuditId,
  createActionContractRepository,
} from "../repositories/action-contract-repository";
import type { ActionContractDb, ContractPhase, PipelineActionContract } from "./action-contract-types";

export function actionAuditId(changeId: string, phase: ContractPhase, actionId: string): string {
  return repositoryActionAuditId(changeId, phase, actionId);
}

export function persistActionContractRow(
  db: ActionContractDb,
  changeId: string,
  action: PipelineActionContract,
  computedAt: string,
): void {
  createActionContractRepository(db).persistStageActionContract(changeId, action, computedAt);
}
