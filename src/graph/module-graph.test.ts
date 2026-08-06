import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blastRadiusOf, dependentsOf,
  closureOf,
  dependenciesOf,
  parseModuleGraph,
  type ModuleFile,
} from "./module-graph";

/**
 * L0 · 真依赖图，用真编译器解析（BACKLOG §5.5.3 / §5.10）。
 *
 * §5.5.3 是整条反馈链路最要紧的一条：**反馈的信号源必须是代码本身，不是 Review
 * 的意见**。那就要求「代码到底依赖了谁」这件事是解析出来的事实，而不是数出来的
 * 近似 —— §5.10 记着：本次量数据用的正则只够量结构，**不够当护栏**。
 *
 * 下面每一条都是正则真会答错的地方。
 */
const file = (path: string, text: string): ModuleFile => ({ path, text });

describe("L0 · 正则答错、编译器答对的那几处", () => {
  it("**只有副作用的 import 也是依赖** —— 它没有 from，正则整条看不见", () => {
    const graph = parseModuleGraph([
      file("a.ts", `import "./boot";\n`),
      file("boot.ts", "export {};\n"),
    ]);
    assert.deepEqual(dependenciesOf(graph, "a.ts"), ["boot.ts"]);
    assert.equal(graph.modules[0]?.imports[0]?.kind, "side-effect");
  });

  it("**注释和字符串里的 from 不算依赖** —— 正则会把它当真", () => {
    const graph = parseModuleGraph([
      file("a.ts", [
        '// 历史：这里原来是 from "./old-thing"',
        'const sample = \'import { x } from "./not-real"\';',
        "export const keep = sample;",
      ].join("\n")),
    ]);
    assert.deepEqual(dependenciesOf(graph, "a.ts"), []);
  });

  it("动态 import() 也是依赖", () => {
    const graph = parseModuleGraph([
      file("a.ts", "export const load = () => import(\"./late\");\n"),
      file("late.ts", "export const x = 1;\n"),
    ]);
    assert.deepEqual(dependenciesOf(graph, "a.ts"), ["late.ts"]);
    assert.equal(graph.modules[0]?.imports[0]?.kind, "dynamic");
  });

  it("`export … from` 是再导出，既是依赖也是出口", () => {
    const graph = parseModuleGraph([
      file("a.ts", 'export { thing } from "./other";\n'),
      file("other.ts", "export const thing = 1;\n"),
    ]);
    assert.deepEqual(dependenciesOf(graph, "a.ts"), ["other.ts"]);
    assert.equal(graph.modules[0]?.imports[0]?.kind, "re-export");
    assert.deepEqual(graph.modules[0]?.exports.map((each) => each.name), ["thing"]);
  });

  it("**只用于类型的 import 单独标出来** —— 它编译后就没了，爆炸半径不一样", () => {
    const graph = parseModuleGraph([
      file("a.ts", 'import type { T } from "./t";\nexport type U = T;\n'),
      file("t.ts", "export type T = 1;\n"),
    ]);
    assert.equal(graph.modules[0]?.imports[0]?.kind, "type");
    // 依赖照算 —— 改 t.ts 的类型一样会波及 a.ts。
    assert.deepEqual(dependenciesOf(graph, "a.ts"), ["t.ts"]);
  });

  it("外部包不进图 —— 这张图问的是「我们自己的模块之间」", () => {
    const graph = parseModuleGraph([
      file("a.ts", 'import ts from "typescript";\nimport { x } from "./b";\nexport const y = x;\n'),
      file("b.ts", "export const x = 1;\n"),
    ]);
    assert.deepEqual(dependenciesOf(graph, "a.ts"), ["b.ts"]);
  });
});

describe("L0 · 路径解析和出口清单", () => {
  it("相对路径按所在目录解，`..` 逐级弹出", () => {
    const graph = parseModuleGraph([
      file("web/panel-server.ts", 'import { p } from "../domain/phase";\nexport const q = p;\n'),
      file("domain/phase.ts", "export const p = 1;\n"),
    ]);
    assert.deepEqual(dependenciesOf(graph, "web/panel-server.ts"), ["domain/phase.ts"]);
  });

  it("指向图外的相对路径 —— 记下来但不当成边（图里没有那个节点）", () => {
    const graph = parseModuleGraph([
      file("a.ts", 'import { x } from "./nowhere";\nexport const y = x;\n'),
    ]);
    assert.deepEqual(dependenciesOf(graph, "a.ts"), []);
    assert.deepEqual(graph.unresolved, [{ from: "a.ts", missing: "nowhere.ts" }]);
  });

  it("出口清单带种类 —— 配料单要靠它说「这个模块对外提供什么」", () => {
    const graph = parseModuleGraph([file("a.ts", [
      "export function run() { return 1; }",
      "export const value = 2;",
      "export class Thing {}",
      "export type Shape = { a: number };",
      "export interface Other { b: string }",
      "function hidden() { return 3; }",
      "export default hidden;",
    ].join("\n"))]);
    assert.deepEqual(
      graph.modules[0]?.exports.map((each) => [each.name, each.kind]),
      [
        ["run", "function"], ["value", "const"], ["Thing", "class"],
        ["Shape", "type"], ["Other", "interface"], ["default", "default"],
      ],
    );
  });
});

describe("L0 · 闭包 —— 「改这个模块，波及多远」", () => {
  const chain = () => parseModuleGraph([
    file("a.ts", 'import { b } from "./b";\nexport const x = b;\n'),
    file("b.ts", 'import { c } from "./c";\nexport const b = c;\n'),
    file("c.ts", "export const c = 1;\n"),
    file("loner.ts", "export const alone = 1;\n"),
  ]);

  it("传递闭包，含自己", () => {
    assert.deepEqual(closureOf(chain(), "a.ts").sort(), ["a.ts", "b.ts", "c.ts"]);
    assert.deepEqual(closureOf(chain(), "loner.ts"), ["loner.ts"]);
  });

  it("**环不会把它转死** —— 环是真实存在的，遇到就停，不是抛", () => {
    const cyclic = parseModuleGraph([
      file("a.ts", 'import { b } from "./b";\nexport const a = b;\n'),
      file("b.ts", 'import { a } from "./a";\nexport const b = a;\n'),
    ]);
    assert.deepEqual(closureOf(cyclic, "a.ts").sort(), ["a.ts", "b.ts"]);
  });
});

/**
 * **爆炸半径和依赖闭包是两个方向，而它们在真树上几乎是反的。**
 *
 * `closureOf` 的注释原来写着「改这个模块，最多波及多远」—— 而它走的是
 * `dependenciesOf`（我依赖谁），答的其实是「要动它我得读多少」。
 * 2026-08-06 在真树上量出来：
 *
 * ```
 *                       closureOf   blastRadiusOf
 * domain/phase.ts             1          39
 * web/panel-server.ts        51           0
 * ```
 *
 * 一个量错方向的指标比没有指标更贵：`panel-server` 会显得「碰不得」，而真正
 * 碰不得的 `domain/phase.ts` 看着人畜无害。
 */
describe("爆炸半径：改它会砸到谁（反方向）", () => {
  /** 一条链加一个旁支：`leaf` 谁都不依赖，却是所有人的地基。 */
  const graph = parseModuleGraph([
    { path: "leaf.ts", text: "export const a = 1;" },
    { path: "mid.ts", text: `import { a } from "./leaf";\nexport const b = a;` },
    { path: "top.ts", text: `import { b } from "./mid";\nexport const c = b;` },
    { path: "side.ts", text: `import { a } from "./leaf";\nexport const d = a;` },
    {
      path: "app.ts",
      text: `import { c } from "./top";\nimport { d } from "./side";\nexport const e = c + d;`,
    },
  ]);

  it("**直接依赖我的** —— 改签名当场编译不过的那些人", () => {
    assert.deepEqual(dependentsOf(graph, "leaf.ts"), ["mid.ts", "side.ts"]);
    assert.deepEqual(dependentsOf(graph, "app.ts"), []);
  });

  it("**传递波及的** —— 不含自己", () => {
    assert.deepEqual(
      blastRadiusOf(graph, "leaf.ts"), ["app.ts", "mid.ts", "side.ts", "top.ts"]);
    assert.deepEqual(blastRadiusOf(graph, "app.ts"), []);
  });

  /**
   * 这一条是那个 bug 的回归测试：**同一个模块，两个方向的数必须能差得很远**。
   * 谁要是把 `blastRadiusOf` 又写成正向，这里当场红。
   */
  it("**两个方向不是同一件事** —— 叶子的闭包最小、爆炸半径最大", () => {
    // leaf 谁都不依赖（闭包只有自己），却波及全部四个。
    assert.deepEqual(closureOf(graph, "leaf.ts"), ["leaf.ts"]);
    assert.equal(blastRadiusOf(graph, "leaf.ts").length, 4);
    // app 读遍全树，却一个人都砸不到。
    assert.equal(closureOf(graph, "app.ts").length, 5);
    assert.equal(blastRadiusOf(graph, "app.ts").length, 0);
  });

  it("有环也不死 —— 环是真实可能存在的，另有护栏盯它", () => {
    const cyclic = parseModuleGraph([
      { path: "x.ts", text: `import { y } from "./y";\nexport const x = y;` },
      { path: "y.ts", text: `import { x } from "./x";\nexport const y = x;` },
    ]);
    assert.deepEqual(blastRadiusOf(cyclic, "x.ts"), ["y.ts"]);
  });
});
