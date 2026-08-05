import tsc from "typescript";

/**
 * 这棵树的**真依赖图**，用真编译器解析出来。
 *
 * ## 为什么必须是真解析器
 *
 * §5.5.3 是整条反馈链路最要紧的一条：**反馈的信号源必须是代码本身，不是 Review
 * 的意见**。粗架构 → 粗反馈 → 粗修正会锁死在粗的层面，破法是从跑出来的真实代码
 * 解析出真实依赖图，和架构图比对 —— **差异本身就是最细的反馈**。
 *
 * 那就要求「代码到底依赖了谁」是**解析出来的事实**，不是数出来的近似。
 * §5.10 早就写着：量数据那次用的正则只够量结构，**不够当护栏**。
 *
 * 正则真会答错的地方（`module-graph.test.ts` 一条一条钉着）：
 *
 * ```
 * import "./boot"              没有 from    → 正则整条看不见，而它是真依赖
 * // 原来是 from "./old"       在注释里     → 正则当真，凭空多一条边
 * await import("./late")       动态         → 看不见
 * ```
 *
 * ## 这一层是纯的
 *
 * 进来的是 `{path, text}`，出去的是图。不碰文件系统 —— 谁去读盘是调用方的事，
 * 而「这段代码依赖谁」可以完全离线证明。
 */

export interface ModuleFile {
  /** 仓库相对路径，带 `.ts`，用 `/` 分隔。图里的节点名就是它。 */
  readonly path: string;
  readonly text: string;
}

/**
 * 一条依赖边的种类。**爆炸半径不一样，所以要分开记。**
 *
 * - `type` 编译后就没了（运行时零耦合），但改了被依赖的类型照样波及这边
 * - `side-effect` 没有名字可言，只有「加载它」这件事
 * - `dynamic` 运行时才加载，静态分析看得见、执行顺序看不见
 */
export type EdgeKind = "value" | "type" | "side-effect" | "dynamic" | "re-export";

export interface ModuleEdge {
  readonly to: string;
  readonly kind: EdgeKind;
  /** 这条边上取了哪几个名字。`side-effect` / `dynamic` 是空的。 */
  readonly names: readonly string[];
}

export type ExportKind =
  | "function" | "const" | "class" | "type" | "interface" | "enum"
  | "re-export" | "default" | "star";

export interface ExportedSymbol {
  readonly name: string;
  readonly kind: ExportKind;
}

export interface ModuleNode {
  readonly path: string;
  readonly imports: readonly ModuleEdge[];
  readonly exports: readonly ExportedSymbol[];
}

export interface ModuleGraph {
  readonly modules: readonly ModuleNode[];
  /**
   * 指向图外的边。**记下来而不是丢掉** —— 一条落空的边意味着图不完整，而一张
   * 自称完整的残图比没有图更糟（对账会把缺口读成「这里没有依赖」）。
   *
   * 记的是**解析之后的路径**而不是源码里那一串：要回答的问题是「图里缺哪个节点」，
   * `../domain/phase` 这种原文还要读的人自己再算一次。
   */
  readonly unresolved: readonly { from: string; missing: string }[];
}

/** `a/b/c.ts` + `../d/e` → `a/d/e.ts`。只认相对路径，别的都是外部包。 */
function resolve(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const directory = fromPath.includes("/")
    ? fromPath.slice(0, fromPath.lastIndexOf("/"))
    : "";
  const parts = (directory ? `${directory}/${specifier}` : specifier).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const joined = out.join("/");
  return joined.endsWith(".ts") ? joined : `${joined}.ts`;
}

/** `import`/`export … from` 上那一串名字。取本地名之外的原名（`a as b` 取 `a`）。 */
function namesOf(clause: tsc.ImportClause | tsc.NamedExportBindings | undefined): string[] {
  if (clause === undefined) return [];
  const names: string[] = [];
  if (tsc.isImportClause(clause)) {
    if (clause.name) names.push("default");
    const bindings = clause.namedBindings;
    if (bindings && tsc.isNamespaceImport(bindings)) names.push("*");
    if (bindings && tsc.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        names.push((element.propertyName ?? element.name).text);
      }
    }
    return names;
  }
  if (tsc.isNamedExports(clause)) {
    for (const element of clause.elements) {
      names.push((element.propertyName ?? element.name).text);
    }
  }
  if (tsc.isNamespaceExport(clause)) names.push("*");
  return names;
}

function exportKindOf(node: tsc.Statement): ExportKind | null {
  if (tsc.isFunctionDeclaration(node)) return "function";
  if (tsc.isClassDeclaration(node)) return "class";
  if (tsc.isTypeAliasDeclaration(node)) return "type";
  if (tsc.isInterfaceDeclaration(node)) return "interface";
  if (tsc.isEnumDeclaration(node)) return "enum";
  if (tsc.isVariableStatement(node)) return "const";
  return null;
}

const isExported = (node: tsc.Statement): boolean =>
  tsc.canHaveModifiers(node)
  && (tsc.getModifiers(node) ?? [])
    .some((modifier) => modifier.kind === tsc.SyntaxKind.ExportKeyword);

function readModule(file: ModuleFile): {
  node: ModuleNode; unresolved: { from: string; missing: string }[];
} {
  const source = tsc.createSourceFile(
    file.path, file.text, tsc.ScriptTarget.Latest, true, tsc.ScriptKind.TS,
  );
  const imports: ModuleEdge[] = [];
  const exports: ExportedSymbol[] = [];
  const unresolved: { from: string; missing: string }[] = [];

  const edge = (specifier: string, kind: EdgeKind, names: string[]): void => {
    const to = resolve(file.path, specifier);
    // 外部包不进图 —— 这张图问的是「我们自己的模块之间」。
    if (to === null) return;
    imports.push({ to, kind, names });
  };

  for (const statement of source.statements) {
    if (tsc.isImportDeclaration(statement)
      && tsc.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      edge(
        specifier,
        clause === undefined ? "side-effect" : clause.isTypeOnly ? "type" : "value",
        namesOf(clause),
      );
      continue;
    }
    if (tsc.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && tsc.isStringLiteral(statement.moduleSpecifier)) {
        const names = namesOf(statement.exportClause);
        edge(statement.moduleSpecifier.text, "re-export", names);
        for (const name of names) {
          exports.push({ name, kind: name === "*" ? "star" : "re-export" });
        }
      } else if (statement.exportClause && tsc.isNamedExports(statement.exportClause)) {
        // `export { a, b }` —— 本地的东西换个门出去，不是依赖。
        for (const element of statement.exportClause.elements) {
          exports.push({ name: element.name.text, kind: "re-export" });
        }
      }
      continue;
    }
    if (tsc.isExportAssignment(statement)) {
      exports.push({ name: "default", kind: "default" });
      continue;
    }
    if (!isExported(statement)) continue;
    const kind = exportKindOf(statement);
    if (kind === null) continue;
    const isDefault = tsc.canHaveModifiers(statement)
      && (tsc.getModifiers(statement) ?? [])
        .some((modifier) => modifier.kind === tsc.SyntaxKind.DefaultKeyword);
    if (isDefault) {
      exports.push({ name: "default", kind: "default" });
      continue;
    }
    if (tsc.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (tsc.isIdentifier(declaration.name)) {
          exports.push({ name: declaration.name.text, kind: "const" });
        }
      }
      continue;
    }
    const named = (statement as { name?: tsc.Identifier }).name;
    if (named) exports.push({ name: named.text, kind });
  }

  /*
   * 动态 `import("…")` 藏在表达式里，不在顶层语句上，所以单独走一遍 AST。
   * **它是真依赖** —— 正则那一版整条看不见。
   */
  const walk = (node: tsc.Node): void => {
    if (tsc.isCallExpression(node)
      && node.expression.kind === tsc.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first && tsc.isStringLiteral(first)) edge(first.text, "dynamic", []);
    }
    tsc.forEachChild(node, walk);
  };
  walk(source);

  return { node: { path: file.path, imports, exports }, unresolved };
}

export function parseModuleGraph(files: readonly ModuleFile[]): ModuleGraph {
  const known = new Set(files.map((file) => file.path));
  const modules: ModuleNode[] = [];
  const unresolved: { from: string; missing: string }[] = [];

  for (const file of files) {
    const read = readModule(file);
    const kept: ModuleEdge[] = [];
    for (const each of read.node.imports) {
      // 图外的边记进 unresolved：一张自称完整的残图比没有图更糟。
      if (known.has(each.to)) kept.push(each);
      else unresolved.push({ from: file.path, missing: each.to });
    }
    modules.push({ ...read.node, imports: kept });
  }
  return { modules, unresolved };
}

/** 这个模块**直接**依赖谁。去重、排序 —— 同一个模块可以被 import 好几次。 */
export function dependenciesOf(graph: ModuleGraph, path: string): string[] {
  const node = graph.modules.find((each) => each.path === path);
  if (!node) return [];
  return [...new Set(node.imports.map((edge) => edge.to))].sort();
}

/**
 * 传递闭包，**含它自己** —— 「改这个模块，最多波及多远」。
 *
 * 环不抛：环是这棵树里真实可能存在的东西（架构护栏另有一条盯着它），
 * 遇到访问过的就停。一个量爆炸半径的函数不该因为量到了环就死掉。
 */
export function closureOf(graph: ModuleGraph, path: string): string[] {
  const seen = new Set<string>();
  const queue = [path];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...dependenciesOf(graph, current));
  }
  return [...seen];
}
