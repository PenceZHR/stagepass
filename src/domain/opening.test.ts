import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { renderOpening } from "./opening";
import { PHASES } from "./phase";

const SOURCE = readFileSync(
  new URL("../prompts/opening.md", import.meta.url), "utf8");

describe("L4 · 开场白", () => {
  it("阶段名被换进去，一个占位符都不许剩", () => {
    const text = renderOpening(SOURCE, "PRD", "producer")!;
    assert.match(text, /做 PRD/);
    assert.doesNotMatch(text, /\{\{/, "还有没换掉的占位符");
  });

  it("每个阶段都出得来，两个角色都出得来", () => {
    for (const phase of PHASES) {
      for (const role of ["producer", "blue"] as const) {
        const text = renderOpening(SOURCE, phase, role);
        assert.notEqual(text, null, `${phase}/${role} 出不来`);
        assert.ok(text!.trim().length > 40, `${phase}/${role} 太短，等于没有`);
        assert.match(text!, new RegExp(phase), `${phase}/${role} 里没提到阶段名`);
      }
    }
  });

  /*
   * **开场白里说得出名字的工具，必须真的存在。**
   *
   * 这段话是人原样粘进会话的 —— 里面写错一个工具名，模型会去调一个不存在的东西，
   * 而它多半会自己编一个答案继续走（2026-08-18 那次 `stagepass_next` 就是这么
   * 悄悄毁掉一整轮的）。和 `system/tool-names.test.ts` 同一族判据，这里管的是
   * 另一份语料。
   */
  it("提到的每个 stagepass_* 工具都在工具表里", () => {
    const registered = new Set(["stagepass_ask", "stagepass_brief", "stagepass_respond"]);
    const mentioned = new Set<string>();
    for (const phase of PHASES) {
      for (const role of ["producer", "blue"] as const) {
        for (const m of (renderOpening(SOURCE, phase, role) ?? "")
          .matchAll(/\bstagepass_[a-z_]+\b/g)) mentioned.add(m[0]);
      }
    }
    assert.notEqual(mentioned.size, 0, "一个工具名都没提到 —— 提取器空转了");
    assert.deepEqual([...mentioned].filter((one) => !registered.has(one)), []);
  });

  it("反方那份**不许**提到意见 —— 互盲盲的就是这一层", () => {
    const blue = renderOpening(SOURCE, "PRD", "blue")!;
    assert.match(blue, /看不到/);
    assert.match(blue, /role/, "得告诉它 role 要传什么，不然它拿到的是正方那份");
  });

  it("不认识的角色是 null，不退回一份别的", () => {
    assert.equal(renderOpening(SOURCE, "PRD", "judge" as never), null);
  });
});

/*
 * **开场白只认阶段名 —— 模板、产物、Change 一样都不需要。**
 *
 * 2026-08-19 用户截图：七个没有产物模板的阶段（TechSpec / Plan / Review / Fix /
 * Merge / Retro / Done）上写着「这个阶段还没有开场白」。原因是 `briefFor` 遇到
 * `no_template` 就整个提前返回，把一个跟它无关的东西顺手砍掉了。
 *
 * 这一条钉的是那件事本身：**没有模板的阶段，开场白照样出得来。**
 */
describe("L4 · 没有产物模板的阶段也有开场白", () => {
  it("十个阶段一个不落", () => {
    const missing = PHASES.filter((phase) =>
      (renderOpening(SOURCE, phase, "producer") ?? "").trim() === "");
    assert.deepEqual(missing, [], "这些阶段出不来开场白");
  });
});
