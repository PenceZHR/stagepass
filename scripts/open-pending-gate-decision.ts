/**
 * Opens the server-side gate decision card for a change already sitting at its
 * gate.
 *
 * A change that settled before `runIntake` learned to open this card is stuck:
 * it is at the gate, so the stage cannot be rerun, and the only decision surface
 * -- the card -- was never opened. This runs exactly what the fixed stage now
 * runs on settle, so the human gets the decision they were always owed.
 *
 * It does not decide anything. `presentDesignGateDecision` reads the live
 * contract and refuses to open a card whose actions are not enabled, so a change
 * that is not actually at its gate gets nothing.
 *
 *   npx tsx scripts/open-pending-gate-decision.ts CHG-001 PRD
 */
import { presentDesignGateDecision } from "../server/services/design-gate-decision-presenter.ts";
import type { DesignInteractionPhase } from "../server/services/human-interaction-broker.ts";

const changeId = process.argv[2];
const phase = (process.argv[3] ?? "PRD") as DesignInteractionPhase;

if (!changeId) {
  console.error("usage: open-pending-gate-decision.ts <changeId> [phase]");
  process.exit(2);
}

const envelope = presentDesignGateDecision({
  changeId,
  phase,
  roundNo: 1,
  reportHash: `${changeId}:${phase.toLowerCase()}`,
});

if (!envelope) {
  console.error(
    `no card opened for ${changeId} at ${phase}:`
    + " either it is not at that gate, or no decision action is enabled",
  );
  process.exit(1);
}

console.log(JSON.stringify(envelope, null, 2).slice(0, 900));
