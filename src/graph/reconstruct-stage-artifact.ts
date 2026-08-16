import { artifactHome, blueDocPath, redDocPath } from "../domain/artifact-home";
import type {
  ArtifactRole,
  StageArtifactFile,
  StageRoundArtifact,
} from "../domain/stage-artifact";
import type { Phase } from "../domain/phase";
import { looksLikeSha, type RepoFileChange, type RepoOps } from "../work/repo";

export interface ReconstructedStageArtifacts {
  readonly reason: "not-a-repo" | null;
  readonly artifacts: readonly StageRoundArtifact[];
  readonly incompleteRounds: readonly number[];
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fixedRound(path: string, changeId: string, phase: Phase): {
  round: number;
  role: "producer" | "critic";
} | null {
  const home = escapeRegExp(artifactHome(changeId));
  const name = escapeRegExp(phase);
  const match = new RegExp(`^${home}/${name}-r([1-9][0-9]*)(-opposition)?\\.md$`).exec(path);
  if (match === null) return null;
  return {
    round: Number.parseInt(match[1]!, 10),
    role: match[2] === undefined ? "producer" : "critic",
  };
}

function roleOf(changeId: string, phase: Phase, round: number, path: string): ArtifactRole {
  if (path === redDocPath(changeId, phase, round)) return "producer";
  if (path === blueDocPath(changeId, phase, round)) return "critic";
  if (path === `${artifactHome(changeId)}/arch.graph.json`) return "structured";
  return "delivery";
}

function fileFromChange(
  changeId: string,
  phase: Phase,
  round: number,
  file: RepoFileChange,
): StageArtifactFile {
  return {
    path: file.path,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    role: roleOf(changeId, phase, round, file.path),
    change: file.change,
  };
}

export function reconstructStageArtifacts(input: {
  root: string;
  changeId: string;
  phase: Phase;
  knownRound: number;
  evidenceArtifactIds: readonly string[];
  evidenceUpdatedAt: string | null;
  repo: RepoOps;
}): ReconstructedStageArtifacts {
  const tracked = input.repo.trackedFiles(input.root);
  if (tracked === null) {
    return { reason: "not-a-repo", artifacts: [], incompleteRounds: [] };
  }
  const byRound = new Map<number, StageArtifactFile[]>();
  for (const path of tracked) {
    const fixed = fixedRound(path, input.changeId, input.phase);
    if (fixed === null) continue;
    byRound.set(fixed.round, [...(byRound.get(fixed.round) ?? []), {
      path, role: fixed.role, change: "modified",
    }]);
  }

  let provenCommit: { sha: string; files: readonly RepoFileChange[] } | null = null;
  for (const id of input.evidenceArtifactIds) {
    if (!looksLikeSha(id)) continue;
    const files = input.repo.changedFiles(input.root, id);
    if (files !== null) {
      provenCommit = { sha: id, files };
      break;
    }
  }
  const commitRound = input.knownRound > 0
    ? input.knownRound
    : Math.max(0, ...byRound.keys());
  if (provenCommit !== null && commitRound > 0) {
    const files = new Map((byRound.get(commitRound) ?? []).map((file) => [file.path, file]));
    for (const file of provenCommit.files) {
      files.set(file.path, fileFromChange(input.changeId, input.phase, commitRound, file));
    }
    byRound.set(commitRound, [...files.values()]);
  }

  const artifacts = [...byRound.entries()].map(([round, files]): StageRoundArtifact => {
    const commit = round === commitRound ? provenCommit?.sha ?? null : null;
    const exactFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));
    return {
      changeId: input.changeId,
      phase: input.phase,
      round,
      jobId: `legacy:${input.changeId}:${input.phase}:${round}`,
      artifactIds: [
        ...exactFiles.filter((file) => file.role === "producer" || file.role === "critic")
          .map((file) => file.path),
        ...(commit === null ? [] : [commit]),
      ],
      commit,
      source: "reconstructed",
      files: exactFiles,
      upstream: [],
      settledAt: commit === null ? null : input.evidenceUpdatedAt,
    };
  }).sort((left, right) => right.round - left.round);
  const represented = new Set(artifacts.map((artifact) => artifact.round));
  const incompleteRounds = Array.from({ length: Math.max(0, input.knownRound) }, (_, index) =>
    index + 1).filter((round) => !represented.has(round));
  return { reason: null, artifacts, incompleteRounds };
}
