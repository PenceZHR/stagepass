import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { ASK_TOOL_LINE, waitForAnswer, type AskSessions } from "./ask-human";

/**
 * `waitForAnswer` 的「turn 已死」探测。
 *
 * 2026-08-09 真机：裁决会话的模型一个工具都没调、吐了条空话就结束了 turn ——
 * 而这里的活性判据只有「答案落没落」和「进程死没死」，于是人对着一个静止的
 * composer 干等了 12 分钟。这组测试钉的就是那个症状：turn 结束而题没答，
 * 要先补问一次，再不行就把「为什么没答上」说出来并落库。
 */

const PROJECT = "PRJ-A";
const CHANGE = "CHG-A";
const PHASE = "PRD" as const;
const QUESTION = "Q-1";
const PROMPT = "调用 stagepass_ask 一次";

function freshDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure(PROJECT, "p", "/tmp");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT });
  return database;
}

function asked(database: Database.Database): QuestionStore {
  const questions = new QuestionStore(database);
  questions.ask({
    id: QUESTION, changeId: CHANGE, phase: PHASE, kind: "gate_decision",
    question: {
      message: "选一个",
      requestedSchema: { type: "object", properties: {}, required: [] },
    },
    expectedSnapshot: "snap",
  });
  return questions;
}

/** 库里这道题的下场 —— 「没答上」也必须留得住（§3.2·5）。 */
function outcomeOf(database: Database.Database): unknown {
  const row = database.prepare(
    "SELECT status, outcome_json FROM questions WHERE id = ?",
  ).get(QUESTION) as { status: string; outcome_json: string | null };
  return {
    status: row.status,
    outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json),
  };
}

describe("waitForAnswer：ask 那一轮结束了而题没答", () => {
  it("先补问一次；再死一次才放弃，且下场落库", async () => {
    const database = freshDatabase();
    const questions = asked(database);
    const typed: string[] = [];
    const sessions: AskSessions = {
      type: async (_change, _phase, line) => { typed.push(line); return true; },
      has: () => true,
      recordCount: () => 7,
      // 无论第一句提示词还是补问的那句，那一轮都「结束了」—— 连抽两次风。
      turnEnded: () => true,
    };

    const waited = await waitForAnswer({
      database, questions, sessions, changeId: CHANGE, phase: PHASE,
      questionId: QUESTION, timeoutMs: 60_000, prompt: PROMPT,
    });

    assert.equal(waited.answered, false);
    if (!waited.answered) {
      assert.equal(waited.reason, "ask_turn_ended_without_answer");
    }
    // 补问恰好一次，打的是那句固定的 ask 行。
    assert.deepEqual(typed, [ASK_TOOL_LINE]);
    assert.deepEqual(outcomeOf(database), {
      status: "applied",
      outcome: { kind: "unanswered", reason: "ask_turn_ended_without_answer" },
    });
  });

  it("补问救回来了：第二轮里人答了，正常返回答案", async () => {
    const database = freshDatabase();
    const questions = asked(database);
    let ended = true; // 第一轮已经死了
    const sessions: AskSessions = {
      type: async () => {
        // 补问送达 → 这一轮「还在跑」，且人马上答了。
        ended = false;
        questions.answer(QUESTION, { action: "accept", content: {} });
        return true;
      },
      has: () => true,
      recordCount: () => 7,
      turnEnded: () => ended,
    };

    const waited = await waitForAnswer({
      database, questions, sessions, changeId: CHANGE, phase: PHASE,
      questionId: QUESTION, timeoutMs: 60_000, prompt: PROMPT,
    });

    assert.equal(waited.answered, true);
  });

  it("认不出线程（recordCount 说 null）就不探，不乱补", async () => {
    const database = freshDatabase();
    const questions = asked(database);
    const typed: string[] = [];
    const sessions: AskSessions = {
      type: async (_c, _p, line) => { typed.push(line); return true; },
      has: () => true,
      recordCount: () => null,
      turnEnded: () => true, // 就算它说结束了也不该被问到
    };

    const waited = await waitForAnswer({
      database, questions, sessions, changeId: CHANGE, phase: PHASE,
      questionId: QUESTION, timeoutMs: 0, prompt: PROMPT,
    });

    assert.equal(waited.answered, false);
    if (!waited.answered) assert.equal(waited.reason, "no_answer_in_time");
    assert.deepEqual(typed, []);
  });

  it("没递 prompt（老调用方）行为不变，但下场照样落库", async () => {
    const database = freshDatabase();
    const questions = asked(database);
    const sessions: AskSessions = {
      type: async () => true,
      has: () => false, // 进程直接就没了
    };

    const waited = await waitForAnswer({
      database, questions, sessions, changeId: CHANGE, phase: PHASE,
      questionId: QUESTION, timeoutMs: 60_000,
    });

    assert.equal(waited.answered, false);
    if (!waited.answered) {
      assert.equal(waited.reason, "session_died_before_answering");
    }
    assert.deepEqual(outcomeOf(database), {
      status: "applied",
      outcome: { kind: "unanswered", reason: "session_died_before_answering" },
    });
  });
});
