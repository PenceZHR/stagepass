import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { nonEmpty } from "./recovery-predicates";
import type {
  BusinessEvidenceObservation,
  FileEvidenceObservation,
} from "./recovery-types";

/**
 * Trusted file/hash evidence observation for recovery. These helpers read the
 * filesystem defensively (no symlink following, stable fd re-stat, size caps)
 * and hash/parse content; they never touch the business database. Extracted
 * from the recovery orchestrator to isolate untrusted IO from decision logic.
 */

export const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const ABSOLUTE_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

export function sha256Text(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function observeTrustedArtifact(
  repoPath: string,
  artifactPath: string | null | undefined,
  expectedMirrorHash: string | null,
  onEvidenceProbe?: (kind: "fs" | "git") => void,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
): { content: Buffer; observation: FileEvidenceObservation } | null {
  if (!nonEmpty(artifactPath)) return null;
  let fd: number | null = null;
  try {
    onEvidenceProbe?.("fs");
    const repoRealPath = fs.realpathSync(repoPath);
    const candidate = path.isAbsolute(artifactPath!)
      ? artifactPath!
      : path.join(repoRealPath, artifactPath!);
    const originalStats = fs.lstatSync(candidate);
    if (!originalStats.isFile() || originalStats.isSymbolicLink()
      || originalStats.size === 0 || originalStats.size > maxArtifactBytes) return null;
    const candidateRealPath = fs.realpathSync(candidate);
    const relative = path.relative(repoRealPath, candidateRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size === BigInt(0) || before.size > BigInt(maxArtifactBytes)
      || before.dev !== BigInt(originalStats.dev) || before.ino !== BigInt(originalStats.ino)) return null;
    const content = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (content.length === 0 || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs) return null;
    return {
      content,
      observation: {
        repoPath,
        repoRealPath,
        rawPath: artifactPath!,
        realPath: candidateRealPath,
        dev: before.dev.toString(),
        ino: before.ino.toString(),
        size: before.size.toString(),
        mtimeNs: before.mtimeNs.toString(),
        contentHash: sha256Text(content),
        expectedMirrorHash,
      },
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function readTrustedArtifact(
  repoPath: string,
  artifactPath: string | null | undefined,
  onEvidenceProbe?: (kind: "fs" | "git") => void,
  fileObservations?: FileEvidenceObservation[],
  expectedMirrorHash: string | null = null,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
): Buffer | null {
  const observed = observeTrustedArtifact(
    repoPath, artifactPath, expectedMirrorHash, onEvidenceProbe, maxArtifactBytes,
  );
  if (!observed) return null;
  fileObservations?.push(observed.observation);
  return observed.content;
}

export function fileObservationMatches(
  expected: FileEvidenceObservation,
  onEvidenceProbe?: (kind: "fs" | "git") => void,
): boolean {
  const current = observeTrustedArtifact(
    expected.repoPath,
    expected.rawPath,
    expected.expectedMirrorHash,
    onEvidenceProbe,
  );
  if (!current) return false;
  const actual = current.observation;
  return actual.repoRealPath === expected.repoRealPath
    && actual.realPath === expected.realPath
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeNs === expected.mtimeNs
    && actual.contentHash === expected.contentHash
    && actual.expectedMirrorHash === expected.expectedMirrorHash;
}

export function fileObservationsMatch(
  observation: BusinessEvidenceObservation,
  onEvidenceProbe?: (kind: "fs" | "git") => void,
): boolean {
  return observation.files.every((file) => fileObservationMatches(file, onEvidenceProbe));
}

export function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (!nonEmpty(value)) return null;
  try {
    const parsed = JSON.parse(value!);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function boundedPriorFindingIds(
  raw: string | null | undefined,
  maxItems: number,
): { ids: string[]; limitExceeded: boolean } {
  const value = raw ?? "[]";
  const maxJsonBytes = Math.max(1_024, maxItems * 1_024);
  if (Buffer.byteLength(value, "utf8") > maxJsonBytes) {
    return { ids: [], limitExceeded: true };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return { ids: [], limitExceeded: false };
    if (parsed.length > maxItems) return { ids: [], limitExceeded: true };
    const ids: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string") ids.push(item);
    }
    return { ids, limitExceeded: ids.length > maxItems };
  } catch {
    return { ids: [], limitExceeded: false };
  }
}
