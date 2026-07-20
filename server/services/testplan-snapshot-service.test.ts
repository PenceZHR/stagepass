import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as schema from "../db/schema.ts";
import { runMigrations } from "../db/migrate.ts";
import { getActions } from "./action-contract-service.ts";
import { setActionContractServiceDbForTest } from "./action-contract-service.ts";
import { ACTION_DEFINITIONS } from "./action-contract-registry-service.ts";
import { setArtifactMirrorServiceDbForTest } from "./artifact-mirror-service.ts";
import {
  setMergeReadinessDbForTest,
  setMergeReadinessHeadProbeForTest,
} from "./merge-readiness-service.ts";
import {
  setReviewQaGateDbForTest,
  setReviewQaGateHeadProbeForTest,
} from "./review-qa-gate-service.ts";
import { setStageAuthorityServiceDbForTest } from "./stage-authority-service.ts";
import {
  approveTestPlan,
  createTestPlanSnapshot,
  getTestPlanSnapshotState,
  getRequiredValidationCommands,
  setTestPlanSnapshotServiceDbForTest,
} from "./testplan-snapshot-service.ts";

const PROJECT_ID = "PRJ-TESTPLAN-SNAPSHOT";
const CHANGE_ID = "CHG-TESTPLAN-SNAPSHOT";
const NOW = "2026-06-29T00:00:00.000Z";
const HEAD_SHA = "d".repeat(40);

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  runMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function seedChange(db: ReturnType<typeof createTestDb>, repoPath: string, status = "IMPLEMENTED") {
  db.insert(schema.projects).values({
    id: PROJECT_ID,
    name: "TestPlan Snapshot",
    repoPath,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(schema.changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Store TestPlan in DB",
    status,
    provider: "codex",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function seedReviewReady(db: ReturnType<typeof createTestDb>) {
  db.insert(schema.buildRunRecords).values({
    id: "BRR-TESTPLAN-SNAPSHOT",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-1",
    status: "adopted",
    headSha: HEAD_SHA,
    adoptedAt: NOW,
    artifactHash: null,
    source: "test",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(schema.runs).values({
    id: "RUN-TESTPLAN-SNAPSHOT-REVIEW",
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: NOW,
    endedAt: NOW,
    summary: "{}",
  }).run();
  db.insert(schema.reviewAttempts).values({
    id: "RAT-TESTPLAN-SNAPSHOT",
    changeId: CHANGE_ID,
    runId: "RUN-TESTPLAN-SNAPSHOT-REVIEW",
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "review-testplan-snapshot",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_SHA,
    priorBlockingFindingIdsJson: null,
    rawOutputArtifactId: null,
    startedAt: NOW,
    endedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(schema.reviewReports).values({
    id: "RRP-TESTPLAN-SNAPSHOT",
    attemptId: "RAT-TESTPLAN-SNAPSHOT",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "review-report-hash-testplan-snapshot",
    gateStatus: "passed",
    qaAllowed: 1,
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_SHA,
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0: 0,
    blockingP1: 0,
    waivedP1: 0,
    p2Count: 0,
    findingsDbHash: "findings-hash-testplan-snapshot",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: NOW,
    createdAt: NOW,
  }).run();
  db.insert(schema.reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-TESTPLAN-SNAPSHOT",
    latestAttemptNo: 1,
    latestReportId: "RRP-TESTPLAN-SNAPSHOT",
    latestValidReviewReportId: "RRP-TESTPLAN-SNAPSHOT",
    latestValidAttemptNo: 1,
    gateStatus: "passed",
    reviewStatus: "passed",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_SHA,
    reportDbHash: "review-report-hash-testplan-snapshot",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: NOW,
  }).run();
}

function validSnapshot(overrides: Partial<Parameters<typeof createTestPlanSnapshot>[0]> = {}) {
  return {
    changeId: CHANGE_ID,
    status: "draft" as const,
    testIntent: "验证 TestPlan DB-first 快照",
    coverageItems: [
      {
        itemKey: "cov-db-commands",
        title: "QA 命令来自 DB",
        requirementRef: "Task 9.2",
        testType: "integration",
        priority: "P0" as const,
      },
    ],
    riskMappings: [
      {
        coverageItemKey: "cov-db-commands",
        riskRef: "risk-markdown-bypass",
        severity: "P0" as const,
        mitigation: "只读取 required_validation_commands",
      },
    ],
    requiredCommands: [
      { command: "pnpm test -- server/services/testplan-snapshot-service.test.ts", required: true },
      { command: "pnpm test -- server/services/pipeline-service.test.ts", required: true },
    ],
    manualChecks: [{ title: "检查 QA action disabled reason", required: true }],
    schemaVersion: "testplan/v1",
    createdAt: NOW,
    ...overrides,
  };
}

function countStageAuthorityRows(
  db: ReturnType<typeof createTestDb>,
  table:
    | typeof schema.stageStates
    | typeof schema.stageGates
    | typeof schema.stageReports
    | typeof schema.stageRuns,
) {
  return db
    .select()
    .from(table)
    .where(and(eq(table.changeId, CHANGE_ID), eq(table.phase, "TestPlan")))
    .all().length;
}

describe("testplan-snapshot-service", () => {
  let repoPath = "";
  let testDb: ReturnType<typeof createTestDb>;
  let cleanupServiceDb: (() => void) | null = null;
  let cleanupStageDb: (() => void) | null = null;
  let cleanupActionDb: (() => void) | null = null;
  let cleanupMirrorDb: (() => void) | null = null;
  let cleanupMergeDb: (() => void) | null = null;
  let cleanupMergeHeadProbe: (() => void) | null = null;
  let cleanupReviewQaDb: (() => void) | null = null;
  let cleanupReviewQaHeadProbe: (() => void) | null = null;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ai-testplan-snapshot-"));
    testDb = createTestDb();
    cleanupServiceDb = setTestPlanSnapshotServiceDbForTest(testDb);
    cleanupStageDb = setStageAuthorityServiceDbForTest(testDb);
    cleanupActionDb = setActionContractServiceDbForTest(testDb);
    cleanupMirrorDb = setArtifactMirrorServiceDbForTest(testDb);
    cleanupMergeDb = setMergeReadinessDbForTest(testDb);
    cleanupMergeHeadProbe = setMergeReadinessHeadProbeForTest(() => HEAD_SHA);
    cleanupReviewQaDb = setReviewQaGateDbForTest(testDb);
    cleanupReviewQaHeadProbe = setReviewQaGateHeadProbeForTest(() => HEAD_SHA);
    seedChange(testDb, repoPath);
    seedReviewReady(testDb);
  });

  afterEach(() => {
    cleanupReviewQaHeadProbe?.();
    cleanupReviewQaHeadProbe = null;
    cleanupReviewQaDb?.();
    cleanupReviewQaDb = null;
    cleanupMergeHeadProbe?.();
    cleanupMergeHeadProbe = null;
    cleanupMergeDb?.();
    cleanupMergeDb = null;
    cleanupMirrorDb?.();
    cleanupMirrorDb = null;
    cleanupActionDb?.();
    cleanupActionDb = null;
    cleanupStageDb?.();
    cleanupStageDb = null;
    cleanupServiceDb?.();
    cleanupServiceDb = null;
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("returns read-only TestPlan sandbox state from the latest snapshot rows", () => {
    const snapshot = createTestPlanSnapshot(validSnapshot({
      testIntent: "Verify command outcomes",
      coverageItems: [
        {
          itemKey: "ci-command-state-machine",
          title: "CI command state machine",
          requirementRef: "Task 1",
          testType: "integration",
          priority: "P0",
        },
      ],
      riskMappings: [
        {
          coverageItemKey: "ci-command-state-machine",
          riskRef: "risk-ci",
          severity: "P0",
          mitigation: "Assert command transitions",
        },
      ],
      requiredCommands: [{ command: "pnpm exec tsx --test server/services/testplan-snapshot-service.test.ts" }],
      manualChecks: [{ title: "Inspect command output", required: true }],
    }));
    const before = {
      states: countStageAuthorityRows(testDb, schema.stageStates),
      gates: countStageAuthorityRows(testDb, schema.stageGates),
      reports: countStageAuthorityRows(testDb, schema.stageReports),
      runs: countStageAuthorityRows(testDb, schema.stageRuns),
    };

    const state = getTestPlanSnapshotState(CHANGE_ID);

    const after = {
      states: countStageAuthorityRows(testDb, schema.stageStates),
      gates: countStageAuthorityRows(testDb, schema.stageGates),
      reports: countStageAuthorityRows(testDb, schema.stageReports),
      runs: countStageAuthorityRows(testDb, schema.stageRuns),
    };
    assert.equal(state.changeId, CHANGE_ID);
    assert.equal(state.snapshot?.id, snapshot.id);
    assert.equal(state.snapshot?.id, "TPL-SNAP-001");
    assert.equal(state.testIntent, "Verify command outcomes");
    assert.equal(state.coverageItems.length, 1);
    assert.equal(state.riskMappings.length, 1);
    assert.equal(state.requiredCommands.length, 1);
    assert.equal(state.manualChecks.length, 1);
    assert.match(state.markdown, /## Coverage Items/);
    assert.match(state.markdown, /ci-command-state-machine/);
    assert.deepEqual(after, before);
  });

  it("returns an empty missing TestPlan sandbox state without writing stage authority rows", () => {
    const before = {
      states: countStageAuthorityRows(testDb, schema.stageStates),
      gates: countStageAuthorityRows(testDb, schema.stageGates),
      reports: countStageAuthorityRows(testDb, schema.stageReports),
      runs: countStageAuthorityRows(testDb, schema.stageRuns),
    };

    const state = getTestPlanSnapshotState(CHANGE_ID);

    const after = {
      states: countStageAuthorityRows(testDb, schema.stageStates),
      gates: countStageAuthorityRows(testDb, schema.stageGates),
      reports: countStageAuthorityRows(testDb, schema.stageReports),
      runs: countStageAuthorityRows(testDb, schema.stageRuns),
    };
    assert.equal(state.snapshot, null);
    assert.equal(state.coverageItems.length, 0);
    assert.equal(state.status, "missing");
    assert.deepEqual(after, before);
  });

  it("returns TestPlan required commands from DB order when Markdown mirror is missing", () => {
    const snapshot = createTestPlanSnapshot(validSnapshot());
    approveTestPlan({ changeId: CHANGE_ID, actor: "tester", approvedAt: NOW });
    fs.rmSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "test-plan-delta.md"), {
      force: true,
    });

    const commands = getRequiredValidationCommands(CHANGE_ID);

    assert.equal(snapshot.requiredCommands.length, 2);
    assert.deepEqual(commands, [
      "pnpm test -- server/services/testplan-snapshot-service.test.ts",
      "pnpm test -- server/services/pipeline-service.test.ts",
    ]);
  });

  it("keeps enter_qa disabled when Markdown says passed but DB TestPlan gate is blocked", () => {
    createTestPlanSnapshot(
      validSnapshot({
        coverageItems: [
          {
            itemKey: "cov-unmapped",
            title: "缺少风险映射的覆盖项",
            requirementRef: "Task 9.3",
            testType: "unit",
            priority: "P1",
          },
        ],
        riskMappings: [],
      }),
    );
    fs.mkdirSync(path.join(repoPath, ".ship", "changes", CHANGE_ID), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, ".ship", "changes", CHANGE_ID, "test-plan-delta.md"),
      "# TestPlan\n\nQA passed\n",
    );

    const enterQa = getActions(CHANGE_ID).find((action) => action.actionId === "enter_qa");

    assert.ok(enterQa);
    assert.equal(enterQa.enabled, false);
    assert.equal(enterQa.reasonCode, "test_plan_blocked");
  });

  it("blocks the TestPlan gate when any coverage item has no risk mapping", () => {
    const snapshot = createTestPlanSnapshot(
      validSnapshot({
        coverageItems: [
          {
            itemKey: "cov-covered",
            title: "已映射覆盖项",
            requirementRef: "Task 9.1",
            testType: "unit",
            priority: "P1",
          },
          {
            itemKey: "cov-unmapped",
            title: "未映射覆盖项",
            requirementRef: "Task 9.1",
            testType: "unit",
            priority: "P1",
          },
        ],
        riskMappings: [
          {
            coverageItemKey: "cov-covered",
            riskRef: "risk-covered",
            severity: "P1",
            mitigation: "已覆盖",
          },
        ],
      }),
    );

    assert.equal(snapshot.gate.status, "blocked");
    assert.match(snapshot.gate.blockersJson ?? "", /cov-unmapped/);
  });

  it("persists approval state and TestPlan authority rows in DB", () => {
    const snapshot = createTestPlanSnapshot(validSnapshot());
    const gate = approveTestPlan({ changeId: CHANGE_ID, actor: "tester", approvedAt: NOW });

    assert.equal(snapshot.gate.status, "blocked");
    assert.equal(gate.status, "passed");
    assert.ok(
      getRequiredValidationCommands(CHANGE_ID).every((command) => command.startsWith("pnpm test")),
    );
    const row = testDb
      .select()
      .from(schema.testplanSnapshots)
      .where(eq(schema.testplanSnapshots.changeId, CHANGE_ID))
      .get();
    assert.equal(row?.approvalState, "approved");
    assert.equal(
      testDb
        .select()
        .from(schema.testplanManualChecks)
        .where(eq(schema.testplanManualChecks.testplanSnapshotId, snapshot.id))
        .all().length,
      1,
    );
  });

  /**
   * The gate's requiredActions are persisted forever (stage_gates is append-only),
   * served by GET /phases, and mirrored into test-plan-delta.json. They named
   * `approve_test_plan` / `fix_test_plan`, neither of which is an action the
   * contract registry has ever defined -- so anything resolving them got nothing.
   */
  function registeredActionIds(): Set<string> {
    return new Set(ACTION_DEFINITIONS.map((definition) => definition.actionId));
  }

  function requiredActionsOf(gate: { requiredActionsJson: string | null }): string[] {
    return JSON.parse(gate.requiredActionsJson ?? "null") as string[];
  }

  it("asks for the approval that actually clears an approval-blocked TestPlan gate", () => {
    const snapshot = createTestPlanSnapshot(validSnapshot());

    assert.equal(snapshot.gate.status, "blocked");
    assert.match(snapshot.gate.blockersJson ?? "", /testplan_approval/);
    // approve_plan is filed under Plan but carries TESTPLAN_DONE precisely so it
    // can serve this confirmation; the UI labels it "确认测试计划".
    assert.deepEqual(requiredActionsOf(snapshot.gate), ["approve_plan"]);

    const approved = approveTestPlan({ changeId: CHANGE_ID, actor: "tester", approvedAt: NOW });

    assert.equal(approved.status, "passed");
    assert.deepEqual(requiredActionsOf(approved), []);
  });

  it("points a content-blocked TestPlan gate at the retry, not at an approval that is refused", () => {
    // riskMappings: [] leaves the coverage item unmapped, which the AI output
    // validator permits and contentBlockers rejects -- so this branch is live,
    // not theoretical.
    const snapshot = createTestPlanSnapshot(validSnapshot({ riskMappings: [] }));

    assert.equal(snapshot.gate.status, "blocked");
    assert.deepEqual(requiredActionsOf(snapshot.gate), ["retry_test_plan"]);

    // Approving cannot clear a content blocker and approveTestPlan refuses, so
    // the gate it writes back must not tell the reader to approve either.
    const refused = approveTestPlan({ changeId: CHANGE_ID, actor: "tester", approvedAt: NOW });

    assert.equal(refused.status, "blocked");
    assert.deepEqual(requiredActionsOf(refused), ["retry_test_plan"]);
  });

  it("never advertises a TestPlan gate action the contract registry cannot resolve", () => {
    const registered = registeredActionIds();
    const gates = [
      createTestPlanSnapshot(validSnapshot({ riskMappings: [] })).gate,
      approveTestPlan({ changeId: CHANGE_ID, actor: "tester", approvedAt: NOW }),
      createTestPlanSnapshot(validSnapshot()).gate,
      approveTestPlan({ changeId: CHANGE_ID, actor: "tester", approvedAt: NOW }),
    ];

    const advertised = [...new Set(gates.flatMap(requiredActionsOf))];

    assert.ok(advertised.length > 0, "at least one gate should advertise an action");
    for (const actionId of advertised) {
      assert.ok(registered.has(actionId), `${actionId} is not a registered action id`);
    }
    assert.ok(!advertised.includes("approve_test_plan"));
    assert.ok(!advertised.includes("fix_test_plan"));
  });
});
