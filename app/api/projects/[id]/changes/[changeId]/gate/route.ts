import { NextResponse } from "next/server";
import { getGateStatus } from "@/server/services/gate-service";
import { requireProjectChange } from "../route-guard";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    return NextResponse.json(getGateStatus(changeId, { refreshActions: false }));
  } catch (err: unknown) {
    console.error("Gate status request failed", { changeId, error: err });
    return NextResponse.json({
      error: { code: "GATE_STATUS_UNAVAILABLE", message: "Gate status is unavailable" },
    }, { status: 500 });
  }
}
