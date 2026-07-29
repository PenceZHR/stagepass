import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { BindingStore } from "../store/binding-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";

import { createPanelServer } from "./panel-server";
import type { Phase } from "../domain/phase";
import type { PtySession } from "./pty-session";

/**
 * The panel over a real socket, with a fake pty in place of Codex.
 *
 * What is proved here is the half with no Codex in it: eleven phases offered,
 * bytes reaching the browser unchanged, keystrokes reaching the pty, and a
 * phase never getting a second live process.
 *
 * ## Why every test tears its own server down
 *
 * The output endpoint never ends its response -- that is what a terminal is.
 * So a server left listening, or a stream left open, keeps the test process
 * alive forever, and `after()` hooks are too late because they run once the
 * whole file is done. Each test owns its server and closes it, connections
 * included.
 */

const CHANGE = "CHG-PANEL";
const PROJECT = "PRJ-PANEL";

interface PhaseEntry {
  phase: string;
  threadId: string | null;
  live: boolean;
  current: boolean;
  /** Passed, failed, or neither yet. See the note on `markOf` in the server. */
  mark: "approved" | "problem" | null;
  gaps: { id: string; severity: string; title: string; status: string }[];
}

/**
 * Carry a Change forward the way a person does: run the phase, let it settle,
 * approve it. Used to reach a phase deep in the line without hand-writing
 * fifteen transitions per test.
 */
function advanceTo(changes: ChangeStore, target: Phase): void {
  for (let guard = 0; changes.read(CHANGE).state.phase !== target; guard += 1) {
    assert.ok(guard < 20, `${target} was not reached; the line does not lead there`);
    changes.apply(CHANGE, "start");
    changes.apply(CHANGE, "settle");
    changes.apply(CHANGE, "approve");
  }
}

interface Fake {
  started: { changeId: string; phase: string; argv: string[] }[];
  written: Uint8Array[];
  resized: { cols: number; rows: number }[];
  emit(bytes: Uint8Array): void;
}

/** The thread an invocation resumes, or null when it starts a fresh one. */
const resumedThread = (argv: string[]): string | null =>
  argv[0] === "resume" ? argv[1]! : null;

async function withPanel(
  body: (context: {
    base: string;
    pty: Fake;
    database: Database.Database;
    open: (path: string, init?: RequestInit) => Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  // 带上一个 project：rubric 有项目级默认，所以它要知道自己属于谁。
  // 不能建完再 UPDATE —— ck_changes_ledger 会拒绝任何没有配套账本行的更新，
  // 而那条触发器正是这么设计的。
  new ProjectStore(database).ensure(PROJECT, "p");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT });

  const started: Fake["started"] = [];
  const written: Uint8Array[] = [];
  const resized: Fake["resized"] = [];
  const emitters: ((bytes: Uint8Array) => void)[] = [];
  const pty: Fake = {
    started, written, resized,
    emit: (bytes) => { for (const listener of emitters) listener(bytes); },
  };

  const start = ((input: {
    changeId: string; phase: string; argv: string[];
  }): PtySession => {
    started.push({ ...input });
    let alive = true;
    return {
      changeId: input.changeId,
      phase: input.phase as PtySession["phase"],
      onBytes(listener) { emitters.push(listener); },
      onExit() { /* the fake never exits */ },
      write(bytes) { written.push(bytes); },
      resize(cols, rows) { resized.push({ cols, rows }); },
      kill() { alive = false; },
      get alive() { return alive; },
    };
  }) as never;

  const { server } = createPanelServer({
    // 时限调到 200ms：没有真 Codex，轮次必然等不到 rollout。不设它的话，
    // 测试会陪着默认的 30 分钟一起等。
    database, session: { cwd: "/tmp" }, start, turnTimeoutMs: 200,
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Streams opened by a test, cancelled before teardown so nothing is left
  // holding a socket.
  const streams: Response[] = [];
  const open = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(`${base}${path}`, init);
    streams.push(response);
    return response;
  };

  try {
    await body({ base, pty, database, open });
  } finally {
    for (const response of streams) {
      try { await response.body?.cancel(); } catch { /* already done */ }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    database.close();
  }
}

describe("panel · what it offers", () => {
  it("offers eleven phases, and never Done", async () => {
    await withPanel(async ({ open }) => {
      const panel = await (await open(`/api/panel?change=${CHANGE}`)).json() as {
        phases: PhaseEntry[];
      };
      assert.equal(panel.phases.length, 11);
      assert.ok(!panel.phases.some((entry) => entry.phase === "Done"));
      // A fresh Change sits at PRD, so that is the one node that may be run.
      // Nothing has passed or failed yet, so no node carries a mark.
      assert.deepEqual(panel.phases[0], {
        phase: "PRD", threadId: null, live: false, current: true,
        mark: null, gaps: [],
      });
      assert.ok(!panel.phases.slice(1).some((entry) => entry.current));
      assert.ok(!panel.phases.some((entry) => entry.mark !== null));
    });
  });

  it("shows the thread a phase is bound to", async () => {
    await withPanel(async ({ open, database }) => {
      new BindingStore(database).bind(CHANGE, "Spec", "THREAD-SPEC");
      const panel = await (await open(`/api/panel?change=${CHANGE}`)).json() as {
        phases: { phase: string; threadId: string | null }[];
      };
      assert.equal(
        panel.phases.find((entry) => entry.phase === "Spec")?.threadId,
        "THREAD-SPEC",
      );
    });
  });

  it("serves the page, and refuses a phase that has no terminal", async () => {
    await withPanel(async ({ open }) => {
      const page = await open("/");
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/);
      await page.text();

      assert.equal((await open(`/pty/${CHANGE}/Nonsense`)).status, 404);
      // Done is a real phase and still has no terminal: nothing runs there.
      assert.equal((await open(`/pty/${CHANGE}/Done`)).status, 404);
    });
  });
});

/**
 * What makes a node green and what makes it amber.
 *
 * The rule, decided 2026-07-29 and written into the rebuild PRD: a phase is
 * green because a PERSON approved it, never because a round reported no
 * problems. That is the same line the whole product is drawn on -- a model
 * saying "looks fine" is not a pass -- so the colour has to be read from the
 * ledger, which only records what a human decided.
 */
describe("panel · pass and fail per phase", () => {
  const marksOf = async (
    open: (path: string) => Promise<Response>,
  ): Promise<Record<string, PhaseEntry["mark"]>> => {
    const panel = await (await open(`/api/panel?change=${CHANGE}`)).json() as
      { phases: PhaseEntry[] };
    return Object.fromEntries(panel.phases.map((entry) => [entry.phase, entry.mark]));
  };

  it("marks the phase a human approved, and no other", async () => {
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");
      changes.apply(CHANGE, "approve");

      const marks = await marksOf(open);
      assert.equal(marks["PRD"], "approved");
      // Spec is where the Change now sits. Arriving is not passing.
      assert.equal(marks["Spec"], null);
      assert.equal(marks["Build"], null);
    });
  });

  it("does not turn a phase green just because a round found nothing", async () => {
    await withPanel(async ({ open, database }) => {
      // A round ran and closed out clean -- but nobody approved it.
      new GapStore(database).settleRound(CHANGE, "PRD", {
        round: 1, found: [], verdicts: {},
      });
      const changes = new ChangeStore(database);
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");

      assert.equal((await marksOf(open))["PRD"], null);
    });
  });

  it("marks a phase with an open gap as a problem", async () => {
    await withPanel(async ({ open, database }) => {
      new GapStore(database).settleRound(CHANGE, "PRD", {
        round: 1,
        found: [{ id: "G1", severity: "P1", title: "验收标准不可测" }],
        verdicts: {},
      });
      assert.equal((await marksOf(open))["PRD"], "problem");
    });
  });

  it("lets a new problem take the green back off an approved phase", async () => {
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");
      changes.apply(CHANGE, "approve");
      assert.equal((await marksOf(open))["PRD"], "approved");

      // A later round reaches back and opens a gap on a phase already passed.
      // Green would then be claiming something that is no longer true.
      new GapStore(database).settleRound(CHANGE, "PRD", {
        round: 2,
        found: [{ id: "G9", severity: "P0", title: "PRD 与 Spec 冲突" }],
        verdicts: {},
      });
      assert.equal((await marksOf(open))["PRD"], "problem");
    });
  });

  it("marks a phase whose turn failed as a problem", async () => {
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "fail");
      assert.equal((await marksOf(open))["PRD"], "problem");
    });
  });

  it("marks a rejected Review as a problem while the work sits in Fix", async () => {
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      advanceTo(changes, "Review");
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");
      changes.apply(CHANGE, "reject");
      assert.equal(changes.read(CHANGE).state.phase, "Fix");

      const marks = await marksOf(open);
      assert.equal(marks["Review"], "problem");
      // The phases that got Review this far are still passed.
      assert.equal(marks["Build"], "approved");
    });
  });

  it("takes the green off Fix when the work comes back to it", async () => {
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      advanceTo(changes, "Review");
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");
      changes.apply(CHANGE, "reject");          // -> Fix
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");
      changes.apply(CHANGE, "approve");         // Fix passed, back to Review
      assert.equal((await marksOf(open))["Fix"], "approved");

      // Review sends it back a second time. Fix is where the work is now, so
      // the green from the previous visit is stale -- Fix is the one phase the
      // line can re-enter, which is why the mark cannot be "was ever approved".
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");
      changes.apply(CHANGE, "reject");
      assert.equal(changes.read(CHANGE).state.phase, "Fix");
      assert.equal((await marksOf(open))["Fix"], null);
    });
  });

  it("gives each phase its own gaps, resolved ones included", async () => {
    await withPanel(async ({ open, database }) => {
      const gaps = new GapStore(database);
      gaps.settleRound(CHANGE, "PRD", {
        round: 1,
        found: [
          { id: "G1", severity: "P0", title: "没有验收标准" },
          { id: "G2", severity: "P2", title: "术语不一致" },
        ],
        verdicts: {},
      });
      gaps.settleRound(CHANGE, "PRD", {
        round: 2, found: [], verdicts: { G2: { kind: "closed", reason: "第二轮统一了叫法" } },
      });
      gaps.settleRound(CHANGE, "Spec", {
        round: 1, found: [{ id: "S1", severity: "P1", title: "接口没有错误码" }], verdicts: {},
      });

      const panel = await (await open(`/api/panel?change=${CHANGE}`)).json() as
        { phases: PhaseEntry[] };
      const forPhase = (phase: string) =>
        panel.phases.find((entry) => entry.phase === phase)!.gaps;

      // The popup shows history, not just what is blocking: a closed gap with
      // its reason is how you tell "we fixed it" from "the round forgot".
      assert.deepEqual(forPhase("PRD").map((gap) => [gap.id, gap.status]),
        [["G1", "open"], ["G2", "closed"]]);
      assert.deepEqual(forPhase("Spec").map((gap) => gap.id), ["S1"]);
      assert.deepEqual(forPhase("TechSpec"), []);
    });
  });
});

describe("panel · bytes go through untouched", () => {
  it("forwards what the pty produced, byte for byte", async () => {
    await withPanel(async ({ open, pty }) => {
      const response = await open(`/pty/${CHANGE}/PRD`);
      const reader = response.body!.getReader();

      // An escape sequence plus a multi-byte character -- exactly what a
      // decode-then-forward implementation corrupts at a chunk boundary.
      const sent = new Uint8Array([
        0x1b, 0x5b, 0x33, 0x31, 0x6d,
        0xe8, 0xaf, 0xb7, 0xe8, 0xa3, 0x81, 0xe5, 0x86, 0xb3,
      ]);
      pty.emit(sent);

      const { value } = await reader.read();
      assert.deepEqual(Array.from(value!), Array.from(sent));
      reader.releaseLock();
    });
  });

  it("replays what a running session already drew", async () => {
    await withPanel(async ({ open, pty }) => {
      // Someone opens the phase, Codex draws its screen, they navigate away.
      const first = await open(`/pty/${CHANGE}/PRD`);
      const banner = new Uint8Array([0x4f, 0x4b, 0x21]); // "OK!"
      pty.emit(banner);
      await first.body!.cancel();

      // Coming back must not show an empty terminal: the pty forwards what
      // happens next, and at an idle composer nothing happens next.
      const second = await open(`/pty/${CHANGE}/PRD`);
      const { value } = await second.body!.getReader().read();

      assert.deepEqual(Array.from(value!), Array.from(banner));
      assert.equal(pty.started.length, 1, "replay must not start a second process");
    });
  });

  it("sends keystrokes to the pty as bytes", async () => {
    await withPanel(async ({ open, pty }) => {
      // Down arrow, then Enter: the two keys a gate decision needs.
      const keys = new Uint8Array([0x1b, 0x5b, 0x42, 0x0d]);
      const posted = await open(`/pty/${CHANGE}/PRD/in`, { method: "POST", body: keys });
      assert.equal(posted.status, 204);
      assert.deepEqual(Array.from(pty.written[0]!), Array.from(keys));
    });
  });

  it("passes the browser's size through to the pty", async () => {
    await withPanel(async ({ open, pty }) => {
      await open(`/pty/${CHANGE}/PRD/resize?cols=100&rows=40`, { method: "POST" });
      assert.deepEqual(pty.resized.at(-1), { cols: 100, rows: 40 });
    });
  });
});

describe("panel · one live process per phase thread", () => {
  it("does not start a second process for a phase that has one", async () => {
    await withPanel(async ({ open, pty }) => {
      await open(`/pty/${CHANGE}/PRD`);
      await open(`/pty/${CHANGE}/PRD`);
      await open(`/pty/${CHANGE}/PRD/in`, {
        method: "POST", body: new Uint8Array([0x0d]),
      });
      assert.equal(pty.started.length, 1);
    });
  });

  it("refuses to dispatch into a phase someone already has open", async () => {
    await withPanel(async ({ open, pty }) => {
      // A fresh Change is at PRD, and someone opens PRD to look at it.
      await open(`/pty/${CHANGE}/PRD`);

      const ran = await (await open(`/api/run?change=${CHANGE}`, { method: "POST" })).json() as
        { ran: boolean; reason?: string; phase: string };

      // Dispatching now would put a second turn into the same rollout, and
      // then "which turn was mine" has no answer (§6.4 pit 2, §6.5 rule 5).
      assert.deepEqual(ran, { ran: false, reason: "phase_already_running", phase: "PRD" });
      assert.equal(pty.started.length, 1);
    });
  });

  it("gives a different phase its own process", async () => {
    await withPanel(async ({ open, pty }) => {
      await open(`/pty/${CHANGE}/PRD`);
      await open(`/pty/${CHANGE}/Spec`);
      assert.equal(pty.started.length, 2);
      assert.deepEqual(pty.started.map((entry) => entry.phase), ["PRD", "Spec"]);
    });
  });

  it("resumes the phase's bound thread rather than starting a new one", async () => {
    await withPanel(async ({ open, pty, database }) => {
      new BindingStore(database).bind(CHANGE, "Spec", "THREAD-SPEC");
      await open(`/pty/${CHANGE}/PRD`);
      await open(`/pty/${CHANGE}/Spec`);
      const argvFor = (phase: string) =>
        pty.started.find((entry) => entry.phase === phase)!.argv;
      assert.equal(resumedThread(argvFor("PRD")), null);
      assert.equal(resumedThread(argvFor("Spec")), "THREAD-SPEC");
    });
  });

  it("opens a phase for looking without dispatching a turn", async () => {
    await withPanel(async ({ open, pty }) => {
      await open(`/pty/${CHANGE}/PRD`);
      const argv = pty.started[0]!.argv;
      // The invocation carries flags and nothing else. A prompt here would send
      // a turn to the model just because somebody clicked a node to look.
      assert.deepEqual(argv, ["-s", "read-only", "-a", "on-request"]);
    });
  });
});

/**
 * rubric 编辑 —— 网页上唯一可以改的东西（PRD §1.1）。
 *
 * 边界写成可查的形式：**Web 可以改「标准」，永远不可以对「这一次的产物」下判断。**
 * 所以这里有编辑 rubric 的端点，而永远不会有 approve / reject / waive 的端点。
 */
describe("panel · rubric 是网页上唯一能改的东西", () => {
  const post = (open: (path: string, init?: RequestInit) => Promise<Response>,
    role: string, body: unknown) =>
    open(`/api/rubric?change=${CHANGE}&phase=Spec&role=${role}`,
      { method: "POST", body: JSON.stringify(body) });

  it("存一份，读回来", async () => {
    await withPanel(async ({ open, database: _database }) => {
      const saved = await (await post(open, "producer", {
        scope: "project",
        drafts: [{ text: "每条需求都有可测的验收标准", blocking: true }],
      })).json() as { saved: boolean; version: number };
      assert.deepEqual(saved, { saved: true, version: 1, retired: [] });

      const read = await (await open(`/api/rubric?change=${CHANGE}&phase=Spec`)).json() as {
        roles: { role: string; scope: string | null; criteria: { text: string }[] }[];
      };
      const producer = read.roles.find((entry) => entry.role === "producer");
      assert.equal(producer?.scope, "project");
      assert.equal(producer?.criteria[0]?.text, "每条需求都有可测的验收标准");
      // 另外两个角色还没有 rubric，而那是合法的。
      assert.equal(read.roles.find((entry) => entry.role === "critic")?.scope, null);
    });
  });

  it("撤下一条阻断标准而不给理由 —— 拒绝，并说清是哪一条", async () => {
    await withPanel(async ({ open }) => {
      await post(open, "producer", {
        scope: "project", drafts: [{ text: "挡着的", blocking: true }],
      });

      const refused = await (await post(open, "producer",
        { scope: "project", drafts: [] })).json() as
        { saved: boolean; reason: string; retired: string[] };
      assert.equal(refused.saved, false);
      assert.equal(refused.reason, "reason_required");
      assert.equal(refused.retired.length, 1);
    });
  });

  it("撤下标准时，它派生的阻断项跟着退休，理由落进 resolution", async () => {
    await withPanel(async ({ open, database }) => {
      await post(open, "producer", {
        scope: "project", drafts: [{ text: "挡着的", blocking: true }],
      });
      const key = (await (await open(`/api/rubric?change=${CHANGE}&phase=Spec`)).json() as {
        roles: { role: string; criteria: { key: string }[] }[];
      }).roles.find((entry) => entry.role === "producer")!.criteria[0]!.key;

      // 手工放一条这条 criterion 派生的 standard，模拟上一轮判了 no。
      new GapStore(database).replace(CHANGE, "Spec", [{
        id: `RB:producer:${key}`, kind: "standard", severity: null,
        title: "挡着的", status: "open", openedRound: 1, resolution: null,
      }]);
      assert.equal(new GapStore(database).blockers(CHANGE, "Spec").length, 1);

      await post(open, "producer",
        { scope: "project", drafts: [], reason: "这条本来就不该要求" });

      const after = new GapStore(database).all(CHANGE, "Spec");
      assert.equal(after[0]?.status, "closed");
      assert.match(after[0]?.resolution ?? "", /这条本来就不该要求/);
    });
  });

  it("scope 没写明 —— 400，不给默认值", async () => {
    await withPanel(async ({ open }) => {
      const refused = await post(open, "producer", { drafts: [] });
      assert.equal(refused.status, 400);
      assert.equal(await refused.text(), "bad_scope");
    });
  });

  it("回传一个不属于本 scope 的 key —— 拒绝整次编辑", async () => {
    await withPanel(async ({ open }) => {
      const refused = await (await post(open, "producer", {
        scope: "project", drafts: [{ key: "K-伪造", text: "x", blocking: true }],
      })).json() as { saved: boolean; reason: string };
      assert.deepEqual(
        { saved: refused.saved, reason: refused.reason },
        { saved: false, reason: "untrusted_key" });
    });
  });

  it("**网页上没有任何裁决产物的端点**", async () => {
    await withPanel(async ({ open }) => {
      // 这条不是形式主义。PRD §1 的整条红线就是它，而 rubric 编辑是唯一的例外 ——
      // 例外之外再多一个，那条线就什么都拦不住了。
      for (const path of ["/api/approve", "/api/reject", "/api/waive", "/api/gate"]) {
        const attempt = await open(path, { method: "POST" });
        assert.equal(attempt.status, 404, path);
      }
    });
  });
});

/**
 * 「跑这个阶段」跑的是一轮对抗，不是一次 turn。
 *
 * 单次 turn 是让一个模型自己写、自己说没问题，闸门读它的自述 —— 这个产品存在的
 * 理由就是不许那样。所以面板上那个按钮换掉了 runner，而不是并排多一个按钮：
 * 两个「跑」、没人说得清哪个是真的，那是老树的病。
 */
describe("panel · 跑一个阶段 = 跑一轮对抗", () => {
  it("派给 Codex 的提示词里有裁判、红方、蓝方", async () => {
    await withPanel(async ({ open, pty }) => {
      // 不等它跑完 —— 真跑要 Codex。看的是**派出去的那条命令**长什么样。
      // 接住它：没有真 Codex，这一轮注定失败。不接就是未处理的 rejection，
      // 会变成一个和任何测试都对不上号的**文件级**失败。
      void open(`/api/run?change=${CHANGE}`, { method: "POST" }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 120); });

      const argv = pty.started.find((entry) => entry.phase === "PRD")?.argv ?? [];
      const prompt = argv.join(" ");
      assert.match(prompt, /裁判/, "没有裁判");
      assert.match(prompt, /\/root\/red/, "没有让它派生红方");
      assert.match(prompt, /\/root\/blue/, "没有让它派生蓝方");
    });
  });

  it("rubric 装上了就进提示词 —— 模型答不出它没被问过的题", async () => {
    await withPanel(async ({ open, database, pty }) => {
      const rubrics = new RubricStore(database);
      const saved = rubrics.save(
        { projectId: PROJECT, changeId: null, phase: "PRD", role: "producer" },
        [{ text: "每条需求都有可观察的验收标准", blocking: true }]);

      void open(`/api/run?change=${CHANGE}`, { method: "POST" }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 120); });

      const prompt = (pty.started.find((entry) => entry.phase === "PRD")?.argv ?? []).join(" ");
      assert.match(prompt, new RegExp(saved.criteria[0]!.key), "criterion 的编号没进去");
      assert.match(prompt, /每条需求都有可观察的验收标准/, "criterion 的正文没进去");
    });
  });
});
