import { NextResponse } from "next/server";
import {
  getPrdBriefingState,
  savePrdIntent,
  PrdBriefingError,
} from "@/server/services/prd-briefing-service";
import { requireProjectChange } from "../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestProviderNotApplicable,
} from "../action-preflight";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    return NextResponse.json(getPrdBriefingState(changeId));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof PrdBriefingError) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const body = (await request.json()) as { rawText: string; provider?: unknown };
    assertRequestProviderNotApplicable(body);
    const { rawText } = body;
    const state = await savePrdIntent({ changeId, rawText });
    return NextResponse.json(state);
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof PrdBriefingError) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
