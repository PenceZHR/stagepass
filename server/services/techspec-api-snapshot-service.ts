import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { eq } from "drizzle-orm";

import { apiSnapshots, techspecSnapshots } from "../db/schema";
import { parseStructuredOutputText } from "./ai-structured-output-service";

type SnapshotDb = typeof import("../db/index").db;
type TechSpecSnapshotRow = typeof techspecSnapshots.$inferSelect;
type ApiSnapshotRow = typeof apiSnapshots.$inferSelect;

export interface NormalizedDesignSections {
  interfaces: unknown[];
  dataContracts: unknown[];
  migrationNotes: unknown[];
  buildInputs: unknown[];
  reviewInputs: unknown[];
  rawText?: string;
}

export interface CreateTechSpecSnapshotInput {
  changeId: string;
  status: string;
  sourceSpecHash?: string | null;
  content: unknown;
  schemaVersion?: string;
  reviewedAt?: string | null;
  createdAt?: string;
}

export interface CreateApiSnapshotInput {
  changeId: string;
  status: string;
  sourceTechspecHash?: string | null;
  contract: unknown;
  schemaVersion?: string;
  reviewedAt?: string | null;
  createdAt?: string;
}

export interface CreateTechSpecAndApiSnapshotsInput {
  changeId: string;
  status: string;
  sourceSpecHash?: string | null;
  techSpecContent: unknown;
  apiContract: unknown;
  techSpecSchemaVersion?: string;
  apiSchemaVersion?: string;
  reviewedAt?: string | null;
  createdAt?: string;
}

export interface TechSpecSnapshot {
  id: string;
  changeId: string;
  status: string;
  sourceSpecHash: string | null;
  content: NormalizedDesignSections;
  contentDbHash: string;
  schemaVersion: string;
  reviewedAt: string | null;
  createdAt: string;
}

export interface ApiSnapshot {
  id: string;
  changeId: string;
  status: string;
  sourceTechspecHash: string | null;
  contract: NormalizedDesignSections;
  contractDbHash: string;
  schemaVersion: string;
  reviewedAt: string | null;
  createdAt: string;
}

export class MissingDesignSnapshotError extends Error {
  readonly reasonCode = "missing_design_snapshot";

  constructor(changeId: string, missing: "techspec" | "api" | "both") {
    super(`missing_design_snapshot: ${changeId} is missing ${missing} DB snapshot`);
    this.name = "MissingDesignSnapshotError";
  }
}

export class DesignSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignSnapshotValidationError";
  }
}

type RequiredDesignSection =
  | "interfaces"
  | "dataContracts"
  | "migrationNotes"
  | "buildInputs"
  | "reviewInputs";

const requireDefaultDb = createRequire(import.meta.url);
let snapshotDbForTest: SnapshotDb | null = null;
let defaultSnapshotDb: SnapshotDb | null = null;

export function setTechSpecApiSnapshotServiceDbForTest(nextDb: SnapshotDb): () => void {
  const previous = snapshotDbForTest;
  snapshotDbForTest = nextDb;
  return () => {
    snapshotDbForTest = previous;
  };
}

function getSnapshotDb(): SnapshotDb {
  if (snapshotDbForTest) return snapshotDbForTest;
  if (!defaultSnapshotDb) {
    defaultSnapshotDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultSnapshotDb;
}

function nowISO(): string {
  return new Date().toISOString();
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

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function stablePrettyJson(value: unknown): string {
  return `${JSON.stringify(sortForStableJson(value), null, 2)}\n`;
}

export function hashCanonicalDesignValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function computeTechSpecContentDbHash(input: {
  changeId: string;
  schemaVersion: string;
  content: unknown;
}): string {
  return hashCanonicalDesignValue({
    changeId: input.changeId,
    schemaVersion: input.schemaVersion,
    content: normalizeDesignSections(input.content),
  });
}

export function computeApiContractDbHash(input: {
  changeId: string;
  schemaVersion: string;
  contract: unknown;
}): string {
  return hashCanonicalDesignValue({
    changeId: input.changeId,
    schemaVersion: input.schemaVersion,
    contract: normalizeDesignSections(input.contract),
  });
}

function parseCandidate(candidate: unknown): unknown {
  if (typeof candidate !== "string") return candidate;
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new DesignSnapshotValidationError("Design snapshot candidate must be a non-empty object");
  }
  if (!trimmed.startsWith("{")) {
    const recovered = parseStructuredOutputText(trimmed).value;
    if (recovered === undefined) {
      throw new DesignSnapshotValidationError("Design snapshot candidate must be a JSON object");
    }
    return recovered;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new DesignSnapshotValidationError("Design snapshot candidate must be valid JSON");
  }
}

function requireArraySection(
  record: Record<string, unknown>,
  section: RequiredDesignSection,
): unknown[] {
  if (!Object.prototype.hasOwnProperty.call(record, section)) {
    throw new DesignSnapshotValidationError(`Design snapshot missing section: ${section}`);
  }
  const value = record[section];
  if (!Array.isArray(value)) {
    throw new DesignSnapshotValidationError(`Design snapshot section must be an array: ${section}`);
  }
  return value;
}

export function normalizeDesignSections(candidate: unknown): NormalizedDesignSections {
  const parsed = parseCandidate(candidate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DesignSnapshotValidationError("Design snapshot candidate must be an object");
  }
  const record = parsed as Record<string, unknown>;
  return {
    interfaces: requireArraySection(record, "interfaces"),
    dataContracts: requireArraySection(record, "dataContracts"),
    migrationNotes: requireArraySection(record, "migrationNotes"),
    buildInputs: requireArraySection(record, "buildInputs"),
    reviewInputs: requireArraySection(record, "reviewInputs"),
  };
}

function nextSnapshotId(prefix: "TECHSPEC" | "API"): string {
  return `${prefix}-${randomUUID()}`;
}

function buildTechSpecSnapshotRow(input: CreateTechSpecSnapshotInput) {
  const content = normalizeDesignSections(input.content);
  const contentDbHash = computeTechSpecContentDbHash({
    changeId: input.changeId,
    schemaVersion: input.schemaVersion ?? "techspec/v1",
    content,
  });
  return {
    id: nextSnapshotId("TECHSPEC"),
    changeId: input.changeId,
    status: input.status,
    sourceSpecHash: input.sourceSpecHash ?? null,
    contentJson: stablePrettyJson(content),
    contentDbHash,
    schemaVersion: input.schemaVersion ?? "techspec/v1",
    reviewedAt: input.reviewedAt ?? null,
    createdAt: input.createdAt ?? nowISO(),
  };
}

function buildApiSnapshotRow(input: CreateApiSnapshotInput) {
  const contract = normalizeDesignSections(input.contract);
  const contractDbHash = computeApiContractDbHash({
    changeId: input.changeId,
    schemaVersion: input.schemaVersion ?? "api/v1",
    contract,
  });
  return {
    id: nextSnapshotId("API"),
    changeId: input.changeId,
    status: input.status,
    sourceTechspecHash: input.sourceTechspecHash ?? null,
    contractJson: stablePrettyJson(contract),
    contractDbHash,
    schemaVersion: input.schemaVersion ?? "api/v1",
    reviewedAt: input.reviewedAt ?? null,
    createdAt: input.createdAt ?? nowISO(),
  };
}

function techSpecFromRow(row: TechSpecSnapshotRow): TechSpecSnapshot {
  if (!row.contentJson) {
    throw new Error(`TechSpec snapshot content_json missing: ${row.id}`);
  }
  return {
    id: row.id,
    changeId: row.changeId,
    status: row.status,
    sourceSpecHash: row.sourceSpecHash,
    content: normalizeDesignSections(JSON.parse(row.contentJson)),
    contentDbHash: row.contentDbHash ?? "",
    schemaVersion: row.schemaVersion,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}

function apiFromRow(row: ApiSnapshotRow): ApiSnapshot {
  if (!row.contractJson) {
    throw new Error(`API snapshot contract_json missing: ${row.id}`);
  }
  return {
    id: row.id,
    changeId: row.changeId,
    status: row.status,
    sourceTechspecHash: row.sourceTechspecHash,
    contract: normalizeDesignSections(JSON.parse(row.contractJson)),
    contractDbHash: row.contractDbHash ?? "",
    schemaVersion: row.schemaVersion,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}

function latestByCreatedAt<T extends { createdAt: string; id: string }>(rows: T[]): T | null {
  return [...rows].sort((left, right) => {
    const createdDiff = right.createdAt.localeCompare(left.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

const AUTHORITATIVE_SNAPSHOT_STATUSES = new Set(["approved", "pass", "passed"]);

function authoritativeRows<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((row) => AUTHORITATIVE_SNAPSHOT_STATUSES.has(row.status));
}

export function createTechSpecSnapshot(input: CreateTechSpecSnapshotInput): TechSpecSnapshot {
  const db = getSnapshotDb();
  const row = buildTechSpecSnapshotRow(input);
  db.insert(techspecSnapshots).values(row).run();
  return techSpecFromRow(row);
}

export function createApiSnapshot(input: CreateApiSnapshotInput): ApiSnapshot {
  const db = getSnapshotDb();
  const row = buildApiSnapshotRow(input);
  db.insert(apiSnapshots).values(row).run();
  return apiFromRow(row);
}

export function createTechSpecAndApiSnapshots(input: CreateTechSpecAndApiSnapshotsInput): {
  techSpec: TechSpecSnapshot;
  api: ApiSnapshot;
} {
  const db = getSnapshotDb();
  const createdAt = input.createdAt ?? nowISO();
  const techSpecRow = buildTechSpecSnapshotRow({
    changeId: input.changeId,
    status: input.status,
    sourceSpecHash: input.sourceSpecHash ?? null,
    content: input.techSpecContent,
    schemaVersion: input.techSpecSchemaVersion ?? "techspec/v1",
    reviewedAt: input.reviewedAt ?? null,
    createdAt,
  });
  const apiRow = buildApiSnapshotRow({
    changeId: input.changeId,
    status: input.status,
    sourceTechspecHash: techSpecRow.contentDbHash,
    contract: input.apiContract,
    schemaVersion: input.apiSchemaVersion ?? "api/v1",
    reviewedAt: input.reviewedAt ?? null,
    createdAt,
  });
  db.transaction((tx) => {
    tx.insert(techspecSnapshots).values(techSpecRow).run();
    tx.insert(apiSnapshots).values(apiRow).run();
  });
  return {
    techSpec: techSpecFromRow(techSpecRow),
    api: apiFromRow(apiRow),
  };
}

export function getLatestTechSpecSnapshot(changeId: string): TechSpecSnapshot | null {
  const db = getSnapshotDb();
  const row = latestByCreatedAt(
    authoritativeRows(
      db.select().from(techspecSnapshots).where(eq(techspecSnapshots.changeId, changeId)).all(),
    ),
  );
  return row ? techSpecFromRow(row) : null;
}

export function getLatestApiSnapshot(changeId: string): ApiSnapshot | null {
  const db = getSnapshotDb();
  const row = latestByCreatedAt(
    authoritativeRows(
      db.select().from(apiSnapshots).where(eq(apiSnapshots.changeId, changeId)).all(),
    ),
  );
  return row ? apiFromRow(row) : null;
}

function requireDesignSnapshots(changeId: string): { techSpec: TechSpecSnapshot; api: ApiSnapshot } {
  const techSpec = getLatestTechSpecSnapshot(changeId);
  const api = getLatestApiSnapshot(changeId);
  if (!techSpec && !api) throw new MissingDesignSnapshotError(changeId, "both");
  if (!techSpec) throw new MissingDesignSnapshotError(changeId, "techspec");
  if (!api) throw new MissingDesignSnapshotError(changeId, "api");
  return { techSpec, api };
}

export function getBuildDesignInputs(changeId: string): { techSpec: TechSpecSnapshot; api: ApiSnapshot } {
  return requireDesignSnapshots(changeId);
}

export function getReviewDesignInputs(changeId: string): { techSpec: TechSpecSnapshot; api: ApiSnapshot } {
  return requireDesignSnapshots(changeId);
}
