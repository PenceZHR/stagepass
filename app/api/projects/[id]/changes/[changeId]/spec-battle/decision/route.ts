import { NextResponse } from "next/server";
import {
  applySpecBattleDecision,
  SpecBattleError,
  type SpecBattleDecisionInput,
} from "@/server/services/spec-battle-service";
import { requireProjectChange } from "../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestProviderNotApplicable,
} from "../../action-preflight";

type PublicSpecBattleDecisionAction = Exclude<SpecBattleDecisionInput["action"], "approve">;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const payload = (await request.json()) as Omit<SpecBattleDecisionInput, "changeId">;
    assertRequestProviderNotApplicable(payload);
    if (payload.action === "approve") {
      return NextResponse.json(
        {
          status: 422,
          error: "invalid_battle_decision_action",
          reasonCode: "invalid_battle_decision_action",
          message: "Spec approval must use /gate/approve with an action contract snapshot.",
        },
        { status: 422 },
      );
    }
    await applySpecBattleDecision({
      changeId,
      action: payload.action as PublicSpecBattleDecisionAction,
      targetType: payload.targetType ?? null,
      targetId: payload.targetId ?? null,
      reason: payload.reason ?? null,
    });
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof SpecBattleError) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
