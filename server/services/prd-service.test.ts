import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, like } from "drizzle-orm";
import fs from "fs";
import path from "path";
import os from "os";
import * as schema from "../db/schema.ts";
import { db as appDb } from "../db/index.ts";
import { setAiEngineLoaderForTest } from "./ai-engine-adapter.ts";
import type { AiEngineAdapter, AiRunInput, AiRunResult } from "./ai-engine-types.ts";
import { confirmPrdRevision, prdTurn, PrdTurnFailedError, startPrdRevision } from "./prd-service.ts";
import type { ChangeStatus } from "../types";
import type { StructuredPrd } from "../types/prd.ts";

const { projects, changes, events } = schema;

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
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      change_id TEXT,
      run_id TEXT,
      type TEXT NOT NULL,
      message TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  return drizzle(sqlite, { schema });
}

type TestDb = ReturnType<typeof setupTestDb>;

function seedProject(db: TestDb, repoPath: string, prdStatus = "none") {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: "PRJ-001",
      name: "Test",
      repoPath,
      contextStatus: "pending",
      contextProvider: "codex",
      prdStatus,
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function validStructuredPrd(title = "PRD Test"): StructuredPrd {
  return {
    version: 1,
    body: {
      title,
      overview: "Build a clear product workflow for tested PRD generation.",
      targetUsers: "Product managers and engineers coordinating delivery.",
      userStories: [],
      functionalRequirements: [
        {
          id: "FR-001",
          title: "Generate PRD",
          description: "The system creates a structured PRD draft from user input.",
          priority: "must",
          acceptanceCriteria: [
            { id: "AC-001", description: "A PRD draft is saved for review.", testable: true },
          ],
        },
      ],
      nonFunctionalRequirements: "",
      outOfScope: "Implementation work is out of scope.",
      successMetrics: "A reviewer can confirm the draft.",
      risks: "Incomplete input may require follow-up.",
      openQuestions: [],
    },
    aiAppendix: {
      implementationConstraints: "",
      affectedModules: [],
      interfaceContracts: "",
      testStrategy: "",
      boundaryConditions: "",
      phaseConstraints: "",
    },
    sources: [],
  };
}

function prdLikeMarkdown(title = "Fallback PRD"): string {
  return `# ${title}

## Overview

This product goal is to turn a conversation into a reliable PRD draft with enough detail for downstream planning and review.

## Target User

Product managers and engineers who need one shared requirement document before creating implementation changes.

## Functional Requirements

### FR-001: Draft generation

The assistant must save a PRD draft when the response itself contains requirements, acceptance criteria, and user intent.

## Acceptance Criteria

- Given a PRD-like summary, when no files changed, then the system saves it as a draft.
- Given plain explanatory text, when no files changed, then the system rejects it.

## Out of Scope

Implementation changes are not included.

## Risks

Ambiguous requirements can require another turn.
`;
}

/**
 * Serializes a structured PRD into legacy-PRD line-protocol text. With this
 * stage on the protocol, mocked engines speak TITLE / OVERVIEW<< / FR / AC /
 * PRD_DONE in `summary` and stagepass assembles the document -- model-authored
 * JSON, hand-written .ship/prd.json, and PRD-shaped chat markdown are all
 * refused. `version` is supplied by stagepass, so it never appears here.
 */
function prdLineProtocolText(
  prd: StructuredPrd = validStructuredPrd(),
  chatProse = "PRD 草案已更新。",
): string {
  const { body, aiAppendix, sources } = prd;
  const block = (name: string, content: string) => `${name}<<\n${content}\n>>${name}`;
  const lines: string[] = [chatProse, `TITLE: ${body.title}`];
  lines.push(block("OVERVIEW", body.overview));
  lines.push(block("TARGETUSERS", body.targetUsers));
  for (const story of body.userStories) {
    lines.push(`STORY: ${story.id} | ${story.persona} | ${story.action} | ${story.benefit}`);
  }
  for (const requirement of body.functionalRequirements) {
    lines.push(
      `FR: ${requirement.id} | ${requirement.title} | ${requirement.description} | ${requirement.priority}`,
    );
    for (const criterion of requirement.acceptanceCriteria) {
      lines.push(`AC: ${requirement.id} | ${criterion.id} | ${criterion.description} | ${criterion.testable}`);
    }
  }
  if (body.nonFunctionalRequirements) lines.push(block("NFR", body.nonFunctionalRequirements));
  if (body.outOfScope) lines.push(block("OUTOFSCOPE", body.outOfScope));
  if (body.successMetrics) lines.push(block("METRICS", body.successMetrics));
  if (body.risks) lines.push(block("RISKS", body.risks));
  for (const question of body.openQuestions) {
    lines.push(`OQ: ${question.id} | ${question.question} | ${question.blocking} | ${question.answer ?? "-"}`);
  }
  if (aiAppendix.implementationConstraints) lines.push(block("CONSTRAINTS", aiAppendix.implementationConstraints));
  for (const modulePath of aiAppendix.affectedModules) lines.push(`MODULE: ${modulePath}`);
  if (aiAppendix.interfaceContracts) lines.push(block("CONTRACTS", aiAppendix.interfaceContracts));
  if (aiAppendix.testStrategy) lines.push(block("TESTSTRATEGY", aiAppendix.testStrategy));
  if (aiAppendix.boundaryConditions) lines.push(block("BOUNDARIES", aiAppendix.boundaryConditions));
  if (aiAppendix.phaseConstraints) lines.push(block("PHASECONSTRAINTS", aiAppendix.phaseConstraints));
  for (const source of sources) {
    lines.push(`SOURCE: ${source.name} | ${source.url}`);
    for (const item of source.adopted) lines.push(`ADOPTED: ${source.name} | ${item}`);
    for (const item of source.rejected) lines.push(`REJECTED: ${source.name} | ${item}`);
    for (const item of source.rejectionReasons) lines.push(`REJECTREASON: ${source.name} | ${item}`);
  }
  lines.push("PRD_DONE: true");
  return lines.join("\n");
}

function realProjectId(label: string): string {
  return `PRD-TST-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function seedRealProject(id: string, repoPath: string, prdStatus = "drafting", prdJson: string | null = null) {
  const now = new Date().toISOString();
  appDb.insert(projects)
    .values({
      id,
      name: id,
      repoPath,
      contextStatus: "pending",
      contextProvider: "codex",
      prdStatus,
      prdProvider: "codex",
      prdJson,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function cleanupRealProject(id: string, repoPath: string) {
  const projectChanges = appDb
    .select({ id: changes.id })
    .from(changes)
    .where(eq(changes.projectId, id))
    .all();
  for (const change of projectChanges) {
    appDb.delete(events).where(eq(events.changeId, change.id)).run();
  }
  appDb.delete(events).where(like(events.rawJson, `%${id}%`)).run();
  appDb.delete(changes).where(eq(changes.projectId, id)).run();
  appDb.delete(projects).where(eq(projects.id, id)).run();
  fs.rmSync(repoPath, { recursive: true, force: true });
}

function seedRealChange(projectId: string, id: string, status: ChangeStatus) {
  const now = new Date().toISOString();
  appDb.insert(changes)
    .values({
      id,
      projectId,
      title: `Change ${id}`,
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
    })
    .run();
}

function latestPrdAssistantEvent(projectId: string) {
  return appDb.select().from(events).all()
    .filter((event) => event.type === "prd_assistant" && (event.rawJson || "").includes(projectId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function mockPrdEngine(run: (input: AiRunInput) => Promise<AiRunResult>): () => void {
  const engine: AiEngineAdapter = {
    run,
    async *runStreamed() {},
  };
  return setAiEngineLoaderForTest("codex", () => engine);
}

describe("PRD state machine transitions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-test-"));
    fs.mkdirSync(path.join(tmpDir, ".ship"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("valid transition: none → drafting", () => {
    const db = setupTestDb();
    seedProject(db, tmpDir, "none");

    db.update(projects)
      .set({ prdStatus: "drafting", updatedAt: new Date().toISOString() })
      .where(eq(projects.id, "PRJ-001"))
      .run();

    const project = db.select().from(projects).where(eq(projects.id, "PRJ-001")).get();
    assert.equal(project!.prdStatus, "drafting");
  });

  it("valid transition: drafting → ready", () => {
    const db = setupTestDb();
    seedProject(db, tmpDir, "drafting");

    db.update(projects)
      .set({ prdStatus: "ready", updatedAt: new Date().toISOString() })
      .where(eq(projects.id, "PRJ-001"))
      .run();

    const project = db.select().from(projects).where(eq(projects.id, "PRJ-001")).get();
    assert.equal(project!.prdStatus, "ready");
  });

  it("valid transition: ready → revising", () => {
    const db = setupTestDb();
    seedProject(db, tmpDir, "ready");

    db.update(projects)
      .set({ prdStatus: "revising", updatedAt: new Date().toISOString() })
      .where(eq(projects.id, "PRJ-001"))
      .run();

    const project = db.select().from(projects).where(eq(projects.id, "PRJ-001")).get();
    assert.equal(project!.prdStatus, "revising");
  });

  it("valid transition: revising → ready", () => {
    const db = setupTestDb();
    seedProject(db, tmpDir, "revising");

    db.update(projects)
      .set({ prdStatus: "ready", updatedAt: new Date().toISOString() })
      .where(eq(projects.id, "PRJ-001"))
      .run();

    const project = db.select().from(projects).where(eq(projects.id, "PRJ-001")).get();
    assert.equal(project!.prdStatus, "ready");
  });
});

describe("PRD state machine: invalid transitions", () => {
  it("none → ready is invalid", () => {
    const VALID_TRANSITIONS: Record<string, string[]> = {
      none: ["drafting"],
      drafting: ["ready"],
      ready: ["revising"],
      revising: ["ready"],
    };

    function assertTransition(current: string, next: string): void {
      const allowed = VALID_TRANSITIONS[current];
      if (!allowed || !allowed.includes(next)) {
        throw new Error(`Invalid PRD status transition: ${current} → ${next}`);
      }
    }

    assert.throws(
      () => assertTransition("none", "ready"),
      (err: Error) => {
        assert.match(err.message, /Invalid PRD status transition/);
        return true;
      }
    );
  });

  it("drafting → revising is invalid", () => {
    const VALID_TRANSITIONS: Record<string, string[]> = {
      none: ["drafting"],
      drafting: ["ready"],
      ready: ["revising"],
      revising: ["ready"],
    };

    function assertTransition(current: string, next: string): void {
      const allowed = VALID_TRANSITIONS[current];
      if (!allowed || !allowed.includes(next)) {
        throw new Error(`Invalid PRD status transition: ${current} → ${next}`);
      }
    }

    assert.throws(
      () => assertTransition("drafting", "revising"),
      (err: Error) => {
        assert.match(err.message, /Invalid PRD status transition/);
        return true;
      }
    );
  });

  it("ready → drafting is invalid", () => {
    const VALID_TRANSITIONS: Record<string, string[]> = {
      none: ["drafting"],
      drafting: ["ready"],
      ready: ["revising"],
      revising: ["ready"],
    };

    function assertTransition(current: string, next: string): void {
      const allowed = VALID_TRANSITIONS[current];
      if (!allowed || !allowed.includes(next)) {
        throw new Error(`Invalid PRD status transition: ${current} → ${next}`);
      }
    }

    assert.throws(
      () => assertTransition("ready", "drafting"),
      (err: Error) => {
        assert.match(err.message, /Invalid PRD status transition/);
        return true;
      }
    );
  });
});

describe("PRD boundary guard: validatePrdStage", () => {
  it("allows .ship/prd.md modification", () => {
    const mutations = [{ kind: "modified" as const, path: ".ship/prd.md" }];
    const violatingFiles = mutations
      .map((m) => m.path)
      .filter((p) => p !== ".ship/prd.md");

    assert.equal(violatingFiles.length, 0);
  });

  it("blocks modification of other files", () => {
    const mutations = [
      { kind: "modified" as const, path: ".ship/prd.md" },
      { kind: "modified" as const, path: "src/index.ts" },
    ];
    const violatingFiles = mutations
      .map((m) => m.path)
      .filter((p) => p !== ".ship/prd.md");

    assert.equal(violatingFiles.length, 1);
    assert.equal(violatingFiles[0], "src/index.ts");
  });

  it("blocks all non-prd modifications", () => {
    const mutations = [
      { kind: "created" as const, path: "package.json" },
      { kind: "modified" as const, path: "server/db/schema.ts" },
    ];
    const violatingFiles = mutations
      .map((m) => m.path)
      .filter((p) => p !== ".ship/prd.md");

    assert.equal(violatingFiles.length, 2);
  });
});

describe("Change suspend/restore on PRD revision", () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-suspend-test-"));
    fs.mkdirSync(path.join(tmpDir, ".ship"), { recursive: true });
    projectId = realProjectId("suspend");
  });

  afterEach(() => {
    cleanupRealProject(projectId, tmpDir);
  });

  it("suspends active changes through the production state transition service", () => {
    seedRealProject(projectId, tmpDir, "ready");
    seedRealChange(projectId, `${projectId}-RUNNING`, "IMPLEMENTING");
    seedRealChange(projectId, `${projectId}-DRAFT`, "DRAFT");
    seedRealChange(projectId, `${projectId}-LOCAL`, "LOCAL_READY");

    startPrdRevision(projectId);

    const suspended = appDb.select().from(changes)
      .where(eq(changes.suspendedByPrd, 1)).all();
    assert.equal(suspended.length, 2);
    assert.deepEqual(
      suspended.map((change) => change.preSuspendStatus).sort(),
      ["DRAFT", "IMPLEMENTING"],
    );
    assert.deepEqual(suspended.map((change) => change.status), ["BLOCKED", "BLOCKED"]);

    const chg3 = appDb.select().from(changes).where(eq(changes.id, `${projectId}-LOCAL`)).get();
    assert.equal(chg3!.status, "LOCAL_READY");
    assert.equal(chg3!.suspendedByPrd, 0);
  });

  it("restores suspended changes through the production state transition service", async () => {
    seedRealProject(projectId, tmpDir, "ready", JSON.stringify(validStructuredPrd("Ready PRD")));
    fs.writeFileSync(path.join(tmpDir, ".ship", "prd.md"), prdLikeMarkdown("Ready PRD"));

    const restoredStatuses: ChangeStatus[] = [
      "DRAFT",
      "SPEC_READY",
      "TECHSPEC_READY",
      "PLAN_READY",
      "TESTPLAN_DONE",
      "MERGE_READY",
    ];
    for (const status of restoredStatuses) {
      seedRealChange(projectId, `${projectId}-${status}`, status);
    }

    startPrdRevision(projectId);
    const result = await confirmPrdRevision(projectId);

    assert.equal(result.valid, true);
    for (const status of restoredStatuses) {
      const change = appDb
        .select()
        .from(changes)
        .where(eq(changes.id, `${projectId}-${status}`))
        .get();
      assert.equal(change!.status, status);
      assert.equal(change!.suspendedByPrd, 0);
      assert.equal(change!.preSuspendStatus, null);
    }

    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    assert.equal(project!.prdStatus, "ready");
  });

  it("restores one suspended running change while preserving running-state invariants", async () => {
    seedRealProject(projectId, tmpDir, "ready", JSON.stringify(validStructuredPrd("Ready PRD")));
    fs.writeFileSync(path.join(tmpDir, ".ship", "prd.md"), prdLikeMarkdown("Ready PRD"));
    seedRealChange(projectId, `${projectId}-IMPLEMENTING`, "IMPLEMENTING");

    startPrdRevision(projectId);
    const result = await confirmPrdRevision(projectId);

    assert.equal(result.valid, true);
    const change = appDb
      .select()
      .from(changes)
      .where(eq(changes.id, `${projectId}-IMPLEMENTING`))
      .get();
    assert.equal(change!.status, "IMPLEMENTING");
    assert.equal(change!.suspendedByPrd, 0);
    assert.equal(change!.preSuspendStatus, null);
  });
});

describe("Change creation PRD guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-guard-test-"));
    fs.mkdirSync(path.join(tmpDir, ".ship", "changes"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects change creation when prdStatus is not ready", () => {
    const db = setupTestDb();
    seedProject(db, tmpDir, "drafting");

    const project = db.select().from(projects).where(eq(projects.id, "PRJ-001")).get();
    assert.equal(project!.prdStatus, "drafting");
    assert.notEqual(project!.prdStatus, "ready");
  });

  it("allows change creation when prdStatus is ready", () => {
    const db = setupTestDb();
    seedProject(db, tmpDir, "ready");

    const project = db.select().from(projects).where(eq(projects.id, "PRJ-001")).get();
    assert.equal(project!.prdStatus, "ready");
  });
});

describe("PRD turn failure contract", () => {
  const servicePath = path.join(process.cwd(), "server", "services", "prd-service.ts");
  const routePath = path.join(process.cwd(), "app", "api", "projects", "[id]", "prd", "route.ts");
  const editorPath = path.join(process.cwd(), "app", "projects", "[id]", "prd-editor.tsx");

  it("records assistant feedback and rejects failed or empty engine output", () => {
    const source = fs.readFileSync(servicePath, "utf-8");

    assert.match(source, /writePrdAssistantEvent/);
    assert.match(source, /result\.success !== true/);
    assert.match(source, /PRD 生成失败/);
    assert.match(source, /PRD 生成没有返回有效回复/);
    assert.match(source, /PRD 生成没有产出文档内容/);
    assert.match(source, /throw new PrdTurnFailedError/);
  });

  it("maps PRD turn production failures to explicit HTTP errors", () => {
    const route = fs.readFileSync(routePath, "utf-8");

    assert.match(route, /PrdTurnFailedError/);
    assert.match(route, /status: err\.statusCode \|\| 502/);
    assert.match(route, /502/);
  });

  it("keeps long PRD editor turns alive while showing a slow-generation notice", () => {
    const editor = fs.readFileSync(editorPath, "utf-8");

    assert.match(editor, /PRD_TURN_SLOW_NOTICE_MS = 60_000/);
    assert.match(editor, /setSlowNotice\(true\)/);
    assert.match(editor, /仍在生成 PRD/);
    assert.match(editor, /setTimeout\(/);
    assert.match(editor, /clearTimeout\(slowNoticeId\)/);
    assert.doesNotMatch(editor, /new AbortController\(\)/);
    assert.doesNotMatch(editor, /signal: controller\.signal/);
    assert.doesNotMatch(editor, /请求超时/);
  });

  it("sanitizes local absolute paths from PRD assistant chat messages at render time", () => {
    const editor = fs.readFileSync(editorPath, "utf-8");

    assert.match(editor, /sanitizePrdAssistantMessage/);
    assert.match(editor, /\/Users/);
    assert.match(editor, /\/private/);
    assert.match(editor, /\/var/);
    assert.match(editor, /路径已隐藏/);
    assert.match(editor, /msg\.role === "assistant" \? sanitizePrdAssistantMessage\(msg\.content\) : msg\.content/);
  });
});

describe("PRD turn artifact extraction and failed state", () => {
  let tmpDir: string;
  let projectId: string;
  let restoreEngine: (() => void) | null = null;
  let previousTimeout: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-turn-real-"));
    fs.mkdirSync(path.join(tmpDir, ".ship"), { recursive: true });
    projectId = realProjectId("turn");
    previousTimeout = process.env.STAGEPASS_PRD_TIMEOUT_MS;
  });

  afterEach(() => {
    restoreEngine?.();
    restoreEngine = null;
    if (previousTimeout === undefined) {
      delete process.env.STAGEPASS_PRD_TIMEOUT_MS;
    } else {
      process.env.STAGEPASS_PRD_TIMEOUT_MS = previousTimeout;
    }
    cleanupRealProject(projectId, tmpDir);
  });

  it("refuses to resurrect model-authored structuredOutput", async () => {
    // The line protocol is the only accepted source: a schema-valid payload the
    // model authored by hand must not settle a turn, whatever channel carries it.
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-structured",
      runId: "run-structured",
      summary: "Structured PRD created.",
      success: true,
      changedFiles: [],
      structuredOutput: validStructuredPrd("Structured Output PRD"),
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "draft a PRD"), PrdTurnFailedError);

    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    assert.doesNotMatch(project!.prdMarkdown || "", /Structured Output PRD/);
  });

  it("records the model's raw reply so a settled turn stays auditable", async () => {
    // Change-scoped stages answer "what did the model write?" from
    // raw-ai-output.json. This stage is project-scoped and cannot use that
    // machinery (artifacts.change_id is NOT NULL with an FK into changes), so
    // the same evidence must ride on the prd_assistant event -- otherwise a
    // settled PRD is unauditable, which is exactly what an e2e probe hit.
    seedRealProject(projectId, tmpDir, "drafting");
    const protocolText = prdLineProtocolText(validStructuredPrd("Audited PRD"));
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-audit",
      runId: "run-audit",
      summary: protocolText,
      success: true,
      changedFiles: [],
      items: [],
    }));

    await prdTurn(projectId, "draft a PRD");

    const raw = JSON.parse(latestPrdAssistantEvent(projectId)!.rawJson || "{}");
    assert.equal(raw.prdSource, "lineProtocol");
    assert.equal(raw.rawCapture.structuredOutputSource, "lineProtocol");
    assert.equal(raw.rawCapture.parseError, null);
    assert.equal(raw.rawCapture.rawText, protocolText);
    assert.equal(raw.rawCapture.modelDeclaredStructuredOutput, false);
  });

  it("records the raw reply and the parser's complaint on a failed turn", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-audit-fail",
      runId: "run-audit-fail",
      summary: "收到，PRD 稍后再改。",
      success: true,
      changedFiles: [],
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "draft a PRD"), PrdTurnFailedError);

    const raw = JSON.parse(latestPrdAssistantEvent(projectId)!.rawJson || "{}");
    assert.equal(raw.reason, "unparseable_prd_content");
    assert.equal(raw.rawCapture.structuredOutputSource, "none");
    assert.equal(raw.rawCapture.rawText, "收到，PRD 稍后再改。");
    assert.match(raw.rawCapture.parseError, /expected exactly 1 TITLE line/);
  });

  it("records that the model declared structured output even while refusing it", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-audit-json",
      runId: "run-audit-json",
      summary: "Here is the PRD.",
      success: true,
      changedFiles: [],
      structuredOutput: validStructuredPrd("Model Authored"),
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "draft a PRD"), PrdTurnFailedError);

    const raw = JSON.parse(latestPrdAssistantEvent(projectId)!.rawJson || "{}");
    assert.equal(raw.rawCapture.modelDeclaredStructuredOutput, true);
    assert.equal(raw.rawCapture.structuredOutputSource, "none");
  });

  it("saves a PRD assembled from the line protocol in the reply", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-summary",
      runId: "run-summary",
      summary: prdLineProtocolText(validStructuredPrd("Protocol PRD")),
      success: true,
      changedFiles: [],
      items: [],
    }));

    const result = await prdTurn(projectId, "draft a PRD from chat");

    assert.match(result.prdContent || "", /Protocol PRD/);
    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    assert.match(project!.prdMarkdown || "", /Protocol PRD/);
    assert.equal(project!.prdStatus, "drafting");
    // The user reads prose, never protocol syntax.
    assert.match(result.assistantMessage, /PRD 草案已更新/);
    assert.doesNotMatch(result.assistantMessage, /TITLE:|OVERVIEW<<|PRD_DONE/);
  });

  it("refuses PRD-shaped markdown that the model wrote as chat prose", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-md-prose",
      runId: "run-md-prose",
      summary: prdLikeMarkdown("Prose Markdown PRD"),
      success: true,
      changedFiles: [],
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "draft a PRD from chat"), PrdTurnFailedError);

    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    assert.doesNotMatch(project!.prdMarkdown || "", /Prose Markdown PRD/);
  });

  it("rejects ordinary explanatory summaries when no PRD artifact exists", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-explainer",
      runId: "run-explainer",
      summary: "我已生成 PRD，请查看 .ship/prd.md 文件。",
      success: true,
      changedFiles: [],
      items: [],
    }));

    await assert.rejects(
      () => prdTurn(projectId, "draft a PRD"),
      (err: Error) => {
        assert.ok(err instanceof PrdTurnFailedError);
        assert.match(err.message, /没有产出文档内容|无法解析/);
        return true;
      },
    );
  });

  it("does not reuse stale PRD artifacts when the current turn returns empty output", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".ship", "prd.json"),
      JSON.stringify(validStructuredPrd("Old JSON PRD"), null, 2),
    );
    fs.writeFileSync(path.join(tmpDir, ".ship", "prd.md"), prdLikeMarkdown("Old Markdown PRD"));
    seedRealProject(projectId, tmpDir, "revising", JSON.stringify(validStructuredPrd("Old DB PRD")));
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-stale-empty",
      runId: "run-stale-empty",
      summary: "",
      success: true,
      changedFiles: [],
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "revise PRD"), PrdTurnFailedError);

    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    const assistantEvent = latestPrdAssistantEvent(projectId);
    const raw = JSON.parse(assistantEvent!.rawJson || "{}");
    assert.equal(project!.prdStatus, "failed");
    assert.equal(raw.reason, "empty_prd_content");
    assert.doesNotMatch(project!.prdMarkdown || "", /Old JSON PRD/);
  });

  it("does not reuse stale PRD artifacts when the current turn returns non-PRD text", async () => {
    fs.writeFileSync(path.join(tmpDir, ".ship", "prd.md"), prdLikeMarkdown("Old Markdown PRD"));
    seedRealProject(projectId, tmpDir, "revising", JSON.stringify(validStructuredPrd("Old DB PRD")));
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-stale-nonprd",
      runId: "run-stale-nonprd",
      summary: "我已生成 PRD，请查看 .ship/prd.md 文件。",
      success: true,
      changedFiles: [],
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "revise PRD"), PrdTurnFailedError);

    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    const assistantEvent = latestPrdAssistantEvent(projectId);
    const raw = JSON.parse(assistantEvent!.rawJson || "{}");
    assert.equal(project!.prdStatus, "failed");
    assert.equal(raw.reason, "unparseable_prd_content");
  });

  it("keeps the line protocol authoritative over PRD artifacts the model wrote by hand", async () => {
    // These file channels used to outrank the reply. stagepass renders both
    // artifacts from the assembled payload now, so a hand-written prd.json is
    // just a stale file on disk -- never a source of truth.
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".ship", "prd.json"),
        JSON.stringify(validStructuredPrd("Hand Written JSON PRD"), null, 2),
      );
      fs.writeFileSync(path.join(tmpDir, ".ship", "prd.md"), prdLikeMarkdown("Hand Written Markdown PRD"));
      return {
        threadId: "thr-json-precedence",
        runId: "run-json-precedence",
        summary: prdLineProtocolText(validStructuredPrd("Protocol PRD")),
        success: true,
        changedFiles: [".ship/prd.json", ".ship/prd.md"],
        items: [],
      };
    });

    const result = await prdTurn(projectId, "draft a PRD");

    assert.match(result.prdContent || "", /Protocol PRD/);
    assert.doesNotMatch(result.prdContent || "", /Hand Written JSON PRD|Hand Written Markdown PRD/);
  });

  it("refuses a hand-written PRD artifact when the reply carries no protocol", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".ship", "prd.json"),
        JSON.stringify(validStructuredPrd("Hand Written JSON PRD"), null, 2),
      );
      return {
        threadId: "thr-md-precedence",
        runId: "run-md-precedence",
        summary: "我已生成 PRD，写在 .ship/prd.json 里了。",
        success: true,
        changedFiles: [".ship/prd.json"],
        items: [],
      };
    });

    await assert.rejects(() => prdTurn(projectId, "draft a PRD"), PrdTurnFailedError);

    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    assert.doesNotMatch(project!.prdMarkdown || "", /Hand Written JSON PRD/);
  });

  it("saves a draft whose validation still has errors without marking it ready", async () => {
    // Structurally valid protocol, business-invalid PRD (no functional
    // requirement): a draft must still land so the user can see the issues.
    seedRealProject(projectId, tmpDir, "drafting");
    const thin = validStructuredPrd("Thin PRD");
    thin.body.functionalRequirements = [];
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-invalid-md",
      runId: "run-invalid-md",
      summary: prdLineProtocolText(thin, "Draft PRD saved."),
      success: true,
      changedFiles: [],
      items: [],
    }));

    const result = await prdTurn(projectId, "draft a PRD");
    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    const assistantEvent = latestPrdAssistantEvent(projectId);

    assert.match(result.prdContent || "", /Thin PRD/);
    assert.equal(project!.prdStatus, "drafting");
    assert.match(project!.prdMarkdown || "", /Thin PRD/);
    assert.match(assistantEvent!.message || "", /校验|草稿/);
  });

  it("records failedFrom=drafting for empty successful engine output", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-empty",
      runId: "run-empty",
      summary: "",
      success: true,
      changedFiles: [],
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "draft a PRD"), PrdTurnFailedError);

    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    const assistantEvent = latestPrdAssistantEvent(projectId);
    const raw = JSON.parse(assistantEvent!.rawJson || "{}");
    assert.equal(project!.prdStatus, "failed");
    assert.equal(raw.failedFrom, "drafting");
  });

  it("records failedFrom=revising when a revision turn fails", async () => {
    seedRealProject(projectId, tmpDir, "revising", JSON.stringify(validStructuredPrd("Existing PRD")));
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-revising-fail",
      runId: "run-revising-fail",
      summary: "",
      success: true,
      changedFiles: [],
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "revise PRD"), PrdTurnFailedError);

    const assistantEvent = latestPrdAssistantEvent(projectId);
    const raw = JSON.parse(assistantEvent!.rawJson || "{}");
    assert.equal(raw.failedFrom, "revising");
  });

  it("retries from failed, restores the running state, and saves a successful draft", async () => {
    seedRealProject(projectId, tmpDir, "failed");
    await appDb.insert(events).values({
      id: `${projectId}-EVT-FAIL`,
      changeId: null,
      runId: null,
      type: "prd_assistant",
      message: "PRD 生成失败",
      rawJson: JSON.stringify({ projectId, phase: "prd", provider: "codex", status: "failed", failedFrom: "drafting" }),
      createdAt: new Date().toISOString(),
    }).run();
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-retry",
      runId: "run-retry",
      summary: prdLineProtocolText(validStructuredPrd("Retry PRD")),
      success: true,
      changedFiles: [],
      items: [],
    }));

    const result = await prdTurn(projectId, "try again");

    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    assert.equal(project!.prdStatus, "drafting");
    assert.match(result.prdContent || "", /Retry PRD/);
    assert.match(project!.prdMarkdown || "", /Retry PRD/);
  });

  it("resumes the latest provider timeout session when retrying a failed PRD turn", async () => {
    seedRealProject(projectId, tmpDir, "failed");
    await appDb.insert(events).values({
      id: `${projectId}-EVT-TIMEOUT`,
      changeId: null,
      runId: null,
      type: "prd_assistant",
      message: "PRD generation timed out",
      rawJson: JSON.stringify({
        projectId,
        phase: "prd",
        provider: "codex",
        status: "failed",
        reason: "provider_timeout",
        engineThreadId: "  sess-progress  ",
        failedFrom: "drafting",
      }),
      createdAt: new Date().toISOString(),
    }).run();
    let observedThreadId: string | undefined;
    restoreEngine = mockPrdEngine(async (input) => {
      observedThreadId = input.threadId;
      return {
        threadId: "sess-progress",
        runId: "run-retry-timeout",
        summary: prdLineProtocolText(validStructuredPrd("Resumed Timeout PRD")),
        success: true,
        changedFiles: [],
        items: [],
      };
    });

    await prdTurn(projectId, "continue after timeout");

    assert.equal(observedThreadId, "sess-progress");
  });

  it("uses event id as a deterministic tiebreaker for failed PRD events in the same millisecond", async () => {
    seedRealProject(projectId, tmpDir, "failed");
    const createdAt = new Date().toISOString();
    await appDb.insert(events).values([
      {
        id: `${projectId}-EVT-001`,
        changeId: null,
        runId: null,
        type: "prd_assistant",
        message: "older Claude timeout",
        rawJson: JSON.stringify({
          projectId,
          phase: "prd",
          provider: "claude",
          status: "failed",
          reason: "provider_timeout",
          engineThreadId: "older-claude-session",
          failedFrom: "revising",
        }),
        createdAt,
      },
      {
        id: `${projectId}-EVT-002`,
        changeId: null,
        runId: null,
        type: "prd_assistant",
        message: "newer Codex timeout",
        rawJson: JSON.stringify({
          projectId,
          phase: "prd",
          provider: "codex",
          status: "failed",
          reason: "provider_timeout",
          engineThreadId: "newer-codex-session",
          failedFrom: "drafting",
        }),
        createdAt,
      },
    ]).run();
    let observedThreadId: string | undefined;
    restoreEngine = mockPrdEngine(async (input) => {
      observedThreadId = input.threadId;
      return {
        threadId: "newer-codex-session",
        runId: "run-same-millisecond-retry",
        summary: prdLineProtocolText(validStructuredPrd("Deterministic Retry PRD")),
        success: true,
        changedFiles: [],
        items: [],
      };
    });

    await prdTurn(projectId, "retry the newest failure", "codex");

    assert.equal(observedThreadId, "newer-codex-session");
    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    assert.equal(project!.prdStatus, "drafting");
  });

  it("does not resume a failed PRD session when the latest failure was not a provider timeout", async () => {
    seedRealProject(projectId, tmpDir, "failed");
    await appDb.insert(events).values({
      id: `${projectId}-EVT-ENGINE-FAIL`,
      changeId: null,
      runId: null,
      type: "prd_assistant",
      message: "PRD generation failed",
      rawJson: JSON.stringify({
        projectId,
        phase: "prd",
        provider: "codex",
        status: "failed",
        reason: "engine_failed",
        engineThreadId: "sess-engine-fail",
        failedFrom: "drafting",
      }),
      createdAt: new Date().toISOString(),
    }).run();
    let observedThreadId: string | undefined;
    restoreEngine = mockPrdEngine(async (input) => {
      observedThreadId = input.threadId;
      return {
        threadId: "fresh-session",
        runId: "run-fresh-after-engine-fail",
        summary: prdLineProtocolText(validStructuredPrd("Fresh Engine Failure Retry PRD")),
        success: true,
        changedFiles: [],
        items: [],
      };
    });

    await prdTurn(projectId, "retry after engine failure");

    assert.equal(observedThreadId, undefined);
  });

  for (const [label, engineThreadId] of [
    ["missing", undefined],
    ["blank", "   "],
  ] as const) {
    it(`does not resume a provider timeout session when engineThreadId is ${label}`, async () => {
      seedRealProject(projectId, tmpDir, "failed");
      await appDb.insert(events).values({
        id: `${projectId}-EVT-TIMEOUT-${label}`,
        changeId: null,
        runId: null,
        type: "prd_assistant",
        message: "PRD generation timed out",
        rawJson: JSON.stringify({
          projectId,
          phase: "prd",
          provider: "codex",
          status: "failed",
          reason: "provider_timeout",
          engineThreadId,
          failedFrom: "drafting",
        }),
        createdAt: new Date().toISOString(),
      }).run();
      let observedThreadId: string | undefined;
      restoreEngine = mockPrdEngine(async (input) => {
        observedThreadId = input.threadId;
        return {
          threadId: "fresh-session",
          runId: `run-fresh-${label}`,
          summary: prdLineProtocolText(validStructuredPrd(`Fresh ${label} Session PRD`)),
          success: true,
          changedFiles: [],
          items: [],
        };
      });

      await prdTurn(projectId, "retry without resumable session");

      assert.equal(observedThreadId, undefined);
    });
  }

  it("does not resume a provider timeout session whose engineThreadId is the unknown sentinel", async () => {
    seedRealProject(projectId, tmpDir, "failed");
    await appDb.insert(events).values({
      id: `${projectId}-EVT-TIMEOUT-UNKNOWN`,
      changeId: null,
      runId: null,
      type: "prd_assistant",
      message: "Legacy PRD timeout without a captured provider session",
      rawJson: JSON.stringify({
        projectId,
        phase: "prd",
        provider: "codex",
        status: "failed",
        reason: "provider_timeout",
        engineThreadId: "  UnKnOwN  ",
        failedFrom: "drafting",
      }),
      createdAt: new Date().toISOString(),
    }).run();
    let observedThreadId: string | undefined;
    restoreEngine = mockPrdEngine(async (input) => {
      observedThreadId = input.threadId;
      return {
        threadId: "fresh-after-unknown-sentinel",
        runId: "run-fresh-after-unknown-sentinel",
        summary: prdLineProtocolText(validStructuredPrd("Fresh Unknown Sentinel Retry PRD")),
        success: true,
        changedFiles: [],
        items: [],
      };
    });

    await prdTurn(projectId, "retry legacy timeout without a real session");

    assert.equal(observedThreadId, undefined);
  });

  it("does not resume a timeout session from a different provider", async () => {
    seedRealProject(projectId, tmpDir, "failed");
    await appDb.insert(events).values({
      id: `${projectId}-EVT-CLAUDE-TIMEOUT`,
      changeId: null,
      runId: null,
      type: "prd_assistant",
      message: "Claude PRD generation timed out",
      rawJson: JSON.stringify({
        projectId,
        phase: "prd",
        provider: "claude",
        status: "failed",
        reason: "provider_timeout",
        engineThreadId: "claude-timeout-session",
        failedFrom: "drafting",
      }),
      createdAt: new Date().toISOString(),
    }).run();
    let observedThreadId: string | undefined;
    restoreEngine = mockPrdEngine(async (input) => {
      observedThreadId = input.threadId;
      return {
        threadId: "codex-fresh-session",
        runId: "run-codex-provider-switch",
        summary: prdLineProtocolText(validStructuredPrd("Codex Provider Switch PRD")),
        success: true,
        changedFiles: [],
        items: [],
      };
    });

    await prdTurn(projectId, "retry with Codex", "codex");

    assert.equal(observedThreadId, undefined);
  });

  it("does not pass a resume thread on an ordinary first PRD turn", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    let observedThreadId: string | undefined;
    restoreEngine = mockPrdEngine(async (input) => {
      observedThreadId = input.threadId;
      return {
        threadId: "first-turn-session",
        runId: "run-first-turn",
        summary: prdLineProtocolText(validStructuredPrd("First Turn PRD")),
        success: true,
        changedFiles: [],
        items: [],
      };
    });

    await prdTurn(projectId, "draft a PRD");

    assert.equal(observedThreadId, undefined);
  });

  it("passes the configured timeoutMs to the PRD engine", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    process.env.STAGEPASS_PRD_TIMEOUT_MS = "123456";
    let observedTimeoutMs: number | undefined;
    restoreEngine = mockPrdEngine(async (input) => {
      observedTimeoutMs = input.timeoutMs;
      return {
        threadId: "thr-timeout",
        runId: "run-timeout",
        summary: prdLineProtocolText(validStructuredPrd("Timeout PRD")),
        success: true,
        changedFiles: [],
        items: [],
      };
    });

    await prdTurn(projectId, "draft a PRD");

    assert.equal(observedTimeoutMs, 123456);
  });

  it("uses the shared thirty minute default timeoutMs", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    delete process.env.STAGEPASS_PRD_TIMEOUT_MS;
    let observedTimeoutMs: number | undefined;
    restoreEngine = mockPrdEngine(async (input) => {
      observedTimeoutMs = input.timeoutMs;
      return {
        threadId: "thr-default-timeout",
        runId: "run-default-timeout",
        summary: prdLineProtocolText(validStructuredPrd("Default Timeout PRD")),
        success: true,
        changedFiles: [],
        items: [],
      };
    });

    await prdTurn(projectId, "draft a PRD");

    assert.equal(observedTimeoutMs, 1_800_000);
  });

  it("sends no output schema and only needs to read the repo", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    let observedOutputSchema: unknown = "unset";
    let observedSandboxMode: unknown;
    let observedPrompt = "";
    restoreEngine = mockPrdEngine(async (input) => {
      observedOutputSchema = input.outputSchema;
      observedSandboxMode = input.sandboxMode;
      observedPrompt = input.prompt;
      return {
        threadId: "thr-prd-schema",
        runId: "run-prd-schema",
        summary: prdLineProtocolText(validStructuredPrd("Schema PRD")),
        success: true,
        changedFiles: [],
        items: [],
      };
    });

    await prdTurn(projectId, "draft a PRD");

    // Handing the model a schema is the invitation to author JSON; StructuredPrdSchema
    // stays server-side as the second gate over the assembled payload.
    assert.equal(observedOutputSchema, undefined);
    // The model no longer writes .ship/prd.* itself, so the turn needs no write access.
    assert.equal(observedSandboxMode, "read-only");
    assert.match(observedPrompt, /TITLE: PRD 标题/);
    assert.match(observedPrompt, /PRD_DONE: true/);
    assert.match(observedPrompt, /不要输出任何 JSON、对象字面量或花括号结构/);
    assert.doesNotMatch(observedPrompt, /```json/);
  });

  it("marks provider_timeout engine failures as failed events", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-provider-timeout",
      runId: "run-provider-timeout",
      summary: "provider_timeout: Codex timed out after 300000ms",
      success: false,
      changedFiles: [],
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "draft a PRD"), PrdTurnFailedError);

    const project = appDb.select().from(projects).where(eq(projects.id, projectId)).get();
    const assistantEvent = latestPrdAssistantEvent(projectId);
    const raw = JSON.parse(assistantEvent!.rawJson || "{}");
    assert.equal(project!.prdStatus, "failed");
    assert.equal(raw.reason, "provider_timeout");
    assert.equal(raw.failedFrom, "drafting");
  });

  it("classifies aborted Codex PRD runs from provider metadata as provider timeouts", async () => {
    seedRealProject(projectId, tmpDir, "drafting");
    restoreEngine = mockPrdEngine(async () => ({
      threadId: "thr-provider-aborted",
      runId: "run-provider-aborted",
      summary: "Codex run failed: The operation was aborted",
      success: false,
      changedFiles: [],
      providerErrorCode: "provider_timeout",
      providerErrorDetail: "The operation was aborted",
      items: [],
    }));

    await assert.rejects(() => prdTurn(projectId, "draft a PRD"), PrdTurnFailedError);

    const assistantEvent = latestPrdAssistantEvent(projectId);
    const raw = JSON.parse(assistantEvent!.rawJson || "{}");
    assert.equal(raw.reason, "provider_timeout");
    assert.match(assistantEvent!.message ?? "", /超时或被中止/);
  });
});

describe("PRD editor failed UI contract", () => {
  it("has a dedicated failed branch that keeps chat and hides confirmation", () => {
    const editorPath = path.join(process.cwd(), "app", "projects", "[id]", "prd-editor.tsx");
    const editor = fs.readFileSync(editorPath, "utf-8");
    const failedBranch = editor.slice(editor.indexOf('prdStatus === "failed"'));

    assert.match(editor, /prdStatus === "failed"/);
    assert.match(failedBranch, /PRD 生成失败|上次失败/);
    assert.match(failedBranch, /handleSend/);
    assert.match(failedBranch, /prdContent/);
    assert.doesNotMatch(failedBranch.slice(0, failedBranch.indexOf("// --- Status: drafting") || undefined), /handleConfirm/);
  });

  it("refreshes server PRD status after every send attempt", () => {
    const editorPath = path.join(process.cwd(), "app", "projects", "[id]", "prd-editor.tsx");
    const editor = fs.readFileSync(editorPath, "utf-8");
    const handleSend = editor.slice(editor.indexOf("async function handleSend"), editor.indexOf("async function handleConfirm"));
    const finallyBlock = handleSend.slice(handleSend.indexOf("finally"));

    assert.match(handleSend, /onStatusChange/);
    assert.match(finallyBlock, /onStatusChange\(\)/);
    assert.match(finallyBlock, /setLoading\(false\)/);
  });
});
