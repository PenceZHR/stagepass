import tsc from "typescript";

import { dependentsOf, dependenciesOf, type ModuleFile, type ModuleGraph } from "./module-graph";

/**
 * 配料单：派轮给一个模块组时，喂进去的东西**由图确定性地算出来**（§5.4.1）。
 *
 * ```
 * G 里每个模块的完整正文        要改它，就得看得见全部
 * + G 直接依赖的【接口签名】     只给签名，不给实现  ← 机关在这儿
 * + 谁依赖 G                    所以它知道自己不能乱改签名
 * + 全局约束                    只许往下依赖、不许成环
 * ```
 *
 * ## 「只给签名不给实现」是防耦合的真正机关
 *
 * 看不见实现，就写不出依赖实现细节的代码。**这不是概率上更不容易，是物理上做不到**
 * —— 比任何 rubric 都硬，因为 rubric 判的是「它这么做了没有」，而这个是「它做不到」。
 *
 * ## 为什么不做成向量召回（§5.4.2）
 *
 * 代码的依赖不是「相似的东西」，是**确定的东西**：图上写着。所以检索退化成图遍历，
 * 而这带来一个决定性差别 —— **向量召回不全，你不知道；图遍历不全，会红。**
 * 配料单因此可测：给定图和一个模块组，喂进去的内容唯一确定。
 *
 * ## 一处刻意的取舍：依赖那半份**不带注释**
 *
 * 只给签名的话，被依赖模块的 JSDoc 严格说也不算实现。但**这棵树的注释里装着大量
 * 实现细节和历史**（每个模块开头那几段就是），把它们放进来，机关当场漏光。
 * 所以这一版一个注释都不带 —— 类型名和签名自己说话。
 * 哪天注释被拆成「契约」和「实现笔记」两类，这条可以放宽。
 */

export interface IngredientList {
  /** 组里的模块，**完整正文**。 */
  readonly own: readonly { path: string; text: string }[];
  /** 直接依赖的模块，**只有导出的签名**。 */
  readonly dependencies: readonly { path: string; signatures: readonly string[] }[];
  /** 谁依赖这个组 —— 改签名会砸到的那些人。 */
  readonly dependents: readonly string[];
}

export class ModuleNotInGraphError extends Error {
  constructor(readonly path: string) {
    super(`不在图上的模块：${path}`);
    this.name = "ModuleNotInGraphError";
  }
}

/**
 * 一条导出的**签名**，函数体一律砍掉。
 *
 * 判据按种类分，而不是「去掉花括号」：
 *
 * ```
 * 函数 / 方法      砍掉函数体，留 (参数): 返回类型
 * 类               留类名和成员签名，每个方法体照砍
 * const            留声明的类型；**没写类型的只留名字** —— 值就是实现
 * type/interface   整份留着：它们本身就是契约，没有实现可藏
 * ```
 */
function signatureOf(node: tsc.Statement, source: tsc.SourceFile): string | null {
  /*
   * **用编译器的打印器，不用 `getText()`。**
   *
   * 2026-08-05 在真树上看输出才发现的两个洞，两个都是 `getText()` 带出来的：
   *
   * 1. 它把节点自己的 `export` 修饰符也带上，前面再拼一个就成了 `export export`
   * 2. **它把花括号里的注释一起带出来** —— `ChangeState` 那个接口的成员上挂着
   *    十几行讲不变量和历史的 JSDoc，整段漏进了配料单。而这个文件开头刚写着
   *    「依赖那半份不带注释」，理由正是这棵树的注释装着实现细节。
   *
   * `removeComments` 的打印器两个一起解决：它从 AST 重新打印，注释不在 AST 上。
   */
  const printer = tsc.createPrinter({ removeComments: true });
  const text = (from: tsc.Node): string =>
    printer.printNode(tsc.EmitHint.Unspecified, from, source);

  if (tsc.isTypeAliasDeclaration(node) || tsc.isInterfaceDeclaration(node)
    || tsc.isEnumDeclaration(node)) {
    // 打印器已经带上 `export` 了，不再拼。
    return text(node);
  }

  if (tsc.isFunctionDeclaration(node) && node.name) {
    const params = node.parameters.map(text).join(", ");
    const returns = node.type ? `: ${text(node.type)}` : "";
    return `export function ${node.name.text}(${params})${returns};`;
  }

  if (tsc.isClassDeclaration(node) && node.name) {
    const members = node.members.flatMap((member) => {
      if (tsc.isMethodDeclaration(member) && member.name) {
        const params = member.parameters.map(text).join(", ");
        const returns = member.type ? `: ${text(member.type)}` : "";
        return [`  ${text(member.name)}(${params})${returns};`];
      }
      if (tsc.isConstructorDeclaration(member)) {
        return [`  constructor(${member.parameters.map(text).join(", ")});`];
      }
      if (tsc.isPropertyDeclaration(member) && member.name) {
        // 属性的**初始值是实现** —— 只留声明的类型。
        const declared = member.type ? `: ${text(member.type)}` : "";
        return [`  ${text(member.name)}${declared};`];
      }
      return [];
    });
    return `export class ${node.name.text} {\n${members.join("\n")}\n}`;
  }

  if (tsc.isVariableStatement(node)) {
    const lines = node.declarationList.declarations.flatMap((declaration) => {
      if (!tsc.isIdentifier(declaration.name)) return [];
      // **没写类型注解的只留名字**：那个初始值就是它的实现，给出去机关就漏了。
      return [declaration.type
        ? `export const ${declaration.name.text}: ${text(declaration.type)};`
        : `export const ${declaration.name.text};`];
    });
    return lines.length === 0 ? null : lines.join("\n");
  }

  return null;
}

const isExported = (node: tsc.Statement): boolean =>
  tsc.canHaveModifiers(node)
  && (tsc.getModifiers(node) ?? [])
    .some((modifier) => modifier.kind === tsc.SyntaxKind.ExportKeyword);

/**
 * 一个模块对外的全部签名。**不带注释** —— 理由见文件开头那段取舍。
 *
 * 不导出：现在只有 `ingredientsFor` 用它。这棵树的规矩是「没有调用方的东西不许
 * 存在」（护栏第一时间就红了），真有第二个用处时再放出去。
 */
function signaturesOf(file: ModuleFile): string[] {
  const source = tsc.createSourceFile(
    file.path, file.text, tsc.ScriptTarget.Latest, true, tsc.ScriptKind.TS,
  );
  const out: string[] = [];
  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    const signature = signatureOf(statement, source);
    if (signature !== null) out.push(signature);
  }
  return out;
}

export function ingredientsFor(input: {
  graph: ModuleGraph;
  files: readonly ModuleFile[];
  group: readonly string[];
}): IngredientList {
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  for (const path of input.group) {
    // 点了一个图上没有的模块 —— 报出来。静默当成空，配料单就少一块而没人知道，
    // 而「图遍历不全会红」正是这条路相对向量召回的全部优势（§5.4.2）。
    if (!byPath.has(path)) throw new ModuleNotInGraphError(path);
  }
  const inGroup = new Set(input.group);

  const own = input.group.map((path) => ({ path, text: byPath.get(path)!.text }));

  // 组内互相依赖不算「外部依赖」：它们的正文本来就全在这份配料单里。
  const outward = new Set<string>();
  for (const path of input.group) {
    for (const target of dependenciesOf(input.graph, path)) {
      if (!inGroup.has(target)) outward.add(target);
    }
  }
  const dependencies = [...outward].sort().map((path) => ({
    path,
    signatures: signaturesOf(byPath.get(path)!),
  }));

  /*
   * 「谁依赖你」= **直接**依赖（`dependentsOf`，一份实现）。
   *
   * 这里要的就是直接那一层：这句话是说给「别乱改签名」听的，而改签名当场编译
   * 不过的正是直接 import 它的人。传递的那一圈是 `blastRadiusOf`，它答的是另一个
   * 问题（改它一共会疼多少人），不该混进这份名单里让模型以为都要顾。
   */
  const dependents = [...new Set(
    [...inGroup].flatMap((path) => dependentsOf(input.graph, path)),
  )].filter((path) => !inGroup.has(path)).sort();

  return { own, dependencies, dependents };
}

/**
 * 全局约束。**跟着每一份配料单走** —— 这些规则模型不知道就会违反，而它们不写在
 * 任何一个模块里（写在护栏里，而护栏模型看不见）。
 */
const CONSTRAINTS = [
  "- **只许往下依赖**：低层不许 import 高层。层次表在 `src/architecture.test.ts`。",
  "- **不许成环**：两个模块互相 import 是架构问题，不是风格问题。",
  "- 要新增一条图上没有的依赖边，那不是模块问题，是架构问题 —— **停手，报上来**。",
];

/** 配料单渲染成喂给模型的那段文本。形状固定，所以可回放、可比对。 */
export function renderIngredients(list: IngredientList): string {
  const parts: string[] = [];

  parts.push("## 你要改的模块（完整正文）");
  for (const module of list.own) {
    parts.push(`\n### ${module.path}\n`, "```ts", module.text, "```");
  }

  if (list.dependencies.length > 0) {
    parts.push(
      "\n## 它依赖的模块 —— **只有签名，没有实现**",
      "看不见实现是有意的：依赖实现细节的代码，这样就写不出来。"
      + "需要知道某个依赖内部怎么做的，说明这次改动的边界画错了 —— 报上来。",
    );
    for (const dependency of list.dependencies) {
      parts.push(`\n### ${dependency.path}\n`, "```ts",
        dependency.signatures.join("\n"), "```");
    }
  }

  parts.push("\n## 谁依赖你");
  parts.push(list.dependents.length === 0
    ? "没有人依赖这一组 —— 改它的签名不会砸到别人。"
    : `${list.dependents.join("、")}\n**改签名之前先想清楚这些人**。`);

  parts.push("\n## 全局约束", ...CONSTRAINTS);
  return parts.join("\n");
}
