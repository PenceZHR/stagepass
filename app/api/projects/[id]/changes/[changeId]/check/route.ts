import { NextResponse } from "next/server";
import { assertCanRunCheck } from "@/server/services/pipeline-service";
import {
  assertActionAllowedAsync,
  PreflightBlockedError,
  PreflightValidationError,
} from "@/server/services/preflight-service";
import { enqueueProviderActionAtomically } from "@/server/services/job-dispatch-service";
import { requireProjectChange } from "../route-guard";
import { actionPreflightErrorResponse, resolveRequestProviderForAction } from "../action-preflight";

type CheckPayload = {
  actionId?: unknown;
  expectedGateVersion?: unknown;
  expectedSourceDbHash?: unknown;
  expectedHeadSha?: unknown;
  idempotencyKey?: unknown;
  provider?: unknown;
};

function normalizePreflightField(value: unknown, field: string): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === undefined) return null;
  throw new PreflightValidationError("invalid_preflight_input", `${field} must be a string or number`);
}

async function readCheckPayload(request: Request): Promise<CheckPayload> {
  const rawBody = await request.text();
  if (rawBody.trim().length === 0) return {};

  const payload = JSON.parse(rawBody) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PreflightValidationError("invalid_preflight_input", "JSON object body required");
  }
  return payload as CheckPayload;
}

function checkActionId(value: unknown): "enter_qa" | "run_qa" | "retry_qa" {
  if (value === "run_qa" || value === "retry_qa") return value;
  return "enter_qa";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;

    const payload = await readCheckPayload(request);
    const actionId = checkActionId(payload.actionId);
    resolveRequestProviderForAction(actionId, payload);
    const idempotencyKey =
      typeof payload.idempotencyKey === "string"
        ? payload.idempotencyKey
        : request.headers.get("idempotency-key") ?? request.headers.get("x-idempotency-key") ?? undefined;
    const expectedGateVersion = normalizePreflightField(
      payload.expectedGateVersion,
      "expectedGateVersion"
    );
    const expectedSourceDbHash = normalizePreflightField(
      payload.expectedSourceDbHash,
      "expectedSourceDbHash"
    );
    const expectedHeadSha = normalizePreflightField(payload.expectedHeadSha, "expectedHeadSha");

    const actionContract = await assertActionAllowedAsync({
      changeId,
      actionId,
      expectedGateVersion: expectedGateVersion ?? "",
      expectedSourceDbHash: expectedSourceDbHash ?? "",
      expectedHeadSha: expectedHeadSha ?? undefined,
      idempotencyKey,
    });
    assertCanRunCheck(changeId, {
      entrypoint: "api_check_route",
      actor: "human",
      expectedHeadSha: expectedHeadSha ?? undefined,
    });
    const { job } = enqueueProviderActionAtomically({
      changeId,
      phase: "local_check",
      actionId,
      idempotencyKey,
    }, actionContract);
    return NextResponse.json(
      { success: true, accepted: true, jobId: job.id, status: "queued" },
      { status: 202 },
    );
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    if (err instanceof PreflightValidationError) {
      return NextResponse.json(
        { error: err.message, reasonCode: err.reasonCode },
        { status: err.status }
      );
    }
    if (err instanceof PreflightBlockedError) {
      if (err.envelope.error !== "action_not_allowed") {
        return NextResponse.json(err.envelope, { status: 409 });
      }
      return NextResponse.json(err.envelope, { status: err.status });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
