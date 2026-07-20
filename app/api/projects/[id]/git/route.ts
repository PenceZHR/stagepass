import { NextResponse } from "next/server";
import { getProject } from "@/server/services/project-service";
import { syncProjectGitState } from "@/server/services/project-git-state-service";
import {
  isGitRepo,
  getSetupStatus,
  initRepo,
  initialCommit,
  hasCommits,
  createRemoteRepo,
  setupGhAuth,
  pushCurrentBranch,
  getRemoteUrl,
  commitWithMessage,
} from "@/server/services/git-service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const syncedProject = await syncProjectGitState(id);
  const status = getSetupStatus(syncedProject.repoPath);
  return NextResponse.json({
    ...status,
    gitEnabled: !!syncedProject.gitEnabled,
    defaultBranch: syncedProject.gitDefaultBranch,
  });
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

  const body = await request.json();
  const { action, repoName, visibility, message: commitMsg, paths } = body as {
    action: "init" | "commit" | "commit_changes" | "create_remote" | "push" | "full_setup";
    repoName?: string;
    visibility?: "private" | "public";
    message?: string;
    paths?: string[];
  };

  const repoPath = project.repoPath;

  async function successResponse(payload: Record<string, unknown>) {
    const syncedProject = await syncProjectGitState(id);
    return NextResponse.json({
      ...payload,
      gitEnabled: !!syncedProject.gitEnabled,
      defaultBranch: syncedProject.gitDefaultBranch,
    });
  }

  try {
    switch (action) {
      case "init": {
        if (isGitRepo(repoPath)) {
          return NextResponse.json({ error: "Already a git repository" }, { status: 400 });
        }
        initRepo(repoPath);
        return successResponse({ success: true, message: "Git repository initialized" });
      }

      case "commit": {
        if (!isGitRepo(repoPath)) {
          return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        }
        initialCommit(repoPath);
        return successResponse({ success: true, message: "Initial commit created" });
      }

      case "commit_changes": {
        if (!isGitRepo(repoPath)) {
          return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        }
        if (!commitMsg?.trim()) {
          return NextResponse.json({ error: "message is required" }, { status: 400 });
        }
        const { sha } = commitWithMessage(repoPath, commitMsg.trim(), paths);
        return successResponse({ success: true, sha, message: `Committed: ${sha}` });
      }

      case "create_remote": {
        if (!repoName) {
          return NextResponse.json({ error: "repoName is required" }, { status: 400 });
        }
        setupGhAuth();
        const url = createRemoteRepo(repoPath, repoName, visibility || "private");
        return successResponse({ success: true, url, message: `Remote repository created: ${url}` });
      }

      case "push": {
        setupGhAuth();
        pushCurrentBranch(repoPath);
        return successResponse({ success: true, message: "Pushed to remote" });
      }

      case "full_setup": {
        const name = repoName || project.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const vis = visibility || "private";

        // Step 1: init if needed
        if (!isGitRepo(repoPath)) {
          initRepo(repoPath);
        }

        // Step 2: commit if no commits
        if (!hasCommits(repoPath)) {
          initialCommit(repoPath);
        }

        // Step 3: create remote and push
        setupGhAuth();
        let url: string;
        const existingRemote = getRemoteUrl(repoPath);
        if (existingRemote) {
          pushCurrentBranch(repoPath);
          url = existingRemote;
        } else {
          url = createRemoteRepo(repoPath, name, vis);
        }

        return successResponse({
          success: true,
          url,
          message: `Full setup complete. Repository: ${url}`,
        });
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
