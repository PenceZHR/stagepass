import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  materializeStageRound,
  type StageRoundArtifact,
} from "../domain/stage-artifact";
import { parseModuleGraph } from "./module-graph";
import {
  layoutStageArtifacts,
  selectedDependencies,
  STAGE_FOLDER_AGGREGATION_THRESHOLD,
} from "./stage-artifact-layout";

const R1: StageRoundArtifact = {
  changeId: "CHG-1",
  phase: "Build",
  round: 1,
  jobId: "JOB-1",
  artifactIds: ["a1b2c3d"],
  commit: "a1b2c3d",
  source: "recorded",
  files: [
    { path: "src/core/a.ts", role: "delivery", change: "added" },
    { path: "src/ui/b.ts", role: "delivery", change: "added" },
    { path: "docs/report.md", role: "producer", change: "added" },
  ],
  upstream: [
    { phase: "Arch", artifactIds: ["arch.md"] },
    { phase: "BuildPlan", artifactIds: ["plan.md"] },
  ],
  settledAt: "2026-08-16T12:00:00.000Z",
};

const R2: StageRoundArtifact = {
  ...R1,
  round: 2,
  jobId: "JOB-2",
  artifactIds: ["b2c3d4e"],
  commit: "b2c3d4e",
  files: [{ path: "src/core/a.ts", role: "delivery", change: "modified" }],
  settledAt: "2026-08-16T13:00:00.000Z",
};

const graph = parseModuleGraph([
  { path: "src/core/a.ts", text: 'import { b } from "../ui/b"; export const a = b;\n' },
  { path: "src/ui/b.ts", text: "export const b = 1;\n" },
]);

describe("Stage artifact layout", () => {
  it("lays out production lineage, folders and selected dependencies deterministically", () => {
    const current = materializeStageRound([R1, R2], 2);
    const scene = layoutStageArtifacts({ current, graph });
    assert.deepEqual(scene.inputs.map((node) => node.phase), ["Arch", "BuildPlan"]);
    assert.deepEqual(scene.folders.map((folder) => folder.path), ["docs", "src/core", "src/ui"]);
    assert.equal(scene.files.find((file) => file.path === "src/core/a.ts")?.display, "modified");
    assert.equal(scene.files.find((file) => file.path === "src/ui/b.ts")?.display, "unchanged");
    assert.deepEqual(selectedDependencies(scene, "src/core/a.ts").dependencies, ["src/ui/b.ts"]);
    assert.deepEqual(selectedDependencies(scene, "src/ui/b.ts").dependents, ["src/core/a.ts"]);
    assert.deepEqual(layoutStageArtifacts({ current, graph }), scene);
  });

  it("does not invent dependency edges for non-code files", () => {
    const scene = layoutStageArtifacts({ current: materializeStageRound([R1], 1), graph });
    assert.deepEqual(selectedDependencies(scene, "docs/report.md"), {
      dependencies: [], dependents: [], edges: [], blast: 0,
    });
  });

  it("returns an explicit empty scene", () => {
    assert.deepEqual(layoutStageArtifacts({ current: null, graph: null }), {
      round: null,
      source: null,
      empty: true,
      inputs: [],
      folders: [],
      files: [],
      production: [],
      dependencyIndex: {},
    });
  });

  it("marks dense folders for aggregation without dropping file buttons", () => {
    const files = Array.from({ length: STAGE_FOLDER_AGGREGATION_THRESHOLD + 1 }, (_, index) => ({
      path: `src/dense/f${index}.ts`, role: "delivery" as const, change: "added" as const,
    }));
    const current = materializeStageRound([{ ...R1, files }], 1);
    const scene = layoutStageArtifacts({ current, graph: parseModuleGraph([]) });
    assert.equal(scene.folders[0]?.aggregated, true);
    assert.equal(scene.files.length, files.length);
  });
});
