import { createHash } from "node:crypto";

import { BLOCKER_SEVERITIES, type BlockerSeverity, type Finding } from "./gate";
import type { Phase } from "./phase";

/**
 * What StagePass asks Codex to do, and what it will accept back.
 *
 * ## The shape of the answer is StagePass's decision, not the model's
 *
 * A turn does not return prose for StagePass to interpret. It returns one
 * fixed structure -- artifacts produced, problems found -- because the gate
 * reads those fields and a gate that has to infer them from a summary is a gate
 * that can be talked past. The judgement is "who decides the structure", not
 * "is the format JSON": a model free to choose the fields is a model free to
 * omit the one that would have blocked it.
 *
 * ## An unparsable answer is a failed turn, loudly
 *
 * Not an empty result. A turn that came back in the wrong shape produced
 * nothing the system can act on, and saying so by name (`turn_result_unparsable`)
 * is the difference between a bug found in a minute and a phase that silently
 * settles with no artifacts and no explanation.
 *
 * ## This module is pure
 */

export interface TurnRequest {
  readonly changeId: string;
  readonly phase: Phase;
  /** What the turn is for. Never blank -- see `assertRequestValid`. */
  readonly prompt: string;
}

export interface TurnResult {
  readonly artifactIds: readonly string[];
  readonly blockers: readonly Finding[];
}

export class InvalidTurnRequestError extends Error {
  constructor(readonly code: "prompt_missing") {
    super(code);
    this.name = "InvalidTurnRequestError";
  }
}

export class TurnResultUnparsableError extends Error {
  constructor(
    readonly code:
      | "turn_result_no_json"
      | "turn_result_not_an_object"
      | "turn_result_artifacts_invalid"
      | "turn_result_blockers_invalid",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TurnResultUnparsableError";
  }
}

/**
 * A request with no prompt is a request the far end cannot act on.
 *
 * The old tree allowed one: its presentation turns carried the text under a
 * field name the reader did not read, so every such turn failed the moment it
 * was picked up -- and nothing noticed for as long as nothing reached that
 * path. Checked here, before anything is written down.
 */
export function assertRequestValid(request: TurnRequest): void {
  if (request.prompt.trim() === "") {
    throw new InvalidTurnRequestError("prompt_missing");
  }
}

/**
 * A turn's identity. Two requests that ask for the same thing hash the same,
 * which is what lets a dispatch be retried without producing a second turn.
 */
export function requestHash(request: TurnRequest): string {
  assertRequestValid(request);
  return createHash("sha256").update(JSON.stringify({
    changeId: request.changeId,
    phase: request.phase,
    prompt: request.prompt,
  })).digest("hex");
}

/** The exact shape a turn must answer in. Sent to the model verbatim. */
/**
 * 答案的**形状**。永远原样印在提示词里，两遍（红蓝各一份）。
 *
 * ## 为什么这一半不许走文件
 *
 * 2026-08-05 把契约的说明那半挪进了文件（`RESULT_CONTRACT_NOTES`，占提示词
 * 44.3% 是主要动机）。**骨架没跟着走，是故意的**：
 *
 *   需求 / 问题名单没被读到  →  模型少了信息，它会大声说读不到
 *   **骨架没被读到**         →  它答出来的形状不对，**整轮无法解析、直接作废**
 *
 * 前者可以赌，后者不能。判据是「缺了会怎样」，不是「长不长」。
 */
export const RESULT_CONTRACT = `Reply with one \`\`\`json block and nothing that contradicts it:
{"artifactIds": ["<path or id you produced>"], "blockers": [{"id": "...", "severity": "P0|P1|P2", "title": "...", "where": "...", "why": "..."}]}
Report every problem you found as a blocker. An empty list means you found none.`;

/**
 * 各字段是什么意思。**这一半走文件**（`judgePrompt` 的 `contractNotesPath`）。
 *
 * 缺了它，模型照样答得出合法形状 —— 只是 `where` / `why` 会写得糙，而那两样
 * **本来就有人在判**（critic rubric 的第 1、2 条：指向具体位置、说明为什么是问题）。
 * 判据归 rubric，不归提示词长度。
 */
export const RESULT_CONTRACT_NOTES =
  `"where" is where the problem is, in your own words: a file and position for code (src/foo.ts:42), a section for a document (PRD 3.2).
"why" is why it is a problem, in a sentence or two. Do not restate the title.`;

const FENCE = /```json\s*([\s\S]*?)```/g;

/**
 * Read the model's answer.
 *
 * The last fenced block wins, because a model that reconsiders emits a second
 * one; taking the first would act on a draft it had already replaced. Prose
 * around the fence is ignored rather than refused -- the contract is about the
 * structure being StagePass's, not about the model being silent.
 */
/**
 * 没有 ```json 围栏时，把正文里**最后那个完整的 JSON 对象**挖出来。
 *
 * ## 为什么要有它
 *
 * 2026-07-30 实测：红方在 JSON 前面写了一句「我先说明一下我做了什么」，而原来的兜底
 * 是「没围栏就把整段当 JSON」—— 于是 `JSON.parse` 在那句话上失败，整轮作废。
 * 一个完整的对象明明就摆在那儿。
 *
 * **判据是「读不读得出来」，不是「有没有照仪式写」。** 这不放宽任何一项检查：挖出来
 * 的东西照样要过 artifactIds / blockers 那些形状检查，坏的照样拒。
 *
 * ## 为什么从最后一个 `}` 往回找最早的 `{`
 *
 * 最早那个能配对成功的 `{` 就是最外层 —— 从里层开始试会挖出一个嵌套的子对象，
 * 而那个子对象大概率过不了形状检查，于是变成一条难查的「形状不对」。
 *
 * 有围栏时这条根本不会被调用：正文里举例写的 JSON 不许盖过围栏里的答案。
 */
export function jsonAnswerIn(text: string): string | null {
  const fences = [...text.matchAll(FENCE)].map((match) => match[1]!.trim());
  if (fences.length > 0) {
    const fence = fences[fences.length - 1]!;
    /*
     * **结尾没关严的 json，把缺的闭括号补上。**
     *
     * 2026-08-02 CHG-003 连着两轮实测：裁判的 json 一切正常，唯独结尾少一个右
     * 花括号 —— 整轮因此作废，而红蓝的活儿全是对的。resume 的线程会抄自己上一轮
     * 的格式，提示词里的告诫压不过它自己的历史，所以这不是提示词能修的。
     *
     * 这不是猜：前缀结构完整、只差闭合的 json，补几个闭括号是**唯一确定**的修复，
     * 一个字符的内容都不会被发明出来。补完仍要过 JSON.parse 和上层的形状检查 ——
     * 判据照旧是「读不读得出来」，不是「有没有照仪式写」。补了还是坏的，原样交回，
     * 让上层照旧大声失败。
     */
    try {
      JSON.parse(fence);
      return fence;
    } catch {
      const repaired = closeUnterminated(fence);
      if (repaired !== null) return repaired;
      return fence;
    }
  }
  return lastJsonObject(text);
}

/**
 * 只在「唯一缺的是结尾闭括号」时补，别的坏法一概不碰。
 *
 * 扫一遍字符流，带字符串/转义状态记开括号栈：扫完时栈非空、且不停在字符串里、
 * 且没有多余的闭括号 —— 按栈序补齐。任何别的形状（多了闭括号、断在字符串中间）
 * 返回 null，交回上层大声失败。
 */
function closeUnterminated(candidate: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of candidate) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { if (inString) escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === "{") stack.push("}");
    else if (character === "[") stack.push("]");
    else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return null; // 关错了对象，不是没关
    }
  }
  if (inString || stack.length === 0) return null;
  const repaired = candidate + stack.reverse().join("");
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

function lastJsonObject(text: string): string | null {
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  for (let start = text.indexOf("{"); start !== -1 && start < end;
    start = text.indexOf("{", start + 1)) {
    const slice = text.slice(start, end + 1);
    try {
      const parsed: unknown = JSON.parse(slice);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return slice;
      }
    } catch {
      // 这个 `{` 配不上最后那个 `}`，往后挪一个再试
    }
  }
  return null;
}

export function parseTurnResult(
  text: string,
  options?: {
    /**
     * 调用方声明：「我不会用 blockers，别让它们的形状毁掉我要用的那半。」
     *
     * ## 为什么要有这一档
     *
     * 红方的 blockers 在自审阶段**注定被丢掉**（`readRound` 的 `redReviewsOthers`
     * 分支）—— 产出者对自己作品的评价不算对抗性发现。而解析原来在「要不要用」
     * 之前：2026-08-05 真机（Build 第 4 轮），红方把 blockers 交成字符串数组，
     * 一份没人会用的数据形状错了，整轮作废，蓝方同一轮 11 条有效发现陪葬，
     * 58 分钟白烧。
     *
     * ## 丢的是这半个答案，不只是错误
     *
     * 开着这一档时 blockers **永远返回空** —— 形状对的也不带回来。带回来就是
     * 邀请谁顺手用一下，而声明说了不用；「有时有值有时没有」比「永远没有」
     * 难对付得多。artifactIds 的校验一点都不放宽：那半个是真要用的。
     */
    readonly discardBlockers?: boolean;
  },
): TurnResult {
  const candidate = jsonAnswerIn(text) ?? text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new TurnResultUnparsableError(
      "turn_result_no_json",
      candidate.slice(0, 200),
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TurnResultUnparsableError(
      "turn_result_not_an_object",
      candidate.slice(0, 200),
    );
  }

  const record = parsed as Record<string, unknown>;
  const artifactIds = record.artifactIds;
  if (
    !Array.isArray(artifactIds)
    || artifactIds.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    throw new TurnResultUnparsableError(
      "turn_result_artifacts_invalid",
      JSON.stringify(artifactIds),
    );
  }

  // 声明了不用，就连形状都不看 —— 看了再抛，等于那份声明没说过。
  if (options?.discardBlockers === true) {
    return { artifactIds: artifactIds as string[], blockers: [] };
  }

  /** 不是非空字符串的一律当成「没写」。见下面 `where` / `why` 那段。 */
  const blank = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value : null;

  const blockers = record.blockers;
  if (!Array.isArray(blockers)) {
    throw new TurnResultUnparsableError(
      "turn_result_blockers_invalid",
      JSON.stringify(blockers),
    );
  }
  const parsedBlockers: Finding[] = blockers.map((value) => {
    const blocker = value as Record<string, unknown>;
    if (
      typeof blocker?.id !== "string" || blocker.id.trim() === ""
      || typeof blocker.title !== "string"
      || typeof blocker.severity !== "string"
      || !(BLOCKER_SEVERITIES as readonly string[]).includes(blocker.severity)
    ) {
      throw new TurnResultUnparsableError(
        "turn_result_blockers_invalid",
        JSON.stringify(value),
      );
    }
    return {
      id: blocker.id,
      // 模型在报「我发现了什么」，所以一律是 finding。standard 是 rubric 判出来的
      // 二元结论，永远不从模型的自述里来。
      kind: "finding",
      severity: blocker.severity as BlockerSeverity,
      title: blocker.title,
      /*
       * **缺了不整轮作废，只当成 null。**
       *
       * 上面那四样（id / title / severity / 数组形状）漏一个就抛，因为**少了它们这条
       * blocker 没法用**：没有 id 就接不上下一轮，没有严重度就排不了序。
       *
       * `where` / `why` 不一样：少了它们，这条问题**仍然是一条能用的问题**，只是说得
       * 不够清楚。为它整轮作废，等于拿几分钟的一轮去罚一次措辞不全 —— 而这两样
       * **本来就有人在判**（critic rubric 的第 1、2 条，Review producer 的第 3 条）。
       * 判据归 rubric，别在解析器里再立一道会烧掉整轮的闸。
       *
       * 空串归一成 null：`""` 和「没写」是同一件事，让它们在库里长成两个样子，
       * 下游就得判两次。
       */
      where: blank(blocker.where),
      why: blank(blocker.why),
    };
  });

  return { artifactIds: artifactIds as string[], blockers: parsedBlockers };
}
