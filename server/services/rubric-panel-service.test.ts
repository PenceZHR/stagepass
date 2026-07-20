import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import { battleRounds, changes, projects, rubricAssessments, rubricCriteria, rubrics } from "../db/schema.ts";
import { buildRubricPanelState } from "./rubric-panel-service.ts";
import {
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

    // Red answered under the round's FIRST run.
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric: producer,
      rawText: `RUBRIC: ${producer.criteria[0]!.id} | yes | acceptance criteria present`,
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
    assert.equal(
      producerPanel.verdicts.length,
      1,
      "the producer answered this round; a run-scoped read would have lost it and read as a pass",
    );
    assert.equal(producerPanel.verdicts[0]!.verdict, "yes");
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
    addRound(ROUND_1, 1);
    const producer = saveRubricVersion({ ...SPEC_PRODUCER, criteria: [{ text: "Alpha" }] });
    recordRubricAssessments({
      changeId: CHANGE_ID,
      runId: "RUN-RED-1",
      roundId: ROUND_1,
      rubric: producer,
      rawText: `RUBRIC: ${producer.criteria[0]!.id} | yes | round one`,
    });

    const all = listRubricAssessmentsForScope({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
      role: "producer",
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
  it("keeps showing a verdict after the rubric is edited, marked as an older version", () => {
    addRound(ROUND_1, 1);
    const v1 = saveRubricVersion({
      ...SPEC_PRODUCER,
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
      ...SPEC_PRODUCER,
      criteria: [{ criterionKey: v1.criteria[0]!.criterionKey, text: "Reworded wording" }],
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "producer")!;

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
      ...SPEC_PRODUCER,
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
      ...SPEC_PRODUCER,
      criteria: [{ criterionKey: v1.criteria[0]!.criterionKey, text: "Alpha" }],
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "producer")!;

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
  it("treats not_assessed as blocking even on a non-blocking criterion", () => {
    addRound(ROUND_1, 1);
    const rubric = saveRubricVersion({
      ...SPEC_PRODUCER,
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
    }).roles.find((role) => role.role === "producer")!;

    assert.equal(panel.verdicts[0]!.verdict, "not_assessed");
    assert.equal(
      panel.blocked,
      true,
      "silence is not content: blocking:false says a FAILURE is tolerable, not that an unanswered question is",
    );
  });

  it("does not block on a `no` against a non-blocking criterion", () => {
    addRound(ROUND_1, 1);
    const rubric = saveRubricVersion({
      ...SPEC_PRODUCER,
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
    }).roles.find((role) => role.role === "producer")!;
    assert.equal(panel.verdicts[0]!.verdict, "no");
    assert.equal(panel.blocked, false);
  });
});

describe("scope and role visibility", () => {
  it("reports which scope is in force and that an override exists", () => {
    saveRubricVersion({ ...SPEC_PRODUCER, criteria: [{ text: "Project default" }] });

    const asProject = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "producer")!;
    assert.equal(asProject.source, "project");
    assert.equal(asProject.hasChangeOverride, false);
    assert.equal(asProject.criteria[0]!.text, "Project default");

    saveRubricVersion({
      ...SPEC_PRODUCER,
      changeId: CHANGE_ID,
      criteria: [{ text: "Change override" }],
    });
    const asChange = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "producer")!;
    assert.equal(asChange.source, "change");
    assert.equal(asChange.hasChangeOverride, true);
    assert.equal(asChange.criteria[0]!.text, "Change override");
  });

  it("keeps a verdict made against the project default visible after an override appears", () => {
    addRound(ROUND_1, 1);
    const projectLevel = saveRubricVersion({
      ...SPEC_PRODUCER,
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
      ...SPEC_PRODUCER,
      changeId: CHANGE_ID,
      criteria: [{ text: "Change override" }],
    });

    const panel = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
    }).roles.find((role) => role.role === "producer")!;
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
