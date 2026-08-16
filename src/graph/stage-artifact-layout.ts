import type {
  DisplayChange,
  MaterializedStageRound,
  StageRoundArtifact,
} from "../domain/stage-artifact";
import {
  blastRadiusOf,
  dependenciesOf,
  dependentsOf,
  type ModuleGraph,
} from "./module-graph";

export const STAGE_FOLDER_AGGREGATION_THRESHOLD = 12;

export interface StageInputNode {
  readonly id: string;
  readonly phase: string;
  readonly artifactIds: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface StageFolderNode {
  readonly id: string;
  readonly path: string;
  readonly count: number;
  readonly aggregated: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface StageFileNode {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  readonly role: string;
  readonly display: DisplayChange;
  readonly commit: string | null;
  readonly changedInRound: number;
  readonly code: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface StageProductionEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "input-folder" | "folder-file";
}

export interface StageDependencyEntry {
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
  readonly blast: number;
}

export interface StageArtifactScene {
  readonly round: number | null;
  readonly source: StageRoundArtifact["source"] | null;
  readonly empty: boolean;
  readonly inputs: readonly StageInputNode[];
  readonly folders: readonly StageFolderNode[];
  readonly files: readonly StageFileNode[];
  readonly production: readonly StageProductionEdge[];
  readonly dependencyIndex: Readonly<Record<string, StageDependencyEntry>>;
}

export interface SelectedStageDependencies extends StageDependencyEntry {
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly direction: "dependency" | "dependent";
  }[];
}

const CODE_SUFFIX = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const folderOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";

const centered = (index: number, total: number, gap: number): number =>
  (index - (total - 1) / 2) * gap;

function dependencyIndex(
  current: MaterializedStageRound,
  graph: ModuleGraph | null,
): Readonly<Record<string, StageDependencyEntry>> {
  if (graph === null) return {};
  const visible = new Set(current.files.map((file) => file.path));
  const modules = new Set(graph.modules.map((module) => module.path));
  const index: Record<string, StageDependencyEntry> = {};
  for (const file of current.files) {
    if (!CODE_SUFFIX.test(file.path) || !modules.has(file.path)) continue;
    index[file.path] = {
      dependencies: dependenciesOf(graph, file.path).filter((path) => visible.has(path)),
      dependents: dependentsOf(graph, file.path).filter((path) => visible.has(path)),
      blast: blastRadiusOf(graph, file.path).filter((path) => visible.has(path)).length,
    };
  }
  return index;
}

export function layoutStageArtifacts(input: {
  current: MaterializedStageRound | null;
  graph: ModuleGraph | null;
}): StageArtifactScene {
  if (input.current === null) {
    return {
      round: null, source: null, empty: true, inputs: [], folders: [], files: [],
      production: [], dependencyIndex: {},
    };
  }
  const current = input.current;
  const inputs: StageInputNode[] = current.upstream.map((entry, index) => ({
    id: `input:${entry.phase}`,
    phase: entry.phase,
    artifactIds: entry.artifactIds,
    x: -20,
    y: 0,
    z: centered(index, current.upstream.length, 7),
  }));
  const grouped = new Map<string, typeof current.files[number][]>();
  for (const file of current.files) {
    const folder = folderOf(file.path);
    grouped.set(folder, [...(grouped.get(folder) ?? []), file]);
  }
  const folderPaths = [...grouped.keys()].sort();
  const folders: StageFolderNode[] = folderPaths.map((path, index) => ({
    id: `folder:${path}`,
    path,
    count: grouped.get(path)!.length,
    aggregated: grouped.get(path)!.length > STAGE_FOLDER_AGGREGATION_THRESHOLD,
    x: 0,
    y: 0,
    z: centered(index, folderPaths.length, 10),
  }));
  const files: StageFileNode[] = [];
  for (const [folderIndex, folder] of folderPaths.entries()) {
    const entries = [...grouped.get(folder)!].sort((left, right) =>
      left.path.localeCompare(right.path));
    for (const [index, file] of entries.entries()) {
      const angle = index * 2.39996;
      const radius = 2 + Math.sqrt(index + 1) * 1.7;
      files.push({
        id: `file:${file.path}`,
        path: file.path,
        name: file.path.slice(file.path.lastIndexOf("/") + 1),
        folder,
        role: file.role,
        display: file.display,
        commit: file.commit,
        changedInRound: file.changedInRound,
        code: CODE_SUFFIX.test(file.path),
        x: 14 + radius * Math.cos(angle),
        y: radius * Math.sin(angle) * 0.25,
        z: centered(folderIndex, folderPaths.length, 10) + radius * Math.sin(angle),
      });
    }
  }
  const production: StageProductionEdge[] = [
    ...inputs.flatMap((source) => folders.map((folder) => ({
      from: source.id, to: folder.id, kind: "input-folder" as const,
    }))),
    ...files.map((file) => ({
      from: `folder:${file.folder}`, to: file.id, kind: "folder-file" as const,
    })),
  ];
  return {
    round: current.round,
    source: current.source,
    empty: files.length === 0,
    inputs,
    folders,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    production,
    dependencyIndex: dependencyIndex(current, input.graph),
  };
}

export function selectedDependencies(
  scene: StageArtifactScene,
  path: string,
): SelectedStageDependencies {
  const entry = scene.dependencyIndex[path]
    ?? { dependencies: [], dependents: [], blast: 0 };
  return {
    ...entry,
    edges: [
      ...entry.dependencies.map((to) => ({
        from: path, to, direction: "dependency" as const,
      })),
      ...entry.dependents.map((from) => ({
        from, to: path, direction: "dependent" as const,
      })),
    ],
  };
}
