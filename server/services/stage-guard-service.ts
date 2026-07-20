import crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

import { db } from "../db";
import { planSnapshots, requiredValidationCommands } from "../db/schema";
import type { RunPhase } from "../types/enums";

type StageGuardDb = typeof db;
let stageGuardDbForTest: StageGuardDb | null = null;

export function setStageGuardServiceDbForTest(nextDb: StageGuardDb): () => void {
  const previous = stageGuardDbForTest;
  stageGuardDbForTest = nextDb;
  return () => {
    stageGuardDbForTest = previous;
  };
}

function getStageGuardDb(): StageGuardDb {
  return stageGuardDbForTest ?? db;
}

export type StageName = RunPhase;

export type WorkspaceMutationKind = "created" | "modified" | "deleted";

export interface WorkspaceFileSnapshot {
  hash: string;
  size: number;
}

export interface WorkspaceSnapshot {
  repoPath: string;
  files: Record<string, WorkspaceFileSnapshot>;
}

export interface WorkspaceMutation {
  kind: WorkspaceMutationKind;
  path: string;
}

export interface PlanScope {
  expectedFiles?: string[];
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  validationCommands?: string[];
  sourceDbHash?: string | null;
  sourceSnapshotId?: string | null;
}

export interface PolicyScope {
  blockedFiles: string[];
  blockedGlobs: string[];
}

export interface FindingScope {
  status?: string;
  file?: string | null;
}

export interface StageScope {
  phase: RunPhase;
  readableFiles: string[];
  writableFiles: string[];
  plannedChanges?: string[];
}

export interface StageViolationResult {
  blocked: boolean;
  stage: StageName;
  files: string[];
  message: string;
}

const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

export const DEFAULT_BLOCKED_PATTERNS = [
  ".github/workflows/**",
  "infra/**",
  "deploy/**",
  "package.json",
  ".env*",
];

export const SHIP_EXEMPT_PATTERNS = [".ship/**"];

export const DEFAULT_STAGE_SCOPES: Record<RunPhase, Omit<StageScope, "phase">> = {
  refine: {
    readableFiles: [".ship/**"],
    writableFiles: [".ship/changes/**"],
  },
  generate_plan: {
    readableFiles: [".ship/**"],
    writableFiles: [".ship/changes/**"],
  },
  implement: {
    readableFiles: ["**"],
    writableFiles: [],
  },
  review: {
    readableFiles: ["**"],
    writableFiles: [".ship/changes/**"],
  },
  local_check: {
    readableFiles: ["**"],
    writableFiles: [".ship/changes/**"],
  },
  fix_findings: {
    readableFiles: ["**"],
    writableFiles: [],
  },
  intake: {
    readableFiles: [".ship/changes/**"],
    writableFiles: [".ship/changes/**"],
  },
  spec: {
    readableFiles: [
      ".ship/changes/**/change-request.md",
      ".ship/changes/**/prd-intent.md",
      ".ship/changes/**/briefing-questions.json",
      ".ship/changes/**/prd-draft.md",
      ".ship/changes/**/prd-gate.json",
      ".ship/changes/**/prd-delta.md",
      ".ship/changes/**/requirement-gaps.json",
      ".ship/changes/**/red-fix-claims.json",
      ".ship/changes/**/blue-gap-reviews.json",
      ".ship/changes/**/reports/spec-report.md",
      ".ship/baseline/prd.md",
    ],
    writableFiles: [".ship/changes/**/prd-delta.md", ".ship/changes/**/*-scope.json"],
  },
  tech_spec: {
    readableFiles: [
      ".ship/changes/**/prd-delta.md",
      ".ship/baseline/prd.md",
      ".ship/baseline/tech-spec.md",
      ".ship/baseline/api-spec.md",
      ".ship/baseline/data-model.md",
      ".ship/baseline/state-machine.md",
    ],
    writableFiles: [
      ".ship/changes/**/tech-spec-delta.md",
      ".ship/changes/**/api-spec-delta.md",
      ".ship/changes/**/*-scope.json",
    ],
  },
  test_plan: {
    readableFiles: [
      ".ship/changes/**/prd-delta.md",
      ".ship/changes/**/tech-spec-delta.md",
      ".ship/baseline/test-plan.md",
    ],
    writableFiles: [".ship/changes/**/test-plan-delta.md", ".ship/changes/**/*-scope.json"],
  },
  release: {
    readableFiles: [".ship/changes/**", ".ship/baseline/**"],
    writableFiles: [".ship/changes/**/release-note.md", ".ship/baseline/**"],
  },
  retro: {
    readableFiles: [".ship/changes/**"],
    writableFiles: [".ship/changes/**/retro.md", ".ship/baseline/backlog.md"],
  },
};

interface PolicyJson {
  blockedFiles?: string[];
  blockedGlobs?: string[];
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function hashFile(filePath: string): WorkspaceFileSnapshot {
  const content = fs.readFileSync(filePath);
  return {
    hash: crypto.createHash("sha256").update(content).digest("hex"),
    size: content.length,
  };
}

function walkFiles(root: string, dir: string, files: Record<string, WorkspaceFileSnapshot>) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, fullPath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (/\.(db|db-shm|db-wal|db-journal)$/.test(entry.name)) {
      continue;
    }

    if (entry.name === "next-env.d.ts") {
      continue;
    }

    const relativePath = normalizePath(path.relative(root, fullPath));
    files[relativePath] = hashFile(fullPath);
  }
}

function walkReadableFiles(root: string, dir: string, files: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) && entry.name !== ".ship") {
        continue;
      }
      walkReadableFiles(root, fullPath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (/\.(db|db-shm|db-wal|db-journal)$/.test(entry.name)) {
      continue;
    }

    if (entry.name === "next-env.d.ts") {
      continue;
    }

    files.push(normalizePath(path.relative(root, fullPath)));
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = "";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(file: string, pattern: string): boolean {
  const normalizedFile = normalizePath(file);
  const normalizedPattern = normalizePath(pattern);

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }

  if (!normalizedPattern.includes("*")) {
    return normalizedFile === normalizedPattern;
  }

  return globToRegex(normalizedPattern).test(normalizedFile);
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(file, pattern));
}

function filterIgnoredMutations(
  mutations: WorkspaceMutation[],
  ignoredPatterns: string[]
): WorkspaceMutation[] {
  return mutations.filter((mutation) => !matchesAny(mutation.path, ignoredPatterns));
}

function stageViolation(
  stage: StageName,
  files: string[],
  messagePrefix: string
): StageViolationResult {
  const uniqueFiles = unique(files).sort();
  if (uniqueFiles.length === 0) {
    return {
      blocked: false,
      stage,
      files: [],
      message: "",
    };
  }

  return {
    blocked: true,
    stage,
    files: uniqueFiles,
    message: `${messagePrefix}: ${uniqueFiles.join(", ")}`,
  };
}

export function captureWorkspaceSnapshot(repoPath: string): WorkspaceSnapshot {
  const files: Record<string, WorkspaceFileSnapshot> = {};
  if (!fs.existsSync(repoPath)) {
    return { repoPath, files };
  }

  walkFiles(repoPath, repoPath, files);
  return { repoPath, files };
}

export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  ignoredPatterns: string[] = []
): WorkspaceMutation[] {
  const mutations: WorkspaceMutation[] = [];
  const paths = unique([...Object.keys(before.files), ...Object.keys(after.files)]);

  for (const filePath of paths) {
    const beforeFile = before.files[filePath];
    const afterFile = after.files[filePath];

    if (!beforeFile && afterFile) {
      mutations.push({ kind: "created", path: filePath });
    } else if (beforeFile && !afterFile) {
      mutations.push({ kind: "deleted", path: filePath });
    } else if (
      beforeFile &&
      afterFile &&
      (beforeFile.hash !== afterFile.hash || beforeFile.size !== afterFile.size)
    ) {
      mutations.push({ kind: "modified", path: filePath });
    }
  }

  return filterIgnoredMutations(mutations, ignoredPatterns);
}

export function loadPolicy(repoPath: string): PolicyScope {
  const policyPath = path.join(repoPath, ".ship", "policy.json");
  let policy: PolicyJson = {};
  if (fs.existsSync(policyPath)) {
    policy = JSON.parse(fs.readFileSync(policyPath, "utf-8")) as PolicyJson;
  }

  return {
    blockedFiles: unique(policy.blockedFiles ?? []),
    blockedGlobs: unique([
      ...DEFAULT_BLOCKED_PATTERNS,
      ...(policy.blockedGlobs ?? []),
      ...(policy.blockedFiles ?? []),
    ]),
  };
}

export function loadPlan(repoPath: string, changeId: string): PlanScope {
  const planPath = path.join(repoPath, ".ship", "changes", changeId, "plan.json");
  if (!fs.existsSync(planPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(planPath, "utf-8")) as PlanScope;
}

function readStringArrayJson(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function loadDbPlanScope(changeId: string): PlanScope {
  const db = getStageGuardDb();
  const snapshot =
    db
      .select()
      .from(planSnapshots)
      .where(and(eq(planSnapshots.changeId, changeId), eq(planSnapshots.status, "approved")))
      .orderBy(desc(planSnapshots.approvedAt), desc(planSnapshots.createdAt), desc(planSnapshots.id))
      .get() ??
    db
      .select()
      .from(planSnapshots)
      .where(and(eq(planSnapshots.changeId, changeId), eq(planSnapshots.status, "ready")))
      .orderBy(desc(planSnapshots.createdAt), desc(planSnapshots.id))
      .get();

  if (!snapshot) {
    return {};
  }

  const validationCommands = db
    .select()
    .from(requiredValidationCommands)
    .where(
      and(
        eq(requiredValidationCommands.changeId, changeId),
        eq(requiredValidationCommands.phase, "Plan"),
        eq(requiredValidationCommands.sourceSnapshotId, snapshot.id)
      )
    )
    .orderBy(requiredValidationCommands.commandOrder)
    .all()
    .map((row) => row.command);

  return {
    expectedFiles: readStringArrayJson(snapshot.expectedFilesJson),
    forbiddenFiles: readStringArrayJson(snapshot.forbiddenFilesJson),
    validationCommands,
    sourceDbHash: snapshot.snapshotDbHash,
    sourceSnapshotId: snapshot.id,
  };
}

export function resolveReadableFiles(repoPath: string, scope: StageScope): string[] {
  if (!fs.existsSync(repoPath)) {
    return [];
  }

  const files: string[] = [];
  walkReadableFiles(repoPath, repoPath, files);
  return unique(files.filter((filePath) => matchesAny(filePath, scope.readableFiles))).sort();
}

export function validatePlannedChanges(
  mutations: WorkspaceMutation[],
  scope: StageScope
): StageViolationResult {
  const allowedPatterns = unique([...(scope.plannedChanges ?? []), ...scope.writableFiles]);
  const scopedMutations = filterIgnoredMutations(mutations, SHIP_EXEMPT_PATTERNS);
  const violatingFiles = scopedMutations
    .map((mutation) => mutation.path)
    .filter((filePath) => allowedPatterns.length === 0 || !matchesAny(filePath, allowedPatterns));

  return stageViolation(
    scope.phase,
    violatingFiles,
    `${scope.phase} stage modified files outside declared plannedChanges`
  );
}

export function validateReadOnlyStage(
  stage: Extract<StageName, "refine" | "generate_plan">,
  mutations: WorkspaceMutation[],
  ignoredPatterns: string[] = []
): StageViolationResult {
  const unexpected = filterIgnoredMutations(mutations, [
    ...SHIP_EXEMPT_PATTERNS,
    ...ignoredPatterns,
  ]);
  return stageViolation(
    stage,
    unexpected.map((mutation) => mutation.path),
    `${stage} stage is read-only but modified files`
  );
}

export function validateImplementScope(
  mutations: WorkspaceMutation[],
  plan: PlanScope,
  policy: PolicyScope
): StageViolationResult {
  const allowedFiles = plan.expectedFiles ?? plan.allowedFiles ?? [];
  const forbiddenPatterns = [...(plan.forbiddenFiles ?? []), ...policy.blockedGlobs];
  const scopedMutations = filterIgnoredMutations(mutations, SHIP_EXEMPT_PATTERNS);
  const violatingFiles = scopedMutations
    .map((mutation) => mutation.path)
    .filter((filePath) => {
      if (matchesAny(filePath, forbiddenPatterns)) {
        return true;
      }
      return allowedFiles.length === 0 || !matchesAny(filePath, allowedFiles);
    });

  return stageViolation(
    "implement",
    violatingFiles,
    "implement stage modified files outside approved plan scope"
  );
}

export function validateFixScope(
  mutations: WorkspaceMutation[],
  findings: FindingScope[],
  plan: PlanScope,
  policy: PolicyScope
): StageViolationResult {
  const openFindings = findings.filter((finding) => finding.status !== "fixed" && finding.status !== "waived");
  const findingFiles = unique(
    openFindings
      .map((finding) => finding.file)
      .filter((file): file is string => typeof file === "string" && file.length > 0)
  );
  const hasFilelessFinding = openFindings.some((finding) => !finding.file);
  const allowedFiles = hasFilelessFinding
    ? unique([...findingFiles, ...(plan.expectedFiles ?? plan.allowedFiles ?? [])])
    : findingFiles;
  const forbiddenPatterns = [...(plan.forbiddenFiles ?? []), ...policy.blockedGlobs];

  const scopedMutations = filterIgnoredMutations(mutations, SHIP_EXEMPT_PATTERNS);
  const violatingFiles = scopedMutations
    .map((mutation) => mutation.path)
    .filter((filePath) => {
      if (matchesAny(filePath, forbiddenPatterns)) {
        return true;
      }
      return allowedFiles.length === 0 || !matchesAny(filePath, allowedFiles);
    });

  return stageViolation(
    "fix_findings",
    violatingFiles,
    "fix_findings stage modified files outside open findings scope"
  );
}

export function localCheckAllowedPatterns(changeId: string): string[] {
  return [`.ship/changes/${changeId}/**`];
}

export function validateLocalCheckScope(
  changeId: string,
  mutations: WorkspaceMutation[]
): StageViolationResult {
  const unexpected = filterIgnoredMutations(mutations, [
    ...SHIP_EXEMPT_PATTERNS,
    ...localCheckAllowedPatterns(changeId),
  ]);
  return stageViolation(
    "local_check",
    unexpected.map((mutation) => mutation.path),
    "local_check stage modified files outside check report outputs"
  );
}
