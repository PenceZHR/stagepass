import fs from "node:fs";
import path from "node:path";

import { db } from "../db";
import { changes } from "../db/schema";
import {
  recoverStaleProviderRuns,
  type ProviderRunRecoveryReport,
  type RecoveryCursor,
} from "./stale-provider-run-recovery-service";

export interface StartupRecoveryResult {
  ok: boolean;
  partial: boolean;
  lastRunAt: string;
  logsDir: string;
  recoveredCount: number;
  staleCount: number;
  failedCount: number;
  deferredCount: number;
}

export interface StartupRecoverySnapshot {
  status: "idle" | "running" | "completed" | "partial" | "failed";
  lastRunAt: string | null;
  recoveredCount: number;
  staleCount: number;
  failedCount: number;
  deferredCount: number;
  error: string | null;
}

interface StartupRecoveryDeps {
  logDir: string;
  now: () => Date;
  ensureLogs: (logDir: string) => void;
  checkDb: () => void;
  recover: (execute: boolean, cursor?: RecoveryCursor) => Promise<ProviderRunRecoveryReport>;
  writeLog: (logDir: string, line: string) => void;
}

let startupRecoveryPromise: Promise<StartupRecoveryResult> | null = null;
let startupRecoveryCursor: RecoveryCursor | undefined;
let snapshot: StartupRecoverySnapshot = {
  status: "idle",
  lastRunAt: null,
  recoveredCount: 0,
  staleCount: 0,
  failedCount: 0,
  deferredCount: 0,
  error: null,
};

let depsForTest: Partial<StartupRecoveryDeps> | null = null;

function defaultDeps(): StartupRecoveryDeps {
  return {
    logDir: process.env.STAGEPASS_LOG_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), "logs"),
    now: () => new Date(),
    ensureLogs: (logDir) => {
      fs.mkdirSync(logDir, { recursive: true });
    },
    checkDb: () => {
      db.select({ id: changes.id }).from(changes).limit(1).all();
    },
    recover: (execute, cursor) => recoverStaleProviderRuns({ execute, cursor }),
    writeLog: (logDir, line) => {
      fs.appendFileSync(path.join(logDir, "startup-recovery.log"), `${line}\n`, "utf-8");
    },
  };
}

function activeDeps(): StartupRecoveryDeps {
  return { ...defaultDeps(), ...(depsForTest ?? {}) };
}

export function resetStartupRecoveryForTest(): void {
  startupRecoveryPromise = null;
  startupRecoveryCursor = undefined;
  snapshot = {
    status: "idle",
    lastRunAt: null,
    recoveredCount: 0,
    staleCount: 0,
    failedCount: 0,
    deferredCount: 0,
    error: null,
  };
  depsForTest = null;
}

export function setStartupRecoveryDependenciesForTest(
  deps: Partial<StartupRecoveryDeps>,
): () => void {
  const previous = depsForTest;
  depsForTest = deps;
  startupRecoveryPromise = null;
  startupRecoveryCursor = undefined;
  return () => {
    depsForTest = previous;
    startupRecoveryPromise = null;
    startupRecoveryCursor = undefined;
  };
}

export function getStartupRecoverySnapshot(): StartupRecoverySnapshot {
  return { ...snapshot };
}

async function runStartupRecovery(): Promise<StartupRecoveryResult> {
  const deps = activeDeps();
  const lastRunAt = deps.now().toISOString();
  let recoveredCount = 0;
  let staleCount = 0;
  let failedCount = 0;
  let deferredCount = 0;
  snapshot = {
    status: "running",
    lastRunAt,
    recoveredCount: 0,
    staleCount: 0,
    failedCount: 0,
    deferredCount: 0,
    error: null,
  };

  try {
    deps.ensureLogs(deps.logDir);
    deps.checkDb();
    const recoveryResults = await deps.recover(true, startupRecoveryCursor);
    startupRecoveryCursor = recoveryResults.nextCursor ?? undefined;
    const staleResults = await deps.recover(false);
    const recoveryDeferred = recoveryResults.deferred ?? [];
    const staleDeferred = staleResults.deferred ?? [];
    recoveredCount = recoveryResults.recovered.length;
    failedCount = recoveryResults.failed.length;
    deferredCount = recoveryDeferred.reduce((total, item) => total + item.count, 0)
      + staleDeferred.reduce((total, item) => total + item.count, 0);
    staleCount = staleResults.observed.filter((result) => result.kind === "stale").length;
    if (failedCount > 0) {
      const failedRuns = recoveryResults.failed.map((failure) => failure.runId).join(", ");
      throw new Error(`${failedCount} run recovery failed: ${failedRuns}`);
    }
    const partial = Boolean(recoveryResults.truncated)
      || Boolean(staleResults.truncated)
      || recoveryDeferred.length > 0
      || staleDeferred.length > 0;
    const result: StartupRecoveryResult = {
      ok: !partial,
      partial,
      lastRunAt,
      logsDir: deps.logDir,
      recoveredCount,
      staleCount,
      failedCount,
      deferredCount,
    };
    snapshot = {
      status: partial ? "partial" : "completed",
      lastRunAt,
      recoveredCount,
      staleCount,
      failedCount,
      deferredCount,
      error: null,
    };
    deps.writeLog(
      deps.logDir,
      JSON.stringify({
        timestamp: lastRunAt,
        event: partial ? "startup_recovery_partial" : "startup_recovery_completed",
        recoveredCount,
        staleCount,
        failedCount,
        partial,
        deferredCount,
      }),
    );
    if (partial) startupRecoveryPromise = null;
    else startupRecoveryCursor = undefined;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    snapshot = {
      status: "failed",
      lastRunAt,
      recoveredCount,
      staleCount,
      failedCount,
      deferredCount,
      error: message,
    };
    startupRecoveryPromise = null;
    throw error;
  }
}

export function ensureStartupRecovery(): Promise<StartupRecoveryResult> {
  startupRecoveryPromise ??= Promise.resolve().then(() => runStartupRecovery());
  return startupRecoveryPromise;
}

export async function observeStartupRecoveryForScopedRead(): Promise<void> {
  if (snapshot.status === "failed") return;
  try {
    await ensureStartupRecovery();
  } catch {
    // Scoped recovery remains authoritative for a single-change read surface.
  }
}
