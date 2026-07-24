import { NextResponse } from "next/server";
import { regeneratePlanReport } from "@/server/services/plan-sandbox-service";
import { requireProjectChange } from "../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
  resolveRequestProviderForAction,
} from "../../action-preflight";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const payload = await readActionPayload(request);
    // Binds this route to whatever the contract decides for
    // regenerate_plan_report, rather than restating nothing at all. The
    // contract currently allows it on a terminal change; if that judgement
    // changes, this route follows without a second edit.
    await assertRequestActionAllowed({ changeId, actionId: "regenerate_plan_report", payload, request });
    resolveRequestProviderForAction("regenerate_plan_report", payload);
    const state = await regeneratePlanReport(changeId);
    return NextResponse.json({ success: true, state });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
