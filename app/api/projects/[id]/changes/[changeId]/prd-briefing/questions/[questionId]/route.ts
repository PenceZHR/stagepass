import { NextResponse } from "next/server";
import {
  applyBriefingQuestionAction,
  PrdBriefingError,
} from "@/server/services/prd-briefing-service";
import { requireProjectChange } from "../../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestProviderNotApplicable,
} from "../../../action-preflight";

type QuestionAction = "answer" | "accept_assumption" | "defer";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string; questionId: string }> }
) {
  const { id: projectId, changeId, questionId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const payload = (await request.json()) as {
      action: QuestionAction;
      value: string;
      provider?: unknown;
    };
    assertRequestProviderNotApplicable(payload);
    const { action, value } = payload;
    const state = await applyBriefingQuestionAction({
      changeId,
      questionId,
      action,
      value,
    });
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
