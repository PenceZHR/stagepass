import { NextResponse } from "next/server";
import { getGraphRunner } from "@/server/services/graph-runner";
import { requireProjectChange } from "../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
  resolveRequestProviderForAction,
} from "../action-preflight";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const payload = await readActionPayload(request);
    // Without this the action contract was decoration here. /block enforces
    // stop_change's preconditions; this twin did not, so the `no_active_run`
    // refusal the contract computes was reachable only through /block. A POST
    // here with zero running runs still reached stopActiveRuns, whose
    // assertMutationAffected throws, and the catch below answered 400 carrying
    // the raw ledger string. Same action, same guard, both doors.
    await assertRequestActionAllowed({ changeId, actionId: "stop_change", payload, request });
    resolveRequestProviderForAction("stop_change", payload);
    await getGraphRunner().stopCurrentRun(changeId);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
