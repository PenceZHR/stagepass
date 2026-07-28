/**
 * Who owns a long-running piece of work, and for how long.
 *
 * ## The bug this shape exists to prevent
 *
 * The tree this replaces clamped a lease to the work's hard deadline while the
 * state machine separately required every heartbeat to move the expiry strictly
 * forward. Once a lease reached the deadline the two rules contradicted each
 * other, so every subsequent heartbeat was an invariant violation -- the work
 * was killed by a trigger ABORT rather than by anyone deciding it had run too
 * long. The failure was real and the message was about a database constraint.
 *
 * Here, "the deadline is reached" is a first-class OUTCOME, not an error state.
 * `heartbeat` returns it, the caller fails the job with a reason a person can
 * read, and nothing has to violate an invariant to make that happen.
 *
 * ## This module is pure
 *
 * `now` is a parameter. No clock, no database, no IO -- so every path,
 * including the ones that only occur seconds before a deadline, is provable
 * offline and instantly.
 */

export interface Lease {
  readonly owner: string;
  /**
   * Changes on every claim. A worker holding an old token cannot write, which
   * is what stops a process that was presumed dead -- but is merely slow --
   * from finishing work its replacement has already taken over.
   */
  readonly token: string;
  readonly expiresAt: number;
  /** The hard cap. The work may not run past it however often it heartbeats. */
  readonly deadlineAt: number;
}

export type ClaimResult =
  | { readonly kind: "claimed"; readonly lease: Lease }
  | { readonly kind: "held"; readonly by: string; readonly until: number };

export type HeartbeatResult =
  | { readonly kind: "extended"; readonly lease: Lease }
  /** Someone else owns it now. This worker must stop and touch nothing. */
  | { readonly kind: "lost" }
  /** The work has run as long as it is allowed to. Fail it, explicitly. */
  | { readonly kind: "deadline_reached" };

export function isExpired(lease: Lease, now: number): boolean {
  return lease.expiresAt <= now;
}

function isPastDeadline(lease: Lease, now: number): boolean {
  return lease.deadlineAt <= now;
}

/**
 * Take ownership. Free work, or work whose lease has lapsed, may be claimed;
 * live work belonging to someone else may not.
 */
export function claim(input: {
  existing: Lease | null;
  owner: string;
  token: string;
  now: number;
  ttlMs: number;
  deadlineAt: number;
}): ClaimResult {
  const { existing, owner, token, now, ttlMs } = input;
  if (existing && !isExpired(existing, now)) {
    return { kind: "held", by: existing.owner, until: existing.expiresAt };
  }
  // A takeover inherits the original deadline. Otherwise a job could be handed
  // between workers indefinitely, each restarting the clock, and the hard cap
  // would never be reached.
  const deadlineAt = existing?.deadlineAt ?? input.deadlineAt;
  return {
    kind: "claimed",
    lease: {
      owner,
      token,
      expiresAt: Math.min(now + ttlMs, deadlineAt),
      deadlineAt,
    },
  };
}

/**
 * Keep ownership alive.
 *
 * Returns `deadline_reached` rather than producing a lease that does not move
 * forward. That is the whole lesson: an expiry that cannot advance is not an
 * invariant to violate, it is an answer.
 */
export function heartbeat(input: {
  lease: Lease;
  owner: string;
  token: string;
  now: number;
  ttlMs: number;
}): HeartbeatResult {
  const { lease, owner, token, now, ttlMs } = input;
  if (lease.owner !== owner || lease.token !== token) return { kind: "lost" };
  if (isExpired(lease, now)) return { kind: "lost" };
  if (isPastDeadline(lease, now)) return { kind: "deadline_reached" };

  const extended = Math.min(now + ttlMs, lease.deadlineAt);
  // Strictly forward or not at all. Equal is not an extension -- it is the
  // deadline holding the expiry in place, which is exactly the condition the
  // old tree mistook for a corrupt lease.
  if (extended <= lease.expiresAt) return { kind: "deadline_reached" };
  return { kind: "extended", lease: { ...lease, expiresAt: extended } };
}

const RECOVERY_OUTCOMES = ["resume", "fail"] as const;
export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

/**
 * What to do with work whose owner is gone.
 *
 * There is deliberately no third answer. "正在执行的工作要么继续要么明确失败" --
 * anything that leaves work sitting in `running` with nobody on it is the
 * failure mode where a job looks alive forever and no one is told.
 */
export function recoveryFor(input: {
  lease: Lease;
  now: number;
  attempt: number;
  maxAttempts: number;
}): { outcome: RecoveryOutcome; reason: string } {
  if (isPastDeadline(input.lease, input.now)) {
    return { outcome: "fail", reason: "deadline_reached" };
  }
  if (input.attempt >= input.maxAttempts) {
    return { outcome: "fail", reason: "attempts_exhausted" };
  }
  return { outcome: "resume", reason: "lease_lapsed" };
}
