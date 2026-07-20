import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  completePipelineJob,
  failPipelineJob,
  heartbeatPipelineJob,
  leaseNextPipelineJob,
  type LeasedPipelineJobPayload,
} from "../server/services/pipeline-job-lease-service";
import { runPipelineJob } from "../server/services/pipeline-job-runner-service";
import type { PipelineJobRunnerMap } from "../server/services/pipeline-job-runner-service";
import { resolveAcceptanceInjection } from "../server/services/acceptance-injection-service";
import type { JobExecutionContext } from "../server/services/job-execution-context";
import {
  activeProviderRegistry,
  installActiveProviderSignalHandlers,
  type ActiveProviderRegistry,
} from "../server/services/active-provider-registry";
import {
  writeWorkerHeartbeat,
  type WorkerHeartbeat,
} from "../server/services/supervisor-health-service";
import { recoverStaleProviderRunsBestEffort } from "../server/services/stale-provider-run-recovery-service";
import { startPipelineWorkerRecoveryScheduler } from "../server/services/pipeline-worker-recovery-service";
import { closeDatabaseHandle, migrateDatabase } from "../server/db/index";

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_PATH = path.join(LOG_DIR, "pipeline-worker.log");
const IDLE_SLEEP_MS = 1000;
const HEARTBEAT_MS = (() => {
  const parsed = Number.parseInt(process.env.PIPELINE_WORKER_JOB_HEARTBEAT_MS ?? "10000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();
const PROCESS_HEARTBEAT_PATH = process.env.PIPELINE_WORKER_HEARTBEAT_FILE
  ?? path.join(LOG_DIR, "pipeline-worker-heartbeat.json");
const PROCESS_HEARTBEAT_MS = (() => {
  const parsed = Number.parseInt(process.env.PIPELINE_WORKER_PROCESS_HEARTBEAT_MS ?? "10000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();
const STDOUT_ONLY = process.env.PIPELINE_WORKER_STDOUT_ONLY === "1";
const RECOVERY_SWEEP_MS = (() => {
  const parsed = Number.parseInt(process.env.PIPELINE_WORKER_RECOVERY_SWEEP_MS ?? "15000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
})();

let stopping = false;

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  });
  if (!STDOUT_ONLY) {
    ensureLogDir();
    fs.appendFileSync(LOG_PATH, `${line}\n`, "utf-8");
  }
  process.stdout.write(`${line}\n`);
}

function logBestEffort(event: string, fields: Record<string, unknown> = {}): void {
  try {
    log(event, fields);
  } catch (error) {
    try {
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "pipeline_worker_log_failed",
        failedEvent: event,
        error: errorSummary(error),
      })}\n`);
    } catch {
      // Fatal cleanup must continue even when every log sink is unavailable.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function digestLeaseToken(leaseToken: string): string {
  return createHash("sha256").update(leaseToken).digest("hex").slice(0, 16);
}

function publishWorkerHeartbeat(state: WorkerHeartbeat): void {
  state.observedAt = new Date().toISOString();
  writeWorkerHeartbeat(PROCESS_HEARTBEAT_PATH, state);
}

async function runLeasedJob(
  job: LeasedPipelineJobPayload,
  workerId: string,
  processHeartbeat: WorkerHeartbeat,
): Promise<void> {
  const context: JobExecutionContext = {
    jobId: job.job.id,
    workerId,
    leaseToken: job.job.leaseToken!,
    attemptNo: job.job.attemptNo,
    provider: job.job.provider,
  };
  processHeartbeat.currentJob = {
    jobId: context.jobId,
    attemptNo: context.attemptNo,
    leaseTokenDigest: digestLeaseToken(context.leaseToken),
  };
  processHeartbeat.lastJobAt = new Date().toISOString();
  publishWorkerHeartbeat(processHeartbeat);
  log("pipeline_job_started", {
    workerId,
    jobId: job.job.id,
    changeId: job.job.changeId,
    phase: job.job.phase,
    actionId: job.job.actionId,
    provider: job.job.provider,
    attemptNo: job.job.attemptNo,
    leaseTokenDigest: digestLeaseToken(context.leaseToken),
  });
  heartbeatPipelineJob(context);
  log("pipeline_job_heartbeat", { workerId, jobId: job.job.id });
  const heartbeat = setInterval(() => {
    try {
      heartbeatPipelineJob(context);
      log("pipeline_job_heartbeat", { workerId, jobId: job.job.id });
    } catch (error) {
      log("pipeline_job_heartbeat_failed", {
        workerId,
        jobId: job.job.id,
        error: errorSummary(error),
      });
    }
  }, HEARTBEAT_MS);

  try {
    await runPipelineJob(job, context, { runnerMap: acceptanceWorkerRunnerMap() });
    completePipelineJob(context);
    log("pipeline_job_succeeded", { workerId, jobId: job.job.id });
  } catch (error) {
    const summary = errorSummary(error);
    failPipelineJob({
      ...context,
      errorCode: "pipeline_job_failed",
      errorSummary: summary.slice(0, 4000),
    });
    log("pipeline_job_failed", {
      workerId,
      jobId: job.job.id,
      error: summary,
    });
  } finally {
    clearInterval(heartbeat);
    processHeartbeat.currentJob = null;
    processHeartbeat.lastJobAt = new Date().toISOString();
    publishWorkerHeartbeat(processHeartbeat);
  }
}

function acceptanceWorkerRunnerMap(): PipelineJobRunnerMap | undefined {
  const barrier = resolveAcceptanceInjection()?.workerBarrier;
  if (!barrier) return undefined;
  return {
    "tech_spec:run_tech_spec": async (_job, context) => {
      fs.writeFileSync(`${barrier}.started`, JSON.stringify({
        jobId: context.jobId,
        workerId: context.workerId,
        leaseToken: context.leaseToken,
        attemptNo: context.attemptNo,
        observedAt: new Date().toISOString(),
      }));
      while (fs.existsSync(barrier)) await sleep(25);
    },
  };
}

function installPipelineWorkerSignalHandlers(
  workerId: string,
  stopRecovery: () => Promise<void>,
): () => void {
  let shutdown: Promise<void> | null = null;
  const requestShutdown = (signal: NodeJS.Signals): Promise<void> => {
    shutdown ??= (async () => {
      log("pipeline_worker_signal", { workerId, signal });
      stopping = true;
      await stopRecovery();
      await activeProviderRegistry.handleSignal(signal);
    })();
    return shutdown;
  };
  const shutdownRegistry = {
    handleSignal: requestShutdown,
  } as ActiveProviderRegistry;
  return installActiveProviderSignalHandlers(shutdownRegistry);
}

export async function runPipelineWorker(): Promise<void> {
  if (process.env.STAGEPASS_DB_BOOTSTRAPPED !== "1") {
    migrateDatabase();
  }
  ensureLogDir();
  const workerId = process.env.PIPELINE_WORKER_ID;
  const instanceNonce = process.env.PIPELINE_WORKER_INSTANCE_NONCE;
  if (!workerId || !instanceNonce) {
    throw new Error("Pipeline worker identity must be assigned by the supervisor");
  }
  const workerNonce = instanceNonce;
  const processHeartbeat: WorkerHeartbeat = {
    pid: process.pid,
    workerId,
    workerNonce,
    instanceNonce,
    observedAt: new Date().toISOString(),
    health: "healthy",
    fatalKind: null,
    currentJob: null,
    lastJobAt: null,
  };
  publishWorkerHeartbeat(processHeartbeat);
  const processHeartbeatTimer = setInterval(() => {
    try {
      publishWorkerHeartbeat(processHeartbeat);
    } catch (error) {
      log("pipeline_worker_process_heartbeat_failed", {
        workerId,
        error: errorSummary(error),
      });
    }
  }, PROCESS_HEARTBEAT_MS);
  log("pipeline_worker_started", {
    workerId,
    workerNonceDigest: digestLeaseToken(workerNonce),
    instanceNonceDigest: digestLeaseToken(instanceNonce),
    pid: process.pid,
  });

  const stopRecovery = startPipelineWorkerRecoveryScheduler({
    intervalMs: RECOVERY_SWEEP_MS,
    recover: () => recoverStaleProviderRunsBestEffort(),
    log,
  });
  const removeSignalHandlers = installPipelineWorkerSignalHandlers(workerId, stopRecovery);
  let fatalShutdown: Promise<void> | null = null;
  const requestFatalShutdown = (
    kind: "uncaughtException" | "unhandledRejection",
    error: unknown,
  ): Promise<void> => {
    fatalShutdown ??= (async () => {
      stopping = true;
      await stopRecovery();
      clearInterval(processHeartbeatTimer);
      process.exitCode = 1;
      processHeartbeat.health = "fatal";
      processHeartbeat.fatalKind = kind;
      try {
        try {
          publishWorkerHeartbeat(processHeartbeat);
        } catch (heartbeatError) {
          logBestEffort("pipeline_worker_fatal_heartbeat_failed", {
            workerId,
            kind,
            error: errorSummary(heartbeatError),
          });
        }
        logBestEffort("pipeline_worker_fatal", { workerId, kind, error: errorSummary(error) });
      } finally {
        try {
          await activeProviderRegistry.handleSignal("SIGTERM");
        } catch (providerError) {
          logBestEffort("pipeline_worker_fatal_provider_shutdown_failed", {
            workerId,
            kind,
            error: errorSummary(providerError),
          });
        }
      }
    })();
    return fatalShutdown;
  };
  const onUncaughtException = (error: Error) => {
    void requestFatalShutdown("uncaughtException", error);
  };
  const onUnhandledRejection = (reason: unknown) => {
    void requestFatalShutdown("unhandledRejection", reason);
  };
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  while (!stopping) {
    try {
      const job = leaseNextPipelineJob({ workerId, workerNonce });
      if (!job) {
        await sleep(IDLE_SLEEP_MS);
        continue;
      }
      await runLeasedJob(job, workerId, processHeartbeat);
    } catch (error) {
      log("pipeline_worker_loop_error", { workerId, error: errorSummary(error) });
      await sleep(IDLE_SLEEP_MS);
    }
  }

  await stopRecovery();
  removeSignalHandlers();
  clearInterval(processHeartbeatTimer);
  await fatalShutdown;
  process.off("uncaughtException", onUncaughtException);
  process.off("unhandledRejection", onUnhandledRejection);
  if (fatalShutdown) {
    logBestEffort("pipeline_worker_stopped", { workerId });
  } else {
    log("pipeline_worker_stopped", { workerId });
  }
  closeDatabaseHandle();
}

function isDirectWorkerEntry(entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  try {
    return fs.realpathSync(path.resolve(entryPath)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entryPath) === fileURLToPath(import.meta.url);
  }
}

if (isDirectWorkerEntry(process.argv[1])) {
  void runPipelineWorker().catch((error) => {
    closeDatabaseHandle();
    process.exitCode = 1;
    logBestEffort("pipeline_worker_fatal", { error: errorSummary(error) });
  });
}
