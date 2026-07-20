import { NextResponse } from "next/server";

import {
  assertActionAllowedAsync,
  PreflightBlockedError,
  PreflightValidationError,
} from "@/server/services/preflight-service";
import {
  ActionContractDriftError,
  PipelineJobConflictError,
  ProviderSelectionConflictError,
} from "@/server/services/job-dispatch-service";
import {
  parseRequestedProvider,
  ProviderSelectionError,
  assertProviderApplicable,
  type Provider,
} from "@/server/services/provider-selection-service";

export type ActionPreflightPayload = Record<string, unknown> & {
  expectedGateVersion?: unknown;
  expectedSourceDbHash?: unknown;
  expectedHeadSha?: unknown;
  idempotencyKey?: unknown;
  provider?: unknown;
};

export function parseRequestProvider(value: unknown): Provider | undefined {
  try {
    return parseRequestedProvider(value);
  } catch (error) {
    if (error instanceof ProviderSelectionError) {
      throw new PreflightValidationError(error.code, error.message);
    }
    throw error;
  }
}

export function resolveRequestProvider(payload: ActionPreflightPayload): Provider | undefined {
  return parseRequestProvider(payload.provider);
}

export function resolveRequestProviderForAction(
  actionId: string,
  payload: ActionPreflightPayload,
): Provider | undefined {
  const provider = resolveRequestProvider(payload);
  try {
    assertProviderApplicable(actionId, provider);
  } catch (error) {
    if (error instanceof ProviderSelectionError) {
      throw new PreflightValidationError(error.code, error.message);
    }
    throw error;
  }
  return provider;
}

/** Validate that a human/local route did not receive an explicit provider. */
export function assertRequestProviderNotApplicable(payload: ActionPreflightPayload): void {
  const provider = resolveRequestProvider(payload);
  if (provider !== undefined) {
    throw new PreflightValidationError(
      "provider_not_applicable",
      "provider is not applicable to this action",
    );
  }
}

function normalizePreflightField(value: unknown, field: string): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === undefined) return null;
  throw new PreflightValidationError("invalid_preflight_input", `${field} must be a string or number`);
}

export async function readActionPayload(request: Request): Promise<ActionPreflightPayload> {
  const rawBody = await request.text();
  if (rawBody.trim().length === 0) return {};
  const payload = JSON.parse(rawBody) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PreflightValidationError("invalid_preflight_input", "JSON object body required");
  }
  const parsed = payload as ActionPreflightPayload;
  // Validate once at the shared boundary so every provider-backed route gets
  // the same invalid_provider response even when it has custom payload fields.
  parseRequestProvider(parsed.provider);
  return parsed;
}

export function resolveRequestIdempotencyKey(
  payload: ActionPreflightPayload,
  request: Request,
): string | undefined {
  const bodyIdempotencyKey =
    typeof payload.idempotencyKey === "string" && payload.idempotencyKey.trim()
      ? payload.idempotencyKey.trim()
      : undefined;
  const headerIdempotencyKey =
    request.headers.get("idempotency-key")?.trim() ||
    request.headers.get("x-idempotency-key")?.trim() ||
    undefined;
  return bodyIdempotencyKey ?? headerIdempotencyKey;
}

export async function assertRequestActionAllowed({
  changeId,
  actionId,
  payload,
  request,
}: {
  changeId: string;
  actionId: string;
  payload: ActionPreflightPayload;
  request: Request;
}) {
  resolveRequestProviderForAction(actionId, payload);
  const idempotencyKey = resolveRequestIdempotencyKey(payload, request);
  const expectedGateVersion = normalizePreflightField(
    payload.expectedGateVersion,
    "expectedGateVersion",
  );
  const expectedSourceDbHash = normalizePreflightField(
    payload.expectedSourceDbHash,
    "expectedSourceDbHash",
  );
  const expectedHeadSha = normalizePreflightField(payload.expectedHeadSha, "expectedHeadSha");

  return assertActionAllowedAsync({
    changeId,
    actionId,
    expectedGateVersion: expectedGateVersion ?? "",
    expectedSourceDbHash: expectedSourceDbHash ?? "",
    expectedHeadSha: expectedHeadSha ?? undefined,
    idempotencyKey,
  });
}

export function actionPreflightErrorResponse(err: unknown) {
  if (err instanceof PipelineJobConflictError) {
    return NextResponse.json(
      { error: err.message, reasonCode: err.code },
      { status: err.status },
    );
  }
  if (err instanceof ProviderSelectionError) {
    return NextResponse.json(
      { error: err.message, reasonCode: err.code },
      { status: 422 },
    );
  }
  if (err instanceof ProviderSelectionConflictError) {
    return NextResponse.json(
      { error: err.message, reasonCode: err.code },
      { status: err.status },
    );
  }
  if (err instanceof ActionContractDriftError) {
    return NextResponse.json(
      { error: err.message, reasonCode: err.code },
      { status: 409 },
    );
  }
  if (err instanceof PreflightValidationError) {
    return NextResponse.json(
      { error: err.message, reasonCode: err.reasonCode },
      { status: err.status },
    );
  }
  if (err instanceof PreflightBlockedError) {
    return NextResponse.json(err.envelope, { status: err.status });
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 422 });
  }
  return null;
}
