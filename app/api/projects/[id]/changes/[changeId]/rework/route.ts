import { NextResponse } from "next/server";
import { ReworkChangeInput } from "@/server/types/api";
import { reworkChange } from "@/server/services/change-rework-service";
import { changeTerminalRefusal } from "@/server/services/action-contract-decision-router";
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
    // Rework has no ACTION_DEFINITIONS entry, so it never reaches
    // assertRequestActionAllowed and the action contract never spoke for it.
    // Its only guard was change-rework-service's RUNNING_CHANGE_STATUSES check,
    // which asks "is something in flight" -- a different question from "is this
    // change finished". Verified against a copy of the shipped database: this
    // route accepted a POST for a DONE change and got all the way into
    // reworkChange, where only a FOREIGN KEY error stopped it, while /block
    // answered 409 change_terminal for the same change at the same moment.
    const terminal = changeTerminalRefusal(guard.change.status, "rework");
    if (terminal) {
      return NextResponse.json(
        { error: terminal.reason, reasonCode: terminal.reasonCode },
        { status: 409 },
      );
    }
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
