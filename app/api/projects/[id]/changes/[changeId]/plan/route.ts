import { NextResponse } from "next/server";
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

function planActionId(value: unknown): "run_plan" | "retry_plan" {
  if (value === undefined) return "run_plan";
  if (value === "run_plan" || value === "retry_plan") return value;
  throw new PreflightValidationError(
    "invalid_preflight_input",
    "actionId must be run_plan or retry_plan",
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
    const actionId = planActionId(payload.actionId);
    const actionContract = await assertRequestActionAllowed({ changeId, actionId, payload, request });
    const idempotencyKey = resolveRequestIdempotencyKey(payload, request);
    const { job } = enqueueProviderActionAtomically({
      changeId,
      phase: "generate_plan",
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
