import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectCode } from "./code-selection";
import { layout } from "./graph-layout";
import { parseModuleGraph, type ModuleFile } from "./module-graph";

/**
 * L0 · 布局（图谱 spec 2026-08-12）。
 *
 * 布局是纯函数，所以这里是 golden：同一张图永远摆出同一个场景。
 * 常量（SPACING=3、黄金角 2.39996、LAYER_GAP=26）在测试里重写一遍是**故意的** ——
 * 谁改了实现里的常量，这里当场红，坐标漂移不会静默溜过去。
 */
const file = (path: string, text: string): ModuleFile => ({ path, text });

/** demo 形状的缩小版：core ← view3d ⇄ game（互引，game→view3d 重）← tests。 */
const tree = () => parseModuleGraph([
  file("core/config.ts", "export const c = 1;\n"),
  file("core/geometry.ts", "export const g = 2;\n"),
  file("view3d/camera.ts", 'import { c } from "../core/config";\nexport const cam = c;\n'),
  file("view3d/rig.ts", [
    'import { c } from "../core/config";',
    'import { hud } from "../game/hud";',   // 反向的那条 —— 轻，会被破
    "export const rig = c + hud;",
  ].join("\n")),
  file("game/hud.ts", [
    'import { g } from "../core/geometry";',
    'import { c } from "../core/config";',   // config 被两层引 —— 它是更重的那个
    "export const hud = g + c;",
  ].join("\n")),
  file("game/player.ts", [
    'import { cam } from "../view3d/camera";',
    'import { rig } from "../view3d/rig";',  // game→view3d 两条，重，保住
    "export const p = cam + rig;",
  ].join("\n")),
  file("tests/player.test.ts", 'import { p } from "../game/player";\nexport const t = p;\n'),
]);

const selection = { code: [], assetDirs: [{ dir: "assets", files: 3 }], excluded: ["archive"] };

describe("L0 · 层：组、序、破环", () => {
  it("组 = 直接父目录，层序 = 拓扑（被依赖的在底下）", () => {
    const scene = layout(tree(), selection);
    assert.deepEqual(
      scene.layers.map((layer) => [layer.key, layer.index, layer.y]),
      [["core", 0, 0], ["view3d", 1, 26], ["game", 2, 52], ["tests", 3, 78]],
    );
  });

  it("**组间环按权重破，破的那条记在账上** —— 它是发现，不是布局的垃圾", () => {
    const scene = layout(tree(), selection);
    // view3d→game 1 条，game→view3d 2 条 —— 破轻的。
    assert.deepEqual(scene.brokenLayerEdges,
      [{ from: "view3d", to: "game", weight: 1 }]);
  });

  it("**被破那条边在场景里标成向上** —— 图上要另眼画的正是它", () => {
    const scene = layout(tree(), selection);
    const upward = scene.edges.filter((edge) => edge.upward);
    assert.deepEqual(
      upward.map((edge) => [scene.nodes[edge.from]!.path, scene.nodes[edge.to]!.path]),
      [["view3d/rig.ts", "game/hud.ts"]],
    );
  });
});

describe("L0 · 盘内：葵花螺旋，爆炸半径说话", () => {
  it("**盘心是最危险的那个** —— 每层第一个节点在爆炸半径最大处", () => {
    const scene = layout(tree(), selection);
    const core = scene.nodes.filter((node) => node.layer === 0);
    // config 波及 3 个（camera/rig/player…），geometry 波及 2 个 —— config 在前。
    assert.equal(core[0]!.path, "core/config.ts");
    assert.ok(core[0]!.blast > core[1]!.blast);
    // 第一个节点贴着盘心：r = 3·√0.55。
    const r0 = Math.hypot(core[0]!.x, core[0]!.z);
    assert.ok(Math.abs(r0 - 3 * Math.sqrt(0.55)) < 1e-9);
  });

  it("golden：第 k 个节点的极坐标就是公式本身", () => {
    const scene = layout(tree(), selection);
    const core = scene.nodes.filter((node) => node.layer === 0);
    for (const [k, node] of core.entries()) {
      const r = 3 * Math.sqrt(k + 0.55);
      const a = k * 2.39996;
      assert.ok(Math.abs(node.x - r * Math.cos(a)) < 1e-9, `节点 ${k} 的 x 漂了`);
      assert.ok(Math.abs(node.z - r * Math.sin(a)) < 1e-9, `节点 ${k} 的 z 漂了`);
      assert.equal(node.y, 0);
    }
  });

  it("盘半径 ∝ √n —— 密度各盘一致，不靠手调", () => {
    const scene = layout(tree(), selection);
    const core = scene.layers.find((layer) => layer.key === "core")!;
    assert.equal(core.radius, 3 * Math.sqrt(2) + 3);
  });
});

describe("L0 · 场景的完整性", () => {
  it("节点带齐画图要的数：出口、依赖、被依赖、爆炸半径、标注位", () => {
    const scene = layout(tree(), selection);
    const config = scene.nodes.find((node) => node.path === "core/config.ts")!;
    assert.equal(config.name, "config");
    assert.equal(config.exports, 1);
    assert.equal(config.deps, 0);
    assert.equal(config.dependents, 3);   // camera、rig、hud
    assert.deepEqual(config.marks, []);
  });

  it("**指向图外的边画成断头，不许丢** —— 残图要自己承认残", () => {
    const graph = parseModuleGraph([
      file("a.ts", 'import { x } from "./gone";\nexport const y = x;\n'),
    ]);
    const scene = layout(graph, selection);
    assert.deepEqual(scene.dangling, [{ from: 0, missing: "gone.ts" }]);
  });

  it("环点名到节点下标", () => {
    const graph = parseModuleGraph([
      file("x.ts", 'import { y } from "./y";\nexport const x = y;\n'),
      file("y.ts", 'import { x } from "./x";\nexport const y = x;\n'),
    ]);
    const scene = layout(graph, selection);
    assert.equal(scene.cycles.length, 1);
    assert.deepEqual(
      scene.cycles[0]!.map((index) => scene.nodes[index]!.path).sort(),
      ["x.ts", "y.ts"],
    );
  });

  it("门和勾选原样带回 —— 前端不重算判据", () => {
    const scene = layout(tree(), selection);
    assert.deepEqual(scene.assetDirs, [{ dir: "assets", files: 3 }]);
    assert.deepEqual(scene.excluded, ["archive"]);
  });

  it("selectCode 的产物直接可用 —— 两层之间没有翻译", () => {
    const picked = selectCode(["core/a.ts", "README.md"], []);
    const graph = parseModuleGraph([file("core/a.ts", "export const a = 1;\n")]);
    const scene = layout(graph, picked);
    assert.equal(scene.nodes.length, 1);
    assert.deepEqual(scene.assetDirs, [{ dir: ".", files: 1 }]);
  });
});
