import { execFileSync } from "node:child_process";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { changes, projects, runs } from "../db/schema";
import { createChildLogger } from "../logger";
import { PreflightValidationError } from "./preflight-service";
import { transitionChangeStatus } from "./change-status-service";
import { endStageRun } from "./pipeline-run-ledger-service";
import {
  markBuildRunFailed,
  readLatestBuildRun,
} from "./build-workspace-service";
import type { BuildRunFile } from "./build-types";

const log = createChildLogger("build-stale-run-recovery-service");

export const DEFAULT_BUILD_STALE_RUN_MS = 30 * 60 * 1000;

type ProviderLiveness = boolean | "unknown";

export interface BuildStaleRunRecoveryOptions {
  now?: () => Date;
  staleAfterMs?: number;
  hasLiveProviderProcess?: (input: {
    changeId: string;
    workspacePath: string;
    runId: string;
  }) => ProviderLiveness;
}

export type StaleBuildInspection =
  | { kind: "none"; reason: "no_running_implement_run" | "change_not_found" | "project_not_found" }
  | { kind: "active"; runId: string; ageMs: number; reason: "below_threshold" | "live_provider_process" | "liveness_unknown" }
  | { kind: "stale"; runId: string; ageMs: number; buildRun: BuildRunFile | null }
  /**
   * The change claims IMPLEMENTING, no implement run is running, and the
   * workspace file is still mid-flight with no process behind it -- what the
   * stale-provider sweeper leaves when it reconciles a killed Build run. See
   * `inspectStrandedImplementClaim` for why this needs a different discriminator
   * from `stale`.
   */
  | { kind: "stranded"; runId: string | null; buildRun: BuildRunFile };

let clockForTest: (() => Date) | null = null;
let providerLivenessForTest:
  | ((input: { changeId: string; workspacePath: string; runId: string }) => ProviderLiveness)
  | null = null;

function latestRunningImplementRun(changeId: string): typeof runs.$inferSelect | null {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.changeId, changeId), eq(runs.phase, "implement"), eq(runs.status, "running")))
    .all()
    .sort((left, right) => {
      const byStarted = (right.startedAt ?? "").localeCompare(left.startedAt ?? "");
      if (byStarted !== 0) return byStarted;
      return right.id.localeCompare(left.id);
    })[0] ?? null;
}

function latestImplementRun(changeId: string): typeof runs.$inferSelect | null {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.changeId, changeId), eq(runs.phase, "implement")))
    .all()
    .sort((left, right) => {
      const byStarted = (right.startedAt ?? "").localeCompare(left.startedAt ?? "");
      if (byStarted !== 0) return byStarted;
      return right.id.localeCompare(left.id);
    })[0] ?? null;
}

function defaultHasLiveProviderProcess(input: {
  changeId: string;
  workspacePath: string;
  runId: string;
}): ProviderLiveness {
  if (providerLivenessForTest) return providerLivenessForTest(input);
  try {
    const output = execFileSync("lsof", ["-nP", "+D", input.workspacePath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return output.trim().length > 0;
  } catch (error) {
    const lsofError = error as { status?: number; stdout?: string | Buffer };
    const stdout = Buffer.isBuffer(lsofError.stdout)
      ? lsofError.stdout.toString("utf-8")
      : lsofError.stdout ?? "";
    if (lsofError.status === 1 && stdout.trim().length === 0) {
      return false;
    }
    if (stdout.includes(input.workspacePath)) {
      return true;
    }
    return "unknown";
  }
}

export function setBuildStaleRunClockForTest(clock: (() => Date) | null): () => void {
  const previous = clockForTest;
  clockForTest = clock;
  return () => {
    clockForTest = previous;
  };
}

export function setBuildProviderLivenessForTest(
  probe: ((input: { changeId: string; workspacePath: string; runId: string }) => ProviderLiveness) | null,
): () => void {
  const previous = providerLivenessForTest;
  providerLivenessForTest = probe;
  return () => {
    providerLivenessForTest = previous;
  };
}

/**
 * Classifies an IMPLEMENTING claim that no *running* implement run backs.
 *
 * This exists because IMPLEMENTING, unlike PLANNING or FIXING, does not mean
 * only "a run is in flight": `runImplementStreamed` COMPLETES into IMPLEMENTING
 * and parks there until a human runs adopt_build. So "no running implement run"
 * is the normal resting state of a *successful* build, and the whole-status
 * recovery the document stages use (recoverStrandedRunningStatus) would
 * silently discard finished work here.
 *
 * The workspace file is the discriminator instead, on 4a738e88's whitelist
 * logic read from the other end: only a file still claiming `running` was
 * killed mid-flight. `awaiting_human` and `gate_blocked` are parked on a
 * person, `created` may still produce the deliverable, and
 * approved/adopted/failed/rejected are already decided -- none of them are
 * this function's business, so they stay `none` and the existing actions keep
 * owning them.
 *
 * Even then the process may be alive: the sweeper commits its DB reconciliation
 * before best-effort terminating, and skips the terminate outright when its time
 * budget is spent or the ownership check fails. So the same liveness probe the
 * `stale` path uses has to clear it, and only a definite `false` counts --
 * `unknown` stays `active`, exactly as above.
 */
function inspectStrandedImplementClaim(input: {
  changeId: string;
  changeStatus: string;
  repoPath: string;
  hasLiveProviderProcess: NonNullable<BuildStaleRunRecoveryOptions["hasLiveProviderProcess"]>;
}): StaleBuildInspection {
  const none = { kind: "none", reason: "no_running_implement_run" } as const;
  if (input.changeStatus !== "IMPLEMENTING") return none;

  const buildRun = readLatestBuildRun(input.repoPath, input.changeId);
  if (!buildRun || buildRun.status !== "running") return none;

  const terminalRun = latestImplementRun(input.changeId);
  const startedAt = new Date(terminalRun?.startedAt ?? "").getTime();
  const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const stillActive = (reason: "live_provider_process" | "liveness_unknown") => ({
    kind: "active" as const,
    runId: terminalRun?.id ?? buildRun.branchName,
    ageMs,
    reason,
  });

  if (!buildRun.workspacePath) return stillActive("liveness_unknown");
  const liveness = input.hasLiveProviderProcess({
    changeId: input.changeId,
    workspacePath: buildRun.workspacePath,
    runId: terminalRun?.id ?? buildRun.branchName,
  });
  if (liveness === "unknown") return stillActive("liveness_unknown");
  if (liveness === true) return stillActive("live_provider_process");

  return { kind: "stranded", runId: terminalRun?.id ?? null, buildRun };
}

export function inspectStaleBuildRun(
  changeId: string,
  options: BuildStaleRunRecoveryOptions = {},
): StaleBuildInspection {
  const now = options.now ?? clockForTest ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_BUILD_STALE_RUN_MS;
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) return { kind: "none", reason: "change_not_found" };
  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) return { kind: "none", reason: "project_not_found" };

  const runningRun = latestRunningImplementRun(changeId);
  if (!runningRun) {
    return inspectStrandedImplementClaim({
      changeId,
      changeStatus: change.status,
      repoPath: project.repoPath,
      hasLiveProviderProcess: options.hasLiveProviderProcess ?? defaultHasLiveProviderProcess,
    });
  }

  const startedAt = new Date(runningRun.startedAt ?? "").getTime();
  const ageMs = Number.isFinite(startedAt) ? now().getTime() - startedAt : staleAfterMs;
  const buildRun = readLatestBuildRun(project.repoPath, changeId);
  if (ageMs < staleAfterMs) {
    return { kind: "active", runId: runningRun.id, ageMs, reason: "below_threshold" };
  }

  const hasLiveProviderProcess = options.hasLiveProviderProcess ?? defaultHasLiveProviderProcess;
  const liveness = buildRun?.workspacePath
    ? hasLiveProviderProcess({ changeId, workspacePath: buildRun.workspacePath, runId: runningRun.id })
    : "unknown";
  if (liveness === "unknown") {
    return { kind: "active", runId: runningRun.id, ageMs, reason: "liveness_unknown" };
  }
  if (buildRun?.workspacePath && liveness === true) {
    return { kind: "active", runId: runningRun.id, ageMs, reason: "live_provider_process" };
  }
  return { kind: "stale", runId: runningRun.id, ageMs, buildRun };
}

export function buildRetryStartDecisionFromInspection(
  changeStatus: string,
  inspection: StaleBuildInspection,
): { canStart: boolean; reasonCode: string | null; reason: string | null } {
  if (changeStatus === "PLAN_APPROVED") {
    return { canStart: true, reasonCode: null, reason: null };
  }
  if (changeStatus !== "IMPLEMENTING") {
    return {
      canStart: false,
      reasonCode: "not_at_gate",
      reason: "not_at_gate",
    };
  }
  if (inspection.kind === "active") {
    return {
      canStart: false,
      reasonCode: "build_run_running",
      reason: "Build run is running",
    };
  }
  if (inspection.kind === "none") {
    return {
      canStart: false,
      reasonCode: "no_running_build_run",
      reason: "No running Build run is available to recover before retry",
    };
  }
  // `stale` and `stranded` both mean the same thing to the caller: a Build the
  // retry may take over. Reporting `stranded` as no_running_build_run was the
  // mirror half of the dead end -- the runner could not recover it and the
  // contract would not offer it either.
  return { canStart: true, reasonCode: null, reason: null };
}

export function assertRetryBuildCanStart(
  changeStatus: string,
  changeId: string,
  options: BuildStaleRunRecoveryOptions = {},
): void {
  const inspection = inspectStaleBuildRun(changeId, options);
  const decision = buildRetryStartDecisionFromInspection(changeStatus, inspection);
  if (!decision.canStart) {
    throw new PreflightValidationError(
      decision.reasonCode ?? "build_retry_not_allowed",
      decision.reason ?? "Build retry cannot start",
    );
  }
}

export async function recoverStaleBuildRun(
  changeId: string,
  options: BuildStaleRunRecoveryOptions = {},
): Promise<{ recovered: boolean; runId?: string; buildRunNumber?: number; reason: string }> {
  const inspection = inspectStaleBuildRun(changeId, options);
  if (inspection.kind === "none") return { recovered: false, reason: inspection.reason };
  if (inspection.kind === "active") {
    throw new Error(`Build run is still active: ${inspection.reason}`);
  }

  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  if (inspection.kind === "stranded") {
    return recoverStrandedImplementClaim({
      changeId,
      repoPath: project.repoPath,
      buildRun: inspection.buildRun,
    });
  }

  const reason = "Build stale recovery: previous provider process exited before completion";
  // The workspace file write can't be made atomic with the DB (different
  // systems), so it stays first: if it fails, nothing in the DB has changed
  // yet. markBuildRunFailed is idempotent (unconditional overwrite), so if a
  // crash lands between it and the DB write below, the next inspection cycle
  // still finds this run `running` and safely retries the whole sequence. The
  // run-end and status writes, which ARE both DB, land in one transaction --
  // otherwise a crash between them leaves the run terminal with the status
  // stuck at IMPLEMENTING, invisible to recovery (D6 audit Tier 2).
  if (inspection.buildRun?.status === "running") {
    markBuildRunFailed({
      repoPath: project.repoPath,
      changeId,
      run: inspection.buildRun,
      reason,
    });
  }
  endStageRun({ changeId, runId: inspection.runId, status: "PLAN_APPROVED", summary: reason, success: false });
  return {
    recovered: true,
    runId: inspection.runId,
    buildRunNumber: inspection.buildRun?.runNumber,
    reason: "stale_build_run_recovered",
  };
}

/**
 * Repairs an IMPLEMENTING claim whose run row the sweeper already ended.
 *
 * There is no run to end here -- that half is done -- so this only moves the
 * change status and retires the abandoned workspace file.
 *
 * The write order is the reverse of the stale path above, deliberately. That
 * path can write the file first because the *run row* is its discriminator: a
 * crash in between leaves the run still `running`, so the next inspection
 * retries the whole sequence. Here the *file* is the discriminator, so
 * file-first would be a trap -- a crash before the status write would leave the
 * file `failed` and the change at IMPLEMENTING, which classifies as `none`
 * forever, re-creating exactly the dead end this repairs. Status first degrades
 * safely instead: the change reaches PLAN_APPROVED, where retry_build needs no
 * inspection at all, and the leftover file is superseded by the next run.
 */
function recoverStrandedImplementClaim(input: {
  changeId: string;
  repoPath: string;
  buildRun: BuildRunFile;
}): { recovered: boolean; runId?: string; buildRunNumber?: number; reason: string } {
  const reason = "Build stranded recovery: run already reconciled, no provider process survives";
  transitionChangeStatus({
    changeId: input.changeId,
    // The sweeper's own rollback target for this phase
    // (fallbackStatusByProviderPhase.implement), the status the stale path ends
    // recovered runs into, and a legal IMPLEMENTING exit in ALLOWED_TRANSITIONS.
    to: "PLAN_APPROVED",
    message: `Recovered stranded IMPLEMENTING: no implement run in flight`,
    rawJson: {
      source: "build_stage_stranded_status_recovery",
      phase: "implement",
      from: "IMPLEMENTING",
      buildRunNumber: input.buildRun.runNumber,
    },
  });
  markBuildRunFailed({
    repoPath: input.repoPath,
    changeId: input.changeId,
    run: input.buildRun,
    reason,
  });
  log.warn(
    { changeId: input.changeId, buildRunNumber: input.buildRun.runNumber },
    "Recovered change stranded at IMPLEMENTING with no implement run in flight",
  );
  return {
    recovered: true,
    buildRunNumber: input.buildRun.runNumber,
    reason: "stranded_build_claim_recovered",
  };
}
