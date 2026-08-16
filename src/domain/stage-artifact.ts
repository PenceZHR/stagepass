import { isPhase, type Phase } from "./phase";

const ARTIFACT_ROLES = ["producer", "critic", "delivery", "structured"] as const;
const FILE_CHANGES = ["added", "modified", "deleted", "renamed"] as const;
const DISPLAY_CHANGES = [
  "added", "modified", "unchanged", "deleted", "replaced",
] as const;

export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];
export type FileChange = (typeof FILE_CHANGES)[number];
export type DisplayChange = (typeof DISPLAY_CHANGES)[number];

export interface StageArtifactFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly role: ArtifactRole;
  readonly change: FileChange;
}

export interface StageArtifactUpstream {
  readonly phase: Phase;
  readonly artifactIds: readonly string[];
}

export interface StageRoundArtifact {
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly jobId: string;
  readonly artifactIds: readonly string[];
  readonly commit: string | null;
  readonly source: "recorded" | "reconstructed";
  readonly files: readonly StageArtifactFile[];
  readonly upstream: readonly StageArtifactUpstream[];
  /** 旧轮次没有可证明的时间时是 null；新写入的 recorded manifest 永远有时间。 */
  readonly settledAt: string | null;
}

export interface MaterializedStageArtifactFile extends StageArtifactFile {
  readonly display: DisplayChange;
  readonly commit: string | null;
  readonly changedInRound: number;
}

export interface MaterializedStageRound extends Omit<StageRoundArtifact, "files"> {
  readonly files: readonly MaterializedStageArtifactFile[];
}

const ROLES = new Set<string>(ARTIFACT_ROLES);
const CHANGES = new Set<string>(FILE_CHANGES);

function fail(field: string): never {
  throw new Error(`stage_artifact_invalid:${field}`);
}

export function isRepoRelativePath(value: string): boolean {
  if (value.trim() !== value || value === "" || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function assertStrings(values: unknown, field: string): asserts values is readonly string[] {
  if (!Array.isArray(values)
    || values.some((value) => typeof value !== "string" || value.trim() === "")) {
    fail(field);
  }
}

export function assertStageRoundArtifact(value: StageRoundArtifact): void {
  if (value.changeId.trim() === "") fail("changeId");
  if (!isPhase(value.phase)) fail("phase");
  if (!Number.isInteger(value.round) || value.round < 1) fail("round");
  if (value.jobId.trim() === "") fail("jobId");
  assertStrings(value.artifactIds, "artifactIds");
  if (value.commit !== null && !/^[0-9a-f]{7,40}$/.test(value.commit)) fail("commit");
  if (value.source !== "recorded" && value.source !== "reconstructed") fail("source");
  if (value.settledAt === null) {
    if (value.source === "recorded") fail("settledAt");
  } else if (!Number.isFinite(Date.parse(value.settledAt))) {
    fail("settledAt");
  }

  const paths = new Set<string>();
  for (const file of value.files) {
    if (!isRepoRelativePath(file.path)) fail("files.path");
    if (paths.has(file.path)) fail("files.path.duplicate");
    paths.add(file.path);
    if (!ROLES.has(file.role)) fail("files.role");
    if (!CHANGES.has(file.change)) fail("files.change");
    if (file.change === "renamed") {
      if (file.previousPath === undefined || !isRepoRelativePath(file.previousPath)) {
        fail("files.previousPath");
      }
    } else if (file.previousPath !== undefined) {
      fail("files.previousPath");
    }
  }

  for (const upstream of value.upstream) {
    if (!isPhase(upstream.phase)) fail("upstream.phase");
    assertStrings(upstream.artifactIds, "upstream.artifactIds");
  }
}

function displayOf(change: FileChange): DisplayChange {
  return change === "renamed" ? "replaced" : change;
}

function materializedFile(
  file: StageArtifactFile,
  manifest: StageRoundArtifact,
): MaterializedStageArtifactFile {
  return {
    path: file.path,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    role: file.role,
    change: file.change,
    display: displayOf(file.change),
    commit: manifest.commit,
    changedInRound: manifest.round,
  };
}

export function materializeStageRound(
  history: readonly StageRoundArtifact[],
  round: number,
): MaterializedStageRound {
  const ordered = [...history].sort((left, right) => left.round - right.round);
  const target = ordered.find((manifest) => manifest.round === round);
  if (target === undefined) throw new Error(`stage_artifact_round_missing:${round}`);
  const files = new Map<string, MaterializedStageArtifactFile>();

  for (const manifest of ordered) {
    if (manifest.round > round) break;
    assertStageRoundArtifact(manifest);
    for (const [path, file] of files) {
      if (file.display !== "deleted") files.set(path, { ...file, display: "unchanged" });
    }
    for (const file of manifest.files) {
      if (file.change === "renamed") files.delete(file.previousPath!);
      files.set(file.path, materializedFile(file, manifest));
    }
  }

  return {
    ...target,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function compareStageRounds(
  previous: StageRoundArtifact | null,
  current: StageRoundArtifact,
): readonly MaterializedStageArtifactFile[] {
  return materializeStageRound(previous === null ? [current] : [previous, current], current.round).files;
}
