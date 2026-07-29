import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { newThreadUrl, threadUrl } from "./desktop-link";

describe("L2 · showing a turn to the human", () => {
  it("builds the thread url Codex registers", () => {
    assert.equal(
      threadUrl("019fab86-50f1-7b43-a49a-d8f6c7ab747a"),
      "codex://threads/019fab86-50f1-7b43-a49a-d8f6c7ab747a",
    );
  });

  /**
   * A thread id arrives from Codex, but it still goes through encoding: a URL
   * assembled by concatenation is a URL that breaks the first time an id
   * contains something that means something in a URL.
   */
  it("encodes the id rather than pasting it", () => {
    assert.equal(threadUrl("a b/c?d"), "codex://threads/a%20b%2Fc%3Fd");
  });

  it("carries the prompt into a new Desktop-owned thread", () => {
    const url = newThreadUrl({
      cwd: "/Users/x/my project",
      prompt: "请裁决：批准还是打回？",
    });
    assert.ok(url.startsWith("codex://threads/new?"));
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    assert.equal(params.get("cwd"), "/Users/x/my project");
    assert.equal(params.get("prompt"), "请裁决：批准还是打回？");
  });
});
