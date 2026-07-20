import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { artifactMirrors, changes, projects } from "../db/schema";
import type { PipelinePhase } from "./stage-authority-service";

type ArtifactMirrorDb = typeof import("../db/index").db;
type ArtifactMirrorRow = typeof artifactMirrors.$inferSelect;

export type ArtifactMirrorStatus =
  | "ok"
  | "missing"
  | "mismatch"
  | "corrupt"
  | "generation_failed"
  | "not_indexed";

export interface ArtifactMirrorSource {
  phase: PipelinePhase;
  artifactType: string;
  fileName?: string;
  path?: string;
  schemaVersion: string;
  sourceDbHash?: string | null;
  sourceRows?: unknown[];
  payload?: unknown;
  content?: string;
  renderer?: (input: ArtifactMirrorSource) => string;
}

export interface RenderMirrorsInput {
  db?: ArtifactMirrorDb;
  repoPath?: string;
  changeId: string;
  mirrors: ArtifactMirrorSource[];
  generatedAt?: string;
}

export interface RebuildArtifactMirrorInput {
  db?: ArtifactMirrorDb;
  repoPath?: string;
  changeId: string;
  mirror: ArtifactMirrorSource;
  generatedAt?: string;
}

export interface ArtifactMirrorResult {
  id: string;
  changeId: string;
  phase: PipelinePhase;
  artifactType: string;
  path: string;
  contentHash: string | null;
  sourceDbHash: string | null;
  schemaVersion: string;
  mirrorStatus: ArtifactMirrorStatus;
  generatedAt: string;
  warning?: string;
}

export interface ArtifactMirrorWarning {
  id: string | null;
  changeId: string;
  phase: PipelinePhase | string;
  artifactType: string;
  path: string | null;
  contentHash: string | null;
  sourceDbHash: string | null;
  schemaVersion: string | null;
  mirrorStatus: ArtifactMirrorStatus;
  warning: string;
  generatedAt: string | null;
}

const requireDefaultDb = createRequire(import.meta.url);
let artifactMirrorDbForTest: ArtifactMirrorDb | null = null;
let defaultArtifactMirrorDb: ArtifactMirrorDb | null = null;

export function setArtifactMirrorServiceDbForTest(nextDb: ArtifactMirrorDb): () => void {
  const previous = artifactMirrorDbForTest;
  artifactMirrorDbForTest = nextDb;
  return () => {
    artifactMirrorDbForTest = previous;
  };
}

function getArtifactMirrorDb(inputDb?: ArtifactMirrorDb): ArtifactMirrorDb {
  if (inputDb) return inputDb;
  if (artifactMirrorDbForTest) return artifactMirrorDbForTest;
  if (!defaultArtifactMirrorDb) {
    defaultArtifactMirrorDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultArtifactMirrorDb;
}

function nowISO(): string {
  return new Date().toISOString();
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortForStableJson(value), null, 2)}\n`;
}

function compactStableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortForStableJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function nextPrefixedId(ids: string[], prefix: string): string {
  const used = new Set(ids);
  let maxNum = 0;
  for (const id of ids) {
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) maxNum = Math.max(maxNum, Number.parseInt(match[1], 10));
  }

  let nextNum = maxNum + 1;
  let candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

function nextMirrorId(db: ArtifactMirrorDb): string {
  return nextPrefixedId(
    db.select({ id: artifactMirrors.id }).from(artifactMirrors).all().map((row) => row.id),
    "AMR",
  );
}

function changeArtifactDir(repoPath: string, changeId: string): string {
  return path.join(repoPath, ".ship", "changes", changeId);
}

function isPathInside(filePath: string, root: string): boolean {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolvedFilePath === resolvedRoot || resolvedFilePath.startsWith(resolvedRoot + path.sep);
}

function resolveMirrorPath(repoPath: string, changeId: string, mirror: ArtifactMirrorSource): string {
  const requestedPath = mirror.path ?? mirror.fileName;
  if (!requestedPath) {
    throw new Error(`Mirror path is required for ${mirror.phase}:${mirror.artifactType}`);
  }

  const changeDir = path.resolve(changeArtifactDir(repoPath, changeId));
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(changeDir, requestedPath);

  if (!isPathInside(resolvedPath, changeDir) || resolvedPath === changeDir) {
    throw new Error(`Artifact mirror path is outside this change: ${requestedPath}`);
  }

  return resolvedPath;
}

function assertWritableMirrorPath(filePath: string, changeDir: string): void {
  const changeDirStats = tryLstat(changeDir);
  if (changeDirStats?.isSymbolicLink()) {
    throw new Error(`Artifact mirror change directory is a symlink: ${changeDir}`);
  }

  const targetStats = tryLstat(filePath);
  if (targetStats?.isSymbolicLink()) {
    throw new Error(`Artifact mirror path is a symlink: ${filePath}`);
  }

  const realChangeDir = tryRealPath(changeDir);
  const realParentDir = tryRealPath(path.dirname(filePath));
  if (realChangeDir && realParentDir && !isPathInside(realParentDir, realChangeDir)) {
    throw new Error(`Artifact mirror parent resolves outside this change: ${filePath}`);
  }
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

function sourceDbHash(input: {
  changeId: string;
  mirror: ArtifactMirrorSource;
}): string | null {
  if (input.mirror.sourceDbHash !== undefined) return input.mirror.sourceDbHash;
  if (!input.mirror.sourceRows) return null;
  const rows = input.mirror.sourceRows
    .map((row) => sortForStableJson(row))
    .sort((left, right) => compactStableJson(left).localeCompare(compactStableJson(right)));
  return sha256Text(
    compactStableJson({
      changeId: input.changeId,
      phase: input.mirror.phase,
      artifactType: input.mirror.artifactType,
      rows,
    }),
  );
}

function renderMirrorContent(mirror: ArtifactMirrorSource): string {
  if (mirror.renderer) return mirror.renderer(mirror);
  if (mirror.content !== undefined) return mirror.content;
  if (mirror.payload !== undefined) return stableJson(mirror.payload);
  throw new Error(`Artifact mirror has no renderer, content, or payload: ${mirror.artifactType}`);
}

function errorCodeFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 120) || "generation_failed";
}

function existingMirror(
  db: ArtifactMirrorDb,
  changeId: string,
  phase: string,
  artifactType: string,
  filePath: string,
): ArtifactMirrorRow | null {
  const rows = db
    .select()
    .from(artifactMirrors)
    .where(
      and(
        eq(artifactMirrors.changeId, changeId),
        eq(artifactMirrors.phase, phase),
        eq(artifactMirrors.artifactType, artifactType),
        eq(artifactMirrors.path, filePath),
      ),
    )
    .all();
  rows.sort(compareMirrorRowsNewestFirst);
  return rows[0] ?? null;
}

function upsertMirrorRow(
  db: ArtifactMirrorDb,
  input: {
    changeId: string;
    phase: PipelinePhase;
    artifactType: string;
    path: string;
    contentHash: string | null;
    sourceDbHash: string | null;
    schemaVersion: string;
    mirrorStatus: ArtifactMirrorStatus;
    generatedAt: string;
  },
): ArtifactMirrorRow {
  const existing = existingMirror(
    db,
    input.changeId,
    input.phase,
    input.artifactType,
    input.path,
  );
  const values = {
    contentHash: input.contentHash,
    sourceDbHash: input.sourceDbHash,
    schemaVersion: input.schemaVersion,
    mirrorStatus: input.mirrorStatus,
    generatedAt: input.generatedAt,
  };

  if (existing) {
    db.update(artifactMirrors).set(values).where(eq(artifactMirrors.id, existing.id)).run();
    const updated = db.select().from(artifactMirrors).where(eq(artifactMirrors.id, existing.id)).get();
    if (!updated) throw new Error(`Failed to update artifact mirror ${existing.id}`);
    return updated;
  }

  const id = nextMirrorId(db);
  db.insert(artifactMirrors)
    .values({
      id,
      changeId: input.changeId,
      phase: input.phase,
      artifactType: input.artifactType,
      path: input.path,
      ...values,
    })
    .run();
  const inserted = db.select().from(artifactMirrors).where(eq(artifactMirrors.id, id)).get();
  if (!inserted) throw new Error(`Failed to create artifact mirror ${input.artifactType}`);
  return inserted;
}

function toResult(row: ArtifactMirrorRow, warning?: string): ArtifactMirrorResult {
  return {
    id: row.id,
    changeId: row.changeId,
    phase: row.phase as PipelinePhase,
    artifactType: row.artifactType,
    path: row.path,
    contentHash: row.contentHash,
    sourceDbHash: row.sourceDbHash,
    schemaVersion: row.schemaVersion ?? "",
    mirrorStatus: row.mirrorStatus as ArtifactMirrorStatus,
    generatedAt: row.generatedAt,
    ...(warning ? { warning } : {}),
  };
}

function renderOneMirror(input: {
  db: ArtifactMirrorDb;
  repoPath: string;
  changeId: string;
  mirror: ArtifactMirrorSource;
  generatedAt: string;
}): ArtifactMirrorResult {
  const filePath = resolveMirrorPath(input.repoPath, input.changeId, input.mirror);
  const expectedSourceDbHash = sourceDbHash({ changeId: input.changeId, mirror: input.mirror });

  try {
    const content = renderMirrorContent(input.mirror);
    const changeDir = path.resolve(changeArtifactDir(input.repoPath, input.changeId));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    assertWritableMirrorPath(filePath, changeDir);
    fs.writeFileSync(filePath, content, "utf-8");
    return toResult(
      upsertMirrorRow(input.db, {
        changeId: input.changeId,
        phase: input.mirror.phase,
        artifactType: input.mirror.artifactType,
        path: filePath,
        contentHash: sha256Text(content),
        sourceDbHash: expectedSourceDbHash,
        schemaVersion: input.mirror.schemaVersion,
        mirrorStatus: "ok",
        generatedAt: input.generatedAt,
      }),
    );
  } catch (error) {
    const warning = errorCodeFrom(error);
    const row = upsertMirrorRow(input.db, {
      changeId: input.changeId,
      phase: input.mirror.phase,
      artifactType: input.mirror.artifactType,
      path: filePath,
      contentHash: null,
      sourceDbHash: expectedSourceDbHash,
      schemaVersion: input.mirror.schemaVersion,
      mirrorStatus: "generation_failed",
      generatedAt: input.generatedAt,
    });
    return toResult(row, warning);
  }
}

function repoPathForChange(db: ArtifactMirrorDb, changeId: string): string {
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new Error(`Project not found for change: ${changeId}`);
  return project.repoPath;
}

function mirrorRowsForChange(
  db: ArtifactMirrorDb,
  changeId: string,
  phase?: PipelinePhase,
): ArtifactMirrorRow[] {
  const query = db.select().from(artifactMirrors);
  const rows = phase
    ? query.where(and(eq(artifactMirrors.changeId, changeId), eq(artifactMirrors.phase, phase))).all()
    : query.where(eq(artifactMirrors.changeId, changeId)).all();
  return latestMirrorRows(rows).sort((left, right) => {
    const pathDiff = left.path.localeCompare(right.path);
    if (pathDiff !== 0) return pathDiff;
    return compareMirrorRowsNewestFirst(left, right);
  });
}

function warningFromRow(row: ArtifactMirrorRow, status: ArtifactMirrorStatus, warning: string): ArtifactMirrorWarning {
  return {
    id: row.id,
    changeId: row.changeId,
    phase: row.phase,
    artifactType: row.artifactType,
    path: row.path,
    contentHash: row.contentHash,
    sourceDbHash: row.sourceDbHash,
    schemaVersion: row.schemaVersion,
    mirrorStatus: status,
    warning,
    generatedAt: row.generatedAt,
  };
}

function compareMirrorRowsNewestFirst(left: ArtifactMirrorRow, right: ArtifactMirrorRow): number {
  const generatedDiff = right.generatedAt.localeCompare(left.generatedAt);
  if (generatedDiff !== 0) return generatedDiff;
  return right.id.localeCompare(left.id);
}

function mirrorIdentityKey(row: ArtifactMirrorRow): string {
  return [row.changeId, row.phase, row.artifactType, row.path].join("\0");
}

function latestMirrorRows(rows: ArtifactMirrorRow[]): ArtifactMirrorRow[] {
  const latest = new Map<string, ArtifactMirrorRow>();
  for (const row of [...rows].sort(compareMirrorRowsNewestFirst)) {
    const key = mirrorIdentityKey(row);
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()];
}

function inspectReadableMirrorBoundary(
  row: ArtifactMirrorRow,
  changeDir: string,
): { status: "ok" } | { status: "missing"; warning: string } | { status: "corrupt"; warning: string } {
  if (!isPathInside(row.path, changeDir)) {
    return { status: "corrupt", warning: "path_outside_change" };
  }

  const targetStats = tryLstat(row.path);
  if (!targetStats) return { status: "missing", warning: "file_missing" };
  if (targetStats.isSymbolicLink()) {
    return { status: "corrupt", warning: "path_symlink" };
  }

  const realChangeDir = tryRealPath(changeDir);
  if (!realChangeDir) {
    return { status: "corrupt", warning: "path_outside_change" };
  }

  const realParentDir = tryRealPath(path.dirname(row.path));
  if (!realParentDir || !isPathInside(realParentDir, realChangeDir)) {
    return { status: "corrupt", warning: "path_outside_change" };
  }

  const realTargetPath = tryRealPath(row.path);
  if (!realTargetPath || !isPathInside(realTargetPath, realChangeDir)) {
    return { status: "corrupt", warning: "path_outside_change" };
  }

  return { status: "ok" };
}

function inspectMirrorRow(
  db: ArtifactMirrorDb,
  repoPath: string,
  changeId: string,
  row: ArtifactMirrorRow,
  persistStatus: boolean,
): ArtifactMirrorWarning[] {
  const changeDir = path.resolve(changeArtifactDir(repoPath, changeId));
  const warnings: ArtifactMirrorWarning[] = [];
  let status: ArtifactMirrorStatus = "ok";

  const boundary = inspectReadableMirrorBoundary(row, changeDir);
  if (boundary.status !== "ok") {
    status = boundary.status;
    warnings.push(warningFromRow(row, status, boundary.warning));
  } else {
    let content: string | null = null;
    try {
      content = fs.readFileSync(row.path, "utf-8");
      if (path.extname(row.path) === ".json") JSON.parse(content);
    } catch {
      status = "corrupt";
      warnings.push(warningFromRow(row, status, "file_corrupt"));
    }

    if (content !== null) {
      const actualHash = sha256Text(content);
      if (!row.contentHash) {
        status = "not_indexed";
        warnings.push(warningFromRow(row, status, "content_hash_missing"));
      } else if (actualHash !== row.contentHash) {
        status = "mismatch";
        warnings.push(warningFromRow(row, status, "content_hash_mismatch"));
      }
    }
  }

  if (status === "ok" && (!row.sourceDbHash || !row.schemaVersion)) {
    status = "not_indexed";
    warnings.push(warningFromRow(row, status, "source_metadata_missing"));
  }

  if (persistStatus && row.mirrorStatus !== status) {
    db.update(artifactMirrors)
      .set({ mirrorStatus: status })
      .where(eq(artifactMirrors.id, row.id))
      .run();
  }

  return warnings;
}

export function renderMirrorsFromDb(input: RenderMirrorsInput): ArtifactMirrorResult[] {
  const db = getArtifactMirrorDb(input.db);
  const repoPath = input.repoPath ?? repoPathForChange(db, input.changeId);
  const generatedAt = input.generatedAt ?? nowISO();
  return input.mirrors.map((mirror) =>
    renderOneMirror({ db, repoPath, changeId: input.changeId, mirror, generatedAt }),
  );
}

export function inspectArtifactMirrors(
  changeId: string,
  phase?: PipelinePhase,
  options: { persistStatus?: boolean } = {},
): ArtifactMirrorWarning[] {
  const db = getArtifactMirrorDb();
  const repoPath = repoPathForChange(db, changeId);
  const rows = mirrorRowsForChange(db, changeId, phase);
  if (rows.length === 0 && phase) {
    return [
      {
        id: null,
        changeId,
        phase,
        artifactType: "unknown",
        path: null,
        contentHash: null,
        sourceDbHash: null,
        schemaVersion: null,
        mirrorStatus: "not_indexed",
        warning: "mirror_row_missing",
        generatedAt: null,
      },
    ];
  }
  return rows.flatMap((row) => inspectMirrorRow(
    db,
    repoPath,
    changeId,
    row,
    options.persistStatus ?? true,
  ));
}

export function rebuildArtifactMirror(input: RebuildArtifactMirrorInput): ArtifactMirrorResult {
  const [result] = renderMirrorsFromDb({
    db: input.db,
    repoPath: input.repoPath,
    changeId: input.changeId,
    mirrors: [input.mirror],
    generatedAt: input.generatedAt,
  });
  if (!result) throw new Error(`No artifact mirror rebuilt for ${input.changeId}`);
  return result;
}
