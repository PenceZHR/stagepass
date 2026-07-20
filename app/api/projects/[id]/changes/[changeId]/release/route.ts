import { NextResponse } from "next/server";
import { enqueueProviderActionAtomically } from "@/server/services/job-dispatch-service";
import { assertCanMerge, MergeReadinessError } from "@/server/services/merge-readiness-service";
import {
  actionNotAllowedEnvelope,
  assertActionAllowedAsync,
  PreflightBlockedError,
  PreflightValidationError,
} from "@/server/services/preflight-service";
import { requireProjectChange } from "../route-guard";
import {
  actionPreflightErrorResponse,
  readActionPayload,
  resolveRequestProvider,
  type ActionPreflightPayload,
} from "../action-preflight";

type ReleasePayload = ActionPreflightPayload;

function normalizePreflightField(value: unknown, field: string): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === undefined) return null;
  throw new PreflightValidationError("invalid_preflight_input", `${field} must be a string or number`);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;

    const payload = await readActionPayload(request) as ReleasePayload;
    const idempotencyKey =
      typeof payload.idempotencyKey === "string"
        ? payload.idempotencyKey
        : request.headers.get("idempotency-key") ?? request.headers.get("x-idempotency-key") ?? undefined;
    const expectedGateVersion = normalizePreflightField(
      payload.expectedGateVersion,
      "expectedGateVersion"
    );
    const expectedSourceDbHash = normalizePreflightField(
      payload.expectedSourceDbHash,
      "expectedSourceDbHash"
    );
    const expectedHeadSha = normalizePreflightField(payload.expectedHeadSha, "expectedHeadSha");

    const actionContract = await assertActionAllowedAsync({
      changeId,
      actionId: "merge",
      expectedGateVersion: expectedGateVersion ?? "",
      expectedSourceDbHash: expectedSourceDbHash ?? "",
      expectedHeadSha: expectedHeadSha ?? undefined,
      idempotencyKey,
    });
    assertCanMerge({ changeId, expectedHeadSha });

    const { job } = enqueueProviderActionAtomically({
      changeId,
      phase: "release",
      actionId: "merge",
      idempotencyKey,
      provider: resolveRequestProvider(payload),
    }, actionContract);
    return NextResponse.json(
      { success: true, accepted: true, jobId: job.id, provider: payload.provider === undefined ? undefined : job.provider, status: "queued" },
      { status: 202 },
    );
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    if (err instanceof PreflightValidationError) {
      return NextResponse.json(
        { error: err.message, reasonCode: err.reasonCode },
        { status: err.status }
      );
    }
    if (err instanceof PreflightBlockedError) {
      return NextResponse.json(err.envelope, { status: err.status });
    }
    if (err instanceof MergeReadinessError) {
      const reasonCode = err.readiness.blockers[0]?.reasonCode ?? "merge_blocked";
      return NextResponse.json(
        actionNotAllowedEnvelope(changeId, "merge", {
          enabled: false,
          reasonCode,
          reason: err.message,
        }),
        { status: 409 }
      );
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
