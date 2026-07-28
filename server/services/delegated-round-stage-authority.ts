import type { DelegatedLedgerPhase } from "./delegated-round-ledger";
import { getGaps, toRuleGap } from "./spec-battle-row-readers";
import { isSpecBlockingGap } from "./spec-battle-rules";
import {
  peekStageAuthority,
  recomputeStageGate,
  type StageGateRecord,
} from "./stage-authority-service";

/**
 * Adds a settled round's open blocking gaps to its phase's stage gate.
 *
 * ## Why a settled round is not a passed gate
 *
 * The single-turn producer path for TechSpec ends with
 * `recomputeStageGate({ status: "passed", blockers: [] })` -- unconditionally,
 * because a producer with no critic has nobody who could raise a blocker. With a
 * round that reasoning stops holding: blue's whole job is to raise gaps, so a
 * round that settles with three open P0s must leave the gate BLOCKED. Letting
 * the round reuse the producer's gate call would have passed a gate over the
 * critic's objections -- the half-round the handoff's §7.3 warns about, with the
 * blocking half never reaching the gate.
 *
 * ## Why this appends instead of writing the gate outright
 *
 * The phase has already written its own gate by the time this runs, and that
 * gate carries blockers this module knows nothing about -- TestPlan's content
 * blockers and its approval blocker, for instance. A gate written from the gaps
 * alone would silently drop them, turning "this test plan has no coverage for
 * two acceptance criteria" into a pass. So the base blockers are read back and
 * kept, and only the round's own are replaced.
 *
 * This is the same shape as `syncRubricStageGateBlockers`, and for the same
 * reason. The one difference is what identifies "our" blockers: rubric blockers
 * are recognised by an id prefix, and a gap blocker is recognised by being in
 * the phase's gap ledger.
 *
 * ## What still closes the gate
 *
 * Nothing here. Clearing the round's blockers restores whatever status the
 * phase's own gate had; it never invents a pass. The HUMAN decision that moves
 * `change.gateState` on is a separate act, exactly as `applySpecBattleDecision`
 * is for Spec -- a round the model liked is not a round the human approved.
 */

type StoredBlocker = { id: string; severity: string; title: string };

function readStoredBlockers(value: string | null): StoredBlocker[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredBlocker =>
        typeof entry === "object" && entry !== null && typeof (entry as StoredBlocker).id === "string",
    );
  } catch {
    return [];
  }
}

function readJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type DelegatedRoundGateSyncResult =
  | { applied: true; gate: StageGateRecord }
  | { applied: false; reason: "no_gate" | "unchanged" };

export function syncDelegatedRoundStageAuthority(input: {
  changeId: string;
  phase: DelegatedLedgerPhase;
  roundId: string;
}): DelegatedRoundGateSyncResult {
  const gate = peekStageAuthority(input.changeId, input.phase).latestGate;
  // The phase has not written a gate yet. Writing the first gate row a phase
  // ever had, from here, would state a verdict about inputs this module never
  // looked at.
  if (!gate) return { applied: false, reason: "no_gate" };

  const gaps = getGaps(input.changeId, input.phase);
  const gapIds = new Set(gaps.map((gap) => gap.id));
  const derived = gaps
    .filter((gap) => isSpecBlockingGap(toRuleGap(gap)))
    .map((gap) => ({
      id: gap.id,
      severity: (gap.downgradedTo ?? gap.severity) as "P0" | "P1",
      title: gap.title,
    }));

  const stored = readStoredBlockers(gate.blockersJson);
  // "Ours" is membership of this phase's gap ledger, not an id prefix: a gap
  // that blue resolved this round is gone from `derived` but still in the
  // ledger, and it has to be dropped from the gate rather than mistaken for a
  // base blocker and kept forever.
  const base = stored.filter((entry) => !gapIds.has(entry.id));

  const previousIds = stored.filter((entry) => gapIds.has(entry.id)).map((entry) => entry.id).sort();
  const nextIds = derived.map((entry) => entry.id).sort();
  const unchanged =
    previousIds.length === nextIds.length && previousIds.every((id, index) => id === nextIds[index]);
  // Never append a gate row that says the same thing: every row bumps
  // gate_version, and preflight rejects a bumped version as `gate_version_drift`,
  // so a no-op write breaks in-flight clients for nothing.
  if (unchanged) return { applied: false, reason: "unchanged" };

  const freshness = readJson(gate.freshnessJson);
  const previousMarker =
    freshness.delegatedRound && typeof freshness.delegatedRound === "object"
      ? (freshness.delegatedRound as Record<string, unknown>)
      : {};
  // The status to fall back to once the round's blockers clear -- captured the
  // first time this phase blocks, so a second round cannot record "blocked" as
  // the thing to restore.
  const baseStatus = typeof previousMarker.baseStatus === "string"
    ? previousMarker.baseStatus
    : gate.status;

  const nextFreshness: Record<string, unknown> = { ...freshness };
  if (derived.length > 0) {
    nextFreshness.delegatedRound = { baseStatus, roundId: input.roundId, gapIds: nextIds };
  } else {
    delete nextFreshness.delegatedRound;
  }

  return {
    applied: true,
    gate: recomputeStageGate({
      changeId: input.changeId,
      phase: input.phase,
      status: derived.length > 0 ? "blocked" : baseStatus,
      blockers: [...base, ...derived],
      freshness: nextFreshness,
      // Kept as the phase advertised it. The remedy for a gap is another round
      // or a human decision, and inventing a required action here would name an
      // action id nothing has registered -- a button that cannot resolve.
      requiredActions: readJsonArray(gate.requiredActionsJson),
      sourceDbHash: gate.sourceDbHash,
    }),
  };
}
