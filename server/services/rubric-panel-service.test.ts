import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import { battleRounds, changes, projects, rubricAssessments, rubricCriteria, rubrics } from "../db/schema.ts";
import { buildRubricPanelState } from "./rubric-panel-service.ts";
import {
  ensureFactoryRubrics,
  listRubricAssessmentsForScope,
  recordRubricAssessments,
  recordUnansweredRubric,
  saveRubricVersion,
  selectLatestAssessmentBatch,
} from "./rubric-service.ts";

/**
 * The read model behind the rubric drawer, and in particular §5.2.
 *
 * `resumeBlue` starts a new run for a round whose red half has already
 * answered, and does NOT re-run red. Red's producer verdicts therefore live
 * under the round's first run id while the round finishes under a second one. A
 * panel that filtered on the current run id would find no producer verdicts,
 * show "no rubric", and read as a pass -- the exact failure this whole
 * mechanism exists to catch. Every "by round, not by run" assertion below is
 * guarding that.
 */

const PROJECT_ID = "PRJ-RUBRIC-PANEL-001";
const CHANGE_ID = "CHG-RUBRIC-PANEL-001";
const ROUND_1 = "BR-RUBRIC-PANEL-1";
const ROUND_2 = "BR-RUBRIC-PANEL-2";

const SPEC_PRODUCER = {
  projectId: PROJECT_ID,
  changeId: null as string | null,
  phase: "Spec" as const,
  role: "producer" as const,
};

/**
 * Spec producer is a TIER-1 SCOPE since the rubric-tiers batch: every save on
 * it prepends the pinned `RBK-factory-Spec-producer-03` row (blocking, ordinal
 * 0), so "save one criterion" yields TWO rows there. Tests below that pin
 * GENERIC panel mechanics (round selection, staleness, blocking arithmetic,
 * scope precedence) therefore run on Spec's CRITIC scope -- same phase, so
 * rounds still exist, but no tier-1 key, so counts and ordinals mean what the
 * test says they mean. Tests that stay on SPEC_PRODUCER do so because they are
 * ABOUT the producer (§5.2's red half) or about the tier-1 injection itself.
 */
const SPEC_CRITIC = { ...SPEC_PRODUCER, role: "critic" as const };

function cleanupRows() {
  const rubricIds = db
    .select({ id: rubrics.id })
    .from(rubrics)
    .where(like(rubrics.projectId, "PRJ-RUBRIC-PANEL-%"))
    .all()
    .map((row) => row.id);
  for (const rubricId of rubricIds) {
    db.delete(rubricAssessments).where(eq(rubricAssessments.rubricId, rubricId)).run();
    db.delete(rubricCriteria).where(eq(rubricCriteria.rubricId, rubricId)).run();
  }
  db.delete(rubrics).where(like(rubrics.projectId, "PRJ-RUBRIC-PANEL-%")).run();
  db.delete(battleRounds).where(like(battleRounds.changeId, "CHG-RUBRIC-PANEL-%")).run();
  db.delete(changes).where(like(changes.id, "CHG-RUBRIC-PANEL-%")).run();
  db.delete(projects).where(like(projects.id, "PRJ-RUBRIC-PANEL-%")).run();
}

function seed() {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Rubric panel",
      repoPath: `/tmp/rubric-panel-${Date.now()}`,
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
      title: "Rubric panel change",
      status: "SPECCING",
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

function addRound(id: string, roundNo: number) {
  const now = new Date().toISOString();
  db.insert(battleRounds)
    .values({
      id,
      changeId: CHANGE_ID,
      phase: "Spec",
      template: "spec_battle_v1",
      roundNo,
      status: "report_ready",
      redUnit: "spec",
      blueUnit: "spec_critic",
      inputSnapshotJson: "{}",
      paramsJson: "{}",
      redArtifactPath: null,
      redArtifactHash: null,
      blueArtifactPath: null,
      blueArtifactHash: null,
      reportPath: null,
      supersededByRoundId: null,
      startedAt: now,
      endedAt: now,
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

describe("verdicts are read by round, never by run (§5.2)", () => {
  it("still shows the producer's verdicts after blue resumes under a new run id", () => {
    addRound(ROUND_1, 1);
    const producer = saveRubricVersion({
      ...SPEC_PRODUCER,
      criteria: [{ text: "Every requirement has an acceptance criterion" }],
    });
    const critic = saveRubricVersion({
      ...SPEC_PRODUCER,
      role: "critic",
      criteria: [{ text: "No boundary is left implicit" }],
    });

    // Red answered under the round's FIRST run. The producer rubric now opens
    // with the injected tier-1 row, so BOTH rows get a yes: this test pins
    // §5.2's by-round read, and a not_assessed tier-1 row would drag `blocked`
    // into the assertion for reasons that belong to the tier tests below.
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric: producer,
      rawText: [
        `RUBRIC: ${producer.criteria[0]!.id} | yes | no requirement beyond the PRD`,
        `RUBRIC: ${producer.criteria[1]!.id} | yes | acceptance criteria present`,
      ].join("\n"),
    });
    // Blue failed and was resumed: a NEW run id, the SAME round, and red is not
    // re-run, so nothing writes producer rows under RUN-BLUE-2.
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-BLUE-2",
      roundId: ROUND_1,
      rubric: critic,
      rawText: `RUBRIC: ${critic.criteria[0]!.id} | no | boundary undefined`,
    });

    const state = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    });
    assert.equal(state.roundId, ROUND_1);

    const producerPanel = state.roles.find((role) => role.role === "producer")!;
    // 2 = the tier-1 row plus the user's row. Was 1 before the tier-1 merge.
    assert.equal(
      producerPanel.verdicts.length,
      2,
      "the producer answered this round; a run-scoped read would have lost it and read as a pass",
    );
    assert.ok(
      producerPanel.verdicts.every((verdict) => verdict.verdict === "yes"),
      "both rows -- tier-1 and the user's -- were answered yes under the round's first run",
    );
    assert.equal(producerPanel.blocked, false);

    const criticPanel = state.roles.find((role) => role.role === "critic")!;
    assert.equal(criticPanel.verdicts[0]!.verdict, "no");
    assert.equal(criticPanel.blocked, true);
  });

  it("does not show a previous round's verdicts as this round's", () => {
    addRound(ROUND_1, 1);
    const producer = saveRubricVersion({ ...SPEC_PRODUCER, criteria: [{ text: "Alpha" }] });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric: producer,
      rawText: `RUBRIC: ${producer.criteria[0]!.id} | yes | round one`,
    });

    addRound(ROUND_2, 2);
    const state = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    });

    assert.equal(state.roundId, ROUND_2);
    assert.deepEqual(
      state.roles.find((role) => role.role === "producer")!.verdicts,
      [],
      "a new round starts with no verdicts; showing round 1's would claim a judgment that has not happened",
    );
  });

  it("selectLatestAssessmentBatch keys on roundId and ignores runId entirely", () => {
    // Pins generic batch selection, so it runs on the critic scope: on the
    // producer the tier-1 merge would add a second assessment row and the
    // `length === 1` below would be counting the injection, not the selection.
    addRound(ROUND_1, 1);
    const critic = saveRubricVersion({ ...SPEC_CRITIC, criteria: [{ text: "Alpha" }] });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric: critic,
      rawText: `RUBRIC: ${critic.criteria[0]!.id} | yes | round one`,
    });

    const all = listRubricAssessmentsForScope({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
      role: "critic",
    });
    assert.equal(all.length, 1);
    assert.equal(all[0]!.runId, "RUN-RED-1");

    assert.equal(
      selectLatestAssessmentBatch(all, { roundId: ROUND_1 }).length,
      1,
      "selecting by the round finds it",
    );
    assert.equal(
      selectLatestAssessmentBatch(all, { roundId: ROUND_2 }).length,
      0,
      "a different round must not inherit it",
    );
    assert.equal(
      selectLatestAssessmentBatch(all, { roundId: null }).length,
      0,
      "round-scoped rows are not round-less rows",
    );
  });
});

describe("stale rubric versions are labelled, not hidden", () => {
  // Both tests pin generic version-staleness mechanics (judgedVersion, the
  // stale label, snapshotted wording), so they run on the critic scope where
  // criteria[0] is the row the test wrote, not the injected tier-1 row.
  it("keeps showing a verdict after the rubric is edited, marked as an older version", () => {
    addRound(ROUND_1, 1);
    const v1 = saveRubricVersion({
      ...SPEC_CRITIC,
      criteria: [{ text: "Original wording" }],
    });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric: v1,
      rawText: `RUBRIC: ${v1.criteria[0]!.id} | no | it failed`,
    });

    saveRubricVersion({
      ...SPEC_CRITIC,
      criteria: [{ criterionKey: v1.criteria[0]!.criterionKey, text: "Reworded wording" }],
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "critic")!;

    assert.equal(panel.version, 2);
    assert.equal(panel.judgedVersion, 1);
    assert.equal(panel.judgedByOutdatedVersion, true, "the drawer must say the verdict is stale");
    assert.equal(panel.verdicts.length, 1, "an edit must not make a recorded verdict disappear");
    assert.equal(
      panel.verdicts[0]!.text,
      "Original wording",
      "a verdict is captioned with the wording the model saw, never re-derived from the current version",
    );
    assert.equal(
      panel.verdicts[0]!.stillCurrent,
      true,
      "the criterion is still in force -- it was reworded, not removed",
    );
    assert.equal(panel.criteria[0]!.text, "Reworded wording");
  });

  it("marks a verdict whose criterion was deleted outright", () => {
    addRound(ROUND_1, 1);
    const v1 = saveRubricVersion({
      ...SPEC_CRITIC,
      criteria: [{ text: "Alpha" }, { text: "Beta" }],
    });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric: v1,
      rawText: [
        `RUBRIC: ${v1.criteria[0]!.id} | yes | alpha holds`,
        `RUBRIC: ${v1.criteria[1]!.id} | no | beta fails`,
      ].join("\n"),
    });
    saveRubricVersion({
      ...SPEC_CRITIC,
      criteria: [{ criterionKey: v1.criteria[0]!.criterionKey, text: "Alpha" }],
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "critic")!;

    assert.deepEqual(
      panel.verdicts.map((verdict) => [verdict.text, verdict.stillCurrent]),
      [
        ["Alpha", true],
        ["Beta", false],
      ],
    );
  });
});

describe("what the drawer treats as blocking", () => {
  it("shows not_assessed on a non-blocking criterion, and does not call the phase blocked", () => {
    // CHANGED in batch 6. This used to assert `blocked === true` on the grounds
    // that "silence is not content". The verdict is still shown as
    // `not_assessed` -- that part was never in question -- but calling the phase
    // BLOCKED was wrong twice over:
    //
    //  - the gate disagreed. `activeRubricBlockers` produced nothing for this
    //    exact input, so the drawer drew a blocking dot on a phase that was not
    //    blocked. Batch 5's comment claims sharing `rubricOutcome` makes that
    //    impossible; sharing it was not enough, because the two read different
    //    fields off the result.
    //  - it made every project's drawer light up once batch 6 shipped factory
    //    criteria, which are all non-blocking: one skipped line from any model
    //    and the phase looked blocked while nothing was.
    //
    // See rubricOutcome for the full argument, including the edit-opens-a-P0
    // failure the old rule also caused.
    addRound(ROUND_1, 1);
    const rubric = saveRubricVersion({
      ...SPEC_CRITIC,
      criteria: [{ text: "Advisory only", blocking: false }],
    });
    recordUnansweredRubric({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric,
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "critic")!;

    assert.equal(panel.verdicts[0]!.verdict, "not_assessed");
    assert.equal(panel.blocked, false);
  });

  it("treats not_assessed as blocking on a criterion the user marked blocking", () => {
    addRound(ROUND_1, 1);
    const rubric = saveRubricVersion({
      ...SPEC_CRITIC,
      criteria: [{ text: "Must hold", blocking: true }],
    });
    recordUnansweredRubric({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric,
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "critic")!;

    assert.equal(panel.verdicts[0]!.verdict, "not_assessed");
    assert.equal(panel.blocked, true, "a model refusing to answer a required standard must not pass");
  });

  it("does not block on a `no` against a non-blocking criterion", () => {
    addRound(ROUND_1, 1);
    const rubric = saveRubricVersion({
      ...SPEC_CRITIC,
      criteria: [{ text: "Advisory only", blocking: false }],
    });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric,
      rawText: `RUBRIC: ${rubric.criteria[0]!.id} | no | style nit`,
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "critic")!;
    assert.equal(panel.verdicts[0]!.verdict, "no");
    assert.equal(panel.blocked, false);
  });
});

describe("scope and role visibility", () => {
  // Both scope-precedence tests pin generic mechanics (which scope is in
  // force, override visibility), so they run on the critic scope: on the
  // producer, criteria[0] is the injected tier-1 row on BOTH scopes, and the
  // text assertions would compare the same pinned wording to itself.
  it("reports which scope is in force and that an override exists", () => {
    saveRubricVersion({ ...SPEC_CRITIC, criteria: [{ text: "Project default" }] });

    const asProject = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "critic")!;
    assert.equal(asProject.source, "project");
    assert.equal(asProject.hasChangeOverride, false);
    assert.equal(asProject.criteria[0]!.text, "Project default");

    saveRubricVersion({
      ...SPEC_CRITIC,
      changeId: CHANGE_ID,
      criteria: [{ text: "Change override" }],
    });
    const asChange = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "critic")!;
    assert.equal(asChange.source, "change");
    assert.equal(asChange.hasChangeOverride, true);
    assert.equal(asChange.criteria[0]!.text, "Change override");
  });

  it("keeps a verdict made against the project default visible after an override appears", () => {
    addRound(ROUND_1, 1);
    const projectLevel = saveRubricVersion({
      ...SPEC_CRITIC,
      criteria: [{ text: "Project default" }],
    });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric: projectLevel,
      rawText: `RUBRIC: ${projectLevel.criteria[0]!.id} | no | judged against the default`,
    });
    saveRubricVersion({
      ...SPEC_CRITIC,
      changeId: CHANGE_ID,
      criteria: [{ text: "Change override" }],
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "critic")!;
    assert.equal(panel.source, "change");
    assert.equal(panel.verdicts.length, 1, "creating an override must not erase what was judged");
    assert.equal(panel.judgedByOutdatedVersion, true);
    assert.equal(panel.verdicts[0]!.stillCurrent, false);
  });

  it("marks the critic role inapplicable exactly on the phases §3 gives no critic", () => {
    const criticApplicable = (phase: Parameters<typeof buildRubricPanelState>[0]["phase"]) =>
      buildRubricPanelState({ projectId: PROJECT_ID, changeId: CHANGE_ID, phase })
        .roles.find((role) => role.role === "critic")!.applicable;

    for (const phase of ["PRD", "Spec", "Build", "Fix"] as const) {
      assert.equal(criticApplicable(phase), true, `${phase} has a critic in §3`);
    }
    for (const phase of ["Refine", "TechSpec", "Plan", "TestPlan", "QA", "Merge", "Retro"] as const) {
      assert.equal(criticApplicable(phase), false, `${phase} has no critic, so §7.1 hides the tab`);
    }
    // Producer and verdict are always answerable, so their tabs never hide.
    for (const phase of ["Refine", "Merge"] as const) {
      const state = buildRubricPanelState({ projectId: PROJECT_ID, changeId: CHANGE_ID, phase });
      assert.equal(state.roles.find((role) => role.role === "producer")!.applicable, true);
      assert.equal(state.roles.find((role) => role.role === "verdict")!.applicable, true);
    }
  });

  it("uses no round for a phase that has none, even while a Spec round exists", () => {
    addRound(ROUND_1, 1);
    const state = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Plan",
    });
    assert.equal(state.roundId, null, "Plan has no rounds; borrowing Spec's would be nonsense");
  });
});

describe("tiers reach the drawer (design §2.1)", () => {
  it("annotates every criterion with its server-derived tier", () => {
    // Factory seed gives Spec producer its tier-1 and tier-2 rows; an
    // append-save adds a user (tier-3) row on top.
    ensureFactoryRubrics(PROJECT_ID);
    const seeded = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "producer")!;
    saveRubricVersion({
      ...SPEC_PRODUCER,
      criteria: [
        ...seeded.criteria.map((criterion) => ({
          criterionKey: criterion.criterionKey,
          text: criterion.text,
          blocking: criterion.blocking,
        })),
        { text: "User-added standard" },
      ],
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "producer")!;

    const byKey = new Map(panel.criteria.map((criterion) => [criterion.criterionKey, criterion]));
    const tier1 = byKey.get("RBK-factory-Spec-producer-03")!;
    assert.equal(tier1.tier, 1, "the promoted key is tier 1");
    assert.equal(tier1.blocking, true, "tier-1 is always blocking, whatever the save sent");
    assert.equal(
      byKey.get("RBK-factory-Spec-producer-01")!.tier,
      2,
      "a non-promoted factory key is tier 2",
    );
    const userRow = panel.criteria.find((criterion) => criterion.text === "User-added standard")!;
    assert.equal(userRow.tier, 3, "a runtime-minted key is tier 3");
    assert.equal(panel.criteria[0]!.criterionKey, "RBK-factory-Spec-producer-03",
      "the tier-1 row is pinned first by ordinal");
  });

  it("injects the tier-1 row into a save that did not carry it", () => {
    saveRubricVersion({ ...SPEC_PRODUCER, criteria: [{ text: "Only mine" }] });
    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "producer")!;
    assert.deepEqual(
      panel.criteria.map((criterion) => [criterion.tier, criterion.blocking]),
      [
        [1, true],
        [3, true],
      ],
      "one user row in, two rows out: the tier-1 clause cannot be saved away",
    );
  });

  it("ships the deterministic tier-1 checks for the phase, read-only metadata included", () => {
    const spec = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    });
    assert.ok(spec.tier1Deterministic.length > 0, "Spec has code-enforced guards to show");
    for (const item of spec.tier1Deterministic) {
      assert.ok(item.id && item.title && item.detail && item.enforcedBy);
    }
    assert.match(
      spec.tier1Deterministic[0]!.enforcedBy,
      /validatePlannedChanges/,
      "enforcedBy names the real execution point, not a paraphrase",
    );

    // The seeded repoPath does not exist on disk, so the policy-backed item
    // must say the file is MISSING rather than show an empty list.
    const build = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Build",
    });
    const policy = build.tier1Deterministic.find((item) => item.id === "policy-blocked-globs")!;
    assert.match(policy.detail, /策略文件缺失/);
  });
});
