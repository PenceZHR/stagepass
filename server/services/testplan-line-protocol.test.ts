import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseTestPlanLineProtocol,
  validateTestPlanCommand,
} from "./testplan-line-protocol.ts";

const tempDirs: string[] = [];

function makeRepo(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "testplan-line-protocol-"));
  tempDirs.push(dir);
  for (const file of files) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "// fixture\n");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseTestPlanLineProtocol", () => {
  it("assembles the payload deterministically from protocol lines, ignoring prose", () => {
    const repo = makeRepo(["src/foo.js", "test/foo.test.js"]);
    const raw = [
      "先说明一下思路：覆盖单元与回归。",
      "INTENT: 证明 foo 的行为契约",
      "COVERAGE: unit-foo | foo 单元行为 | AC-1 | unit | P0",
      "COVERAGE: reg-suite | 全量回归 | - | regression | P1",
      "- RISK: unit-foo | AC-1 溢出 | P1 | 单测覆盖边界",
      "COMMAND!: node --test test/foo.test.js",
      "COMMAND?: node --check src/foo.js",
      "MANUAL?: 目检 README | 确认示例一致",
      "这行没有前缀，应当被忽略 { \"command\": \"rm -rf /\" }",
    ].join("\n");

    const result = parseTestPlanLineProtocol(raw, { repoPath: repo });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.payload.testIntent, "证明 foo 的行为契约");
    assert.deepEqual(result.payload.coverageItems[0], {
      itemKey: "unit-foo",
      title: "foo 单元行为",
      requirementRef: "AC-1",
      testType: "unit",
      priority: "P0",
    });
    assert.equal(result.payload.coverageItems[1]?.requirementRef, null);
    assert.deepEqual(result.payload.riskMappings, [{
      coverageItemKey: "unit-foo",
      riskRef: "AC-1 溢出",
      severity: "P1",
      mitigation: "单测覆盖边界",
    }]);
    assert.deepEqual(result.payload.requiredCommands, [
      { command: "node --test test/foo.test.js", required: true },
      { command: "node --check src/foo.js", required: false },
    ]);
    assert.deepEqual(result.payload.manualChecks, [
      { title: "目检 README", description: "确认示例一致", required: false },
    ]);
  });

  it("rejects the exact JSON-garbage command corruption observed live (},{ fragment)", () => {
    const repo = makeRepo(["src/foo.js", "test/foo.test.js"]);
    const raw = [
      "INTENT: x",
      "COVERAGE: k | t | - | unit | P0",
      "COMMAND!: node --check src/foo.js && node --check test/foo.test.js},{",
    ].join("\n");

    const result = parseTestPlanLineProtocol(raw, { repoPath: repo });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /JSON fragment garbage/);
  });

  it("rejects commands referencing files that do not exist (js1024-style suffix corruption)", () => {
    const repo = makeRepo(["test/slugify.test.js"]);
    const raw = [
      "INTENT: x",
      "COVERAGE: k | t | - | unit | P0",
      "COMMAND!: node --test test/slugify.test.js1024",
    ].join("\n");

    const result = parseTestPlanLineProtocol(raw, { repoPath: repo });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /does not exist in the repo \(test\/slugify\.test\.js1024\)/);
  });

  it("accepts globs over existing directories, $VAR tokens, and shell pipes in commands", () => {
    const repo = makeRepo(["test/a.test.js"]);
    const raw = [
      "INTENT: x",
      "COVERAGE: k | t | - | unit | P0",
      'COMMAND!: node --test "$PWD"/test/*.test.js',
      "COMMAND?: node --test test/a.test.js | tee /dev/null",
    ].join("\n");

    const result = parseTestPlanLineProtocol(raw, { repoPath: repo });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.payload.requiredCommands[1]?.command, "node --test test/a.test.js | tee /dev/null");
  });

  it("rejects missing INTENT, missing required command, and dangling RISK references", () => {
    const repo = makeRepo(["test/a.test.js"]);
    const raw = [
      "COVERAGE: k | t | - | unit | P0",
      "RISK: ghost | ref | P1 | mitigation",
      "COMMAND?: node --test test/a.test.js",
    ].join("\n");

    const result = parseTestPlanLineProtocol(raw, { repoPath: repo });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /exactly 1 INTENT/);
    assert.match(result.message, /at least 1 COMMAND!/);
    assert.match(result.message, /unknown coverageItemKey "ghost"/);
  });
});

describe("validateTestPlanCommand", () => {
  it("flags unbalanced quotes and backticks", () => {
    const repo = makeRepo([]);
    assert.match(validateTestPlanCommand('node -e "console.log(1)', { repoPath: repo }) ?? "", /unbalanced quotes/);
    assert.match(validateTestPlanCommand("echo `date`", { repoPath: repo }) ?? "", /backticks/);
    assert.equal(validateTestPlanCommand('node -e "console.log(1)"', { repoPath: repo }), null);
  });
});
