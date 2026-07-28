import { createChildLogger } from "../logger";
import { getActions } from "./action-contract-service";
import {
  HumanInteractionBroker,
  type DesignInteractionPhase,
} from "./human-interaction-broker";
import type { InteractionEnvelope } from "./interaction-types";
import { peekStageAuthority } from "./stage-authority-service";
import { getGaps, toRuleGap } from "./spec-battle-row-readers";
import { isSpecBlockingGap } from "./spec-battle-rules";

const log = createChildLogger("design-gate-decision-presenter");

/**
 * Opens the human's decision card once a design phase's round has settled.
 *
 * ## The hole this fills
 *
 * Everything needed to put a gate decision in front of a human already existed
 * and none of it ran. `HumanInteractionBroker.ensureDesignInteraction` creates
 * the interaction, enqueues its `interaction_present` job, expires it when the
 * gate moves, and dedupes on (change, kind, gateVersion, sourceDbHash) --
 * a complete mechanism with no caller anywhere in the pipeline.
 *
 * Meanwhile the web deliberately refuses to route `approve_*` / `waive_*`
 * (NON_POST_ROUTED_ACTION_IDS), on the grounds that those decisions belong on
 * the Codex decision surface. So on a change whose Spec round had settled, the
 * web said "not here" and Codex was never asked: `SELECT count(*) FROM
 * codex_interactions WHERE kind='gate_decision'` returned 0 across the entire
 * database. The forward exit from Spec existed in neither surface -- which is
 * exactly the shape of a mechanism that looks armed and is not.
 *
 * ## Why this reads the contract rather than being told it
 *
 * `ensureInteraction` refuses a card whose (gateVersion, sourceDbHash) does not
 * match a real `stage_gates` row -- `interaction_source_contract_stale`. A
 * caller that passed its own idea of the contract would be the thing that goes
 * stale, so the values are read back from stage authority at the moment the
 * card is opened, and the action list is filtered to what the contract
 * currently has ENABLED. A card offering a disabled action is a button that
 * fails on click.
 *
 * ## Why failures here are swallowed
 *
 * It runs after the round has already settled and the gate has already been
 * written. A card that cannot be opened -- the binding is not ready, the Codex
 * task is gone -- must not undo a finished round; the change simply stays where
 * it is, with the same actions it already had, and the operator gets a log line.
 * Losing the card costs a click; losing the round costs a full red/blue/judge
 * cycle.
 */

const DECISION_ACTIONS: Record<DesignInteractionPhase, readonly string[]> = {
  Spec: ["approve_spec", "reject_spec", "waive_spec_p1", "request_spec_changes"],
  TechSpec: ["approve_tech_spec", "reject_tech_spec", "request_tech_spec_changes"],
  Plan: ["approve_plan", "waive_plan_p1", "reject_plan", "request_plan_changes"],
  TestPlan: ["reject_test_plan", "request_test_plan_changes"],
};

const TITLES: Record<DesignInteractionPhase, string> = {
  Spec: "Spec 对抗已出结果，请裁决",
  TechSpec: "TechSpec 对抗已出结果，请裁决",
  Plan: "Plan 对抗已出结果，请裁决",
  TestPlan: "TestPlan 对抗已出结果，请裁决",
};

type StoredBlocker = { id: string; severity: string; title: string };

function readBlockers(value: string | null): StoredBlocker[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is StoredBlocker =>
        typeof entry === "object" && entry !== null
        && typeof (entry as StoredBlocker).id === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeSeverity(value: string): "P0" | "P1" | "P2" {
  return value === "P0" || value === "P1" ? value : "P2";
}

/**
 * Action ids the contract has enabled, in the order the phase declares.
 *
 * COMPUTED, not read back from `stage_actions`. That table is a cache written
 * the last time something called `getActions`, and a round that has just settled
 * has moved the gate several versions past it -- observed at gate 37 against
 * rows still stamped 34, which made every decision action look absent and the
 * card was skipped as "nothing to decide". `getActions` recomputes and
 * persists, so it is also what makes the rows the human's next request reads
 * agree with the card they were just shown.
 */
function enabledDecisionActions(input: {
  changeId: string;
  phase: DesignInteractionPhase;
}): { actionIds: string[]; gateVersion: string; sourceDbHash: string } | null {
  const wanted = new Set(DECISION_ACTIONS[input.phase]);
  const live = getActions(input.changeId).filter((action) => wanted.has(action.actionId));
  const enabled = live.filter((action) => action.enabled);
  const first = enabled[0];
  // The contract stamps every action with the gate it was computed against, so
  // taking it from there -- rather than reading the gate separately -- removes
  // the window where the two could disagree. `ensureInteraction` refuses a
  // mismatch as `interaction_source_contract_stale`, so that window was the
  // whole bug.
  if (!first?.gateVersion || !first.sourceDbHash) return null;
  return {
    actionIds: DECISION_ACTIONS[input.phase]
      .filter((actionId) => enabled.some((action) => action.actionId === actionId)),
    gateVersion: first.gateVersion,
    sourceDbHash: first.sourceDbHash,
  };
}

export function presentDesignGateDecision(input: {
  changeId: string;
  phase: DesignInteractionPhase;
  roundNo: number;
  /** Identifies the settled round, so a re-run of the same round reuses the card. */
  reportHash: string;
  broker?: HumanInteractionBroker;
}): InteractionEnvelope | null {
  try {
    const contract = enabledDecisionActions({
      changeId: input.changeId,
      phase: input.phase,
    });
    // A card with nothing on it is worse than no card: it interrupts the human
    // to show them a decision they cannot make.
    if (!contract) {
      log.info(
        { changeId: input.changeId, phase: input.phase },
        "No decision action is enabled, so no card is opened",
      );
      return null;
    }
    const { actionIds, gateVersion, sourceDbHash } = contract;
    const gate = peekStageAuthority(input.changeId, input.phase).latestGate;

    const gaps = getGaps(input.changeId, input.phase);
    const blockers = readBlockers(gate?.blockersJson ?? null).map((blocker) => ({
      id: blocker.id,
      severity: normalizeSeverity(blocker.severity),
      title: blocker.title,
    }));

    const broker = input.broker ?? new HumanInteractionBroker();
    return broker.ensureDesignInteraction({
      changeId: input.changeId,
      phase: input.phase,
      kind: "gate_decision",
      title: TITLES[input.phase],
      summary: `第 ${input.roundNo} 轮已结算，${
        blockers.length > 0 ? `仍有 ${blockers.length} 项阻断` : "没有阻断项"
      }。`,
      actionIds,
      contract: { gateVersion, sourceDbHash },
      facts: {
        roundNo: input.roundNo,
        reportHash: input.reportHash,
        openGaps: gaps
          .filter((gap) => isSpecBlockingGap(toRuleGap(gap)))
          .map((gap) => ({
            id: gap.canonicalGapId,
            severity: normalizeSeverity(gap.downgradedTo ?? gap.severity),
            evidenceIds: [],
            proposedPatch: gap.proposedSpecPatch,
          })),
        blockers,
        risks: [],
        freshness: { fresh: true, gateVersion },
      },
    });
  } catch (error) {
    log.warn(
      {
        changeId: input.changeId,
        phase: input.phase,
        error: error instanceof Error ? error.message : String(error),
      },
      "Could not open the gate decision card; the round stands and its actions are unchanged",
    );
    return null;
  }
}
