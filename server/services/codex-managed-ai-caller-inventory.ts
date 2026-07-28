import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

export interface ManagedAiCallerManifestEntry {
  file: string;
  mode: "logical_resolver" | "rollback_adapter";
  resolverSymbol?: string;
  guard?: "desktopBridge=off";
}

export const CODEX_MANAGED_AI_CALLER_MANIFEST:
readonly ManagedAiCallerManifestEntry[] = [
  { file: "server/services/prd-service.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
  { file: "server/services/context-init-service.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
  { file: "server/services/pipeline-engine-service.ts", mode: "logical_resolver", resolverSymbol: "getAiEngine" },
  { file: "server/services/pipeline-prd-briefing-stage-service.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
  { file: "server/services/pipeline-spec-stage-service.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
  { file: "server/services/pipeline-delegated-round.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
  { file: "server/services/pipeline-document-stage-runner-service.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
  { file: "server/services/pipeline-plan-stage-service.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
  { file: "server/services/pipeline-build-stage-service.ts", mode: "logical_resolver", resolverSymbol: "resolveBuildTurn" },
  { file: "server/services/pipeline-review-stage-service.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
  { file: "server/services/interaction-presentation-orchestrator.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
  { file: "server/services/crash-resilience-harness.ts", mode: "logical_resolver", resolverSymbol: "resolveLogicalTurn" },
];

export interface ManagedAiCallerInventory {
  callers: ManagedAiCallerManifestEntry[];
  byFile: Record<string, ManagedAiCallerManifestEntry>;
  unclassified: string[];
}

function productionServerFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["fixtures", "__fixtures__", "generated"].includes(entry.name)) visit(absolute);
      } else if (
        entry.name.endsWith(".ts")
        && !entry.name.endsWith(".test.ts")
        && !entry.name.endsWith(".d.ts")
      ) {
        result.push(absolute);
      }
    }
  };
  visit(path.join(root, "server"));
  return result;
}

function resolvedSymbol(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function symbolIsManagedFactory(symbol: ts.Symbol | undefined): boolean {
  if (!symbol || !["getAiEngine", "getPipelineEngine"].includes(symbol.name)) {
    return false;
  }
  return symbol.declarations?.some((declaration) => {
    const file = declaration.getSourceFile().fileName.split(path.sep).join("/");
    return file.endsWith("/server/services/ai-engine-adapter.ts")
      || file.endsWith("/server/services/pipeline-engine-service.ts");
  }) ?? false;
}

function symbolIsManagedRun(symbol: ts.Symbol | undefined): boolean {
  if (!symbol || !["run", "runStreamed"].includes(symbol.name)) return false;
  return symbol.declarations?.some((declaration) => {
    const file = declaration.getSourceFile().fileName.split(path.sep).join("/");
    return file.endsWith("/server/services/ai-engine-types.ts");
  }) ?? false;
}

function isManagedCaller(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression)
        && symbolIsManagedFactory(resolvedSymbol(checker, node.expression))
      ) {
        found = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(node.expression)
        && (
          symbolIsManagedRun(resolvedSymbol(checker, node.expression.name))
          || (
            ["run", "runStreamed"].includes(node.expression.name.text)
            && ts.isIdentifier(node.expression.expression)
            && node.expression.expression.text === "engine"
          )
        )
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function fileDeclaresSymbol(source: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isIdentifier(node) && node.text === name)
      || (
        ts.isImportSpecifier(node)
        && node.name.text === name
      )
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function buildManagedAiCallerInventory(
  projectRoot: string,
): ManagedAiCallerInventory {
  const root = path.resolve(projectRoot);
  const files = productionServerFiles(root);
  const program = ts.createProgram(files, {
    allowJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();
  const detected = new Map<string, ts.SourceFile>();
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(path.join(root, "server"))) continue;
    const relative = path.relative(root, source.fileName).split(path.sep).join("/");
    if (
      [
        "server/services/ai-engine-adapter.ts",
        "server/services/codex-desktop-engine.ts",
      ].includes(relative)
    ) continue;
    if (isManagedCaller(source, checker)) {
      detected.set(relative, source);
    }
  }
  const manifest = new Map(
    CODEX_MANAGED_AI_CALLER_MANIFEST.map((entry) => [entry.file, entry]),
  );
  const unclassified = new Set<string>();
  for (const file of detected.keys()) {
    if (!manifest.has(file)) unclassified.add(file);
  }
  for (const entry of CODEX_MANAGED_AI_CALLER_MANIFEST) {
    const source = program.getSourceFile(path.join(root, entry.file));
    if (!source || !detected.has(entry.file)) {
      unclassified.add(`${entry.file}:missing_managed_call`);
      continue;
    }
    if (
      entry.mode === "logical_resolver"
      && (
        !entry.resolverSymbol
        || !fileDeclaresSymbol(source, entry.resolverSymbol)
      )
    ) {
      unclassified.add(`${entry.file}:missing_resolver:${entry.resolverSymbol ?? ""}`);
    }
    if (
      entry.mode === "rollback_adapter"
      && entry.guard !== "desktopBridge=off"
    ) {
      unclassified.add(`${entry.file}:invalid_rollback_guard`);
    }
  }
  const callers = [...CODEX_MANAGED_AI_CALLER_MANIFEST];
  return {
    callers,
    byFile: Object.fromEntries(callers.map((entry) => [entry.file, entry])),
    unclassified: [...unclassified].sort(),
  };
}
