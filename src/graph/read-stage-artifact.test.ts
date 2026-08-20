import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { MaterializedStageRound } from "../domain/stage-artifact";
import { createRepoOps } from "../work/repo";
import { readStageArtifact } from "./read-stage-artifact";

function fixture(): { root: string; round: MaterializedStageRound } {
  const root = mkdtempSync(join(tmpdir(), "stagepass-artifact-reader-"));
  const git = (...args: string[]): string => execFileSync("git", args, {
    cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
  });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "code.ts"), "export const before = 1;\n");
  writeFileSync(join(root, "deleted.ts"), "before deletion\n");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(root, "tracked-not-in-manifest.ts"), "secret-ish\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "code.ts"), "export const changed = 2;\n");
  unlinkSync(join(root, "deleted.ts"));
  git("add", "-A");
  git("commit", "-q", "-m", "delta");
  const delta = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "current.md"), "# Current\n");

  return {
    root,
    round: {
      changeId: "CHG-1", phase: "Build", round: 2, jobId: "JOB-2",
      artifactIds: [delta], commit: delta, source: "recorded", upstream: [],
      settledAt: "2026-08-16T12:00:00.000Z",
      files: [
        {
          path: "binary.bin", role: "delivery", change: "added", display: "unchanged",
          commit: base, changedInRound: 1,
        },
        {
          path: "code.ts", role: "delivery", change: "modified", display: "modified",
          commit: delta, changedInRound: 2,
        },
        {
          path: "current.md", role: "producer", change: "modified", display: "modified",
          commit: null, changedInRound: 2,
        },
        {
          path: "deleted.ts", role: "delivery", change: "deleted", display: "deleted",
          commit: delta, changedInRound: 2,
        },
      ],
    },
  };
}

describe("Stage artifact reader", () => {
  it("fails closed on traversal, non-membership and commit injection", () => {
    const { root, round } = fixture();
    const repo = createRepoOps();
    assert.equal(readStageArtifact({ root, round, path: "../../.ssh/id_rsa", repo }).reason,
      "path-outside");
    assert.equal(readStageArtifact({
      root, round, path: "tracked-not-in-manifest.ts", repo,
    }).reason, "path-not-in-round");
    assert.equal(readStageArtifact({
      root, round, path: "code.ts", requestedCommit: "0000000", repo,
    }).reason, "commit-mismatch");
  });

  it("reads historical text, patch, deleted content and binary metadata", () => {
    const { root, round } = fixture();
    const repo = createRepoOps();
    const code = readStageArtifact({ root, round, path: "code.ts", repo });
    assert.equal(code.ok, true);
    if (code.ok && code.kind === "text") {
      assert.match(code.content, /changed/);
      assert.match(code.diff ?? "", /^\+export const changed/m);
    }
    const deleted = readStageArtifact({ root, round, path: "deleted.ts", repo });
    assert.equal(deleted.ok, true);
    if (deleted.ok && deleted.kind === "text") assert.match(deleted.content, /before deletion/);
    const binary = readStageArtifact({ root, round, path: "binary.bin", repo });
    assert.deepEqual(binary.ok && binary.kind === "binary"
      ? { kind: binary.kind, size: binary.size } : binary,
    { kind: "binary", size: 4 });
  });

  it("fences current files by realpath and size", () => {
    const { root, round } = fixture();
    const outside = join(mkdtempSync(join(tmpdir(), "stagepass-outside-")), "outside.md");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(root, "escape.md"));
    const escaped = {
      ...round,
      files: [...round.files, {
        path: "escape.md", role: "delivery" as const, change: "modified" as const,
        display: "modified" as const, commit: null, changedInRound: 2,
      }],
    };
    assert.equal(readStageArtifact({
      root, round: escaped, path: "escape.md", repo: createRepoOps(),
    }).reason, "path-outside");

    writeFileSync(join(root, "huge.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    const huge = {
      ...round,
      files: [...round.files, {
        path: "huge.txt", role: "delivery" as const, change: "modified" as const,
        display: "modified" as const, commit: null, changedInRound: 2,
      }],
    };
    assert.equal(readStageArtifact({
      root, round: huge, path: "huge.txt", repo: createRepoOps(),
    }).reason, "file-too-large");
  });

  it("does not fall back when the recorded commit is unavailable", () => {
    const { root, round } = fixture();
    const missing = {
      ...round,
      files: round.files.map((file) => file.path === "code.ts"
        ? { ...file, commit: "0000000" } : file),
    };
    assert.equal(readStageArtifact({
      root, round: missing, path: "code.ts", repo: createRepoOps(),
    }).reason, "file-unavailable");
  });
});
