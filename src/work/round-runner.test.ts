import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { RESULT_CONTRACT } from "../domain/turn";
import { ScriptedCodexTransport } from "../codex/transport";
import { ChangeStore } from "../store/change-store";
import { GapStore } from "../store/gap-store";
import { RoundAgentsNotFoundError, runRound } from "./round-runner";

/**
 * L4 offline: a whole adversarial round, minus the one thing only a real Codex
 * can answer (whether a judge really spawns two sub-agents).
 */

const CHANGE = "CHG-R";
const AT = "2026-07-29T00:00:00.000Z";

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  const changes = new ChangeStore(db, { now: () => new Date(AT) });
  changes.create(CHANGE);
  return db;
}

/** A role transcript in the shape the result contract asks for. */
function answer(input: {
  artifactIds?: string[];
  blockers?: { id: string; severity: string; title: string }[];
}): string {
  return "```json\n" + JSON.stringify({
    artifactIds: input.artifactIds ?? [],
    blockers: input.blockers ?? [],
  }) + "\n```";
}

/**
 * 裁判的答复。**它不再报任何线程 id** —— 那一版把 36 字符的 UUID 放进了模型必须
 * 手抄的文本里，见 docs/DESIGN-no-hand-transcription-2026-08-02.md。
 */
function verdicts(record: Record<string, { kind: string; reason: string }> = {}): string {
  return "```json\n" + JSON.stringify({ verdicts: record }) + "\n```";
}

const RED_THREAD = "T-RED";
const BLUE_THREAD = "T-BLUE";

/**
 * 裁判线程累积的子 Agent —— **每跑一轮多两条**。
 *
 * 真实的裁判线程就是这样长的（2026-08-02 实测见过一条挂着 7 个子 Agent），而
 * `runRound` 靠 turn 前后的差集挑出「这一次派生的那两条」。一个每次都返回同样两条
 * 的替身会让第二轮的差集变成空 —— 那正是这个替身该盯住的事。
 */
const spawnedBy = (transport: { dispatches: readonly unknown[] }) => (): string[] =>
  Array.from(
    { length: transport.dispatches.length },
    (_, round) => [`${RED_THREAD}-${round + 1}`, `${BLUE_THREAD}-${round + 1}`],
  ).flat();

/** 按线程 id 给出那一方说的话。轮次编号在后缀里，这里只认前缀。 */
const roles = (red: string, blue: string) =>
  (threadId: string): string => {
    if (threadId.startsWith(RED_THREAD)) return red;
    if (threadId.startsWith(BLUE_THREAD)) return blue;
    throw new Error(`unexpected thread ${threadId}`);
  };

describe("L4 · a round turns blue's attack into gaps the gate can read", () => {
  it("opens what blue found, and blocks the gate with it", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    const settled = await runRound(
      { changeId: CHANGE, phase: "Spec", round: 1, task: "写 Spec", judgeThreadId: null },
      {
        transport,
        gaps,
        childThreads: spawnedBy(transport),
        readThread: roles(
          answer({ artifactIds: ["spec.md"] }),
          answer({ blockers: [{ id: "SPEC-1", severity: "P1", title: "验收不可测" }] }),
        ),
      },
    );

    assert.equal(settled.judgeThreadId, "JUDGE-1");
    assert.deepEqual(settled.artifactIds, ["spec.md"]);
    assert.deepEqual(settled.blockers.map((b) => b.id), ["SPEC-1"]);
    // and it is state, not just a return value
    assert.deepEqual(gaps.blockers(CHANGE, "Spec").map((b) => b.id), ["SPEC-1"]);
  });

  it("puts the open gaps to the judge, and asks red for the contract shape", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({}), verdicts({})], "JUDGE-1");
    const dependencies = {
      transport,
      gaps,
      childThreads: spawnedBy(transport),
      readThread: roles(
        answer({ artifactIds: ["spec.md"] }),
        answer({ blockers: [{ id: "SPEC-1", severity: "P1", title: "验收不可测" }] }),
      ),
    };
    const request = {
      changeId: CHANGE, phase: "Spec" as const, task: "写 Spec", judgeThreadId: null,
    };

    await runRound({ ...request, round: 1 }, dependencies);
    await runRound({ ...request, round: 2, judgeThreadId: "JUDGE-1" }, dependencies);

    // Round 1 had nothing open to judge; round 2 must carry round 1's finding.
    assert.match(transport.dispatches[0]!.prompt, /没有未关闭的问题/);
    assert.match(transport.dispatches[1]!.prompt, /SPEC-1 \[P1\] 验收不可测/);
    // Red is told the shape to answer in, or its result is unreadable later.
    assert.ok(transport.dispatches[0]!.prompt.includes(RESULT_CONTRACT));
  });

  it("closes a gap only when the judge says why", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([
      verdicts({}),
      verdicts({ "SPEC-1": { kind: "closed", reason: "已补可测的验收标准" } }),
    ], "JUDGE-1");
    // Blue stops reporting it in round 2. Silence must NOT close it -- only the
    // judge's verdict does.
    const dependencies = {
      transport,
      gaps,
      childThreads: spawnedBy(transport),
      readThread: (threadId: string) => threadId.startsWith(RED_THREAD)
        ? answer({ artifactIds: ["spec.md"] })
        : answer({ blockers: [] }),
    };
    const first = {
      transport,
      gaps,
      childThreads: spawnedBy(transport),
      readThread: roles(
        answer({ artifactIds: ["spec.md"] }),
        answer({ blockers: [{ id: "SPEC-1", severity: "P1", title: "验收不可测" }] }),
      ),
    };
    const request = {
      changeId: CHANGE, phase: "Spec" as const, task: "写 Spec", judgeThreadId: null,
    };

    await runRound({ ...request, round: 1 }, first);
    assert.deepEqual(gaps.blockers(CHANGE, "Spec").map((b) => b.id), ["SPEC-1"]);

    const settled = await runRound({ ...request, round: 2, judgeThreadId: "JUDGE-1" }, dependencies);
    assert.deepEqual(settled.blockers, []);
    assert.equal(gaps.all(CHANGE, "Spec")[0]!.resolution, "已补可测的验收标准");
  });

  it("keeps a gap the judge said nothing about", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([
      verdicts({}),
      verdicts({}), // judge says nothing in round 2
    ], "JUDGE-1");
    const request = {
      changeId: CHANGE, phase: "Spec" as const, task: "写 Spec", judgeThreadId: null,
    };
    const withBlue = (blockers: { id: string; severity: string; title: string }[]) => ({
      transport,
      gaps,
      childThreads: spawnedBy(transport),
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers })),
    });

    await runRound({ ...request, round: 1 },
      withBlue([{ id: "SPEC-1", severity: "P1", title: "验收不可测" }]));
    const settled = await runRound({ ...request, round: 2, judgeThreadId: "JUDGE-1" },
      withBlue([]));

    assert.deepEqual(settled.blockers.map((b) => b.id), ["SPEC-1"]);
  });
});

describe("L4 · a round that half happened settles nothing", () => {
  it("writes no gaps when blue cannot be read", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    await assert.rejects(() => runRound(
      { changeId: CHANGE, phase: "Spec", round: 1, task: "写 Spec", judgeThreadId: null },
      {
        transport,
        gaps,
        childThreads: spawnedBy(transport),
        readThread: (threadId) => {
          if (threadId.startsWith(RED_THREAD)) return answer({ artifactIds: ["spec.md"] });
          throw new Error("no sub-agent at /root/blue");
        },
      },
    ), /no sub-agent/);

    // The gate must still read the state from before the round.
    assert.deepEqual(gaps.all(CHANGE, "Spec"), []);
  });

  it("refuses a blue that answered in the wrong shape", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    await assert.rejects(() => runRound(
      { changeId: CHANGE, phase: "Spec", round: 1, task: "写 Spec", judgeThreadId: null },
      {
        transport,
        gaps,
        childThreads: spawnedBy(transport),
        readThread: roles(
          answer({ artifactIds: ["spec.md"] }),
          "蓝方觉得这份 Spec 大体没问题。",
        ),
      },
    ), /blue:/);

    assert.deepEqual(gaps.all(CHANGE, "Spec"), []);
  });
});

/**
 * 认这一轮跑在哪两条线程上。
 *
 * 2026-08-02 之前这是**裁判抄两个 36 字符 UUID 进 json**，抄错一个字符整轮作废、
 * 正反两方说的话谁也看不到（`02059a8` 实测的一次：它把自己的线程报成了红方）。
 * 现在 StagePass 按 rollout 里的 `parent_thread_id` 自己认，见
 * docs/DESIGN-no-hand-transcription-2026-08-02.md §三。
 */
describe("L4 · 这一轮跑在哪两条线程上，由 StagePass 自己认", () => {
  const request = {
    changeId: CHANGE, phase: "Spec" as const, round: 1,
    task: "写 Spec", judgeThreadId: null,
  };

  it("**先出生的是红方，后出生的是蓝方**", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");
    const asked: string[] = [];

    const settled = await runRound(request, {
      transport,
      gaps,
      childThreads: spawnedBy(transport),
      readThread: (threadId) => {
        asked.push(threadId);
        return threadId.startsWith(RED_THREAD)
          ? answer({ artifactIds: ["spec.md"] })
          : answer({ blockers: [] });
      },
    });

    assert.deepEqual(settled.agents, { red: `${RED_THREAD}-1`, blue: `${BLUE_THREAD}-1` });
    assert.deepEqual(asked, [`${RED_THREAD}-1`, `${BLUE_THREAD}-1`]);
    assert.equal(settled.spawned, 2);
  });

  it("**上一轮的子 Agent 不算这一轮的** —— 判据是差集，不是「这条线程有哪些孩子」", async () => {
    // 成功的轮复用裁判线程，所以它会累积多轮的子 Agent（实测见过一条挂着 7 个）。
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({}), verdicts({})], "JUDGE-1");
    const dependencies = {
      transport,
      gaps,
      childThreads: spawnedBy(transport),
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers: [] })),
    };

    await runRound(request, dependencies);
    const second = await runRound(
      { ...request, round: 2, judgeThreadId: "JUDGE-1" }, dependencies,
    );

    assert.deepEqual(second.agents, { red: `${RED_THREAD}-2`, blue: `${BLUE_THREAD}-2` });
    assert.equal(second.spawned, 2);
  });

  it("**一条都没派生 —— 大声失败，gap 一条不写**", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    await assert.rejects(() => runRound(request, {
      transport,
      gaps,
      childThreads: () => [],
      readThread: roles(answer({}), answer({})),
    }), RoundAgentsNotFoundError);
    assert.deepEqual(gaps.all(CHANGE, "Spec"), []);
  });

  it("只派生了一条也失败 —— 读不到蓝方就不许动闸门", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    await assert.rejects(() => runRound(request, {
      transport,
      gaps,
      childThreads: () => [`${RED_THREAD}-1`],
      readThread: roles(answer({}), answer({})),
    }), RoundAgentsNotFoundError);
    assert.deepEqual(gaps.all(CHANGE, "Spec"), []);
  });

  it("**派多了取最后两条，而实际派了几条照数报上去**", async () => {
    // 多出来通常是裁判重派了一次（第一次的子 Agent 失败了），这时最后两条是对的。
    // 但它也可能是裁判违反了「一个跑完再派下一个」—— 两者在这里分不出来，
    // 所以不猜也不静默：`spawned` 让人在账本上看得见。
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    const settled = await runRound(request, {
      transport,
      gaps,
      childThreads: () => [
        `${RED_THREAD}-dead`, `${BLUE_THREAD}-dead`,
        `${RED_THREAD}-1`, `${BLUE_THREAD}-1`,
      ],
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers: [] })),
    });

    assert.deepEqual(settled.agents, { red: `${RED_THREAD}-1`, blue: `${BLUE_THREAD}-1` });
    assert.equal(settled.spawned, 4);
  });
});
