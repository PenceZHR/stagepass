import path from "node:path";

import { and, asc, desc, eq, inArray, or } from "drizzle-orm";

import type { db } from "../db";
import {
  apiSnapshots,
  artifacts,
  artifactMirrors,
  battleRounds,
  briefingQuestions,
  buildRunRecords,
  changes,
  findings,
  pipelineJobs,
  projects,
  prdBriefings,
  prdDrafts,
  reviewAttempts,
  reviewReports,
  reviewState,
  runs,
  stageGates,
  stageRuns,
  stageReports,
  techspecSnapshots,
  warReports,
} from "../db/schema";
import type { ProviderRunProcess } from "./provider-run-lifecycle-service";
import type {
  BusinessEvidenceObservation,
  FileEvidenceObservation,
} from "./recovery-types";
import { DEFAULT_MAX_REVIEW_FINDINGS } from "./recovery-types";
import { nonEmpty } from "./recovery-predicates";
import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  boundedPriorFindingIds,
  parseJsonRecord,
  readTrustedArtifact,
  sha256Text,
} from "./recovery-evidence";
import { renderDesignSnapshotMarkdown } from "./pipeline-design-stage-service";
import {
  computeReviewFindingsDbHash,
  computeReviewReportDbHash,
  settlementFindingsForReviewAttempt,
} from "./review-report-service";
import { getSpecReportFreshness } from "./spec-battle-report-service";
import { computeSourceDbHash } from "./stage-authority-service";
import {
  computeApiContractDbHash,
  computeTechSpecContentDbHash,
  normalizeDesignSections,
} from "./techspec-api-snapshot-service";
import { hashBuildChangedFiles } from "./build-run-record-service";
import { assertAdoptedBuildRunMatchesWorkspace } from "./build-workspace-service";

/**
 * Business-evidence observation for a completed provider run and the
 * authoritative DB-snapshot witness it is compared against. Extracted from the
 * recovery orchestrator so the ~470 lines of read-only, phase-specific evidence
 * gathering live apart from the transactional executors. This module reads the
 * business database and trusted artifacts but performs no writes; the loop
 * dependency is broken by inlining the evidence DB shape (`EvidenceDb`) and the
 * query-observation hook rather than importing the orchestrator's option type.
 */

type EvidenceDb = Pick<typeof db, "select">;

type EvidenceDbQueryHook = (
  phase: string,
  scope: "observation" | "transaction",
) => void;

export const documentStagePhases: Partial<Record<string, string>> = {
  spec: "Spec",
  spec_critic: "Spec",
  tech_spec: "TechSpec",
  generate_plan: "Plan",
  test_plan: "TestPlan",
  implement: "Build",
  fix_findings: "Build",
  review: "Review",
  local_check: "QA",
};

/**
 * Resolves the pipelineJobs.actionId that produced an "intake"-phase provider
 * run, via provider.jobId. Intake has no stageRuns row (documentStagePhases has
 * no "intake" entry) so, unlike every other phase, there is no attemptNo-keyed
 * authority row to key evidence off of; actionId is the only stable signal for
 * which of the legacy single-shot or new 3-step PRD briefing flow produced this
 * run, and thus which domain evidence table to check. Returns null (fail-closed
 * via the "intake_action_unresolved" evidence code, not silent pass) when the
 * provider has no jobId or the job row can no longer be found.
 */
function resolveIntakeActionId(
  evidenceDb: EvidenceDb,
  provider: ProviderRunProcess,
): string | null {
  if (!provider.jobId) return null;
  return evidenceDb.select({ actionId: pipelineJobs.actionId })
    .from(pipelineJobs)
    .where(eq(pipelineJobs.id, provider.jobId))
    .get()?.actionId ?? null;
}

export function businessEvidenceForCompletedProvider(
  evidenceDb: EvidenceDb,
  run: typeof runs.$inferSelect,
  provider: ProviderRunProcess,
  maxReviewFindings: number,
  onEvidenceProbe?: (kind: "fs" | "git") => void,
  onEvidenceDbQuery?: EvidenceDbQueryHook,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
): BusinessEvidenceObservation {
  const initialDbSnapshot = captureEvidenceDbSnapshot(
    evidenceDb, run, provider, onEvidenceDbQuery, "observation", maxReviewFindings,
  );
  const missingEvidence: string[] = [];
  const fileObservations: FileEvidenceObservation[] = [];
  const project = evidenceDb.select().from(projects).where(eq(projects.id,
    evidenceDb.select({ projectId: changes.projectId }).from(changes).where(eq(changes.id, run.changeId)).get()?.projectId ?? ""
  )).get() ?? null;
  if (provider.phase === "tech_spec") {
    const techSpec = evidenceDb.select().from(techspecSnapshots).where(and(
      eq(techspecSnapshots.changeId, run.changeId),
      inArray(techspecSnapshots.status, ["approved", "pass", "passed"]),
    )).orderBy(desc(techspecSnapshots.createdAt), desc(techspecSnapshots.id)).limit(1).get() ?? null;
    const api = evidenceDb.select().from(apiSnapshots).where(and(
      eq(apiSnapshots.changeId, run.changeId),
      inArray(apiSnapshots.status, ["approved", "pass", "passed"]),
    )).orderBy(desc(apiSnapshots.createdAt), desc(apiSnapshots.id)).limit(1).get() ?? null;
    const runArtifacts = ["tech_spec_delta", "api_spec_delta"].map((artifactType) =>
      evidenceDb.select().from(artifacts).where(and(
        eq(artifacts.changeId, run.changeId),
        eq(artifacts.runId, run.id),
        eq(artifacts.type, artifactType),
      )).orderBy(desc(artifacts.createdAt), desc(artifacts.id)).limit(1).get() ?? null
    ).filter((artifact): artifact is typeof artifacts.$inferSelect => artifact !== null);
    const gate = evidenceDb.select().from(stageGates).where(and(
      eq(stageGates.changeId, run.changeId),
      eq(stageGates.phase, "TechSpec"),
    )).orderBy(desc(stageGates.computedAt), desc(stageGates.id)).limit(1).get() ?? null;
    let techSpecContent: ReturnType<typeof normalizeDesignSections> | null = null;
    let apiContract: ReturnType<typeof normalizeDesignSections> | null = null;
    try {
      techSpecContent = techSpec?.contentJson ? normalizeDesignSections(JSON.parse(techSpec.contentJson)) : null;
    } catch {
      techSpecContent = null;
    }
    try {
      apiContract = api?.contractJson ? normalizeDesignSections(JSON.parse(api.contractJson)) : null;
    } catch {
      apiContract = null;
    }
    const techSpecHash = techSpec && techSpecContent
      ? computeTechSpecContentDbHash({ changeId: run.changeId, schemaVersion: techSpec.schemaVersion, content: techSpecContent })
      : null;
    const apiHash = api && apiContract
      ? computeApiContractDbHash({ changeId: run.changeId, schemaVersion: api.schemaVersion, contract: apiContract })
      : null;
    if (!techSpec || !techSpecContent || techSpec.contentDbHash !== techSpecHash) {
      missingEvidence.push("techspec_structured_snapshot");
    }
    if (!techSpec || !nonEmpty(techSpec.sourceSpecHash)
      || !run.startedAt || techSpec.createdAt < run.startedAt) {
      missingEvidence.push("techspec_source_lineage");
    }
    if (!api || !apiContract || api.contractDbHash !== apiHash) {
      missingEvidence.push("api_structured_snapshot");
    }
    if (!api || api.sourceTechspecHash !== techSpec?.contentDbHash) missingEvidence.push("api_source_lineage");
    const artifactExpectations = [
      {
        type: "tech_spec_delta",
        title: "TechSpec DB Snapshot",
        sourceDbHash: techSpec?.contentDbHash ?? null,
        schemaVersion: techSpec?.schemaVersion ?? null,
        content: techSpec && techSpecContent
          ? renderDesignSnapshotMarkdown("TechSpec DB Snapshot", {
            id: techSpec.id,
            changeId: techSpec.changeId,
            status: techSpec.status,
            sourceSpecHash: techSpec.sourceSpecHash,
            content: techSpecContent,
            contentDbHash: techSpec.contentDbHash ?? "",
            schemaVersion: techSpec.schemaVersion,
            reviewedAt: techSpec.reviewedAt,
            createdAt: techSpec.createdAt,
          })
          : null,
      },
      {
        type: "api_spec_delta",
        title: "API DB Snapshot",
        sourceDbHash: api?.contractDbHash ?? null,
        schemaVersion: api?.schemaVersion ?? null,
        content: api && apiContract
          ? renderDesignSnapshotMarkdown("API DB Snapshot", {
            id: api.id,
            changeId: api.changeId,
            status: api.status,
            sourceTechspecHash: api.sourceTechspecHash,
            contract: apiContract,
            contractDbHash: api.contractDbHash ?? "",
            schemaVersion: api.schemaVersion,
            reviewedAt: api.reviewedAt,
            createdAt: api.createdAt,
          })
          : null,
      },
    ] as const;
    for (const expected of artifactExpectations) {
      const type = expected.type;
      const artifact = runArtifacts.find((row) => row.type === type) ?? null;
      const mirror = evidenceDb.select().from(artifactMirrors).where(and(
        eq(artifactMirrors.changeId, run.changeId),
        eq(artifactMirrors.phase, "TechSpec"),
        eq(artifactMirrors.artifactType, type),
      )).orderBy(desc(artifactMirrors.generatedAt), desc(artifactMirrors.id)).limit(1).get() ?? null;
      const content = artifact && project
        ? readTrustedArtifact(project.repoPath, artifact.path, onEvidenceProbe, fileObservations, mirror?.contentHash ?? null, maxArtifactBytes)
        : null;
      const contentHash = content ? sha256Text(content) : null;
      if (!artifact || !content || !expected.content || content.toString("utf8") !== expected.content
        || !run.startedAt || artifact.createdAt < run.startedAt
        || !mirror || mirror.mirrorStatus !== "ok" || mirror.contentHash !== contentHash
        || mirror.sourceDbHash !== expected.sourceDbHash || mirror.schemaVersion !== expected.schemaVersion
        || mirror.generatedAt < run.startedAt) {
        missingEvidence.push(`${type}_run_artifact`);
      }
    }
    let gateFresh = false;
    try {
      gateFresh = Boolean(gate?.freshnessJson && JSON.parse(gate.freshnessJson).fresh === true);
    } catch {
      gateFresh = false;
    }
    const expectedGateHash = techSpec && api
      ? computeSourceDbHash({
        changeId: run.changeId,
        phase: "TechSpec",
        rows: [
          { table: "techspec_snapshots", id: techSpec.id, contentDbHash: techSpec.contentDbHash },
          { table: "api_snapshots", id: api.id, contractDbHash: api.contractDbHash },
        ],
      })
      : null;
    if (!gate || !["pass", "passed", "passed_with_warnings"].includes(gate.status)
      || gate.sourceDbHash !== expectedGateHash || !gateFresh
      || !run.startedAt || gate.computedAt < run.startedAt) {
      missingEvidence.push("techspec_success_gate");
    }
  } else if (provider.phase === "spec" || provider.phase === "spec_critic") {
    const round = provider.roundId
      ? evidenceDb.select().from(battleRounds).where(eq(battleRounds.id, provider.roundId)).get() ?? null
      : evidenceDb.select().from(battleRounds).where(and(
        eq(battleRounds.changeId, run.changeId),
        inArray(battleRounds.phase, ["Spec", "spec"]),
      )).orderBy(desc(battleRounds.roundNo), desc(battleRounds.id)).limit(1).get() ?? null;
    if (!round || !["report_ready", "closed"].includes(round.status)) missingEvidence.push("spec_round_terminal");
    const redContent = round && project
      ? readTrustedArtifact(project.repoPath, round.redArtifactPath, onEvidenceProbe, fileObservations, round.redArtifactHash, maxArtifactBytes)
      : null;
    if (!round || !redContent || sha256Text(redContent) !== round.redArtifactHash) missingEvidence.push("spec_red_artifact");
    const blueContent = round && project
      ? readTrustedArtifact(project.repoPath, round.blueArtifactPath, onEvidenceProbe, fileObservations, round.blueArtifactHash, maxArtifactBytes)
      : null;
    let blueHash: string | null = null;
    try {
      blueHash = blueContent ? sha256Text(JSON.stringify(JSON.parse(blueContent.toString("utf8")))) : null;
    } catch {
      blueHash = null;
    }
    if (!round || !blueContent || blueHash !== round.blueArtifactHash) missingEvidence.push("spec_blue_artifact");
    const report = round
      ? evidenceDb.select().from(warReports).where(and(
        eq(warReports.changeId, run.changeId), eq(warReports.roundId, round.id), eq(warReports.type, "phase_report"),
      )).orderBy(desc(warReports.createdAt), desc(warReports.id)).limit(1).get() ?? null
      : null;
    const reportArtifact = report
      ? evidenceDb.select().from(artifacts).where(and(
        eq(artifacts.changeId, run.changeId), eq(artifacts.type, "spec_report"), eq(artifacts.path, report.path),
      )).get() ?? null
      : null;
    const reportContent = report && project
      ? readTrustedArtifact(project.repoPath, report.path, onEvidenceProbe, fileObservations, report.reportHash, maxArtifactBytes)
      : null;
    const freshness = getSpecReportFreshness(run.changeId);
    if (!report || report.status !== "generated" || !reportArtifact || !reportContent
      || sha256Text(reportContent) !== report.reportHash || !freshness.reportFresh || freshness.reportId !== report.id) {
      missingEvidence.push("spec_report_commit");
    }
    const gate = evidenceDb.select().from(stageGates).where(and(
      eq(stageGates.changeId, run.changeId), eq(stageGates.phase, "Spec"),
    )).orderBy(desc(stageGates.computedAt), desc(stageGates.id)).limit(1).get() ?? null;
    const authorityRun = gate?.sourceDbHash
      ? evidenceDb.select().from(stageRuns).where(and(
        eq(stageRuns.changeId, run.changeId), eq(stageRuns.phase, "Spec"), eq(stageRuns.outputDbHash, gate.sourceDbHash),
      )).orderBy(desc(stageRuns.completedAt), desc(stageRuns.id)).limit(1).get() ?? null
      : null;
    const authorityReport = authorityRun
      ? evidenceDb.select().from(stageReports).where(eq(stageReports.sourceRunId, authorityRun.id))
        .orderBy(desc(stageReports.generatedAt), desc(stageReports.id)).limit(1).get() ?? null
      : null;
    const gateFreshness = parseJsonRecord(gate?.freshnessJson);
    if (!gate || !["pass", "blocked"].includes(gate.status) || !authorityRun
      || !["passed", "issues_found"].includes(authorityRun.status)
      || authorityReport?.reportDbHash !== gate.sourceDbHash
      || gateFreshness?.reportId !== report?.id) {
      missingEvidence.push("spec_stage_authority");
    }
  } else if (provider.phase === "review") {
    const attempt = evidenceDb.select().from(reviewAttempts).where(and(
      eq(reviewAttempts.changeId, run.changeId), eq(reviewAttempts.runId, run.id),
    )).get() ?? null;
    const state = evidenceDb.select().from(reviewState).where(eq(reviewState.changeId, run.changeId)).get() ?? null;
    const report = state?.latestValidReviewReportId
      ? evidenceDb.select().from(reviewReports).where(eq(reviewReports.id, state.latestValidReviewReportId)).get() ?? null
      : null;
    if (!attempt || attempt.status !== "completed" || !["passed", "issues_found"].includes(attempt.reviewStatus) || !attempt.completedAt) {
      missingEvidence.push("review_attempt_terminal");
    }
    const reportFacts = parseJsonRecord(report?.reportJson);
    const currentAttemptFindingRows = attempt
      ? evidenceDb.select().from(findings).where(and(
        eq(findings.changeId, run.changeId),
        eq(findings.source, "review"),
        eq(findings.reviewAttemptId, attempt.id),
      )).orderBy(asc(findings.id)).limit(maxReviewFindings + 1).all()
      : [];
    let findingsLimitExceeded = currentAttemptFindingRows.length > maxReviewFindings;
    const currentAttemptFindings = currentAttemptFindingRows.slice(0, maxReviewFindings);
    const boundedPrior = boundedPriorFindingIds(
      attempt?.priorBlockingFindingIdsJson,
      maxReviewFindings,
    );
    const priorFindingIds = boundedPrior.ids;
    const remainingFindingCapacity = Math.max(0, maxReviewFindings - currentAttemptFindings.length);
    if (boundedPrior.limitExceeded || priorFindingIds.length > remainingFindingCapacity) {
      findingsLimitExceeded = true;
    }
    const priorIdsForQuery = priorFindingIds.slice(0, remainingFindingCapacity + 1);
    const priorFindingRows = priorIdsForQuery.length > 0
      ? evidenceDb.select().from(findings).where(and(
        eq(findings.changeId, run.changeId),
        eq(findings.source, "review"),
        inArray(findings.id, priorIdsForQuery),
      )).orderBy(asc(findings.id)).limit(remainingFindingCapacity + 1).all()
      : [];
    if (priorFindingRows.length > remainingFindingCapacity) findingsLimitExceeded = true;
    const priorFindings = priorFindingRows.slice(0, remainingFindingCapacity);
    if (findingsLimitExceeded) missingEvidence.push("review_findings_limit");
    const reviewFindings = [...currentAttemptFindings, ...priorFindings];
    const settlement = attempt ? settlementFindingsForReviewAttempt(attempt, reviewFindings) : [];
    const findingsDbHash = computeReviewFindingsDbHash(settlement);
    const reportDbHash = reportFacts ? computeReviewReportDbHash(reportFacts, findingsDbHash) : null;
    if (!report || report.attemptId !== attempt?.id || report.staleReason !== null
      || report.findingsDbHash !== findingsDbHash || report.reportDbHash !== reportDbHash) {
      missingEvidence.push("review_report_commit");
    }
    const latestBuild = evidenceDb.select().from(buildRunRecords).where(and(
      eq(buildRunRecords.changeId, run.changeId),
      inArray(buildRunRecords.status, ["approved_for_absorb", "adopted"]),
    )).orderBy(
      desc(buildRunRecords.adoptedAt), desc(buildRunRecords.updatedAt), desc(buildRunRecords.id),
    ).limit(1).get() ?? null;
    const latestBuildId = latestBuild?.buildRunId ?? latestBuild?.id ?? null;
    const latestBuildHead = latestBuild?.status === "approved_for_absorb"
      ? latestBuild.baseCommit ?? latestBuild.baseHeadSha
      : latestBuild?.headSha ?? latestBuild?.adoptedHeadSha ?? latestBuild?.baseCommit ?? null;
    if (!state || state.latestAttemptId !== attempt?.id || state.latestValidReviewReportId !== report?.id
      || state.reportDbHash !== report?.reportDbHash || state.gateStatus !== report?.gateStatus
      || report?.sourceBuildRunId !== attempt?.sourceBuildRunId || report?.sourceBuildRunId !== latestBuildId
      || report?.sourceHeadSha !== attempt?.sourceHeadSha || report?.sourceHeadSha !== latestBuildHead) {
      missingEvidence.push("review_gate_commit");
    }
  } else if (provider.phase === "implement" || provider.phase === "fix_findings") {
    const build = evidenceDb.select().from(buildRunRecords).where(and(
      eq(buildRunRecords.changeId, run.changeId), eq(buildRunRecords.runId, run.id),
    )).get() ?? null;
    const runNumber = build?.buildRunId ? /^(?:build-)?(\d+)$/.exec(build.buildRunId)?.[1] ?? null : null;
    const buildRunPath = project && runNumber
      ? path.join(project.repoPath, ".ship", "changes", run.changeId, "build", "runs", `build-${runNumber}.json`)
      : null;
    const buildRunContent = project && buildRunPath
      ? readTrustedArtifact(project.repoPath, buildRunPath, onEvidenceProbe, fileObservations, null, maxArtifactBytes)
      : null;
    const buildRunFile = buildRunContent ? parseJsonRecord(buildRunContent.toString("utf8")) : null;
    let workspaceValidated = false;
    if (project) {
      try {
        onEvidenceProbe?.("git");
        const validated = assertAdoptedBuildRunMatchesWorkspace({ repoPath: project.repoPath, changeId: run.changeId });
        workspaceValidated = validated.runNumber === Number(runNumber);
      } catch {
        workspaceValidated = false;
      }
    }
    const purpose = buildRunFile?.purpose === "fix" ? "fix" : "build";
    const expectedAdoptionDecisionId = runNumber ? `${purpose}-${runNumber}-adoption` : null;
    if (!build || build.status !== "adopted" || buildRunFile?.status !== "adopted"
      || !workspaceValidated || buildRunFile?.changeId !== run.changeId
      || build.adoptionDecisionId !== expectedAdoptionDecisionId
      || buildRunFile?.adoptionDecisionId !== expectedAdoptionDecisionId) {
      missingEvidence.push("build_adopted_terminal");
    }
    const changedFiles = Array.isArray(buildRunFile?.changedFiles)
      ? buildRunFile!.changedFiles.filter((item): item is string => typeof item === "string")
      : null;
    const patchContent = project && typeof buildRunFile?.patchPath === "string"
      ? readTrustedArtifact(project.repoPath, buildRunFile.patchPath, onEvidenceProbe, fileObservations, build?.patchHash ?? null, maxArtifactBytes)
      : null;
    const patchHash = patchContent ? sha256Text(patchContent) : null;
    if (!build || !buildRunFile || !patchContent || !changedFiles
      || build.patchHash !== patchHash || build.artifactHash !== patchHash
      || build.changedFilesHash !== hashBuildChangedFiles(changedFiles)
      || buildRunFile.patchSha256 !== patchHash || buildRunFile.patchHash !== patchHash
      || buildRunFile.changedFilesHash !== build.changedFilesHash) {
      missingEvidence.push("build_collect_result");
    }
    if (!build || !build.adoptedAt || build.headSha !== build.adoptedHeadSha
      || build.adoptedHeadSha !== buildRunFile?.adoptedHeadSha
      || build.baseCommit !== buildRunFile?.baseCommit || build.baseHeadSha !== buildRunFile?.baseHeadSha
      || build.adoptedAt !== buildRunFile?.updatedAt) {
      missingEvidence.push("build_adoption_commit");
    }
  } else if (provider.phase === "intake") {
    // Intake has no documentStagePhases entry (see the comment on
    // resolveIntakeActionId), so evidence is dispatched on the pipelineJobs
    // actionId that produced this run rather than on a stageRuns row.
    const actionId = resolveIntakeActionId(evidenceDb, provider);
    if (actionId === "run_prd" || actionId === "retry_prd") {
      // Legacy single-shot flow: runDocumentStage writes only to the generic
      // artifacts table (artifactType "change_request"), keyed by run.id.
      const artifact = evidenceDb.select().from(artifacts).where(and(
        eq(artifacts.changeId, run.changeId), eq(artifacts.runId, run.id),
      )).get() ?? null;
      if (!artifact || !nonEmpty(artifact.path)) missingEvidence.push("intake_artifact_missing");
    } else if (actionId === "run_prd_briefing_questions") {
      const questions = evidenceDb.select().from(briefingQuestions)
        .where(eq(briefingQuestions.changeId, run.changeId)).all();
      if (questions.length === 0
        || questions.some((question) => !nonEmpty(question.question) || !nonEmpty(question.whyItMatters))) {
        missingEvidence.push("intake_questions_missing");
      }
    } else if (actionId === "run_prd_briefing_draft") {
      const draft = evidenceDb.select().from(prdDrafts).where(eq(prdDrafts.changeId, run.changeId)).all()
        .sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
      if (!draft || !nonEmpty(draft.markdown)) missingEvidence.push("intake_draft_missing");
    } else if (actionId === "run_prd_briefing_final_review") {
      const briefing = evidenceDb.select().from(prdBriefings)
        .where(eq(prdBriefings.changeId, run.changeId)).get() ?? null;
      if (!briefing || !nonEmpty(briefing.finalReviewJson)) missingEvidence.push("intake_final_review_missing");
    } else {
      // Unknown/unresolvable actionId (missing jobId, deleted job row, or an
      // actionId this branch doesn't recognize): fail closed rather than
      // silently treating evidence as present.
      missingEvidence.push("intake_action_unresolved");
    }
  } else {
    const stagePhase = documentStagePhases[provider.phase];
    const stage = stagePhase && run.attemptNo !== null
      ? evidenceDb.select().from(stageRuns).where(and(
        eq(stageRuns.changeId, run.changeId), eq(stageRuns.phase, stagePhase), eq(stageRuns.attemptNo, run.attemptNo),
      )).get() ?? null
      : null;
    const artifact = evidenceDb.select().from(artifacts).where(and(
      eq(artifacts.changeId, run.changeId), eq(artifacts.runId, run.id),
    )).get() ?? null;
    if (!stage || stage.status !== "completed" || !nonEmpty(stage.outputDbHash)) missingEvidence.push("stage_success_commit");
    if (!stage || !nonEmpty(stage.sourceLineageJson)) missingEvidence.push("stage_source_lineage");
    if (!artifact || !nonEmpty(artifact.path)) missingEvidence.push("stage_run_artifact");
  }
  const dbSnapshot = captureEvidenceDbSnapshot(
    evidenceDb, run, provider, onEvidenceDbQuery, "observation", maxReviewFindings,
  );
  if (initialDbSnapshot !== dbSnapshot) missingEvidence.push("evidence_changed_during_probe");
  return { complete: missingEvidence.length === 0, missingEvidence, dbSnapshot, files: fileObservations };
}

export function captureEvidenceDbSnapshot(
  evidenceDb: EvidenceDb,
  run: typeof runs.$inferSelect,
  provider: ProviderRunProcess,
  onQuery?: EvidenceDbQueryHook,
  scope: "observation" | "transaction" = "observation",
  maxReviewFindings = DEFAULT_MAX_REVIEW_FINDINGS,
): string {
  const query = <T>(read: () => T): T => {
    onQuery?.(provider.phase, scope);
    return read();
  };
  const change = query(() => evidenceDb.select({
    id: changes.id,
    projectId: changes.projectId,
    updatedAt: changes.updatedAt,
  }).from(changes).where(eq(changes.id, run.changeId)).get() ?? null);
  const project = query(() => evidenceDb.select({
    id: projects.id,
    repoPath: projects.repoPath,
    updatedAt: projects.updatedAt,
  }).from(projects).where(eq(projects.id, change?.projectId ?? "")).get() ?? null);
  const common = { change, project };
  if (provider.phase === "tech_spec") {
    return JSON.stringify({
      ...common,
      techspec: query(() => evidenceDb.select({
        id: techspecSnapshots.id, status: techspecSnapshots.status, sourceSpecHash: techspecSnapshots.sourceSpecHash,
        contentJson: techspecSnapshots.contentJson,
        contentDbHash: techspecSnapshots.contentDbHash, schemaVersion: techspecSnapshots.schemaVersion,
        reviewedAt: techspecSnapshots.reviewedAt, createdAt: techspecSnapshots.createdAt,
      }).from(techspecSnapshots).where(and(
        eq(techspecSnapshots.changeId, run.changeId),
        inArray(techspecSnapshots.status, ["approved", "pass", "passed"]),
      )).orderBy(desc(techspecSnapshots.createdAt), desc(techspecSnapshots.id)).limit(1).get() ?? null),
      api: query(() => evidenceDb.select({
        id: apiSnapshots.id, status: apiSnapshots.status, sourceTechspecHash: apiSnapshots.sourceTechspecHash,
        contractJson: apiSnapshots.contractJson,
        contractDbHash: apiSnapshots.contractDbHash, schemaVersion: apiSnapshots.schemaVersion,
        reviewedAt: apiSnapshots.reviewedAt, createdAt: apiSnapshots.createdAt,
      }).from(apiSnapshots).where(and(
        eq(apiSnapshots.changeId, run.changeId),
        inArray(apiSnapshots.status, ["approved", "pass", "passed"]),
      )).orderBy(desc(apiSnapshots.createdAt), desc(apiSnapshots.id)).limit(1).get() ?? null),
      artifacts: ["tech_spec_delta", "api_spec_delta"].map((artifactType) => query(() =>
        evidenceDb.select({
          id: artifacts.id, runId: artifacts.runId, type: artifacts.type,
          path: artifacts.path, createdAt: artifacts.createdAt,
        }).from(artifacts).where(and(
          eq(artifacts.changeId, run.changeId),
          eq(artifacts.runId, run.id),
          eq(artifacts.type, artifactType),
        )).orderBy(desc(artifacts.createdAt), desc(artifacts.id)).limit(1).get() ?? null
      )),
      mirrors: ["tech_spec_delta", "api_spec_delta"].map((artifactType) => query(() =>
        evidenceDb.select({
          id: artifactMirrors.id, artifactType: artifactMirrors.artifactType,
          contentHash: artifactMirrors.contentHash, sourceDbHash: artifactMirrors.sourceDbHash,
          schemaVersion: artifactMirrors.schemaVersion, mirrorStatus: artifactMirrors.mirrorStatus,
          generatedAt: artifactMirrors.generatedAt,
        }).from(artifactMirrors).where(and(
          eq(artifactMirrors.changeId, run.changeId),
          eq(artifactMirrors.phase, "TechSpec"),
          eq(artifactMirrors.artifactType, artifactType),
        )).orderBy(desc(artifactMirrors.generatedAt), desc(artifactMirrors.id)).limit(1).get() ?? null
      )),
      gate: query(() => evidenceDb.select({
        id: stageGates.id, status: stageGates.status, freshnessJson: stageGates.freshnessJson,
        sourceDbHash: stageGates.sourceDbHash, gateVersion: stageGates.gateVersion, computedAt: stageGates.computedAt,
      }).from(stageGates).where(and(
        eq(stageGates.changeId, run.changeId), eq(stageGates.phase, "TechSpec"),
      )).orderBy(desc(stageGates.computedAt), desc(stageGates.id)).limit(1).get() ?? null),
    });
  }
  if (provider.phase === "spec" || provider.phase === "spec_critic") {
    const round = query(() => provider.roundId
      ? evidenceDb.select({
        id: battleRounds.id, phase: battleRounds.phase, roundNo: battleRounds.roundNo,
        status: battleRounds.status, redArtifactPath: battleRounds.redArtifactPath,
        redArtifactHash: battleRounds.redArtifactHash, blueArtifactPath: battleRounds.blueArtifactPath,
        blueArtifactHash: battleRounds.blueArtifactHash, endedAt: battleRounds.endedAt,
        updatedAt: battleRounds.updatedAt,
      }).from(battleRounds).where(eq(battleRounds.id, provider.roundId)).get() ?? null
      : evidenceDb.select({
        id: battleRounds.id, phase: battleRounds.phase, roundNo: battleRounds.roundNo,
        status: battleRounds.status, redArtifactPath: battleRounds.redArtifactPath,
        redArtifactHash: battleRounds.redArtifactHash, blueArtifactPath: battleRounds.blueArtifactPath,
        blueArtifactHash: battleRounds.blueArtifactHash, endedAt: battleRounds.endedAt,
        updatedAt: battleRounds.updatedAt,
      }).from(battleRounds).where(and(
        eq(battleRounds.changeId, run.changeId), inArray(battleRounds.phase, ["Spec", "spec"]),
      )).orderBy(desc(battleRounds.roundNo), desc(battleRounds.id)).limit(1).get() ?? null);
    const report = query(() => round
      ? evidenceDb.select({
        id: warReports.id, roundId: warReports.roundId, status: warReports.status,
        path: warReports.path, reportHash: warReports.reportHash, updatedAt: warReports.updatedAt,
      }).from(warReports).where(and(
        eq(warReports.changeId, run.changeId), eq(warReports.roundId, round.id),
        eq(warReports.type, "phase_report"),
      )).orderBy(desc(warReports.createdAt), desc(warReports.id)).limit(1).get() ?? null
      : null);
    const gate = query(() => evidenceDb.select({
      id: stageGates.id, status: stageGates.status, sourceDbHash: stageGates.sourceDbHash,
      gateVersion: stageGates.gateVersion, computedAt: stageGates.computedAt,
    }).from(stageGates).where(and(
      eq(stageGates.changeId, run.changeId), eq(stageGates.phase, "Spec"),
    )).orderBy(desc(stageGates.computedAt), desc(stageGates.id)).limit(1).get() ?? null);
    const authorityRun = query(() => gate?.sourceDbHash
      ? evidenceDb.select({
        id: stageRuns.id, attemptNo: stageRuns.attemptNo, status: stageRuns.status,
        outputDbHash: stageRuns.outputDbHash, completedAt: stageRuns.completedAt,
      }).from(stageRuns).where(and(
        eq(stageRuns.changeId, run.changeId), eq(stageRuns.phase, "Spec"),
        eq(stageRuns.outputDbHash, gate.sourceDbHash),
      )).orderBy(desc(stageRuns.completedAt), desc(stageRuns.id)).limit(1).get() ?? null
      : null);
    return JSON.stringify({
      ...common,
      round,
      report,
      reportArtifact: query(() => report
        ? evidenceDb.select({ id: artifacts.id, path: artifacts.path, createdAt: artifacts.createdAt })
          .from(artifacts).where(and(
            eq(artifacts.changeId, run.changeId), eq(artifacts.type, "spec_report"),
            eq(artifacts.path, report.path),
          )).orderBy(desc(artifacts.createdAt), desc(artifacts.id)).limit(1).get() ?? null
        : null),
      authorityRun,
      authorityReport: query(() => authorityRun
        ? evidenceDb.select({
        id: stageReports.id, sourceRunId: stageReports.sourceRunId, status: stageReports.status,
        isFresh: stageReports.isFresh, staleReason: stageReports.staleReason,
        reportDbHash: stageReports.reportDbHash, generatedAt: stageReports.generatedAt,
      }).from(stageReports).where(eq(stageReports.sourceRunId, authorityRun.id))
        .orderBy(desc(stageReports.generatedAt), desc(stageReports.id)).limit(1).get() ?? null
        : null),
      gate,
    });
  }
  if (provider.phase === "review") {
    const state = query(() => evidenceDb.select({
      changeId: reviewState.changeId, latestAttemptId: reviewState.latestAttemptId,
      latestValidReviewReportId: reviewState.latestValidReviewReportId,
      latestValidAttemptNo: reviewState.latestValidAttemptNo, gateStatus: reviewState.gateStatus,
      reviewStatus: reviewState.reviewStatus, sourceBuildRunId: reviewState.sourceBuildRunId,
      sourceHeadSha: reviewState.sourceHeadSha, reportDbHash: reviewState.reportDbHash,
      findingVersion: reviewState.findingVersion, waiverVersion: reviewState.waiverVersion,
      updatedAt: reviewState.updatedAt,
    }).from(reviewState).where(eq(reviewState.changeId, run.changeId)).get() ?? null);
    const attempt = query(() => evidenceDb.select({
      id: reviewAttempts.id, runId: reviewAttempts.runId, attemptNo: reviewAttempts.attemptNo,
      status: reviewAttempts.status, reviewStatus: reviewAttempts.reviewStatus,
      sourceBuildRunId: reviewAttempts.sourceBuildRunId, sourceHeadSha: reviewAttempts.sourceHeadSha,
      priorBlockingFindingIdsJson: reviewAttempts.priorBlockingFindingIdsJson,
      completedAt: reviewAttempts.completedAt, updatedAt: reviewAttempts.updatedAt,
    }).from(reviewAttempts).where(and(
      eq(reviewAttempts.changeId, run.changeId), eq(reviewAttempts.runId, run.id),
    )).limit(1).get() ?? null);
    const boundedPrior = boundedPriorFindingIds(
      attempt?.priorBlockingFindingIdsJson,
      maxReviewFindings,
    );
    const priorFindingIds = boundedPrior.ids;
    const findingScope = attempt
      ? priorFindingIds.length > 0
        ? or(eq(findings.reviewAttemptId, attempt.id), inArray(findings.id, priorFindingIds))
        : eq(findings.reviewAttemptId, attempt.id)
      : eq(findings.id, "");
    return JSON.stringify({
      ...common,
      attempt,
      priorFindingIdsLimitExceeded: boundedPrior.limitExceeded,
      report: query(() => state?.latestValidReviewReportId
        ? evidenceDb.select({
        id: reviewReports.id, attemptId: reviewReports.attemptId, reportVersion: reviewReports.reportVersion,
        reportDbHash: reviewReports.reportDbHash, findingsDbHash: reviewReports.findingsDbHash,
        findingVersion: reviewReports.findingVersion, waiverVersion: reviewReports.waiverVersion,
        gateStatus: reviewReports.gateStatus, staleReason: reviewReports.staleReason,
        reportJson: reviewReports.reportJson,
        sourceBuildRunId: reviewReports.sourceBuildRunId, sourceHeadSha: reviewReports.sourceHeadSha,
        generatedAt: reviewReports.generatedAt, createdAt: reviewReports.createdAt,
      }).from(reviewReports).where(eq(reviewReports.id, state.latestValidReviewReportId)).get() ?? null
        : null),
      settlementFindings: query(() => evidenceDb.select().from(findings).where(and(
        eq(findings.changeId, run.changeId), eq(findings.source, "review"), findingScope,
      )).orderBy(asc(findings.id)).limit(maxReviewFindings + 1).all()),
      state,
      build: query(() => evidenceDb.select({
        id: buildRunRecords.id, runId: buildRunRecords.runId, buildRunId: buildRunRecords.buildRunId,
        status: buildRunRecords.status, headSha: buildRunRecords.headSha,
        baseHeadSha: buildRunRecords.baseHeadSha, baseCommit: buildRunRecords.baseCommit,
        patchHash: buildRunRecords.patchHash, changedFilesHash: buildRunRecords.changedFilesHash,
        adoptedHeadSha: buildRunRecords.adoptedHeadSha, adoptionDecisionId: buildRunRecords.adoptionDecisionId,
        adoptedAt: buildRunRecords.adoptedAt, artifactHash: buildRunRecords.artifactHash,
        source: buildRunRecords.source, updatedAt: buildRunRecords.updatedAt,
      }).from(buildRunRecords).where(and(
        eq(buildRunRecords.changeId, run.changeId),
        inArray(buildRunRecords.status, ["approved_for_absorb", "adopted"]),
      )).orderBy(
        desc(buildRunRecords.adoptedAt), desc(buildRunRecords.updatedAt), desc(buildRunRecords.id),
      ).limit(1).get() ?? null),
    });
  }
  if (provider.phase === "implement" || provider.phase === "fix_findings") {
    return JSON.stringify({
      ...common,
      build: query(() => evidenceDb.select({
        id: buildRunRecords.id, runId: buildRunRecords.runId, buildRunId: buildRunRecords.buildRunId,
        status: buildRunRecords.status, headSha: buildRunRecords.headSha,
        baseHeadSha: buildRunRecords.baseHeadSha, baseCommit: buildRunRecords.baseCommit,
        patchHash: buildRunRecords.patchHash, changedFilesHash: buildRunRecords.changedFilesHash,
        adoptedHeadSha: buildRunRecords.adoptedHeadSha, adoptionDecisionId: buildRunRecords.adoptionDecisionId,
        adoptedAt: buildRunRecords.adoptedAt, artifactHash: buildRunRecords.artifactHash,
        source: buildRunRecords.source, updatedAt: buildRunRecords.updatedAt,
      }).from(buildRunRecords).where(and(
        eq(buildRunRecords.changeId, run.changeId), eq(buildRunRecords.runId, run.id),
      )).limit(1).get() ?? null),
    });
  }
  if (provider.phase === "intake") {
    const actionId = query(() => resolveIntakeActionId(evidenceDb, provider));
    return JSON.stringify({
      ...common,
      actionId,
      artifact: actionId === "run_prd" || actionId === "retry_prd"
        ? query(() => evidenceDb.select({
          id: artifacts.id, runId: artifacts.runId, type: artifacts.type,
          path: artifacts.path, createdAt: artifacts.createdAt,
        }).from(artifacts).where(and(
          eq(artifacts.changeId, run.changeId), eq(artifacts.runId, run.id),
        )).orderBy(desc(artifacts.createdAt), desc(artifacts.id)).limit(1).get() ?? null)
        : null,
      questions: actionId === "run_prd_briefing_questions"
        ? query(() => evidenceDb.select({
          id: briefingQuestions.id, question: briefingQuestions.question,
          whyItMatters: briefingQuestions.whyItMatters, status: briefingQuestions.status,
          answer: briefingQuestions.answer, updatedAt: briefingQuestions.updatedAt,
        }).from(briefingQuestions).where(eq(briefingQuestions.changeId, run.changeId))
          .orderBy(asc(briefingQuestions.id)).all())
        : null,
      draft: actionId === "run_prd_briefing_draft"
        ? query(() => evidenceDb.select({
          id: prdDrafts.id, version: prdDrafts.version, markdown: prdDrafts.markdown,
          draftHash: prdDrafts.draftHash, createdAt: prdDrafts.createdAt,
        }).from(prdDrafts).where(eq(prdDrafts.changeId, run.changeId))
          .orderBy(desc(prdDrafts.version), desc(prdDrafts.createdAt)).limit(1).get() ?? null)
        : null,
      briefing: actionId === "run_prd_briefing_final_review"
        ? query(() => evidenceDb.select({
          id: prdBriefings.id, status: prdBriefings.status,
          finalReviewJson: prdBriefings.finalReviewJson, updatedAt: prdBriefings.updatedAt,
        }).from(prdBriefings).where(eq(prdBriefings.changeId, run.changeId)).get() ?? null)
        : null,
    });
  }
  return JSON.stringify({
    ...common,
    stage: query(() => evidenceDb.select({
      id: stageRuns.id, phase: stageRuns.phase, attemptNo: stageRuns.attemptNo,
      status: stageRuns.status, inputDbHash: stageRuns.inputDbHash,
      outputDbHash: stageRuns.outputDbHash, errorCode: stageRuns.errorCode,
      completedAt: stageRuns.completedAt,
    }).from(stageRuns).where(and(
      eq(stageRuns.changeId, run.changeId),
      eq(stageRuns.phase, documentStagePhases[provider.phase] ?? provider.phase),
      eq(stageRuns.attemptNo, run.attemptNo ?? provider.attemptNo ?? 0),
    )).limit(1).get() ?? null),
    artifact: query(() => evidenceDb.select({
      id: artifacts.id, runId: artifacts.runId, type: artifacts.type, path: artifacts.path, createdAt: artifacts.createdAt,
    }).from(artifacts).where(and(
      eq(artifacts.changeId, run.changeId), eq(artifacts.runId, run.id),
    )).orderBy(desc(artifacts.createdAt), desc(artifacts.id)).limit(1).get() ?? null),
  });
}
