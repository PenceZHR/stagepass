import type { Provider } from "./provider-selection-service";

export interface JobExecutionContext {
  jobId: string;
  workerId: string;
  leaseToken: string;
  attemptNo: number;
  /** Immutable provider selected when the pipeline job was enqueued. */
  provider?: Provider;
}

export class StaleLeaseFenceError extends Error {
  readonly code = "stale_lease_fence" as const;

  constructor(readonly context: JobExecutionContext) {
    super(
      `Stale lease fence for job ${context.jobId} attempt ${context.attemptNo}`,
    );
    this.name = "StaleLeaseFenceError";
  }
}
