import { NextResponse } from "next/server";
import { getProject } from "@/server/services/project-service";
import { suggestCommitMessage } from "@/server/services/commit-message-service";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const message = await suggestCommitMessage(project.repoPath);
    return NextResponse.json({ message });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
