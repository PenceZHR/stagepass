import { NextResponse } from "next/server";
import { waivePlanRisk } from "@/server/services/plan-sandbox-service";
import { requireProjectChange } from "../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  resolveRequestProviderForAction,
} from "../../action-preflight";

type PlanRiskDecisionPayload = {
  riskId?: unknown;
  reason?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;

    const payload = (await request.json()) as PlanRiskDecisionPayload | null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json({ error: "JSON object body required" }, { status: 400 });
    }
    // The contract's decision for waive_plan_p1 -- terminal-change refusal
    // included -- only binds if a route asks for it. This one did not, so
    // waiving a Plan P1 on a DONE change went straight through while the gate
    // reported `change_terminal`.
    await assertRequestActionAllowed({ changeId, actionId: "waive_plan_p1", payload, request });
    resolveRequestProviderForAction("waive_plan_p1", payload);
    if (typeof payload.riskId !== "string") {
      return NextResponse.json({ error: "riskId field required" }, { status: 400 });
    }
    if (typeof payload.reason !== "string") {
      return NextResponse.json({ error: "reason field required" }, { status: 400 });
    }

    const state = await waivePlanRisk(changeId, payload.riskId, payload.reason);
    return NextResponse.json({ success: true, state });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
