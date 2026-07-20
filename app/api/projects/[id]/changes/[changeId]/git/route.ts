import { NextResponse } from "next/server";

import {
  commitWithMessage,
  defaultChangeCommitMessage,
  initRepo,
} from "@/server/services/git-service";
import { PreflightValidationError } from "@/server/services/preflight-service";
import { getProject } from "@/server/services/project-service";
import { syncProjectGitState } from "@/server/services/project-git-state-service";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
  type ActionPreflightPayload,
} from "../action-preflight";
import { requireProjectChange } from "../route-guard";

/**
 * The change-scoped git actions.
 *
 * POST /api/projects/[id]/git already committed and initialised, but entirely
 * outside the pipeline: no preflight, no action contract, no changeId, so a
 * commit could not be attributed to the change it belonged to and the contract
 * never knew one had happened. This route is the same two capabilities behind
 * assertRequestActionAllowed, which is what makes them ordinary pipeline
 * actions -- routable from the stage bar, refused when the contract says they
 * are unavailable, and refused again when HEAD has moved since the contract was
 * issued (action-contract-git-policy stamps sourceDbHash from HEAD).
 */

type GitActionId = "init_git_repo" | "commit_changes";

function gitActionId(value: unknown): GitActionId {
  if (value === "init_git_repo" || value === "commit_changes") return value;
  throw new PreflightValidationError(
    "invalid_preflight_input",
    "actionId must be init_git_repo or commit_changes",
  );
}

function commitPaths(payload: ActionPreflightPayload): string[] | undefined {
  const raw = payload.paths;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new PreflightValidationError("invalid_preflight_input", "paths must be an array of strings");
  }
  const paths = (raw as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return paths.length > 0 ? paths : undefined;
}

function commitMessage(payload: ActionPreflightPayload, change: { id: string; title: string }): string {
  const raw = payload.message;
  if (raw === undefined || raw === null) return defaultChangeCommitMessage(change.id, change.title);
  if (typeof raw !== "string") {
    throw new PreflightValidationError("invalid_preflight_input", "message must be a string");
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : defaultChangeCommitMessage(change.id, change.title);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const project = await getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const payload = await readActionPayload(request);
    const actionId = gitActionId(payload.actionId);
    // Parses/validates provider, gate version, source hash and idempotency key,
    // and throws PreflightBlockedError with the live contract when the action is
    // not allowed -- the same 409 envelope every other action route returns.
    await assertRequestActionAllowed({ changeId, actionId, payload, request });

    if (actionId === "init_git_repo") {
      initRepo(project.repoPath);
      await syncProjectGitState(projectId);
      return NextResponse.json({ success: true, message: "Git repository initialized" });
    }

    const { sha } = commitWithMessage(
      project.repoPath,
      commitMessage(payload, guard.change),
      commitPaths(payload),
    );
    await syncProjectGitState(projectId);
    return NextResponse.json({ success: true, sha, message: `Committed: ${sha}` });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
