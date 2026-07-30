import { RESULT_CONTRACT, TurnResultUnparsableError } from "./turn";
import { parseTurnResult } from "./turn";
import { isHumanGap } from "./gap";
import type { Gap, RoundOutcome, Verdict } from "./gap";
import { redReviewsOthers, type Phase } from "./phase";

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
/**
 * 蓝方够得着什么。**这一条按阶段定，不是一句写死的话。**
 *
 * ## 设计阶段：不许读仓库
 *
 * 蓝方的活儿是攻击**摆在面前的这份文档**。放开它去读仓库，「攻击这份 PRD」就滑成
 * 「调查这个项目」—— 它会翻一遍代码，报回来一堆和这份文档无关的毛病，而闸门会拿
 * 那些毛病挡住一个本该放行的阶段。这条在设计阶段是必须的，不是保守。
 *
 * ## Build：正方的产出就是仓库
 *
 * 同一句话到了 Build 就变成了错的 —— 它等于叫蓝方闭着眼睛审代码，只能看着 diff 猜
 * 「这个函数还有没有别的调用方」，而那恰恰是审代码里最值钱的问题。
 *
 * 所以用户 2026-07-30 单独为 Build 定了：**能读这一轮改动涉及的文件和它们的直接
 * 调用方**（范围有界，才不会滑回「调查这个项目」），**但不自己执行** —— 「跑过没有」
 * 那类标准由红方交运行证据，让蓝方去跑会把一轮的耗时和不确定性都放大一截。
 *
 * ## Review：对象就是代码，而且两边都在审它
 *
 * Review 里红方审的是 Build 的产出，蓝方的活儿是「你漏了什么、这条成不成立」——
 * 那要**自己去看**才答得出来。不给它读，它就只能看着红方的报告自说自话，而一份
 * 没人复核的 review 报告和没有 review 是一回事（用户 2026-07-30 拍板）。
 *
 * 和 Build 一样不许自己执行：那是 QA 的活儿，在这里跑等于把两个阶段揉成一个。
 *
 * ## 别的阶段一律不动
 *
 * QA / Fix / Merge / Retro 的形状还没谈过。没谈过的沿用设计阶段那条 ——
 * **保守是因为没谈，不是因为想清楚了**，这句话写在这里免得下次被当成结论。
 */
const blueReach = (phase: string): string => {
  if (phase === "Build") {
    return "   可以读这一轮改动涉及的文件，以及它们的直接调用方 —— 只读这些，"
      + "不要把整个仓库读一遍。不要自己执行任何东西，也不要动手修：跑没跑过看正方交出来的运行证据。";
  }
  if (phase === "Review") {
    return "   可以读被审的那个 commit 涉及的文件，以及它们的直接调用方 —— 自己去看，"
      + "不要只凭正方的报告下结论。不要自己执行任何东西，也不要动手修：跑起来验是 QA 的活儿。";
  }
  return "   只许基于正方产出提出问题，不要去读仓库、不要自己动手修。";
};

/**
 * Review 里红蓝**都在报缺陷**，共用一个 id 空间 —— 所以给两边分前缀。
 *
 * 不分的后果不是「乱」，是**静默丢一条**：`readRound` 撞 id 时只留第一条，而两边
 * 审的是同一份代码，各自起一个 `REVIEW-1` 是完全可能的。「留哪一条」永远是个将就，
 * 分前缀让这件事结构上不会发生。
 *
 * 别的阶段只有蓝方报问题，不需要这套 —— 给红方讲一套它用不上的规矩只是噪音。
 */
const ID_PREFIX: Readonly<Record<string, { red: string; blue: string }>> = {
  Review: { red: "RV-", blue: "RVB-" },
};

const idRule = (phase: string, side: "red" | "blue"): string[] => {
  const prefix = ID_PREFIX[phase]?.[side];
  return prefix === undefined ? [] : [
    `   每个问题一个稳定 id，**必须以 \`${prefix}\` 开头**`
    + `（例如 \`${prefix}NULL-DEREF-1\`）—— 另一边用的是别的前缀，撞了会丢一条。`
    + "同一个问题在后续轮次要用同一个 id。",
  ];
};

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
    "派生两个子 Agent。**用原生的 `spawn_agent` 工具，`task_name` 分别设成"
    + ` \`${RED.replace("/root/", "")}\` 和 \`${BLUE.replace("/root/", "")}\`** ——`,
    `它们的身份路径会因此成为 "${RED}" 和 "${BLUE}"，后续追加任务用 \`followup_task\``,
    "（`target` 填那个身份路径）。",
    "",
    "**不要用 `exec` 里的 `multi_agent_v1__spawn_agent`** —— 那条路没有 `task_name`，",
    "派出去的子 Agent 没有身份路径，这一轮的产出就找不回来，整轮作废。",
    "",
    "**一个跑完再派下一个，不要并行。** 反方要拿到正方的产出才能开始审 ——",
    "并行的话它会对着空气写意见，而那份意见没有任何价值。",
    "",
    `1. ${RED} —— 正方。任务：`,
    input.task,
    ...redFixList(input.openGaps),
    ...idRule(input.phase, "red"),
    `   要求它按下面的格式作答：`,
    RESULT_CONTRACT,
    ...extra(input.addenda?.red),
    "",
    `2. ${BLUE} —— 反方。任务：读正方产出，找出其中的遗漏、冲突与不可验证之处。`,
    blueReach(input.phase),
    ...(idRule(input.phase, "blue").length > 0
      ? idRule(input.phase, "blue")
      : ["   每个问题一个稳定 id（例如 SPEC-SCOPE-1），同一个问题在后续轮次要用同一个 id。"]),
    `   要求它按同样的格式作答，把问题放进 blockers。`,
    ...extra(input.addenda?.blue),
    "",
    "两个都做完之后，轮到你。**只做一件事**：对下面这些**已经存在**的问题逐条表态。",
    "",
    gaps,
    "",
    "用一个 ```json 块回答，不要复述正方或反方说了什么：",
    '{"agents": {"red": "<正方的 agent_id>", "blue": "<反方的 agent_id>"},',
    ' "verdicts": {"<问题 id>": {"kind": "closed" | "still_open", "reason": "<为什么>"}}}',
    "",
    "`agents` 里填 `spawn_agent` 返回的那两个 `agent_id`。**这两个 id 是这一轮唯一的",
    "取证入口** —— 少一个、写错一个，这一轮就作废，而正反两方说的话谁也看不到。",
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

export class UnreadableAgentsError extends Error {
  constructor(readonly detail: string) {
    super(`agents_unreadable: ${detail}`);
    this.name = "UnreadableAgentsError";
  }
}

export interface RoundAgents {
  /** 正方那条子 Agent 线程。 */
  readonly red: string;
  /** 反方那条。 */
  readonly blue: string;
}

/**
 * 裁判报出来的两条子 Agent 线程 id。
 *
 * ## 为什么由裁判报，而不是从 Codex 的库里认
 *
 * 原来靠 `threads.agent_path`（`/root/red`）认。2026-07-30 实测：**只有原生
 * `spawn_agent({task_name})` 会设那一列，而那个工具不是每个会话都有** —— 没有它的
 * 会话里，裁判只能走 `exec` 里的 `multi_agent_v1__spawn_agent`，那条路没有
 * `task_name`，于是 `agent_path` 是 NULL，StagePass 报 `no sub-agent at /root/red`，
 * **每个阶段的每一轮都跑不了**。光靠提示词修不好：工具不在，模型再听话也设不上。
 *
 * 裁判**总是**拿得到 id（两个派生入口都返回 `agent_id`），所以让它报出来。
 * 顺带把对 Codex 私有库的依赖去掉了 —— rollout 文件名里就带着 thread id。
 *
 * ## 「不经裁判转述」没有被削弱
 *
 * 它报的是**指针**，正文照旧从那两条 rollout 里读。一个想软化蓝方的裁判做不到这件
 * 事 —— 它能动的只有「去读哪一条」，而报错一条会让这一轮**大声失败**，不会变成一份
 * 被软化的意见。
 *
 * ## 三种都抛，不降级
 *
 * 少一个、一个都没有、两个一样 —— 全部抛。降级成空 transcript 等于把「读不到蓝方」
 * 和「蓝方没发现问题」变成同一件事，而那是这套机制最不能容忍的混淆。
 */
export function readAgents(text: string): RoundAgents {
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
    .map((match) => match[1]!.trim());
  const candidate = fences.length > 0 ? fences[fences.length - 1]! : text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new UnreadableAgentsError("裁判的答复不是一个 json 块");
  }
  const agents = (parsed as { agents?: unknown } | null)?.agents as
    { red?: unknown; blue?: unknown } | undefined;
  const red = agents?.red;
  const blue = agents?.blue;
  if (typeof red !== "string" || red.trim() === "") {
    throw new UnreadableAgentsError("没有报出正方的线程 id");
  }
  if (typeof blue !== "string" || blue.trim() === "") {
    throw new UnreadableAgentsError("没有报出反方的线程 id");
  }
  if (red.trim() === blue.trim()) {
    throw new UnreadableAgentsError(`正反两方报成了同一条线程：${red}`);
  }
  return { red: red.trim(), blue: blue.trim() };
}

export interface RoundTranscript {
  /** 哪个阶段。红方报的问题算不算数，按它定（`redReviewsOthers`）。 */
  readonly phase: string;
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
 *
 * ## 例外：红方审的是别人的东西时（`redReviewsOthers`）
 *
 * 上面那条理由到 Review 就不成立了 —— 红方审的是 Build 的产出，不是自己写的。
 * 而 Review 的活儿**就是**找缺陷，照旧丢掉等于这个阶段什么都不产出
 * （用户 2026-07-30 拍板）。那时两边的发现合并，**红方在前**。
 *
 * 撞 id 的按先到的算：两边审的是同一份代码，撞 id 是真会发生的，而一个 id 只能
 * 指一件事。合并时留第一条，等价于 `applyRound` 后面那道去重 —— 但**在这里就去，
 * 免得同一个 id 带着两种标题往下走**。提示词里还给两边分了前缀，让它压根不该撞。
 */
/** 同一个 id 只留第一条。理由见 `readRound` 上面那段。 */
function dedupeById(
  found: RoundOutcome["found"],
): RoundOutcome["found"] {
  const seen = new Set<string>();
  return found.filter((each) => {
    if (seen.has(each.id)) return false;
    seen.add(each.id);
    return true;
  });
}

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

  const found = redReviewsOthers(transcript.phase)
    ? dedupeById([
        ...red.blockers.map((blocker) => ({
          id: blocker.id, severity: blocker.severity, title: blocker.title,
        })),
        ...blueBlockers,
      ])
    : blueBlockers;

  return {
    artifactIds: red.artifactIds,
    outcome: {
      round: transcript.round,
      found,
      verdicts: readVerdicts(transcript.judge).verdicts,
    },
  };
}
