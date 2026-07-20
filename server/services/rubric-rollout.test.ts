import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  changes,
  projects,
  rubricAssessments,
  rubricCriteria,
  rubrics,
} from "../db/schema.ts";
import { deleteChangeRecords } from "./change-service.ts";
import { persistPlanSnapshot } from "./plan-snapshot-service.ts";
import { RUBRIC_PHASES, RUBRIC_ROLES, type RubricPhase, type RubricRole } from "./rubric-assessment.ts";
import {
  factoryCriteria,
  factoryRubricScopes,
  RUBRIC_ROLE_ANSWERED_BY,
  rubricRoleAnsweredBy,
} from "./rubric-defaults.ts";
import {
  rubricBlockingChannel,
  reapplyRubricStageGateBlockers,
} from "./rubric-gate-adapters.ts";
import { activeRubricBlockers, rubricBlockerId } from "./rubric-gate-service.ts";
import { buildRubricPanelState } from "./rubric-panel-service.ts";
import {
  ensureFactoryRubrics,
  getCurrentRubric,
  recordRubricAssessments,
  recordUnansweredRubric,
  saveRubricVersion,
  selectLatestAssessmentBatch,
  type StoredRubricAssessment,
} from "./rubric-service.ts";
import { peekStageAuthority, recomputeStageGate } from "./stage-authority-service.ts";

/**
 * Batch 6: the rollout to the remaining phases.
 *
 * Three things are load-bearing here and none of them was reachable before:
 *
 *  1. A document phase's own gate write must NOT swallow a rubric blocker.
 *     `stage_gates` is append-only and every phase publishes its whole blocker
 *     list from its own inputs, so a phase writing a gate after a rubric blocker
 *     opened would silently drop it and read `passed`.
 *  2. A round-less phase must be able to supersede its own verdicts by
 *     re-running. Every document phase, Build and Fix store `roundId = null`,
 *     so "this execution's verdicts" has to be identified by run.
 *  3. Factory criteria must be inert on arrival: recorded and displayed, never
 *     blocking, or every existing project stalls the next time it runs anything.
 */

const PROJECT_ID = "PRJ-RUBRIC-ROLLOUT";
const CHANGE_ID = "CHG-RUBRIC-ROLLOUT";
const NOW = "2026-07-20T00:00:00.000Z";

let repoRoot: string;

function cleanup() {
  // The change's own children go through the real delete plan: these cases write
  // stage gates, stage states, stage runs and plan snapshots, and hand-listing
  // those tables here would rot the moment one is added. Project-level rubrics
  // are outside that plan by design (they outlive the change), so they are
  // cleared explicitly -- the same asymmetry PROJECT_RUBRIC_DELETE_PLAN exists
  // for.
  for (const change of db.select({ id: changes.id }).from(changes)
    .where(like(changes.id, "CHG-RUBRIC-ROLLOUT%")).all()) {
    deleteChangeRecords(change.id);
  }
  const ids = db
    .select({ id: rubrics.id })
    .from(rubrics)
    .where(like(rubrics.projectId, "PRJ-RUBRIC-ROLLOUT%"))
    .all()
    .map((row) => row.id);
  for (const id of ids) {
    db.delete(rubricAssessments).where(eq(rubricAssessments.rubricId, id)).run();
    db.delete(rubricCriteria).where(eq(rubricCriteria.rubricId, id)).run();
  }
  db.delete(rubrics).where(like(rubrics.projectId, "PRJ-RUBRIC-ROLLOUT%")).run();
  db.delete(changes).where(like(changes.id, "CHG-RUBRIC-ROLLOUT%")).run();
  db.delete(projects).where(like(projects.id, "PRJ-RUBRIC-ROLLOUT%")).run();
}

beforeEach(() => {
  cleanup();
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-rollout-"));
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Rubric rollout",
    repoPath: repoRoot,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Roll rubrics out",
    status: "PLAN_READY",
    provider: "codex",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
});

afterEach(() => {
  cleanup();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function scopeFor(phase: RubricPhase, role: RubricRole = "producer") {
  return { projectId: PROJECT_ID, changeId: null as string | null, phase, role };
}

/** A rubric with one blocking criterion, answered `no` under a round-less run. */
function judgedBlockingCriterion(phase: RubricPhase, runId: string) {
  const rubric = saveRubricVersion({
    ...scopeFor(phase),
    criteria: [{ text: `${phase} 的一条硬标准`, blocking: true }],
  });
  recordRubricAssessments({
    changeId: CHANGE_ID,
    runId,
    roundId: null,
    rubric,
    rawText: `RUBRIC: ${rubric.criteria[0]!.id} | no | 产物没有满足这一条`,
  });
  return rubric;
}

function latestGate(phase: "Plan" | "TechSpec" | "TestPlan" | "PRD") {
  return peekStageAuthority(CHANGE_ID, phase).latestGate;
}

function blockerIds(phase: "Plan" | "TechSpec" | "TestPlan" | "PRD"): string[] {
  const raw = latestGate(phase)?.blockersJson ?? "[]";
  return (JSON.parse(raw) as Array<{ id: string }>).map((entry) => entry.id).sort();
}

describe("factory rubrics", () => {
  it("seeds every declared scope, once, and never re-seeds", () => {
    const first = ensureFactoryRubrics(PROJECT_ID);
    assert.deepEqual(
      first.map((scope) => `${scope.phase} ${scope.role}`).sort(),
      factoryRubricScopes().map((scope) => `${scope.phase} ${scope.role}`).sort(),
    );
    assert.deepEqual(ensureFactoryRubrics(PROJECT_ID), [], "seeding must be idempotent");
  });

  it("ships every criterion non-blocking, so no existing project is stalled by an upgrade", () => {
    ensureFactoryRubrics(PROJECT_ID);
    for (const scope of factoryRubricScopes()) {
      const rubric = getCurrentRubric(scopeFor(scope.phase, scope.role))!;
      assert.ok(rubric, `${scope.phase} ${scope.role} was not seeded`);
      const blocking = rubric.criteria.filter((criterion) => criterion.blocking);
      assert.deepEqual(
        blocking.map((criterion) => criterion.text),
        [],
        `${scope.phase} ${scope.role} ships a blocking criterion; every existing project would `
        + "meet it for the first time mid-pipeline, and the only exit is a drawer nobody has opened",
      );
    }
  });

  it("gives every declared scope 5-12 criteria, all with stable keys", () => {
    for (const scope of factoryRubricScopes()) {
      const criteria = factoryCriteria(scope.phase, scope.role);
      assert.ok(
        criteria.length >= 5 && criteria.length <= 12,
        `${scope.phase} ${scope.role} has ${criteria.length} criteria, outside 5-12`,
      );
      const keys = criteria.map((criterion) => criterion.criterionKey);
      assert.equal(new Set(keys).size, keys.length, `${scope.phase} ${scope.role} has duplicate keys`);
      for (const key of keys) {
        assert.match(key, new RegExp(`^RBK-factory-${scope.phase}-${scope.role}-\\d{2}$`));
      }
    }
  });

  it("only declares a scope that something in the pipeline actually answers", () => {
    for (const scope of factoryRubricScopes()) {
      assert.ok(
        rubricRoleAnsweredBy(scope.phase, scope.role),
        `${scope.phase} ${scope.role} ships criteria but nothing answers it -- the drawer would `
        + "hold a checklist that stays blank forever, and blank reads as 'no rubric', which reads as a pass",
      );
    }
    // ...and the map covers every phase, so adding one to RUBRIC_PHASES without
    // deciding who answers it fails here rather than silently.
    for (const phase of RUBRIC_PHASES) {
      assert.ok(RUBRIC_ROLE_ANSWERED_BY[phase], `${phase} has no answerability entry`);
    }
  });

  it("does not resurrect a rubric the user emptied", () => {
    ensureFactoryRubrics(PROJECT_ID);
    saveRubricVersion({ ...scopeFor("Plan"), criteria: [] });
    ensureFactoryRubrics(PROJECT_ID);
    assert.deepEqual(
      getCurrentRubric(scopeFor("Plan"))!.criteria,
      [],
      "an emptied rubric is the documented way to turn a phase off (§4.5)",
    );
  });

  it("leaves nothing blocked after a stage answers none of them", () => {
    ensureFactoryRubrics(PROJECT_ID);
    const rubric = getCurrentRubric(scopeFor("Plan"))!;
    recordUnansweredRubric({ changeId: CHANGE_ID, runId: "RUN-PLAN-1", roundId: null, rubric });

    const panel = buildRubricPanelState({ projectId: PROJECT_ID, changeId: CHANGE_ID, phase: "Plan" })
      .roles.find((role) => role.role === "producer")!;
    assert.equal(panel.verdicts.length, rubric.criteria.length, "every criterion is still recorded");
    assert.equal(
      panel.blocked,
      false,
      "a model that answered nothing must not light up a phase whose criteria are all advisory",
    );
  });
});

describe("a phase's own gate write must not swallow a rubric blocker", () => {
  function seedPassingGate(phase: "TechSpec" | "Plan") {
    recomputeStageGate({
      changeId: CHANGE_ID,
      phase,
      status: "passed",
      blockers: [],
      freshness: { fresh: true },
      requiredActions: [],
      sourceDbHash: `${phase}-SOURCE`,
    });
  }

  it("re-derives after the phase republishes its own blocker list", () => {
    seedPassingGate("TechSpec");
    const rubric = judgedBlockingCriterion("TechSpec", "RUN-TS-1");
    const derivedId = rubricBlockerId(rubric.criteria[0]!.criterionKey);

    reapplyRubricStageGateBlockers(CHANGE_ID, "TechSpec");
    assert.deepEqual(blockerIds("TechSpec"), [derivedId]);
    assert.equal(latestGate("TechSpec")?.status, "blocked");

    // This is exactly what pipeline-design-stage-service does on a re-run:
    // a fresh gate row built only from the phase's own inputs.
    seedPassingGate("TechSpec");
    assert.deepEqual(
      blockerIds("TechSpec"),
      [],
      "sanity: the phase's own write really does drop the rubric blocker",
    );

    reapplyRubricStageGateBlockers(CHANGE_ID, "TechSpec");
    assert.deepEqual(
      blockerIds("TechSpec"),
      [derivedId],
      "the writer's follow-up re-derivation is what keeps the blocker alive",
    );
    assert.equal(latestGate("TechSpec")?.status, "blocked");
  });

  it("survives a real Plan snapshot write, which hand-rolls its own gate insert", () => {
    seedPassingGate("Plan");
    const rubric = judgedBlockingCriterion("Plan", "RUN-PLAN-1");
    const derivedId = rubricBlockerId(rubric.criteria[0]!.criterionKey);
    reapplyRubricStageGateBlockers(CHANGE_ID, "Plan");
    assert.deepEqual(blockerIds("Plan"), [derivedId]);

    // The real writer. It inserts into stage_gates by hand inside its own
    // transaction, which is why its re-derivation had to be placed after the
    // commit rather than inside it.
    persistPlanSnapshot({
      changeId: CHANGE_ID,
      repoPath: repoRoot,
      plan: {
        summary: "roll out rubrics",
        implementationSteps: [
          { step: 1, description: "wire the phases", file: "server/services/rubric-defaults.ts", status: "pending" },
        ],
        expectedFiles: ["server/services/rubric-defaults.ts"],
        forbiddenFiles: [],
        acceptanceCriteria: ["every phase resolves a rubric"],
      } as never,
      risks: [],
      gate: {
        canApprove: true,
        blockingP0: 0,
        blockingP1: 0,
        nonBlockingP2: 0,
        missingFields: [],
      } as never,
      reportFresh: true,
    });

    assert.deepEqual(
      blockerIds("Plan"),
      [derivedId],
      "persistPlanSnapshot published a gate from its own inputs and must re-derive afterwards",
    );
    assert.equal(latestGate("Plan")?.status, "blocked");
  });

  it("restores the phase's own status when the criterion is withdrawn", () => {
    seedPassingGate("Plan");
    const rubric = judgedBlockingCriterion("Plan", "RUN-PLAN-1");
    reapplyRubricStageGateBlockers(CHANGE_ID, "Plan");
    assert.equal(latestGate("Plan")?.status, "blocked");

    // §4.3.1: the exit is the criterion itself.
    saveRubricVersion({
      ...scopeFor("Plan"),
      criteria: [
        {
          text: rubric.criteria[0]!.text,
          blocking: false,
          criterionKey: rubric.criteria[0]!.criterionKey,
        },
      ],
    });
    reapplyRubricStageGateBlockers(CHANGE_ID, "Plan");
    assert.equal(latestGate("Plan")?.status, "passed");
    assert.deepEqual(blockerIds("Plan"), []);
  });

  it("never appends a gate row when nothing changed", () => {
    seedPassingGate("Plan");
    judgedBlockingCriterion("Plan", "RUN-PLAN-1");
    reapplyRubricStageGateBlockers(CHANGE_ID, "Plan");
    const version = latestGate("Plan")!.gateVersion;
    assert.deepEqual(reapplyRubricStageGateBlockers(CHANGE_ID, "Plan"), {
      applied: false,
      reason: "unchanged",
    });
    assert.equal(
      latestGate("Plan")!.gateVersion,
      version,
      "a bumped gate_version is what preflight rejects as gate_version_drift",
    );
  });
});

describe("every document-phase gate writer re-derives", () => {
  // A tripwire, not a proof: the two cases above prove the behaviour for the
  // writers a unit test can drive cheaply. PRD and TechSpec sit behind a full
  // provider run, so this guards them against someone adding a gate write -- or
  // removing the follow-up -- without noticing that the rubric blocker vanishes.
  const WRITERS: Array<{ file: string; phase: string }> = [
    { file: "server/services/prd-briefing-service.ts", phase: "PRD" },
    { file: "server/services/pipeline-design-stage-service.ts", phase: "TechSpec" },
    { file: "server/services/plan-snapshot-service.ts", phase: "Plan" },
    { file: "server/services/testplan-snapshot-service.ts", phase: "TestPlan" },
  ];

  for (const writer of WRITERS) {
    it(`${writer.phase}: ${path.basename(writer.file)} calls reapplyRubricStageGateBlockers`, () => {
      const source = fs.readFileSync(path.join(process.cwd(), writer.file), "utf8");
      assert.match(
        source,
        new RegExp(`reapplyRubricStageGateBlockers\\([^)]*"${writer.phase}"\\)`),
        `${writer.file} writes the ${writer.phase} gate but never re-derives the rubric blockers, `
        + "so the next gate row it publishes silently drops them",
      );
    });
  }
});

describe("round-less phases identify a batch by run", () => {
  function row(overrides: Partial<StoredRubricAssessment>): StoredRubricAssessment {
    return {
      id: "RBA-x",
      rubricId: "RUB-1",
      runId: "RUN-1",
      roundId: null,
      criterionId: "C1",
      verdict: "no",
      evidence: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      ...overrides,
    };
  }

  it("a re-run supersedes the previous run instead of being merged with it", () => {
    const batch = selectLatestAssessmentBatch(
      [
        row({ id: "A", runId: "RUN-1", verdict: "no", createdAt: "2026-07-20T00:00:00.000Z" }),
        row({ id: "B", runId: "RUN-2", verdict: "yes", createdAt: "2026-07-20T01:00:00.000Z" }),
      ],
      { roundId: null },
    );
    assert.deepEqual(batch.map((entry) => entry.runId), ["RUN-2"]);
    assert.deepEqual(
      batch.map((entry) => entry.verdict),
      ["yes"],
      "fixing the artefact and re-running is §4.3.1's second exit; merging the runs closed it",
    );
  });

  it("breaks a same-millisecond tie deterministically rather than by row order", () => {
    const sameMs = "2026-07-20T00:00:00.000Z";
    const forwards = selectLatestAssessmentBatch(
      [row({ id: "A", runId: "RUN-1", createdAt: sameMs }), row({ id: "B", runId: "RUN-2", createdAt: sameMs })],
      { roundId: null },
    );
    const backwards = selectLatestAssessmentBatch(
      [row({ id: "B", runId: "RUN-2", createdAt: sameMs }), row({ id: "A", runId: "RUN-1", createdAt: sameMs })],
      { roundId: null },
    );
    assert.deepEqual(forwards.map((entry) => entry.runId), backwards.map((entry) => entry.runId));
  });

  it("still selects by round when there is one, so §5.2 is untouched", () => {
    // resumeBlue: red answered under the round's FIRST run, blue finishes under
    // a second. Reading by run id would find no producer verdicts and pass.
    const batch = selectLatestAssessmentBatch(
      [
        row({ id: "A", runId: "RUN-RED", roundId: "BR-1", verdict: "no" }),
        row({ id: "B", runId: "RUN-BLUE", roundId: "BR-2", verdict: "yes" }),
      ],
      { roundId: "BR-1" },
    );
    assert.deepEqual(batch.map((entry) => entry.runId), ["RUN-RED"]);
  });
});

describe("the drawer and the gate agree on what is blocked", () => {
  // Batch 5's comment claims sharing `rubricOutcome` makes disagreement
  // impossible. It did not: each side applied its own second filter. Both of
  // these were observed disagreeing before batch 6, one in each direction.
  function panelBlocked(phase: RubricPhase): boolean {
    return buildRubricPanelState({ projectId: PROJECT_ID, changeId: CHANGE_ID, phase })
      .roles.find((role) => role.role === "producer")!.blocked;
  }

  function gateBlocked(phase: RubricPhase): boolean {
    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()!;
    return activeRubricBlockers({
      projectId: change.projectId,
      changeId: CHANGE_ID,
      phase,
      roundId: null,
    }).length > 0;
  }

  it("agrees while a blocking criterion stands", () => {
    judgedBlockingCriterion("Plan", "RUN-PLAN-1");
    assert.equal(panelBlocked("Plan"), true);
    assert.equal(gateBlocked("Plan"), true);
  });

  it("agrees once the criterion is withdrawn -- §4.3.1's exit clears the dot too", () => {
    const rubric = judgedBlockingCriterion("Plan", "RUN-PLAN-1");
    saveRubricVersion({
      ...scopeFor("Plan"),
      criteria: [{
        text: rubric.criteria[0]!.text,
        blocking: false,
        criterionKey: rubric.criteria[0]!.criterionKey,
      }],
    });
    assert.equal(
      gateBlocked("Plan"),
      false,
      "withdrawing the standard is the only exit a rubric-derived P0 has",
    );
    assert.equal(
      panelBlocked("Plan"),
      false,
      "a drawer still showing a blocking dot after the exit makes the exit look broken",
    );
  });

  it("agrees on an unanswered advisory criterion", () => {
    ensureFactoryRubrics(PROJECT_ID);
    recordUnansweredRubric({
      changeId: CHANGE_ID,
      runId: "RUN-PLAN-2",
      roundId: null,
      rubric: getCurrentRubric(scopeFor("Plan"))!,
    });
    assert.equal(panelBlocked("Plan"), false);
    assert.equal(gateBlocked("Plan"), false);
  });
});

describe("a rubric that cannot block says so", () => {
  it("reports each phase's real blocking channel", () => {
    assert.equal(rubricBlockingChannel("Spec"), "requirement_gap");
    assert.equal(rubricBlockingChannel("Build"), "finding");
    assert.equal(rubricBlockingChannel("Fix"), "finding");
    assert.equal(rubricBlockingChannel("Plan"), "stage_gate");
    assert.equal(rubricBlockingChannel("TechSpec"), "stage_gate");
    assert.equal(rubricBlockingChannel("PRD"), "stage_gate");
    assert.equal(rubricBlockingChannel("TestPlan"), "stage_gate");
    // Own no stage_gates row anywhere in the repo: ticking `blocking` here
    // records a verdict and stops nothing, which the drawer has to admit.
    assert.equal(rubricBlockingChannel("Refine"), "none");
    assert.equal(rubricBlockingChannel("Retro"), "none");
  });

  it("marks a role nothing answers, and the panel carries it", () => {
    assert.equal(rubricRoleAnsweredBy("Plan", "producer"), "generate_plan");
    assert.equal(rubricRoleAnsweredBy("Build", "critic"), "review");
    assert.equal(rubricRoleAnsweredBy("QA", "producer"), null);
    assert.equal(rubricRoleAnsweredBy("Merge", "critic"), null);
    assert.equal(rubricRoleAnsweredBy("Refine", "producer"), null);
    assert.equal(
      rubricRoleAnsweredBy("Fix", "critic"),
      null,
      "the single review stage answers Build's critic rubric; Fix's critic tab has no answerer",
    );

    const panel = buildRubricPanelState({ projectId: PROJECT_ID, changeId: CHANGE_ID, phase: "QA" });
    assert.equal(panel.blockingChannel, "stage_gate");
    for (const role of RUBRIC_ROLES) {
      assert.equal(panel.roles.find((entry) => entry.role === role)!.answeredBy, null);
    }
  });
});
