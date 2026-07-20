import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  battleRounds,
  changes,
  findings,
  projects,
  requirementGaps,
  rubricAssessments,
  rubricCriteria,
  rubrics,
} from "../db/schema.ts";
import { deleteChangeRecords } from "./change-service.ts";
import {
  activeRubricBlockers,
  blockingCriterionKeysInForce,
  criterionKeyFromBlockerId,
  deriveRubricBlockers,
  isRubricBlockerId,
  latestRubricVerdictsByKey,
  rubricBlockerId,
  rubricBlockerRetirement,
  RUBRIC_BLOCKER_RETIRED_BY_EDIT,
  RUBRIC_BLOCKER_RETIRED_BY_VERDICT,
} from "./rubric-gate-service.ts";
import {
  syncRubricBlockers,
  syncRubricFindings,
  syncRubricStageGateBlockers,
  syncSpecRubricGaps,
} from "./rubric-gate-adapters.ts";
import {
  recordRubricAssessments,
  saveRubricVersion,
  type RubricVersionRecord,
} from "./rubric-service.ts";
import { computeGapCounts } from "./spec-battle-rules.ts";
import { getStageAuthority, recomputeStageGate } from "./stage-authority-service.ts";

/**
 * Batch 5: rubric verdicts reaching the gates (docs/RUBRIC-DESIGN.md §4.3).
 *
 * The first four batches could only ever record. This is the batch that lets a
 * rubric stop a human, so most of what is asserted here is the way BACK OUT.
 *
 * Every channel this feeds refuses to let a human clear a P0 -- Spec throws
 * `human_cannot_resolve_gap`, a P0 finding is unwaivable four independent ways,
 * and `stage_gates` has no override column at all. So a derived blocker that
 * outlives its criterion is a permanent dead end, and the tests that matter
 * most are the ones proving it cannot.
 *
 * The `deriveRubricBlockers` direction is checked in BOTH directions on
 * purpose: an assertion that a `no` blocks is worthless on its own, because the
 * dangerous mutation is not "stops blocking", it is "blocks something that
 * should have been left alone" and "cannot be un-blocked".
 */

const PROJECT_ID = "PRJ-RUBRIC-GATE-001";
const CHANGE_ID = "CHG-RUBRIC-GATE-001";
const ROUND_1 = "BR-RUBRIC-GATE-1";
const ROUND_2 = "BR-RUBRIC-GATE-2";

const SPEC_PRODUCER = {
  projectId: PROJECT_ID,
  changeId: null as string | null,
  phase: "Spec" as const,
  role: "producer" as const,
};

function cleanupRows(): void {
  // Syncing a Spec gap resyncs the whole stage authority, which writes
  // stage_runs / stage_reports / stage_gates / stage_states. CHANGE_DELETE_PLAN
  // is the repo's own definition of "everything hanging off a change", so the
  // cleanup follows it rather than a hand-kept list that would rot the moment
  // the sync touches one more table.
  if (db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()) {
    deleteChangeRecords(CHANGE_ID);
  }
  const rubricIds = db
    .select({ id: rubrics.id })
    .from(rubrics)
    .where(like(rubrics.projectId, "PRJ-RUBRIC-GATE-%"))
    .all()
    .map((row) => row.id);
  for (const rubricId of rubricIds) {
    db.delete(rubricAssessments).where(eq(rubricAssessments.rubricId, rubricId)).run();
    db.delete(rubricCriteria).where(eq(rubricCriteria.rubricId, rubricId)).run();
  }
  db.delete(rubrics).where(like(rubrics.projectId, "PRJ-RUBRIC-GATE-%")).run();
  db.delete(changes).where(like(changes.id, "CHG-RUBRIC-GATE-%")).run();
  db.delete(projects).where(like(projects.id, "PRJ-RUBRIC-GATE-%")).run();
}

function seed(): void {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Rubric gate",
      repoPath: `/tmp/rubric-gate-${Date.now()}`,
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
      title: "Rubric gate change",
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

function addRound(id: string, roundNo: number): void {
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

/**
 * Verdicts are always written through the real parser, never hand-assembled.
 * A test that inserted `rubric_assessments` rows directly could pin behaviour
 * the production path can never actually produce.
 */
function judge(
  rubric: RubricVersionRecord,
  verdicts: Array<"yes" | "no" | undefined>,
  opts: { runId: string; roundId: string | null },
): void {
  const lines = rubric.criteria
    .map((criterion, index) =>
      verdicts[index] === undefined
        ? null
        : `RUBRIC: ${criterion.id} | ${verdicts[index]} | 第 ${index + 1} 节的实际措辞`,
    )
    .filter((line): line is string => line !== null);
  const recorded = recordRubricAssessments({
    changeId: CHANGE_ID,
    runId: opts.runId,
    roundId: opts.roundId,
    rubric,
    rawText: `一些正文。\n${lines.join("\n")}\n`,
  });
  assert.equal(recorded.ok, true, "fixture judgment must parse");
}

function saveSpecProducer(
  criteria: Array<{ text: string; blocking?: boolean; criterionKey?: string | null }>,
): RubricVersionRecord {
  return saveRubricVersion({ ...SPEC_PRODUCER, criteria });
}

function specScope(roundId: string | null) {
  return { projectId: PROJECT_ID, changeId: CHANGE_ID, phase: "Spec" as const, roundId };
}

function rubricGaps() {
  return db
    .select()
    .from(requirementGaps)
    .where(eq(requirementGaps.changeId, CHANGE_ID))
    .all()
    .filter((row) => isRubricBlockerId(row.canonicalGapId));
}

function specGateSourceDbHash(): string {
  return getStageAuthority(CHANGE_ID, "Spec").latestGate?.sourceDbHash ?? "missing";
}

beforeEach(() => {
  cleanupRows();
  seed();
  addRound(ROUND_1, 1);
});

afterEach(cleanupRows);

// --- §4.3: what blocks, and just as importantly what does not ---------------

describe("§4.3 which verdicts block", () => {
  it("a blocking criterion answered `no` blocks", () => {
    const rubric = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(rubric, ["no"], { runId: "RUN-1", roundId: ROUND_1 });

    const blockers = deriveRubricBlockers(specScope(ROUND_1));
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]!.criterionKey, rubric.criteria[0]!.criterionKey);
    assert.equal(blockers[0]!.verdict, "no");
  });

  it("an unanswered criterion blocks, whatever its blocking flag says", () => {
    // Both directions in one case: `not_assessed` is the ONLY verdict that
    // ignores `blocking: false`, because silence is not a judgment about
    // content -- it is a model skipping a question it expects to fail.
    const rubric = saveSpecProducer([
      { text: "非阻断标准", blocking: false },
      { text: "阻断标准", blocking: true },
    ]);
    judge(rubric, [undefined, undefined], { runId: "RUN-1", roundId: ROUND_1 });

    const blockers = deriveRubricBlockers(specScope(ROUND_1));
    assert.deepEqual(
      blockers.map((entry) => entry.verdict).sort(),
      ["not_assessed", "not_assessed"],
    );
  });

  it("a NON-blocking criterion answered `no` does not block", () => {
    const rubric = saveSpecProducer([{ text: "建议性标准", blocking: false }]);
    judge(rubric, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    assert.deepEqual(deriveRubricBlockers(specScope(ROUND_1)), []);
  });

  it("`yes` does not block", () => {
    const rubric = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(rubric, ["yes"], { runId: "RUN-1", roundId: ROUND_1 });
    assert.deepEqual(deriveRubricBlockers(specScope(ROUND_1)), []);
  });

  it("no rubric at all derives nothing -- an absent rubric means this phase does no judging", () => {
    assert.deepEqual(deriveRubricBlockers(specScope(ROUND_1)), []);
    assert.deepEqual(syncSpecRubricGaps(CHANGE_ID).opened, []);
  });
});

// --- §5.2: by round, never by run ------------------------------------------

describe("§5.2 verdicts are selected by round, never by run", () => {
  it("still sees the producer's blocking verdict after blue resumes under a new run id", () => {
    // resumeBlue opens a NEW run for a round whose red half already answered
    // and does not re-run red. Reading by run id would find no producer rows,
    // read that as "no rubric", and pass the stage on a judgment nobody made.
    const rubric = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(rubric, ["no"], { runId: "RUN-RED", roundId: ROUND_1 });

    const critic = saveRubricVersion({
      ...SPEC_PRODUCER,
      role: "critic",
      criteria: [{ text: "反方标准", blocking: true }],
    });
    judge(critic, ["yes"], { runId: "RUN-BLUE-RESUMED", roundId: ROUND_1 });

    const blockers = deriveRubricBlockers(specScope(ROUND_1));
    assert.equal(blockers.length, 1, "red's `no` must survive blue resuming under a second run");
    assert.equal(blockers[0]!.criterionKey, rubric.criteria[0]!.criterionKey);
  });

  it("a later round's verdicts, not an earlier round's, decide what blocks now", () => {
    const rubric = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(rubric, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    addRound(ROUND_2, 2);
    judge(rubric, ["yes"], { runId: "RUN-2", roundId: ROUND_2 });

    assert.equal(deriveRubricBlockers(specScope(ROUND_1)).length, 1);
    assert.deepEqual(deriveRubricBlockers(specScope(ROUND_2)), []);
  });
});

// --- §5.1: identity is the criterion key, and the text is a snapshot --------

describe("§5.1 derived blockers are keyed on criterionKey, not on the version row", () => {
  it("survives a reword: the criterion keeps its key, so the gap is still reachable", () => {
    const v1 = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);
    const gapBefore = rubricGaps();
    assert.equal(gapBefore.length, 1);
    const key = v1.criteria[0]!.criterionKey;
    assert.equal(gapBefore[0]!.canonicalGapId, rubricBlockerId(key));

    // The editor round-trips the key, which is what makes a typo fix safe.
    const v2 = saveSpecProducer([
      { text: "验收条件必须可判定", blocking: true, criterionKey: key },
    ]);
    assert.notEqual(v2.criteria[0]!.id, v1.criteria[0]!.id, "a new version mints a new row id");
    assert.equal(v2.criteria[0]!.criterionKey, key, "but the identity is the same");

    // The gap is still found by the new version -- not orphaned.
    assert.equal(blockingCriterionKeysInForce(specScope(null)).has(key), true);
    const gapAfter = rubricGaps();
    assert.equal(gapAfter.length, 1, "a reword must not create a second gap");
    assert.equal(gapAfter[0]!.id, gapBefore[0]!.id);
  });

  it("a reword leaves the gap row byte-identical, so neither Spec hash moves", () => {
    // §5.1: the criterion text is snapshotted into the gap and NEVER re-derived.
    // `requirement_gaps` is hashed verbatim by BOTH spec hash definitions
    // (specSourceDbHash and reportSourceDbHash, §11.3), so re-deriving the
    // wording would stale every stamped Spec gate and every war report at once
    // on a typo fix.
    const v1 = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);
    const before = rubricGaps()[0]!;
    const hashBefore = specGateSourceDbHash();

    saveSpecProducer([
      { text: "验收条件必须可判定（措辞修订）", blocking: true, criterionKey: v1.criteria[0]!.criterionKey },
    ]);
    syncSpecRubricGaps(CHANGE_ID);

    const after = rubricGaps()[0]!;
    assert.deepEqual(after, before, "an open derived gap is written once and never rewritten");
    assert.equal(specGateSourceDbHash(), hashBefore, "so the Spec source hash cannot move");
  });

  it("a criterion the caller sends with an unknown key gets a NEW identity, not the open gap's", () => {
    // Honouring a foreign key would let one request bind a brand-new criterion
    // to an existing open gap. The safe direction is always a fresh identity.
    const v1 = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);

    const v2 = saveSpecProducer([
      { text: "完全不同的新标准", blocking: true, criterionKey: "RBK-not-from-this-scope" },
    ]);
    assert.notEqual(v2.criteria[0]!.criterionKey, v1.criteria[0]!.criterionKey);
  });

  it("the snapshotted text comes from the version that was judged, not from today's", () => {
    const v1 = saveSpecProducer([{ text: "原始措辞", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    saveSpecProducer([
      { text: "新措辞", blocking: true, criterionKey: v1.criteria[0]!.criterionKey },
    ]);

    const verdicts = latestRubricVerdictsByKey(specScope(ROUND_1));
    assert.equal(verdicts.get(v1.criteria[0]!.criterionKey)!.text, "原始措辞");
  });
});

// --- the exit ---------------------------------------------------------------

describe("the human exit: withdrawing the criterion retires what it derived", () => {
  it("unticking `blocking` retires the gap and unblocks the Spec gate", () => {
    const v1 = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);

    const opened = rubricGaps()[0]!;
    assert.equal(opened.status, "open");
    assert.equal(opened.severity, "P0");
    assert.equal(opened.specBlocking, 1);
    assert.equal(
      computeGapCounts(rubricGaps().map((row) => ({
        id: row.id,
        severity: row.severity as "P0",
        originalSeverity: row.originalSeverity as "P0",
        downgradedTo: null,
        status: row.status as "open",
      }))).blockingP0,
      1,
      "the gate counts it as a P0 -- this is what actually stops the human",
    );

    // THE EXIT: the user withdraws the standard rather than claiming it is met.
    saveSpecProducer([
      { text: "验收条件可判定", blocking: false, criterionKey: v1.criteria[0]!.criterionKey },
    ]);
    const result = syncSpecRubricGaps(CHANGE_ID);

    assert.deepEqual(result.retired, [v1.criteria[0]!.criterionKey]);
    const retired = rubricGaps()[0]!;
    assert.equal(retired.status, "resolved");
    assert.equal(retired.specBlocking, 0);
    assert.equal(retired.mergeBlocking, 0, "and it must not just move the dead end to Merge");
    assert.equal(retired.resolutionEvidence, RUBRIC_BLOCKER_RETIRED_BY_EDIT);
    assert.equal(
      retired.resolvedByRoundId,
      null,
      "no round resolved it; that null is how this differs from a gap blue reviewed",
    );
  });

  it("deleting the criterion retires the gap too", () => {
    const v1 = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);
    assert.equal(rubricGaps()[0]!.status, "open");

    saveSpecProducer([]);
    syncSpecRubricGaps(CHANGE_ID);
    assert.equal(rubricGaps()[0]!.status, "resolved");
  });

  it("a later round answering `yes` retires the gap without any human action", () => {
    const v1 = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);
    assert.equal(rubricGaps()[0]!.status, "open");

    addRound(ROUND_2, 2);
    judge(v1, ["yes"], { runId: "RUN-2", roundId: ROUND_2 });
    syncSpecRubricGaps(CHANGE_ID);

    const retired = rubricGaps()[0]!;
    assert.equal(retired.status, "resolved");
    assert.equal(retired.resolutionEvidence, RUBRIC_BLOCKER_RETIRED_BY_VERDICT);
  });

  it("ABSENCE never retires: a round that produced no verdict leaves the gap open", () => {
    // The fail-open this whole mechanism exists to prevent. A round that died
    // before its rubric ran has no rows for the criterion, and "no rows" must
    // not read as "cleared".
    const v1 = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);
    assert.equal(rubricGaps()[0]!.status, "open");

    addRound(ROUND_2, 2); // no verdicts recorded for this round at all
    syncSpecRubricGaps(CHANGE_ID);

    assert.equal(rubricGaps()[0]!.status, "open", "silence is not a retirement reason");
  });

  it("a still-blocking criterion is not retired just because the rubric was saved again", () => {
    const v1 = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);

    saveSpecProducer([
      { text: "验收条件可判定", blocking: true, criterionKey: v1.criteria[0]!.criterionKey },
      { text: "另一条新标准", blocking: true },
    ]);
    const result = syncSpecRubricGaps(CHANGE_ID);

    assert.deepEqual(result.retired, []);
    assert.equal(rubricGaps()[0]!.status, "open");
  });

  it("adding a blocking criterion cannot open a gap retroactively", () => {
    // Reconciliation may only ever CLOSE. Opening reads verdicts judged against
    // the criterion as it then stood, and a criterion nobody has judged has no
    // verdict at all -- so a rubric edit can never newly block a change whose
    // gate is already stamped (§4.4).
    const v1 = saveSpecProducer([{ text: "已通过的标准", blocking: true }]);
    judge(v1, ["yes"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);
    assert.deepEqual(rubricGaps(), []);

    saveSpecProducer([
      { text: "已通过的标准", blocking: true, criterionKey: v1.criteria[0]!.criterionKey },
      { text: "刚刚加上的新标准", blocking: true },
    ]);
    const result = syncSpecRubricGaps(CHANGE_ID);

    assert.deepEqual(result.opened, []);
    assert.deepEqual(rubricGaps(), []);
  });

  it("flipping a judged non-blocking `no` to blocking does not block retroactively either", () => {
    const v1 = saveSpecProducer([{ text: "当时是建议性的", blocking: false }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);
    assert.deepEqual(rubricGaps(), []);

    saveSpecProducer([
      { text: "当时是建议性的", blocking: true, criterionKey: v1.criteria[0]!.criterionKey },
    ]);
    // The verdict on file was made against a criterion that did not block, and
    // the snapshot is what counts -- re-judging is the round's job, not an
    // edit's.
    assert.deepEqual(syncSpecRubricGaps(CHANGE_ID).opened, []);
  });

  it("a retired gap reopens when a later round blocks on the same criterion again", () => {
    const v1 = saveSpecProducer([{ text: "验收条件可判定", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    syncSpecRubricGaps(CHANGE_ID);
    addRound(ROUND_2, 2);
    judge(v1, ["yes"], { runId: "RUN-2", roundId: ROUND_2 });
    syncSpecRubricGaps(CHANGE_ID);
    assert.equal(rubricGaps()[0]!.status, "resolved");

    const ROUND_3 = "BR-RUBRIC-GATE-3";
    addRound(ROUND_3, 3);
    judge(v1, ["no"], { runId: "RUN-3", roundId: ROUND_3 });
    const result = syncSpecRubricGaps(CHANGE_ID);

    assert.deepEqual(result.reopened, [v1.criteria[0]!.criterionKey]);
    assert.equal(rubricGaps().length, 1, "the same row reopens; identity is the criterion key");
    assert.equal(rubricGaps()[0]!.status, "open");
    assert.equal(rubricGaps()[0]!.specBlocking, 1);
  });
});

describe("rubricBlockerRetirement", () => {
  const key = "RBK-x";
  const judged = new Map([
    [key, {
      criterionKey: key,
      role: "producer" as const,
      rubricId: "RUB-1",
      text: "t",
      blocking: true,
      verdict: "no" as const,
      evidence: null,
    }],
  ]);

  it("retires when the standard is no longer in force", () => {
    assert.deepEqual(
      rubricBlockerRetirement({ criterionKey: key, keysInForce: new Set(), verdicts: judged }),
      { retired: true, reason: RUBRIC_BLOCKER_RETIRED_BY_EDIT },
    );
  });

  it("does not retire on a `no` that is still in force", () => {
    assert.deepEqual(
      rubricBlockerRetirement({ criterionKey: key, keysInForce: new Set([key]), verdicts: judged }),
      { retired: false },
    );
  });

  it("does not retire when the criterion is simply missing from the batch", () => {
    assert.deepEqual(
      rubricBlockerRetirement({
        criterionKey: key,
        keysInForce: new Set([key]),
        verdicts: new Map(),
      }),
      { retired: false },
    );
  });
});

describe("blocker ids carry the criterion key", () => {
  it("round-trips", () => {
    assert.equal(criterionKeyFromBlockerId(rubricBlockerId("RBK-abc")), "RBK-abc");
  });

  it("does not claim ordinary ids", () => {
    assert.equal(criterionKeyFromBlockerId("GAP-123"), null);
    assert.equal(criterionKeyFromBlockerId("RUBRIC:"), null);
    assert.equal(criterionKeyFromBlockerId(null), null);
    assert.equal(isRubricBlockerId("FND-001"), false);
  });
});

describe("activeRubricBlockers refuses to derive from a withdrawn standard", () => {
  it("drops a verdict whose criterion is no longer blocking", () => {
    const v1 = saveSpecProducer([{ text: "标准", blocking: true }]);
    judge(v1, ["no"], { runId: "RUN-1", roundId: ROUND_1 });
    assert.equal(activeRubricBlockers(specScope(ROUND_1)).length, 1);

    saveSpecProducer([{ text: "标准", blocking: false, criterionKey: v1.criteria[0]!.criterionKey }]);
    assert.deepEqual(activeRubricBlockers(specScope(ROUND_1)), []);
    // derive still reports it: the model really did answer `no`. The two
    // functions differ exactly where the user withdrew the standard, which is
    // what makes opening and retiring agree.
    assert.equal(deriveRubricBlockers(specScope(ROUND_1)).length, 1);
  });
});

// --- Build / Fix: findings --------------------------------------------------

describe("Build/Fix channel: review findings", () => {
  function buildProducer(
    criteria: Array<{ text: string; blocking?: boolean; criterionKey?: string | null }>,
  ): RubricVersionRecord {
    return saveRubricVersion({ ...SPEC_PRODUCER, phase: "Build", criteria });
  }

  function rubricFindings() {
    return db
      .select()
      .from(findings)
      .where(eq(findings.changeId, CHANGE_ID))
      .all()
      .filter((row) => isRubricBlockerId(row.id));
  }

  it("a blocking `no` becomes an open P0 finding", () => {
    const rubric = buildProducer([{ text: "实现覆盖了计划里的每个文件", blocking: true }]);
    judge(rubric, ["no"], { runId: "RUN-BUILD", roundId: null });

    const result = syncRubricFindings(CHANGE_ID, "Build");
    assert.deepEqual(result.opened, [rubric.criteria[0]!.criterionKey]);

    const row = rubricFindings()[0]!;
    assert.equal(row.severity, "P0");
    assert.equal(row.status, "open");
    assert.equal(row.source, "rubric");
    assert.equal(
      row.waivable,
      0,
      "chk_findings_waivable_scope forbids a waivable non-review P0, and so do we",
    );
    assert.equal(criterionKeyFromBlockerId(row.id), rubric.criteria[0]!.criterionKey);
  });

  it("withdrawing the criterion waives it; a later `yes` marks it fixed", () => {
    const rubric = buildProducer([{ text: "实现覆盖了计划里的每个文件", blocking: true }]);
    judge(rubric, ["no"], { runId: "RUN-BUILD", roundId: null });
    syncRubricFindings(CHANGE_ID, "Build");

    saveRubricVersion({
      ...SPEC_PRODUCER,
      phase: "Build",
      criteria: [
        { text: "实现覆盖了计划里的每个文件", blocking: false, criterionKey: rubric.criteria[0]!.criterionKey },
      ],
    });
    syncRubricFindings(CHANGE_ID, "Build");
    const waived = rubricFindings()[0]!;
    assert.equal(waived.status, "waived");
    assert.equal(waived.waivedBy, "rubric_criterion_withdrawn");

    // Restore the standard, answer it, and the finding tells the other story.
    const restored = saveRubricVersion({
      ...SPEC_PRODUCER,
      phase: "Build",
      criteria: [
        { text: "实现覆盖了计划里的每个文件", blocking: true, criterionKey: rubric.criteria[0]!.criterionKey },
      ],
    });
    judge(restored, ["no"], { runId: "RUN-BUILD-2", roundId: null });
    syncRubricFindings(CHANGE_ID, "Build");
    assert.equal(rubricFindings()[0]!.status, "open");

    judge(restored, ["yes"], { runId: "RUN-BUILD-3", roundId: null });
    syncRubricFindings(CHANGE_ID, "Build");
    assert.equal(rubricFindings()[0]!.status, "fixed");
  });

  it("does not claim `review` provenance, so no review attempt is forced to recheck it", () => {
    // `openBlockingReviewFindingIds` freezes `source === "review"` rows into the
    // next attempt's obligation set. A rubric row claiming `review` would make
    // a model answer `PRIOR: <id> | fixed` about a criterion it was never
    // shown -- and that verdict would silently close a rubric judgment.
    const rubric = buildProducer([{ text: "标准", blocking: true }]);
    judge(rubric, ["no"], { runId: "RUN-BUILD", roundId: null });
    syncRubricFindings(CHANGE_ID, "Build");
    assert.notEqual(rubricFindings()[0]!.source, "review");
  });
});

// --- document phases: stage gate blockers -----------------------------------

describe("document phase channel: stage gate blockers", () => {
  function techSpecRubric(
    criteria: Array<{ text: string; blocking?: boolean; criterionKey?: string | null }>,
  ): RubricVersionRecord {
    return saveRubricVersion({ ...SPEC_PRODUCER, phase: "TechSpec", criteria });
  }

  function seedPassingTechSpecGate(): void {
    recomputeStageGate({
      changeId: CHANGE_ID,
      phase: "TechSpec",
      status: "passed",
      blockers: [],
      freshness: { fresh: true },
      requiredActions: [],
      sourceDbHash: "TECHSPEC-SOURCE-HASH",
    });
  }

  it("blocks the gate, and restores the phase's own status when the criterion is withdrawn", () => {
    seedPassingTechSpecGate();
    const rubric = techSpecRubric([{ text: "接口契约完整", blocking: true }]);
    judge(rubric, ["no"], { runId: "RUN-TS", roundId: null });

    const applied = syncRubricStageGateBlockers(CHANGE_ID, "TechSpec");
    assert.equal(applied.applied, true);
    let gate = getStageAuthority(CHANGE_ID, "TechSpec").latestGate!;
    assert.equal(gate.status, "blocked");
    assert.equal(
      gate.sourceDbHash,
      "TECHSPEC-SOURCE-HASH",
      "the rubric is not a source row for any phase, so sourceDbHash must not move (§4.4)",
    );

    saveRubricVersion({
      ...SPEC_PRODUCER,
      phase: "TechSpec",
      criteria: [{ text: "接口契约完整", blocking: false, criterionKey: rubric.criteria[0]!.criterionKey }],
    });
    syncRubricStageGateBlockers(CHANGE_ID, "TechSpec");
    gate = getStageAuthority(CHANGE_ID, "TechSpec").latestGate!;
    assert.equal(gate.status, "passed", "the status the phase's own inputs implied is restored");
    assert.deepEqual(JSON.parse(gate.blockersJson ?? "[]"), []);
  });

  it("never appends a gate row that says the same thing", () => {
    seedPassingTechSpecGate();
    const rubric = techSpecRubric([{ text: "接口契约完整", blocking: true }]);
    judge(rubric, ["no"], { runId: "RUN-TS", roundId: null });
    syncRubricStageGateBlockers(CHANGE_ID, "TechSpec");
    const version = getStageAuthority(CHANGE_ID, "TechSpec").latestGate!.gateVersion;

    const second = syncRubricStageGateBlockers(CHANGE_ID, "TechSpec");
    assert.deepEqual(second, { applied: false, reason: "unchanged" });
    assert.equal(
      getStageAuthority(CHANGE_ID, "TechSpec").latestGate!.gateVersion,
      version,
      "a bumped gate_version is what preflight rejects as gate_version_drift",
    );
  });

  it("keeps the phase's own blockers alongside the rubric's", () => {
    recomputeStageGate({
      changeId: CHANGE_ID,
      phase: "Plan",
      status: "blocked",
      blockers: [{ id: "risk-1", severity: "P1", title: "计划风险" }],
      freshness: { fresh: true },
      requiredActions: ["regenerate_plan_report"],
      sourceDbHash: "PLAN-SOURCE-HASH",
    });
    const rubric = saveRubricVersion({
      ...SPEC_PRODUCER,
      phase: "Plan",
      criteria: [{ text: "步骤可执行", blocking: true }],
    });
    judge(rubric, ["no"], { runId: "RUN-PLAN", roundId: null });
    syncRubricStageGateBlockers(CHANGE_ID, "Plan");

    const gate = getStageAuthority(CHANGE_ID, "Plan").latestGate!;
    const ids = (JSON.parse(gate.blockersJson ?? "[]") as Array<{ id: string }>).map((b) => b.id);
    assert.deepEqual(ids.sort(), ["risk-1", rubricBlockerId(rubric.criteria[0]!.criterionKey)].sort());
    assert.deepEqual(JSON.parse(gate.requiredActionsJson ?? "[]"), ["regenerate_plan_report"]);

    // Retiring the rubric blocker must leave the phase's own blocker and its
    // own `blocked` status exactly where they were.
    saveRubricVersion({
      ...SPEC_PRODUCER,
      phase: "Plan",
      criteria: [{ text: "步骤可执行", blocking: false, criterionKey: rubric.criteria[0]!.criterionKey }],
    });
    syncRubricStageGateBlockers(CHANGE_ID, "Plan");
    const after = getStageAuthority(CHANGE_ID, "Plan").latestGate!;
    assert.equal(after.status, "blocked");
    assert.deepEqual(
      (JSON.parse(after.blockersJson ?? "[]") as Array<{ id: string }>).map((b) => b.id),
      ["risk-1"],
    );
  });

  it("refuses phases that own no stage gate rather than guessing a neighbour", () => {
    assert.deepEqual(syncRubricStageGateBlockers(CHANGE_ID, "Refine"), {
      applied: false,
      reason: "unsupported_phase",
    });
    assert.equal(syncRubricBlockers(CHANGE_ID, "Retro").channel, "none");
  });

  it("does nothing when the phase has never computed a gate", () => {
    const rubric = techSpecRubric([{ text: "接口契约完整", blocking: true }]);
    judge(rubric, ["no"], { runId: "RUN-TS", roundId: null });
    assert.deepEqual(syncRubricStageGateBlockers(CHANGE_ID, "TechSpec"), {
      applied: false,
      reason: "no_gate",
    });
  });
});

describe("syncRubricBlockers routes each phase to its own channel (§4.3)", () => {
  it("Spec -> requirement gap, Build/Fix -> finding, document phases -> stage gate", () => {
    assert.equal(syncRubricBlockers(CHANGE_ID, "Spec").channel, "requirement_gap");
    assert.equal(syncRubricBlockers(CHANGE_ID, "Build").channel, "finding");
    assert.equal(syncRubricBlockers(CHANGE_ID, "Fix").channel, "finding");
    assert.equal(syncRubricBlockers(CHANGE_ID, "TechSpec").channel, "stage_gate");
    assert.equal(syncRubricBlockers(CHANGE_ID, "PRD").channel, "stage_gate");
  });
});
