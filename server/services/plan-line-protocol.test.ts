import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parsePlanLineProtocol } from "./plan-line-protocol.ts";

const CTX = { changeId: "CHG-TEST", repoPath: process.cwd() };

describe("parsePlanLineProtocol", () => {
  it("assembles PlanJson deterministically, ignoring prose and preserving pipes in descriptions", () => {
    const raw = [
      "先说明拆分思路（这行会被忽略）。",
      "PLAN: 新增 formatDuration 纯函数",
      "EXPECT: src/format-duration.js",
      "EXPECT: test/format-duration.test.js",
      "FORBID: package.json",
      "FORBID: app/**",
      "STEP: 2 | test/format-duration.test.js | pending | 新建 node:test 单测，覆盖 0 | 59 | 60 边界",
      "STEP: 1 | src/format-duration.js | pending | 导出 formatDuration(totalSeconds: number): string",
      "TEST: 边界与异常路径有单测覆盖",
      "COMMAND: node --test test/format-duration.test.js",
      "RISK: 超大秒数精度待确认",
    ].join("\n");

    const result = parsePlanLineProtocol(raw, CTX);

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.payload.planName, "新增 formatDuration 纯函数");
    assert.deepEqual(result.payload.expectedFiles, ["src/format-duration.js", "test/format-duration.test.js"]);
    assert.deepEqual(result.payload.forbiddenFiles, ["package.json", "app/**"]);
    // Steps are sorted by number; pipes inside the description survive.
    assert.deepEqual(result.payload.implementationSteps?.map((step) => step.step), [1, 2]);
    assert.equal(
      result.payload.implementationSteps?.[1]?.description,
      "新建 node:test 单测，覆盖 0 | 59 | 60 边界",
    );
    assert.deepEqual(result.payload.validationCommands, ["node --test test/format-duration.test.js"]);
  });

  it("rejects a STEP whose file is not declared in EXPECT (the P0-interceptor round-trip, caught early)", () => {
    const raw = [
      "PLAN: x",
      "EXPECT: src/a.js",
      "STEP: 1 | src/b.js | pending | 修改 b",
    ].join("\n");

    const result = parsePlanLineProtocol(raw, CTX);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /STEP 1 的文件未在 EXPECT 中声明: src\/b\.js/);
  });

  it("rejects duplicate step numbers, EXPECT∩FORBID overlap, and garbage commands", () => {
    const raw = [
      "PLAN: x",
      "EXPECT: src/a.js",
      "FORBID: src/a.js",
      "STEP: 1 | src/a.js | pending | 改 a",
      "STEP: 1 | src/a.js | pending | 又改 a",
      "COMMAND: node --check src/a.js},{",
    ].join("\n");

    const result = parsePlanLineProtocol(raw, CTX);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /duplicate STEP 编号 1/);
    assert.match(result.message, /listed in both EXPECT and FORBID/);
    assert.match(result.message, /JSON fragment garbage/);
  });

  it("rejects missing PLAN/EXPECT/STEP and absolute or traversal paths", () => {
    const raw = [
      "EXPECT: /etc/passwd",
      "EXPECT: ../outside.js",
    ].join("\n");

    const result = parsePlanLineProtocol(raw, CTX);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /exactly 1 PLAN line, got 0/);
    assert.match(result.message, /at least 1 STEP line/);
    assert.match(result.message, /must be repo-relative/);
    assert.match(result.message, /escapes the repo root/);
  });
});
