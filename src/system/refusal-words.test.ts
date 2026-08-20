import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { REFUSAL_KINDS } from "../domain/gate";

/**
 * **闸门拒了人，界面必须说得出为什么。**
 *
 * 这条护栏是一次真实静默失灵的产物（2026-08-19）：`RefusalReason` 从字符串枚举扩成
 * 联合类型之后，`rubric_sheet_incomplete` 是个**对象**，而界面对 reason 做的是
 * **精确字符串相等**匹配 —— 一条都匹配不上。表现是：
 *
 *   · 裁决卡说「没有问题挡着闸门」，而 approve 悄悄不见了
 *   · 面板上显示 `[object Object]`
 *
 * **`tsc` 不红**（对象 !== 字符串是合法比较），**1276 条测试也不红**。
 * 和 `stagepass_next` 那次逐字同型：全绿，而链子断在层与层之间。
 *
 * 判据取的是 `REFUSAL_KINDS` 这个**运行时常量**，不是对源码做正则 —— 后者只证明
 * 字符串在文件里（TestPlan §四·1）。这里比的是两个名字集合。
 */
describe("standing · 每一种拒绝都有一句人话", () => {
  const panel = readFileSync(new URL("../web/panel.js", import.meta.url), "utf8");

  /** `GATE_REFUSAL_WORDS = { … }` 那个字面量里的键。 */
  function wordKeys(): readonly string[] {
    const start = panel.indexOf("const GATE_REFUSAL_WORDS = {");
    assert.notEqual(start, -1, "panel.js 里找不到 GATE_REFUSAL_WORDS —— 它是不是改名了？");
    const end = panel.indexOf("\n};", start);
    assert.notEqual(end, -1, "GATE_REFUSAL_WORDS 的字面量没有收口");
    return [...panel.slice(start, end).matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]!);
  }

  it("gate.ts 的每一支拒绝，panel.js 都翻得出人话", () => {
    const keys = new Set(wordKeys());
    const missing = REFUSAL_KINDS.filter((kind) => !keys.has(kind));
    assert.deepEqual(missing, [], `这几支拒绝在界面上没有人话：${missing.join(", ")}`);
  });

  /*
   * 提取器空转的话，上面那条永远绿。改名、搬家、换渲染方式都会让它悄悄变成零份 ——
   * 而「零份」和「全都盖到了」在断言上长得一模一样。
   */
  it("这条护栏不是空转的 —— 它确实读到了那张表", () => {
    assert.ok(wordKeys().length >= REFUSAL_KINDS.length);
  });

  it("对象那一支要摊得开，不能插成 [object Object]", () => {
    assert.match(panel, /const refusalWords = \(reason\) =>/);
    // 四个显示点都得走帮手，漏一个就是漏一处 [object Object]
    assert.equal([...panel.matchAll(/refusalWords\(/g)].length, 4);
  });
});
