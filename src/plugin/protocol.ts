import type { RequestedSchema } from "../domain/question";

/**
 * The plugin's request handling, with no process and no database attached.
 *
 * Everything a Codex plugin does is: answer `initialize`, list one tool, and
 * when that tool is called, ask the human and report what they said. Keeping
 * that as a function from message to message means the whole of it is provable
 * offline -- the parts that need a real Codex are the two lines that write to
 * stdout, and they contain no logic.
 *
 * ## What this plugin deliberately cannot do
 *
 * It takes a question id and nothing else. It cannot compose a question, choose
 * an option, or decide what an answer means: it reads what StagePass asked,
 * puts it to the human through the client's own selector, and writes down the
 * reply. Every judgement stays on the StagePass side of the file.
 */

export const TOOL_NAME = "stagepass_ask";
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
  /** The question StagePass is waiting on, or null if there is none. */
  readQuestion(questionId: string): OpenQuestion | null;
  /** Record what the human said. Throws if the question is not answerable. */
  recordAnswer(questionId: string, result: unknown): void;
  /** Put the question to the human and wait. */
  elicit(question: OpenQuestion): Promise<unknown>;
}

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  title: "Ask the human a StagePass question",
  description:
    "Put a StagePass question to the human and record their answer. Takes only "
    + "the question id you were given. It contains the wording and the options; "
    + "you cannot change either, and you must not answer on the human's behalf.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["questionId"],
    properties: { questionId: { type: "string", minLength: 1 } },
  },
} as const;

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
  if (method === "tools/list") return reply(id, { tools: [TOOL_DEFINITION] });
  if (method === "ping") return reply(id, {});

  if (method === "tools/call") {
    const params = message.params as
      { name?: unknown; arguments?: { questionId?: unknown } } | undefined;
    if (params?.name !== TOOL_NAME) {
      return reply(id, toolText(`unknown tool: ${String(params?.name)}`, true));
    }
    const questionId = params.arguments?.questionId;
    if (typeof questionId !== "string" || questionId === "") {
      return reply(id, toolText("questionId is required", true));
    }

    const question = dependencies.readQuestion(questionId);
    // Not an error the model should work around. StagePass may have superseded
    // the question, or someone may have answered it already -- both are normal,
    // and inventing an answer here would be the worst possible response.
    if (!question) {
      return reply(id, toolText(
        `question ${questionId} is not open; nothing was asked and nothing was recorded`,
        true,
      ));
    }

    let result: unknown;
    try {
      result = await dependencies.elicit(question);
    } catch (error) {
      return reply(id, toolText(
        `could not ask the human: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }
    try {
      dependencies.recordAnswer(questionId, result);
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
