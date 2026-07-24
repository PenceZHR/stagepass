import { execFileSync, execSync, spawnSync } from "node:child_process";
import type {
  ExecSyncOptions,
  ExecSyncOptionsWithBufferEncoding,
  ExecSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_COMMAND_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

type ExecOptions = (
  | ExecSyncOptions
  | ExecSyncOptionsWithBufferEncoding
  | ExecSyncOptionsWithStringEncoding
) & { timeout?: number };

function execGit(command: string, options: ExecSyncOptionsWithStringEncoding & { timeout?: number }): string;
function execGit(
  command: string,
  options?: (ExecSyncOptions | ExecSyncOptionsWithBufferEncoding) & { timeout?: number },
): Buffer;
function execGit(command: string, options: ExecOptions = {}): string | Buffer {
  return execSync(command, {
    ...options,
    timeout: options.timeout ?? GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? GIT_COMMAND_MAX_BUFFER_BYTES,
  } as ExecOptions);
}

function runGit(repoPath: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    env: env ? { ...process.env, ...env } : process.env,
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

export function isGitRepo(repoPath: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
      stdio: "pipe",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    });
    return true;
  } catch {
    return false;
  }
}

export function getCurrentBranch(repoPath: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    encoding: "utf-8",
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
  }).trim();
}

export function branchExists(repoPath: string, branchName: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", branchName], {
      cwd: repoPath,
      stdio: "pipe",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    });
    return true;
  } catch {
    return false;
  }
}

export function getDefaultBranch(repoPath: string): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    }).trim();
    if (ref) return ref.replace("refs/remotes/origin/", "");
  } catch {}
  for (const candidate of ["main", "master"]) {
    if (branchExists(repoPath, candidate)) return candidate;
  }
  return getCurrentBranch(repoPath);
}

export function hasCommits(repoPath: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      stdio: "pipe",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    });
    return true;
  } catch {
    return false;
  }
}

export function hasUncommittedChanges(repoPath: string): boolean {
  return getPorcelainStatus(repoPath).length > 0;
}

export interface FileEntry {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
}

export interface WorkingTreeStatus {
  clean: boolean;
  staged: FileEntry[];
  unstaged: FileEntry[];
  ahead: number;
  behind: number;
  branch: string | null;
}

export interface WorkingTreeStatusOptions {
  expandUntrackedDirectories?: boolean;
}

export function getWorkingTreeStatus(
  repoPath: string,
  options: WorkingTreeStatusOptions = {},
): WorkingTreeStatus {
  if (!isGitRepo(repoPath) || !hasCommits(repoPath)) {
    return { clean: true, staged: [], unstaged: [], ahead: 0, behind: 0, branch: null };
  }

  const branch = getCurrentBranch(repoPath);
  const porcelain = execGit(
    options.expandUntrackedDirectories ? "git status --porcelain -uall" : "git status --porcelain",
    { cwd: repoPath, encoding: "utf-8" },
  ).trimEnd();
  const staged: FileEntry[] = [];
  const unstaged: FileEntry[] = [];
  for (const line of porcelain ? porcelain.split("\n") : []) {
    const x = line[0];
    const y = line[1];
    const filePath = line.slice(3).split(" -> ").pop()!.trim();
    if (x !== " " && x !== "?") staged.push({ path: filePath, status: x as FileEntry["status"] });
    if (y !== " " && y !== "?") unstaged.push({ path: filePath, status: y as FileEntry["status"] });
    if (x === "?" && y === "?") unstaged.push({ path: filePath, status: "?" });
  }

  let ahead = 0;
  let behind = 0;
  try {
    const counts = execGit(`git rev-list --left-right --count ${branch}...origin/${branch}`, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const [a, b] = counts.split(/\s+/);
    ahead = Number.parseInt(a, 10) || 0;
    behind = Number.parseInt(b, 10) || 0;
  } catch {}

  return {
    clean: staged.length === 0 && unstaged.length === 0,
    staged,
    unstaged,
    ahead,
    behind,
    branch,
  };
}

export function getDiffSummary(repoPath: string, maxBytes = 30_000): string {
  const stat = execGit("git diff --stat", { cwd: repoPath, encoding: "utf-8" }).trim();
  const untrackedFiles = execGit("git ls-files --others --exclude-standard", {
    cwd: repoPath,
    encoding: "utf-8",
  }).trim();
  let diff = execGit("git diff", { cwd: repoPath, encoding: "utf-8" });
  if (diff.length > maxBytes) diff = `${diff.slice(0, maxBytes)}\n... (truncated)`;
  const parts = [stat];
  if (untrackedFiles) parts.push(`\nNew untracked files:\n${untrackedFiles}`);
  parts.push(`\n${diff}`);
  return parts.join("\n");
}

export function getHeadSha(repoPath: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
  }).trim();
}

export function getCommitSubject(repoPath: string, ref: string): string | null {
  try {
    return execFileSync("git", ["log", "-1", "--format=%s", ref], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    }).trim();
  } catch {
    return null;
  }
}

export function getPorcelainStatus(repoPath: string): string[] {
  const output = execGit("git status --porcelain", {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  }).trimEnd();
  return output ? output.split("\n") : [];
}

export function isWorkingTreeClean(repoPath: string): boolean {
  return getPorcelainStatus(repoPath).length === 0;
}

function withTemporaryIndex<T>(repoPath: string, callback: (env: NodeJS.ProcessEnv) => T): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stagepass-git-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, "index") };
  try {
    runGit(repoPath, ["read-tree", "HEAD"], env);
    runGit(repoPath, ["add", "-A", "--"], env);
    return callback(env);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function getBinaryDiff(repoPath: string): string {
  return withTemporaryIndex(repoPath, (env) =>
    runGit(repoPath, ["diff", "--cached", "--binary", "HEAD", "--"], env),
  );
}

export interface GitNameStatusEntry {
  status: "A" | "M" | "D" | "R" | "?";
  path: string;
}

export function getNameStatusDiff(repoPath: string): GitNameStatusEntry[] {
  return withTemporaryIndex(repoPath, (env) => {
    const output = runGit(repoPath, ["diff", "--cached", "--name-status", "-z", "HEAD", "--"], env);
    if (!output) return [];
    const entries: GitNameStatusEntry[] = [];
    const tokens = output.split("\0").filter(Boolean);
    for (let index = 0; index < tokens.length; index += 1) {
      const status = tokens[index][0] as GitNameStatusEntry["status"];
      if (status === "R") {
        index += 2;
        entries.push({ status, path: tokens[index] });
      } else {
        const filePath = tokens[++index];
        if (!filePath) break;
        entries.push({ status, path: filePath });
      }
    }
    return entries;
  });
}

export function generateChangeBranchName(changeId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return `ship/${changeId.toLowerCase()}/${slug || "change"}`;
}
