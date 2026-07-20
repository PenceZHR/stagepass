import { NextResponse } from "next/server";
import { getProject } from "@/server/services/project-service";
import { getChangeForProject } from "@/server/services/change-service";
import { suggestCommitMessage } from "@/server/services/commit-message-service";

/**
 * Optional `{ changeId }` body: suggestCommitMessage has always taken change
 * context, but this route never supplied any, so every suggestion was written as
 * if the diff belonged to nobody. A changeId that does not resolve to a change
 * of this project is ignored rather than rejected -- the suggestion is advisory
 * and must not fail closed on it.
 */
async function readChangeContext(
  request: Request,
  projectId: string,
): Promise<{ changeId: string; changeTitle: string } | undefined> {
  try {
    const rawBody = await request.text();
    if (rawBody.trim().length === 0) return undefined;
    const payload = JSON.parse(rawBody) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const changeId = (payload as { changeId?: unknown }).changeId;
    if (typeof changeId !== "string" || changeId.trim().length === 0) return undefined;
    const change = await getChangeForProject(projectId, changeId.trim());
    if (!change) return undefined;
    return { changeId: change.id, changeTitle: change.title };
  } catch {
    return undefined;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const context = await readChangeContext(request, id);
    const message = await suggestCommitMessage(project.repoPath, context);
    return NextResponse.json({ message });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
