import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  changes,
  findings,
  projects,
  requirementGaps,
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
  stageGatePhaseFor,
  syncRubricBlockers,
  type RubricBlockingChannel,
} from "./rubric-gate-adapters.ts";
import {
  activeRubricBlockers,
  isRubricBlockerId,
  rubricBlockerId,
} from "./rubric-gate-service.ts";
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
import { TIER1_CRITERION_KEYS } from "./rubric-tiers.ts";
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
 *     (Since 2026-07-21 the four tier-1 promotions are the deliberate exception
 *     -- §2.1 恒阻断, pinned in rubric-tiers.test.ts.)
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

/**
 * A rubric with one blocking criterion, answered `no` under a round-less run.
 *
 * The judged row is looked up by the text this helper wrote, not by index: on
 * a tier-1 scope (Build/Done producer) saveRubricVersion pins the tier-1 rows
 * first (rubric-tiers.ts §2.1), so `criteria[0]` is no longer the row this
 * fixture created. Tier-1 rows the model stays silent about are recorded
 * `not_assessed` -- exactly what a real one-answer reply produces there.
 */
function judgedBlockingCriterion(phase: RubricPhase, runId: string) {
  const text = `${phase} 的一条硬标准`;
  const rubric = saveRubricVersion({
    ...scopeFor(phase),
    criteria: [{ text, blocking: true }],
  });
  const created = rubric.criteria.find((criterion) => criterion.text === text);
  assert.ok(created, "the fixture's own criterion must survive the save");
  recordRubricAssessments({
    changeId: CHANGE_ID,
    runId,
    roundId: null,
    rubric,
    rawText: `RUBRIC: ${created.id} | no | 产物没有满足这一条`,
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

  it("ships every criterion non-blocking, except the four tier-1 promotions", () => {
    // Until 2026-07-21 this asserted NO criterion ships blocking. That is now
    // wrong by design for exactly the tier-1 registry (§2.1 恒阻断): those four
    // keys are promotions of factory lines that already shipped, blocking on
    // arrival is their whole point, and no drawer can turn them off. The
    // "stalled against wording nobody has read" argument this test encodes
    // still holds for every OTHER criterion, so that is what it pins now.
    ensureFactoryRubrics(PROJECT_ID);
    for (const scope of factoryRubricScopes()) {
      const rubric = getCurrentRubric(scopeFor(scope.phase, scope.role))!;
      assert.ok(rubric, `${scope.phase} ${scope.role} was not seeded`);
      const blocking = rubric.criteria.filter((criterion) => criterion.blocking);
      assert.deepEqual(
        blocking.map((criterion) => criterion.criterionKey),
        rubric.criteria
          .map((criterion) => criterion.criterionKey)
          .filter((key) => TIER1_CRITERION_KEYS.has(key)),
        `${scope.phase} ${scope.role} ships a blocking criterion outside the tier-1 registry; `
        + "every existing project would meet it for the first time mid-pipeline, and the only "
        + "exit is a drawer nobody has opened",
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

  // A criterion is read by a model that also read its host template, and the
  // Spec templates spend three lines each disambiguating who is who: 红方 is the
  // human user and nobody else, SPEC_WRITER is 我方执行代理 / 正方,
  // REQUIREMENT_CRITIC is 反方. 蓝方 is defined in no template at all.
  //
  // Three shipped criteria used 蓝方 and 红方 to mean the two agents. A critic
  // obeying its template then reads "红方声称修复的每一个 gap" as a claim about
  // the human -- who authors no fix claims -- and the rubric's own instruction
  // is that a criterion you cannot confirm is `no`. That is a false `no` on a
  // standard the critic actually met, shipped to every project, and the moment
  // somebody ticks `blocking` it becomes a P0 that describes nothing.
  // The assertion that was missing while keys were positional. `criterionKey` is
  // identity: derived blockers persist as `RUBRIC:<criterionKey>` and §4.3.1's
  // exit hangs on it, so changing a key silently retires a blocker the user
  // never withdrew and opens one they never saw. The old tests checked key
  // SHAPE and count, which a renumbering satisfies perfectly.
  //
  // Pinned as a SET, not a key-to-text map, on purpose: rewording a criterion
  // must keep its identity (that is what the key being authored buys), so text
  // drift is legal and must not fail here. Changing or dropping a key is not.
  // Adding one fails until you add it below -- deliberately, since a new
  // criterion reaches every project on the next seed.
  const FACTORY_CRITERION_KEYS = [
    // PRD producer
    "RBK-factory-PRD-producer-01",
    "RBK-factory-PRD-producer-02",
    "RBK-factory-PRD-producer-03",
    "RBK-factory-PRD-producer-04",
    "RBK-factory-PRD-producer-05",
    "RBK-factory-PRD-producer-06",
    "RBK-factory-PRD-producer-07",
    "RBK-factory-PRD-producer-08",
    // PRD critic
    "RBK-factory-PRD-critic-01",
    "RBK-factory-PRD-critic-02",
    "RBK-factory-PRD-critic-03",
    "RBK-factory-PRD-critic-04",
    "RBK-factory-PRD-critic-05",
    "RBK-factory-PRD-critic-06",
    "RBK-factory-PRD-critic-07",
    // Spec producer
    "RBK-factory-Spec-producer-01",
    "RBK-factory-Spec-producer-02",
    "RBK-factory-Spec-producer-03",
    "RBK-factory-Spec-producer-04",
    "RBK-factory-Spec-producer-05",
    "RBK-factory-Spec-producer-06",
    // Spec critic
    "RBK-factory-Spec-critic-01",
    "RBK-factory-Spec-critic-02",
    "RBK-factory-Spec-critic-03",
    "RBK-factory-Spec-critic-04",
    "RBK-factory-Spec-critic-05",
    "RBK-factory-Spec-critic-06",
    // Spec verdict
    "RBK-factory-Spec-verdict-01",
    "RBK-factory-Spec-verdict-02",
    "RBK-factory-Spec-verdict-03",
    "RBK-factory-Spec-verdict-04",
    "RBK-factory-Spec-verdict-05",
    // TechSpec producer
    "RBK-factory-TechSpec-producer-01",
    "RBK-factory-TechSpec-producer-02",
    "RBK-factory-TechSpec-producer-03",
    "RBK-factory-TechSpec-producer-04",
    "RBK-factory-TechSpec-producer-05",
    "RBK-factory-TechSpec-producer-06",
    "RBK-factory-TechSpec-producer-07",
    "RBK-factory-TechSpec-producer-08",
    // Plan producer
    "RBK-factory-Plan-producer-01",
    "RBK-factory-Plan-producer-02",
    "RBK-factory-Plan-producer-03",
    "RBK-factory-Plan-producer-04",
    "RBK-factory-Plan-producer-05",
    "RBK-factory-Plan-producer-06",
    "RBK-factory-Plan-producer-07",
    "RBK-factory-Plan-producer-08",
    // TestPlan producer
    "RBK-factory-TestPlan-producer-01",
    "RBK-factory-TestPlan-producer-02",
    "RBK-factory-TestPlan-producer-03",
    "RBK-factory-TestPlan-producer-04",
    "RBK-factory-TestPlan-producer-05",
    "RBK-factory-TestPlan-producer-06",
    "RBK-factory-TestPlan-producer-07",
    // Build producer
    "RBK-factory-Build-producer-01",
    "RBK-factory-Build-producer-02",
    "RBK-factory-Build-producer-03",
    "RBK-factory-Build-producer-04",
    "RBK-factory-Build-producer-05",
    "RBK-factory-Build-producer-06",
    "RBK-factory-Build-producer-07",
    // Build critic
    "RBK-factory-Build-critic-01",
    "RBK-factory-Build-critic-02",
    "RBK-factory-Build-critic-03",
    "RBK-factory-Build-critic-04",
    "RBK-factory-Build-critic-05",
    "RBK-factory-Build-critic-06",
    "RBK-factory-Build-critic-07",
    // Fix producer
    "RBK-factory-Fix-producer-01",
    "RBK-factory-Fix-producer-02",
    "RBK-factory-Fix-producer-03",
    "RBK-factory-Fix-producer-04",
    "RBK-factory-Fix-producer-05",
    "RBK-factory-Fix-producer-06",
    // Retro producer
    "RBK-factory-Retro-producer-01",
    "RBK-factory-Retro-producer-02",
    "RBK-factory-Retro-producer-03",
    "RBK-factory-Retro-producer-04",
    "RBK-factory-Retro-producer-05",
    "RBK-factory-Retro-producer-06",
    // Done producer (delivery note). Added deliberately: this list turning red
    // on a new factory criterion is the mechanism working, not a nuisance --
    // these keys reach every project on the next seed.
    "RBK-factory-Done-producer-01",
    "RBK-factory-Done-producer-02",
    "RBK-factory-Done-producer-03",
    "RBK-factory-Done-producer-04",
    "RBK-factory-Done-producer-05",
    "RBK-factory-Done-producer-06",
    "RBK-factory-Done-producer-07",
    "RBK-factory-Done-producer-08",
    "RBK-factory-Done-producer-09",
    "RBK-factory-Done-producer-10",
  ];

  it("keeps every factory criterion key exactly as shipped", () => {
    const live = factoryRubricScopes()
      .flatMap((scope) => factoryCriteria(scope.phase, scope.role))
      .map((criterion) => criterion.criterionKey);
    assert.deepEqual(
      [...live].sort(),
      [...FACTORY_CRITERION_KEYS].sort(),
      "a factory criterion key changed -- every blocker already stamped against the old key "
      + "retires silently, and the criterion it named is no longer the one the user ticked",
    );
  });

  it("uses only the role words the prompt templates define", () => {
    const undefinedRoleWords = ["蓝方"];
    for (const scope of factoryRubricScopes()) {
      for (const criterion of factoryCriteria(scope.phase, scope.role)) {
        for (const word of undefinedRoleWords) {
          assert.ok(
            !criterion.text.includes(word),
            `${scope.phase} ${scope.role} criterion "${criterion.text}" uses "${word}", which no `
            + "prompt template defines -- the model is being asked about a role it was never given",
          );
        }
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
  // Keyed by phase rather than written as a list of calls, and cross-checked
  // against RUBRIC_PHASES below, because the previous version of this test
  // asserted only 7 of the 12 phases. The five it skipped were exactly the ones
  // whose channel nobody had checked -- QA, Merge and Done among them -- and two
  // docblocks in rubric-gate-adapters had drifted to claim QA and Merge were
  // `none` (they are `stage_gate`) while omitting Done (which is `none`). A
  // partial list is how a vocabulary claims to be complete and is not.
  const EXPECTED_CHANNEL: Record<RubricPhase, RubricBlockingChannel> = {
    Spec: "requirement_gap",
    Build: "finding",
    Fix: "finding",
    PRD: "stage_gate",
    TechSpec: "stage_gate",
    Plan: "stage_gate",
    TestPlan: "stage_gate",
    // Real `stage_gates` rows and real `PipelinePhase` members. These two are
    // inert for an unrelated reason -- RUBRIC_ROLE_ANSWERED_BY gives them no
    // answerer -- which is the panel's `answeredBy` notice, not this one.
    QA: "stage_gate",
    Merge: "stage_gate",
    // Own no stage_gates row anywhere in the repo: ticking `blocking` here
    // records a verdict and stops nothing, which the drawer has to admit.
    Refine: "none",
    Retro: "none",
    // Terminal and post-merge. See the behavioural case below.
    Done: "none",
  };

  it("reports each phase's real blocking channel, for every phase there is", () => {
    for (const phase of RUBRIC_PHASES) {
      assert.equal(
        rubricBlockingChannel(phase),
        EXPECTED_CHANNEL[phase],
        `${phase} routes to the wrong blocking channel`,
      );
    }
    assert.deepEqual(
      Object.keys(EXPECTED_CHANNEL).sort(),
      [...RUBRIC_PHASES].sort(),
      "a phase added to RUBRIC_PHASES must be classified here, not left to a default arm",
    );
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

/**
 * Done is the terminus (delivery runs DELIVERY_PENDING -> DONE, and the change
 * is already merged by then), so a rubric-derived P0 there could not stop a
 * downstream gate -- it could only strand the change short of DONE, and strand
 * it permanently, since a rubric-derived blocker is P0 and P0 has no human
 * waiver in any channel.
 *
 * So the behaviour under test is deliberately the NEGATIVE one: a ticked
 * `blocking` criterion on Done, answered `no`, must be recorded and shown and
 * must write no blocking record anywhere. That is only worth asserting next to a
 * positive control -- "nothing was written" passes just as well when the fixture
 * never worked -- so the Build case runs first through the same helper and the
 * same dispatcher, and must write a finding.
 */
describe("Done records a blocking verdict without blocking anything", () => {
  function rubricDerivedFindingIds(): string[] {
    return db
      .select()
      .from(findings)
      .where(eq(findings.changeId, CHANGE_ID))
      .all()
      .filter((row) => isRubricBlockerId(row.id))
      .map((row) => row.id)
      .sort();
  }

  function rubricDerivedGapIds(): string[] {
    return db
      .select()
      .from(requirementGaps)
      .where(eq(requirementGaps.changeId, CHANGE_ID))
      .all()
      .filter((row) => isRubricBlockerId(row.canonicalGapId))
      .map((row) => row.canonicalGapId!)
      .sort();
  }

  it("control: the same fixture on Fix really does write a blocking record", () => {
    // Fix rather than Build for the positive control: both route to the same
    // `finding` channel, but Build/producer now force-merges two always-blocking
    // tier-1 rows into the fixture's save (rubric-tiers.ts §2.1), whose
    // not_assessed verdicts would open findings of their own. Fix/producer
    // carries no tier-1 row, so the control stays a single criterion in, a
    // single finding out.
    const rubric = judgedBlockingCriterion("Fix", "RUN-FIX-CONTROL");
    const synced = syncRubricBlockers(CHANGE_ID, "Fix");

    assert.equal(synced.channel, "finding");
    assert.deepEqual(
      rubricDerivedFindingIds(),
      [rubricBlockerId(rubric.criteria[0]!.criterionKey)],
      "a ticked `blocking` criterion answered `no` lands as an open P0 finding",
    );
  });

  it("writes no finding, no gap and no stage gate for a blocking Done `no`", () => {
    const rubric = judgedBlockingCriterion("Done", "RUN-DONE-1");
    assert.equal(
      rubric.criteria[0]!.blocking,
      true,
      "precondition: the user ticked 阻断 and the drawer persisted it",
    );

    const synced = syncRubricBlockers(CHANGE_ID, "Done");

    assert.equal(synced.channel, "none");
    // The three ways a blocker could land. Routing Done to any real channel
    // trips one of these, which is the point of asserting all three rather than
    // asserting that a constant equals "none".
    assert.deepEqual(rubricDerivedFindingIds(), [], "Done must not open a finding");
    assert.deepEqual(rubricDerivedGapIds(), [], "Done must not open a requirement gap");
    assert.equal(synced.stageGate, null, "Done owns no stage gate to amend");
    assert.deepEqual(
      synced.records,
      { opened: [], retired: [], reopened: [] },
      "nothing opened, nothing retired -- the verdict simply has nowhere to land",
    );
    assert.equal(stageGatePhaseFor("Done"), null, "and no PipelinePhase to land it on");
  });

  it("still records the verdict, and the drawer can still say the tick is inert", () => {
    const rubric = judgedBlockingCriterion("Done", "RUN-DONE-2");
    syncRubricBlockers(CHANGE_ID, "Done");

    const state = buildRubricPanelState({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Done",
    });
    const producer = state.roles.find((role) => role.role === "producer")!;

    // Two rows, not one, since 2026-07-21: Done/producer saves force-merge the
    // tier-1 delivery clause (rubric-tiers.ts §2.1), so the fixture's rubric is
    // [tier-1, user criterion] and the unanswered tier-1 row is recorded
    // not_assessed. The behaviour under test -- the user's blocking `no` is
    // kept and shown while the channel stays "none" -- is unchanged.
    assert.equal(
      producer.verdicts.length,
      rubric.criteria.length,
      "every criterion's judgment is kept, not discarded",
    );
    const judged = producer.verdicts.find((entry) => entry.verdict === "no");
    assert.ok(judged, "the user's `no` is kept, not discarded");
    assert.equal(judged.blocking, true, "and it is shown as a blocking one");
    assert.equal(
      rubricRoleAnsweredBy("Done", "producer"),
      "delivery",
      "the delivery stage does answer this rubric, so the drawer's other inert reason does not apply",
    );
    assert.equal(
      state.blockingChannel,
      "none",
      "which leaves exactly one honest notice for the drawer to print: the tick stops nothing",
    );
  });
});
