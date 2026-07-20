import { execSync, spawnSync } from "child_process";
import type {
  ExecSyncOptions,
  ExecSyncOptionsWithBufferEncoding,
  ExecSyncOptionsWithStringEncoding,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createChildLogger } from "../logger";

const log = createChildLogger("git-service");
const GIT_COMMAND_TIMEOUT_MS = 30_000;

type ExecWithTimeoutOptions = (
  | ExecSyncOptions
  | ExecSyncOptionsWithBufferEncoding
  | ExecSyncOptionsWithStringEncoding
) & { timeout?: number };
type SpawnWithTimeoutOptions = SpawnSyncOptionsWithStringEncoding & { timeout?: number };

function execWithTimeout(command: string, options: ExecSyncOptionsWithStringEncoding & { timeout?: number }): string;
function execWithTimeout(
  command: string,
  options?: (ExecSyncOptions | ExecSyncOptionsWithBufferEncoding) & { timeout?: number }
): Buffer;
function execWithTimeout(command: string, options: ExecWithTimeoutOptions = {}): string | Buffer {
  return execSync(command, {
    ...options,
    timeout: options.timeout ?? GIT_COMMAND_TIMEOUT_MS,
  } as ExecWithTimeoutOptions);
}

function spawnWithTimeout(
  command: string,
  args: readonly string[],
  options: SpawnWithTimeoutOptions
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    ...options,
    timeout: options.timeout ?? GIT_COMMAND_TIMEOUT_MS,
  }) as SpawnSyncReturns<string>;
}

export function isGitRepo(repoPath: string): boolean {
  try {
    execWithTimeout("git rev-parse --is-inside-work-tree", { cwd: repoPath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function getCurrentBranch(repoPath: string): string {
  return execWithTimeout("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
}

export function getDefaultBranch(repoPath: string): string {
  try {
    const ref = execWithTimeout("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo ''", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    if (ref) return ref.replace("refs/remotes/origin/", "");
  } catch {}
  return getCurrentBranch(repoPath);
}

export function createBranch(repoPath: string, branchName: string): void {
  execWithTimeout(`git checkout -b ${branchName}`, { cwd: repoPath, stdio: "pipe" });
  log.info({ repoPath, branchName }, "Branch created");
}

export function checkoutBranch(repoPath: string, branchName: string): void {
  execWithTimeout(`git checkout ${branchName}`, { cwd: repoPath, stdio: "pipe" });
  log.info({ repoPath, branchName }, "Checked out branch");
}

export function branchExists(repoPath: string, branchName: string): boolean {
  try {
    execWithTimeout(`git rev-parse --verify ${branchName}`, { cwd: repoPath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function commitAll(repoPath: string, message: string): void {
  execWithTimeout("git add -A", { cwd: repoPath, stdio: "pipe" });
  try {
    execWithTimeout(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: repoPath, stdio: "pipe" });
    log.info({ repoPath, message }, "Committed");
  } catch {
    log.info({ repoPath }, "Nothing to commit");
  }
}

export function hasUncommittedChanges(repoPath: string): boolean {
  const output = execWithTimeout("git status --porcelain", { cwd: repoPath, encoding: "utf-8" }).trim();
  return output.length > 0;
}

export function generateChangeBranchName(changeId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return `ship/${changeId.toLowerCase()}/${slug || "change"}`;
}

// --- gh CLI integration ---

export function isGhInstalled(): boolean {
  try {
    execWithTimeout("gh --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function isGhAuthenticated(): boolean {
  try {
    execWithTimeout("gh auth status", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function getGhUser(): string | null {
  try {
    return execWithTimeout("gh api user --jq .login", { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

export function getRemoteUrl(repoPath: string): string | null {
  try {
    return execWithTimeout("git remote get-url origin", { cwd: repoPath, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

export function initRepo(repoPath: string, defaultBranch: string = "main"): void {
  execWithTimeout(`git init -b ${defaultBranch}`, { cwd: repoPath, stdio: "pipe" });
  log.info({ repoPath }, "Git repo initialized");
}

export function initialCommit(repoPath: string): void {
  execWithTimeout("git add -A", { cwd: repoPath, stdio: "pipe" });
  execWithTimeout('git commit -m "init"', { cwd: repoPath, stdio: "pipe" });
  log.info({ repoPath }, "Initial commit created");
}

export function hasCommits(repoPath: string): boolean {
  try {
    execWithTimeout("git rev-parse HEAD", { cwd: repoPath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function createRemoteRepo(
  repoPath: string,
  name: string,
  visibility: "private" | "public" = "private"
): string {
  const result = spawnWithTimeout("gh", ["repo", "create", name, `--${visibility}`, "--source=.", "--push"], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });

  if (result.status === 0) {
    const url = (result.stdout || "").trim().split("\n")[0];
    log.info({ repoPath, name, url }, "Remote repo created and pushed");
    return url;
  }

  // If remote already exists, just set-url and push
  const stderr = result.stderr || "";
  if (stderr.includes("Unable to add remote")) {
    const user = getGhUser();
    const remoteUrl = `https://github.com/${user}/${name}.git`;
    execWithTimeout(`git remote set-url origin ${remoteUrl}`, { cwd: repoPath, stdio: "pipe" });
    setupGhAuth();
    execWithTimeout("git push -u origin main", { cwd: repoPath, stdio: "pipe" });
    log.info({ repoPath, remoteUrl }, "Remote updated and pushed");
    return `https://github.com/${user}/${name}`;
  }

  throw new Error(`Failed to create remote repo: ${stderr}`);
}

export function setupGhAuth(): void {
  try {
    execWithTimeout("gh auth setup-git", { stdio: "pipe" });
  } catch {}
}

export function pushCurrentBranch(repoPath: string): void {
  const branch = getCurrentBranch(repoPath);
  execWithTimeout(`git push -u origin ${branch}`, { cwd: repoPath, stdio: "pipe" });
  log.info({ repoPath, branch }, "Pushed to remote");
}

export interface GitSetupStatus {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghUser: string | null;
  isRepo: boolean;
  hasCommits: boolean;
  hasRemote: boolean;
  remoteUrl: string | null;
  currentBranch: string | null;
}

export function getSetupStatus(repoPath: string): GitSetupStatus {
  const ghInstalled = isGhInstalled();
  const ghAuthenticated = ghInstalled ? isGhAuthenticated() : false;
  const ghUser = ghAuthenticated ? getGhUser() : null;
  const isRepo = isGitRepo(repoPath);
  const _hasCommits = isRepo ? hasCommits(repoPath) : false;
  const remoteUrl = isRepo ? getRemoteUrl(repoPath) : null;
  const currentBranch = isRepo && _hasCommits ? getCurrentBranch(repoPath) : null;

  return {
    ghInstalled,
    ghAuthenticated,
    ghUser,
    isRepo,
    hasCommits: _hasCommits,
    hasRemote: !!remoteUrl,
    remoteUrl,
    currentBranch,
  };
}

// --- Working tree status ---

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

export function getWorkingTreeStatus(repoPath: string): WorkingTreeStatus {
  if (!isGitRepo(repoPath) || !hasCommits(repoPath)) {
    return { clean: true, staged: [], unstaged: [], ahead: 0, behind: 0, branch: null };
  }

  const branch = getCurrentBranch(repoPath);
  const porcelain = execWithTimeout("git status --porcelain", { cwd: repoPath, encoding: "utf-8" }).trimEnd();

  const staged: FileEntry[] = [];
  const unstaged: FileEntry[] = [];

  if (porcelain) {
    for (const line of porcelain.split("\n")) {
      const x = line[0]; // index status
      const y = line[1]; // worktree status
      const filePath = line.slice(3).split(" -> ").pop()!.trim();

      if (x !== " " && x !== "?") {
        staged.push({ path: filePath, status: x as FileEntry["status"] });
      }
      if (y !== " " && y !== "?") {
        unstaged.push({ path: filePath, status: y as FileEntry["status"] });
      }
      if (x === "?" && y === "?") {
        unstaged.push({ path: filePath, status: "?" });
      }
    }
  }

  let ahead = 0;
  let behind = 0;
  try {
    const counts = execWithTimeout(
      `git rev-list --left-right --count ${branch}...origin/${branch}`,
      { cwd: repoPath, encoding: "utf-8", stdio: "pipe" }
    ).trim();
    const [a, b] = counts.split(/\s+/);
    ahead = parseInt(a, 10) || 0;
    behind = parseInt(b, 10) || 0;
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

export function getDiffSummary(repoPath: string, maxBytes = 30000): string {
  const stat = execWithTimeout("git diff --stat", { cwd: repoPath, encoding: "utf-8" }).trim();
  const untrackedFiles = execWithTimeout(
    "git ls-files --others --exclude-standard",
    { cwd: repoPath, encoding: "utf-8" }
  ).trim();

  let diff = execWithTimeout("git diff", { cwd: repoPath, encoding: "utf-8" });
  if (diff.length > maxBytes) {
    diff = diff.slice(0, maxBytes) + "\n... (truncated)";
  }

  const parts = [stat];
  if (untrackedFiles) {
    parts.push(`\nNew untracked files:\n${untrackedFiles}`);
  }
  parts.push(`\n${diff}`);
  return parts.join("\n");
}

export function commitWithMessage(repoPath: string, message: string, paths?: string[]): { sha: string } {
  const selectedPaths = paths && paths.length > 0 ? validateRepoRelativePathspecs(paths) : [];
  if (selectedPaths.length > 0) {
    const addResult = spawnWithTimeout("git", ["add", "-A", "--", ...selectedPaths], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
    if (addResult.status !== 0 || addResult.error) {
      throw new Error(`Git add selected paths failed: ${formatSpawnFailure(addResult)}`);
    }
  } else {
    execWithTimeout("git add -A", { cwd: repoPath, stdio: "pipe" });
  }

  const commitArgs = selectedPaths.length > 0
    ? ["commit", "-m", message, "--only", "--", ...selectedPaths]
    : ["commit", "-m", message];
  const result = spawnWithTimeout("git", commitArgs, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    const err = (result.stderr || "").trim();
    if (err.includes("nothing to commit")) {
      throw new Error("Nothing to commit");
    }
    throw new Error(`Git commit failed: ${err}`);
  }

  const sha = execWithTimeout("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
  log.info({ repoPath, sha, message: message.split("\n")[0] }, "Committed");
  return { sha };
}

function validateRepoRelativePathspecs(paths: string[]): string[] {
  return paths.map((rawPath) => {
    if (typeof rawPath !== "string") {
      throw new Error("Git commit path must be a string");
    }
    const normalizedSeparators = rawPath.replace(/\\/g, "/");
    if (!normalizedSeparators.trim()) {
      throw new Error("Git commit path must not be empty");
    }
    if (path.isAbsolute(normalizedSeparators)) {
      throw new Error(`Git commit path must be repo-relative: ${rawPath}`);
    }
    const normalized = path.posix.normalize(normalizedSeparators);
    if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
      throw new Error(`Git commit path must stay inside the repository: ${rawPath}`);
    }
    if (normalized.startsWith(":")) {
      throw new Error(`Git commit pathspec magic is not allowed: ${rawPath}`);
    }
    return normalized;
  });
}

function hasSpawnFailure(result: SpawnSyncReturns<string>): boolean {
  return !!result.error || result.status !== 0;
}

function formatSpawnFailure(result: SpawnSyncReturns<string>): string {
  const details = [
    result.error?.message,
    result.signal ? `signal=${result.signal}` : "",
    (result.stderr || "").trim(),
    (result.stdout || "").trim(),
    result.status !== null && result.status !== 0 ? `status=${result.status}` : "",
  ].filter(Boolean);

  return details.join("; ") || "no stderr/stdout from command";
}

function runGitCommand(
  repoPath: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; maxBuffer?: number } = {}
): string {
  const result = spawnWithTimeout("git", args, {
    cwd: repoPath,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    encoding: "utf-8",
    stdio: "pipe",
    maxBuffer: options.maxBuffer,
  });

  if (hasSpawnFailure(result)) {
    throw new Error(`Git ${args.join(" ")} failed: ${formatSpawnFailure(result)}`);
  }

  return result.stdout || "";
}

export interface CreateWorktreeInput {
  workspacePath: string;
  branchName: string;
  baseCommit: string;
}

export function getHeadSha(repoPath: string): string {
  return execWithTimeout("git rev-parse HEAD", {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

/** The subject line of a commit, or null if `ref` does not resolve to one. */
export function getCommitSubject(repoPath: string, ref: string): string | null {
  try {
    return execWithTimeout(`git log -1 --format=%s ${ref}`, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

export function getPorcelainStatus(repoPath: string): string[] {
  const output = execWithTimeout("git status --porcelain", {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  }).trimEnd();
  return output ? output.split("\n") : [];
}

export function isWorkingTreeClean(repoPath: string): boolean {
  return getPorcelainStatus(repoPath).length === 0;
}

export function createGitWorktree(repoPath: string, input: CreateWorktreeInput): void {
  fs.mkdirSync(path.dirname(input.workspacePath), { recursive: true });
  const result = spawnWithTimeout(
    "git",
    ["worktree", "add", "-b", input.branchName, input.workspacePath, input.baseCommit],
    { cwd: repoPath, encoding: "utf-8", stdio: "pipe" }
  );
  if (hasSpawnFailure(result)) {
    throw new Error(`Git worktree add failed: ${formatSpawnFailure(result)}`);
  }
}

export function removeGitWorktree(repoPath: string, workspacePath: string, force = false): void {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(workspacePath);

  const result = spawnWithTimeout("git", args, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (hasSpawnFailure(result)) {
    throw new Error(`Git worktree remove failed: ${formatSpawnFailure(result)}`);
  }
}

export function deleteGitBranch(repoPath: string, branchName: string, force = false): void {
  const args = ["branch", force ? "-D" : "-d", branchName];
  const result = spawnWithTimeout("git", args, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (hasSpawnFailure(result)) {
    throw new Error(`Git branch delete failed: ${formatSpawnFailure(result)}`);
  }
}

export function getBinaryDiff(repoPath: string): string {
  return runWithTemporaryFullIndex(repoPath, (env) =>
    runGitCommand(repoPath, ["diff", "--cached", "--binary", "HEAD", "--"], {
      env,
      maxBuffer: 20 * 1024 * 1024,
    })
  );
}

export interface GitNameStatusEntry {
  status: "A" | "M" | "D" | "R" | "?";
  path: string;
}

function runWithTemporaryFullIndex<T>(
  repoPath: string,
  callback: (env: NodeJS.ProcessEnv) => T
): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stagepass-git-index-"));
  const tempIndexPath = path.join(tempDir, "index");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tempIndexPath };

  try {
    runGitCommand(repoPath, ["read-tree", "HEAD"], { env });
    runGitCommand(repoPath, ["add", "-A", "--"], { env });
    return callback(env);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function getNameStatusDiff(repoPath: string): GitNameStatusEntry[] {
  return runWithTemporaryFullIndex(repoPath, (env) => {
    const output = runGitCommand(repoPath, ["diff", "--cached", "--name-status", "-z", "HEAD", "--"], {
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (!output) return [];

    const entries: GitNameStatusEntry[] = [];
    const tokens = output.split("\0").filter((token) => token.length > 0);
    for (let i = 0; i < tokens.length; i++) {
      const statusToken = tokens[i];
      const status = statusToken[0] as GitNameStatusEntry["status"];
      if (status === "R") {
        i += 2;
        const newPath = tokens[i];
        entries.push({ status, path: newPath });
        continue;
      }

      const filePath = tokens[++i];
      if (!filePath) break;
      entries.push({ status, path: filePath });
    }
    return entries;
  });
}

export interface ApplyPatchOptions {
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

export function applyPatch(repoPath: string, patch: string, options: ApplyPatchOptions = {}): void {
  const excludeArgs = gitApplyExcludeArgs(options.excludedPrefixes);
  const checkResult = spawnWithTimeout("git", ["apply", "--check", "--whitespace=nowarn", ...excludeArgs, "-"], {
    cwd: repoPath,
    input: patch,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (hasSpawnFailure(checkResult)) {
    throw new Error(`Git apply check failed: ${formatSpawnFailure(checkResult)}`);
  }

  const applyResult = spawnWithTimeout("git", ["apply", "--whitespace=nowarn", ...excludeArgs, "-"], {
    cwd: repoPath,
    input: patch,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (hasSpawnFailure(applyResult)) {
    throw new Error(`Git apply failed: ${formatSpawnFailure(applyResult)}`);
  }
}
