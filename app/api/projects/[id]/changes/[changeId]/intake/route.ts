import { NextResponse } from "next/server";
import { enqueueProviderActionAtomically } from "@/server/services/job-dispatch-service";
import { PreflightValidationError } from "@/server/services/preflight-service";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
  resolveRequestIdempotencyKey,
  resolveRequestProvider,
} from "../action-preflight";
import { requireProjectChange } from "../route-guard";

function intakeActionId(value: unknown): "run_prd" | "retry_prd" {
  if (value === undefined) return "run_prd";
  if (value === "run_prd" || value === "retry_prd") return value;
  throw new PreflightValidationError(
    "invalid_preflight_input",
    "actionId must be run_prd or retry_prd",
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
    const actionId = intakeActionId(payload.actionId);
    const actionContract = await assertRequestActionAllowed({ changeId, actionId, payload, request });
    const idempotencyKey = resolveRequestIdempotencyKey(payload, request);
    const { job } = enqueueProviderActionAtomically({
      changeId,
      phase: "intake",
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
