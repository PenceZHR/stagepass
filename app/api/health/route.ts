import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

import { db } from "@/server/db";
import { changes } from "@/server/db/schema";
import { readSupervisorHealth } from "@/server/services/supervisor-health-service";
import {
  getStartupRecoverySnapshot,
} from "@/server/services/startup-recovery-service";
import { recoverStaleProviderRuns } from "@/server/services/stale-provider-run-recovery-service";

interface HealthRouteDeps {
  probeDb: () => void;
  inspectStaleRunning: () => number | Promise<number>;
}

let healthRouteDepsForTest: Partial<HealthRouteDeps> | null = null;

export function setHealthRouteDependenciesForTest(
  deps: Partial<HealthRouteDeps> | null,
): () => void {
  const previous = healthRouteDepsForTest;
  healthRouteDepsForTest = deps;
  return () => {
    healthRouteDepsForTest = previous;
  };
}

function healthLogDir(): string {
  return process.env.STAGEPASS_LOG_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), "logs");
}

function healthRouteDeps(): HealthRouteDeps {
  return {
    probeDb: () => {
      db.select({ id: changes.id }).from(changes).limit(1).all();
    },
    inspectStaleRunning: async () =>
      (await recoverStaleProviderRuns({ execute: false })).observed
        .filter((result) => result.kind === "stale").length,
    ...(healthRouteDepsForTest ?? {}),
  };
}

export async function GET() {
  const logDir = healthLogDir();
  const supervisor = readSupervisorHealth(path.join(logDir, "supervisor-health.json"));
  const recovery = getStartupRecoverySnapshot();
  const recoveryIncomplete = recovery.status === "partial" || recovery.status === "failed";
  const deps = healthRouteDeps();
  let dbOk = true;
  let dbError: { code: string; message: string } | null = null;
  let staleRunningCount = recovery.staleCount;
  try {
    deps.probeDb();
    if (staleRunningCount === 0) {
      staleRunningCount = await deps.inspectStaleRunning();
    }
  } catch (error) {
    console.error("Health database probe failed", error);
    dbOk = false;
    dbError = { code: "DATABASE_UNAVAILABLE", message: "Database health probe failed" };
    staleRunningCount = -1;
  }
  const ok = !recoveryIncomplete && dbOk;

  return NextResponse.json({
    ok,
    service: "stagepass",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    db: { ok: dbOk, error: dbError },
    logs: {
      exists: fs.existsSync(logDir),
    },
    recovery: {
      status: recovery.status,
      lastRunAt: recovery.lastRunAt,
      recoveredCount: recovery.recoveredCount,
      failedCount: recovery.failedCount,
      partial: recovery.status === "partial",
      deferredCount: recovery.deferredCount,
      error: recoveryIncomplete
        ? {
            code: recovery.status === "partial"
              ? "STARTUP_RECOVERY_INCOMPLETE"
              : "STARTUP_RECOVERY_FAILED",
            message: "Startup recovery is incomplete",
          }
        : null,
    },
    staleRunning: {
      count: staleRunningCount,
    },
    worker: {
      mode: "external_worker",
      healthy: Boolean(supervisor?.worker.pid && !supervisor.worker.crashLoop),
      lastHeartbeatAt: supervisor?.worker.lastHealthAt ?? null,
    },
    supervisor: {
      next: {
        portListening: supervisor?.next.portListening ?? false,
      },
      worker: {
        crashLoop: supervisor?.worker.crashLoop ?? false,
      },
    },
  }, { status: ok ? 200 : 503 });
}
