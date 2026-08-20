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
  /** 这个目录的区域半径；两个目录的中心距不会小于两个半径之和。 */
  readonly radius: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 这一轮本身。上游喂给它，它产出目录 —— 谱系里唯一成立的那句话。 */
export interface StageRoundNode {
  readonly id: "round";
  readonly round: number;
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
  readonly kind: "input-round" | "round-folder" | "folder-file";
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
  readonly hub: StageRoundNode | null;
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

/** 黄金角。同一个目录里的文件按向日葵铺开，密的地方也不会叠在一起。 */
const GOLDEN_ANGLE = 2.399963229728653;
/** 两个目录区域之间至少留这么宽的空隙，文件才不会看起来像是别人家的。 */
const REGION_MARGIN = 4;
/** 文件只铺到自己区域半径的这个比例，边缘留给标签。 */
const FILE_FILL = 0.74;

const regionRadius = (count: number): number => 1.6 + Math.sqrt(count) * 1.9;

/**
 * 目录摆在一个圆环上。环的半径取所有目录两两之间都不重叠所需的最小值 ——
 * 只有一个目录时半径为 0，它就正好落在画面中心。
 */
function ringRadius(radii: readonly number[]): number {
  if (radii.length < 2) return 0;
  let needed = 0;
  for (const [i, left] of radii.entries()) {
    for (let j = i + 1; j < radii.length; j += 1) {
      const separation = Math.abs(i - j) * ((2 * Math.PI) / radii.length);
      const chord = 2 * Math.sin(Math.min(separation, 2 * Math.PI - separation) / 2);
      needed = Math.max(needed, (left + radii[j]! + REGION_MARGIN) / chord);
    }
  }
  return needed;
}

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
      round: null, source: null, empty: true, hub: null, inputs: [], folders: [], files: [],
      production: [], dependencyIndex: {},
    };
  }
  const current = input.current;

  const grouped = new Map<string, typeof current.files[number][]>();
  for (const file of current.files) {
    const folder = folderOf(file.path);
    grouped.set(folder, [...(grouped.get(folder) ?? []), file]);
  }
  const folderPaths = [...grouped.keys()].sort();
  const radii = folderPaths.map((path) => regionRadius(grouped.get(path)!.length));
  const ring = ringRadius(radii);

  const folders: StageFolderNode[] = folderPaths.map((path, index) => {
    const angle = (index / folderPaths.length) * Math.PI * 2;
    return {
      id: `folder:${path}`,
      path,
      count: grouped.get(path)!.length,
      aggregated: grouped.get(path)!.length > STAGE_FOLDER_AGGREGATION_THRESHOLD,
      radius: radii[index]!,
      x: ring * Math.cos(angle),
      y: 0,
      z: ring * Math.sin(angle),
    };
  });

  const files: StageFileNode[] = [];
  for (const [folderIndex, folder] of folderPaths.entries()) {
    const anchor = folders[folderIndex]!;
    const entries = [...grouped.get(folder)!].sort((left, right) =>
      left.path.localeCompare(right.path));
    for (const [index, file] of entries.entries()) {
      const angle = index * GOLDEN_ANGLE;
      const spread = anchor.radius * FILE_FILL
        * Math.sqrt((index + 0.5) / entries.length);
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
        x: anchor.x + spread * Math.cos(angle),
        y: Math.sin(index * 1.7) * 0.55,
        z: anchor.z + spread * Math.sin(angle),
      });
    }
  }

  // 上游站在目录环外侧的左边，谱系从那里穿过“这一轮”再散进目录。
  const outer = ring + Math.max(0, ...radii);
  const hub: StageRoundNode = { id: "round", round: current.round, x: -(outer + 11), y: 0, z: 0 };
  const inputs: StageInputNode[] = current.upstream.map((entry, index) => ({
    id: `input:${entry.phase}`,
    phase: entry.phase,
    artifactIds: entry.artifactIds,
    x: hub.x - 13,
    y: 0,
    z: centered(index, current.upstream.length, 7),
  }));

  const production: StageProductionEdge[] = [
    ...inputs.map((source) => ({ from: source.id, to: hub.id, kind: "input-round" as const })),
    ...folders.map((folder) => ({ from: hub.id, to: folder.id, kind: "round-folder" as const })),
    ...files.map((file) => ({
      from: `folder:${file.folder}`, to: file.id, kind: "folder-file" as const,
    })),
  ];

  return {
    round: current.round,
    source: current.source,
    empty: files.length === 0,
    hub,
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
