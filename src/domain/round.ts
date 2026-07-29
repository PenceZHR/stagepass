import { RESULT_CONTRACT, TurnResultUnparsableError } from "./turn";
import { parseTurnResult } from "./turn";
import type { Gap, RoundOutcome, Verdict } from "./gap";
import type { Phase } from "./phase";

/**
 * One adversarial round: red produces, blue attacks, the judge settles.
 *
 * ## Each role is read from its own file
 *
 * The judge never relays what blue said. StagePass reads blue's rollout
 * directly, because a judge that summarised blue could soften it -- and a
 * softened attack is the failure mode this whole mechanism exists to prevent.
 * The judge's only output is a verdict on problems that were ALREADY open,
 * which is a judgement nobody else can make.
 *
 *   red    -> what was produced
 *   blue   -> what is wrong with it        (becomes new gaps)
 *   judge  -> what is still wrong from before (verdicts on open gaps)
 *
 * ## Why blue gets no tools
 *
 * A blue with a shell can go and check, which sounds better and is not: it
 * turns an attack on the artifact into an investigation of the repository, and
 * the gap it reports stops being about the document under review. Blue reads
 * what red wrote and nothing else.
 *
 * ## This module is pure
 */

export const RED = "/root/red";
export const BLUE = "/root/blue";

export interface RoundInstructions {
  readonly phase: Phase;
  readonly round: number;
  readonly task: string;
  readonly openGaps: readonly Gap[];
}

/**
 * What the judge is told.
 *
 * It spawns both roles itself, so the human watches one window -- and blue gets
 * its own thread, which is the only arrangement where blue has not already read
 * every word of red's self-justification.
 */
export function judgePrompt(input: RoundInstructions): string {
  const gaps = input.openGaps.length === 0
    ? "（本阶段目前没有未关闭的问题。）"
    : input.openGaps
      .map((gap) => `- ${gap.id} [${gap.severity}] ${gap.title}`)
      .join("\n");

  return [
    `你是本轮的裁判。阶段：${input.phase}，第 ${input.round} 轮。`,
    "",
    `派生两个子 Agent，路径必须精确是 "${RED}" 和 "${BLUE}"：`,
    "",
    `1. ${RED} —— 正方。任务：`,
    input.task,
    `   要求它按下面的格式作答：`,
    RESULT_CONTRACT,
    "",
    `2. ${BLUE} —— 反方。任务：读正方产出，找出其中的遗漏、冲突与不可验证之处。`,
    "   只许基于正方产出提出问题，不要去读仓库、不要自己动手修。",
    "   每个问题一个稳定 id（例如 SPEC-SCOPE-1），同一个问题在后续轮次要用同一个 id。",
    `   要求它按同样的格式作答，把问题放进 blockers。`,
    "",
    "两个都做完之后，轮到你。**只做一件事**：对下面这些**已经存在**的问题逐条表态。",
    "",
    gaps,
    "",
    "用一个 ```json 块回答，不要复述正方或反方说了什么：",
    '{"verdicts": {"<问题 id>": {"kind": "closed" | "still_open", "reason": "<为什么>"}}}',
    "",
    "沉默等于仍然存在 —— 你没提到的问题会继续挡住闸门。",
    "关闭一个问题必须写清楚它为什么不再成立。",
  ].join("\n");
}

export interface VerdictReport {
  readonly verdicts: Readonly<Record<string, Verdict>>;
}

export class UnreadableVerdictError extends Error {
  constructor(readonly detail: string) {
    super(`verdicts_unreadable: ${detail}`);
    this.name = "UnreadableVerdictError";
  }
}

const VERDICT_KINDS = ["closed", "still_open"] as const;

/**
 * Read the judge's verdicts.
 *
 * A judge that says nothing readable yields no verdicts rather than an error:
 * every open gap then stays open, which is the safe direction. Only a
 * malformed verdict -- one that claims to be a judgement and is not -- is
 * refused, because silently dropping it would look identical to the judge
 * having said nothing.
 */
export function readVerdicts(text: string): VerdictReport {
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
    .map((match) => match[1]!.trim());
  const candidate = fences.length > 0 ? fences[fences.length - 1]! : text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { verdicts: {} };
  }
  const record = (parsed as { verdicts?: unknown } | null)?.verdicts;
  if (record === undefined || record === null) return { verdicts: {} };
  if (typeof record !== "object" || Array.isArray(record)) {
    throw new UnreadableVerdictError(JSON.stringify(record).slice(0, 120));
  }

  const verdicts: Record<string, Verdict> = {};
  for (const [gapId, value] of Object.entries(record as Record<string, unknown>)) {
    const entry = value as { kind?: unknown; reason?: unknown };
    if (
      typeof entry?.kind !== "string"
      || !(VERDICT_KINDS as readonly string[]).includes(entry.kind)
      || typeof entry.reason !== "string"
      || entry.reason.trim() === ""
    ) {
      throw new UnreadableVerdictError(`${gapId}: ${JSON.stringify(value).slice(0, 80)}`);
    }
    verdicts[gapId] = entry.kind === "closed"
      ? { kind: "closed", reason: entry.reason }
      : { kind: "still_open", reason: entry.reason };
  }
  return { verdicts };
}

export interface RoundTranscript {
  readonly round: number;
  /** What red's own rollout said. */
  readonly red: string;
  /** What blue's own rollout said. Never relayed through the judge. */
  readonly blue: string;
  /** What the judge said. Only verdicts are read from it. */
  readonly judge: string;
}

export interface RoundReading {
  readonly artifactIds: readonly string[];
  readonly outcome: RoundOutcome;
}

/**
 * Turn three transcripts into one round's effect on the gaps.
 *
 * Red's blockers are ignored on purpose. A producer reporting problems with its
 * own work is not an adversarial finding, and counting it would let red decide
 * how bad its own output is -- which is blue's job precisely because red cannot
 * do it.
 */
export function readRound(transcript: RoundTranscript): RoundReading {
  const red = parseTurnResult(transcript.red);
  let blueBlockers: RoundOutcome["found"];
  try {
    blueBlockers = parseTurnResult(transcript.blue).blockers.map((blocker) => ({
      id: blocker.id, severity: blocker.severity, title: blocker.title,
    }));
  } catch (error) {
    // A blue that answered in the wrong shape found nothing StagePass can act
    // on. Treating that as "no problems" would turn a broken attacker into a
    // clean bill of health, so it fails the round instead.
    throw error instanceof TurnResultUnparsableError
      ? new TurnResultUnparsableError(error.code, `blue: ${error.detail}`)
      : error;
  }

  return {
    artifactIds: red.artifactIds,
    outcome: {
      round: transcript.round,
      found: blueBlockers,
      verdicts: readVerdicts(transcript.judge).verdicts,
    },
  };
}
