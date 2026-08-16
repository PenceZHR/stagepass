import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertStageRoundArtifact,
  compareStageRounds,
  materializeStageRound,
  type StageRoundArtifact,
} from "./stage-artifact";

const R1: StageRoundArtifact = {
  changeId: "CHG-1",
  phase: "Build",
  round: 1,
  jobId: "JOB-1",
  artifactIds: ["a1b2c3d"],
  commit: "a1b2c3d",
  source: "recorded",
  files: [
    { path: "src/a.ts", role: "delivery", change: "added" },
    { path: "src/old.ts", role: "delivery", change: "added" },
    {
      path: "docs/stagepass/CHG-1/Build-r1.md",
      role: "producer",
      change: "added",
    },
  ],
  upstream: [{ phase: "Arch", artifactIds: ["docs/stagepass/CHG-1/Arch-r1.md"] }],
  settledAt: "2026-08-16T12:00:00.000Z",
};

describe("stage artifact manifest", () => {
  it("treats the first round's files as added", () => {
    assert.deepEqual(
      compareStageRounds(null, R1).map((file) => file.display),
      ["added", "added", "added"],
    );
  });

  it("folds deltas without inventing deletion", () => {
    const r2: StageRoundArtifact = {
      ...R1,
      round: 2,
      jobId: "JOB-2",
      commit: "b2c3d4e",
      artifactIds: ["b2c3d4e"],
      files: [
        { path: "src/a.ts", role: "delivery", change: "modified" },
        {
          path: "src/new.ts",
          previousPath: "src/old.ts",
          role: "delivery",
          change: "renamed",
        },
      ],
      settledAt: "2026-08-16T13:00:00.000Z",
    };
    const snapshot = materializeStageRound([R1, r2], 2);

    assert.deepEqual(
      snapshot.files.map((file) => [file.path, file.display]),
      [
        ["docs/stagepass/CHG-1/Build-r1.md", "unchanged"],
        ["src/a.ts", "modified"],
        ["src/new.ts", "replaced"],
      ],
    );
  });

  it("marks only an explicit deletion as deleted", () => {
    const r2: StageRoundArtifact = {
      ...R1,
      round: 2,
      jobId: "JOB-2",
      commit: "b2c3d4e",
      artifactIds: ["b2c3d4e"],
      files: [{ path: "src/a.ts", role: "delivery", change: "deleted" }],
      settledAt: "2026-08-16T13:00:00.000Z",
    };
    const snapshot = materializeStageRound([R1, r2], 2);
    assert.equal(snapshot.files.find((file) => file.path === "src/a.ts")?.display, "deleted");
    assert.equal(
      snapshot.files.find((file) => file.path.endsWith("Build-r1.md"))?.display,
      "unchanged",
    );
  });

  it("rejects malformed identity, phase, round and paths", () => {
    assert.throws(() => assertStageRoundArtifact({ ...R1, changeId: " " }), /changeId/);
    assert.throws(
      () => assertStageRoundArtifact({ ...R1, phase: "Implement" as "Build" }),
      /phase/,
    );
    assert.throws(() => assertStageRoundArtifact({ ...R1, round: 0 }), /round/);
    assert.throws(
      () => assertStageRoundArtifact({
        ...R1,
        files: [{ path: "../outside", role: "delivery", change: "added" }],
      }),
      /path/,
    );
    assert.throws(
      () => assertStageRoundArtifact({
        ...R1,
        files: [{ path: "/absolute", role: "delivery", change: "added" }],
      }),
      /path/,
    );
  });
});
