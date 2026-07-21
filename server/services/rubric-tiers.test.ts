import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import { projects, rubricAssessments, rubricCriteria, rubrics } from "../db/schema.ts";
import { factoryCriteria } from "./rubric-defaults.ts";
import { blockingCriterionKeysInForce } from "./rubric-gate-service.ts";
import {
  ensureFactoryRubrics,
  getCurrentRubric,
  saveRubricVersion,
} from "./rubric-service.ts";
import {
  TIER1_CRITERION_KEYS,
  tier1CriteriaForScope,
  tierOfCriterionKey,
} from "./rubric-tiers.ts";

const PROJECT_ID = "PRJ-RUBRIC-TIERS-001";

const BUILD_SCOPE = {
  projectId: PROJECT_ID,
  changeId: null,
  phase: "Build" as const,
  role: "producer" as const,
};

const BUILD_TIER1_KEYS = ["RBK-factory-Build-producer-01", "RBK-factory-Build-producer-02"];

function canonicalText(key: string): string {
  const criterion = factoryCriteria("Build", "producer").find((row) => row.criterionKey === key);
  assert.ok(criterion, `factory table lost ${key}`);
  return criterion.text;
}

function cleanupRows() {
  const rubricIds = db
    .select({ id: rubrics.id })
    .from(rubrics)
    .where(like(rubrics.projectId, "PRJ-RUBRIC-TIERS-%"))
    .all()
    .map((row) => row.id);
  for (const rubricId of rubricIds) {
    db.delete(rubricAssessments).where(eq(rubricAssessments.rubricId, rubricId)).run();
    db.delete(rubricCriteria).where(eq(rubricCriteria.rubricId, rubricId)).run();
  }
  db.delete(rubrics).where(like(rubrics.projectId, "PRJ-RUBRIC-TIERS-%")).run();
  db.delete(projects).where(like(projects.id, "PRJ-RUBRIC-TIERS-%")).run();
}

function seedProject() {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Rubric Tiers",
      repoPath: `/tmp/rubric-tiers-${Date.now()}`,
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
}

describe("rubric tiers (§2.1 一级 恒阻断/不可删改/关不掉)", () => {
  beforeEach(() => {
    cleanupRows();
    seedProject();
  });
  afterEach(() => {
    cleanupRows();
  });

  it("derives the tier from the key: registry -> 1, factory -> 2, minted -> 3", () => {
    for (const key of TIER1_CRITERION_KEYS) assert.equal(tierOfCriterionKey(key), 1);
    assert.equal(tierOfCriterionKey("RBK-factory-PRD-producer-01"), 2);
    assert.equal(tierOfCriterionKey(`RBK-${randomUUID()}`), 3);
  });

  it("the registry names exactly the four promoted clauses, each present in the factory table", () => {
    assert.deepEqual(
      [...TIER1_CRITERION_KEYS].sort(),
      [
        "RBK-factory-Build-producer-01",
        "RBK-factory-Build-producer-02",
        "RBK-factory-Done-producer-01",
        "RBK-factory-Spec-producer-03",
      ],
    );
    assert.deepEqual(
      tier1CriteriaForScope("Build", "producer").map((row) => row.criterionKey),
      BUILD_TIER1_KEYS,
    );
    assert.equal(tier1CriteriaForScope("Spec", "producer").length, 1);
    assert.equal(tier1CriteriaForScope("Done", "producer").length, 1);
    // Scopes outside the registry are untouched by the whole mechanism.
    assert.equal(tier1CriteriaForScope("PRD", "producer").length, 0);
  });

  it("an empty save cannot remove tier-1 rows (关不掉)", () => {
    const saved = saveRubricVersion({ ...BUILD_SCOPE, criteria: [] });
    assert.deepEqual(
      saved.criteria.map((row) => row.criterionKey),
      BUILD_TIER1_KEYS,
    );
    for (const row of saved.criteria) {
      assert.equal(row.blocking, true);
      assert.equal(row.text, canonicalText(row.criterionKey));
    }
  });

  it("an empty save on a scope without tier-1 rows still empties it (PRD unchanged)", () => {
    const saved = saveRubricVersion({
      ...BUILD_SCOPE,
      phase: "PRD" as const,
      criteria: [],
    });
    assert.deepEqual(saved.criteria, []);
  });

  it("drifted text under a tier-1 key is corrected back to canon, blocking coerced", () => {
    const saved = saveRubricVersion({
      ...BUILD_SCOPE,
      criteria: [
        {
          criterionKey: "RBK-factory-Build-producer-01",
          text: "随便什么放宽了的措辞",
          blocking: false,
        },
        { text: "用户自己的三级标准" },
      ],
    });
    const tier1Row = saved.criteria.find(
      (row) => row.criterionKey === "RBK-factory-Build-producer-01",
    );
    assert.ok(tier1Row);
    assert.equal(tier1Row.text, canonicalText("RBK-factory-Build-producer-01"));
    assert.equal(tier1Row.blocking, true);
    const userRow = saved.criteria.find((row) => row.text === "用户自己的三级标准");
    assert.ok(userRow);
    assert.equal(tierOfCriterionKey(userRow.criterionKey), 3);
  });

  it("a keyless row matching canonical text is absorbed, not duplicated", () => {
    const saved = saveRubricVersion({
      ...BUILD_SCOPE,
      criteria: [{ text: canonicalText("RBK-factory-Build-producer-02") }],
    });
    const matches = saved.criteria.filter(
      (row) => row.text === canonicalText("RBK-factory-Build-producer-02"),
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.criterionKey, "RBK-factory-Build-producer-02");
  });

  it("tier-1 rows sit first, in factory order, on every version", () => {
    const saved = saveRubricVersion({
      ...BUILD_SCOPE,
      criteria: [{ text: "甲" }, { text: "乙" }],
    });
    assert.deepEqual(
      saved.criteria.slice(0, 2).map((row) => row.criterionKey),
      BUILD_TIER1_KEYS,
    );
    assert.deepEqual(saved.criteria.slice(2).map((row) => row.text), ["甲", "乙"]);
  });

  it("a user row cannot steal a tier-1 key through the text-match rule", () => {
    // A legacy version where the tier-1 key sits next to since-corrected
    // wording -- writable only by direct insert, which is exactly how a
    // pre-enforcement database looks.
    const now = new Date().toISOString();
    const legacyRubricId = `RUB-${randomUUID()}`;
    db.insert(rubrics)
      .values({
        id: legacyRubricId,
        projectId: PROJECT_ID,
        changeId: null,
        phase: "Build",
        role: "producer",
        version: 1,
        isCurrent: 1,
        createdAt: now,
      })
      .run();
    db.insert(rubricCriteria)
      .values({
        id: `RBC-${randomUUID()}`,
        rubricId: legacyRubricId,
        criterionKey: "RBK-factory-Build-producer-01",
        ordinal: 0,
        text: "漂移过的旧措辞",
        blocking: 0,
        createdAt: now,
      })
      .run();

    const saved = saveRubricVersion({
      ...BUILD_SCOPE,
      criteria: [{ text: "漂移过的旧措辞" }],
    });
    const userRow = saved.criteria.find((row) => row.text === "漂移过的旧措辞");
    assert.ok(userRow, "the user's line survives as their own criterion");
    assert.equal(
      TIER1_CRITERION_KEYS.has(userRow.criterionKey),
      false,
      "text-match resolution must not hand out a tier-1 identity",
    );
    // And the canonical tier-1 rows are present regardless.
    assert.deepEqual(
      saved.criteria.slice(0, 2).map((row) => row.criterionKey),
      BUILD_TIER1_KEYS,
    );
  });

  it("factory seeding ships tier-1 blocking and everything else advisory", () => {
    ensureFactoryRubrics(PROJECT_ID);
    for (const [phase, role, key] of [
      ["Spec", "producer", "RBK-factory-Spec-producer-03"],
      ["Build", "producer", "RBK-factory-Build-producer-01"],
      ["Build", "producer", "RBK-factory-Build-producer-02"],
      ["Done", "producer", "RBK-factory-Done-producer-01"],
    ] as const) {
      const rubric = getCurrentRubric({ projectId: PROJECT_ID, changeId: null, phase, role });
      assert.ok(rubric, `${phase}/${role} not seeded`);
      for (const row of rubric.criteria) {
        assert.equal(
          row.blocking,
          row.criterionKey === key
          || TIER1_CRITERION_KEYS.has(row.criterionKey),
          `${row.criterionKey} blocking flag`,
        );
      }
    }
    // A scope with no tier-1 promotion stays fully advisory.
    const prd = getCurrentRubric({
      projectId: PROJECT_ID,
      changeId: null,
      phase: "PRD",
      role: "producer",
    });
    assert.ok(prd);
    assert.equal(prd.criteria.some((row) => row.blocking), false);
  });

  it("a tier-1 key is in force even when a legacy row carries blocking=0", () => {
    const now = new Date().toISOString();
    const legacyRubricId = `RUB-${randomUUID()}`;
    db.insert(rubrics)
      .values({
        id: legacyRubricId,
        projectId: PROJECT_ID,
        changeId: null,
        phase: "Build",
        role: "producer",
        version: 1,
        isCurrent: 1,
        createdAt: now,
      })
      .run();
    for (const [ordinal, key] of BUILD_TIER1_KEYS.entries()) {
      db.insert(rubricCriteria)
        .values({
          id: `RBC-${randomUUID()}`,
          rubricId: legacyRubricId,
          criterionKey: key,
          ordinal,
          text: canonicalText(key),
          blocking: 0,
          createdAt: now,
        })
        .run();
    }

    const inForce = blockingCriterionKeysInForce({
      projectId: PROJECT_ID,
      changeId: "CHG-NONE",
      phase: "Build",
    });
    for (const key of BUILD_TIER1_KEYS) {
      assert.ok(inForce.has(key), `${key} must be in force despite the stale flag`);
    }
  });
});
