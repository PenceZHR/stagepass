import { NextResponse } from "next/server";
import { z } from "zod";
import { getGraphRunner } from "@/server/services/graph-runner";
import { requireProjectChange } from "../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
} from "../action-preflight";

const BlockBody = z.object({
  reason: z.string().optional(),
  phase: z
    .enum([
      "refine",
      "generate_plan",
      "implement",
      "review",
      "local_check",
      "fix_findings",
      "intake",
      "spec",
      "tech_spec",
      "test_plan",
      "release",
      "retro",
    ])
    .optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const body = await readActionPayload(request);
    await assertRequestActionAllowed({ changeId, actionId: "stop_change", payload: body, request });
    const parsed = BlockBody.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const reason = parsed.data.reason || "Manually blocked";
    await getGraphRunner().blockChange(changeId, reason, parsed.data.phase);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
