import { resolveStageBinding } from "./codex-stage-binding-resolver";

export interface CodexStageControl {
  bindingTitle: string | null;
  bindingStatus: string;
  threadId: string | null;
  lastTurnId: string | null;
  lastObservationCursor: number | null;
  lastSeenAt: string | null;
  lastErrorCode: string | null;
}

/**
 * The Codex task state the page shows for one stage.
 *
 * Read per stage rather than per change: the page decides between "start this
 * stage", "open its task" and "run it again" from whether this stage has a
 * task, and a change-wide reading made every stage look already started as
 * soon as any one of them was.
 */
export function projectCodexStageControl(input: {
  changeId: string;
  projectId: string;
  stageId: string;
}): CodexStageControl {
  const binding = resolveStageBinding(input.changeId, input.stageId);
  const owned = binding && binding.projectId === input.projectId
    ? binding
    : null;
  return {
    bindingTitle: owned?.title ?? null,
    bindingStatus: owned?.status ?? "detached",
    threadId: owned?.threadId ?? null,
    lastTurnId: owned?.lastTurnId ?? null,
    lastObservationCursor: owned?.lastObservationCursor ?? null,
    lastSeenAt: owned?.lastSeenAt ?? null,
    lastErrorCode: owned?.lastErrorCode ?? null,
  };
}
