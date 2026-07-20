import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  testplanCoverageItems,
  testplanSnapshots,
} from "../db/schema";
import type { BuildRunFile } from "./build-workspace-service";
import {
  getBuildDesignInputs,
  getReviewDesignInputs,
  type ApiSnapshot,
  type TechSpecSnapshot,
} from "./techspec-api-snapshot-service";
import { getRequiredValidationCommands } from "./testplan-snapshot-service";
import { loadDbPlanScope } from "./stage-guard-service";

export function renderDbPlanScopeForPrompt(changeId: string): string {
  const scope = loadDbPlanScope(changeId);
  return [
    "## DB Plan Scope (authoritative)",
    "",
    `sourceDbHash: ${scope.sourceDbHash ?? "missing"}`,
    `sourceSnapshotId: ${scope.sourceSnapshotId ?? "missing"}`,
    "",
    "Expected files:",
    ...(scope.expectedFiles?.length ? scope.expectedFiles.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Forbidden files:",
    ...(scope.forbiddenFiles?.length ? scope.forbiddenFiles.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Validation commands:",
    ...(scope.validationCommands?.length
      ? scope.validationCommands.map((command) => `- ${command}`)
      : ["- none"]),
    "",
    "Use this DB Plan Scope as the only scope authority. plan.json and plan.md are generated mirrors for context and must not override this section.",
  ].join("\n");
}

export function designSourceDbHash(input: {
  techSpec: Pick<TechSpecSnapshot, "contentDbHash">;
  api: Pick<ApiSnapshot, "contractDbHash">;
}): string {
  return `${input.techSpec.contentDbHash}:${input.api.contractDbHash}`;
}

export function renderDesignInputsForPrompt(input: {
  techSpec: TechSpecSnapshot;
  api: ApiSnapshot;
}): string {
  return [
    "## DB Design Snapshot Authority",
    "DB TechSpec Snapshot Authority",
    "DB API Snapshot Authority",
    "",
    `TechSpec contentDbHash: ${input.techSpec.contentDbHash}`,
    `API contractDbHash: ${input.api.contractDbHash}`,
    "",
    "### TechSpec sections",
    "```json",
    JSON.stringify(input.techSpec.content, null, 2),
    "```",
    "",
    "### API contract sections",
    "```json",
    JSON.stringify(input.api.contract, null, 2),
    "```",
  ].join("\n");
}

export function latestTestPlanSnapshotForBuild(changeId: string): typeof testplanSnapshots.$inferSelect | null {
  const rows = db
    .select()
    .from(testplanSnapshots)
    .where(eq(testplanSnapshots.changeId, changeId))
    .all()
    .filter((snapshot) => snapshot.status === "approved" || snapshot.approvalState === "approved");
  return rows.sort((left, right) => {
    const byApproved = (right.approvedAt ?? "").localeCompare(left.approvedAt ?? "");
    if (byApproved !== 0) return byApproved;
    return right.createdAt.localeCompare(left.createdAt);
  })[0] ?? null;
}

export function renderDbTestPlanForPrompt(changeId: string): string {
  const snapshot = latestTestPlanSnapshotForBuild(changeId);
  if (!snapshot) {
    return [
      "## DB TestPlan Snapshot Authority",
      "",
      "status: missing",
      "Required commands:",
      "- none",
    ].join("\n");
  }
  const coverage = db
    .select()
    .from(testplanCoverageItems)
    .where(eq(testplanCoverageItems.testplanSnapshotId, snapshot.id))
    .all()
    .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
  const commands = getRequiredValidationCommands(changeId);
  return [
    "## DB TestPlan Snapshot Authority",
    "",
    `snapshotId: ${snapshot.id}`,
    `snapshotDbHash: ${snapshot.snapshotDbHash}`,
    `testIntent: ${snapshot.testIntent}`,
    "",
    "Coverage items:",
    ...(coverage.length
      ? coverage.map((item) => `- ${item.itemKey}: ${item.title} [${item.priority}]`)
      : ["- none"]),
    "",
    "Required commands:",
    ...(commands.length ? commands.map((command) => `- ${command}`) : ["- none"]),
  ].join("\n");
}

export function renderBuildGitFactsForPrompt(buildRun: BuildRunFile): string {
  return [
    "## Git facts",
    "",
    `baseHeadSha: ${buildRun.baseHeadSha ?? buildRun.baseCommit ?? "missing"}`,
    `baseCommit: ${buildRun.baseCommit ?? "missing"}`,
    `workspacePath: ${buildRun.workspacePath}`,
    `branchName: ${buildRun.branchName}`,
  ].join("\n");
}

export function loadBuildDesignInputs(changeId: string) {
  const designInputs = getBuildDesignInputs(changeId);
  return {
    designInputs,
    sourceDbHash: designSourceDbHash(designInputs),
  };
}

export function loadReviewDesignInputs(changeId: string) {
  const designInputs = getReviewDesignInputs(changeId);
  return {
    designInputs,
    sourceDbHash: designSourceDbHash(designInputs),
  };
}
