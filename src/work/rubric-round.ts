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

/** 哪个角色的判定，读哪一份 transcript。 */
const TRANSCRIPT_OF: Readonly<Record<RubricRole, keyof RoundSettled["transcripts"]>> = {
  producer: "red",
  critic: "blue",
  verdict: "judge",
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
  for (const role of Object.keys(TRANSCRIPT_OF) as RubricRole[]) {
    const rubric = rubrics.effective(
      request.projectId, request.changeId, request.phase, role,
    );
    if (rubric && rubric.criteria.length > 0) active.set(role, rubric);
  }

  const settled = await runRound({
    ...request,
    addenda: {
      red: active.has("producer") ? rubricContract(active.get("producer")!.criteria) : undefined,
      blue: active.has("critic") ? rubricContract(active.get("critic")!.criteria) : undefined,
      judge: active.has("verdict") ? rubricContract(active.get("verdict")!.criteria) : undefined,
    },
  }, dependencies);

  const assessments: Record<RubricRole, readonly Assessment[]> = {
    producer: [], critic: [], verdict: [],
  };
  let gaps = settled.gaps;

  for (const [role, rubric] of active) {
    const read = assess(settled.transcripts[TRANSCRIPT_OF[role]], rubric);
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
