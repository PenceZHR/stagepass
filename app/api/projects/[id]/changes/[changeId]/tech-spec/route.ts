import { NextResponse } from "next/server";
import { enqueueProviderActionAtomically } from "@/server/services/job-dispatch-service";
import {
  assertActionAllowedAsync,
  PreflightBlockedError,
  PreflightValidationError,
} from "@/server/services/preflight-service";
import { getSpecBattleState } from "@/server/services/spec-battle-service";
import { requireProjectChange } from "../route-guard";
import {
  actionPreflightErrorResponse,
  readActionPayload,
  resolveRequestProvider,
  type ActionPreflightPayload,
} from "../action-preflight";

type TechSpecPayload = ActionPreflightPayload;

function normalizePreflightField(value: unknown, field: string): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === undefined) return null;
  throw new PreflightValidationError("invalid_preflight_input", `${field} must be a string or number`);
}

function techSpecActionId(value: unknown): "run_tech_spec" | "retry_tech_spec" {
  if (value === undefined) return "run_tech_spec";
  if (value === "run_tech_spec" || value === "retry_tech_spec") return value;
  throw new PreflightValidationError(
    "invalid_preflight_input",
    "actionId must be run_tech_spec or retry_tech_spec",
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
    const change = guard.change;

    const payload = await readActionPayload(request) as TechSpecPayload;
    const actionId = techSpecActionId(payload.actionId);
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

    const actionContract = await assertActionAllowedAsync({
      changeId,
      actionId,
      expectedGateVersion: expectedGateVersion ?? "",
      expectedSourceDbHash: expectedSourceDbHash ?? "",
      idempotencyKey,
    });

    const battle = getSpecBattleState(changeId);
    if (change.gateState !== "spec" || battle.latestRound?.status !== "closed") {
      const reasonCode =
        change.gateState !== "spec" ? "spec_gate_unapproved" : "spec_battle_not_closed";
      return NextResponse.json(
        { error: "Spec gate is not approved", reasonCode },
        { status: 409 }
      );
    }

    const { job } = enqueueProviderActionAtomically({
      changeId,
      phase: "tech_spec",
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
