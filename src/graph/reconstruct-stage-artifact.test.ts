import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RepoOps } from "../work/repo";
import { reconstructStageArtifacts } from "./reconstruct-stage-artifact";

const SHA = "a1b2c3d4e5f6";

function repo(tracked: readonly string[], commit = true): RepoOps {
  return {
    dirtyPaths: () => [], commitAll: () => null, commitPaths: () => null,
    show: () => null, head: () => null, trackedFiles: () => tracked,
    changedFiles: (_cwd, sha) => commit && sha === SHA
      ? [{ path: "src/proven.ts", change: "modified" }] : null,
    fileAt: () => null, fileBefore: () => null, diffAt: () => null,
  };
}

describe("legacy Stage artifact reconstruction", () => {
  it("uses only exact fixed paths and a validated current evidence commit", () => {
    const result = reconstructStageArtifacts({
      root: "/repo",
      changeId: "CHG-1",
      phase: "Build",
      knownRound: 2,
      evidenceArtifactIds: ["notes", SHA],
      evidenceUpdatedAt: "2026-08-16T12:00:00.000Z",
      repo: repo([
        "docs/stagepass/CHG-1/Build-r1.md",
        "docs/stagepass/CHG-1/Build-r1-opposition.md",
        "docs/stagepass/CHG-1/Build-r2-notes.md",
        "src/current-worktree-only.ts",
      ]),
    });

    assert.deepEqual(result.artifacts.map((artifact) => artifact.round), [2, 1]);
    assert.ok(result.artifacts.every((artifact) => artifact.source === "reconstructed"));
    assert.equal(result.artifacts[0]?.commit, SHA);
    assert.deepEqual(result.artifacts[0]?.files.map((file) => file.path), ["src/proven.ts"]);
    assert.deepEqual(result.artifacts[1]?.files.map((file) => file.path), [
      "docs/stagepass/CHG-1/Build-r1-opposition.md",
      "docs/stagepass/CHG-1/Build-r1.md",
    ]);
    assert.deepEqual(result.incompleteRounds, []);
  });

  it("names unprovable rounds instead of filling them from the worktree", () => {
    const result = reconstructStageArtifacts({
      root: "/repo",
      changeId: "CHG-1",
      phase: "Build",
      knownRound: 2,
      evidenceArtifactIds: ["not-a-commit"],
      evidenceUpdatedAt: null,
      repo: repo(["docs/stagepass/CHG-1/Build-r1.md"], false),
    });
    assert.deepEqual(result.artifacts.map((artifact) => artifact.round), [1]);
    assert.deepEqual(result.incompleteRounds, [2]);
  });

  it("does not treat fuzzy names or a missing repository as history", () => {
    const noRepo = repo([], false);
    noRepo.trackedFiles = () => null;
    assert.equal(reconstructStageArtifacts({
      root: "/repo", changeId: "CHG-1", phase: "Build", knownRound: 1,
      evidenceArtifactIds: [], evidenceUpdatedAt: null, repo: noRepo,
    }).reason, "not-a-repo");
  });
});
