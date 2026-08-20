import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BATCH_MAX, checkAsk, OPTION_MAX, OPTION_MIN, type AskCheck, type AskRequest } from "./ask";

/**
 * 提问的参数校验。**这一层的全部价值在于「拒得让模型改得过来」。**
 *
 * ## 为什么每条拒绝都要盯 `reason` 的内容
 *
 * `domain/worklist.ts` 的 `bad_answer` 立的范式：答错了不抛异常，把允许值原样回给
 * 它。抛异常会在 MCP 那一层变成一句「工具失败了」，模型只知道失败，不知道该改什么
 * —— 于是它要么重试同样的错，要么放弃提问改成打字问（而打字问是这套东西唯一
 * 拦不住的失败模式，TechSpec §十）。
 *
 * 所以这一份里绝大多数断言打的是 **`reason` 里有没有那个数字**，而不是「有没有
 * 拒掉」。只判拒没拒，一句「越界了」也能全绿，而那正是要防的东西。
 */

/**
 * 拒绝的那一支，顺便把类型收窄。
 *
 * `assert.equal(outcome.ok, false)` 收窄不了联合类型（TS 看不见 assert 的语义），
 * 而这棵树的测试是过 `tsc` 的 —— 每处都写一遍 if 只会把断言淹掉。
 */
function refused(outcome: AskCheck, what: string): { error: string; reason: string } {
  assert.equal(outcome.ok, false, `${what}：本该拒掉，却通过了`);
  if (outcome.ok) throw new Error("unreachable");
  assert.notEqual(outcome.reason.trim(), "", `${what}：拒了但没说为什么`);
  // 一句复读 error 码的 reason 等于没有 reason —— 模型拿 `bad_options` 四个字
  // 改不出第二版。
  assert.notEqual(outcome.reason.trim(), outcome.error, `${what}：reason 只是复读了错误码`);
  return { error: outcome.error, reason: outcome.reason };
}

function accepted(outcome: AskCheck, what: string): AskRequest {
  assert.equal(outcome.ok, true, `${what}：本该通过，却被拒了`);
  if (!outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.requests.length, 1, `${what}：单条应该只出一条`);
  return outcome.requests[0]!;
}

function acceptedBatch(outcome: AskCheck, what: string): readonly AskRequest[] {
  assert.equal(outcome.ok, true, `${what}：本该通过，却被拒了`);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.requests;
}

const ok = (patch: Record<string, unknown> = {}): unknown => ({
  ordinal: 1, question: "两种做法选哪个？", options: ["A", "B"], ...patch,
});

describe("L0 · 提问的形状 —— 模型只能生成一个小整数和散文", () => {
  it("序号越界要把范围原样回给模型 —— 它自己改得过来", () => {
    const { error, reason } = refused(checkAsk(ok({ ordinal: 9 }), 4), "ordinal=9 / 共 4 条");
    assert.equal(error, "ordinal_out_of_range");
    // 不是「越界了」三个字 —— 那句话模型没法据以改正。要看得见 1 和 4。
    assert.match(reason, /1[^\d]*4/);
  });

  it("**判据单一条都没有时，任何序号都是越界，而且要说出「零条」**", () => {
    // 退化路径最容易被写成一句「越界了」：`1..0` 这个范围印出来是自相矛盾的，
    // 实现很容易在这里偷懒。而模型此刻唯一的出路是改成 ordinal=null，
    // reason 得让它看出来「这一轮根本没有判据单」。
    const { error, reason } = refused(checkAsk(ok({ ordinal: 1 }), 0), "ordinal=1 / 共 0 条");
    assert.equal(error, "ordinal_out_of_range");
    assert.match(reason, /0/);
  });

  it("判据单为空时允许不带序号", () => {
    const request = accepted(checkAsk(ok({ ordinal: null }), 0), "ordinal=null / 共 0 条");
    assert.equal(request.ordinal, null);
  });

  it("判据单不空时也允许不带序号 —— null 是「这个问题不挂在某一条上」", () => {
    // TechSpec §九：P0b 的退化形态是「随便问」，而 `AskRequest.ordinal` 的类型
    // 就是 `number | null`。若实现在 count>0 时把 null 判成必填，那是把类型里
    // 写着的一半悄悄关掉。
    assert.equal(accepted(checkAsk(ok({ ordinal: null }), 4), "ordinal=null / 共 4 条").ordinal, null);
  });

  it("两端的序号都算数 —— 1 和 count 本身不是越界", () => {
    // 差一错误的经典落点。两端都通过、两端外一格都拒，四个点一起钉。
    assert.equal(accepted(checkAsk(ok({ ordinal: 1 }), 4), "ordinal=1").ordinal, 1);
    assert.equal(accepted(checkAsk(ok({ ordinal: 4 }), 4), "ordinal=4").ordinal, 4);
    assert.equal(refused(checkAsk(ok({ ordinal: 0 }), 4), "ordinal=0").error, "ordinal_out_of_range");
    assert.equal(refused(checkAsk(ok({ ordinal: 5 }), 4), "ordinal=5").error, "ordinal_out_of_range");
  });

  it("序号得是个整数 —— 小数、字符串、NaN 都不是「第几条」", () => {
    // 全是模型真会生成的东西：`"2"` 尤其常见（JSON 里手滑加引号）。
    // 静默地 Number() 一下会让 `"2"` 和 2 走两条路，而错的那条查不出来。
    for (const bad of [1.5, "2", Number.NaN, true, [] as unknown]) {
      assert.equal(
        refused(checkAsk(ok({ ordinal: bad }), 4), `ordinal=${String(bad)}`).error,
        "ordinal_out_of_range",
      );
    }
  });

  it("选项少于两条 = 不是选择题", () => {
    assert.equal(refused(checkAsk(ok({ options: ["A"] }), 4), "一个选项").error, "bad_options");
    assert.equal(refused(checkAsk(ok({ options: [] }), 4), "零个选项").error, "bad_options");
  });

  it("选项多过六条 = 不是给人点的表单", () => {
    const seven = ["A", "B", "C", "D", "E", "F", "G"];
    assert.equal(refused(checkAsk(ok({ options: seven }), 4), "七个选项").error, "bad_options");
  });

  it("**选项数不对时，reason 里要有 2 和 6** —— 模型据此自己裁到范围里", () => {
    const { reason } = refused(checkAsk(ok({ options: ["A"] }), 4), "一个选项");
    assert.match(reason, new RegExp(`${OPTION_MIN}[^\\d]*${OPTION_MAX}`));
    // 常量和文本是同一份事实，别让它们分家。
    assert.equal(OPTION_MIN, 2);
    assert.equal(OPTION_MAX, 6);
  });

  it("两条和六条都算数 —— 上下界本身通过", () => {
    assert.equal(accepted(checkAsk(ok({ options: ["A", "B"] }), 4), "两个选项").options.length, 2);
    const six = ["A", "B", "C", "D", "E", "F"];
    assert.deepEqual([...accepted(checkAsk(ok({ options: six }), 4), "六个选项").options], six);
  });

  it("选项得是一组字符串 —— 不是一个字符串、也不是一组对象", () => {
    // `options: "A 或 B"` 是模型最常见的走形，而它的 `.length` 是 5 —— 正好落在
    // 2..6 里。只数长度不看类型的实现会放它过去，所以这一条不是多余的。
    for (const bad of ["A 或 B", [1, 2], [{ label: "A" }, { label: "B" }], null]) {
      assert.equal(
        refused(checkAsk(ok({ options: bad }), 4), `options=${JSON.stringify(bad)}`).error,
        "bad_options",
      );
    }
  });

  it("空的问句拒掉 —— 一个只有选项的表单，人不知道在答什么", () => {
    assert.equal(refused(checkAsk(ok({ question: "" }), 4), "空问句").error, "empty_question");
    assert.equal(refused(checkAsk(ok({ question: "   \n\t" }), 4), "全空白问句").error, "empty_question");
    assert.equal(refused(checkAsk(ok({ question: null }), 4), "问句是 null").error, "empty_question");
  });

  it("`why` 缺席就是 null，不是 undefined —— 落档那一层不该再判一次「有没有这个键」", () => {
    assert.equal(accepted(checkAsk(ok(), 4), "没给 why").why, null);
    assert.equal(accepted(checkAsk(ok({ why: "两种都能跑，代价不一样" }), 4), "给了 why").why,
      "两种都能跑，代价不一样");
  });

  it("**校验失败一律不抛异常** —— 抛了模型只知道「失败了」", () => {
    /*
     * 这是这个模块存在的唯一理由，所以它单独有一条测试，而且喂的是**整段乱七八糟
     * 的输入**，不是精心构造的畸形字段：`raw` 的类型是 `unknown`，它真会收到
     * MCP 那头原样转来的任何东西。
     */
    const garbage: unknown[] = [
      null, undefined, 42, "不是对象", [], true,
      {}, { ordinal: 1 }, { question: "？" }, { options: ["A", "B"] },
      { ordinal: {}, question: {}, options: {}, why: {} },
      Object.create(null) as unknown,
    ];
    for (const raw of garbage) {
      let outcome: AskCheck | undefined;
      assert.doesNotThrow(
        () => { outcome = checkAsk(raw, 4); },
        `checkAsk(${JSON.stringify(raw) ?? String(raw)}) 抛了 —— 模型收到的会是一句「工具失败」`,
      );
      refused(outcome!, `垃圾输入 ${JSON.stringify(raw) ?? String(raw)}`);
    }
  });

  it("通过时回来的是一份归一化的请求 —— 上游不再碰 raw", () => {
    // `checkAsk` 是 raw 的唯一入口。它若只回一个 `ok: true` 而不带 request，
    // 上游就得自己再解一次 raw，于是校验和使用读的是两份东西。
    const request = accepted(
      checkAsk({ ordinal: 3, question: "选哪个？", options: ["A", "B"], why: "因为" }, 4),
      "完整请求",
    );
    assert.deepEqual({ ...request, options: [...request.options] }, {
      ordinal: 3, question: "选哪个？", options: ["A", "B"], why: "因为",
    });
  });
});

/*
 * **攒几个一起问**（用户 2026-08-19：「一次问一个不符合我的效率逻辑」）。
 *
 * 我原来定「一次一条」的理由是 elicitation 的第三条静默坑：空文本格吃掉回车、
 * 而只有最后一格能提交。**那条坑只在有自由文本格时成立** —— 一批全是选择题的
 * 表单没有文本格。理由比我当初说的窄。
 */
describe("L0 · 攒一批问", () => {
  const one = (patch: Record<string, unknown> = {}) => ({
    ordinal: null, question: "选哪个？", options: ["A", "B"], ...patch,
  });

  it("一批按送来的顺序出来 —— 顺序就是人在表单上看到的顺序", () => {
    const out = acceptedBatch(checkAsk({ questions: [
      one({ question: "第一个" }), one({ question: "第二个" }), one({ question: "第三个" }),
    ] }, 0), "三条");
    assert.deepEqual(out.map((r) => r.question), ["第一个", "第二个", "第三个"]);
  });

  it("单个对象等价于一批里只有一条 —— 模型真只有一个问题时不用包数组", () => {
    assert.equal(acceptedBatch(checkAsk(one(), 0), "单条").length, 1);
  });

  it(`超过 ${BATCH_MAX} 条整批拒，并说得出上限`, () => {
    const out = refused(checkAsk({ questions: Array.from({ length: BATCH_MAX + 1 }, () => one()) }, 0), "超批");
    assert.equal(out.error, "bad_batch");
    assert.match(out.reason, new RegExp(String(BATCH_MAX)));
  });

  it("空批也拒 —— 一条问题都没有的「提问」是模型出错了，不是它没什么要问", () => {
    assert.equal(refused(checkAsk({ questions: [] }, 0), "空批").error, "bad_batch");
  });

  it("**一条不合规就整批拒，并说清是第几条**", () => {
    const out = refused(checkAsk({ questions: [
      one(), one({ options: ["只有一个"] }), one(),
    ] }, 0), "第二条坏");
    // 只送合规的那几条，模型会以为整批都问出去了，然后等一个永远不来的答案
    assert.match(out.reason, /第 2 条/);
    assert.match(out.reason, /整批都没问出去/);
  });
});
