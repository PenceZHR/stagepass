import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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
