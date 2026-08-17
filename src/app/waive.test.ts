import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import {
  waiveFollowUpQuestion, waiveQuestion, WAIVE_ACCEPT,
} from "../domain/question";
import type { Phase } from "../domain/phase";
import { ChangeStore } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { waive } from "./waive";
import type { AskSessions } from "./ask-human";

/**
 * **这个文件本身就是 §4.1 那条抱怨的答案。**
 *
 * > 用例没法单独测 —— 746 个测试全是模块级的。
 *
 * 接受风险这条路原来整个写在 `handle()` 的 HTTP 分支里，于是验它只有一条路：
 * 起一个真服务器、真 socket、假 pty，再从响应的 JSON 倒推逻辑对不对。下面这些
 * 用例**一个 HTTP、一个进程都没有** —— 库、假会话、直接调那个函数。
 *
 * 这不是「测试写得更漂亮」。它是那一层真的存在的唯一证据：如果 `waive()` 还需要
 * `request` / `response` 才跑得起来，这个文件写不出来。
 */

const PROJECT = "PRJ-A";
const CHANGE = "CHG-A";

/** 一个什么都没起来的会话：进程不在，打字打不进去。 */
const noSession: AskSessions = {
  type: async () => false,
  has: () => false,
};

function freshDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure(PROJECT, "p", "/tmp");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT });
  return database;
}

/** 一条开着的 P1 —— 也就是「可以带着走」的那一种。 */
function openP1(database: Database.Database, id = "G-1"): void {
  new GapStore(database).replace(CHANGE, "PRD", [{
    id, kind: "finding", severity: "P1", title: "接口没有错误码",
    status: "open", openedRound: 1, resolution: null,
  } as never]);
}

/** 跑这个用例，同时在它等答案的时候替人答一次。 */
async function waiveAnswering(
  database: Database.Database,
  answer: ((questionId: string) => unknown) | null,
  options: { alive?: boolean } = {},
): ReturnType<typeof waive> {
  const questions = new QuestionStore(database);
  const sessions: AskSessions = {
    type: async () => options.alive ?? true,
    has: () => options.alive ?? true,
  };
  /*
   * 人在**浏览器**里按下去的那一刻 —— 不再由 `launch` 触发（C 方案之后这条路
   * 不派信使了），而是像人一样过一会儿去答。库一关就自己停。
   */
  let timer: ReturnType<typeof setInterval> | null = null;
  if (answer) {
    const answerOpen = (): void => {
      if (!database.open) { if (timer) clearInterval(timer); return; }
      const open = questions.open(CHANGE);
      if (open) questions.answer(open.id, answer(open.id));
    };
    timer = setInterval(answerOpen, 20);
    timer.unref();
  }
  const running = waive({
    database, sessions, changeId: CHANGE,
    cannotAskNow: () => null,
    launch: () => {},
    timeoutMs: 3_000,
  });
  return running;
}

describe("app · 接受风险这个用例（不经过 HTTP）", () => {
  it("没有这个 Change —— 说 no_such_change，**不是** 404", async () => {
    const database = freshDatabase();
    const result = await waive({
      database, sessions: noSession, changeId: "CHG-不存在",
      cannotAskNow: () => null, launch: () => {}, timeoutMs: 10,
    });
    assert.deepEqual(result.outcome, { kind: "no_such_change" });
    /*
     * 状态码是 `web/` 的词汇。这一层说的是「没有这个 Change」——**同一个下场，
     * 换个界面（CLI、TUI）翻成别的东西**，而用例一个字都不用改。这正是 §4.1
     * 里「换界面 = 重写全部用例」被治好的地方。
     */
    assert.equal("phase" in result.outcome, false);
    database.close();
  });

  it("一条可接受的都没有 —— 不问", async () => {
    const database = freshDatabase();
    let launched = false;
    const result = await waive({
      database, sessions: noSession, changeId: CHANGE,
      cannotAskNow: () => null, launch: () => { launched = true; }, timeoutMs: 10,
    });
    assert.equal(result.outcome.kind, "nothing_waivable");
    assert.equal(launched, false, "一道没有选项的题比不问更糟 —— 连会话都不该起");
    database.close();
  });

  it("**P0 不在候选里** —— 严重到不可接受的问题不能靠普通确认绕过", async () => {
    const database = freshDatabase();
    new GapStore(database).replace(CHANGE, "PRD", [{
      id: "G-1", kind: "finding", severity: "P0", title: "会丢数据",
      status: "open", openedRound: 1, resolution: null,
    } as never]);
    const result = await waive({
      database, sessions: noSession, changeId: CHANGE,
      cannotAskNow: () => null, launch: () => {}, timeoutMs: 10,
    });
    assert.equal(result.outcome.kind, "nothing_waivable");
    database.close();
  });

  it("现在不能问就不问，并说出是什么挡着", async () => {
    const database = freshDatabase();
    openP1(database);
    const result = await waive({
      database, sessions: noSession, changeId: CHANGE,
      cannotAskNow: () => ({ reason: "phase_already_running", busy: "terminal" }),
      launch: () => {}, timeoutMs: 10,
    });
    assert.equal(result.outcome.kind, "busy");
    database.close();
  });

  /**
   * 这一条就是这一趟修的那个 bug：超时之后那道题**必须**不再是 open。
   * 原来只有裁决和录需求两条路收了题，接受风险这第四份拷贝漏了。
   */
  it("**没人答就把题收掉** —— 没人在等的题不该看起来在等", async () => {
    const database = freshDatabase();
    openP1(database);
    const result = await waiveAnswering(database, null);
    assert.equal(result.outcome.kind, "unanswered");
    assert.equal(result.closeSession, true, "放弃了就该把那个会话关掉");
    assert.equal(
      new QuestionStore(database).open(CHANGE), null,
      "留着一道 open 的题 —— 下一个调 stagepass_ask 的会被端出这道死题",
    );
    database.close();
  });

  it("会话死了也不影响这道题 —— 它在浏览器里等人", async () => {
    /*
     * 以前这道题要派一轮让模型转达，所以「会话死了」= 人永远看不到它。
     * C 方案之后题就摆在页面上，跟会话活不活着没关系 —— 没答上就是没答上。
     */
    const database = freshDatabase();
    openP1(database);
    const result = await waiveAnswering(database, null, { alive: false });
    assert.equal(result.outcome.kind, "unanswered");
    assert.equal(
      result.outcome.kind === "unanswered" && result.outcome.reason,
      "no_answer_in_time",
    );
    database.close();
  });

  it("重启后把已经答完的两趟风险表落库，不重开会话", async () => {
    const database = freshDatabase();
    openP1(database);
    const gaps = new GapStore(database).all(CHANGE, "PRD");
    const question = waiveQuestion({ phase: "PRD", waivable: gaps, round: 1 });
    assert.ok(question);
    const questions = new QuestionStore(database);
    const gate = new CommandStore(database).gateFor(CHANGE);
    const questionId = `W-${CHANGE}-PRD-interrupted`;
    questions.ask({
      id: questionId,
      changeId: CHANGE,
      phase: "PRD",
      kind: "waive",
      question,
      expectedSnapshot: gate.snapshot,
    });
    const first = { action: "accept" as const, content: { W01: WAIVE_ACCEPT } };
    questions.answer(questionId, first);
    const followUp = waiveFollowUpQuestion(gaps, first);
    assert.ok(followUp);
    questions.ask({
      id: `${questionId}-x`,
      changeId: CHANGE,
      phase: "PRD",
      kind: "waive",
      question: followUp,
      expectedSnapshot: gate.snapshot,
    });
    questions.answer(`${questionId}-x`, {
      action: "accept",
      content: { W01x: "已有隔离措施，下一版补齐" },
    });

    const result = await waive({
      database,
      sessions: {
        type: async () => { throw new Error("两趟都答完了，不该再问"); },
        has: () => false,
      },
      changeId: CHANGE,
      cannotAskNow: () => null,
      launch: () => { throw new Error("两趟都答完了，不该重开会话"); },
      timeoutMs: 10,
    });

    assert.equal(result.outcome.kind, "waived");
    assert.equal(new GapStore(database).all(CHANGE, "PRD")[0]?.status, "waived");
    assert.equal(questions.read(questionId).status, "applied");
    assert.equal(questions.read(`${questionId}-x`).status, "applied");
    database.close();
  });

  it("接了就落库，一次能接多条", async () => {
    const database = freshDatabase();
    new GapStore(database).replace(CHANGE, "PRD", [
      {
        id: "G-1", kind: "finding", severity: "P1", title: "接口没有错误码",
        status: "open", openedRound: 1, resolution: null,
      },
      {
        id: "G-2", kind: "finding", severity: "P1", title: "重试没有上限",
        status: "open", openedRound: 1, resolution: null,
      },
    ] as never);

    /*
     * 第一趟纯选项格，第二趟才要理由 —— 两趟都在浏览器里答，所以这里挂一个定时器
     * 像人一样一趟一趟地答，不再由 `launch` / `type` 触发。
     */
    const questions = new QuestionStore(database);
    const answerWhatever = (): void => {
      const open = questions.open(CHANGE);
      if (!open) return;
      const content: Record<string, string> = {};
      for (const key of Object.keys(
        (open.question.requestedSchema as { properties?: Record<string, unknown> })
          .properties ?? {},
      )) {
        content[key] = key.endsWith("x") ? "这一版先不做，下一版补" : WAIVE_ACCEPT;
      }
      questions.answer(open.id, { action: "accept", content });
    };
    const sessions: AskSessions = {
      type: async () => { answerWhatever(); return true; },
      has: () => true,
    };
    const timer = setInterval(() => {
      if (!database.open) { clearInterval(timer); return; }
      answerWhatever();
    }, 20);
    timer.unref();

    const result = await waive({
      database, sessions, changeId: CHANGE,
      cannotAskNow: () => null,
      launch: () => {},
      timeoutMs: 3_000,
    });
    clearInterval(timer);

    assert.equal(result.outcome.kind, "waived");
    assert.deepEqual(
      result.outcome.kind === "waived" ? [...result.outcome.gapIds] : [],
      ["G-1", "G-2"],
      "用户 2026-08-04：接两条不该走两遍完整流程",
    );
    const after = new GapStore(database).all(CHANGE, "PRD" as Phase);
    assert.deepEqual(after.map((gap) => gap.status), ["waived", "waived"]);
    // 理由是硬要求：一个没有理由的 waive 和「忘了处理」在库里长得一模一样。
    assert.ok(after.every((gap) => (gap.resolution ?? "").trim() !== ""));
    assert.equal(new QuestionStore(database).open(CHANGE), null);
    database.close();
  });
});
