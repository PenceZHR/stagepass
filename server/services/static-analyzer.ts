import ts from "typescript";
import fs from "fs";
import path from "path";
import { createChildLogger } from "../logger";

const log = createChildLogger("static-analyzer");

export interface ExportInfo {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "enum";
  signature?: string;
}

export interface ImportInfo {
  from: string;
  names: string[];
}

export interface ClassInfo {
  name: string;
  methods: Array<{ name: string; signature: string }>;
  implements?: string[];
}

export interface FileAnalysis {
  filePath: string;
  exports: ExportInfo[];
  imports: ImportInfo[];
  classes: ClassInfo[];
}

export interface RouteInfo {
  method: string;
  path: string;
  file: string;
}

export interface PageInfo {
  path: string;
  file: string;
}

export interface AnalysisResult {
  tree: string;
  coreFiles: FileAnalysis[];
  peripheralFiles: FileAnalysis[];
  dependencyGraph: Map<string, string[]>;
  routes: RouteInfo[];
  pages: PageInfo[];
}

export interface ProgressCallback {
  (stage: string, file?: string): void;
}

const IGNORE_DIRS = new Set([
  "node_modules", ".next", ".git", ".ship", "dist", "build", "coverage", ".turbo",
]);

const CORE_PATTERNS = [
  /^server\/services\/.*\.ts$/,
  /^server\/db\/.*\.ts$/,
  /^server\/types\/.*\.ts$/,
];

const PERIPHERAL_PATTERNS = [
  /^app\/.*\/page\.tsx$/,
  /^app\/api\/.*\/route\.ts$/,
  /^components\/.*\.tsx$/,
  /^server\/.*\.ts$/,
  /^lib\/.*\.ts$/,
];

function isCorePath(relPath: string): boolean {
  return CORE_PATTERNS.some(p => p.test(relPath));
}

function isPeripheralPath(relPath: string): boolean {
  return PERIPHERAL_PATTERNS.some(p => p.test(relPath));
}

function buildDirectoryTree(rootPath: string, maxDepth = 4): string {
  const lines: string[] = [];

  function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !IGNORE_DIRS.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const nextPrefix = prefix + (isLast ? "    " : "│   ");

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        walk(path.join(dir, entry.name), nextPrefix, depth + 1);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  }

  walk(rootPath, "", 0);
  return lines.join("\n");
}

function collectSourceFiles(rootPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        results.push(fullPath);
      }
    }
  }

  walk(rootPath);
  return results;
}

function getSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    const params = node.parameters
      .map(p => p.getText(sourceFile))
      .join(", ");
    const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
    const name = node.name?.getText(sourceFile) ?? "anonymous";
    return `${name}(${params})${returnType}`;
  }
  if (ts.isVariableDeclaration(node)) {
    const typeAnnotation = node.type ? `: ${node.type.getText(sourceFile)}` : "";
    return `${node.name.getText(sourceFile)}${typeAnnotation}`;
  }
  return "";
}

function analyzeFileWithAST(filePath: string, rootPath: string): FileAnalysis {
  const source = fs.readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const exports: ExportInfo[] = [];
  const imports: ImportInfo[] = [];
  const classes: ClassInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpec = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpec)) {
        const names: string[] = [];
        if (node.importClause) {
          if (node.importClause.name) {
            names.push(node.importClause.name.text);
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const spec of node.importClause.namedBindings.elements) {
                names.push(spec.name.text);
              }
            } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              names.push(`* as ${node.importClause.namedBindings.name.text}`);
            }
          }
        }
        imports.push({ from: moduleSpec.text, names });
      }
    }

    const hasExportModifier = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;

    if (hasExportModifier || (ts.isExportAssignment(node) && !node.isExportEquals)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        exports.push({
          name: node.name.text,
          kind: "function",
          signature: getSignature(node, sourceFile),
        });
      } else if (ts.isClassDeclaration(node) && node.name) {
        const classInfo: ClassInfo = {
          name: node.name.text,
          methods: [],
          implements: [],
        };
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
              classInfo.implements = clause.types.map(t => t.getText(sourceFile));
            }
          }
        }
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            classInfo.methods.push({
              name: member.name.getText(sourceFile),
              signature: getSignature(member, sourceFile),
            });
          }
        }
        classes.push(classInfo);
        exports.push({ name: node.name.text, kind: "class" });
      } else if (ts.isInterfaceDeclaration(node)) {
        exports.push({ name: node.name.text, kind: "interface" });
      } else if (ts.isTypeAliasDeclaration(node)) {
        exports.push({ name: node.name.text, kind: "type" });
      } else if (ts.isEnumDeclaration(node)) {
        exports.push({ name: node.name.text, kind: "enum" });
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            exports.push({
              name: decl.name.text,
              kind: "const",
              signature: getSignature(decl, sourceFile),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  return {
    filePath: path.relative(rootPath, filePath),
    exports,
    imports,
    classes,
  };
}

function analyzeFileWithRegex(filePath: string, rootPath: string): FileAnalysis {
  const source = fs.readFileSync(filePath, "utf-8");
  const exports: ExportInfo[] = [];
  const imports: ImportInfo[] = [];

  const importRegex = /import\s+(?:{([^}]+)}\s+from|(\w+)\s+from)\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    const names = match[1]
      ? match[1].split(",").map(s => s.trim()).filter(Boolean)
      : [match[2]];
    imports.push({ from: match[3], names });
  }

  const exportFnRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
  while ((match = exportFnRegex.exec(source)) !== null) {
    exports.push({ name: match[1], kind: "function" });
  }

  const exportDefaultRegex = /export\s+default\s+function\s+(\w+)/g;
  while ((match = exportDefaultRegex.exec(source)) !== null) {
    exports.push({ name: match[1], kind: "function" });
  }

  const exportConstRegex = /export\s+const\s+(\w+)/g;
  while ((match = exportConstRegex.exec(source)) !== null) {
    exports.push({ name: match[1], kind: "const" });
  }

  const exportClassRegex = /export\s+class\s+(\w+)/g;
  while ((match = exportClassRegex.exec(source)) !== null) {
    exports.push({ name: match[1], kind: "class" });
  }

  const exportInterfaceRegex = /export\s+(?:interface|type)\s+(\w+)/g;
  while ((match = exportInterfaceRegex.exec(source)) !== null) {
    exports.push({ name: match[1], kind: "interface" });
  }

  return {
    filePath: path.relative(rootPath, filePath),
    exports,
    imports,
    classes: [],
  };
}

function buildDependencyGraph(
  analyses: FileAnalysis[],
  rootPath: string
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const fileSet = new Set(analyses.map(a => a.filePath));

  for (const analysis of analyses) {
    const deps: string[] = [];
    const fileDir = path.dirname(path.join(rootPath, analysis.filePath));

    for (const imp of analysis.imports) {
      if (!imp.from.startsWith(".") && !imp.from.startsWith("@/")) continue;

      let resolved: string;
      if (imp.from.startsWith("@/")) {
        resolved = imp.from.slice(2);
      } else {
        resolved = path.relative(rootPath, path.resolve(fileDir, imp.from));
      }

      const candidates = [
        resolved,
        resolved + ".ts",
        resolved + ".tsx",
        resolved + "/index.ts",
        resolved + "/index.tsx",
      ];

      for (const candidate of candidates) {
        if (fileSet.has(candidate)) {
          deps.push(candidate);
          break;
        }
      }
    }

    graph.set(analysis.filePath, deps);
  }

  return graph;
}

function extractRoutes(rootPath: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const apiDir = path.join(rootPath, "app", "api");
  if (!fs.existsSync(apiDir)) return routes;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === "route.ts") {
        const relPath = path.relative(rootPath, fullPath);
        const routePath = "/" + path.relative(path.join(rootPath, "app"), dir)
          .replace(/\\/g, "/")
          .replace(/\[(\w+)\]/g, ":$1");

        const source = fs.readFileSync(fullPath, "utf-8");
        const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
        for (const method of methods) {
          if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source)) {
            routes.push({ method, path: routePath, file: relPath });
          }
        }
      }
    }
  }

  walk(apiDir);
  return routes;
}

function extractPages(rootPath: string): PageInfo[] {
  const pages: PageInfo[] = [];
  const appDir = path.join(rootPath, "app");
  if (!fs.existsSync(appDir)) return pages;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === "page.tsx" || entry.name === "page.ts") {
        const relPath = path.relative(rootPath, fullPath);
        const pagePath = "/" + path.relative(appDir, dir)
          .replace(/\\/g, "/")
          .replace(/\[(\w+)\]/g, ":$1");
        pages.push({ path: pagePath === "/." ? "/" : pagePath, file: relPath });
      }
    }
  }

  walk(appDir);
  return pages;
}

export async function runStaticAnalysis(
  rootPath: string,
  onProgress?: ProgressCallback
): Promise<AnalysisResult> {
  log.info({ rootPath }, "Starting static analysis");
  onProgress?.("static_analysis", "building directory tree");

  const tree = buildDirectoryTree(rootPath);
  const allFiles = collectSourceFiles(rootPath);

  const coreFiles: FileAnalysis[] = [];
  const peripheralFiles: FileAnalysis[] = [];

  for (const filePath of allFiles) {
    const relPath = path.relative(rootPath, filePath);

    if (isCorePath(relPath)) {
      onProgress?.("static_analysis", relPath);
      try {
        coreFiles.push(analyzeFileWithAST(filePath, rootPath));
      } catch (err) {
        log.warn({ filePath, err }, "AST analysis failed, falling back to regex");
        coreFiles.push(analyzeFileWithRegex(filePath, rootPath));
      }
    } else if (isPeripheralPath(relPath)) {
      onProgress?.("static_analysis", relPath);
      peripheralFiles.push(analyzeFileWithRegex(filePath, rootPath));
    }
  }

  onProgress?.("static_analysis", "building dependency graph");
  const allAnalyses = [...coreFiles, ...peripheralFiles];
  const dependencyGraph = buildDependencyGraph(allAnalyses, rootPath);

  onProgress?.("static_analysis", "extracting routes");
  const routes = extractRoutes(rootPath);

  onProgress?.("static_analysis", "extracting pages");
  const pages = extractPages(rootPath);

  log.info(
    { coreCount: coreFiles.length, peripheralCount: peripheralFiles.length, routes: routes.length },
    "Static analysis completed"
  );

  return { tree, coreFiles, peripheralFiles, dependencyGraph, routes, pages };
}

export function formatAnalysisForPrompt(result: AnalysisResult): string {
  const sections: string[] = [];

  sections.push("## 目录结构\n```\n" + result.tree + "\n```");

  sections.push("\n## API 路由表\n");
  for (const route of result.routes) {
    sections.push(`- ${route.method} ${route.path} → ${route.file}`);
  }

  sections.push("\n## 页面路由\n");
  for (const page of result.pages) {
    sections.push(`- ${page.path} → ${page.file}`);
  }

  sections.push("\n## 核心文件分析（AST 精确提取）\n");
  for (const file of result.coreFiles) {
    sections.push(`### ${file.filePath}`);
    if (file.exports.length > 0) {
      sections.push("**Exports:**");
      for (const exp of file.exports) {
        const sig = exp.signature ? ` — \`${exp.signature}\`` : "";
        sections.push(`- [${exp.kind}] \`${exp.name}\`${sig}`);
      }
    }
    if (file.classes.length > 0) {
      for (const cls of file.classes) {
        const impl = cls.implements?.length ? ` implements ${cls.implements.join(", ")}` : "";
        sections.push(`- [class] \`${cls.name}\`${impl}`);
        for (const method of cls.methods) {
          sections.push(`  - \`${method.signature}\``);
        }
      }
    }
    if (file.imports.length > 0) {
      const localImports = file.imports.filter(i => i.from.startsWith(".") || i.from.startsWith("@/"));
      if (localImports.length > 0) {
        sections.push("**Local deps:** " + localImports.map(i => i.from).join(", "));
      }
    }
    sections.push("");
  }

  sections.push("\n## 外围文件分析（正则快速扫描）\n");
  for (const file of result.peripheralFiles) {
    sections.push(`### ${file.filePath}`);
    if (file.exports.length > 0) {
      sections.push("**Exports:** " + file.exports.map(e => `${e.name}(${e.kind})`).join(", "));
    }
    sections.push("");
  }

  sections.push("\n## 依赖关系图\n");
  for (const [file, deps] of result.dependencyGraph) {
    if (deps.length > 0) {
      sections.push(`- ${file} → ${deps.join(", ")}`);
    }
  }

  return sections.join("\n");
}
