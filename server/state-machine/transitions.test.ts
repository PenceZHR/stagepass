import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  IllegalTransitionError,
  RUNNING_CHANGE_STATUSES,
  TransitionInvariantError,
  assertLegalTransition,
  assertTransitionInvariants,
} from "./transitions.ts";

describe("change status transitions", () => {
  it("rejects gate-ready reruns that must be rejected first", () => {
    assert.throws(
      () => assertLegalTransition("SPEC_READY", "SPECCING"),
      IllegalTransitionError,
    );
    assert.throws(
      () => assertLegalTransition("TECHSPEC_READY", "TECHSPECCING"),
      IllegalTransitionError,
    );
    assert.throws(
      () => assertLegalTransition("PLAN_READY", "IMPLEMENTING"),
      IllegalTransitionError,
    );
    assert.throws(
      () => assertLegalTransition("TESTPLAN_DONE", "IMPLEMENTING"),
      IllegalTransitionError,
    );
  });

  it("rejects unsafe CHECK_FAILED repair back to IMPLEMENTING", () => {
    assert.throws(
      () => assertLegalTransition("CHECK_FAILED", "IMPLEMENTING"),
      IllegalTransitionError,
    );
  });

  it("allows audited Review blocker recovery through BLOCKED only", () => {
    assert.doesNotThrow(() => assertLegalTransition("IMPLEMENTING", "BLOCKED"));
    assert.doesNotThrow(() => assertLegalTransition("BLOCKED", "CHECK_FAILED"));
    assert.throws(
      () => assertLegalTransition("IMPLEMENTING", "CHECK_FAILED"),
      IllegalTransitionError,
    );
  });

  it("allows explicit reject paths from gate-ready states", () => {
    assert.doesNotThrow(() => assertLegalTransition("SPEC_READY", "INTAKE_READY"));
    assert.doesNotThrow(() => assertLegalTransition("TECHSPEC_READY", "SPEC_READY"));
    assert.doesNotThrow(() => assertLegalTransition("MERGE_READY", "LOCAL_READY"));
  });

  it("allows BLOCKED to restore every status that PRD revision can suspend", () => {
    const prdSuspendableStatuses = [
      "REFINING",
      "DRAFT",
      "INTAKE_PENDING",
      "INTAKE_READY",
      "SPECCING",
      "SPEC_READY",
      "TECHSPECCING",
      "TECHSPEC_READY",
      "PLANNING",
      "PLAN_READY",
      "PLAN_APPROVED",
      "TESTPLANNING",
      "TESTPLAN_DONE",
      "IMPLEMENTING",
      "IMPLEMENTED",
      "REVIEWING",
      "CHECKING",
      "CHECK_FAILED",
      "SCOPE_FAILED",
      "FIXING",
      "LOCAL_READY",
      "MERGE_READY",
      "MERGING",
      "RETRO_PENDING",
    ] as const;

    for (const status of prdSuspendableStatuses) {
      assert.doesNotThrow(() => assertLegalTransition("BLOCKED", status));
    }
    assert.throws(() => assertLegalTransition("BLOCKED", "DONE"), IllegalTransitionError);
  });

  it("uses one running-status set for all running invariants", () => {
    assert.deepEqual(
      [...RUNNING_CHANGE_STATUSES].sort(),
      [
        "CHECKING",
        "FIXING",
        "IMPLEMENTING",
        "MERGING",
        "PLANNING",
        "RETRO_PENDING",
        "REVIEWING",
        "SPECCING",
        "TECHSPECCING",
        "TESTPLANNING",
      ],
    );
  });

  it("enforces running mutual exclusion within a project", () => {
    assert.throws(
      () => assertTransitionInvariants({
        changeId: "CHG-2",
        projectId: "PRJ-1",
        from: "PLAN_APPROVED",
        to: "IMPLEMENTING",
        fixIterations: 0,
        siblingRunningChanges: [
          { id: "CHG-1", status: "FIXING" },
        ],
      }),
      TransitionInvariantError,
    );
  });

  it("allows entering FIXING before the 99-iteration ceiling", () => {
    assert.doesNotThrow(() => assertTransitionInvariants({
      changeId: "CHG-1",
      projectId: "PRJ-1",
      from: "CHECK_FAILED",
      to: "FIXING",
      fixIterations: 98,
      siblingRunningChanges: [],
    }));
  });

  it("blocks entering FIXING at 99 fix iterations", () => {
    assert.throws(
      () => assertTransitionInvariants({
        changeId: "CHG-1",
        projectId: "PRJ-1",
        from: "CHECK_FAILED",
        to: "FIXING",
        fixIterations: 99,
        siblingRunningChanges: [],
      }),
      /Max fix iterations \(99\) reached/,
    );
  });
});
