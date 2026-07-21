import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  battleRounds,
  briefingQuestions,
  changes,
  events,
  pipelineJobs,
  prdBriefings,
  prdDrafts,
  projects,
  redFixClaims,
  requirementGaps,
  rubricAssessments,
  rubricCriteria,
  rubrics,
  runs,
} from "../db/schema.ts";
import type { JobExecutionContext } from "./job-execution-context.ts";
import { StaleLeaseFenceError } from "./job-execution-context.ts";
import { withExecutionFence } from "./execution-fence-service.ts";
import { setPipelineEngineFactoryForTest } from "./pipeline-engine-service.ts";
import { runSpec } from "./pipeline-spec-stage-service.ts";
import { applySpecBattleDecision } from "./spec-battle-service.ts";
import { getSpecReportFreshness } from "./spec-battle-report-service.ts";
import { computeSourceDbHash, getStageAuthority, recomputeStageGate } from "./stage-authority-service.ts";
import {
  listRubricAssessments,
  recordRubricAssessments,
  saveRubricVersion,
  type RubricVersionRecord,
} from "./rubric-service.ts";
import { isRubricBlockerId, rubricBlockerId } from "./rubric-gate-service.ts";
import { deleteChangeRecords } from "./change-service.ts";

/**
 * Batch 3: the Spec battle's three rubrics (docs/RUBRIC-DESIGN.md §8.3).
 *
 * This drives the real runSpec() with a stubbed provider, so what is asserted is
 * the wiring -- which rubric each side is given, that its verdicts land against
 * the right run and round, and that a rubric can neither leak into the stage's
 * own documents nor into any stamped hash.
 */

const PROJECT_ID = "PRJ-RUBRIC-SPEC";
const CHANGE_ID = "CHG-RUBRIC-SPEC";

const RED_FIX_CLAIM_GAP = "gap-rubric-fixture";

let repoPath = "";
let jobSequence = 0;

// --- fixtures -------------------------------------------------------------

function cleanupRows(): void {
  // CHANGE_DELETE_PLAN covers the whole change graph, rubric rows included.
  deleteChangeRecords(CHANGE_ID);
  const rubricIds = db.select({ id: rubrics.id }).from(rubrics)
    .where(eq(rubrics.projectId, PROJECT_ID)).all().map((row) => row.id);
  for (const rubricId of rubricIds) {
    db.delete(rubricAssessments).where(eq(rubricAssessments.rubricId, rubricId)).run();
    db.delete(rubricCriteria).where(eq(rubricCriteria.rubricId, rubricId)).run();
  }
  db.delete(rubrics).where(eq(rubrics.projectId, PROJECT_ID)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(like(projects.id, `${PROJECT_ID}%`)).run();
}

function seedLockedPrdAuthority(): void {
  const now = new Date().toISOString();
  const briefing = {
    id: "PBR-RUBRIC-SPEC",
    changeId: CHANGE_ID,
    status: "locked",
    intentText: "Rubric fixture locked PRD.",
    finalReviewJson: JSON.stringify({
      verdict: "ready",
      blockingQuestionIds: [],
      riskSummary: "No fixture blockers.",
      recommendedNextAction: "lock_prd",
    }),
    sourceHashesJson: JSON.stringify({
      currentInputHash: "rubric-fixture-input",
      draftInputHash: "rubric-fixture-input",
      finalReviewInputHash: "rubric-fixture-input",
      finalReviewDraftHash: "rubric-fixture-draft",
    }),
    lockedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const question = {
    id: "BQ-RUBRIC-SPEC",
    changeId: CHANGE_ID,
    category: "scope",
    severity: "important",
    question: "Who owns rollout?",
    whyItMatters: "Ownership affects acceptance.",
    suggestedDefault: "Project owner.",
    status: "deferred",
    answer: "Handled by fixture.",
    source: "ai_blue",
    createdAt: now,
    updatedAt: now,
  };
  const draft = {
    id: "PDR-RUBRIC-SPEC",
    changeId: CHANGE_ID,
    version: 1,
    markdown: "# DB PRD Draft\n\nRubric fixture PRD.\n",
    sourceQuestionIdsJson: JSON.stringify([question.id]),
    unresolvedQuestionIdsJson: JSON.stringify([question.id]),
    draftHash: "rubric-fixture-draft",
    createdAt: now,
  };
  db.insert(prdBriefings).values(briefing).run();
  db.insert(briefingQuestions).values(question).run();
  db.insert(prdDrafts).values(draft).run();
  recomputeStageGate({
    changeId: CHANGE_ID,
    phase: "PRD",
    status: "pass",
    blockers: [],
    freshness: { source: "db", lockedAt: now },
    requiredActions: [],
    sourceDbHash: computeSourceDbHash({
      changeId: CHANGE_ID,
      phase: "PRD",
      rows: [
        { table: "prd_briefings", row: briefing },
        { table: "briefing_questions", rows: [question] },
        { table: "prd_drafts.latest", row: draft },
      ],
    }),
  });
  fs.mkdirSync(path.join(repoPath, ".ship", "changes", CHANGE_ID), { recursive: true });
}

function seedChange(): void {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Rubric Spec Battle",
    repoPath,
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
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Rubric spec battle",
    status: "INTAKE_READY",
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
  }).run();
  seedLockedPrdAuthority();
}

function makeJobContext(label: string): JobExecutionContext {
  jobSequence += 1;
  const key = `${label}-${jobSequence}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const context: JobExecutionContext = {
    jobId: `PJOB-RUBRIC-${key}`,
    workerId: `worker-${key}`,
    leaseToken: `lease-${key}`,
    attemptNo: 1,
  };
  db.update(pipelineJobs).set({ status: "succeeded", endedAt: new Date().toISOString() })
    .where(and(
      eq(pipelineJobs.changeId, CHANGE_ID),
      inArray(pipelineJobs.status, ["queued", "leased", "running"]),
    )).run();
  db.insert(pipelineJobs).values({
    id: context.jobId,
    changeId: CHANGE_ID,
    phase: "spec",
    actionId: "run_spec",
    idempotencyKey: context.jobId,
    status: "running",
    leasedBy: context.workerId,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    heartbeatAt: "2026-07-20T10:00:00.000Z",
    attemptNo: context.attemptNo,
    errorCode: null,
    errorSummary: null,
    createdAt: "2026-07-20T09:59:00.000Z",
    startedAt: "2026-07-20T10:00:00.000Z",
    endedAt: null,
    leaseToken: context.leaseToken,
    workerNonce: `nonce-${key}`,
  }).run();
  return context;
}

// --- rubric fixtures ------------------------------------------------------

function saveSpecRubric(
  role: "producer" | "critic" | "verdict",
  criteria: Array<{ text: string; blocking?: boolean }>,
): RubricVersionRecord {
  return saveRubricVersion({
    projectId: PROJECT_ID,
    changeId: null,
    phase: "Spec",
    role,
    criteria,
  });
}

function rubricLines(
  rubric: RubricVersionRecord,
  verdicts: Array<"yes" | "no" | null>,
): string[] {
  return rubric.criteria.flatMap((criterion, index) => {
    const verdict = verdicts[index];
    return verdict === null || verdict === undefined
      ? []
      : [`RUBRIC: ${criterion.id} | ${verdict} | evidence for ${criterion.ordinal}`];
  });
}

// --- provider stub --------------------------------------------------------

/** The PRD delta body, byte-exact: it is what prd-delta.md and red.md must hold. */
const RED_DELTA_BODY = "# PRD delta\n\nRubric fixture delta body.\n";

/**
 * Red's reply in the line protocol (spec-red-line-protocol.ts): one PRD_DELTA
 * block carrying the whole document, then FIXCLAIM lines, then SPEC_DONE.
 *
 * Every call site appends the RUBRIC lines AFTER this, which is where spec.md
 * tells the model to put them -- outside every block, last. That placement is
 * load-bearing for the rubric, not cosmetic: scanProtocolLines skips block
 * bodies, so a RUBRIC line written INSIDE PRD_DELTA is neither harvested nor
 * stripped and rides into the document.
 */
const RED_LINES = [
  "PRD_DELTA<<",
  // Verbatim, trailing newline included: join("\n") turns that newline into the
  // blank line before the terminator, which the block reads back as the body's
  // own trailing newline. The delta round-trips byte-exact.
  RED_DELTA_BODY,
  ">>PRD_DELTA",
  `FIXCLAIM: ${RED_FIX_CLAIM_GAP} | fixed | Closed by the fixture. | See the delta body. | -`,
  "SPEC_DONE: true",
].join("\n");

const BLUE_LINES = [
  "GAP: gap-rubric-new | Export limit undefined | scope | P2 | delta says export with no cap | add a cap",
  "CRITIQUE_DONE: true",
].join("\n");

interface StubReplies {
  spec?: string | (() => string);
  spec_critic?: string;
  spec_verdict?: string | { fail: true };
}

function installEngine(replies: StubReplies): { prompts: Map<string, string> } {
  const prompts = new Map<string, string>();
  setPipelineEngineFactoryForTest(() => ({
    async run(input) {
      prompts.set(input.phase, input.prompt);
      const configured = replies[input.phase as keyof StubReplies];
      if (configured && typeof configured === "object" && "fail" in configured) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: `ENGINE-${input.phase}`,
          summary: "verdict provider exploded",
          success: false,
          providerErrorCode: "provider_run_failed",
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      }
      const summary = typeof configured === "function" ? configured() : configured ?? "";
      return {
        threadId: `${input.changeId}-thread`,
        runId: `ENGINE-${input.phase}`,
        summary,
        success: true,
        changedFiles: [],
        structuredOutput: undefined,
        items: [],
      };
    },
    async *runStreamed() {},
  }));
  return { prompts };
}

// --- helpers --------------------------------------------------------------

function currentRound() {
  return db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).all().at(-1);
}

function specRunId(): string {
  const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
    .find((candidate) => candidate.phase === "spec");
  assert.ok(run, "the Spec battle should have created a business run");
  return run.id;
}

function assessmentsFor(rubric: RubricVersionRecord) {
  return listRubricAssessments({ runId: specRunId(), rubricId: rubric.id });
}

function verdictByCriterion(rubric: RubricVersionRecord): Record<string, string> {
  const byId = new Map(rubric.criteria.map((criterion, index) => [criterion.id, `c${index + 1}`]));
  return Object.fromEntries(
    assessmentsFor(rubric).map((row) => [byId.get(row.criterionId) ?? row.criterionId, row.verdict]),
  );
}

beforeEach(() => {
  cleanupRows();
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-spec-battle-"));
  seedChange();
});

afterEach(() => {
  setPipelineEngineFactoryForTest(null);
  cleanupRows();
  if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  repoPath = "";
});

describe("Spec battle rubric wiring", () => {
  it("records the red producer rubric against this run and round", async () => {
    // Spec/producer saves force-merge the always-blocking tier-1 row on top
    // (rubric-tiers.ts §2.1, 关不掉), so this rubric is THREE criteria:
    // [tier-1, the two saved below]. Red answers the tier-1 row `yes` (c1) so
    // the user rows' verdicts stay the thing under test.
    const producer = saveSpecRubric("producer", [
      { text: "Every requirement has an acceptance criterion" },
      { text: "No requirement contradicts the PRD" },
    ]);
    assert.equal(producer.criteria.length, 3, "tier-1 row + the two saved above");
    const { prompts } = installEngine({
      spec: [RED_LINES, ...rubricLines(producer, ["yes", "yes", "no"])].join("\n"),
      spec_critic: BLUE_LINES,
    });

    await runSpec(CHANGE_ID, makeJobContext("spec-producer"));

    const stored = assessmentsFor(producer);
    assert.equal(stored.length, 3, "one row per criterion");
    assert.deepEqual(verdictByCriterion(producer), { c1: "yes", c2: "yes", c3: "no" });
    const round = currentRound();
    assert.ok(round);
    for (const row of stored) {
      assert.equal(row.roundId, round.id, "a verdict must be attributable to the round that produced it");
      assert.equal(row.runId, specRunId());
    }
    // The criteria must actually have reached the model, or the verdicts above
    // would be answers to a question nobody asked.
    const redPrompt = prompts.get("spec") ?? "";
    for (const criterion of producer.criteria) assert.match(redPrompt, new RegExp(criterion.id));
    assert.match(redPrompt, /RUBRIC: criterionId \| yes 或 no \| evidence/);
  });

  it("keeps red's RUBRIC lines out of the PRD delta and out of the round artifact", async () => {
    const producer = saveSpecRubric("producer", [{ text: "Acceptance criteria are testable" }]);
    installEngine({
      spec: [RED_LINES, ...rubricLines(producer, ["yes"])].join("\n"),
      spec_critic: BLUE_LINES,
    });

    await runSpec(CHANGE_ID, makeJobContext("spec-strip"));

    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    const prdDelta = fs.readFileSync(path.join(changeDir, "prd-delta.md"), "utf-8");
    const roundRed = fs.readFileSync(
      path.join(changeDir, "rounds", "spec-round-01-red.md"),
      "utf-8",
    );
    assert.doesNotMatch(prdDelta, /^RUBRIC:/m, "protocol lines are not document content");
    assert.doesNotMatch(roundRed, /^RUBRIC:/m);
    assert.doesNotMatch(roundRed, new RegExp(producer.criteria[0]!.id));

    // The three assertions above are no longer what does the work, and saying so
    // matters: under the line protocol both documents are the PRD_DELTA block's
    // CONTENT, so a RUBRIC line written where spec.md says to put it -- outside
    // every block -- cannot reach them whether or not stripRubricLines ran. They
    // would pass against a broken strip.
    //
    // So pin the property that actually keeps the rubric out: each document is
    // the block body and nothing else. That fails loudly if the artifact write
    // ever falls back to `result.summary` (markdownArtifactContentFromResult does
    // exactly that when structuredOutput.markdown is absent), which is the one
    // reachable way protocol text still gets into prd-delta.md.
    assert.equal(prdDelta, RED_DELTA_BODY, "the delta is the block body, byte for byte");
    assert.equal(roundRed, RED_DELTA_BODY);

    // Red's claims survive alongside a rubric. Under the JSON contract this was
    // the canary for a leaked line: JSON.parse threw on trailing text and
    // parseRedSpecOutput's bare catch degraded to "whole reply is the markdown,
    // zero claims". Red writes FIXCLAIM lines now, so what this pins today is the
    // rubric/host coupling one layer up -- the harvest runs FIRST and would void
    // the whole round (RubricOutputVoidError) if it rejected red's own PRD_DELTA
    // block, leaving zero claims and a failed round.
    const claims = db.select().from(redFixClaims).where(eq(redFixClaims.changeId, CHANGE_ID)).all();
    assert.equal(claims.length, 1, "the rubric harvest must not void red's own output");
    assert.equal(claims[0]!.canonicalGapId, RED_FIX_CLAIM_GAP);
  });

  it("records the blue critic rubric without disturbing the critique payload", async () => {
    const critic = saveSpecRubric("critic", [
      { text: "Every prior P0 gap was rechecked" },
      { text: "New gaps cite concrete evidence" },
    ]);
    // Spec/producer can no longer be rubric-free: an empty save still leaves
    // the always-blocking tier-1 row (rubric-tiers.ts §2.1), and without this
    // save runSpec would seed the factory producer rubric instead. Red answers
    // that one row `yes`, so the only derived gap below is the critic's --
    // which is what this case is about.
    const producer = saveSpecRubric("producer", []);
    const { prompts } = installEngine({
      spec: [RED_LINES, ...rubricLines(producer, ["yes"])].join("\n"),
      spec_critic: [BLUE_LINES, ...rubricLines(critic, ["no", "yes"])].join("\n"),
    });

    await runSpec(CHANGE_ID, makeJobContext("spec-critic"));

    assert.deepEqual(verdictByCriterion(critic), { c1: "no", c2: "yes" });
    const criticPrompt = prompts.get("spec_critic") ?? "";
    for (const criterion of critic.criteria) assert.match(criticPrompt, new RegExp(criterion.id));

    // Blue's own protocol must be unaffected: the gap it reported still lands.
    //
    // Batch 5 note: this used to assert the gap list was EXACTLY blue's own gap,
    // which pinned "a rubric verdict never reaches the gate". That was true of
    // batch 3 and is precisely what batch 5 changes -- the critic's `no` on a
    // blocking criterion now derives its own P0 gap (§4.3). What the assertion
    // was actually protecting is that blue's gap is not disturbed by the rubric
    // running alongside it, so that is what it now says, plus the derived gap it
    // should be seeing.
    const gaps = db.select().from(requirementGaps).where(eq(requirementGaps.changeId, CHANGE_ID)).all();
    assert.equal(
      gaps.filter((gap) => gap.canonicalGapId === "gap-rubric-new").length,
      1,
      "blue's own gap must still land untouched",
    );
    const derived = gaps.filter((gap) => isRubricBlockerId(gap.canonicalGapId));
    assert.deepEqual(
      derived.map((gap) => gap.canonicalGapId),
      [rubricBlockerId(critic.criteria[0]!.criterionKey)],
      "the critic's blocking `no` derives exactly one gap, keyed on the criterion",
    );
    assert.equal(derived[0]!.severity, "P0");
    assert.equal(derived[0]!.status, "open");
    assert.equal(currentRound()?.status, "report_ready");
  });

  it("runs the verdict rubric after both sides and stores its judgment", async () => {
    const verdict = saveSpecRubric("verdict", [
      { text: "Blue confirmed every fix red claimed" },
      { text: "No P0 gap is still open" },
    ]);
    const { prompts } = installEngine({
      spec: RED_LINES,
      spec_critic: BLUE_LINES,
      spec_verdict: rubricLines(verdict, ["yes", "no"]).join("\n"),
    });

    await runSpec(CHANGE_ID, makeJobContext("spec-verdict"));

    assert.ok(prompts.has("spec_verdict"), "the verdict agent must actually be asked");
    assert.deepEqual(verdictByCriterion(verdict), { c1: "yes", c2: "no" });
    const stored = assessmentsFor(verdict);
    assert.equal(stored[0]!.roundId, currentRound()?.id);

    // It judges the two sides' outputs, so it must be given them.
    const verdictPrompt = prompts.get("spec_verdict") ?? "";
    assert.match(verdictPrompt, /prd-delta\.md/);
    assert.match(verdictPrompt, /blue-gap-reviews\.json/);
  });

  it("records a verdict rubric that never ran as not_assessed, not as absent", async () => {
    // §9's "裁决 rubric 没跑却当成通过" case. Storing nothing is the dangerous
    // outcome: no rows is indistinguishable from "this phase has no rubric",
    // which reads as a pass.
    const verdict = saveSpecRubric("verdict", [
      { text: "Blue confirmed every fix red claimed" },
      { text: "No P0 gap is still open" },
    ]);
    installEngine({
      spec: RED_LINES,
      spec_critic: BLUE_LINES,
      spec_verdict: { fail: true },
    });

    await runSpec(CHANGE_ID, makeJobContext("spec-verdict-dead"));

    assert.deepEqual(verdictByCriterion(verdict), { c1: "not_assessed", c2: "not_assessed" });
    // A judging call that failed must not destroy a round that already committed.
    assert.equal(currentRound()?.status, "report_ready");
    assert.equal(
      db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status,
      "SPEC_READY",
    );
  });

  it("records an unanswered criterion as not_assessed rather than as a pass", async () => {
    // §9's "红方漏答被当成通过" case. c1 is the force-merged tier-1 row
    // (rubric-tiers.ts §2.1), answered `yes` so the silence under test stays
    // the user's own criterion (c3).
    const producer = saveSpecRubric("producer", [
      { text: "Answered criterion" },
      { text: "Criterion the model stays silent about" },
    ]);
    installEngine({
      spec: [RED_LINES, ...rubricLines(producer, ["yes", "yes", null])].join("\n"),
      spec_critic: BLUE_LINES,
    });

    await runSpec(CHANGE_ID, makeJobContext("spec-silent"));

    assert.deepEqual(verdictByCriterion(producer), { c1: "yes", c2: "yes", c3: "not_assessed" });
    assert.equal(
      assessmentsFor(producer).find((row) => row.verdict === "not_assessed")?.evidence,
      null,
    );
  });

  it("voids the round when red answers a rubric it was not given", async () => {
    const producer = saveSpecRubric("producer", [{ text: "Only criterion" }]);
    installEngine({
      spec: [RED_LINES, "RUBRIC: RBC-invented | yes | answered someone else's checklist"].join("\n"),
      spec_critic: BLUE_LINES,
    });

    await assert.rejects(runSpec(CHANGE_ID, makeJobContext("spec-void")));

    assert.deepEqual(
      listRubricAssessments({ runId: specRunId() }),
      [],
      "a half-stored rubric would look like a completed judgment",
    );
    assert.equal(currentRound()?.status, "failed");
    assert.equal(assessmentsFor(producer).length, 0);
  });

  it("an emptied rubric turns critic and verdict off; Spec producer keeps its tier-1 row", async () => {
    // CHANGED in batch 6 (the empty state has to be asked for), and AGAIN on
    // 2026-07-21. §4.5's "an empty rubric means this role does no rubric
    // judging" still holds for critic and verdict, but an empty save on
    // Spec/producer now deliberately leaves the always-blocking tier-1 row
    // behind (rubric-tiers.ts §2.1, 关不掉) -- there is no reachable state in
    // which red runs without a rubric anymore, so the old "no rubric at all"
    // premise cannot be staged. What this case pins now: the emptied critic
    // and verdict roles really are off (no prompt section, no verdict call, no
    // rows), while red's prompt carries exactly the tier-1 criterion and its
    // verdict is the only judgment recorded.
    const producer = saveSpecRubric("producer", []);
    assert.equal(producer.criteria.length, 1, "the empty save leaves the tier-1 row (关不掉)");
    saveSpecRubric("critic", []);
    saveSpecRubric("verdict", []);
    const { prompts } = installEngine({
      spec: [RED_LINES, ...rubricLines(producer, ["yes"])].join("\n"),
      spec_critic: BLUE_LINES,
    });

    await runSpec(CHANGE_ID, makeJobContext("spec-no-rubric"));

    assert.equal(currentRound()?.status, "report_ready");
    assert.deepEqual(
      listRubricAssessments({ runId: specRunId() }).map((row) => [row.criterionId, row.verdict]),
      [[producer.criteria[0]!.id, "yes"]],
      "the tier-1 judgment is the only rubric row this round leaves behind",
    );
    // Matched on the rubric section's own wire-format line rather than the bare
    // word: this fixture's change id contains "RUBRIC".
    const rubricSection = /RUBRIC: criterionId \| yes 或 no \| evidence/;
    assert.match(prompts.get("spec") ?? "", rubricSection);
    assert.doesNotMatch(prompts.get("spec_critic") ?? "", rubricSection);
    assert.equal(prompts.has("spec_verdict"), false, "no verdict rubric means no verdict call");
  });

  it("pins the rubric version each round was judged by", async () => {
    const producer = saveSpecRubric("producer", [{ text: "First wording" }]);
    installEngine({
      spec: [RED_LINES, ...rubricLines(producer, ["yes"])].join("\n"),
      spec_critic: BLUE_LINES,
    });

    await runSpec(CHANGE_ID, makeJobContext("spec-pin"));

    const pins = db.select().from(events)
      .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, "rubric_version_pinned")))
      .all()
      .map((row) => JSON.parse(row.rawJson ?? "{}").rubricVersionPin);
    const producerPin = pins.find((pin) => pin?.role === "producer");
    assert.ok(producerPin, "each round must record the rubric version it used");
    assert.equal(producerPin.rubricId, producer.id);
    assert.equal(producerPin.version, 1);
    assert.equal(producerPin.roundId, currentRound()?.id);
    assert.equal(producerPin.source, "project");
    // The verdict rows carry the same version independently, so the record
    // survives even if the event is lost.
    assert.equal(assessmentsFor(producer)[0]!.rubricId, producer.id);
  });
});

describe("rubric text stays out of stamped hashes", () => {
  it("keeps a stamped Spec gate valid across a rubric edit, under a real recompute", async () => {
    // §4.4, and the 204f3f5 regression it was written about: adding a column to
    // briefing_questions moved every stamped PRD gate hash and jammed Spec Battle.
    //
    // Reading the stored gate row back would prove nothing -- editing a rubric
    // writes no gate, so the row trivially stays put. What has to hold is that a
    // RECOMPUTE still lands on the stamped value. So this drives the idempotent
    // re-approve branch of applySpecBattleDecision, whose only effect is
    // syncSpecStageAuthority + generateSpecReport + refreshMirrors: the real
    // production recompute of both Spec hash definitions, over unchanged rows.
    // Batch 5 note: these two are `blocking: false`, which they did not need to
    // be when this test was written -- a `no` reached no gate then. It does now:
    // a blocking `no` derives a P0 requirement gap, so the approve below would
    // throw `gate_blocked` and this test would stop measuring the hash at all.
    // Keeping a real `no` on file, rather than flipping it to `yes`, preserves
    // the point of the leak assertions at the end AND additionally pins §4.3's
    // rule that a non-blocking `no` is recorded without blocking, end to end.
    // (An OPEN derived gap's own hash stability across an edit is covered
    // separately in rubric-gate-service.test.ts.)
    //
    // 2026-07-21: the producer rubric's first row is now the force-merged,
    // always-blocking tier-1 criterion (rubric-tiers.ts §2.1). Red answers it
    // `yes` -- a `no` there would derive a real P0 gap and turn the approve
    // below into `gate_blocked`, and this test would stop measuring the hash.
    // The deliberate non-blocking `no` stays on the user's own criterion.
    const producer = saveSpecRubric("producer", [{ text: "Original wording", blocking: false }]);
    const verdict = saveSpecRubric("verdict", [
      { text: "Original verdict wording", blocking: false },
    ]);
    installEngine({
      spec: [RED_LINES, ...rubricLines(producer, ["yes", "no"])].join("\n"),
      spec_critic: BLUE_LINES,
      spec_verdict: rubricLines(verdict, ["yes"]).join("\n"),
    });

    const prdHashBefore = getStageAuthority(CHANGE_ID, "PRD").latestGate?.sourceDbHash;
    assert.ok(prdHashBefore);

    await runSpec(CHANGE_ID, makeJobContext("spec-hash"));

    const approve = {
      changeId: CHANGE_ID,
      action: "approve" as const,
      targetType: "gate" as const,
      targetId: null,
      reason: null,
    };
    await applySpecBattleDecision(approve);
    const specGateBefore = getStageAuthority(CHANGE_ID, "Spec").latestGate;
    assert.ok(specGateBefore);
    const reportBefore = getSpecReportFreshness(CHANGE_ID);
    assert.equal(reportBefore.reportFresh, true, "the round should leave a fresh report to compare against");

    // §4.4: an edit appends a version -- new rubric rows, new criterion rows,
    // brand new criterion ids -- and must invalidate nothing.
    saveSpecRubric("producer", [{ text: "Completely rewritten wording" }, { text: "An added criterion" }]);
    saveSpecRubric("critic", [{ text: "A critic rubric that did not exist before" }]);
    saveSpecRubric("verdict", [{ text: "Rewritten verdict wording" }]);
    saveRubricVersion({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      phase: "Spec",
      role: "producer",
      criteria: [{ text: "A change-level override" }],
    });

    // The recompute. If any rubric row had entered either Spec hash, this is
    // where the stamped gate would move and the fresh report would go stale.
    await applySpecBattleDecision(approve);

    const specGateAfter = getStageAuthority(CHANGE_ID, "Spec").latestGate;
    assert.equal(
      specGateAfter?.sourceDbHash,
      specGateBefore.sourceDbHash,
      "editing a rubric moved the recomputed Spec gate hash",
    );
    assert.equal(
      getSpecReportFreshness(CHANGE_ID).reportFresh,
      true,
      "editing a rubric made a stamped Spec report look stale",
    );
    assert.equal(
      getStageAuthority(CHANGE_ID, "PRD").latestGate?.sourceDbHash,
      prdHashBefore,
      "a rubric-bearing Spec round moved the stamped PRD gate hash",
    );
    // ...and the verdicts really were there to be leaked, so the assertions above
    // are not passing on an empty table.
    //
    // CHANGED in batch 6: was `=== 2`, the exact count when the only rubrics in
    // the project were this test's own. Factory criteria are now seeded for Spec
    // too, so the round also records verdicts for those. The assertion's job is
    // to prove the table was NOT empty, which a lower bound does just as well
    // and without re-pinning to however many factory criteria Spec ships.
    assert.ok(
      listRubricAssessments({ runId: specRunId() }).length >= 2,
      "the hash assertions above must not be passing on an empty assessments table",
    );
  });
});

describe("rubric verdicts are fenced to the current execution", () => {
  function seedBoundRun(runId: string, context: JobExecutionContext): void {
    db.insert(runs).values({
      id: runId,
      changeId: CHANGE_ID,
      phase: "spec",
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      summary: null,
      provider: "codex",
      jobId: context.jobId,
      workerId: context.workerId,
      leaseToken: context.leaseToken,
      attemptNo: context.attemptNo,
    }).run();
  }

  it("refuses a verdict from a worker whose job lease was taken over", async () => {
    const producer = saveSpecRubric("producer", [{ text: "Only criterion" }]);
    const context = makeJobContext("fence-job");
    const runId = "RUN-RUBRIC-FENCE-JOB";
    seedBoundRun(runId, context);

    await withExecutionFence(context, async () => {
      // Somebody else takes the lease while this worker is mid-stage. Retrying
      // the write (withSqliteWriteRetry alone) would happily commit it; only a
      // fence re-checked inside the transaction can refuse it.
      db.update(pipelineJobs).set({ leaseToken: "taken-over-by-another-worker" })
        .where(eq(pipelineJobs.id, context.jobId)).run();
      assert.throws(
        () => recordRubricAssessments({
          changeId: CHANGE_ID,
          runId,
          roundId: null,
          rubric: producer,
          rawText: `RUBRIC: ${producer.criteria[0]!.id} | yes | written by a fenced-out worker`,
        }),
        (error: unknown) => error instanceof StaleLeaseFenceError,
      );
    });

    assert.deepEqual(
      listRubricAssessments({ runId, rubricId: producer.id }),
      [],
      "a fenced-out worker must not be able to record a verdict",
    );
  });

  it("refuses a verdict for a run bound to a different execution", async () => {
    // The job-level check alone passes here: this worker's own job row is
    // healthy. This is what pins the runId argument -- dropping it would let a
    // live worker write verdicts onto a run a newer attempt has rebound.
    const producer = saveSpecRubric("producer", [{ text: "Only criterion" }]);
    const owner = makeJobContext("fence-run-owner");
    const runId = "RUN-RUBRIC-FENCE-RUN";
    seedBoundRun(runId, owner);
    const other = makeJobContext("fence-run-other");

    await withExecutionFence(other, async () => {
      assert.throws(
        () => recordRubricAssessments({
          changeId: CHANGE_ID,
          runId,
          roundId: null,
          rubric: producer,
          rawText: `RUBRIC: ${producer.criteria[0]!.id} | yes | written against a run owned by another execution`,
        }),
        (error: unknown) => error instanceof StaleLeaseFenceError,
      );
    });

    assert.deepEqual(listRubricAssessments({ runId, rubricId: producer.id }), []);
  });

  it("still records verdicts for the execution that owns the run", () => {
    // The fence must not be so tight that the legitimate path stops working --
    // that is the failure mode a "make it stricter" mutation would introduce.
    const producer = saveSpecRubric("producer", [{ text: "Only criterion" }]);
    const owner = makeJobContext("fence-happy");
    const runId = "RUN-RUBRIC-FENCE-OK";
    seedBoundRun(runId, owner);

    return withExecutionFence(owner, async () => {
      const result = recordRubricAssessments({
        changeId: CHANGE_ID,
        runId,
        roundId: null,
        rubric: producer,
        rawText: `RUBRIC: ${producer.criteria[0]!.id} | no | judged by the owning execution`,
      });
      assert.equal(result.ok, true);
      assert.equal(listRubricAssessments({ runId, rubricId: producer.id })[0]?.verdict, "no");
    });
  });
});
