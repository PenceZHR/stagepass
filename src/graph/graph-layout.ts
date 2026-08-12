import {
  blastRadiusOf, cyclesOf, dependenciesOf, dependentsOf,
  type EdgeKind, type ModuleGraph,
} from "./module-graph";
import type { Selection } from "./code-selection";
import { reconcile, type ConceptMap, type Finding } from "./reconcile";

/**
 * 把一张依赖图摆成三维场景：**层 = 环，引力 = 依赖方向，位置 = 危险度**。
 *
 * ## 为什么布局在服务端、是纯函数
 *
 * 纯函数才有 golden test —— 同一张图永远摆出同一个场景，坐标不会因为前端
 * 改了个常量悄悄漂。前端只负责画，一个数都不算。
 *
 * ## 形态：黑洞 + 同心环（用户 2026-08-12 定，换掉第一版的叠盘塔）
 *
 * 中心留一个洞（前端画黑洞），代码绕着它排成土星环。**引力就是依赖方向**：
 *
 * ```
 * 被依赖得越狠的层，环越靠内 —— 全树压在它身上，它离洞最近
 * tests 谁也不被依赖 —— 最外圈
 * 违规（依赖比自己外层的东西）= 向外爬的边，一眼能看出来
 * ```
 *
 * ## 三条布局规则
 *
 * 1. **组 = 文件的直接父目录。** demo 恰好得到 core/view3d/game/tests 四组，
 *    stagepass 得到 src 下九组 —— 两边都对，不用配置。
 * 2. **环序 = 组图的拓扑序**（全序：同级并列的组也排出先后，一组一条环带）。
 *    组图有环时按边的权重破，**保重的那条**，被破的边记进
 *    `brokenLayerEdges` —— 它本身就是一条发现，不是布局的垃圾。
 * 3. **环带内按爆炸半径降序、黄金角布点，重的沉向内缘** —— 引力隐喻的延伸：
 *    同一层里也越危险越靠洞。第 k 个（共 n 个）的半径
 *    `r = √(rᵢₙ² + (k+0.5)/n · (rₒᵤₜ² − rᵢₙ²))`，角 `a = k·黄金角`；
 *    环带外缘按**每节点等面积**长大（`rₒᵤₜ = √(rᵢₙ² + n·AREA/π)`），
 *    于是所有环带的密度一致，不靠手调。
 *
 * 坐标系：全部节点在 y=0 的平面上，环在 x/z —— 土星环是平的。
 */

/** 中心洞的半径 —— 前端的黑洞画在这里面，代码不许进来。 */
const HOLE_RADIUS = 11;
/** 相邻环带之间的空隙。 */
const RING_GAP = 5;
/** 每个节点在环带里占的面积。改它整张图等比疏密，别的什么都不变。 */
const NODE_AREA = 26;
/** 黄金角（弧度）。任何 n 下都不出现放射状的空条。 */
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
  /** 0 = 最内圈 = 被依赖得最狠的那层。 */
  readonly index: number;
  /** 环带内缘。第 0 环的内缘就是洞的边。 */
  readonly inner: number;
  /** 环带外缘。 */
  readonly radius: number;
  /** 恒为 0 —— 土星环是平的。留着是给第二阶段的立体标注用。 */
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

  // 全序：先按层号，同层按组名 —— 同级并列的组也一组一条环带，不叠在一起。
  const groupKeys = [...weights.keys()].sort((a, b) =>
    (level.get(a)! - level.get(b)!) || a.localeCompare(b));
  const layerIndex = new Map(groupKeys.map((key, index) => [key, index]));

  // 环带内排序：爆炸半径降序，同数按路径 —— 重的沉向内缘，结果确定。
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
  const layers: SceneLayer[] = [];
  let inner = HOLE_RADIUS + RING_GAP;
  for (const key of groupKeys) {
    const entries = byLayer.get(key) ?? [];
    const index = layerIndex.get(key)!;
    // 每节点等面积长大：所有环带密度一致，不靠手调。空组也占一条细缝，
    // 免得「一层消失了」和「一层是空的」在图上分不开。
    const outer = Math.sqrt(inner * inner + Math.max(entries.length, 1) * NODE_AREA / Math.PI);
    for (const [k, entry] of entries.entries()) {
      const r = Math.sqrt(
        inner * inner + ((k + 0.5) / entries.length) * (outer * outer - inner * inner));
      const a = k * GOLDEN_ANGLE;
      const node = graph.modules.find((module) => module.path === entry.path)!;
      indexOf.set(entry.path, nodes.length);
      nodes.push({
        path: entry.path,
        name: entry.path.slice(entry.path.lastIndexOf("/") + 1)
          .replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, ""),
        layer: index,
        x: r * Math.cos(a),
        y: 0,
        z: r * Math.sin(a),
        exports: node.exports.length,
        deps: dependenciesOf(graph, entry.path).length,
        dependents: dependentsOf(graph, entry.path).length,
        blast: entry.blast,
        marks: [],
      });
    }
    layers.push({ key, index, inner, radius: outer, y: 0, count: entries.length });
    inner = outer + RING_GAP;
  }

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

/** 规划层悬浮的高度。真实的星在 y=0 的环面上，规划的幽灵星飘在它们头顶。 */
const PLAN_ALTITUDE = 14;

export interface PlanConcept {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 承载它的真实节点（SceneModel.nodes 下标）。 */
  readonly carriers: readonly number[];
  /** 需求里有它、代码里没有 —— reconcile 的 concept_homeless。 */
  readonly homeless: boolean;
}

export interface PlanRelation {
  readonly from: number;
  readonly to: number;
  readonly why: string;
  /** 承载两头的模块之间真的有依赖。false = 关系没实现，或一头是幽灵。 */
  readonly implemented: boolean;
}

export interface PlanOverlay {
  readonly concepts: readonly PlanConcept[];
  readonly relations: readonly PlanRelation[];
  /** 真实节点的对账标注：下标 → FindingKind 子集（unclaimed / overloaded / scattered）。 */
  readonly nodeMarks: Readonly<Record<number, readonly string[]>>;
  /** 计划外的依赖（代码有、图上没有）：真实节点下标对。 */
  readonly unplanned: readonly { from: number; to: number }[];
  /** reconcile 的原话，给侧栏逐条读。 */
  readonly findings: readonly Finding[];
}

/**
 * 把 Arch 的概念图叠到已经摆好的场景上（BACKLOG §十一：架构必须可视化）。
 *
 * ## 摆法：规划层悬在真实层上方
 *
 * - 有归宿的概念摆在**承载它的那些星的重心正上方**（y = PLAN_ALTITUDE）——
 *   概念和它的实现在一条垂线上，抬头就能对上
 * - 无归宿的概念（needs 里有、代码里没有）摆在**最外环再往外一圈**的
 *   规划轨道上 —— 它们还没落地，所以不在任何环带里
 * - 关系两头都有承载且微观真有依赖 = implemented；否则是虚的
 *
 * 纯函数：场景 + 图 + 概念图进，叠影出。对账本身是 `reconcile()` 的活，
 * 这里只把它的发现翻译成坐标和标注 —— 同一份发现，侧栏读原话、图上看位置。
 */
export function overlayPlan(
  scene: SceneModel,
  graph: ModuleGraph,
  map: ConceptMap,
): PlanOverlay {
  const findings = reconcile(map, graph);
  const indexOf = new Map(scene.nodes.map((node, index) => [node.path, index]));

  const carriersOf = new Map<string, number[]>(
    map.concepts.map((concept) => [concept.id, []]));
  for (const [path, ids] of Object.entries(map.serves)) {
    const index = indexOf.get(path);
    if (index === undefined) continue;
    for (const id of ids) carriersOf.get(id)?.push(index);
  }

  const outermost = Math.max(14, ...scene.layers.map((layer) => layer.radius));
  let strays = 0;
  const concepts: PlanConcept[] = map.concepts.map((concept) => {
    const carriers = [...(carriersOf.get(concept.id) ?? [])].sort((a, b) => a - b);
    if (carriers.length === 0) {
      // 规划轨道：黄金角错开，和环带里的星同一套节奏。
      const angle = strays * 2.39996;
      strays += 1;
      return {
        id: concept.id, name: concept.name,
        x: (outermost + 10) * Math.cos(angle),
        y: PLAN_ALTITUDE,
        z: (outermost + 10) * Math.sin(angle),
        carriers, homeless: true,
      };
    }
    const x = carriers.reduce((sum, index) => sum + scene.nodes[index]!.x, 0) / carriers.length;
    const z = carriers.reduce((sum, index) => sum + scene.nodes[index]!.z, 0) / carriers.length;
    return {
      id: concept.id, name: concept.name,
      x, y: PLAN_ALTITUDE, z, carriers, homeless: false,
    };
  });
  const conceptIndex = new Map(concepts.map((concept, index) => [concept.id, index]));

  const unimplemented = new Set(
    findings.filter((finding) => finding.kind === "relation_unimplemented")
      .map((finding) => `${finding.concepts[0]}>${finding.concepts[1]}`));
  const relations: PlanRelation[] = map.relations
    .filter((relation) => conceptIndex.has(relation.from) && conceptIndex.has(relation.to))
    .map((relation) => ({
      from: conceptIndex.get(relation.from)!,
      to: conceptIndex.get(relation.to)!,
      why: relation.why,
      implemented: !unimplemented.has(`${relation.from}>${relation.to}`)
        && !concepts[conceptIndex.get(relation.from)!]!.homeless
        && !concepts[conceptIndex.get(relation.to)!]!.homeless,
    }));

  const nodeMarks: Record<number, string[]> = {};
  const mark = (path: string, kind: string): void => {
    const index = indexOf.get(path);
    if (index === undefined) return;
    nodeMarks[index] = [...(nodeMarks[index] ?? []), kind];
  };
  for (const finding of findings) {
    if (finding.kind === "module_unclaimed" || finding.kind === "module_overloaded"
      || finding.kind === "concept_scattered") {
      for (const path of finding.modules) mark(path, finding.kind);
    }
  }

  const unplanned = findings
    .filter((finding) => finding.kind === "dependency_unplanned")
    .flatMap((finding) => {
      const from = indexOf.get(finding.modules[0] ?? "");
      const to = indexOf.get(finding.modules[1] ?? "");
      return from === undefined || to === undefined ? [] : [{ from, to }];
    });

  return { concepts, relations, nodeMarks, unplanned, findings };
}
