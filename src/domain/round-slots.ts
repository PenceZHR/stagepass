import { isPhase, type Phase } from "./phase";

/**
 * 一轮的格子文件。
 *
 * StagePass 把整份结构铺好，模型只把 `null` 换成值 —— 结构由谁决定，是这件事唯一的
 * 判据（格式是不是 JSON 无关）。`id` 也由这一侧写死，模型连 id 都不用打，
 * 手抄那条顺带焊死。
 *
 * 读回来时任何一条对不上就整份拒绝，并把原因原样留给下一轮。不修复、不猜、不截断
 * —— 截断会让「它到底想说几条」永远查不清，猜出来的 severity 则会变成账本上的假事实。
 */

/** 铺出去的格子数。多出来的是余量，不是配额。 */
export const SLOT_COUNT = 15;
/** 一轮最多填几条。超过就是这一轮违约。 */
export const SLOT_FILL_LIMIT = 10;

const SEVERITIES = ["P0", "P1", "P2"] as const;
const SLOT_KEYS = ["id", "severity", "title", "where", "why", "owner"] as const;

export type SlotSeverity = (typeof SEVERITIES)[number];

export interface SlotHeader {
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  /**
   * 这一轮它产出的东西 —— **由 StagePass 预填，模型一个字都不用写**。
   *
   * 旧契约要模型自己交 `artifactIds`。2026-08-06 真机：反方按新契约答出来的东西里
   * 没有那一格，于是**每一轮都整轮作废**。而这些路径 StagePass 本来就知道
   * （`<Phase>-r<N>.md` / `-opposition.md`），根本不该问模型要。
   */
  readonly artifacts: readonly string[];
  /** 这一阶段要不要模型给一句总评。不要的阶段这一格根本不出现。 */
  readonly wantsOverall?: boolean;
}

export interface FilledSlot {
  readonly id: string;
  readonly severity: SlotSeverity;
  readonly title: string;
  readonly where: string | null;
  readonly why: string | null;
  readonly owner: string | null;
}

export type SlotDocumentResult =
  | {
    readonly ok: true;
    readonly filled: readonly FilledSlot[];
    readonly artifacts: readonly string[];
    readonly overall: string | null;
  }
  | { readonly ok: false; readonly reason: string };

const slotId = (index: number): string => `G-${index + 1}`;

export function createSlotDocument(header: SlotHeader): string {
  return `${JSON.stringify({
    stagepass: {
      change: header.changeId,
      phase: header.phase,
      round: header.round,
      maxFilled: SLOT_FILL_LIMIT,
    },
    artifacts: [...header.artifacts],
    ...(header.wantsOverall === true ? { overall: null } : {}),
    slots: Array.from({ length: SLOT_COUNT }, (_, index) => ({
      id: slotId(index),
      severity: null,
      title: null,
      where: null,
      why: null,
      owner: null,
    })),
  }, null, 2)}\n`;
}

/**
 * 交给模型的那段话。
 *
 * ## 为什么这一段可以短，而旧的 `RESULT_CONTRACT` 不许
 *
 * 旧契约必须把骨架原样印在提示词里，理由是「缺了会怎样」：
 *
 *   需求没被读到    → 模型少了信息，它会大声说读不到（可以赌）
 *   **骨架没被读到** → 它答出来的形状不对，**整轮无法解析、直接作废**（不能赌）
 *
 * 格子文件把这条反转了：骨架现在在**文件里**，由 StagePass 写好。模型读不到文件，
 * 落回第一种 —— 它会说读不到，而不是交出一个解析不了的形状。所以这里只需要说清
 * 规矩，不需要复述形状。
 */
export function slotContract(path: string): string {
  return [
    `这一轮的产出格子已经铺好在：${path}`,
    "打开它，**只填值**：",
    "- 每个格子的 `id` 已经写死，不要改；",
    "- `artifacts` 是 StagePass 填好的，不要动；",
    "- `severity` 只能是 P0 / P1 / P2；",
    "- 一个格子要么填完整（至少 `severity` 和 `title`），要么原样留空 —— 半条不算数；",
    `- 这一轮最多填 ${SLOT_FILL_LIMIT} 个格子。文件里给了 ${SLOT_COUNT} 个是余量，不是配额；`,
    "- 不要新建文件、不要增删字段、不要改动结构。",
    "填完保存，然后结束这一轮；不用把内容再复述一遍。",
    "没有要报的问题，就一个字都不填 —— 那是合法的。",
  ].join("\n");
}

const refuse = (reason: string): SlotDocumentResult => ({ ok: false, reason });

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

export function readSlotDocument(
  source: string | null,
  header: SlotHeader,
): SlotDocumentResult {
  if (source === null) {
    return refuse("这一轮没有格子文件；StagePass 铺好的那一份不见了，本轮作废。");
  }
  if (!isPhase(header.phase)) return refuse(`未知阶段 ${header.phase}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    // 原话留给下一轮 —— 写坏和写到一半在这里是同一种失败。
    return refuse(`格子文件不是合法 JSON：${
      error instanceof Error ? error.message : String(error)
    }`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("格子文件的顶层不是一个对象。");
  }

  const document = parsed as Record<string, unknown>;
  const expectedHead = JSON.stringify({
    change: header.changeId,
    phase: header.phase,
    round: header.round,
    maxFilled: SLOT_FILL_LIMIT,
  });
  if (JSON.stringify(document.stagepass) !== expectedHead) {
    return refuse(
      `抬头被改过，或这一份属于别的轮次/座位：期待 ${expectedHead}，`
      + `实际 ${JSON.stringify(document.stagepass)}。`,
    );
  }

  // 产出路径是 StagePass 自己填的，模型碰它就是越界。
  const expectedArtifacts = JSON.stringify([...header.artifacts]);
  if (JSON.stringify(document.artifacts) !== expectedArtifacts) {
    return refuse(
      `artifacts 是 StagePass 填好的，不该被改：期待 ${expectedArtifacts}，`
      + `实际 ${JSON.stringify(document.artifacts)}。`,
    );
  }

  const wantsOverall = header.wantsOverall === true;
  if (wantsOverall !== ("overall" in document)) {
    return refuse(wantsOverall
      ? "这一阶段要一句总评，但文件里没有 overall 这一格。"
      : "这一阶段不要总评，文件里不该出现 overall 这一格。");
  }
  let overall: string | null = null;
  if (wantsOverall) {
    if (document.overall !== null && typeof document.overall !== "string") {
      return refuse(`overall 只能是一句话或留空，实际 ${JSON.stringify(document.overall)}。`);
    }
    overall = text(document.overall);
  }

  const slots = document.slots;
  if (!Array.isArray(slots) || slots.length !== SLOT_COUNT) {
    return refuse(`格子数必须是 ${SLOT_COUNT} 个，实际 ${
      Array.isArray(slots) ? slots.length : "不是数组"
    }。`);
  }

  const filled: FilledSlot[] = [];
  for (const [index, raw] of slots.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return refuse(`第 ${index + 1} 个格子不是一个对象。`);
    }
    const slot = raw as Record<string, unknown>;
    const keys = Object.keys(slot).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...SLOT_KEYS].sort())) {
      return refuse(
        `${slotId(index)} 的字段被改过：只能填值，不能增删字段（实际 ${keys.join(", ")}）。`,
      );
    }
    if (slot.id !== slotId(index)) {
      return refuse(`第 ${index + 1} 个格子的 id 应该是 ${slotId(index)}，实际 ${
        JSON.stringify(slot.id)
      }；id 由 StagePass 写死，不该被改。`);
    }

    const severity = text(slot.severity);
    const title = text(slot.title);
    const where = text(slot.where);
    const why = text(slot.why);
    const owner = text(slot.owner);
    if (severity === null && title === null && where === null && why === null && owner === null) {
      continue;
    }
    if (title === null) {
      return refuse(`${slotId(index)} 填了一半：有内容但没有 title。半条比没有更糟，本轮作废。`);
    }
    if (severity === null || !(SEVERITIES as readonly string[]).includes(severity)) {
      return refuse(
        `${slotId(index)} 的 severity 必须是 ${SEVERITIES.join(" / ")} 之一，`
        + `实际 ${JSON.stringify(slot.severity)}。`,
      );
    }
    filled.push({ id: slotId(index), severity: severity as SlotSeverity, title, where, why, owner });
  }

  if (filled.length > SLOT_FILL_LIMIT) {
    return refuse(
      `这一轮填了 ${filled.length} 条，超过上限 ${SLOT_FILL_LIMIT} 条。`
      + "本轮作废 —— 不截断，否则「它到底想说几条」查不清。",
    );
  }
  return { ok: true, filled, artifacts: [...header.artifacts], overall };
}
