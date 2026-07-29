import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRubricEdit, UnreadableEditError } from "./rubric-edit";

const bytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

const ok = {
  scope: "project",
  drafts: [{ key: "K1", text: "每条需求都有可测的验收标准", blocking: true }],
  reason: "改了措辞",
};

describe("rubric 编辑请求 · 读得出来的", () => {
  it("完整的一份", () => {
    assert.deepEqual(parseRubricEdit(bytes(ok)), {
      scope: "project",
      drafts: [{ key: "K1", text: "每条需求都有可测的验收标准", blocking: true }],
      reason: "改了措辞",
    });
  });

  it("没有 key 的 draft 是新写的一条", () => {
    const read = parseRubricEdit(bytes({ scope: "change", drafts: [{ text: "新的", blocking: false }] }));
    assert.equal(read.scope, "change");
    assert.equal(read.drafts[0]?.key, undefined);
  });

  it("没有 reason 就是 undefined，不是空字符串", () => {
    // 空字符串会让 store 那条「理由不能为空」的检查看起来被满足了。
    assert.equal(parseRubricEdit(bytes({ scope: "project", drafts: [] })).reason, undefined);
  });

  it("空 drafts 合法 —— 那是「把这份 rubric 清空」", () => {
    assert.deepEqual(parseRubricEdit(bytes({ scope: "project", drafts: [] })).drafts, []);
  });
});

describe("rubric 编辑请求 · 读不出来的", () => {
  const refuses = (payload: unknown, code: string) => {
    assert.throws(() => parseRubricEdit(bytes(payload)), (error: unknown) => {
      assert.ok(error instanceof UnreadableEditError);
      assert.equal(error.code, code);
      return true;
    });
  };

  it("不是 JSON", () => { refuses("这不是 json", "not_json"); });
  it("是数组不是对象", () => { refuses([1, 2], "not_an_object"); });

  it("**scope 没写明 —— 拒绝，不给默认值**", () => {
    /*
     * 两个方向都是静默的错，所以哪个都不能当默认：
     *   默认 project —— 一次本想只影响这个 Change 的编辑，悄悄改掉了全局默认
     *   默认 change  —— 人以为改了全局，其实只改了这一个
     */
    refuses({ drafts: [] }, "bad_scope");
    refuses({ scope: "全局", drafts: [] }, "bad_scope");
  });

  it("drafts 不是数组，或者里面的东西形状不对", () => {
    refuses({ scope: "project" }, "bad_drafts");
    refuses({ scope: "project", drafts: [{ text: "少了 blocking" }] }, "bad_drafts");
    refuses({ scope: "project", drafts: [{ text: 1, blocking: true }] }, "bad_drafts");
    refuses({ scope: "project", drafts: [{ text: "x", blocking: "true" }] }, "bad_drafts");
    refuses({ scope: "project", drafts: [{ key: 7, text: "x", blocking: true }] }, "bad_drafts");
  });
});
