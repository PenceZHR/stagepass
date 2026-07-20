import { NextResponse } from "next/server";

import {
  ReviewWaiverError,
  waiveReviewFinding,
} from "@/server/services/review-waiver-service";
import { requireProjectChange } from "../../../route-guard";
import {
  actionPreflightErrorResponse,
  type ActionPreflightPayload,
  assertRequestActionAllowed,
  readActionPayload,
} from "../../../action-preflight";

interface WaiverPayload extends ActionPreflightPayload {
  reason?: unknown;
  actor?: unknown;
}

async function parsePayload(request: Request): Promise<WaiverPayload> {
  return readActionPayload(request) as Promise<WaiverPayload>;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string; findingId: string }> },
) {
  const { id: projectId, changeId, findingId } = await params;
  const guard = await requireProjectChange(projectId, changeId);
  if (guard.response) return guard.response;

  try {
    const payload = await parsePayload(request);
    await assertRequestActionAllowed({ changeId, actionId: "waive_review_p1", payload, request });
    const reason = typeof payload.reason === "string" ? payload.reason : null;
    const actor = typeof payload.actor === "string" ? payload.actor : "human";
    const result = waiveReviewFinding({ changeId, findingId, reason, actor });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const preflightResponse = actionPreflightErrorResponse(error);
    if (preflightResponse) return preflightResponse;
    if (error instanceof ReviewWaiverError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    throw error;
  }
}
