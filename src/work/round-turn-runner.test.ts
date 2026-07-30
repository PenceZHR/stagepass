import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { BLUE } from "../domain/round";
import { ScriptedCodexTransport, type CodexTransport, type TurnDispatch } from "../codex/transport";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";
import { TurnLoop } from "./turn-loop";
import { RoundTurnRunner } from "./round-turn-runner";

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
): RoundTurnRunner {
  return new RoundTurnRunner({
    transport,
    gaps: context.gaps,
    rubrics: context.rubrics,
    changes: context.changes,
    bindings: context.bindings,
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
