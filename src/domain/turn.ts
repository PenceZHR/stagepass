import { createHash } from "node:crypto";

import { BLOCKER_SEVERITIES, type BlockerSeverity, type Finding } from "./gate";
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
  readonly blockers: readonly Finding[];
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
/**
 * 没有 ```json 围栏时，把正文里**最后那个完整的 JSON 对象**挖出来。
 *
 * ## 为什么要有它
 *
 * 2026-07-30 实测：红方在 JSON 前面写了一句「我先说明一下我做了什么」，而原来的兜底
 * 是「没围栏就把整段当 JSON」—— 于是 `JSON.parse` 在那句话上失败，整轮作废。
 * 一个完整的对象明明就摆在那儿。
 *
 * **判据是「读不读得出来」，不是「有没有照仪式写」。** 这不放宽任何一项检查：挖出来
 * 的东西照样要过 artifactIds / blockers 那些形状检查，坏的照样拒。
 *
 * ## 为什么从最后一个 `}` 往回找最早的 `{`
 *
 * 最早那个能配对成功的 `{` 就是最外层 —— 从里层开始试会挖出一个嵌套的子对象，
 * 而那个子对象大概率过不了形状检查，于是变成一条难查的「形状不对」。
 *
 * 有围栏时这条根本不会被调用：正文里举例写的 JSON 不许盖过围栏里的答案。
 */
function lastJsonObject(text: string): string | null {
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  for (let start = text.indexOf("{"); start !== -1 && start < end;
    start = text.indexOf("{", start + 1)) {
    const slice = text.slice(start, end + 1);
    try {
      const parsed: unknown = JSON.parse(slice);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return slice;
      }
    } catch {
      // 这个 `{` 配不上最后那个 `}`，往后挪一个再试
    }
  }
  return null;
}

export function parseTurnResult(text: string): TurnResult {
  const fences = [...text.matchAll(FENCE)].map((match) => match[1]!.trim());
  const candidate = fences.length > 0
    ? fences[fences.length - 1]!
    : (lastJsonObject(text) ?? text.trim());

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
  const parsedBlockers: Finding[] = blockers.map((value) => {
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
      // 模型在报「我发现了什么」，所以一律是 finding。standard 是 rubric 判出来的
      // 二元结论，永远不从模型的自述里来。
      kind: "finding",
      severity: blocker.severity as BlockerSeverity,
      title: blocker.title,
    };
  });

  return { artifactIds: artifactIds as string[], blockers: parsedBlockers };
}
