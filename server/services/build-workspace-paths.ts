import fs from "node:fs";
import path from "node:path";

import type { BuildRunFile } from "./build-types";

export function assertSafeChangeId(changeId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(changeId)) {
    throw new Error(`Invalid changeId for build workspace artifacts: ${changeId}`);
  }
}

export function buildRunsDir(repoPath: string, changeId: string): string {
  assertSafeChangeId(changeId);
  return path.join(repoPath, ".ship", "changes", changeId, "build", "runs");
}

export function buildRunPath(
  repoPath: string,
  run: Pick<BuildRunFile, "changeId" | "runNumber">
): string {
  if (!Number.isInteger(run.runNumber) || run.runNumber < 1) {
    throw new Error(`Invalid build run number: ${run.runNumber}`);
  }
  return path.join(buildRunsDir(repoPath, run.changeId), `build-${run.runNumber}.json`);
}

export function buildApprovalPathForRun(run: Pick<BuildRunFile, "changeId" | "runNumber">): string {
  if (!Number.isInteger(run.runNumber) || run.runNumber < 1) {
    throw new Error(`Invalid build run number: ${run.runNumber}`);
  }
  assertSafeChangeId(run.changeId);
  return normalizePath(
    path.join(
      ".ship",
      "changes",
      run.changeId,
      "approvals",
      `build-${run.runNumber}-approval.json`
    )
  );
}

export function workspacePathFor(repoPath: string, changeId: string, runNumber: number): string {
  assertSafeChangeId(changeId);
  return path.join(
    path.dirname(repoPath),
    ".stagepass-workspaces",
    path.basename(repoPath),
    changeId,
    `build-${runNumber}`
  );
}

export function controlledWorkspacesRoot(repoPath: string): string {
  return path.join(path.dirname(path.resolve(repoPath)), ".stagepass-workspaces");
}

export function buildBranchName(changeId: string, runNumber: number): string {
  assertSafeChangeId(changeId);
  return `stagepass/build/${changeId}/build-${runNumber}`;
}

export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/\\/g, "/");
}

export function isPathInside(filePath: string, root: string): boolean {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolvedFilePath === resolvedRoot || resolvedFilePath.startsWith(resolvedRoot + path.sep);
}

export function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function tryLstat(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export function tryRealPath(filePath: string): string | null {
  try {
    return fs.realpathSync.native(filePath);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export function ensureControlledWorkspacesRoot(repoPath: string): string {
  const root = controlledWorkspacesRoot(repoPath);
  const stats = tryLstat(root);
  if (stats?.isSymbolicLink()) {
    throw new Error(`Build worktree root is a symlink and cannot be trusted: ${root}`);
  }
  if (stats && !stats.isDirectory()) {
    throw new Error(`Build worktree root is not a directory: ${root}`);
  }
  fs.mkdirSync(root, { recursive: true });

  const realParent = tryRealPath(path.dirname(path.resolve(repoPath))) ?? path.dirname(path.resolve(repoPath));
  const realRoot = fs.realpathSync.native(root);
  if (!isPathInside(realRoot, realParent)) {
    throw new Error(`Build worktree root resolves outside the controlled parent: ${root}`);
  }
  return root;
}

export function assertControlledWorkspacePath(
  repoPath: string,
  workspacePath: string,
  options: { finalMustNotExist: boolean },
): void {
  const root = ensureControlledWorkspacesRoot(repoPath);
  const resolvedRoot = path.resolve(root);
  const resolvedWorkspacePath = path.resolve(workspacePath);
  if (!isPathInside(resolvedWorkspacePath, resolvedRoot)) {
    throw new Error(`Build workspace path escapes the controlled worktree root: ${workspacePath}`);
  }

  const relativeWorkspacePath = path.relative(resolvedRoot, resolvedWorkspacePath);
  let current = resolvedRoot;
  for (const segment of relativeWorkspacePath.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const stats = tryLstat(current);
    if (!stats) continue;
    if (stats.isSymbolicLink()) {
      throw new Error(`Build workspace path contains an untrusted symlink: ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Build workspace path contains a non-directory ancestor: ${current}`);
    }
  }

  if (options.finalMustNotExist && tryLstat(resolvedWorkspacePath)) {
    throw new Error(`Build workspace path already exists and cannot be reused: ${workspacePath}`);
  }

  const realRoot = fs.realpathSync.native(root);
  const realWorkspacePath = tryRealPath(resolvedWorkspacePath);
  if (realWorkspacePath && !isPathInside(realWorkspacePath, realRoot)) {
    throw new Error(`Build workspace realpath escapes the controlled worktree root: ${workspacePath}`);
  }
}

export function assertSafeExistingDirectory(
  directoryPath: string,
  repoRoot: string,
  realRepoRoot: string | null
): void {
  const stats = tryLstat(directoryPath);
  if (!stats) return;
  if (stats.isSymbolicLink()) {
    throw new Error(`Build workspace artifact directory is a symlink: ${directoryPath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Build workspace artifact path is not a directory: ${directoryPath}`);
  }

  const realDirectoryPath = tryRealPath(directoryPath);
  if (realRepoRoot && realDirectoryPath && !isPathInside(realDirectoryPath, realRepoRoot)) {
    throw new Error(`Build workspace artifact directory resolves outside the repository: ${directoryPath}`);
  }
}

export function assertSafeArtifactPath(
  repoPath: string,
  changeId: string,
  targetPath: string,
  artifactRoot: string
): void {
  const repoRoot = path.resolve(repoPath);
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const resolvedTargetPath = path.resolve(targetPath);
  if (!isPathInside(resolvedTargetPath, resolvedArtifactRoot)) {
    throw new Error(`Build workspace artifact target is outside this change: ${targetPath}`);
  }

  const realRepoRoot = tryRealPath(repoRoot);
  const relativeTargetDir = path.relative(repoRoot, path.dirname(resolvedTargetPath));
  let current = repoRoot;
  for (const segment of relativeTargetDir.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const stats = tryLstat(current);
    if (!stats) return;
    assertSafeExistingDirectory(current, repoRoot, realRepoRoot);
  }
}

export function assertBuildArtifactPath(repoPath: string, changeId: string, targetPath: string): void {
  assertSafeArtifactPath(
    repoPath,
    changeId,
    targetPath,
    path.join(repoPath, ".ship", "changes", changeId, "build")
  );
}

export function assertChangeArtifactPath(repoPath: string, changeId: string, targetPath: string): void {
  assertSafeArtifactPath(
    repoPath,
    changeId,
    targetPath,
    path.join(repoPath, ".ship", "changes", changeId)
  );
}

export function assertReadableBuildArtifactFile(
  repoPath: string,
  changeId: string,
  targetPath: string,
  artifactLabel = "Build patch artifact"
): void {
  assertBuildArtifactPath(repoPath, changeId, targetPath);

  const stats = tryLstat(targetPath);
  if (!stats) {
    throw new Error(`${artifactLabel} not found: ${targetPath}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${artifactLabel} is a symlink: ${targetPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`${artifactLabel} is not a file: ${targetPath}`);
  }

  const realRepoRoot = tryRealPath(path.resolve(repoPath));
  const realTargetPath = tryRealPath(targetPath);
  if (realRepoRoot && realTargetPath && !isPathInside(realTargetPath, realRepoRoot)) {
    throw new Error(`${artifactLabel} resolves outside the repository: ${targetPath}`);
  }
}

export function assertReadableChangeArtifactFile(
  repoPath: string,
  changeId: string,
  targetPath: string,
  artifactLabel: string
): void {
  assertChangeArtifactPath(repoPath, changeId, targetPath);

  const stats = tryLstat(targetPath);
  if (!stats) {
    throw new Error(`${artifactLabel} not found: ${targetPath}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${artifactLabel} is a symlink: ${targetPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`${artifactLabel} is not a file: ${targetPath}`);
  }

  const realRepoRoot = tryRealPath(path.resolve(repoPath));
  const realTargetPath = tryRealPath(targetPath);
  if (realRepoRoot && realTargetPath && !isPathInside(realTargetPath, realRepoRoot)) {
    throw new Error(`${artifactLabel} resolves outside the repository: ${targetPath}`);
  }
}

export function ensureSafeDirectory(repoPath: string, changeId: string, directoryPath: string): void {
  assertBuildArtifactPath(repoPath, changeId, path.join(directoryPath, ".build-workspace-write-check"));
  fs.mkdirSync(directoryPath, { recursive: true });
  assertBuildArtifactPath(repoPath, changeId, path.join(directoryPath, ".build-workspace-write-check"));
}

export function ensureSafeChangeDirectory(repoPath: string, changeId: string, directoryPath: string): void {
  assertChangeArtifactPath(repoPath, changeId, path.join(directoryPath, ".build-workspace-write-check"));
  fs.mkdirSync(directoryPath, { recursive: true });
  assertChangeArtifactPath(repoPath, changeId, path.join(directoryPath, ".build-workspace-write-check"));
}

export function writeBuildArtifact(repoPath: string, changeId: string, relativePath: string, content: string): void {
  const targetPath = path.join(repoPath, relativePath);
  const dir = path.dirname(targetPath);
  ensureSafeChangeDirectory(repoPath, changeId, dir);

  const tempPath = path.join(
    dir,
    `.${path.basename(relativePath)}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    fs.writeFileSync(tempPath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function buildResultArtifactPathsForRun(run: Pick<BuildRunFile, "changeId" | "runNumber">): Pick<
  BuildRunFile,
  "patchPath" | "diffPath" | "auditPath" | "reportPath"
> {
  const runArtifactDir = path.join(
    ".ship",
    "changes",
    run.changeId,
    "build",
    "runs",
    `build-${run.runNumber}`,
    "result"
  );
  return {
    patchPath: normalizePath(path.join(runArtifactDir, "build.patch")),
    diffPath: normalizePath(path.join(runArtifactDir, "build.diff")),
    auditPath: normalizePath(path.join(runArtifactDir, "build-audit.json")),
    reportPath: normalizePath(
      path.join(".ship", "changes", run.changeId, "reports", `build-${run.runNumber}-report.md`)
    ),
  };
}
