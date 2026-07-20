import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveChangeFilePath } from "./change-file-access.ts";

describe("resolveChangeFilePath", () => {
  let repoRoot: string;
  let outsideDir: string;

  before(() => {
    repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cfa-repo-")));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cfa-out-")));

    fs.mkdirSync(path.join(repoRoot, ".ship", "changes", "CHG-1"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".ship", "changes", "CHG-1", "plan.json"),
      JSON.stringify({ ok: true }),
    );
    fs.writeFileSync(path.join(repoRoot, "src.ts"), "export const x = 1;");
    fs.mkdirSync(path.join(repoRoot, "subdir"));

    // A secret outside the repo + a symlink inside the repo that points at it.
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET");
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(repoRoot, "escape-link"));
  });

  after(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("resolves a repo-relative file", () => {
    const r = resolveChangeFilePath(".ship/changes/CHG-1/plan.json", repoRoot);
    assert.equal(r.ok, true);
    assert.equal(
      r.ok && r.file.relativePath,
      path.join(".ship", "changes", "CHG-1", "plan.json"),
    );
  });

  it("resolves an absolute file inside the repo", () => {
    const r = resolveChangeFilePath(path.join(repoRoot, "src.ts"), repoRoot);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.file.relativePath, "src.ts");
  });

  it("rejects ../ traversal that escapes the repo", () => {
    const escaping = path.relative(repoRoot, path.join(outsideDir, "secret.txt"));
    const r = resolveChangeFilePath(escaping, repoRoot);
    assert.deepEqual(r, { ok: false, error: "outside_repo" });
  });

  it("rejects a symlink inside the repo that points outside (symlink escape)", () => {
    const r = resolveChangeFilePath("escape-link", repoRoot);
    assert.deepEqual(r, { ok: false, error: "outside_repo" });
  });

  it("rejects an absolute path outside the repo", () => {
    const r = resolveChangeFilePath(path.join(outsideDir, "secret.txt"), repoRoot);
    assert.deepEqual(r, { ok: false, error: "outside_repo" });
  });

  it("reports not_found for a missing file", () => {
    const r = resolveChangeFilePath("does-not-exist.txt", repoRoot);
    assert.deepEqual(r, { ok: false, error: "not_found" });
  });

  it("reports not_a_file for a directory", () => {
    const r = resolveChangeFilePath("subdir", repoRoot);
    assert.deepEqual(r, { ok: false, error: "not_a_file" });
  });

  it("rejects empty, whitespace, null-byte, and non-string input", () => {
    const nullByte = "with" + String.fromCharCode(0) + "null";
    const badInputs: unknown[] = ["", "   ", nullByte, null, undefined, 42, {}];
    for (const bad of badInputs) {
      const r = resolveChangeFilePath(bad, repoRoot);
      assert.deepEqual(r, { ok: false, error: "invalid_input" }, `input: ${String(bad)}`);
    }
  });
});
