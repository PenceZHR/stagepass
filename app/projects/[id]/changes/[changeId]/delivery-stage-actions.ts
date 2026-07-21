import { pipelineActionDisabledReason, type PipelineActionContract } from "./pipeline-action-contract";
import type { StageActionView } from "./stage-action-bar";

export const DELIVERY_STAGE_ACTION_ID = "run_delivery";

/**
 * Builds the Done stage's single action: produce the delivery note.
 *
 * Extracted from the page component so the decision is reachable by a test.
 * While it lived inside a useMemo the only available coverage was
 * `assert.match(pageSource, /.../)`, which is blind to what the button does:
 * flipping `enabled` to a constant `false` -- the delivery button unclickable
 * under every condition -- kept the suite fully green, while a pure rename of
 * the memo turned it red. That is the wrong way round for a button whose whole
 * job is to be pressable exactly when the action contract says so.
 */
export function buildDeliveryStageActions(input: {
  deliveryAction: PipelineActionContract | null;
  busy: boolean;
  onAction: (actionId: string) => void;
}): StageActionView[] {
  const disabledReason = pipelineActionDisabledReason(input.deliveryAction);

  return [{
    id: `done-${DELIVERY_STAGE_ACTION_ID}`,
    label: input.deliveryAction?.label ?? "生成交付单",
    role: "primary",
    // The contract is the authority on availability, and it is the only
    // authority: a missing contract yields a disabledReason too, so this is
    // never silently enabled.
    enabled: disabledReason === null,
    busy: input.busy,
    disabledReason,
    sourceActionId: DELIVERY_STAGE_ACTION_ID,
    onAction: () => input.onAction(DELIVERY_STAGE_ACTION_ID),
  }];
}
