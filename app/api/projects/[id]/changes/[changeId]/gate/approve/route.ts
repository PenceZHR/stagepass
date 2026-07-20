import { NextResponse } from "next/server";
import { approveGate, gateApprovalActionId, type GateName } from "@/server/services/gate-service";
import {
  actionNotAllowedEnvelope,
  PreflightBlockedError,
  PreflightValidationError,
} from "@/server/services/preflight-service";
import { SpecBattleError } from "@/server/services/spec-battle-service";
import { requireProjectChange } from "../../route-guard";
import {
  assertRequestProviderNotApplicable,
  type ActionPreflightPayload,
} from "../../action-preflight";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  let requestedGate: GateName | null = null;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const rawBody = await request.json();
    const body = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? rawBody
      : {}) as ActionPreflightPayload & {
      gate: GateName;
      expectedGateVersion?: string;
      expectedSourceDbHash?: string;
      idempotencyKey?: string;
      expectedHeadSha?: string;
    };
    // Gate approvals are human-only actions. Keep accepting the historical
    // body fields, but reject an explicit provider instead of silently
    // ignoring it.
    assertRequestProviderNotApplicable(body);
    requestedGate = body.gate;
    const idempotencyKey =
      body.idempotencyKey ??
      request.headers.get("idempotency-key") ??
      request.headers.get("x-idempotency-key") ??
      undefined;
    await approveGate(changeId, body.gate, {
      expectedGateVersion: body.expectedGateVersion ?? "",
      expectedSourceDbHash: body.expectedSourceDbHash ?? "",
      idempotencyKey,
      expectedHeadSha: body.expectedHeadSha,
    });
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof PreflightBlockedError) {
      return NextResponse.json(err.envelope, { status: err.status });
    }
    if (err instanceof PreflightValidationError) {
      return NextResponse.json(
        { status: err.status, error: err.reasonCode, reasonCode: err.reasonCode, message },
        { status: err.status },
      );
    }
    if (err instanceof SpecBattleError) {
      const actionId = requestedGate ? gateApprovalActionId(requestedGate) : "approve_spec";
      const envelope = actionNotAllowedEnvelope(changeId, actionId, {
        enabled: false,
        reasonCode: err.code,
        reason: message,
      });
      return NextResponse.json(envelope, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
