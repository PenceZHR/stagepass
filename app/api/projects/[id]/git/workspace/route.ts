import { NextResponse } from "next/server";
import { getProject } from "@/server/services/project-service";
import { getWorkingTreeStatus, hasCommits, isGitRepo } from "@/server/services/git-service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // getWorkingTreeStatus reports `clean: true` for a path that is not a
  // repository at all -- the same shape it reports for a genuinely clean tree.
  // The panel rendered that as "工作区干净，没有未提交的改动", i.e. it told the
  // user everything was fine on precisely the projects that were stuck at
  // build_base_camp_blocked / "Path is not a git repository." Reporting the two
  // facts separately is what lets the panel tell those states apart.
  const repo = isGitRepo(project.repoPath);
  const status = getWorkingTreeStatus(project.repoPath);
  return NextResponse.json({
    ...status,
    isRepo: repo,
    hasCommits: repo ? hasCommits(project.repoPath) : false,
  });
}
