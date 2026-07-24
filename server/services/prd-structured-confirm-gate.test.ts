import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import { projects } from "../db/schema.ts";
import { readStoredStructuredPrd } from "./prd-document-service.ts";

/**
 * The confirm gate used to read "PRD is broken" and "there is no PRD" as the
 * same thing.
 *
 * `readStructuredPrd` returns null for a document that fails JSON.parse AND for
 * one that fails StructuredPrdSchema, and both confirm paths (confirmPrd and
 * confirmPrdRevision -- the same rule written twice) treated that null as
 * "nothing structured to validate" and marked the project ready. The single
 * case the gate exists to catch was the one case it skipped.
 *
 * Pinned at the source rather than by driving confirmPrd end to end: that call
 * reaches initializeProjectContext, which spends a real provider run.
 */
const PROJECT_ID = "PRJ-STRUCTURED-GATE";

function seed(prdJson: string | null) {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: PROJECT_ID,
    repoPath: "/tmp/prj-structured-gate",
    contextStatus: "pending",
    contextProvider: "codex",
    prdStatus: "drafting",
    prdProvider: "codex",
    prdJson,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

const VALID_PRD = JSON.stringify({
  version: 1,
  body: { title: "标题", overview: "概述", targetUsers: "目标用户" },
  aiAppendix: {},
});

describe("stored structured PRD: broken is not the same as absent", { concurrency: false }, () => {
  beforeEach(() => {
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  });
  afterEach(() => {
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  });

  it("reports a project with no prdJson as missing", () => {
    seed(null);
    assert.equal(readStoredStructuredPrd(PROJECT_ID).kind, "missing");
  });

  it("reports unparseable prdJson as invalid, not missing", () => {
    seed("{not json at all");
    assert.equal(
      readStoredStructuredPrd(PROJECT_ID).kind,
      "invalid",
      "a corrupt document must not read as absent -- that is what skipped validation",
    );
  });

  it("reports schema-invalid prdJson as invalid, not missing", () => {
    // The realistic trigger: adding a required field to StructuredPrdSchema
    // invalidates every stored PRD at once. Collapsing that to `missing` would
    // silently stop validating every project instead of failing loudly.
    seed(JSON.stringify({ version: 1, body: { title: "只有标题" } }));
    assert.equal(readStoredStructuredPrd(PROJECT_ID).kind, "invalid");
  });

  it("still returns a valid document", () => {
    seed(VALID_PRD);
    assert.equal(readStoredStructuredPrd(PROJECT_ID).kind, "ok");
  });
});
