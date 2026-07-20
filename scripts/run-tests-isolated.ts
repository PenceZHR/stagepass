import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateDatabase } from "../server/db/index.ts";

/**
 * Heavy acceptance suites spawn real Next/worker/provider process trees and can
 * starve ordinary unit tests of CPU when interleaved in the same run. They run
 * separately via `pnpm test:acceptance`.
 */
export const ACCEPTANCE_TEST_FILES = [
  "server/services/crash-resilience-acceptance.test.ts",
];

export function listTests(
  root: string,
  options: { suite?: "unit" | "acceptance" | "all" } = {},
): string[] {
  const suite = options.suite ?? "unit";
  const acceptancePaths = new Set(
    ACCEPTANCE_TEST_FILES.map((file) => path.join(root, file)),
  );
  const files: string[] = [];
  const visit = (entryPath: string): void => {
    if (!fs.existsSync(entryPath)) return;
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(entryPath).sort()) visit(path.join(entryPath, entry));
      return;
    }
    if (!entryPath.endsWith(".test.ts") && !entryPath.endsWith(".test.tsx")) return;
    const isAcceptance = acceptancePaths.has(entryPath);
    if (suite === "unit" && isAcceptance) return;
    if (suite === "acceptance" && !isAcceptance) return;
    files.push(entryPath);
  };
  visit(path.join(root, "app"));
  visit(path.join(root, "server"));
  return files;
}

/**
 * `node --test` treats each positional argument as a glob pattern. Our test files
 * live under Next.js dynamic-route folders (`[id]`, `[changeId]`), so their literal
 * paths contain `[`/`]` that the glob layer reads as character-classes — silently
 * matching nothing and skipping the whole file. Escape the brackets so each path is
 * matched literally. Non-bracket paths pass through unchanged.
 */
export function escapeGlobLiteral(p: string): string {
  return p.replace(/[[\]]/g, (ch) => (ch === "[" ? "[[]" : "[]]"));
}

type FileStamp = { exists: boolean; size: number | null; mtimeMs: number | null; sha256: string | null };

function stamp(filePath: string): FileStamp {
  if (!fs.existsSync(filePath)) return { exists: false, size: null, mtimeMs: null, sha256: null };
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
  };
}

export function runIsolatedTests(root = process.cwd(), requestedTests = process.argv.slice(2)): number {
  const suite: "unit" | "acceptance" | "all" = requestedTests[0] === "--acceptance"
    ? "acceptance"
    : requestedTests[0] === "--all"
      ? "all"
      : "unit";
  if (suite !== "unit") requestedTests = requestedTests.slice(1);
  const productionFiles = ["ship.db", "ship.db-wal", "ship.db-shm"]
    .map((name) => path.join(root, "server", "db", name));
  const before = new Map(productionFiles.map((file) => [file, stamp(file)]));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stagepass-test-suite-"));
  const testDbPath = path.join(tempRoot, "suite.db");

  let exitCode = 1;
  try {
    migrateDatabase(testDbPath);
    const tests = requestedTests.length > 0
      ? requestedTests.map((testPath) => path.resolve(root, testPath))
      : listTests(root, { suite });
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--test", "--test-concurrency=1", ...tests.map(escapeGlobLiteral),
    ], {
      cwd: root,
      env: { ...process.env, STAGEPASS_DB_PATH: testDbPath, STAGEPASS_TEST_ROOT: tempRoot },
      stdio: "inherit",
    });
    exitCode = child.status ?? 1;
    if (child.error) throw child.error;
    for (const file of productionFiles) {
      const previous = before.get(file);
      const current = stamp(file);
      if (JSON.stringify(previous) !== JSON.stringify(current)) {
        throw new Error(`Test isolation violation: production DB sidecar changed: ${path.basename(file)}`);
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  return exitCode;
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = runIsolatedTests();
}
