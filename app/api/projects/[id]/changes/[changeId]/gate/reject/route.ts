import { NextResponse } from "next/server";
import { gateRejectActionId, rejectGate, type GateName } from "@/server/services/gate-service";
import {
  actionPreflightErrorResponse,
  type ActionPreflightPayload,
  assertRequestActionAllowed,
  readActionPayload,
} from "../../action-preflight";
import { requireProjectChange } from "../../route-guard";

type RejectGatePayload = ActionPreflightPayload & {
  gate?: unknown;
  reason?: unknown;
};

function isGateName(value: unknown): value is GateName {
  return value === "intake" || value === "spec" || value === "tech_spec" || value === "merge";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const body = (await readActionPayload(request)) as RejectGatePayload;
    if (!isGateName(body.gate)) {
      return NextResponse.json({ error: "Invalid gate" }, { status: 400 });
    }
    const gate = body.gate;
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    await assertRequestActionAllowed({
      changeId,
      actionId: gateRejectActionId(gate),
      payload: body,
      request,
    });
    await rejectGate(changeId, gate, reason);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
