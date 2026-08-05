import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseModuleGraph, type ModuleFile } from "./module-graph";
import { reconcile, type ConceptMap } from "./reconcile";

/**
 * L1 · 两张图的对账（§5.4.4：全部价值在对账）。
 *
 * **这一层不生产概念图，只消费它** —— §5.8 第 1 条：宏观图一旦是从代码归纳出来的，
 * 就退化成微观图的摘要，对账永远绿。所以下面的概念图全是夹具，由「人 / Spec 轮」
 * 那一侧给出，这里只验比对逻辑对不对。
 *
 * 它也不判红：§5.8 第 6 条 —— 概念划分本身是主观的。出去的是**发现**。
 */
const files: ModuleFile[] = [
  { path: "domain/gate.ts", text: 'import { g } from "./gap";\nexport const gate = g;' },
  { path: "domain/gap.ts", text: "export const g = 1;" },
  { path: "store/gap-store.ts", text: 'import { g } from "../domain/gap";\nexport const s = g;' },
  { path: "web/panel.ts", text: 'import { gate } from "../domain/gate";\nexport const p = gate;' },
];
const graph = parseModuleGraph(files);

const map = (patch: Partial<ConceptMap> = {}): ConceptMap => ({
  concepts: [
    { id: "C-gate", name: "闸门" },
    { id: "C-gap", name: "问题" },
  ],
  relations: [{ from: "C-gate", to: "C-gap", why: "闸门读还开着哪些问题" }],
  serves: {
    "domain/gate.ts": ["C-gate"],
    "domain/gap.ts": ["C-gap"],
    "store/gap-store.ts": ["C-gap"],
    "web/panel.ts": ["C-gate"],
  },
  ...patch,
});

const kinds = (found: { kind: string }[]) => found.map((each) => each.kind);

describe("L1 · 一切对得上时，一条发现都没有", () => {
  it("概念都有归宿、模块都只服务一个、关系都实现了", () => {
    assert.deepEqual(reconcile(map(), graph), []);
  });
});

describe("L1 · ① 概念在代码里没有归宿 / 摊得太散", () => {
  it("**需求里有、代码里没有** —— 这条要在 Build 之前就报出来", () => {
    /*
     * 现成的实例是 §3.3·9：Blocker 契约只有 id/severity/title，而 Review 要求
     * 「文件和位置」—— 宏观图上 Blocker 显然该有「位置」，微观图上没有任何模块
     * 存它。以前是撞上了才发现。
     */
    const found = reconcile(map({
      concepts: [...map().concepts, { id: "C-where", name: "问题的位置" }],
    }), graph);
    assert.deepEqual(kinds(found), ["concept_homeless"]);
    assert.match(found[0]!.detail, /问题的位置/);
    assert.deepEqual(found[0]!.concepts, ["C-where"]);
  });

  it("摊到三个模块以上算散落，阈值可调", () => {
    const spread = map({
      serves: { ...map().serves, "web/panel.ts": ["C-gap"] },
    });
    // 默认阈值 3：gap 现在有 domain/gap、gap-store、panel 三个承载者。
    const found = reconcile(spread, graph).filter((each) => each.kind === "concept_scattered");
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.modules,
      ["domain/gap.ts", "store/gap-store.ts", "web/panel.ts"]);
    // 调高阈值就不报 —— 它是可调的观察，不是判据。
    assert.deepEqual(
      reconcile(spread, graph, { scatterAt: 4 })
        .filter((each) => each.kind === "concept_scattered"), []);
  });
});

describe("L1 · ② 模块承载太多概念 / 说不出自己服务谁", () => {
  it("**一个模块同时承载几个概念 = 该拆了** —— 比「文件太长」准得多", () => {
    const found = reconcile(map({
      serves: { ...map().serves, "web/panel.ts": ["C-gate", "C-gap"] },
    }), graph).filter((each) => each.kind === "module_overloaded");
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.modules, ["web/panel.ts"]);
    assert.match(found[0]!.detail, /闸门、问题/);
  });

  it("说不出服务于哪个概念 —— 那它没有存在理由（§5.2）", () => {
    const orphan = map({ serves: { ...map().serves, "web/panel.ts": [] } });
    const found = reconcile(orphan, graph).filter((each) => each.kind === "module_unclaimed");
    assert.deepEqual(found.map((each) => each.modules[0]), ["web/panel.ts"]);
  });
});

describe("L1 · ③ 两张图对不上的两个方向", () => {
  it("**宏观有关系、微观没依赖** —— 最危险的一类，因为它看着好好的", () => {
    // 把 gate 对 gap 的依赖去掉：关系还在概念图上，代码里没了。
    const detached = parseModuleGraph([
      { path: "domain/gate.ts", text: "export const gate = 1;" },
      ...files.slice(1),
    ]);
    const found = reconcile(map(), detached)
      .filter((each) => each.kind === "relation_unimplemented");
    assert.equal(found.length, 1);
    assert.match(found[0]!.detail, /闸门.*问题/);
    assert.match(found[0]!.detail, /闸门读还开着哪些问题/);
  });

  it("**微观有依赖、宏观没关系** —— 一条抄近路", () => {
    // 概念图上删掉那条关系，代码里的依赖还在。
    const found = reconcile(map({ relations: [] }), graph)
      .filter((each) => each.kind === "dependency_unplanned");
    /*
     * **只有跨概念的那条被报出来。** panel→gate 和 gap-store→gap 都是同一个概念
     * 内部的依赖，不算「宏观上该有一条关系」—— 下面那条测试单独钉这件事。
     */
    assert.deepEqual(found.map((each) => each.modules),
      [["domain/gate.ts", "domain/gap.ts"]]);
  });

  it("同一个概念内部的依赖不算跨概念关系 —— gap-store 依赖 gap 是自己人", () => {
    const found = reconcile(map(), graph)
      .filter((each) => each.kind === "dependency_unplanned");
    assert.deepEqual(found, []);
  });

  it("归属都没写的模块，先报「说不出服务谁」，不重复报成抄近路", () => {
    const found = reconcile(map({ serves: {} }), graph);
    assert.deepEqual([...new Set(kinds(found))].sort(),
      ["concept_homeless", "module_unclaimed"]);
  });
});
