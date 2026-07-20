import { and, eq, inArray, lte, or } from "drizzle-orm";

import { db } from "../db";
import { pipelineJobs, runs } from "../db/schema";

export type JobStoreDb = typeof db;
type JobStoreConnection = Pick<JobStoreDb, "select" | "update">;

export type PipelineJobRow = typeof pipelineJobs.$inferSelect;
export type SettledBusinessRun = typeof runs.$inferSelect;

/** A run that already reached a terminal status has nothing left to execute. */
const SETTLED_RUN_STATUSES = ["completed", "failed", "stopped"] as const;

let jobStoreDbForTest: JobStoreDb | null = null;

export function setJobStoreDbForTest(nextDb: JobStoreDb): () => void {
  const previous = jobStoreDbForTest;
  jobStoreDbForTest = nextDb;
  return () => {
    jobStoreDbForTest = previous;
  };
}

function getJobStoreDb(): JobStoreDb {
  return jobStoreDbForTest ?? db;
}

export interface JobFenceConditions {
  jobId: string;
  workerId: string;
  leaseToken: string;
  attemptNo: number;
}

function fenceConditions(context: JobFenceConditions) {
  return and(
    eq(pipelineJobs.id, context.jobId),
    eq(pipelineJobs.leasedBy, context.workerId),
    eq(pipelineJobs.leaseToken, context.leaseToken),
    eq(pipelineJobs.attemptNo, context.attemptNo),
    eq(pipelineJobs.status, "running"),
  );
}

export function createJobStoreRepository(connection: JobStoreConnection) {
  return {
    readJob(jobId: string): PipelineJobRow | null {
      return connection.select().from(pipelineJobs).where(eq(pipelineJobs.id, jobId)).get() ?? null;
    },

    /** Jobs eligible for a lease: queued, or running/leased past their lease expiry. */
    leaseCandidates(nowText: string): PipelineJobRow[] {
      return connection
        .select()
        .from(pipelineJobs)
        .where(
          or(
            eq(pipelineJobs.status, "queued"),
            and(eq(pipelineJobs.status, "running"), lte(pipelineJobs.leaseExpiresAt, nowText)),
            and(eq(pipelineJobs.status, "leased"), lte(pipelineJobs.leaseExpiresAt, nowText)),
          ),
        )
        .all()
        .sort((left, right) => {
          const byCreated = left.createdAt.localeCompare(right.createdAt);
          if (byCreated !== 0) return byCreated;
          return left.id.localeCompare(right.id);
        });
    },

    /**
     * The business run belonging to this job's current attempt, if it already
     * settled. A queued job has not produced a run yet, so it can never match.
     *
     * This is the one deliberate exception to "JobStore only touches
     * pipeline_jobs" -- the read exists to answer "is this job orphaned",
     * the same shape as stage-authority-repository's changeExists reading
     * `changes`.
     */
    settledRunForAttempt(job: PipelineJobRow): SettledBusinessRun | null {
      if (job.status === "queued" || !job.leaseToken) return null;
      return (
        connection
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.jobId, job.id),
              eq(runs.leaseToken, job.leaseToken),
              eq(runs.attemptNo, job.attemptNo),
              inArray(runs.status, [...SETTLED_RUN_STATUSES]),
            ),
          )
          .get() ?? null
      );
    },

    /** Settles a job whose business run already finished without the job closing. Returns rows changed. */
    settleOrphanedJob(input: {
      jobId: string;
      expectedStatus: string;
      expectedAttemptNo: number;
      settledRun: SettledBusinessRun;
      nowText: string;
    }): number {
      const result = connection
        .update(pipelineJobs)
        .set({
          status: input.settledRun.status === "completed" ? "succeeded" : "failed",
          leasedBy: null,
          leaseExpiresAt: null,
          heartbeatAt: input.nowText,
          endedAt: input.settledRun.endedAt ?? input.nowText,
          errorCode: input.settledRun.status === "completed" ? null : "run_settled_without_job_close",
          errorSummary: input.settledRun.status === "completed" ? null : input.settledRun.summary,
        })
        .where(
          and(
            eq(pipelineJobs.id, input.jobId),
            eq(pipelineJobs.status, input.expectedStatus),
            eq(pipelineJobs.attemptNo, input.expectedAttemptNo),
          ),
        )
        .run();
      return result.changes;
    },

    /** Grants a lease to a candidate via CAS on (id, status, attemptNo). Returns rows changed. */
    leaseJob(input: {
      jobId: string;
      expectedStatus: string;
      expectedAttemptNo: number;
      workerId: string;
      workerNonce: string;
      leaseToken: string;
      attemptNo: number;
      leaseExpiresAt: string;
      heartbeatAt: string;
      startedAt: string;
    }): number {
      const result = connection
        .update(pipelineJobs)
        .set({
          status: "running",
          leasedBy: input.workerId,
          leaseExpiresAt: input.leaseExpiresAt,
          heartbeatAt: input.heartbeatAt,
          attemptNo: input.attemptNo,
          leaseToken: input.leaseToken,
          workerNonce: input.workerNonce,
          startedAt: input.startedAt,
          endedAt: null,
          errorCode: null,
          errorSummary: null,
        })
        .where(
          and(
            eq(pipelineJobs.id, input.jobId),
            eq(pipelineJobs.status, input.expectedStatus),
            eq(pipelineJobs.attemptNo, input.expectedAttemptNo),
          ),
        )
        .run();
      return result.changes;
    },

    /** Fenced heartbeat renewal. Returns rows changed (0 means the fence no longer matches). */
    heartbeat(context: JobFenceConditions, heartbeatAt: string, leaseExpiresAt: string): number {
      return connection
        .update(pipelineJobs)
        .set({ heartbeatAt, leaseExpiresAt })
        .where(fenceConditions(context))
        .run().changes;
    },

    /** Fenced terminal update (succeeded/failed). Returns rows changed. */
    close(
      context: JobFenceConditions,
      patch: { status: "succeeded" | "failed"; endedAt: string; heartbeatAt: string; errorCode: string | null; errorSummary: string | null },
    ): number {
      return connection
        .update(pipelineJobs)
        .set({ ...patch, leaseExpiresAt: null })
        .where(fenceConditions(context))
        .run().changes;
    },
  };
}

export type JobStoreRepository = ReturnType<typeof createJobStoreRepository>;

export function withJobStoreTransaction<T>(
  callback: (repository: JobStoreRepository) => T,
): T {
  return getJobStoreDb().transaction((tx) =>
    callback(createJobStoreRepository(tx as JobStoreConnection)),
  );
}

/** Bound to the default (non-transactional) connection -- for single-statement CAS updates. */
export const jobStoreRepository: JobStoreRepository = {
  readJob: (...args) => createJobStoreRepository(getJobStoreDb()).readJob(...args),
  leaseCandidates: (...args) => createJobStoreRepository(getJobStoreDb()).leaseCandidates(...args),
  settledRunForAttempt: (...args) => createJobStoreRepository(getJobStoreDb()).settledRunForAttempt(...args),
  settleOrphanedJob: (...args) => createJobStoreRepository(getJobStoreDb()).settleOrphanedJob(...args),
  leaseJob: (...args) => createJobStoreRepository(getJobStoreDb()).leaseJob(...args),
  heartbeat: (...args) => createJobStoreRepository(getJobStoreDb()).heartbeat(...args),
  close: (...args) => createJobStoreRepository(getJobStoreDb()).close(...args),
};
