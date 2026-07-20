import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as schema from "../db/schema.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  createApiSnapshot,
  createTechSpecAndApiSnapshots,
  createTechSpecSnapshot,
  DesignSnapshotValidationError,
  getBuildDesignInputs,
  getLatestTechSpecSnapshot,
  getReviewDesignInputs,
  MissingDesignSnapshotError,
  normalizeDesignSections,
  setTechSpecApiSnapshotServiceDbForTest,
} from "./techspec-api-snapshot-service.ts";
import {
  inspectArtifactMirrors,
  renderMirrorsFromDb,
  setArtifactMirrorServiceDbForTest,
} from "./artifact-mirror-service.ts";

const PROJECT_ID = "PRJ-TECHSPEC-API";
const CHANGE_ID = "CHG-TECHSPEC-API";
const NOW = "2026-06-29T00:00:00.000Z";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  runMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function seedChange(db: ReturnType<typeof createTestDb>, repoPath: string) {
  db.insert(schema.projects).values({
    id: PROJECT_ID,
    name: "TechSpec API",
    repoPath,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(schema.changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "DB first TechSpec/API",
    status: "TECHSPEC_READY",
    provider: "codex",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

describe("techspec/api snapshot service", () => {
  let repoPath = "";
  let cleanupDb: (() => void) | null = null;
  let cleanupMirrorDb: (() => void) | null = null;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ai-techspec-api-"));
  });

  afterEach(() => {
    cleanupDb?.();
    cleanupDb = null;
    cleanupMirrorDb?.();
    cleanupMirrorDb = null;
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("loads build and review design inputs from DB snapshots after mirror tampering", () => {
    const db = createTestDb();
    cleanupDb = setTechSpecApiSnapshotServiceDbForTest(db);
    cleanupMirrorDb = setArtifactMirrorServiceDbForTest(db);
    seedChange(db, repoPath);

    const techSpec = createTechSpecSnapshot({
      changeId: CHANGE_ID,
      status: "approved",
      sourceSpecHash: "spec-db-hash",
      schemaVersion: "techspec/v1",
      reviewedAt: NOW,
      createdAt: NOW,
      content: {
        interfaces: [{ method: "GET", endpoint: "/api/projects/:id", required: true }],
        dataContracts: [{ name: "ProjectResponse", fields: ["id", "name"] }],
        migrationNotes: [],
        buildInputs: ["Preserve GET /api/projects/:id"],
        reviewInputs: ["Review project route compatibility"],
      },
    });
    const api = createApiSnapshot({
      changeId: CHANGE_ID,
      status: "approved",
      sourceTechspecHash: techSpec.contentDbHash,
      schemaVersion: "api/v1",
      reviewedAt: NOW,
      createdAt: NOW,
      contract: {
        interfaces: [{ method: "GET", endpoint: "/api/projects/:id" }],
        dataContracts: [{ response: "ProjectResponse", requiredFields: ["actions"] }],
        migrationNotes: [],
        buildInputs: ["Response must include actions"],
        reviewInputs: ["Verify actions remains in response"],
      },
    });

    const mirrorResults = renderMirrorsFromDb({
      db,
      repoPath,
      changeId: CHANGE_ID,
      generatedAt: NOW,
      mirrors: [
        {
          phase: "Build",
          artifactType: "tech_spec_delta",
          fileName: "tech-spec-delta.md",
          schemaVersion: techSpec.schemaVersion,
          sourceDbHash: techSpec.contentDbHash,
          payload: techSpec.content,
        },
        {
          phase: "Build",
          artifactType: "api_spec_delta",
          fileName: "api-spec-delta.md",
          schemaVersion: api.schemaVersion,
          sourceDbHash: api.contractDbHash,
          payload: api.contract,
        },
      ],
    });
    const sourceDbHashesBeforeTamper = mirrorResults.map((result) => result.sourceDbHash);

    fs.writeFileSync(
      path.join(repoPath, ".ship", "changes", CHANGE_ID, "tech-spec-delta.md"),
      "tampered: endpoint /api/projects/:id removed\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(repoPath, ".ship", "changes", CHANGE_ID, "api-spec-delta.md"),
      "tampered: response field actions removed\n",
      "utf-8",
    );

    const buildInputs = getBuildDesignInputs(CHANGE_ID);
    const reviewInputs = getReviewDesignInputs(CHANGE_ID);

    assert.match(JSON.stringify(buildInputs.techSpec.content), /\/api\/projects\/:id/);
    assert.match(JSON.stringify(buildInputs.api.contract), /actions/);
    assert.match(JSON.stringify(reviewInputs.techSpec.content), /\/api\/projects\/:id/);
    assert.match(JSON.stringify(reviewInputs.api.contract), /actions/);
    assert.deepEqual(
      [buildInputs.techSpec.contentDbHash, buildInputs.api.contractDbHash],
      [techSpec.contentDbHash, api.contractDbHash],
    );

    const warnings = inspectArtifactMirrors(CHANGE_ID, "Build");
    assert.equal(warnings.filter((warning) => warning.mirrorStatus === "mismatch").length, 2);
    const mirrorRows = db
      .select()
      .from(schema.artifactMirrors)
      .where(eq(schema.artifactMirrors.changeId, CHANGE_ID))
      .all()
      .sort((left, right) => left.artifactType.localeCompare(right.artifactType));
    assert.deepEqual(
      mirrorRows.map((row) => row.sourceDbHash).sort(),
      sourceDbHashesBeforeTamper.sort(),
    );
  });

  it("throws missing_design_snapshot when either DB snapshot is missing", () => {
    const db = createTestDb();
    cleanupDb = setTechSpecApiSnapshotServiceDbForTest(db);
    seedChange(db, repoPath);

    assert.throws(
      () => getBuildDesignInputs(CHANGE_ID),
      (error) =>
        error instanceof MissingDesignSnapshotError &&
        error.reasonCode === "missing_design_snapshot",
    );
  });

  it("rejects non-structured candidates before writing DB snapshots", () => {
    const db = createTestDb();
    cleanupDb = setTechSpecApiSnapshotServiceDbForTest(db);
    seedChange(db, repoPath);

    assert.throws(
      () =>
        createTechSpecSnapshot({
          changeId: CHANGE_ID,
          status: "approved",
          content: "plain markdown is not authoritative",
        }),
      DesignSnapshotValidationError,
    );
    assert.equal(
      db.select().from(schema.techspecSnapshots).where(eq(schema.techspecSnapshots.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.throws(
      () =>
        createApiSnapshot({
          changeId: CHANGE_ID,
          status: "approved",
          contract: { interfaces: [], dataContracts: [] },
        }),
      /missing section: migrationNotes/,
    );
  });

  it("normalizes the production fenced JSON TechSpec summary as an object", () => {
    const candidate = `\`\`\`json
{
  "interfaces": [{"name":"ReplayExport"}],
  "dataContracts": [{"name":"ReplayRecord"}],
  "migrationNotes": [],
  "buildInputs": ["src/replay.js"],
  "reviewInputs": ["deterministic output"]
}
\`\`\``;

    assert.deepEqual(normalizeDesignSections(candidate), {
      interfaces: [{ name: "ReplayExport" }],
      dataContracts: [{ name: "ReplayRecord" }],
      migrationNotes: [],
      buildInputs: ["src/replay.js"],
      reviewInputs: ["deterministic output"],
    });
  });

  it("still rejects malformed, array, and non-object fenced design candidates", () => {
    for (const candidate of [
      "```json\n{not-json}\n```",
      "```json\n[]\n```",
      "```json\n\"string\"\n```",
    ]) {
      assert.throws(() => normalizeDesignSections(candidate), DesignSnapshotValidationError);
    }
  });

  it("keeps DB snapshots and the repository tree unchanged for invalid production persistence inputs", () => {
    const db = createTestDb();
    cleanupDb = setTechSpecApiSnapshotServiceDbForTest(db);
    seedChange(db, repoPath);
    const valid = {
      interfaces: [],
      dataContracts: [],
      migrationNotes: [],
      buildInputs: [],
      reviewInputs: [],
    };
    const invalidCandidates = [
      "```json\n{not-json}\n```",
      "```json\n[]\n```",
      "```json\n\"string\"\n```",
    ];
    const snapshotState = () => ({
      techSpecCount: db.select().from(schema.techspecSnapshots)
        .where(eq(schema.techspecSnapshots.changeId, CHANGE_ID)).all().length,
      apiCount: db.select().from(schema.apiSnapshots)
        .where(eq(schema.apiSnapshots.changeId, CHANGE_ID)).all().length,
      repoTree: fs.readdirSync(repoPath, { recursive: true, encoding: "utf-8" }).sort(),
    });
    const before = snapshotState();

    for (const candidate of invalidCandidates) {
      assert.throws(() => createTechSpecSnapshot({
        changeId: CHANGE_ID,
        status: "approved",
        content: candidate,
      }), DesignSnapshotValidationError);
      assert.throws(() => createApiSnapshot({
        changeId: CHANGE_ID,
        status: "approved",
        contract: candidate,
      }), DesignSnapshotValidationError);
      assert.throws(() => createTechSpecAndApiSnapshots({
        changeId: CHANGE_ID,
        status: "approved",
        techSpecContent: valid,
        apiContract: candidate,
      }), DesignSnapshotValidationError);
      assert.throws(() => createTechSpecAndApiSnapshots({
        changeId: CHANGE_ID,
        status: "approved",
        techSpecContent: candidate,
        apiContract: valid,
      }), DesignSnapshotValidationError);
      assert.deepEqual(snapshotState(), before);
    }
  });

  it("selects only approved or passed snapshots as latest authority", () => {
    const db = createTestDb();
    cleanupDb = setTechSpecApiSnapshotServiceDbForTest(db);
    seedChange(db, repoPath);

    createTechSpecSnapshot({
      changeId: CHANGE_ID,
      status: "draft",
      createdAt: "2026-06-29T00:01:00.000Z",
      content: {
        interfaces: [{ endpoint: "/draft" }],
        dataContracts: [],
        migrationNotes: [],
        buildInputs: [],
        reviewInputs: [],
      },
    });
    const approved = createTechSpecSnapshot({
      changeId: CHANGE_ID,
      status: "approved",
      createdAt: "2026-06-29T00:00:00.000Z",
      content: {
        interfaces: [{ endpoint: "/approved" }],
        dataContracts: [],
        migrationNotes: [],
        buildInputs: [],
        reviewInputs: [],
      },
    });

    assert.equal(getLatestTechSpecSnapshot(CHANGE_ID)?.id, approved.id);
  });
});
