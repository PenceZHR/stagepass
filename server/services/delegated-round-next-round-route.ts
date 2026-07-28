import { NextResponse } from "next/server";

import {
  DelegatedRoundLedgerError,
  openNextDelegatedRound,
} from "./delegated-round-ledger";
import type { DelegatedPhaseDescriptor } from "./pipeline-delegated-phase-stage";

/**
 * The shared body of the three `request_*_changes` routes.
 *
 * One implementation rather than three copies because the only thing that
 * differs is the descriptor and the action id, and the parts that must NOT
 * differ are the parts a copy erodes first: the preflight gate, the refusal of
 * an empty reason, and the error mapping. Spec keeps its own route for the
 * reason its whole ledger is separate -- it goes through
 * `applySpecBattleDecision`, which does considerably more than open a round.
 *
 * ## Why the reason is not defaulted
 *
 * Another round supersedes the current one and costs a full red/blue/judge
 * cycle, so the record has to say who asked and why. Filling it in server-side
 * would keep the guard's shape while destroying what it guards.
 */
export async function handleDelegatedNextRoundRequest(input: {
  request: Request;
  projectId: string;
  changeId: string;
  actionId: string;
  descriptor: DelegatedPhaseDescriptor;
  requireProjectChange: (
    projectId: string,
    changeId: string,
  ) => Promise<{ response?: NextResponse }>;
  assertRequestProviderNotApplicable: (payload: Record<string, unknown>) => void;
  assertRequestActionAllowed: (input: {
    changeId: string;
    actionId: string;
    payload: Record<string, unknown>;
    request: Request;
  }) => Promise<unknown>;
  actionPreflightErrorResponse: (error: unknown) => NextResponse | null;
}): Promise<NextResponse> {
  try {
    const guard = await input.requireProjectChange(input.projectId, input.changeId);
    if (guard.response) return guard.response;

    const payload = (await input.request.json()) as Record<string, unknown>;
    input.assertRequestProviderNotApplicable(payload);

    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (reason.length === 0) {
      return NextResponse.json(
        { error: "另开一轮必须写明理由", reasonCode: "decision_reason_required" },
        { status: 422 },
      );
    }

    await input.assertRequestActionAllowed({
      changeId: input.changeId,
      actionId: input.actionId,
      payload,
      request: input.request,
    });

    const opened = await openNextDelegatedRound({
      changeId: input.changeId,
      descriptor: input.descriptor,
      reason,
    });
    return NextResponse.json({ ok: true, roundId: opened.roundId, roundNo: opened.roundNo });
  } catch (error) {
    const preflight = input.actionPreflightErrorResponse(error);
    if (preflight) return preflight;
    if (error instanceof DelegatedRoundLedgerError) {
      // 409 rather than 500: every code this throws is a state conflict the
      // caller can see and act on (the round is still running, it already
      // closed, the limit is reached), not a server fault.
      return NextResponse.json(
        { error: error.message, reasonCode: error.code },
        { status: 409 },
      );
    }
    throw error;
  }
}
