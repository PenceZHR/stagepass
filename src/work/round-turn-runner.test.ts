import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { BLUE } from "../domain/round";
import { ScriptedCodexTransport, type CodexTransport, type TurnDispatch } from "../codex/transport";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
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

const judgeSays = '```json\n{"verdicts":{}}\n```';
const answer = (blockers: { id: string; severity: string; title: string }[] = []) =>
  "```json\n" + JSON.stringify({ artifactIds: ["prd.md"], blockers }) + "\n```";

function runner(
  context: ReturnType<typeof open>,
  transport: CodexTransport,
  readRole: (thread: string, path: string) => string,
  repo?: RepoOps,
): RoundTurnRunner {
  return new RoundTurnRunner({
    transport,
    gaps: context.gaps,
    rubrics: context.rubrics,
    changes: context.changes,
    bindings: context.bindings,
    evidence: new EvidenceStore(context.db),
    // 测试**绝不碰真 git**：默认给一个什么都不做的。
    repo: repo ?? { dirtyPaths: () => [], commitAll: () => null, show: () => null },
    workspaceFor: () => "/tmp/stagepass-not-a-real-repo",
    readRole,
    taskFor: () => "写 PRD",
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
        (_thread, path) => (path === BLUE ? blueSays[blueRead++]! : answer()),
      ),
    });

    await dispatchRound(loop, "J1");
    // 人裁决「再来一轮」：settled -> pending，下一次派发会再记一条 start。
    context.changes.apply(CHANGE, "reject");
    await dispatchRound(loop, "J2");

    const opened = Object.fromEntries(
      context.gaps.all(CHANGE, "PRD").map((gap) => [gap.id, gap.openedRound]),
    );
    assert.equal(opened["S-1"], 1);
    assert.equal(opened["S-2"], 2, "第二轮发现的问题被记成了第 1 轮");
  });

  it("失败重跑也算得进去 —— retry 之后那一轮是第 2 轮", async () => {
    const context = open();
    const loop = new TurnLoop({
      database: context.db,
      runner: runner(
        context,
        new ScriptedCodexTransport([new Error("codex_died"), judgeSays]),
        (_thread, path) =>
          path === BLUE
            ? answer([{ id: "S-1", severity: "P1", title: "重跑那一轮发现的" }])
            : answer(),
      ),
    });

    await dispatchRound(loop, "J1"); // 这一轮失败，Change 落到 blocked
    assert.equal(context.changes.read(CHANGE).state.status, "blocked");
    context.changes.apply(CHANGE, "retry");   // 人的裁决：重跑一次
    await dispatchRound(loop, "J2");

    assert.equal(
      context.gaps.all(CHANGE, "PRD").find((gap) => gap.id === "S-1")?.openedRound,
      2,
      "失败后的重跑没算进轮次",
    );
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

    const prompt = transport.dispatches[0]?.prompt ?? "";
    assert.match(prompt, /docs\/prd\/countdown\.md/, "上游产物的路径没进任务书");
    assert.match(prompt, /PRD/, "没说这份产物是哪个阶段的");
  });

  it("走到 TestPlan 时，四份上游按线的顺序全在", async () => {
    const context = open();
    const evidence = new EvidenceStore(context.db);
    const line: [string, string][] = [
      ["PRD", "docs/prd.md"], ["Spec", "docs/spec.md"],
      ["TechSpec", "docs/techspec.md"], ["Plan", "docs/plan.md"],
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

    const prompt = transport.dispatches[0]?.prompt ?? "";
    const positions = line.map(([, artifact]) => prompt.indexOf(artifact));
    assert.ok(positions.every((at) => at >= 0),
      `有上游没进任务书：${JSON.stringify(positions)}`);
    // 顺序就是线的顺序 —— 读的人按它从头到尾走一遍。
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
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
      transport.dispatches[0]?.prompt ?? "", /上游/,
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
    for (const phase of ["PRD", "Spec", "TechSpec", "Plan", "TestPlan"] as const) {
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
      show: () => null,
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

  it("设计阶段不走这条路 —— 产出仍然是红方报的那个路径", async () => {
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
    assert.deepEqual(repo.calls, [], "设计阶段也去 commit 了");
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
