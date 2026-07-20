import { NextResponse } from "next/server";
import { enqueueProviderActionAtomically } from "@/server/services/job-dispatch-service";
import {
  assertCanStartPrdBriefingFinalReview,
  PrdBriefingError,
} from "@/server/services/prd-briefing-service";
import {
  actionPreflightErrorResponse,
  readActionPayload,
  resolveRequestIdempotencyKey,
  resolveRequestProvider,
} from "../../action-preflight";
import { requireProjectChange } from "../../route-guard";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const payload = await readActionPayload(request);
    assertCanStartPrdBriefingFinalReview(changeId);
    const { job } = enqueueProviderActionAtomically({
      changeId,
      phase: "prd_briefing_final_review",
      actionId: "run_prd_briefing_final_review",
      idempotencyKey: resolveRequestIdempotencyKey(payload, request),
      provider: resolveRequestProvider(payload),
    });
    return NextResponse.json(
      { success: true, accepted: true, jobId: job.id, provider: payload.provider === undefined ? undefined : job.provider, status: "queued" },
      { status: 202 },
    );
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof PrdBriefingError) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
