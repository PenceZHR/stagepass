import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as schema from "../db/schema.ts";
import {
  inspectArtifactMirrors,
  rebuildArtifactMirror,
  renderMirrorsFromDb,
  setArtifactMirrorServiceDbForTest,
} from "./artifact-mirror-service.ts";

const PROJECT_ID = "PRJ-ARTIFACT-MIRROR";
const CHANGE_ID = "CHG-ARTIFACT-MIRROR";
const PHASE = "Plan";
const NOW = "2026-06-29T00:00:00.000Z";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      context_status TEXT NOT NULL DEFAULT 'pending',
      context_provider TEXT NOT NULL DEFAULT 'codex',
      prd_status TEXT NOT NULL DEFAULT 'none',
      prd_provider TEXT NOT NULL DEFAULT 'codex',
      prd_json TEXT,
      prd_markdown TEXT,
      git_enabled INTEGER NOT NULL DEFAULT 0,
      git_default_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE changes (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'codex',
      codex_thread_id TEXT,
      fix_iterations INTEGER DEFAULT 0,
      blocked_phase TEXT,
      rework_from_phase TEXT,
      suspended_by_prd INTEGER NOT NULL DEFAULT 0,
      pre_suspend_status TEXT,
      git_branch TEXT,
      gate_state TEXT,
      docs_complete INTEGER NOT NULL DEFAULT 0,
      retro_done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE stage_runs (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      idempotency_key TEXT,
      input_db_hash TEXT,
      output_db_hash TEXT,
      source_lineage_json TEXT,
      error_code TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE stage_reports (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      source_run_id TEXT,
      status TEXT NOT NULL,
      counts_json TEXT,
      is_fresh INTEGER NOT NULL DEFAULT 1,
      stale_reason TEXT,
      report_db_hash TEXT,
      generated_at TEXT NOT NULL
    );
    CREATE TABLE stage_gates (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      blockers_json TEXT,
      freshness_json TEXT,
      required_actions_json TEXT,
      source_db_hash TEXT,
      gate_version INTEGER NOT NULL DEFAULT 1,
      computed_at TEXT NOT NULL
    );
    CREATE TABLE stage_actions (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      action_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      reason_code TEXT,
      reason TEXT,
      blockers_json TEXT,
      gate_version INTEGER NOT NULL DEFAULT 1,
      source_db_hash TEXT,
      requires_idempotency_key INTEGER NOT NULL DEFAULT 0,
      computed_at TEXT NOT NULL
    );
    CREATE TABLE stage_states (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      latest_run_id TEXT,
      latest_report_id TEXT,
      latest_gate_id TEXT,
      latest_valid_report_id TEXT,
      db_hash TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE artifact_mirrors (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT,
      source_db_hash TEXT,
      schema_version TEXT,
      mirror_status TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function seedChange(db: ReturnType<typeof createTestDb>, repoPath: string) {
  db.insert(schema.projects).values({
    id: PROJECT_ID,
    name: "Artifact mirror",
    repoPath,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(schema.changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Artifact mirror change",
    status: "PLAN_APPROVED",
    provider: "codex",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(schema.stageRuns).values({
    id: "STG-RUN-MIRROR",
    changeId: CHANGE_ID,
    phase: PHASE,
    attemptNo: 1,
    status: "passed",
    inputDbHash: "input-db-hash",
    outputDbHash: "plan-report-db-hash",
    startedAt: NOW,
    completedAt: NOW,
  }).run();
  db.insert(schema.stageReports).values({
    id: "STG-RPT-MIRROR",
    changeId: CHANGE_ID,
    phase: PHASE,
    sourceRunId: "STG-RUN-MIRROR",
    status: "passed",
    countsJson: "{\"warnings\":0}",
    isFresh: 1,
    reportDbHash: "plan-report-db-hash",
    generatedAt: NOW,
  }).run();
  db.insert(schema.stageGates).values({
    id: "STG-GATE-MIRROR",
    changeId: CHANGE_ID,
    phase: PHASE,
    status: "passed",
    blockersJson: "[]",
    freshnessJson: "{\"fresh\":true}",
    requiredActionsJson: "[]",
    sourceDbHash: "plan-source-db-hash",
    gateVersion: 3,
    computedAt: NOW,
  }).run();
  db.insert(schema.stageActions).values({
    id: "STG-ACT-MIRROR",
    changeId: CHANGE_ID,
    phase: PHASE,
    actionId: "run_build",
    enabled: 1,
    reasonCode: null,
    reason: null,
    blockersJson: "[]",
    gateVersion: 3,
    sourceDbHash: "plan-source-db-hash",
    requiresIdempotencyKey: 1,
    computedAt: NOW,
  }).run();
  db.insert(schema.stageStates).values({
    id: "STG-STATE-MIRROR",
    changeId: CHANGE_ID,
    phase: PHASE,
    status: "passed",
    latestRunId: "STG-RUN-MIRROR",
    latestReportId: "STG-RPT-MIRROR",
    latestGateId: "STG-GATE-MIRROR",
    latestValidReportId: "STG-RPT-MIRROR",
    dbHash: "plan-source-db-hash",
    version: 1,
    updatedAt: NOW,
  }).run();
}

function authoritySnapshot(db: ReturnType<typeof createTestDb>) {
  return {
    gate: db.select().from(schema.stageGates).where(eq(schema.stageGates.id, "STG-GATE-MIRROR")).get(),
    action: db.select().from(schema.stageActions).where(eq(schema.stageActions.id, "STG-ACT-MIRROR")).get(),
    state: db.select().from(schema.stageStates).where(eq(schema.stageStates.id, "STG-STATE-MIRROR")).get(),
    report: db.select().from(schema.stageReports).where(eq(schema.stageReports.id, "STG-RPT-MIRROR")).get(),
  };
}

function insertMirrorRow(
  db: ReturnType<typeof createTestDb>,
  values: {
    id: string;
    artifactType?: string;
    path: string;
    contentHash: string | null;
    sourceDbHash?: string | null;
    schemaVersion?: string | null;
    mirrorStatus: string;
    generatedAt: string;
  },
) {
  db.insert(schema.artifactMirrors).values({
    id: values.id,
    changeId: CHANGE_ID,
    phase: PHASE,
    artifactType: values.artifactType ?? "plan_json",
    path: values.path,
    contentHash: values.contentHash,
    sourceDbHash: values.sourceDbHash ?? "plan-source-db-hash",
    schemaVersion: values.schemaVersion ?? "plan/v1",
    mirrorStatus: values.mirrorStatus,
    generatedAt: values.generatedAt,
  }).run();
}

describe("artifact-mirror-service", () => {
  let repoPath: string;
  let db: ReturnType<typeof createTestDb>;
  let restoreDb: (() => void) | null = null;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-mirror-"));
    db = createTestDb();
    restoreDb = setArtifactMirrorServiceDbForTest(db);
    seedChange(db, repoPath);
  });

  afterEach(() => {
    restoreDb?.();
    restoreDb = null;
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("renders JSON and Markdown mirrors from DB payloads and records metadata", () => {
    const before = authoritySnapshot(db);
    const results = renderMirrorsFromDb({
      db,
      repoPath,
      changeId: CHANGE_ID,
      generatedAt: NOW,
      mirrors: [
        {
          phase: PHASE,
          artifactType: "plan_json",
          fileName: "plan.json",
          schemaVersion: "plan/v1",
          sourceRows: [{ table: "plan_snapshots", id: "PLAN-1", status: "passed" }],
          payload: { status: "passed", allowedFiles: ["server/app.ts"] },
        },
        {
          phase: PHASE,
          artifactType: "plan_md",
          fileName: "plan.md",
          schemaVersion: "plan-md/v1",
          sourceDbHash: "plan-markdown-source-hash",
          renderer: () => "# Plan\n\n- server/app.ts\n",
        },
      ],
    });

    assert.deepEqual(results.map((result) => result.mirrorStatus), ["ok", "ok"]);
    const planJsonPath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "plan.json");
    assert.equal(
      fs.readFileSync(planJsonPath, "utf-8"),
      "{\n  \"allowedFiles\": [\n    \"server/app.ts\"\n  ],\n  \"status\": \"passed\"\n}\n",
    );
    assert.equal(fs.readFileSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "plan.md"), "utf-8"), "# Plan\n\n- server/app.ts\n");

    const mirrorRows = db
      .select()
      .from(schema.artifactMirrors)
      .where(eq(schema.artifactMirrors.changeId, CHANGE_ID))
      .all()
      .sort((left, right) => left.artifactType.localeCompare(right.artifactType));
    assert.equal(mirrorRows.length, 2);
    assert.equal(mirrorRows[0].artifactType, "plan_json");
    assert.equal(mirrorRows[0].mirrorStatus, "ok");
    assert.equal(mirrorRows[0].contentHash, sha256Text(fs.readFileSync(planJsonPath, "utf-8")));
    assert.equal(mirrorRows[0].schemaVersion, "plan/v1");

    assert.deepEqual(authoritySnapshot(db), before);
  });

  it("keeps missing and mismatched mirror states out of stage authority and actions", () => {
    renderMirrorsFromDb({
      db,
      repoPath,
      changeId: CHANGE_ID,
      generatedAt: NOW,
      mirrors: [
        {
          phase: PHASE,
          artifactType: "plan_json",
          fileName: "plan.json",
          schemaVersion: "plan/v1",
          sourceDbHash: "plan-source-db-hash",
          payload: { gate: "passed", requiredActions: ["run_build"] },
        },
      ],
    });
    const planJsonPath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "plan.json");
    const before = authoritySnapshot(db);

    fs.rmSync(planJsonPath);
    const missing = inspectArtifactMirrors(CHANGE_ID, PHASE);
    assert.equal(missing[0]?.mirrorStatus, "missing");
    assert.match(missing[0]?.warning ?? "", /file_missing/);
    assert.deepEqual(authoritySnapshot(db), before);

    const rebuilt = rebuildArtifactMirror({
      db,
      repoPath,
      changeId: CHANGE_ID,
      generatedAt: NOW,
      mirror: {
        phase: PHASE,
        artifactType: "plan_json",
        fileName: "plan.json",
        schemaVersion: "plan/v1",
        sourceDbHash: "plan-source-db-hash",
        payload: { gate: "passed", requiredActions: ["run_build"] },
      },
    });
    assert.equal(rebuilt.mirrorStatus, "ok");
    assert.equal(JSON.parse(fs.readFileSync(planJsonPath, "utf-8")).gate, "passed");

    fs.writeFileSync(planJsonPath, "{\"gate\":\"failed\",\"requiredActions\":[]}\n", "utf-8");
    const mismatch = inspectArtifactMirrors(CHANGE_ID, PHASE);
    assert.equal(mismatch[0]?.mirrorStatus, "mismatch");
    assert.match(mismatch[0]?.warning ?? "", /content_hash_mismatch/);
    assert.equal(db.select().from(schema.stageGates).where(eq(schema.stageGates.id, "STG-GATE-MIRROR")).get()?.status, "passed");
    assert.deepEqual(authoritySnapshot(db), before);
  });

  it("rebuilds tampered mirror files from the DB snapshot payload", () => {
    const mirror = {
      phase: PHASE,
      artifactType: "plan_json",
      fileName: "plan.json",
      schemaVersion: "plan/v1",
      sourceDbHash: "plan-source-db-hash",
      payload: { gate: "passed", requiredActions: ["run_build"] },
    } as const;
    renderMirrorsFromDb({ db, repoPath, changeId: CHANGE_ID, generatedAt: NOW, mirrors: [mirror] });
    const planJsonPath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "plan.json");

    fs.writeFileSync(planJsonPath, "{\"gate\":\"failed\"}\n", "utf-8");
    rebuildArtifactMirror({ db, repoPath, changeId: CHANGE_ID, generatedAt: NOW, mirror });

    assert.equal(JSON.parse(fs.readFileSync(planJsonPath, "utf-8")).gate, "passed");
  });

  it("rejects mirror paths that escape .ship/changes/changeId", () => {
    assert.throws(
      () =>
        renderMirrorsFromDb({
          db,
          repoPath,
          changeId: CHANGE_ID,
          mirrors: [
            {
              phase: PHASE,
              artifactType: "plan_json",
              fileName: "../outside.json",
              schemaVersion: "plan/v1",
              payload: { gate: "passed" },
            },
          ],
        }),
      /outside this change/,
    );
    assert.equal(fs.existsSync(path.join(repoPath, ".ship", "changes", "outside.json")), false);
  });

  it("marks symlink mirror files corrupt without reading their targets", (t) => {
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-mirror-outside-"));
    const externalFile = path.join(externalDir, "outside-plan.json");
    const mirrorPath = path.join(changeDir, "plan.json");
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(externalFile, "{\"gate\":\"passed\"}\n", "utf-8");

    try {
      fs.symlinkSync(externalFile, mirrorPath);
    } catch (error) {
      fs.rmSync(externalDir, { recursive: true, force: true });
      t.skip(`symlink creation is not supported here: ${String(error)}`);
      return;
    }

    insertMirrorRow(db, {
      id: "AMR-SYMLINK-FILE",
      path: mirrorPath,
      contentHash: sha256Text(fs.readFileSync(externalFile, "utf-8")),
      mirrorStatus: "ok",
      generatedAt: "2026-06-29T00:01:00.000Z",
    });

    const warnings = inspectArtifactMirrors(CHANGE_ID, PHASE);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.id, "AMR-SYMLINK-FILE");
    assert.equal(warnings[0]?.mirrorStatus, "corrupt");
    assert.match(warnings[0]?.warning ?? "", /path_outside_change|symlink/);
    assert.equal(
      db.select().from(schema.artifactMirrors).where(eq(schema.artifactMirrors.id, "AMR-SYMLINK-FILE")).get()
        ?.mirrorStatus,
      "corrupt",
    );

    fs.rmSync(externalDir, { recursive: true, force: true });
  });

  it("marks mirrors under symlink directories corrupt without reading their targets", (t) => {
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-mirror-linked-dir-"));
    const linkedReportsDir = path.join(changeDir, "reports");
    const externalFile = path.join(externalDir, "plan-report.md");
    const mirrorPath = path.join(linkedReportsDir, "plan-report.md");
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(externalFile, "# External report\n", "utf-8");

    try {
      fs.symlinkSync(externalDir, linkedReportsDir, "dir");
    } catch (error) {
      fs.rmSync(externalDir, { recursive: true, force: true });
      t.skip(`directory symlink creation is not supported here: ${String(error)}`);
      return;
    }

    insertMirrorRow(db, {
      id: "AMR-SYMLINK-DIR",
      artifactType: "plan_report",
      path: mirrorPath,
      contentHash: sha256Text(fs.readFileSync(externalFile, "utf-8")),
      schemaVersion: "plan-report/v1",
      mirrorStatus: "ok",
      generatedAt: "2026-06-29T00:01:00.000Z",
    });

    const warnings = inspectArtifactMirrors(CHANGE_ID, PHASE);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.id, "AMR-SYMLINK-DIR");
    assert.equal(warnings[0]?.mirrorStatus, "corrupt");
    assert.match(warnings[0]?.warning ?? "", /path_outside_change|symlink/);

    fs.rmSync(externalDir, { recursive: true, force: true });
  });

  it("inspects and rebuilds only the latest mirror row for the same artifact path", () => {
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    const mirrorPath = path.join(changeDir, "plan.json");
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(mirrorPath, "{\"gate\":\"passed\"}\n", "utf-8");
    insertMirrorRow(db, {
      id: "AMR-HISTORY-OLD",
      path: mirrorPath,
      contentHash: "old-wrong-hash",
      mirrorStatus: "mismatch",
      generatedAt: "2026-06-29T00:01:00.000Z",
    });
    insertMirrorRow(db, {
      id: "AMR-HISTORY-NEW",
      path: mirrorPath,
      contentHash: sha256Text(fs.readFileSync(mirrorPath, "utf-8")),
      mirrorStatus: "ok",
      generatedAt: "2026-06-29T00:02:00.000Z",
    });

    assert.deepEqual(inspectArtifactMirrors(CHANGE_ID, PHASE), []);

    rebuildArtifactMirror({
      db,
      repoPath,
      changeId: CHANGE_ID,
      generatedAt: "2026-06-29T00:03:00.000Z",
      mirror: {
        phase: PHASE,
        artifactType: "plan_json",
        fileName: "plan.json",
        schemaVersion: "plan/v1",
        sourceDbHash: "plan-source-db-hash",
        payload: { gate: "passed", requiredActions: ["run_build"] },
      },
    });

    const oldRow = db
      .select()
      .from(schema.artifactMirrors)
      .where(eq(schema.artifactMirrors.id, "AMR-HISTORY-OLD"))
      .get();
    const newRow = db
      .select()
      .from(schema.artifactMirrors)
      .where(eq(schema.artifactMirrors.id, "AMR-HISTORY-NEW"))
      .get();
    assert.equal(oldRow?.mirrorStatus, "mismatch");
    assert.equal(oldRow?.generatedAt, "2026-06-29T00:01:00.000Z");
    assert.equal(newRow?.mirrorStatus, "ok");
    assert.equal(newRow?.generatedAt, "2026-06-29T00:03:00.000Z");
    assert.equal(JSON.parse(fs.readFileSync(mirrorPath, "utf-8")).requiredActions[0], "run_build");
  });
});
