import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { db } from "@/server/db";
import { artifactMirrors, artifacts, changes, projects } from "@/server/db/schema";
import { eq } from "drizzle-orm";

import { CONTENT_PHASES } from "@/server/services/change-phase-service";
import { GET } from "./route.ts";

/**
 * The route is driven for real -- real Request, real rows, real files on disk --
 * because the guarantee under test is only observable end to end: that a single
 * unreadable row degrades to a marker about *that row* while every other phase
 * still comes back.
 *
 * The regression this pins: GET /phases wraps everything in one try/catch that
 * answers 500 PHASE_REVIEW_UNAVAILABLE. Two per-row loops inside it had no
 * per-row recovery --
 *
 *   1. artifact-mirror-service `inspectArtifactMirrors`, whose rows.flatMap ran
 *      inspectMirrorRow per row; that calls lstat/realpath through helpers that
 *      only swallow ENOENT, so a row whose path had a non-directory component
 *      (ENOTDIR), an unreadable parent (EACCES) or a symlink cycle (ELOOP)
 *      threw straight out of the flatMap.
 *   2. change-phase-service `readKnownFiles`, whose loop called readFileSync
 *      after an existsSync guard; existsSync answers true for a directory, so a
 *      path that is a directory threw EISDIR (and an unreadable file EACCES).
 *
 * Either throw escaped into the route's catch, so one bad row deleted the whole
 * page: every phase, every gate, every action, replaced by a 500. The blast
 * radius has to stay at the row that actually failed.
 *
 * The phase count is read off CONTENT_PHASES rather than hard-coded, so adding a
 * stage cannot quietly weaken this assertion.
 */

const PROJECT_ID = "PRJ-PHASE-ROW-DEGRADE";
const CHANGE_ID = "CHG-PHASE-ROW-DEGRADE";
const NOW = "2026-07-22T00:00:00.000Z";

let repoPath: string;

function changeArtifactDir(): string {
  return path.join(repoPath, ".ship", "changes", CHANGE_ID);
}

function cleanupRows() {
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

async function getPhases(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await GET(
    new Request(
      `http://localhost/api/projects/${PROJECT_ID}/changes/${CHANGE_ID}/phases?phase=Plan`,
    ),
    { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

before(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-row-degrade-"));
  cleanupRows();

  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Phase row degradation",
    repoPath,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Phase row degradation",
    status: "PLAN_APPROVED",
    provider: "codex",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();

  const dir = changeArtifactDir();
  fs.mkdirSync(dir, { recursive: true });

  // A healthy Plan artifact: this is the content that must survive a bad
  // neighbour. plan.json is a real definition for the Plan phase.
  fs.writeFileSync(path.join(dir, "plan.json"), '{"status":"passed"}\n', "utf-8");
});

after(() => {
  cleanupRows();
  if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("GET /phases keeps one bad row from deleting the whole page", () => {
  it("still answers with every phase when a mirror row's path has a non-directory component", async () => {
    // plan.json is a regular file, so lstat/realpath of a path *through* it is
    // ENOTDIR, not ENOENT. A stale mirror row pointing below a path that later
    // became a file is exactly how production reaches this.
    db.insert(artifactMirrors).values({
      id: "AMR-DEGRADE-BAD",
      changeId: CHANGE_ID,
      phase: "Plan",
      artifactType: "plan_json",
      path: path.join(changeArtifactDir(), "plan.json", "nested.json"),
      contentHash: "deadbeef",
      sourceDbHash: "plan-source-db-hash",
      schemaVersion: "plan/v1",
      mirrorStatus: "ok",
      generatedAt: NOW,
    }).run();

    const { status, body } = await getPhases();

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    const phases = body.phases as Array<{ phase: string }> | undefined;
    assert.ok(Array.isArray(phases), "phases array must survive a bad mirror row");
    assert.equal(
      phases.length,
      CONTENT_PHASES.length,
      "every phase must still be returned",
    );

    // The failure must be visible, not swallowed: the bad row reports itself.
    const warnings = body.mirrorWarnings as Array<{ id: string; warning: string }>;
    const bad = warnings.find((warning) => warning.id === "AMR-DEGRADE-BAD");
    assert.ok(bad, `bad row must surface a warning, got ${JSON.stringify(warnings)}`);
    assert.equal(bad.warning, "inspect_failed");
  });

  it("still answers with every phase when a known artifact path is a directory", async () => {
    // existsSync answers true for a directory; readFileSync then throws EISDIR.
    // plan.md is a real Plan definition, so readKnownFiles will try to read it.
    fs.mkdirSync(path.join(changeArtifactDir(), "plan.md"), { recursive: true });
    // A DB row for the unreadable path, so the degraded outcome is observable
    // in the response rather than only in the log: an artifact row renders even
    // when its content could not be loaded.
    db.insert(artifacts).values({
      id: "ART-DEGRADE-BAD",
      changeId: CHANGE_ID,
      runId: null,
      type: "plan_md",
      path: path.join(changeArtifactDir(), "plan.md"),
      createdAt: NOW,
    }).run();

    const { status, body } = await getPhases();

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    const phases = body.phases as Array<{ phase: string; artifactCount: number }>;
    assert.equal(
      phases.length,
      CONTENT_PHASES.length,
      "every phase must still be returned",
    );

    // The healthy neighbour in the same phase must still be readable.
    const selected = body.selected as {
      artifacts: Array<{ id: string; fileName: string; content: string | null; missing: boolean }>;
    };
    const planJson = selected.artifacts.find((artifact) => artifact.fileName === "plan.json");
    assert.ok(planJson, "healthy plan.json must still be present");
    assert.equal(planJson.content, '{"status":"passed"}\n');

    // The unreadable one must not masquerade as healthy: no fabricated content,
    // and flagged missing. Degrading is allowed to lose the content, never to
    // claim the content was fine.
    const planMd = selected.artifacts.find((artifact) => artifact.id === "ART-DEGRADE-BAD");
    assert.ok(planMd, "unreadable artifact row must still be listed");
    assert.equal(planMd.content, null, "unreadable file must not report content");
    assert.equal(planMd.missing, true, "unreadable file must be flagged missing");
  });
});
