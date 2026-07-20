import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, like } from "drizzle-orm";
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
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
} from "../db/schema.ts";
import {
  approvePlanSnapshot,
  assertPlanCanApprove,
  getPlanSandboxState,
  regeneratePlanReport,
  waivePlanRisk,
  type PlanJson,
  type PlanRisk,
} from "./plan-sandbox-service.ts";
import { deleteChangeRecords } from "./change-service.ts";

const PROJECT_ID_PREFIX = "PRJ-PLAN-SANDBOX-SERVICE-";
const CHANGE_ID_PREFIX = "CHG-PLAN-SANDBOX-SERVICE-";
let projectId = `${PROJECT_ID_PREFIX}initial`;
let changeId = `${CHANGE_ID_PREFIX}initial`;
let testCounter = 0;
let extraPaths: string[] = [];

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
  db.delete(changes).where(like(changes.id, `${CHANGE_ID_PREFIX}%`)).run();
  db.delete(projects).where(like(projects.id, `${PROJECT_ID_PREFIX}%`)).run();
}

function seedChange(repoPath: string, status = "PLAN_READY") {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: projectId,
    name: "Plan Sandbox",
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
    title: "Plan sandbox change",
    status,
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

function changePath(repoPath: string, ...segments: string[]) {
  return path.join(repoPath, ".ship", "changes", changeId, ...segments);
}

function writeChangeFile(repoPath: string, fileName: string, content: string) {
  const filePath = changePath(repoPath, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function validPlan(overrides: Partial<PlanJson> = {}): PlanJson {
  return {
    planName: "Plan sandbox rollout",
    allowedFiles: ["server/services/plan-sandbox-service.ts"],
    forbiddenFiles: ["server/services/pipeline-service.ts"],
    implementationSteps: [
      {
        step: 1,
        description: "Implement the deterministic service.",
        file: "server/services/plan-sandbox-service.ts",
        status: "pending",
      },
    ],
    testPlan: ["pnpm test server/services/plan-sandbox-service.test.ts"],
    validationCommands: ["pnpm test server/services/plan-sandbox-service.test.ts"],
    risks: [],
    ...overrides,
  };
}

function writePlan(repoPath: string, plan: PlanJson = validPlan()) {
  writeChangeFile(repoPath, "plan.json", `${JSON.stringify(plan, null, 2)}\n`);
  writeChangeFile(repoPath, "plan.md", "# Plan\n");
}

function risk(overrides: Partial<PlanRisk> = {}): PlanRisk {
  return {
    id: "risk-1",
    severity: "P1",
    category: "scope",
    title: "Scope can drift",
    evidence: "Plan mentions additional files.",
    requiredPlanChange: "Restrict allowed files.",
    affectedStepNumbers: [1],
    status: "open",
    waiverReason: null,
    ...overrides,
  };
}

function writeCritique(repoPath: string, risks: PlanRisk[]) {
  writeChangeFile(repoPath, "plan-critique.json", `${JSON.stringify({ risks }, null, 2)}\n`);
}

function createExternalPath(name: string) {
  const filePath = path.join(
    os.tmpdir(),
    `plan-sandbox-service-${process.pid}-${testCounter}-${name}`
  );
  extraPaths.push(filePath);
  return filePath;
}

function writeExternalFile(name: string, content: string) {
  const filePath = createExternalPath(name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("plan-sandbox-service", () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    testCounter += 1;
    projectId = `${PROJECT_ID_PREFIX}${process.pid}-${testCounter}`;
    changeId = `${CHANGE_ID_PREFIX}${process.pid}-${testCounter}`;
    extraPaths = [];
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sandbox-"));
    seedChange(repoPath);
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
    for (const filePath of extraPaths) {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  });

  it("blocks approval when plan.json or plan.md is missing", () => {
    let state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.match(state.gate.missingFields.join(","), /plan\.json/);
    assert.match(state.gate.missingFields.join(","), /plan\.md/);

    writeChangeFile(repoPath, "plan.json", `${JSON.stringify(validPlan(), null, 2)}\n`);
    state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.match(state.gate.missingFields.join(","), /plan\.md/);
  });

  it("blocks approval instead of throwing when plan.json is invalid", () => {
    writeChangeFile(repoPath, "plan.json", "{not-json");
    writeChangeFile(repoPath, "plan.md", "# Plan\n");

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.match(state.gate.missingFields.join(","), /invalid_plan_json|plan\.json/);
  });

  it("blocks approval instead of throwing when plan-critique.json is invalid", () => {
    writePlan(repoPath);
    writeChangeFile(repoPath, "plan-critique.json", "{not-json");

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.match(state.gate.missingFields.join(","), /invalid_plan_critique/);
  });

  it("blocks approval when validationCommands is empty", () => {
    writePlan(repoPath, validPlan({ validationCommands: [] }));
    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.blockingP0, 1);
    assert.match(state.gate.missingFields.join(","), /validationCommands/);
  });

  it("blocks approval when planName is blank", () => {
    writePlan(repoPath, validPlan({ planName: "   " }));

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.blockingP0, 1);
    assert.match(state.gate.missingFields.join(","), /planName/);
    assert.equal(state.plan?.planName, `${changeId} Plan`);
  });

  it("keeps regenerated reports blocked when planName is blank", () => {
    writePlan(repoPath, validPlan({ planName: "   " }));

    const state = regeneratePlanReport(changeId);
    const report = fs.readFileSync(changePath(repoPath, "reports", "plan-report.md"), "utf-8");

    assert.equal(state.gate.canApprove, false);
    assert.match(state.gate.missingFields.join(","), /planName/);
    assert.match(report, /Verdict: blocked/);
    assert.match(report, /Missing fields: .*planName/);
  });

  it("normalizes legacy task statuses to pending for display", () => {
    writePlan(
      repoPath,
      validPlan({
        implementationSteps: [
          {
            step: 1,
            description: "Legacy task without status.",
            file: "server/services/plan-sandbox-service.ts",
          },
        ],
      })
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.plan?.implementationSteps?.[0]?.status, "pending");
  });

  it("blocks approval when implementation steps are not continuous", () => {
    writePlan(
      repoPath,
      validPlan({
        implementationSteps: [
          { step: 1, description: "First", file: "server/services/plan-sandbox-service.ts" },
          { step: 3, description: "Third", file: "server/services/plan-sandbox-service.ts" },
        ],
      })
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.blockingP0, 1);
    assert.match(state.gate.missingFields.join(","), /step_sequence/);
  });

  it("blocks approval when an implementation step file is outside allowedFiles", () => {
    writePlan(
      repoPath,
      validPlan({
        implementationSteps: [
          { step: 1, description: "Edit service", file: "server/services/pipeline-service.ts" },
        ],
      })
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.blockingP0, 1);
    assert.match(state.gate.missingFields.join(","), /expectedFiles/);
  });

  it("blocks approval when an allowed file path is absolute", () => {
    const absoluteFile = path.join(repoPath, "outside.ts");
    writePlan(
      repoPath,
      validPlan({
        allowedFiles: [absoluteFile],
        forbiddenFiles: [],
        implementationSteps: [
          { step: 1, description: "Unsafe absolute path", file: absoluteFile },
        ],
      })
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.match(state.gate.missingFields.join(","), /unsafePath/);
  });

  it("blocks approval when a forbidden file path escapes with parent traversal", () => {
    writePlan(
      repoPath,
      validPlan({
        forbiddenFiles: ["../secret.ts"],
      })
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.match(state.gate.missingFields.join(","), /unsafePath/);
  });

  it("blocks approval when an implementation step file escapes with parent traversal", () => {
    writePlan(
      repoPath,
      validPlan({
        allowedFiles: ["server/services/plan-sandbox-service.ts", "../secret.ts"],
        implementationSteps: [
          { step: 1, description: "Unsafe step path", file: "../secret.ts" },
        ],
      })
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.match(state.gate.missingFields.join(","), /unsafePath/);
  });

  it("blocks approval when allowedFiles overlaps forbiddenFiles", () => {
    writePlan(
      repoPath,
      validPlan({
        forbiddenFiles: ["server/services/plan-sandbox-service.ts"],
      })
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.blockingP0, 1);
    assert.match(state.gate.missingFields.join(","), /forbiddenFiles/);
  });

  it("matches double-star globs at the directory root and nested paths", () => {
    writePlan(
      repoPath,
      validPlan({
        allowedFiles: ["server/**/*.ts"],
        forbiddenFiles: ["client/**/*.ts"],
        implementationSteps: [
          { step: 1, description: "Root file", file: "server/foo.ts" },
          { step: 2, description: "Nested file", file: "server/services/foo.ts" },
        ],
      })
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.missingFields.includes("expectedFiles"), false);
  });

  it("blocks approval when allowedFiles and forbiddenFiles globs overlap", () => {
    writePlan(
      repoPath,
      validPlan({
        allowedFiles: ["server/**/*.ts"],
        forbiddenFiles: ["server/services/*.ts"],
      })
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.blockingP0, 1);
    assert.match(state.gate.missingFields.join(","), /forbiddenFiles/);
  });

  it("blocks approval for an open P0 Plan Risk", () => {
    writePlan(repoPath);
    writeCritique(repoPath, [risk({ id: "risk-p0", severity: "P0" })]);
    regeneratePlanReport(changeId);

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.blockingP0, 1);
    assert.equal(state.gate.blockingP1, 0);
  });

  it("blocks approval for an open P1 Plan Risk", () => {
    writePlan(repoPath);
    writeCritique(repoPath, [risk({ id: "risk-p1", severity: "P1" })]);
    regeneratePlanReport(changeId);

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.blockingP0, 0);
    assert.equal(state.gate.blockingP1, 1);
  });

  it("does not block approval for a waived P1 Plan Risk with a reason", () => {
    writePlan(repoPath);
    writeCritique(repoPath, [
      risk({ id: "risk-p1", severity: "P1", status: "waived", waiverReason: "Accepted for MVP." }),
    ]);

    const state = regeneratePlanReport(changeId);

    assert.equal(state.gate.canApprove, true);
    assert.equal(state.gate.blockingP1, 0);
    assert.equal(state.risks[0]?.status, "waived");
    assert.equal(state.risks[0]?.waiverReason, "Accepted for MVP.");
  });

  it("blocks approval when the report is stale", () => {
    writePlan(repoPath);
    let state = regeneratePlanReport(changeId);
    assert.equal(state.gate.canApprove, true);

    writeChangeFile(repoPath, "plan.md", "# Plan\n\nChanged after report.\n");
    state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.stale, true);
    assert.equal(state.reportFresh, false);
  });

  it("treats a malformed report metadata line as stale instead of throwing", () => {
    writePlan(repoPath);
    const reportFile = changePath(repoPath, "reports", "plan-report.md");
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(
      reportFile,
      "<!-- plan-sandbox-source-hashes: {not-json} -->\n# Report\n"
    );

    const state = getPlanSandboxState(changeId);

    assert.equal(state.gate.canApprove, false);
    assert.equal(state.gate.stale, true);
    assert.equal(state.reportFresh, false);
  });

  it("writes plan-report.md and returns fresh state when regenerating the report", () => {
    writePlan(repoPath);

    const state = regeneratePlanReport(changeId);

    assert.equal(state.reportFresh, true);
    assert.equal(state.gate.stale, false);
    assert.equal(state.reportPath, changePath(repoPath, "reports", "plan-report.md"));
    assert.equal(fs.existsSync(state.reportPath), true);
    assert.match(fs.readFileSync(state.reportPath, "utf-8"), /Plan Sandbox Report/);
  });

  it("writes approved Plan authority to DB tables and renders plan mirrors from the snapshot", () => {
    writePlan(repoPath, validPlan({ allowedFiles: ["server/services/plan-sandbox-service.ts"] }));

    const state = regeneratePlanReport(changeId);

    assert.equal(state.gate.canApprove, true);
    const snapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, changeId))
      .get();
    assert.ok(snapshot);
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.planName, "Plan sandbox rollout");
    assert.deepEqual(JSON.parse(snapshot.expectedFilesJson ?? "[]"), [
      "server/services/plan-sandbox-service.ts",
    ]);
    assert.deepEqual(JSON.parse(snapshot.forbiddenFilesJson ?? "[]"), [
      "server/services/pipeline-service.ts",
    ]);
    assert.equal(
      db.select().from(planSteps).where(eq(planSteps.planSnapshotId, snapshot.id)).all().length,
      1
    );
    assert.equal(
      db
        .select()
        .from(requiredValidationCommands)
        .where(eq(requiredValidationCommands.sourceSnapshotId, snapshot.id))
        .all().length,
      1
    );
    assert.equal(
      db.select().from(stageReports).where(eq(stageReports.changeId, changeId)).all().length > 0,
      true
    );
    assert.equal(
      db
        .select()
        .from(stageGates)
        .where(and(eq(stageGates.changeId, changeId), eq(stageGates.phase, "Plan")))
        .get()?.status,
      "passed"
    );

    const mirror = JSON.parse(fs.readFileSync(changePath(repoPath, "plan.json"), "utf-8"));
    assert.deepEqual(mirror.expectedFiles, ["server/services/plan-sandbox-service.ts"]);
    assert.equal("allowedFiles" in mirror, false);

    const decisionId = approvePlanSnapshot(changeId);
    const approvedSnapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.id, snapshot.id))
      .get();
    assert.equal(approvedSnapshot?.status, "approved");
    assert.equal(approvedSnapshot?.approvalDecisionId, decisionId);
    assert.equal(
      db.select().from(planApprovals).where(eq(planApprovals.planSnapshotId, snapshot.id)).all()
        .length,
      1
    );
    assert.equal(
      db.select().from(humanDecisions).where(eq(humanDecisions.id, decisionId)).get()?.action,
      "approve_plan"
    );
  });

  it("rejects Plan approval when the gate source DB hash drifts from the latest snapshot", () => {
    writePlan(repoPath);
    regeneratePlanReport(changeId);

    const snapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, changeId))
      .get();
    assert.ok(snapshot?.snapshotDbHash);
    db.update(stageGates)
      .set({ sourceDbHash: `${snapshot.snapshotDbHash}-drifted` })
      .where(and(eq(stageGates.changeId, changeId), eq(stageGates.phase, "Plan")))
      .run();

    assert.throws(() => assertPlanCanApprove(changeId), /source_db_hash_drift/);
  });

  it("returns the existing Plan approval decision without writing duplicate approval rows", () => {
    writePlan(repoPath);
    regeneratePlanReport(changeId);

    const snapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, changeId))
      .get();
    assert.ok(snapshot);
    const firstDecisionId = approvePlanSnapshot(changeId);
    const decisionsBefore = db
      .select()
      .from(humanDecisions)
      .where(eq(humanDecisions.changeId, changeId))
      .all();
    const approvalsBefore = db
      .select()
      .from(planApprovals)
      .where(eq(planApprovals.planSnapshotId, snapshot.id))
      .all();

    const secondDecisionId = approvePlanSnapshot(changeId);

    assert.equal(secondDecisionId, firstDecisionId);
    assert.equal(
      db.select().from(humanDecisions).where(eq(humanDecisions.changeId, changeId)).all().length,
      decisionsBefore.length
    );
    assert.equal(
      db
        .select()
        .from(planApprovals)
        .where(eq(planApprovals.planSnapshotId, snapshot.id))
        .all().length,
      approvalsBefore.length
    );
    assert.equal(decisionsBefore.length, 1);
    assert.equal(approvalsBefore.length, 1);
  });

  it("maps legacy allowedFiles to expectedFiles when importing a Plan snapshot", () => {
    writePlan(
      repoPath,
      validPlan({
        allowedFiles: ["src/legacy.ts"],
        forbiddenFiles: [],
        implementationSteps: [
          { step: 1, description: "Edit legacy file", file: "src/legacy.ts" },
        ],
      })
    );

    regeneratePlanReport(changeId);

    const snapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, changeId))
      .get();
    assert.deepEqual(JSON.parse(snapshot?.expectedFilesJson ?? "[]"), ["src/legacy.ts"]);
    const mirror = JSON.parse(fs.readFileSync(changePath(repoPath, "plan.json"), "utf-8"));
    assert.deepEqual(mirror.expectedFiles, ["src/legacy.ts"]);
    assert.equal("allowedFiles" in mirror, false);
  });

  it("does not follow a symlink when writing plan-report.md", () => {
    writePlan(repoPath);
    const reportFile = changePath(repoPath, "reports", "plan-report.md");
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    const externalReport = writeExternalFile("outside-report.md", "outside report\n");
    fs.symlinkSync(externalReport, reportFile);

    assert.throws(() => regeneratePlanReport(changeId), /symlink/i);
    assert.equal(fs.readFileSync(externalReport, "utf-8"), "outside report\n");
  });

  it("does not create report directories through a .ship ancestor symlink", () => {
    const externalShipDir = createExternalPath("ship-ancestor-report");
    fs.mkdirSync(externalShipDir, { recursive: true });
    fs.symlinkSync(externalShipDir, path.join(repoPath, ".ship"));

    assert.throws(() => regeneratePlanReport(changeId), /symlink|outside/i);
    assert.equal(fs.existsSync(path.join(externalShipDir, "changes", changeId)), false);
  });

  it("does not create report directories through a .ship/changes ancestor symlink", () => {
    const externalChangesDir = createExternalPath("changes-ancestor-report");
    fs.mkdirSync(path.join(repoPath, ".ship"), { recursive: true });
    fs.mkdirSync(externalChangesDir, { recursive: true });
    fs.symlinkSync(externalChangesDir, path.join(repoPath, ".ship", "changes"));

    assert.throws(() => regeneratePlanReport(changeId), /symlink|outside/i);
    assert.equal(fs.existsSync(path.join(externalChangesDir, changeId)), false);
  });

  it("does not write plan-report.md when the reports directory is a symlink", () => {
    writePlan(repoPath);
    const externalReportsDir = createExternalPath("reports-dir");
    fs.mkdirSync(externalReportsDir, { recursive: true });
    const externalReport = path.join(externalReportsDir, "plan-report.md");
    fs.writeFileSync(externalReport, "outside report\n");
    fs.symlinkSync(externalReportsDir, changePath(repoPath, "reports"));

    assert.throws(() => regeneratePlanReport(changeId), /symlink/i);
    assert.equal(fs.readFileSync(externalReport, "utf-8"), "outside report\n");
  });

  it("does not follow a symlink when writing plan-critique.json", () => {
    writePlan(repoPath);
    const outsideContent = `${JSON.stringify({ risks: [risk({ id: "risk-p1" })] }, null, 2)}\n`;
    const externalCritique = writeExternalFile("outside-critique.json", outsideContent);
    fs.symlinkSync(externalCritique, changePath(repoPath, "plan-critique.json"));

    assert.throws(() => waivePlanRisk(changeId, "risk-p1", "Accepted risk."), /symlink/i);
    assert.equal(fs.readFileSync(externalCritique, "utf-8"), outsideContent);
  });

  it("does not create critique directories through a .ship ancestor symlink", () => {
    const externalShipDir = createExternalPath("ship-ancestor-critique");
    fs.mkdirSync(externalShipDir, { recursive: true });
    fs.symlinkSync(externalShipDir, path.join(repoPath, ".ship"));

    assert.throws(() => waivePlanRisk(changeId, "risk-p1", "Accepted risk."), /symlink|outside/i);
    assert.equal(fs.existsSync(path.join(externalShipDir, "changes", changeId)), false);
  });

  it("does not create critique directories through a .ship/changes ancestor symlink", () => {
    const externalChangesDir = createExternalPath("changes-ancestor-critique");
    fs.mkdirSync(path.join(repoPath, ".ship"), { recursive: true });
    fs.mkdirSync(externalChangesDir, { recursive: true });
    fs.symlinkSync(externalChangesDir, path.join(repoPath, ".ship", "changes"));

    assert.throws(() => waivePlanRisk(changeId, "risk-p1", "Accepted risk."), /symlink|outside/i);
    assert.equal(fs.existsSync(path.join(externalChangesDir, changeId)), false);
  });

  it("does not write plan-report.md when the change directory is a symlink", () => {
    const externalChangeDir = createExternalPath("change-dir-report");
    fs.mkdirSync(externalChangeDir, { recursive: true });
    fs.mkdirSync(path.dirname(changePath(repoPath)), { recursive: true });
    fs.rmSync(changePath(repoPath), { recursive: true, force: true });
    fs.symlinkSync(externalChangeDir, changePath(repoPath));
    fs.writeFileSync(path.join(externalChangeDir, "plan.json"), `${JSON.stringify(validPlan(), null, 2)}\n`);
    fs.writeFileSync(path.join(externalChangeDir, "plan.md"), "# Plan\n");

    assert.throws(() => regeneratePlanReport(changeId), /symlink/i);
    assert.equal(fs.existsSync(path.join(externalChangeDir, "reports", "plan-report.md")), false);
  });

  it("does not write plan-critique.json when the change directory is a symlink", () => {
    const externalChangeDir = createExternalPath("change-dir-critique");
    const critiqueContent = `${JSON.stringify({ risks: [risk({ id: "risk-p1" })] }, null, 2)}\n`;
    fs.mkdirSync(externalChangeDir, { recursive: true });
    fs.mkdirSync(path.dirname(changePath(repoPath)), { recursive: true });
    fs.rmSync(changePath(repoPath), { recursive: true, force: true });
    fs.symlinkSync(externalChangeDir, changePath(repoPath));
    fs.writeFileSync(path.join(externalChangeDir, "plan.json"), `${JSON.stringify(validPlan(), null, 2)}\n`);
    fs.writeFileSync(path.join(externalChangeDir, "plan.md"), "# Plan\n");
    fs.writeFileSync(path.join(externalChangeDir, "plan-critique.json"), critiqueContent);

    assert.throws(() => waivePlanRisk(changeId, "risk-p1", "Accepted risk."), /symlink/i);
    assert.equal(fs.readFileSync(path.join(externalChangeDir, "plan-critique.json"), "utf-8"), critiqueContent);
  });

  it("waives a P1 risk, records the reason, and returns a non-blocking fresh state", () => {
    writePlan(repoPath);
    writeCritique(repoPath, [risk({ id: "risk-p1", severity: "P1" })]);
    regeneratePlanReport(changeId);

    const state = waivePlanRisk(changeId, "risk-p1", "Human accepts the ordering risk.");

    assert.equal(state.reportFresh, true);
    assert.equal(state.gate.canApprove, true);
    assert.equal(state.gate.blockingP1, 0);
    assert.equal(state.risks[0]?.status, "waived");
    assert.equal(state.risks[0]?.waiverReason, "Human accepts the ordering risk.");

    const critique = JSON.parse(fs.readFileSync(changePath(repoPath, "plan-critique.json"), "utf-8"));
    assert.equal(critique.risks[0].status, "waived");
    assert.equal(critique.risks[0].waiverReason, "Human accepts the ordering risk.");
  });

  it("throws when asserting approval for a blocked gate", () => {
    writePlan(repoPath, validPlan({ validationCommands: [] }));

    assert.throws(() => assertPlanCanApprove(changeId), /Plan cannot be approved/);
  });
});
