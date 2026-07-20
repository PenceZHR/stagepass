import { NextResponse } from "next/server";
import {
  BuildWorkspaceError,
  changeArtifactIgnoredPrefixes,
  checkGitBaseCamp,
  readLatestBuildRun,
} from "@/server/services/build-workspace-service";
import { getProject } from "@/server/services/project-service";
import {
  actionNotAllowedEnvelope,
  assertActionAllowedAsync,
  PreflightBlockedError,
  PreflightValidationError,
} from "@/server/services/preflight-service";
import { requireProjectChange } from "../route-guard";
import { resolveRequestProviderForAction, type ActionPreflightPayload } from "../action-preflight";

type BuildWorkspaceAction = "approve_absorb" | "reject_build";
type BuildWorkspaceBody = {
  action?: unknown;
  expectedGateVersion?: unknown;
  expectedSourceDbHash?: unknown;
  expectedHeadSha?: unknown;
  idempotencyKey?: unknown;
  provider?: unknown;
};

function isBuildWorkspaceAction(action: unknown): action is BuildWorkspaceAction {
  return action === "approve_absorb" || action === "reject_build";
}

async function readJsonObjectBody(request: Request): Promise<BuildWorkspaceBody | NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 422 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON object body required" }, { status: 422 });
  }

  return body as BuildWorkspaceBody;
}

function buildWorkspacePostErrorStatus(err: unknown): number {
  if (err instanceof BuildWorkspaceError) return err.statusCode;
  if (!(err instanceof Error)) return 400;
  if (/^(Change|Project) not found/.test(err.message)) return 404;
  if (/^Invalid status:/.test(err.message)) return 409;
  return 400;
}

function normalizePreflightField(value: unknown, field: string): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === undefined) return null;
  throw new PreflightValidationError("invalid_preflight_input", `${field} must be a string or number`);
}

function buildWorkspaceContractReasonCode(message: string): string {
  if (/fix_hash_drift/i.test(message)) return "fix_hash_drift";
  if (/build_hash_drift|patch hash|changed files hash/i.test(message)) return "build_hash_drift";
  if (/HEAD drifted|git head/i.test(message)) return "git_head_drift";
  if (/dirty|uncommitted/i.test(message)) return "git_worktree_dirty";
  return "build_adoption_blocked";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;

    const project = await getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json({
      baseCamp: checkGitBaseCamp(project.repoPath, {
        ignoredPrefixes: changeArtifactIgnoredPrefixes(changeId),
        strictClean: false, // Don't block build on uncommitted changes - allow local dev
      }),
      buildRun: readLatestBuildRun(project.repoPath, changeId),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  let buildWorkspaceErrorActionId: "adopt_build" | "adopt_fix" = "adopt_build";
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;

    const body = await readJsonObjectBody(request);
    if (body instanceof NextResponse) return body;

    if (!isBuildWorkspaceAction(body?.action)) {
      return NextResponse.json({ error: "Unknown build workspace action" }, { status: 422 });
    }
    resolveRequestProviderForAction(
      body.action === "approve_absorb"
        ? "adopt_build"
        : "reject_build",
      body as ActionPreflightPayload,
    );

    const expectedGateVersion = normalizePreflightField(
      body.expectedGateVersion,
      "expectedGateVersion"
    );
    const expectedSourceDbHash = normalizePreflightField(
      body.expectedSourceDbHash,
      "expectedSourceDbHash"
    );
    const expectedHeadSha = normalizePreflightField(body.expectedHeadSha, "expectedHeadSha");
    const idempotencyKey =
      typeof body.idempotencyKey === "string"
        ? body.idempotencyKey
        : request.headers.get("idempotency-key") ?? request.headers.get("x-idempotency-key") ?? undefined;

    if (body.action === "approve_absorb") {
      const project = await getProject(projectId);
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      const buildRun = readLatestBuildRun(project.repoPath, changeId);
      if (!buildRun) {
        return NextResponse.json({ error: "No build run found" }, { status: 404 });
      }
      buildWorkspaceErrorActionId = buildRun.purpose === "fix" ? "adopt_fix" : "adopt_build";
      await assertActionAllowedAsync({
        changeId,
        actionId: buildWorkspaceErrorActionId,
        expectedGateVersion: expectedGateVersion ?? "",
        expectedSourceDbHash: expectedSourceDbHash ?? "",
        idempotencyKey,
        expectedHeadSha: expectedHeadSha ?? buildRun.baseHeadSha ?? buildRun.baseCommit ?? "",
      });
      const { approveBuildAbsorb } = await import("@/server/services/pipeline-service");
      await approveBuildAbsorb(changeId);
      return NextResponse.json({ success: true });
    }

    await assertActionAllowedAsync({
      changeId,
      actionId: "reject_build",
      expectedGateVersion: expectedGateVersion ?? "",
      expectedSourceDbHash: expectedSourceDbHash ?? "",
      idempotencyKey,
    });
    const { rejectBuildRun } = await import("@/server/services/pipeline-service");
    const buildRun = await rejectBuildRun(changeId);
    return NextResponse.json({ success: true, buildRun });
  } catch (err: unknown) {
    if (err instanceof PreflightValidationError) {
      return NextResponse.json(
        { error: err.message, reasonCode: err.reasonCode },
        { status: err.status }
      );
    }
    if (err instanceof PreflightBlockedError) {
      return NextResponse.json(err.envelope, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof BuildWorkspaceError && err.statusCode === 409) {
      const envelope = actionNotAllowedEnvelope(changeId, buildWorkspaceErrorActionId, {
        enabled: false,
        reasonCode: buildWorkspaceContractReasonCode(message),
        reason: message,
      });
      return NextResponse.json(envelope, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: buildWorkspacePostErrorStatus(err) });
  }
}
