import crypto from "crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

import { db } from "../db";
import {
  planRisks,
  planSnapshots,
  planSteps,
  requiredValidationCommands,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
} from "../db/schema";
import { computeNextGateVersion } from "../repositories/stage-authority-repository";
import { normalizeRepoPath } from "./plan-glob-policy-service";
import {
  changeDir,
  planMarkdownPath,
  planPath,
  writeFileNoFollow,
} from "./plan-safe-file-service";
import {
  computeSourceDbHash,
} from "./stage-authority-service";
import type { PlanGate, PlanJson, PlanRisk, PlanStep } from "./plan-types";

const PLAN_SCHEMA_VERSION = "plan-snapshot-v1";

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortForStableJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function nextRandomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sha256File(filePath: string): string {
  if (!fs.existsSync(filePath)) return "missing";
  return sha256Text(fs.readFileSync(filePath, "utf-8"));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeTaskStatus(value: unknown): PlanStep["status"] {
  if (value === "blocked" || value === "done") return value;
  return "pending";
}

export function isBlockingP0Risk(risk: PlanRisk): boolean {
  return risk.severity === "P0" && risk.status !== "resolved";
}

export function isBlockingP1Risk(risk: PlanRisk): boolean {
  if (risk.severity !== "P1") return false;
  if (risk.status === "resolved") return false;
  return risk.status !== "waived" || !risk.waiverReason;
}

export function latestPlanSnapshot(changeId: string) {
  return db
    .select()
    .from(planSnapshots)
    .where(eq(planSnapshots.changeId, changeId))
    .orderBy(desc(planSnapshots.createdAt), desc(planSnapshots.id))
    .get();
}

export function latestApprovedPlanSnapshot(changeId: string) {
  return db
    .select()
    .from(planSnapshots)
    .where(and(eq(planSnapshots.changeId, changeId), eq(planSnapshots.status, "approved")))
    .orderBy(desc(planSnapshots.approvedAt), desc(planSnapshots.createdAt), desc(planSnapshots.id))
    .get();
}

function planRowsForHash(args: {
  changeId: string;
  plan: PlanJson;
  risks: PlanRisk[];
}): unknown[] {
  return [
    {
      table: "plan_snapshots",
      changeId: args.changeId,
      schemaVersion: PLAN_SCHEMA_VERSION,
      planName: args.plan.planName ?? null,
      expectedFiles: args.plan.expectedFiles ?? [],
      forbiddenFiles: args.plan.forbiddenFiles ?? [],
      validationCommands: args.plan.validationCommands ?? [],
      steps: args.plan.implementationSteps ?? [],
      // `risks` is the structured critique risk set; `modelRisks`/`testPlan` are
      // the model's own prose. All three feed the hash so a plan that differs
      // only in test plan or model risks is never mistaken for an unchanged
      // snapshot and silently reused.
      testPlan: args.plan.testPlan ?? [],
      modelRisks: args.plan.risks ?? [],
      risks: args.risks,
    },
  ];
}

function sourceSpecHashForPlan(repoPath: string, changeId: string): string {
  const candidatePaths = [
    path.join(changeDir(repoPath, changeId), "tech-spec-delta.md"),
    path.join(changeDir(repoPath, changeId), "prd-delta.md"),
    path.join(repoPath, ".ship", "baseline", "prd.md"),
  ];
  return sha256Text(
    stableJson(
      candidatePaths.map((filePath) => ({
        path: normalizeRepoPath(path.relative(repoPath, filePath)),
        hash: sha256File(filePath),
      }))
    )
  );
}

function nextPlanSnapshotId(): string {
  return nextRandomId("PLAN-SNAP");
}

function nextStageRunId(): string {
  return `STG-RUN-${crypto.randomUUID()}`;
}

function nextStageReportId(): string {
  return nextRandomId("STG-RPT");
}

function nextStageGateId(): string {
  return nextRandomId("STG-GATE");
}

function nextStageStateId(): string {
  return nextRandomId("STG-STATE");
}

function canonicalPlan(plan: PlanJson): PlanJson {
  return {
    planName: plan.planName,
    expectedFiles: plan.expectedFiles ?? [],
    forbiddenFiles: plan.forbiddenFiles ?? [],
    implementationSteps: plan.implementationSteps ?? [],
    testPlan: plan.testPlan ?? [],
    validationCommands: plan.validationCommands ?? [],
    risks: plan.risks ?? [],
  };
}

export function renderPlanJsonMirror(plan: PlanJson): string {
  return `${JSON.stringify(canonicalPlan(plan), null, 2)}\n`;
}

export function renderPlanMarkdownMirror(plan: PlanJson): string {
  const planTitle = plan.planName?.trim() || "Implementation Plan";
  const lines: string[] = [`# ${planTitle}`, ""];
  const steps = plan.implementationSteps ?? [];
  if (steps.length > 0) {
    lines.push("## Steps", "");
    for (const step of steps) {
      lines.push(`### Step ${step.step}${step.file ? ` - \`${step.file}\`` : ""}`);
      lines.push("");
      lines.push(`Status: ${step.status ?? "pending"}`);
      lines.push("");
      lines.push(step.description);
      lines.push("");
    }
  }

  const expectedFiles = plan.expectedFiles ?? [];
  if (expectedFiles.length > 0) {
    lines.push("## Expected Files", "");
    for (const file of expectedFiles) lines.push(`- \`${file}\``);
    lines.push("");
  }

  const forbiddenFiles = plan.forbiddenFiles ?? [];
  if (forbiddenFiles.length > 0) {
    lines.push("## Forbidden Files", "");
    for (const file of forbiddenFiles) lines.push(`- \`${file}\``);
    lines.push("");
  }

  const testPlan = plan.testPlan ?? [];
  if (testPlan.length > 0) {
    lines.push("## Test Plan", "");
    for (const item of testPlan) lines.push(`- ${item}`);
    lines.push("");
  }

  const validationCommands = plan.validationCommands ?? [];
  if (validationCommands.length > 0) {
    lines.push("## Validation Commands", "", "```bash");
    for (const command of validationCommands) lines.push(command);
    lines.push("```", "");
  }

  const risks = plan.risks ?? [];
  if (risks.length > 0) {
    lines.push("## Risks", "");
    for (const item of risks) lines.push(`- ${item}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function planFromDbSnapshot(snapshotId: string): PlanJson {
  const snapshot = db.select().from(planSnapshots).where(eq(planSnapshots.id, snapshotId)).get();
  if (!snapshot) {
    throw new Error(`Plan snapshot not found: ${snapshotId}`);
  }
  const steps = db
    .select()
    .from(planSteps)
    .where(eq(planSteps.planSnapshotId, snapshotId))
    .orderBy(asc(planSteps.stepNo), asc(planSteps.id))
    .all()
    .map((step) => {
      const expectedFiles = asStringArray(JSON.parse(step.expectedFilesJson ?? "[]"));
      return {
        step: step.stepNo,
        description: step.description ?? step.title ?? "",
        file: expectedFiles[0],
        status: normalizeTaskStatus(step.status),
      };
    });
  const validationCommands = db
    .select()
    .from(requiredValidationCommands)
    .where(eq(requiredValidationCommands.sourceSnapshotId, snapshotId))
    .orderBy(asc(requiredValidationCommands.commandOrder), asc(requiredValidationCommands.id))
    .all()
    .map((command) => command.command);

  return {
    planName: snapshot.planName ?? `${snapshot.changeId} DB Plan Snapshot`,
    expectedFiles: asStringArray(JSON.parse(snapshot.expectedFilesJson ?? "[]")),
    forbiddenFiles: asStringArray(JSON.parse(snapshot.forbiddenFilesJson ?? "[]")),
    implementationSteps: steps,
    // testPlan and risks are the model's own prose and round-trip through their
    // own columns. testPlan must never be aliased to validationCommands: that
    // reads as "present" to every emptiness check while carrying the wrong
    // content, which is how the model's test plan went missing unnoticed.
    testPlan: asStringArray(JSON.parse(snapshot.testPlanJson ?? "[]")),
    validationCommands,
    risks: asStringArray(JSON.parse(snapshot.modelRisksJson ?? "[]")),
  };
}

export function writePlanMirrorsFromDb(repoPath: string, changeId: string, snapshotId: string): void {
  const plan = planFromDbSnapshot(snapshotId);
  writeFileNoFollow(repoPath, changeId, planPath(repoPath, changeId), renderPlanJsonMirror(plan));
  writeFileNoFollow(
    repoPath,
    changeId,
    planMarkdownPath(repoPath, changeId),
    renderPlanMarkdownMirror(plan)
  );
}

export function persistPlanSnapshot(input: {
  changeId: string;
  repoPath: string;
  plan: PlanJson;
  risks: PlanRisk[];
  gate: PlanGate;
  reportFresh: boolean;
}): string {
  const canonical = canonicalPlan(input.plan);
  const snapshotDbHash = computeSourceDbHash({
    changeId: input.changeId,
    phase: "Plan",
    rows: planRowsForHash({ changeId: input.changeId, plan: canonical, risks: input.risks }),
  });
  const existing = latestPlanSnapshot(input.changeId);
  const reusedSnapshotId =
    existing?.snapshotDbHash === snapshotDbHash && existing.status !== "approved"
      ? existing.id
      : null;

  const now = new Date().toISOString();
  const snapshotId = reusedSnapshotId ?? nextPlanSnapshotId();
  const stageRunId = nextStageRunId();
  const stageReportId = nextStageReportId();
  const stageGateId = nextStageGateId();
  db.transaction((tx) => {
    const existingStageRuns = tx
      .select()
      .from(stageRuns)
      .where(and(eq(stageRuns.changeId, input.changeId), eq(stageRuns.phase, "Plan")))
      .all();
    const stageAttemptNo =
      existingStageRuns.reduce((max, existingRun) => Math.max(max, existingRun.attemptNo), 0) + 1;

    if (!reusedSnapshotId) {
      tx.insert(planSnapshots).values({
        id: snapshotId,
        changeId: input.changeId,
        status: input.gate.canApprove ? "ready" : "blocked",
        planName: canonical.planName ?? null,
        sourceSpecHash: sourceSpecHashForPlan(input.repoPath, input.changeId),
        expectedFilesJson: JSON.stringify(canonical.expectedFiles ?? []),
        forbiddenFilesJson: JSON.stringify(canonical.forbiddenFiles ?? []),
        testPlanJson: JSON.stringify(canonical.testPlan ?? []),
        modelRisksJson: JSON.stringify(canonical.risks ?? []),
        validationPolicyHash: sha256Text(stableJson(canonical.validationCommands ?? [])),
        approvedAt: null,
        approvalDecisionId: null,
        snapshotDbHash,
        createdAt: now,
      }).run();

      for (const step of canonical.implementationSteps ?? []) {
        tx.insert(planSteps).values({
          id: nextRandomId("PLAN-STEP"),
          planSnapshotId: snapshotId,
          stepNo: step.step,
          title: step.description.split(/\r?\n/, 1)[0]?.slice(0, 160) ?? null,
          description: step.description,
          expectedFilesJson: JSON.stringify(step.file ? [step.file] : []),
          status: step.status ?? "pending",
          createdAt: now,
        }).run();
      }

      for (const risk of input.risks) {
        tx.insert(planRisks).values({
          id: nextRandomId("PLAN-RISK"),
          planSnapshotId: snapshotId,
          severity: risk.severity,
          category: risk.category,
          title: risk.title,
          evidence: risk.evidence,
          requiredPlanChange: risk.requiredPlanChange,
          status: risk.status,
          createdAt: now,
        }).run();
      }

      for (const [index, command] of (canonical.validationCommands ?? []).entries()) {
        tx.insert(requiredValidationCommands).values({
          id: nextRandomId("VAL-CMD"),
          changeId: input.changeId,
          phase: "Plan",
          sourceSnapshotId: snapshotId,
          command,
          commandOrder: index + 1,
          required: 1,
          createdAt: now,
        }).run();
      }
    }

    tx.insert(stageRuns).values({
      id: stageRunId,
      changeId: input.changeId,
      phase: "Plan",
      attemptNo: stageAttemptNo,
      status: input.gate.canApprove ? "passed" : "issues_found",
      idempotencyKey: null,
      inputDbHash: snapshotDbHash,
      outputDbHash: snapshotDbHash,
      sourceLineageJson: stableJson({
        schemaVersion: PLAN_SCHEMA_VERSION,
        source: "plan_snapshot",
        snapshotId,
      }),
      errorCode: null,
      startedAt: now,
      completedAt: now,
    }).run();

    const counts = {
      snapshotId,
      expectedFiles: canonical.expectedFiles?.length ?? 0,
      forbiddenFiles: canonical.forbiddenFiles?.length ?? 0,
      validationCommands: canonical.validationCommands?.length ?? 0,
      steps: canonical.implementationSteps?.length ?? 0,
      blockingP0: input.gate.blockingP0,
      blockingP1: input.gate.blockingP1,
      nonBlockingP2: input.gate.nonBlockingP2,
      missingFields: input.gate.missingFields,
    };

    tx.insert(stageReports).values({
      id: stageReportId,
      changeId: input.changeId,
      phase: "Plan",
      sourceRunId: stageRunId,
      status: input.gate.canApprove ? "passed" : "issues_found",
      countsJson: stableJson(counts),
      isFresh: input.reportFresh ? 1 : 0,
      staleReason: input.reportFresh ? null : "plan_report_stale",
      reportDbHash: snapshotDbHash,
      generatedAt: now,
    }).run();

    const blockers = [
      ...input.gate.missingFields.map((field) => ({
        id: field,
        severity: "P0",
        title: `Missing or invalid ${field}`,
      })),
      ...input.risks
        .filter((risk) => isBlockingP0Risk(risk) || isBlockingP1Risk(risk))
        .map((risk) => ({
          id: risk.id,
          severity: risk.severity,
          title: risk.title,
        })),
    ];
    const freshness = {
      reportFresh: input.reportFresh,
      source: "plan_snapshot",
      snapshotId,
    };
    const requiredActions = input.gate.canApprove ? ["approve_plan"] : ["regenerate_plan_report"];
    const gateStatus = input.gate.canApprove ? "passed" : "blocked";

    const existingGateVersions = tx
      .select({ gateVersion: stageGates.gateVersion })
      .from(stageGates)
      .where(and(eq(stageGates.changeId, input.changeId), eq(stageGates.phase, "Plan")))
      .all()
      .map((row) => row.gateVersion);
    tx.insert(stageGates).values({
      id: stageGateId,
      changeId: input.changeId,
      phase: "Plan",
      status: gateStatus,
      blockersJson: stableJson(blockers),
      freshnessJson: stableJson(freshness),
      requiredActionsJson: stableJson(requiredActions),
      sourceDbHash: snapshotDbHash,
      gateVersion: computeNextGateVersion(existingGateVersions),
      computedAt: now,
    }).run();

    const existingState = tx
      .select()
      .from(stageStates)
      .where(and(eq(stageStates.changeId, input.changeId), eq(stageStates.phase, "Plan")))
      .all()
      .sort((left, right) => {
        const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
        if (updatedDiff !== 0) return updatedDiff;
        if (right.version !== left.version) return right.version - left.version;
        return right.id.localeCompare(left.id);
      })[0];
    if (existingState) {
      tx.update(stageStates)
        .set({
          status: gateStatus,
          latestRunId: stageRunId,
          latestReportId: stageReportId,
          latestGateId: stageGateId,
          latestValidReportId: input.reportFresh ? stageReportId : null,
          dbHash: snapshotDbHash,
          version: existingState.version + 1,
          updatedAt: now,
        })
        .where(eq(stageStates.id, existingState.id))
        .run();
    } else {
      tx.insert(stageStates).values({
        id: nextStageStateId(),
        changeId: input.changeId,
        phase: "Plan",
        status: gateStatus,
        latestRunId: stageRunId,
        latestReportId: stageReportId,
        latestGateId: stageGateId,
        latestValidReportId: input.reportFresh ? stageReportId : null,
        dbHash: snapshotDbHash,
        version: 1,
        updatedAt: now,
      }).run();
    }
  });
  return snapshotId;
}
