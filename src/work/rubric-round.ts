import type { Assessment, RubricRole } from "../domain/rubric";
import {
  answeredKeysIn, readAssessments, RubricOutputVoidError, rubricContract,
} from "../domain/rubric-protocol";
import { applyAssessments } from "../domain/rubric-gaps";
import { BLUE, RED } from "../domain/round";
import type { RubricStore, RubricVersion } from "../store/rubric-store";
import { runRound, type RoundDependencies, type RoundRequest, type RoundSettled } from "./round-runner";

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
 * ## 为什么必须有它
 *
 * 用户 2026-07-31：「每对抗一轮，我都是要知情的……前提是他要给我。」而今天所有没
 * 判上的都记成 `not_assessed` + `evidence` 为 `NULL`，四种完全不同的原因写成同一句
 * 「没评估」：
 *
 * - 契约没送到反方（Review 实测：它的 rollout 里一个 `RBC-` 都没有）
 * - 送到了，反方一条没答（QA 实测）
 * - 送到了，反方答的是裁判那一份（Retro 实测，等于给自己打分）
 * - 别人替它答了（Review 实测：裁判把 8 条全答了）
 *
 * 四种要做的事完全不同，混成一句就等于什么都没说。
 *
 * ## 拼法
 *
 * 「送达」一句 +「谁答的」一句，**后者只在带来新信息时才写**：契约压根没送到时
 * 「它没有作答」是同义反复，不写；但「这一条被别人代答了」即使在没送到时也要写 ——
 * 那是另一件独立发生的事，而且正是人要看见的那件。
 *
 * ## 代答的照实说，但不算数
 *
 * 用户同一次定的：「**蓝方一定是要勾的**。」所以裁判替反方答的那几条不采信 ——
 * 记下来是「我要知情」，不算数是「蓝方一定要勾」，两条同时成立，不冲突。
 */
function whyNotAssessed(input: {
  readonly assessor: Participant;
  /** 契约有没有送到。`null` = 不适用：StagePass 直接写进了那个人的提示词。 */
  readonly delivered: boolean | null;
  /** 它答的是别人那一份。 */
  readonly answeredAnother: boolean;
  /** 这一条被别的参与者答了。null = 没有。 */
  readonly answeredBy: Participant | null;
}): string {
  const who = WHO[input.assessor];
  const clauses: string[] = [];

  if (input.delivered === false) {
    clauses.push(`这一轮的标准没有送到${who}手上（裁判没有转达）`);
  } else if (input.delivered === true) {
    clauses.push(`标准送到了${who}`);
  }

  if (input.answeredAnother) {
    clauses.push("它答的是另一份标准，不是这一份");
  } else if (input.delivered !== false) {
    clauses.push("它没有作答");
  }

  if (input.answeredBy !== null) {
    clauses.push(
      `这一条由${WHO[input.answeredBy]}作答，而它不是这一份的判定人，不采信`,
    );
  }

  return `${clauses.join("；")}。`;
}

/**
 * 这几条标准被**别的**参与者答了没有，答了的话是谁。
 *
 * 「谁答的」这个问题 `readAssessments` 结构上答不了 —— 它只读一个人的话，对着一份
 * 标准。而错位是跨人的：2026-07-31 实测 Review 第 6 轮，裁判把反方那 4 条也答了，
 * 那 4 条答案确实存在、写得也像样，只是出自没有资格判它们的那张嘴。
 *
 * 一条被两个人答的情况按参与者顺序取第一个 —— 这里要说的是「有人代答了」，
 * 不是清点有几个人代答。
 */
function answeredBy(
  transcripts: RoundSettled["transcripts"],
  assessor: Participant,
  mine: ReadonlySet<string>,
): Map<string, Participant> {
  const found = new Map<string, Participant>();
  for (const who of Object.keys(transcripts) as Participant[]) {
    if (who === assessor) continue;
    for (const key of answeredKeysIn(transcripts[who], mine)) {
      if (!found.has(key)) found.set(key, who);
    }
  }
  return found;
}

/**
 * 给每一条没判上的补一句「为什么」。
 *
 * **整份作废那一种不碰** —— 它已经带着自己的原因（`整份判定作废（unknown_key）…`），
 * 而那是一件不同的事：那时契约送到了、人也答了，只是答出来的东西不能采信。
 * 用送达情况把它盖掉，等于把一句准确的话换成一句不相干的话。
 */
function withReasons(
  read: readonly Assessment[],
  context: {
    readonly assessor: Participant;
    readonly delivered: boolean | null;
    readonly answeredAnother: boolean;
    readonly answeredElsewhere: ReadonlyMap<string, Participant>;
  },
): Assessment[] {
  return read.map((entry) => {
    if (entry.verdict !== "not_assessed" || entry.evidence !== null) return entry;
    return {
      ...entry,
      evidence: whyNotAssessed({
        assessor: context.assessor,
        delivered: context.delivered,
        answeredAnother: context.answeredAnother,
        answeredBy: context.answeredElsewhere.get(entry.criterionKey) ?? null,
      }),
    };
  });
}

export interface RubricRoundSettled extends RoundSettled {
  /** 每个角色这一轮的判定。没有 rubric 的角色是空数组。 */
  readonly assessments: Readonly<Record<RubricRole, readonly Assessment[]>>;
}

/**
 * 把一份 transcript 读成判定。
 *
 * 作废时不抛 —— 见文件开头。全部记 `not_assessed`，并把原因带上。
 */
function assess(
  text: string,
  rubric: RubricVersion,
  elsewhere: ReadonlySet<string>,
): Assessment[] {
  const snapshot = (key: string) => {
    const criterion = rubric.criteria.find((entry) => entry.key === key)!;
    return { criterionText: criterion.text, blockingThen: criterion.blocking };
  };

  try {
    return readAssessments(text, rubric.criteria, elsewhere).map((read) => ({
      ...read, ...snapshot(read.criterionKey),
    }));
  } catch (error: unknown) {
    if (!(error instanceof RubricOutputVoidError)) throw error;
    return rubric.criteria.map((criterion) => ({
      criterionKey: criterion.key,
      verdict: "not_assessed" as const,
      evidence: `整份判定作废（${error.code}），本轮视为未评估`,
      criterionText: criterion.text,
      blockingThen: criterion.blocking,
    }));
  }
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

  /** 这一轮谁要背一份标准。由 `ASSESSED_BY` 反过来算，不另写一张表。 */
  const contractFor = (
    who: keyof RoundSettled["transcripts"],
  ): string | undefined => {
    for (const [role, rubric] of active) {
      const assessed = ASSESSED_BY[role];
      if (assessed?.by === who) return rubricContract(rubric.criteria, assessed.subject);
    }
    return undefined;
  };

  const settled = await runRound({
    ...request,
    addenda: {
      // 红方永远是 undefined —— 它是被判的那个，不背任何标准。
      blue: contractFor("blue"),
      judge: contractFor("judge"),
    },
  }, dependencies);

  const assessments: Record<RubricRole, readonly Assessment[]> = {
    producer: [], critic: [], verdict: [],
  };
  let gaps = settled.gaps;

  /**
   * 这一轮所有活着的 key。
   *
   * 「不属于你」和「不存在」要分开，就得先知道这一轮总共有哪些 key ——
   * 少了这份名单，一个答错对象的 key 和一个凭空编的 key 在解析器眼里一模一样。
   */
  const everyKey = new Set(
    [...active.values()].flatMap((rubric) => rubric.criteria.map((each) => each.key)),
  );

  /**
   * 一条线程收到过这份标准没有。
   *
   * **裁判那份返回 null（不适用）**：它的提示词是 StagePass 自己写的，送达不是一个
   * 会出问题的环节。只有子 Agent 那一侧要经裁判转达，也只有那一侧会丢。
   *
   * **读不到 rollout 也返回 null，不是 false。** 「查不出来」和「没送到」是两件事，
   * 把前者说成后者就是编了一句 StagePass 并不知道的话 —— 而这一整套改动的立身之本
   * 就是不许出现这种话。走到这里 `runRound` 已经成功读过这条线程了，所以真出错是
   * 很反常的情况，但反常不等于可以撒谎。
   */
  const deliveredTo = (
    assessor: Participant, keys: readonly string[],
  ): boolean | null => {
    if (assessor === "judge") return null;
    try {
      const whole = dependencies.readThreadWhole(settled.agents[assessor]);
      return keys.some((key) => whole.includes(key));
    } catch {
      return null;
    }
  };

  for (const [role, rubric] of active) {
    const assessor = ASSESSED_BY[role]!.by;
    const mine = rubric.criteria.map((each) => each.key);
    const elsewhere = new Set([...everyKey].filter((key) => !mine.includes(key)));

    const read = assess(settled.transcripts[assessor], rubric, elsewhere);
    assessments[role] = withReasons(read, {
      assessor,
      delivered: deliveredTo(assessor, mine),
      // 它答了别人那一份 —— Retro 实测：反方答的 4 条 key 全是裁判那份的。
      answeredAnother:
        answeredKeysIn(settled.transcripts[assessor], elsewhere).length > 0,
      // 这几条被别人代答了 —— Review 实测：裁判把反方那 4 条也答了。
      answeredElsewhere: answeredBy(settled.transcripts, assessor, new Set(mine)),
    });

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

  return { ...settled, gaps, blockers, assessments };
}
