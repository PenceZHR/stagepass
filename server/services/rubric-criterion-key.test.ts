import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { eq, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { changes, projects, rubricAssessments, rubricCriteria, rubrics } from "../db/schema.ts";
import { getCurrentRubric, listRubricVersions, saveRubricVersion } from "./rubric-service.ts";

/**
 * §5.1: a criterion needs an identity that survives an edit.
 *
 * Batch 5 derives a requirement gap from a blocking `no`. If that gap is keyed
 * on the criterion ROW, then -- because every save appends a whole new version
 * with fresh rows -- one rubric edit orphans every open rubric-derived gap:
 * blue cannot recheck a gap it never reported, `human_cannot_resolve_gap`
 * forbids a person from closing it, and only P1 is waivable. An orphaned P0
 * would jam the Spec gate with no exit. These tests are what stops that from
 * being reachable.
 */

const PROJECT_ID = "PRJ-RUBRIC-KEY-001";
const CHANGE_ID = "CHG-RUBRIC-KEY-001";

const SCOPE = {
  projectId: PROJECT_ID,
  changeId: null,
  phase: "Spec" as const,
  role: "producer" as const,
};

function cleanupRows() {
  const rubricIds = db
    .select({ id: rubrics.id })
    .from(rubrics)
    .where(like(rubrics.projectId, "PRJ-RUBRIC-KEY-%"))
    .all()
    .map((row) => row.id);
  for (const rubricId of rubricIds) {
    db.delete(rubricAssessments).where(eq(rubricAssessments.rubricId, rubricId)).run();
    db.delete(rubricCriteria).where(eq(rubricCriteria.rubricId, rubricId)).run();
  }
  db.delete(rubrics).where(like(rubrics.projectId, "PRJ-RUBRIC-KEY-%")).run();
  db.delete(changes).where(like(changes.id, "CHG-RUBRIC-KEY-%")).run();
  db.delete(projects).where(like(projects.id, "PRJ-RUBRIC-KEY-%")).run();
}

function seed() {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Rubric key",
      repoPath: `/tmp/rubric-key-${Date.now()}`,
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
    })
    .run();
  db.insert(changes)
    .values({
      id: CHANGE_ID,
      projectId: PROJECT_ID,
      title: "Rubric key change",
      status: "SPEC_READY",
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

beforeEach(() => {
  cleanupRows();
  seed();
});

afterEach(cleanupRows);

describe("criterion identity survives editing", () => {
  it("keeps the same key when a criterion's text is unchanged", () => {
    const first = saveRubricVersion({
      ...SCOPE,
      criteria: [{ text: "Every requirement has an acceptance criterion" }, { text: "No contradictions" }],
    });
    // A caller that does not track keys at all -- §5.1's literal rule.
    const second = saveRubricVersion({
      ...SCOPE,
      criteria: [
        { text: "Every requirement has an acceptance criterion" },
        { text: "No contradictions" },
        { text: "A brand new standard" },
      ],
    });

    assert.notDeepEqual(
      second.criteria.map((criterion) => criterion.id),
      first.criteria.map((criterion) => criterion.id),
      "a new version still gets new ROW ids -- that is what versioning means",
    );
    assert.deepEqual(
      second.criteria.slice(0, 2).map((criterion) => criterion.criterionKey),
      first.criteria.map((criterion) => criterion.criterionKey),
      "unchanged wording must carry the same key across versions",
    );
    assert.equal(
      new Set(second.criteria.map((criterion) => criterion.criterionKey)).size,
      3,
      "a genuinely new criterion gets a genuinely new key",
    );
  });

  it("keeps the key through a REWORDING when the editor sends it back", () => {
    // The case plain text-matching cannot cover, and the one that would
    // otherwise let a typo fix jam the Spec gate: the wording changes, so the
    // identity has to travel on the key the UI round-trips.
    const first = saveRubricVersion({
      ...SCOPE,
      criteria: [{ text: "Evrey requirement has an acceptance criterion" }],
    });
    const key = first.criteria[0]!.criterionKey;

    const second = saveRubricVersion({
      ...SCOPE,
      criteria: [{ criterionKey: key, text: "Every requirement has an acceptance criterion" }],
    });

    assert.equal(second.criteria[0]!.criterionKey, key);
    assert.notEqual(second.criteria[0]!.id, first.criteria[0]!.id);
    assert.equal(second.criteria[0]!.text, "Every requirement has an acceptance criterion");
  });

  it("keeps keys through a reorder", () => {
    const first = saveRubricVersion({
      ...SCOPE,
      criteria: [{ text: "Alpha" }, { text: "Beta" }, { text: "Gamma" }],
    });
    const keyOf = (record: typeof first, text: string) =>
      record.criteria.find((criterion) => criterion.text === text)!.criterionKey;

    const second = saveRubricVersion({
      ...SCOPE,
      criteria: [
        { criterionKey: keyOf(first, "Gamma"), text: "Gamma" },
        { criterionKey: keyOf(first, "Alpha"), text: "Alpha" },
        { criterionKey: keyOf(first, "Beta"), text: "Beta" },
      ],
    });

    assert.deepEqual(
      second.criteria.map((criterion) => [criterion.ordinal, criterion.text, criterion.criterionKey]),
      [
        [0, "Gamma", keyOf(first, "Gamma")],
        [1, "Alpha", keyOf(first, "Alpha")],
        [2, "Beta", keyOf(first, "Beta")],
      ],
      "reordering moves ordinals, not identities",
    );
  });

  it("resurrects the key of a criterion that was removed and re-added", () => {
    const first = saveRubricVersion({
      ...SCOPE,
      criteria: [{ text: "Alpha" }, { text: "Beta" }],
    });
    saveRubricVersion({ ...SCOPE, criteria: [{ text: "Alpha" }] });
    const third = saveRubricVersion({ ...SCOPE, criteria: [{ text: "Alpha" }, { text: "Beta" }] });

    assert.equal(
      third.criteria[1]!.criterionKey,
      first.criteria[1]!.criterionKey,
      "identical wording is the same standard even after a version without it",
    );
  });

  it("refuses to honour a key that belongs to another scope", () => {
    // The direction that must fail closed. Honouring a foreign key would let a
    // request bind a brand-new criterion to an existing identity -- and so to
    // whatever gap batch 5 has already opened against it.
    const otherScope = saveRubricVersion({
      ...SCOPE,
      role: "critic",
      criteria: [{ text: "Critic standard" }],
    });
    const foreignKey = otherScope.criteria[0]!.criterionKey;

    const saved = saveRubricVersion({
      ...SCOPE,
      criteria: [{ criterionKey: foreignKey, text: "Producer standard" }],
    });

    assert.notEqual(
      saved.criteria[0]!.criterionKey,
      foreignKey,
      "a key from a different rubric scope must not be adopted",
    );
  });

  it("mints a fresh key rather than colliding when one key is sent twice", () => {
    const first = saveRubricVersion({ ...SCOPE, criteria: [{ text: "Alpha" }] });
    const key = first.criteria[0]!.criterionKey;

    const second = saveRubricVersion({
      ...SCOPE,
      criteria: [
        { criterionKey: key, text: "Alpha" },
        { criterionKey: key, text: "Alpha copy" },
      ],
    });

    assert.equal(second.criteria[0]!.criterionKey, key);
    assert.notEqual(second.criteria[1]!.criterionKey, key);
    assert.equal(
      new Set(second.criteria.map((criterion) => criterion.criterionKey)).size,
      2,
      "uq_rubric_criteria_rubric_key must never be reachable from the service",
    );
  });

  it("keeps duplicate wordings distinct instead of merging them", () => {
    const first = saveRubricVersion({
      ...SCOPE,
      criteria: [{ text: "Same wording" }, { text: "Same wording" }],
    });
    assert.equal(
      new Set(first.criteria.map((criterion) => criterion.criterionKey)).size,
      2,
    );

    const second = saveRubricVersion({
      ...SCOPE,
      criteria: [{ text: "Same wording" }, { text: "Same wording" }],
    });
    assert.deepEqual(
      second.criteria.map((criterion) => criterion.criterionKey),
      first.criteria.map((criterion) => criterion.criterionKey),
      "repeated wording resolves positionally, in order, and stays distinct",
    );
  });

  it("scopes keys to one lineage: a change override does not inherit the project default's", () => {
    const projectLevel = saveRubricVersion({ ...SCOPE, criteria: [{ text: "Shared wording" }] });
    const changeLevel = saveRubricVersion({
      ...SCOPE,
      changeId: CHANGE_ID,
      criteria: [{ text: "Shared wording" }],
    });

    assert.notEqual(
      changeLevel.criteria[0]!.criterionKey,
      projectLevel.criteria[0]!.criterionKey,
      "an override is a different standard, not a continuation of the default",
    );
  });

  it("leaves every earlier version's keys untouched", () => {
    saveRubricVersion({ ...SCOPE, criteria: [{ text: "Alpha" }] });
    const before = listRubricVersions(SCOPE)[0]!.criteria.map((c) => c.criterionKey);
    saveRubricVersion({ ...SCOPE, criteria: [{ text: "Alpha" }, { text: "Beta" }] });

    assert.deepEqual(
      listRubricVersions(SCOPE)[0]!.criteria.map((c) => c.criterionKey),
      before,
      "a save must not reach backwards into a version an earlier run was judged by",
    );
    assert.equal(getCurrentRubric(SCOPE)?.version, 2);
  });
});

describe("criterion_key at the schema level", () => {
  it("is NOT NULL with no default, so a write that omits it fails loudly", () => {
    // The whole reason 0024 rebuilds the table instead of ALTER TABLE ADD
    // COLUMN: SQLite can only add a NOT NULL column WITH a default, and a
    // defaulted key silently collapses every criterion onto one identity --
    // which batch 5 would turn into one shared gap id. A local in-memory
    // database is used so the assertion is about the migration, not about
    // whatever the suite database happens to contain.
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);

    const info = sqlite.prepare("PRAGMA table_info(rubric_criteria)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const column = info.find((row) => row.name === "criterion_key");
    assert.ok(column, "0024 must have added criterion_key");
    assert.equal(column!.notnull, 1, "criterion_key must be NOT NULL");
    assert.equal(column!.dflt_value, null, "a default would be a fail-open");

    const indexes = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    assert.ok(
      indexes.includes("uq_rubric_criteria_rubric_key"),
      "one key may appear at most once per version",
    );
    assert.ok(
      indexes.includes("uq_rubric_criteria_rubric_ordinal"),
      "the rebuild must not have dropped the pre-existing index",
    );

    // The FK the rebuild had to survive: rubric_assessments points at
    // rubric_criteria.id, and the table was dropped and renamed underneath it.
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(
      (
        sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'rubric_assessments'")
          .get() as { sql: string }
      ).sql.includes("rubric_criteria"),
      "rubric_assessments must still reference the rebuilt table",
    );
    sqlite.close();
  });

  it("backfills a pre-0024 database, linking identical wording across versions", () => {
    // Replays the real upgrade: build the table as 0023 left it, fill it the
    // way the old saveRubricVersion did (no key column at all), then run 0024
    // over it. Proven on a copy of the production database as well; this is the
    // version that runs in CI.
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = OFF");
    runMigrations(sqlite);
    sqlite.exec("DROP TABLE rubric_criteria");
    sqlite.exec(`CREATE TABLE rubric_criteria (
      id text PRIMARY KEY NOT NULL,
      rubric_id text NOT NULL,
      ordinal integer NOT NULL,
      text text NOT NULL,
      blocking integer DEFAULT 1 NOT NULL,
      created_at text NOT NULL
    )`);
    sqlite.exec("DELETE FROM __migrations WHERE tag = '0024_rubric_criterion_key'");

    const now = new Date().toISOString();
    sqlite
      .prepare("INSERT INTO projects (id, name, repo_path, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run("PRJ-BACKFILL", "Backfill", "/tmp/backfill", now, now);
    const addRubric = sqlite.prepare(
      "INSERT INTO rubrics (id, project_id, change_id, phase, role, version, is_current, created_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    const addCriterion = sqlite.prepare(
      "INSERT INTO rubric_criteria (id, rubric_id, ordinal, text, blocking, created_at) VALUES (?,?,?,?,?,?)",
    );
    addRubric.run("RUB-V1", "PRJ-BACKFILL", null, "Spec", "producer", 1, 0, now);
    addCriterion.run("RBC-1", "RUB-V1", 0, "Carried over", 1, now);
    addCriterion.run("RBC-2", "RUB-V1", 1, "Dropped later", 1, now);
    addRubric.run("RUB-V2", "PRJ-BACKFILL", null, "Spec", "producer", 2, 1, now);
    addCriterion.run("RBC-3", "RUB-V2", 0, "Carried over", 1, now);
    addCriterion.run("RBC-4", "RUB-V2", 1, "Added later", 1, now);
    // A version that repeats a wording: ambiguous, so the backfill must not link it.
    addRubric.run("RUB-DUP", "PRJ-BACKFILL", null, "Plan", "producer", 1, 1, now);
    addCriterion.run("RBC-5", "RUB-DUP", 0, "Twice", 1, now);
    addCriterion.run("RBC-6", "RUB-DUP", 1, "Twice", 1, now);

    const applied = runMigrations(sqlite);
    assert.deepEqual(applied.applied, ["0024_rubric_criterion_key"]);

    const keys = new Map(
      (
        sqlite.prepare("SELECT id, criterion_key FROM rubric_criteria").all() as Array<{
          id: string;
          criterion_key: string;
        }>
      ).map((row) => [row.id, row.criterion_key]),
    );

    assert.equal(keys.size, 6, "every pre-existing row must be carried over");
    assert.equal(
      keys.get("RBC-3"),
      keys.get("RBC-1"),
      "identical wording in a later version of the same scope continues the earlier criterion",
    );
    assert.notEqual(keys.get("RBC-4"), keys.get("RBC-2"), "different wording is a different standard");
    assert.notEqual(
      keys.get("RBC-6"),
      keys.get("RBC-5"),
      "a repeated wording is ambiguous, so each row keeps its own identity",
    );
    assert.equal(new Set(keys.values()).size, 5, "exactly one pair may be linked");
    for (const key of keys.values()) assert.ok(key.startsWith("RBK-"), `unkeyed row: ${key}`);
    sqlite.close();
  });
});
