import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import {
  getChangeForProject,
  deleteChange,
} from "@/server/services/change-service";
import { db } from "@/server/db";
import { runs, findings, artifacts, projects } from "@/server/db/schema";
import fs from "fs";
import path from "path";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
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
