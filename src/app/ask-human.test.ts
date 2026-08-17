import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { waitForAnswer, type AskSessions } from "./ask-human";

/**
 * `waitForAnswer`：题在浏览器里等人。
 *
 * 2026-08-17 之前这里还要盯着会话（题是打进会话让模型转达的），于是有两种死法：
 * 会话没了、以及「turn 结束了而题没答」。C 方案之后题就摆在页面上，那两类整类
 * 消失，连同它们的探测机器一起拆掉了 —— 这组测试钉的是剩下的那一条：
 * 答上了就交出去，没答上就把题收掉并把下场留住。
 */

const PROJECT = "PRJ-A";
const CHANGE = "CHG-A";
const PHASE = "PRD" as const;
const QUESTION = "Q-1";

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

describe("waitForAnswer：题在浏览器里等人（C 方案）", () => {
  it("没有会话也照等 —— 没有人需要挂着一轮", async () => {
    // 旧路要模型挂着把表单端给人，所以「会话没了」= 这道题废了。C 之下题落在库里，
    // 人在浏览器里答，压根没有会话这回事 —— 再把 has() 当活性判据就会把每一道题
    // 都当场判死。
    const database = freshDatabase();
    const questions = asked(database);
    const sessions: AskSessions = {
      type: async () => false,
      has: () => false, // 没有任何会话
    };

    const waiting = waitForAnswer({
      database, questions, sessions, changeId: CHANGE, phase: PHASE,
      questionId: QUESTION, timeoutMs: 4_000,
    });

    // 人过一会儿在浏览器里答了
    setTimeout(() => {
      questions.answer(QUESTION, { action: "accept", content: { decision: "批准" } });
    }, 300);

    const waited = await waiting;
    assert.equal(waited.answered, true);
    assert.equal(waited.answer?.content.decision, "批准");
    database.close();
  });

  it("没答上就是没答上，题要收掉、下场要留住", async () => {
    // 「没答上」也是下场（§3.2·5）—— `applied` + 空下场和一次正常落地在库里
    // 长得一模一样，事后谁也说不清这道题发生过什么。
    const database = freshDatabase();
    const questions = asked(database);
    const sessions: AskSessions = { type: async () => true, has: () => false };

    const waited = await waitForAnswer({
      database, questions, sessions, changeId: CHANGE, phase: PHASE,
      questionId: QUESTION, timeoutMs: 1_200,
    });

    assert.equal(waited.answered, false);
    assert.equal(waited.answered === false && waited.reason, "no_answer_in_time");
    assert.deepEqual(outcomeOf(database), {
      status: "applied",
      outcome: { kind: "unanswered", reason: "no_answer_in_time" },
    });
    database.close();
  });
});
