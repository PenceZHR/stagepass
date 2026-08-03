import { jsonAnswerIn, RESULT_CONTRACT, TurnResultUnparsableError } from "./turn";
import { parseTurnResult } from "./turn";
import { isHumanGap } from "./gap";
import type { Gap, RoundOutcome, Verdict } from "./gap";
import { producesCommit, redReviewsOthers, type Phase } from "./phase";

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

/**
 * 两方在提示词里的名字。
 *
 * **原来它们是 `/root/red` / `/root/blue`，是子 Agent 的身份路径** —— StagePass 靠那个
 * 从 Codex 的库里认哪条线程是谁。那条路 2026-07-30 废掉了（改由裁判报两个
 * `agent_id`），2026-08-02 那一版也废掉了（改由 StagePass 按 `parent_thread_id`
 * 自己认）。两版之后，路径这个概念在这里都是死重：它不指向任何东西，留着只会让
 * 下一个人以为它还有作用。
 *
 * 现在它们只是提示词里的区段标签，仅此而已。
 */
export const RED = "正方";
export const BLUE = "反方";

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
    /**
     * 反方那一段。**只剩它了。**
     *
     * 裁判那份 rubric 契约 2026-08-02 搬去名单了（它调工具逐条答），而反方是子 Agent、
     * 拿不到 StagePass 的工具，所以它这一份还得经裁判转达。见
     * docs/DESIGN-no-hand-transcription-2026-08-02.md §四。
     */
    readonly blue?: string | undefined;
  } | undefined;
}

/** 有内容才占一行，否则连空行都不要 —— 提示词里多一段空白也是噪音。 */
const extra = (text: string | undefined): string[] =>
  text === undefined || text.trim() === "" ? [] : ["", text];

/**
 * 附给**子 Agent** 的那一段，带明确的收件人。
 *
 * ## 为什么非要这个抬头
 *
 * 蓝方那份 rubric 契约只能经裁判的手转达 —— StagePass 不跟子 Agent 说话。而这段
 * 文本原来是**裸的**：一句主语中立的祈使句（「对照下面 4 条标准逐条判定正方这一轮
 * 的产出」）夹在裁判自己的提示词里，紧跟在「2. 反方。任务：…」后面。
 *
 * 2026-07-31 实测的两种后果，都是照着字面办事：
 *
 * - Review 第 6 轮：裁判把它当成对自己说的，8 条一起答了。反方的 rollout 里
 *   **一个 `RBC-` 都没有** —— 契约根本没送到。
 * - Retro 第 1 轮：裁判把**两份**都转给了反方，反方挑了错的那份答，等于给自己打分。
 *
 * 还有一件同一次查出来的事：裁判**不是原样转达**任务的，它会改写成自己的话
 * （实测蓝方收到的开头是「你是反方。正方产出如下…」，不是这里写的原文）。所以
 * 「原样、一个字都不要改」不是客套，是这一段唯一的要求。
 *
 * **这不是靠语气治病。** 原来的文本里根本没有「收件人」这个信息，模型不是不听话，
 * 是没得可依。这里补的是缺失的信息。它单独**不足以保证送达** ——
 * `work/rubric-round.ts` 会机械核验到底送没送到，见
 * docs/DESIGN-rubric-delivery-2026-07-31.md §3.1 与 §3.3。
 */
const relayedTo = (who: string, text: string | undefined): string[] =>
  text === undefined || text.trim() === "" ? [] : [
    "",
    `   **下面这一整段原样转达给${who}，一个字都不要改。它是给${who}的，不是给你答的。**`,
    text,
  ];

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
 * ## Build / Fix：正方的产出就是仓库（判据 `producesCommit`）
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
 * ## QA：活儿本身就是执行
 *
 * 到 QA，「跑」就是正题。一个跑不了东西的反方核对不了一份「我跑了、结果是这样」的
 * 报告 —— 它只能检查报告自洽不自洽，而那不叫核对。所以这里两边都能跑。
 *
 * ## Merge：交付说明全是对代码的断言
 *
 * 「改了什么、对谁有影响、能不能回滚」没有一句是能对着文档答出来的。范围是**这一次
 * 的全部 commit**，不是某一轮改动涉及的文件 —— Merge 看的是整件事（用户 2026-07-30）。
 *
 * ## 只剩 Retro 沿用设计阶段那条
 *
 * 它写的是复盘，对着的是前面每个阶段的产出和账本，不需要读代码。
 * 这不是「还没谈过所以保守」，是这一次谈过之后的结论。
 */
const blueReach = (phase: string): string => {
  if (producesCommit(phase)) {
    /*
     * **上游文档也在够得着的范围里**（用户 2026-07-31）。
     *
     * 他要蓝方用 rubric 判「有没有完成 PRD/Spec 的要求」，而那个判据原来够不着：
     * `PRD.md` / `Spec.md` 不在「这一轮改动涉及的文件」里。判不了就只能猜，而
     * `rubric-defaults.ts` 里写着这条教训 —— **一条只能靠猜的标准比没有更糟**，
     * 它每一轮都会得到一个没有依据的 yes。
     *
     * 边界没有被放开成「整个仓库」：加进来的是任务书里**已经列着的那一份有限名单**，
     * 不是另一份。「攻击这份产出」不会因此滑成「调查这个项目」。
     */
    return "   可以读这一轮改动涉及的文件、它们的直接调用方，以及任务里列出的那几份"
      + "已批准上游产物（要判它有没有做到要求，就得对着要求看）—— 只读这些，"
      + "不要把整个仓库读一遍。不要自己执行任何东西，也不要动手修：跑没跑过看正方交出来的运行证据。";
  }
  if (phase === "Review") {
    return "   可以读被审的那个 commit 涉及的文件，以及它们的直接调用方 —— 自己去看，"
      + "不要只凭正方的报告下结论。不要自己执行任何东西，也不要动手修：跑起来验是 QA 的活儿。";
  }
  if (phase === "Merge") {
    return "   可以读这一次的全部 commit（`git log` 里属于这个 Change 的那些）以及"
      + "它们改到的文件 —— 交付说明里「改了什么、对谁有影响、能不能回滚」全是对代码的"
      + "断言，不自己看就只能跟着正方点头。不要自己执行任何东西，也不要动手改。";
  }
  if (phase === "QA") {
    return "   可以读代码，也**可以自己跑一遍**验证正方报的结果 —— 这是唯一一个活儿本身"
      + "就是执行的阶段，一个跑不了东西的反方核对不了一份「我跑了、结果是这样」的报告。"
      + "不要动手改代码：这一轮的活儿是验，不是修。";
  }
  /*
   * **「正方产出」包括它报出来的那份文档文件本身**（2026-08-02 CHG-003 实测补的）。
   *
   * 红方交回来的是一个文件路径。这句话原来只说「基于正方产出、不要读仓库」，蓝方
   * 照字面办事：把那个路径当成产出的全部，连着两轮开出「无法核验正文」的 gap ——
   * 而正文明明就在那个文件里。「攻击摆在面前的这份文档」得先读得到这份文档。
   *
   * 边界没有放开：能读的只有**红方这一轮报出来的那（几）个文件**，仓库的其余部分
   * 照旧不许翻 —— 那条「攻击文档不许滑成调查项目」的理由原样成立。
   */
  return "   读正方报出来的那份产出文件本身（它交的是路径，正文在文件里），"
    + "基于它提出问题。除那份产出之外不要读仓库的其他内容、不要自己动手修。";
};

/**
 * Review 里红蓝**都在报缺陷**，共用一个 id 空间 —— 所以给两边分前缀。
 *
 * 不分的后果不是「乱」，是**静默丢一条**：`readRound` 撞 id 时只留第一条，而两边
 * 审的是同一份代码，各自起一个 `REVIEW-1` 是完全可能的。「留哪一条」永远是个将就，
 * 分前缀让这件事结构上不会发生。
 *
 * 名单和 `redReviewsOthers` 是同一批阶段，而且必然如此：**只有红方的发现也算数的
 * 阶段，两边才会共用一个 id 空间**。这两处要一起改。
 *
 * 别的阶段只有蓝方报问题，不需要这套 —— 给红方讲一套它用不上的规矩只是噪音。
 */
const ID_PREFIX: Readonly<Record<string, { red: string; blue: string }>> = {
  Review: { red: "RV-", blue: "RVB-" },
  QA: { red: "QA-", blue: "QAB-" },
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
    /*
     * **不再要它报 `agent_id`。**
     *
     * 那一版（2026-07-30 到 08-02）要裁判把两个 36 字符的 UUID 抄进答案，而 StagePass
     * 拿它们做精确匹配。抄错一个字符这一轮就作废、正反两方说的话谁也看不到 ——
     * `02059a8` 是实测的一次（它把自己的线程报成了子 Agent）。现在 StagePass 自己按
     * rollout 里的 `parent_thread_id` 认（`work/round-runner.ts`）。
     *
     * 「一个跑完再派下一个」留着，而且分量比以前更重：**它现在是红蓝的判据** ——
     * 先出生的是正方，后出生的是反方。
     */
    "派生两个子 Agent，一个当正方、一个当反方。**你手上哪个 spawn 工具都行**，",
    "叫什么名字、什么路径都不要紧。",
    "",
    "**必须先派正方，等它跑完再派反方，不要并行。** 两个理由：反方要拿到正方的产出",
    "才能开始审，并行的话它会对着空气写意见；而且 StagePass 就是按这个先后认",
    "谁是正方、谁是反方的 —— 顺序反了，两边的话会被记到对方头上。",
    "",
    /*
     * **任务要原样转达，和 rubric 契约同一个抬头、同一个理由。**
     *
     * 2026-08-02 CHG-003 第一轮实测：裁判的提示词里明明有「人要的是这些：…排行榜…」
     * （人自己答的需求），**红方的 rollout 里却一个字都没有** —— 裁判转述任务时把它
     * 改写丢了，红方只能报「缺少产品输入」，四条 rubric 全判 no，一整轮白烧。
     *
     * 和 Review 那次丢 rubric 契约（`relayedTo` 那段注释）是同一个病：一段没有
     * 收件人的文本递到裁判手上，它就当成可以自己消化的背景。rubric 契约修了抬头，
     * 任务这段当时漏了。
     */
    `1. ${RED}。**下面这段任务原样转达给${RED}，一个字都不要改** ——`
    + `「人要的是这些」那几行是人自己答的需求，改写或省略它，${RED}就只能凭空编。`,
    input.task,
    ...redFixList(input.openGaps),
    ...idRule(input.phase, "red"),
    `   要求它按下面的格式作答：`,
    RESULT_CONTRACT,
    ...extra(input.addenda?.red),
    "",
    `2. ${BLUE}。任务：读正方产出，找出其中的遗漏、冲突与不可验证之处。`,
    blueReach(input.phase),
    ...(idRule(input.phase, "blue").length > 0
      ? idRule(input.phase, "blue")
      : ["   每个问题一个稳定 id（例如 SPEC-SCOPE-1），同一个问题在后续轮次要用同一个 id。"]),
    /*
     * **契约原文再给一遍，不说「同样的格式」。**
     *
     * 2026-08-02 CHG-003 第 4 轮实测：这里原来写「要求它按同样的格式作答」——
     * 「同样」指的是正方那节里的 RESULT_CONTRACT，但裁判没有把那段转给反方，
     * 反方就自己发明了一个形状（`{"id","question"}`，没有 severity），整轮作废。
     *
     * 和转丢需求、转丢 rubric 契约是同一个病的第三张脸：**凡是要经裁判转达的文本，
     * 指望它「参照上文」就是指望它转述 —— 只有原文加收件人才到得了。**
     */
    `   下面这段格式要求**原样转达给${BLUE}**，一个字都不要改：`,
    RESULT_CONTRACT,
    `   它找出的每个问题都要放进 blockers。`,
    /*
     * 逐条之外再要一句整体的（用户 2026-07-31）。
     *
     * **只有反方有这一格，正方没有。** 让正方给自己的产出写一句整体评价就是自评，
     * 而那是 2026-07-30 拿掉的东西 —— 实测红方自评累计 20 条全部 yes。
     *
     * 所以 `RESULT_CONTRACT` 本身不动（它是两边共用的），这一行只写在反方这一节。
     * `parseTurnResult` 只读它认识的字段，多一个 key 不会拒；反过来说，正方哪天
     * 真写了 `overall` 也不会被采信，因为没有人去读它。
     *
     * **它不动闸门**（用户明确选的）：不派生 gap、不进 blockers、不参与任何判定。
     * 它和裁判的结论并排出现在人裁决时看的那张表上，仅此而已。
     */
    `   再要它在同一个 json 块里多给一个 \`overall\` 字段：一句话说这一轮整体够不够格、`
    + `为什么。这一句不挡任何东西，是写给人看的。`,
    ...relayedTo(BLUE, input.addenda?.blue),
    "",
    /*
     * 裁判从「只做一件事」改成两件（用户 2026-07-31）。
     *
     * 第二件是他要的那句「还要不要再来一轮」。**它是建议，不是决定** —— 闸门仍然
     * 由人推（2026-07-30 拍板：要不要继续对抗由人决定，不做成全自动）。写明「你不需要
     * 考虑闸门」是为了让它就事论事，而不是去猜 StagePass 会拿它的话做什么。
     *
     * 要它**自己去读上游**，是因为这个结论只有读过才下得了。原来的提示词从没要求过
     * 它读任何文档，而 `rubric-defaults.ts` 里写着这条教训：一条只能靠猜的标准比没有
     * 更糟 —— 一个只能靠猜的结论同理。
     */
    "两个都做完之后，轮到你。**两件事**：",
    "",
    /*
     * **表态改走工具，不再手抄 id**（2026-08-02）。
     *
     * 原来这里印一份带 id 的清单，要裁判把那些 id 抄进一个 json 的 key 位置上 ——
     * 而 gap id 长 50 字符（`RB:critic:RBC-<uuid>`）、criterion key 长 40。抄漏一段，
     * 那一条的表态就凭空消失，人还看不出是「它说还在」还是「它抄错了」。
     * 实测过更糟的：同一个抄错的 UUID 连抄三轮。
     *
     * 清单仍然印出来，但**它现在是给人和给上下文看的**，不是给它抄的 —— 它照样需要
     * 知道这一轮要处理哪些问题才判得动。真正算数的是工具那一路。
     */
    "1. 对下面这些**已经存在**的问题逐条表态 —— **走工具，不要写进 json**：",
    "",
    "   反复调 `stagepass_next`（不带参数）取下一条，看完用 `stagepass_answer`",
    "   回答，直到它说没有了。**你不需要、也无法指定答的是哪一条** —— StagePass 记着。",
    "   下面这份清单是给你看背景的，不要把它们的编号抄进任何地方。",
    "",
    gaps,
    "",
    /*
     * **说「上面任务里列出来的那些」，不说「上游产物」。**
     *
     * PRD 自己没有上游，而任务书里那一节是**按有没有上游动态出现**的
     * （`round-turn-runner.ts`）。写死一句「读一遍已批准的上游产物」，PRD 那一轮就是
     * 在叫模型去找不存在的东西 —— 护栏当场抓到过这一条。
     *
     * 这个说法两边都成立：有上游时它指的就是那一节，没有时它指的是需求本身。
     */
    "2. 自己读一遍上面任务里列出来的那些输入、正方这一轮的产出、反方这一轮的意见，"
    + "然后给一个结论：**还要不要再来一轮，为什么。**",
    "   这是给人看的建议 —— 按不按由他决定，**你不需要考虑闸门**。",
    "   结论要建立在你实际读过的东西上，不是复述正方或反方说过的话。",
    "",
    /*
     * **json 里只剩 conclusion 了。**
     *
     * `verdicts` 那一段搬去工具了（见上），而 conclusion 是一句散文加一个布尔 ——
     * 里面没有任何 StagePass 要拿去精确匹配的字符串，所以它留在这儿是安全的。
     */
    "最后用一个 ```json 块给出结论，**里面只放这一样东西**：",
    '{"conclusion": {"another_round": true | false, "reason": "<为什么>"}}',
    "不要把逐条表态写进这个块 —— 那些走上面的工具，写在这里不算数。",
    "",
    "沉默等于仍然存在 —— 你没用工具表过态的问题会继续挡住闸门。",
    "关闭一个问题必须写清楚它为什么不再成立。",
  ].join("\n");
}

export interface VerdictReport {
  readonly verdicts: Readonly<Record<string, Verdict>>;
  /**
   * **信封本身就没读出来**（不是「它没给裁决」）。
   *
   * 两件事在 `verdicts` 上长得一模一样 —— 都是空的 —— 而它们要做的事完全不同：
   * 没给裁决是一次正常的轮（沉默 = 全部保持 open），而信封坏了意味着这条线程的
   * 历史里留下了一份坏格式，下一轮 resume 回去它会接着抄
   * （2026-08-02 实测：同一个坏形状连抄三轮）。
   *
   * **判据只有 `JSON.parse` 失败。** 解析成功但没有 `verdicts` 这个键不算 ——
   * 那时它确实什么都没说，而闸门方向是安全的。
   */
  readonly unreadable: boolean;
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
  // 同上：一个概念一个找法。
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonAnswerIn(text) ?? "");
  } catch {
    return { verdicts: {}, unreadable: true };
  }
  const record = (parsed as { verdicts?: unknown } | null)?.verdicts;
  if (record === undefined || record === null) return { verdicts: {}, unreadable: false };
  if (typeof record !== "object" || Array.isArray(record)) {
    throw new UnreadableVerdictError(JSON.stringify(record).slice(0, 120));
  }

  const verdicts: Record<string, Verdict> = {};
  for (const [gapId, value] of Object.entries(record as Record<string, unknown>)) {
    /*
     * **`conclusion` 塞错了位置不算一条裁决**（2026-08-02 实测：裁判把它放进了
     * `verdicts` 里）。它不是对某条 gap 的表态，按 malformed verdict 拒掉会作废
     * 整轮 —— 而 `readConclusion` 会去两个位置找它，谁也不丢。
     */
    if (gapId === "conclusion") continue;
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
  return { verdicts, unreadable: false };
}

/**
 * 一轮里除了逐条判定之外，还有两句**只写给人看**的话。
 *
 * 它们哪一句都不动闸门：裁判那句是建议（人按按钮），反方那句是整体印象。逐条的
 * 东西说不出「加起来怎么样」，而那正是人按按钮之前想知道的。
 *
 * 两句都按轮存着不覆盖 —— 和 `rubric_assessments` 同一个理由：「第几轮说了什么」
 * 要留得住。
 */
export const ROUND_NOTE_SOURCES = ["judge_conclusion", "blue_overall"] as const;
export type RoundNoteSource = (typeof ROUND_NOTE_SOURCES)[number];

/**
 * 这两句话在人裁决前看的那张表上长什么样。
 *
 * ## 为什么它必须落在那张表上
 *
 * 和 `summariseAssessments`（domain/rubric.ts）同一个理由，那边已经写清楚了：
 * **裁决发生在 Codex 画的选择器里，人按下去的那一刻眼前只有那张表。** 要他判断的
 * 信息不在那张表上，就等于要他凭记忆判断。
 *
 * 用户 2026-07-31：「每对抗一轮，我都是要知情的……前提是他要给我。」这是那条要求
 * 的最后一米。
 *
 * ## `anotherRound` 是 null 时**不许说「可以了」**
 *
 * null 的意思是裁判给了结论但写坏了 —— 「还要不要再来一轮」没有答案。把它渲染成
 * 「可以了」就是替裁判说了一句它没说过的话，而这一整套东西的立身之本正是不许
 * 出现这种话。所以那一种照实说「读不出来」。
 */
export function summariseRoundNotes(
  notes: readonly {
    readonly source: RoundNoteSource;
    readonly anotherRound: boolean | null;
    readonly text: string;
  }[],
): string {
  const lines: string[] = [];

  const judge = notes.find((each) => each.source === "judge_conclusion");
  if (judge) {
    const call = judge.anotherRound === null ? "结论读不出来"
      : judge.anotherRound ? "还需要再来一轮" : "可以了";
    lines.push(`裁判：${call} —— ${judge.text}`);
  }

  const blue = notes.find((each) => each.source === "blue_overall");
  if (blue) lines.push(`${BLUE}的整体判断：${blue.text}`);

  return lines.length === 0 ? "" : `\n${lines.join("\n")}`;
}

/**
 * 裁判对「还要不要再来一轮」的结论。
 *
 * `null` = 它没给（沉默 = 没有建议，这一轮照常）。
 */
export type RoundConclusion =
  | { readonly kind: "advised"; readonly anotherRound: boolean; readonly reason: string }
  /** 它给了，但读不出来。**原文带着走**，人要看见的是这个。 */
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * 读裁判的结论。
 *
 * ## 错处理和 `verdicts` 不一样，这是有意的
 *
 * 一个坏掉的 `verdicts` 会抛、整轮失败 —— 因为它**决定 gap 的状态**，拿一份读不准
 * 的东西去改状态比不改危险。
 *
 * `conclusion` 不决定任何状态：闸门由人推（用户 2026-07-31：裁判给结论，人按按钮）。
 * 为一句读不准的建议作废一轮几分钟的对抗不成比例。
 *
 * 所以坏掉时**不抛**，返回 `unreadable` 并把原文带上 —— 那不是静默跳过：人照样在
 * 裁决那张表上看见「裁判的结论读不出来」，这正是「每一轮我都要知情」那条要求。
 *
 * 一句话的判据：**改状态的东西读不准就拒，给人看的东西读不准就照实说读不准。**
 */
export function readConclusion(text: string): RoundConclusion | null {
  // 和 `readVerdicts` 同一个找法（`jsonAnswerIn`）：两处各严各的，就会出现
  // 「这处漏了围栏能读、那处漏了读不了」这种说不出道理的差别。
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonAnswerIn(text) ?? "");
  } catch {
    return null;
  }
  // 顶层优先；裁判塞进 verdicts 里的也认（2026-08-02 实测的走位，readVerdicts
  // 那边会跳过它 —— 两边配对，谁也不把它读成别的东西）。
  const shape = parsed as {
    conclusion?: unknown;
    verdicts?: { conclusion?: unknown } | null;
  } | null;
  const record = shape?.conclusion ?? shape?.verdicts?.conclusion;
  if (record === undefined || record === null) return null;

  const entry = record as { another_round?: unknown; reason?: unknown };
  if (
    typeof entry.another_round !== "boolean"
    || typeof entry.reason !== "string"
    || entry.reason.trim() === ""
  ) {
    return { kind: "unreadable", detail: JSON.stringify(record).slice(0, 200) };
  }
  return {
    kind: "advised", anotherRound: entry.another_round, reason: entry.reason.trim(),
  };
}

/**
 * 这一轮跑在哪两条子 Agent 线程上。
 *
 * **StagePass 自己按血缘认的，不是裁判报的**（`work/round-runner.ts` 用
 * `codex/subagent.ts` 的 `childThreadsOf`）。让裁判报那一版活到 2026-08-02 ——
 * 它把 36 字符的 UUID 放进了模型必须手抄的文本里，抄错一个字符整轮作废。
 * 见 docs/DESIGN-no-hand-transcription-2026-08-02.md §三。
 */
export interface RoundAgents {
  /** 正方那条子 Agent 线程 —— 先出生的那条。 */
  readonly red: string;
  /** 反方那条 —— 后出生的那条。 */
  readonly blue: string;
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
  /**
   * 反方对这一轮的整体判断，一句话。没给就是 null。
   *
   * **不动闸门**（用户 2026-07-31）：不派生 gap、不进 blockers。它和裁判的结论并排
   * 出现在人裁决时看的那张表上 —— 逐条的东西说不出「加起来怎么样」，而那正是他
   * 按按钮之前想知道的。
   */
  readonly blueOverall: string | null;
}

/**
 * 反方那句整体判断。
 *
 * 单独读，不走 `parseTurnResult` —— 那个函数只认 `artifactIds` / `blockers` 两样，
 * 而**这一句缺席是完全合法的**（老的反方不会写它，`RESULT_CONTRACT` 里也没有它）。
 * 把它加进那个函数的形状检查，等于让一次没写整体判断的回答整轮作废，而它不挡任何东西。
 */
const overallIn = (text: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonAnswerIn(text) ?? "");
  } catch {
    return null;
  }
  const overall = (parsed as { overall?: unknown } | null)?.overall;
  if (typeof overall !== "string") return null;
  const trimmed = overall.trim();
  return trimmed === "" ? null : trimmed;
};

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

export function readRound(
  transcript: RoundTranscript,
  /**
   * 裁判对已有问题的表态。
   *
   * **从名单里来，不从它写的 json 里来**（2026-08-02）。原来是
   * `readVerdicts(transcript.judge)` —— 那要求裁判把 50 字符的 gap id 手抄进一个
   * json 的 key 位置上，而 StagePass 拿它做精确匹配。抄漏一段，那一条的表态就凭空
   * 消失（而 gap 保持 open，人看不出是「它说还在」还是「它抄错了」）。
   *
   * 现在它调 `stagepass_next` / `stagepass_answer`，一条一条答，一个标识符都不写。
   * 见 docs/DESIGN-no-hand-transcription-2026-08-02.md。
   */
  verdicts: Readonly<Record<string, Verdict>>,
): RoundReading {
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
      verdicts,
    },
    blueOverall: overallIn(transcript.blue),
  };
}
