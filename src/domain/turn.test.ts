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
        blockers: [{
          id: "B", kind: "finding", severity: "P1", title: "x",
          // 契约里有，这一条没写 —— 缺就是 null，不作废整轮。见下面三条。
          where: null, why: null,
        }],
      },
    );
  });

  /**
   * 「在哪儿」和「为什么」必须原样活到下游（用户 2026-08-04：「绝对不能出现语义
   * 损失」）。这三条钉的是那条链子的**第一环**：解析器不许把它们丢掉。
   *
   * 丢掉的后果不是报错，是**安静地少一截**——红方明明写了 foo.ts:42，下一轮的红方
   * 和 Fix 只看得到一个标题。所以这里断言的是「一字不改地带过来」，不是「有值」。
   */
  it("**带上 where / why，一字不改**", () => {
    assert.deepEqual(
      parseTurnResult(
        '{"artifactIds":[],"blockers":[{"id":"B","severity":"P0","title":"空指针",'
        + '"where":"src/foo.ts:42","why":"list 为空时 head() 返回 undefined"}]}',
      ).blockers,
      [{
        id: "B", kind: "finding", severity: "P0", title: "空指针",
        where: "src/foo.ts:42", why: "list 为空时 head() 返回 undefined",
      }],
    );
  });

  it("**没写就是 null —— 不是解析失败**", () => {
    const parsed = parseTurnResult(
      '{"artifactIds":[],"blockers":[{"id":"B","severity":"P1","title":"x"}]}',
    );
    assert.equal(parsed.blockers[0]?.where, null);
    assert.equal(parsed.blockers[0]?.why, null);
  });

  /**
   * 空串和「没写」是同一件事。让它们在库里长成两个样子，下游就得判两次 ——
   * 而判漏一次的表现是提示词里出现一行 `在这儿：`，后面什么都没有。
   */
  it("**空串和只有空白，都归一成 null**", () => {
    const parsed = parseTurnResult(
      '{"artifactIds":[],"blockers":[{"id":"B","severity":"P1","title":"x",'
      + '"where":"","why":"   "}]}',
    );
    assert.equal(parsed.blockers[0]?.where, null);
    assert.equal(parsed.blockers[0]?.why, null);
  });

  /**
   * 一份**注定被丢掉**的 blockers，形状再烂也不许作废整轮。
   *
   * 2026-08-05 真机（Build 第 4 轮，58 分钟）：红方把 blockers 交成了字符串数组。
   * 而 Build 的红方写的是自己的代码，自评本来就被丢掉（`redReviewsOthers`）——
   * 一份没人会用的数据形状错了，整轮作废，蓝方同一轮 11 条有效发现陪葬。
   *
   * `discardBlockers` 是调用方的声明：「我不会用 blockers，别让它们的形状毁掉
   * 我要用的那部分。」所以它**永远返回空**（形状对的也不带回来 —— 带回来就是
   * 邀请谁顺手用一下，而声明说了不用）；artifactIds 的校验**一点都不放宽**。
   */
  it("**discardBlockers：形状烂掉的 blockers 不作废整轮**", () => {
    assert.deepEqual(
      parseTurnResult(
        '{"artifactIds":["x.ts"],"blockers":["BUILD-WEB-1: npm run build 失败了"]}',
        { discardBlockers: true },
      ),
      { artifactIds: ["x.ts"], blockers: [] },
    );
  });

  it("**discardBlockers 丢的是这半个答案，不只是错误** —— 形状对的也不带回来", () => {
    assert.deepEqual(
      parseTurnResult(
        '{"artifactIds":[],"blockers":[{"id":"B","severity":"P1","title":"x"}]}',
        { discardBlockers: true },
      ).blockers,
      [],
    );
  });

  it("**discardBlockers 不放宽 artifactIds** —— 那半个是真要用的", () => {
    assert.throws(
      () => parseTurnResult(
        '{"artifactIds":[42],"blockers":[]}',
        { discardBlockers: true },
      ),
      (error: unknown) =>
        error instanceof TurnResultUnparsableError
        && error.code === "turn_result_artifacts_invalid",
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
