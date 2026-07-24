import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const PRODUCTION_CONSUMERS = [
  "server/services/build-workspace-service.ts",
  "server/services/change-service.ts",
  "server/services/merge-readiness-service.ts",
  "server/services/pipeline-build-stage-service.ts",
  "server/services/project-git-state-service.ts",
  "server/services/scope-check-service.ts",
] as const;

const TASK_18_REMOVAL_CONSUMERS = [
  "app/api/projects/[id]/changes/[changeId]/git/route.ts",
  "app/api/projects/[id]/git/route.ts",
] as const;

const KNOWN_TEST_CONSUMERS = [
  "server/services/build-workspace-service.test.ts",
  "server/services/git-service.test.ts",
  "server/services/pipeline-service.test.ts",
  "server/services/project-service.test.ts",
] as const;

export interface GitServiceConsumerInventory {
  productionConsumers: string[];
  task18RemovalConsumers: string[];
  testConsumers: string[];
  activeLegacyConsumers: string[];
  unclassified: string[];
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".claude", ".git", ".next", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function importsLegacyGitService(filePath: string): boolean {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      (
        ts.isImportDeclaration(node)
        || ts.isExportDeclaration(node)
      )
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
      && /(?:^|\/)git-service(?:\.[cm]?ts)?$/.test(node.moduleSpecifier.text)
    ) {
      found = true;
    }
    if (
      ts.isCallExpression(node)
      && node.arguments.length > 0
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require"
      && ts.isStringLiteral(node.arguments[0])
      && /(?:^|\/)git-service(?:\.[cm]?ts)?$/.test(node.arguments[0].text)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function buildGitServiceConsumerInventory(projectRoot: string): GitServiceConsumerInventory {
  const activeLegacyConsumers = sourceFiles(projectRoot)
    .filter(importsLegacyGitService)
    .map((file) => path.relative(projectRoot, file).split(path.sep).join("/"))
    .sort();
  const classified = new Set<string>([
    ...PRODUCTION_CONSUMERS,
    ...TASK_18_REMOVAL_CONSUMERS,
    ...KNOWN_TEST_CONSUMERS,
  ]);
  return {
    productionConsumers: [...PRODUCTION_CONSUMERS],
    task18RemovalConsumers: [...TASK_18_REMOVAL_CONSUMERS],
    testConsumers: [...KNOWN_TEST_CONSUMERS],
    activeLegacyConsumers,
    unclassified: activeLegacyConsumers.filter((consumer) => !classified.has(consumer)),
  };
}
