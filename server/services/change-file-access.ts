import fs from "fs";
import path from "path";

/**
 * Shared, security-critical resolver for "open this produced file" requests.
 *
 * The pipeline UI renders many produced-file paths (changed source files, .ship
 * artifacts, plan/spec/gate outputs). To make them clickable we need to read an
 * arbitrary caller-supplied path — so every read must be proven to live inside
 * the project's repo root, defending against `../` traversal AND symlink escapes
 * (realpath is the authoritative boundary, not string prefixing). Callers map the
 * discriminated error to an HTTP status.
 */

export interface ResolvedChangeFile {
  /** Absolute, symlink-resolved path guaranteed to live under repoPath. */
  absolutePath: string;
  /** Path relative to the repo root (safe to echo back to the client). */
  relativePath: string;
}

export type ResolveChangeFileError =
  | "invalid_input"
  | "not_found"
  | "outside_repo"
  | "not_a_file";

export type ResolveChangeFileResult =
  | { ok: true; file: ResolvedChangeFile }
  | { ok: false; error: ResolveChangeFileError };

/**
 * Resolve a user-supplied file path (absolute or repo-relative) to an absolute
 * path proven to sit inside repoPath. Returns a discriminated result; never throws
 * for untrusted input.
 */
export function resolveChangeFilePath(
  inputPath: unknown,
  repoPath: string,
): ResolveChangeFileResult {
  if (typeof inputPath !== "string" || inputPath.trim() === "" || inputPath.includes("\0")) {
    return { ok: false, error: "invalid_input" };
  }

  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(repoPath);
  } catch {
    // Repo root itself is missing/unreadable — treat as not found.
    return { ok: false, error: "not_found" };
  }

  const candidate = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(repoRoot, inputPath);

  if (!fs.existsSync(candidate)) {
    return { ok: false, error: "not_found" };
  }

  // realpath collapses symlinks; the containment check below is the real boundary.
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return { ok: false, error: "not_found" };
  }

  const rel = path.relative(repoRoot, realCandidate);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "outside_repo" };
  }

  if (!fs.lstatSync(realCandidate).isFile()) {
    return { ok: false, error: "not_a_file" };
  }

  return { ok: true, file: { absolutePath: realCandidate, relativePath: rel } };
}
