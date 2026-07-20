import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { artifacts, changeProviderSessions, changes, events, findings, projects } from "../db/schema.ts";
import { setAiEngineLoaderForTest } from "./ai-engine-adapter.ts";
import type { AiEngineAdapter } from "./ai-engine-types.ts";
import { confirmRequirements, refineTurn } from "./refine-service.ts";

const PROJECT_ID = "PRJ-REFINE-ENTRY";
const CHANGE_ID = "CHG-REFINE-ENTRY";

let repoPath = "";
let restoreEngine: (() => void) | null = null;

function seedIntakePendingChange(): void {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Refine entry contract",
    repoPath,
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: "# PRD",
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Refine from intake entry",
    status: "INTAKE_PENDING",
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
  }).run();
}

beforeEach(() => {
  const testRoot = process.env.STAGEPASS_TEST_ROOT ?? os.tmpdir();
  fs.mkdirSync(testRoot, { recursive: true });
  repoPath = fs.mkdtempSync(path.join(testRoot, "refine-entry-"));
  seedIntakePendingChange();
});

afterEach(() => {
  sqlite.exec("DROP TRIGGER IF EXISTS test_refine_confirm_status_drift");
  sqlite.exec("DROP TRIGGER IF EXISTS test_refine_confirm_artifact_failure");
  restoreEngine?.();
  restoreEngine = null;
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("intake-first Refine entry contract", () => {
  it("runs a Refine chat turn while preserving INTAKE_PENDING", async () => {
    const engine: AiEngineAdapter = {
      async run() {
        return {
          threadId: "thread-refine-entry",
          runId: "run-refine-entry",
          summary: [
            "请确认验收标准。",
            "```requirements",
            JSON.stringify([{ id: "REQ-1", category: "functional", title: "公开入口", description: "允许从新 Change 发起 Refine", status: "confirmed" }]),
            "```",
          ].join("\n"),
        };
      },
    };
    restoreEngine = setAiEngineLoaderForTest("codex", () => engine);

    const result = await refineTurn(PROJECT_ID, CHANGE_ID, "需要走公开 Refine API");

    assert.equal(result.requirements.length, 1);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "INTAKE_PENDING");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.codexThreadId, "thread-refine-entry");
  });

  it("confirms Refine requirements without leaving the PRD briefing entry state", async () => {
    await confirmRequirements(PROJECT_ID, CHANGE_ID, [{
      id: "REQ-1",
      category: "functional",
      title: "公开入口",
      description: "允许从新 Change 发起 Refine",
      status: "confirmed",
    }]);

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const specArtifact = db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).get();
    assert.equal(change?.status, "INTAKE_PENDING");
    assert.equal(specArtifact?.type, "spec");
    assert.equal(fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "spec.md")), true);
  });

  it("keeps the legacy REFINING confirmation transition to DRAFT", async () => {
    db.update(changes).set({ status: "REFINING" }).where(eq(changes.id, CHANGE_ID)).run();

    await confirmRequirements(PROJECT_ID, CHANGE_ID, [{
      id: "REQ-1",
      category: "functional",
      title: "Legacy Refine",
      description: "Retain the existing transition contract",
      status: "confirmed",
    }]);

    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "DRAFT");
  });

  it("still rejects Refine chat outside both supported entry states", async () => {
    db.update(changes).set({ status: "INTAKE_READY" }).where(eq(changes.id, CHANGE_ID)).run();

    await assert.rejects(
      refineTurn(PROJECT_ID, CHANGE_ID, "too late"),
      /not available for Refine \(current: INTAKE_READY\)/,
    );
  });

  it("rejects confirmation if status drifts after validation without partial side effects", async () => {
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    const specPath = path.join(changeDir, "spec.md");
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(specPath, "# Existing spec\n");
    db.insert(artifacts).values({
      id: "ART-REFINE-EXISTING",
      changeId: CHANGE_ID,
      runId: null,
      type: "spec",
      path: specPath,
      createdAt: new Date().toISOString(),
    }).run();
    const beforeEvents = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all();
    sqlite.exec(`
      CREATE TRIGGER test_refine_confirm_status_drift
      BEFORE DELETE ON artifacts
      WHEN OLD.change_id = '${CHANGE_ID}' AND OLD.type = 'spec'
      BEGIN
        UPDATE changes SET status = 'INTAKE_READY' WHERE id = '${CHANGE_ID}';
      END;
    `);

    await assert.rejects(
      confirmRequirements(PROJECT_ID, CHANGE_ID, [{
        id: "REQ-1",
        category: "functional",
        title: "Drift safe",
        description: "Do not persist stale confirmation",
        status: "confirmed",
      }]),
      /status changed while confirming requirements/,
    );

    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "INTAKE_PENDING");
    assert.equal(fs.readFileSync(specPath, "utf8"), "# Existing spec\n");
    assert.deepEqual(
      db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().map((row) => row.id),
      ["ART-REFINE-EXISTING"],
    );
    assert.deepEqual(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all(), beforeEvents);
  });

  it("rejects confirmation from an invalid state without any mutation", async () => {
    db.update(changes).set({ status: "INTAKE_READY" }).where(eq(changes.id, CHANGE_ID)).run();
    const before = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const beforeEvents = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all();

    await assert.rejects(
      confirmRequirements(PROJECT_ID, CHANGE_ID, []),
      /not available for Refine \(current: INTAKE_READY\)/,
    );

    assert.deepEqual(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get(), before);
    assert.deepEqual(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all(), beforeEvents);
    assert.equal(db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "spec.md")), false);
  });

  it("rolls back the legacy status transition when artifact persistence fails", async () => {
    db.update(changes).set({ status: "REFINING" }).where(eq(changes.id, CHANGE_ID)).run();
    sqlite.exec(`
      CREATE TRIGGER test_refine_confirm_artifact_failure
      BEFORE INSERT ON artifacts
      WHEN NEW.change_id = '${CHANGE_ID}' AND NEW.type = 'spec'
      BEGIN
        SELECT RAISE(ABORT, 'forced artifact failure');
      END;
    `);

    await assert.rejects(
      confirmRequirements(PROJECT_ID, CHANGE_ID, [{
        id: "REQ-1",
        category: "functional",
        title: "Atomic rollback",
        description: "Do not advance status without the spec artifact",
        status: "confirmed",
      }]),
      /forced artifact failure/,
    );

    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "REFINING");
    assert.equal(db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "spec.md")), false);
    assert.deepEqual(fs.readdirSync(path.join(repoPath, ".ship", "changes", CHANGE_ID)), []);
  });

  it("does not collide with an existing PID-and-millisecond staging path", async (t) => {
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    fs.mkdirSync(changeDir, { recursive: true });
    t.mock.method(Date, "now", () => 12_345);
    const collidingPath = path.join(changeDir, `.spec.${process.pid}.12345.tmp`);
    fs.writeFileSync(collidingPath, "do not replace\n");

    await confirmRequirements(PROJECT_ID, CHANGE_ID, []);

    assert.equal(fs.readFileSync(collidingPath, "utf8"), "do not replace\n");
    assert.equal(fs.existsSync(path.join(changeDir, "spec.md")), true);
  });

  it("cleans the unique staging directory when the staging write fails", async (t) => {
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    fs.mkdirSync(changeDir, { recursive: true });
    t.mock.method(fs, "writeFileSync", () => {
      throw new Error("forced staging write failure");
    });

    await assert.rejects(
      confirmRequirements(PROJECT_ID, CHANGE_ID, []),
      /forced staging write failure/,
    );

    assert.deepEqual(fs.readdirSync(changeDir), []);
    assert.equal(db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "INTAKE_PENDING");
  });

  it("restores an existing empty spec when persistence fails after staging", async () => {
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    const specPath = path.join(changeDir, "spec.md");
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(specPath, Buffer.alloc(0));
    sqlite.exec(`
      CREATE TRIGGER test_refine_confirm_artifact_failure
      BEFORE INSERT ON artifacts
      WHEN NEW.change_id = '${CHANGE_ID}' AND NEW.type = 'spec'
      BEGIN
        SELECT RAISE(ABORT, 'forced artifact failure');
      END;
    `);

    await assert.rejects(confirmRequirements(PROJECT_ID, CHANGE_ID, []), /forced artifact failure/);

    assert.equal(fs.existsSync(specPath), true);
    assert.equal(fs.statSync(specPath).size, 0);
    assert.equal(db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length, 0);
  });
});
