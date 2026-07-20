export interface PipelineWorkerRecoveryReport {
  recovered: unknown[];
  failed: unknown[];
  deferred: unknown[];
  truncated: boolean;
}

interface PipelineWorkerRecoverySweeperOptions {
  intervalMs: number;
  nowMs?: () => number;
  recover: () => Promise<PipelineWorkerRecoveryReport>;
  log: (event: string, fields: Record<string, unknown>) => void;
}

export function createPipelineWorkerRecoverySweeper(
  options: PipelineWorkerRecoverySweeperOptions,
): () => Promise<boolean> {
  let lastSweepAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  return async (): Promise<boolean> => {
    const observedAt = (options.nowMs ?? Date.now)();
    if (inFlight || (lastSweepAt !== null && observedAt - lastSweepAt < options.intervalMs)) {
      return false;
    }
    lastSweepAt = observedAt;
    inFlight = (async () => {
      try {
        const report = await options.recover();
        options.log("pipeline_worker_recovery_completed", {
          recoveredCount: report.recovered.length,
          failedCount: report.failed.length,
          deferredCount: report.deferred.length,
          truncated: report.truncated,
        });
      } catch (error) {
        options.log("pipeline_worker_recovery_failed", {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
    return true;
  };
}

export function startPipelineWorkerRecoveryScheduler(
  options: PipelineWorkerRecoverySweeperOptions,
): () => Promise<void> {
  let stopped = false;
  let activeSweep: Promise<boolean> | null = null;
  const sweep = createPipelineWorkerRecoverySweeper(options);
  const run = () => {
    if (stopped || activeSweep) return;
    activeSweep = sweep().finally(() => {
      activeSweep = null;
    });
  };
  run();
  const timer = setInterval(run, options.intervalMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await activeSweep;
  };
}
