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

export type SlotSeverity = (typeof SEVERITIES)[number];

/**
 * 一种格子长什么样。
 *
 * 轮次契约（红蓝交问题）和问人（模型起草问题给人答）要的字段不一样，但**保证是同一套**：
 * 结构预铺、id 预填、上限 10、余量 15、任何一条对不上就整份拒绝。所以形状是声明出来的，
 * 不是各写一份解析器 —— 两份解析器迟早只有一份是对的。
 */
export interface SlotShape {
  /** 格子里允许出现的全部键（含预填的 `id`）。多一个少一个都算改结构。 */
  readonly keys: readonly string[];
  /** 这个格子只要被动过，这些键就必须有值。缺一个 = 半条，整份拒绝。 */
  readonly required: readonly string[];
  /** 取值被钉死的键。 */
  readonly enums?: Readonly<Record<string, readonly string[]>>;
}

/** 红蓝两方报问题用的形状。 */
export const BLOCKER_SHAPE: SlotShape = {
  keys: ["id", "severity", "title", "where", "why", "owner"],
  required: ["severity", "title"],
  enums: { severity: SEVERITIES },
};

/**
 * 模型起草问题给人答用的形状。
 *
 * **可选项不在这里** —— 它们是 StagePass 的，每道题都一样（同意 / 不同意 /
 * 先接受风险 / 我自己说），预填在文件的 `options` 那一节。模型只写问句和理由，
 * 连选项都不用编，于是「选项被编歪」这一类不稳定根本不存在。
 */
export const QUESTION_SHAPE: SlotShape = {
  keys: ["id", "question", "why"],
  required: ["question"],
};

export type SlotRole = "red" | "blue";

export interface SlotHeader {
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  /** 哪一方的那一份。没有它，红蓝两份文件可以互换而判不出来。 */
  readonly role: SlotRole;
  /** 这一份铺的是哪种格子。 */
  readonly shape: SlotShape;
  /**
   * 这一轮它产出的东西 —— **由 StagePass 预填，模型一个字都不用写**。
   *
   * 旧契约要模型自己交 `artifactIds`。2026-08-06 真机：反方按新契约答出来的东西里
   * 没有那一格，于是**每一轮都整轮作废**。而这些路径 StagePass 本来就知道
   * （`<Phase>-r<N>.md` / `-opposition.md`），根本不该问模型要。
   */
  readonly artifacts: readonly string[];
  /**
   * 每道题的可选项 —— **StagePass 的，不是模型的**，每道题都一样。
   *
   * 措辞归 `domain/question.ts`（`RESPONSE_AGREE` 那一组），这里只当数据收下：
   * 这一层不该有第二套措辞，两套措辞迟早只有一套是对的。
   * 问句表必须给，别的形状不许给。
   */
  readonly options?: readonly string[];
  /** 这一阶段要不要模型给一句总评。不要的阶段这一格根本不出现。 */
  readonly wantsOverall?: boolean;
}

/** 一个被填过的格子。键集合由形状决定，`id` 一定在。 */
export type FilledSlot = Readonly<Record<string, string | null>> & { readonly id: string };

export type SlotDocumentResult =
  | {
    readonly ok: true;
    readonly filled: readonly FilledSlot[];
    readonly artifacts: readonly string[];
    readonly overall: string | null;
  }
  | { readonly ok: false; readonly reason: string };

/**
 * 格子的 id。**带角色、补零**：红方 `R-01` … `R-15`，反方 `B-01` … `B-15`。
 *
 * 角色前缀不是装饰：一轮里红蓝两份文件会被并到同一份发现名单上，而名单是按 id
 * 去重的。两边都叫 `G-01` 的话，后来的那条会被当成重复直接吃掉 —— 实测里
 * 红方那条就这么没了。
 *
 * 不补零的话字典序是 `G-1, G-10, G-11, …, G-2` —— 而问句表要经过
 * `domain/question.ts` 的 `compose`，那里有一条 `order_not_sorted` 守卫
 * （2026-07-30 实测出来的客户端行为：表单按字段名排序）。补零之后字典序和
 * 数字序一致，文件本身读起来也不会 G-10 排在 G-2 前面。
 */
const slotId = (role: SlotRole, index: number): string =>
  `${role === "red" ? "R" : "B"}-${String(index + 1).padStart(2, "0")}`;

const headOf = (header: SlotHeader): Readonly<Record<string, unknown>> => ({
  change: header.changeId,
  phase: header.phase,
  round: header.round,
  role: header.role,
  maxFilled: SLOT_FILL_LIMIT,
});

export function createSlotDocument(header: SlotHeader): string {
  return `${JSON.stringify({
    stagepass: headOf(header),
    artifacts: [...header.artifacts],
    ...(header.options === undefined ? {} : { options: [...header.options] }),
    ...(header.wantsOverall === true ? { overall: null } : {}),
    slots: Array.from({ length: SLOT_COUNT }, (_, index) =>
      Object.fromEntries(header.shape.keys.map((key) =>
        [key, key === "id" ? slotId(header.role, index) : null]))),
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
export function slotContract(path: string, shape: SlotShape): string {
  const enums = Object.entries(shape.enums ?? {})
    .map(([key, allowed]) => `- \`${key}\` 只能是 ${allowed.join(" / ")}；`);
  return [
    `这一轮的产出格子已经铺好在：${path}`,
    "打开它，**只填值**：",
    "- 每个格子的 `id` 已经写死，不要改；",
    "- `artifacts` 是 StagePass 填好的，不要动；",
    ...enums,
    `- 一个格子要么填完整（至少 ${
      shape.required.map((key) => `\`${key}\``).join(" 和 ")
    }），要么原样留空 —— 半条不算数；`,
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
  const expectedHead = JSON.stringify(headOf(header));
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

  const wantsOptions = header.options !== undefined;
  const expectedOptions = wantsOptions ? JSON.stringify([...header.options!]) : undefined;
  if (wantsOptions && JSON.stringify(document.options) !== expectedOptions) {
    return refuse(
      `options 是 StagePass 定的，每道题都一样，不该被改：期待 ${expectedOptions}，`
      + `实际 ${JSON.stringify(document.options)}。`,
    );
  }
  if (!wantsOptions && "options" in document) {
    return refuse("这一份不是问句表，不该出现 options 这一格。");
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
    if (JSON.stringify(keys) !== JSON.stringify([...header.shape.keys].sort())) {
      return refuse(
        `${slotId(header.role, index)} 的字段被改过：只能填值，不能增删字段（实际 ${keys.join(", ")}）。`,
      );
    }
    if (slot.id !== slotId(header.role, index)) {
      return refuse(`第 ${index + 1} 个格子的 id 应该是 ${slotId(header.role, index)}，实际 ${
        JSON.stringify(slot.id)
      }；id 由 StagePass 写死，不该被改。`);
    }

    const values = new Map<string, string | null>();
    for (const key of header.shape.keys) {
      if (key === "id") continue;
      values.set(key, text(slot[key]));
    }
    if ([...values.values()].every((value) => value === null)) continue;

    const missing = header.shape.required.filter((key) => values.get(key) == null);
    if (missing.length > 0) {
      return refuse(
        `${slotId(header.role, index)} 填了一半：有内容但没有 ${missing.join(" 和 ")}。`
        + "半条比没有更糟，本轮作废。",
      );
    }
    for (const [key, allowed] of Object.entries(header.shape.enums ?? {})) {
      const value = values.get(key) ?? null;
      if (value !== null && !allowed.includes(value)) {
        return refuse(
          `${slotId(header.role, index)} 的 ${key} 必须是 ${allowed.join(" / ")} 之一，`
          + `实际 ${JSON.stringify(slot[key])}。`,
        );
      }
    }
    filled.push({ id: slotId(header.role, index), ...Object.fromEntries(values) } as FilledSlot);
  }

  if (filled.length > SLOT_FILL_LIMIT) {
    return refuse(
      `这一轮填了 ${filled.length} 条，超过上限 ${SLOT_FILL_LIMIT} 条。`
      + "本轮作废 —— 不截断，否则「它到底想说几条」查不清。",
    );
  }
  return { ok: true, filled, artifacts: [...header.artifacts], overall };
}
