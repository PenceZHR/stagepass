import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { and, desc, eq } from "drizzle-orm";

import { buildRunRecords } from "../db/schema";
import type { BuildRunFile, BuildRunStatus } from "./build-types";

export type BuildRunRecord = typeof buildRunRecords.$inferSelect;
type BuildRunRecordDb = typeof import("../db/index").db;

const requireDefaultDb = createRequire(import.meta.url);
let buildRunRecordDbForTest: BuildRunRecordDb | null = null;
let defaultBuildRunRecordDb: BuildRunRecordDb | null = null;

export interface RecordBuildRunRecordInput {
  changeId: string;
  buildRunId: string;
  status: BuildRunStatus;
  headSha?: string | null;
  baseHeadSha?: string | null;
  baseCommit?: string | null;
  patchHash?: string | null;
  changedFilesHash?: string | null;
  adoptedHeadSha?: string | null;
  adoptionDecisionId?: string | null;
  adoptedAt?: string | null;
  artifactHash?: string | null;
  source?: string;
  runId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type BuildRecordStaleReason = "not_found" | "head_mismatch";

export class BuildRecordStaleError extends Error {
  constructor(
    public readonly reason: BuildRecordStaleReason,
    message: string,
    public readonly record: BuildRunRecord | null = null
  ) {
    super(message);
    this.name = "BuildRecordStaleError";
  }
}

function assertSafeChangeId(changeId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(changeId)) {
    throw new Error(`Invalid changeId for build run records: ${changeId}`);
  }
}

function buildRunsDir(repoPath: string, changeId: string): string {
  assertSafeChangeId(changeId);
  return path.join(repoPath, ".ship", "changes", changeId, "build", "runs");
}

function stableBuildRunRecordId(changeId: string, buildRunId: string): string {
  const digest = createHash("sha256")
    .update(`${changeId}\0${buildRunId}`, "utf-8")
    .digest("hex")
    .slice(0, 24);
  return `BRR-${digest}`;
}

function buildRunIdForFile(run: Pick<BuildRunFile, "runNumber">): string {
  return `build-${run.runNumber}`;
}

export function hashBuildChangedFiles(changedFiles: string[]): string {
  const normalized = Array.from(new Set(changedFiles.map((filePath) => filePath.split(path.sep).join("/")))).sort();
  return createHash("sha256")
    .update(JSON.stringify(normalized), "utf-8")
    .digest("hex");
}

function buildRunNumberFromSelector(selector: string | number): number {
  if (typeof selector === "number") return selector;
  const match = /^build-(\d+)$/.exec(selector) ?? /^(\d+)$/.exec(selector);
  if (!match) {
    throw new Error(`Invalid build run selector: ${selector}`);
  }
  return Number.parseInt(match[1], 10);
}

function readBuildRunFile(
  repoPath: string,
  changeId: string,
  selector?: string | number
): BuildRunFile {
  const runsDir = buildRunsDir(repoPath, changeId);
  if (!fs.existsSync(runsDir)) {
    throw new Error(`No build runs found for change: ${changeId}`);
  }

  const runNumber =
    selector === undefined
      ? fs
          .readdirSync(runsDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => /^build-(\d+)\.json$/.exec(entry.name))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => Number.parseInt(match[1], 10))
          .sort((a, b) => b - a)[0]
      : buildRunNumberFromSelector(selector);

  if (!runNumber) {
    throw new Error(`No build run found for change: ${changeId}`);
  }

  const content = fs.readFileSync(path.join(runsDir, `build-${runNumber}.json`), "utf-8");
  return JSON.parse(content) as BuildRunFile;
}

function recordInputFromBuildRunFile(run: BuildRunFile): RecordBuildRunRecordInput {
  const buildRunId = buildRunIdForFile(run);
  return {
    changeId: run.changeId,
    buildRunId,
    status: run.status,
    headSha: run.adoptedHeadSha ?? null,
    baseHeadSha: run.baseHeadSha ?? run.baseCommit ?? null,
    baseCommit: run.baseCommit ?? null,
    patchHash: run.patchHash ?? run.patchSha256 ?? null,
    changedFilesHash: run.changedFilesHash ?? hashBuildChangedFiles(run.changedFiles),
    adoptedHeadSha: run.adoptedHeadSha ?? null,
    adoptionDecisionId: run.adoptionDecisionId ?? null,
    adoptedAt: run.status === "adopted" ? run.updatedAt : null,
    artifactHash: run.patchSha256 ?? null,
    source: "workspace_file",
    runId: null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function setBuildRunRecordDbForTest(nextDb: BuildRunRecordDb): () => void {
  const previous = buildRunRecordDbForTest;
  buildRunRecordDbForTest = nextDb;
  return () => {
    buildRunRecordDbForTest = previous;
  };
}

function getBuildRunRecordDb(): BuildRunRecordDb {
  if (buildRunRecordDbForTest) {
    return buildRunRecordDbForTest;
  }
  if (!defaultBuildRunRecordDb) {
    defaultBuildRunRecordDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultBuildRunRecordDb;
}

export function recordBuildRunRecord(input: RecordBuildRunRecordInput): BuildRunRecord {
  assertSafeChangeId(input.changeId);
  const now = new Date().toISOString();
  const id = stableBuildRunRecordId(input.changeId, input.buildRunId);
  const db = getBuildRunRecordDb();
  const values = {
    id,
    changeId: input.changeId,
    runId: input.runId ?? null,
    buildRunId: input.buildRunId,
    status: input.status,
    headSha: input.headSha ?? null,
    baseHeadSha: input.baseHeadSha ?? null,
    baseCommit: input.baseCommit ?? null,
    patchHash: input.patchHash ?? null,
    changedFilesHash: input.changedFilesHash ?? null,
    adoptedHeadSha: input.adoptedHeadSha ?? null,
    adoptionDecisionId: input.adoptionDecisionId ?? null,
    adoptedAt: input.adoptedAt ?? null,
    artifactHash: input.artifactHash ?? null,
    source: input.source ?? "unknown",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };

  db.insert(buildRunRecords)
    .values(values)
    .onConflictDoUpdate({
      target: buildRunRecords.id,
      set: {
        runId: values.runId,
        buildRunId: values.buildRunId,
        status: values.status,
        headSha: values.headSha,
        baseHeadSha: values.baseHeadSha,
        baseCommit: values.baseCommit,
        patchHash: values.patchHash,
        changedFilesHash: values.changedFilesHash,
        adoptedHeadSha: values.adoptedHeadSha,
        adoptionDecisionId: values.adoptionDecisionId,
        adoptedAt: values.adoptedAt,
        artifactHash: values.artifactHash,
        source: values.source,
        updatedAt: values.updatedAt,
      },
    })
    .run();

  const record = db
    .select()
    .from(buildRunRecords)
    .where(eq(buildRunRecords.id, id))
    .get();
  if (!record) {
    throw new Error(`Failed to record build run: ${input.changeId}/${input.buildRunId}`);
  }
  return record;
}

export function recordBuildRunFromWorkspaceFile(
  repoPath: string,
  changeId: string,
  buildRunIdOrRun?: string | number | BuildRunFile
): BuildRunRecord {
  let run: BuildRunFile;
  if (typeof buildRunIdOrRun === "object" && buildRunIdOrRun !== null) {
    run = buildRunIdOrRun;
  } else {
    const selector = typeof buildRunIdOrRun === "string" || typeof buildRunIdOrRun === "number"
      ? buildRunIdOrRun
      : undefined;
    run = readBuildRunFile(repoPath, changeId, selector);
  }
  if (run.changeId !== changeId) {
    throw new Error(
      `Build run changeId mismatch: expected ${changeId}, got ${run.changeId}`
    );
  }
  return recordBuildRunRecord(recordInputFromBuildRunFile(run));
}

export function getBuildRunRecord(changeId: string, buildRunId: string): BuildRunRecord | null {
  assertSafeChangeId(changeId);
  const id = stableBuildRunRecordId(changeId, buildRunId);
  return (
    getBuildRunRecordDb()
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.id, id))
      .get() ?? null
  );
}

export function getLatestAdoptedBuildRecord(changeId: string): BuildRunRecord | null {
  assertSafeChangeId(changeId);
  return (
    getBuildRunRecordDb()
      .select()
      .from(buildRunRecords)
      .where(and(eq(buildRunRecords.changeId, changeId), eq(buildRunRecords.status, "adopted")))
      .orderBy(
        desc(buildRunRecords.adoptedAt),
        desc(buildRunRecords.updatedAt),
        desc(buildRunRecords.id)
      )
      .limit(1)
      .get() ?? null
  );
}

export function assertBuildRecordFresh(
  changeId: string,
  expectedHeadSha?: string
): BuildRunRecord {
  const record = getLatestAdoptedBuildRecord(changeId);
  if (!record) {
    throw new BuildRecordStaleError(
      "not_found",
      `Latest adopted build record not found for change ${changeId}`,
      null
    );
  }
  if (expectedHeadSha && record.headSha !== expectedHeadSha) {
    throw new BuildRecordStaleError(
      "head_mismatch",
      `Latest adopted build record is stale: expected HEAD ${expectedHeadSha}, got ${record.headSha ?? "none"}`,
      record
    );
  }
  return record;
}
