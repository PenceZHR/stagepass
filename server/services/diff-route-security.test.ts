import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { eq } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";

import { GET } from "../../app/api/projects/[id]/changes/[changeId]/diff/route.ts";
import { db } from "../db/index.ts";
import { changes, projects } from "../db/schema.ts";

const PROJECT_ID = "PRJ-DIFF-SEC";
const CHANGE_ID = "CHG-DIFF-SEC";

let tempDirs: string[] = [];

function cleanupRows() {
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function makeRepo() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "diff-route-repo-"));
  tempDirs.push(repoPath);
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });

  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Diff security",
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
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Diff security change",
    status: "IMPLEMENTED",
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

  return repoPath;
}

function writeChangedFiles(repoPath: string, files: unknown) {
  const changedFilesPath = path.join(
    repoPath,
    ".ship",
    "changes",
    CHANGE_ID,
    "changed-files.json"
  );
  fs.mkdirSync(path.dirname(changedFilesPath), { recursive: true });
  fs.writeFileSync(changedFilesPath, JSON.stringify(files, null, 2));
}

async function callDiff() {
  return GET(new Request("http://localhost/api/diff"), {
    params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }),
  });
}

afterEach(() => {
  cleanupRows();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("diff route security", () => {
  it("rejects absolute changed file paths without reading local files", async () => {
    cleanupRows();
    const repoPath = makeRepo();
    const outsidePath = path.join(os.tmpdir(), `diff-secret-${Date.now()}.txt`);
    tempDirs.push(outsidePath);
    fs.writeFileSync(outsidePath, "super-secret-token");
    writeChangedFiles(repoPath, [outsidePath]);

    const response = await callDiff();
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /Invalid changed-files\.json/);
    assert.doesNotMatch(body, /super-secret-token/);
  });

  it("passes changed files to git without shell interpretation", async () => {
    cleanupRows();
    const repoPath = makeRepo();
    const markerPath = path.join(os.tmpdir(), `diff-shell-marker-${Date.now()}`);
    tempDirs.push(markerPath);
    const hostileFile = `evil"; touch ${markerPath}; echo ".txt`;
    writeChangedFiles(repoPath, [hostileFile]);

    const response = await callDiff();
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(body, /Invalid changed-files\.json/);
    assert.equal(fs.existsSync(markerPath), false);
  });
});
