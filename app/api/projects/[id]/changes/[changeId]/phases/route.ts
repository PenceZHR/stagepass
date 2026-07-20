import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { stageGates, stageReports, stageStates } from "@/server/db/schema";
import { computeActions } from "@/server/services/action-contract-service";
import { inspectArtifactMirrors } from "@/server/services/artifact-mirror-service";
import {
  CONTENT_PHASES,
  getChangePhaseReview,
  normalizeReviewPhase,
} from "@/server/services/change-phase-service";
import { requireProjectChange } from "../route-guard";

const PhaseQuery = z.object({
  phase: z.string().optional(),
  runId: z.string().optional(),
});

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safePhaseReviewDto(review: Awaited<ReturnType<typeof getChangePhaseReview>>) {
  return {
    phases: review.phases.map((phase) => ({
      phase: phase.phase,
      available: phase.available,
      artifactCount: phase.artifactCount,
      runCount: phase.runCount,
      eventCount: phase.eventCount,
      legacyWarning: phase.legacyWarning ?? false,
      stageAuthority: phase.stageAuthority ?? null,
    })),
    selected: {
      phase: review.selected.phase,
      selectedRunId: review.selected.selectedRunId,
      artifacts: review.selected.artifacts.map((artifact) => ({
        id: artifact.id,
        type: artifact.type,
        fileName: artifact.fileName,
        impactLabel: artifact.impactLabel,
        runId: artifact.runId,
        createdAt: artifact.createdAt,
        source: artifact.source,
        missing: artifact.missing,
        advanced: artifact.advanced ?? false,
        content: artifact.content,
        editablePath: artifact.editablePath,
      })),
      runs: review.selected.runs.map((run) => ({
        id: run.id,
        phase: run.phase,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      })),
      events: review.selected.events.map((event) => ({
        id: event.id,
        type: event.type,
        message: event.message,
        createdAt: event.createdAt,
        runId: event.runId,
      })),
      legacyImports: review.selected.legacyImports.map((legacyImport) => ({
        id: legacyImport.id,
        phase: legacyImport.phase,
        sourceArtifactHash: legacyImport.sourceArtifactHash,
        schemaVersion: legacyImport.schemaVersion,
        importStatus: legacyImport.importStatus,
        importedAt: legacyImport.importedAt,
      })),
    },
  };
}

function dbFirstPhaseDto(changeId: string, review: Awaited<ReturnType<typeof getChangePhaseReview>>) {
  const stateRows = db.select().from(stageStates).where(eq(stageStates.changeId, changeId)).all();
  const gateRows = db.select().from(stageGates).where(eq(stageGates.changeId, changeId)).all();
  const reportRows = db.select().from(stageReports).where(eq(stageReports.changeId, changeId)).all();
  const latestValidReportIds = new Set(
    stateRows.map((state) => state.latestValidReportId).filter((id): id is string => Boolean(id))
  );

  return {
    stageStates: stateRows.map((state) => ({
      id: state.id,
      phase: state.phase,
      status: state.status,
      latestRunId: state.latestRunId,
      latestReportId: state.latestReportId,
      latestGateId: state.latestGateId,
      latestValidReportId: state.latestValidReportId,
      dbHash: state.dbHash,
      version: state.version,
      updatedAt: state.updatedAt,
    })),
    stageGates: gateRows.map((gate) => ({
      id: gate.id,
      phase: gate.phase,
      status: gate.status,
      blockers: parseJson(gate.blockersJson),
      freshness: parseJson(gate.freshnessJson),
      requiredActions: parseJson(gate.requiredActionsJson),
      sourceDbHash: gate.sourceDbHash,
      gateVersion: gate.gateVersion,
      computedAt: gate.computedAt,
    })),
    actions: computeActions(changeId),
    mirrorWarnings: inspectArtifactMirrors(changeId, undefined, { persistStatus: false }).map((warning) => ({
      id: warning.id,
      phase: warning.phase,
      artifactType: warning.artifactType,
      mirrorStatus: warning.mirrorStatus,
      warning: warning.warning,
      generatedAt: warning.generatedAt,
    })),
    legacyWarnings: review.phases
      .filter((phase) => phase.legacyWarning)
      .map((phase) => ({
        phase: phase.phase,
        imports: (phase.legacyImports ?? []).map((legacyImport) => ({
          id: legacyImport.id,
          phase: legacyImport.phase,
          sourceArtifactHash: legacyImport.sourceArtifactHash,
          schemaVersion: legacyImport.schemaVersion,
          importStatus: legacyImport.importStatus,
          importedAt: legacyImport.importedAt,
        })),
      })),
    latestValidReports: reportRows
      .filter((report) => latestValidReportIds.has(report.id))
      .map((report) => ({
        id: report.id,
        phase: report.phase,
        sourceRunId: report.sourceRunId,
        status: report.status,
        counts: parseJson(report.countsJson),
        isFresh: report.isFresh,
        staleReason: report.staleReason,
        reportDbHash: report.reportDbHash,
        generatedAt: report.generatedAt,
      })),
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  const { searchParams } = new URL(request.url);
  const parsed = PhaseQuery.safeParse({
    phase: searchParams.get("phase") ?? undefined,
    runId: searchParams.get("runId") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const phase = normalizeReviewPhase(parsed.data.phase ?? "Refine");
  if (!phase) {
    return NextResponse.json(
      { error: `Unsupported phase. Use ${CONTENT_PHASES.join(", ")}.` },
      { status: 400 }
    );
  }

  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const review = await getChangePhaseReview(
      projectId,
      changeId,
      phase,
      parsed.data.runId ?? null
    );
    return NextResponse.json({
      ...safePhaseReviewDto(review),
      ...dbFirstPhaseDto(changeId, review),
    });
  } catch (err: unknown) {
    console.error("Phase review request failed", { changeId, error: err });
    return NextResponse.json({
      error: { code: "PHASE_REVIEW_UNAVAILABLE", message: "Phase review is unavailable" },
    }, { status: 500 });
  }
}
