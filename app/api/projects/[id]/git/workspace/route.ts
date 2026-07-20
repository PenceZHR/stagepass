import { NextResponse } from "next/server";
import { getProject } from "@/server/services/project-service";
import { getWorkingTreeStatus } from "@/server/services/git-service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const status = getWorkingTreeStatus(project.repoPath);
  return NextResponse.json(status);
}
