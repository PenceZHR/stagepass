import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PHASES } from "./phase";
import {
  assertRequestValid,
  InvalidTurnRequestError,
  parseTurnResult,
  requestHash,
  RESULT_CONTRACT,
  TurnResultUnparsableError,
} from "./turn";
import { MINIMAL_PHASE_INSTRUCTIONS } from "../codex/turn-runner";

describe("L2 · a request the far end can act on", () => {
  /**
   * The old tree dispatched turns whose text sat under a field its reader did
   * not read, so every one of them failed the instant it was picked up -- and
   * nothing noticed for as long as nothing reached that path.
   */
  it("refuses a blank prompt before anything is written down", () => {
    for (const prompt of ["", "   ", "\n\t"]) {
      assert.throws(
        () => assertRequestValid({ changeId: "CHG-1", phase: "PRD", prompt }),
        (error: unknown) =>
          error instanceof InvalidTurnRequestError
          && error.code === "prompt_missing",
      );
    }
  });

  it("gives the same request the same identity", () => {
    const request = { changeId: "CHG-1", phase: "PRD" as const, prompt: "go" };
    assert.equal(requestHash(request), requestHash({ ...request }));
    assert.notEqual(
      requestHash(request),
      requestHash({ ...request, prompt: "go further" }),
    );
  });
});

describe("L2 · reading the model's answer", () => {
  it("accepts the contract's shape, and stamps every blocker as a finding", () => {
    assert.deepEqual(
      parseTurnResult(
        '```json\n{"artifactIds":["a.md"],"blockers":[{"id":"B","severity":"P1","title":"x"}]}\n```',
      ),
      {
        artifactIds: ["a.md"],
        // `kind` 不在契约里，模型也不写它 —— 是这里盖上去的。模型在报「我发现了
        // 什么」，那定义上就是 finding；一条 standard 是 rubric 判出来的二元结论，
        // 永远不从模型的自述里来。
        blockers: [{ id: "B", kind: "finding", severity: "P1", title: "x" }],
      },
    );
  });

  it("accepts bare json with no fence", () => {
    assert.deepEqual(
      parseTurnResult('{"artifactIds":[],"blockers":[]}'),
      { artifactIds: [], blockers: [] },
    );
  });

  it("ignores prose around the block", () => {
    assert.deepEqual(
      parseTurnResult(
        'Here is what I did.\n```json\n{"artifactIds":["a"],"blockers":[]}\n```\nHope that helps!',
      ).artifactIds,
      ["a"],
    );
  });

  for (const [label, text, code] of [
    ["no json at all", "all done", "turn_result_no_json"],
    ["an array", "[]", "turn_result_not_an_object"],
    ["null", "null", "turn_result_not_an_object"],
    ["missing artifactIds", '{"blockers":[]}', "turn_result_artifacts_invalid"],
    [
      "a non-string artifact",
      '{"artifactIds":[7],"blockers":[]}',
      "turn_result_artifacts_invalid",
    ],
    [
      "a blank artifact",
      '{"artifactIds":["  "],"blockers":[]}',
      "turn_result_artifacts_invalid",
    ],
    [
      "missing blockers",
      '{"artifactIds":[]}',
      "turn_result_blockers_invalid",
    ],
    [
      "an invented severity",
      '{"artifactIds":[],"blockers":[{"id":"B","severity":"BLOCKER","title":"x"}]}',
      "turn_result_blockers_invalid",
    ],
    [
      "a blocker with no id",
      '{"artifactIds":[],"blockers":[{"severity":"P0","title":"x"}]}',
      "turn_result_blockers_invalid",
    ],
  ] as const) {
    it(`names the failure on ${label}`, () => {
      assert.throws(
        () => parseTurnResult(text),
        (error: unknown) =>
          error instanceof TurnResultUnparsableError && error.code === code,
      );
    });
  }
});

describe("L2 · what every turn is told", () => {
  it("states the exact fields the gate reads", () => {
    assert.match(RESULT_CONTRACT, /artifactIds/);
    assert.match(RESULT_CONTRACT, /blockers/);
    assert.match(RESULT_CONTRACT, /P0\|P1\|P2/);
  });

  /**
   * A phase with no instruction would dispatch a turn carrying only the result
   * contract -- the model would be told how to answer but not what to do.
   */
  it("has an instruction for every phase", () => {
    for (const phase of PHASES) {
      assert.ok(
        MINIMAL_PHASE_INSTRUCTIONS[phase]?.trim(),
        `${phase} has no instruction`,
      );
    }
    assert.equal(
      Object.keys(MINIMAL_PHASE_INSTRUCTIONS).length,
      PHASES.length,
    );
  });
});

/**
 * 没包围栏，但 JSON 明明就在那儿。
 *
 * 2026-07-30 实测：红方答的是
 *
 * ```
 * I'm reviewing the target commit ... assigned a stable RV- ID.
 * {"artifactIds":["index.html"],"blockers":[]}
 * ```
 *
 * 契约要的是一个 ```json 块，它没给。而原来的兜底是「没围栏就把整段当 JSON」——
 * 整段前面有一句话，于是 `JSON.parse` 失败，整轮作废。
 *
 * **判据不该是「有没有照仪式写」，而是「读不读得出来」。** 一个完整的 JSON 对象摆在
 * 那儿，把它读出来不叫放宽标准 —— 后面那些形状检查（artifactIds 必须是字符串数组、
 * blockers 必须是数组）一个都没动，读出来的东西照样要过它们。
 */
describe("turn · 没围栏时，认最后那个完整的 JSON 对象", () => {
  const body = '{"artifactIds":["index.html"],"blockers":[]}';

  it("**前面有一句话也读得出来**", () => {
    const result = parseTurnResult(`我先说明一下我做了什么。\n${body}`);
    assert.deepEqual(result.artifactIds, ["index.html"]);
    assert.deepEqual(result.blockers, []);
  });

  it("后面还有一句话也读得出来", () => {
    const result = parseTurnResult(`${body}\n以上。`);
    assert.deepEqual(result.artifactIds, ["index.html"]);
  });

  it("**有围栏时仍然只认围栏里的** —— 别被正文里举的例子带偏", () => {
    const text = '举个例子：{"artifactIds":["假的"],"blockers":[]}\n'
      + "```json\n" + body + "\n```";
    assert.deepEqual(parseTurnResult(text).artifactIds, ["index.html"]);
  });

  it("**形状不对照样拒** —— 这条兜底不放宽任何一项检查", () => {
    assert.throws(
      () => parseTurnResult('说明。\n{"artifactIds":"不是数组","blockers":[]}'),
      TurnResultUnparsableError,
    );
  });

  it("压根没有 JSON —— 照旧报 no_json", () => {
    assert.throws(() => parseTurnResult("我写完了，没别的。"), TurnResultUnparsableError);
  });
});
