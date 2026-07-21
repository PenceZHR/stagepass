import type { ChangeStatus } from "../types";
import {
  MAX_FIX_ITERATIONS,
  maxFixIterationsErrorMessage,
} from "./iteration-policy";

export class IllegalTransitionError extends Error {
  constructor(from: ChangeStatus, to: ChangeStatus) {
    super(`Illegal status transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class TransitionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionInvariantError";
  }
}

/**
 * Statuses that mean "a run of this change is in flight", which is what the
 * one-active-change invariant below is about.
 *
 * DELIVERY_PENDING is deliberately ABSENT, for the same reason RETRO_PENDING's
 * presence here is a wart rather than a precedent: the change is parked waiting
 * for a human to press the button, and the delivery stage's own running status
 * is DELIVERY_PENDING only because it, like retro, fails back onto itself.
 * Adding it would forbid starting any sibling change in the project until
 * someone clicks 运行交付 -- i.e. it would turn "I have not read the delivery
 * note yet" into a project-wide lock.
 */
export const RUNNING_CHANGE_STATUSES = new Set<ChangeStatus>([
  "PLANNING",
  "SPECCING",
  "TECHSPECCING",
  "TESTPLANNING",
  "IMPLEMENTING",
  "REVIEWING",
  "CHECKING",
  "FIXING",
  "MERGING",
  "RETRO_PENDING",
]);

export const ALLOWED_TRANSITIONS: ReadonlyMap<ChangeStatus, ReadonlySet<ChangeStatus>> = new Map([
  ["REFINING", new Set(["DRAFT", "BLOCKED"])],
  ["DRAFT", new Set(["REFINING", "BLOCKED"])],
  ["INTAKE_PENDING", new Set(["INTAKE_READY", "BLOCKED"])],
  ["INTAKE_READY", new Set(["SPECCING", "BLOCKED"])],
  ["SPECCING", new Set(["SPECCING", "SPEC_READY", "BLOCKED"])],
  ["SPEC_READY", new Set(["INTAKE_READY", "TECHSPECCING", "BLOCKED"])],
  ["TECHSPECCING", new Set(["TECHSPEC_READY", "SPEC_READY", "BLOCKED"])],
  ["TECHSPEC_READY", new Set(["SPEC_READY", "PLANNING", "BLOCKED"])],
  ["PLANNING", new Set(["PLAN_READY", "TECHSPEC_READY", "BLOCKED"])],
  ["PLAN_READY", new Set(["PLANNING", "PLAN_APPROVED", "TECHSPEC_READY", "BLOCKED"])],
  ["PLAN_APPROVED", new Set(["TESTPLANNING", "IMPLEMENTING", "BLOCKED"])],
  ["TESTPLANNING", new Set(["TESTPLAN_DONE", "PLAN_APPROVED", "BLOCKED"])],
  ["TESTPLAN_DONE", new Set(["PLAN_APPROVED", "BLOCKED"])],
  ["IMPLEMENTING", new Set(["IMPLEMENTING", "IMPLEMENTED", "PLAN_APPROVED", "BLOCKED"])],
  ["IMPLEMENTED", new Set(["REVIEWING", "CHECKING", "BLOCKED"])],
  ["REVIEWING", new Set(["IMPLEMENTED", "CHECK_FAILED", "BLOCKED"])],
  ["CHECKING", new Set(["MERGE_READY", "CHECK_FAILED", "SCOPE_FAILED", "PLAN_APPROVED", "LOCAL_READY", "BLOCKED"])],
  ["CHECK_FAILED", new Set(["FIXING", "REVIEWING", "CHECKING", "IMPLEMENTED", "BLOCKED"])],
  ["SCOPE_FAILED", new Set(["FIXING", "CHECKING", "BLOCKED"])],
  ["FIXING", new Set(["IMPLEMENTING", "IMPLEMENTED", "CHECKING", "CHECK_FAILED", "SCOPE_FAILED", "BLOCKED"])],
  ["LOCAL_READY", new Set(["MERGE_READY", "BLOCKED"])],
  ["MERGE_READY", new Set(["MERGING", "LOCAL_READY", "BLOCKED"])],
  ["MERGING", new Set(["RETRO_PENDING", "MERGE_READY", "BLOCKED"])],
  ["RETRO_PENDING", new Set(["DELIVERY_PENDING", "BLOCKED"])],
  ["DELIVERY_PENDING", new Set(["DONE", "BLOCKED"])],
  ["DONE", new Set<ChangeStatus>([])],
  [
    "BLOCKED",
    new Set([
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
      "DELIVERY_PENDING",
    ]),
  ],
]);

export function assertLegalTransition(from: ChangeStatus, to: ChangeStatus): void {
  if (!ALLOWED_TRANSITIONS.get(from)?.has(to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export interface TransitionInvariantInput {
  changeId: string;
  projectId: string;
  from: ChangeStatus;
  to: ChangeStatus;
  fixIterations: number;
  siblingRunningChanges: Array<{ id: string; status: ChangeStatus }>;
}

export function assertTransitionInvariants(input: TransitionInvariantInput): void {
  if (
    input.to === "FIXING" &&
    input.from !== "FIXING" &&
    input.fixIterations >= MAX_FIX_ITERATIONS
  ) {
    throw new TransitionInvariantError(maxFixIterationsErrorMessage());
  }

  if (!RUNNING_CHANGE_STATUSES.has(input.to)) return;
  const active = input.siblingRunningChanges.find((change) => change.id !== input.changeId);
  if (active) {
    throw new TransitionInvariantError(
      `Another change is active in project ${input.projectId}: ${active.id} (${active.status})`,
    );
  }
}
