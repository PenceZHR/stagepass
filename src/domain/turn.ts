import { createHash } from "node:crypto";

import { BLOCKER_SEVERITIES, type Blocker } from "./gate";
import type { Phase } from "./phase";

/**
 * What StagePass asks Codex to do, and what it will accept back.
 *
 * ## The shape of the answer is StagePass's decision, not the model's
 *
 * A turn does not return prose for StagePass to interpret. It returns one
 * fixed structure -- artifacts produced, problems found -- because the gate
 * reads those fields and a gate that has to infer them from a summary is a gate
 * that can be talked past. The judgement is "who decides the structure", not
 * "is the format JSON": a model free to choose the fields is a model free to
 * omit the one that would have blocked it.
 *
 * ## An unparsable answer is a failed turn, loudly
 *
 * Not an empty result. A turn that came back in the wrong shape produced
 * nothing the system can act on, and saying so by name (`turn_result_unparsable`)
 * is the difference between a bug found in a minute and a phase that silently
 * settles with no artifacts and no explanation.
 *
 * ## This module is pure
 */

export interface TurnRequest {
  readonly changeId: string;
  readonly phase: Phase;
  /** What the turn is for. Never blank -- see `assertRequestValid`. */
  readonly prompt: string;
}

export interface TurnResult {
  readonly artifactIds: readonly string[];
  readonly blockers: readonly Blocker[];
}

export class InvalidTurnRequestError extends Error {
  constructor(readonly code: "prompt_missing") {
    super(code);
    this.name = "InvalidTurnRequestError";
  }
}

export class TurnResultUnparsableError extends Error {
  constructor(
    readonly code:
      | "turn_result_no_json"
      | "turn_result_not_an_object"
      | "turn_result_artifacts_invalid"
      | "turn_result_blockers_invalid",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TurnResultUnparsableError";
  }
}

/**
 * A request with no prompt is a request the far end cannot act on.
 *
 * The old tree allowed one: its presentation turns carried the text under a
 * field name the reader did not read, so every such turn failed the moment it
 * was picked up -- and nothing noticed for as long as nothing reached that
 * path. Checked here, before anything is written down.
 */
export function assertRequestValid(request: TurnRequest): void {
  if (request.prompt.trim() === "") {
    throw new InvalidTurnRequestError("prompt_missing");
  }
}

/**
 * A turn's identity. Two requests that ask for the same thing hash the same,
 * which is what lets a dispatch be retried without producing a second turn.
 */
export function requestHash(request: TurnRequest): string {
  assertRequestValid(request);
  return createHash("sha256").update(JSON.stringify({
    changeId: request.changeId,
    phase: request.phase,
    prompt: request.prompt,
  })).digest("hex");
}

/** The exact shape a turn must answer in. Sent to the model verbatim. */
export const RESULT_CONTRACT = `Reply with one \`\`\`json block and nothing that contradicts it:
{"artifactIds": ["<path or id you produced>"], "blockers": [{"id": "...", "severity": "P0|P1|P2", "title": "..."}]}
Report every problem you found as a blocker. An empty list means you found none.`;

const FENCE = /```json\s*([\s\S]*?)```/g;

/**
 * Read the model's answer.
 *
 * The last fenced block wins, because a model that reconsiders emits a second
 * one; taking the first would act on a draft it had already replaced. Prose
 * around the fence is ignored rather than refused -- the contract is about the
 * structure being StagePass's, not about the model being silent.
 */
export function parseTurnResult(text: string): TurnResult {
  const fences = [...text.matchAll(FENCE)].map((match) => match[1]!.trim());
  const candidate = fences.length > 0 ? fences[fences.length - 1]! : text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new TurnResultUnparsableError(
      "turn_result_no_json",
      candidate.slice(0, 200),
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TurnResultUnparsableError(
      "turn_result_not_an_object",
      candidate.slice(0, 200),
    );
  }

  const record = parsed as Record<string, unknown>;
  const artifactIds = record.artifactIds;
  if (
    !Array.isArray(artifactIds)
    || artifactIds.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    throw new TurnResultUnparsableError(
      "turn_result_artifacts_invalid",
      JSON.stringify(artifactIds),
    );
  }

  const blockers = record.blockers;
  if (!Array.isArray(blockers)) {
    throw new TurnResultUnparsableError(
      "turn_result_blockers_invalid",
      JSON.stringify(blockers),
    );
  }
  const parsedBlockers: Blocker[] = blockers.map((value) => {
    const blocker = value as Record<string, unknown>;
    if (
      typeof blocker?.id !== "string" || blocker.id.trim() === ""
      || typeof blocker.title !== "string"
      || typeof blocker.severity !== "string"
      || !(BLOCKER_SEVERITIES as readonly string[]).includes(blocker.severity)
    ) {
      throw new TurnResultUnparsableError(
        "turn_result_blockers_invalid",
        JSON.stringify(value),
      );
    }
    return {
      id: blocker.id,
      severity: blocker.severity as Blocker["severity"],
      title: blocker.title,
    };
  });

  return { artifactIds: artifactIds as string[], blockers: parsedBlockers };
}
