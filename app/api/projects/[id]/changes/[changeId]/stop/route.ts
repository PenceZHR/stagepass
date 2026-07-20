import { NextResponse } from "next/server";
import { getGraphRunner } from "@/server/services/graph-runner";
import { requireProjectChange } from "../route-guard";
import {
  actionPreflightErrorResponse,
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
