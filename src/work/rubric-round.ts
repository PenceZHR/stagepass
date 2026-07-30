import type { Assessment, RubricRole } from "../domain/rubric";
import { readAssessments, RubricOutputVoidError, rubricContract } from "../domain/rubric-protocol";
import { applyAssessments } from "../domain/rubric-gaps";
import type { RubricStore, RubricVersion } from "../store/rubric-store";
import { runRound, type RoundDependencies, type RoundRequest, type RoundSettled } from "./round-runner";

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

export interface RubricRoundRequest extends RoundRequest {
  /** rubric 有项目级默认，所以要知道这个 Change 属于哪个项目。 */
  readonly projectId: string;
}

export interface RubricRoundDependencies extends RoundDependencies {
  readonly rubrics: RubricStore;
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
function assess(text: string, rubric: RubricVersion): Assessment[] {
  const snapshot = (key: string) => {
    const criterion = rubric.criteria.find((entry) => entry.key === key)!;
    return { criterionText: criterion.text, blockingThen: criterion.blocking };
  };

  try {
    return readAssessments(text, rubric.criteria).map((read) => ({
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

  for (const [role, rubric] of active) {
    const read = assess(settled.transcripts[ASSESSED_BY[role]!.by], rubric);
    assessments[role] = read;

    rubrics.record(
      request.changeId, request.phase, role, request.round, rubric,
      read.map((entry) => ({
        criterionKey: entry.criterionKey,
        verdict: entry.verdict,
        evidence: entry.evidence,
      })),
    );

    gaps = applyAssessments(gaps, {
      round: request.round, role, assessments: read,
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
