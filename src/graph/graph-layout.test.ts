import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectCode } from "./code-selection";
import { layout, overlayPlan } from "./graph-layout";
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

describe("L0 · 环：组、序、破环", () => {
  it("组 = 直接父目录，环序 = 拓扑（被依赖得最狠的贴着洞）", () => {
    const scene = layout(tree(), selection);
    assert.deepEqual(
      scene.layers.map((layer) => [layer.key, layer.index]),
      [["core", 0], ["view3d", 1], ["game", 2], ["tests", 3]],
    );
    // 土星环是平的。
    assert.ok(scene.layers.every((layer) => layer.y === 0));
    assert.ok(scene.nodes.every((node) => node.y === 0));
  });

  it("golden：环带嵌套 —— 第 0 环内缘贴洞，后一环内缘 = 前一环外缘 + 缝", () => {
    const scene = layout(tree(), selection);
    assert.equal(scene.layers[0]!.inner, 16);   // HOLE 11 + GAP 5
    for (const [i, layer] of scene.layers.entries()) {
      assert.ok(layer.radius > layer.inner, `${layer.key} 的环带没有宽度`);
      if (i > 0) {
        assert.ok(Math.abs(layer.inner - (scene.layers[i - 1]!.radius + 5)) < 1e-9,
          `${layer.key} 的内缘漂了`);
      }
    }
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

describe("L0 · 环带内：重的沉向内缘，密度各环一致", () => {
  it("**离洞最近的是最危险的那个** —— 每环第一个节点爆炸半径最大、半径最小", () => {
    const scene = layout(tree(), selection);
    const core = scene.nodes.filter((node) => node.layer === 0);
    // config 被两层引，geometry 只被一层 —— config 在前、更靠洞。
    assert.equal(core[0]!.path, "core/config.ts");
    assert.ok(core[0]!.blast > core[1]!.blast);
    assert.ok(
      Math.hypot(core[0]!.x, core[0]!.z) < Math.hypot(core[1]!.x, core[1]!.z));
  });

  it("golden：第 k 个节点的极坐标就是公式本身", () => {
    const scene = layout(tree(), selection);
    const ring = scene.layers[0]!;
    const core = scene.nodes.filter((node) => node.layer === 0);
    for (const [k, node] of core.entries()) {
      const r = Math.sqrt(ring.inner ** 2
        + ((k + 0.5) / core.length) * (ring.radius ** 2 - ring.inner ** 2));
      const a = k * 2.39996;
      assert.ok(Math.abs(node.x - r * Math.cos(a)) < 1e-9, `节点 ${k} 的 x 漂了`);
      assert.ok(Math.abs(node.z - r * Math.sin(a)) < 1e-9, `节点 ${k} 的 z 漂了`);
    }
  });

  it("golden：环带按每节点等面积长大 —— 密度不靠手调", () => {
    const scene = layout(tree(), selection);
    for (const ring of scene.layers) {
      const area = Math.PI * (ring.radius ** 2 - ring.inner ** 2);
      assert.ok(Math.abs(area - ring.count * 26) < 1e-6,
        `${ring.key} 的环带面积漂了：${area}`);
    }
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

describe("L0 · overlayPlan：规划层悬在真实层上方（BACKLOG §十一）", () => {
  const scene = () => layout(tree(), selection);
  const graphOf = () => tree();
  const map = {
    concepts: [
      { id: "cfg", name: "配置" },
      { id: "play", name: "玩法" },
      { id: "dream", name: "还没做的" },
    ],
    relations: [
      { from: "play", to: "cfg", why: "玩法读配置" },
      { from: "dream", to: "cfg", why: "幽灵的关系" },
    ],
    serves: {
      "core/config.ts": ["cfg"],
      "core/geometry.ts": ["cfg"],
      "game/player.ts": ["play"],
    },
  };

  it("有归宿的概念悬在承载者重心正上方；幽灵挂在规划轨道上", () => {
    const plan = overlayPlan(scene(), graphOf(), map);
    const cfg = plan.concepts.find((concept) => concept.id === "cfg")!;
    assert.equal(cfg.homeless, false);
    assert.equal(cfg.y, 14);
    // 重心：两个承载者坐标的平均。
    const s = scene();
    const carriers = cfg.carriers.map((index) => s.nodes[index]!);
    assert.ok(Math.abs(cfg.x - (carriers[0]!.x + carriers[1]!.x) / 2) < 1e-9);
    const dream = plan.concepts.find((concept) => concept.id === "dream")!;
    assert.equal(dream.homeless, true);
    assert.ok(Math.hypot(dream.x, dream.z) > Math.max(...s.layers.map((l) => l.radius)),
      "幽灵概念必须在最外环之外的规划轨道上");
  });

  it("关系分实现与虚：真有依赖的实线，幽灵参与的一律虚", () => {
    const plan = overlayPlan(scene(), graphOf(), map);
    const real = plan.relations.find((relation) => relation.why === "玩法读配置")!;
    // game/player.ts import 了 view3d，没直接 import core/config —— 看真图。
    // tree() 里 player 只引 camera/rig，所以这条关系其实没实现 —— 虚。
    assert.equal(real.implemented, false);
    const ghost = plan.relations.find((relation) => relation.why === "幽灵的关系")!;
    assert.equal(ghost.implemented, false);
  });

  it("对账标注落到节点下标上：无主模块被点名", () => {
    const plan = overlayPlan(scene(), graphOf(), map);
    const s = scene();
    const unclaimedIndexes = Object.entries(plan.nodeMarks)
      .filter(([, kinds]) => kinds.includes("module_unclaimed"))
      .map(([index]) => s.nodes[Number(index)]!.path);
    // serves 只认领了三个文件 —— 其余全是无主。
    assert.ok(unclaimedIndexes.includes("view3d/camera.ts"));
    assert.ok(!unclaimedIndexes.includes("core/config.ts"));
  });

  it("findings 原话带回 —— 侧栏读的和图上画的是同一份", () => {
    const plan = overlayPlan(scene(), graphOf(), map);
    assert.ok(plan.findings.some((finding) => finding.kind === "concept_homeless"));
  });
});
