import { NextResponse } from "next/server";
import { getSpecBattleState } from "@/server/services/spec-battle-service";
import { PreflightValidationError } from "@/server/services/preflight-service";
import { enqueueProviderActionAtomically } from "@/server/services/job-dispatch-service";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
  resolveRequestIdempotencyKey,
  resolveRequestProvider,
  type ActionPreflightPayload,
} from "../action-preflight";
import { requireProjectChange } from "../route-guard";

function specActionId(changeId: string, payload: ActionPreflightPayload): "run_spec" | "retry_spec" {
  const value = payload.actionId;
  if (value === "run_spec" || value === "retry_spec") return value;
  if (value !== undefined && value !== null) {
    throw new PreflightValidationError(
      "invalid_preflight_input",
      "actionId must be run_spec or retry_spec",
    );
  }

  const latestRound = getSpecBattleState(changeId).latestRound;
  if (latestRound?.status === "failed") return "retry_spec";
  return "run_spec";
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
    const actionId = specActionId(changeId, payload);
    const actionContract = await assertRequestActionAllowed({ changeId, actionId, payload, request });
    const idempotencyKey = resolveRequestIdempotencyKey(payload, request);
    const { job } = enqueueProviderActionAtomically({
      changeId,
      phase: "spec",
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
