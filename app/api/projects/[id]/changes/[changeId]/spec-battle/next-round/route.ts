import { NextResponse } from "next/server";
import {
  applySpecBattleDecision,
  SpecBattleError,
} from "@/server/services/spec-battle-service";
import { requireProjectChange } from "../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  assertRequestProviderNotApplicable,
} from "../../action-preflight";

/**
 * Starts another adversarial round on a settled Spec round.
 *
 * ## Why this exists next to /spec-battle/decision
 *
 * The decision route takes a free-form `action` in its body, which is why it
 * could never be reached from the pipeline action bar: that bar posts one thing
 * -- the action contract's preflight payload -- to one endpoint per action id.
 * `request_spec_changes` therefore had a contract entry, an availability rule
 * computed on every request, and no way to be invoked: `ACTION_ENDPOINTS` had
 * no mapping, and the UI deliberately hides actions with no mapping so they do
 * not render as buttons that do nothing. The next round was unreachable from
 * the web entirely.
 *
 * This endpoint is the missing half: one action id, one route, the standard
 * preflight gate -- plus the reason the service requires.
 *
 * ## Why the reason is not defaulted
 *
 * `applySpecBattleDecision` refuses an empty reason, and that refusal is the
 * point: another round supersedes the current one and costs a full red/blue
 * cycle, so the record has to say who asked and why. Filling it in server-side
 * would keep the guard's shape while destroying what it guards.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;

    const payload = (await request.json()) as { reason?: unknown };
    assertRequestProviderNotApplicable(payload as Record<string, unknown>);

    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (reason.length === 0) {
      return NextResponse.json(
        {
          error: "另开一轮必须写明理由",
          reasonCode: "decision_reason_required",
        },
        { status: 422 },
      );
    }

    await assertRequestActionAllowed({
      changeId,
      actionId: "request_spec_changes",
      payload: payload as Record<string, unknown>,
      request,
    });

    await applySpecBattleDecision({
      changeId,
      action: "request_changes",
      targetType: "gate",
      targetId: null,
      reason,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const preflight = actionPreflightErrorResponse(error);
    if (preflight) return preflight;
    if (error instanceof SpecBattleError) {
      return NextResponse.json(
        { error: error.message, reasonCode: error.code },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
