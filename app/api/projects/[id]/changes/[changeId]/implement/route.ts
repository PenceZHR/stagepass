import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  changeArtifactIgnoredPrefixes,
  checkGitBaseCamp,
} from "@/server/services/build-workspace-service";
import { db } from "@/server/db";
import { projects } from "@/server/db/schema";
import { PreflightValidationError } from "@/server/services/preflight-service";
import { assertRetryBuildCanStart } from "@/server/services/build-stale-run-recovery-service";
import { enqueueProviderActionAtomically } from "@/server/services/job-dispatch-service";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
  resolveRequestIdempotencyKey,
  resolveRequestProvider,
} from "../action-preflight";
import { requireProjectChange } from "../route-guard";

function implementActionId(value: unknown): "run_build" | "retry_build" {
  if (value === undefined) return "run_build";
  if (value === "run_build" || value === "retry_build") return value;
  throw new PreflightValidationError(
    "invalid_preflight_input",
    "actionId must be run_build or retry_build",
  );
}

function getProjectRepoPath(projectId: string): string | null {
  const project = db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, projectId)).get();
  return project?.repoPath ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const payload = await readActionPayload(request);
    const actionId = implementActionId(payload.actionId);
    const actionContract = await assertRequestActionAllowed({ changeId, actionId, payload, request });

    const repoPath = getProjectRepoPath(projectId);
    if (!repoPath) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const baseCamp = checkGitBaseCamp(repoPath, {
      ignoredPrefixes: changeArtifactIgnoredPrefixes(changeId),
    });
    if (!baseCamp.headSha || baseCamp.blockers.length > 0) {
      const details =
        baseCamp.blockers.length > 0
          ? baseCamp.blockers.join("; ")
          : "Git HEAD is missing.";
      return NextResponse.json(
        {
          error: `Build workspace base camp blocked: ${details}`,
          baseCamp,
          blockers: baseCamp.blockers,
        },
        { status: 409 }
      );
    }
    if (actionId === "retry_build") {
      assertRetryBuildCanStart(guard.change.status, changeId);
    }
    const idempotencyKey = resolveRequestIdempotencyKey(payload, request);
    const { job } = enqueueProviderActionAtomically({
      changeId,
      phase: "implement",
      actionId,
      idempotencyKey,
      provider: resolveRequestProvider(payload),
    }, actionContract);
    return NextResponse.json(
      { success: true, accepted: true, jobId: job.id, provider: payload.provider === undefined ? undefined : job.provider, status: "queued" },
      { status: 202 },
    );
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
