import { eq } from "drizzle-orm";
import fs from "fs";

import { db } from "../db";
import { changes, projects, runs } from "../db/schema";
import {
  isUnsafePlanPath,
  matchesAnyPattern,
  patternsOverlap,
} from "./plan-glob-policy-service";
import {
  assertSafeWriteTarget,
  critiquePath,
  planMarkdownPath,
  planPath,
  readJson,
  readText,
  reportPath,
  writeFileNoFollow,
} from "./plan-safe-file-service";
import {
  currentSourceHashes,
  formatReport,
  readReportSourceHashes,
  sameHashes,
} from "./plan-report-service";
import {
  isBlockingP0Risk,
  isBlockingP1Risk,
  latestPlanSnapshot,
  planFromDbSnapshot,
  persistPlanSnapshot,
  renderPlanMarkdownMirror,
  writePlanMirrorsFromDb,
} from "./plan-snapshot-service";
import { getActions } from "./action-contract-service";
import { recordPostCommitSideEffectFailure } from "./pipeline-run-ledger-service";
import { getStageAuthority } from "./stage-authority-service";
import type { PlanGate, PlanJson, PlanRisk, PlanSandboxState, PlanStep } from "./plan-types";

export type {
  PlanGate,
  PlanJson,
  PlanRisk,
  PlanRiskSeverity,
  PlanRiskStatus,
  PlanSandboxState,
  PlanStep,
} from "./plan-types";

export { assertPlanCanApprove, approvePlanSnapshot } from "./plan-approval-service";

type PlanCritiqueFile = {
  risks?: unknown[];
};

type PlanReadResult = {
  plan: PlanJson | null;
  invalid: boolean;
};

type RiskReadResult = {
  risks: PlanRisk[];
  invalid: boolean;
};

const RISK_CATEGORIES = new Set<PlanRisk["category"]>([
  "scope",
  "ordering",
  "granularity",
  "missing_test",
  "migration",
  "security",
  "dependency",
  "rollback",
  "unknown",
]);

function getChangeAndProject(changeId: string) {
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);

  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  return { change, project };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeTaskStatus(value: unknown): PlanStep["status"] {
  if (value === "blocked" || value === "done") return value;
  return "pending";
}

function addMissing(missingFields: string[], field: string): void {
  if (!missingFields.includes(field)) {
    missingFields.push(field);
  }
}

function isContinuousStepSequence(steps: PlanStep[]): boolean {
  return steps.every((step, index) => step.step === index + 1);
}

function normalizePlan(value: unknown): PlanJson | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as PlanJson;
  const expectedFiles = asStringArray(raw.expectedFiles);
  const legacyAllowedFiles = asStringArray(raw.allowedFiles);
  return {
    planName: typeof raw.planName === "string" ? raw.planName : undefined,
    expectedFiles: expectedFiles.length > 0 ? expectedFiles : legacyAllowedFiles,
    allowedFiles: legacyAllowedFiles,
    forbiddenFiles: asStringArray(raw.forbiddenFiles),
    implementationSteps: Array.isArray(raw.implementationSteps)
      ? raw.implementationSteps
          .filter((step): step is PlanStep => {
            return (
              !!step &&
              typeof step === "object" &&
              typeof step.step === "number" &&
              typeof step.description === "string"
            );
          })
          .map((step) => ({
            step: step.step,
            description: step.description,
            file: typeof step.file === "string" ? step.file : undefined,
            status: normalizeTaskStatus(step.status),
          }))
      : [],
    testPlan: asStringArray(raw.testPlan),
    validationCommands: asStringArray(raw.validationCommands),
    risks: asStringArray(raw.risks),
  };
}

function normalizeRisk(value: unknown, index: number): PlanRisk {
  const raw = value && typeof value === "object" ? (value as Partial<PlanRisk>) : {};
  const severity = raw.severity === "P0" || raw.severity === "P1" || raw.severity === "P2"
    ? raw.severity
    : "P2";
  const status = raw.status === "resolved" || raw.status === "waived" ? raw.status : "open";
  const category = raw.category && RISK_CATEGORIES.has(raw.category) ? raw.category : "unknown";
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `plan-risk-${index + 1}`,
    severity,
    category,
    title: typeof raw.title === "string" ? raw.title : "Untitled plan risk",
    evidence: typeof raw.evidence === "string" ? raw.evidence : "",
    requiredPlanChange:
      typeof raw.requiredPlanChange === "string" ? raw.requiredPlanChange : null,
    affectedStepNumbers: Array.isArray(raw.affectedStepNumbers)
      ? raw.affectedStepNumbers.filter((step): step is number => Number.isInteger(step))
      : [],
    status,
    waiverReason:
      typeof raw.waiverReason === "string" && raw.waiverReason.trim()
        ? raw.waiverReason
        : null,
  };
}

function readPlan(repoPath: string, changeId: string): PlanReadResult {
  const parsed = readJson<unknown>(planPath(repoPath, changeId));
  return {
    plan: normalizePlan(parsed.value),
    invalid: parsed.invalid,
  };
}

function readRisks(repoPath: string, changeId: string): RiskReadResult {
  const parsed = readJson<PlanCritiqueFile>(critiquePath(repoPath, changeId));
  if (!parsed.value?.risks || !Array.isArray(parsed.value.risks)) {
    return { risks: [], invalid: parsed.invalid };
  }
  return {
    risks: parsed.value.risks.map(normalizeRisk),
    invalid: parsed.invalid,
  };
}

function structuralMissingFields(
  plan: PlanJson | null,
  planJsonExists: boolean,
  planMarkdownExists: boolean,
  extraMissingFields: string[] = []
): string[] {
  const missingFields: string[] = [];
  for (const field of extraMissingFields) {
    addMissing(missingFields, field);
  }
  if (!planJsonExists || !plan) {
    addMissing(missingFields, "plan.json");
  }
  if (!planMarkdownExists) {
    addMissing(missingFields, "plan.md");
  }
  if (!plan) {
    return missingFields;
  }

  const expectedFiles = plan.expectedFiles ?? [];
  const forbiddenFiles = plan.forbiddenFiles ?? [];
  const steps = plan.implementationSteps ?? [];
  const validationCommands = plan.validationCommands ?? [];
  const planPaths = [
    ...expectedFiles,
    ...forbiddenFiles,
    ...steps.flatMap((step) => (step.file ? [step.file] : [])),
  ];

  if (!plan.planName?.trim()) {
    addMissing(missingFields, "planName");
  }
  if (expectedFiles.length === 0) {
    addMissing(missingFields, "expectedFiles");
  }
  if (planPaths.some(isUnsafePlanPath)) {
    addMissing(missingFields, "unsafePath");
  }
  if (validationCommands.filter((command) => command.trim()).length === 0) {
    addMissing(missingFields, "validationCommands");
  }
  if (steps.length === 0) {
    addMissing(missingFields, "implementationSteps");
  } else if (!isContinuousStepSequence(steps)) {
    addMissing(missingFields, "step_sequence");
  }

  for (const step of steps) {
    if (step.file && !matchesAnyPattern(step.file, expectedFiles)) {
      addMissing(missingFields, "expectedFiles");
    }
  }

  for (const expected of expectedFiles) {
    for (const forbidden of forbiddenFiles) {
      if (patternsOverlap(expected, forbidden)) {
        addMissing(missingFields, "forbiddenFiles");
      }
    }
  }

  return missingFields;
}

function computeGate(args: {
  plan: PlanJson | null;
  planJsonExists: boolean;
  planMarkdownExists: boolean;
  risks: PlanRisk[];
  reportFresh: boolean;
  extraMissingFields?: string[];
}): PlanGate {
  const missingFields = structuralMissingFields(
    args.plan,
    args.planJsonExists,
    args.planMarkdownExists,
    args.extraMissingFields ?? []
  );
  const riskBlockingP0 = args.risks.filter(isBlockingP0Risk).length;
  const blockingP1 = args.risks.filter(isBlockingP1Risk).length;
  const blockingP0 = riskBlockingP0 + missingFields.length;
  const nonBlockingP2 = args.risks.filter(
    (risk) => risk.severity === "P2" && risk.status === "open"
  ).length;
  const stale = !args.reportFresh;

  return {
    canApprove: blockingP0 === 0 && blockingP1 === 0 && missingFields.length === 0 && !stale,
    blockingP0,
    blockingP1,
    nonBlockingP2,
    missingFields,
    stale,
  };
}

function statusForState(args: {
  changeStatus: string;
  planJsonExists: boolean;
  planMarkdownExists: boolean;
  reportFresh: boolean;
  gate: PlanGate;
}): PlanSandboxState["status"] {
  if (args.changeStatus === "PLAN_APPROVED") return "approved";
  if (!args.planJsonExists && !args.planMarkdownExists) return "not_started";
  if (args.reportFresh) {
    return args.gate.canApprove ? "report_ready" : "blocked";
  }
  return "plan_ready";
}

function buildState(changeId: string): PlanSandboxState {
  const { change, project } = getChangeAndProject(changeId);
  const dbState = buildDbSnapshotState(changeId, change.status);
  if (dbState) {
    return dbState;
  }

  const jsonPath = planPath(project.repoPath, changeId);
  const markdownPath = planMarkdownPath(project.repoPath, changeId);
  const currentReportPath = reportPath(project.repoPath, changeId);
  const planJsonExists = fs.existsSync(jsonPath);
  const planMarkdownExists = fs.existsSync(markdownPath);
  const planResult = readPlan(project.repoPath, changeId);
  const planMarkdown = readText(markdownPath);
  const riskResult = readRisks(project.repoPath, changeId);
  const hashes = currentSourceHashes(project.repoPath, changeId);
  const reportFresh = sameHashes(readReportSourceHashes(currentReportPath), hashes);
  const extraMissingFields = [
    planResult.invalid ? "invalid_plan_json" : null,
    riskResult.invalid ? "invalid_plan_critique" : null,
  ].filter((field): field is string => field !== null);
  const gate = computeGate({
    plan: planResult.plan,
    planJsonExists,
    planMarkdownExists,
    risks: riskResult.risks,
    reportFresh,
    extraMissingFields,
  });
  const displayPlan = planResult.plan
    ? {
        ...planResult.plan,
        planName: planResult.plan.planName?.trim() || `${changeId} Plan`,
      }
    : null;

  return {
    changeId,
    status: statusForState({
      changeStatus: change.status,
      planJsonExists,
      planMarkdownExists,
      reportFresh,
      gate,
    }),
    plan: displayPlan,
    planMarkdown,
    risks: riskResult.risks,
    gate,
    reportPath: fs.existsSync(currentReportPath) ? currentReportPath : null,
    reportFresh,
  };
}

function buildDbSnapshotState(
  changeId: string,
  changeStatus: string,
): PlanSandboxState | null {
  const snapshot = latestPlanSnapshot(changeId);
  if (!snapshot) return null;
  if (!snapshotComesFromGeneratedPlan(changeId, snapshot.createdAt)) return null;

  const authority = getStageAuthority(changeId, "Plan");
  const plan = planFromDbSnapshot(snapshot.id);
  const report = authority.latestReport;
  const gateRecord = authority.latestGate;
  const blockers = readJsonArray(gateRecord?.blockersJson);
  const missingFields = blockers
    .map((blocker) => {
      const item = blocker as { id?: unknown; severity?: unknown };
      return item.severity === "P0" && typeof item.id === "string" ? item.id : null;
    })
    .filter((field): field is string => field !== null);
  const blockingP0 = blockers.filter((blocker) => (blocker as { severity?: unknown }).severity === "P0").length;
  const blockingP1 = blockers.filter((blocker) => (blocker as { severity?: unknown }).severity === "P1").length;
  const counts = readJsonRecord(report?.countsJson);
  const nonBlockingP2 =
    typeof counts.nonBlockingP2 === "number" ? counts.nonBlockingP2 : 0;
  const reportFresh = report?.isFresh === 1 && Boolean(report.reportDbHash);
  const gate: PlanGate = {
    canApprove: gateRecord?.status === "passed" && reportFresh,
    blockingP0,
    blockingP1,
    nonBlockingP2,
    missingFields,
    stale: !reportFresh,
  };

  return {
    changeId,
    status: statusForState({
      changeStatus,
      planJsonExists: true,
      planMarkdownExists: true,
      reportFresh,
      gate,
    }),
    plan,
    planMarkdown: renderPlanMarkdownMirror(plan),
    risks: [],
    gate,
    reportPath: null,
    reportFresh,
  };
}

function snapshotComesFromGeneratedPlan(changeId: string, snapshotCreatedAt: string): boolean {
  const latestPlanRun = db
    .select()
    .from(runs)
    .where(eq(runs.changeId, changeId))
    .all()
    .filter((run) => run.phase === "generate_plan" && run.status === "completed")
    .sort((left, right) => {
      const rightTime = Date.parse(right.endedAt ?? right.startedAt ?? "");
      const leftTime = Date.parse(left.endedAt ?? left.startedAt ?? "");
      return rightTime - leftTime || right.id.localeCompare(left.id);
    })[0];
  if (!latestPlanRun) return false;

  const runTime = Date.parse(latestPlanRun.endedAt ?? latestPlanRun.startedAt ?? "");
  const snapshotTime = Date.parse(snapshotCreatedAt);
  if (!Number.isFinite(runTime) || !Number.isFinite(snapshotTime)) return false;
  return Math.abs(snapshotTime - runTime) < 5_000 || snapshotTime <= runTime;
}

function readJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getPlanSandboxState(changeId: string): PlanSandboxState {
  return buildState(changeId);
}

export function regeneratePlanReport(changeId: string): PlanSandboxState {
  const { project } = getChangeAndProject(changeId);
  const destination = reportPath(project.repoPath, changeId);

  const staleState = buildState(changeId);
  const rawPlanResult = readPlan(project.repoPath, changeId);
  const planJsonExists = fs.existsSync(planPath(project.repoPath, changeId));
  const planMarkdownExists = fs.existsSync(planMarkdownPath(project.repoPath, changeId));
  const freshGate = computeGate({
    plan: rawPlanResult.plan,
    planJsonExists,
    planMarkdownExists,
    risks: staleState.risks,
    reportFresh: true,
    extraMissingFields: [
      ...(rawPlanResult.invalid ? ["invalid_plan_json"] : []),
      ...staleState.gate.missingFields.filter((field) => field === "invalid_plan_critique"),
    ],
  });
  if (rawPlanResult.plan) {
    const snapshotId = persistPlanSnapshot({
      changeId,
      repoPath: project.repoPath,
      plan: rawPlanResult.plan,
      risks: staleState.risks,
      gate: freshGate,
      reportFresh: true,
    });
    if (freshGate.canApprove) {
      writePlanMirrorsFromDb(project.repoPath, changeId, snapshotId);
    }
  }
  const hashes = currentSourceHashes(project.repoPath, changeId);
  const stateForReport: PlanSandboxState = {
    ...staleState,
    plan: rawPlanResult.plan,
    planMarkdown: rawPlanResult.plan ? renderPlanMarkdownMirror(rawPlanResult.plan) : staleState.planMarkdown,
    gate: freshGate,
    reportFresh: true,
    reportPath: destination,
  };

  writeFileNoFollow(project.repoPath, changeId, destination, formatReport(changeId, stateForReport, hashes));
  refreshPlanActionsBestEffort({ changeId });
  return buildState(changeId);
}

async function refreshPlanActionsBestEffort(input: {
  changeId: string;
  runId?: string;
}): Promise<void> {
  try {
    getActions(input.changeId);
  } catch (error) {
    if (!input.runId) return;
    await recordPostCommitSideEffectFailure({
      changeId: input.changeId,
      runId: input.runId,
      phase: "Plan",
      sideEffect: "plan_action_contract_refresh",
      message: "Plan post-commit side-effect failed: action contract refresh",
      error,
    });
  }
}

/**
 * The `risks: []` below is the STRUCTURED critique risk set (PlanRisk[]), which
 * is genuinely empty at generate_plan time -- plan-critique.json does not exist
 * yet. It is not a dropped field, and it must stay empty: structured risks carry
 * a severity that blocks the Plan gate, and the model's RISK lines carry none.
 *
 * The model's own risks travel as `input.plan.risks` (string[]) and are persisted
 * by persistPlanSnapshot into plan_snapshots.model_risks_json, so they survive the
 * DB round-trip and reach plan.json / plan.md / the UI without ever being guessed
 * into a severity.
 */
export function persistGeneratedPlanSnapshot(input: {
  changeId: string;
  repoPath: string;
  plan: PlanJson;
}): string {
  const gate = computeGate({
    plan: input.plan,
    planJsonExists: true,
    planMarkdownExists: true,
    risks: [],
    reportFresh: true,
  });
  return persistPlanSnapshot({
    changeId: input.changeId,
    repoPath: input.repoPath,
    plan: input.plan,
    risks: [],
    gate,
    reportFresh: true,
  });
}

export async function writeGeneratedPlanArtifactsFromDbBestEffort(input: {
  changeId: string;
  runId: string;
  snapshotId: string;
}): Promise<void> {
  const { project } = getChangeAndProject(input.changeId);
  let mirrorsWritten = false;

  try {
    writePlanMirrorsFromDb(project.repoPath, input.changeId, input.snapshotId);
    mirrorsWritten = true;
  } catch (error) {
    await recordPostCommitSideEffectFailure({
      changeId: input.changeId,
      runId: input.runId,
      phase: "Plan",
      sideEffect: "plan_mirror_write",
      message: "Plan post-commit side-effect failed: DB mirror write",
      error,
      rawJson: {
        snapshotId: input.snapshotId,
      },
    });
  }

  if (!mirrorsWritten) {
    return;
  }

  try {
    const destination = reportPath(project.repoPath, input.changeId);
    const hashes = currentSourceHashes(project.repoPath, input.changeId);
    const plan = planFromDbSnapshot(input.snapshotId);
    const freshGate = computeGate({
      plan,
      planJsonExists: true,
      planMarkdownExists: true,
      risks: [],
      reportFresh: true,
    });
    const stateForReport: PlanSandboxState = {
      changeId: input.changeId,
      status: freshGate.canApprove ? "report_ready" : "blocked",
      plan,
      planMarkdown: renderPlanMarkdownMirror(plan),
      risks: [],
      gate: freshGate,
      reportFresh: true,
      reportPath: destination,
    };
    writeFileNoFollow(
      project.repoPath,
      input.changeId,
      destination,
      formatReport(input.changeId, stateForReport, hashes)
    );
  } catch (error) {
    await recordPostCommitSideEffectFailure({
      changeId: input.changeId,
      runId: input.runId,
      phase: "Plan",
      sideEffect: "plan_report_write",
      message: "Plan post-commit side-effect failed: report write",
      error,
      rawJson: {
        snapshotId: input.snapshotId,
      },
    });
  }

  await refreshPlanActionsBestEffort({ changeId: input.changeId, runId: input.runId });
}

export function waivePlanRisk(changeId: string, riskId: string, reason: string): PlanSandboxState {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new Error("Waiver reason is required");
  }

  const { project } = getChangeAndProject(changeId);
  const filePath = critiquePath(project.repoPath, changeId);
  assertSafeWriteTarget(project.repoPath, changeId, filePath);
  const parsed = readJson<PlanCritiqueFile>(filePath);
  const risks = parsed.value?.risks?.map(normalizeRisk) ?? [];
  const risk = risks.find((item) => item.id === riskId);
  if (!risk) {
    throw new Error(`Plan risk not found: ${riskId}`);
  }
  if (risk.severity !== "P1") {
    throw new Error("Only P1 plan risks can be waived");
  }

  const updatedRisks = risks.map((item) =>
    item.id === riskId
      ? {
          ...item,
          status: "waived" as const,
          waiverReason: trimmedReason,
        }
      : item
  );
  writeFileNoFollow(
    project.repoPath,
    changeId,
    filePath,
    `${JSON.stringify({ risks: updatedRisks }, null, 2)}\n`
  );

  return regeneratePlanReport(changeId);
}
