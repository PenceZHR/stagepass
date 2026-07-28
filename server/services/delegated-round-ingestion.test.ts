import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  describeDelegatedRoundViolations,
  readDelegatedRound,
} from "./delegated-round-ingestion.ts";
import { SPEC_DELEGATED_ROUND } from "./delegated-round-phases.ts";
import { roundOutputPath } from "./delegated-round-workspace.ts";

const CHANGE_ID = "CHG-ING";
const JUDGE_THREAD = "THREAD-JUDGE";
const PHASE = SPEC_DELEGATED_ROUND.phase;
let repoPath = "";

// Realistic epoch ms: red 0–120s, blue 200–320s. Small integers would sit
// entirely inside the 10s clock-skew allowance, making every window overlap.
const RED_WINDOW = { startedAt: 1_700_000_000_000, completedAt: 1_700_000_120_000 };
const BLUE_WINDOW = { startedAt: 1_700_000_200_000, completedAt: 1_700_000_320_000 };

const RED_WRITE = 1_700_000_060_000;
const BLUE_WRITE = 1_700_000_260_000;
const VERDICT_WRITE = 1_700_000_400_000;

const RED_JSON = JSON.stringify({ markdown: "# delta\n", fixClaims: [] });
const BLUE_JSON = JSON.stringify({ gapReviews: [], requirementGaps: [], rubric: [] });
const VERDICT_JSON = JSON.stringify({
  verdict: "两方都跑完了。",
  rubric: [{ criterionId: "c1", verdict: "yes", evidence: "见 delta" }],
  roundDone: true,
});

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "round-ing-"));
});
afterEach(() => {
  if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  repoPath = "";
});

/** Writes a side's output and stamps it as written during `whenMs`. */
function writeOutput(role: "red" | "blue" | "verdict", text: string, whenMs: number): void {
  const absolute = path.join(repoPath, roundOutputPath(CHANGE_ID, PHASE, 1, role));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
  const when = new Date(whenMs);
  fs.utimesSync(absolute, when, when);
}

/**
 * A spawned child as the DURABLE record reports it: parent id stamped by the
 * app-server, and no usable role label -- `agent_path`/`agent_role` came back
 * null on the real round, so nothing here says which side it is.
 */
function child(threadId: string, nickname: string) {
  return { threadId, parentThreadId: JUDGE_THREAD, agentNickname: nickname, agentRole: null };
}

const BOTH_CHILDREN = async () => [child("THREAD-A", "Linnaeus"), child("THREAD-B", "Raman")];

const readsBothThreads = async (threadId: string) =>
  threadId === "THREAD-A"
    ? { output: "第一个子 Agent 说它写完了", ...RED_WINDOW }
    : { output: "第二个子 Agent 说它写完了", ...BLUE_WINDOW };

function seedGoodRound(): void {
  writeOutput("red", RED_JSON, RED_WRITE);
  writeOutput("blue", BLUE_JSON, BLUE_WRITE);
  writeOutput("verdict", VERDICT_JSON, VERDICT_WRITE);
}

function read(overrides: Partial<Parameters<typeof readDelegatedRound>[0]> = {}) {
  return readDelegatedRound({
    descriptor: SPEC_DELEGATED_ROUND,
    changeId: CHANGE_ID,
    repoPath,
    roundNo: 1,
    judgeThreadId: JUDGE_THREAD,
    listSubAgents: BOTH_CHILDREN,
    readThread: readsBothThreads,
    verdictCriterionIds: ["c1"],
    ...overrides,
  });
}

const codes_ = (overrides: Parameters<typeof read>[0] = {}) => codes(overrides);

async function codes(overrides: Parameters<typeof read>[0] = {}) {
  const result = await read(overrides);
  assert.equal(result.ok, false, "expected the round to be refused");
  return result.ok ? [] : result.violations.map((v) => v.code);
}

describe("delegated round ingestion", () => {
  it("assembles a round from the three files its sides wrote", async () => {
    seedGoodRound();

    const result = await read();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.round.red.markdown, "# delta\n");
    assert.deepEqual(result.round.blue.requirementGaps, []);
    assert.equal(result.round.judge.rubric[0]?.verdict, "yes");
    // Roles were DERIVED: nothing labelled these children red or blue. red.json
    // was written while THREAD-A ran, blue.json while THREAD-B ran.
    assert.deepEqual(result.round.sideThreads, { red: "THREAD-A", blue: "THREAD-B" });
  });

  /**
   * Blue answers the CRITIC rubric from its own brief. Before that existed the
   * judge was the only role asked about any rubric, so a critic checklist could
   * only ever have been answered by the judge on blue's behalf -- the one thing
   * this whole design refuses -- or left blank, which `rubric-rollout` calls out
   * as reading like a pass.
   */
  it("harvests blue's own critic rubric answers", async () => {
    writeOutput("red", RED_JSON, RED_WRITE);
    writeOutput("blue", JSON.stringify({
      gapReviews: [],
      requirementGaps: [],
      rubric: [{ criterionId: "k1", verdict: "no", evidence: "第 3 条需求没有验收条件" }],
    }), BLUE_WRITE);
    writeOutput("verdict", VERDICT_JSON, VERDICT_WRITE);

    const result = await read({ criticCriterionIds: ["k1"] });

    assert.equal(result.ok, true, "a valid critic rubric answer was refused");
    if (!result.ok) return;
    assert.deepEqual(result.round.blue.rubric, [
      { criterionId: "k1", verdict: "no", evidence: "第 3 条需求没有验收条件" },
    ]);
  });

  /**
   * A judge turn that never ran is not a judge that delegated nothing.
   *
   * The engine returns `success: false` instead of throwing for a class of
   * transport failures, and nothing here read it -- so a wedged Codex
   * app-server, which never dispatched the turn at all, arrived at ingestion
   * and was reported as 「red 方没有写出产出文件」. Measured on CHG-006 round 8:
   * three 30-second failures (a real round takes 5-8 minutes), zero rows in
   * `codex_turn_executions`, and the follower attempt quarantined as
   * `desktop_follower_start_ambiguous`. The operator was sent looking for a
   * sub-agent that was never asked to exist.
   */
  it("names a judge turn that did not complete, rather than blaming red", async () => {
    const { runDelegatedRound, DelegatedRoundError } = await import("./pipeline-delegated-round.ts");
    await assert.rejects(
      () => runDelegatedRound({
        descriptor: SPEC_DELEGATED_ROUND,
        changeId: CHANGE_ID,
        repoPath,
        roundNo: 8,
        runId: "RUN-X",
        context: { jobId: "JOB-X" } as never,
        provider: "codex" as never,
        adoptedResult: {
          success: false,
          providerErrorCode: "desktop_follower_start_ambiguous",
          threadId: JUDGE_THREAD,
          runId: "RUN-X",
          summary: "",
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        } as never,
        ports: { listSubAgents: BOTH_CHILDREN, readThread: readsBothThreads },
      }),
      (error: Error) =>
        error instanceof DelegatedRoundError
        && /judge turn did not complete/.test(error.message)
        && /desktop_follower_start_ambiguous/.test(error.message),
    );
  });

  /**
   * CHG-006 round 5: two sub-agents existed (the count check had already
   * passed), they ran in parallel, both output files therefore landed inside the
   * FIRST one's window, and the round was refused as "两方其实是同一个 Agent".
   *
   * That diagnosis was wrong and expensive -- it points at a judge that failed
   * to delegate, when the judge delegated fine and merely failed to wait. The
   * overlap is checked first now, so the report names the thing that actually
   * happened.
   */
  it("reports parallel sub-agents as an overlap, not as one agent playing both sides", async () => {
    seedGoodRound();

    const codes = await codes_({
      readThread: async (threadId: string) =>
        threadId === "THREAD-A"
          // B starts before A finishes, and A's window contains both writes.
          ? { output: "红方", startedAt: RED_WINDOW.startedAt, completedAt: BLUE_WINDOW.completedAt }
          : { output: "蓝方", startedAt: RED_WINDOW.startedAt + 1_000, completedAt: BLUE_WINDOW.completedAt },
    });

    assert.deepEqual(codes, ["sub_agents_overlapped"]);
  });

  it("refuses blue answering criterion ids the critic rubric does not have", async () => {
    writeOutput("red", RED_JSON, RED_WRITE);
    writeOutput("blue", JSON.stringify({
      gapReviews: [],
      requirementGaps: [],
      rubric: [{ criterionId: "invented_slug", verdict: "yes", evidence: "看起来没问题" }],
    }), BLUE_WRITE);
    writeOutput("verdict", VERDICT_JSON, VERDICT_WRITE);

    assert.deepEqual(
      await codes({ criticCriterionIds: ["k1"] }),
      ["blue_rubric_unknown_criteria"],
    );
  });

  /**
   * The failure the whole form is built against: a judge whose spawns silently
   * failed. It can still WRITE all three files -- so the files alone prove
   * nothing, and the absence of any spawned child is what catches it.
   */
  it("refuses a round with all three files but no sub-agents", async () => {
    seedGoodRound();

    assert.deepEqual(
      await codes({
        listSubAgents: async () => [],
        readThread: async () => {
          assert.fail("no thread may be read when no sub-agent was spawned");
        },
      }),
      ["no_sub_agents"],
    );
  });

  /**
   * Children the app-server did not attribute to THIS judge are not this
   * round's sides, however plausible they look.
   */
  it("ignores sub-agents belonging to another judge", async () => {
    seedGoodRound();

    assert.deepEqual(
      await codes({
        listSubAgents: async () => [
          { threadId: "THREAD-X", parentThreadId: "SOME-OTHER-JUDGE", agentNickname: "Ada", agentRole: null },
        ],
        // The production discovery filters by parent; this asserts the round
        // does not settle just because *some* child exists.
        judgeThreadId: JUDGE_THREAD,
      }),
      ["sub_agent_count_unexpected"],
    );
  });

  /**
   * Both files landing inside one child's window means one agent wrote both --
   * the "two sides" would be one agent talking to itself.
   */
  it("refuses two sub-agents sharing one window as an overlap", async () => {
    seedGoodRound();

    const violations = await codes({
      listSubAgents: async () => [child("THREAD-A", "Linnaeus"), child("THREAD-B", "Raman")],
      readThread: async () => ({ output: "同一个", startedAt: 1_700_000_000_000, completedAt: 1_700_000_500_000 }),
    });

    // Two children exist -- the count check passed -- so "they were really one
    // agent" would be false. They ran at the same time, and that is what is said.
    assert.deepEqual(violations, ["sub_agents_overlapped"]);
  });

  /**
   * The case `side_output_ambiguous` is actually for, and the reason it is not
   * dead code: the windows do NOT overlap, and both files still land in the
   * first child's -- so the second file was written by something that was not
   * its own side. Reachable only once overlap has been ruled out, which is why
   * the overlap check runs first.
   */
  it("still refuses a file written inside another side's window when nothing overlapped", async () => {
    writeOutput("red", RED_JSON, 1_700_000_050_000);
    writeOutput("blue", BLUE_JSON, 1_700_000_060_000);
    writeOutput("verdict", VERDICT_JSON, 1_700_000_600_000);

    assert.deepEqual(
      await codes({
        readThread: async (threadId: string) =>
          threadId === "THREAD-A"
            ? { output: "红方", startedAt: 1_700_000_000_000, completedAt: 1_700_000_100_000 }
            : { output: "蓝方", startedAt: 1_700_000_200_000, completedAt: 1_700_000_300_000 },
      }),
      ["side_output_ambiguous"],
    );
  });

  /**
   * The other half of that: sub-agents really ran, but the judge wrote their
   * files. The write time then falls outside the side's own turn window --
   * timings the judge does not control.
   */
  it("refuses a side's file that was written outside that side's turn", async () => {
    writeOutput("red", RED_JSON, RED_WRITE);
    // Blue ran 300–400, but its file was written at 900 -- after blue finished.
    writeOutput("blue", BLUE_JSON, 1_700_009_000_000);
    writeOutput("verdict", VERDICT_JSON, VERDICT_WRITE);

    assert.deepEqual(await codes(), ["side_output_foreign"]);
  });

  it("refuses a side that ran but wrote nothing", async () => {
    writeOutput("red", RED_JSON, RED_WRITE);
    writeOutput("verdict", VERDICT_JSON, VERDICT_WRITE);

    assert.deepEqual(await codes(), ["side_output_missing"]);
  });

  it("refuses a side whose file is not the document its schema asked for", async () => {
    writeOutput("red", RED_JSON, RED_WRITE);
    writeOutput("blue", "蓝方觉得没什么问题。", BLUE_WRITE);
    writeOutput("verdict", VERDICT_JSON, VERDICT_WRITE);

    assert.deepEqual(await codes(), ["side_output_invalid"]);
  });

  /**
   * zod carries the cross-field rules a JSON schema cannot express: a
   * `downgraded` review with no target passes the schema and must still fail,
   * or the gap is downgraded to nothing in particular.
   */
  it("applies blue's cross-field rules, not only its shape", async () => {
    writeOutput("red", RED_JSON, RED_WRITE);
    writeOutput("blue", JSON.stringify({
      gapReviews: [{
        canonicalGapId: "g1",
        verdict: "downgraded",
        reviewSummary: "没那么严重",
        evidence: "见 delta",
        resolutionEvidence: null,
        downgradedTo: null,
      }],
      requirementGaps: [],
    }), BLUE_WRITE);
    writeOutput("verdict", VERDICT_JSON, VERDICT_WRITE);

    assert.deepEqual(await codes(), ["side_output_invalid"]);
  });

  /**
   * Overlapping windows, but each file lands in one child's exclusive stretch,
   * so the sides ARE attributable -- and the round is still refused, because
   * blue started before red had finished.
   */
  it("refuses a round whose sides ran at the same time", async () => {
    writeOutput("red", RED_JSON, 1_700_000_060_000);
    writeOutput("blue", BLUE_JSON, 1_700_000_400_000);
    writeOutput("verdict", VERDICT_JSON, 1_700_000_600_000);

    assert.deepEqual(
      await codes({
        readThread: async (threadId: string) =>
          threadId === "THREAD-A"
            // A ran 0–300s, B started at 240s: they overlapped.
            ? { output: "第一个", startedAt: 1_700_000_000_000, completedAt: 1_700_000_300_000 }
            : { output: "第二个", startedAt: 1_700_000_240_000, completedAt: 1_700_000_500_000 },
      }),
      ["sub_agents_overlapped"],
    );
  });

  /**
   * When the windows overlap so badly that a file could belong to either child,
   * the honest answer is that attribution is impossible -- not a guess.
   */
  it("refuses to guess when both children ran across the same span", async () => {
    seedGoodRound();

    assert.deepEqual(
      await codes({
        readThread: async () => ({
          output: "分不清", startedAt: 1_700_000_000_000, completedAt: 1_700_000_500_000,
        }),
      }),
      ["sub_agents_overlapped"],
    );
  });

  it("refuses a round where the judge wrote no verdict file", async () => {
    writeOutput("red", RED_JSON, RED_WRITE);
    writeOutput("blue", BLUE_JSON, BLUE_WRITE);

    assert.deepEqual(await codes(), ["judge_output_missing"]);
  });

  it("refuses a verdict the judge itself did not declare finished", async () => {
    writeOutput("red", RED_JSON, RED_WRITE);
    writeOutput("blue", BLUE_JSON, BLUE_WRITE);
    writeOutput("verdict", JSON.stringify({
      verdict: "还得再看一轮。", rubric: [], roundDone: false,
    }), VERDICT_WRITE);

    assert.deepEqual(await codes(), ["judge_round_not_done"]);
  });

  it("reports every violation at once rather than one per expensive re-run", async () => {
    writeOutput("verdict", "不是 JSON", VERDICT_WRITE);

    assert.deepEqual(
      await codes({ listSubAgents: async () => [child("THREAD-A", "Linnaeus")] }),
      ["side_output_missing", "side_output_missing", "sub_agent_count_unexpected", "judge_output_invalid"],
    );
  });

  /**
   * Caught in the ingestion, before a single row is written. The assessment
   * store rejects unknown ids too, but only after red and blue have committed
   * -- which is how CHG-006 ended up with a failed round and two gaps already
   * in the ledger.
   */
  it("refuses a judge that answered criterion ids this rubric does not have", async () => {
    writeOutput("red", RED_JSON, RED_WRITE);
    writeOutput("blue", BLUE_JSON, BLUE_WRITE);
    writeOutput("verdict", JSON.stringify({
      verdict: "判完了。",
      rubric: [{ criterionId: "claims_verified_by_critic", verdict: "yes", evidence: "见 delta" }],
      roundDone: true,
    }), VERDICT_WRITE);

    assert.deepEqual(await codes(), ["judge_rubric_unknown_criteria"]);
  });

  /**
   * The continuation round, which is the normal case from round 2 on.
   *
   * The judge thread persists across rounds, so `thread/list` keeps returning
   * every child it ever spawned. Round 3 of CHG-006 spawned two fresh children,
   * both sides wrote on time -- and the round was refused for "reusing" round
   * 2's threads, which were only ever in the list because the judge is the same
   * judge. Spent children are this round's background, not its evidence.
   */
  it("attributes a continuation round to its fresh children, ignoring spent ones", async () => {
    seedGoodRound();

    const result = await read({
      listSubAgents: async () => [
        child("THREAD-OLD-RED", "Curie"),
        child("THREAD-OLD-BLUE", "Bohr"),
        child("THREAD-A", "Linnaeus"),
        child("THREAD-B", "Raman"),
      ],
      readThread: async (threadId: string) =>
        threadId.startsWith("THREAD-OLD")
          // An earlier round's windows, hours before this one's.
          ? { output: "上一轮的产出", startedAt: 1_699_990_000_000, completedAt: 1_699_990_100_000 }
          : readsBothThreads(threadId),
      usedAgentThreadIds: new Set(["THREAD-OLD-RED", "THREAD-OLD-BLUE"]),
    });

    assert.equal(result.ok, true, result.ok ? "" : describeDelegatedRoundViolations(result.violations));
    if (!result.ok) return;
    assert.deepEqual(result.round.sideThreads, { red: "THREAD-A", blue: "THREAD-B" });
  });

  /**
   * Excluding spent children must not become a way to pass. A judge that
   * spawned nothing new still has a non-empty child list, so the emptiness has
   * to be judged AFTER exclusion -- and reported as "spawned nobody", which is
   * what happened, rather than as a count mismatch.
   */
  it("refuses a continuation round whose judge spawned nobody new", async () => {
    seedGoodRound();

    assert.deepEqual(
      await codes({
        listSubAgents: async () => [child("THREAD-A", "Linnaeus"), child("THREAD-B", "Raman")],
        usedAgentThreadIds: new Set(["THREAD-A", "THREAD-B"]),
      }),
      ["no_sub_agents"],
    );
  });

  it("describes every violation it can produce", () => {
    const described = describeDelegatedRoundViolations([
      { code: "no_sub_agents", parentThreadId: "J" },
      { code: "sub_agent_count_unexpected", expected: 2, found: 1 },
      { code: "sub_agent_timing_unknown", threadId: "A" },
      { code: "side_output_foreign", role: "red", writtenAtMs: 1 },
      { code: "side_output_ambiguous", roles: ["red", "blue"], threadId: "A" },
      { code: "sub_agent_ran_out_of_turn", role: "blue", afterRole: "red", startedAt: 1, afterCompletedAt: 2 },
      { code: "side_output_missing", role: "red", detail: "p" },
      { code: "side_output_invalid", role: "red", detail: "bad" },
      { code: "judge_output_missing", detail: "p" },
      { code: "judge_output_invalid", detail: "bad" },
      { code: "judge_round_not_done" },
      { code: "judge_rubric_unknown_criteria", criterionIds: ["x"] },
    ]);

    assert.equal(described.split("；").length, 12);
    assert.equal(described.includes("undefined"), false);
  });
});
