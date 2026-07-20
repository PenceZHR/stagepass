import { NextResponse } from "next/server";
import { approvePlan } from "@/server/services/pipeline-service";
import {
  assertActionAllowedAsync,
  PreflightBlockedError,
  PreflightValidationError,
} from "@/server/services/preflight-service";
import { requireProjectChange } from "../route-guard";
import { resolveRequestProviderForAction, type ActionPreflightPayload } from "../action-preflight";

type ApprovePlanPayload = {
  p1Waivers?: unknown;
  expectedGateVersion?: unknown;
  expectedSourceDbHash?: unknown;
  idempotencyKey?: unknown;
  provider?: unknown;
};

function normalizePreflightField(value: unknown, field: string): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === undefined) return null;
  throw new PreflightValidationError("invalid_preflight_input", `${field} must be a string or number`);
}

async function readApprovePlanPayload(request: Request): Promise<ApprovePlanPayload> {
  const rawBody = await request.text();
  if (rawBody.trim().length === 0) return {};

  const payload = JSON.parse(rawBody) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload as ApprovePlanPayload;
}

function hasInlinePlanWaivers(payload: ApprovePlanPayload): boolean {
  return Object.prototype.hasOwnProperty.call(payload, "p1Waivers");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;

    const payload = await readApprovePlanPayload(request);
    resolveRequestProviderForAction("approve_plan", payload as ActionPreflightPayload);
    if (hasInlinePlanWaivers(payload)) {
      return NextResponse.json(
        {
          error: "P1 waivers must be submitted through plan-sandbox/decision before approving Plan",
          reasonCode: "p1_waivers_must_use_plan_decision",
        },
        { status: 422 }
      );
    }

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

    await assertActionAllowedAsync({
      changeId,
      actionId: "approve_plan",
      expectedGateVersion: expectedGateVersion ?? "",
      expectedSourceDbHash: expectedSourceDbHash ?? "",
      idempotencyKey,
    });
    await approvePlan(changeId, { source: "route_preflight" });
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof PreflightValidationError) {
      return NextResponse.json(
        { error: err.message, reasonCode: err.reasonCode },
        { status: err.status }
      );
    }
    if (err instanceof PreflightBlockedError) {
      return NextResponse.json(err.envelope, { status: err.status });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
