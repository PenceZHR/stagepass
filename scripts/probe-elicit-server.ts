/**
 * A probe MCP server that elicits the moment it is initialized.
 *
 *   STAGEPASS_TAP=<file> tsx scripts/probe-elicit-server.ts
 *
 * ## Why the model is removed from the loop
 *
 * The first probe asked Codex's model to call a tool, and the tool then
 * elicited. Measured across six real turns: four times the model simply never
 * called it, each run costing ten-plus minutes and answering nothing. A gate
 * that only reports when a model feels like cooperating is not a gate.
 *
 * This server needs no model and no tool call. It answers `initialize`, and as
 * soon as the client says it is ready it sends `elicitation/create` itself.
 * Whether the TUI draws a selector is then a property of Codex alone, which is
 * exactly the question §五.10 asks.
 *
 * If Codex refuses an elicitation that arrives outside a tool call, that is a
 * real finding too -- and it arrives in seconds instead of twelve minutes.
 */
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const TAP = process.env.STAGEPASS_TAP;
const PROTOCOL_VERSION = "2025-06-18";

const ELICIT_ID = 9001;

interface JsonRpc {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

function record(direction: string, payload: unknown): void {
  if (!TAP) return;
  appendFileSync(TAP, `${JSON.stringify({ direction, payload })}\n`, "utf-8");
}

function send(message: JsonRpc): void {
  record("server->client", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** The same shape a real gate decision uses: one required field, an enum. */
function elicit(): void {
  send({
    jsonrpc: "2.0",
    id: ELICIT_ID,
    method: "elicitation/create",
    params: {
      message: "PRD：第 1 轮已结算，1 项 P1 已被接受",
      requestedSchema: {
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", title: "请裁决", enum: ["approve", "reject"] },
        },
      },
    },
  });
}

const TOOL_NAME = "ask_the_human";

let elicited = false;
let toolCallId: unknown = null;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: JsonRpc;
  try {
    message = JSON.parse(trimmed) as JsonRpc;
  } catch {
    return;
  }
  record("client->server", message);

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0", id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "elicitprobe", version: "0.1.0" },
      },
    });
    return;
  }

  // Measured 2026-07-29: an elicitation sent here, outside any tool call, is
  // ignored by Codex -- no selector, and no reply at all, not even a decline.
  // Kept behind a flag because "the client ignores it" is itself the finding.
  if (message.method === "notifications/initialized" && !elicited
    && process.env.STAGEPASS_ELICIT_ON_INIT === "1") {
    elicited = true;
    setTimeout(elicit, 300);
    return;
  }

  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0", id: message.id,
      result: {
        tools: [{
          name: TOOL_NAME,
          title: "Ask the human to decide",
          description:
            "Ask the human a yes/no style decision and return what they chose. "
            + "Takes no arguments. Call it once, then stop.",
          inputSchema: { type: "object", additionalProperties: false, properties: {} },
        }],
      },
    });
    return;
  }

  // The path that matters: elicit from inside a tool call.
  if (message.method === "tools/call") {
    const name = (message.params as { name?: string } | undefined)?.name;
    if (name !== TOOL_NAME) {
      send({
        jsonrpc: "2.0", id: message.id,
        result: { isError: true, content: [{ type: "text", text: `unknown tool: ${String(name)}` }] },
      });
      return;
    }
    toolCallId = message.id;
    elicit();
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  // The reply we are here for. Close the tool call so the turn can end.
  if (message.id === ELICIT_ID && message.method === undefined) {
    record("ELICIT_REPLY", { result: message.result, error: message.error });
    if (toolCallId !== null) {
      send({
        jsonrpc: "2.0", id: toolCallId,
        result: { content: [{ type: "text", text: "Recorded. Do not restate it." }] },
      });
      toolCallId = null;
    }
    return;
  }

  if (typeof message.method === "string" && message.id !== undefined) {
    send({
      jsonrpc: "2.0", id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }
});
