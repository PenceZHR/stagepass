import fs from "fs";
import path from "path";
import {
  changeArtifactDir,
  getDefinitionForFileName,
  getDefinitionForType,
  getDefinitionsForPhase,
  isEditablePhaseArtifactFileName,
} from "./phase-artifact-service";
import type { PipelinePhase } from "./stage-authority-service";

export const CONTENT_PHASES = [
  "Refine",
  "Intake",
  "Spec",
  "TechSpec",
  "Plan",
  "TestPlan",
  "Build",
  "Implement",
  "Review",
  "Check",
  "Fix",
  "Merge",
  "Retro",
  // Done became a real stage (design §3): it produces delivery.md. Before that
  // it was a completion screen with no records of its own.
  "Done",
] as const;
export type ReviewPhase = (typeof CONTENT_PHASES)[number];

type SourceKind = "current" | "artifact" | "virtual";

interface RunRow {
  id: string;
  changeId: string;
  phase: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
}

interface EventRow {
  id: string;
  changeId: string | null;
  runId: string | null;
  type: string;
  message: string | null;
  rawJson: string | null;
  createdAt: string;
}

interface ArtifactRow {
  id: string;
  changeId: string;
  runId: string | null;
  type: string;
  path: string;
  createdAt: string;
}

interface LegacyImportRow {
  id: string;
  changeId: string;
  phase: string;
  sourcePath: string;
  sourceArtifactHash: string | null;
  schemaVersion: string | null;
  importStatus: string;
  importResultJson: string | null;
  importedAt: string;
}

export interface PhaseArtifactReview {
  id: string;
  type: string;
  path: string;
  editablePath: string | null;
  fileName: string;
  impactLabel: string;
  runId: string | null;
  createdAt: string | null;
  source: SourceKind;
  content: string | null;
  missing: boolean;
  advanced?: boolean;
}

export interface PhaseRunReview {
  id: string;
  phase: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
}

export interface PhaseEventReview {
  id: string;
  type: string;
  message: string | null;
  rawJson: string | null;
  createdAt: string;
  runId: string | null;
}

export interface PhaseOverview {
  phase: ReviewPhase;
  available: boolean;
  artifactCount: number;
  runCount: number;
  eventCount: number;
  legacyWarning?: boolean;
  legacyImports?: PhaseLegacyImportSummary[];
  stageAuthority?: PhaseStageAuthority;
}

export interface PhaseReviewResponse {
  phases: PhaseOverview[];
  selected: {
    phase: ReviewPhase;
    selectedRunId: string | null;
    artifacts: PhaseArtifactReview[];
    runs: PhaseRunReview[];
    events: PhaseEventReview[];
    legacyImports: PhaseLegacyImportSummary[];
  };
}

export interface PhaseLegacyImportSummary {
  id: string;
  phase: string;
  sourcePath: string;
  sourceArtifactHash: string | null;
  schemaVersion: string | null;
  importStatus: string;
  importedAt: string;
}

interface BuildPhaseReviewInput {
  changeId: string;
  repoPath: string;
  selectedPhase: ReviewPhase;
  selectedRunId?: string | null;
  runs: RunRow[];
  events: EventRow[];
  artifacts: ArtifactRow[];
  fileContents?: Record<string, string | undefined>;
  stageAuthorities?: Partial<Record<ReviewPhase, PhaseStageAuthority>>;
  legacyImports?: LegacyImportRow[];
}

export interface PhaseStageAuthority {
  status: string | null;
  latestRunId: string | null;
  latestReportId: string | null;
  latestGateId: string | null;
  latestValidReportId: string | null;
}

const RUN_PHASE_TO_REVIEW_PHASE: Record<string, ReviewPhase> = {
  refine: "Refine",
  intake: "Intake",
  spec: "Spec",
  tech_spec: "TechSpec",
  test_plan: "TestPlan",
  generate_plan: "Plan",
  implement: "Build",
  review: "Review",
  local_check: "Check",
  fix_findings: "Fix",
  release: "Merge",
  retro: "Retro",
  delivery: "Done",
};

const ARTIFACT_TYPE_TO_REVIEW_PHASE: Record<string, ReviewPhase> = {
  spec: "Refine",
  change_request: "Intake",
  prd_intent: "Intake",
  briefing_questions: "Intake",
  prd_draft: "Intake",
  prd_gate: "Intake",
  prd_delta: "Spec",
  tech_spec_delta: "TechSpec",
  api_spec_delta: "TechSpec",
  test_plan_delta: "TestPlan",
  plan: "Plan",
  plan_json: "Plan",
  plan_md: "Plan",
  plan_critique: "Plan",
  plan_report: "Plan",
  diff: "Build",
  implement_summary: "Build",
  changed_files: "Build",
  review_report: "Review",
  review_findings: "Review",
  check_report: "Check",
  log: "Fix",
  release_note: "Merge",
  retro: "Retro",
  delivery: "Done",
};

const STATUS_TO_REVIEW_PHASE: Record<string, ReviewPhase> = {
  REFINING: "Refine",
  DRAFT: "Refine",
  PLANNING: "Plan",
  PLAN_READY: "Plan",
  PLAN_APPROVED: "Plan",
  INTAKE_PENDING: "Intake",
  INTAKE_READY: "Intake",
  SPECCING: "Spec",
  SPEC_READY: "Spec",
  TECHSPECCING: "TechSpec",
  TECHSPEC_READY: "TechSpec",
  TESTPLANNING: "TestPlan",
  TESTPLAN_DONE: "TestPlan",
  IMPLEMENTING: "Build",
  IMPLEMENTED: "Review",
  REVIEWING: "Review",
  CHECKING: "Check",
  CHECK_FAILED: "Check",
  SCOPE_FAILED: "Check",
  FIXING: "Fix",
  LOCAL_READY: "Check",
  MERGE_READY: "Merge",
  MERGING: "Merge",
  RETRO_PENDING: "Retro",
  DELIVERY_PENDING: "Done",
  DONE: "Done",
  BLOCKED: "Check",
};

const VIRTUAL_ARTIFACTS: Record<ReviewPhase, Array<{ type: string; fileName: string }>> = {
  Refine: [{ type: "spec", fileName: "spec.md" }],
  Intake: [
    { type: "change_request", fileName: "change-request.md" },
    { type: "prd_intent", fileName: "prd-intent.md" },
    { type: "briefing_questions", fileName: "briefing-questions.json" },
    { type: "prd_draft", fileName: "prd-draft.md" },
    { type: "prd_gate", fileName: "prd-gate.json" },
  ],
  Spec: [{ type: "prd_delta", fileName: "prd-delta.md" }],
  TechSpec: [
    { type: "tech_spec_delta", fileName: "tech-spec-delta.md" },
    { type: "api_spec_delta", fileName: "api-spec-delta.md" },
  ],
  TestPlan: [{ type: "test_plan_delta", fileName: "test-plan-delta.md" }],
  Plan: [
    { type: "plan_md", fileName: "plan.md" },
    { type: "plan_json", fileName: "plan.json" },
    { type: "plan_critique", fileName: "plan-critique.json" },
    { type: "plan_report", fileName: "reports/plan-report.md" },
  ],
  Build: [
    { type: "implement_summary", fileName: "implement-summary.md" },
    { type: "changed_files", fileName: "changed-files.json" },
  ],
  Implement: [
    { type: "implement_summary", fileName: "implement-summary.md" },
    { type: "changed_files", fileName: "changed-files.json" },
  ],
  Review: [
    { type: "review_report", fileName: "review-report.md" },
    { type: "review_findings", fileName: "review-findings.json" },
  ],
  Check: [
    { type: "local_check", fileName: "local-check.json" },
    { type: "findings", fileName: "findings.json" },
    { type: "semgrep", fileName: "semgrep-local.json" },
  ],
  Fix: [{ type: "changed_files", fileName: "changed-files.json" }],
  Merge: [{ type: "release_note", fileName: "release-note.md" }],
  Retro: [{ type: "retro", fileName: "retro.md" }],
  Done: [{ type: "delivery", fileName: "delivery.md" }],
};

const RAW_REVIEW_OUTPUT_TYPES = new Set([
  "raw_review_output",
  "review_raw_output",
  "stage_raw_output",
]);
const REVIEW_MIRROR_TYPES = new Set(["review_report", "review_findings"]);
const REVIEW_MIRROR_FILE_NAMES = new Set(["review-report.md", "review-findings.json"]);

const PIPELINE_PHASE_TO_REVIEW_PHASE: Record<PipelinePhase, ReviewPhase> = {
  PRD: "Intake",
  Spec: "Spec",
  TechSpec: "TechSpec",
  Plan: "Plan",
  TestPlan: "TestPlan",
  Build: "Build",
  Review: "Review",
  QA: "Check",
  Merge: "Merge",
};

function legacyImportReviewPhase(phase: string): ReviewPhase | null {
  if (phase === "PRD") return "Intake";
  if (phase === "QA") return "Check";
  return normalizeReviewPhase(phase);
}

export function normalizeReviewPhase(value: string | null | undefined): ReviewPhase | null {
  if (!value) return null;
  const found = CONTENT_PHASES.find(
    (phase) => phase.toLowerCase() === value.toLowerCase()
  );
  return found ?? null;
}

function eventPhaseFromStatus(rawJson: string | null): ReviewPhase | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as { status?: string; to?: string };
    const status = parsed.status ?? parsed.to;
    return status ? STATUS_TO_REVIEW_PHASE[status] ?? null : null;
  } catch {
    return null;
  }
}

function eventPhase(event: EventRow, runPhaseById: Map<string, ReviewPhase>): ReviewPhase | null {
  if (event.runId && runPhaseById.has(event.runId)) {
    return runPhaseById.get(event.runId) ?? null;
  }
  if (event.type === "chat_user" || event.type === "chat_assistant") {
    return "Refine";
  }
  if (event.type === "change_status_changed") {
    return eventPhaseFromStatus(event.rawJson);
  }
  return null;
}

function artifactPhase(
  artifact: ArtifactRow,
  runPhaseById: Map<string, ReviewPhase>
): ReviewPhase | null {
  if (artifact.runId && runPhaseById.has(artifact.runId)) {
    return runPhaseById.get(artifact.runId) ?? null;
  }
  return ARTIFACT_TYPE_TO_REVIEW_PHASE[artifact.type] ?? null;
}

function toRunReview(run: RunRow): PhaseRunReview {
  return {
    id: run.id,
    phase: run.phase,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    summary: run.summary,
  };
}

function toEventReview(event: EventRow): PhaseEventReview {
  return {
    id: event.id,
    type: event.type,
    message: event.message,
    rawJson: event.rawJson,
    createdAt: event.createdAt,
    runId: event.runId,
  };
}

function toLegacyImportSummary(row: LegacyImportRow): PhaseLegacyImportSummary {
  return {
    id: row.id,
    phase: row.phase,
    sourcePath: row.sourcePath,
    sourceArtifactHash: row.sourceArtifactHash,
    schemaVersion: row.schemaVersion,
    importStatus: row.importStatus,
    importedAt: row.importedAt,
  };
}

function toArtifactReview(
  artifact: ArtifactRow,
  phase: ReviewPhase,
  fileContents: Record<string, string | undefined>
): PhaseArtifactReview {
  const fileName = path.basename(artifact.path);
  const definition = getDefinitionForFileName(fileName) ?? getDefinitionForType(artifact.type);
  const metadataOnly = isReviewMetadataOnlyArtifact({
    phase,
    type: artifact.type,
    fileName,
  });
  const content = metadataOnly ? null : fileContents[artifact.path] ?? null;
  return {
    id: artifact.id,
    type: artifact.type,
    path: artifact.path,
    editablePath: null,
    fileName: definition?.fileName ?? fileName,
    impactLabel: definition?.label ?? artifact.type,
    runId: artifact.runId,
    createdAt: artifact.createdAt,
    source: "artifact",
    content,
    missing: metadataOnly ? !hasKnownPath(fileContents, artifact.path) : content === null,
    ...(metadataOnly ? { advanced: true } : {}),
  };
}

function hasKnownPath(
  fileContents: Record<string, string | undefined>,
  filePath: string
): boolean {
  return Object.prototype.hasOwnProperty.call(fileContents, filePath);
}

function isReviewMirrorType(type: string): boolean {
  return REVIEW_MIRROR_TYPES.has(type);
}

function isReviewMirrorFileName(fileName: string): boolean {
  return REVIEW_MIRROR_FILE_NAMES.has(fileName);
}

function isReviewMetadataOnlyArtifact({
  phase,
  type,
  fileName,
}: {
  phase: ReviewPhase;
  type: string;
  fileName: string;
}): boolean {
  if (RAW_REVIEW_OUTPUT_TYPES.has(type)) return true;
  return phase === "Review" && (isReviewMirrorType(type) || isReviewMirrorFileName(fileName));
}

function createCurrentArtifacts(
  phase: ReviewPhase,
  input: BuildPhaseReviewInput
): PhaseArtifactReview[] {
  return getDefinitionsForPhase(phase).flatMap((definition) => {
    const filePath = path.join(
      changeArtifactDir(input.repoPath, input.changeId),
      definition.fileName
    );
    const metadataOnly = isReviewMetadataOnlyArtifact({
      phase,
      type: definition.type,
      fileName: definition.fileName,
    });
    if (metadataOnly && !hasKnownPath(input.fileContents ?? {}, filePath)) return [];
    const content = input.fileContents?.[filePath];
    if (!metadataOnly && content === undefined) return [];
    const reviewContent = metadataOnly ? null : content ?? null;
    return [
      {
        id: `current:${phase}:${definition.fileName}`,
        type: definition.type,
        path: filePath,
        editablePath: metadataOnly
          ? null
          : isEditablePhaseArtifactFileName(definition.fileName) ? filePath : null,
        fileName: definition.fileName,
        impactLabel: definition.label,
        runId: null,
        createdAt: null,
        source: "current" as const,
        content: reviewContent,
        missing: false,
        ...(metadataOnly ? { advanced: true } : {}),
      },
    ];
  });
}

function newestRun(runs: PhaseRunReview[]): PhaseRunReview | null {
  if (runs.length === 0) return null;
  return [...runs].sort((a, b) => {
    const aTime = a.startedAt ? Date.parse(a.startedAt) : 0;
    const bTime = b.startedAt ? Date.parse(b.startedAt) : 0;
    return bTime - aTime;
  })[0];
}

function chooseSelectedRunId(
  runs: PhaseRunReview[],
  requestedRunId?: string | null
): string | null {
  if (requestedRunId && runs.some((run) => run.id === requestedRunId)) {
    return requestedRunId;
  }
  return newestRun(runs)?.id ?? null;
}

function filterArtifactsForRun(
  artifacts: PhaseArtifactReview[],
  selectedRunId: string | null
): PhaseArtifactReview[] {
  const currentArtifacts = artifacts.filter((artifact) => artifact.source === "current");
  if (!selectedRunId) return artifacts;
  const runArtifacts = artifacts.filter((artifact) => artifact.runId === selectedRunId);
  return [...currentArtifacts, ...runArtifacts];
}

function filterEventsForRun(
  events: PhaseEventReview[],
  selectedRunId: string | null
): PhaseEventReview[] {
  if (!selectedRunId) return events;
  return events.filter((event) => event.runId === selectedRunId);
}

function createVirtualArtifacts(
  phase: ReviewPhase,
  input: BuildPhaseReviewInput,
  existingPaths: Set<string>
): PhaseArtifactReview[] {
  return VIRTUAL_ARTIFACTS[phase].flatMap((candidate) => {
    const filePath = path.join(
      changeArtifactDir(input.repoPath, input.changeId),
      candidate.fileName
    );
    if (existingPaths.has(filePath)) return [];
    const metadataOnly = isReviewMetadataOnlyArtifact({
      phase,
      type: candidate.type,
      fileName: candidate.fileName,
    });
    if (metadataOnly && !hasKnownPath(input.fileContents ?? {}, filePath)) return [];
    const content = input.fileContents?.[filePath];
    if (!metadataOnly && content === undefined) return [];
    const reviewContent = metadataOnly ? null : content ?? null;
    const definition = getDefinitionForFileName(candidate.fileName);
    return [
      {
        id: `virtual:${phase}:${candidate.fileName}`,
        type: definition?.type ?? candidate.type,
        path: filePath,
        editablePath: metadataOnly
          ? null
          : isEditablePhaseArtifactFileName(candidate.fileName) ? filePath : null,
        fileName: candidate.fileName,
        impactLabel: definition?.label ?? candidate.type,
        runId: null,
        createdAt: null,
        source: "virtual" as const,
        content: reviewContent,
        missing: false,
        ...(metadataOnly ? { advanced: true } : {}),
      },
    ];
  });
}

export function buildPhaseReview(input: BuildPhaseReviewInput): PhaseReviewResponse {
  const runPhaseById = new Map<string, ReviewPhase>();
  for (const run of input.runs) {
    const phase = RUN_PHASE_TO_REVIEW_PHASE[run.phase];
    if (phase) runPhaseById.set(run.id, phase);
  }

  const artifactsByPhase = new Map<ReviewPhase, PhaseArtifactReview[]>();
  const runsByPhase = new Map<ReviewPhase, PhaseRunReview[]>();
  const eventsByPhase = new Map<ReviewPhase, PhaseEventReview[]>();
  const legacyImportsByPhase = new Map<ReviewPhase, PhaseLegacyImportSummary[]>();
  const existingArtifactPaths = new Set<string>();
  const currentArtifactPaths = new Set<string>();

  for (const phase of CONTENT_PHASES) {
    artifactsByPhase.set(phase, []);
    runsByPhase.set(phase, []);
    eventsByPhase.set(phase, []);
    legacyImportsByPhase.set(phase, []);
  }

  for (const phase of CONTENT_PHASES) {
    const currentArtifacts = createCurrentArtifacts(phase, input);
    for (const artifact of currentArtifacts) {
      existingArtifactPaths.add(artifact.path);
      currentArtifactPaths.add(artifact.path);
    }
    artifactsByPhase.get(phase)?.push(...currentArtifacts);
  }

  for (const run of input.runs) {
    const phase = RUN_PHASE_TO_REVIEW_PHASE[run.phase];
    if (phase) runsByPhase.get(phase)?.push(toRunReview(run));
  }

  for (const artifact of input.artifacts) {
    const phase = artifactPhase(artifact, runPhaseById);
    if (!phase) continue;
    existingArtifactPaths.add(artifact.path);
    if (currentArtifactPaths.has(artifact.path)) continue;
    artifactsByPhase
      .get(phase)
      ?.push(toArtifactReview(artifact, phase, input.fileContents ?? {}));
  }

  for (const phase of CONTENT_PHASES) {
    artifactsByPhase
      .get(phase)
      ?.push(...createVirtualArtifacts(phase, input, existingArtifactPaths));
  }

  for (const event of input.events) {
    const phase = eventPhase(event, runPhaseById);
    if (phase) eventsByPhase.get(phase)?.push(toEventReview(event));
  }

  for (const legacyImport of input.legacyImports ?? []) {
    const phase = legacyImportReviewPhase(legacyImport.phase);
    if (phase) legacyImportsByPhase.get(phase)?.push(toLegacyImportSummary(legacyImport));
  }

  const phases = CONTENT_PHASES.map((phase) => {
    const artifactCount = artifactsByPhase.get(phase)?.length ?? 0;
    const runCount = runsByPhase.get(phase)?.length ?? 0;
    const eventCount = eventsByPhase.get(phase)?.length ?? 0;
    const legacySummaries = legacyImportsByPhase.get(phase) ?? [];
    const stageAuthority = input.stageAuthorities?.[phase];
    return {
      phase,
      available:
        artifactCount + runCount + eventCount + legacySummaries.length > 0 ||
        Boolean(stageAuthority),
      artifactCount,
      runCount,
      eventCount,
      ...(legacySummaries.length > 0
        ? { legacyWarning: true, legacyImports: legacySummaries }
        : {}),
      ...(stageAuthority ? { stageAuthority } : {}),
    };
  });

  const selectedRuns = runsByPhase.get(input.selectedPhase) ?? [];
  const selectedRunId = chooseSelectedRunId(selectedRuns, input.selectedRunId);
  const selectedLegacyImports = legacyImportsByPhase.get(input.selectedPhase) ?? [];

  return {
    phases,
    selected: {
      phase: input.selectedPhase,
      selectedRunId,
      artifacts: filterArtifactsForRun(
        artifactsByPhase.get(input.selectedPhase) ?? [],
        selectedRunId
      ),
      runs: selectedRuns,
      events: filterEventsForRun(
        eventsByPhase.get(input.selectedPhase) ?? [],
        selectedRunId
      ),
      legacyImports: selectedLegacyImports,
    },
  };
}

function isPathSafe(filePath: string, repoPath: string): boolean {
  const resolved = path.resolve(filePath);
  const repoResolved = path.resolve(repoPath);
  return resolved.startsWith(repoResolved + path.sep) || resolved === repoResolved;
}

function readKnownFiles(
  repoPath: string,
  changeId: string,
  artifactRows: ArtifactRow[]
): Record<string, string | undefined> {
  const paths = new Set<string>();
  for (const artifact of artifactRows) {
    paths.add(artifact.path);
  }
  for (const phase of CONTENT_PHASES) {
    for (const candidate of VIRTUAL_ARTIFACTS[phase]) {
      paths.add(path.join(changeArtifactDir(repoPath, changeId), candidate.fileName));
    }
    for (const definition of getDefinitionsForPhase(phase)) {
      paths.add(path.join(changeArtifactDir(repoPath, changeId), definition.fileName));
    }
  }

  const result: Record<string, string | undefined> = {};
  for (const filePath of paths) {
    if (!isPathSafe(filePath, repoPath) || !fs.existsSync(filePath)) continue;
    if (isReviewMetadataOnlyPath(filePath)) {
      result[filePath] = undefined;
      continue;
    }
    result[filePath] = fs.readFileSync(filePath, "utf-8");
  }
  return result;
}

function isReviewMetadataOnlyPath(filePath: string): boolean {
  const fileName = path.basename(filePath);
  if (isReviewMirrorFileName(fileName)) return true;
  return (
    fileName.includes("raw-review-output") ||
    fileName.includes("raw_review_output") ||
    fileName === "raw-ai-output.json"
  );
}

export async function getChangePhaseReview(
  projectId: string,
  changeId: string,
  selectedPhase: ReviewPhase,
  selectedRunId?: string | null
): Promise<PhaseReviewResponse> {
  const [{ db }, schema, drizzle, stageAuthorityService] = await Promise.all([
    import("../db"),
    import("../db/schema"),
    import("drizzle-orm"),
    import("./stage-authority-service"),
  ]);
  const { artifacts, changes, events, legacyImports, projects, runs } = schema;
  const { and, asc, eq } = drizzle;

  const change = db
    .select()
    .from(changes)
    .where(and(eq(changes.id, changeId), eq(changes.projectId, projectId)))
    .get();
  if (!change) {
    throw new Error(`Change not found: ${changeId}`);
  }

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const runRows = db
    .select()
    .from(runs)
    .where(eq(runs.changeId, changeId))
    .orderBy(asc(runs.startedAt))
    .all() as RunRow[];

  const eventRows = db
    .select()
    .from(events)
    .where(eq(events.changeId, changeId))
    .orderBy(asc(events.createdAt))
    .all() as EventRow[];

  const artifactRows = db
    .select()
    .from(artifacts)
    .where(eq(artifacts.changeId, changeId))
    .orderBy(asc(artifacts.createdAt))
    .all() as ArtifactRow[];
  const legacyImportRows = db
    .select()
    .from(legacyImports)
    .where(eq(legacyImports.changeId, changeId))
    .orderBy(asc(legacyImports.importedAt))
    .all() as LegacyImportRow[];
  const stageAuthorities: Partial<Record<ReviewPhase, PhaseStageAuthority>> = {};
  for (const [pipelinePhase, reviewPhase] of Object.entries(PIPELINE_PHASE_TO_REVIEW_PHASE) as Array<
    [PipelinePhase, ReviewPhase]
  >) {
    const authority = stageAuthorityService.peekStageAuthority(changeId, pipelinePhase);
    if (
      !authority.state &&
      !authority.latestAttempt &&
      !authority.latestReport &&
      !authority.latestGate
    ) {
      continue;
    }
    stageAuthorities[reviewPhase] = {
      status: authority.state?.status ?? null,
      latestRunId: authority.latestAttempt?.id ?? null,
      latestReportId: authority.latestReport?.id ?? null,
      latestGateId: authority.latestGate?.id ?? null,
      latestValidReportId: authority.latestValidReport?.id ?? null,
    };
  }

  return buildPhaseReview({
    changeId,
    repoPath: project.repoPath,
    selectedPhase,
    selectedRunId,
    runs: runRows,
    events: eventRows,
    artifacts: artifactRows,
    fileContents: readKnownFiles(project.repoPath, changeId, artifactRows),
    stageAuthorities,
    legacyImports: legacyImportRows,
  });
}
