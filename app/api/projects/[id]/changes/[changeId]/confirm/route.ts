import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmRequirements } from "@/server/services/refine-service";
import { requireProjectChange } from "../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestProviderNotApplicable,
  readActionPayload,
} from "../action-preflight";

const RequirementSchema = z.object({
  id: z.string(),
  category: z.enum(["functional", "non-functional", "constraint"]),
  title: z.string(),
  description: z.string(),
  status: z.enum(["confirmed", "uncertain", "new"]),
});

const ConfirmBody = z.object({
  requirements: z.array(RequirementSchema).min(1),
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
    assertRequestProviderNotApplicable(body);
    const parsed = ConfirmBody.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = await confirmRequirements(projectId, changeId, parsed.data.requirements);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
