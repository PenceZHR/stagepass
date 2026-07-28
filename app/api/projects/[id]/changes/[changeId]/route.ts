import { NextResponse } from "next/server";
import { projectCodexStageControl } from "@/server/services/codex-stage-control-projection";
import { and, eq, desc, inArray } from "drizzle-orm";
import {
  getChangeForProject,
  deleteChange,
} from "@/server/services/change-service";
import { db } from "@/server/db";
import {
  runs,
  findings,
  artifacts,
  projects,
  codexInteractions,
  codexThreadBindings,
} from "@/server/db/schema";
import { readCodexNativeFlags } from "@/server/config/codex-native-flags";
import {
  CODEX_DECISION_INTERACTION_KINDS,
  CODEX_DECISION_PHASES,
  isCodexDecisionSurfaceEnabled,
  type CodexDecisionInteractionKind,
  type CodexDecisionPhase,
} from "@/server/config/codex-decision-rollout";
import fs from "fs";
import path from "path";

function rolloutTargetForStatus(status: string): {
  phase: CodexDecisionPhase;
  kind: CodexDecisionInteractionKind;
} | null {
  if (status.startsWith("INTAKE")) return { phase: "Intake", kind: "gate_decision" };
  if (status.startsWith("SPEC") || status === "SPECCING") return { phase: "Spec", kind: "gate_decision" };
  if (status.startsWith("TECHSPEC")) return { phase: "TechSpec", kind: "gate_decision" };
  if (status.startsWith("PLAN") || status === "PLANNING") return { phase: "Plan", kind: "risk_waiver" };
  if (status.startsWith("TESTPLAN")) return { phase: "TestPlan", kind: "gate_decision" };
  if (status === "IMPLEMENTING" || status === "IMPLEMENTED") return { phase: "Build", kind: "build_adoption" };
  if (status === "FIXING") return { phase: "Fix", kind: "build_adoption" };
  if (status === "REVIEWING" || status === "LOCAL_READY" || status === "BLOCKED") {
    return { phase: "Review", kind: "review_resolution" };
  }
  if (status === "CHECKING" || status === "CHECK_FAILED") return { phase: "QA", kind: "gate_decision" };
  if (status === "MERGE_READY" || status === "MERGING") return { phase: "Merge", kind: "merge_decision" };
  return null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  // Each stage owns its own Codex task, so the page asks for the stage it is
  // showing. Without one, fall back to the change-wide reading a client that
  // predates per-stage tasks expects.
  const requestedStage = new URL(request.url).searchParams.get("stage");
  const change = await getChangeForProject(projectId, changeId);

  if (!change) {
    return NextResponse.json({ error: "Change not found" }, { status: 404 });
  }
  const recoveredChange = change;

  // Enrich with latest run, findings summary, changed files
  const latestRun = db
    .select()
    .from(runs)
    .where(eq(runs.changeId, changeId))
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  const testPlanCompleted = db
    .select()
    .from(runs)
    .where(eq(runs.changeId, changeId))
    .all()
    .some((run) => run.phase === "test_plan" && run.status === "completed");

  const allFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all();

  const openFindings = allFindings.filter((f) => f.status === "open").length;
  const totalFindings = allFindings.length;

  const allArtifacts = db
    .select()
    .from(artifacts)
    .where(eq(artifacts.changeId, changeId))
    .all();

  const stageControl = requestedStage
    ? projectCodexStageControl({ changeId, projectId, stageId: requestedStage })
    : null;
  const binding = db.select().from(codexThreadBindings).where(and(
    eq(codexThreadBindings.scopeKind, "change"),
    eq(codexThreadBindings.scopeId, changeId),
    eq(codexThreadBindings.projectId, projectId),
    eq(codexThreadBindings.changeId, changeId),
  )).get();
  const interaction = db.select().from(codexInteractions).where(and(
    eq(codexInteractions.changeId, changeId),
    inArray(codexInteractions.status, ["pending", "presented", "submitting"]),
  )).orderBy(desc(codexInteractions.createdAt)).limit(1).get();
  const interactionTarget =
    interaction
    && CODEX_DECISION_PHASES.includes(interaction.phase as CodexDecisionPhase)
    && CODEX_DECISION_INTERACTION_KINDS.includes(
      interaction.kind as CodexDecisionInteractionKind,
    )
      ? {
          phase: interaction.phase as CodexDecisionPhase,
          kind: interaction.kind as CodexDecisionInteractionKind,
        }
      : null;
  const rolloutTarget = interactionTarget ?? rolloutTargetForStatus(change.status);
  const flags = readCodexNativeFlags();
  const codexDecisionEnabled = rolloutTarget
    ? isCodexDecisionSurfaceEnabled(rolloutTarget, flags)
    : false;

  // Try to read changed-files.json from .ship
  let changedFiles: string[] = [];
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, recoveredChange.projectId))
    .get();

  if (project) {
    const cfPath = path.join(
      project.repoPath,
      ".ship",
      "changes",
      changeId,
      "changed-files.json"
    );
    if (fs.existsSync(cfPath)) {
      try {
        changedFiles = JSON.parse(fs.readFileSync(cfPath, "utf-8"));
      } catch {}
    }
  }

  return NextResponse.json({
    ...recoveredChange,
    latestRun: latestRun || null,
    testPlanCompleted,
    findingsSummary: { open: openFindings, total: totalFindings },
    changedFiles,
    artifactCount: allArtifacts.length,
    codexControl: {
      bindingTitle: stageControl?.bindingTitle ?? binding?.title ?? null,
      bindingStatus: stageControl?.bindingStatus ?? binding?.status ?? "detached",
      threadId: stageControl ? stageControl.threadId : binding?.threadId ?? null,
      lastTurnId: stageControl ? stageControl.lastTurnId : binding?.lastTurnId ?? null,
      lastObservationCursor: stageControl
        ? stageControl.lastObservationCursor
        : binding?.lastObservationCursor ?? null,
      lastSeenAt: stageControl ? stageControl.lastSeenAt : binding?.lastSeenAt ?? null,
      lastErrorCode: stageControl ? stageControl.lastErrorCode : binding?.lastErrorCode ?? null,
      currentInteractionId: interaction?.id ?? null,
      codexDecisionEnabled,
      decisionPhase: rolloutTarget?.phase ?? null,
      interactionKind: rolloutTarget?.kind ?? null,
      model: recoveredChange.codexModel ?? null,
      reasoningEffort: recoveredChange.reasoningEffort ?? null,
    },
  });
}

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  const change = await getChangeForProject(projectId, changeId);
  if (!change) {
    return NextResponse.json({ error: "Change not found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      error: "Direct status mutation is not allowed from this route. Use pipeline/gate-specific actions instead.",
    },
    { status: 400 }
  );
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const change = await getChangeForProject(projectId, changeId);
    if (!change) {
      return NextResponse.json({ error: "Change not found" }, { status: 404 });
    }
    await deleteChange(changeId);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
