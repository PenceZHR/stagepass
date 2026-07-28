import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { JobNotFoundError, JobStore, NotJobOwnerError } from "./job-store";

const AT = "2026-07-28T00:00:00.000Z";
const T0 = 1_000_000;
const TTL = 30_000;
const DEADLINE = T0 + 300_000;

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const now = () => new Date(AT);
  new ChangeStore(database, { now }).create("CHG-1");
  const jobs = new JobStore(database, now);
  return { database, jobs };
}

function enqueue(jobs: JobStore, id = "JOB-1", maxAttempts = 3) {
  return jobs.enqueue({
    id, changeId: "CHG-1", kind: "phase_turn",
    deadlineAt: DEADLINE, maxAttempts,
  });
}

describe("L1 · claiming work", () => {
  it("hands out queued work once, with a lease", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      const claimed = jobs.claimNext({
        owner: "w-a", token: "t-1", now: T0, ttlMs: TTL,
      });
      assert.equal(claimed?.status, "running");
      assert.equal(claimed?.attempt, 1);
      assert.equal(claimed?.lease?.owner, "w-a");
      // A second worker finds nothing: the job is no longer queued.
      assert.equal(
        jobs.claimNext({ owner: "w-b", token: "t-2", now: T0, ttlMs: TTL }),
        null,
      );
    } finally {
      database.close();
    }
  });

  it("reports an unknown job instead of returning an empty one", () => {
    const { database, jobs } = open();
    try {
      assert.throws(() => jobs.read("JOB-NOPE"), JobNotFoundError);
    } finally {
      database.close();
    }
  });

  it("returns nothing when there is nothing to do", () => {
    const { database, jobs } = open();
    try {
      assert.equal(
        jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL }),
        null,
      );
    } finally {
      database.close();
    }
  });

  /**
   * A worker must never receive work that cannot legitimately run. Failing it
   * at the point of claim is what keeps "retried forever" from being possible.
   */
  it("fails work whose attempts are spent instead of handing it out", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs, "JOB-1", 1);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      jobs.recover(T0 + TTL); // lease lapses, attempt 1 of 1 -> requeued? no
      // recoveryFor fails it: attempt (1) >= maxAttempts (1).
      const job = jobs.read("JOB-1");
      assert.equal(job.status, "failed");
      assert.equal(job.error, "attempts_exhausted");
    } finally {
      database.close();
    }
  });
});

describe("L1 · heartbeats and the deadline", () => {
  it("extends a live claim", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      const result = jobs.heartbeat({
        jobId: "JOB-1", owner: "w-a", token: "t-1",
        now: T0 + 10_000, ttlMs: TTL,
      });
      assert.equal(result.kind, "extended");
      assert.equal(jobs.read("JOB-1").lease?.expiresAt, T0 + 40_000);
    } finally {
      database.close();
    }
  });

  /**
   * The old tree's bug, now an outcome: once the lease is pinned to the
   * deadline the heartbeat cannot advance, and the correct response is to end
   * the work with a reason a person can read -- not to violate an invariant.
   */
  it("ends the work when the deadline is reached, with that as the reason", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: DEADLINE - 1_000, ttlMs: TTL });
      // The claim was clamped to the deadline; the next heartbeat cannot move it.
      assert.equal(jobs.read("JOB-1").lease?.expiresAt, DEADLINE);

      const result = jobs.heartbeat({
        jobId: "JOB-1", owner: "w-a", token: "t-1",
        now: DEADLINE - 500, ttlMs: TTL,
      });
      assert.deepEqual(result, { kind: "deadline_reached" });

      const job = jobs.read("JOB-1");
      assert.equal(job.status, "failed");
      assert.equal(job.error, "deadline_reached");
      assert.equal(job.lease, null);
    } finally {
      database.close();
    }
  });

  it("tells a superseded worker it lost the job", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      assert.deepEqual(
        jobs.heartbeat({
          jobId: "JOB-1", owner: "w-b", token: "t-1",
          now: T0 + 1, ttlMs: TTL,
        }),
        { kind: "lost" },
      );
    } finally {
      database.close();
    }
  });
});

describe("L1 · finishing work requires owning it", () => {
  it("completes and releases the lease", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      const done = jobs.complete({ jobId: "JOB-1", owner: "w-a", token: "t-1" });
      assert.equal(done.status, "done");
      assert.equal(done.lease, null);
    } finally {
      database.close();
    }
  });

  it("records a reason on every failure", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      const failed = jobs.fail({
        jobId: "JOB-1", owner: "w-a", token: "t-1", reason: "provider_refused",
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.error, "provider_refused");
    } finally {
      database.close();
    }
  });

  /**
   * A worker presumed dead but merely slow must not be able to finish work its
   * replacement has taken over.
   */
  it("refuses a worker that does not hold the token", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      for (const wrong of [
        { owner: "w-b", token: "t-1" },
        { owner: "w-a", token: "t-9" },
      ]) {
        assert.throws(
          () => jobs.complete({ jobId: "JOB-1", ...wrong }),
          NotJobOwnerError,
        );
      }
      assert.equal(jobs.read("JOB-1").status, "running");
    } finally {
      database.close();
    }
  });
});

describe("L1 · work whose owner vanished is always resolved", () => {
  it("requeues it when attempts and time remain", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      const summary = jobs.recover(T0 + TTL);
      assert.deepEqual(summary, { resumed: ["JOB-1"], failed: [] });

      const job = jobs.read("JOB-1");
      assert.equal(job.status, "queued");
      assert.equal(job.lease, null);
      // Another worker can now pick it up, and the attempt count carries over.
      const retaken = jobs.claimNext({
        owner: "w-b", token: "t-2", now: T0 + TTL, ttlMs: TTL,
      });
      assert.equal(retaken?.attempt, 2);
    } finally {
      database.close();
    }
  });

  it("fails it once the deadline has passed", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      const summary = jobs.recover(DEADLINE + 1);
      assert.deepEqual(summary.failed, [
        { id: "JOB-1", reason: "deadline_reached" },
      ]);
      assert.equal(jobs.read("JOB-1").error, "deadline_reached");
    } finally {
      database.close();
    }
  });

  it("leaves live work alone", () => {
    const { database, jobs } = open();
    try {
      enqueue(jobs);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      assert.deepEqual(jobs.recover(T0 + 1), { resumed: [], failed: [] });
      assert.equal(jobs.read("JOB-1").status, "running");
    } finally {
      database.close();
    }
  });

  /**
   * The property that matters most at this layer: after recovery runs, no job
   * is both un-owned and still claiming to be running. That state is where work
   * looks alive forever and nothing tells anyone.
   */
  it("leaves nothing running with nobody on it", () => {
    const { database, jobs } = open();
    try {
      for (const id of ["JOB-1", "JOB-2", "JOB-3"]) enqueue(jobs, id);
      jobs.claimNext({ owner: "w-a", token: "t-1", now: T0, ttlMs: TTL });
      jobs.claimNext({ owner: "w-b", token: "t-2", now: T0, ttlMs: TTL });
      jobs.recover(DEADLINE + 1);

      const orphaned = database.prepare(
        "SELECT count(*) AS n FROM jobs WHERE status = 'running' AND (owner IS NULL OR expires_at <= ?)",
      ).get(DEADLINE + 1) as { n: number };
      assert.equal(orphaned.n, 0);
    } finally {
      database.close();
    }
  });
});

describe("L1 · the schema refuses a job row that cannot be true", () => {
  it("refuses running with no owner", () => {
    const { database } = open();
    try {
      assert.throws(
        () => database.prepare(
          `INSERT INTO jobs
             (id, change_id, kind, status, attempt, max_attempts,
              owner, token, expires_at, deadline_at, error, created_at, updated_at)
           VALUES ('JOB-BAD', 'CHG-1', 'k', 'running', 1, 3,
                   NULL, NULL, NULL, ?, NULL, ?, ?)`,
        ).run(DEADLINE, AT, AT),
        /CHECK constraint failed/,
      );
    } finally {
      database.close();
    }
  });

  it("refuses a failure with no reason", () => {
    const { database } = open();
    try {
      assert.throws(
        () => database.prepare(
          `INSERT INTO jobs
             (id, change_id, kind, status, attempt, max_attempts,
              owner, token, expires_at, deadline_at, error, created_at, updated_at)
           VALUES ('JOB-BAD', 'CHG-1', 'k', 'failed', 1, 3,
                   NULL, NULL, NULL, ?, NULL, ?, ?)`,
        ).run(DEADLINE, AT, AT),
        /CHECK constraint failed/,
      );
    } finally {
      database.close();
    }
  });
});
