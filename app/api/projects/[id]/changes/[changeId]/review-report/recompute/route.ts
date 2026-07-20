import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { reviewAttempts } from "@/server/db/schema";
import { recomputeReviewReport } from "@/server/services/review-report-service";
import { rebuildReviewMirrors } from "@/server/services/review-artifact-mirror-service";
import { requireProjectChange } from "../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
} from "../../action-preflight";

function latestAttemptId(changeId: string): string | null {
  const attempts = db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, changeId)).all();
  attempts.sort((left, right) => {
    if (right.attemptNo !== left.attemptNo) return right.attemptNo - left.attemptNo;
    const started = right.startedAt.localeCompare(left.startedAt);
    if (started !== 0) return started;
    return right.id.localeCompare(left.id);
  });
  return attempts[0]?.id ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id: projectId, changeId } = await params;
  const guard = await requireProjectChange(projectId, changeId);
  if (guard.response) return guard.response;

  try {
    const payload = await readActionPayload(request);
    await assertRequestActionAllowed({ changeId, actionId: "recompute_report", payload, request });
    const attemptId = latestAttemptId(changeId);
    if (!attemptId) {
      return NextResponse.json(
        { error: "No Review attempt is available to recompute." },
        { status: 409 },
      );
    }
    const result = recomputeReviewReport(changeId, attemptId);
    // Keep the mirrors in step with the recomputed report. Best-effort: a
    // filesystem problem must not fail an already-settled recompute, and
    // rebuildReviewMirrors records per-kind failures on the mirror rows itself.
    try {
      rebuildReviewMirrors(result.report.id);
    } catch {
      // Mirror failures are recorded on the mirror rows and surfaced as warnings.
    }
    return NextResponse.json({
      success: true,
      report: {
        id: result.report.id,
        reportDbHash: result.report.reportDbHash,
        findingsDbHash: result.report.findingsDbHash,
        gateStatus: result.report.gateStatus,
        qaAllowed: result.report.qaAllowed === 1,
      },
      state: {
        changeId: result.state.changeId,
        latestAttemptId: result.state.latestAttemptId,
        latestValidReviewReportId: result.state.latestValidReviewReportId,
        updatedAt: result.state.updatedAt,
      },
    });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
