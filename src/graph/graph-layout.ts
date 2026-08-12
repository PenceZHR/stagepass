import {
  blastRadiusOf, cyclesOf, dependenciesOf, dependentsOf,
  type EdgeKind, type ModuleGraph,
} from "./module-graph";
import type { Selection } from "./code-selection";

/**
 * 把一张依赖图摆成三维场景：**层 = 盘，高度 = 依赖方向，位置 = 危险度**。
 *
 * ## 为什么布局在服务端、是纯函数
 *
 * 纯函数才有 golden test —— 同一张图永远摆出同一个场景，坐标不会因为前端
 * 改了个常量悄悄漂。前端只负责画，一个数都不算。
 *
 * ## 三条布局规则（图谱 spec 2026-08-12）
 *
 * 1. **组 = 文件的直接父目录。** demo 恰好得到 core/view3d/game/tests 四组，
 *    stagepass 得到 src 下九组 —— 两边都对，不用配置。
 * 2. **层序 = 组图的拓扑序**（全序：同级并列的组也排出先后，免得两张盘叠在
 *    同一个高度上）。组图有环时按边的权重破，**保重的那条**，被破的边记进
 *    `brokenLayerEdges` —— 它本身就是一条发现，不是布局的垃圾。
 * 3. **盘内位置 = 葵花螺旋，按爆炸半径降序** —— 越靠盘心越危险，位置本身在
 *    说话。第 k 个节点 `r = SPACING·√(k+0.55)`、`a = k·黄金角`，
 *    于是盘半径 `∝ √n`，节点密度各盘一致。
 *
 * 坐标系：y 向上（层的高度），盘面在 x/z 平面 —— three.js 的习惯，前端照画。
 */

/** 盘内节点间距。改它整张图等比缩放，别的什么都不变。 */
const SPACING = 3;
/** 相邻两张盘的高度差。 */
const LAYER_GAP = 26;
/** 黄金角（弧度）。葵花籽就是这么排的 —— 任何 n 下都不出现放射状的空条。 */
const GOLDEN_ANGLE = 2.39996;

export interface SceneNode {
  readonly path: string;
  /** 文件名去后缀 —— 标签用。 */
  readonly name: string;
  /** 所在盘的序号，0 = 最底。 */
  readonly layer: number;
  readonly x: number;
  /** 向上。同一张盘上的节点同一个 y。 */
  readonly y: number;
  readonly z: number;
  readonly exports: number;
  readonly deps: number;
  readonly dependents: number;
  readonly blast: number;
  /** 第二阶段的标注位（touched/fed/drift）。这一轮恒为空。 */
  readonly marks: readonly string[];
}

export interface SceneLayer {
  /** 组名，就是目录：`assets/scripts/core`。 */
  readonly key: string;
  readonly index: number;
  readonly radius: number;
  readonly y: number;
  readonly count: number;
}

export interface SceneEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: EdgeKind;
  /** 指向更高的盘 —— 「只许往下依赖」的反例，图上要另眼画。 */
  readonly upward: boolean;
}

export interface SceneModel {
  readonly layers: readonly SceneLayer[];
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
  /** 指向图外的边 —— 残图的缺口，画成断头的边，不许丢。 */
  readonly dangling: readonly { from: number; missing: string }[];
  /** 环（节点下标串）。按层摆的图会把环伪装成两条无辜的边，必须点名。 */
  readonly cycles: readonly (readonly number[])[];
  /** 排层时被破掉的组间边 —— 组图里的环，本身就是一条发现。 */
  readonly brokenLayerEdges: readonly { from: string; to: string; weight: number }[];
  readonly assetDirs: readonly { dir: string; files: number }[];
  readonly excluded: readonly string[];
}

/** `a/b/c.ts` → `a/b`；根下的文件归 `"."`。 */
const groupOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";

/**
 * 组图排层。返回每组的层号（0 = 最底 = 谁都不依赖）和被破的边。
 *
 * 破环的判据是**权重**：`game→view3d` 12 条、`view3d→game` 5 条（demo 实测），
 * 破轻的那条 —— 12 条边代表的方向更接近这棵树想说的话。同重按名字，结果确定。
 */
function orderGroups(
  weights: Map<string, Map<string, number>>,
): {
  level: Map<string, number>;
  broken: { from: string; to: string; weight: number }[];
} {
  const broken: { from: string; to: string; weight: number }[] = [];
  const edges = new Map<string, Map<string, number>>();
  for (const [from, to] of weights) edges.set(from, new Map(to));

  // 找一个环（DFS）；找不到返回 null。
  const findCycle = (): string[] | null => {
    const state = new Map<string, "open" | "done">();
    const stack: string[] = [];
    let cycle: string[] | null = null;
    const walk = (node: string): void => {
      if (cycle !== null || state.get(node) === "done") return;
      if (state.get(node) === "open") {
        const at = stack.indexOf(node);
        if (at >= 0) cycle = stack.slice(at);
        return;
      }
      state.set(node, "open");
      stack.push(node);
      for (const next of [...(edges.get(node) ?? new Map<string, number>()).keys()].sort()) {
        walk(next);
      }
      stack.pop();
      state.set(node, "done");
    };
    for (const node of [...edges.keys()].sort()) walk(node);
    return cycle;
  };

  for (let guard = edges.size * edges.size + 1; guard > 0; guard -= 1) {
    const cycle = findCycle();
    if (cycle === null) break;
    // 环上最轻的一条（同重按名字）—— 破它。
    let lightest: { from: string; to: string; weight: number } | null = null;
    for (let i = 0; i < cycle.length; i += 1) {
      const from = cycle[i]!;
      const to = cycle[(i + 1) % cycle.length]!;
      const weight = edges.get(from)?.get(to) ?? 0;
      if (
        lightest === null || weight < lightest.weight
        || (weight === lightest.weight
          && `${from}->${to}` < `${lightest.from}->${lightest.to}`)
      ) {
        lightest = { from, to, weight };
      }
    }
    broken.push(lightest!);
    edges.get(lightest!.from)!.delete(lightest!.to);
  }

  // 无环了：层号 = 依赖链的最长深度。
  const level = new Map<string, number>();
  const depthOf = (node: string): number => {
    const known = level.get(node);
    if (known !== undefined) return known;
    level.set(node, 0); // 占位 —— guard 之外的保险，不该被读到
    const deps = [...(edges.get(node) ?? new Map<string, number>()).keys()];
    const depth = deps.length === 0
      ? 0
      : 1 + Math.max(...deps.map(depthOf));
    level.set(node, depth);
    return depth;
  };
  for (const node of edges.keys()) depthOf(node);
  return { level, broken };
}

export function layout(graph: ModuleGraph, selection: Selection): SceneModel {
  const paths = graph.modules.map((module) => module.path);

  // 组间边的权重（组内的不算）。
  const weights = new Map<string, Map<string, number>>();
  for (const path of paths) {
    if (!weights.has(groupOf(path))) weights.set(groupOf(path), new Map());
  }
  for (const module of graph.modules) {
    const from = groupOf(module.path);
    for (const edge of module.imports) {
      const to = groupOf(edge.to);
      if (from === to) continue;
      const row = weights.get(from)!;
      row.set(to, (row.get(to) ?? 0) + 1);
    }
  }

  const { level, broken } = orderGroups(weights);

  // 全序：先按层号，同层按组名 —— 同级并列的组也一组一张盘，不叠在一个高度。
  const groupKeys = [...weights.keys()].sort((a, b) =>
    (level.get(a)! - level.get(b)!) || a.localeCompare(b));
  const layerIndex = new Map(groupKeys.map((key, index) => [key, index]));

  // 盘内排序：爆炸半径降序，同数按路径 —— 位置说话，结果确定。
  const measured = paths.map((path) => ({
    path,
    blast: blastRadiusOf(graph, path).length,
  }));
  const byLayer = new Map<string, { path: string; blast: number }[]>();
  for (const entry of measured) {
    const key = groupOf(entry.path);
    byLayer.set(key, [...(byLayer.get(key) ?? []), entry]);
  }
  for (const entries of byLayer.values()) {
    entries.sort((a, b) => (b.blast - a.blast) || a.path.localeCompare(b.path));
  }

  const nodes: SceneNode[] = [];
  const indexOf = new Map<string, number>();
  const layers: SceneLayer[] = groupKeys.map((key) => {
    const entries = byLayer.get(key) ?? [];
    const index = layerIndex.get(key)!;
    const y = index * LAYER_GAP;
    for (const [k, entry] of entries.entries()) {
      const r = SPACING * Math.sqrt(k + 0.55);
      const a = k * GOLDEN_ANGLE;
      const node = graph.modules.find((module) => module.path === entry.path)!;
      indexOf.set(entry.path, nodes.length);
      nodes.push({
        path: entry.path,
        name: entry.path.slice(entry.path.lastIndexOf("/") + 1)
          .replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, ""),
        layer: index,
        x: r * Math.cos(a),
        y,
        z: r * Math.sin(a),
        exports: node.exports.length,
        deps: dependenciesOf(graph, entry.path).length,
        dependents: dependentsOf(graph, entry.path).length,
        blast: entry.blast,
        marks: [],
      });
    }
    return {
      key,
      index,
      radius: SPACING * Math.sqrt(entries.length) + SPACING,
      y,
      count: entries.length,
    };
  });

  const edges: SceneEdge[] = [];
  for (const module of graph.modules) {
    const from = indexOf.get(module.path)!;
    const seen = new Set<string>();
    for (const edge of module.imports) {
      // 同一对模块之间可能有好几条 import —— 场景里一条就够，种类取第一条。
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const to = indexOf.get(edge.to);
      if (to === undefined) continue;
      edges.push({
        from, to, kind: edge.kind,
        upward: nodes[to]!.layer > nodes[from]!.layer,
      });
    }
  }

  return {
    layers,
    nodes,
    edges,
    dangling: graph.unresolved
      .filter((entry) => indexOf.has(entry.from))
      .map((entry) => ({ from: indexOf.get(entry.from)!, missing: entry.missing })),
    cycles: cyclesOf(graph)
      .map((cycle) => cycle.map((path) => indexOf.get(path)!)),
    brokenLayerEdges: broken,
    assetDirs: selection.assetDirs,
    excluded: selection.excluded,
  };
}
