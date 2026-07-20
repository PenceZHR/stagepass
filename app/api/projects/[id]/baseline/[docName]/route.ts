import { NextResponse } from "next/server";
import { readBaselineDoc } from "@/server/services/baseline-service";
import { getProject } from "@/server/services/project-service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docName: string }> }
) {
  const { id, docName } = await params;
  const project = await getProject(id);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    return NextResponse.json(readBaselineDoc(project.repoPath, docName));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

