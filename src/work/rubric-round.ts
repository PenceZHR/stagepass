import type { Assessment, RubricRole } from "../domain/rubric";
import type { Phase } from "../domain/phase";
import { applyAssessments } from "../domain/rubric-gaps";
import { BLUE, RED } from "../domain/round";
import type { CodexTransport } from "../codex/transport";
import type { RubricStore, RubricVersion } from "../store/rubric-store";
import { runRound, type RoundDependencies, type RoundRequest, type RoundSettled } from "./round-runner";
import type { WorkItemDraft } from "../domain/worklist";
import type { WorkItem, WorklistStore } from "../store/worklist-store";

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
 * 补问最多几次。**用户 2026-07-31 定的 3。**
 *
 * 他要的是「补到它答上为止」，但那不能真的无限：每一次都是一个真 turn（几十秒到
 * 几分钟），而这一轮外面还有 30 分钟的 job 租约兜着（`TurnLoop`）。无限补的结局
 * 不是「终于答上了」，是租约到期、整轮被判失败 —— 那比记一句「问了三遍没答上」
 * 糟得多，因为后者至少还是句实话。
 */
const ASK_AGAIN_AT_MOST = 3;

/** 补问的结局。`null` = 这一份没走补问那条路。 */
type FollowUp =
  /** 补了 n 次，它仍然没答上。 */
  | { readonly kind: "asked"; readonly times: number }
  /** 补问**这个动作本身**失败了。和「它不肯答」是两件事，必须分开说。 */
  | { readonly kind: "failed"; readonly times: number; readonly detail: string };

function whyNotAssessed(input: {
  readonly assessor: Participant;
  /** 问它的结局。null = 一次都没问成，或者根本没走到问它那一步。 */
  readonly followUp: FollowUp | null;
}): string {
  const who = WHO[input.assessor];
  const clauses = ["它没有作答"];

  /*
   * 两种必须分得开：**它被问了 n 遍就是不答**（模型的问题，人可能要换标准或换法子），
   * 和**问它这个动作本身失败了**（StagePass / Codex 的问题，跟它无关）。混成一句，
   * 人会去改一份根本没毛病的 rubric。
   */
  if (input.followUp?.kind === "asked") {
    clauses.push(`又问了 ${input.followUp.times} 次，仍然没有作答`);
  } else if (input.followUp?.kind === "failed") {
    clauses.push(
      `问它没能进行下去（第 ${input.followUp.times} 次时失败：${input.followUp.detail}）`
      + `—— 这是这个动作本身出了问题，不是${who}拒绝作答`,
    );
  }

  return `${clauses.join("；")}。`;
}

/**
 * 反方那份标准：**StagePass 自己去问它，逐条走工具。**
 *
 * ## 为什么不再经裁判转达
 *
 * 原来那份契约夹在裁判的提示词里，指望它原样转给反方。实测的三种断法（没送到 /
 * 送到不答 / 答错对象）里有两种是转达出的问题 —— 而「凡经裁判转达的文本，只有
 * 原文加收件人才到得了」那条教训本身就说明：这条链不该存在。
 *
 * 现在 StagePass 直接 resume 反方那条线程单起一轮。argv 是 StagePass 自己拼的，
 * 所以插件和正确的 `STAGEPASS_CHANGE` 一并带上 —— 子 Agent 不继承 `-c` 传的 MCP
 * server（2026-08-02 真机验的），但**这一轮不是它继承来的，是我们给它起的**。
 *
 * ## 于是反方也不用手抄任何东西
 *
 * 提示词里一条 criterion key 都没有，正文由 `stagepass_next` 给。这就是七个手抄面
 * 里最后一个的归零。
 *
 * ## 没答完就再问，最多三次
 *
 * 游标留在库里，所以「再问一次」就是再跑一个 turn —— 不必重新开名单，它自然接着
 * 上次没答完的那一条。
 */
async function askBlueByWorklist(input: {
  readonly transport: CodexTransport;
  readonly worklist: WorklistStore;
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly threadId: string;
  readonly rubric: RubricVersion;
  readonly subject: string;
}): Promise<{ read: Assessment[]; followUp: FollowUp | null }> {
  input.worklist.append(input.changeId, input.phase, input.round,
    input.rubric.criteria.map((criterion) => ({
      kind: "criterion" as const,
      target: criterion.key,
      prompt: `${input.subject}：这一条标准满足了吗？\n${criterion.text}`,
      choices: ["yes", "no"],
    })));

  let times = 0;
  let failure: FollowUp | null = null;
  while (times < ASK_AGAIN_AT_MOST) {
    if (input.worklist.next(input.changeId) === null) break;
    times += 1;
    try {
      await input.transport.runTurn({
        threadId: input.threadId,
        prompt: [
          `你刚才审的那份产出，还要请你**逐条判定**几条标准 —— 判的是${input.subject}。`,
          "",
          "反复调 `stagepass_next`（不带参数）取下一条，看完用 `stagepass_answer`",
          "（只给 `answer` 和 `reason`）作答，直到它说没有下一条了为止。",
          "",
          "**你不需要、也无法指定答的是哪一条 —— StagePass 记着。**",
          "不要在回答里写任何编号，`reason` 里写清依据就够。",
        ].join("\n"),
        // 跑在反方自己那条线程上，所以不能挤掉阶段那个终端；面板给它单开一格，
        // 跑完自动收（用户 2026-07-31）。
        aside: { label: `${BLUE}·逐条判定` },
      });
    } catch (error: unknown) {
      failure = {
        kind: "failed",
        times,
        detail: error instanceof Error ? error.message : String(error),
      };
      break;
    }
  }

  input.worklist.close(input.changeId, input.phase, input.round);
  const read = fromWorklist(
    input.worklist.read(input.changeId, input.phase, input.round), input.rubric,
  );
  const stillMissing = read.some((entry) => entry.verdict === "not_assessed");
  return {
    read,
    followUp: failure ?? (times === 0 || !stillMissing ? null : { kind: "asked", times }),
  };
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

  const settled = await runRound({
    ...request,
    extraWorkItems: judgeItems,
  }, dependencies);

  const assessments: Record<RubricRole, readonly Assessment[]> = {
    producer: [], critic: [], verdict: [],
  };
  /** 这一轮有哪几份判定整份作废了 —— 汇进 `malformed` 交给上层放线程。 */
  const voided: string[] = [];
  let gaps = settled.gaps;

  for (const [role, rubric] of active) {
    const assessor = ASSESSED_BY[role]!.by;

    /*
     * **两边都走名单了。**
     *
     * 裁判在它自己那一轮里逐条答（名单在 turn 之前就开好）；反方由 StagePass 单独
     * 去问，跑在它自己那条线程上（`askBlueByWorklist`）。两条路都不经模型的嘴传
     * 任何标识符 —— 那是这一整套改动的落点，见
     * docs/DESIGN-no-hand-transcription-2026-08-02.md。
     */
    const { read, followUp } = assessor === "blue"
      ? await askBlueByWorklist({
          transport: dependencies.transport,
          worklist: dependencies.worklist,
          changeId: request.changeId,
          phase: request.phase,
          round: request.round,
          threadId: settled.agents.blue,
          rubric,
          subject: ASSESSED_BY[role]!.subject,
        })
      : { read: fromWorklist(settled.workItems, rubric), followUp: null };

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
