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

const distance = (
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);

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
      hub: null,
      inputs: [],
      folders: [],
      files: [],
      production: [],
      dependencyIndex: {},
    });
  });

  it("puts every file inside its own directory region", () => {
    // 目录要成为看得出来的区域。文件必须离自己的目录锚点最近 —— 否则画出来就是
    // 一坨认不出归属的球，真机上 22 个文件正是这个样子。
    const current = materializeStageRound([{
      ...R1,
      files: [
        ...Array.from({ length: 6 }, (_, i) => ({
          path: `src/core/c${i}.ts`, role: "delivery" as const, change: "added" as const,
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          path: `src/ui/u${i}.ts`, role: "delivery" as const, change: "added" as const,
        })),
        ...Array.from({ length: 9 }, (_, i) => ({
          path: `docs/d${i}.md`, role: "producer" as const, change: "added" as const,
        })),
      ],
    }], 1);
    const scene = layoutStageArtifacts({ current, graph: parseModuleGraph([]) });
    const anchors = new Map(scene.folders.map((folder) => [folder.path, folder]));
    for (const file of scene.files) {
      const own = anchors.get(file.folder)!;
      const ownDistance = distance(file, own);
      for (const other of scene.folders) {
        if (other.path === file.folder) continue;
        assert.ok(
          ownDistance < distance(file, other),
          `${file.path} 离 ${other.path} 比离自己的目录 ${file.folder} 还近`,
        );
      }
    }
  });

  it("keeps directory regions from swallowing each other", () => {
    const current = materializeStageRound([{
      ...R1,
      files: Array.from({ length: 24 }, (_, i) => ({
        path: `pkg/m${i % 6}/f${i}.ts`, role: "delivery" as const, change: "added" as const,
      })),
    }], 1);
    const scene = layoutStageArtifacts({ current, graph: parseModuleGraph([]) });
    assert.equal(scene.folders.length, 6);
    for (const left of scene.folders) {
      for (const right of scene.folders) {
        if (left.path >= right.path) continue;
        assert.ok(
          distance(left, right) >= left.radius + right.radius,
          `${left.path} 和 ${right.path} 的区域重叠了`,
        );
      }
    }
  });

  it("draws production lineage once per node instead of an input×folder cross product", () => {
    // 旧实现给每个上游都连了每个目录：2 上游 × 3 目录 = 6 条线，而它们一条也不成立。
    // 真话只有一句：这一轮的全部上游喂给了这一轮，这一轮产出了这些目录和文件。
    const current = materializeStageRound([R1], 1);
    const scene = layoutStageArtifacts({ current, graph });
    assert.equal(scene.inputs.length, 2);
    assert.equal(scene.folders.length, 3);
    assert.equal(scene.files.length, 3);
    const kinds = new Map();
    for (const edge of scene.production) kinds.set(edge.kind, (kinds.get(edge.kind) ?? 0) + 1);
    assert.equal(kinds.get("input-round"), 2, "每个上游一条线");
    assert.equal(kinds.get("round-folder"), 3, "每个目录一条线");
    assert.equal(kinds.get("folder-file"), 3, "每个文件一条线");
    const ids = new Set([
      scene.round === null ? "" : "round",
      ...scene.inputs.map((node) => node.id),
      ...scene.folders.map((node) => node.id),
      ...scene.files.map((node) => node.id),
    ]);
    for (const edge of scene.production) {
      assert.ok(ids.has(edge.from), `${edge.from} 不是场景里的节点`);
      assert.ok(ids.has(edge.to), `${edge.to} 不是场景里的节点`);
    }
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
