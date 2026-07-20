import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "@/server/db";
import { artifacts, projects } from "@/server/db/schema";
import { savePhaseArtifactContent } from "@/server/services/phase-artifact-service";
import { requireProjectChange } from "../../../route-guard";

function isPathSafe(filePath: string, repoPath: string): boolean {
  const resolved = path.resolve(filePath);
  const repoResolved = path.resolve(repoPath);
  return resolved.startsWith(repoResolved + path.sep) || resolved === repoResolved;
}

function isMetadataOnlyArtifactType(type: string): boolean {
  return type === "stage_raw_output" || type === "raw_review_output" || type === "review_raw_output";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string; artifactId: string }> }
) {
  const { id: projectId, changeId, artifactId } = await params;
  const guard = await requireProjectChange(projectId, changeId);
  if (guard.response) return guard.response;

  const artifact = db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.changeId, changeId)))
    .get();

  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }
  if (isMetadataOnlyArtifactType(artifact.type)) {
    return NextResponse.json({ error: "Artifact content is metadata-only" }, { status: 403 });
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!isPathSafe(artifact.path, project.repoPath)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  if (!fs.existsSync(artifact.path)) {
    return NextResponse.json({ error: "File not found on disk" }, { status: 404 });
  }

  const content = fs.readFileSync(artifact.path, "utf-8");
  const ext = path.extname(artifact.path).toLowerCase();
  const mimeType = ext === ".json" ? "application/json" : "text/plain";

  return NextResponse.json({ content, mimeType, path: artifact.path });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string; artifactId: string }> }
) {
  const { id: projectId, changeId, artifactId } = await params;
  const guard = await requireProjectChange(projectId, changeId);
  if (guard.response) return guard.response;

  const change = guard.change;
  if (!change) {
    return NextResponse.json({ error: "Change not found" }, { status: 404 });
  }

  if (change.status !== "PLAN_READY") {
    return NextResponse.json(
      { error: "Editing only allowed in PLAN_READY status" },
      { status: 400 }
    );
  }

  const artifact = db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.changeId, changeId)))
    .get();

  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }
  if (isMetadataOnlyArtifactType(artifact.type)) {
    return NextResponse.json({ error: "Artifact content is metadata-only" }, { status: 403 });
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!isPathSafe(artifact.path, project.repoPath)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content field required" }, { status: 400 });
  }

  try {
    const saved = savePhaseArtifactContent({
      repoPath: project.repoPath,
      changeId,
      artifactPath: artifact.path,
      content: body.content,
    });
    return NextResponse.json({ success: true, path: saved.path });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
