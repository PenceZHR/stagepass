import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const scriptPath = path.join(
  process.cwd(),
  "server/scripts/repair-stuck-review-blockers.ts",
);

function scriptSource(): string {
  return fs.readFileSync(scriptPath, "utf-8");
}

function applyBlock(source: string): string {
  const marker = "if (!apply)";
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, "script should branch on apply");

  const elseIndex = source.indexOf("else", markerIndex);
  assert.notEqual(elseIndex, -1, "script should have an apply else branch");

  return source.slice(elseIndex);
}

describe("repair-stuck-review-blockers script source contract", () => {
  it("defaults to dry-run unless --apply is present", () => {
    assert.match(scriptSource(), /const apply = process\.argv\.includes\("--apply"\);/);
  });

  it("keeps dry-run free of writable DB/service imports", () => {
    const source = scriptSource();

    assert.doesNotMatch(source, /from\s+["']\.\.\/db["']/);
    assert.doesNotMatch(source, /from\s+["']\.\.\/services\/review-center-service["']/);
    assert.doesNotMatch(source, /from\s+["']\.\.\/services\/change-status-service["']/);
    assert.match(source, /readonly:\s*true/);
    assert.match(source, /fileMustExist:\s*true/);
  });

  it("loads writable services only in the apply path", () => {
    const source = scriptSource();
    const dryRunBlock = source.slice(0, source.indexOf("if (!apply)"));
    const writeBlock = applyBlock(source);

    assert.doesNotMatch(dryRunBlock, /import\(["']\.\.\/db["']\)/);
    assert.doesNotMatch(dryRunBlock, /import\(["']\.\.\/services\/review-center-service["']\)/);
    assert.doesNotMatch(dryRunBlock, /import\(["']\.\.\/services\/change-status-service["']\)/);
    assert.match(writeBlock, /import\(["']\.\.\/services\/review-center-service["']\)/);
    assert.match(writeBlock, /import\(["']\.\.\/services\/change-status-service["']\)/);
  });

  it("uses audited two-step status transitions without directly updating changes", () => {
    const source = scriptSource();

    assert.match(source, /transitionChangeStatus/);
    assert.match(source, /to:\s*"BLOCKED"/);
    assert.match(source, /to:\s*"CHECK_FAILED"/);
    assert.doesNotMatch(source, /\.update\s*\(\s*changes\s*\)/);
  });

  it("skips active runs and human-gated build states", () => {
    const source = scriptSource();

    assert.match(source, /hasRunningRun/);
    assert.match(source, /isAwaitingHumanBuildOrFix/);
    assert.match(source, /awaiting_human/);
    assert.match(source, /approved_for_absorb/);
  });
});
