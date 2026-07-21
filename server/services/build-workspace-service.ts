import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";

import {
  commitWithMessage,
  getCommitSubject,
  gitApplyExcludeArgs,
  type GitNameStatusEntry,
} from "./git-service";
import {
  loadDbPlanScope,
  loadPolicy,
  type WorkspaceMutation,
} from "./stage-guard-service";
import {
  getBuildRunRecord,
  hashBuildChangedFiles,
  recordBuildRunFromWorkspaceFile,
} from "./build-run-record-service";
import {
  buildRunId,
  readBuildRunByNumber,
  readLatestBuildRun,
  readPreviousAdoptedBuildRun,
  writeBuildRun,
} from "./build-workspace-run-store";
import {
  assertControlledWorkspacePath,
  assertReadableBuildArtifactFile,
  assertReadableChangeArtifactFile,
  assertSafeChangeId,
  buildApprovalPathForRun,
  buildBranchName,
  buildResultArtifactPathsForRun,
  buildRunPath,
  normalizePath,
  tryLstat,
  workspacePathFor,
  writeBuildArtifact,
} from "./build-workspace-paths";
import { evaluateBuildGate, isShipArtifact } from "./build-gate-service";
import {
  changeAndSiblingArtifactIgnoredPrefixes,
  patchAdoptionIgnoredPrefixes,
  pipelineSystemMetadataIgnoredPrefixes,
  allChangeArtifactIgnoredPrefixes,
} from "./build-workspace-ignored-prefixes";
import type {
  BuildDeviation,
  BuildPatchApprovalFile,
  BuildPlanScope,
  BuildRunFile,
} from "./build-types";

export { evaluateBuildGate } from "./build-gate-service";
export {
  changeArtifactIgnoredPrefixes,
  patchAdoptionIgnoredPrefixes,
  pipelineSystemMetadataIgnoredPrefixes,
  allChangeArtifactIgnoredPrefixes,
} from "./build-workspace-ignored-prefixes";
export {
  buildRunId,
  isApprovedBuildRunStatus,
  isDeadBuildRunStatus,
  markBuildRunFailed,
  markBuildRunRunning,
  readLatestApprovedBuildRun,
  readLatestBuildRun,
  resolveApprovedBuildRun,
  writeBuildRun,
  type ApprovedBuildRunResolution,
} from "./build-workspace-run-store";
export type {
  BuildDeviation,
  BuildDeviationReason,
  BuildDeviationSeverityHint,
  BuildGateInput,
  BuildGateResult,
  BuildPatchApprovalFile,
  BuildPlanScope,
  BuildRunFile,
  BuildRunStatus,
} from "./build-types";

export interface GitBaseCampStatus {
  status: "ready" | "blocked" | "dirty";
  headSha: string | null;
  clean: boolean;
  blockers: string[];
  warnings: string[];
}

export type BuildWorkspaceGitProbeFailureReason =
  | "build_workspace_probe_timeout"
  | "build_workspace_probe_output_limit"
  | "build_workspace_probe_failure";

export interface BuildWorkspaceGitCommandOptions extends SpawnSyncOptionsWithStringEncoding {
  encoding: "utf-8";
  timeout: number;
  maxBuffer: number;
  killSignal: NodeJS.Signals;
}

export type BuildWorkspaceGitCommandRunner = (
  args: readonly string[],
  options: BuildWorkspaceGitCommandOptions,
) => SpawnSyncReturns<string>;

/**
 * `message` stays a fixed summary: git stderr can carry absolute repository
 * paths, and leaking those is what "maps git failures without exposing
 * repository paths or stderr" exists to prevent.
 *
 * `detail` is the same stderr with absolute paths redacted, kept off `message`
 * so nothing that logs an error incidentally publishes it. It exists because the
 * summary alone is true of a dozen unrelated causes and diagnostic of none: a
 * refused fix adoption read identically whether the patch collided with a file
 * already in the tree, the repo was locked, or the patch was corrupt. Git says
 * which every time, and relative paths -- the part that actually names the
 * offending file -- survive redaction intact.
 */
export class BuildWorkspaceGitProbeError extends Error {
  constructor(
    readonly code: BuildWorkspaceGitProbeFailureReason,
    readonly detail?: string,
  ) {
    super(
      code === "build_workspace_probe_timeout"
        ? "Build workspace Git probe timed out"
        : code === "build_workspace_probe_output_limit"
          ? "Build workspace Git probe output exceeded limit"
          : "Build workspace Git probe failed",
    );
    this.name = "BuildWorkspaceGitProbeError";
  }
}

/** git's diagnostics are the useful half; cap them so one run cannot flood a UI. */
const GIT_PROBE_DETAIL_MAX_CHARS = 600;

/**
 * Absolute paths are the only part of git's output that can name something
 * outside the repository, so they are the only part removed. `tests/a.mjs:
 * already exists in working directory` survives whole.
 */
export function redactAbsolutePaths(text: string): string {
  return text.replace(/(^|[\s'"(<])\/[^\s'")>]+/g, (_match, lead: string) => `${lead}<path>`);
}

function gitFailureDetail(result: SpawnSyncReturns<string>): string | undefined {
  const raw = (result.stderr || "").trim() || (result.stdout || "").trim();
  if (!raw) return undefined;
  const redacted = redactAbsolutePaths(raw);
  return redacted.length > GIT_PROBE_DETAIL_MAX_CHARS
    ? `${redacted.slice(0, GIT_PROBE_DETAIL_MAX_CHARS)}…`
    : redacted;
}

const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 500;
const MAX_GIT_COMMAND_TIMEOUT_MS = 1_000;
const GIT_COMMAND_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const GIT_COMMAND_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";

const defaultBuildWorkspaceGitRunner: BuildWorkspaceGitCommandRunner = (args, options) =>
  spawnSync("git", [...args], options);
let buildWorkspaceGitRunner = defaultBuildWorkspaceGitRunner;
let buildWorkspaceGitTimeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS;

export function setBuildWorkspaceGitRunnerForTest(
  runner: BuildWorkspaceGitCommandRunner,
  timeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
): () => void {
  const previousRunner = buildWorkspaceGitRunner;
  const previousTimeoutMs = buildWorkspaceGitTimeoutMs;
  buildWorkspaceGitRunner = runner;
  buildWorkspaceGitTimeoutMs = Math.min(Math.max(1, timeoutMs), MAX_GIT_COMMAND_TIMEOUT_MS);
  return () => {
    buildWorkspaceGitRunner = previousRunner;
    buildWorkspaceGitTimeoutMs = previousTimeoutMs;
  };
}

function mapGitCommandFailure(result: SpawnSyncReturns<string>): BuildWorkspaceGitProbeError {
  const error = result.error as (NodeJS.ErrnoException & { killed?: boolean }) | undefined;
  if (error?.code === "ENOBUFS" || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new BuildWorkspaceGitProbeError("build_workspace_probe_output_limit");
  }
  if (
    error?.code === "ETIMEDOUT"
    || error?.code === "ERR_CHILD_PROCESS_TIMEOUT"
    || error?.killed === true
    || result.signal === GIT_COMMAND_KILL_SIGNAL
  ) {
    return new BuildWorkspaceGitProbeError("build_workspace_probe_timeout");
  }
  return new BuildWorkspaceGitProbeError("build_workspace_probe_failure", gitFailureDetail(result));
}

function runGitCommand(
  repoPath: string,
  args: readonly string[],
  options: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    expectedExitCodes?: number[];
  } = {},
): { status: number; stdout: string; stderr: string } {
  const result = buildWorkspaceGitRunner(args, {
    cwd: repoPath,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: buildWorkspaceGitTimeoutMs,
    maxBuffer: Math.min(options.maxBuffer ?? GIT_COMMAND_MAX_BUFFER_BYTES, GIT_COMMAND_MAX_BUFFER_BYTES),
    killSignal: GIT_COMMAND_KILL_SIGNAL,
  });
  if (
    result.error
    || result.status === null
    || result.signal !== null
    || (
      result.status !== 0
      && !options.expectedExitCodes?.includes(result.status)
    )
  ) throw mapGitCommandFailure(result);
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function isGitRepo(repoPath: string): boolean {
  return runGitCommand(repoPath, ["rev-parse", "--is-inside-work-tree"], {
    expectedExitCodes: [128],
  }).stdout.trim() === "true";
}

function hasCommits(repoPath: string): boolean {
  return runGitCommand(repoPath, ["rev-parse", "--verify", "HEAD"], {
    expectedExitCodes: [128],
  }).stdout.trim().length > 0;
}

function getHeadSha(repoPath: string): string {
  return runGitCommand(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
}

function runWithTemporaryFullIndex<T>(
  repoPath: string,
  callback: (env: NodeJS.ProcessEnv) => T,
): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stagepass-build-git-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, "index") };
  try {
    runGitCommand(repoPath, ["read-tree", "HEAD"], { env });
    runGitCommand(repoPath, ["add", "-A", "--"], { env });
    return callback(env);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function diffPathspec(excludedPrefixes: string[] = []): string[] {
  const pathspec = ["."];
  for (const prefix of excludedPrefixes) {
    const normalized = normalizePath(prefix).replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized || normalized === "." || path.isAbsolute(normalized) || normalized.includes("..")) continue;
    pathspec.push(`:(exclude)${normalized}`, `:(exclude)${normalized}/**`);
  }
  return pathspec;
}

function getBinaryDiff(repoPath: string, excludedPrefixes: string[] = []): string {
  return runWithTemporaryFullIndex(repoPath, (env) =>
    runGitCommand(repoPath, ["diff", "--cached", "--binary", "HEAD", "--", ...diffPathspec(excludedPrefixes)], { env }).stdout);
}

function getNameStatusDiff(repoPath: string): GitNameStatusEntry[] {
  return runWithTemporaryFullIndex(repoPath, (env) => {
    const output = runGitCommand(
      repoPath,
      ["diff", "--cached", "--name-status", "-z", "HEAD", "--"],
      { env },
    ).stdout;
    const tokens = output.split("\0").filter(Boolean);
    const entries: GitNameStatusEntry[] = [];
    for (let index = 0; index < tokens.length;) {
      const status = tokens[index++][0] as GitNameStatusEntry["status"];
      if (status === "R") index += 1;
      const filePath = tokens[index++];
      if (filePath) entries.push({ status, path: filePath });
    }
    return entries;
  });
}

function applyPatch(
  repoPath: string,
  patch: string,
  options: { excludedPrefixes?: string[] } = {},
): void {
  runGitCommand(
    repoPath,
    ["apply", "--binary", "--whitespace=nowarn", ...gitApplyExcludeArgs(options.excludedPrefixes), "-"],
    { input: patch },
  );
}

function createGitWorktree(
  repoPath: string,
  input: { workspacePath: string; branchName: string; baseCommit: string },
): void {
  fs.mkdirSync(path.dirname(input.workspacePath), { recursive: true });
  runGitCommand(repoPath, ["worktree", "add", "-b", input.branchName, input.workspacePath, input.baseCommit]);
}

function removeGitWorktree(repoPath: string, workspacePath: string, force = false): void {
  runGitCommand(repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), workspacePath]);
}

function deleteGitBranch(repoPath: string, branchName: string, force = false): void {
  runGitCommand(repoPath, ["branch", force ? "-D" : "-d", branchName]);
}

export interface CreateBuildWorkspaceInput {
  repoPath: string;
  changeId: string;
  designSourceDbHash?: string | null;
  purpose?: "build" | "fix";
}

export interface CollectBuildResultInput {
  repoPath: string;
  changeId: string;
  plan?: BuildPlanScope;
  designSourceDbHash?: string | null;
}

/** When set and `enabled`, adoption commits the applied patch instead of leaving it dirty. */
export interface AdoptionCommitOptions {
  enabled: boolean;
}

export interface AbsorbBuildPatchInput {
  repoPath: string;
  changeId: string;
  commit?: AdoptionCommitOptions;
}

export interface RejectLatestBuildRunInput {
  repoPath: string;
  changeId: string;
}

export interface AdoptFixPatchInput {
  repoPath: string;
  changeId: string;
  commit?: AdoptionCommitOptions;
}

export interface AssertAdoptedBuildRunMatchesWorkspaceInput {
  repoPath: string;
  changeId: string;
  /**
   * Validate this run number instead of the newest one on disk. Review resolves
   * the approved run first and pins it here, so a newer dead fix run cannot
   * shadow it in the trust check either. The run file is re-read from disk
   * either way: this selects which file to trust, it never supplies the facts.
   */
  runNumber?: number;
}

export class BuildWorkspaceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 404 | 409
  ) {
    super(message);
    this.name = "BuildWorkspaceError";
  }
}

function buildWorkspaceNotFound(message: string): BuildWorkspaceError {
  return new BuildWorkspaceError(message, 404);
}

function buildWorkspaceConflict(message: string): BuildWorkspaceError {
  return new BuildWorkspaceError(message, 409);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function readVerifiedBuildPatch(repoPath: string, changeId: string, run: BuildRunFile): string {
  if (!run.patchPath) {
    throw buildWorkspaceConflict("Build run patchPath is required before approving or absorbing a patch");
  }
  if (!run.patchSha256) {
    throw buildWorkspaceConflict("Build run patchSha256 is required before approving or absorbing a patch");
  }

  const patchPath = path.resolve(repoPath, run.patchPath);
  assertReadableBuildArtifactFile(repoPath, changeId, patchPath);

  const patch = fs.readFileSync(patchPath, "utf-8");
  const currentSha256 = sha256(patch);
  if (currentSha256 !== run.patchSha256) {
    throw buildWorkspaceConflict(
      `Build patch hash mismatch: expected ${run.patchSha256}, got ${currentSha256}`
    );
  }
  return patch;
}

interface RemovedMirrorArtifact {
  relativePath: string;
  content: Buffer;
}

function readAndRemoveRepoRelativeFile(
  repoPath: string,
  relativePath: string | null | undefined
): RemovedMirrorArtifact | null {
  if (!relativePath) return null;
  const normalized = normalizePath(relativePath);
  if (path.isAbsolute(normalized) || normalized.includes("..")) return null;
  const fullPath = path.join(repoPath, normalized);
  if (!fs.existsSync(fullPath)) return null;
  const content = fs.readFileSync(fullPath);
  fs.rmSync(fullPath, { force: true });
  return { relativePath: normalized, content };
}

function captureAndRemoveBuildAdoptionMirrorArtifacts(
  repoPath: string,
  run: BuildRunFile
): RemovedMirrorArtifact[] {
  return [
    readAndRemoveRepoRelativeFile(repoPath, buildApprovalPathForRun(run)),
    readAndRemoveRepoRelativeFile(repoPath, run.patchPath),
    readAndRemoveRepoRelativeFile(repoPath, run.diffPath),
    readAndRemoveRepoRelativeFile(repoPath, run.auditPath),
    readAndRemoveRepoRelativeFile(repoPath, run.reportPath),
    readAndRemoveRepoRelativeFile(repoPath, path.relative(repoPath, buildRunPath(repoPath, run))),
  ].filter((artifact): artifact is RemovedMirrorArtifact => artifact !== null);
}

function restoreMirrorArtifacts(repoPath: string, artifacts: RemovedMirrorArtifact[]): void {
  for (const artifact of artifacts) {
    const fullPath = path.join(repoPath, artifact.relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, artifact.content);
  }
}

function recomputeWorkspaceBuildHashes(run: BuildRunFile): {
  patchHash: string;
  changedFilesHash: string;
} {
  const workspaceStats = tryLstat(run.workspacePath);
  if (!workspaceStats?.isDirectory()) {
    throw buildWorkspaceConflict(`Build workspace does not exist: ${run.workspacePath}`);
  }
  const patchHash = sha256(getBinaryDiff(run.workspacePath));
  const changedFiles = unique(
    getNameStatusDiff(run.workspacePath).map((entry) => normalizePath(entry.path))
  ).sort();
  return {
    patchHash,
    changedFilesHash: hashBuildChangedFiles(changedFiles),
  };
}

function assertBuildRunDbFreshForAdoption(
  changeId: string,
  run: BuildRunFile,
): void {
  const record = getBuildRunRecord(changeId, buildRunId(run));
  if (!record) {
    throw buildWorkspaceConflict("build_hash_drift: BuildRun DB record is missing before adoption");
  }
  const current = recomputeWorkspaceBuildHashes(run);
  if (!record.patchHash || record.patchHash !== current.patchHash) {
    throw buildWorkspaceConflict(
      `build_hash_drift: patch hash mismatch before adoption; expected ${record.patchHash ?? "none"}, got ${current.patchHash}`
    );
  }
  if (!record.changedFilesHash || record.changedFilesHash !== current.changedFilesHash) {
    throw buildWorkspaceConflict(
      `build_hash_drift: changed files hash mismatch before adoption; expected ${record.changedFilesHash ?? "none"}, got ${current.changedFilesHash}`
    );
  }
}

function assertFixRunDbFreshForAdoption(changeId: string, run: BuildRunFile): void {
  try {
    assertBuildRunDbFreshForAdoption(changeId, run);
  } catch (error) {
    if (
      error instanceof BuildWorkspaceError &&
      error.statusCode === 409 &&
      /build_hash_drift/i.test(error.message)
    ) {
      throw buildWorkspaceConflict(error.message.replace(/build_hash_drift/g, "fix_hash_drift"));
    }
    throw error;
  }
}

function writeBuildPatchApproval(
  repoPath: string,
  changeId: string,
  approval: BuildPatchApprovalFile
): string {
  const approvalPath = buildApprovalPathForRun(approval);
  writeBuildArtifact(
    repoPath,
    changeId,
    approvalPath,
    `${JSON.stringify(approval, null, 2)}\n`
  );
  return approvalPath;
}

function readBuildPatchApproval(
  repoPath: string,
  changeId: string,
  run: BuildRunFile
): BuildPatchApprovalFile {
  const approvalPath = path.resolve(repoPath, buildApprovalPathForRun(run));
  assertReadableChangeArtifactFile(repoPath, changeId, approvalPath, "Build approval artifact");
  return JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as BuildPatchApprovalFile;
}

function assertApprovalMatchesRun(
  approval: BuildPatchApprovalFile,
  run: BuildRunFile,
  currentPatch: string
): void {
  if (approval.changeId !== run.changeId) {
    throw new Error(
      `Build patch approval changeId mismatch: expected ${run.changeId}, got ${approval.changeId}`
    );
  }
  if (approval.runNumber !== run.runNumber) {
    throw new Error(
      `Build patch approval runNumber mismatch: expected ${run.runNumber}, got ${approval.runNumber}`
    );
  }
  if (approval.baseCommit !== run.baseCommit) {
    throw new Error(
      `Build patch approval baseCommit mismatch: expected ${run.baseCommit}, got ${approval.baseCommit}`
    );
  }
  if (approval.patchPath !== run.patchPath) {
    throw new Error(
      `Build patch approval patchPath mismatch: expected ${run.patchPath}, got ${approval.patchPath}`
    );
  }
  if (approval.patchSha256 !== run.patchSha256) {
    throw new Error(
      `Build patch approval hash mismatch: expected ${approval.patchSha256}, got ${run.patchSha256}`
    );
  }

  const currentSha256 = sha256(currentPatch);
  if (currentSha256 !== approval.patchSha256) {
    throw new Error(
      `Build patch hash mismatch: expected approved ${approval.patchSha256}, got ${currentSha256}`
    );
  }
}

function getDetailedPorcelainStatus(repoPath: string): string[] {
  const output = runGitCommand(
    repoPath,
    ["status", "--porcelain", "-uall"],
  ).stdout.trimEnd();
  return output ? output.split("\n") : [];
}

function statusPath(line: string): string {
  return normalizePath(line.slice(3).split(" -> ").pop()!.trim());
}

function isIgnoredPath(filePath: string, ignoredPrefixes: string[]): boolean {
  return ignoredPrefixes.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`));
}

function isIgnoredStatusLine(line: string, ignoredPrefixes: string[]): boolean {
  return isIgnoredPath(statusPath(line), ignoredPrefixes);
}

export function checkGitBaseCamp(
  repoPath: string,
  options: { ignoredPrefixes?: string[]; strictClean?: boolean } = {}
): GitBaseCampStatus {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!isGitRepo(repoPath)) {
    return {
      status: "blocked",
      headSha: null,
      clean: false,
      blockers: ["Path is not a git repository."],
      warnings: [],
    };
  }

  if (!hasCommits(repoPath)) {
    return {
      status: "blocked",
      headSha: null,
      clean: false,
      blockers: ["Git repository has no commits."],
      warnings: [],
    };
  }

  const headSha = getHeadSha(repoPath);
  const porcelain = getDetailedPorcelainStatus(repoPath).filter(
    (line) => !isIgnoredStatusLine(line, options.ignoredPrefixes ?? [])
  );
  const clean = porcelain.length === 0;

  if (!clean) {
    const message = `Working tree has uncommitted changes: ${porcelain.join(", ")}`;
    // Only block if strictClean is required (e.g., before merge)
    // Otherwise just warn (allow local development with other uncommitted work)
    if (options.strictClean) {
      blockers.push(message);
    } else {
      warnings.push(message);
    }
  }

  return {
    status: blockers.length === 0 ? (clean ? "ready" : "dirty") : "blocked",
    headSha,
    clean,
    blockers,
    warnings,
  };
}

function mutationKindFromNameStatus(status: string): WorkspaceMutation["kind"] {
  if (status === "A") return "created";
  if (status === "D") return "deleted";
  return "modified";
}

function renderList(values: string[]): string {
  if (values.length === 0) return "- None";
  return values.map((value) => `- ${value}`).join("\n");
}

function renderDeviationList(deviations: BuildDeviation[]): string {
  if (deviations.length === 0) return "- None";
  return deviations
    .map((deviation) => `- ${deviation.file} (${deviation.reason}, ${deviation.severityHint})`)
    .join("\n");
}

function renderBuildReport(run: BuildRunFile): string {
  return [
    "# Build Report",
    "",
    `Status: ${run.status}`,
    "",
    "## Changed files",
    renderList(run.changedFiles),
    "",
    "## Blocking files",
    renderList(run.blockers),
    "",
    "## Deviations",
    renderDeviationList(run.deviations),
    "",
  ].join("\n");
}

export function collectBuildResult(input: CollectBuildResultInput): BuildRunFile {
  assertSafeChangeId(input.changeId);
  const run = readLatestBuildRun(input.repoPath, input.changeId);
  if (!run) {
    throw buildWorkspaceNotFound(`No build run found for change: ${input.changeId}`);
  }
  const workspaceStats = tryLstat(run.workspacePath);
  if (!workspaceStats?.isDirectory()) {
    throw new Error(`Build workspace does not exist: ${run.workspacePath}`);
  }

  const patch = getBinaryDiff(run.workspacePath);
  const nameStatusEntries = getNameStatusDiff(run.workspacePath);
  const changedFiles = unique(nameStatusEntries.map((entry) => normalizePath(entry.path))).sort();
  if (changedFiles.length === 0 || patch.trim() === "") {
    const failedRun: BuildRunFile = {
      ...run,
      status: "failed",
      changedFiles: [],
      blockers: ["Build workspace produced no changes."],
      updatedAt: new Date().toISOString(),
    };
    writeBuildRun(input.repoPath, failedRun);
    throw new Error("Build workspace produced no changes");
  }
  const plan: BuildPlanScope = input.plan ?? loadDbPlanScope(input.changeId);
  const policy = loadPolicy(input.repoPath);
  const gate = evaluateBuildGate({
    mutations: nameStatusEntries.map((entry) => ({
      kind: mutationKindFromNameStatus(entry.status),
      path: normalizePath(entry.path),
    })),
    plan,
    policy,
  });
  const now = new Date().toISOString();
  const artifactPaths = buildResultArtifactPathsForRun(run);
  const collectedRun: BuildRunFile = {
    ...run,
    status: gate.blocked ? "gate_blocked" : "awaiting_human",
    expectedFiles: plan.expectedFiles ?? plan.allowedFiles ?? [],
    forbiddenFiles: plan.forbiddenFiles ?? [],
    changedFiles,
    deviations: gate.deviations,
    blockers: gate.blockingFiles,
    ...artifactPaths,
    patchSha256: sha256(patch),
    patchHash: sha256(patch),
    changedFilesHash: hashBuildChangedFiles(changedFiles),
    designSourceDbHash: input.designSourceDbHash ?? run.designSourceDbHash ?? null,
    updatedAt: now,
  };
  const audit = {
    status: collectedRun.status,
    blockingFiles: gate.blockingFiles,
    deviations: gate.deviations,
    changedFiles,
    designSourceDbHash: collectedRun.designSourceDbHash ?? null,
  };

  writeBuildArtifact(input.repoPath, input.changeId, artifactPaths.diffPath!, patch);
  writeBuildArtifact(input.repoPath, input.changeId, artifactPaths.patchPath!, patch);
  writeBuildArtifact(
    input.repoPath,
    input.changeId,
    artifactPaths.auditPath!,
    `${JSON.stringify(audit, null, 2)}\n`
  );
  writeBuildArtifact(
    input.repoPath,
    input.changeId,
    artifactPaths.reportPath!,
    renderBuildReport(collectedRun)
  );
  writeBuildRun(input.repoPath, collectedRun);
  recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, collectedRun);
  return collectedRun;
}

function getRecoverableDirtyFiles(repoPath: string, ignoredPrefixes: string[]): string[] {
  return unique(
    getNameStatusDiff(repoPath)
      .map((entry) => normalizePath(entry.path))
      .filter((filePath) => !isIgnoredPath(filePath, ignoredPrefixes))
  ).sort();
}

function reverseApplyCheck(
  repoPath: string,
  patch: string,
  excludedPrefixes: string[] = []
): { ok: boolean; reason: string } {
  const result = runGitCommand(
    repoPath,
    ["apply", "--reverse", "--check", "--whitespace=nowarn", ...gitApplyExcludeArgs(excludedPrefixes), "-"],
    { input: patch, expectedExitCodes: [1] },
  );
  return result.status === 0
    ? { ok: true, reason: "" }
    : { ok: false, reason: "git apply reverse check failed" };
}

function adoptedPatchMatchesWorkspace(
  repoPath: string,
  run: BuildRunFile,
  patch: string,
  ignoredPrefixes: string[],
  patchExcludedPrefixes: string[] = []
): { ok: boolean; reason: string } {
  const dirtyFiles = getRecoverableDirtyFiles(repoPath, ignoredPrefixes);
  const approvedSourceFiles = new Set(
    run.changedFiles
      .map((filePath) => normalizePath(filePath))
      .filter((filePath) => !isShipArtifact(filePath))
  );
  const unapprovedDirtyFiles = dirtyFiles.filter((filePath) => !approvedSourceFiles.has(filePath));

  if (unapprovedDirtyFiles.length > 0) {
    return {
      ok: false,
      reason:
        `dirty files (${dirtyFiles.join(", ") || "none"}) include files outside ` +
        `the adopted patch (${Array.from(approvedSourceFiles).sort().join(", ") || "none"})`,
    };
  }

  const expectedProductDiff = getBinaryDiff(run.workspacePath, patchExcludedPrefixes);
  const currentProductDiff = getBinaryDiff(repoPath, patchExcludedPrefixes);
  const committedApprovedPatch = currentProductDiff.trim() === "";
  if (!committedApprovedPatch && currentProductDiff !== expectedProductDiff) {
    return {
      ok: false,
      reason:
        `current product diff does not exactly match the approved patch ` +
        `(expected ${sha256(expectedProductDiff)}, got ${sha256(currentProductDiff)})`,
    };
  }

  const reverseCheck = reverseApplyCheck(repoPath, patch, patchExcludedPrefixes);
  if (!reverseCheck.ok) {
    return {
      ok: false,
      reason: `adopted patch is not applied to the current workspace: ${reverseCheck.reason}`,
    };
  }

  return { ok: true, reason: "" };
}

function commitWorkspaceBaseline(workspacePath: string): void {
  runGitCommand(workspacePath, ["add", "-A"]);
  runGitCommand(workspacePath, ["commit", "-m", "stagepass adopted baseline"]);
}

/**
 * True when HEAD sits on a commit whose subject matches this exact adoption's
 * commit message, with no non-ignored dirty files left -- i.e. a prior attempt
 * already applied and committed this patch, then crashed before `adopted`
 * persisted. `treeIsReady` must come from the same ignored-prefixes check the
 * caller already ran (checkGitBaseCamp), since .ship/ artifacts legitimately
 * stay untracked even right after a successful adoption commit. Only ever
 * consulted when HEAD has already drifted from the run's base commit; a
 * message match this specific is not something an unrelated commit would
 * produce by chance.
 */
function isRetryOfOwnAdoptionCommit(
  repoPath: string,
  headSha: string,
  commitMessage: string,
  treeIsReady: boolean,
): boolean {
  return treeIsReady && getCommitSubject(repoPath, headSha) === commitMessage;
}

/** The patch's own files, in the same shape adoptedPatchMatchesWorkspace already trusts as "the patch". */
function adoptionCommitPaths(changedFiles: string[]): string[] {
  return changedFiles.map((filePath) => normalizePath(filePath)).filter((filePath) => !isShipArtifact(filePath));
}

export function assertAdoptedBuildRunMatchesWorkspace(
  input: AssertAdoptedBuildRunMatchesWorkspaceInput
): BuildRunFile {
  assertSafeChangeId(input.changeId);
  const run = input.runNumber === undefined
    ? readLatestBuildRun(input.repoPath, input.changeId)
    : readBuildRunByNumber(input.repoPath, input.changeId, input.runNumber);
  if (!run) {
    throw buildWorkspaceConflict(`No build run found for change: ${input.changeId}`);
  }
  if (run.status !== "adopted") {
    throw buildWorkspaceConflict(`Build run must be adopted before review; current status is ${run.status}`);
  }
  if (!run.adoptedHeadSha) {
    throw buildWorkspaceConflict("Build run is missing adopted HEAD metadata");
  }
  const currentHeadSha = getHeadSha(input.repoPath);
  if (currentHeadSha !== run.adoptedHeadSha) {
    throw buildWorkspaceConflict(
      `Build workspace HEAD drifted after adoption: expected ${run.adoptedHeadSha}, got ${currentHeadSha}`
    );
  }

  const patch = readVerifiedBuildPatch(input.repoPath, input.changeId, run);
  const current = adoptedPatchMatchesWorkspace(
    input.repoPath,
    run,
    patch,
    changeAndSiblingArtifactIgnoredPrefixes(input.repoPath, input.changeId),
    patchAdoptionIgnoredPrefixes()
  );
  if (!current.ok) {
    throw buildWorkspaceConflict(current.reason);
  }

  return run;
}

export function assertTrustedAdoptedBuildState(
  input: AssertAdoptedBuildRunMatchesWorkspaceInput,
): BuildRunFile {
  const run = assertAdoptedBuildRunMatchesWorkspace(input);
  assertBuildRunDbFreshForAdoption(input.changeId, run);
  const record = getBuildRunRecord(input.changeId, buildRunId(run));
  if (
    !record ||
    record.status !== "adopted" ||
    record.adoptedHeadSha !== run.adoptedHeadSha ||
    record.adoptionDecisionId !== run.adoptionDecisionId ||
    record.patchHash !== run.patchSha256 ||
    record.changedFilesHash !== hashBuildChangedFiles(run.changedFiles)
  ) {
    throw buildWorkspaceConflict("build_hash_drift: adopted BuildRun DB metadata does not match workspace authority");
  }
  return run;
}

export function approveBuildForAbsorb(input: AbsorbBuildPatchInput): BuildRunFile {
  assertSafeChangeId(input.changeId);
  const run = readLatestBuildRun(input.repoPath, input.changeId);
  if (!run) {
    throw buildWorkspaceNotFound(`No build run found for change: ${input.changeId}`);
  }
  if (run.status === "adopted") {
    const adopted = assertAdoptedBuildRunMatchesWorkspace(input);
    recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, adopted);
    return adopted;
  }
  if (run.status === "approved_for_absorb") {
    const patch = readVerifiedBuildPatch(input.repoPath, input.changeId, run);
    const approval = readBuildPatchApproval(input.repoPath, input.changeId, run);
    assertApprovalMatchesRun(approval, run, patch);
    const approvalPath = buildApprovalPathForRun(run);
    if (run.approvalPath === approvalPath) {
      return run;
    }
    const approvedRun: BuildRunFile = {
      ...run,
      approvalPath,
      updatedAt: new Date().toISOString(),
    };
    writeBuildRun(input.repoPath, approvedRun);
    recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, approvedRun);
    return approvedRun;
  }
  if (run.status !== "awaiting_human") {
    throw buildWorkspaceConflict(
      `Build run must be awaiting_human before approval for absorb; current status is ${run.status}`
    );
  }
  readVerifiedBuildPatch(input.repoPath, input.changeId, run);
  if (!run.baseCommit) {
    throw buildWorkspaceConflict("Cannot approve build patch without a base commit");
  }

  const approvedAt = new Date().toISOString();
  const approvalPath = writeBuildPatchApproval(input.repoPath, input.changeId, {
    changeId: run.changeId,
    runNumber: run.runNumber,
    baseCommit: run.baseCommit,
    patchPath: run.patchPath!,
    patchSha256: run.patchSha256!,
    approvedAt,
  });
  const approvedRun: BuildRunFile = {
    ...run,
    status: "approved_for_absorb",
    approvalPath,
    updatedAt: approvedAt,
  };
  writeBuildRun(input.repoPath, approvedRun);
  recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, approvedRun);
  return approvedRun;
}

export function absorbBuildPatch(input: AbsorbBuildPatchInput): BuildRunFile {
  assertSafeChangeId(input.changeId);
  const run = readLatestBuildRun(input.repoPath, input.changeId);
  if (!run) {
    throw buildWorkspaceNotFound(`No build run found for change: ${input.changeId}`);
  }
  if (run.status === "adopted") {
    const adopted = assertAdoptedBuildRunMatchesWorkspace(input);
    recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, adopted);
    return adopted;
  }
  if (run.status !== "approved_for_absorb") {
    throw buildWorkspaceConflict(
      `Build run must be approved_for_absorb before absorb; current status is ${run.status}`
    );
  }
  const patch = readVerifiedBuildPatch(input.repoPath, input.changeId, run);
  const approval = readBuildPatchApproval(input.repoPath, input.changeId, run);
  assertApprovalMatchesRun(approval, run, patch);
  assertBuildRunDbFreshForAdoption(input.changeId, run);
  const adoptionDecisionId = `build-${run.runNumber}-adoption`;
  const commitMessage = `build(${input.changeId}): adopt ${adoptionDecisionId}`;
  const removedMirrorArtifacts = captureAndRemoveBuildAdoptionMirrorArtifacts(input.repoPath, run);
  try {
    const baseCamp = checkGitBaseCamp(input.repoPath, {
      ignoredPrefixes: [
        ...pipelineSystemMetadataIgnoredPrefixes(),
        ...allChangeArtifactIgnoredPrefixes(input.repoPath, input.changeId),
      ],
    });
    if (!run.baseCommit) {
      throw buildWorkspaceConflict("Cannot absorb build patch without a base commit");
    }
    if (!baseCamp.headSha) {
      throw buildWorkspaceConflict(`Cannot absorb build patch into dirty workspace: ${baseCamp.blockers.join("; ")}`);
    }
    if (baseCamp.headSha === run.baseCommit && baseCamp.status === "ready") {
      applyPatch(input.repoPath, patch, { excludedPrefixes: patchAdoptionIgnoredPrefixes() });
      if (input.commit?.enabled) {
        commitWithMessage(input.repoPath, commitMessage, adoptionCommitPaths(run.changedFiles));
      }
    } else if (baseCamp.headSha === run.baseCommit) {
      const alreadyApplied = adoptedPatchMatchesWorkspace(
        input.repoPath,
        run,
        patch,
        [
          ...pipelineSystemMetadataIgnoredPrefixes(),
          ...allChangeArtifactIgnoredPrefixes(input.repoPath, input.changeId),
        ],
        patchAdoptionIgnoredPrefixes(),
      );
      if (!alreadyApplied.ok) {
        throw buildWorkspaceConflict(
          `Cannot absorb build patch into dirty workspace: ${baseCamp.blockers.join("; ")}; ${alreadyApplied.reason}`
        );
      }
    } else if (
      input.commit?.enabled
      && isRetryOfOwnAdoptionCommit(input.repoPath, baseCamp.headSha, commitMessage, baseCamp.status === "ready")
    ) {
      // A prior attempt already applied and committed this exact adoption, then
      // crashed before `adopted` persisted. HEAD moved past run.baseCommit, but
      // it's our own commit -- nothing left to apply.
    } else {
      throw buildWorkspaceConflict(`HEAD drifted from build base commit: expected ${run.baseCommit}, got ${baseCamp.headSha}`);
    }

    const adoptedHeadSha = getHeadSha(input.repoPath);
    const adoptedRun: BuildRunFile = {
      ...run,
      status: "adopted",
      adoptedHeadSha,
      adoptionDecisionId,
      updatedAt: new Date().toISOString(),
    };
    restoreMirrorArtifacts(input.repoPath, removedMirrorArtifacts);
    removedMirrorArtifacts.length = 0;
    writeBuildRun(input.repoPath, adoptedRun);
    recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, adoptedRun);
    return adoptedRun;
  } finally {
    restoreMirrorArtifacts(input.repoPath, removedMirrorArtifacts);
  }
}

export function adoptFixPatch(input: AdoptFixPatchInput): BuildRunFile {
  assertSafeChangeId(input.changeId);
  const run = readLatestBuildRun(input.repoPath, input.changeId);
  if (!run) {
    throw buildWorkspaceNotFound(`No build run found for change: ${input.changeId}`);
  }
  if (run.status !== "approved_for_absorb") {
    throw buildWorkspaceConflict(
      `Fix run must be approved_for_absorb before adoption; current status is ${run.status}`
    );
  }
  if (run.purpose !== "fix") {
    throw buildWorkspaceConflict(`Latest BuildRun is not a fix run; current purpose is ${run.purpose ?? "build"}`);
  }

  const patch = readVerifiedBuildPatch(input.repoPath, input.changeId, run);
  const approval = readBuildPatchApproval(input.repoPath, input.changeId, run);
  assertApprovalMatchesRun(approval, run, patch);
  assertFixRunDbFreshForAdoption(input.changeId, run);
  const adoptionDecisionId = `fix-${run.runNumber}-adoption`;
  const commitMessage = `fix(${input.changeId}): adopt ${adoptionDecisionId}`;

  const removedMirrorArtifacts = captureAndRemoveBuildAdoptionMirrorArtifacts(input.repoPath, run);
  try {
    const baseCamp = checkGitBaseCamp(input.repoPath, {
      ignoredPrefixes: changeAndSiblingArtifactIgnoredPrefixes(input.repoPath, input.changeId),
    });
    if (!run.baseCommit) {
      throw buildWorkspaceConflict("Cannot adopt fix patch without a base commit");
    }
    if (!baseCamp.headSha) {
      throw buildWorkspaceConflict(`Cannot adopt fix patch without a valid HEAD: ${baseCamp.blockers.join("; ")}`);
    }
    if (baseCamp.headSha === run.baseCommit) {
      if (baseCamp.status !== "ready") {
        const previousAdoptedRun = readPreviousAdoptedBuildRun(input.repoPath, input.changeId, run.runNumber);
        if (!previousAdoptedRun) {
          throw buildWorkspaceConflict(
            `Cannot adopt fix patch into dirty workspace: ${baseCamp.blockers.join("; ")}`
          );
        }
        const previousPatch = readVerifiedBuildPatch(input.repoPath, input.changeId, previousAdoptedRun);
        const adoptedCurrent = adoptedPatchMatchesWorkspace(
          input.repoPath,
          previousAdoptedRun,
          previousPatch,
          changeAndSiblingArtifactIgnoredPrefixes(input.repoPath, input.changeId),
          patchAdoptionIgnoredPrefixes()
        );
        if (!adoptedCurrent.ok) {
          throw buildWorkspaceConflict(`Cannot adopt fix patch into dirty workspace: ${adoptedCurrent.reason}`);
        }
      }
      applyPatch(input.repoPath, patch, { excludedPrefixes: patchAdoptionIgnoredPrefixes() });
      if (input.commit?.enabled) {
        commitWithMessage(input.repoPath, commitMessage, adoptionCommitPaths(run.changedFiles));
      }
    } else if (
      input.commit?.enabled
      && isRetryOfOwnAdoptionCommit(input.repoPath, baseCamp.headSha, commitMessage, baseCamp.status === "ready")
    ) {
      // A prior attempt already applied and committed this exact adoption, then
      // crashed before `adopted` persisted. Nothing left to apply.
    } else {
      throw buildWorkspaceConflict(
        `HEAD drifted from fix base commit: expected ${run.baseCommit}, got ${baseCamp.headSha}`
      );
    }

    const adoptedHeadSha = getHeadSha(input.repoPath);
    const adoptedRun: BuildRunFile = {
      ...run,
      status: "adopted",
      adoptedHeadSha,
      adoptionDecisionId,
      updatedAt: new Date().toISOString(),
    };
    restoreMirrorArtifacts(input.repoPath, removedMirrorArtifacts);
    writeBuildRun(input.repoPath, adoptedRun);
    recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, adoptedRun);
    return adoptedRun;
  } catch (error) {
    restoreMirrorArtifacts(input.repoPath, removedMirrorArtifacts);
    throw error;
  }
}

export function rejectLatestBuildRun(input: RejectLatestBuildRunInput): BuildRunFile {
  assertSafeChangeId(input.changeId);
  const run = readLatestBuildRun(input.repoPath, input.changeId);
  if (!run) {
    throw buildWorkspaceNotFound(`No build run found for change: ${input.changeId}`);
  }
  if (run.status !== "awaiting_human" && run.status !== "gate_blocked") {
    throw buildWorkspaceConflict(`Build run cannot be rejected from status: ${run.status}`);
  }

  const rejectedRun: BuildRunFile = {
    ...run,
    status: "rejected",
    updatedAt: new Date().toISOString(),
  };
  writeBuildRun(input.repoPath, rejectedRun);
  recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, rejectedRun);
  return rejectedRun;
}

export function createBuildWorkspace(input: CreateBuildWorkspaceInput): BuildRunFile {
  assertSafeChangeId(input.changeId);
  const latestRun = readLatestBuildRun(input.repoPath, input.changeId);
  let adoptedBaselinePatch: string | null = null;
  let baseCamp = checkGitBaseCamp(input.repoPath, {
    // Sibling-aware like the adopt paths. Here it only shapes WARNINGS
    // (strictClean: false), but those warnings are what the Base Camp panel
    // shows the user, and listing another change's pipeline artifacts as
    // "uncommitted work" is noise that buries the real ones.
    ignoredPrefixes: changeAndSiblingArtifactIgnoredPrefixes(input.repoPath, input.changeId),
    strictClean: false, // Don't require clean tree for build - allow local uncommitted work
  });
  // Only block if there are actual blockers (not just warnings)
  if (baseCamp.blockers.length > 0 || !baseCamp.headSha) {
    if (input.purpose === "fix") {
      // For fix workspace, always try to clean dirty files first
      runGitCommand(input.repoPath, ["reset", "--hard", "HEAD"]);
      runGitCommand(input.repoPath, ["clean", "-fd"]);

      // Re-check after cleanup
      const baseCampAfterClean = checkGitBaseCamp(input.repoPath, {
        ignoredPrefixes: changeAndSiblingArtifactIgnoredPrefixes(input.repoPath, input.changeId),
        strictClean: false,
      });
      if (baseCampAfterClean.blockers.length > 0 || !baseCampAfterClean.headSha) {
        throw buildWorkspaceConflict(`Fix workspace base camp blocked after cleanup: ${baseCampAfterClean.blockers.join("; ")}`);
      }
      baseCamp = baseCampAfterClean;

      // If there was an adopted run, verify the patch still matches
      if (latestRun?.status === "adopted") {
        adoptedBaselinePatch = readVerifiedBuildPatch(input.repoPath, input.changeId, latestRun);
        const adoptedCurrent = adoptedPatchMatchesWorkspace(
          input.repoPath,
          latestRun,
          adoptedBaselinePatch,
          changeAndSiblingArtifactIgnoredPrefixes(input.repoPath, input.changeId),
          patchAdoptionIgnoredPrefixes()
        );
        if (!adoptedCurrent.ok) {
          throw buildWorkspaceConflict(`Fix workspace base camp blocked: ${adoptedCurrent.reason}`);
        }
      }
    } else {
      throw buildWorkspaceConflict(`Build workspace base camp blocked: ${baseCamp.blockers.join("; ")}`);
    }
  }

  const runNumber = (latestRun?.runNumber ?? 0) + 1;
  const workspacePath = workspacePathFor(input.repoPath, input.changeId, runNumber);
  const branchName = buildBranchName(input.changeId, runNumber);

  assertControlledWorkspacePath(input.repoPath, workspacePath, { finalMustNotExist: true });
  const baseHeadSha = baseCamp.headSha;
  if (!baseHeadSha) {
    throw buildWorkspaceConflict(`Build workspace base camp blocked: ${baseCamp.blockers.join("; ")}`);
  }

  const now = new Date().toISOString();
  const run: BuildRunFile = {
    changeId: input.changeId,
    runNumber,
    status: "created",
    purpose: input.purpose ?? "build",
    baseHeadSha,
    baseCommit: baseHeadSha,
    workspacePath,
    branchName,
    expectedFiles: [],
    forbiddenFiles: [],
    changedFiles: [],
    deviations: [],
    blockers: [],
    patchPath: null,
    patchSha256: null,
    designSourceDbHash: input.designSourceDbHash ?? null,
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    createGitWorktree(input.repoPath, {
      workspacePath,
      branchName,
      baseCommit: baseHeadSha,
    });
    assertControlledWorkspacePath(input.repoPath, workspacePath, { finalMustNotExist: false });
    if (adoptedBaselinePatch) {
      applyPatch(workspacePath, adoptedBaselinePatch, { excludedPrefixes: patchAdoptionIgnoredPrefixes() });
      commitWorkspaceBaseline(workspacePath);
    }
    writeBuildRun(input.repoPath, run);
    recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, run);
    return run;
  } catch (error) {
    try {
      removeGitWorktree(input.repoPath, workspacePath, true);
    } finally {
      deleteGitBranch(input.repoPath, branchName, true);
    }
    throw error;
  }
}
