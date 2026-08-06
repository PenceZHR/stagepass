import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseModuleGraph, type ModuleFile } from "./module-graph";
import { ingredientsFor, ModuleNotInGraphError, renderIngredients } from "./ingredients";

/**
 * L0 · 配料单：派轮给一个模块时，喂进去的东西由图**确定性地**算出来（§5.4.1）。
 *
 * ```
 * G 里每个模块的完整正文
 * + G 直接依赖的模块的【接口签名】—— 只给签名，不给实现
 * + 谁依赖 G（所以它知道自己不能乱改签名）
 * ```
 *
 * **「只给签名不给实现」是防耦合的真正机关**：看不见实现，就写不出依赖实现细节的
 * 代码 —— 这不是概率上更不容易，是物理上做不到。下面第一组就是在钉这个机关。
 *
 * 而 §5.4.2 说它必须是可测的：给定图和一个模块组，喂进去的内容**唯一确定**。
 */
const files: ModuleFile[] = [
  {
    path: "domain/gate.ts",
    text: [
      "/** 闸门。 */",
      'import type { Phase } from "./phase";',
      "export interface Gate { readonly permitted: readonly string[] }",
      "export function computeGate(phase: Phase, evidence: number): Gate {",
      "  const SECRET_IMPLEMENTATION_DETAIL = evidence * 42;",
      "  return { permitted: [String(phase), String(SECRET_IMPLEMENTATION_DETAIL)] };",
      "}",
      "export const EMPTY: Gate = { permitted: [] };",
    ].join("\n"),
  },
  {
    path: "domain/phase.ts",
    text: [
      "export type Phase = \"PRD\" | \"Spec\";",
      "export function advancesTo(phase: Phase): Phase | null {",
      "  const TABLE_ONLY_PHASE_KNOWS = { PRD: \"Spec\", Spec: null } as const;",
      "  return TABLE_ONLY_PHASE_KNOWS[phase];",
      "}",
    ].join("\n"),
  },
  {
    path: "web/panel-server.ts",
    text: [
      'import { computeGate } from "../domain/gate";',
      "export const handle = () => computeGate(\"PRD\", 1);",
    ].join("\n"),
  },
];

const graph = parseModuleGraph(files);
const bag = (group: string[]) => ingredientsFor({ graph, files, group });

describe("L0 · 只给签名，不给实现（那个机关）", () => {
  it("**依赖的实现一个字都不许进来**", () => {
    const text = renderIngredients(bag(["domain/gate.ts"]));
    // gate 依赖 phase，所以 advancesTo 的签名要在……
    assert.match(text, /advancesTo\(phase: Phase\): Phase \| null/);
    // ……而它的函数体不许在。
    assert.ok(!text.includes("TABLE_ONLY_PHASE_KNOWS"), "依赖的实现漏进配料单了");
  });

  it("**组里自己的模块给完整正文** —— 要改它，得看得见全部", () => {
    const text = renderIngredients(bag(["domain/gate.ts"]));
    assert.ok(text.includes("SECRET_IMPLEMENTATION_DETAIL"), "自己的实现应当在");
  });

  it("类型和接口整份给 —— 它们本身就是契约，没有「实现」可藏", () => {
    const text = renderIngredients(bag(["web/panel-server.ts"]));
    /*
     * 断言只认内容，不认排版：签名是**编译器重新打印**出来的（`removeComments`），
     * 所以接口会被规范成多行 —— 那正是要的效果，源码里花括号内的注释也因此
     * 进不来（第一版用 `getText()`，把成员上十几行讲不变量的 JSDoc 一起带出来了）。
     */
    assert.match(text, /export interface Gate \{/);
    assert.match(text, /readonly permitted: readonly string\[\];/);
  });

  it("常量只给它声明的类型，不给它的值", () => {
    const text = renderIngredients(bag(["web/panel-server.ts"]));
    assert.match(text, /const EMPTY: Gate/);
    assert.ok(!text.includes("permitted: [] }"), "常量的值漏进来了");
  });
});

describe("L0 · 配料单的四样东西各就各位", () => {
  it("自己、直接依赖、谁依赖我 —— 三份名单都由图算出来", () => {
    const list = bag(["domain/gate.ts"]);
    assert.deepEqual(list.own.map((each) => each.path), ["domain/gate.ts"]);
    assert.deepEqual(list.dependencies.map((each) => each.path), ["domain/phase.ts"]);
    // **谁依赖我**：改签名之前得知道会砸到谁（§5.4.1）。
    assert.deepEqual(list.dependents, ["web/panel-server.ts"]);
  });

  it("一组多个模块：组内互相依赖不重复算成「外部依赖」", () => {
    const list = bag(["domain/gate.ts", "domain/phase.ts"]);
    assert.deepEqual(list.own.map((each) => each.path).sort(),
      ["domain/gate.ts", "domain/phase.ts"]);
    assert.deepEqual(list.dependencies, []);
    assert.deepEqual(list.dependents, ["web/panel-server.ts"]);
  });

  it("**全局约束跟着一起进去** —— 那些规则模型不知道就会违反", () => {
    const text = renderIngredients(bag(["domain/gate.ts"]));
    assert.match(text, /只许往下依赖/);
    assert.match(text, /不许成环/);
  });

  it("组里点了一个图上没有的模块 —— 报出来，不静默当成空", () => {
    assert.throws(() => bag(["domain/nope.ts"]), (error: unknown) => {
      // 认类型不认消息：**这个错是契约的一部分**（调用方要能 catch 它），
      // 而一个只被正则匹配过的导出，在孤儿护栏眼里等于没人用。
      assert.ok(error instanceof ModuleNotInGraphError);
      assert.equal(error.path, "domain/nope.ts");
      return true;
    });
  });
});

describe("L0 · 它省下的是「无关内容」，不是字数（§5.7）", () => {
  /*
   * **判据是「无关的实现在不在里面」，不是「省了几个字」。**
   *
   * 第一版这里比的是长度，而在这个三模块的夹具上配料单比全树还长（832 vs 664）
   * —— 抬头、围栏、约束那几行样板占了大头。那不是设计的问题，是**尺度问题**：
   * §5.7 那个 72× 是 48 个模块的真树量出来的。所以长度那一半改到真树上去量
   * （`architecture.test.ts` 有一条护栏盯着），这里只钉语义。
   */
  it("和这次改动无关的模块，实现一个字都不进来", () => {
    const text = renderIngredients(bag(["domain/gate.ts"]));
    // panel-server 依赖 gate，但改 gate 不需要看见 panel-server 的实现。
    assert.ok(!text.includes("handle = () =>"), "无关模块的实现漏进来了");
    // 它只该以「谁依赖你」的名字出现。
    assert.match(text, /web\/panel-server\.ts/);
  });
});
