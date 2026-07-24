import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, isNull, and, like } from "drizzle-orm";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../db/schema.ts";
import { runMigrations } from "../db/migrate.ts";
import { db as appDb } from "../db/index.ts";
import { deleteProject, getProject } from "./project-service.ts";
import { createChange } from "./change-service.ts";
import { branchExists } from "./repository-evidence-service.ts";

const {
  projects, changes, runs, events, artifacts, findings,
  codexThreadBindings, projectAiRuns, codexLogicalTurns,
  codexFollowerStartAttempts, codexBindingRunLeases, codexTurnExecutions,
} = schema;
const __dirname = dirname(fileURLToPath(import.meta.url));

function setupTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = OFF");

  sqlite.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL UNIQUE,
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
      id TEXT PRIMARY KEY,
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
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      change_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      summary TEXT,
      job_id TEXT,
      worker_id TEXT,
      lease_token TEXT,
      attempt_no INTEGER,
      provider TEXT
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      change_id TEXT,
      run_id TEXT,
      type TEXT NOT NULL,
      message TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      change_id TEXT NOT NULL,
      run_id TEXT,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE findings (
      id TEXT PRIMARY KEY,
      change_id TEXT NOT NULL,
      run_id TEXT,
      round_id TEXT,
      phase TEXT,
      source TEXT NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      file TEXT,
      line INTEGER,
      evidence TEXT,
      required_fix TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      review_attempt_id TEXT,
      source_build_run_id TEXT,
      source_head_sha TEXT,
      waivable INTEGER NOT NULL DEFAULT 0,
      waived_by TEXT,
      waived_at TEXT,
      waiver_decision_id TEXT,
      legacy_state TEXT,
      legacy_finding_key TEXT,
      finding_version INTEGER NOT NULL DEFAULT 1
    );
  `);
  runMigrations(sqlite);

  return drizzle(sqlite, { schema });
}

function seedProject(db: ReturnType<typeof setupTestDb>, repoPath: string) {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: "PRJ-001",
      name: "Test",
      repoPath,
      contextStatus: "pending",
      contextProvider: "codex",
      prdStatus: "none",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(changes)
    .values({
      id: "CHG-001",
      projectId: "PRJ-001",
      title: "feat: test",
      status: "DONE",
      provider: "codex",
      codexThreadId: null,
      fixIterations: 0,
      blockedPhase: null,
      reworkFromPhase: null,
      suspendedByPrd: 0,
      preSuspendStatus: null,
      gitBranch: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(runs)
    .values({ id: "RUN-001", changeId: "CHG-001", phase: "implement", status: "success", startedAt: now, endedAt: now, summary: null })
    .run();
  db.insert(events)
    .values({ id: "EVT-001", changeId: "CHG-001", runId: "RUN-001", type: "run_started", message: "started", rawJson: null, createdAt: now })
    .run();
  db.insert(events)
    .values({ id: "EVT-002", changeId: null, runId: null, type: "project_created", message: "Project created", rawJson: JSON.stringify({ projectId: "PRJ-001" }), createdAt: now })
    .run();
  db.insert(artifacts)
    .values({ id: "ART-001", changeId: "CHG-001", runId: "RUN-001", type: "spec", path: "/tmp/spec.md", createdAt: now })
    .run();
  db.insert(findings)
    .values({ id: "FND-001", changeId: "CHG-001", runId: "RUN-001", source: "lint", severity: "error", category: "style", title: "missing semi", file: "a.ts", line: 1, evidence: null, requiredFix: null, status: "open", createdAt: now })
    .run();
}

function realProjectId(label: string): string {
  return `GIT-TST-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function seedRealProject(
  id: string,
  repoPath: string,
  options: { prdStatus?: string; gitEnabled?: number; gitDefaultBranch?: string | null } = {},
) {
  const now = new Date().toISOString();
  appDb.insert(projects)
    .values({
      id,
      name: id,
      repoPath,
      contextStatus: "pending",
      contextProvider: "codex",
      prdStatus: options.prdStatus || "none",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: options.gitEnabled ?? 0,
      gitDefaultBranch: options.gitDefaultBranch ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function cleanupRealProject(id: string, repoPath: string) {
  appDb.delete(events).where(like(events.rawJson, `%${id}%`)).run();
  appDb.delete(artifacts).where(like(artifacts.path, `%${id}%`)).run();
  appDb.delete(changes).where(eq(changes.projectId, id)).run();
  appDb.delete(projects).where(eq(projects.id, id)).run();
  fs.rmSync(repoPath, { recursive: true, force: true });
}

function seedRealProjectNativeGraph(id: string, repoPath: string) {
  seedRealProject(id, repoPath);
  fs.mkdirSync(path.join(repoPath, ".ship"), { recursive: true });
  const now = new Date().toISOString();
  const bindingId = `${id}-B`;
  const runId = `${id}-AIR`;
  const logicalTurnId = crypto.randomUUID();
  const attemptId = `${id}-ATT`;
  appDb.insert(codexThreadBindings).values({
    bindingId,
    scopeKind: "project_prd",
    scopeId: id,
    projectId: id,
    changeId: null,
    codexProjectId: null,
    threadId: `${id}-THREAD`,
    title: "PRD",
    status: "ready",
    bridgeProtocolVersion: "v1",
    provisionClaimToken: null,
    provisionLeaseOwner: null,
    provisionLeaseExpiresAt: null,
    followerStartProvedAt: null,
    lastTurnId: null,
    lastObservationCursor: 0,
    lastSemanticSnapshotHash: null,
    lastSeenAt: now,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  appDb.insert(projectAiRuns).values({
    id: runId,
    projectId: id,
    kind: "prd_turn",
    requestKey: "request",
    sequence: 1,
    status: "pending",
    workerId: null,
    leaseToken: null,
    ownerAttempt: 0,
    ownerEpoch: 0,
    leaseExpiresAt: null,
    deadlineAt: "9999-01-01T00:00:00.000Z",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }).run();
  appDb.insert(codexLogicalTurns).values({
    logicalTurnId,
    pipelineJobId: null,
    projectAiRunId: runId,
    bindingId,
    interactionId: null,
    commandId: null,
    phase: "PRD",
    role: "prd_turn",
    round: 0,
    ordinal: 0,
    turnSlot: `${id}-slot`,
    runCorrelationId: `${id}-corr`,
    canonicalRequestJson: "{}",
    canonicalRequestHash: `${id}-hash`,
    dispatchSurface: "follower_ipc",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  }).run();
  appDb.insert(codexFollowerStartAttempts).values({
    attemptId,
    logicalTurnId,
    runCorrelationId: `${id}-corr`,
    pipelineJobId: null,
    projectAiRunId: runId,
    workerId: "worker",
    leaseToken: "token",
    ownerAttempt: 1,
    ownerEpoch: 1,
    threadId: `${id}-THREAD`,
    purpose: "test",
    dispatchSurface: "follower_ipc",
    normalizedPromptHash: `${id}-prompt`,
    correlationMarker: `${id}-marker`,
    cwd: repoPath,
    model: null,
    reasoningEffort: null,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    preStartTurnIdsJson: "[]",
    preStartSemanticHash: "base",
    state: "succeeded",
    dispatchOrdinal: 0,
    dispatchCount: 1,
    budgetDeadline: "9999-01-01T00:00:00.000Z",
    followerTurnId: `${id}-TURN`,
    recoveryOwnerId: null,
    recoveryLeaseToken: null,
    recoveryEpoch: 0,
    lastResult: null,
    lastErrorCode: null,
    preparedAt: now,
    dispatchedAt: now,
    completedAt: now,
  }).run();
  appDb.insert(codexBindingRunLeases).values({
    bindingId,
    logicalTurnId,
    attemptId,
    workerId: "worker",
    leaseToken: "token",
    ownerEpoch: 1,
    leaseExpiresAt: "9999-01-01T00:00:00.000Z",
    deadlineAt: "9999-01-01T00:00:00.000Z",
  }).run();
  appDb.insert(codexTurnExecutions).values({
    id: `${id}-EX`,
    startAttemptId: attemptId,
    logicalTurnId,
    pipelineJobId: null,
    projectAiRunId: runId,
    threadId: `${id}-THREAD`,
    turnId: `${id}-TURN`,
    dispatchSurface: "follower_ipc",
    leaseToken: "token",
    ownerAttempt: 1,
    ownerEpoch: 1,
    lastObservationCursor: 0,
    normalizedItemsJson: "[]",
    lastSemanticSnapshotHash: null,
    status: "completed",
    lastObservedAt: now,
    terminalSemanticHash: "terminal",
    reconnectCount: 0,
    notYetVisibleCount: 0,
    createdAt: now,
    updatedAt: now,
  }).run();

  const contextBindingId = `${id}-CTX-B`;
  const contextRunId = `${id}-CTX-AIR`;
  const contextLogicalTurnId = crypto.randomUUID();
  const contextAttemptId = `${id}-CTX-ATT`;
  appDb.insert(codexThreadBindings).values({
    bindingId: contextBindingId,
    scopeKind: "project_context",
    scopeId: id,
    projectId: id,
    changeId: null,
    codexProjectId: null,
    threadId: `${id}-CTX-THREAD`,
    title: "Context",
    status: "ready",
    bridgeProtocolVersion: "v1",
    provisionClaimToken: null,
    provisionLeaseOwner: null,
    provisionLeaseExpiresAt: null,
    followerStartProvedAt: null,
    lastTurnId: null,
    lastObservationCursor: 0,
    lastSemanticSnapshotHash: null,
    lastSeenAt: now,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  appDb.insert(projectAiRuns).values({
    id: contextRunId,
    projectId: id,
    kind: "context_init",
    requestKey: "context-request",
    sequence: 2,
    status: "pending",
    workerId: null,
    leaseToken: null,
    ownerAttempt: 0,
    ownerEpoch: 0,
    leaseExpiresAt: null,
    deadlineAt: "9999-01-01T00:00:00.000Z",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }).run();
  appDb.insert(codexLogicalTurns).values({
    logicalTurnId: contextLogicalTurnId,
    pipelineJobId: null,
    projectAiRunId: contextRunId,
    bindingId: contextBindingId,
    interactionId: null,
    commandId: null,
    phase: "Context",
    role: "context_generate",
    round: 0,
    ordinal: 0,
    turnSlot: `${id}-context-slot`,
    runCorrelationId: `${id}-context-corr`,
    canonicalRequestJson: "{}",
    canonicalRequestHash: `${id}-context-hash`,
    dispatchSurface: "follower_ipc",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  }).run();
  appDb.insert(codexFollowerStartAttempts).values({
    attemptId: contextAttemptId,
    logicalTurnId: contextLogicalTurnId,
    runCorrelationId: `${id}-context-corr`,
    pipelineJobId: null,
    projectAiRunId: contextRunId,
    workerId: "worker",
    leaseToken: "context-token",
    ownerAttempt: 1,
    ownerEpoch: 1,
    threadId: `${id}-CTX-THREAD`,
    purpose: "test-context",
    dispatchSurface: "follower_ipc",
    normalizedPromptHash: `${id}-context-prompt`,
    correlationMarker: `${id}-context-marker`,
    cwd: repoPath,
    model: null,
    reasoningEffort: null,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    preStartTurnIdsJson: "[]",
    preStartSemanticHash: "base",
    state: "succeeded",
    dispatchOrdinal: 0,
    dispatchCount: 1,
    budgetDeadline: "9999-01-01T00:00:00.000Z",
    followerTurnId: `${id}-CTX-TURN`,
    recoveryOwnerId: null,
    recoveryLeaseToken: null,
    recoveryEpoch: 0,
    lastResult: null,
    lastErrorCode: null,
    preparedAt: now,
    dispatchedAt: now,
    completedAt: now,
  }).run();
  appDb.insert(codexBindingRunLeases).values({
    bindingId: contextBindingId,
    logicalTurnId: contextLogicalTurnId,
    attemptId: contextAttemptId,
    workerId: "worker",
    leaseToken: "context-token",
    ownerEpoch: 1,
    leaseExpiresAt: "9999-01-01T00:00:00.000Z",
    deadlineAt: "9999-01-01T00:00:00.000Z",
  }).run();
  appDb.insert(codexTurnExecutions).values({
    id: `${id}-CTX-EX`,
    startAttemptId: contextAttemptId,
    logicalTurnId: contextLogicalTurnId,
    pipelineJobId: null,
    projectAiRunId: contextRunId,
    threadId: `${id}-CTX-THREAD`,
    turnId: `${id}-CTX-TURN`,
    dispatchSurface: "follower_ipc",
    leaseToken: "context-token",
    ownerAttempt: 1,
    ownerEpoch: 1,
    lastObservationCursor: 0,
    normalizedItemsJson: "[]",
    lastSemanticSnapshotHash: null,
    status: "completed",
    lastObservedAt: now,
    terminalSemanticHash: "terminal",
    reconnectCount: 0,
    notYetVisibleCount: 0,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function initCommittedRepo(repoPath: string) {
  execSync("git init -b main", { cwd: repoPath, stdio: "pipe" });
  execSync("git config user.email test@example.com", { cwd: repoPath, stdio: "pipe" });
  execSync("git config user.name Test User", { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: repoPath, stdio: "pipe" });
}

function initEmptyRepo(repoPath: string) {
  execSync("git init -b main", { cwd: repoPath, stdio: "pipe" });
}

describe("deleteProject", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-test-"));
    fs.mkdirSync(path.join(tmpDir, ".ship"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".ship", "policy.json"), "{}");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should cascade delete all related records and remove .ship/ directory", async () => {
    const db = setupTestDb();
    seedProject(db, tmpDir);

    assert.equal(db.select().from(projects).all().length, 1);
    assert.equal(db.select().from(changes).all().length, 1);
    assert.equal(db.select().from(runs).all().length, 1);
    assert.equal(db.select().from(events).all().length, 2);
    assert.equal(db.select().from(artifacts).all().length, 1);
    assert.equal(db.select().from(findings).all().length, 1);

    const { deleteProjectWithDb } = createDeleteFn(db);
    await deleteProjectWithDb("PRJ-001");

    assert.equal(db.select().from(projects).all().length, 0);
    assert.equal(db.select().from(changes).all().length, 0);
    assert.equal(db.select().from(runs).all().length, 0);
    assert.equal(db.select().from(events).all().length, 0);
    assert.equal(db.select().from(artifacts).all().length, 0);
    assert.equal(db.select().from(findings).all().length, 0);
    assert.equal(fs.existsSync(path.join(tmpDir, ".ship")), false);
  });

  it("should throw when project does not exist", async () => {
    const db = setupTestDb();
    const { deleteProjectWithDb } = createDeleteFn(db);

    await assert.rejects(
      () => deleteProjectWithDb("PRJ-999"),
      (err: Error) => {
        assert.match(err.message, /not found/i);
        return true;
      }
    );
  });

  it("should handle already-deleted .ship/ directory gracefully", async () => {
    const db = setupTestDb();
    seedProject(db, tmpDir);
    fs.rmSync(path.join(tmpDir, ".ship"), { recursive: true, force: true });

    const { deleteProjectWithDb } = createDeleteFn(db);
    await deleteProjectWithDb("PRJ-001");

    assert.equal(db.select().from(projects).all().length, 0);
  });

  it("production delete removes Project native owners in one transaction", async () => {
    const id = realProjectId("native-delete");
    seedRealProjectNativeGraph(id, tmpDir);

    await deleteProject(id);

    assert.equal(appDb.select().from(projects).where(eq(projects.id, id)).get(), undefined);
    assert.equal(appDb.select().from(projectAiRuns).where(eq(projectAiRuns.projectId, id)).all().length, 0);
    assert.equal(appDb.select().from(codexThreadBindings).where(eq(codexThreadBindings.projectId, id)).all().length, 0);
    assert.equal(fs.existsSync(path.join(tmpDir, ".ship")), false);
  });

  it("rolls back domain and native rows when the before-commit failpoint throws", async () => {
    const id = realProjectId("native-rollback");
    seedRealProjectNativeGraph(id, tmpDir);

    await assert.rejects(
      deleteProject(id, {
        beforeCommit() {
          throw new Error("task2_before_commit");
        },
      }),
      /task2_before_commit/,
    );

    assert.ok(appDb.select().from(projects).where(eq(projects.id, id)).get());
    assert.equal(appDb.select().from(projectAiRuns).where(eq(projectAiRuns.projectId, id)).all().length, 2);
    assert.equal(appDb.select().from(codexThreadBindings).where(eq(codexThreadBindings.projectId, id)).all().length, 2);
    await deleteProject(id);
  });
});

describe("project git state synchronization", () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-git-sync-"));
    projectId = realProjectId("sync");
  });

  afterEach(() => {
    cleanupRealProject(projectId, tmpDir);
  });

  it("getProject enables git for a real repo with commits even when DB is stale", async () => {
    initCommittedRepo(tmpDir);
    seedRealProject(projectId, tmpDir, { gitEnabled: 0, gitDefaultBranch: null });

    const project = await getProject(projectId);

    assert.equal(project!.gitEnabled, 1);
    assert.equal(project!.gitDefaultBranch, "main");
    const dbProject = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    assert.equal(dbProject!.gitEnabled, 1);
    assert.equal(dbProject!.gitDefaultBranch, "main");
  });

  it("createChange syncs stale project git state and creates a real branch", async () => {
    initCommittedRepo(tmpDir);
    seedRealProject(projectId, tmpDir, { prdStatus: "ready", gitEnabled: 0, gitDefaultBranch: null });

    const change = await createChange({ projectId, title: "Add Git Sync" });

    assert.ok(change.gitBranch);
    assert.equal(branchExists(tmpDir, change.gitBranch!), true);
    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    assert.equal(project!.gitEnabled, 1);
    assert.equal(project!.gitDefaultBranch, "main");
  });

  it("keeps ordinary directories git-disabled without throwing", async () => {
    seedRealProject(projectId, tmpDir, { gitEnabled: 1, gitDefaultBranch: "main" });

    const project = await getProject(projectId);

    assert.equal(project!.gitEnabled, 0);
    assert.equal(project!.gitDefaultBranch, null);
  });

  it("keeps git repositories without commits disabled", async () => {
    initEmptyRepo(tmpDir);
    seedRealProject(projectId, tmpDir, { gitEnabled: 1, gitDefaultBranch: "main" });

    const project = await getProject(projectId);

    assert.equal(project!.gitEnabled, 0);
    assert.equal(project!.gitDefaultBranch, null);
  });

});

describe("createProject", () => {
  const src = readFileSync(resolve(__dirname, "project-service.ts"), "utf-8");
  const changeSrc = readFileSync(resolve(__dirname, "change-service.ts"), "utf-8");
  const gitStateSrc = readFileSync(resolve(__dirname, "project-git-state-service.ts"), "utf-8");

  it("checks registered repo paths before rejecting existing .ship directories", () => {
    const registeredPathCheck = src.indexOf(".where(eq(projects.repoPath, absPath))");
    const shipDirCheck = src.indexOf("fs.existsSync(shipDir)");

    assert.notEqual(registeredPathCheck, -1, "createProject should check existing registered paths");
    assert.notEqual(shipDirCheck, -1, "createProject should still reject unregistered .ship directories");
    assert.ok(
      registeredPathCheck < shipDirCheck,
      "registered repo path check should run before .ship directory check"
    );
  });

  it("keeps project git synchronization outside project/change service cycle", () => {
    assert.match(src, /from "\.\/project-git-state-service"/);
    assert.match(changeSrc, /from "\.\/project-git-state-service"/);
    assert.doesNotMatch(changeSrc, /from "\.\/project-service"/);
    assert.doesNotMatch(gitStateSrc, /from "\.\/change-service"/);
  });
});

function createDeleteFn(db: ReturnType<typeof setupTestDb>) {
  async function deleteProjectWithDb(id: string): Promise<void> {
    const project = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) throw new Error(`Project not found: ${id}`);

    const projectChanges = db
      .select()
      .from(changes)
      .where(eq(changes.projectId, id))
      .all();

    for (const change of projectChanges) {
      db.delete(findings).where(eq(findings.changeId, change.id)).run();
      db.delete(artifacts).where(eq(artifacts.changeId, change.id)).run();
      db.delete(events).where(eq(events.changeId, change.id)).run();
      db.delete(runs).where(eq(runs.changeId, change.id)).run();
    }

    db.delete(changes).where(eq(changes.projectId, id)).run();
    db.delete(events)
      .where(and(isNull(events.changeId), like(events.rawJson, `%${id}%`)))
      .run();
    db.delete(projects).where(eq(projects.id, id)).run();

    const shipDir = path.join(project.repoPath, ".ship");
    if (fs.existsSync(shipDir)) {
      fs.rmSync(shipDir, { recursive: true, force: true });
    }
  }

  return { deleteProjectWithDb };
}
