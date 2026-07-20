import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";

import { ACCEPTANCE_TEST_FILES, listTests } from "../../scripts/run-tests-isolated";

test("full test entrypoint injects an isolated DB before loading test modules", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    scripts: { test: string };
  };
  const runner = fs.readFileSync("scripts/run-tests-isolated.ts", "utf8");

  assert.equal(packageJson.scripts.test, "tsx scripts/run-tests-isolated.ts");
  assert.match(runner, /STAGEPASS_DB_PATH: testDbPath/);
  assert.match(runner, /--import[\s\S]*tsx[\s\S]*--test/);
  assert.match(runner, /ship\.db-wal/);
  assert.match(runner, /ship\.db-shm/);
  assert.match(runner, /createHash\("sha256"\)/);
  assert.match(runner, /fs\.rmSync\(tempRoot, \{ recursive: true, force: true \}\)/);
  // Isolation guarantee: the runner must migrate an isolated temp DB (never the
  // production database). Importing server/db is allowed because the handle is
  // opened lazily and migrateDatabase is only ever called with the temp path.
  assert.match(runner, /migrateDatabase\(testDbPath\)/);
});

test("full test enumeration recursively covers every app/server TS and TSX test", () => {
  const root = process.cwd();
  const expected: string[] = [];
  const visit = (entryPath: string): void => {
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(entryPath).sort()) visit(path.join(entryPath, entry));
    } else if (entryPath.endsWith(".test.ts") || entryPath.endsWith(".test.tsx")) {
      expected.push(entryPath);
    }
  };
  visit(path.join(root, "app"));
  visit(path.join(root, "server"));

  // Unit + acceptance suites must partition the full enumeration with no gaps:
  // every discovered test file runs in exactly one of the two suites.
  const unitSuite = listTests(root, { suite: "unit" });
  const acceptanceSuite = listTests(root, { suite: "acceptance" });
  assert.deepEqual(listTests(root, { suite: "all" }), expected);
  assert.deepEqual([...unitSuite, ...acceptanceSuite].sort(), [...expected].sort());
  assert.deepEqual(
    acceptanceSuite,
    ACCEPTANCE_TEST_FILES.map((file) => path.join(root, file)),
  );
  assert.ok(expected.length >= 104, `expected at least 104 test files, found ${expected.length}`);
  assert.ok(expected.some((file) => file.endsWith("server/templates/prompts/prompt-templates.test.ts")));
  assert.ok(expected.some((file) => file.endsWith("server/state-machine/transitions.test.ts")));
});
