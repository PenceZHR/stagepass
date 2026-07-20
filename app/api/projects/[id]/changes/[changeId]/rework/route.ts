import { NextResponse } from "next/server";
import { ReworkChangeInput } from "@/server/types/api";
import { reworkChange } from "@/server/services/change-rework-service";
import { requireProjectChange } from "../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestProviderNotApplicable,
  readActionPayload,
} from "../action-preflight";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const body = await readActionPayload(request);
    assertRequestProviderNotApplicable(body);
    const parsed = ReworkChangeInput.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await reworkChange(projectId, changeId, parsed.data.phase);
    return NextResponse.json(updated);
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Cannot rework while") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
