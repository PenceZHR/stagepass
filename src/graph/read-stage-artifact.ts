import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import {
  isRepoRelativePath,
  type MaterializedStageArtifactFile,
  type MaterializedStageRound,
} from "../domain/stage-artifact";
import type { RepoOps } from "../work/repo";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export type StageArtifactReading =
  | {
    readonly ok: true;
    readonly reason: null;
    readonly kind: "text";
    readonly path: string;
    readonly content: string;
    readonly diff: string | null;
    readonly size: number;
  }
  | {
    readonly ok: true;
    readonly reason: null;
    readonly kind: "binary";
    readonly path: string;
    readonly size: number;
  }
  | {
    readonly ok: false;
    readonly reason:
      | "path-outside"
      | "path-not-in-round"
      | "commit-mismatch"
      | "file-unavailable"
      | "file-too-large";
  };

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function success(path: string, content: Buffer, diff: string | null): StageArtifactReading {
  if (content.includes(0)) {
    return { ok: true, reason: null, kind: "binary", path, size: content.byteLength };
  }
  return {
    ok: true,
    reason: null,
    kind: "text",
    path,
    content: content.toString("utf-8"),
    diff,
    size: content.byteLength,
  };
}

function historical(input: {
  root: string;
  file: MaterializedStageArtifactFile;
  repo: RepoOps;
}): StageArtifactReading {
  const commit = input.file.commit!;
  const text = input.file.display === "deleted"
    ? input.repo.fileBefore(input.root, commit, input.file.path)
    : input.repo.fileAt(input.root, commit, input.file.path);
  if (text === null) return { ok: false, reason: "file-unavailable" };
  const content = Buffer.from(text, "utf-8");
  if (content.byteLength > MAX_ARTIFACT_BYTES) {
    return { ok: false, reason: "file-too-large" };
  }
  const diff = input.repo.diffAt(input.root, commit, input.file.path);
  return success(input.file.path, content, diff);
}

export function readStageArtifact(input: {
  root: string;
  round: MaterializedStageRound;
  path: string;
  requestedCommit?: string | null;
  repo: RepoOps;
}): StageArtifactReading {
  if (isAbsolute(input.path) || !isRepoRelativePath(input.path)) {
    return { ok: false, reason: "path-outside" };
  }
  const file = input.round.files.find((entry) => entry.path === input.path);
  if (file === undefined) return { ok: false, reason: "path-not-in-round" };
  if (input.requestedCommit !== undefined && input.requestedCommit !== file.commit) {
    return { ok: false, reason: "commit-mismatch" };
  }
  if (file.commit !== null) return historical({ root: input.root, file, repo: input.repo });

  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(input.root);
    realFile = realpathSync(join(realRoot, input.path));
  } catch {
    return { ok: false, reason: "file-unavailable" };
  }
  if (!inside(realRoot, realFile)) return { ok: false, reason: "path-outside" };
  try {
    if (statSync(realFile).size > MAX_ARTIFACT_BYTES) {
      return { ok: false, reason: "file-too-large" };
    }
    return success(input.path, readFileSync(realFile), null);
  } catch {
    return { ok: false, reason: "file-unavailable" };
  }
}
