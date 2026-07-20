import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { changes, projects, runs } from "@/server/db/schema";
import {
  canEditPhaseArtifacts,
  savePhaseArtifactContent,
} from "@/server/services/phase-artifact-service";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;

  const change = db
    .select()
    .from(changes)
    .where(and(eq(changes.id, changeId), eq(changes.projectId, projectId)))
    .get();
  if (!change) {
    return NextResponse.json({ error: "Change not found" }, { status: 404 });
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const latestRun = db
    .select()
    .from(runs)
    .where(eq(runs.changeId, changeId))
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  const latestRunStatus = latestRun?.status ?? null;

  if (!canEditPhaseArtifacts({ status: change.status, latestRunStatus })) {
    return NextResponse.json(
      { error: "Editing is disabled while this change is running" },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "JSON object body required" }, { status: 400 });
  }
  const payload = body as { path?: unknown; content?: unknown };
  if (typeof payload.path !== "string") {
    return NextResponse.json({ error: "path field required" }, { status: 400 });
  }
  if (typeof payload.content !== "string") {
    return NextResponse.json({ error: "content field required" }, { status: 400 });
  }

  try {
    const result = savePhaseArtifactContent({
      repoPath: project.repoPath,
      changeId,
      artifactPath: payload.path,
      content: payload.content,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
