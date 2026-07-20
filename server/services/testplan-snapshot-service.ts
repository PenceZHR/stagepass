import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { and, asc, desc, eq } from "drizzle-orm";

import {
  changes,
  humanDecisions,
  requiredValidationCommands,
  testplanCoverageItems,
  testplanManualChecks,
  testplanRiskMappings,
  testplanSnapshots,
} from "../db/schema";
import {
  completeStageRun,
  computeSourceDbHash,
  peekStageAuthority,
  recomputeStageGate,
  startStageRun,
  type StageGateRecord,
} from "./stage-authority-service";
import { getActions } from "./action-contract-service";
import { renderMirrorsFromDb } from "./artifact-mirror-service";
import type { Provider } from "./provider-selection-service";

type TestPlanSnapshotDb = typeof import("../db/index").db;
type TestPlanSnapshotRow = typeof testplanSnapshots.$inferSelect;

export type TestPlanPriority = "P0" | "P1" | "P2";
export type TestPlanSnapshotStatus = "draft" | "approved" | "blocked";

export interface TestPlanCoverageItemInput {
  itemKey: string;
  title: string;
  requirementRef?: string | null;
  testType: string;
  priority: TestPlanPriority;
}

export interface TestPlanRiskMappingInput {
  coverageItemKey: string;
  riskRef: string;
  severity: TestPlanPriority;
  mitigation: string;
}

export interface TestPlanRequiredCommandInput {
  command: string;
  required?: boolean;
}

export interface TestPlanManualCheckInput {
  title: string;
  description?: string | null;
  required?: boolean;
}

export interface CreateTestPlanSnapshotInput {
  changeId: string;
  provider?: Provider;
  status?: TestPlanSnapshotStatus;
  testIntent: string;
  coverageItems: TestPlanCoverageItemInput[];
  riskMappings: TestPlanRiskMappingInput[];
  requiredCommands: TestPlanRequiredCommandInput[];
  manualChecks: TestPlanManualCheckInput[];
  schemaVersion?: string;
  createdAt?: string;
}

export interface ApproveTestPlanInput {
  changeId: string;
  actor: string;
  approvedAt?: string;
  reason?: string | null;
}

export interface TestPlanSnapshot {
  id: string;
  changeId: string;
  status: string;
  testIntent: string;
  schemaVersion: string;
  approvalState: string;
  approvedAt: string | null;
  approvalDecisionId: string | null;
  snapshotDbHash: string;
  createdAt: string;
  coverageItems: Array<typeof testplanCoverageItems.$inferSelect>;
  riskMappings: Array<typeof testplanRiskMappings.$inferSelect>;
  requiredCommands: Array<typeof requiredValidationCommands.$inferSelect>;
  manualChecks: Array<typeof testplanManualChecks.$inferSelect>;
  gate: StageGateRecord;
}

type TestPlanMarkdownGate = {
  status: string;
  sourceDbHash: string | null;
};

export interface TestPlanSandboxState {
  changeId: string;
  status: "missing" | "draft" | "approved" | "blocked";
  snapshot: {
    id: string;
    status: string;
    approvalState: string;
    approvedAt: string | null;
    snapshotDbHash: string;
    schemaVersion: string;
    createdAt: string;
  } | null;
  testIntent: string;
  coverageItems: Array<typeof testplanCoverageItems.$inferSelect>;
  riskMappings: Array<typeof testplanRiskMappings.$inferSelect>;
  requiredCommands: Array<typeof requiredValidationCommands.$inferSelect>;
  manualChecks: Array<typeof testplanManualChecks.$inferSelect>;
  gate: {
    status: string | null;
    sourceDbHash: string | null;
    blockers: unknown[];
    requiredActions: string[];
  };
  reportFresh: boolean;
  markdown: string;
}

interface TestPlanBlocker {
  id: string;
  severity: TestPlanPriority;
  title: string;
}

const requireDefaultDb = createRequire(import.meta.url);
let testPlanSnapshotDbForTest: TestPlanSnapshotDb | null = null;
let defaultTestPlanSnapshotDb: TestPlanSnapshotDb | null = null;

export function setTestPlanSnapshotServiceDbForTest(nextDb: TestPlanSnapshotDb): () => void {
  const previous = testPlanSnapshotDbForTest;
  testPlanSnapshotDbForTest = nextDb;
  return () => {
    testPlanSnapshotDbForTest = previous;
  };
}

function getTestPlanSnapshotDb(): TestPlanSnapshotDb {
  if (testPlanSnapshotDbForTest) return testPlanSnapshotDbForTest;
  if (!defaultTestPlanSnapshotDb) {
    defaultTestPlanSnapshotDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultTestPlanSnapshotDb;
}

function nowISO(): string {
  return new Date().toISOString();
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

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function nextPrefixedId(ids: string[], prefix: string): string {
  const used = new Set(ids);
  let maxNum = 0;
  for (const id of ids) {
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) maxNum = Math.max(maxNum, Number.parseInt(match[1], 10));
  }
  let nextNum = maxNum + 1;
  let candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

function nextId(selectIds: () => string[], prefix: string): string {
  return nextPrefixedId(selectIds(), prefix);
}

function cleanText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`TestPlan ${field} is required`);
  return trimmed;
}

function normalizedCommand(input: TestPlanRequiredCommandInput): TestPlanRequiredCommandInput {
  const command = cleanText(input.command, "required command");
  // Structural garbage gate at the DB door (defense in depth behind the
  // test-plan line protocol): JSON fragments and unbalanced quotes observed
  // leaking from model output must never become QA-executed commands.
  if (command.includes("},{") || command.includes("],[")) {
    throw new Error(`required command contains JSON fragment garbage: ${command}`);
  }
  if ((command.match(/"/g) ?? []).length % 2 !== 0 || (command.match(/'/g) ?? []).length % 2 !== 0) {
    throw new Error(`required command has unbalanced quotes: ${command}`);
  }
  return {
    command,
    required: input.required !== false,
  };
}

function contentRows(input: {
  changeId: string;
  snapshotId: string;
  testIntent: string;
  schemaVersion: string;
  coverageItems: TestPlanCoverageItemInput[];
  riskMappings: TestPlanRiskMappingInput[];
  requiredCommands: TestPlanRequiredCommandInput[];
  manualChecks: TestPlanManualCheckInput[];
}): unknown[] {
  return [
    {
      table: "testplan_snapshots",
      id: input.snapshotId,
      changeId: input.changeId,
      testIntent: input.testIntent,
      schemaVersion: input.schemaVersion,
    },
    ...input.coverageItems.map((item) => ({ table: "testplan_coverage_items", ...item })),
    ...input.riskMappings.map((mapping) => ({ table: "testplan_risk_mappings", ...mapping })),
    ...input.requiredCommands.map((command, index) => ({
      table: "required_validation_commands",
      phase: "TestPlan",
      commandOrder: index + 1,
      ...command,
    })),
    ...input.manualChecks.map((manualCheck) => ({
      table: "testplan_manual_checks",
      ...manualCheck,
    })),
  ];
}

function contentBlockers(input: {
  coverageItems: TestPlanCoverageItemInput[];
  riskMappings: TestPlanRiskMappingInput[];
  requiredCommands: TestPlanRequiredCommandInput[];
}): TestPlanBlocker[] {
  const blockers: TestPlanBlocker[] = [];
  if (input.coverageItems.length === 0) {
    blockers.push({ id: "coverage_items", severity: "P0", title: "TestPlan has no coverage items" });
  }
  if (input.requiredCommands.filter((command) => command.required !== false).length === 0) {
    blockers.push({ id: "required_commands", severity: "P0", title: "TestPlan has no required commands" });
  }
  const mappedCoverageKeys = new Set(input.riskMappings.map((mapping) => mapping.coverageItemKey));
  for (const item of input.coverageItems) {
    if (!mappedCoverageKeys.has(item.itemKey)) {
      blockers.push({
        id: item.itemKey,
        severity: item.priority,
        title: `Coverage item has no risk mapping: ${item.itemKey}`,
      });
    }
  }
  return blockers;
}

function latestSnapshot(changeId: string): TestPlanSnapshotRow | null {
  const db = getTestPlanSnapshotDb();
  return (
    db
      .select()
      .from(testplanSnapshots)
      .where(eq(testplanSnapshots.changeId, changeId))
      .orderBy(desc(testplanSnapshots.createdAt), desc(testplanSnapshots.id))
      .limit(1)
      .get() ?? null
  );
}

function latestApprovedSnapshot(changeId: string): TestPlanSnapshotRow | null {
  const db = getTestPlanSnapshotDb();
  return (
    db
      .select()
      .from(testplanSnapshots)
      .where(and(eq(testplanSnapshots.changeId, changeId), eq(testplanSnapshots.approvalState, "approved")))
      .orderBy(desc(testplanSnapshots.approvedAt), desc(testplanSnapshots.createdAt), desc(testplanSnapshots.id))
      .limit(1)
      .get() ?? null
  );
}

function loadSnapshotRows(snapshotId: string) {
  const db = getTestPlanSnapshotDb();
  const coverageItems = db
    .select()
    .from(testplanCoverageItems)
    .where(eq(testplanCoverageItems.testplanSnapshotId, snapshotId))
    .orderBy(asc(testplanCoverageItems.id))
    .all();
  const riskMappings = db
    .select()
    .from(testplanRiskMappings)
    .where(eq(testplanRiskMappings.testplanSnapshotId, snapshotId))
    .orderBy(asc(testplanRiskMappings.id))
    .all();
  const requiredCommands = db
    .select()
    .from(requiredValidationCommands)
    .where(
      and(
        eq(requiredValidationCommands.phase, "TestPlan"),
        eq(requiredValidationCommands.sourceSnapshotId, snapshotId),
      ),
    )
    .orderBy(asc(requiredValidationCommands.commandOrder), asc(requiredValidationCommands.id))
    .all();
  const manualChecks = db
    .select()
    .from(testplanManualChecks)
    .where(eq(testplanManualChecks.testplanSnapshotId, snapshotId))
    .orderBy(asc(testplanManualChecks.id))
    .all();
  return { coverageItems, riskMappings, requiredCommands, manualChecks };
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

function readJsonStringArray(value: string | null | undefined): string[] {
  return readJsonArray(value).filter((item): item is string => typeof item === "string");
}

function testPlanSandboxStatus(snapshot: TestPlanSnapshotRow | null): TestPlanSandboxState["status"] {
  if (!snapshot) return "missing";
  if (snapshot.approvalState === "approved") return "approved";
  if (snapshot.status === "draft" || snapshot.status === "approved" || snapshot.status === "blocked") {
    return snapshot.status;
  }
  return "blocked";
}

function testPlanMarkdownGate(gate: StageGateRecord | null): TestPlanMarkdownGate {
  return {
    status: gate?.status ?? "missing",
    sourceDbHash: gate?.sourceDbHash ?? null,
  };
}

function renderTestPlanMarkdown(input: {
  snapshot: TestPlanSnapshotRow;
  coverageItems: Array<typeof testplanCoverageItems.$inferSelect>;
  riskMappings: Array<typeof testplanRiskMappings.$inferSelect>;
  requiredCommands: Array<typeof requiredValidationCommands.$inferSelect>;
  manualChecks: Array<typeof testplanManualChecks.$inferSelect>;
  gate: TestPlanMarkdownGate;
}): string {
  const lines = [
    "# TestPlan DB Snapshot",
    "",
    `schemaVersion: ${input.snapshot.schemaVersion}`,
    `status: ${input.snapshot.status}`,
    `approvalState: ${input.snapshot.approvalState}`,
    `gate: ${input.gate.status}`,
    `sourceDbHash: ${input.gate.sourceDbHash}`,
    "",
    "## Test Intent",
    "",
    input.snapshot.testIntent,
    "",
    "## Coverage Items",
    "",
  ];
  for (const item of input.coverageItems) {
    lines.push(`- [${item.priority}] ${item.itemKey}: ${item.title} (${item.testType})`);
  }
  lines.push("", "## Risk Mappings", "");
  for (const mapping of input.riskMappings) {
    lines.push(`- ${mapping.coverageItemKey} -> ${mapping.riskRef} [${mapping.severity}]: ${mapping.mitigation}`);
  }
  lines.push("", "## Required Commands", "", "```bash");
  for (const command of input.requiredCommands.filter((row) => row.required === 1)) {
    lines.push(command.command);
  }
  lines.push("```", "", "## Manual Checks", "");
  for (const check of input.manualChecks) {
    lines.push(`- ${check.required === 1 ? "required" : "optional"}: ${check.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function getTestPlanSnapshotState(changeId: string): TestPlanSandboxState {
  const snapshot = latestSnapshot(changeId);
  const authority = peekStageAuthority(changeId, "TestPlan");
  const gate = authority.latestGate;
  const report = authority.latestReport;
  const gateState = {
    status: gate?.status ?? null,
    sourceDbHash: gate?.sourceDbHash ?? null,
    blockers: readJsonArray(gate?.blockersJson),
    requiredActions: readJsonStringArray(gate?.requiredActionsJson),
  };

  if (!snapshot) {
    return {
      changeId,
      status: "missing",
      snapshot: null,
      testIntent: "",
      coverageItems: [],
      riskMappings: [],
      requiredCommands: [],
      manualChecks: [],
      gate: gateState,
      reportFresh: report?.isFresh === 1,
      markdown: "# TestPlan DB Snapshot\n\nNo TestPlan snapshot has been generated.\n",
    };
  }

  const rows = loadSnapshotRows(snapshot.id);

  return {
    changeId,
    status: testPlanSandboxStatus(snapshot),
    snapshot: {
      id: snapshot.id,
      status: snapshot.status,
      approvalState: snapshot.approvalState,
      approvedAt: snapshot.approvedAt,
      snapshotDbHash: snapshot.snapshotDbHash,
      schemaVersion: snapshot.schemaVersion,
      createdAt: snapshot.createdAt,
    },
    testIntent: snapshot.testIntent,
    ...rows,
    gate: gateState,
    reportFresh: report?.isFresh === 1,
    markdown: renderTestPlanMarkdown({
      snapshot,
      ...rows,
      gate: testPlanMarkdownGate(gate),
    }),
  };
}

function recomputeContentGate(input: {
  changeId: string;
  snapshot: TestPlanSnapshotRow;
  includeApprovalBlocker: boolean;
}): StageGateRecord {
  const rows = loadSnapshotRows(input.snapshot.id);
  const blockers = contentBlockers({
    coverageItems: rows.coverageItems.map((item) => ({
      itemKey: item.itemKey,
      title: item.title,
      requirementRef: item.requirementRef,
      testType: item.testType,
      priority: item.priority as TestPlanPriority,
    })),
    riskMappings: rows.riskMappings.map((mapping) => ({
      coverageItemKey: mapping.coverageItemKey,
      riskRef: mapping.riskRef,
      severity: mapping.severity as TestPlanPriority,
      mitigation: mapping.mitigation,
    })),
    requiredCommands: rows.requiredCommands.map((command) => ({
      command: command.command,
      required: command.required === 1,
    })),
  });
  if (input.includeApprovalBlocker && input.snapshot.approvalState !== "approved") {
    blockers.push({
      id: "testplan_approval",
      severity: "P1",
      title: "TestPlan requires approval before QA",
    });
  }
  return recomputeStageGate({
    changeId: input.changeId,
    phase: "TestPlan",
    status: blockers.length > 0 ? "blocked" : "passed",
    blockers,
    freshness: { fresh: true, sourceSnapshotId: input.snapshot.id },
    requiredActions: blockers.length > 0 ? ["approve_test_plan"] : [],
    rows: [
      input.snapshot,
      ...rows.coverageItems,
      ...rows.riskMappings,
      ...rows.requiredCommands,
      ...rows.manualChecks,
    ],
  });
}

export function createTestPlanSnapshot(input: CreateTestPlanSnapshotInput): TestPlanSnapshot {
  const db = getTestPlanSnapshotDb();
  const existingChange = db.select().from(changes).where(eq(changes.id, input.changeId)).get();
  if (!existingChange) throw new Error(`Change not found: ${input.changeId}`);

  const createdAt = input.createdAt ?? nowISO();
  const schemaVersion = input.schemaVersion ?? "testplan/v1";
  const normalizedCoverage = input.coverageItems.map((item) => ({
    itemKey: cleanText(item.itemKey, "coverage item key"),
    title: cleanText(item.title, "coverage item title"),
    requirementRef: item.requirementRef?.trim() || null,
    testType: cleanText(item.testType, "coverage item testType"),
    priority: item.priority,
  }));
  const normalizedMappings = input.riskMappings.map((mapping) => ({
    coverageItemKey: cleanText(mapping.coverageItemKey, "risk mapping coverageItemKey"),
    riskRef: cleanText(mapping.riskRef, "risk mapping riskRef"),
    severity: mapping.severity,
    mitigation: cleanText(mapping.mitigation, "risk mapping mitigation"),
  }));
  const normalizedCommands = input.requiredCommands.map(normalizedCommand);
  const normalizedManualChecks = input.manualChecks.map((check) => ({
    title: cleanText(check.title, "manual check title"),
    description: check.description?.trim() || null,
    required: check.required !== false,
  }));
  const snapshotId = nextId(
    () => db.select({ id: testplanSnapshots.id }).from(testplanSnapshots).all().map((row) => row.id),
    "TPL-SNAP",
  );
  const rowsForHash = contentRows({
    changeId: input.changeId,
    snapshotId,
    testIntent: cleanText(input.testIntent, "testIntent"),
    schemaVersion,
    coverageItems: normalizedCoverage,
    riskMappings: normalizedMappings,
    requiredCommands: normalizedCommands,
    manualChecks: normalizedManualChecks,
  });
  const snapshotDbHash = sha256(rowsForHash);
  const run = startStageRun({
    changeId: input.changeId,
    phase: "TestPlan",
    inputDbHash: snapshotDbHash,
    sourceLineage: { schemaVersion, source: "testplan_snapshot_service" },
    startedAt: createdAt,
    provider: input.provider ?? null,
  });

  db.transaction((tx) => {
    tx.delete(requiredValidationCommands)
      .where(
        and(
          eq(requiredValidationCommands.changeId, input.changeId),
          eq(requiredValidationCommands.phase, "TestPlan"),
        ),
      )
      .run();
    tx.insert(testplanSnapshots).values({
      id: snapshotId,
      changeId: input.changeId,
      status: input.status ?? "draft",
      testIntent: cleanText(input.testIntent, "testIntent"),
      schemaVersion,
      approvalState: "pending",
      approvedAt: null,
      approvalDecisionId: null,
      snapshotDbHash,
      createdAt,
    }).run();
    const coverageIds = db
      .select({ id: testplanCoverageItems.id })
      .from(testplanCoverageItems)
      .all()
      .map((row) => row.id);
    normalizedCoverage.forEach((item) => {
      const id = nextPrefixedId(coverageIds, "TPL-COV");
      coverageIds.push(id);
      tx.insert(testplanCoverageItems).values({
        id,
        testplanSnapshotId: snapshotId,
        itemKey: item.itemKey,
        title: item.title,
        requirementRef: item.requirementRef,
        testType: item.testType,
        priority: item.priority,
        status: "planned",
        createdAt,
      }).run();
    });
    const mappingIds = db
      .select({ id: testplanRiskMappings.id })
      .from(testplanRiskMappings)
      .all()
      .map((row) => row.id);
    normalizedMappings.forEach((mapping) => {
      const id = nextPrefixedId(mappingIds, "TPL-RISK");
      mappingIds.push(id);
      tx.insert(testplanRiskMappings).values({
        id,
        testplanSnapshotId: snapshotId,
        coverageItemKey: mapping.coverageItemKey,
        riskRef: mapping.riskRef,
        severity: mapping.severity,
        mitigation: mapping.mitigation,
        createdAt,
      }).run();
    });
    const commandIds = db
      .select({ id: requiredValidationCommands.id })
      .from(requiredValidationCommands)
      .all()
      .map((row) => row.id);
    normalizedCommands.forEach((command, index) => {
      const id = nextPrefixedId(commandIds, "VAL-CMD");
      commandIds.push(id);
      tx.insert(requiredValidationCommands).values({
        id,
        changeId: input.changeId,
        phase: "TestPlan",
        sourceSnapshotId: snapshotId,
        command: command.command,
        commandOrder: index + 1,
        required: command.required === false ? 0 : 1,
        createdAt,
      }).run();
    });
    const manualCheckIds = db
      .select({ id: testplanManualChecks.id })
      .from(testplanManualChecks)
      .all()
      .map((row) => row.id);
    normalizedManualChecks.forEach((check) => {
      const id = nextPrefixedId(manualCheckIds, "TPL-MAN");
      manualCheckIds.push(id);
      tx.insert(testplanManualChecks).values({
        id,
        testplanSnapshotId: snapshotId,
        title: check.title,
        description: check.description,
        required: check.required ? 1 : 0,
        status: "pending",
        createdAt,
      }).run();
    });
  });

  const snapshot = db.select().from(testplanSnapshots).where(eq(testplanSnapshots.id, snapshotId)).get();
  if (!snapshot) throw new Error(`TestPlan snapshot was not written: ${snapshotId}`);
  const rows = loadSnapshotRows(snapshot.id);
  const contentOnlyBlockers = contentBlockers({
    coverageItems: normalizedCoverage,
    riskMappings: normalizedMappings,
    requiredCommands: normalizedCommands,
  });
  const reportDbHash = computeSourceDbHash({
    changeId: input.changeId,
    phase: "TestPlan",
    rows: [snapshot, ...rows.coverageItems, ...rows.riskMappings, ...rows.requiredCommands, ...rows.manualChecks],
  });
  completeStageRun({
    runId: run.id,
    status: contentOnlyBlockers.length > 0 ? "issues_found" : "passed",
    counts: {
      coverageItems: rows.coverageItems.length,
      riskMappings: rows.riskMappings.length,
      requiredCommands: rows.requiredCommands.filter((command) => command.required === 1).length,
      manualChecks: rows.manualChecks.length,
      blockers: contentOnlyBlockers.length,
    },
    reportDbHash,
    outputDbHash: reportDbHash,
    completedAt: createdAt,
    generatedAt: createdAt,
  });
  const gate = recomputeContentGate({
    changeId: input.changeId,
    snapshot,
    includeApprovalBlocker: true,
  });
  getActions(input.changeId);

  renderMirrorsFromDb({
    changeId: input.changeId,
    generatedAt: createdAt,
    mirrors: [
      {
        phase: "TestPlan",
        artifactType: "test_plan_delta",
        fileName: "test-plan-delta.md",
        schemaVersion,
        sourceDbHash: gate.sourceDbHash,
        content: renderTestPlanMarkdown({ snapshot, ...rows, gate: testPlanMarkdownGate(gate) }),
      },
      {
        phase: "TestPlan",
        artifactType: "test_plan_delta_json",
        fileName: "test-plan-delta.json",
        schemaVersion,
        sourceDbHash: snapshot.snapshotDbHash,
        payload: {
          snapshot,
          coverageItems: rows.coverageItems,
          riskMappings: rows.riskMappings,
          requiredCommands: rows.requiredCommands,
          manualChecks: rows.manualChecks,
          gate,
        },
      },
    ],
  });

  return { ...snapshot, ...rows, gate };
}

export function approveTestPlan(input: ApproveTestPlanInput): StageGateRecord {
  const db = getTestPlanSnapshotDb();
  const snapshot = latestSnapshot(input.changeId);
  if (!snapshot) throw new Error(`TestPlan snapshot not found: ${input.changeId}`);
  const rows = loadSnapshotRows(snapshot.id);
  const blockers = contentBlockers({
    coverageItems: rows.coverageItems.map((item) => ({
      itemKey: item.itemKey,
      title: item.title,
      requirementRef: item.requirementRef,
      testType: item.testType,
      priority: item.priority as TestPlanPriority,
    })),
    riskMappings: rows.riskMappings.map((mapping) => ({
      coverageItemKey: mapping.coverageItemKey,
      riskRef: mapping.riskRef,
      severity: mapping.severity as TestPlanPriority,
      mitigation: mapping.mitigation,
    })),
    requiredCommands: rows.requiredCommands.map((command) => ({
      command: command.command,
      required: command.required === 1,
    })),
  });
  if (blockers.length > 0) {
    return recomputeStageGate({
      changeId: input.changeId,
      phase: "TestPlan",
      status: "blocked",
      blockers,
      freshness: { fresh: true, sourceSnapshotId: snapshot.id },
      requiredActions: ["fix_test_plan"],
      rows: [snapshot, ...rows.coverageItems, ...rows.riskMappings, ...rows.requiredCommands, ...rows.manualChecks],
    });
  }

  const approvedAt = input.approvedAt ?? nowISO();
  const decisionId = nextId(
    () => db.select({ id: humanDecisions.id }).from(humanDecisions).all().map((row) => row.id),
    "HD",
  );
  db.insert(humanDecisions).values({
    id: decisionId,
    changeId: input.changeId,
    roundId: null,
    gate: "test_plan",
    action: "approve",
    targetType: "testplan_snapshot",
    targetId: snapshot.id,
    reason: input.reason ?? null,
    reportHash: snapshot.snapshotDbHash,
    createdBy: input.actor,
    createdAt: approvedAt,
  }).run();
  db.update(testplanSnapshots)
    .set({
      status: "approved",
      approvalState: "approved",
      approvedAt,
      approvalDecisionId: decisionId,
    })
    .where(eq(testplanSnapshots.id, snapshot.id))
    .run();
  const approved = db.select().from(testplanSnapshots).where(eq(testplanSnapshots.id, snapshot.id)).get();
  if (!approved) throw new Error(`TestPlan snapshot not found after approval: ${snapshot.id}`);
  const gate = recomputeContentGate({
    changeId: input.changeId,
    snapshot: approved,
    includeApprovalBlocker: true,
  });
  getActions(input.changeId);
  return gate;
}

export function getRequiredValidationCommands(changeId: string): string[] {
  const db = getTestPlanSnapshotDb();
  const snapshot = latestApprovedSnapshot(changeId) ?? latestSnapshot(changeId);
  if (!snapshot) return [];
  return db
    .select()
    .from(requiredValidationCommands)
    .where(
      and(
        eq(requiredValidationCommands.changeId, changeId),
        eq(requiredValidationCommands.phase, "TestPlan"),
        eq(requiredValidationCommands.sourceSnapshotId, snapshot.id),
        eq(requiredValidationCommands.required, 1),
      ),
    )
    .orderBy(asc(requiredValidationCommands.commandOrder), asc(requiredValidationCommands.id))
    .all()
    .map((row) => row.command);
}
