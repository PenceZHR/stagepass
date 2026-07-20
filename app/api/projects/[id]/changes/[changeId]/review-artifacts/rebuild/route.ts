import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { reviewState } from "@/server/db/schema";
import { rebuildReviewMirrors } from "@/server/services/review-artifact-mirror-service";
import { requireProjectChange } from "../../route-guard";
import {
  actionPreflightErrorResponse,
  assertRequestActionAllowed,
  readActionPayload,
} from "../../action-preflight";

function latestValidReportId(changeId: string): string | null {
  return (
    db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get()
      ?.latestValidReviewReportId ?? null
  );
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
    await assertRequestActionAllowed({ changeId, actionId: "rebuild_mirror", payload, request });
    const reportId = latestValidReportId(changeId);
    if (!reportId) {
      return NextResponse.json(
        { error: "No latest valid Review report is available to rebuild." },
        { status: 409 },
      );
    }
    const result = rebuildReviewMirrors(reportId);
    return NextResponse.json({
      success: true,
      reportId: result.reportId,
      changeId: result.changeId,
      rebuilt: result.rebuilt,
      warnings: result.warnings,
      mirrors: result.mirrors.map((mirror) => ({
        kind: mirror.kind,
        status: mirror.status,
        schemaVersion: mirror.schemaVersion,
        sourceDbHash: mirror.sourceDbHash,
        expectedContentHash: mirror.expectedContentHash,
        recordedContentHash: mirror.recordedContentHash,
        artifactId: mirror.artifactId,
        warnings: mirror.warnings,
      })),
      rawOutputArtifact: result.rawOutputArtifact
        ? {
            id: result.rawOutputArtifact.id,
            type: result.rawOutputArtifact.type,
            createdAt: result.rawOutputArtifact.createdAt,
          }
        : null,
    });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
