import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Gap } from "./gap";
import { BLUE, judgePrompt, readRound, readVerdicts, RED, UnreadableVerdictError } from "./round";
import { TurnResultUnparsableError } from "./turn";

const answer = (artifacts: string[], blockers: object[] = []) =>
  "```json\n" + JSON.stringify({ artifactIds: artifacts, blockers }) + "\n```";

const gap = (id: string, title: string): Gap => ({
  id, severity: "P1", title, status: "open", openedRound: 1, resolution: null,
});

describe("L4 · what the judge is told", () => {
  it("names both roles by their exact paths", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "写出 Spec", openGaps: [],
    });
    assert.match(prompt, new RegExp(`"${RED}"`));
    assert.match(prompt, new RegExp(`"${BLUE}"`));
    assert.match(prompt, /Spec/);
    assert.match(prompt, /第 2 轮/);
  });

  it("carries the result contract to both roles", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 1, task: "写出 Spec", openGaps: [],
    });
    assert.match(prompt, /artifactIds/);
    assert.match(prompt, /P0\|P1\|P2/);
  });

  it("lists the open problems the judge must rule on", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 3, task: "t",
      openGaps: [gap("SPEC-1", "范围与 PRD 冲突"), gap("SPEC-2", "验收不可测")],
    });
    assert.match(prompt, /SPEC-1 \[P1\] 范围与 PRD 冲突/);
    assert.match(prompt, /SPEC-2 \[P1\] 验收不可测/);
  });

  /**
   * The rule has to reach the judge, not just the code. A judge that believes
   * silence closes a problem will close problems by staying quiet.
   */
  it("tells the judge that silence keeps a problem open", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "t", openGaps: [gap("SPEC-1", "x")],
    });
    assert.match(prompt, /沉默等于仍然存在/);
  });

  /**
   * Blue investigating the repository turns an attack on the artifact into an
   * investigation of something else, and the gap it reports stops being about
   * the document under review.
   */
  it("tells blue to attack the artifact and nothing else", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 1, task: "t", openGaps: [],
    });
    assert.match(prompt, /只许基于正方产出提出问题/);
    assert.match(prompt, /不要去读仓库/);
  });

  it("says nothing to rule on when nothing is open", () => {
    assert.match(
      judgePrompt({ phase: "PRD", round: 1, task: "t", openGaps: [] }),
      /没有未关闭的问题/,
    );
  });
});

describe("L4 · reading the judge's verdicts", () => {
  it("reads a verdict on each named problem", () => {
    assert.deepEqual(readVerdicts(
      '```json\n{"verdicts":{"SPEC-1":{"kind":"closed","reason":"范围已收窄"},'
      + '"SPEC-2":{"kind":"still_open","reason":"仍不可测"}}}\n```',
    ), {
      verdicts: {
        "SPEC-1": { kind: "closed", reason: "范围已收窄" },
        "SPEC-2": { kind: "still_open", reason: "仍不可测" },
      },
    });
  });

  /**
   * A judge that said nothing readable has ruled on nothing, and every open gap
   * stays open. That is the safe direction, so it is not an error.
   */
  it("yields no verdicts when the judge said nothing readable", () => {
    for (const text of ["都挺好的", "```json\n{}\n```", '{"verdicts":null}']) {
      assert.deepEqual(readVerdicts(text), { verdicts: {} });
    }
  });

  /**
   * But a malformed verdict IS refused: dropping it silently would look exactly
   * like the judge having stayed quiet, and those two must not be confusable.
   */
  it("refuses a verdict that claims to be one and is not", () => {
    for (const bad of [
      '{"verdicts":{"G-1":{"kind":"maybe","reason":"r"}}}',
      '{"verdicts":{"G-1":{"kind":"closed"}}}',
      '{"verdicts":{"G-1":{"kind":"closed","reason":"  "}}}',
      '{"verdicts":[]}',
    ]) {
      assert.throws(() => readVerdicts(bad), UnreadableVerdictError, bad);
    }
  });
});

describe("L4 · each role is read from its own transcript", () => {
  it("takes artifacts from red and problems from blue", () => {
    const reading = readRound({
      round: 2,
      red: answer(["spec.md"]),
      blue: answer([], [{ id: "SPEC-9", severity: "P0", title: "范围冲突" }]),
      judge: '```json\n{"verdicts":{}}\n```',
    });
    assert.deepEqual(reading.artifactIds, ["spec.md"]);
    assert.deepEqual(reading.outcome.found, [
      { id: "SPEC-9", severity: "P0", title: "范围冲突" },
    ]);
    assert.equal(reading.outcome.round, 2);
  });

  /**
   * A producer grading its own work is not an adversarial finding. Counting
   * red's blockers would let it decide how bad its own output is, which is
   * blue's job precisely because red cannot do it.
   */
  it("ignores problems red reported about its own work", () => {
    const reading = readRound({
      round: 1,
      red: answer(["spec.md"], [{ id: "RED-SELF", severity: "P0", title: "我觉得还行" }]),
      blue: answer([], []),
      judge: "",
    });
    assert.deepEqual(reading.outcome.found, []);
  });

  /**
   * A blue that answered in the wrong shape found nothing StagePass can act on.
   * Reading that as "no problems" would turn a broken attacker into a clean
   * bill of health.
   */
  it("fails the round when blue's answer cannot be read", () => {
    assert.throws(
      () => readRound({
        round: 1, red: answer(["spec.md"]), blue: "看起来没问题", judge: "",
      }),
      (error: unknown) =>
        error instanceof TurnResultUnparsableError
        && error.detail.startsWith("blue:"),
    );
  });

  it("fails the round when red produced nothing readable", () => {
    assert.throws(
      () => readRound({ round: 1, red: "写完了", blue: answer([]), judge: "" }),
      TurnResultUnparsableError,
    );
  });

  it("carries the judge's verdicts into the round's outcome", () => {
    const reading = readRound({
      round: 3,
      red: answer(["spec.md"]),
      blue: answer([]),
      judge: '```json\n{"verdicts":{"SPEC-1":{"kind":"closed","reason":"已收窄"}}}\n```',
    });
    assert.deepEqual(reading.outcome.verdicts, {
      "SPEC-1": { kind: "closed", reason: "已收窄" },
    });
  });
});
