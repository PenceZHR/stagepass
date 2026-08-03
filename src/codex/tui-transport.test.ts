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

  it("**线程一被认出来就叫 onThread —— 即使这个 turn 永远跑不完**", async () => {
    /*
     * 一个 turn 要跑几分钟，而线程在开头就建出来了。等 runTurn 返回才拿 id 的话，
     * 第一轮全程说不出「走到哪了」，中途死掉的轮什么都不留。所以 id 一确定就得
     * 说出去 —— 连失败的 turn 也一样。
     */
    const store = sessions();
    const clock = fakeTime();
    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, ...clock,
      // 线程建了、提示词也送到了，但 task_complete 永远不来。
      launch: () => store.write(THREAD, [
        line({ type: "task_started" }),
        line({ type: "user_message", message: "first ever" }),
      ].join("\n")),
    });

    const seen: string[] = [];
    await assert.rejects(
      transport.runTurn({
        threadId: null, prompt: "first ever",
        onThread: (threadId) => { seen.push(threadId); },
      }),
      CodexUnavailableError,
    );
    assert.deepEqual(seen, [THREAD], "turn 失败了，但线程 id 早就该说出去了");
  });

  it("**别的 Codex 同时建了线程时，认的是带着我们提示词的那个**", async () => {
    /*
     * 2026-07-29 实测栽过一次。原先的做法是「启动之后第一个没见过的线程 id」，
     * 而当时有一轮没杀干净的对抗还在派生子 Agent —— 这里抓到了它的线程，于是后面
     * 去找 /root/red 一无所获，报出来是「裁判没有派生子 Agent」。
     *
     * 而裁判其实好好地派生了。**只是不是这个裁判。** 这种错法最难查：报错信息
     * 指着一个完全无辜的地方。
     */
    const store = sessions();
    const clock = fakeTime();

    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, ...clock,
      launch: () => {
        // 别人的先出现 —— 按到达顺序认就会抓它。
        store.write(OTHER, turn("另一个 Codex 在干别的", "不是我们的"));
        store.write(THREAD, turn("这是我们派的活", "我们的答案"));
      },
    });

    assert.deepEqual(
      await transport.runTurn({ threadId: null, prompt: "这是我们派的活" }),
      { threadId: THREAD, text: "我们的答案" },
    );
  });

  it("有新线程但都不是我们的 —— 报错要和「TUI 没起来」分开", async () => {
    const store = sessions();
    const clock = fakeTime();
    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root, timeoutMs: 50, pollMs: 10, ...clock,
      launch: () => { store.write(OTHER, turn("别人的活", "别人的答案")); },
    });

    // 两种失败的处理方式完全不同：一种是去看 TUI 为什么没起来，另一种是去看
    // 谁还在跑 Codex。混成一句话，查的人会往错的方向走。
    await assert.rejects(
      transport.runTurn({ threadId: null, prompt: "我们的活" }),
      /none carried this prompt/);
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

/**
 * 2026-08-03 真机：`codex resume <id> … "<prompt>"` 把提示词**搁进了 composer 却
 * 没发出去**。屏幕停在 `Starting MCP server (2/4)`，提示词前面带着 `›`，rollout
 * 一个字节没长 —— 而这一侧看见的和「在跑」一模一样，只能等满整个 timeout。
 *
 * 类文档里那句「sends with no keystroke」是 2026-07-28 实测的。挂上插件之后 MCP
 * server 从 3 个变 4 个，那句话就不再总是成立了。
 */
describe("L2 · 提示词没被提交时补一下回车", () => {
  it("**rollout 一条都没长就补，补完这一轮就跑起来了**", async () => {
    const store = sessions();
    const clock = fakeTime();
    store.write(THREAD, turn("old", "old answer"));
    const nudges: { label?: string; bytes: Uint8Array }[] = [];

    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root,
      timeoutMs: 60_000, pollMs: 1_000, nudgeAfterMs: 3_000,
      ...clock,
      launch: () => {}, // 提示词进了 composer，没发出去 —— rollout 不长
      nudge: (input) => {
        nudges.push(input);
        // 那一下回车把它发出去了。
        store.write(THREAD, `${turn("old", "old answer")}\n${turn("go", "答上了")}`);
      },
    });

    const delivery = await transport.runTurn({
      threadId: THREAD, prompt: "go", aside: { label: "反方·逐条判定" },
    });

    assert.equal(delivery.text, "答上了");
    assert.equal(nudges.length, 1, "补了不止一次 —— 多出来的那些会打断已经跑起来的 turn");
    assert.equal(nudges[0]!.label, "反方·逐条判定", "补到了主线，而这一轮跑在补问那一格");
    assert.equal(new TextDecoder().decode(nudges[0]!.bytes), "\r");
  });

  it("**turn 已经开跑就绝不补** —— 那一下会被 Codex 当成打断", async () => {
    /*
     * 这条是这个功能的承重墙。2026-08-03 那个 `■ Conversation interrupted` 就是
     * 按键打进正在跑的 turn 造成的，而我们绝不能自己制造同一件事。
     * 判据是 rollout 长没长：真开跑了 `user_message` 立刻就落进去。
     */
    const store = sessions();
    const clock = fakeTime();
    store.write(THREAD, turn("old", "old answer"));
    const nudges: unknown[] = [];
    let polls = 0;

    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root,
      timeoutMs: 60_000, pollMs: 1_000, nudgeAfterMs: 3_000,
      now: clock.now,
      sleep: async (ms) => {
        polls += 1;
        // 跑得比 nudgeAfterMs 久，但它确实在跑。
        if (polls === 8) {
          store.write(THREAD, `${turn("old", "old answer")}\n${turn("go", "慢慢答完了")}`);
        }
        await clock.sleep(ms);
      },
      // 开跑了：turn 一起来就往 rollout 里落记录。
      launch: () => store.write(THREAD, [
        turn("old", "old answer"),
        line({ type: "task_started" }),
        line({ type: "user_message", message: "go" }),
      ].join("\n")),
      nudge: (input) => { nudges.push(input); },
    });

    const delivery = await transport.runTurn({ threadId: THREAD, prompt: "go" });
    assert.equal(delivery.text, "慢慢答完了");
    assert.deepEqual(nudges, [], "往一个正在跑的 turn 里塞了回车 —— 那正是打断它的做法");
  });

  it("**新起的会话不补** —— 它是靠提示词出现在 rollout 里认出来的", async () => {
    const store = sessions();
    const clock = fakeTime();
    const nudges: unknown[] = [];

    const transport = new CodexTuiTransport({
      cwd: "/tmp", sessionsDir: store.root,
      timeoutMs: 60_000, pollMs: 1_000, nudgeAfterMs: 3_000,
      ...clock,
      launch: () => store.write(THREAD, turn("go", "新线程答的")),
      nudge: (input) => { nudges.push(input); },
    });

    const delivery = await transport.runTurn({ threadId: null, prompt: "go" });
    assert.equal(delivery.text, "新线程答的");
    assert.deepEqual(nudges, []);
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
