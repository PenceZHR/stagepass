import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import {
  APPROVE_AS_RECOMMENDED, decisionLabel, DECISION_FIELD,
  RESPONSE_AGREE, RESPONSE_DISMISS,
} from "../domain/question";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { decideGate } from "./decide-gate";
import type { AskSessions } from "./ask-human";

/**
 * 裁决这个用例，**不经过 HTTP**。
 *
 * 这一条最值得单独验：它同时做四件事（组题、等人选、落表态、推闸门），而**顺序
 * 是承重的**。原来要看这个顺序对不对，只能起一个真服务器再从响应的 JSON 倒推；
 * 现在直接把库的前后状态摆出来。
 */

const PROJECT = "PRJ-A";
const CHANGE = "CHG-A";

function freshDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure(PROJECT, "p", "/tmp");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT });
  return database;
}

/** 走到一个 settled 的 PRD，手里有两条 open 的 P1 —— 也就是一轮跑完的样子。 */
function settledWithGaps(database: Database.Database): void {
  const changes = new ChangeStore(database);
  new GapStore(database).replace(CHANGE, "PRD", [
    {
      id: "SPEC-1", kind: "finding", severity: "P1", title: "验收标准不可测",
      status: "open", openedRound: 1, resolution: null,
    },
    {
      id: "SPEC-2", kind: "finding", severity: "P1", title: "范围与 PRD 冲突",
      status: "open", openedRound: 1, resolution: null,
    },
  ] as never);
  new EvidenceStore(database).put(CHANGE, "PRD", {
    artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
  });
  changes.apply(CHANGE, "start");
  changes.apply(CHANGE, "settle");
}

/** 什么都不做的注入件 —— 这三样是 `web/` 的活，用例只该调它们。 */
const inert = {
  launch: () => {},
  rerun: async () => "跑了一轮",
  onApproved: () => {},
  roundBudget: 5,
};

/**
 * 一个「人会答」的会话：题一出现就按 `content` 答掉。
 *
 * 第一趟由 `launch` 触发（起会话把题送进去），第二趟由 `type` 触发（打进同一个
 * 会话）—— 两处都调这个。
 */
function answerer(database: Database.Database, content: Record<string, string>) {
  const questions = new QuestionStore(database);
  const answered = new Set<string>();
  const answerOpen = (): void => {
    const open = questions.open(CHANGE);
    if (!open || answered.has(open.id)) return;
    answered.add(open.id);
    // 只答这道题真的有的格子 —— 多答一格会被 `readAnswer` 当成答错了题。
    const mine: Record<string, string> = {};
    for (const field of Object.keys(open.question.requestedSchema.properties)) {
      if (field in content) mine[field] = content[field]!;
    }
    questions.answer(open.id, { action: "accept", content: mine });
  };
  const sessions: AskSessions = {
    type: async () => { answerOpen(); return true; },
    has: () => true,
  };
  return { sessions, answerOpen };
}

describe("app · 裁决这个用例（不经过 HTTP）", () => {
  it("没有这个 Change —— 说 no_such_change", async () => {
    const database = freshDatabase();
    const result = await decideGate({
      database, sessions: { type: async () => true, has: () => true },
      changeId: "CHG-不存在", cannotAskNow: () => null, timeoutMs: 10, ...inert,
    });
    assert.deepEqual(result.outcome, { kind: "no_such_change" });
    database.close();
  });

  /**
   * **一道做不了的决定比不问更糟。** 阶段还没跑完（没有证据、没 settle），
   * 闸门一个动作都放不出来 —— 那就不该弹一张空表给人。
   */
  it("组不出一道他做得了的题就不问", async () => {
    const database = freshDatabase();
    let launched = false;
    const result = await decideGate({
      database, sessions: { type: async () => true, has: () => true },
      changeId: CHANGE, cannotAskNow: () => null, timeoutMs: 10,
      ...inert, launch: () => { launched = true; },
    });
    assert.equal(result.outcome.kind, "no_decision");
    assert.equal(launched, false, "连会话都不该起");
    database.close();
  });

  it("没人答就收题、关会话", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    const result = await decideGate({
      database, sessions: { type: async () => true, has: () => true },
      changeId: CHANGE, cannotAskNow: () => null, timeoutMs: 2_000, ...inert,
    });
    assert.equal(result.outcome.kind, "unanswered");
    assert.equal(result.closeSession, true);
    assert.equal(new QuestionStore(database).open(CHANGE), null);
    database.close();
  });

  /**
   * **三步的顺序是承重的**（fence → 表态 → 闸门）。
   *
   * 人把两条 P1 都驳回了，然后选「批准」。第 2 步先把两条 blocker 从名单里拿掉，
   * 第 3 步的闸门才算得出「可以放行」。顺序反过来就是拿着旧名单裁决 —— 人刚说的
   * 话对这一次没有任何影响，而界面上看不出差别。
   */
  it("**表态先落地，闸门再算** —— 驳回两条之后批准才走得通", async () => {
    const database = freshDatabase();
    settledWithGaps(database);

    const before = new CommandStore(database).gateFor(CHANGE);
    assert.equal(
      before.permitted.includes("approve"), false,
      "两条 P1 开着的时候闸门不该放行 approve —— 这一条是下面那个断言的前提",
    );

    const { sessions, answerOpen } = answerer(database, {
      // 两条都驳回（`RESPONSE_DISMISS` 要理由，理由在第二趟那几格）。
      R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
      R01x: "这条说的是别的阶段的事", R02x: "范围是我改的，不是它写错",
      [DECISION_FIELD]: decisionLabel("approve", "PRD"),
    });

    const result = await decideGate({
      database, sessions, changeId: CHANGE, cannotAskNow: () => null,
      timeoutMs: 3_000, ...inert, launch: () => { answerOpen(); },
    });

    assert.equal(result.outcome.kind, "decided");
    const gaps = new GapStore(database).all(CHANGE, "PRD");
    assert.deepEqual(
      gaps.map((gap) => [gap.status, gap.closedBy]),
      [["closed", "human"], ["closed", "human"]],
      "表态必须在闸门之前落地，否则闸门算的是旧名单",
    );
    // 理由是硬要求：一次没有理由的关闭和「这一轮忘了提」在库里长得一模一样。
    assert.ok(gaps.every((gap) => (gap.resolution ?? "").trim() !== ""));
    assert.equal(
      new ChangeStore(database).read(CHANGE).state.phase, "Spec",
      "批准之后该进下一个阶段",
    );
    database.close();
  });

  /**
   * **表态本身不推动闸门。** 全同意 = 两条 blocker 还挡着，这时选「批准」闸门该
   * 拒，而且要说出来 —— 默默当成没发生，人会以为批准了。
   */
  it("同意了两条还挡着的问题，再选批准 —— 闸门拒，而且说得出来", async () => {
    const database = freshDatabase();
    settledWithGaps(database);

    const { sessions, answerOpen } = answerer(database, {
      R01: RESPONSE_AGREE, R02: RESPONSE_AGREE,
      [DECISION_FIELD]: decisionLabel("approve", "PRD"),
    });
    const result = await decideGate({
      database, sessions, changeId: CHANGE, cannotAskNow: () => null,
      timeoutMs: 3_000, ...inert, launch: () => { answerOpen(); },
    });

    assert.equal(result.outcome.kind, "decided");
    const outcome = result.outcome.kind === "decided" ? result.outcome.outcome : null;
    assert.equal((outcome as { kind?: string }).kind, "refused");
    assert.equal(
      new ChangeStore(database).read(CHANGE).state.phase, "PRD", "没被批准就不许动");
    // 下场必须留得住（§3.2·5），不能只活在这一次响应里。
    assert.ok(new QuestionStore(database).latestOutcomeFor(CHANGE, "PRD") !== null);
    database.close();
  });

  /**
   * §8.10 的端到端：**人选了一条系统没推荐的路，Change 真的去了那儿。**
   *
   * 这一条穿过整条链子 —— 题面那一格、答案、`approveTargetFrom`、
   * `questions.apply`、command 层、状态机。链子上任何一环没接上，它都会红。
   */
  it("**批准时选一条非推荐的路** —— 中间的阶段真的被跳过了", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    // 推荐是 Spec（主线下一步）。人选 TestPlan —— 这次改动不需要重写技术方案。
    const { sessions, answerOpen } = answerer(database, {
      R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
      R01x: "不成立", R02x: "不成立",
      U: "TestPlan",
      [DECISION_FIELD]: decisionLabel("approve", "PRD"),
    });
    const result = await decideGate({
      database, sessions, changeId: CHANGE, cannotAskNow: () => null,
      timeoutMs: 3_000, ...inert, launch: () => { answerOpen(); },
    });

    assert.equal(result.outcome.kind, "decided");
    assert.equal(
      new ChangeStore(database).read(CHANGE).state.phase, "TestPlan",
      "人选的是 TestPlan，不是推荐的 Spec",
    );
  });

  it("不选就走推荐那条 —— 这一格的存在不该改变默认", async () => {
    const database = freshDatabase();
    settledWithGaps(database);
    const { sessions, answerOpen } = answerer(database, {
      R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
      R01x: "不成立", R02x: "不成立",
      U: APPROVE_AS_RECOMMENDED,
      [DECISION_FIELD]: decisionLabel("approve", "PRD"),
    });
    await decideGate({
      database, sessions, changeId: CHANGE, cannotAskNow: () => null,
      timeoutMs: 3_000, ...inert, launch: () => { answerOpen(); },
    });
    assert.equal(new ChangeStore(database).read(CHANGE).state.phase, "Spec");
  });

  /**
   * 选了「再来一轮」就**直接续跑** —— 用户 2026-07-30：「把现在的两步合成一步。」
   * 中间那一步看不出来还需要它，人会以为下一轮已经在跑了。
   */
  it("选「再来一轮」就续跑；选批准不续", async () => {
    for (const [action, expected] of [
      ["rerun", "跑了一轮"],
      ["approve", null],
    ] as const) {
      const database = freshDatabase();
      settledWithGaps(database);
      const { sessions, answerOpen } = answerer(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
        R01x: "不成立", R02x: "不成立",
        [DECISION_FIELD]: decisionLabel(action, "PRD"),
      });
      const result = await decideGate({
        database, sessions, changeId: CHANGE, cannotAskNow: () => null,
        timeoutMs: 3_000, ...inert, launch: () => { answerOpen(); },
      });
      assert.equal(result.outcome.kind, "decided");
      assert.equal(
        result.outcome.kind === "decided" ? result.outcome.continued : "?",
        expected, `${action} 的续跑行为`);
      database.close();
    }
  });

  /**
   * **批准了才归档这个阶段的线程**（用户 2026-07-30 拍板的那一半）。别的地方一概
   * 不许调 —— 一个还没批准的阶段的线程被归档，下一次 resume 就会一起来就死。
   */
  it("只有批准会触发归档", async () => {
    for (const [action, archived] of [["approve", 1], ["rerun", 0]] as const) {
      const database = freshDatabase();
      settledWithGaps(database);
      // 归档要有线程可归 —— 没绑定就一次都不该调。
      new BindingStore(database).bind(CHANGE, "PRD", "THREAD-PRD");

      const calls: string[] = [];
      const { sessions, answerOpen } = answerer(database, {
        R01: RESPONSE_DISMISS, R02: RESPONSE_DISMISS,
        R01x: "不成立", R02x: "不成立",
        [DECISION_FIELD]: decisionLabel(action, "PRD"),
      });
      await decideGate({
        database, sessions, changeId: CHANGE, cannotAskNow: () => null,
        timeoutMs: 3_000, ...inert,
        launch: () => { answerOpen(); },
        onApproved: ({ threadId }) => { calls.push(threadId); },
      });
      assert.equal(calls.length, archived, `${action} 触发归档的次数`);
      database.close();
    }
  });
});
