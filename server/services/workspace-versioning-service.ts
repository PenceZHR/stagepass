import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createChildLogger } from "../logger";
import { getCurrentBranch, getHeadSha } from "./repository-evidence-service";

const log = createChildLogger("workspace-versioning-service");
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_COMMAND_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

function runGit(
  repoPath: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
  }) as SpawnSyncReturns<string>;
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join("; ")
      .trim();
    throw new Error(`Git ${args.join(" ")} failed: ${detail || `status=${result.status}`}`);
  }
  return result.stdout || "";
}

export interface CreateBuildWorktreeInput {
  workspacePath: string;
  branchName: string;
  baseCommit: string;
}

export function createBuildWorktree(repoPath: string, input: CreateBuildWorktreeInput): void {
  fs.mkdirSync(path.dirname(input.workspacePath), { recursive: true });
  runGit(repoPath, [
    "worktree",
    "add",
    "-b",
    input.branchName,
    input.workspacePath,
    input.baseCommit,
  ]);
}

export function removeBuildWorktree(repoPath: string, workspacePath: string, force = false): void {
  runGit(repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), workspacePath]);
}

export function deleteInternalBranch(repoPath: string, branchName: string, force = false): void {
  runGit(repoPath, ["branch", force ? "-D" : "-d", branchName]);
}

export interface ApplyAdoptionPatchOptions {
  excludedPrefixes?: string[];
}

export function gitApplyExcludeArgs(excludedPrefixes: string[] = []): string[] {
  const args: string[] = [];
  for (const prefix of excludedPrefixes) {
    const normalized = prefix.split(path.sep).join("/").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized || normalized === "." || path.isAbsolute(normalized) || normalized.includes("..")) {
      continue;
    }
    args.push(`--exclude=${normalized}`, `--exclude=${normalized}/**`);
  }
  return args;
}

export function applyAdoptionPatch(
  repoPath: string,
  patch: string,
  options: ApplyAdoptionPatchOptions = {},
): void {
  const args = ["apply", "--whitespace=nowarn", ...gitApplyExcludeArgs(options.excludedPrefixes), "-"];
  try {
    runGit(repoPath, ["apply", "--check", "--whitespace=nowarn", ...gitApplyExcludeArgs(options.excludedPrefixes), "-"], {
      input: patch,
    });
  } catch (error) {
    throw new Error(`Git apply check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    runGit(repoPath, args, { input: patch });
  } catch (error) {
    throw new Error(`Git apply failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateRepoRelativePathspecs(paths: string[]): string[] {
  return paths.map((rawPath) => {
    if (typeof rawPath !== "string") throw new Error("Git commit path must be a string");
    const separators = rawPath.replace(/\\/g, "/");
    if (!separators.trim()) throw new Error("Git commit path must not be empty");
    if (path.isAbsolute(separators)) throw new Error(`Git commit path must be repo-relative: ${rawPath}`);
    const normalized = path.posix.normalize(separators);
    if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`Git commit path must stay inside the repository: ${rawPath}`);
    }
    if (normalized.startsWith(":")) {
      throw new Error(`Git commit pathspec magic is not allowed: ${rawPath}`);
    }
    return normalized;
  });
}

export function commitAdoptedPatch(
  repoPath: string,
  message: string,
  paths?: string[],
): { sha: string } {
  const selected = paths?.length ? validateRepoRelativePathspecs(paths) : [];
  runGit(repoPath, ["add", "-A", ...(selected.length ? ["--", ...selected] : [])]);
  const commitArgs = selected.length
    ? ["commit", "-m", message, "--only", "--", ...selected]
    : ["commit", "-m", message];
  runGit(repoPath, commitArgs);
  const sha = getHeadSha(repoPath);
  log.info({ repoPath, sha, message: message.split("\n")[0] }, "Adopted patch committed");
  return { sha };
}

export function createInternalBranch(repoPath: string, branchName: string): void {
  runGit(repoPath, ["checkout", "-b", branchName]);
}

export function checkoutInternalBranch(repoPath: string, branchName: string): void {
  runGit(repoPath, ["checkout", branchName]);
}

export function commitPipelineChanges(repoPath: string, message: string): void {
  runGit(repoPath, ["add", "-A"]);
  const result = spawnSync("git", ["commit", "-m", message], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
  }) as SpawnSyncReturns<string>;
  if (result.error) throw result.error;
  if (result.status !== 0 && !(result.stderr || "").includes("nothing to commit")) {
    throw new Error(`Git commit failed: ${(result.stderr || "").trim()}`);
  }
}

export function currentInternalBranch(repoPath: string): string {
  return getCurrentBranch(repoPath);
}
