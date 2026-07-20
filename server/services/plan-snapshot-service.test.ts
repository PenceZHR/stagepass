import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";

import { db } from "../db/index.ts";
import {
  changes,
  humanDecisions,
  planApprovals,
  planRisks,
  planSnapshots,
  planSteps,
  projects,
  requiredValidationCommands,
  runs,
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
} from "../db/schema.ts";
import {
  getPlanSandboxState,
  persistGeneratedPlanSnapshot,
  type PlanJson,
} from "./plan-sandbox-service.ts";
import { planFromDbSnapshot, writePlanMirrorsFromDb } from "./plan-snapshot-service.ts";
import { deleteChangeRecords } from "./change-service.ts";

const PROJECT_ID_PREFIX = "PRJ-PLAN-SNAPSHOT-SERVICE-";
const CHANGE_ID_PREFIX = "CHG-PLAN-SNAPSHOT-SERVICE-";
let projectId = `${PROJECT_ID_PREFIX}initial`;
let changeId = `${CHANGE_ID_PREFIX}initial`;
let testCounter = 0;

/**
 * The model authors these through the plan line protocol (TEST / COMMAND / RISK
 * lines). They are deliberately pairwise disjoint so any cross-binding between
 * fields shows up as a failed assertion instead of a coincidental match.
 */
const MODEL_TEST_PLAN = [
  "验证 RateLimiter 具名导出与初始满桶行为",
  "验证突发耗尽后失败请求不扣减令牌",
  "验证时间回拨后补充区间仍然有效",
];
const MODEL_RISKS = [
  "Date.now 是墙上时钟且可回拨，实现依赖保留最大有效时间戳",
  "policy.json 要求 lint/typecheck/test/build，但仓库仅配置 npm test",
];
const VALIDATION_COMMANDS = ["npm test", "node --check src/index.js", "git diff --check"];

function cleanupRows() {
  const changeIds = db
    .select({ id: changes.id })
    .from(changes)
    .where(like(changes.id, `${CHANGE_ID_PREFIX}%`))
    .all()
    .map((row) => row.id);
  for (const testChangeId of changeIds) {
    deleteChangeRecords(testChangeId);
  }

  const snapshotIds = db
    .select({ id: planSnapshots.id })
    .from(planSnapshots)
    .where(like(planSnapshots.changeId, `${CHANGE_ID_PREFIX}%`))
    .all()
    .map((row) => row.id);
  for (const snapshotId of snapshotIds) {
    db.delete(planApprovals).where(eq(planApprovals.planSnapshotId, snapshotId)).run();
    db.delete(planRisks).where(eq(planRisks.planSnapshotId, snapshotId)).run();
    db.delete(planSteps).where(eq(planSteps.planSnapshotId, snapshotId)).run();
  }
  db.delete(requiredValidationCommands)
    .where(like(requiredValidationCommands.changeId, `${CHANGE_ID_PREFIX}%`))
    .run();
  db.delete(planSnapshots).where(like(planSnapshots.changeId, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(stageActions).where(like(stageActions.changeId, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(stageGates).where(like(stageGates.changeId, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(stageReports).where(like(stageReports.changeId, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(stageRuns).where(like(stageRuns.changeId, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(stageStates).where(like(stageStates.changeId, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(humanDecisions).where(like(humanDecisions.changeId, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(runs).where(like(runs.changeId, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(changes).where(like(changes.id, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(projects).where(like(projects.id, `${PROJECT_ID_PREFIX}%`)).run();
}

function seedChange(repoPath: string) {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: projectId,
    name: "Plan Snapshot",
    repoPath,
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(changes).values({
    id: changeId,
    projectId,
    title: "Plan snapshot change",
    status: "PLAN_READY",
    provider: "codex",
    codexThreadId: null,
    fixIterations: 0,
    blockedPhase: null,
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    gateState: null,
    docsComplete: 0,
    retroDone: 0,
    createdAt: now,
    updatedAt: now,
  }).run();
}

/** buildDbSnapshotState only trusts a snapshot that a completed generate_plan run produced. */
function seedCompletedPlanRun() {
  const now = new Date().toISOString();
  db.insert(runs).values({
    id: `RUN-${changeId}`,
    changeId,
    phase: "generate_plan",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "Plan generated",
    jobId: null,
    workerId: null,
    leaseToken: null,
    attemptNo: 1,
    provider: "codex",
  }).run();
}

function modelPlan(overrides: Partial<PlanJson> = {}): PlanJson {
  return {
    planName: "Rate limiter rollout",
    expectedFiles: ["src/index.js"],
    forbiddenFiles: ["package.json"],
    implementationSteps: [
      {
        step: 1,
        description: "Implement the token bucket.",
        file: "src/index.js",
        status: "pending",
      },
    ],
    testPlan: MODEL_TEST_PLAN,
    validationCommands: VALIDATION_COMMANDS,
    risks: MODEL_RISKS,
    ...overrides,
  };
}

describe("plan-snapshot-service model-authored fields", () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    testCounter += 1;
    projectId = `${PROJECT_ID_PREFIX}${process.pid}-${testCounter}`;
    changeId = `${CHANGE_ID_PREFIX}${process.pid}-${testCounter}`;
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "plan-snapshot-"));
    seedChange(repoPath);
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  // Face A: risks were hardcoded away, so the model's RISK lines never reached the DB.
  it("round-trips the model's risks through the DB snapshot", () => {
    const snapshotId = persistGeneratedPlanSnapshot({ changeId, repoPath, plan: modelPlan() });

    const restored = planFromDbSnapshot(snapshotId);

    assert.deepEqual(restored.risks, MODEL_RISKS);
  });

  // Face B: testPlan was aliased to validationCommands, so it read as "present"
  // while carrying entirely different content.
  it("round-trips the model's testPlan without aliasing it to validationCommands", () => {
    const snapshotId = persistGeneratedPlanSnapshot({ changeId, repoPath, plan: modelPlan() });

    const restored = planFromDbSnapshot(snapshotId);

    assert.deepEqual(restored.testPlan, MODEL_TEST_PLAN);
    assert.deepEqual(restored.validationCommands, VALIDATION_COMMANDS);
    assert.notDeepEqual(restored.testPlan, restored.validationCommands);
  });

  it("writes the model's testPlan and risks into the plan.json mirror", () => {
    const snapshotId = persistGeneratedPlanSnapshot({ changeId, repoPath, plan: modelPlan() });
    writePlanMirrorsFromDb(repoPath, changeId, snapshotId);

    const mirror = JSON.parse(
      fs.readFileSync(path.join(repoPath, ".ship", "changes", changeId, "plan.json"), "utf-8")
    ) as PlanJson;

    assert.deepEqual(mirror.testPlan, MODEL_TEST_PLAN);
    assert.deepEqual(mirror.risks, MODEL_RISKS);
    assert.deepEqual(mirror.validationCommands, VALIDATION_COMMANDS);
    assert.notDeepEqual(mirror.testPlan, mirror.validationCommands);
  });

  it("renders the model's testPlan and risks into the plan.md mirror", () => {
    const snapshotId = persistGeneratedPlanSnapshot({ changeId, repoPath, plan: modelPlan() });
    writePlanMirrorsFromDb(repoPath, changeId, snapshotId);

    const markdown = fs.readFileSync(
      path.join(repoPath, ".ship", "changes", changeId, "plan.md"),
      "utf-8"
    );

    assert.match(markdown, /## Test Plan/);
    assert.match(markdown, /## Risks/);
    for (const item of MODEL_TEST_PLAN) assert.ok(markdown.includes(item), `plan.md lost: ${item}`);
    for (const item of MODEL_RISKS) assert.ok(markdown.includes(item), `plan.md lost: ${item}`);
  });

  it("surfaces the model's testPlan and risks in the state the UI reads", () => {
    persistGeneratedPlanSnapshot({ changeId, repoPath, plan: modelPlan() });
    seedCompletedPlanRun();

    const state = getPlanSandboxState(changeId);

    assert.deepEqual(state.plan?.testPlan, MODEL_TEST_PLAN);
    assert.deepEqual(state.plan?.risks, MODEL_RISKS);
    assert.notDeepEqual(state.plan?.testPlan, state.plan?.validationCommands);
    assert.match(state.planMarkdown ?? "", /## Test Plan/);
  });

  // The protocol's RISK lines carry no severity. Recording them must not invent one.
  it("does not turn model risks into structured risks or gate blockers", () => {
    const snapshotId = persistGeneratedPlanSnapshot({ changeId, repoPath, plan: modelPlan() });

    const structuredRisks = db
      .select()
      .from(planRisks)
      .where(eq(planRisks.planSnapshotId, snapshotId))
      .all();
    const gate = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, changeId))
      .all()
      .at(-1);

    assert.equal(structuredRisks.length, 0);
    assert.equal(gate?.status, "passed");
    assert.deepEqual(JSON.parse(gate?.blockersJson ?? "[]"), []);
  });

  // Without the model-authored fields in the snapshot hash, a plan that changed
  // only its test plan or risks would reuse the previous snapshot and the new
  // content would never be written.
  it("does not reuse a snapshot when only the testPlan or risks changed", () => {
    const first = persistGeneratedPlanSnapshot({ changeId, repoPath, plan: modelPlan() });
    const secondTestPlan = persistGeneratedPlanSnapshot({
      changeId,
      repoPath,
      plan: modelPlan({ testPlan: ["完全不同的测试计划"] }),
    });
    const thirdRisks = persistGeneratedPlanSnapshot({
      changeId,
      repoPath,
      plan: modelPlan({ testPlan: ["完全不同的测试计划"], risks: ["完全不同的风险"] }),
    });

    assert.notEqual(secondTestPlan, first);
    assert.notEqual(thirdRisks, secondTestPlan);
    assert.deepEqual(planFromDbSnapshot(thirdRisks).risks, ["完全不同的风险"]);
  });

  // Snapshots written before the columns existed must degrade to empty, never to
  // the validation commands.
  it("returns empty model fields for legacy snapshots instead of aliasing", () => {
    const snapshotId = persistGeneratedPlanSnapshot({ changeId, repoPath, plan: modelPlan() });
    db.update(planSnapshots)
      .set({ testPlanJson: null, modelRisksJson: null })
      .where(eq(planSnapshots.id, snapshotId))
      .run();

    const restored = planFromDbSnapshot(snapshotId);

    assert.deepEqual(restored.testPlan, []);
    assert.deepEqual(restored.risks, []);
    assert.deepEqual(restored.validationCommands, VALIDATION_COMMANDS);
  });
});
