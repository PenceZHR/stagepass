import { NextResponse } from "next/server";
import { preflightReviewRun } from "@/server/services/pipeline-service";
import { PreflightValidationError } from "@/server/services/preflight-service";
import { enqueueProviderActionAtomically } from "@/server/services/job-dispatch-service";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
  resolveRequestIdempotencyKey,
  resolveRequestProvider,
} from "../action-preflight";
import { requireProjectChange } from "../route-guard";

function reviewActionId(value: unknown): "run_review" | "retry_review" {
  if (value === undefined) return "run_review";
  if (value === "run_review" || value === "retry_review") return value;
  throw new PreflightValidationError(
    "invalid_preflight_input",
    "actionId must be run_review or retry_review",
  );
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
    const actionId = reviewActionId(payload.actionId);
    const actionContract = await assertRequestActionAllowed({ changeId, actionId, payload, request });

    preflightReviewRun(changeId);
    const idempotencyKey = resolveRequestIdempotencyKey(payload, request);
    const { job } = enqueueProviderActionAtomically({
      changeId,
      phase: "review",
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
    return NextResponse.json(
      { error: "Review request failed", reasonCode: "internal_error" },
      { status: 500 },
    );
  }
}
