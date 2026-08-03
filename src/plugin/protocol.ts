import type { RequestedSchema } from "../domain/question";
import type { AnswerOutcome, WorkItemView } from "../domain/worklist";

/**
 * The plugin's request handling, with no process and no database attached.
 *
 * Everything a Codex plugin does is: answer `initialize`, list its tools, and
 * when one is called, do the one thing it does. Keeping that as a function from
 * message to message means the whole of it is provable offline -- the parts
 * that need a real Codex are the two lines that write to stdout, and they
 * contain no logic.
 *
 * ## 这个插件刻意做不到的事
 *
 * **每个工具都不收任何标识符。** 它不能拟一个问题、选一个选项、决定一个答案是什么
 * 意思，也不能挑要答哪一条 —— 它读 StagePass 摆出来的那一件事，交给人或者念给模型，
 * 然后把回话写下来。每一个判断都留在 StagePass 那一侧。
 *
 * ## 为什么连 id 都不收了（2026-08-02）
 *
 * `stagepass_ask` 原来收一个 `questionId`，而那个 id 是 StagePass 印在提示词里、
 * 模型**手抄**进工具入参的。同一个病在裁判那边更重：它要手抄 50 字符的 gap id 和
 * 40 字符的 criterion key，抄漏一段就一整份判定作废（实测连抄三轮）。
 *
 * 用户 2026-08-02 立的规矩：**凡是 StagePass 会拿去做精确匹配的字符串，都不许出现
 * 在模型必须生成的文本里。** 所以「答的是哪一条」由 StagePass 在库里说了算，模型只
 * 交一个枚举值和一句散文。见 docs/DESIGN-no-hand-transcription-2026-08-02.md。
 */

export const TOOL_NAME = "stagepass_ask";
export const NEXT_TOOL = "stagepass_next";
export const ANSWER_TOOL = "stagepass_answer";
export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface OpenQuestion {
  readonly message: string;
  readonly requestedSchema: RequestedSchema;
}

export interface PluginDependencies {
  /**
   * StagePass 此刻在等的那个问题，没有就 null。
   *
   * **不按 id 找** —— 模型没有 id 可给（见文件开头）。「哪一个是此刻这一个」是库里
   * 的事实，由 StagePass 那一侧决定。
   */
  openQuestion(): { readonly id: string; readonly question: OpenQuestion } | null;
  /** Record what the human said. Throws if the question is not answerable. */
  recordAnswer(questionId: string, result: unknown): void;
  /** Put the question to the human and wait. */
  elicit(question: OpenQuestion): Promise<unknown>;
  /** 裁判这一轮还没表态的第一项，没有就 null。 */
  nextItem(): WorkItemView | null;
  /** 把答案记在那一项上。**答错了不抛，返回一个结局。** */
  recordItem(answer: string, reason: string): AnswerOutcome;
}

/** 不收任何入参。这是这三个工具的共同点，也是它们存在的理由。 */
const NOTHING = {
  type: "object", additionalProperties: false, properties: {},
} as const;

export const TOOL_DEFINITIONS = [
  {
    name: TOOL_NAME,
    title: "Ask the human the question StagePass is waiting on",
    description:
      "把 StagePass 此刻在等的那个问题交给人，并记下他的回答。**不带参数** —— "
      + "问哪一个由 StagePass 决定。措辞和选项都是它给的，你改不了，也不许替人作答。",
    inputSchema: NOTHING,
  },
  {
    name: NEXT_TOOL,
    title: "Get the next thing StagePass needs your verdict on",
    description:
      "取下一条要你表态的东西。**不带参数** —— 顺序由 StagePass 定。返回里写明这是"
      + "第几条、一共几条、正文，以及你只能答哪几个值。答完一条再调一次，直到它说没有了。",
    inputSchema: NOTHING,
  },
  {
    name: ANSWER_TOOL,
    title: "Answer the item you were just given",
    description:
      "回答上一次 stagepass_next 给你的那一条。answer 只能是它列出的那几个值之一，"
      + "reason 用一句话说清依据。**不需要、也无法指定答的是哪一条** —— StagePass 记着。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["answer", "reason"],
      properties: {
        answer: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
      },
    },
  },
] as const;

function reply(id: unknown, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

function toolText(text: string, isError = false): unknown {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] };
}

/**
 * Handle one incoming message.
 *
 * Returns the reply to send, or null for a notification that needs none.
 */
export async function handleMessage(
  message: JsonRpcMessage,
  dependencies: PluginDependencies,
): Promise<JsonRpcMessage | null> {
  const { method, id } = message;
  if (typeof method !== "string") return null;
  // A notification has no id and expects no answer.
  if (id === undefined) return null;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "stagepass", version: "0.1.0" },
    });
  }
  if (method === "tools/list") return reply(id, { tools: TOOL_DEFINITIONS });
  if (method === "ping") return reply(id, {});

  if (method === "tools/call") {
    const params = message.params as
      { name?: unknown; arguments?: Record<string, unknown> } | undefined;

    if (params?.name === NEXT_TOOL) return reply(id, nextReply(dependencies));
    if (params?.name === ANSWER_TOOL) {
      return reply(id, answerReply(params.arguments, dependencies));
    }
    if (params?.name !== TOOL_NAME) {
      return reply(id, toolText(`unknown tool: ${String(params?.name)}`, true));
    }

    const open = dependencies.openQuestion();
    // Not an error the model should work around. StagePass may have superseded
    // the question, or someone may have answered it already -- both are normal,
    // and inventing an answer here would be the worst possible response.
    if (!open) {
      return reply(id, toolText(
        "StagePass 此刻没有在等任何问题；什么都没问，也什么都没记下。",
        true,
      ));
    }

    let result: unknown;
    try {
      result = await dependencies.elicit(open.question);
    } catch (error) {
      return reply(id, toolText(
        `could not ask the human: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }
    try {
      dependencies.recordAnswer(open.id, result);
    } catch (error) {
      // The human answered and StagePass could not store it. Saying so is the
      // only honest move: reporting success would leave a decision that was
      // made and lost.
      return reply(id, toolText(
        `the human answered but StagePass could not record it: `
        + `${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }
    return reply(id, toolText(
      "Recorded. StagePass has the answer; do not restate or act on it.",
    ));
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

/**
 * 把下一条念给模型听。
 *
 * **正文之外只多说三件事**：这是第几条、一共几条、只能答哪几个值。前两个是为了让它
 * 停得下来（不知道总数的模型会一直问下去，或者答一条就走）；第三个是为了让「答错」
 * 变成一件它当场就能改的事，而不是一次事后才发现的作废。
 *
 * 没有下一条时说得明明白白 —— 「答完了」和「出错了」长得一样的话，模型会重试。
 */
function nextReply(dependencies: PluginDependencies): unknown {
  const item = dependencies.nextItem();
  if (!item) {
    return toolText("没有要你表态的东西了。这一轮的名单已经答完，不用再调这个工具。");
  }
  return toolText([
    `第 ${item.ordinal} 条，共 ${item.total} 条。`,
    "",
    item.prompt,
    "",
    `用 ${ANSWER_TOOL} 回答。answer 只能是：${item.choices.join(" / ")}。`,
    "reason 用一句话说清依据。",
  ].join("\n"));
}

/**
 * 收下一条答案。
 *
 * **四种结局各说各的，不合并成一句「失败」。** 模型对它们要做的事完全不同：值答错了
 * 就换一个值重来，理由空了就补一句，答完了就停下，而入参形状不对是它自己写坏了。
 * 合成一句，它只会原样重试。
 */
function answerReply(
  args: Record<string, unknown> | undefined,
  dependencies: PluginDependencies,
): unknown {
  const answer = args?.["answer"];
  const reason = args?.["reason"];
  if (typeof answer !== "string" || answer.trim() === "") {
    return toolText("answer 是必填的，而且只能是上一条里列出的那几个值之一。", true);
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    return toolText("reason 是必填的：一句话说清依据。", true);
  }

  const outcome = dependencies.recordItem(answer.trim(), reason);
  switch (outcome.kind) {
    case "recorded":
      return toolText(outcome.remaining === 0
        ? "记下了。这一轮的名单答完了，不用再调 stagepass_next。"
        : `记下了。还剩 ${outcome.remaining} 条，继续调 ${NEXT_TOOL}。`);
    case "bad_answer":
      return toolText(
        `「${answer.trim()}」不是这一条允许的答案。只能是：${outcome.choices.join(" / ")}。`
        + "换一个值再调一次，这一条还没记上。",
        true,
      );
    case "no_reason":
      return toolText("reason 不能是空白：一句话说清依据。这一条还没记上。", true);
    case "nothing_open":
      return toolText(
        "此刻没有等着被回答的条目 —— 可能已经答完了。先调 " + NEXT_TOOL + " 确认。",
        true,
      );
  }
}

/**
 * The elicitation request for a question.
 *
 * Split out so the shape sent to Codex is checkable without a client: it is the
 * MCP `elicitation/create` params, and nothing about it is StagePass-specific.
 */
export function elicitationParams(question: OpenQuestion): {
  message: string;
  requestedSchema: RequestedSchema;
} {
  return {
    message: question.message,
    requestedSchema: question.requestedSchema,
  };
}
