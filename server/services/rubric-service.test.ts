import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import { changes, projects, rubricAssessments, rubricCriteria, rubrics } from "../db/schema.ts";
import { deleteChangeRecords } from "./change-service.ts";
import {
  computeMergeReadiness,
  setMergeReadinessDirtyProbeForTest,
  setMergeReadinessHeadProbeForTest,
} from "./merge-readiness-service.ts";
import { deleteProject } from "./project-service.ts";
import { rubricOutcome } from "./rubric-assessment.ts";
import {
  getCurrentRubric,
  getEffectiveRubric,
  listRubricAssessments,
  listRubricVersions,
  PROJECT_RUBRIC_DELETE_PLAN,
  recordRubricAssessments,
  RubricError,
  saveRubricVersion,
} from "./rubric-service.ts";

const PROJECT_ID = "PRJ-RUBRIC-SERVICE-001";
const CHANGE_ID = "CHG-RUBRIC-SERVICE-001";

// TechSpec, deliberately: this file pins the tier-agnostic persistence
// mechanics (versioned writes, key resolution, assessment rows, deletion), and
// TechSpec/producer carries no tier-1 row. Spec/Build/Done producer saves now
// force-merge the tier-1 rows (rubric-tiers.ts §2.1), which would change every
// count and ordinal below for reasons this file is not about; that behaviour
// is pinned in rubric-tiers.test.ts instead.
const SCOPE = {
  projectId: PROJECT_ID,
  changeId: null,
  phase: "TechSpec" as const,
  role: "producer" as const,
};

const CRITERIA = [
  { text: "Every requirement has an acceptance criterion" },
  { text: "No requirement contradicts the PRD" },
  { text: "Wording is consistent", blocking: false },
];

let restoreHeadProbe: (() => void) | null = null;
let restoreDirtyProbe: (() => void) | null = null;

function cleanupRows() {
  const changeIds = db
    .select({ id: changes.id })
    .from(changes)
    .where(like(changes.id, "CHG-RUBRIC-SERVICE-%"))
    .all()
    .map((row) => row.id);
  for (const changeId of changeIds) deleteChangeRecords(changeId);

  const rubricIds = db
    .select({ id: rubrics.id })
    .from(rubrics)
    .where(like(rubrics.projectId, "PRJ-RUBRIC-SERVICE-%"))
    .all()
    .map((row) => row.id);
  for (const rubricId of rubricIds) {
    db.delete(rubricAssessments).where(eq(rubricAssessments.rubricId, rubricId)).run();
    db.delete(rubricCriteria).where(eq(rubricCriteria.rubricId, rubricId)).run();
  }
  db.delete(rubrics).where(like(rubrics.projectId, "PRJ-RUBRIC-SERVICE-%")).run();
  db.delete(changes).where(like(changes.id, "CHG-RUBRIC-SERVICE-%")).run();
  db.delete(projects).where(like(projects.id, "PRJ-RUBRIC-SERVICE-%")).run();
}

function seed() {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Rubric Service",
      repoPath: `/tmp/rubric-service-${Date.now()}`,
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
      title: "Rubric service change",
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
  restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => "abc123");
  restoreDirtyProbe = setMergeReadinessDirtyProbeForTest(() => false);
});

afterEach(() => {
  restoreHeadProbe?.();
  restoreDirtyProbe?.();
  restoreHeadProbe = null;
  restoreDirtyProbe = null;
  cleanupRows();
});

describe("rubric versioned writes", () => {
  it("creates version 1 as the current rubric", () => {
    const saved = saveRubricVersion({ ...SCOPE, criteria: CRITERIA });

    assert.equal(saved.version, 1);
    assert.equal(saved.isCurrent, true);
    assert.deepEqual(saved.criteria.map((criterion) => criterion.ordinal), [0, 1, 2]);
    assert.deepEqual(
      saved.criteria.map((criterion) => criterion.blocking),
      [true, true, false],
      "blocking defaults to true and an explicit false is honoured",
    );
  });

  it("edits by appending a new version and demoting the old one", () => {
    const first = saveRubricVersion({ ...SCOPE, criteria: CRITERIA });
    const second = saveRubricVersion({
      ...SCOPE,
      criteria: [{ text: "Rewritten criterion" }],
    });

    assert.equal(second.version, 2);
    assert.equal(second.isCurrent, true);
    assert.equal(getCurrentRubric(SCOPE)?.id, second.id);

    // The old version and its criteria survive verbatim. Assessments point at
    // criterion ids, so a finished run must stay explainable in the wording it
    // was actually judged by.
    const versions = listRubricVersions(SCOPE);
    assert.deepEqual(versions.map((version) => [version.version, version.isCurrent]), [
      [1, false],
      [2, true],
    ]);
    assert.equal(versions[0]!.id, first.id);
    assert.deepEqual(
      versions[0]!.criteria.map((criterion) => criterion.text),
      CRITERIA.map((criterion) => criterion.text),
      "editing must not rewrite the previous version's criterion text",
    );
  });

  it("keeps exactly one current rubric per scope", () => {
    saveRubricVersion({ ...SCOPE, criteria: CRITERIA });
    saveRubricVersion({ ...SCOPE, criteria: CRITERIA });
    saveRubricVersion({ ...SCOPE, criteria: CRITERIA });

    const current = db
      .select()
      .from(rubrics)
      .where(eq(rubrics.projectId, PROJECT_ID))
      .all()
      .filter((row) => row.isCurrent === 1);
    assert.equal(current.length, 1);
    assert.equal(current[0]!.version, 3);
  });

  it("rejects an empty criterion", () => {
    assert.throws(
      () => saveRubricVersion({ ...SCOPE, criteria: [{ text: "   " }] }),
      (error: unknown) => error instanceof RubricError && error.code === "rubric_criterion_empty",
    );
  });

  it("scopes project-level and change-level rubrics separately", () => {
    const projectLevel = saveRubricVersion({ ...SCOPE, criteria: [{ text: "Project default" }] });
    const changeLevel = saveRubricVersion({
      ...SCOPE,
      changeId: CHANGE_ID,
      criteria: [{ text: "Change override" }],
    });

    assert.notEqual(projectLevel.id, changeLevel.id);
    assert.equal(getCurrentRubric(SCOPE)?.id, projectLevel.id);
    assert.equal(getCurrentRubric({ ...SCOPE, changeId: CHANGE_ID })?.id, changeLevel.id);
  });

  it("resolves a change to its override, falling back to the project default", () => {
    const projectLevel = saveRubricVersion({ ...SCOPE, criteria: [{ text: "Project default" }] });

    const fallback = getEffectiveRubric({ ...SCOPE, changeId: CHANGE_ID });
    assert.equal(fallback?.source, "project");
    assert.equal(fallback?.rubric.id, projectLevel.id);

    const override = saveRubricVersion({
      ...SCOPE,
      changeId: CHANGE_ID,
      criteria: [{ text: "Change override" }],
    });
    const resolved = getEffectiveRubric({ ...SCOPE, changeId: CHANGE_ID });
    assert.equal(resolved?.source, "change");
    assert.equal(resolved?.rubric.id, override.id);
  });

  it("treats an absent rubric as legal", () => {
    assert.equal(getEffectiveRubric({ ...SCOPE, changeId: CHANGE_ID }), null);
  });

  it("treats an empty rubric as legal and non-blocking", () => {
    // §4.5: an empty rubric means this phase does no rubric judging, and
    // behaviour falls back to what it was before rubrics existed.
    const empty = saveRubricVersion({ ...SCOPE, criteria: [] });
    assert.deepEqual(empty.criteria, []);

    const result = recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-EMPTY",
      rubric: empty,
      rawText: "Nothing to judge here.",
    });
    assert.ok(result.ok);
    assert.deepEqual(result.assessments, []);
    assert.equal(rubricOutcome(empty.criteria, result.assessments).blocked, false);
  });

  it("voids a judgment aimed at an empty rubric rather than accepting it", () => {
    // The fail-closed twin of the case above: an empty rubric has no criterion
    // for a RUBRIC line to name, so any line is an unknown id.
    const empty = saveRubricVersion({ ...SCOPE, criteria: [] });
    const result = recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-EMPTY-2",
      rubric: empty,
      rawText: "RUBRIC: C1 | yes | judged against a rubric that has no criteria",
    });
    assert.equal(result.ok, false);
  });
});

describe("rubric assessment persistence", () => {
  it("stores one row per criterion, unanswered ones as not_assessed", () => {
    const rubric = saveRubricVersion({ ...SCOPE, criteria: CRITERIA });
    const [c1, , c3] = rubric.criteria;

    const result = recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-1",
      rubric,
      rawText: [
        `RUBRIC: ${c1!.id} | yes | every REQ carries an AC`,
        `RUBRIC: ${c3!.id} | no | two spellings of workspace`,
      ].join("\n"),
    });

    assert.ok(result.ok);
    const stored = listRubricAssessments({ runId: "RUN-1" });
    assert.equal(stored.length, 3, "every criterion gets a row, answered or not");
    assert.deepEqual(
      stored.map((row) => row.verdict).sort(),
      ["no", "not_assessed", "yes"],
    );
    const notAssessed = stored.find((row) => row.verdict === "not_assessed");
    assert.equal(notAssessed?.evidence, null);
    assert.equal(rubricOutcome(rubric.criteria, result.assessments).blocked, true);
  });

  it("writes nothing when the output is void", () => {
    const rubric = saveRubricVersion({ ...SCOPE, criteria: CRITERIA });

    const result = recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-2",
      rubric,
      rawText: `RUBRIC: ${rubric.criteria[0]!.id} | yes | ok\nRUBRIC: NOPE | yes | invented`,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(
      listRubricAssessments({ runId: "RUN-2" }),
      [],
      "a half-stored rubric would look like a completed judgment",
    );
  });

  it("replaces a run's verdicts on re-run instead of colliding", () => {
    const rubric = saveRubricVersion({ ...SCOPE, criteria: [{ text: "Only criterion" }] });
    const criterionId = rubric.criteria[0]!.id;

    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-3",
      rubric,
      rawText: `RUBRIC: ${criterionId} | no | first pass`,
    });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-3",
      rubric,
      rawText: `RUBRIC: ${criterionId} | yes | fixed on the retry`,
    });

    const stored = listRubricAssessments({ runId: "RUN-3" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.verdict, "yes");
  });

  it("keeps a producer's and a critic's verdicts side by side in one run", () => {
    const producer = saveRubricVersion({ ...SCOPE, criteria: [{ text: "Producer criterion" }] });
    const critic = saveRubricVersion({
      ...SCOPE,
      role: "critic",
      criteria: [{ text: "Critic criterion" }],
    });

    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-4",
      rubric: producer,
      rawText: `RUBRIC: ${producer.criteria[0]!.id} | yes | self-check`,
    });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-4",
      rubric: critic,
      rawText: `RUBRIC: ${critic.criteria[0]!.id} | no | independent recheck disagrees`,
    });

    assert.equal(listRubricAssessments({ runId: "RUN-4" }).length, 2);
    assert.equal(listRubricAssessments({ runId: "RUN-4", rubricId: producer.id }).length, 1);
    assert.equal(
      listRubricAssessments({ runId: "RUN-4", rubricId: critic.id })[0]!.verdict,
      "no",
      "writing the critic's rows must not disturb the producer's",
    );
  });
});

describe("rubric data is invisible to stage hashes", () => {
  it("does not move a recomputed gate hash when a rubric is written or edited", () => {
    // §4.4, and the regression 204f3f5 was written for: adding a column to
    // briefing_questions moved every stamped PRD gate hash and jammed Spec
    // Battle. computeMergeReadiness is a real production hash path, called
    // unmodified -- so if anyone ever adds rubric rows to a stage's hash
    // inputs, this assertion is what fails.
    const before = computeMergeReadiness(CHANGE_ID).sourceDbHash;

    const rubric = saveRubricVersion({ ...SCOPE, criteria: CRITERIA });
    assert.equal(
      computeMergeReadiness(CHANGE_ID).sourceDbHash,
      before,
      "writing a rubric moved a stage hash",
    );

    saveRubricVersion({ ...SCOPE, criteria: [{ text: "Edited wording" }] });
    assert.equal(
      computeMergeReadiness(CHANGE_ID).sourceDbHash,
      before,
      "editing a rubric moved a stage hash -- editing must invalidate no stamped gate",
    );

    saveRubricVersion({
      ...SCOPE,
      changeId: CHANGE_ID,
      criteria: [{ text: "Change-level override" }],
    });
    assert.equal(
      computeMergeReadiness(CHANGE_ID).sourceDbHash,
      before,
      "a change-level rubric override moved a stage hash",
    );

    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-HASH",
      rubric,
      rawText: `RUBRIC: ${rubric.criteria[0]!.id} | no | deliberately failing`,
    });
    assert.equal(
      computeMergeReadiness(CHANGE_ID).sourceDbHash,
      before,
      "recording rubric assessments moved a stage hash",
    );
  });
});

describe("rubric deletion", () => {
  it("removes a change's own rubrics but keeps the project default", () => {
    const projectLevel = saveRubricVersion({ ...SCOPE, criteria: [{ text: "Project default" }] });
    const changeLevel = saveRubricVersion({
      ...SCOPE,
      changeId: CHANGE_ID,
      criteria: [{ text: "Change override" }],
    });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-DEL",
      rubric: changeLevel,
      rawText: `RUBRIC: ${changeLevel.criteria[0]!.id} | yes | ok`,
    });

    deleteChangeRecords(CHANGE_ID);

    assert.equal(getCurrentRubric({ ...SCOPE, changeId: CHANGE_ID }), null);
    assert.equal(
      getCurrentRubric(SCOPE)?.id,
      projectLevel.id,
      "the project default must outlive any one change",
    );
    assert.deepEqual(listRubricAssessments({ runId: "RUN-DEL" }), []);
    assert.deepEqual(
      db.select().from(rubricCriteria).where(eq(rubricCriteria.rubricId, changeLevel.id)).all(),
      [],
    );
  });

  it("lets a project be deleted after it has rubrics", async () => {
    // rubrics.project_id references projects.id and project-level rows belong
    // to no change, so deleteChangeRecords never reaches them. Without
    // PROJECT_RUBRIC_DELETE_PLAN the final DELETE FROM projects raises
    // SQLITE_CONSTRAINT_FOREIGNKEY and a project can never be deleted again.
    const rubric = saveRubricVersion({ ...SCOPE, criteria: CRITERIA });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-PRJ",
      rubric,
      rawText: `RUBRIC: ${rubric.criteria[0]!.id} | yes | ok`,
    });

    await deleteProject(PROJECT_ID);

    assert.deepEqual(db.select().from(projects).where(eq(projects.id, PROJECT_ID)).all(), []);
    assert.deepEqual(db.select().from(rubrics).where(eq(rubrics.projectId, PROJECT_ID)).all(), []);
    assert.deepEqual(
      db.select().from(rubricCriteria).where(eq(rubricCriteria.rubricId, rubric.id)).all(),
      [],
    );
    assert.deepEqual(listRubricAssessments({ runId: "RUN-PRJ" }), []);
  });

  it("covers every rubric table in the project delete plan", () => {
    assert.deepEqual(
      PROJECT_RUBRIC_DELETE_PLAN.map((step) => step.table),
      ["rubric_assessments", "rubric_criteria", "rubrics"],
      "children must be deleted before the rubrics row they reference",
    );
  });
});
