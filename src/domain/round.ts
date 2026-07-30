import { RESULT_CONTRACT, TurnResultUnparsableError } from "./turn";
import { parseTurnResult } from "./turn";
import { isHumanGap } from "./gap";
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
  /**
   * 追加给各角色的额外要求，原样插进它们的任务里。
   *
   * **纯字符串，这一层不知道里面是什么。** L5 用它塞 rubric 契约；这里若改成
   * 一个 rubric 类型，L4 就要 import L5 —— 那是向上依赖，常驻护栏会当场红，而且
   * 分层纪律说的就是这件事。
   *
   * 缺席即没有额外要求，行为和加这个字段之前逐字一致。
   */
  readonly addenda?: {
    readonly red?: string | undefined;
    readonly blue?: string | undefined;
    readonly judge?: string | undefined;
  } | undefined;
}

/** 有内容才占一行，否则连空行都不要 —— 提示词里多一段空白也是噪音。 */
const extra = (text: string | undefined): string[] =>
  text === undefined || text.trim() === "" ? [] : ["", text];

/**
 * What the judge is told.
 *
 * It spawns both roles itself, so the human watches one window -- and blue gets
 * its own thread, which is the only arrangement where blue has not already read
 * every word of red's self-justification.
 */
/**
 * 一条 gap 在提示词里长什么样。
 *
 * `standard` 写「标准」而不是它的 severity —— 它**没有** severity（rubric 是二元判断，
 * REMAP §5.1）。原来无条件插 `[${gap.severity}]`，于是每条 rubric 派生的 gap 在裁判
 * 眼里都是 `[null]`：一个模型看不懂的分级，而它正要对这条表态。
 */
const gapLine = (gap: Gap): string => {
  const head = `- ${gap.id} [${gap.kind === "standard" ? "标准" : gap.severity}] ${gap.title}`;
  /*
   * 人对这一条说过的话跟着它进提示词。**这是「我的话进下一轮」那条的落点** ——
   * 不带上它，人在选择器里逐条写的东西就只存在于库里，红方下一轮照样不知道他要什么。
   */
  return gap.note === null ? head : `${head}\n  人说：${gap.note}`;
};

/**
 * 上一轮报出来的问题，交给**动手的那个人**。
 *
 * ## 为什么它必须存在
 *
 * 在这之前 open gap 只出现在裁判那一区，红方拿到的只有阶段指令 + 需求 + 上游文档。
 * 于是「红方根据蓝方的判断修正」这句话**没有载体**：红方每一轮都是从零重写，而不是
 * 照着意见改。2026-07-30 CHG-002 那次续跑就是活样本 —— 人在选择器里对三条问题逐条
 * 写了意见，那些话进了 gap 的 note，而红方一个字都没看到。`gapLine` 上面那段注释
 * 写着「不带上它，红方下一轮照样不知道他要什么」，本意一直在，线没接到红方。
 *
 * ## 为什么是「改掉，或者写清为什么不改」
 *
 * 只说「改掉」，红方遇到一条它认为不成立的问题就只能假装改。而一条它不认同的问题，
 * 正确的出口是**把理由写进产出**，让蓝方和人去看那个理由 —— 那正是下一轮蓝方要判、
 * 裁判要表态的东西。逼它服从会把分歧藏起来。
 *
 * ## 裁判那一份没有被拿走
 *
 * 同一份名单两边都有，指令不同：红方是「去处理」，裁判是「逐条表态」。少了裁判那份，
 * 就没人对「这条到底还成不成立」下结论；少了红方这份，就没人去改。
 */
const redFixList = (openGaps: readonly Gap[]): string[] => {
  if (openGaps.length === 0) return [];
  const indent = (gap: Gap): string =>
    gapLine(gap).split("\n").map((line) => `   ${line}`).join("\n");
  // 人提的排在模型报的前面，**和裁判那一区同一个顺序、同一个理由**：先看要求，
  // 再看建议。两边的顺序不一致，等于告诉红方和裁判两件不同的事哪个更要紧。
  const human = openGaps.filter(isHumanGap);
  const found = openGaps.filter((gap) => !isHumanGap(gap));
  const lines: string[] = [];
  if (human.length > 0) {
    lines.push("   人明确要求这一轮处理的（不许当成建议）：", ...human.map(indent));
  }
  if (found.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("   上一轮报出来的问题：", ...found.map(indent));
  }
  return [
    "",
    ...lines,
    "   以上每一条都要处理 —— 改掉它，或者在产出里写清楚为什么它不成立。",
    "",
  ];
};

export function judgePrompt(input: RoundInstructions): string {
  /*
   * 人提的问题**单独一区，措辞和模型报的不一样**（用户 2026-07-30）。
   *
   * 混在一起列，「用户明确要求的」和「反方顺口提的」在裁判眼里一模一样 —— 而它们
   * 的分量不一样：一条模型报的问题，裁判判它不成立是它的本职；一条人提的要求，
   * 裁判不该拿「我觉得这个建议可以不采纳」把它关掉。
   *
   * 分区判据只有 id 前缀（`isHumanGap`），和 rubric 派生 gap 用 `RB:` 前缀是同一个
   * 先例。**它仍然可以被判 closed** —— 人的要求真被满足了就该关掉；这里管的是
   * 措辞，不是给它加一层不可关闭的特权。
   */
  const human = input.openGaps.filter(isHumanGap);
  const found = input.openGaps.filter((gap) => !isHumanGap(gap));

  const sections: string[] = [];
  if (human.length > 0) {
    sections.push(
      "**人明确要求下一轮处理的（不许当成建议）：**",
      ...human.map(gapLine),
    );
  }
  if (found.length > 0) {
    if (sections.length > 0) sections.push("", "之前轮次报出来的问题：");
    sections.push(...found.map(gapLine));
  }
  const gaps = sections.length === 0
    ? "（本阶段目前没有未关闭的问题。）"
    : sections.join("\n");

  return [
    `你是本轮的裁判。阶段：${input.phase}，第 ${input.round} 轮。`,
    "",
    `派生两个子 Agent，路径必须精确是 "${RED}" 和 "${BLUE}"：`,
    "",
    `1. ${RED} —— 正方。任务：`,
    input.task,
    ...redFixList(input.openGaps),
    `   要求它按下面的格式作答：`,
    RESULT_CONTRACT,
    ...extra(input.addenda?.red),
    "",
    `2. ${BLUE} —— 反方。任务：读正方产出，找出其中的遗漏、冲突与不可验证之处。`,
    "   只许基于正方产出提出问题，不要去读仓库、不要自己动手修。",
    "   每个问题一个稳定 id（例如 SPEC-SCOPE-1），同一个问题在后续轮次要用同一个 id。",
    `   要求它按同样的格式作答，把问题放进 blockers。`,
    ...extra(input.addenda?.blue),
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
    ...extra(input.addenda?.judge),
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
