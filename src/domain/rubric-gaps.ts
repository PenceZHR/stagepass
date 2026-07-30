import type { Gap } from "./gap";
import type { Assessment, RubricRole } from "./rubric";

/**
 * rubric 的判定怎么变成挡门的东西，以及怎么不再挡。
 *
 * ## 走的是 `gaps`，不新建平行机制
 *
 * 老树有三套并行的阻断机制（requirement gap / review finding / stage gate），
 * 每一套的出口都不一样，叠在一起造出了三个**没有出口的死锁**。新树只有 `gaps`
 * 一条通道，rubric 也走它 —— 只是以 `standard` 的身份进来，没有严重度。
 *
 * ## 派生方向不对称，这是整套的根
 *
 *   开启 —— 读**判定当时**的快照（`blockingThen` / `criterionText`）
 *   退休 —— 读**当前**的 rubric
 *
 * 所以：改一次 rubric 的措辞，动不了任何已经开出去的东西（标题是快照，gap id 绑在
 * `criterion_key` 上）；而撤下一条标准，会让它派生的阻断项跟着退休。
 * **一次编辑只能关，不能开** —— 没有任何编辑能让一个已盖章的 change 重新被挡。
 *
 * ## 退休需要正面证据，缺席永远不算
 *
 * 只有两件事能让一条 standard 不再挡：后续某轮答了 `yes`，或者那条标准被撤下。
 * **某一轮没提它，绝不退休** —— 一轮在 rubric 跑之前就死掉，不是「标准已满足」的
 * 证据。这和 `domain/gap.ts` 里「沉默保持 open」是同一条规则的两面。
 *
 * ## 这个模块是纯的
 */

/**
 * 一条 rubric 派生阻断项的 id。
 *
 * **绑在 `criterion_key` 上，不是版本内的行 id。** `gate.snapshotOf` 哈希 blocker
 * 的 id：若 id 随每次编辑而变，改一个错别字就会移动 snapshot，让每一个 open
 * question 的 fence 当场作废 —— 人正在回答的问题被拒绝。
 *
 * role 也在里面：正方、反方、裁判各有各的标准，同一条 key 在两个角色下是两件事。
 */
export const standardGapId = (role: RubricRole, criterionKey: string): string =>
  `RB:${role}:${criterionKey}`;

export interface AssessedRound {
  readonly round: number;
  readonly role: RubricRole;
  readonly assessments: readonly Assessment[];
}

/**
 * 一轮判定之后的 gaps。
 *
 * 只碰这一轮**明确提到**的那些 standard；没提到的原样留下，`finding` 一律不碰。
 *
 * | 判定当时是否阻断 | verdict | 结果 |
 * |---|---|---|
 * | 是 | `no` | 开 / 保持开 |
 * | 是 | `not_assessed` | 开 / 保持开 —— **标了阻断的漏答视同阻断** |
 * | 是 | `yes` | 关，写明是哪一轮答的 |
 * | 否 | 任何 | 关 —— 判定当时它已不是阻断项，那是「标准被撤下」的正面证据 |
 */
export function applyAssessments(
  before: readonly Gap[],
  input: AssessedRound,
): Gap[] {
  const byId = new Map(before.map((gap) => [gap.id, gap]));

  for (const assessment of input.assessments) {
    const id = standardGapId(input.role, assessment.criterionKey);
    const existing = byId.get(id);

    // 判定当时它就不阻断 —— 这一轮亲眼看到标准已经撤下了，可以退休。
    // 注意这不是「缺席」：它有一条判定，判定里写着当时不阻断。
    if (!assessment.blockingThen) {
      if (existing?.status === "open") {
        byId.set(id, {
          ...existing,
          status: "closed",
          resolution: `第 ${input.round} 轮判定时，这条标准已不再标为阻断`,
        });
      }
      continue;
    }

    if (assessment.verdict === "yes") {
      if (existing?.status === "open") {
        byId.set(id, {
          ...existing,
          status: "closed",
          resolution: `第 ${input.round} 轮判定满足`
            + (assessment.evidence ? `：${assessment.evidence}` : ""),
        });
      }
      continue;
    }

    // no 或 not_assessed，且当时标着阻断 —— 挡住。
    if (existing?.status === "open") continue; // 已经开着，什么都不用改
    byId.set(id, {
      id,
      kind: "standard",
      // 二元判断没有严重度。schema 的配对 CHECK 也不让它有。
      severity: null,
      // 人对一条标准说的话没有容器 —— 它的出口是撤下那条 criterion，不是留言。
      note: null,
      // 快照，永不回溯派生 —— 标题若跟着当前 rubric 变，snapshot 就会动。
      title: assessment.criterionText,
      status: "open",
      openedRound: input.round,
      resolution: null,
    });
  }

  return [...byId.values()];
}

/**
 * 撤下标准时，退休它派生的阻断项。
 *
 * `retiredKeys` 来自 `retiredBy(上一版, 新版)` —— 也就是这次编辑里 `blocking` 从真
 * 变假、或整条消失的那些。`reason` 是人写的话，PRD §1.1 要求它非空才允许这次编辑，
 * 所以这里直接把它带进 resolution：**关掉一个问题必须说明理由**，rubric 这条路也
 * 不例外。
 */
export function retireStandards(
  before: readonly Gap[],
  role: RubricRole,
  retiredKeys: readonly string[],
  reason: string,
): Gap[] {
  const retiring = new Set(retiredKeys.map((key) => standardGapId(role, key)));
  return before.map((gap) =>
    retiring.has(gap.id) && gap.status === "open"
      ? { ...gap, status: "closed" as const, resolution: `标准已撤下：${reason}` }
      : gap);
}
