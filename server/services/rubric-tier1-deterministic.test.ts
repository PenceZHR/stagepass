import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RUBRIC_PHASES } from "./rubric-assessment.ts";
import {
  DEFAULT_BLOCKED_PATTERNS,
  DEFAULT_STAGE_SCOPES,
} from "./stage-guard-service.ts";
import { tier1DeterministicChecks } from "./rubric-tier1-deterministic.ts";

/**
 * 纯读派生，无 DB：这个模块唯一的外部输入是 repoPath 下的 .ship/policy.json，
 * 所以测试只需要临时目录。任何需要种 DB 行的断言都不属于这里——那说明模块
 * 偷偷长出了第二个数据源。
 */

let emptyRepo: string;
let policyRepo: string;
let brokenRepo: string;

before(() => {
  emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t1det-empty-"));
  policyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t1det-policy-"));
  brokenRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t1det-broken-"));
  fs.mkdirSync(path.join(policyRepo, ".ship"), { recursive: true });
  fs.writeFileSync(
    path.join(policyRepo, ".ship", "policy.json"),
    JSON.stringify({ blockedGlobs: ["secrets/**"], blockedFiles: ["infra/prod.ts"] }),
  );
  fs.mkdirSync(path.join(brokenRepo, ".ship"), { recursive: true });
  fs.writeFileSync(path.join(brokenRepo, ".ship", "policy.json"), "{not json");
});

after(() => {
  for (const dir of [emptyRepo, policyRepo, brokenRepo]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("shape: every item names a real enforcement point", () => {
  it("gives every phase's every item non-empty id/title/detail/enforcedBy", () => {
    for (const phase of RUBRIC_PHASES) {
      for (const item of tier1DeterministicChecks({ phase, repoPath: emptyRepo })) {
        for (const field of ["id", "title", "detail", "enforcedBy"] as const) {
          assert.ok(item[field].length > 0, `${phase} ${item.id} has empty ${field}`);
        }
        assert.match(
          item.enforcedBy,
          / · /,
          `${phase} ${item.id}: enforcedBy must read service · function, got ${item.enforcedBy}`,
        );
      }
    }
  });

  it("keeps ids unique within one phase's list", () => {
    for (const phase of RUBRIC_PHASES) {
      const ids = tier1DeterministicChecks({ phase, repoPath: emptyRepo }).map((i) => i.id);
      assert.deepEqual(ids, [...new Set(ids)], `${phase} repeats an id`);
    }
  });
});

describe("stage write scope comes from DEFAULT_STAGE_SCOPES, not a copy", () => {
  it("presents Spec's writable patterns verbatim", () => {
    const items = tier1DeterministicChecks({ phase: "Spec", repoPath: emptyRepo });
    const scope = items.find((item) => item.id === "stage-write-scope");
    assert.ok(scope, "Spec has a write-scope item");
    for (const pattern of DEFAULT_STAGE_SCOPES.spec.writableFiles) {
      assert.ok(
        scope!.detail.includes(pattern),
        `Spec detail must list ${pattern} -- a paraphrase would drift from the enforced set`,
      );
    }
    assert.match(scope!.enforcedBy, /validatePlannedChanges/);
  });

  it("presents Done's delivery.md-only scope", () => {
    const items = tier1DeterministicChecks({ phase: "Done", repoPath: emptyRepo });
    const scope = items.find((item) => item.id === "stage-write-scope")!;
    assert.ok(scope.detail.includes(".ship/changes/**/delivery.md"));
    assert.match(scope.enforcedBy, /validatePlannedChanges/);
  });

  it("describes Plan and Refine as read-only via validateReadOnlyStage", () => {
    for (const phase of ["Plan", "Refine"] as const) {
      const items = tier1DeterministicChecks({ phase, repoPath: emptyRepo });
      assert.equal(items.length, 1, `${phase} has exactly the read-only item`);
      assert.match(items[0]!.enforcedBy, /validateReadOnlyStage/);
    }
  });
});

describe("policy blockedGlobs: missing and empty are different answers", () => {
  it("flags a missing policy file instead of showing an empty list", () => {
    const items = tier1DeterministicChecks({ phase: "Build", repoPath: emptyRepo });
    const policy = items.find((item) => item.id === "policy-blocked-globs")!;
    assert.match(policy.detail, /策略文件缺失/);
    for (const pattern of DEFAULT_BLOCKED_PATTERNS) {
      assert.ok(
        policy.detail.includes(pattern),
        `missing-file detail must still list the built-in default ${pattern}`,
      );
    }
  });

  it("shows the merged glob set the gate actually receives when the file exists", () => {
    const items = tier1DeterministicChecks({ phase: "Build", repoPath: policyRepo });
    const policy = items.find((item) => item.id === "policy-blocked-globs")!;
    assert.doesNotMatch(policy.detail, /策略文件缺失/);
    assert.ok(policy.detail.includes("secrets/**"), "policy's own glob is shown");
    assert.ok(
      policy.detail.includes("infra/prod.ts"),
      "blockedFiles are folded into blockedGlobs by loadPolicy, and the display must match",
    );
    for (const pattern of DEFAULT_BLOCKED_PATTERNS) {
      assert.ok(policy.detail.includes(pattern), `defaults stay in the merged set: ${pattern}`);
    }
  });

  it("flags an unparseable policy file as unreadable, not as empty", () => {
    const items = tier1DeterministicChecks({ phase: "Build", repoPath: brokenRepo });
    const policy = items.find((item) => item.id === "policy-blocked-globs")!;
    assert.match(policy.detail, /无法解析/);
    assert.ok(policy.detail.includes(DEFAULT_BLOCKED_PATTERNS[0]!));
  });

  it("flags an empty repoPath (project row without a real checkout) as missing", () => {
    const items = tier1DeterministicChecks({ phase: "Build", repoPath: "" });
    assert.match(items.find((item) => item.id === "policy-blocked-globs")!.detail, /策略文件缺失/);
  });
});

describe("per-phase coverage", () => {
  it("gives QA the scope check, its own write scope, and the policy list", () => {
    const ids = tier1DeterministicChecks({ phase: "QA", repoPath: emptyRepo }).map((i) => i.id);
    assert.deepEqual(ids, ["qa-scope-check", "qa-write-scope", "policy-blocked-globs"]);
  });

  it("gives Build the plan scope and the policy list", () => {
    const items = tier1DeterministicChecks({ phase: "Build", repoPath: emptyRepo });
    assert.deepEqual(items.map((i) => i.id), ["plan-scope", "policy-blocked-globs"]);
    assert.match(items[0]!.enforcedBy, /evaluateBuildGate/);
  });

  it("gives Fix the open-findings scope and the policy list", () => {
    const items = tier1DeterministicChecks({ phase: "Fix", repoPath: emptyRepo });
    assert.deepEqual(items.map((i) => i.id), ["fix-scope", "policy-blocked-globs"]);
    assert.match(items[0]!.enforcedBy, /validateFixScope/);
  });

  it("returns an empty list for Merge, which runs no model and writes no files", () => {
    assert.deepEqual(tier1DeterministicChecks({ phase: "Merge", repoPath: emptyRepo }), []);
  });
});
