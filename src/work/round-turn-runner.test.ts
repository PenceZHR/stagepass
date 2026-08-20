import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ScriptedCodexTransport, type CodexTransport, type TurnDispatch } from "../codex/transport";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { EvidenceStore } from "../store/evidence-store";
import { RoundNoteStore } from "../store/round-note-store";
import { StageArtifactStore } from "../store/stage-artifact-store";
import { WorklistStore } from "../store/worklist-store";
import { GapStore } from "../store/gap-store";
import type { Gap } from "../domain/gap";
import type { Phase } from "../domain/phase";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";
import { TurnLoop } from "./turn-loop";
import { RoundTurnRunner } from "./round-turn-runner";
import type { RepoOps } from "./repo";

/**
 * RoundTurnRunner：把「跑这个阶段」接成一轮对抗的那根线。
 *
 * 这里专门验它自己那两条容易撒谎的地方：**轮次号**（REMAP §3.5「按轮读」建在这个
 * 数上）和**绑定写入的时机**（/api/progress 的 stage 靠它才说得出话）。
 */

const PROJECT = "PRJ-RT";
const CHANGE = "CHG-RT";

function open() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  new ProjectStore(db).ensure(PROJECT, "p");
  const changes = new ChangeStore(db);
  changes.create(CHANGE, { projectId: PROJECT });
  changes.setBrief(CHANGE, "人答出来的需求");
  return {
    db,
    changes,
    gaps: new GapStore(db),
    rubrics: new RubricStore(db),
    bindings: new BindingStore(db),
  };
}

/**
 * 把 Change 一路推到 QA（离线手段，L1 的假答案纪律）。
 *
 * **「轮次号」那两条测试要在 QA 上跑**：它们靠反方的自由 blockers 当载体，而那条
 * 通道只在**反方够得着代码**的阶段还留着（`blue.investigates`）—— 环 v3 里主线上
 * 只剩 QA 一个（Review 收编进它了）。测的事情没变：轮次从账本数，和哪个阶段无关。
 */
function toQA(context: ReturnType<typeof open>): void {
  const evidence = new EvidenceStore(context.db);
  while (context.changes.read(CHANGE).state.phase !== "QA") {
    const phase = context.changes.read(CHANGE).state.phase;
    context.changes.apply(CHANGE, "start");
    context.changes.apply(CHANGE, "settle");
    evidence.put(CHANGE, phase, {
      artifactIds: [`docs/stagepass/${CHANGE}/${phase}-r1.md`],
      blockers: [], waivedBlockerIds: [],
    });
    context.changes.apply(CHANGE, "approve");
  }
}

const RED_THREAD = "T-RED";
const BLUE_THREAD = "T-BLUE";
/**
 * 裁判的答复。**它不再报任何线程 id**（2026-08-02）—— StagePass 按 rollout 的
 * `parent_thread_id` 自己认，见 docs/DESIGN-no-hand-transcription-2026-08-02.md §三。
 */
const judgeSays = '```json\n' + JSON.stringify({ verdicts: {} }) + '\n```';

/**
 * 裁判线程累积的子 Agent —— **每问一次就多两条**。
 *
 * 真实的裁判线程就是这样长的（2026-08-02 实测见过一条挂着 7 个子 Agent），而
 * `runRound` 靠 turn 前后的差集挑出「这一次派生的那一对」。一个每次都返回同样两条
 * 的替身，会让第二轮的差集变成空 —— 那正是这个替身该盯住的事。
 *
 * 只涨不减，所以不管 `runRound` 一轮问几次，差集永远恰好是最新的那一对。
 */
function growingChildren(): () => string[] {
  const children: string[] = [];
  return () => {
    const pair = children.length / 2 + 1;
    children.push(`${RED_THREAD}-${pair}`, `${BLUE_THREAD}-${pair}`);
    return [...children];
  };
}
const answer = (blockers: { id: string; severity: string; title: string }[] = []) =>
  "```json\n" + JSON.stringify({ artifactIds: ["prd.md"], blockers }) + "\n```";

/**
 * runner 写给模型读的文件，按路径记在内存里（测试绝不碰真文件系统）。
 *
 * 题面走文件之后（2026-08-13），会话里只送一个信封 —— 任务书内容的断言全要
 * 来这里找，盯着 `dispatches[].prompt` 只能看到信封。每次 `runner()` 换新的一张。
 */
let written = new Map<string, string>();

/**
 * 第 `round` 轮的题面正文。没落成文件就当场喊出来，别让断言去匹配 undefined。
 * 不给轮次 = 这个 runner 只派过一轮，取那唯一的一份 —— 轮次号从账本数
 * （sendBack 重开的阶段第一派就是第 2 轮），只派一轮的测试犯不着自己算它。
 */
function roundScript(round?: number): string {
  const paths = [...written.keys()].filter((each) => each.includes("round-script-"));
  const path = round === undefined
    ? (paths.length === 1 ? paths[0] : undefined)
    : paths.find((each) => each.endsWith(`-r${round}.md`));
  assert.ok(path !== undefined,
    `题面没对上（现有 ${paths.length} 份，要的是${round === undefined ? "唯一一份" : `第 ${round} 轮`}）`);
  return written.get(path!)!;
}

function runner(
  context: ReturnType<typeof open>,
  transport: CodexTransport,
  readThread: (threadId: string) => string,
  repo?: RepoOps,
  log?: (line: string) => void,
): RoundTurnRunner {
  written = new Map();
  return new RoundTurnRunner({
    transport,
    gaps: context.gaps,
    rubrics: context.rubrics,
    changes: context.changes,
    bindings: context.bindings,
    evidence: new EvidenceStore(context.db),
    notes: new RoundNoteStore(context.db),
    // 测试**绝不碰真 git**：默认给一个什么都不做的。
    repo: repo ?? {
      dirtyPaths: () => [], commitAll: () => null, commitPaths: () => null,
      show: () => null, head: () => null, trackedFiles: () => null,
      changedFiles: () => null, fileAt: () => null, fileBefore: () => null,
      diffAt: () => null,
    },
    workspaceFor: () => "/tmp/stagepass-not-a-real-repo",
    childThreads: growingChildren(),
    writeRoundFile: (name: string, content: string) => {
      const path = `/tmp/stagepass-test/${name}`;
      written.set(path, content);
      return path;
    },
    // 读回永远是「没写」：答卷是模型往真文件系统里填的，替身这侧没有那只手。
    // （不回 written 的内容 —— rubric 那条路会预写一份空答卷，读回它就把
    // 「反方没写」偷换成「读到空模板」。）
    readRoundFile: () => null,
    worklist: new WorklistStore(context.db),
    readThread,
    // 这些用例不问送达 —— 它们问的是这个 runner 有没有把各层接对。
    readThreadWhole: readThread,
    taskFor: () => "写 PRD",
    ...(log === undefined ? {} : { log }),
  });
}

/** 派一轮并跑完。queueTurn + runOnce，和面板的 runRound 同一条路。 */
async function dispatchRound(loop: TurnLoop, jobId: string): Promise<void> {
  const at = Date.now();
  loop.queueTurn({
    changeId: CHANGE, jobId, deadlineAt: at + 60_000, maxAttempts: 1,
  });
  await loop.runOnce({ owner: "test", token: jobId, now: at, ttlMs: 60_000 });
}

describe("RoundTurnRunner · 轮次从账本数，不用 job.attempt", () => {
  /**
   * 实测过的谎：每次「跑这个阶段」都新建一个 job，attempt 恒等于 1，于是 CHG-002
   * 跑了两轮，`gaps.opened_round` 全是 1 —— 「第几轮发现的」这句话在库里是假的。
   * 账本 append-only：这个阶段第几次落到 running，就是第几轮。
   */
  it("驳回之后再跑 —— 第二轮发现的问题记在第 2 轮", async () => {
    const context = open();
    toQA(context);
    const blueSays = [
      answer([{ id: "S-1", severity: "P1", title: "第一轮发现的" }]),
      answer([{ id: "S-2", severity: "P1", title: "第二轮发现的" }]),
    ];
    let blueRead = 0;
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(
        context,
        new ScriptedCodexTransport([judgeSays, judgeSays]),
        (threadId) => (threadId.startsWith(BLUE_THREAD) ? blueSays[blueRead++]! : answer()),
      ),
    });

    await dispatchRound(loop, "J1");
    // 「再来一轮」就是 `reject`：环 v3 里它在每个阶段都是原地重开（送修 → Fix
    // 那条路连同 rerun 一起拆了），QA 也不例外。
    context.changes.apply(CHANGE, "reject");
    await dispatchRound(loop, "J2");

    const opened = Object.fromEntries(
      context.gaps.all(CHANGE, "QA").map((gap) => [gap.id, gap.openedRound]),
    );
    assert.equal(opened["S-1"], 1);
    assert.equal(opened["S-2"], 2, "第二轮发现的问题被记成了第 1 轮");
  });

  it("失败重跑也算得进去 —— retry 之后那一轮是第 2 轮", async () => {
    const context = open();
    toQA(context);
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(
        context,
        new ScriptedCodexTransport([new Error("codex_died"), judgeSays]),
        (threadId) =>
          threadId.startsWith(BLUE_THREAD)
            ? answer([{ id: "S-1", severity: "P1", title: "重跑那一轮发现的" }])
            : answer(),
      ),
    });

    await dispatchRound(loop, "J1"); // 这一轮失败，Change 落到 blocked
    assert.equal(context.changes.read(CHANGE).state.status, "blocked");
    context.changes.apply(CHANGE, "retry");   // 人的裁决：重跑一次
    await dispatchRound(loop, "J2");

    assert.equal(
      context.gaps.all(CHANGE, "QA").find((gap) => gap.id === "S-1")?.openedRound,
      2,
      "失败后的重跑没算进轮次",
    );
  });
});

/**
 * 取题面那条路的轮次（2026-08-19 真机抓到的）。
 *
 * ## 它是什么样的错
 *
 * 「轮次从账本数」成立的前提是 **`queueTurn` 已经把这一轮的 start 写进去了** ——
 * 派轮那条路正是这个顺序。取题面**不建 job**（StagePass 那时确实什么都没在跑），
 * 于是同一段代码数出来的是上一轮的号：真机上第一次点，信封写着「第 0 轮」，
 * 名单和题面文件也全落在 0 上。
 *
 * 而结算时 `queueTurn` 会补上那个 start，同一段代码这次数出 1 —— **名单读回来
 * 是空的，题面文件对不上号，账本上看不出哪里错了。** 这正是这条路唯一承重的那个
 * 号，所以它有自己的护栏。
 */
describe("RoundTurnRunner · 备的那一轮和收的那一轮必须是同一个号", () => {
  it("**第一次取题面是第 1 轮，不是第 0 轮**", () => {
    const context = open();
    toQA(context);
    const prepared = runner(context, new ScriptedCodexTransport([]), () => answer())
      .prepare({ id: "H-1", changeId: CHANGE, phase: "QA" } as never);

    assert.equal(prepared.round, 1);
    assert.match(prepared.envelope, /第 1 轮/);
  });

  it("**结算用备的时候那个号，不重数** —— 中间账本长了也不许漂", () => {
    const context = open();
    toQA(context);
    const only = runner(context, new ScriptedCodexTransport([]), () => answer());
    const prepared = only.prepare({ id: "H-1", changeId: CHANGE, phase: "QA" } as never);

    // 结算时 `queueTurn` 会补一条 start，账本从此数得出 1；再多跑一轮就是 2。
    // 无论账本涨到几，收的都必须是备的那一轮 —— 名单和文件都落在它上面。
    context.changes.apply(CHANGE, "start");
    context.changes.apply(CHANGE, "settle");
    context.changes.apply(CHANGE, "reject");
    context.changes.apply(CHANGE, "start");

    const again = only.prepare({ id: "H-2", changeId: CHANGE, phase: "QA" } as never);
    assert.notEqual(again.round, prepared.round, "账本长了，下一次备的该是新的号");
    assert.match(again.envelope, new RegExp(`第 ${again.round} 轮`));
  });
});

describe("RoundTurnRunner · 上游已批准的产物要进任务书", () => {
  /**
   * 每个阶段一条新线程（§6.5 规则 2），线程之间只能靠文档传信息 ——
   * binding-store 的注释写明「every phase's opening prompt has to carry its
   * upstream documents itself」。PRD 只靠 brief 就够；Spec 起，红方被要求
   * 「Turn the approved PRD into…」，**却没人告诉它 PRD 在哪** —— 它只能去猜，
   * 而「凭空生成」正是这个产品要防的事。
   */
  it("Spec 的任务书里列着 PRD 的产物路径", async () => {
    const context = open();
    // 把 Change 摆到 Spec：PRD 跑过、批准过（离线手段，L1 的假答案纪律）。
    context.changes.apply(CHANGE, "start");
    context.changes.apply(CHANGE, "settle");
    new EvidenceStore(context.db).put(CHANGE, "PRD", {
      artifactIds: ["docs/prd/countdown.md"], blockers: [], waivedBlockerIds: [],
    });
    context.changes.apply(CHANGE, "approve");
    assert.equal(context.changes.read(CHANGE).state.phase, "Spec");

    const transport = new ScriptedCodexTransport([judgeSays]);
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, transport, () => answer()),
    });
    await dispatchRound(loop, "J1");

    const prompt = roundScript(1);   // 会话里只送信封，任务书在题面文件里
    assert.match(prompt, /docs\/prd\/countdown\.md/, "上游产物的路径没进任务书");
    assert.match(prompt, /PRD/, "没说这份产物是哪个阶段的");
  });

  it("**被打回的阶段，打回的理由从账本走进了提示词**（§5.5 最后一米）", async () => {
    const context = open();
    const evidence = new EvidenceStore(context.db);
    // PRD 批准 → Spec 批准 → Build 结算，然后人把活打回 Spec 并写下理由。
    for (const [phase, artifact] of [["PRD", "docs/prd.md"], ["Spec", "docs/spec.md"]] as const) {
      context.changes.apply(CHANGE, "start");
      context.changes.apply(CHANGE, "settle");
      evidence.put(CHANGE, phase, {
        artifactIds: [artifact], blockers: [], waivedBlockerIds: [],
      });
      context.changes.apply(CHANGE, "approve");
    }
    // 把 Change 一路推到 Build（中间几段不带产物，够用）。
    for (const phase of ["Arch", "BuildPlan", "TestPlan"] as const) {
      context.changes.apply(CHANGE, "start");
      context.changes.apply(CHANGE, "settle");
      evidence.put(CHANGE, phase, { artifactIds: ["x.md"], blockers: [], waivedBlockerIds: [] });
      context.changes.apply(CHANGE, "approve");
    }
    context.changes.apply(CHANGE, "start");
    context.changes.apply(CHANGE, "settle");
    context.changes.apply(CHANGE, "sendBack",
      { to: "Spec", reason: "接口边界在 Spec 里就画错了，别再往下修补" });
    assert.equal(context.changes.read(CHANGE).state.phase, "Spec");

    const transport = new ScriptedCodexTransport([judgeSays]);
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, transport, () => answer()),
    });
    await dispatchRound(loop, "J1");

    // 会话里只送信封，任务书在题面文件里。sendBack 重开的 Spec 是第 2 轮，
    // 轮次号在文件名里 —— 不指定，取这一派唯一的那份。
    const prompt = roundScript();
    assert.match(prompt, /被 Build 打回来的/, "红方不知道是谁退的它");
    // **原话，不是转述** —— 而且要出现两遍（裁判自己读一次、转达原文一次）。
    assert.equal(prompt.split("接口边界在 Spec 里就画错了，别再往下修补").length - 1, 2);
    assert.match(prompt, /不是从零重写/);
  });

  /**
   * §8.6·①：任务书里列的是**真正的上游**，不是主线顺序的前缀。
   *
   * 两轨互盲（环 v3）：TestPlan 和 BuildPlan 都只消费 Arch，互不消费 ——
   * BuildPlan 的文档不该出现在 TestPlan 红方的输入里。多喂一份它用不上的文档，
   * 既占上下文又暗示「你该照着它做」，而测试照着施工计划写，独立性就没了。
   */
  it("走到 TestPlan 时，**真正的**上游按线的顺序全在，BuildPlan 不在", async () => {
    const context = open();
    const evidence = new EvidenceStore(context.db);
    const line: [string, string][] = [
      ["PRD", "docs/prd.md"], ["Spec", "docs/spec.md"],
      ["Arch", "docs/arch.md"], ["BuildPlan", "docs/buildplan.md"],
    ];
    for (const [phase, artifact] of line) {
      context.changes.apply(CHANGE, "start");
      context.changes.apply(CHANGE, "settle");
      evidence.put(CHANGE, phase as Parameters<typeof evidence.put>[1], {
        artifactIds: [artifact], blockers: [], waivedBlockerIds: [],
      });
      context.changes.apply(CHANGE, "approve");
    }
    assert.equal(context.changes.read(CHANGE).state.phase, "TestPlan");

    const transport = new ScriptedCodexTransport([judgeSays]);
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, transport, () => answer()),
    });
    await dispatchRound(loop, "J1");

    const prompt = roundScript(1);   // 会话里只送信封，任务书在题面文件里
    const real = line.filter(([phase]) => phase !== "BuildPlan");
    const positions = real.map(([, artifact]) => prompt.indexOf(artifact));
    assert.ok(positions.every((at) => at >= 0),
      `有上游没进任务书：${JSON.stringify(positions)}`);
    // 顺序就是线的顺序 —— 读的人按它从头到尾走一遍。
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    // **BuildPlan 不在。** 它产出过、也被批准过，就是不属于 TestPlan 的上游。
    assert.equal(
      prompt.includes("docs/buildplan.md"), false,
      "TestPlan 收到了 BuildPlan 的文档 —— 互盲被投递层破掉了",
    );
  });

  it("**上游是一个 commit 时，说它是 commit** —— 别让红方拿 sha 去找文件", async () => {
    /*
     * Build 的产出是 sha，而这一节的抬头写着「已批准的上游文档（先读完再动手）」——
     * 红方会拿着 `349c17d7…` 当文件名去找，然后报一条「文件不存在」。
     * 判据和服务端读产出那一条同一个（`looksLikeSha`），不另算一套。
     */
    const context = open();
    const evidence = new EvidenceStore(context.db);
    for (const [phase, artifact] of [
      ["PRD", "docs/prd.md"], ["Spec", "docs/spec.md"], ["Arch", "docs/arch.md"],
      ["BuildPlan", "docs/buildplan.md"], ["TestPlan", "docs/tp.md"],
      ["Build", "349c17d7d10414882f2c91f3241fda2645534645"],
      ["Test", "docs/tests-r1.md"],
    ] as const) {
      context.changes.apply(CHANGE, "start");
      context.changes.apply(CHANGE, "settle");
      evidence.put(CHANGE, phase, {
        artifactIds: [artifact], blockers: [], waivedBlockerIds: [],
      });
      context.changes.apply(CHANGE, "approve");
    }
    assert.equal(context.changes.read(CHANGE).state.phase, "QA");

    const transport = new ScriptedCodexTransport([judgeSays]);
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, transport, () => answer()),
    });
    await dispatchRound(loop, "J1");

    const prompt = roundScript(1);   // 会话里只送信封，任务书在题面文件里
    assert.match(prompt, /commit 349c17d7/, "sha 没被标成 commit");
    assert.match(prompt, /git show/, "没告诉红方怎么看这个 commit");
    // 而路径那些照旧原样列出来。
    assert.match(prompt, /docs\/prd\.md/);
  });

  it("PRD 自己没有上游 —— 任务书里不出现上游那一节", async () => {
    const context = open();
    const transport = new ScriptedCodexTransport([judgeSays]);
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, transport, () => answer()),
    });
    await dispatchRound(loop, "J1");

    assert.doesNotMatch(
      roundScript(1), /上游/,
      "没有上游却画了一节空的，模型会去找不存在的东西",
    );
  });
});

describe("RoundTurnRunner · Build 的产出是 commit", () => {
  /**
   * 用户 2026-07-30 拍板：Build 一轮的产出记成 commit。
   *
   * 文件列表说不出「改了什么」（同一个路径改前改后都是它），diff 说不出「基于哪一版」。
   * commit 两样都有，还多了稳定 id、能 revert、能进 fence。
   *
   * **红方自己报的 artifactIds 被换掉，不是并列。** 并列会让同一轮的产出有两种说法，
   * 而下游（弹窗、fence、下一轮的蓝方）得挑一个信 —— 那正是「一个概念一个名字」要挡的。
   */
  const atBuild = (context: ReturnType<typeof open>): void => {
    const evidence = new EvidenceStore(context.db);
    for (const phase of ["PRD", "Spec", "Arch", "BuildPlan", "TestPlan"] as const) {
      context.changes.apply(CHANGE, "start");
      context.changes.apply(CHANGE, "settle");
      evidence.put(CHANGE, phase, {
        artifactIds: [`${phase}.md`], blockers: [], waivedBlockerIds: [],
      });
      context.changes.apply(CHANGE, "approve");
    }
    assert.equal(context.changes.read(CHANGE).state.phase, "Build");
  };

  /** 记下每一次调用的假 git。测试绝不碰真仓库。 */
  const fakeRepo = (sha: string | null) => {
    const calls: string[] = [];
    return {
      calls,
      dirtyPaths: () => [],
      commitAll: (_cwd: string, message: string) => {
        calls.push(`commit ${message}`);
        return sha;
      },
      commitPaths: (_cwd: string, paths: readonly string[], message: string) => {
        calls.push(`commitPaths ${paths.join(",")} ${message}`);
        return sha;
      },
      show: () => null, head: () => null, trackedFiles: () => null,
      changedFiles: () => sha === null ? null : [
        { path: "src/feature.ts", change: "added" as const },
      ],
      fileAt: () => null, fileBefore: () => null, diffAt: () => null,
    };
  };

  it("**红方报的路径被换成 commit 的 sha**", async () => {
    const context = open();
    atBuild(context);
    const repo = fakeRepo("a1b2c3d4e5f6");
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([judgeSays]),
        () => answer(), repo),
    });
    await dispatchRound(loop, "J1");

    assert.deepEqual(
      new EvidenceStore(context.db).read(CHANGE, "Build").artifactIds,
      ["a1b2c3d4e5f6"],
      "产出还是红方自己报的路径",
    );
    // 提交信息要说得出是哪个 Change 的第几轮 —— 人在 git log 里看得懂。
    assert.match(repo.calls[0] ?? "", new RegExp(CHANGE));
    const manifest = new StageArtifactStore(context.db).read(CHANGE, "Build", 1);
    assert.ok(manifest);
    assert.equal(manifest.jobId, "J1");
    assert.equal(manifest.commit, "a1b2c3d4e5f6");
    assert.deepEqual(manifest.upstream.map((entry) => entry.phase),
      ["PRD", "Spec", "Arch", "BuildPlan"]);
    assert.deepEqual(manifest.files.map((file) => [file.path, file.role]), [
      [`docs/stagepass/${CHANGE}/Build-r1-opposition.md`, "critic"],
      [`docs/stagepass/${CHANGE}/Build-r1.md`, "producer"],
      ["src/feature.ts", "delivery"],
    ]);
  });

  it("**红方什么都没改 —— 不许伪装成有产出**", async () => {
    const context = open();
    atBuild(context);
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([judgeSays]),
        () => answer(), fakeRepo(null)),
    });
    await dispatchRound(loop, "J1");

    // 闸门不放行一个什么都没产出的阶段，而这正是那一格该有的样子。
    assert.deepEqual(
      new EvidenceStore(context.db).read(CHANGE, "Build").artifactIds, []);
  });

  it("**Test 也记 commit** —— 它和 Build 同形状：红方写的是（测试）代码", async () => {
    /*
     * 用户 2026-07-30 的通则判据：红方在这一阶段写的是代码，产出就是 commit。
     * 环 v3 把「写测试代码」从 TestPlan 拆给 Test —— 名单换成 {Build, Test}
     * （Fix 退休、TestPlan 收窄成纯文档），这条钉的就是新名单的 Test 那半。
     */
    const context = open();
    const evidence = new EvidenceStore(context.db);
    for (const phase of ["PRD", "Spec", "Arch", "BuildPlan", "TestPlan", "Build"] as const) {
      context.changes.apply(CHANGE, "start");
      context.changes.apply(CHANGE, "settle");
      evidence.put(CHANGE, phase, {
        artifactIds: [`${phase}.md`], blockers: [], waivedBlockerIds: [],
      });
      context.changes.apply(CHANGE, "approve");
    }
    assert.equal(context.changes.read(CHANGE).state.phase, "Test");

    const repo = fakeRepo("7e57c0dec0ff17");
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([judgeSays]),
        () => answer(), repo),
    });
    await dispatchRound(loop, "J1");

    assert.deepEqual(
      new EvidenceStore(context.db).read(CHANGE, "Test").artifactIds,
      ["7e57c0dec0ff17"], "Test 的产出还是红方报的路径");
    /*
     * **而且走的是窄提交**（批 4 · 案 B）：产物目录 + 红方声明的落点，逐个点名 ——
     * 结构上卷不走别人的半成品，这正是它不要求干净树、能和 Build 并行的机械前提。
     * 走了 commitAll 就是把等式改回「两个整树阶段共用一个工作区」那个洞。
     */
    assert.match(repo.calls[0] ?? "", /^commitPaths/,
      "Test 走了整树提交 —— 案 B 的窄提交被丢了");
    assert.match(repo.calls[0] ?? "", /prd\.md/, "红方声明的落点没进提交名单");
  });

  it("**Build 撞上对轨 mid-round —— 响亮失败，不静默卷**（批 4 · 案 B 挡门）", async () => {
    const context = open();
    const evidence = new EvidenceStore(context.db);
    for (const phase of ["PRD", "Spec", "Arch", "BuildPlan", "TestPlan"] as const) {
      context.changes.apply(CHANGE, "start");
      context.changes.apply(CHANGE, "settle");
      evidence.put(CHANGE, phase, {
        artifactIds: [`${phase}.md`], blockers: [], waivedBlockerIds: [],
      });
      context.changes.apply(CHANGE, "approve");
    }
    assert.equal(context.changes.read(CHANGE).state.phase, "Build");

    const repo = fakeRepo("b011d54a");
    const base = runner(context, new ScriptedCodexTransport([judgeSays]),
      () => answer(), repo);
    // 对轨（Test 座）正在跑一轮 —— 树上有它写了一半的文件。
    const guarded = new RoundTurnRunner({
      ...(base as unknown as { options: ConstructorParameters<typeof RoundTurnRunner>[0] }).options,
      seatStatus: (_change, seatPhase) => seatPhase === "Test" ? "running" : null,
    });
    const loop = new TurnLoop({ database: context.db, runner: guarded });
    await dispatchRound(loop, "J1");

    // 这一轮失败、Change 落到 blocked，错误里说得出是对轨挡的 —— 人等对轨收工再 retry。
    assert.equal(context.changes.read(CHANGE).state.status, "blocked");
    assert.ok(!repo.calls.some((call) => call.startsWith("commit ")),
      "挡门没拦住 —— 整树提交把对轨的半成品卷进去了");
  });

  it("设计阶段不换 sha —— 产出仍然是红方报的那个路径", async () => {
    /*
     * 2026-08-05 被 E 改写过：原断言是「设计阶段不碰 repo」（`repo.calls` 为空）。
     * 现在设计阶段轮末**窄提交产物目录**（commitPaths，treeE 的测试盯着），
     * 但这一条守的东西没变：**证据不换 sha**。commit 只是让树干净的记账，
     * 产物形态还是路径 —— 下游全按路径找。
     */
    const context = open();
    const repo = fakeRepo("a1b2c3d4e5f6");
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([judgeSays]),
        () => answer(), repo),
    });
    await dispatchRound(loop, "J1");   // 还在 PRD

    assert.deepEqual(
      new EvidenceStore(context.db).read(CHANGE, "PRD").artifactIds, ["prd.md"]);
    assert.ok(!repo.calls.some((call) => call.startsWith("commit ")),
      "设计阶段走了 commitAll —— 整树提交会把人的活儿卷进去");
  });
});

describe("RoundTurnRunner · 线程一出现就绑上，不等整轮跑完", () => {
  /**
   * 绑定原来写在 run 的最后一行，于是第一轮跑到一半时没有裁判 threadId ——
   * `/api/progress` 的 `stage` 只能是 null，而一轮要跑几分钟，正是人最想知道
   * 「走到哪了」的那几分钟。更糟的是中途死掉的第一轮**什么都不留**：线程明明
   * 建出来了，下一次却只能重新开一条。
   */
  it("一轮中途死掉，绑定已经在了", async () => {
    const context = open();
    const transport: CodexTransport = {
      runTurn: async (dispatch: TurnDispatch) => {
        dispatch.onThread?.("T-JUDGE");
        throw new Error("died_mid_round");
      },
    };
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, transport, () => answer()),
    });

    await dispatchRound(loop, "J1");

    assert.equal(context.changes.read(CHANGE).state.status, "blocked");
    const bound = context.bindings.find(CHANGE, "PRD");
    assert.equal(bound?.threadId, "T-JUDGE", "线程建了，StagePass 却没记下来");
    assert.equal(bound?.status, "bound");
  });
});

/*
 * 这里原来有一条「带 aside 的 turn 不去坐裁判的绑定座位」。
 *
 * 2026-08-03 起**生产代码里没有任何地方产生 aside 了** —— 那条路
 * （StagePass 自己 resume 反方线程逐条问）被证实走不通：Codex 禁止外部驱动子
 * Agent 线程。规则本身还写在 `RoundTurnRunner` 里（那个包装仍按 aside 分流），
 * 但**没有任何输入能走到它**，所以这条测试留着就是一条永远跑不到的用例。
 *
 * 连带地：`launchAside` / `closeAside` / 面板的补问格标签页 / `?label=` 那两条路由，
 * 整套 aside 机制现在都没有使用者。**要不要整个撤掉是一个单独的决定**，见交接。
 */

/**
 * 坏格式不许在裁判自己的线程里循环。
 *
 * 2026-08-02 CHG-003 实测：Build 阶段 critic 那份**连续三轮全部作废**（12 条
 * `not_assessed`），同一个抄漏一段的 UUID 连抄三轮；另一处是少了右花括号的信封
 * 连写两轮。这些轮**都是成功的**，所以 `panel-server.ts` 那条「job 失败才放开
 * 线程」的路一次都没触发，而模型 resume 回去看见的正是自己上一轮那么写的。
 */
describe("RoundTurnRunner · 形状坏了就放开裁判线程", () => {
  /** 裁判的信封没关严 —— `readVerdicts` 读不出来，但这一轮不失败。 */
  const brokenEnvelope = '```json\n{"verdicts":{"G-1":{"kind":"closed","reason":"修了"}}}}\n```';

  it("**信封读不出来 —— 轮次成功，但线程被放开**", async () => {
    const context = open();
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([brokenEnvelope]), () => answer()),
    });

    await dispatchRound(loop, "J1");

    // 轮次是成功的 —— 这正是这条路要接住的那一种。
    assert.notEqual(context.changes.read(CHANGE).state.status, "blocked");
    assert.equal(context.bindings.find(CHANGE, "PRD")?.status, "detached");
  });

  it("**读得懂的一轮不放线程** —— 那里的历史是真的，要接着用", async () => {
    const context = open();
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([judgeSays]), () => answer()),
    });

    await dispatchRound(loop, "J1");

    assert.equal(context.bindings.find(CHANGE, "PRD")?.status, "bound");
  });

  it("**下一轮真的从新线程开** —— 这才是放开它的意义", async () => {
    const context = open();
    const transport = new ScriptedCodexTransport([brokenEnvelope, judgeSays]);
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, transport, () => answer()),
    });

    await dispatchRound(loop, "J1");
    context.changes.apply(CHANGE, "reject");
    await dispatchRound(loop, "J2");

    // 第一轮开了一条新线程（threadId 是 null），第二轮**也**必须是 null ——
    // 不放开的话这里会是第一轮那条中毒线程的 id。
    assert.equal(transport.dispatches[1]!.threadId, null);
  });

  it("放开这件事记进账本 —— 人不该看见一次无缘无故的换线程", async () => {
    const context = open();
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([brokenEnvelope]), () => answer()),
    });

    await dispatchRound(loop, "J1");

    const notes = new RoundNoteStore(context.db).read(CHANGE, "PRD", 1);
    const said = notes.map((note) => note.text).join("\n");
    assert.match(said, /verdicts_unreadable/);
    assert.match(said, /已放开裁判线程/);
    // 「还要不要再来一轮」在这里没有答案 —— 记 false 会被渲染成「可以了」。
    assert.equal(notes.find((note) => /已放开裁判线程/.test(note.text))?.anotherRound, null);
  });
});

describe("L4 · E：产物有家，轮末自己入档，越界要报出来", () => {
  /**
   * E（产物污染干净树）的执行端。四件事各一条：
   *
   *   任务书给红方指路      设计阶段的文档写到 docs/stagepass/<change>/<Phase>-r<N>.md
   *   轮末窄提交            只提交那个目录，树外的（人的活儿）一个字节不碰
   *   Build 一个字不改      producesCommit 阶段照旧 commitAll + 换 sha
   *   越界当场报出来        轮里新冒出来的、目录外的文件 —— 报给人，不自动收拾
   */
  const trackingRepo = (dirtySeq: string[][]) => {
    const calls: string[] = [];
    let reads = 0;
    return {
      calls,
      dirtyPaths: () => dirtySeq[Math.min(reads++, dirtySeq.length - 1)] ?? [],
      commitAll: (_cwd: string, message: string) => {
        calls.push(`commitAll ${message}`);
        return "deadbeefcafe";
      },
      commitPaths: (_cwd: string, paths: readonly string[], message: string) => {
        calls.push(`commitPaths ${paths.join(",")} ${message}`);
        return "beefdeadcafe";
      },
      show: () => null, head: () => null, trackedFiles: () => null,
      changedFiles: () => [], fileAt: () => null, fileBefore: () => null,
      diffAt: () => null,
    };
  };

  const openLoop = (repo: RepoOps, log?: (line: string) => void) => {
    const context = open();
    const transport = new ScriptedCodexTransport([judgeSays]);
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, transport, () => answer(), repo, log),
    });
    return { context, transport, loop };
  };

  it("**设计阶段：任务书里有确切的输出路径** —— 不让红方自己起名", async () => {
    const { loop } = openLoop(trackingRepo([[]]) as unknown as RepoOps);
    await dispatchRound(loop, "J1");
    const prompt = roundScript(1);   // 会话里只送信封，任务书在题面文件里
    assert.match(prompt, /docs\/stagepass\/CHG-RT\/PRD-r1\.md/,
      "红方的输出路径没进任务书 —— 它又要自己起名了");
    assert.match(prompt, /docs\/stagepass\/CHG-RT\/PRD-r1-opposition\.md/,
      "反方的输出路径没进裁判的提示词");
  });

  it("**设计阶段轮末只提交产物目录** —— 证据仍然是路径，不换 sha", async () => {
    const repo = trackingRepo([[]]);
    const { context, loop } = openLoop(repo as unknown as RepoOps);
    await dispatchRound(loop, "J1");

    assert.deepEqual(repo.calls, ["commitPaths docs/stagepass/CHG-RT StagePass CHG-RT PRD 第 1 轮"],
      "该窄提交产物目录，而且只提交它");
    // 证据照旧是红方报的路径 —— commit 只是让树干净的记账，不是产物形态的改变。
    assert.deepEqual(
      new EvidenceStore(context.db).read(CHANGE, "PRD").artifactIds,
      ["prd.md"]);
  });

  it("**越界的文件当场报出来，人的旧文件不背锅**", async () => {
    /*
     * 轮前就脏的（人写了一半的）不报 —— 报了就是把人的活儿说成模型的违规。
     * 轮里新冒出来、又不在产物目录里的，才是越界（用户 2026-08-04：
     * 「当场报出来，不自动收拾」）。
     */
    const said: string[] = [];
    const repo = trackingRepo([
      ["人写了一半.md"],                       // 轮前快照
      ["人写了一半.md", "乱写的笔记.md"],      // 轮后：多了一个目录外的
    ]);
    const { loop } = openLoop(repo as unknown as RepoOps, (line) => said.push(line));
    await dispatchRound(loop, "J1");

    const report = said.join("\n");
    assert.match(report, /乱写的笔记\.md/, "越界文件没被报出来");
    assert.doesNotMatch(report, /人写了一半\.md/, "人的旧文件被说成了模型的违规");
  });

  it("什么都没越界 —— 一个字都不说", async () => {
    const said: string[] = [];
    const { loop } = openLoop(
      trackingRepo([[], []]) as unknown as RepoOps, (line) => said.push(line));
    await dispatchRound(loop, "J1");
    assert.deepEqual(said, []);
  });
});

describe("RoundTurnRunner · 编辑过门（批 6）", () => {
  it("**Arch 轮末开门，而裁判的名单里没有它** —— 模型判不了「人编辑没编辑」", async () => {
    const context = open();
    const evidence = new EvidenceStore(context.db);
    for (const phase of ["PRD", "Spec"] as const) {
      context.changes.apply(CHANGE, "start");
      context.changes.apply(CHANGE, "settle");
      evidence.put(CHANGE, phase, {
        artifactIds: [`${phase}.md`], blockers: [], waivedBlockerIds: [],
      });
      context.changes.apply(CHANGE, "approve");
    }
    assert.equal(context.changes.read(CHANGE).state.phase, "Arch");

    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([judgeSays, judgeSays]),
        () => answer()),
    });
    await dispatchRound(loop, "J1");

    const gate = context.gaps.all(CHANGE, "Arch").find((gap) => gap.id === "EDIT-1");
    assert.equal(gate?.status, "open", "Arch 轮末没开编辑过门");
    assert.equal(gate?.severity, "P1", "门要是 P1 —— waive 是人的出口");

    // 第二轮：门还开着（人没编辑），但**裁判的名单里没有它** —— 它是人和机器
    // 之间的门，不是对抗的一部分。
    context.changes.apply(CHANGE, "reject");
    await dispatchRound(loop, "J2");
    const asked = new WorklistStore(context.db).read(CHANGE, "Arch", 2)
      .map((item) => item.target);
    assert.ok(!asked.includes("EDIT-1"),
      "编辑过门被送进了裁判的名单 —— 一个没有依据的表态会把门顺手关掉");
  });

  it("设计阶段的别家（Spec）不开门 —— 名单只有 Arch", async () => {
    const context = open();
    context.changes.apply(CHANGE, "start");
    context.changes.apply(CHANGE, "settle");
    new EvidenceStore(context.db).put(CHANGE, "PRD", {
      artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
    });
    context.changes.apply(CHANGE, "approve");
    assert.equal(context.changes.read(CHANGE).state.phase, "Spec");

    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([judgeSays]), () => answer()),
    });
    await dispatchRound(loop, "J1");
    assert.ok(!context.gaps.all(CHANGE, "Spec").some((gap) => gap.id === "EDIT-1"));
  });
});

describe("L4 · 下游判给这个阶段的问题，打回时跟着过来（环 v3 的反馈回路）", () => {
  /**
   * 真机上的洞（2026-08-11）：QA 打回 Build 之后，Build 的红方看到的是**空名单** ——
   * QA 那二十几条一条都传不过去，唯一穿过去的是人写的那句理由（那次是「直接打回」
   * 四个字），于是红方把上一版原样交了回来，两版哈希一模一样。
   *
   * 判据：`returnStack` 上欠着回程的那几个阶段里，`owner` 指着本阶段的 open gap。
   */
  /** 这个阶段跑到第几轮了 —— 名单是按轮存的，写死 1 会在打回之后错位。 */
  const roundOf = (context: ReturnType<typeof open>, phase: Phase): number =>
    context.changes.ledger(CHANGE)
      .filter((entry) => entry.to.phase === phase && entry.to.status === "running").length;
  const finding = (id: string, title: string, owner: string | null): Gap => ({
    id, kind: "finding", severity: "P1", title,
    status: "open", openedRound: 1, resolution: null, note: null,
    closedBy: null, where: null, why: null, owner,
  });

  it("**QA 判给 Build 的进了 Build 这一轮的名单**，判给 Test 的不进", async () => {
    const context = open();
    context.gaps.replace(CHANGE, "QA", [
      finding("Q-1", "代码这儿错了", "Build"),
      finding("Q-2", "测试这儿错了", "Test"),
      finding("Q-3", "QA 自己要补的", null),
    ]);
    /*
     * 走真的状态机推到「Build 欠着 QA 的回程」——**直接 UPDATE changes 会被账本
     * 触发器当场拒**（`ck_changes_ledger`），而那正是它存在的理由：没有账的状态
     * 变化不许发生，测试也不例外。
     */
    toQA(context);
    context.changes.apply(CHANGE, "start");
    context.changes.apply(CHANGE, "settle");
    context.changes.apply(CHANGE, "sendBack", { to: "Build", reason: "代码错了" });

    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([judgeSays]), () => answer()),
    });
    await dispatchRound(loop, "J1");

    const round = roundOf(context, "Build");
    const asked = new WorklistStore(context.db).read(CHANGE, "Build", round)
      .map((item) => item.target);
    assert.ok(asked.includes("Q-1"), `判给 Build 的没送到：${JSON.stringify(asked)}`);
    assert.ok(!asked.includes("Q-2"),
      "判给 Test 的送到了 Build 手上 —— 那是把测试的问题摆到施工方眼前，破互盲");
    assert.ok(!asked.includes("Q-3"), "没判归属的是 QA 自己的活儿，不该派给 Build");
  });

  it("不欠回程时一条都不带 —— 正常前进的轮次不该背上下游的旧账", async () => {
    const context = open();
    context.gaps.replace(CHANGE, "QA", [finding("Q-1", "代码这儿错了", "Build")]);
    // 沿主线正常走到 Build（不欠任何回程）。
    const evidence = new EvidenceStore(context.db);
    while (context.changes.read(CHANGE).state.phase !== "Build") {
      const at = context.changes.read(CHANGE).state.phase;
      context.changes.apply(CHANGE, "start");
      context.changes.apply(CHANGE, "settle");
      evidence.put(CHANGE, at, {
        artifactIds: [`docs/stagepass/${CHANGE}/${at}-r1.md`],
        blockers: [], waivedBlockerIds: [],
      });
      context.changes.apply(CHANGE, "approve");
    }

    const loop = new TurnLoop({
      database: context.db,
      runner: runner(context, new ScriptedCodexTransport([judgeSays]), () => answer()),
    });
    await dispatchRound(loop, "J1");
    assert.ok(!new WorklistStore(context.db).read(CHANGE, "Build", roundOf(context, "Build"))
      .map((item) => item.target).includes("Q-1"));
  });
});
