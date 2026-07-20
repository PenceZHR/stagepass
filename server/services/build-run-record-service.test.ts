import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "../db/schema.ts";
import {
  assertBuildRecordFresh,
  getLatestAdoptedBuildRecord,
  recordBuildRunRecord,
  recordBuildRunFromWorkspaceFile,
  setBuildRunRecordDbForTest,
} from "./build-run-record-service.ts";
import { writeBuildRun, type BuildRunFile } from "./build-workspace-service.ts";

const CHANGE_ID = "CHG-BRR";

const tempDirs: string[] = [];
let restoreDb: (() => void) | null = null;
let testDb: ReturnType<typeof makeTestDb> | null = null;

function makeTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE build_run_records (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      run_id TEXT,
      build_run_id TEXT,
      status TEXT NOT NULL,
      head_sha TEXT,
      base_head_sha TEXT,
      base_commit TEXT,
      patch_hash TEXT,
      changed_files_hash TEXT,
      adopted_head_sha TEXT,
      adoption_decision_id TEXT,
      adopted_at TEXT,
      artifact_hash TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_build_run_records_change_status_adopted
      ON build_run_records (change_id, status, adopted_at);
  `);
  return drizzle(sqlite, { schema });
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "build-run-record-repo-"));
  tempDirs.push(repo);
  return repo;
}

function makeBuildRun(overrides: Partial<BuildRunFile> = {}): BuildRunFile {
  const now = new Date().toISOString();
  return {
    changeId: CHANGE_ID,
    runNumber: 1,
    status: "created",
    baseCommit: "0".repeat(40),
    workspacePath: "/tmp/workspace",
    branchName: "stagepass/build/CHG-BRR/build-1",
    expectedFiles: [],
    forbiddenFiles: [],
    changedFiles: [],
    deviations: [],
    blockers: [],
    patchPath: null,
    patchSha256: null,
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("build run DB records", () => {
  beforeEach(() => {
    testDb = makeTestDb();
    restoreDb = setBuildRunRecordDbForTest(testDb);
  });

  afterEach(() => {
    restoreDb?.();
    restoreDb = null;
    testDb = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records and reads the latest adopted build from DB after the workspace file is removed", () => {
    const repo = makeRepo();
    writeBuildRun(
      repo,
      makeBuildRun({
        runNumber: 1,
        status: "adopted",
        adoptedHeadSha: "1".repeat(40),
        patchSha256: "artifact-1",
        updatedAt: "2026-06-29T01:00:00.000Z",
      }),
    );
    writeBuildRun(
      repo,
      makeBuildRun({
        runNumber: 2,
        status: "adopted",
        adoptedHeadSha: "2".repeat(40),
        patchSha256: "artifact-2",
        updatedAt: "2026-06-29T02:00:00.000Z",
      }),
    );

    recordBuildRunFromWorkspaceFile(repo, CHANGE_ID);
    fs.rmSync(path.join(repo, ".ship"), { recursive: true, force: true });

    const latest = getLatestAdoptedBuildRecord(CHANGE_ID);
    assert.ok(latest);
    assert.equal(latest.buildRunId, "build-2");
    assert.equal(latest.headSha, "2".repeat(40));
    assert.equal(latest.artifactHash, "artifact-2");
  });

  it("records DB-authoritative adoption and freshness fields from a workspace run", () => {
    const repo = makeRepo();
    writeBuildRun(
      repo,
      makeBuildRun({
        runNumber: 3,
        status: "adopted",
        baseCommit: "a".repeat(40),
        adoptedHeadSha: "b".repeat(40),
        patchSha256: "patch-hash-3",
        changedFiles: ["src/app.ts", "package.json"],
        updatedAt: "2026-06-29T05:00:00.000Z",
      }),
    );

    const record = recordBuildRunFromWorkspaceFile(repo, CHANGE_ID);

    assert.equal(record.buildRunId, "build-3");
    assert.equal(record.status, "adopted");
    assert.equal(record.baseHeadSha, "a".repeat(40));
    assert.equal(record.baseCommit, "a".repeat(40));
    assert.equal(record.patchHash, "patch-hash-3");
    assert.match(record.changedFilesHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(record.adoptedHeadSha, "b".repeat(40));
    assert.equal(record.headSha, "b".repeat(40));
    assert.equal(record.adoptedAt, "2026-06-29T05:00:00.000Z");
  });

  it("does not runtime import the default DB at module load", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "build-run-record-service.ts"),
      "utf-8",
    );

    assert.doesNotMatch(
      source,
      /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']\.\.\/db\/index(?:\.ts)?["'];?/m,
    );
  });

  it("is idempotent when recording the same adopted workspace run repeatedly", () => {
    const repo = makeRepo();
    writeBuildRun(
      repo,
      makeBuildRun({
        status: "adopted",
        adoptedHeadSha: "6".repeat(40),
        patchSha256: "artifact-stable",
        createdAt: "2026-06-29T03:00:00.000Z",
        updatedAt: "2026-06-29T03:01:00.000Z",
      }),
    );

    const first = recordBuildRunFromWorkspaceFile(repo, CHANGE_ID);
    const second = recordBuildRunFromWorkspaceFile(repo, CHANGE_ID);
    assert.ok(testDb);
    const rows = testDb
      .select()
      .from(schema.buildRunRecords)
      .where(eq(schema.buildRunRecords.changeId, CHANGE_ID))
      .all();

    assert.equal(rows.length, 1);
    assert.equal(second.id, first.id);
    assert.equal(second.buildRunId, first.buildRunId);
    assert.equal(second.status, "adopted");
    assert.equal(second.headSha, "6".repeat(40));
    assert.equal(second.artifactHash, "artifact-stable");
    assert.equal(second.source, "workspace_file");
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.updatedAt, first.updatedAt);
  });

  it("updates an existing build record while preserving the original createdAt", () => {
    const first = recordBuildRunRecord({
      changeId: CHANGE_ID,
      buildRunId: "build-7",
      status: "created",
      headSha: "7".repeat(40),
      source: "test",
      createdAt: "2026-06-29T04:00:00.000Z",
      updatedAt: "2026-06-29T04:01:00.000Z",
    });
    const second = recordBuildRunRecord({
      changeId: CHANGE_ID,
      buildRunId: "build-7",
      status: "adopted",
      headSha: "8".repeat(40),
      adoptedAt: "2026-06-29T04:02:00.000Z",
      artifactHash: "artifact-updated",
      source: "test",
      createdAt: "2026-06-29T04:03:00.000Z",
      updatedAt: "2026-06-29T04:04:00.000Z",
    });

    assert.equal(second.id, first.id);
    assert.equal(second.status, "adopted");
    assert.equal(second.headSha, "8".repeat(40));
    assert.equal(second.baseHeadSha, null);
    assert.equal(second.baseCommit, null);
    assert.equal(second.patchHash, null);
    assert.equal(second.changedFilesHash, null);
    assert.equal(second.adoptedHeadSha, null);
    assert.equal(second.adoptionDecisionId, null);
    assert.equal(second.artifactHash, "artifact-updated");
    assert.equal(second.createdAt, "2026-06-29T04:00:00.000Z");
    assert.equal(second.updatedAt, "2026-06-29T04:04:00.000Z");
  });

  it("rejects a workspace run object whose changeId differs from the requested change", () => {
    const repo = makeRepo();
    const run = makeBuildRun({ changeId: "CHG-OTHER" });

    assert.throws(
      () => recordBuildRunFromWorkspaceFile(repo, CHANGE_ID, run),
      /changeId mismatch/i,
    );
  });

  it("treats a forged adopted .ship file as stale when DB has no adopted record", () => {
    const repo = makeRepo();
    writeBuildRun(
      repo,
      makeBuildRun({
        status: "adopted",
        adoptedHeadSha: "3".repeat(40),
        patchSha256: "artifact-forged",
      }),
    );

    assert.throws(
      () => assertBuildRecordFresh(CHANGE_ID, "3".repeat(40)),
      /not found/i,
    );
  });

  it("treats an adopted DB record as stale when the expected HEAD differs", () => {
    const repo = makeRepo();
    writeBuildRun(
      repo,
      makeBuildRun({
        status: "adopted",
        adoptedHeadSha: "4".repeat(40),
        patchSha256: "artifact-4",
      }),
    );
    recordBuildRunFromWorkspaceFile(repo, CHANGE_ID);

    assert.throws(
      () => assertBuildRecordFresh(CHANGE_ID, "5".repeat(40)),
      /head.*mismatch|stale/i,
    );
  });
});
