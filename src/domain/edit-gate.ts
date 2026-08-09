import type { Gap } from "./gap";

/**
 * 编辑过门（批 6）：**要人深度介入的阶段，产物没过人的手就不许批准。**
 *
 * ## 为什么 Arch 要这道门
 *
 * 环 v3 里 Arch 是钻石的分叉点：BuildPlan 和 TestPlan 两条轨都只从它推导。
 * 分叉点就是共模点 —— Arch 的错误会被两轨**一致地**继承，测试和代码在同一个
 * 错误上握手，QA 的对撞抓不住它。全部独立性机械保护的都是 Arch 之下的东西；
 * 对 Arch 本身，人的判断是唯一的防线。所以机械形式复用 brief 那条规矩：
 * **模型起草，人改，未经编辑不算**（用户 2026-08-06 拍的分工，批 6 搬到 Arch）。
 *
 * ## 机械形式：一条 P1 gap，不是一种新状态
 *
 * 轮末开一条固定 id 的 gap —— 它天然挡住批准（`blocking_problem_outstanding`），
 * 闸门、裁决表、fence 全部照旧，一行都不用另写。人的编辑被检测到（产物文件上有
 * 未提交的改动，`/api/ask` 进门时查）就机械关闭；人也可以在裁决表上驳回或
 * waive 它 —— 「这版我不改也认」是他有权说的话，只是要落在记录上（P1 的既有
 * 语义，阻断归人管）。
 *
 * ## 模型看不见这一条
 *
 * 它是人和机器之间的门，不是对抗的一部分：红方修不了它，裁判也判不了
 * 「人编辑没编辑」—— 送进轮里只会引来一个没有依据的表态把门顺手关掉。
 * `runRound` 按 `isEditGateGap` 把它从任务书和裁判名单里滤掉。
 *
 * ## 这个模块是纯的
 *
 * 只有数据变换。开与关的时机归调用方（runner 轮末开、panel 检测到编辑关），
 * 落盘走 `GapStore.replace` —— 那条路要求规则先是离线可证的纯函数，这就是它。
 */

export const EDIT_GATE_ID = "EDIT-1";

const EDIT_GATE_TITLE =
  "这份产出还没过你的手 —— 编辑产出文件（未提交的改动即算）再来批准；"
  + "这一版确实不用改的话，驳回或 waive 这一条，说明原因";

export const isEditGateGap = (gap: { readonly id: string }): boolean =>
  gap.id === EDIT_GATE_ID;

/**
 * 轮末：确保这道门开着。
 *
 * 每一轮红方都会重写产出 —— 上一版上人留的手迹随之作废，所以**每轮都重开**：
 * 已关的翻回 open（openedRound 记这一轮），没有的补一条。已经开着就原样不动
 * （别把 openedRound 往后挪 —— 那会把「第几轮开的」这句话变成假话）。
 */
export function withEditGate(gaps: readonly Gap[], round: number): Gap[] {
  const existing = gaps.find(isEditGateGap);
  if (existing?.status === "open") return [...gaps];
  const gate: Gap = {
    id: EDIT_GATE_ID,
    kind: "finding",
    severity: "P1",
    title: EDIT_GATE_TITLE,
    status: "open",
    openedRound: round,
    resolution: null,
    note: null,
    closedBy: null,
    where: null,
    why: null,
  };
  return existing === undefined
    ? [...gaps, gate]
    : gaps.map((gap) => (isEditGateGap(gap) ? gate : gap));
}

/**
 * 检测到人的编辑：关门。`evidence` 写的是**看到了什么**（哪几个文件有未提交的
 * 改动）—— 一次没有依据的关闭和「这一轮忘了开」在库里长得一模一样。
 * 门本来就不在（或已关）就原样返回 —— 幂等，重复检测不写第二遍。
 */
export function editGateClosed(gaps: readonly Gap[], evidence: string): Gap[] {
  const existing = gaps.find(isEditGateGap);
  if (existing === undefined || existing.status !== "open") return [...gaps];
  return gaps.map((gap) => (isEditGateGap(gap)
    ? {
      ...gap,
      status: "closed" as const,
      resolution: `human_edited: ${evidence}`,
      closedBy: "human" as const,
    }
    : gap));
}
