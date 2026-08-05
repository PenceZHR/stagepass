import { DEFAULT_GRAPH } from "./phase";
import { roundFromLedger } from "./round";

/**
 * 跳转表 = 事件流的投影（BACKLOG §4.3 / §5.9.2）。
 *
 * ## 为什么不另建表
 *
 * `change_events` 就是那条事件流：append-only（触发器强制）、seq 稠密单调。
 * 「从哪 · 去哪 · 什么理由 · 哪一轮」每一样都算得出来 —— 再建一张跳转表，就是
 * 同一份事实的第二份拷贝，迟早说出两个不同的历史。
 *
 * ## 模型和 UI 是同一件事，做一次
 *
 * G 档（环从「路径」变「地图」，§5.9.3）画历史箭头读的必须是这一份投影。
 * 别在前端从 phases 再拼一遍 —— 那就是 §5.9.2 警告的「两份不一样的结构」。
 *
 * ## This module is pure
 */

/** 输入的形状 = `ChangeStore.ledger` 的一行。结构对上就行，域层不 import 库层。 */
export interface JourneyEntry {
  readonly seq: number;
  readonly action: string;
  readonly from: { readonly phase: string; readonly status: string } | null;
  readonly to: { readonly phase: string; readonly status: string };
  readonly reason: string | null;
  readonly at: string;
}

/**
 * 一跳的方向，环上两种画法靠它分（§5.9.3·④：沿环走 = 推进，弦 = 回头）。
 *
 * `self` 是频率最高的那条边（每阶段 3~4 轮），在这之前完全隐形（§5.9.4）。
 */
export type JumpKind = "forward" | "backward" | "self";

export interface Jump {
  readonly seq: number;
  readonly action: string;
  readonly fromPhase: string;
  readonly toPhase: string;
  readonly kind: JumpKind;
  /** 人的话（打回的理由等）。null = 这一步没带理由。 */
  readonly reason: string | null;
  /** 跳的那一刻，出发的阶段已经跑到第几轮 —— 和派发、题面同一个算法。 */
  readonly round: number;
  readonly at: string;
}

/**
 * 只留**人推动**的那几步：approve / reject / sendBack。
 *
 * - `start`/`settle`/`fail`/`retry` 是系统在陈述一轮的生命周期，不是一跳 ——
 *   画出来的该是「人把它送去了哪」，不是「它跑了没跑」。
 * - **自环也算**（同阶段的 reject：再来一轮）—— §5.9.3 点名它别被忘了。
 * - `create` 不算：出生不是移动。
 */
const HUMAN_MOVES: ReadonlySet<string> = new Set(["approve", "reject", "sendBack"]);

const ORDER_INDEX: ReadonlyMap<string, number> =
  new Map(DEFAULT_GRAPH.order.map((phase, index) => [phase, index]));

/**
 * 方向：全序的下标说了算（子序列图保持相对顺序，所以不用知道图）。
 * Fix 不在全序上，按语义判：**进 Fix 是回头（送修），出 Fix 是向前（修完回去）**。
 */
function kindOf(fromPhase: string, toPhase: string): JumpKind {
  if (fromPhase === toPhase) return "self";
  if (toPhase === "Fix") return "backward";
  if (fromPhase === "Fix") return "forward";
  const from = ORDER_INDEX.get(fromPhase);
  const to = ORDER_INDEX.get(toPhase);
  if (from === undefined || to === undefined) return "backward"; // 认不出，往保守判
  return to > from ? "forward" : "backward";
}

export function jumpsFrom(entries: readonly JourneyEntry[]): Jump[] {
  const jumps: Jump[] = [];
  entries.forEach((entry, index) => {
    if (entry.from === null || !HUMAN_MOVES.has(entry.action)) return;
    jumps.push({
      seq: entry.seq,
      action: entry.action,
      fromPhase: entry.from.phase,
      toPhase: entry.to.phase,
      kind: kindOf(entry.from.phase, entry.to.phase),
      reason: entry.reason,
      // 到这一步为止（含它自己之前的），出发阶段落进 running 的次数。
      round: roundFromLedger(entries.slice(0, index + 1), entry.from.phase),
      at: entry.at,
    });
  });
  return jumps;
}
