import { NextResponse } from "next/server";
import {
  applySpecBattleDecision,
  SpecBattleError,
  type SpecBattleDecisionInput,
} from "@/server/services/spec-battle-service";
import { changeTerminalRefusal } from "@/server/services/action-contract-decision-router";
import { requireProjectChange } from "../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
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
    // One route, three actions, and until now no contract check on any of them:
    // it imported the preflight *error handler* but never the gate, so a POST
    // went straight into applySpecBattleDecision. Measured against a copy of the
    // shipped database: a return_to_spec on a DONE change reached the service
    // and failed with a business error (round_not_ready), while /block answered
    // 409 change_terminal for the same change.
    //
    // waive_p1 has a real contract action (waive_spec_p1, which
    // pipeline-action-commands already documents as living at this endpoint), so
    // it gets the full gate -- gate version, source hash and idempotency
    // included. The other two have no ACTION_DEFINITIONS entry, so the most this
    // can honour is the terminal rule, read from the same set the contract uses.
    if (payload.action === "waive_p1") {
      await assertRequestActionAllowed({
        changeId,
        actionId: "waive_spec_p1",
        payload: payload as Record<string, unknown>,
        request,
      });
    } else {
      const terminal = changeTerminalRefusal(guard.change.status, "spec_battle_decision");
      if (terminal) {
        return NextResponse.json(
          { error: terminal.reason, reasonCode: terminal.reasonCode },
          { status: 409 },
        );
      }
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
