import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claim,
  heartbeat,
  isExpired,
  recoveryFor,
  type Lease,
} from "./lease";

const T0 = 1_000_000;
const TTL = 30_000;
const DEADLINE = T0 + 300_000;

function lease(patch: Partial<Lease> = {}): Lease {
  return {
    owner: "worker-a",
    token: "tok-1",
    expiresAt: T0 + TTL,
    deadlineAt: DEADLINE,
    ...patch,
  };
}

describe("L1 · claiming work", () => {
  it("claims free work and bounds the lease by the deadline", () => {
    const result = claim({
      existing: null,
      owner: "worker-a",
      token: "tok-1",
      now: T0,
      ttlMs: TTL,
      deadlineAt: DEADLINE,
    });
    assert.equal(result.kind, "claimed");
    assert.deepEqual(result.kind === "claimed" ? result.lease : null, lease());
  });

  it("refuses work someone else still holds, and says who", () => {
    const result = claim({
      existing: lease(),
      owner: "worker-b",
      token: "tok-2",
      now: T0 + 1,
      ttlMs: TTL,
      deadlineAt: DEADLINE,
    });
    assert.deepEqual(result, {
      kind: "held",
      by: "worker-a",
      until: T0 + TTL,
    });
  });

  it("lets a second worker take over once the lease lapses", () => {
    const now = T0 + TTL;
    assert.ok(isExpired(lease(), now));
    const result = claim({
      existing: lease(),
      owner: "worker-b",
      token: "tok-2",
      now,
      ttlMs: TTL,
      deadlineAt: DEADLINE,
    });
    assert.equal(result.kind, "claimed");
    assert.equal(result.kind === "claimed" && result.lease.owner, "worker-b");
    assert.equal(result.kind === "claimed" && result.lease.token, "tok-2");
  });

  /**
   * A takeover inherits the original deadline. Restarting it would let a job be
   * passed between workers forever, each resetting the clock, and the hard cap
   * would never actually cap anything.
   */
  it("inherits the original deadline across a takeover", () => {
    const result = claim({
      existing: lease(),
      owner: "worker-b",
      token: "tok-2",
      now: T0 + TTL,
      ttlMs: TTL,
      deadlineAt: T0 + 9_000_000,
    });
    assert.equal(result.kind === "claimed" && result.lease.deadlineAt, DEADLINE);
  });

  it("never issues a lease that outlives the deadline", () => {
    const now = DEADLINE - 5;
    const result = claim({
      existing: null,
      owner: "worker-a",
      token: "tok-1",
      now,
      ttlMs: TTL,
      deadlineAt: DEADLINE,
    });
    assert.equal(result.kind === "claimed" && result.lease.expiresAt, DEADLINE);
  });
});

describe("L1 · the heartbeat that could not advance", () => {
  it("extends a live lease strictly forward", () => {
    const now = T0 + 10_000;
    const result = heartbeat({
      lease: lease(), owner: "worker-a", token: "tok-1", now, ttlMs: TTL,
    });
    assert.equal(result.kind, "extended");
    assert.ok(
      result.kind === "extended" && result.lease.expiresAt > lease().expiresAt,
    );
  });

  /**
   * The exact condition the old tree turned into a database ABORT: the lease is
   * pinned to the deadline, so the next heartbeat cannot move it forward. That
   * is an answer -- "this work has run as long as it may" -- not a corrupt
   * lease, and the caller has to be able to act on it.
   */
  it("reports the deadline instead of refusing to move", () => {
    const pinned = lease({ expiresAt: DEADLINE });
    const result = heartbeat({
      lease: pinned,
      owner: "worker-a",
      token: "tok-1",
      now: DEADLINE - 1,
      ttlMs: TTL,
    });
    assert.deepEqual(result, { kind: "deadline_reached" });
  });

  it("reports the deadline once it has actually passed", () => {
    assert.deepEqual(
      heartbeat({
        lease: lease({ expiresAt: DEADLINE + 10 }),
        owner: "worker-a",
        token: "tok-1",
        now: DEADLINE,
        ttlMs: TTL,
      }),
      { kind: "deadline_reached" },
    );
  });

  /**
   * A slow worker that was presumed dead must not be able to write after its
   * replacement took over. The token is what makes that impossible.
   */
  it("tells a superseded worker it has lost the work", () => {
    for (const wrong of [
      { owner: "worker-b", token: "tok-1" },
      { owner: "worker-a", token: "tok-2" },
    ]) {
      assert.deepEqual(
        heartbeat({ lease: lease(), ...wrong, now: T0 + 1, ttlMs: TTL }),
        { kind: "lost" },
      );
    }
  });

  it("tells a worker whose lease already lapsed that it lost the work", () => {
    assert.deepEqual(
      heartbeat({
        lease: lease(), owner: "worker-a", token: "tok-1",
        now: T0 + TTL, ttlMs: TTL,
      }),
      { kind: "lost" },
    );
  });
});

describe("L1 · work whose owner is gone has exactly two futures", () => {
  it("resumes when there are attempts left and time remains", () => {
    assert.deepEqual(
      recoveryFor({ lease: lease(), now: T0 + TTL, attempt: 1, maxAttempts: 3 }),
      { outcome: "resume", reason: "lease_lapsed" },
    );
  });

  it("fails explicitly once the deadline has passed", () => {
    assert.deepEqual(
      recoveryFor({ lease: lease(), now: DEADLINE, attempt: 1, maxAttempts: 3 }),
      { outcome: "fail", reason: "deadline_reached" },
    );
  });

  it("fails explicitly once the attempts are spent", () => {
    assert.deepEqual(
      recoveryFor({ lease: lease(), now: T0 + TTL, attempt: 3, maxAttempts: 3 }),
      { outcome: "fail", reason: "attempts_exhausted" },
    );
  });

  /**
   * There is no third answer on purpose. Anything that leaves work sitting in
   * `running` with nobody on it is the failure mode where a job looks alive
   * forever and nothing tells anyone.
   */
  it("never returns anything but resume or fail", () => {
    const cases = [
      { now: T0 + TTL, attempt: 0, maxAttempts: 3 },
      { now: DEADLINE + 1, attempt: 0, maxAttempts: 3 },
      { now: T0 + TTL, attempt: 99, maxAttempts: 3 },
      { now: DEADLINE, attempt: 99, maxAttempts: 3 },
    ];
    for (const input of cases) {
      const { outcome } = recoveryFor({ lease: lease(), ...input });
      assert.ok(outcome === "resume" || outcome === "fail");
    }
  });
});
