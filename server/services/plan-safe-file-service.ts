import fs from "fs";
import path from "path";

export type JsonReadResult<T> = {
  value: T | null;
  invalid: boolean;
};

export function changeDir(repoPath: string, changeId: string): string {
  return path.join(repoPath, ".ship", "changes", changeId);
}

export function planPath(repoPath: string, changeId: string): string {
  return path.join(changeDir(repoPath, changeId), "plan.json");
}

export function planMarkdownPath(repoPath: string, changeId: string): string {
  return path.join(changeDir(repoPath, changeId), "plan.md");
}

export function critiquePath(repoPath: string, changeId: string): string {
  return path.join(changeDir(repoPath, changeId), "plan-critique.json");
}

export function reportPath(repoPath: string, changeId: string): string {
  return path.join(changeDir(repoPath, changeId), "reports", "plan-report.md");
}

function isPathInside(filePath: string, root: string): boolean {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolvedFilePath === resolvedRoot || resolvedFilePath.startsWith(resolvedRoot + path.sep);
}

function tryLstat(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function tryRealPath(filePath: string): string | null {
  try {
    return fs.realpathSync.native(filePath);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

type SafeWritePaths = {
  repoRoot: string;
  expectedChangeDir: string;
  resolvedTargetPath: string;
  parentDir: string;
};

function safeWritePaths(repoPath: string, changeId: string, targetPath: string): SafeWritePaths {
  const repoRoot = path.resolve(repoPath);
  const expectedChangeDir = path.resolve(changeDir(repoPath, changeId));
  const resolvedTargetPath = path.resolve(targetPath);
  if (!isPathInside(resolvedTargetPath, expectedChangeDir)) {
    throw new Error(`Plan sandbox write target is outside this change: ${targetPath}`);
  }

  return {
    repoRoot,
    expectedChangeDir,
    resolvedTargetPath,
    parentDir: path.dirname(resolvedTargetPath),
  };
}

function assertSafeExistingDirectory(
  directoryPath: string,
  repoRoot: string,
  realRepoRoot: string | null
): void {
  const stats = tryLstat(directoryPath);
  if (!stats) return;
  if (stats.isSymbolicLink()) {
    throw new Error(`Plan sandbox directory is a symlink: ${directoryPath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Plan sandbox path is not a directory: ${directoryPath}`);
  }

  const realDirectoryPath = tryRealPath(directoryPath);
  if (realRepoRoot && realDirectoryPath && !isPathInside(realDirectoryPath, realRepoRoot)) {
    throw new Error(`Plan sandbox directory resolves outside the repository: ${directoryPath}`);
  }
}

function assertExistingAncestorsSafe(repoRoot: string, targetDir: string): void {
  if (!isPathInside(targetDir, repoRoot)) {
    throw new Error(`Plan sandbox directory is outside the repository: ${targetDir}`);
  }

  const realRepoRoot = tryRealPath(repoRoot);
  const relativeTargetDir = path.relative(repoRoot, targetDir);
  if (relativeTargetDir === "") return;

  let current = repoRoot;
  for (const segment of relativeTargetDir.split(path.sep)) {
    current = path.join(current, segment);
    const stats = tryLstat(current);
    if (!stats) return;
    assertSafeExistingDirectory(current, repoRoot, realRepoRoot);
  }
}

function ensureSafeDirectory(repoPath: string, changeId: string, directoryPath: string): void {
  const { repoRoot, expectedChangeDir } = safeWritePaths(
    repoPath,
    changeId,
    path.join(directoryPath, ".plan-sandbox-write-check")
  );
  const resolvedDirectoryPath = path.resolve(directoryPath);
  if (!isPathInside(resolvedDirectoryPath, expectedChangeDir)) {
    throw new Error(`Plan sandbox write directory is outside this change: ${directoryPath}`);
  }

  const realRepoRoot = tryRealPath(repoRoot);
  const relativeDirectoryPath = path.relative(repoRoot, resolvedDirectoryPath);
  let current = repoRoot;
  for (const segment of relativeDirectoryPath.split(path.sep)) {
    if (segment === "") continue;
    current = path.join(current, segment);
    const stats = tryLstat(current);
    if (stats) {
      assertSafeExistingDirectory(current, repoRoot, realRepoRoot);
      continue;
    }

    assertExistingAncestorsSafe(repoRoot, path.dirname(current));
    fs.mkdirSync(current);
    assertSafeExistingDirectory(current, repoRoot, realRepoRoot);
  }
}

function sameFileStats(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSymlinkOpenError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ELOOP"
  );
}

export function assertSafeWriteTarget(repoPath: string, changeId: string, targetPath: string): void {
  const { repoRoot, expectedChangeDir, resolvedTargetPath, parentDir } = safeWritePaths(
    repoPath,
    changeId,
    targetPath
  );

  assertExistingAncestorsSafe(repoRoot, parentDir);

  const changeDirStats = tryLstat(expectedChangeDir);
  if (changeDirStats?.isSymbolicLink()) {
    throw new Error(`Plan sandbox change directory is a symlink: ${expectedChangeDir}`);
  }

  const targetStats = tryLstat(resolvedTargetPath);
  if (targetStats?.isSymbolicLink()) {
    throw new Error(`Plan sandbox write target is a symlink: ${targetPath}`);
  }

  const parentStats = tryLstat(parentDir);
  if (parentStats?.isSymbolicLink()) {
    throw new Error(`Plan sandbox write parent is a symlink: ${parentDir}`);
  }

  const realRepoRoot = tryRealPath(repoRoot);
  const realChangeDir = tryRealPath(expectedChangeDir);
  if (realRepoRoot && realChangeDir && !isPathInside(realChangeDir, realRepoRoot)) {
    throw new Error(`Plan sandbox change directory resolves outside the repository: ${expectedChangeDir}`);
  }

  if (parentStats) {
    const realParentDir = tryRealPath(parentDir);
    if (realChangeDir && realParentDir && !isPathInside(realParentDir, realChangeDir)) {
      throw new Error(`Plan sandbox write parent resolves outside this change: ${parentDir}`);
    }
  }
}

function prepareSafeWriteTarget(repoPath: string, changeId: string, targetPath: string): void {
  assertSafeWriteTarget(repoPath, changeId, targetPath);
  ensureSafeDirectory(repoPath, changeId, path.dirname(targetPath));
  assertSafeWriteTarget(repoPath, changeId, targetPath);
}

export function writeFileNoFollow(
  repoPath: string,
  changeId: string,
  targetPath: string,
  content: string
): void {
  const resolvedTargetPath = path.resolve(targetPath);
  prepareSafeWriteTarget(repoPath, changeId, resolvedTargetPath);
  assertSafeWriteTarget(repoPath, changeId, resolvedTargetPath);

  const targetBeforeOpen = tryLstat(resolvedTargetPath);
  if (targetBeforeOpen?.isSymbolicLink()) {
    throw new Error(`Plan sandbox write target is a symlink: ${resolvedTargetPath}`);
  }

  const noFollowFlag =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollowFlag;
  let fd: number | null = null;
  try {
    fd = fs.openSync(resolvedTargetPath, flags, 0o666);
    const openedStats = fs.fstatSync(fd);
    const targetAfterOpen = fs.lstatSync(resolvedTargetPath);
    if (targetAfterOpen.isSymbolicLink()) {
      throw new Error(`Plan sandbox write target is a symlink: ${resolvedTargetPath}`);
    }
    if (targetBeforeOpen && !sameFileStats(targetBeforeOpen, targetAfterOpen)) {
      throw new Error(`Plan sandbox write target changed before write: ${resolvedTargetPath}`);
    }
    if (!sameFileStats(openedStats, targetAfterOpen)) {
      throw new Error(`Plan sandbox write target does not match opened file: ${resolvedTargetPath}`);
    }

    fs.writeFileSync(fd, content, "utf-8");
  } catch (error) {
    if (isSymlinkOpenError(error)) {
      throw new Error(`Plan sandbox write target is a symlink: ${resolvedTargetPath}`);
    }
    throw error;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }

  assertSafeWriteTarget(repoPath, changeId, resolvedTargetPath);
}

export function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

export function readJson<T>(filePath: string): JsonReadResult<T> {
  const raw = readText(filePath);
  if (raw === null) return { value: null, invalid: false };
  try {
    return { value: JSON.parse(raw) as T, invalid: false };
  } catch {
    return { value: null, invalid: true };
  }
}
