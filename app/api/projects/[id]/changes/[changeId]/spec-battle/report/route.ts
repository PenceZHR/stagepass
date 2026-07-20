import { NextResponse } from "next/server";
import {
  generateSpecReport,
  generateWarReport,
} from "@/server/services/spec-battle-report-service";
import { requireProjectChange } from "../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestProviderNotApplicable,
  readActionPayload,
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
    assertRequestProviderNotApplicable(payload);
    const specReport = await generateSpecReport(changeId);
    const warReport = await generateWarReport(changeId);
    return NextResponse.json({ success: true, specReport, warReport });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
