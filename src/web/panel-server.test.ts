import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { BindingStore } from "../store/binding-store";
import { EvidenceStore } from "../store/evidence-store";
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
  assessed: {
    round: number;
    byRole: Record<string, { criterionKey: string; verdict: string; criterionText: string }[]>;
  } | null;
  produced: string[];
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
  /** 每次启动用的 cwd。**Codex 跑在哪个仓库，靠它验。** */
  startedCwd: string[];
  /** 让进程退出。验「死终端要被察觉」那条用的。 */
  exit(): void;
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
  // **项目必须有路径**：Codex 跑在项目的目录里（2026-07-30 起），没有路径
  // launchInto 会抛 ProjectPathMissingError。用 /tmp，测试里的 pty 是假的，不会真跑。
  new ProjectStore(database).ensure(PROJECT, "p", "/tmp");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT });

  const started: Fake["started"] = [];
  const startedCwd: string[] = [];
  const written: Uint8Array[] = [];
  const resized: Fake["resized"] = [];
  const emitters: ((bytes: Uint8Array) => void)[] = [];
  const exiters: ((exitCode: number) => void)[] = [];
  const pty: Fake = {
    started, startedCwd, written, resized,
    emit: (bytes) => { for (const listener of emitters) listener(bytes); },
    exit: () => { for (const onExit of [...exiters]) onExit(0); },
  };

  const start = ((input: {
    changeId: string; phase: string; argv: string[]; options: { cwd: string };
  }): PtySession => {
    started.push({
      changeId: input.changeId, phase: input.phase, argv: input.argv,
    });
    startedCwd.push(input.options.cwd);
    let alive = true;
    return {
      changeId: input.changeId,
      phase: input.phase as PtySession["phase"],
      onBytes(listener) { emitters.push(listener); },
      onExit(listener) { exiters.push(listener); },
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
        // assessed 是 null 而不是空对象：**「没跑过」和「跑了但一条都没答上」
        // 必须分得开** —— 后者在 gaps 里看不出来，因为 yes 和 not_assessed 都
        // 不留痕迹。
        mark: null, gaps: [], assessed: null,
        // 空数组 = 还没产出任何东西。闸门不会放行一个什么都没产出的阶段，
        // 所以这一格是「红方主张」那一侧的原料。
        produced: [],
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

/*
 * 弹窗要能拿到那份产出的**正文**，不只是文件名。
 *
 * 用户 2026-07-30 的原话：「他们把 PRD 和建议一起带回给我 —— 现在只有建议，我拿不到
 * 那份 PRD。」蓝方挑的毛病看得见、被挑的那份东西看不见，那串建议就是悬着的。
 *
 * 测试的项目路径是 `/tmp`（见 withPanel），所以产出也写在 /tmp 下面。
 */
describe("panel · 产出的正文读得到，读不到要说为什么", () => {
  const produce = (database: Database.Database, ids: string[]): void => {
    new EvidenceStore(database).put(CHANGE, "PRD", {
      artifactIds: ids, blockers: [], waivedBlockerIds: [],
    });
  };
  const readArtifact = async (
    open: (path: string, init?: RequestInit) => Promise<Response>,
    id: string,
  ) => await (await open(
    `/api/artifact?change=${CHANGE}&phase=PRD&id=${encodeURIComponent(id)}`,
  )).json() as { readable: boolean; reason?: string; text?: string };

  it("读得到正文", async () => {
    const directory = mkdtempSync("/tmp/sp-artifact-");
    const file = join(directory, "prd.md");
    writeFileSync(file, "# 排行榜\n\n只给我自己看。\n");
    try {
      await withPanel(async ({ open, database }) => {
        produce(database, [file]);
        const read = await readArtifact(open, file);
        assert.equal(read.readable, true);
        assert.match(read.text!, /只给我自己看/);
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("相对路径按项目目录解 —— L4 的红方报的就是 `spec.md` 这种", async () => {
    const name = `sp-artifact-relative-${process.pid}.md`;
    writeFileSync(join("/tmp", name), "相对路径也读得到");
    try {
      await withPanel(async ({ open, database }) => {
        produce(database, [name]);
        const read = await readArtifact(open, name);
        assert.equal(read.readable, true);
        assert.match(read.text!, /相对路径也读得到/);
      });
    } finally { rmSync(join("/tmp", name), { force: true }); }
  });

  it("**库里没记成这个阶段的产出 —— 不给读**", async () => {
    // 否则这个端点就是「照 query 参数读任意文件」，而 query 是浏览器给的。
    const directory = mkdtempSync("/tmp/sp-artifact-");
    const file = join(directory, "secret.md");
    writeFileSync(file, "不该被读到");
    try {
      await withPanel(async ({ open, database }) => {
        produce(database, ["/tmp/something-else.md"]);
        const read = await readArtifact(open, file);
        assert.equal(read.readable, false);
        assert.equal(read.reason, "not_produced_here");
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("**落在项目目录外 —— 不给读**，哪怕库里列着它", async () => {
    /*
     * `artifactIds` 是**模型**写的。一个想歪的模型往里放 `~/.ssh/id_rsa`，
     * 「只读库里列着的」挡不住它 —— 挡得住的是这一条。
     */
    const outside = mkdtempSync(join(tmpdir(), "sp-artifact-outside-"));
    const file = join(outside, "elsewhere.md");
    writeFileSync(file, "在项目外面");
    try {
      await withPanel(async ({ open, database }) => {
        produce(database, [file]);
        const read = await readArtifact(open, file);
        assert.equal(read.readable, false);
        assert.equal(read.reason, "outside_project");
      });
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it("文件不在了 —— 说出来，不给一块空白", async () => {
    // 一块空白和「这份 PRD 是空的」看着一模一样，而两者要做的事完全不同（M7）。
    await withPanel(async ({ open, database }) => {
      produce(database, ["/tmp/sp-artifact-never-written.md"]);
      const read = await readArtifact(open, "/tmp/sp-artifact-never-written.md");
      assert.equal(read.readable, false);
      assert.equal(read.reason, "gone");
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
    await withPanel(async ({ open, pty, database }) => {
      // 没有需求就不许跑（见下面那条测试）。先把它录上。
      new ChangeStore(database).setBrief(CHANGE, "我要一个重新生成按钮");
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

  it("**没有录入需求 —— 不许跑**", async () => {
    await withPanel(async ({ open, pty }) => {
      /*
       * 用户 2026-07-29 发现的洞：进 PRD 阶段没人问他要什么，直接就跑了。
       * 那时红方收到的是一句写死的通用指令，「this change」是哪个 change 从来没被
       * 告知 —— 那份 PRD 只能是编的，而下游每个阶段都写着「Turn the approved PRD
       * into…」。
       *
       * 所以这里拒绝，而不是「有就用、没有就算」：**能绕过的录入等于装饰。**
       */
      const ran = await (await open(`/api/run?change=${CHANGE}`,
        { method: "POST" })).json() as { ran: boolean; reason?: string };
      assert.equal(ran.ran, false);
      assert.match(ran.reason ?? "", /change_has_no_brief/);
      assert.equal(pty.started.length, 0, "一个 Codex 都不该起");
    });
  });

  it("录了需求，它就出现在派出去的提示词里", async () => {
    await withPanel(async ({ open, pty, database }) => {
      new ChangeStore(database).setBrief(CHANGE, "上线前必须能一键回滚");
      void open(`/api/run?change=${CHANGE}`, { method: "POST" }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 120); });

      const prompt = (pty.started.find((entry) => entry.phase === "PRD")?.argv ?? []).join(" ");
      // 模型不再需要猜「this change」是什么。
      assert.match(prompt, /上线前必须能一键回滚/);
    });
  });

  it("rubric 装上了就进提示词 —— 模型答不出它没被问过的题", async () => {
    await withPanel(async ({ open, database, pty }) => {
      new ChangeStore(database).setBrief(CHANGE, "我要一个重新生成按钮");
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

/**
 * 新建 Project / Change。
 *
 * **这不是业务决策入口**：它不推动任何闸门，也不对任何产物下判断 —— 和「选中一个
 * Change」同类。PRD §1.1 那条线管的是「对这一次的产物下判断」，不是「能不能开新活」。
 */
describe("panel · 能从界面上开新活", () => {
  it("建一个 Project，并且一建出来就带上出厂标准", async () => {
    await withPanel(async ({ open, database }) => {
      // 路径必填 —— 一个 Project 就是一个仓库，Codex 跑在这个目录里。
      const created = await (await open(
        `/api/project?name=${encodeURIComponent("新项目")}&path=/tmp`, { method: "POST" },
      )).json() as { created: boolean; id: string; name: string };

      assert.equal(created.created, true);
      assert.equal(created.name, "新项目");
      // 不装出厂标准的话，新项目每个阶段都是空 rubric，人得逐个手写才能开始用。
      assert.ok(
        new RubricStore(database).current({
          projectId: created.id, changeId: null, phase: "PRD", role: "producer",
        }) !== null,
        "新项目没有出厂标准");
    });
  });

  it("建一个 Change，它停在第一个阶段", async () => {
    await withPanel(async ({ open }) => {
      const created = await (await open(
        `/api/change?project=${PROJECT}&title=${encodeURIComponent("加个按钮")}`,
        { method: "POST" },
      )).json() as { created: boolean; id: string; phase: string };

      assert.equal(created.created, true);
      // 起点是状态机给的，这里不替它走一步。
      assert.equal(created.phase, "PRD");

      const panel = await (await open(`/api/panel?change=${created.id}`)).json() as
        { changes: { id: string; title: string }[] };
      assert.ok(panel.changes.some((change) => change.id === created.id));
    });
  });

  it("id 顺号而不是 uuid —— 这两个 id 人要念", async () => {
    await withPanel(async ({ open }) => {
      const first = await (await open(
        `/api/change?project=${PROJECT}&title=a`, { method: "POST" })).json() as { id: string };
      const second = await (await open(
        `/api/change?project=${PROJECT}&title=b`, { method: "POST" })).json() as { id: string };
      assert.match(first.id, /^CHG-\d{3}$/);
      assert.notEqual(first.id, second.id);
    });
  });

  it("名字为空 —— 拒绝，不建一个叫「」的东西", async () => {
    await withPanel(async ({ open }) => {
      assert.equal((await open("/api/project?name=", { method: "POST" })).status, 400);
      assert.equal((await open("/api/project?name=%20%20", { method: "POST" })).status, 400);
      assert.equal(
        (await open(`/api/change?project=${PROJECT}&title=`, { method: "POST" })).status, 400);
    });
  });

  it("往一个不存在的 Project 里建 Change —— 404", async () => {
    await withPanel(async ({ open }) => {
      assert.equal(
        (await open("/api/change?project=PRJ-不存在&title=x", { method: "POST" })).status, 404);
    });
  });
});

/**
 * 接受一条已知风险。
 *
 * **这仍然不是网页上的裁决入口**：网页组题、把题送进那个阶段的终端，选哪一条、
 * 写什么理由都发生在 Codex 自己的选择器里 —— 和 approve / reject 同一条路。
 */
describe("panel · 接受风险也走选择器", () => {
  const openGap = (database: Database.Database, patch: Record<string, unknown>) => {
    new GapStore(database).replace(CHANGE, "PRD", [{
      id: "G-1", kind: "finding", severity: "P1", title: "接口没有错误码",
      status: "open", openedRound: 1, resolution: null,
      ...patch,
    } as never]);
  };

  it("没有可接受的就不问 —— 一道没有选项的题比不问更糟", async () => {
    await withPanel(async ({ open }) => {
      const refused = await (await open(`/api/waive?change=${CHANGE}`,
        { method: "POST" })).json() as { asked: boolean; reason: string };
      assert.deepEqual({ asked: refused.asked, reason: refused.reason },
        { asked: false, reason: "nothing_waivable" });
    });
  });

  it("**P0 不在候选里** —— 严重到不可接受的问题不能靠普通确认绕过", async () => {
    await withPanel(async ({ open, database }) => {
      openGap(database, { severity: "P0" });
      const refused = await (await open(`/api/waive?change=${CHANGE}`,
        { method: "POST" })).json() as { asked: boolean; reason: string };
      assert.equal(refused.reason, "nothing_waivable");
    });
  });

  it("**standard 也不在候选里** —— 它的出口是撤下那条标准，不是接受风险", async () => {
    await withPanel(async ({ open, database }) => {
      openGap(database, { kind: "standard", severity: null });
      const refused = await (await open(`/api/waive?change=${CHANGE}`,
        { method: "POST" })).json() as { asked: boolean; reason: string };
      assert.equal(refused.reason, "nothing_waivable");
    });
  });

  it("有 P1 就组题，并把题送进那个阶段的终端", async () => {
    await withPanel(async ({ open, database, pty }) => {
      openGap(database, {});
      void open(`/api/waive?change=${CHANGE}`, { method: "POST" }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 150); });

      // 题真的落库了，而且是 waive 那一种。
      const asked = database.prepare(
        "SELECT kind, message FROM questions WHERE change_id = ?").get(CHANGE) as
        { kind: string; message: string } | undefined;
      assert.equal(asked?.kind, "waive");
      // 标题列在正文里 —— 只给一串 id 去选，等于让人凭记忆决定。
      assert.match(asked?.message ?? "", /接口没有错误码/);

      // 而且是送进终端，不是网页上直接办了。
      const argv = (pty.started.find((entry) => entry.phase === "PRD")?.argv ?? []).join(" ");
      assert.match(argv, /stagepass_ask/);
    });
  });
});

describe("panel · 「没有这个 Change」不许降级成「没有 rubric」", () => {
  it("读一个不存在的 Change 的 rubric —— 404，不是一份空的", async () => {
    await withPanel(async ({ open }) => {
      /*
       * 空 rubric 是**合法状态**（这个阶段不做判定）；问错了地方不是。
       * 混在一起，界面会摆出一个空编辑器，人填完按保存才收到 404 —— 白填一遍。
       */
      assert.equal((await open("/api/rubric?change=CHG-不存在&phase=Spec")).status, 404);
      // 真的存在的照常给。
      assert.equal((await open(`/api/rubric?change=${CHANGE}&phase=Spec`)).status, 200);
    });
  });
});

/**
 * 一个 Project 就是一个仓库，Codex 跑在它的目录里。
 *
 * 用户 2026-07-30 发现的洞：在这之前 `projects` 只有 id 和 name，而 pty 的 cwd 是
 * 服务启动时定死的一个值。于是新建一个项目、在它下面建 Change、按「跑这个阶段」——
 * **Codex 跑在 stagepass 这个仓库里，用的还是 workspace-write，而且没有任何提示。**
 */
describe("panel · Codex 跑在项目的目录里", () => {
  it("pty 起在项目的 path 上，不是服务启动时那个 cwd", async () => {
    await withPanel(async ({ open, pty }) => {
      // withPanel 把项目的 path 设成 /tmp，而 session.cwd 是 "/tmp" 之外的值时
      // 这条才有意义 —— 所以断言的是「用了项目那个」。
      await open(`/pty/${CHANGE}/PRD`);
      assert.equal(pty.started.length, 1);
      assert.equal(pty.startedCwd[0], "/tmp");
    });
  });

  it("**项目没写路径 —— 不许跑，而且在排队之前就拒**", async () => {
    await withPanel(async ({ open, database, pty }) => {
      new ChangeStore(database).setBrief(CHANGE, "需求有了，但项目没路径");
      // 把路径抹掉，模拟旧库里那些没有 path 的项目。
      database.prepare("UPDATE projects SET path = NULL WHERE id = ?").run(PROJECT);

      const ran = await (await open(`/api/run?change=${CHANGE}`,
        { method: "POST" })).json() as { ran: boolean; reason?: string };
      assert.equal(ran.ran, false);
      assert.match(ran.reason ?? "", /project_has_no_path/);
      assert.equal(pty.started.length, 0, "一个 Codex 都不该起");

      // 状态机也不许动 —— 前置条件不满足不是「这一轮失败了」。
      assert.equal(new ChangeStore(database).read(CHANGE).state.status, "pending");
    });
  });

  it("拿不到路径时连终端都不起 —— 不回落到某个默认目录", async () => {
    await withPanel(async ({ open, database, pty }) => {
      database.prepare("UPDATE projects SET path = NULL WHERE id = ?").run(PROJECT);
      // 回落会让「跑在正确的仓库」和「跑在恰好启动时那个仓库」看起来一模一样。
      assert.equal((await open(`/pty/${CHANGE}/PRD`)).status, 500);
      assert.equal(pty.started.length, 0);
    });
  });
});

describe("panel · 新建 Project 必须给路径", () => {
  it("路径必填", async () => {
    await withPanel(async ({ open }) => {
      assert.equal(
        (await open(`/api/project?name=${encodeURIComponent("新项目")}`,
          { method: "POST" })).status, 400);
    });
  });

  it("相对路径 —— 拒绝（相对谁？相对服务端的 cwd 就又回到那个洞了）", async () => {
    await withPanel(async ({ open }) => {
      assert.equal(
        (await open("/api/project?name=x&path=some/where", { method: "POST" })).status, 400);
    });
  });

  it("不存在的路径 —— 拒绝", async () => {
    await withPanel(async ({ open }) => {
      assert.equal(
        (await open("/api/project?name=x&path=/nope/nowhere", { method: "POST" })).status, 400);
    });
  });

  it("给了一个真目录 —— 建成，并且带上出厂标准", async () => {
    await withPanel(async ({ open, database }) => {
      const created = await (await open(
        `/api/project?name=${encodeURIComponent("新项目")}&path=/tmp`, { method: "POST" },
      )).json() as { created: boolean; id: string; path: string };
      assert.equal(created.created, true);
      // realpath：macOS 上 /tmp 是 /private/tmp 的软链，而 Codex 按真实路径记信任。
      assert.equal(created.path, realpathSync("/tmp"));
      assert.ok(new RubricStore(database).current({
        projectId: created.id, changeId: null, phase: "PRD", role: "producer",
      }) !== null);
    });
  });
});

/**
 * 进程死了，正在看的人要知道。
 *
 * 用户 2026-07-30 报的「Terminal shut down … I can't type anything」：终端确实没了，
 * 但**没有任何一层察觉到**。响应一直开着，浏览器的 reader 永远等不到 done，xterm
 * 停在最后一帧、光标还在 —— 死终端和在思考的终端一模一样，人于是一直等、一直打字。
 *
 * `request.on("close")` 管的是反方向（人走开），救不了这一边。
 */
describe("panel · 终端死了要告诉正在看的人", () => {
  it("**进程退出时那条响应会结束**", async () => {
    await withPanel(async ({ open, pty, base }) => {
      const response = await open(`/pty/${CHANGE}/PRD`);
      const reader = response.body!.getReader();
      pty.emit(new Uint8Array([0x68, 0x69])); // "hi"
      await reader.read();

      // 进程没了。以前这里什么都不会发生，reader 就一直等下去。
      pty.exit();

      const after = await reader.read();
      assert.equal(after.done, true, "响应没结束 —— 浏览器无从知道终端已经死了");
      assert.ok(base);
    });
  });

  it("人先走开时不会去动一个已经关掉的响应", async () => {
    await withPanel(async ({ open, pty }) => {
      const response = await open(`/pty/${CHANGE}/PRD`);
      await response.body!.cancel();          // 人关掉了页面
      await new Promise((resolve) => { setTimeout(resolve, 60); });
      // 这一下不许抛：ender 应该已经被 request close 摘掉了。
      assert.doesNotThrow(() => { pty.exit(); });
    });
  });
});

/**
 * 荒谬的尺寸要拒掉，不能照做。
 *
 * 实测两次：一个尺寸为 0 的浏览器窗口会让 xterm 的 fit 算出 1 列，StagePass 老实
 * 传给 pty，Codex 从此把每个字符单独排一行 —— 画面竖成一条，**而且是持久的**：
 * 窗口恢复之后那一屏已经那样画出去了，字节回放重排不了，看着像终端坏了。
 *
 * `cols > 0` 挡不住它，因为 1 也是「> 0」。
 */
describe("panel · 荒谬的终端尺寸不照做", () => {
  const sizeAfter = async (
    open: (path: string, init?: RequestInit) => Promise<Response>,
    query: string,
  ) => {
    await open(`/pty/${CHANGE}/PRD/resize?${query}`, { method: "POST" });
  };

  it("**cols=1 被拒**", async () => {
    await withPanel(async ({ open, pty }) => {
      await sizeAfter(open, "cols=1&rows=1");
      assert.deepEqual(pty.resized, [], "1 列的终端里什么 TUI 都没法用");
    });
  });

  it("正常尺寸照常生效", async () => {
    await withPanel(async ({ open, pty }) => {
      await sizeAfter(open, "cols=120&rows=40");
      assert.deepEqual(pty.resized.at(-1), { cols: 120, rows: 40 });
    });
  });

  it("负数、NaN、缺参数都拒", async () => {
    await withPanel(async ({ open, pty }) => {
      for (const query of ["cols=-5&rows=40", "cols=abc&rows=40", "rows=40", ""]) {
        await sizeAfter(open, query);
      }
      assert.deepEqual(pty.resized, []);
    });
  });
});
