import type { Assessment, RubricRole } from "../domain/rubric";
import type { Phase } from "../domain/phase";
import { applyAssessments } from "../domain/rubric-gaps";
import type { BlueRubricAnswers } from "../domain/round";
import { BLUE, RED, readBlueRubricAnswers } from "../domain/round";
import type { RubricStore, RubricVersion } from "../store/rubric-store";
import { runRound, type RoundDependencies, type RoundRequest, type RoundSettled } from "./round-runner";
import type { WorkItemDraft } from "../domain/worklist";
import type { WorkItem } from "../store/worklist-store";

type Participant = keyof RoundSettled["transcripts"];

/** 写给人看的时候，三方各叫什么。 */
const WHO: Readonly<Record<Participant, string>> = {
  red: RED, blue: BLUE, judge: "裁判",
};

/**
 * 一轮对抗，外加每个角色对自己那份 rubric 的逐条判定。
 *
 * ## 为什么住在这一层
 *
 * `runRound` 是 L4，rubric 是 L5，**L4 不能 import L5**。所以这里是包在外面的一层
 * 而不是塞进去的一段：L4 只多收了一个纯字符串的 `addenda`，它至今不知道 rubric
 * 是什么东西。
 *
 * ## 角色的对应
 *
 *   producer -> 红方的 rollout
 *   critic   -> 蓝方的 rollout
 *   verdict  -> 裁判自己的返回
 *
 * 三份 rubric 各自独立：正方按「我该产出什么」被判，反方按「我该挑出什么」被判，
 * 裁判按「我该怎么裁」被判。
 *
 * ## 作废的输出会 fail-closed，而不是被跳过
 *
 * `readAssessments` 对结构坏掉的输出抛异常，本意是**让它可以重试**。但到了这里，
 * 那一轮已经跑完、findings 已经落库 —— 重试的粒度是下一轮，不是这一次。
 *
 * 所以这里把作废翻译成「这一轮什么都没评上」：**每一条 criterion 记 `not_assessed`**。
 * 而标了阻断的 `not_assessed` 是挡门的，于是作废的后果是**闸门关着**，不是标准被
 * 悄悄跳过。作废的原因写进 evidence，人看得见。
 *
 * 反过来做 —— 作废就当没有 rubric —— 会让一份写坏的输出比一份诚实答 no 的输出更
 * 容易过闸门。那是这套机制存在的理由的反面。
 */

/**
 * 一份标准由**谁**来判，以及判的是谁的活儿。
 *
 * ## 没有人给自己打分（用户 2026-07-30 拍板，所有阶段）
 *
 * 原来是每个角色对照自己那份：`producer` 读红方的话、`critic` 读蓝方的话。实测的
 * 结果是橡皮图章 —— 五个阶段跑下来，**红方自评累计 20 条全部 yes，一个 no 都没有**，
 * 而所有判出问题的判定都来自评自己的蓝方。一个模型给自己的产出打分，和「模型说
 * 没问题」是同一件事，那正是这个产品存在的理由的反面。
 *
 * 排完之后是一条链：蓝方判红方、裁判判蓝方、裁判自己那份交给人。
 *
 * ## `verdict` 是 null，而且它不是「以后再说」
 *
 * 链排到裁判就没有下一个模型了。让裁判对照自己那份打分就是把刚拿掉的毛病装回去，
 * 所以它**不进对抗**：不注入任何提示词、不产生判定、不派生 standard。
 * 那几条标准改由人在弹窗里对照裁判这一轮的表态自己看（用户 2026-07-30 选的）——
 * 裁判本来就是人直接在读的那一个。
 *
 * ## 一个参与者只背一份，这是硬约束不是审美
 *
 * `readAssessments` 见到 fence 里有不认识的 key 会**作废整份**（那条规则有它自己的
 * 理由，见 rubric-protocol.ts）。两份标准塞进同一个人的提示词，它答出来的那一个
 * fence 对两份来说都含着「不认识的 key」，于是**两份一起作废**。所以这张表里
 * 三个角色的落点必须两两不同。
 */
const ASSESSED_BY: Readonly<
  Record<RubricRole, { by: keyof RoundSettled["transcripts"]; subject: string } | null>
> = {
  producer: { by: "blue", subject: "正方这一轮的产出" },
  critic: { by: "judge", subject: "反方这一轮挑问题的表现" },
  verdict: null,
};

/**
 * 这一份标准由谁判，`null` = 不进对抗（交给人）。
 *
 * 面板要照实说得出「这一份不进对抗，你自己对照裁判的表态看」—— 不说，verdict 那一栏
 * 会显示成「这个角色当时没有 rubric」，而那是**假话**：标准在，只是不再由模型判。
 *
 * 导出来，是为了让界面**读**这条规则而不是**抄**它。同一条规则的两份拷贝必然漂移，
 * 而漂移的那一天，界面会理直气壮地说错话。
 */
export const assessorOf = (
  role: RubricRole,
): keyof RoundSettled["transcripts"] | null => ASSESSED_BY[role]?.by ?? null;

export interface RubricRoundRequest extends RoundRequest {
  /** rubric 有项目级默认，所以要知道这个 Change 属于哪个项目。 */
  readonly projectId: string;
}

export interface RubricRoundDependencies extends RoundDependencies {
  readonly rubrics: RubricStore;
  /**
   * 一条线程**收到过**的全部文本 —— 它说的，和它被告知的。
   *
   * 和 `readThread`（它说了什么）并列，不是它的替代。多这一个 reader 是为了回答
   * 一个 `readThread` 结构上答不了的问题：**契约到底送到没有。** 契约在「它被问到
   * 的那一段」里，而 `readThread` 只收模型说过的话。
   *
   * 「反方没答」和「反方压根没收到」今天在库里长得一模一样（evidence 都是 NULL），
   * 而人对这两件事该做的事完全不同。见
   * docs/DESIGN-rubric-delivery-2026-07-31.md §3.3。
   */
  readonly readThreadWhole: (threadId: string) => string;
}

/**
 * 一条标准这一轮为什么没有判定 —— **写给人看的那句话。**
 *
 * 用户 2026-07-31：「每对抗一轮，我都是要知情的……前提是他要给我。」而所有没判上的
 * 若都记成 `not_assessed` + `evidence` 为 `NULL`，几种完全不同的原因就写成了同一句
 * 「没评估」—— 混成一句等于什么都没说。
 */
/**
 * 反方那份判定为什么没成。`null` = 成了，或者这一份根本不归反方判。
 *
 * 原来这里还有一种 `asked`（补问了 n 次它仍不答）。补问那条路是
 * 「StagePass 自己 resume 反方线程」，2026-08-03 实测被 Codex 封了
 * （见 `blueRubricFiles`），那种结局结构上不再可能发生，所以一并退场 ——
 * 留着它就是留一个永远为假的分支给下一个读代码的人去猜。
 */
type FollowUp =
  { readonly kind: "failed"; readonly times: number; readonly detail: string };

function whyNotAssessed(input: {
  readonly assessor: Participant;
  /** 问它的结局。null = 一次都没问成，或者根本没走到问它那一步。 */
  readonly followUp: FollowUp | null;
}): string {
  const who = WHO[input.assessor];
  const clauses = ["它没有作答"];

  /*
   * **「它没答」和「它答了但对不上号」必须分得开。**
   *
   * 前者是模型的判断（人可能要换标准、或者换个问法），后者是这份判定整份作废了
   * —— 而作废的那份里，它其实**逐条都写了**，只是数不对。混成一句，人会去改一份
   * 根本没毛病的 rubric。
   */
  if (input.followUp !== null) {
    clauses.push(`${input.followUp.detail}（不是${who}拒绝作答）`);
  }

  return `${clauses.join("；")}。`;
}

/**
 * 反方那半 rubric：**StagePass 写文件，裁判转达路径，反方把答案写回文件。**
 *
 * ## 为什么不是直接去问它
 *
 * 原来（`3d32ea3`）是 StagePass 自己 `codex resume` 反方线程单起一轮。2026-08-03
 * 真机实测那条路**结构上不成立**：Codex 禁止外部驱动子 Agent 线程 ——
 *
 *     ■ This sub-agent is controlled by its parent. Direct input is disabled.
 *
 * 而且和父线程活不活着无关（探针 `scripts/probe-subagent-input.ts`：父线程一小时前
 * 就结束的那条照样拒）。唯一还通的通道是**它的父线程**，也就是裁判。
 *
 * ## 那不是又回到「经裁判转达」的老病了吗
 *
 * 转的是**两个路径**，不是标准正文、更不是 criterion key。2026-08-02 那三张脸
 * （转丢需求、转丢契约、答错对象）长在「要它转述一段正文」上；一个路径它没什么可
 * 消化的，转坏了反方会大声说读不到文件，而不是安静地判错一条。
 *
 * 反方手上只有 `1..N` 的序号和散文，**key 由 StagePass 按序号映射回去** —— 七个
 * 手抄面仍然是零。
 *
 * ## 数不对就整份作废
 *
 * 用户 2026-08-03 定的。判定在 `domain/round.ts` 的 `readBlueRubricAnswers`。
 */
function blueRubricFiles(input: {
  readonly writeRoundFile: (name: string, content: string) => string;
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly rubric: RubricVersion;
  readonly subject: string;
}): { criteriaPath: string; answersPath: string; count: number } {
  const stem = `${input.changeId}-${input.phase}-r${input.round}`;
  /*
   * **标准正文进文件，序号是它唯一的身份。** criterion key 一个字都不出现 ——
   * 它出现在这里，就等于把它交给了模型的嘴。
   */
  const criteriaPath = input.writeRoundFile(
    `rubric-${stem}.md`,
    [
      `# 要判的标准：${input.subject}`,
      "",
      `一共 ${input.rubric.criteria.length} 条。逐条判，按序号回答。`,
      "",
      ...input.rubric.criteria.map((criterion, index) =>
        `${index + 1}. ${criterion.text}`),
      "",
    ].join("\n"),
  );
  /*
   * 答案那份**先写一个空壳**，只为了拿到路径。
   *
   * 不预先建它的话，这一层就得自己拼路径 —— 而拼路径意味着这一层要知道
   * `writeRoundFile` 把文件放在哪，那是它不该知道的事（那个目录是每轮一个临时目录）。
   */
  const answersPath = input.writeRoundFile(
    `rubric-answers-${stem}.md`,
    `# ${input.subject}：逐条判定\n\n（反方把答案写在这里，一行一条，形如 \`3: yes —— 依据…\`）\n`,
  );
  return { criteriaPath, answersPath, count: input.rubric.criteria.length };
}

/**
 * 给每一条没判上的补一句「为什么」。
 *
 * ## 剩下的原因只有两种了
 *
 * 以前有四种（契约没送到 / 送到没答 / 答错对象 / 别人代答），因为那份契约要经裁判
 * 转达 —— 三种断法都长在那条链上。**现在没有那条链了**：两边都由 StagePass 自己
 * 开名单、自己问，一条 criterion key 都不经模型的嘴。于是只剩「它没答」和
 * 「问它这件事本身失败了」，而这两种人要做的事仍然完全不同。
 */
function withReasons(
  read: readonly Assessment[],
  context: {
    readonly assessor: Participant;
    readonly followUp: FollowUp | null;
  },
): Assessment[] {
  return read.map((entry) => {
    if (entry.verdict !== "not_assessed" || entry.evidence !== null) return entry;
    return {
      ...entry,
      evidence: whyNotAssessed({
        assessor: context.assessor,
        followUp: context.followUp,
      }),
    };
  });
}

export interface RubricRoundSettled extends RoundSettled {
  /** 每个角色这一轮的判定。没有 rubric 的角色是空数组。 */
  readonly assessments: Readonly<Record<RubricRole, readonly Assessment[]>>;
}

/**
 * 名单答成什么样 -> 这一份 rubric 的判定。
 *
 * **`target` 是 criterion key，而模型从头到尾没见过它。** 它只被问「这一条标准满足
 * 了吗：<正文>」，答 yes/no 加一句依据。对不对得上号由 StagePass 记着 —— 这就是
 * 「精确标识符绝不经由模型」那条约束在 rubric 这一侧的落点。
 *
 * 没答上的记 `not_assessed`，理由由 `withReasons` 补 —— 和以前一样，标了阻断的
 * 漏答仍然挡门。
 */
function fromWorklist(
  items: readonly WorkItem[],
  rubric: RubricVersion,
): Assessment[] {
  const answered = new Map(items
    .filter((item) => item.kind === "criterion" && item.answer !== null)
    .map((item) => [item.target, item]));

  return rubric.criteria.map((criterion) => {
    const item = answered.get(criterion.key);
    return {
      criterionKey: criterion.key,
      verdict: (item?.answer ?? "not_assessed") as Assessment["verdict"],
      evidence: item?.reason ?? null,
      criterionText: criterion.text,
      blockingThen: criterion.blocking,
    };
  });
}

/**
 * 按序号把反方的答案贴回 criterion key 上。
 *
 * **整份作废时全部 `not_assessed`**，一条也不采信 —— 位置映射一旦错位，那条判定会
 * 挂到别的标准上，而人没有任何办法察觉。理由那句由 `withReasons` 从 `followUp`
 * 里接过去，所以这里只管数据。
 */
function byOrdinal(
  rubric: RubricVersion,
  answers: BlueRubricAnswers | null,
): Assessment[] {
  return rubric.criteria.map((criterion, index) => {
    const given = answers?.voided === null ? answers.answers[index] : undefined;
    return {
      criterionKey: criterion.key,
      verdict: (given?.verdict ?? "not_assessed") as Assessment["verdict"],
      evidence: given?.evidence ?? null,
      criterionText: criterion.text,
      blockingThen: criterion.blocking,
    };
  });
}

export async function runRubricRound(
  request: RubricRoundRequest,
  dependencies: RubricRoundDependencies,
): Promise<RubricRoundSettled> {
  const { rubrics } = dependencies;

  // 先取三份 rubric。没有就是没有 —— 空 rubric 合法，等于这个角色不做判定，
  // 行为退回没有 rubric 之前的样子（RUBRIC-DESIGN §4.5）。
  const active = new Map<RubricRole, RubricVersion>();
  for (const role of Object.keys(ASSESSED_BY) as RubricRole[]) {
    // 不进对抗的角色（verdict）连读都不读 —— 它的标准是给人看的，不是给模型答的。
    if (ASSESSED_BY[role] === null) continue;
    const rubric = rubrics.effective(
      request.projectId, request.changeId, request.phase, role,
    );
    if (rubric && rubric.criteria.length > 0) active.set(role, rubric);
  }


  /**
   * 裁判要判的那几条标准，**进名单，不进提示词**。
   *
   * `target` 是 criterion key（40 字符的 UUID），模型从头到尾看不到它 —— 它只被问
   * 「第 N 条：<正文>，答 yes 还是 no」。这就是 #3 里裁判那一半的归零。
   */
  const judgeItems: WorkItemDraft[] = [];
  for (const [role, rubric] of active) {
    const assessed = ASSESSED_BY[role];
    if (assessed?.by !== "judge") continue;
    for (const criterion of rubric.criteria) {
      judgeItems.push({
        kind: "criterion",
        target: criterion.key,
        prompt: `${assessed.subject}：这一条标准满足了吗？\n${criterion.text}`,
        choices: ["yes", "no"],
      });
    }
  }

  /*
   * **反方那份在 turn 之前就要写出来** —— 它的路径要进裁判的提示词。
   *
   * 至多一份：`ASSESSED_BY` 里 `by: "blue"` 的只有 producer 那一个角色。真多出
   * 第二份的那天这里会安静地只带上第一份，所以宁可在这儿就报出来。
   */
  const blueRoles = [...active].filter(([role]) => ASSESSED_BY[role]?.by === "blue");
  if (blueRoles.length > 1) {
    throw new Error(
      `这一轮有 ${blueRoles.length} 份 rubric 要反方判，而提示词只带得动一份`,
    );
  }
  const blueEntry = blueRoles[0];
  const blueFiles = blueEntry === undefined ? undefined : blueRubricFiles({
    writeRoundFile: dependencies.writeRoundFile,
    changeId: request.changeId,
    phase: request.phase,
    round: request.round,
    rubric: blueEntry[1],
    subject: ASSESSED_BY[blueEntry[0]]!.subject,
  });

  const settled = await runRound({
    ...request,
    extraWorkItems: judgeItems,
    ...(blueFiles === undefined ? {} : { blueRubric: blueFiles }),
  }, dependencies);

  /*
   * 反方写回来的那份，读一次就够 —— 两个角色不会同时要它判（上面那条守卫）。
   * 文件不在就是 `null`，和「写了但对不上号」由 `readBlueRubricAnswers` 分开说。
   */
  const blueAnswers = blueFiles === undefined
    ? null
    : readBlueRubricAnswers(
        dependencies.readRoundFile(blueFiles.answersPath), blueFiles.count);

  const assessments: Record<RubricRole, readonly Assessment[]> = {
    producer: [], critic: [], verdict: [],
  };
  /** 这一轮有哪几份判定整份作废了 —— 汇进 `malformed` 交给上层放线程。 */
  const voided: string[] = [];
  let gaps = settled.gaps;

  for (const [role, rubric] of active) {
    const assessor = ASSESSED_BY[role]!.by;

    /*
     * **两条路都不经模型的嘴传任何标识符**，只是形状不同了。
     *
     * 裁判在它自己那一轮里逐条走工具（名单在 turn 之前就开好，游标在库里）；
     * 反方读一份按 `1..N` 编号的文件、把答案写回另一份文件，**key 由 StagePass
     * 按序号映射回去**。见 `blueRubricFiles` 那段：直接去问它那条路被 Codex 封了。
     */
    const read = assessor === "blue"
      ? byOrdinal(rubric, blueAnswers)
      : fromWorklist(settled.workItems, rubric);
    const followUp: FollowUp | null = assessor === "blue" && blueAnswers?.voided
      ? { kind: "failed", times: 1, detail: blueAnswers.voided }
      : null;

    assessments[role] = withReasons(read, { assessor, followUp });

    rubrics.record(
      request.changeId, request.phase, role, request.round, rubric,
      assessments[role]!.map((entry) => ({
        criterionKey: entry.criterionKey,
        verdict: entry.verdict,
        evidence: entry.evidence,
      })),
    );

    gaps = applyAssessments(gaps, {
      round: request.round, role, assessments: assessments[role]!,
    });
  }

  if (active.size > 0) {
    dependencies.gaps.replace(request.changeId, request.phase, gaps);
  }

  const blockers = gaps
    .filter((gap) => gap.status === "open")
    .map((gap) => ({
      id: gap.id, kind: gap.kind, severity: gap.severity, title: gap.title,
    }));

  return {
    ...settled,
    gaps,
    blockers,
    assessments,
    malformed: [
      ...settled.malformed,
      ...voided.map((code) => `rubric_void:${code}`),
    ],
  };
}
