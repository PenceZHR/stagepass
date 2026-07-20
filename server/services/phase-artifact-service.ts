import fs from "fs";
import path from "path";
import type { ReviewPhase } from "./change-phase-service";

interface PhaseArtifactDefinitionShape {
  phase: ReviewPhase;
  type: string;
  fileName: string;
  label: string;
  editable?: boolean;
}

export const PHASE_ARTIFACT_DEFINITIONS = [
  { phase: "Refine", type: "spec", fileName: "spec.md", label: "需求澄清说明" },
  { phase: "Intake", type: "change_request", fileName: "change-request.md", label: "需求入口 / 变更请求" },
  { phase: "Intake", type: "prd_intent", fileName: "prd-intent.md", label: "PRD 需求意图" },
  { phase: "Intake", type: "briefing_questions", fileName: "briefing-questions.json", label: "PRD 澄清问题" },
  { phase: "Intake", type: "prd_draft", fileName: "prd-draft.md", label: "PRD 草稿" },
  { phase: "Intake", type: "prd_gate", fileName: "prd-gate.json", label: "PRD 锁定门禁" },
  { phase: "Spec", type: "prd_delta", fileName: "prd-delta.md", label: "产品需求变更" },
  { phase: "Spec", type: "spec_report", fileName: "reports/spec-report.md", label: "Spec 对抗战报" },
  { phase: "Spec", type: "war_report", fileName: "reports/war-report.md", label: "变更总战报" },
  { phase: "TechSpec", type: "tech_spec_delta", fileName: "tech-spec-delta.md", label: "技术方案变更" },
  { phase: "TechSpec", type: "api_spec_delta", fileName: "api-spec-delta.md", label: "接口契约变更" },
  { phase: "TestPlan", type: "test_plan_delta", fileName: "test-plan-delta.md", label: "测试计划变更" },
  { phase: "Plan", type: "plan_md", fileName: "plan.md", label: "实施计划说明" },
  { phase: "Plan", type: "plan_json", fileName: "plan.json", label: "实施范围与验证命令" },
  { phase: "Plan", type: "plan_critique", fileName: "plan-critique.json", label: "反方计划审查", editable: false },
  { phase: "Plan", type: "plan_report", fileName: "reports/plan-report.md", label: "Plan 作战沙盘报告", editable: false },
  { phase: "Build", type: "implement_summary", fileName: "implement-summary.md", label: "实现摘要" },
  { phase: "Build", type: "changed_files", fileName: "changed-files.json", label: "修改文件清单" },
  { phase: "Implement", type: "implement_summary", fileName: "implement-summary.md", label: "实现摘要" },
  { phase: "Implement", type: "changed_files", fileName: "changed-files.json", label: "修改文件清单" },
  { phase: "Review", type: "review_report", fileName: "review-report.md", label: "Review 审计战报", editable: false },
  { phase: "Review", type: "review_findings", fileName: "review-findings.json", label: "Review 审计发现", editable: false },
  { phase: "Check", type: "local_check", fileName: "local-check.json", label: "本地检查结果" },
  { phase: "Check", type: "scope_check", fileName: "scope-check.json", label: "范围检查结果", editable: false },
  { phase: "Check", type: "findings", fileName: "findings.json", label: "检查发现问题" },
  { phase: "Check", type: "semgrep", fileName: "semgrep-local.json", label: "静态扫描结果" },
  { phase: "Fix", type: "changed_files", fileName: "changed-files.json", label: "修复变更文件" },
  { phase: "Merge", type: "release_note", fileName: "release-note.md", label: "发布与交付说明" },
  { phase: "Retro", type: "retro", fileName: "retro.md", label: "复盘与债务回流" },
] as const satisfies readonly PhaseArtifactDefinitionShape[];

export type PhaseArtifactDefinition = (typeof PHASE_ARTIFACT_DEFINITIONS)[number];

export interface PhaseArtifactMirrorMetadataInput {
  id: string;
  changeId: string;
  phase: string;
  artifactType: string;
  path: string;
  contentHash: string | null;
  sourceDbHash: string | null;
  schemaVersion: string | null;
  mirrorStatus: string;
  generatedAt: string | null;
}

export interface PhaseArtifactMirrorDisplayMetadata {
  id: string;
  changeId: string;
  phase: string;
  artifactType: string;
  path: string;
  fileName: string;
  impactLabel: string;
  contentHash: string | null;
  sourceDbHash: string | null;
  schemaVersion: string | null;
  mirrorStatus: string;
  warnings: string[];
  generatedAt: string | null;
  rebuildActionMetadata: {
    changeId: string;
    phase: string;
    artifactType: string;
    path: string;
    sourceDbHash: string | null;
    schemaVersion: string | null;
  };
}

const RUNNING_CHANGE_STATUSES = new Set([
  "REFINING",
  "INTAKE_PENDING",
  "PLANNING",
  "IMPLEMENTING",
  "REVIEWING",
  "CHECKING",
  "FIXING",
  "SPECCING",
  "TECHSPECCING",
  "TESTPLANNING",
  "MERGING",
  "RETRO_PENDING",
]);

const EDITABLE_FILE_NAMES: ReadonlySet<string> = new Set(
  PHASE_ARTIFACT_DEFINITIONS.filter((definition) => isEditableDefinition(definition)).map(
    (definition) => definition.fileName
  )
);

export function changeArtifactDir(repoPath: string, changeId: string): string {
  return path.join(repoPath, ".ship", "changes", changeId);
}

export function getDefinitionForFileName(
  fileName: string
): PhaseArtifactDefinition | undefined {
  return PHASE_ARTIFACT_DEFINITIONS.find((definition) => definition.fileName === fileName);
}

export function getDefinitionForType(type: string): PhaseArtifactDefinition | undefined {
  return PHASE_ARTIFACT_DEFINITIONS.find((definition) => definition.type === type);
}

export function getDefinitionsForPhase(phase: ReviewPhase): PhaseArtifactDefinition[] {
  return PHASE_ARTIFACT_DEFINITIONS.filter((definition) => definition.phase === phase);
}

export function isEditablePhaseArtifactFileName(fileName: string): boolean {
  return EDITABLE_FILE_NAMES.has(fileName);
}

export function toPhaseArtifactMirrorDisplayMetadata(
  mirror: PhaseArtifactMirrorMetadataInput
): PhaseArtifactMirrorDisplayMetadata {
  const fileName = mirrorPathFileName(mirror.path);
  const definition = getDefinitionForFileName(fileName) ?? getDefinitionForType(mirror.artifactType);
  return {
    id: mirror.id,
    changeId: mirror.changeId,
    phase: mirror.phase,
    artifactType: mirror.artifactType,
    path: mirror.path,
    fileName: definition?.fileName ?? fileName,
    impactLabel: definition?.label ?? mirror.artifactType,
    contentHash: mirror.contentHash,
    sourceDbHash: mirror.sourceDbHash,
    schemaVersion: mirror.schemaVersion,
    mirrorStatus: mirror.mirrorStatus,
    warnings: mirrorWarnings(mirror),
    generatedAt: mirror.generatedAt,
    rebuildActionMetadata: {
      changeId: mirror.changeId,
      phase: mirror.phase,
      artifactType: mirror.artifactType,
      path: mirror.path,
      sourceDbHash: mirror.sourceDbHash,
      schemaVersion: mirror.schemaVersion,
    },
  };
}

export function canEditPhaseArtifacts({
  status,
  latestRunStatus,
}: {
  status: string | null | undefined;
  latestRunStatus?: string | null;
}): boolean {
  if (latestRunStatus === "running") return false;
  return !status || !RUNNING_CHANGE_STATUSES.has(status);
}

export function resolveEditablePhaseArtifactPath(
  repoPath: string,
  changeId: string,
  artifactPath: string
): string {
  const repoRoot = path.resolve(repoPath);
  const resolvedArtifactPath = path.isAbsolute(artifactPath)
    ? path.resolve(artifactPath)
    : path.resolve(repoRoot, artifactPath);

  if (!isPathInside(resolvedArtifactPath, repoRoot)) {
    throw new Error(`Artifact path is outside the repository: ${artifactPath}`);
  }

  const expectedChangeDir = path.resolve(changeArtifactDir(repoRoot, changeId));
  if (!isPathInside(resolvedArtifactPath, expectedChangeDir)) {
    throw new Error(`Artifact path is outside this change: ${artifactPath}`);
  }

  const relativeToChange = path.relative(expectedChangeDir, resolvedArtifactPath);
  if (relativeToChange === "runs" || relativeToChange.startsWith(`runs${path.sep}`)) {
    throw new Error(`Artifact path is inside the runs directory: ${artifactPath}`);
  }
  if (!relativeToChange || relativeToChange.includes(path.sep)) {
    throw new Error(`Artifact path must be a root artifact inside this change: ${artifactPath}`);
  }
  if (!isEditablePhaseArtifactFileName(relativeToChange)) {
    throw new Error(`File is not an editable phase artifact: ${relativeToChange}`);
  }

  assertSafeRealPathBoundaries({
    repoRoot,
    expectedChangeDir,
    resolvedArtifactPath,
    artifactPath,
  });

  return resolvedArtifactPath;
}

export function savePhaseArtifactContent({
  repoPath,
  changeId,
  artifactPath,
  content,
}: {
  repoPath: string;
  changeId: string;
  artifactPath: string;
  content: string;
}): { path: string; content: string } {
  const resolvedPath = resolveEditablePhaseArtifactPath(repoPath, changeId, artifactPath);

  if (path.extname(resolvedPath) === ".json") {
    try {
      JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON: ${message}`);
    }
  }

  fs.writeFileSync(resolvedPath, content, "utf-8");
  return { path: resolvedPath, content };
}

function isPathInside(filePath: string, root: string): boolean {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolvedFilePath === resolvedRoot || resolvedFilePath.startsWith(resolvedRoot + path.sep);
}

function hasPathSeparator(fileName: string): boolean {
  return fileName.includes("/") || fileName.includes(path.sep);
}

function isEditableDefinition(definition: PhaseArtifactDefinitionShape): boolean {
  return definition.editable !== false && !hasPathSeparator(definition.fileName);
}

function mirrorPathFileName(filePath: string): string {
  const normalized = filePath.split(path.sep).join("/");
  const changesMarker = "/.ship/changes/";
  const markerIndex = normalized.indexOf(changesMarker);
  if (markerIndex >= 0) {
    const afterChanges = normalized.slice(markerIndex + changesMarker.length);
    const parts = afterChanges.split("/");
    if (parts.length > 1) return parts.slice(1).join("/");
  }
  return path.basename(filePath);
}

function mirrorWarnings(mirror: PhaseArtifactMirrorMetadataInput): string[] {
  if (mirror.mirrorStatus === "ok") return [];
  const warnings = [`mirror_${mirror.mirrorStatus}`];
  if (!mirror.contentHash) warnings.push("content_hash_missing");
  if (!mirror.sourceDbHash || !mirror.schemaVersion) warnings.push("source_metadata_missing");
  return warnings;
}

function assertSafeRealPathBoundaries({
  repoRoot,
  expectedChangeDir,
  resolvedArtifactPath,
  artifactPath,
}: {
  repoRoot: string;
  expectedChangeDir: string;
  resolvedArtifactPath: string;
  artifactPath: string;
}) {
  const artifactStats = tryLstat(resolvedArtifactPath);
  if (artifactStats?.isSymbolicLink()) {
    throw new Error(`Artifact path is a symlink: ${artifactPath}`);
  }

  const changeDirStats = tryLstat(expectedChangeDir);
  if (changeDirStats?.isSymbolicLink()) {
    throw new Error(`Change directory is a symlink: ${artifactPath}`);
  }

  const realRepoRoot = tryRealPath(repoRoot);
  if (!realRepoRoot) return;

  const realChangeDir = tryRealPath(expectedChangeDir);
  if (realChangeDir && !isPathInside(realChangeDir, realRepoRoot)) {
    throw new Error(`Change directory resolves outside the repository: ${artifactPath}`);
  }

  const realParentDir = tryRealPath(path.dirname(resolvedArtifactPath));
  if (!realParentDir) return;
  if (!isPathInside(realParentDir, realRepoRoot)) {
    throw new Error(`Artifact parent directory resolves outside the repository: ${artifactPath}`);
  }
  if (realChangeDir && realParentDir !== realChangeDir) {
    throw new Error(`Artifact parent directory resolves outside this change: ${artifactPath}`);
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
