import { emitEvent, type EmitEventInput } from "./event-service";
import type { StageProgressEventPayload } from "./stage-ai-output-contract";

interface StageProgressEnvelope extends Record<string, unknown> {
  stageProgress: StageProgressEventPayload;
}

export type StageProgressEventWriter = (input: EmitEventInput) => Promise<string>;

export interface EmitStageProgressInput {
  changeId: string;
  payload: StageProgressEventPayload;
  repoPath?: string;
  writer?: StageProgressEventWriter;
}

export async function emitStageProgress(
  input: EmitStageProgressInput,
): Promise<string> {
  const writer = input.writer ?? emitEvent;
  const eventInput: EmitEventInput = {
    changeId: input.changeId,
    runId: input.payload.runId,
    type: "stage_progress",
    message: input.payload.message ?? input.payload.status,
    rawJson: stageProgressEnvelope(input.payload),
  };

  if (input.repoPath !== undefined) {
    eventInput.repoPath = input.repoPath;
  }

  return writer(eventInput);
}

export function stageProgressRawJson(payload: StageProgressEventPayload): string {
  return JSON.stringify(stageProgressEnvelope(payload));
}

function stageProgressEnvelope(
  payload: StageProgressEventPayload,
): StageProgressEnvelope {
  return { stageProgress: payload };
}
