import type { Blocker, BlockerSeverity } from "./gate";

/**
 * A problem found in one round that outlives it.
 *
 * ## The rule this whole module exists for
 *
 * 「旧问题必须被明确复核，不能因为重新生成文档而消失」. A round that regenerates
 * its document and simply does not mention last round's problem must not
 * thereby resolve it. So:
 *
 *   silence keeps a gap open. closing one requires saying so, with a reason.
 *
 * Stated that way round deliberately. The opposite default -- "not re-reported
 * means fixed" -- is what makes a second round able to open a gate by
 * forgetting, and forgetting is the single most likely thing a model does.
 *
 * ## Why a waiver is not a close
 *
 * Closing says the problem is gone. Waiving says it is still there and someone
 * decided to live with it. Collapsing them would erase the difference between
 * "we fixed it" and "we shipped with it", which is precisely the distinction a
 * delivery note has to carry.
 *
 * ## This module is pure
 */

export const GAP_STATUSES = ["open", "closed", "waived"] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export interface Gap {
  readonly id: string;
  readonly severity: BlockerSeverity;
  readonly title: string;
  readonly status: GapStatus;
  /** The round that found it. */
  readonly openedRound: number;
  /** Why it was closed or waived. Never empty once it leaves `open`. */
  readonly resolution: string | null;
}

export type Verdict =
  /** The round checked and the problem is gone. */
  | { readonly kind: "closed"; readonly reason: string }
  /** The round checked and it still stands. */
  | { readonly kind: "still_open"; readonly reason: string };

export class InvalidVerdictError extends Error {
  constructor(readonly code: "reason_missing" | "unknown_gap") {
    super(code);
    this.name = "InvalidVerdictError";
  }
}

export interface RoundOutcome {
  readonly round: number;
  /** Problems this round found. Ids are stable, so re-finding is not re-adding. */
  readonly found: readonly { id: string; severity: BlockerSeverity; title: string }[];
  /** What this round says about gaps that were already open. */
  readonly verdicts: Readonly<Record<string, Verdict>>;
}

/**
 * The gaps after a round, given the gaps before it.
 *
 * Every previously-open gap is carried forward unless this round explicitly
 * closed it. A verdict naming a gap that is not open is refused rather than
 * ignored -- a round claiming to have closed something that was never there is
 * a round whose other claims are worth less.
 */
export function applyRound(
  before: readonly Gap[],
  outcome: RoundOutcome,
): Gap[] {
  const byId = new Map(before.map((gap) => [gap.id, gap]));

  for (const [gapId, verdict] of Object.entries(outcome.verdicts)) {
    const gap = byId.get(gapId);
    if (!gap || gap.status !== "open") {
      throw new InvalidVerdictError("unknown_gap");
    }
    if (verdict.reason.trim() === "") {
      // A close with no reason is indistinguishable from forgetting, and the
      // whole point here is that those two must not look the same.
      throw new InvalidVerdictError("reason_missing");
    }
    if (verdict.kind === "closed") {
      byId.set(gapId, { ...gap, status: "closed", resolution: verdict.reason });
    }
    // `still_open` changes nothing about the gap -- which is the point: it is
    // the same outcome as silence, and it is recorded on the round rather than
    // on the gap.
  }

  for (const found of outcome.found) {
    const existing = byId.get(found.id);
    if (existing) {
      // Re-finding a gap that was closed reopens it: the round looked and it is
      // there. Re-finding an open one changes nothing.
      if (existing.status === "closed") {
        byId.set(found.id, {
          ...existing,
          status: "open",
          resolution: null,
          openedRound: outcome.round,
        });
      }
      continue;
    }
    byId.set(found.id, {
      id: found.id,
      severity: found.severity,
      title: found.title,
      status: "open",
      openedRound: outcome.round,
      resolution: null,
    });
  }

  return [...byId.values()];
}

/**
 * A human deciding to live with a problem.
 *
 * Separate from `applyRound` because it is a different kind of act: a round
 * reports what it found, a person decides what to tolerate. The reason is
 * required -- 「用户接受已知风险时，必须能够看到风险并留下理由」.
 */
export function waive(gaps: readonly Gap[], gapId: string, reason: string): Gap[] {
  if (reason.trim() === "") throw new InvalidVerdictError("reason_missing");
  const gap = gaps.find((candidate) => candidate.id === gapId);
  if (!gap || gap.status !== "open") throw new InvalidVerdictError("unknown_gap");
  return gaps.map((candidate) =>
    candidate.id === gapId
      ? { ...candidate, status: "waived" as const, resolution: reason }
      : candidate);
}

/**
 * What the gate sees.
 *
 * Only open gaps. A waived one is not a blocker -- somebody accepted it, on the
 * record -- and a closed one is not a problem. P2 is carried too, because the
 * gate is what decides which severities block, not this.
 */
export function blockersFrom(gaps: readonly Gap[]): Blocker[] {
  return gaps
    .filter((gap) => gap.status === "open")
    .map((gap) => ({ id: gap.id, severity: gap.severity, title: gap.title }));
}

/** Gaps a human accepted, for the delivery note that has to list them. */
export function waivedFrom(gaps: readonly Gap[]): Gap[] {
  return gaps.filter((gap) => gap.status === "waived");
}
