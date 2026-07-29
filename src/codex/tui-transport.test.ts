import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexUnavailableError } from "./transport";
import { CodexTuiTransport } from "./tui-transport";

/**
 * The watching half, proved with no Codex and no window: the launcher is
 * injected and writes the session file a real turn would have written.
 */

const THREAD = "019faba0-33e3-7141-b44d-f8a067e4d8c6";
const OTHER = "019fab86-50f1-7b43-a49a-d8f6c7ab747a";

function line(payload: object) {
  return JSON.stringify({ type: "event_msg", payload });
}
const turn = (question: string, answer: string) => [
  line({ type: "task_started" }),
  line({ type: "user_message", message: question }),
  line({ type: "agent_message", message: answer }),
  line({ type: "task_complete" }),
].join("\n");

function sessions() {
  const root = mkdtempSync(join(tmpdir(), "stagepass-sessions-"));
  const day = join(root, "2026", "07", "28");
  mkdirSync(day, { recursive: true });
  return {
    root,
    write(threadId: string, text: string) {
      writeFileSync(
        join(day, `rollout-2026-07-28T22-07-10-${threadId}.jsonl`),
        text,
      );
    },
    read(threadId: string) {
      return readFileSync(
        join(day, `rollout-2026-07-28T22-07-10-${threadId}.jsonl`),
        "utf-8",
      );
    },
  };
}

/** A clock that only moves when the transport waits, so tests never sleep. */
function fakeTime() {
  let now = 1_000_000;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
  };
}

describe("L2 · running a turn in the TUI", () => {
  it("returns what the model said, on the thread it was given", async () => {
    const store = sessions();
    const clock = fakeTime();
    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, ...clock,
      launch: () => store.write(THREAD, turn("go", "the answer")),
    });

    assert.deepEqual(
      await transport.runTurn({ threadId: THREAD, prompt: "go" }),
      { threadId: THREAD, text: "the answer" },
    );
  });

  /**
   * The trap `codex resume` creates: it appends to the thread's existing file,
   * so a scan from the top returns the previous question's answer.
   */
  it("ignores the turns that were already in the file", async () => {
    const store = sessions();
    const clock = fakeTime();
    store.write(THREAD, turn("old question", "old answer"));

    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, ...clock,
      launch: () => store.write(
        THREAD,
        `${turn("old question", "old answer")}\n${turn("new question", "new answer")}`,
      ),
    });

    const delivery = await transport.runTurn({ threadId: THREAD, prompt: "new question" });
    assert.equal(delivery.text, "new answer");
  });

  it("discovers the thread a first turn created", async () => {
    const store = sessions();
    const clock = fakeTime();
    store.write(OTHER, turn("someone else's", "not this one"));

    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, ...clock,
      launch: () => store.write(THREAD, turn("first ever", "hello")),
    });

    assert.deepEqual(
      await transport.runTurn({ threadId: null, prompt: "first ever" }),
      { threadId: THREAD, text: "hello" },
    );
  });

  it("waits while the turn is still running", async () => {
    const store = sessions();
    const clock = fakeTime();
    let polls = 0;
    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, pollMs: 10,
      now: clock.now,
      sleep: async (ms) => {
        polls += 1;
        // Finishes on the third look, not the first.
        if (polls === 3) store.write(THREAD, turn("go", "eventually"));
        await clock.sleep(ms);
      },
      launch: () => store.write(THREAD, [
        line({ type: "task_started" }),
        line({ type: "user_message", message: "go" }),
      ].join("\n")),
    });

    const delivery = await transport.runTurn({ threadId: THREAD, prompt: "go" });
    assert.equal(delivery.text, "eventually");
    assert.ok(polls >= 3);
  });
});

describe("L2 · a TUI turn that never finishes says so", () => {
  /**
   * A TUI stays open after a turn, so nothing about the process indicates
   * completion or failure. Without this the promise would never settle and the
   * job would sit in `running` until its lease expired -- the exact shape that
   * left 82 turns stuck in the tree this replaces.
   */
  it("fails by name rather than waiting forever", async () => {
    const store = sessions();
    const clock = fakeTime();
    store.write(THREAD, turn("old", "old answer"));

    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, timeoutMs: 5_000, pollMs: 1_000,
      ...clock,
      launch: () => {}, // The window never opens; nothing is ever appended.
    });

    await assert.rejects(
      () => transport.runTurn({ threadId: THREAD, prompt: "go" }),
      (error: unknown) =>
        error instanceof CodexUnavailableError
        && /did not complete within 5000ms/.test(error.message),
    );
  });

  it("says so when no session ever appears for a first turn", async () => {
    const store = sessions();
    const clock = fakeTime();
    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, timeoutMs: 3_000, pollMs: 1_000,
      ...clock,
      launch: () => {},
    });

    await assert.rejects(
      () => transport.runTurn({ threadId: null, prompt: "go" }),
      (error: unknown) =>
        error instanceof CodexUnavailableError
        && /no new Codex session appeared/.test(error.message),
    );
  });

  it("tolerates a sessions directory that does not exist yet", async () => {
    const clock = fakeTime();
    const transport = new CodexTuiTransport({
      cwd: "/tmp",
      sessionsDir: join(tmpdir(), "stagepass-absent-sessions"),
      timeoutMs: 2_000, pollMs: 1_000, ...clock,
      launch: () => {},
    });
    await assert.rejects(
      () => transport.runTurn({ threadId: null, prompt: "go" }),
      CodexUnavailableError,
    );
  });
});

describe("L2 · the prompt never goes through a shell", () => {
  /**
   * Measured the hard way: passed as a quoted argument through osascript, every
   * non-ASCII character was mangled and the model was asked a question full of
   * replacement bytes.
   */
  it("writes the prompt to a file and reads it back in the script", async () => {
    const store = sessions();
    const clock = fakeTime();
    const prompt = "请裁决：批准还是打回？ \"quoted\" $VAR `backtick`";
    let script = "";

    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, ...clock,
      launch: (input) => {
        script = readFileSync(input.script, "utf-8");
        store.write(THREAD, turn(prompt, "ok"));
      },
    });
    await transport.runTurn({ threadId: THREAD, prompt });

    // The prompt itself is nowhere in the script -- only a path to it.
    assert.doesNotMatch(script, /批准还是打回/);
    assert.match(script, /codex resume 019faba0-[0-9a-f-]+ .*"\$\(cat .*prompt\.txt\)"/);
    const promptPath = /\$\(cat ([^)]+)\)/.exec(script)![1]!;
    assert.equal(readFileSync(promptPath, "utf-8"), prompt);
  });

  it("starts a fresh session when there is no thread yet", async () => {
    const store = sessions();
    const clock = fakeTime();
    let script = "";
    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, ...clock,
      reasoningEffort: "low",
      launch: (input) => {
        script = readFileSync(input.script, "utf-8");
        store.write(THREAD, turn("go", "ok"));
      },
    });
    await transport.runTurn({ threadId: null, prompt: "go" });

    assert.doesNotMatch(script, /codex resume/);
    assert.match(script, /exec codex -s read-only/);
    assert.match(script, /model_reasoning_effort="low"/);
  });
});
