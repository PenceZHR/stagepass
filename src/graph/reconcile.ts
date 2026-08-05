import { dependenciesOf, type ModuleGraph } from "./module-graph";

/**
 * 两张图的**对账** —— §5.4.4：「全部价值在对账」。
 *
 * ```
 * 宏观图（概念）   属于 Spec —— 概念是需求层面的
 * 微观图（模块）   属于 TechSpec —— 从真代码解析（`module-graph.ts`）
 * 对账             两个阶段的衔接第一次是机械的（§5.4.5）
 * ```
 *
 * ## 这一层**不生产概念图**，只消费它
 *
 * §5.8 第 1 条风险写得最硬：**宏观图一旦是从代码归纳出来的，就退化成微观图的
 * 摘要，对账永远绿。** 所以概念图必须先有、或由不同轮次独立产出（§5.3·1：
 * TechSpec / TestPlan 起就产出图谱），而这个文件只做比对。
 *
 * 它也不判对错：§5.8 第 6 条 ——「概念划分本身是主观的，所以宏观图不能像护栏那样
 * 判红。**对账可以机械做，画图不能。**」所以出去的是**发现**，不是失败。
 *
 * ## 这一层是纯的
 *
 * 两张图进来，一份发现清单出去。不碰文件系统、不碰库。
 */

export interface Concept {
  /** 稳定标识。概念改名不该让所有归属失效，所以名字之外要有 id。 */
  readonly id: string;
  readonly name: string;
}

export interface ConceptRelation {
  readonly from: string;
  readonly to: string;
  /** 这条关系是什么。**人读的**，对账只看有没有，不解析它。 */
  readonly why: string;
}

export interface ConceptMap {
  readonly concepts: readonly Concept[];
  readonly relations: readonly ConceptRelation[];
  /**
   * 模块 → 它服务的概念（id）。
   *
   * §5.2 那个空缺：**每个模块必须能说出它服务于哪个概念，说不出来的就是没有
   * 存在理由的模块。** 所以这张表缺了谁，本身就是一条发现。
   */
  readonly serves: Readonly<Record<string, readonly string[]>>;
}

/** 一条发现的种类。名字对着 §5.4.4 的三类，外加 §5.2 那条。 */
export type FindingKind =
  /** ① 概念没有任何模块承载 —— 它在需求里存在，在代码里不存在 */
  | "concept_homeless"
  /** ① 概念摊在太多模块上 —— 改它一次要动好几处 */
  | "concept_scattered"
  /** ② 模块承载了好几个概念 —— 「该拆了」的机械判据 */
  | "module_overloaded"
  /** ②' 模块说不出自己服务哪个概念 —— §5.2：那它没有存在理由 */
  | "module_unclaimed"
  /** ③ 宏观有关系、微观没依赖 —— 关系没实现，或者靠约定俗成维持 */
  | "relation_unimplemented"
  /** ③ 微观有依赖、宏观没关系 —— 一条计划外的依赖，多半是抄近路 */
  | "dependency_unplanned";

export interface Finding {
  readonly kind: FindingKind;
  /** 一句话说清是什么。**给人读的** —— 对账不判红，它摊事实。 */
  readonly detail: string;
  /** 牵涉到的模块（有几个算几个）。 */
  readonly modules: readonly string[];
  /** 牵涉到的概念 id。 */
  readonly concepts: readonly string[];
}

export interface ReconcileOptions {
  /**
   * 一个概念摊到几个模块上才算「散落」。
   *
   * 默认 3：两个模块合起来实现一个概念是常态（比如一份领域逻辑加一张表），
   * 三个起才值得看一眼。**这是个可调的阈值，不是判据** —— 判据是人看完之后
   * 觉得它散不散。
   */
  readonly scatterAt?: number;
}

export function reconcile(
  map: ConceptMap,
  graph: ModuleGraph,
  options: ReconcileOptions = {},
): Finding[] {
  const scatterAt = options.scatterAt ?? 3;
  const findings: Finding[] = [];
  const conceptName = new Map(map.concepts.map((each) => [each.id, each.name]));

  /** 概念 → 承载它的模块。只算图上真存在的模块。 */
  const modulesOf = new Map<string, string[]>(
    map.concepts.map((concept) => [concept.id, []]),
  );
  for (const [path, ids] of Object.entries(map.serves)) {
    if (!graph.modules.some((module) => module.path === path)) continue;
    for (const id of ids) modulesOf.get(id)?.push(path);
  }

  // ① 概念无归宿 / 散落
  for (const concept of map.concepts) {
    const carriers = (modulesOf.get(concept.id) ?? []).sort();
    if (carriers.length === 0) {
      findings.push({
        kind: "concept_homeless",
        detail: `概念「${concept.name}」在代码里没有归宿 —— 需求里有它，没有任何模块承载。`,
        modules: [], concepts: [concept.id],
      });
      continue;
    }
    if (carriers.length >= scatterAt) {
      findings.push({
        kind: "concept_scattered",
        detail: `概念「${concept.name}」摊在 ${carriers.length} 个模块上 —— 改它一次要动好几处。`,
        modules: carriers, concepts: [concept.id],
      });
    }
  }

  // ② 模块承载太多概念 / 说不出自己服务谁
  for (const module of [...graph.modules].sort((a, b) => a.path.localeCompare(b.path))) {
    const ids = (map.serves[module.path] ?? []).filter((id) => conceptName.has(id));
    if (ids.length === 0) {
      findings.push({
        kind: "module_unclaimed",
        detail: `模块 ${module.path} 说不出它服务于哪个概念 —— 那它没有存在理由（§5.2）。`,
        modules: [module.path], concepts: [],
      });
      continue;
    }
    if (ids.length >= 2) {
      const names = ids.map((id) => conceptName.get(id) ?? id).join("、");
      findings.push({
        kind: "module_overloaded",
        detail: `模块 ${module.path} 同时承载 ${ids.length} 个概念（${names}）`
          + ` —— 「该拆了」的机械判据，比「文件太长」准得多。`,
        modules: [module.path], concepts: ids,
      });
    }
  }

  /** 微观上，承载 a 的模块里有没有谁依赖承载 b 的模块。 */
  const linked = (from: string, to: string): boolean => {
    for (const source of modulesOf.get(from) ?? []) {
      const targets = new Set(dependenciesOf(graph, source));
      if ((modulesOf.get(to) ?? []).some((path) => targets.has(path))) return true;
    }
    return false;
  };

  // ③ 宏观有关系、微观没依赖 —— **最危险的一类，因为它看着好好的**
  for (const relation of map.relations) {
    if (!conceptName.has(relation.from) || !conceptName.has(relation.to)) continue;
    /*
     * **两头有一头压根没人承载时，不在这儿报。**
     *
     * 那时「关系没实现」和「概念无归宿」说的是同一件事，而根因是后者 ——
     * 一个概念在代码里不存在，它的每一条关系都会跟着报一遍，把一条发现放大成
     * 五条。对账的价值在于人愿意读完它。
     */
    if ((modulesOf.get(relation.from) ?? []).length === 0) continue;
    if ((modulesOf.get(relation.to) ?? []).length === 0) continue;
    if (linked(relation.from, relation.to)) continue;
    findings.push({
      kind: "relation_unimplemented",
      detail: `宏观图上「${conceptName.get(relation.from)}」→「${conceptName.get(relation.to)}」`
        + `（${relation.why}），而承载它们的模块之间没有任何依赖`
        + ` —— 关系没实现，或者靠约定俗成维持。`,
      modules: [], concepts: [relation.from, relation.to],
    });
  }

  // ③ 微观有依赖、宏观没关系 —— 一条计划外的依赖，多半是抄近路
  const related = new Set(map.relations.map((each) => `${each.from}>${each.to}`));
  const conceptsOf = (path: string): string[] =>
    (map.serves[path] ?? []).filter((id) => conceptName.has(id));
  for (const module of [...graph.modules].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const target of dependenciesOf(graph, module.path)) {
      const from = conceptsOf(module.path);
      const to = conceptsOf(target);
      if (from.length === 0 || to.length === 0) continue;   // 归属都没有，先报上面那条
      // 同一个概念内部的依赖不算跨概念的关系。
      const crossing = from.flatMap((a) => to.filter((b) => a !== b).map((b) => [a, b] as const));
      if (crossing.length === 0) continue;
      if (crossing.some(([a, b]) => related.has(`${a}>${b}`))) continue;
      findings.push({
        kind: "dependency_unplanned",
        detail: `${module.path} → ${target}：代码里有这条依赖，而宏观图上`
          + `「${from.map((id) => conceptName.get(id)).join("/")}」和`
          + `「${to.map((id) => conceptName.get(id)).join("/")}」之间没有关系`
          + ` —— 一条计划外的依赖，多半是抄近路。`,
        modules: [module.path, target],
        concepts: [...new Set([...from, ...to])],
      });
    }
  }

  return findings;
}
