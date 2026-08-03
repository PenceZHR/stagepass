import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { RESULT_CONTRACT } from "../domain/turn";
import { ScriptedCodexTransport, type CodexTransport } from "../codex/transport";
import { ChangeStore } from "../store/change-store";
import { GapStore } from "../store/gap-store";
import { WorklistStore } from "../store/worklist-store";
import { RoundAgentsNotFoundError, runRound } from "./round-runner";

/**
 * L4 offline: a whole adversarial round, minus the one thing only a real Codex
 * can answer (whether a judge really spawns two sub-agents).
 */

const CHANGE = "CHG-R";
const AT = "2026-07-29T00:00:00.000Z";

/**
 * 名单是真的 —— 用真的 store，不做替身。
 *
 * 它是这一轮「裁判怎么表态」的唯一入口，替身化就等于把这条路的接线一起假掉。
 */
function worklistOf(db: Database.Database): WorklistStore {
  return new WorklistStore(db, () => new Date(AT));
}

/**
 * 一个**会调工具**的裁判：turn 一跑就把名单按顺序答掉。
 *
 * 真裁判是在自己的 turn 里调 `stagepass_next` / `stagepass_answer` 的，所以替身也得
 * 在同一个位置动手 —— 在 turn 之后才答，`runRound` 早就把名单读完了。
 *
 * 答案按顺序给，给多少答多少：**没答的那几条是沉默，按规矩保持 open**。
 */
function judgeAnswering(
  transport: ScriptedCodexTransport,
  store: WorklistStore,
  answers: readonly (readonly [string, string])[],
): CodexTransport {
  return {
    async runTurn(dispatch) {
      const delivery = await transport.runTurn(dispatch);
      for (const [answer, reason] of answers) store.answer(CHANGE, answer, reason);
      return delivery;
    },
  };
}

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

/**
 * 把「写给模型读的文件」记在内存里。
 *
 * 测试**绝不碰真文件系统**（和 repo 那个替身同一个理由）。记下来还有第二个用处：
 * 断言得了「名单确实落进了文件、而且正文对」—— 提示词里现在只剩一个路径。
 */
function inMemoryFiles() {
  const written = new Map<string, string>();
  return {
    written,
    write(name: string, content: string): string {
      const path = `/tmp/stagepass-test/${name}`;
      written.set(path, content);
      return path;
    },
    /** 没写过的路径就是 `null` —— 和生产那一侧「文件不在」同一个形状。 */
    read(path: string): string | null {
      return written.get(path) ?? null;
    },
  };
}

/** 两个文件依赖一起给 —— 分开给会让写和读落在两个不同的实例上。 */
function inMemoryDeps() {
  const files = inMemoryFiles();
  return { writeRoundFile: files.write, readRoundFile: files.read };
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
        ...inMemoryDeps(),
        worklist: worklistOf(db),
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
    const files = inMemoryFiles();
    const dependencies = {
      transport,
      gaps,
      childThreads: spawnedBy(transport),
      writeRoundFile: files.write,
      readRoundFile: files.read,
      worklist: worklistOf(db),
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
    /*
     * **名单走文件了**（用户 2026-08-03：能文件化的就走文件）。所以第 2 轮的提示词里
     * 是一个路径，正文在文件里 —— 两处都要盯，否则「路径印出去了但文件是空的」这种
     * 断法就没人接住。
     */
    const path = [...files.written.keys()].find((each) => each.includes("open-problems"))!;
    assert.match(transport.dispatches[1]!.prompt, new RegExp(path));
    assert.doesNotMatch(transport.dispatches[1]!.prompt, /SPEC-1 \[P1\]/, "正文还印在提示词里");
    assert.match(files.written.get(path)!, /SPEC-1 \[P1\] 验收不可测/);
    // Red is told the shape to answer in, or its result is unreadable later.
    assert.ok(transport.dispatches[0]!.prompt.includes(RESULT_CONTRACT));
  });

  it("closes a gap only when the judge says why", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const worklist = worklistOf(db);
    const transport = new ScriptedCodexTransport([verdicts({}), verdicts({})], "JUDGE-1");
    const childThreads = spawnedBy(transport);
    // Blue stops reporting it in round 2. Silence must NOT close it -- only the
    // judge's verdict does. 第 2 轮它调工具把那一条关掉。
    const dependencies = {
      transport: judgeAnswering(transport, worklist, [["closed", "已补可测的验收标准"]]),
      gaps,
      childThreads,
      ...inMemoryDeps(),
      worklist,
      readThread: (threadId: string) => threadId.startsWith(RED_THREAD)
        ? answer({ artifactIds: ["spec.md"] })
        : answer({ blockers: [] }),
    };
    const first = {
      transport,
      gaps,
      childThreads,
      ...inMemoryDeps(),
      worklist,
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
      ...inMemoryDeps(),
      worklist: worklistOf(db),
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
        ...inMemoryDeps(),
        worklist: worklistOf(db),
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
        ...inMemoryDeps(),
        worklist: worklistOf(db),
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
      ...inMemoryDeps(),
      worklist: worklistOf(db),
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
      ...inMemoryDeps(),
      worklist: worklistOf(db),
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
      ...inMemoryDeps(),
      worklist: worklistOf(db),
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
      ...inMemoryDeps(),
      worklist: worklistOf(db),
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
      ...inMemoryDeps(),
      childThreads: () => [
        `${RED_THREAD}-dead`, `${BLUE_THREAD}-dead`,
        `${RED_THREAD}-1`, `${BLUE_THREAD}-1`,
      ],
      worklist: worklistOf(db),
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers: [] })),
    });

    assert.deepEqual(settled.agents, { red: `${RED_THREAD}-1`, blue: `${BLUE_THREAD}-1` });
    assert.equal(settled.spawned, 4);
  });
});

/**
 * 裁判逐条表态那条路。
 *
 * 2026-08-02 之前：StagePass 把 gap id 印进提示词，裁判把它们**手抄**进一个 json 的
 * key 位置上（`RB:critic:RBC-<uuid>` 长 50 字符），而 StagePass 拿它做精确匹配。
 * 抄漏一段，那一条的表态就凭空消失，而人看不出是「它说还在」还是「它抄错了」。
 */
describe("L4 · 表态走名单，裁判手上没有任何 id 可抄", () => {
  const request = {
    changeId: CHANGE, phase: "Spec" as const, round: 1,
    task: "写 Spec", judgeThreadId: null,
  };

  const withGap = (db: Database.Database, gaps: GapStore) => {
    gaps.settleRound(CHANGE, "Spec", {
      round: 0,
      found: [{ id: "SPEC-1", severity: "P1", title: "验收不可测" }],
      verdicts: {},
    });
    return db;
  };

  it("**名单里有 id，念给模型的那段话里没有**", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    withGap(db, gaps);
    const worklist = worklistOf(db);
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    await runRound(request, {
      transport, gaps, worklist,
      childThreads: spawnedBy(transport),
      ...inMemoryDeps(),
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers: [] })),
    });

    const item = worklist.read(CHANGE, "Spec", 1)[0]!;
    assert.equal(item.target, "SPEC-1", "上层要按它认回是哪一条");
    assert.equal(item.prompt.includes("SPEC-1"), false, "模型看得到 id 就会去抄它");
    assert.match(item.prompt, /验收不可测/);
    assert.deepEqual(item.choices, ["closed", "still_open"]);
  });

  it("**裁判写在 json 里的表态一个字都不算数**", async () => {
    // 算数就等于把那条 50 字符的手抄路重新打开了。
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    withGap(db, gaps);
    const worklist = worklistOf(db);
    const transport = new ScriptedCodexTransport([
      verdicts({ "SPEC-1": { kind: "closed", reason: "它自己写在 json 里的" } }),
    ], "JUDGE-1");

    const settled = await runRound(request, {
      transport, gaps, worklist,
      childThreads: spawnedBy(transport),
      ...inMemoryDeps(),
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers: [] })),
    });

    assert.deepEqual(settled.blockers.map((b) => b.id), ["SPEC-1"], "它靠写 json 关掉了");
  });

  it("名单在 turn **之前**就开好 —— 裁判一起来就可能调工具", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    withGap(db, gaps);
    const worklist = worklistOf(db);
    const inner = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");
    let openWhenTurnRan = 0;

    await runRound(request, {
      transport: {
        async runTurn(dispatch) {
          openWhenTurnRan = worklist.next(CHANGE) === null ? 0 : 1;
          return inner.runTurn(dispatch);
        },
      },
      gaps, worklist,
      childThreads: spawnedBy(inner),
      ...inMemoryDeps(),
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers: [] })),
    });

    assert.equal(openWhenTurnRan, 1, "turn 跑的时候名单还没开出来");
  });

  it("**一条都没答，而名单不是空的 —— 记进 malformed，线程会被放开**", async () => {
    // 提示词明写着逐条走工具。全不答只可能是它压根没调（工具没起来，或者它自作主张
    // 写进了 json）。一条中毒的线程会把「不用那个工具」这件事也一起抄下去。
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    withGap(db, gaps);
    const worklist = worklistOf(db);
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    const settled = await runRound(request, {
      transport, gaps, worklist,
      childThreads: spawnedBy(transport),
      ...inMemoryDeps(),
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers: [] })),
    });

    assert.deepEqual(settled.malformed, ["worklist_unanswered"]);
  });

  it("**答了一部分不算** —— 那是它的判断，沉默的那几条按老规矩保持 open", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    gaps.settleRound(CHANGE, "Spec", {
      round: 0,
      found: [
        { id: "SPEC-1", severity: "P1", title: "第一个" },
        { id: "SPEC-2", severity: "P1", title: "第二个" },
      ],
      verdicts: {},
    });
    const worklist = worklistOf(db);
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    const settled = await runRound(request, {
      transport: judgeAnswering(transport, worklist, [["closed", "第一个修了"]]),
      gaps, worklist,
      childThreads: spawnedBy(transport),
      ...inMemoryDeps(),
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers: [] })),
    });

    assert.deepEqual(settled.malformed, [], "答了一部分不是格式坏了");
    assert.deepEqual(settled.blockers.map((b) => b.id), ["SPEC-2"]);
  });

  it("名单是空的时候不报 malformed —— 没什么可表态是正常的一轮", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const worklist = worklistOf(db);
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    const settled = await runRound(request, {
      transport, gaps, worklist,
      childThreads: spawnedBy(transport),
      ...inMemoryDeps(),
      readThread: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers: [] })),
    });

    assert.deepEqual(settled.malformed, []);
  });
});
