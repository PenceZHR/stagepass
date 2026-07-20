import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import ts from "typescript";

export type DbWriteOperation = "insert" | "update" | "delete" | "transaction" | "run" | "exec";

export interface DbWriteInventoryPolicy {
  roots: string[];
  productionOwners: Record<string, string>;
  allowedTestScripts: string[];
  isolatedTestFixtures?: string[];
  testFixtures?: TestDbFixturePolicyEntry[];
  allowlist?: DbWriteAllowlistEntry[];
}

export interface TestDbFixturePolicyEntry {
  file: string;
  mode: "local-memory" | "local-temp" | "suite-env";
  reason: string;
}

export interface DbWriteAllowlistEntry {
  file: string;
  symbol: string;
  nodeKind: string;
  table: string | null;
  reason: string;
  owner: string;
}

export interface DbWriteSite {
  file: string;
  symbol: string;
  receiver: string;
  operation: DbWriteOperation;
  target: string | null;
  line: number;
  nodeKind: string;
  owner: string | null;
  reason: string;
}

export interface BoundaryCallSite {
  file: string;
  receiver: string;
  symbol: string;
  line: number;
}

export interface DbWriteInventoryResult {
  files: string[];
  writes: DbWriteSite[];
  boundaryCalls: BoundaryCallSite[];
  unclassified: DbWriteSite[];
}

export interface DbWriteInventoryOptions {
  virtualFiles?: Record<string, string>;
}

const TASK_14_FILES = [
  "server/repositories/run-ledger-repository.ts",
  "server/services/artifact-mirror-service.ts",
  "server/services/build-run-record-service.ts",
  "server/services/change-service.ts",
  "server/services/change-status-service.ts",
  "server/services/context-init-service.ts",
  "server/services/event-service.ts",
  "server/services/gate-service.ts",
  "server/services/graph-runner.ts",
  "server/services/merge-readiness-service.ts",
  "server/services/pipeline-plan-stage-service.ts",
  "server/services/pipeline-prd-briefing-stage-service.ts",
  "server/services/pipeline-qa-stage-service.ts",
  "server/services/pipeline-release-retro-stage-service.ts",
  "server/services/plan-approval-service.ts",
  "server/services/plan-snapshot-service.ts",
  "server/services/prd-briefing-service.ts",
  "server/services/prd-document-service.ts",
  "server/services/prd-service.ts",
  "server/services/project-git-state-service.ts",
  "server/services/project-service.ts",
  "server/services/qa-run-service.ts",
  "server/services/refine-service.ts",
  "server/services/review-artifact-mirror-service.ts",
  "server/services/review-report-service.ts",
  "server/services/review-run-service.ts",
  "server/services/review-waiver-service.ts",
  "server/services/spec-battle-repair-service.ts",
  "server/services/spec-battle-report-service.ts",
  "server/services/spec-battle-service.ts",
  "server/services/techspec-api-snapshot-service.ts",
  "server/services/testplan-snapshot-service.ts",
];

const DEFAULT_PRODUCTION_OWNERS: Record<string, string> = Object.fromEntries([
  ["server/services/job-dispatch-service.ts", "Task 9"],
  ...[
    "server/services/pipeline-build-stage-service.ts",
    "server/services/pipeline-document-stage-runner-service.ts",
    "server/services/pipeline-job-lease-service.ts",
    "server/services/pipeline-service.ts",
    "server/services/provider-process-lease-service.ts",
    "server/services/provider-run-lifecycle-service.ts",
  ].map((file) => [file, "Task 10"]),
  ...[
    "server/services/action-contract-self-heal-service.ts",
    "server/services/stale-provider-run-recovery-service.ts",
    "server/services/recovery-executors.ts",
  ].map((file) => [file, "Task 11"]),
  ...TASK_14_FILES.map((file) => [file, "Task 14"]),
  ["server/services/execution-fence-service.ts", "Task 14"],
  ["server/services/change-rework-service.ts", "Task 14"],
]);

export function readIndependentDbWritePolicy(rootDir: string): {
  productionEntries: DbWriteAllowlistEntry[];
  testFixtures: TestDbFixturePolicyEntry[];
} {
  const policyPath = path.join(rootDir, "server", "db", "db-write-policy.json");
  if (!fs.existsSync(policyPath)) return { productionEntries: [], testFixtures: [] };
  const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8")) as {
    schemaVersion?: number;
    productionEntries?: DbWriteAllowlistEntry[];
    testFixtures?: TestDbFixturePolicyEntry[];
  };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.productionEntries) || !Array.isArray(parsed.testFixtures)) {
    throw new Error("Invalid independent DB write policy");
  }
  return { productionEntries: parsed.productionEntries, testFixtures: parsed.testFixtures };
}

export function computeDbWritePolicyDigest(entries: DbWriteAllowlistEntry[]): string {
  const canonical = [...entries]
    .sort((left, right) => [left.file, left.symbol, left.nodeKind, left.table ?? ""]
      .join("|").localeCompare([right.file, right.symbol, right.nodeKind, right.table ?? ""].join("|")))
    .map(({ file, symbol, nodeKind, table, owner, reason }) => ({
      file,
      symbol,
      nodeKind,
      table,
      owner,
      reason,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const INDEPENDENT_POLICY = readIndependentDbWritePolicy(process.cwd());

export const DEFAULT_DB_WRITE_INVENTORY_POLICY: DbWriteInventoryPolicy = {
  roots: ["server", "app", "scripts"],
  productionOwners: DEFAULT_PRODUCTION_OWNERS,
  allowedTestScripts: [
    "scripts/test-retry-always-available.ts",
    "scripts/test-state-machine-closure.ts",
  ],
  allowlist: INDEPENDENT_POLICY.productionEntries,
  testFixtures: INDEPENDENT_POLICY.testFixtures,
};

const ROOT_WRITE_OPERATIONS = new Set<DbWriteOperation>([
  "insert",
  "update",
  "delete",
  "transaction",
]);

function normalizeFile(rootDir: string, file: string): string {
  return path.relative(rootDir, file).split(path.sep).join("/");
}

function listTypeScriptFiles(rootDir: string, roots: string[]): string[] {
  const result: string[] = [];
  const visit = (entryPath: string): void => {
    if (!fs.existsSync(entryPath)) return;
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(entryPath).sort()) visit(path.join(entryPath, entry));
      return;
    }
    if (entryPath.endsWith(".ts") || entryPath.endsWith(".tsx")) result.push(entryPath);
  };
  for (const root of roots) visit(path.join(rootDir, root));
  return result;
}

function isAllowedFile(
  file: string,
  policy: DbWriteInventoryPolicy,
  sourceText = "",
): string | null {
  if (file.startsWith("server/db/migrations/")) return "database migration";
  const fixture = policy.testFixtures?.find((entry) => entry.file === file);
  if (fixture || policy.isolatedTestFixtures?.includes(file)) {
    const ownsMemoryDatabase = /new\s+Database\s*\(\s*["']:memory:["']\s*\)/.test(sourceText);
    const injectsFixtureDb = /drizzle\s*\(/.test(sourceText);
    const ownsTemporaryDatabase = /new\s+Database\s*\(/.test(sourceText) && /mkdtemp/.test(sourceText);
    const importsSuiteDb = /(?:from\s*["'][^"']*(?:server\/)?db(?:\/index)?(?:\.ts)?["']|import\s*\(["'][^"']*(?:server\/)?db(?:\/index)?(?:\.ts)?["']\))/.test(sourceText);
    if ((fixture?.mode ?? "local-memory") === "local-memory" && ownsMemoryDatabase
      && (injectsFixtureDb || /\.exec\s*\(|\.prepare\s*\(/.test(sourceText))) {
      return fixture?.reason ?? "proven isolated in-memory test DB injection";
    }
    if (fixture?.mode === "local-temp" && ownsTemporaryDatabase) return fixture.reason;
    if (fixture?.mode === "suite-env" && importsSuiteDb) return fixture.reason;
  }
  return null;
}

function exactAllowlistEntry(
  policy: DbWriteInventoryPolicy,
  site: Pick<DbWriteSite, "file" | "symbol" | "nodeKind" | "target">,
): DbWriteAllowlistEntry | null {
  return policy.allowlist?.find((entry) =>
    entry.file === site.file
    && entry.symbol === site.symbol
    && entry.nodeKind === site.nodeKind
    && entry.table === site.target
  ) ?? null;
}

function propertyCall(node: ts.CallExpression): { receiver: ts.Expression; operation: string; name: ts.Identifier } | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (!ts.isIdentifier(node.expression.name)) return null;
  return { receiver: node.expression.expression, operation: node.expression.name.text, name: node.expression.name };
}

function sourcePath(sourceFile: ts.SourceFile): string {
  return sourceFile.fileName.split(path.sep).join("/");
}

function symbolDeclarationsInclude(symbol: ts.Symbol | undefined, fragment: string): boolean {
  return Boolean(symbol?.declarations?.some((declaration) => sourcePath(declaration.getSourceFile()).includes(fragment)));
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function isDrizzleReceiver(checker: ts.TypeChecker, receiver: ts.Expression, method: ts.Identifier): boolean {
  const methodSymbol = resolvedSymbol(checker, method);
  if (symbolDeclarationsInclude(methodSymbol, "/drizzle-orm/")) return true;
  const typeText = checker.typeToString(
    checker.getTypeAtLocation(receiver),
    receiver,
    ts.TypeFormatFlags.NoTruncation,
  );
  return /(BetterSQLite3Database|BaseSQLiteDatabase|SQLiteTransaction|SQLite.*Query|SQLite.*Base)/.test(typeText);
}

function isBetterSqliteReceiver(checker: ts.TypeChecker, receiver: ts.Expression, method: ts.Identifier): boolean {
  const methodSymbol = resolvedSymbol(checker, method);
  return symbolDeclarationsInclude(methodSymbol, "/@types/better-sqlite3/");
}

function sqlText(expression: ts.Expression | undefined): string | null {
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return null;
}

function nativeSqlTarget(sql: string | null): string {
  if (!sql) return "__native_sql__";
  const match = sql.match(/\b(?:insert\s+into|update|delete\s+from|replace\s+into|create\s+table(?:\s+if\s+not\s+exists)?|drop\s+table(?:\s+if\s+exists)?|alter\s+table)\s+["'`\[]?([\w.-]+)/i);
  return match?.[1]?.replace(/[\]"'`]/g, "") ?? "__native_sql__";
}

function preparedSql(checker: ts.TypeChecker, receiver: ts.Expression): string | null {
  if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)
    && receiver.expression.name.text === "prepare") {
    return sqlText(receiver.arguments[0]);
  }
  if (ts.isIdentifier(receiver)) {
    const declaration = resolvedSymbol(checker, receiver)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)
      && ts.isPropertyAccessExpression(declaration.initializer.expression)
      && declaration.initializer.expression.name.text === "prepare") {
      return sqlText(declaration.initializer.arguments[0]);
    }
  }
  return null;
}

function isRunLedgerBoundaryCall(checker: ts.TypeChecker, name: ts.Identifier): boolean {
  return symbolDeclarationsInclude(resolvedSymbol(checker, name), "/server/repositories/run-ledger-repository.ts");
}

function tableName(checker: ts.TypeChecker, argument: ts.Expression | undefined): string | null {
  if (!argument) return null;
  if (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument)) {
    const name = ts.isIdentifier(argument) ? argument.text : argument.name.text;
    const symbolNode = ts.isIdentifier(argument) ? argument : argument.name;
    const symbol = resolvedSymbol(checker, symbolNode);
    if (symbolDeclarationsInclude(symbol, "/server/db/schema.ts")) return name;
  }
  if (ts.isTaggedTemplateExpression(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return "__raw_sql__";
  }
  return null;
}

function createInventoryProgram(
  rootDir: string,
  roots: string[],
  virtualFiles: Record<string, string> | null,
): { program: ts.Program; projectFiles: Set<string> } {
  const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, "tsconfig.json");
  const config = configPath
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, rootDir)
    : { options: {}, fileNames: [] as string[], errors: [] as ts.Diagnostic[] };
  const realFiles = listTypeScriptFiles(rootDir, roots).map((file) => path.resolve(file));
  const virtualMap = new Map(
    Object.entries(virtualFiles ?? {}).map(([file, source]) => [path.resolve(rootDir, file), source]),
  );
  const rootNames = [...new Set([...config.fileNames, ...realFiles, ...virtualMap.keys()])];
  const host = ts.createCompilerHost({ ...config.options, noEmit: true }, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => virtualMap.has(path.resolve(fileName)) || originalFileExists(fileName);
  host.readFile = (fileName) => virtualMap.get(path.resolve(fileName)) ?? originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = virtualMap.get(path.resolve(fileName));
    return source === undefined
      ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, source, languageVersion, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  };
  return {
    program: ts.createProgram({ rootNames, options: { ...config.options, noEmit: true }, host }),
    projectFiles: new Set(
      (virtualMap.size > 0 ? [...virtualMap.keys()] : realFiles).map((file) => path.resolve(file)),
    ),
  };
}

export function scanDbWriteInventory(
  rootDir: string,
  policy: DbWriteInventoryPolicy = DEFAULT_DB_WRITE_INVENTORY_POLICY,
  options: DbWriteInventoryOptions = {},
): DbWriteInventoryResult {
  const virtualFiles = options.virtualFiles ?? null;
  const { program, projectFiles } = createInventoryProgram(rootDir, policy.roots, virtualFiles);
  const checker = program.getTypeChecker();
  const writes: DbWriteSite[] = [];
  const boundaryCalls: BoundaryCallSite[] = [];

  for (const sourceFile of program.getSourceFiles()
    .filter((file) => projectFiles.has(path.resolve(file.fileName)))
    .sort((left, right) => left.fileName.localeCompare(right.fileName))) {
    const file = normalizeFile(rootDir, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const call = propertyCall(node);
        if (call) {
          const receiver = call.receiver.getText(sourceFile);
          if (isRunLedgerBoundaryCall(checker, call.name)) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            boundaryCalls.push({ file, receiver, symbol: call.operation, line });
          }
          const rootMutation = ROOT_WRITE_OPERATIONS.has(call.operation as DbWriteOperation);
          const directRawRun = call.operation === "run" && tableName(checker, node.arguments[0]) === "__raw_sql__";
          const drizzleWrite = (rootMutation || directRawRun) && isDrizzleReceiver(checker, call.receiver, call.name);
          const nativeWrite = (call.operation === "exec" || call.operation === "run")
            && isBetterSqliteReceiver(checker, call.receiver, call.name);
          if (drizzleWrite || nativeWrite) {
            const operation = call.operation as DbWriteOperation;
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            const site = {
              file,
              symbol: nativeWrite && ts.isCallExpression(call.receiver)
                && ts.isPropertyAccessExpression(call.receiver.expression)
                && call.receiver.expression.name.text === "prepare"
                ? `${call.receiver.expression.expression.getText(sourceFile)}.prepare.run`
                : `${receiver}.${operation}`,
              receiver,
              operation,
              target: nativeWrite
                ? nativeSqlTarget(call.operation === "exec" ? sqlText(node.arguments[0]) : preparedSql(checker, call.receiver))
                : tableName(checker, node.arguments[0]),
              line,
              nodeKind: ts.SyntaxKind[node.kind],
            };
            const exact = exactAllowlistEntry(policy, site);
            const allowedReason = isAllowedFile(file, policy, sourceFile.text);
            const owner = exact?.owner ?? (allowedReason ? "test-fixture" : null);
            writes.push({
              ...site,
              owner,
              reason: exact?.reason ?? allowedReason ?? (owner ? `owned by ${owner}` : "unclassified production DB write"),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  writes.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.operation.localeCompare(right.operation));
  boundaryCalls.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  return {
    files: [...new Set(writes.map((write) => write.file))],
    writes,
    boundaryCalls,
    unclassified: writes.filter((write) => !write.owner),
  };
}
