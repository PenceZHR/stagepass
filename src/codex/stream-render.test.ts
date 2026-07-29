import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeEvent, StreamPrinter, type CodexEvent } from "./stream-render";

/**
 * Built against payloads captured from a real turn on 0.144.4, so the switch is
 * proved against what Codex actually sends rather than what it was assumed to.
 */

function print(events: CodexEvent[]): string {
  let out = "";
  const printer = new StreamPrinter((text) => { out += text; });
  for (const event of events) printer.handle(event);
  return out;
}

describe("L2 · a running turn is watchable", () => {
  it("streams the model's text as it arrives", () => {
    assert.deepEqual(
      describeEvent({ type: "agent_message_content_delta", delta: "Hel" }),
      { kind: "chunk", text: "Hel" },
    );
    assert.equal(print([
      { type: "agent_message_content_delta", delta: "Hel" },
      { type: "agent_message_content_delta", delta: "lo" },
    ]), "Hello");
  });

  /**
   * A chunk followed by a line needs a newline between them, or the next event
   * lands in the middle of the sentence being streamed.
   */
  it("closes a streamed line before printing the next event", () => {
    assert.equal(print([
      { type: "agent_message_content_delta", delta: "thinking" },
      { type: "task_complete" },
    ]), "thinking\n■ turn complete\n");
  });

  it("names the plugins and the tools they were asked for", () => {
    assert.equal(print([
      { type: "mcp_startup_update", server: "stagepass-card", status: { state: "ready" } },
      {
        type: "mcp_tool_call_begin",
        invocation: { server: "stagepass-card", tool: "present_stagepass_choices" },
      },
      {
        type: "mcp_tool_call_end",
        invocation: { server: "stagepass-card", tool: "present_stagepass_choices" },
      },
    ]),
      "  plugin stagepass-card: ready\n"
      + "  → stagepass-card/present_stagepass_choices\n"
      + "  ← stagepass-card/present_stagepass_choices\n");
  });

  it("shows commands and their exit codes", () => {
    assert.equal(print([
      { type: "exec_command_begin", command: ["ls", "-la"] },
      { type: "exec_command_end", exit_code: 0 },
    ]), "  $ ls -la\n  exit 0\n");
  });

  it("reads the token count from either shape", () => {
    assert.deepEqual(
      describeEvent({ type: "token_count", info: { total_token_usage: { total_tokens: 20081 } } }),
      { kind: "line", text: "  20081 tokens" },
    );
    assert.deepEqual(
      describeEvent({ type: "token_count", total_token_usage: { total_tokens: 7 } }),
      { kind: "line", text: "  7 tokens" },
    );
  });

  it("surfaces errors rather than swallowing them", () => {
    assert.deepEqual(
      describeEvent({ type: "error", message: "stream closed" }),
      { kind: "line", text: "  ! stream closed" },
    );
  });

  /**
   * Codex adds event types. A renderer that failed on an unfamiliar one would
   * turn a cosmetic change upstream into a failed turn here.
   */
  it("ignores what it does not recognise instead of failing", () => {
    for (const event of [
      { type: "some_future_event", payload: { anything: true } },
      { type: "task_started", unexpected: "extra field" },
      {},
      { type: 7 },
      { type: "agent_message_content_delta" },
    ]) {
      assert.doesNotThrow(() => describeEvent(event));
    }
    assert.equal(describeEvent({ type: "some_future_event" }), null);
    // A known type with a usable field still renders, extra fields and all.
    assert.deepEqual(
      describeEvent({ type: "task_started", unexpected: "x" }),
      { kind: "line", text: "▶ turn started" },
    );
  });

  it("renders the shape of a whole small turn", () => {
    assert.equal(print([
      { type: "task_started" },
      { type: "mcp_startup_update", server: "stagepass-card", status: { state: "ready" } },
      { type: "agent_message_content_delta", delta: "OK" },
      { type: "agent_message", message: "OK" },  // the same text, sent again
      { type: "token_count", info: { total_token_usage: { total_tokens: 20081 } } },
      { type: "task_complete" },
    ]),
      "▶ turn started\n"
      + "  plugin stagepass-card: ready\n"
      + "OK\n"
      + "  20081 tokens\n"
      + "■ turn complete\n");
  });

  /**
   * Codex sends the deltas AND the finished message. Rendering both printed
   * every sentence twice -- measured on a real turn, where each paragraph of
   * reasoning appeared once as it streamed and again in full.
   */
  it("does not print a message twice when it was already streamed", () => {
    assert.equal(print([
      { type: "agent_message_content_delta", delta: "half " },
      { type: "agent_message_content_delta", delta: "a thought" },
      { type: "agent_message", message: "half a thought" },
    ]), "half a thought\n");
  });

  /**
   * ...but a turn that streams nothing must not end up silent. Reasoning deltas
   * only arrive when the summary is configured for them, so the finished
   * message is the only text some turns produce.
   */
  it("prints the finished message when nothing was streamed", () => {
    assert.equal(
      print([{ type: "agent_message", message: "the whole answer" }]),
      "the whole answer\n",
    );
  });

  it("prints each turn's message again after the previous one closed", () => {
    assert.equal(print([
      { type: "agent_message_content_delta", delta: "first" },
      { type: "agent_message", message: "first" },
      { type: "agent_message", message: "second" },
    ]), "first\nsecond\n");
  });
});
