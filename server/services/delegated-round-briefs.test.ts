import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAndMaterialiseRoundBriefs,
  buildRoundDispatchPrompt,
} from "./delegated-round-briefs.ts";
import {
  DELEGATED_ROUND_PHASES,
  PLAN_DELEGATED_ROUND,
  SPEC_DELEGATED_ROUND,
  TECH_SPEC_DELEGATED_ROUND,
  TEST_PLAN_DELEGATED_ROUND,
} from "./delegated-round-phases.ts";
import { roundWritableGlobs } from "./delegated-round-workspace.ts";

const CHANGE_ID = "CHG-BRIEF";
let repoPath = "";

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "round-briefs-"));
});
afterEach(() => {
  if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  repoPath = "";
});

function materialise(descriptor = SPEC_DELEGATED_ROUND, roundNo = 1) {
  const paths = buildAndMaterialiseRoundBriefs({
    descriptor, changeId: CHANGE_ID, changeTitle: "标题", repoPath, roundNo,
  });
  const read = (relative: string) => fs.readFileSync(path.join(repoPath, relative), "utf-8");
  return { paths, judge: read(paths.judge), red: read(paths.red), blue: read(paths.blue) };
}

describe("delegated round briefs", () => {
  it("writes all three role briefs as files, for every phase", () => {
    for (const descriptor of DELEGATED_ROUND_PHASES) {
      const { paths, judge, red, blue } = materialise(descriptor);
      for (const brief of [judge, red, blue]) {
        assert.ok(brief.trim().length > 0, `${descriptor.phase} brief is empty`);
        // A placeholder that survived means the server left the model an
        // instruction it cannot follow.
        assert.doesNotMatch(brief, /\{[a-zA-Z]+\}/, `${descriptor.phase} brief has an unfilled placeholder`);
      }
      assert.match(paths.judge, /roles[/\\]judge\.md$/);
    }
  });

  /**
   * The schema exists once, in the descriptor. Nine briefs each carrying a
   * pasted copy would only have to drift once for a side to be asked for a
   * document the server then refuses.
   */
  it("injects each phase's own producer schema into red's brief", () => {
    const cases = [
      [SPEC_DELEGATED_ROUND, "fixClaims"],
      [TECH_SPEC_DELEGATED_ROUND, "techSpec"],
      [PLAN_DELEGATED_ROUND, "validationCommands"],
      [TEST_PLAN_DELEGATED_ROUND, "coverageItems"],
    ] as const;

    for (const [descriptor, marker] of cases) {
      const { red } = materialise(descriptor);
      assert.match(red, new RegExp(marker), `${descriptor.phase} red brief lost its schema`);
    }
    // Blue's schema is shared, so every phase's blue brief asks for the same
    // two arrays.
    for (const descriptor of DELEGATED_ROUND_PHASES) {
      const { blue } = materialise(descriptor);
      assert.match(blue, /requirementGaps/);
      assert.match(blue, /gapReviews/);
    }
  });

  /**
   * The whole point of the file form: a side writes its result, it does not
   * type it into the chat.
   */
  it("tells every side to write a file and not to answer in chat", () => {
    const { red, blue, judge, paths } = materialise();

    assert.match(red, new RegExp(paths.redOutput.replace(/[\\/]/g, "[\\\\/]")));
    assert.match(blue, new RegExp(paths.blueOutput.replace(/[\\/]/g, "[\\\\/]")));
    assert.match(judge, new RegExp(paths.verdictOutput.replace(/[\\/]/g, "[\\\\/]")));
    for (const brief of [red, blue]) {
      assert.match(brief, /不要在聊天里复述这份 JSON/);
    }
  });

  /**
   * The judge hands over PATHS. A judge that quotes a brief is a judge that can
   * quietly relax its sub-agent's schema.
   */
  it("gives the judge its sub-agents' brief paths, not their contents", () => {
    const { judge, paths, red } = materialise();

    assert.match(judge, new RegExp(paths.red.replace(/[\\/]/g, "[\\\\/]")));
    assert.match(judge, new RegExp(paths.blue.replace(/[\\/]/g, "[\\\\/]")));
    assert.match(judge, /不要把任务书的内容复述给子 Agent，只给路径/);
    // Red's brief body must NOT be inside the judge's brief.
    const redBody = red.split("\n").find((line) => line.includes("你就是红方"));
    assert.ok(redBody);
    assert.equal(judge.includes(redBody!), false, "the judge brief inlined red's brief");
  });

  it("carries the serial-delegation and anti-fabrication rules exactly once, shared by every phase", () => {
    for (const descriptor of DELEGATED_ROUND_PHASES) {
      const { judge } = materialise(descriptor);
      assert.match(judge, /在 red 结束之前，绝对不许启动蓝方/);
      assert.match(judge, /禁止并行/);
      assert.match(judge, /禁止你自己写红方或蓝方的内容/);
      assert.match(judge, /写入时间是否落在该方自己那一轮的运行区间内/);
      assert.match(judge, /红蓝双方都是 Agent，与人类无关/);
      // Counts are computed from the ledger; the judge must not report them.
      assert.match(judge, /不要输出任何计数/);
    }
  });

  it("names the phase's own units and checklist in the shared judge brief", () => {
    assert.match(materialise(TECH_SPEC_DELEGATED_ROUND).judge, /TECH_SPEC_WRITER/);
    assert.match(materialise(PLAN_DELEGATED_ROUND).judge, /PLAN_CRITIC/);
    assert.match(
      materialise(TEST_PLAN_DELEGATED_ROUND).judge,
      /每个会阻止交付的关键风险/,
      "the TestPlan checklist did not reach the judge",
    );
  });

  /**
   * The briefs are server-owned. A round that could rewrite its own brief could
   * rewrite its own schema, so they sit outside the writable glob.
   */
  it("keeps the role briefs outside what the round may write", () => {
    const { paths } = materialise();
    const globs = roundWritableGlobs(CHANGE_ID, SPEC_DELEGATED_ROUND.phase);

    for (const brief of [paths.judge, paths.red, paths.blue]) {
      assert.equal(
        globs.some((glob) => new RegExp(`^${glob.replace(/\*/g, "[^/]*")}$`).test(brief)),
        false,
        brief,
      );
    }
  });
});

describe("delegated round dispatch prompt", () => {
  /**
   * The turn carries a pointer, not a brief -- because a path cannot be
   * paraphrased into a weaker schema on the way through, and because the round's
   * actual instruction should not be buried under a page of role definition.
   */
  it("is short, points at the judge brief, and states the round", () => {
    const { paths } = materialise(SPEC_DELEGATED_ROUND, 3);

    const prompt = buildRoundDispatchPrompt({
      descriptor: SPEC_DELEGATED_ROUND, changeId: CHANGE_ID, roundNo: 3, paths,
    });

    assert.ok(prompt.length < 600, `dispatch prompt is not a dispatch: ${prompt.length} chars`);
    assert.match(prompt, /第 3 轮/);
    assert.match(prompt, new RegExp(paths.judge.replace(/[\\/]/g, "[\\\\/]")));
    // It must not restate the judge's rules -- those live in the file.
    assert.doesNotMatch(prompt, /禁止并行/);
  });

  /**
   * This used to assert the opposite -- that a later round is told it is "不是新
   * 会话". That was true of the design and false of the runtime, and the runtime
   * won: a round's sub-agents must be fresh, sub-agents live in the Codex task,
   * so every round runs in a fresh task (delegated-round-task-rotation.ts).
   *
   * A judge told it remembers rounds it cannot see is a judge invited to invent
   * them. It is pointed at the files instead, which are evidence rather than
   * recollection.
   */
  it("points a later round at the earlier rounds' files instead of its memory", () => {
    const { paths } = materialise(SPEC_DELEGATED_ROUND, 2);

    const first = buildRoundDispatchPrompt({
      descriptor: SPEC_DELEGATED_ROUND, changeId: CHANGE_ID, roundNo: 1, paths,
    });
    const later = buildRoundDispatchPrompt({
      descriptor: SPEC_DELEGATED_ROUND, changeId: CHANGE_ID, roundNo: 3, paths,
    });

    assert.match(first, /这是本阶段的第一轮/);
    assert.doesNotMatch(
      later,
      /不是新会话|你都还记得/,
      "the task is rotated every round, so claimed continuity is a claim the judge cannot honour",
    );
    assert.match(later, /新起的会话/);
    assert.match(later, /round-01/, "it has to say where the earlier rounds actually are");
    assert.match(later, /round-02/, "the range must end at the previous round, not this one");
    assert.doesNotMatch(later, /round-03/, "this round has produced nothing to read yet");
  });
});
