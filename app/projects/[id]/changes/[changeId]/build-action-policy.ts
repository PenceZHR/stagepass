export type BuildActionPolicyRunStatus =
  | "created"
  | "running"
  | "gate_blocked"
  | "awaiting_human"
  | "approved_for_absorb"
  | "audit_ready"
  | "adopted"
  | "rejected"
  | "failed";

export interface BuildActionPolicyRun {
  status: BuildActionPolicyRunStatus;
  purpose?: "build" | "fix";
}

export interface BuildActionPolicyAction {
  actionId: string;
  enabled: boolean;
  reasonCode: string | null;
}

export interface BuildActionSlot {
  id: "build-start" | "build-adopt" | "build-reject";
  sourceActionId?: string | null;
}

export function isBuildApprovedForAbsorb(buildRun: BuildActionPolicyRun | null): boolean {
  return buildRun?.status === "approved_for_absorb";
}

export function shouldShowBuildStartAction(
  buildRun: BuildActionPolicyRun | null,
  action: BuildActionPolicyAction | null,
): boolean {
  if (!action) return false;
  if (buildRun?.status === "approved_for_absorb" || buildRun?.status === "awaiting_human") return false;
  return true;
}

export function shouldShowBuildAdoptAction(
  buildRun: BuildActionPolicyRun | null,
  action: BuildActionPolicyAction | null,
): boolean {
  if (!action) return false;
  return action.enabled || isBuildApprovedForAbsorb(buildRun);
}

export function shouldShowBuildRejectAction(
  buildRun: BuildActionPolicyRun | null,
  action: BuildActionPolicyAction | null,
): boolean {
  if (!action) return false;
  if (isBuildApprovedForAbsorb(buildRun)) return false;
  return action.enabled;
}

export function buildVisibleActionSlots(input: {
  buildRun: BuildActionPolicyRun | null;
  startAction: BuildActionPolicyAction | null;
  adoptAction: BuildActionPolicyAction | null;
  rejectAction: BuildActionPolicyAction | null;
}): BuildActionSlot[] {
  const slots: BuildActionSlot[] = [];

  if (shouldShowBuildStartAction(input.buildRun, input.startAction)) {
    slots.push({ id: "build-start", sourceActionId: input.startAction?.actionId });
  }
  if (shouldShowBuildAdoptAction(input.buildRun, input.adoptAction)) {
    slots.push({ id: "build-adopt", sourceActionId: input.adoptAction?.actionId });
  }
  if (shouldShowBuildRejectAction(input.buildRun, input.rejectAction)) {
    slots.push({ id: "build-reject", sourceActionId: input.rejectAction?.actionId });
  }

  return slots;
}

export function buildActionErrorSignature(input: {
  buildRun: BuildActionPolicyRun | null;
  slots: Array<{ id: string; sourceActionId?: string | null }>;
}): string {
  const status = input.buildRun?.status ?? "none";
  const purpose = input.buildRun?.purpose ?? "none";
  const slotSignature = input.slots
    .map((slot) => `${slot.id}:${slot.sourceActionId ?? ""}`)
    .join("|");
  return `${status}:${purpose}:${slotSignature}`;
}
