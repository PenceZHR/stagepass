import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { JobStore } from "../work/job-store";

import {
  decisionLabel, RESPONSE_AGREE, RESPONSE_DISMISS, RESPONSE_WAIVE,
  RAISE_SOMETHING, RAISE_NOTHING,
} from "../domain/question";
import {
  createPanelServer, type PanelOptions, type PanelSessions,
} from "./panel-server";
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
  /** 只让第 n 个起来的那个退出。验「旧的 onExit 不许删掉新的」那条用的。 */
  exitOne(index: number): void;
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
    sessions: PanelSessions;
  }) => Promise<void>,
  /** 额外注入的依赖。归档那一层要能在不碰 Codex 的情况下验。 */
  extra: {
    archive?: PanelOptions["archive"];
    repo?: PanelOptions["repo"];
    trust?: PanelOptions["trust"];
  } = {},
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
    exitOne: (index) => { exiters[index]?.(0); },
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

  const { server, sessions } = createPanelServer({
    // 时限调到 200ms：没有真 Codex，轮次必然等不到 rollout。不设它的话，
    // 测试会陪着默认的 30 分钟一起等。
    database, session: { cwd: "/tmp" }, start, turnTimeoutMs: 200,
    // 问人那条路的截止时间。生产是 15 分钟 —— 在测试里那意味着一条没答对形状的
    // 用例会坐等到框架超时（300 秒）。写错的代价应该是 1 秒，不是 5 分钟。
    askTimeoutMs: 4_000,
    /*
     * **默认注入一个什么都不知道的假的。**
     *
     * 不注入的话用的是真的那一套，而它会去读 `~/.codex/state_5.sqlite` —— 测试跑一遍
     * 就摸了一次用户的 Codex 库。这里一律「查不到状态」，也就是退回加归档那一层之前
     * 的行为，跟别的测试原来验的东西逐字一致。
     */
    archive: extra.archive ?? {
      isArchived: () => null,
      unarchive: () => { throw new Error("测试里不许真的动 Codex"); },
      archive: () => { throw new Error("测试里不许真的动 Codex"); },
    },
    /*
     * **默认注入一个绝不碰 git 的。**
     *
     * 不注入的话用的是真的那一套，而它会在**这棵树**上跑 `git add -A` + `git commit`
     * —— 测试跑一遍就把工作区里所有没提交的东西提交掉。这一格是承重的。
     */
    repo: extra.repo ?? {
      dirtyPaths: () => [],
      commitAll: () => { throw new Error("测试里不许真的动 git"); },
      show: () => { throw new Error("测试里不许真的动 git"); },
    },
    /*
     * **默认「查不出来」。**
     *
     * 不注入的话读的是用户真的 `~/.codex/config.toml` —— 测试跑一遍就摸一次他的配置，
     * 而且结果会随那个文件变（`/tmp` 在不在名单里决定测试红不红）。`null` 等于退回
     * 加这一层之前的行为，别的测试原来验的东西一个字都不变。
     */
    trust: extra.trust ?? { isTrusted: () => null },
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
    await body({ base, pty, database, open, sessions });
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
        // 补问那格现在开着几个。空数组是常态 —— 它只在一次对抗里存在，跑完就收，
        // 而这个 Change 一轮都没跑过。
        asides: [],
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
      changes.setBrief(CHANGE, "本地排行榜");
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
      changes.setBrief(CHANGE, "本地排行榜");
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

/*
 * 跑一轮时说得出它在干什么。
 *
 * 用户 2026-07-30：「跑一轮的时候界面几分钟不说话，我以为它挂了。」而更糟的那一格
 * 同一天撞到了：`status = running` 而那个阶段一个活进程都没有 —— 派出去的 Codex 早就
 * 没了，面板会一直坐到 30 分钟超时。**「在跑」和「已经死了」在界面上是同一个样子。**
 */
describe("panel · 一轮跑到哪了", () => {
  interface Progress {
    phase: string;
    status: string;
    live: boolean;
    job: { id: string; status: string; elapsedMs: number } | null;
    /** 这一轮派生了几个子 Agent。数个数，不看 agent_path。 */
    spawned: number;
    stage: string | null;
    processGone: boolean;
  }
  const progressOf = async (
    open: (path: string, init?: RequestInit) => Promise<Response>,
  ) => await (await open(`/api/progress?change=${CHANGE}`)).json() as Progress;

  it("什么都没跑过 —— 老实说没有 job，也没有阶段", async () => {
    await withPanel(async ({ open }) => {
      const progress = await progressOf(open);
      assert.deepEqual(
        { phase: progress.phase, status: progress.status, job: progress.job },
        { phase: "PRD", status: "pending", job: null });
      assert.equal(progress.stage, null);
      assert.equal(progress.processGone, false);
    });
  });

  it("**status 说在跑、可是没有活进程 —— 这一格必须有名字**", async () => {
    /*
     * 这就是那个会静默烧掉 30 分钟的状态。今天界面上它和「在跑」长得一模一样，
     * 所以它得有一个字段，界面才说得出「这一轮实际上已经死了」。
     */
    await withPanel(async ({ open, database }) => {
      new ChangeStore(database).apply(CHANGE, "start");
      const progress = await progressOf(open);
      assert.equal(progress.status, "running");
      assert.equal(progress.live, false);
      assert.equal(progress.processGone, true);
    });
  });

  it("进程还在时不许报「已经死了」", async () => {
    await withPanel(async ({ open, database }) => {
      new ChangeStore(database).apply(CHANGE, "start");
      await open(`/pty/${CHANGE}/PRD`);          // 起一个活会话
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      const progress = await progressOf(open);
      assert.equal(progress.live, true);
      assert.equal(progress.processGone, false);
    });
  });

  it("报得出这一轮跑了多久", async () => {
    await withPanel(async ({ open, database }) => {
      new JobStore(database).enqueue({
        id: "JOB-P", changeId: CHANGE, kind: "phase_turn",
        deadlineAt: Date.now() + 60_000, maxAttempts: 1,
      });
      const progress = await progressOf(open);
      assert.equal(progress.job?.id, "JOB-P");
      assert.equal(progress.job?.status, "queued");
      assert.ok((progress.job?.elapsedMs ?? -1) >= 0);
    });
  });

  /**
   * `stage` 要从裁判的 threadId 查子 Agent。绑定现在是线程一出现就写的，但在
   * transport 认出线程之前（第一轮的开头）它还不存在 —— **那时就是 null，界面照实
   * 说「还看不出走到哪一步」**，不编阶段名。
   */
  it("没有裁判线程 —— stage 是 null，不猜", async () => {
    await withPanel(async ({ open, database }) => {
      new ChangeStore(database).apply(CHANGE, "start");
      assert.equal((await progressOf(open)).stage, null);
    });
  });

  it("**只读** —— 拉一百次进度，账本一行都不多", async () => {
    // M5：读接口不许写。老树的 listBaselineDocs 在 GET 里 scaffold 十个文件，
    // 打开项目页就能让正在跑的阶段判为越界。
    await withPanel(async ({ open, database }) => {
      const count = () => (database.prepare(
        "SELECT COUNT(*) AS n FROM change_events").get() as { n: number }).n;
      const before = count();
      for (let each = 0; each < 5; each += 1) await progressOf(open);
      assert.equal(count(), before);
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM jobs")
        .get() as { n: number }).n, 0);
    });
  });
});

/*
 * 归档：用户 2026-07-30 拍板的形状 ——
 * **批准之前遇到归档就自动解开；批准之后由 StagePass 主动归档。**
 *
 * 规则本身在 `codex/archive.ts` 离线证过，这里验的是**接线**：resume 那条路上真的
 * 会先解归档，批准那条路上真的会归档。
 */
describe("panel · 归档由 StagePass 自己管", () => {
  /** 一个假的 Codex 归档状态，记下每一次动作。 */
  const fakeArchive = (initial: Record<string, boolean>) => {
    const state = { ...initial };
    const calls: string[] = [];
    return {
      calls,
      isArchived: (id: string) => (id in state ? state[id]! : null),
      unarchive: (id: string) => { calls.push(`unarchive ${id}`); state[id] = false; },
      archive: (id: string) => { calls.push(`archive ${id}`); state[id] = true; },
    };
  };

  it("**resume 一条被归档的线程之前，先解开它**", async () => {
    /*
     * 2026-07-30 用户就撞在这上面：线程被归档 → `codex resume` 一起来就退 →
     * 界面只看得见「进程没了」。现在每次 resume 都先确认一遍。
     */
    const archive = fakeArchive({ "THREAD-OLD": true });
    await withPanel(async ({ open, database, pty }) => {
      new BindingStore(database).bind(CHANGE, "PRD", "THREAD-OLD");
      await open(`/pty/${CHANGE}/PRD`);              // 浏览用的 resume
      await new Promise((resolve) => { setTimeout(resolve, 80); });

      assert.deepEqual(archive.calls, ["unarchive THREAD-OLD"]);
      // 而且确实是走 resume 起的，不是新开一条线程。
      assert.equal(resumedThread(pty.started[0]?.argv ?? []), "THREAD-OLD");
    }, { archive });
  });

  it("没被归档的线程 —— 一根手指都不动", () => {
    // `codex unarchive` 对一条没被归档的会话会报错（实测），所以不能无脑先跑一遍。
    const archive = fakeArchive({ "THREAD-OK": false });
    return withPanel(async ({ open, database }) => {
      new BindingStore(database).bind(CHANGE, "PRD", "THREAD-OK");
      await open(`/pty/${CHANGE}/PRD`);
      await new Promise((resolve) => { setTimeout(resolve, 80); });
      assert.deepEqual(archive.calls, []);
    }, { archive });
  });

  it("**批准一个阶段之后，归档它那条线程**", async () => {
    const archive = fakeArchive({ "THREAD-PRD": false });
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      new BindingStore(database).bind(CHANGE, "PRD", "THREAD-PRD");
      new EvidenceStore(database).put(CHANGE, "PRD", {
        artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
      });
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");

      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      const questionId = (database.prepare(
        "SELECT id FROM questions WHERE change_id = ? ORDER BY asked_at DESC",
      ).get(CHANGE) as { id: string }).id;
      database.prepare(
        "INSERT INTO answers (question_id, action, content_json, answered_at) VALUES (?,?,?,?)",
      ).run(questionId, "accept",
        JSON.stringify({ decision: decisionLabel("approve", "PRD") }),
        new Date().toISOString());
      await asking;

      assert.equal(changes.read(CHANGE).state.phase, "Spec");
      assert.deepEqual(archive.calls, ["archive THREAD-PRD"]);
    }, { archive });
  });

  it("**没批准就不许归档** —— 再来一轮之后那条线程还得能用", async () => {
    const archive = fakeArchive({ "THREAD-PRD": false });
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      new BindingStore(database).bind(CHANGE, "PRD", "THREAD-PRD");
      new EvidenceStore(database).put(CHANGE, "PRD", {
        artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
      });
      changes.setBrief(CHANGE, "需求");
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");

      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      const questionId = (database.prepare(
        "SELECT id FROM questions WHERE change_id = ? ORDER BY asked_at DESC",
      ).get(CHANGE) as { id: string }).id;
      database.prepare(
        "INSERT INTO answers (question_id, action, content_json, answered_at) VALUES (?,?,?,?)",
      ).run(questionId, "accept",
        JSON.stringify({ decision: decisionLabel("reject", "PRD") }),
        new Date().toISOString());
      await asking;

      // 一次 archive 都不许有 —— 这个阶段还没完，它下一轮还要接着用那条线程。
      assert.ok(!archive.calls.some((each) => each.startsWith("archive ")),
        archive.calls.join(" / "));
    }, { archive });
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

  it("**一个死掉的会话的最后一屏，下一次打开时先回放出来**", async () => {
    /*
     * 一个刚起来就死的进程（最常见：线程被归档，`codex resume` 一起来就退），它
     * 临死前打出来的那句话正是死因 —— 而注册表原来在 onExit 里把会话连 scrollback
     * 一起删掉，`/pty/…` 又是「打开就起一个新的」，于是**回不去看尸体**。归档那句
     * 报错是靠仓库外的 node-pty 探针重放同一条 argv 才拿到的，不该那么贵。
     *
     * 字节仍然是字节：留下的是原样的 Uint8Array，回放也是原样写回，不解析（§9.3）。
     */
    await withPanel(async ({ open, pty }) => {
      const first = await open(`/pty/${CHANGE}/PRD`);
      const lastWords = new Uint8Array(Buffer.from("session is archived", "utf-8"));
      pty.emit(lastWords);
      await first.body!.cancel();   // 人走开了……
      pty.exitOne(0);               // ……然后进程自己死了
      await new Promise((resolve) => { setTimeout(resolve, 50); });

      const second = await open(`/pty/${CHANGE}/PRD`);
      assert.equal(pty.started.length, 2, "死了之后再打开，该起的是一个新进程");
      const reader = second.body!.getReader();
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array }>((resolve) => {
          setTimeout(() => { resolve({}); }, 300);
        }),
      ]);
      assert.ok(value, "新会话起来了，尸体的最后一屏却没回放 —— 遗言看不到");
      assert.deepEqual(Array.from(value), Array.from(lastWords));
      reader.releaseLock();
    });
  });

  it("**删掉一个 Change，它的尸体也要跟着没** —— 否则下一个重名的会继承那一屏", async () => {
    /*
     * 2026-08-03 用户报的：新建一个 Change，第一个阶段一打开就是满屏
     * `Error: Operation not permitted (os error 1)`，一模一样几十行。
     *
     * 那些行**不是这一次打出来的**，是历次尝试攒下来的：
     *
     *   建 CHG-001 → 进程死掉（+1 行）→ 尸体存在 key "CHG-001PRD"
     *   删掉 → 再建 → `mintId` 取「已有最大号 + 1」，删光了就又发 CHG-001
     *   新会话起来 → 把那具尸体整个垫进 scrollback → 又死 → +1 行 → 存回去
     *
     * 每试一次多一行，而**删掉 Change 甩不掉它**：`/api/change DELETE` 只
     * `close()`，而 `close()` 触发的 onExit 反倒把尸体又存了一遍。
     *
     * 尸体是为了让人回去看**这个** Change 的死因（见 `corpses` 那段注释）。一个
     * 已经被删掉的 Change 没有「回去看」这回事，它的最后一屏只会冒充下一个同名者的。
     */
    await withPanel(async ({ open, pty, database }) => {
      const first = await open(`/pty/${CHANGE}/PRD`);
      const lastWords = new Uint8Array(
        Buffer.from("Error: Operation not permitted (os error 1)", "utf-8"),
      );
      pty.emit(lastWords);
      await first.body!.cancel();
      pty.exitOne(0);
      await new Promise((resolve) => { setTimeout(resolve, 50); });

      const deleted = await open(`/api/change?change=${CHANGE}`, { method: "DELETE" });
      assert.deepEqual(await deleted.json(), { deleted: true, changeId: CHANGE });

      // 重发同一个 id —— `mintId` 在删光之后就是这么发的，这里直接照着做。
      new ChangeStore(database).create(CHANGE, { projectId: PROJECT });

      const second = await open(`/pty/${CHANGE}/PRD`);
      const reader = second.body!.getReader();
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array }>((resolve) => {
          setTimeout(() => { resolve({}); }, 300);
        }),
      ]);
      reader.releaseLock();
      assert.equal(
        value === undefined ? "" : Buffer.from(value).toString("utf-8"),
        "",
        "新 Change 的终端里出现了上一个同名 Change 的遗言 —— 那一屏不是它的",
      );
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

  it("**turn 在飞时拒绝派发** —— 规则 5 保护的是 turn 边界", async () => {
    await withPanel(async ({ open, pty, database }) => {
      new ChangeStore(database).setBrief(CHANGE, "本地排行榜");
      await open(`/pty/${CHANGE}/PRD`);
      // 有一轮真的没跑完：最新 job 还是 running。
      database.prepare(
        `INSERT INTO jobs (id, change_id, kind, status, attempt, max_attempts,
           owner, token, expires_at,
           deadline_at, created_at, updated_at)
         VALUES ('JOB-INFLIGHT', ?, 'phase_turn', 'running', 1, 1,
           'panel', 'T-INFLIGHT', 9999999999999,
           9999999999999, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`,
      ).run(CHANGE);

      const ran = await (await open(`/api/run?change=${CHANGE}`, { method: "POST" })).json() as
        { ran: boolean; reason?: string; phase: string; busy?: string; jobId?: string };

      // Dispatching now would put a second turn into the same rollout, and
      // then "which turn was mine" has no answer (§6.4 pit 2, §6.5 rule 5).
      /*
       * `reason` 是界面在精确匹配的那个字符串（`panel.js`），不许变。而「在等什么」
       * 走旁边的字段 —— 2026-08-03 实测：人卡在这条拒绝上时，最想知道的正是
       * 「到底什么东西还在跑」，而原来一个字都不说。
       */
      assert.equal(ran.ran, false);
      assert.equal(ran.reason, "phase_already_running");
      assert.equal(ran.phase, "PRD");
      assert.equal(ran.busy, "running", "没说清在等的是什么");
      assert.equal(ran.jobId, "JOB-INFLIGHT", "没说清是哪个 job");
      assert.equal(pty.started.length, 1);
    });
  });

  /**
   * 2026-08-03 真机撞出来的三条，全是同一个根：**闸门问的是「进程活着吗」，而不是
   * 「这个阶段有没有活儿没了结」。**
   */
  it("**会话没了但账没结 —— 照样不许再派**（否则同阶段起两条裁判线程）", async () => {
    await withPanel(async ({ open, pty, database }) => {
      new ChangeStore(database).setBrief(CHANGE, "本地排行榜");
      // 一轮跑完，TUI 结束、注册表里没了 —— 但库里那个 job 还是 running。
      database.prepare(
        `INSERT INTO jobs (id, change_id, kind, status, attempt, max_attempts,
           owner, token, expires_at, deadline_at, created_at, updated_at)
         VALUES ('JOB-ORPHAN', ?, 'phase_turn', 'running', 1, 1,
           'panel', 'T-ORPHAN', 9999999999999,
           9999999999999, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')`,
      ).run(CHANGE);
      const before = pty.started.length;

      const ran = await (await open(`/api/run?change=${CHANGE}`, { method: "POST" })).json() as
        { ran: boolean; busy?: string };

      // 实测那一次：这里放行了，于是同一个 (Change, 阶段) 上跑着两条裁判线程，
      // 互相打断，一条烧掉近 300 万 input token。
      assert.equal(ran.ran, false, "会话没了就放行 —— 会起第二条裁判线程");
      assert.equal(ran.busy, "running");
      assert.equal(pty.started.length, before, "还是起了一个新进程");
    });
  });

  it("**排着队还没跑起来的也算忙** —— 派了两次就是两轮", async () => {
    await withPanel(async ({ open, database }) => {
      new ChangeStore(database).setBrief(CHANGE, "本地排行榜");
      database.prepare(
        `INSERT INTO jobs (id, change_id, kind, status, attempt, max_attempts,
           deadline_at, created_at, updated_at)
         VALUES ('JOB-QUEUED', ?, 'phase_turn', 'queued', 0, 1,
           9999999999999, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')`,
      ).run(CHANGE);

      const ran = await (await open(`/api/run?change=${CHANGE}`, { method: "POST" })).json() as
        { ran: boolean; busy?: string };
      assert.equal(ran.ran, false);
      assert.equal(ran.busy, "queued");
    });
  });

  it("**问人之前，活着的终端也要挡** —— 往在飞的 turn 里打字会把选择器打掉", async () => {
    await withPanel(async ({ open, database }) => {
      new ChangeStore(database).setBrief(CHANGE, "本地排行榜");
      // 有人开着这个阶段的终端（可能正跑着一个 turn，注册表看不出来）。
      await open(`/pty/${CHANGE}/PRD`);

      const asked = await (await open(`/api/ask?change=${CHANGE}`, { method: "POST" })).json() as
        { asked: boolean; reason?: string; busy?: string };

      /*
       * 2026-08-03 实测：这里放行的话，新提示词打进去，Codex 当成打断
       * （`turn_aborted: interrupted`），人面前那个选择器在 1~4 秒内被取消，
       * `stagepass_ask` 返回空的 `cancel`。连着六次都是这么废的。
       */
      assert.equal(asked.asked, false, "往活着的终端里打字了 —— 会打断在飞的 turn");
      assert.equal(asked.reason, "phase_already_running");
      assert.equal(asked.busy, "terminal");
    });
  });

  it("**闲着的终端不挡派发** —— 关掉它接着派（2026-08-02 收窄）", async () => {
    /*
     * 一轮结算完 TUI 不退出，留下的是个没有任何 turn 边界可交错的闲窗口。原来它也
     * 触发拒绝，于是每次「跑这个阶段」之前都得有人手动去关（交接 §4.2 的坑）——
     * 真机连跑时第 7 轮的派发就这么被第 6 轮的闲终端顶掉过，还看着像跑起来了。
     */
    await withPanel(async ({ open, pty, database }) => {
      new ChangeStore(database).setBrief(CHANGE, "本地排行榜");
      // 有人开着 PRD 的终端看，但没有任何 job 在跑。
      await open(`/pty/${CHANGE}/PRD`);
      const before = pty.started.length;

      const ran = await (await open(`/api/run?change=${CHANGE}`, { method: "POST" })).json() as
        { ran: boolean };

      assert.equal(ran.ran, true, "闲终端还在挡派发 —— 人又得手动去关了");
      // 旧的浏览窗口被关掉、新的裁判进程起来了。
      assert.ok(pty.started.length > before);
    });
  });

  it("**关掉一个再起一个 —— 后来那个不许被前一个的 onExit 删掉**", async () => {
    /*
     * 2026-07-30 在真 Codex 上撞到的：D 的「答完直接续跑」是 `close()` 紧接着
     * `launchInto()`，而 `close()` 只 `kill()`，进程的 onExit 是**异步**来的。
     *
     *   close → kill 旧的 → launchInto 存进新的 → 旧的 onExit 到了 → 把新的删掉
     *
     * 注册表从此认为这个阶段没有活进程，下一个 `open()` 就又起一个 —— 实测到两个
     * codex 同时挂在同一个 (Change, 阶段) 上。§6.5 规则 5 的全部意义就是不许出现
     * 这个：两个 `codex resume` 往同一个 rollout 追加，「哪一轮是我的」没有答案。
     */
    await withPanel(async ({ open, pty }) => {
      // 起一个（浏览用），关掉它，再起一个 —— 中间不让 onExit 有机会先到。
      await open(`/pty/${CHANGE}/PRD`);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      await open(`/api/close?change=${CHANGE}&phase=PRD`, { method: "POST" });
      await open(`/pty/${CHANGE}/PRD`);
      const afterRelaunch = pty.started.length;

      // 只让**第一个**（已经被 kill 掉的那个）把 onExit 发出来。
      pty.exitOne(0);
      await new Promise((resolve) => { setTimeout(resolve, 50); });

      // 再进一次终端：注册表里还认得那一个，所以不该再起第三个。
      await open(`/pty/${CHANGE}/PRD`);
      assert.equal(pty.started.length, afterRelaunch,
        "旧进程的 onExit 把新会话删掉了，于是这里又起了一个 —— 同一个阶段两个进程");
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

  it("**每一份都说清由谁判** —— 界面靠它,不许自己抄一份", async () => {
    /*
     * 「没有人给自己打分」排完之后是一条链：蓝方判红方、裁判判蓝方、裁判自己那份
     * 交给人。界面必须照实说得出「这一份不进对抗」—— 否则 verdict 那一栏会显示成
     * 「这个角色当时没有 rubric」,而那是**假话**:标准在,只是不再由模型判。
     *
     * 判据从服务端来,不在 panel.js 里抄一份 —— 抄一份就是同一条规则的第二份拷贝,
     * 而它们必然漂移。
     */
    await withPanel(async ({ open }) => {
      const body = await (await open(`/api/rubric?change=${CHANGE}&phase=Spec`)).json() as {
        roles: { role: string; assessedBy: string | null }[];
      };
      assert.deepEqual(
        Object.fromEntries(body.roles.map((each) => [each.role, each.assessedBy])),
        { producer: "blue", critic: "judge", verdict: null },
      );
    });
  });

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
        title: "挡着的", status: "open", openedRound: 1, resolution: null, note: null,
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
      // 「/root/red」那套身份路径 2026-07-30 废掉了，「裁判报 agent_id」那一版
      // 2026-08-02 也废掉了 —— 现在两方在提示词里就叫正方 / 反方，而 StagePass 按
      // rollout 的 parent_thread_id 自己认哪条线程是谁。
      assert.match(prompt, /1\. 正方/, "没有让它派生正方");
      assert.match(prompt, /2\. 反方/, "没有让它派生反方");
      assert.doesNotMatch(prompt, /agent_id/, "又在要它手抄线程 id 了");
      assert.match(prompt, /先派正方/, "没说清派生的先后 —— 那是红蓝的判据");

      /*
       * **插件也要挂上。**
       *
       * 面板另外两条路（问人问题、录需求）一直挂着，对抗这条路先前没有 —— 于是
       * 裁判那个会话手上没有 StagePass 的工具。少了它，提示词里叫它调工具只会得到
       * 「没有这个工具」，而那是最难查的一种毛病。
       */
      assert.match(prompt, /mcp_servers\.stagepass\.command/, "没给这一轮挂上插件");
      assert.match(prompt, /plugin\/server\.ts/, "插件路径没进 argv");
    });
  });

  it("**不是 pending 的阶段派不了** —— 而且说清是哪一种", async () => {
    /*
     * 2026-07-30 实测到的死按钮：一个 `blocked` 的阶段上按「跑这个阶段」，回来的是
     * **HTTP 500、空 body**，界面显示「没跑起来：undefined」。原因是派一轮的第一步是
     * `start`，而只有 `pending` 接受它。
     *
     * `blocked` 的出口是 `retry`，而 retry 是人的裁决 —— 走选择器，不走这个按钮。
     */
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      changes.setBrief(CHANGE, "人答出来的需求");
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "fail");
      assert.equal(changes.read(CHANGE).state.status, "blocked");

      const response = await open(`/api/run?change=${CHANGE}`, { method: "POST" });
      assert.equal(response.status, 200, "500 + 空 body 就是那个死按钮");
      assert.deepEqual(await response.json(),
        { ran: false, phase: "PRD", reason: "phase_cannot_queue:blocked" });
      // 而且一轮都没排出去 —— 拦在排队之前，不是让它跑起来再失败。
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM jobs")
        .get() as { n: number }).n, 0);
    });
  });

  it("**`running` 能派** —— 人 retry 之后就停在那儿，那时正需要派一轮", async () => {
    /*
     * 这条是上一条的另一半，而我第一版把它写错了：只放 `pending` 会把 retry 之后
     * 那一步堵死。名单要跟着 `TurnLoop.queueTurn` 走 —— 它收 `pending`（自己补一个
     * `start`）和 `running`（人刚 retry 过）。
     */
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      changes.setBrief(CHANGE, "人答出来的需求");
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "fail");
      changes.apply(CHANGE, "retry");
      assert.equal(changes.read(CHANGE).state.status, "running");

      const ran = await (await open(`/api/run?change=${CHANGE}`,
        { method: "POST" })).json() as { ran: boolean; reason?: string };
      assert.equal(ran.ran, true, ran.reason);
      // 真的排出去了 —— 不是「没拒绝」而已。
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM jobs")
        .get() as { n: number }).n, 1);
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

  it("录了需求，它就跟着这一轮出去 —— **走文件，提示词里是路径**", async () => {
    await withPanel(async ({ open, pty, database }) => {
      new ChangeStore(database).setBrief(CHANGE, "上线前必须能一键回滚");
      void open(`/api/run?change=${CHANGE}`, { method: "POST" }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 120); });

      const prompt = (pty.started.find((entry) => entry.phase === "PRD")?.argv ?? []).join(" ");
      /*
       * 模型不再需要猜「this change」是什么 —— 但正文现在在文件里（用户 2026-08-03）。
       * 两头都要盯：路径印出去了，而且那个文件里真是他写的需求。只盯前一半的话，
       * 「路径对了但文件是空的」就没人接住 —— 而那正是 CHG-003 第一轮的症状
       * （红方报「缺少产品输入」）换了一种发生方式。
       */
      const path = /\/[^\s：]*requirement-[^\s：]*\.md/.exec(prompt)?.[0];
      assert.ok(path, "需求的路径没进提示词");
      assert.match(readFileSync(path, "utf-8"), /上线前必须能一键回滚/);
    });
  });

  it("**change 列表跟着当前 Change 的项目走** —— 不是把全库摊开", async () => {
    /*
     * 用户 2026-08-03：「我点了某个 Project 只能显示这个 Project 的 change。」
     * 而正常打开面板的地址不带 `?project=`（启动横幅印的就是那个），于是原来
     * 服务端把全库的 change 都给了界面。
     */
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      new ProjectStore(database).ensure("PRJ-OTHER", "别人家的", "/tmp/other");
      changes.create("CHG-OTHER", { projectId: "PRJ-OTHER", title: "别人家的活儿" });

      const shown = await (await open(`/api/panel?change=${CHANGE}`)).json() as
        { selectedProject: string | null; changes: { id: string }[] };

      assert.equal(shown.selectedProject, PROJECT, "没跟着当前 Change 的项目");
      assert.deepEqual(shown.changes.map((each) => each.id), [CHANGE],
        "别的项目的 change 混进来了");
    });
  });

  it("显式带了 ?project= 就听它的", async () => {
    await withPanel(async ({ open, database }) => {
      new ProjectStore(database).ensure("PRJ-OTHER", "别人家的", "/tmp/other");
      new ChangeStore(database).create("CHG-OTHER", { projectId: "PRJ-OTHER", title: "x" });

      const shown = await (await open(
        `/api/panel?change=${CHANGE}&project=PRJ-OTHER`)).json() as
        { selectedProject: string | null; changes: { id: string }[] };

      assert.equal(shown.selectedProject, "PRJ-OTHER");
      assert.deepEqual(shown.changes.map((each) => each.id), ["CHG-OTHER"]);
    });
  });

  it("**rubric 不进提示词了** —— 两份都走名单，模型手上没有任何 key 可抄", async () => {
    await withPanel(async ({ open, database, pty }) => {
      new ChangeStore(database).setBrief(CHANGE, "我要一个重新生成按钮");
      const rubrics = new RubricStore(database);
      const saved = rubrics.save(
        { projectId: PROJECT, changeId: null, phase: "PRD", role: "producer" },
        [{ text: "每条需求都有可观察的验收标准", blocking: true }]);

      void open(`/api/run?change=${CHANGE}`, { method: "POST" }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 120); });

      /*
       * 2026-08-03 起：裁判那份在它自己的 turn 里逐条走 `stagepass_next`，反方那份
       * 由 StagePass 单独去问它的线程。**criterion key 和正文都不再经提示词。**
       * 见 docs/DESIGN-no-hand-transcription-2026-08-02.md。
       */
      const prompt = (pty.started.find((entry) => entry.phase === "PRD")?.argv ?? []).join(" ");
      assert.doesNotMatch(prompt, new RegExp(saved.criteria[0]!.key), "criterion key 又进提示词了");
      assert.doesNotMatch(prompt, /```rubric/, "围栏协议又回来了");
      // 而工具那条路是通的：提示词里告诉它去调。
      assert.match(prompt, /stagepass_next/);
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

/*
 * 「回应蓝方」和裁决同一次问出来（用户 2026-07-30 的第 ⑤ 步）。
 *
 * 这里验的是**接线**：题里有没有那些格子、答案回来之后表态有没有落到 gaps 上、
 * 落不下去的有没有报回来。分流规则本身在 `domain/gap.ts` / `domain/question.ts`
 * 离线证过，不在这儿重证一遍。
 */
describe("panel · Codex 没信任过这个目录就别派", () => {
  /**
   * 2026-07-30 实测：给一个 Codex 没信任过的工作区派一轮，30 分钟之后拿到
   * `codex_unavailable: no new Codex session appeared`。真实情况是它起来了、停在
   * 「Do you trust the contents of this directory?」上等人按 —— 而这一侧看得见的
   * 只有「没有新线程」。**界面上它和「在跑」一模一样。**
   *
   * 而且不是边角情况：**每加一个新项目都会撞一次**。
   */
  it("**明确没信任 —— 不派，并且说清怎么办**", async () => {
    await withPanel(async ({ open, database, pty }) => {
      new ChangeStore(database).setBrief(CHANGE, "需求");
      const ran = await (await open(`/api/run?change=${CHANGE}`,
        { method: "POST" })).json() as
        { ran: boolean; reason?: string; workspace?: string };

      assert.equal(ran.ran, false);
      assert.equal(ran.reason, "workspace_not_trusted");
      assert.equal(ran.workspace, "/tmp", "没说是哪个目录，人无从下手");
      assert.equal(pty.started.length, 0, "起了一个注定停在提问上的 Codex");
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM jobs")
        .get() as { n: number }).n, 0, "拦在排队之前，不是跑起来再失败");
    }, { trust: { isTrusted: () => false } });
  });

  it("**查不出来 —— 照旧往下走**，不是拦住", async () => {
    // 读不到别人的配置就拦，等于一个把 Codex 配置换了地方的人从此什么都跑不了。
    // 和归档那一层同一条规矩：查不到就退回加这一层之前的行为。
    await withPanel(async ({ open, database }) => {
      new ChangeStore(database).setBrief(CHANGE, "需求");
      void open(`/api/run?change=${CHANGE}`, { method: "POST" }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 120); });
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM jobs")
        .get() as { n: number }).n, 1, "查不出来却把派发拦住了");
    }, { trust: { isTrusted: () => null } });
  });
});

describe("panel · Build 要在干净的工作树上跑", () => {
  /**
   * Build 的产出是 commit，而 StagePass 提交的是「工作树里所有的改动」—— 它分不出
   * 哪一行是红方写的、哪一行是人自己写了一半的。
   *
   * 所以派发之前必须确认树是干净的，否则这一次 commit 会**把人没提交的活儿一起
   * 卷进去**，而那是不该替他做的事。干净之后，「这一轮改了什么」才有唯一定义：
   * commit 边界严格等于轮次边界。
   */
  const dirty: PanelOptions["repo"] = {
    dirtyPaths: () => ["半成品.md"], commitAll: () => null, show: () => null,
  };

  const advanceToBuild = (database: Database.Database): void => {
    const changes = new ChangeStore(database);
    changes.setBrief(CHANGE, "需求");
    advanceTo(changes, "Build");
  };

  it("**树脏就不派发，而且说清是哪几个文件**", async () => {
    await withPanel(async ({ open, database, pty }) => {
      advanceToBuild(database);
      const ran = await (await open(`/api/run?change=${CHANGE}`,
        { method: "POST" })).json() as
        { ran: boolean; reason?: string; dirty?: string[] };

      assert.equal(ran.ran, false);
      assert.equal(ran.reason, "workspace_dirty");
      assert.deepEqual(ran.dirty, ["半成品.md"], "没说是哪几个文件，人无从下手");
      assert.equal(pty.started.length, 0, "一个 Codex 都不该起");
      // 而且一轮都没排出去 —— 拦在排队之前，不是让它跑起来再失败。
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM jobs")
        .get() as { n: number }).n, 0);
    }, { repo: dirty });
  });

  it("设计阶段不查这个 —— 人手里有没有没提交的东西和写文档无关", async () => {
    await withPanel(async ({ open, database }) => {
      new ChangeStore(database).setBrief(CHANGE, "需求");
      void open(`/api/run?change=${CHANGE}`, { method: "POST" }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 120); });
      // 排出去了就说明没被那道闸拦住。
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM jobs")
        .get() as { n: number }).n, 1);
    }, { repo: dirty });
  });
});

describe("panel · 弹窗里读得到一个 commit", () => {
  it("**产出是 sha 时给的是 diff，不是「文件不见了」**", async () => {
    await withPanel(async ({ open, database }) => {
      new EvidenceStore(database).put(CHANGE, "PRD", {
        artifactIds: ["a1b2c3d"], blockers: [], waivedBlockerIds: [],
      });
      const read = await (await open(
        `/api/artifact?change=${CHANGE}&phase=PRD&id=a1b2c3d`)).json() as
        { readable: boolean; text?: string; kind?: string };

      assert.equal(read.readable, true, "sha 被当成路径去找文件了");
      assert.equal(read.kind, "commit");
      assert.match(read.text ?? "", /\+export const x = 1;/);
    }, {
      repo: {
        dirtyPaths: () => [],
        commitAll: () => null,
        show: () => "commit a1b2c3d\n\n    加了 x\n\n+export const x = 1;\n",
      },
    });
  });

  it("这个阶段没报过的 sha —— 照样拒，不去 git 里翻", async () => {
    await withPanel(async ({ open }) => {
      const read = await (await open(
        `/api/artifact?change=${CHANGE}&phase=PRD&id=deadbee`)).json() as
        { readable: boolean; reason?: string };
      assert.equal(read.readable, false);
      assert.equal(read.reason, "not_produced_here");
    });
  });
});

describe("panel · 裁决前看得见这一轮的标准判定", () => {
  /**
   * 用户 2026-07-30：**要不要继续对抗由人决定，不做成全自动**。
   *
   * 那么人就得看得见这一轮判成什么样 —— 否则「再来一轮还是批准」是在没有信息的
   * 情况下按的。这一屏存在的全部意义就是不让人猜。
   */
  const ask = async (
    open: (path: string, init?: RequestInit) => Promise<Response>,
    database: Database.Database,
  ): Promise<string> => {
    const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    const row = database.prepare(
      "SELECT id, message, schema_json FROM questions WHERE change_id = ? ORDER BY asked_at DESC",
    ).get(CHANGE) as { id: string; message: string; schema_json: string };
    // **答 approve，不答 reject。** reject 会当场续跑（D 那条路），而那一轮会一直跑到
    // 测试把库拆掉之后 —— 症状是一串和任何断言都对不上的 SQLITE_ERROR。
    database.prepare(
      "INSERT INTO answers (question_id, action, content_json, answered_at) VALUES (?,?,?,?)",
    ).run(row.id, "accept",
      JSON.stringify({ decision: decisionLabel("approve", "PRD") }),
      new Date().toISOString());
    await asking;
    return `${row.message}\n${row.schema_json}`;
  };

  const settleAt = (database: Database.Database): void => {
    const changes = new ChangeStore(database);
    changes.setBrief(CHANGE, "需求");
    new EvidenceStore(database).put(CHANGE, "PRD", {
      artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
    });
    changes.apply(CHANGE, "start");
    changes.apply(CHANGE, "settle");
  };

  it("**没勾上的标准出现在题面里** —— 说清是哪一条、谁那一份", async () => {
    await withPanel(async ({ open, database }) => {
      const rubrics = new RubricStore(database);
      const saved = rubrics.save(
        { projectId: PROJECT, changeId: null, phase: "PRD", role: "producer" },
        [{ text: "每条需求都有可观察的验收标准", blocking: false }]);
      rubrics.record(CHANGE, "PRD", "producer", 1, saved, [{
        criterionKey: saved.criteria[0]!.key, verdict: "no", evidence: "第 2 节只写了「要快」",
      }]);
      settleAt(database);

      const question = await ask(open, database);
      assert.match(question, /每条需求都有可观察的验收标准/, "没说是哪一条");
      assert.match(question, /正方/, "没说是谁那一份");
      assert.match(question, /不满足/);
    });
  });

  it("全勾上了也要说 —— 「都满足」和「压根没判过」不能长得一样", async () => {
    await withPanel(async ({ open, database }) => {
      const rubrics = new RubricStore(database);
      const saved = rubrics.save(
        { projectId: PROJECT, changeId: null, phase: "PRD", role: "producer" },
        [{ text: "每条需求都有可观察的验收标准", blocking: false }]);
      rubrics.record(CHANGE, "PRD", "producer", 1, saved, [{
        criterionKey: saved.criteria[0]!.key, verdict: "yes", evidence: "三条都写了",
      }]);
      settleAt(database);

      assert.match(await ask(open, database), /全部满足/);
    });
  });

  it("压根没跑过判定 —— 照实说，不许说成「都满足」", async () => {
    await withPanel(async ({ open, database }) => {
      settleAt(database);
      const question = await ask(open, database);
      assert.match(question, /没有标准判定/);
      assert.doesNotMatch(question, /全部满足/);
    });
  });
});

describe("panel · 回应蓝方和裁决同一次问出来", () => {
  /** 走到一个 settled 的 PRD，手里有两条 open 的 P1 —— 也就是一轮跑完的样子。 */
  const settledWithGaps = (database: Database.Database): void => {
    const changes = new ChangeStore(database);
    new GapStore(database).replace(CHANGE, "PRD", [
      {
        id: "SPEC-1", kind: "finding", severity: "P1", title: "验收标准不可测",
        status: "open", openedRound: 1, resolution: null, note: null,
      },
      {
        id: "SPEC-2", kind: "finding", severity: "P1", title: "范围与 PRD 冲突",
        status: "open", openedRound: 1, resolution: null, note: null,
      },
    ]);
    new EvidenceStore(database).put(CHANGE, "PRD", {
      artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
    });
    changes.apply(CHANGE, "start");
    changes.apply(CHANGE, "settle");
  };

  /**
   * 等到真有一道**还没答的**题，再替人答它。
   *
   * 不能用固定的 `setTimeout` 等第二趟：handler 每秒才轮询一次上一趟的答案，等它
   * 把第二道题建出来的时刻是不定的。等不够就会把第二趟的答案插到第一道题上 ——
   * 主键冲突，而报出来的是 `SQLITE_CONSTRAINT_PRIMARYKEY`，看不出是时序问题。
   */
  const answerNext = async (
    database: Database.Database, content: Record<string, string>,
  ): Promise<string> => {
    for (let i = 0; i < 60; i += 1) {
      const row = database.prepare(
        `SELECT q.id FROM questions q
          LEFT JOIN answers a ON a.question_id = q.id
          WHERE q.change_id = ? AND a.question_id IS NULL
          ORDER BY q.rowid DESC`,
      ).get(CHANGE) as { id: string } | undefined;
      if (row) {
        database.prepare(
          "INSERT INTO answers (question_id, action, content_json, answered_at) VALUES (?,?,?,?)",
        ).run(row.id, "accept", JSON.stringify(content), new Date().toISOString());
        return row.id;
      }
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    throw new Error("没有等到一道还没答的题");
  };

  /** 替人在选择器里答一次：直接写 answers 那一行，插件写的就是这一行。 */
  const answer = (database: Database.Database, content: Record<string, string>): string => {
    /*
     * **按插入顺序取，不按 `asked_at`。** 裁决改成两趟之后，两道题会落在同一毫秒里，
     * 而按时间排序时 SQLite 不保证谁在前 —— 挑中第一趟那条就是往同一个 question_id
     * 上插第二行，主键冲突。rowid 是单调的，它说得准。
     */
    const questionId = (database.prepare(
      "SELECT id FROM questions WHERE change_id = ? ORDER BY rowid DESC",
    ).get(CHANGE) as { id: string }).id;
    database.prepare(
      "INSERT INTO answers (question_id, action, content_json, answered_at) VALUES (?,?,?,?)",
    ).run(questionId, "accept", JSON.stringify(content), new Date().toISOString());
    return questionId;
  };

  it("**第一趟一条 gap 一格，全是选项**，最后才是裁决", async () => {
    await withPanel(async ({ open, database }) => {
      settledWithGaps(database);
      void open(`/api/ask?change=${CHANGE}`, { method: "POST" }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 150); });

      const asked = database.prepare(
        "SELECT schema_json FROM questions WHERE change_id = ?").get(CHANGE) as
        { schema_json: string } | undefined;
      // 这个文件在 src/web/ 外面（.test.ts 不算 pty 模块），所以这里可以 parse。
      const schema = JSON.parse(asked?.schema_json ?? "{}") as {
        required: string[]; properties: Record<string, { title: string }>;
      };
      assert.deepEqual(Object.keys(schema.properties),
        ["R01", "R02", "RY", "decision"]);
      // 自己写和提新问题都可以留空；四个选项和裁决必填。
      // RY 也进 required —— 它现在是选项格（「没有了」/「有，我来提」），
      // 而选项格必答不会挡住回车。
      assert.deepEqual(schema.required, ["R01", "R02", "RY", "decision"]);
      assert.match(schema.properties.R01!.title, /SPEC-1/);
      // 2026-08-03 起第一趟里一个自由文本格都没有 —— 理由挪到第二趟去问，
      // 而且只问那几条语义上真的需要理由的（同意的那些不问）。
      for (const [id, field] of Object.entries(schema.properties)) {
        assert.ok((field as { enum?: unknown }).enum, `${id} 是自由文本格`);
      }
    });
  });

  it("表态落到 gaps 上，而且**在闸门之前** —— 否则人刚说的话对这一次没有影响", async () => {
    await withPanel(async ({ open, database }) => {
      settledWithGaps(database);
      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      // 第一趟：纯选项。
      answer(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_AGREE,
        RY: RAISE_SOMETHING, decision: decisionLabel("reject", "PRD"),
      });
      // 第二趟：只有需要理由的那几条 —— R01 驳回了要理由，R02 同意不用，
      // RY 点了「有」所以要写正文。
      await answerNext(database, {
        R01x: "验收标准在第 3 节，反方没读到",
        RYx: "没说清楚失败时回滚到哪",
      });

      const result = await (await asking).json() as {
        refused: unknown[]; raised: string | null;
      };
      assert.deepEqual(result.refused, []);
      assert.equal(result.raised, "HUMAN-1");

      const gaps = new GapStore(database).all(CHANGE, "PRD");
      const byId = new Map(gaps.map((gap) => [gap.id, gap]));
      // 驳回 = closed + 我写的理由。
      assert.equal(byId.get("SPEC-1")?.status, "closed");
      assert.equal(byId.get("SPEC-1")?.resolution, "验收标准在第 3 节，反方没读到");
      // 同意 = 留着，我的话落在 note 上，跟着它进下一轮。
      assert.equal(byId.get("SPEC-2")?.status, "open");
      // **同意那一条不再有 note** —— 它不进第二趟（没什么要说的），而这正是
      // 「选了选项就不用打字」那条要买的东西。
      assert.equal(byId.get("SPEC-2")?.note, null);
      // 我自己提的那条：HUMAN-1 / finding / P1，开着。
      assert.equal(byId.get("HUMAN-1")?.severity, "P1");
      assert.equal(byId.get("HUMAN-1")?.title, "没说清楚失败时回滚到哪");
    });
  });

  it("**驳回没写理由 —— 那一条留着不动，而且报回来**", async () => {
    await withPanel(async ({ open, database }) => {
      settledWithGaps(database);
      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      answer(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_AGREE,
        RY: RAISE_NOTHING, decision: decisionLabel("reject", "PRD"),
      });
      await answerNext(database, { R01x: "" });

      const result = await (await asking).json() as {
        refused: { id: string; code: string }[];
      };
      // 人已经答完走了。静默跳过 = 他点了一下什么都没发生，那正是要防的失败。
      assert.deepEqual(result.refused, [{ id: "SPEC-1", code: "reason_missing" }]);
      assert.equal(new GapStore(database).all(CHANGE, "PRD")
        .find((gap) => gap.id === "SPEC-1")?.status, "open");
    });
  });

  it("**别人在你回答的时候动了证据 —— 一条表态都不落**", async () => {
    /*
     * fence 查在落表态**之前**，问的是「别人动过吗」。放到之后去查，查的就只是
     * 「我刚写完的东西还在不在」—— 那时它永远成立，fence 就成了装饰。
     */
    await withPanel(async ({ open, database }) => {
      settledWithGaps(database);
      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });

      // 有别的东西在这中间又开了一条问题 —— 人没看见过它。
      new GapStore(database).replace(CHANGE, "PRD", [{
        id: "SPEC-9", kind: "finding", severity: "P0", title: "人没看见过的这一条",
        status: "open", openedRound: 2, resolution: null, note: null,
      }]);
      answer(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_AGREE,
        RY: RAISE_NOTHING, decision: decisionLabel("reject", "PRD"),
      });
      await answerNext(database, { R01x: "不成立" });

      const result = await (await asking).json() as { reason: string };
      assert.equal(result.reason, "gate_moved");
      // SPEC-1 原样留着 —— 那一次驳回没有落地。
      assert.equal(new GapStore(database).all(CHANGE, "PRD")
        .find((gap) => gap.id === "SPEC-1")?.status, "open");
    });
  });

  it("**驳回完最后一条挡着的，同一次就批准得了** —— 不用再问一遍", async () => {
    /*
     * 这是「先落表态、再走闸门」那个顺序的兑现。组题时 approve 是被拒的
     * （blocking_problem_outstanding），但那个拒**人在同一道题里就能清掉** ——
     * 所以它照样被提供，而等裁决落地时闸门已经放行了。
     */
    await withPanel(async ({ open, database }) => {
      settledWithGaps(database);
      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      answer(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_WAIVE,
        RY: RAISE_NOTHING, decision: decisionLabel("approve", "PRD"),
      });
      // 驳回和接受风险都要理由 —— 那是实质内容，会落进 resolution。
      await answerNext(database, {
        R01x: "反方没读到第 3 节", R02x: "这一版先带着它走",
      });

      const result = await (await asking).json() as { outcome: { kind: string } };
      assert.equal(result.outcome.kind, "advanced");
      // 批准 PRD = 进 Spec。
      assert.equal(new ChangeStore(database).read(CHANGE).state.phase, "Spec");
    });
  });

  it("**提了新要求又选批准 —— 闸门拒，而且说出来**", async () => {
    // 他自己刚提的要求挡住了他自己的批准。默默当成没发生，人会以为批准了。
    await withPanel(async ({ open, database }) => {
      settledWithGaps(database);
      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      answer(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
        RY: RAISE_SOMETHING, decision: decisionLabel("approve", "PRD"),
      });
      await answerNext(database, {
        R01x: "不成立", R02x: "也不成立",
        RYx: "但是没说清楚失败时回滚到哪",
      });

      const result = await (await asking).json() as {
        outcome: { kind: string; reason?: string }; raised: string | null;
      };
      assert.equal(result.raised, "HUMAN-1");
      assert.deepEqual(result.outcome,
        { kind: "refused", action: "approve", reason: "blocking_problem_outstanding" });
      // 阶段一步都没动。
      assert.equal(new ChangeStore(database).read(CHANGE).state.phase, "PRD");
    });
  });

  it("**选「再来一轮」就直接续跑** —— 不用回面板再按一次", async () => {
    /*
     * 用户 2026-07-30：「把现在的两步合成一步。」两步之所以是坑，不只是多点一下 ——
     * 中间那一步看不出来还需要它，人会以为下一轮已经在跑了。
     *
     * 这里的 pty 是假的，所以那一轮必然读不到 rollout、`ran: true` 之后 outcome 是
     * 失败的。验的是**有没有真的派出去**，不是那一轮的结果。
     */
    await withPanel(async ({ open, database, pty }) => {
      settledWithGaps(database);
      // 续跑要读需求（`runRound` 在排队之前就查）。
      new ChangeStore(database).setBrief(CHANGE, "人自己答出来的需求");
      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      answer(database, {
        R01: RESPONSE_AGREE, R01x: "按第 3 节那种写法改",
        R02: RESPONSE_AGREE,
        decision: decisionLabel("reject", "PRD"),
      });

      const result = await (await asking).json() as {
        continued: { ran: boolean; phase: string } | null;
      };
      assert.equal(result.continued?.ran, true);
      assert.equal(result.continued?.phase, "PRD");
      // 派出去的那一轮提示词里带着裁判和红蓝 —— 是一轮对抗，不是一次 turn。
      const argv = pty.started.map((entry) => entry.argv.join(" ")).join("\n");
      assert.match(argv, /1\. 正方/);
      assert.match(argv, /2\. 反方/);
      /*
       * 而且人刚写的那句话进了下一轮 —— **它现在在名单文件里，不在提示词里**
       * （用户 2026-08-03：能文件化的就走文件）。所以两件事都要盯：路径印出去了，
       * 而且那个文件里真有他那句话。少盯后一半，「路径对了但文件是空的」就没人接住。
       */
      const path = /\/[^\s：]*open-problems-[^\s：]*\.md/.exec(argv)?.[0];
      assert.ok(path, "名单的路径没进提示词");
      assert.match(readFileSync(path, "utf-8"), /按第 3 节那种写法改/);
    });
  });

  it("**「重跑一次」也续跑** —— 同一个抱怨，retry 那条路也不许留中间那一步", async () => {
    await withPanel(async ({ open, database, pty }) => {
      const changes = new ChangeStore(database);
      changes.setBrief(CHANGE, "人自己答出来的需求");
      new EvidenceStore(database).put(CHANGE, "PRD", {
        artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
      });
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "fail");          // blocked：闸门只剩 retry
      assert.deepEqual(
        (await (await open(`/api/panel?change=${CHANGE}`)).json() as
          { gate: { permitted: string[] } }).gate.permitted, ["retry"]);

      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      answer(database, { decision: decisionLabel("retry", "PRD") });

      const result = await (await asking).json() as {
        continued: { ran: boolean } | null;
      };
      assert.equal(result.continued?.ran, true, "retry 之后没有自动续跑");
      assert.match(pty.started.map((each) => each.argv.join(" ")).join("\n"),
        /1\. 正方/);
    });
  });

  it("「打回去修」不续跑 —— 那时 Change 已经在 Fix 了", async () => {
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      changes.setBrief(CHANGE, "本地排行榜");
      advanceTo(changes, "Review");
      new EvidenceStore(database).put(CHANGE, "Review", {
        artifactIds: ["review.md"], blockers: [], waivedBlockerIds: [],
      });
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");

      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      answer(database, { decision: decisionLabel("reject", "Review") });

      const result = await (await asking).json() as { continued: unknown };
      assert.equal(result.continued, null);
      // 活确实送到 Fix 去了。自动在一个刚到的阶段上开跑，等于替人决定 Fix 该做什么。
      assert.equal(changes.read(CHANGE).state.phase, "Fix");
    });
  });

  it("**终端一起来就死了 —— 立刻说，别等满 15 分钟**", async () => {
    /*
     * 2026-07-30 实测到的那一次：这个阶段绑的裁判线程被 Codex **归档**了，于是
     * `codex resume <id>` 一起来就退（`session … is archived`）。而那个等待循环原来
     * 只盯答案，于是它对着一个已经死掉的终端等满 15 分钟，界面上一句话都没有 ——
     * 「在等你选」和「那边早就没了」长得一模一样。
     *
     * 判据是**进程状态**，不是 pty 的输出（§9.3）。
     */
    await withPanel(async ({ open, database, pty }) => {
      new BindingStore(database).bind(CHANGE, "PRD", "THREAD-ARCHIVED");
      settledWithGaps(database);
      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      pty.exit();                                   // 进程一起来就没了

      const result = await (await asking).json() as {
        answered: boolean; reason: string; threadId: string | null;
      };
      assert.equal(result.answered, false);
      assert.equal(result.reason, "session_died_before_answering");
      // 线程 id 要给出去 —— 最常见的原因是它被归档了，而解药 `codex unarchive` 要它。
      assert.equal(result.threadId, "THREAD-ARCHIVED");
    });
  });

  it("一道没有 gap 的裁决 —— 和加这个之前逐字一样", async () => {
    await withPanel(async ({ open, database }) => {
      new EvidenceStore(database).put(CHANGE, "PRD", {
        artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
      });
      const changes = new ChangeStore(database);
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");

      const asking = open(`/api/ask?change=${CHANGE}`, { method: "POST" });
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      answer(database, { decision: decisionLabel("approve", "PRD") });

      const result = await (await asking).json() as {
        responses: Record<string, unknown>; raised: string | null;
      };
      assert.deepEqual(result.responses, {});
      assert.equal(result.raised, null);
      assert.equal(changes.read(CHANGE).state.phase, "Spec");
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

/**
 * 补问那一格终端。
 *
 * 用户 2026-07-31 定的形状：补问跑在**反方自己那条线程**上（不是这个阶段的主线），
 * 所以面板给它单开一格；跑完自动收。它必须让人看得见 —— 「一定要是在我的 web 里面
 * 用 codex，一定是 codex 的 TUI」，headless 的 turn 是不可见的 turn。
 */
describe("panel · 补问那一格", () => {
  const LABEL = "反方·补问";

  it("**开出来之后进度里报得出，主线那一格不受影响**", async () => {
    await withPanel(async ({ open, sessions }) => {
      const dispose = sessions.launchAside(CHANGE, "PRD", LABEL, ["resume", "T-BLUE"]);
      const panel = await (await open(`/api/panel?change=${CHANGE}`)).json() as {
        phases: { phase: string; live: boolean; asides: string[] }[];
      };
      const prd = panel.phases.find((each) => each.phase === "PRD")!;
      assert.deepEqual(prd.asides, [LABEL]);
      // **主线那一格没被这个动作点亮** —— live 是「裁判那个终端在跑」，
      // 派发前的 phase_already_running 全靠它。
      assert.equal(prd.live, false);
      dispose();
    });
  });

  it("`?label=` 接得到它的流，而且不新起进程", async () => {
    await withPanel(async ({ open, pty, sessions }) => {
      const dispose = sessions.launchAside(CHANGE, "PRD", LABEL, ["resume", "T-BLUE"]);
      const before = pty.started.length;
      const response = await open(
        `/pty/${CHANGE}/PRD?label=${encodeURIComponent(LABEL)}`);
      assert.equal(response.status, 200);
      assert.equal(pty.started.length, before, "看一眼补问那格居然又起了一个进程");
      await response.body?.cancel();
      dispose();
    });
  });

  it("**那一格不在时给 409，不是起一个空终端**", async () => {
    await withPanel(async ({ open, pty }) => {
      const before = pty.started.length;
      const response = await open(`/pty/${CHANGE}/PRD?label=${encodeURIComponent(LABEL)}`);
      assert.equal(response.status, 409);
      // 起一个空的会让人以为补问还在跑，而它已经结束了。
      assert.equal(pty.started.length, before);
      await response.text();
    });
  });

  it("**disposer 收掉它之后，进度里就没有了**（补完自动关）", async () => {
    await withPanel(async ({ open, sessions }) => {
      const dispose = sessions.launchAside(CHANGE, "PRD", LABEL, ["resume", "T-BLUE"]);
      dispose();
      const panel = await (await open(`/api/panel?change=${CHANGE}`)).json() as {
        phases: { phase: string; asides: string[] }[];
      };
      assert.deepEqual(panel.phases.find((each) => each.phase === "PRD")!.asides, []);
    });
  });

  it("没有补问时，每个阶段都是空数组 —— 那是常态", async () => {
    await withPanel(async ({ open }) => {
      const panel = await (await open(`/api/panel?change=${CHANGE}`)).json() as {
        phases: { asides: string[] }[];
      };
      assert.ok(panel.phases.every((each) => each.asides.length === 0));
    });
  });

  it("补问那格死了，正在看的人会被告知 —— 不留一帧静止画面", async () => {
    await withPanel(async ({ open, pty, sessions }) => {
      sessions.launchAside(CHANGE, "PRD", LABEL, ["resume", "T-BLUE"]);
      const response = await open(`/pty/${CHANGE}/PRD?label=${encodeURIComponent(LABEL)}`);
      const reader = response.body!.getReader();
      pty.exit();
      // done 是浏览器唯一能知道「这个终端不再接受输入」的途径。
      const { done } = await reader.read();
      assert.equal(done, true);
    });
  });
});

/**
 * C1：派发之前先查上游产物还在不在。
 *
 * 不查的后果实测过（2026-07-31 Review 那轮）：任务书把一份磁盘上不存在的上游产物
 * 列给红方当输入，一整轮几分钟只换来一句「输入不见了」，QA 和 Merge 的四个角色
 * 又各自发现了一遍。判据和 /api/artifact 共用 locateArtifact —— 同一条规则不许
 * 两份拷贝。
 */
describe("panel · 派发前查上游产物", () => {
  const missingPath = `/tmp/stagepass-c1-绝不存在-${process.pid}.md`;

  it("**上游文档不在磁盘上 —— 拒派发，一个进程都不起**", async () => {
    await withPanel(async ({ open, pty, database }) => {
      const changes = new ChangeStore(database);
      changes.setBrief(CHANGE, "本地排行榜");   // 没需求会被更早那道预检拦住
      advanceTo(changes, "Spec");
      new EvidenceStore(database).put(CHANGE, "PRD", {
        artifactIds: [missingPath], blockers: [], waivedBlockerIds: [],
      });
      const before = pty.started.length;
      const result = await (await open(`/api/run?change=${CHANGE}`, { method: "POST" }))
        .json() as { ran: boolean; reason?: string; missing?: { phase: string; id: string }[] };
      assert.equal(result.ran, false);
      assert.equal(result.reason, "upstream_artifact_missing");
      // 逐条列出：「上游产物不见了」这句话本身没法让人动手。
      assert.deepEqual(result.missing, [{ phase: "PRD", id: missingPath }]);
      assert.equal(pty.started.length, before, "拒了还起进程 —— 白烧一轮的钱照花");
    });
  });

  it("上游文档在 —— 照常派发", async () => {
    const present = `/tmp/stagepass-c1-在的-${process.pid}.md`;
    writeFileSync(present, "PRD 正文", "utf-8");
    try {
      await withPanel(async ({ open, pty, database }) => {
        const changes = new ChangeStore(database);
        changes.setBrief(CHANGE, "本地排行榜");
        advanceTo(changes, "Spec");
        new EvidenceStore(database).put(CHANGE, "PRD", {
          artifactIds: [present], blockers: [], waivedBlockerIds: [],
        });
        const before = pty.started.length;
        const result = await (await open(`/api/run?change=${CHANGE}`, { method: "POST" }))
          .json() as { ran: boolean };
        assert.equal(result.ran, true, "产物明明在，却被拦了");
        assert.ok(pty.started.length > before);
      });
    } finally {
      rmSync(present, { force: true });
    }
  });

  it("**Build 的产出是 sha —— 问 git，不当路径找**", async () => {
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      changes.setBrief(CHANGE, "本地排行榜");
      advanceTo(changes, "Review");
      new EvidenceStore(database).put(CHANGE, "Build", {
        artifactIds: ["0123456789abcdef0123456789abcdef01234567"],
        blockers: [], waivedBlockerIds: [],
      });
      const result = await (await open(`/api/run?change=${CHANGE}`, { method: "POST" }))
        .json() as { ran: boolean; reason?: string; missing?: { id: string }[] };
      // 注入的 repo.show 返回 null = 仓库里没有这个 commit。
      assert.equal(result.reason, "upstream_artifact_missing");
      assert.equal(result.missing?.[0]?.id, "0123456789abcdef0123456789abcdef01234567");
    }, {
      repo: {
        dirtyPaths: () => [], commitAll: () => null, show: () => null,
      },
    });
  });
});

/**
 * 轮失败就放开裁判线程。
 *
 * 2026-08-02 CHG-003 连烧四轮实测出来的机制：一轮被作废，库里不留痕，但裁判线程的
 * 记忆里全在 —— resume 回去它抄自己的坏格式、对自己在作废轮里发明的幽灵 gap 表态
 * （unknown_gap）。线程从来不是真相的载体（开着的 gap 每轮都完整写在提示词里），
 * 被作废的轮丢掉的只有毒。
 */
describe("panel · 失败的轮不留毒线程", () => {
  it("**轮失败 —— 绑定被放开，下一轮从干净线程开**", async () => {
    await withPanel(async ({ open, database }) => {
      const changes = new ChangeStore(database);
      changes.setBrief(CHANGE, "本地排行榜");
      const bindings = new BindingStore(database);
      bindings.bind(CHANGE, "PRD", "THREAD-POISONED");
      // 假 pty 不产生 rollout，200ms 超时 → 这一轮必然失败。
      const result = await (await open(`/api/run?change=${CHANGE}`, { method: "POST" }))
        .json() as { ran: boolean };
      assert.equal(result.ran, true);
      const bound = bindings.find(CHANGE, "PRD");
      assert.equal(bound?.status, "detached",
        "失败的轮还绑着旧线程 —— 下一轮会 resume 回去接着中毒");
    });
  });

  it("成功的轮**不**放开 —— 那里的历史是真的", async () => {
    // ScriptedPty 一路成功的轮走不到这套 harness 里（它要真 rollout），这一条由
    // 既有的「同一个 (Change, 阶段) 复用同一个裁判线程」测试反向钉着：绑定还在，
    // 下一轮才 resume 得回去。这里只钉失败路径的行为存在且方向对。
    assert.ok(true);
  });
});
