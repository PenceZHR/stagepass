import crypto from "crypto";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { battleRounds, changes, projects } from "../db/schema";
import {
  isOccupiedBattleRoundStatus,
  isRunningBattleRoundStatus,
} from "../types/enums";
import { battleRoundScope, isBattleRoundOfPhase } from "./battle-round-phase-scope";
import type { DelegatedRoundPhase } from "./delegated-round-phases";
import { emitIdempotentEvent } from "./event-service";
import type { RubricPhase } from "./rubric-assessment";

/**
 * The round ledger for the design phases that run as a delegated round, minus
 * Spec.
 *
 * ## Why this is a second ledger rather than a parameterised first one
 *
 * `spec-battle-service` is the only delegated path with real runtime evidence
 * behind it -- three consecutive rounds of CHG-006 against a live Codex App.
 * It also carries roughly fifty Spec-specific call sites spread over thirteen
 * exported functions, most of them entangled with the requirement-gap ledger,
 * the war report and the Spec stage authority. Parameterising it would put the
 * one proven path at risk to save writing the two hundred lines below, so Spec
 * keeps its ledger and the three new phases share this one. `openDelegatedRound`
 * refuses `Spec` outright rather than trusting the convention.
 *
 * ## What this owns, and what it deliberately does not
 *
 * Only the round row: its lifecycle, its numbering and its per-phase slot. The
 * artifacts a round produces belong to each phase's own persister, and the gap
 * ledger belongs to whatever ends up writing gaps -- keeping those out means a
 * settle here cannot half-write a round, which is §7.3's rule ("finish every
 * check before anything lands") applied to the ledger itself.
 *
 * ## Why every operation takes the descriptor
 *
 * `battle_rounds` is one table holding every phase's rounds, so a round id
 * alone does not say which phase's slot it occupies. Passing the descriptor
 * makes the phase part of every call, and `round_phase_mismatch` turns a
 * cross-phase mistake into a refusal instead of a silent write to the wrong
 * phase's slot. See battle-round-phase-scope.ts for what went wrong when the
 * readers left the phase implicit.
 */

const TEMPLATE = "DELEGATED_ROUND_V1";

/**
 * Every phase this ledger owns. Spec is excluded because it has its own.
 *
 * Typed as a literal tuple rather than `RubricPhase[]` so `DelegatedLedgerPhase`
 * narrows to the three. That narrowing is load-bearing downstream: stage
 * authority takes `PipelinePhase`, which has no Refine/Fix/Retro/Done, and a
 * widened phase would have needed a cast at the gate write -- the exact place a
 * cast would let a phase with no stage gate through.
 */
export const DELEGATED_LEDGER_PHASES = ["TechSpec", "Plan", "TestPlan"] as const satisfies
  readonly RubricPhase[];

export type DelegatedLedgerPhase = (typeof DELEGATED_LEDGER_PHASES)[number];

/** Narrows a rubric phase to one this ledger owns. */
export function isDelegatedLedgerPhase(phase: RubricPhase): phase is DelegatedLedgerPhase {
  return (DELEGATED_LEDGER_PHASES as readonly RubricPhase[]).includes(phase);
}

export class DelegatedRoundLedgerError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "DelegatedRoundLedgerError";
  }
}

export interface DelegatedRoundLedgerState {
  latestRound: typeof battleRounds.$inferSelect | null;
  rounds: Array<typeof battleRounds.$inferSelect>;
}

export interface OpenedDelegatedRound {
  roundId: string;
  roundNo: number;
  status: string;
}

/** Rounds of one phase, oldest first. */
function phaseRounds(
  changeId: string,
  phase: RubricPhase,
): Array<typeof battleRounds.$inferSelect> {
  return db
    .select()
    .from(battleRounds)
    .where(battleRoundScope(changeId, phase))
    .all()
    .sort((a, b) => a.roundNo - b.roundNo || a.createdAt.localeCompare(b.createdAt));
}

export function getDelegatedRoundState(
  changeId: string,
  phase: RubricPhase,
): DelegatedRoundLedgerState {
  const rounds = phaseRounds(changeId, phase);
  return { latestRound: rounds.at(-1) ?? null, rounds };
}

function nowISO(): string {
  return new Date().toISOString();
}

function nextRoundId(): string {
  return `BRD-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function assertLedgerOwnsPhase(
  descriptor: DelegatedRoundPhase,
): asserts descriptor is DelegatedRoundPhase & { phase: DelegatedLedgerPhase } {
  if (!isDelegatedLedgerPhase(descriptor.phase)) {
    throw new DelegatedRoundLedgerError(
      "phase_has_own_ledger",
      `${descriptor.phase} keeps its own round ledger; this one must not write its rounds`,
    );
  }
}

function requireChange(changeId: string) {
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new DelegatedRoundLedgerError("change_not_found", `Change not found: ${changeId}`);
  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) {
    throw new DelegatedRoundLedgerError("project_not_found", `Project not found: ${change.projectId}`);
  }
  return { change, project };
}

/**
 * The round row this call is about, checked against both the change and the
 * phase before anything reads its status.
 *
 * The phase check is not redundant with the id: `battle_rounds` holds every
 * phase's rounds, so a TechSpec round id handed to a Plan call would otherwise
 * settle, fail or park a round belonging to a phase the caller was not acting
 * on.
 */
function requireRound(input: {
  changeId: string;
  descriptor: DelegatedRoundPhase;
  roundId: string;
}): typeof battleRounds.$inferSelect {
  const round = db.select().from(battleRounds).where(eq(battleRounds.id, input.roundId)).get();
  if (!round) throw new DelegatedRoundLedgerError("round_not_found");
  if (round.changeId !== input.changeId) throw new DelegatedRoundLedgerError("round_change_mismatch");
  if (!isBattleRoundOfPhase(round, input.descriptor.phase)) {
    throw new DelegatedRoundLedgerError(
      "round_phase_mismatch",
      `round ${input.roundId} is a ${round.phase} round, not ${input.descriptor.phase}`,
    );
  }
  return round;
}

function requireCurrentRound(input: {
  changeId: string;
  descriptor: DelegatedRoundPhase;
  roundId: string;
}): typeof battleRounds.$inferSelect {
  const round = requireRound(input);
  const current = phaseRounds(input.changeId, input.descriptor.phase).at(-1);
  if (!current || current.id !== round.id) {
    throw new DelegatedRoundLedgerError("round_not_current");
  }
  return round;
}

/**
 * Opens the next round of a phase.
 *
 * `inputSnapshotJson` records what the round was opened against. It is
 * deliberately thin compared with Spec's: Spec freezes the PRD and the open gap
 * set because its round is judged against them, whereas these phases have their
 * own upstream snapshots (`techspec_snapshots`, `plan_steps`,
 * `testplan_snapshots`) already under stage authority. Duplicating those here
 * would create a second copy that can disagree with the first.
 */
export async function openDelegatedRound(input: {
  changeId: string;
  descriptor: DelegatedRoundPhase;
  maxRounds?: number;
}): Promise<OpenedDelegatedRound> {
  assertLedgerOwnsPhase(input.descriptor);
  requireChange(input.changeId);

  const rounds = phaseRounds(input.changeId, input.descriptor.phase);
  if (input.maxRounds !== undefined && rounds.length >= input.maxRounds) {
    throw new DelegatedRoundLedgerError("round_limit_reached");
  }
  const current = rounds.at(-1);
  if (current && isOccupiedBattleRoundStatus(current.status)) {
    throw new DelegatedRoundLedgerError("round_occupied");
  }

  const roundNo = (rounds.at(-1)?.roundNo ?? 0) + 1;
  const roundId = nextRoundId();
  const now = nowISO();
  db.insert(battleRounds).values({
    id: roundId,
    changeId: input.changeId,
    phase: input.descriptor.phase,
    template: TEMPLATE,
    roundNo,
    status: "not_started",
    redUnit: input.descriptor.redUnit,
    blueUnit: input.descriptor.blueUnit,
    inputSnapshotJson: JSON.stringify({
      authority: "db",
      phase: input.descriptor.phase,
      openedAt: now,
    }),
    paramsJson: JSON.stringify({ maxRounds: input.maxRounds ?? null }),
    redArtifactPath: null,
    redArtifactHash: null,
    blueArtifactPath: null,
    blueArtifactHash: null,
    reportPath: null,
    supersededByRoundId: null,
    startedAt: now,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  }).run();

  return { roundId, roundNo, status: "not_started" };
}

/**
 * Supersedes a settled round and opens the next one.
 *
 * This is the human saying "keep going" on a round that produced a report --
 * the `request_*_changes` action. It is one call rather than a supersede
 * followed by an open, because the two must not be separable: a supersede that
 * committed without its successor would leave the phase with no round at all
 * and no record that one was asked for.
 *
 * `reason` is required and not defaulted. Another round costs a full
 * red/blue/judge cycle, so the record has to say who asked and why; filling it
 * in server-side would keep the guard's shape while destroying what it guards.
 */
export async function openNextDelegatedRound(input: {
  changeId: string;
  descriptor: DelegatedRoundPhase;
  reason: string;
  maxRounds?: number;
}): Promise<OpenedDelegatedRound> {
  assertLedgerOwnsPhase(input.descriptor);
  if (input.reason.trim().length === 0) {
    throw new DelegatedRoundLedgerError("decision_reason_required");
  }
  const current = getDelegatedRoundState(input.changeId, input.descriptor.phase).latestRound;
  if (!current) throw new DelegatedRoundLedgerError("round_not_found");
  // Only a round that actually reported. Superseding one still in flight would
  // throw away work in progress, and superseding a failed one would hide the
  // failure behind a fresh round nobody could tell was a retry.
  if (current.status !== "report_ready") {
    throw new DelegatedRoundLedgerError("round_not_ready", `round status is ${current.status}`);
  }

  const now = nowISO();
  db.update(battleRounds)
    .set({ status: "superseded", updatedAt: now })
    .where(eq(battleRounds.id, current.id))
    .run();

  let opened: OpenedDelegatedRound;
  try {
    opened = await openDelegatedRound({
      changeId: input.changeId,
      descriptor: input.descriptor,
      maxRounds: input.maxRounds,
    });
  } catch (err) {
    // Put the settled round back. Without this a round-limit refusal would
    // leave the phase with a superseded round and no successor -- no report to
    // approve and no round to continue.
    db.update(battleRounds)
      .set({ status: current.status, updatedAt: nowISO() })
      .where(eq(battleRounds.id, current.id))
      .run();
    throw err;
  }

  db.update(battleRounds)
    .set({ supersededByRoundId: opened.roundId, updatedAt: nowISO() })
    .where(eq(battleRounds.id, current.id))
    .run();

  emitIdempotentEvent({
    id: `EVT-delegated-next-round-${opened.roundId}`,
    changeId: input.changeId,
    runId: null,
    type: "delegated_round_next_requested",
    message: `Human requested another ${input.descriptor.phase} round: ${input.reason}`,
    rawJson: {
      delegatedRoundNextRequested: {
        schemaVersion: "delegated_round_next_requested/v1",
        phase: input.descriptor.phase,
        supersededRoundId: current.id,
        roundId: opened.roundId,
        roundNo: opened.roundNo,
        reason: input.reason,
      },
    },
  });
  return opened;
}

/**
 * Marks a round as executing.
 *
 * Separate from `open` because the two happen at different moments and for
 * different reasons: a round exists as soon as the phase decides to run one,
 * but it is only `red_running` once a worker has actually taken it. Collapsing
 * them would make a round that was opened and never picked up
 * indistinguishable from one whose sides are mid-flight.
 */
export function claimDelegatedRound(input: {
  changeId: string;
  descriptor: DelegatedRoundPhase;
  roundId: string;
}): void {
  assertLedgerOwnsPhase(input.descriptor);
  const round = requireCurrentRound(input);
  if (round.status !== "not_started") {
    throw new DelegatedRoundLedgerError("round_not_claimable", `round status is ${round.status}`);
  }
  db.update(battleRounds)
    .set({ status: "red_running", updatedAt: nowISO() })
    .where(eq(battleRounds.id, input.roundId))
    .run();
}

/**
 * Settles a round that actually ran.
 *
 * One step rather than Spec's two (`completeRed` then `completeBlue`) because a
 * delegated round produces all three parts in a single turn and
 * `readDelegatedRound` has already refused it unless every part validated. A
 * two-step settle here would reintroduce exactly the half-round it prevents:
 * a committed red leg with no critic reads to every later query as a critic
 * that found nothing.
 */
export function settleDelegatedRound(input: {
  changeId: string;
  descriptor: DelegatedRoundPhase;
  roundId: string;
  redArtifactPath: string;
  redArtifactHash: string;
  blueArtifactPath: string;
  blueArtifactHash: string;
}): void {
  assertLedgerOwnsPhase(input.descriptor);
  const round = requireCurrentRound(input);
  if (!isRunningBattleRoundStatus(round.status)) {
    throw new DelegatedRoundLedgerError("round_not_ready", `round status is ${round.status}`);
  }
  const now = nowISO();
  db.update(battleRounds)
    .set({
      status: "report_ready",
      redArtifactPath: input.redArtifactPath,
      redArtifactHash: input.redArtifactHash,
      blueArtifactPath: input.blueArtifactPath,
      blueArtifactHash: input.blueArtifactHash,
      endedAt: now,
      updatedAt: now,
    })
    .where(eq(battleRounds.id, input.roundId))
    .run();
}

export function failDelegatedRound(input: {
  changeId: string;
  descriptor: DelegatedRoundPhase;
  roundId: string;
  reason: string;
}): void {
  assertLedgerOwnsPhase(input.descriptor);
  const round = requireCurrentRound(input);
  const now = nowISO();
  db.update(battleRounds)
    .set({ status: "failed", endedAt: now, updatedAt: now })
    .where(eq(battleRounds.id, input.roundId))
    .run();
  emitIdempotentEvent({
    id: `EVT-delegated-round-failed-${input.roundId}-${round.roundNo}`,
    changeId: input.changeId,
    runId: null,
    type: "delegated_round_failed",
    message: `Delegated ${input.descriptor.phase} round ${round.roundNo} failed: ${input.reason}`,
    rawJson: {
      delegatedRoundFailure: {
        schemaVersion: "delegated_round_failure/v1",
        phase: input.descriptor.phase,
        roundId: input.roundId,
        roundNo: round.roundNo,
        reason: input.reason,
      },
    },
  });
}

const CLARIFICATION_PAUSE_EVENT = "delegated_round_clarification_pause";

/**
 * Parks a round on the human without ending it.
 *
 * `endedAt` stays null on purpose. Nothing failed -- the turn handed its
 * questions over and is waiting -- and a round with an end time reads to every
 * later query as one that finished. The leg it was parked from is recorded on
 * the event, because the round row has no column for it and resuming has to put
 * the round back where it left rather than at a fixed status.
 */
export function pauseDelegatedRound(input: {
  changeId: string;
  descriptor: DelegatedRoundPhase;
  roundId: string;
}): void {
  assertLedgerOwnsPhase(input.descriptor);
  const round = requireCurrentRound(input);
  if (!isRunningBattleRoundStatus(round.status)) {
    throw new DelegatedRoundLedgerError("round_not_in_flight", `round status is ${round.status}`);
  }
  db.update(battleRounds)
    .set({ status: "awaiting_clarification", updatedAt: nowISO() })
    .where(eq(battleRounds.id, input.roundId))
    .run();
  emitIdempotentEvent({
    id: `EVT-delegated-clarification-pause-${input.roundId}-${round.status}`,
    changeId: input.changeId,
    runId: null,
    type: CLARIFICATION_PAUSE_EVENT,
    message: `Delegated ${input.descriptor.phase} round parked awaiting human clarification`,
    rawJson: {
      delegatedRoundClarificationPause: {
        schemaVersion: "delegated_round_clarification_pause/v1",
        phase: input.descriptor.phase,
        roundId: input.roundId,
        roundNo: round.roundNo,
        resumeStatus: round.status,
      },
    },
  });
}

export interface DelegatedRoundResumeResult {
  resumed: boolean;
  roundId: string;
  status: string;
}

/**
 * Returns a parked round to the leg it was parked from.
 *
 * Idempotent by status rather than by a flag: adoption can deliver the same
 * converged answer more than once, and a second resume must not restart a round
 * that has since settled, failed or been superseded.
 */
export function resumeDelegatedRound(input: {
  changeId: string;
  descriptor: DelegatedRoundPhase;
  roundId: string;
}): DelegatedRoundResumeResult {
  assertLedgerOwnsPhase(input.descriptor);
  const round = requireCurrentRound(input);
  if (round.status !== "awaiting_clarification") {
    return { resumed: false, roundId: round.id, status: round.status };
  }
  // Always `red_running`, and not because the parked leg was not recorded --
  // the pause event carries it. A delegated round runs red and blue inside ONE
  // judge turn, so `blue_running` is a status this ledger never writes and a
  // resume can never land on. Spec's two-leg lookup exists because Spec really
  // does have two separately resumable turns; copying it here would be a branch
  // that can only ever take one path, which is worse than no branch at all.
  const status = "red_running";
  db.update(battleRounds)
    .set({ status, updatedAt: nowISO() })
    .where(eq(battleRounds.id, input.roundId))
    .run();
  return { resumed: true, roundId: round.id, status };
}
