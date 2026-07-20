import { NextResponse } from "next/server";
import { getSpecBattleState, SpecBattleError } from "@/server/services/spec-battle-service";
import { requireProjectChange } from "../route-guard";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    return NextResponse.json(getSpecBattleState(changeId));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = err instanceof SpecBattleError ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
