import type { Phase } from "./phase";

/**
 * 「模型在会话里问人一句，等一个回答」这件事的形状。
 *
 * ## 为什么模型交上来的只有一个小整数和散文
 *
 * 用户 2026-08-02 立的规矩（`docs/DESIGN-no-hand-transcription-2026-08-02.md`，
 * `domain/worklist.ts` 开头逐字复述）：**凡是 StagePass 会拿去做精确匹配的字符串，
 * 都不许出现在模型必须生成的文本里。** 推论是模型的输出里只允许有两种东西 ——
 * 枚举里的选择，和散文。
 *
 * PRD §3.2 原本写的是 `stagepass_ask(rubricId, …)`，而 `rubricId` 正是 StagePass
 * 拿去做精确匹配的那种字符串（实测代价：同一个抄错的 UUID 连抄三轮，整份判定作废）。
 * 所以入参换成**判据单上的序号**：模型读的是一份文件，它看见的本来就是 `1. 2. 3.`，
 * 而 `ordinal → rubricId` 的映射留在 StagePass 这一侧（`web/ask-route.ts`）。
 *
 * 「不许问别的阶段」这条判据因此反而更硬：从「引用完整性」降级成 `1..count` 的
 * 范围检查，代码判得更死。
 *
 * ## 这个模块是纯的
 *
 * 没有库、没有时钟、没有 IO —— 它只认识 `Phase`。谁在问、问的是哪一轮，由上面那层
 * 填进来；这里只管「这一次提问长什么样、参数合不合规」。
 */

/** 一次提问的全部留档。**答案是后来补上去的**，所以后三格可空。 */
export interface Ask {
  /** `ASK-0007`，**StagePass 生成** —— 模型从来不写它。 */
  readonly id: string;
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  /**
   * 这一条问的是哪一份判据，**序号映射回来的**。判据单为空时是 null。
   *
   * 记的是**备那一轮那一刻**生效的版本（`HandedRound.rubricIds`）：人可能在这一轮
   * 跑着的时候改了标准，而这条提问挂的是他当时看的那一份。
   */
  readonly rubricId: string | null;
  readonly ordinal: number | null;
  readonly question: string;
  readonly why: string | null;
  readonly options: readonly string[];
  readonly askedAt: string;
  /** 人选了哪一条。**没答就是 null** —— 那不是错误，见 TechSpec §三。 */
  readonly chosen: string | null;
  readonly note: string | null;
  readonly answeredAt: string | null;
}

/** 模型这一次交上来的东西，校验完之后的样子。 */
export interface AskRequest {
  readonly ordinal: number | null;
  readonly question: string;
  readonly options: readonly string[];
  readonly why: string | null;
}

/**
 * 一次参数校验的结局。
 *
 * **不合规不抛异常，返回一个值** —— 和 `domain/worklist.ts` 的 `AnswerOutcome`
 * 同一个理由：抛出去会变成一句 MCP 层的错误文本，模型只知道「失败了」，不知道该
 * 怎么改。所以 `reason` 里必须有它能照着改的具体信息（允许范围、当前条数）。
 */
export type AskCheck =
  | { readonly ok: true; readonly requests: readonly AskRequest[] }
  | { readonly ok: false; readonly error: string; readonly reason: string };

/** 少于两条就不是选择题，人只能点「好」。 */
/**
 * 一次最多攒几个问题（用户 2026-08-19：「攒几个问一下…不是像现在这样一次问一个，
 * 这不符合我的效率逻辑」）。
 *
 * **5，因为字段名排序。** elicitation 的表单**按字段名排**（2026-08-04 实测），
 * 所以字段叫 `q1`…`q9` 才排得出你写的顺序 —— `q10` 会排到 `q1` 和 `q2` 中间。
 * 上限本可以是 9，取 5 是产品判断：再多就不是「攒几个」，是问卷。
 */
export const BATCH_MAX = 5;

export const OPTION_MIN = 2;
/**
 * 多于六条人挑不动 —— 而这套东西的判据是「要不要等一个人」，等的那个人得点得下去。
 * 真要有第七种可能，那是一道该拆开问的题。
 */
export const OPTION_MAX = 6;

/**
 * 模型交上来的这一次提问站不站得住。
 *
 * `raw` 收 `unknown`：它可能是已经解开的对象（域里直接调），也可能是原样的请求正文
 * （HTTP 那一层调）。**两种都从这儿走**，免得「解 JSON」这件事在两处各写一遍，
 * 而其中一处忘了说人话。
 *
 * `sheetCount` 是这一轮判据单的条数。**为 0 时 `ordinal` 只能留空** —— 判据单还没有
 * 的阶段照样问得成（TechSpec §九：P0b 独立可用），但不许指着一条不存在的判据。
 */
/**
 * 一次提问 —— **可以是一批**。
 *
 * 两种形状都收：`{ questions: [...] }` 是一批，单个对象是一条（等价于一批里只有
 * 一条）。收单个不是为了兼容旧调用，是因为**模型有时真的只有一个问题**，那时逼它
 * 包一层数组只是多一道能写错的手续。
 */
export function checkAsk(raw: unknown, sheetCount: number): AskCheck {
  const outer = readFields(raw);
  if (outer !== null && Array.isArray(outer["questions"])) {
    return checkBatch(outer["questions"] as unknown[], sheetCount);
  }
  return checkBatch([raw], sheetCount);
}

function checkBatch(items: readonly unknown[], sheetCount: number): AskCheck {
  if (items.length === 0 || items.length > BATCH_MAX) {
    return {
      ok: false,
      error: "bad_batch",
      reason: `一次问 1 到 ${BATCH_MAX} 条，现在是 ${items.length} 条。`
        + "攒太多人一屏看不完，答一半就会漏 —— 分两次问。",
    };
  }
  const requests: AskRequest[] = [];
  for (const [index, item] of items.entries()) {
    const one = checkOne(item, sheetCount);
    // 一条不合规就整批拒。**不许只送合规的那几条** —— 模型会以为整批都问出去了，
    // 然后站在那儿等一个永远不会来的答案。
    if (!one.ok) {
      return items.length === 1 ? one : {
        ok: false,
        error: one.error,
        reason: `第 ${index + 1} 条不合规，整批都没问出去：${one.reason}`,
      };
    }
    requests.push(one.request);
  }
  return { ok: true, requests };
}

function checkOne(raw: unknown, sheetCount: number): SingleCheck {
  const fields = readFields(raw);
  if (fields === null) {
    return {
      ok: false,
      error: "unreadable_request",
      /*
       * 这一条不在 TechSpec §三那张表里，因为那四条判的是**问题本身**，而这一条是
       * 「送过来的东西根本不成形」。混进 `empty_question` 会让模型去改问句 ——
       * 而问句可能写得好好的，坏的是外面那层壳。
       */
      reason: `送上来的东西读不成一次提问。要的是一个对象：`
        + `{ ordinal: 1..${Math.max(sheetCount, 1)} 或留空, question: "问句", `
        + `options: ["选项 A", "选项 B"], why?: "为什么要问" }。`,
    };
  }

  const question = typeof fields.question === "string" ? fields.question.trim() : "";
  if (question === "") {
    return {
      ok: false,
      error: "empty_question",
      reason: "question 要写一句真的在问人的话（散文），现在是空的。"
        + "把你要他替你定的那件事写清楚 —— 他看不到你这边的上下文。",
    };
  }

  const options = checkOptions(fields.options);
  if (!options.ok) return options;

  const ordinal = checkOrdinal(fields.ordinal, sheetCount);
  if (!ordinal.ok) return ordinal;

  const why = typeof fields.why === "string" && fields.why.trim() !== ""
    ? fields.why.trim()
    : null;

  return {
    ok: true,
    request: { ordinal: ordinal.ordinal, question, options: options.options, why },
  };
}

type SingleCheck =
  | { readonly ok: true; readonly request: AskRequest }
  | { readonly ok: false; readonly error: string; readonly reason: string };

/** 一次请求的字段。读不成对象就是 null —— 空对象和「不是对象」不是一回事。 */
function readFields(raw: unknown): Record<string, unknown> | null {
  // 字符串按 JSON 解一次：HTTP 那一层拿到的就是一串原文，让它自己解会多出一处
  // 「解不开的时候说什么」，而那句话必须和这里说的是同一句。
  if (typeof raw === "string") {
    try {
      return readFields(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

type OptionsCheck =
  | { readonly ok: true; readonly options: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly reason: string };

function checkOptions(raw: unknown): OptionsCheck {
  const range = `${OPTION_MIN}..${OPTION_MAX} 条`;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "bad_options",
      reason: `options 要是一个数组，${range}，每条是一句散文。现在给的不是数组。`,
    };
  }
  // **条数先判**：`["A"]` 的毛病是「不是选择题」，不是「第二条写错了」。
  if (raw.length < OPTION_MIN || raw.length > OPTION_MAX) {
    return {
      ok: false,
      error: "bad_options",
      reason: `options 要 ${range}，现在是 ${raw.length} 条。`
        + `少于 ${OPTION_MIN} 条就不是选择题（人只能点「好」），`
        + `多于 ${OPTION_MAX} 条他挑不动 —— 那是该拆开问的两道题。`,
    };
  }
  const options = raw.map((each) => (typeof each === "string" ? each.trim() : ""));
  if (options.some((each) => each === "")) {
    return {
      ok: false,
      error: "bad_options",
      reason: `options 里有空的一条（第 ${options.indexOf("") + 1} 条）。`
        + "每一条都要写清楚选它意味着什么 —— 一个空格子人点不下去。",
    };
  }
  if (new Set(options).size !== options.length) {
    return {
      ok: false,
      error: "bad_options",
      // 重复的选项让「他选了哪个」问不出答案：两条字面一样，落档时分不出是哪一条。
      reason: `options 里有两条一模一样的。${range}，而且每条要不一样 ——`
        + "重的那两条人选了也说明不了什么。",
    };
  }
  return { ok: true, options };
}

type OrdinalCheck =
  | { readonly ok: true; readonly ordinal: number | null }
  | { readonly ok: false; readonly error: string; readonly reason: string };

function checkOrdinal(raw: unknown, sheetCount: number): OrdinalCheck {
  // 没给和给 null 一样：MCP 那一侧的可选参数缺席时就是 undefined。
  if (raw === null || raw === undefined) {
    return { ok: true, ordinal: null };
  }
  const outOfRange = (why: string): OrdinalCheck => ({
    ok: false,
    error: "ordinal_out_of_range",
    /*
     * **把范围原样回给它**，而不是一句「越界了」—— 后者模型没法据以改正。
     * 范式来自 `domain/worklist.ts` 的 `bad_answer`：答错不抛异常，把允许值原样回去。
     */
    reason: sheetCount === 0
      ? `这一轮的判据单是空的（0 条），ordinal 只能留空。${why}`
      + "要问的话就直接问，不必挂在某一条判据上。"
      : `ordinal 要落在 1..${sheetCount} 之间（这一轮的判据单一共 ${sheetCount} 条）。`
      + why,
  });
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return outOfRange(`现在给的是 ${JSON.stringify(raw)}，它不是一个整数序号。`);
  }
  if (sheetCount === 0 || raw < 1 || raw > sheetCount) {
    return outOfRange(`现在给的是 ${raw}。`);
  }
  return { ok: true, ordinal: raw };
}
