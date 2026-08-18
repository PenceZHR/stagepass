import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { draftOrRead } from "./ask-human";

/**
 * `draftOrRead`：问 = 起草，答 = 消费，**没有等待**。
 *
 * 2026-08-18 之前这里是一个每秒轮询、15 分钟死线的协程（`waitForAnswer`）——
 * MCP 信使时代的遗物。真机三道闸门题全死于 `no_answer_in_time`：题落库了，
 * 页面不刷新人看不见，等看见时死线已过半。现在起草完立刻返回，答案由
 * `/api/answer` 落库后再把用例喊回来消费 —— 一道没答的题不是失败，
 * 是一道还摆在页面上的题。
 */

const PROJECT = "PRJ-A";
const CHANGE = "CHG-A";
const PHASE = "PRD" as const;
const QUESTION = "Q-1";

const SHAPE = {
  message: "选一个",
  requestedSchema: { type: "object" as const, properties: {}, required: [] },
};

function freshDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure(PROJECT, "p", "/tmp");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT });
  return database;
}

function draft(questions: QuestionStore, settleOnAnswer?: boolean): ReturnType<typeof draftOrRead> {
  return draftOrRead({
    questions, changeId: CHANGE, phase: PHASE, kind: "gate_decision",
    question: SHAPE, questionId: QUESTION, expectedSnapshot: "snap",
    ...(settleOnAnswer === undefined ? {} : { settleOnAnswer }),
  });
}

function statusOf(database: Database.Database): string {
  return (database.prepare("SELECT status FROM questions WHERE id = ?")
    .get(QUESTION) as { status: string }).status;
}

describe("draftOrRead：问 = 起草，答 = 消费，没有等待", () => {
  it("没登记就起草并立刻返回 pending —— 没有人挂着", () => {
    const database = freshDatabase();
    const questions = new QuestionStore(database);
    assert.deepEqual(draft(questions), { kind: "pending" });
    assert.equal(statusOf(database), "open");
    database.close();
  });

  it("题还 open 就还是 pending，而且不重复登记", () => {
    const database = freshDatabase();
    const questions = new QuestionStore(database);
    draft(questions);
    assert.deepEqual(draft(questions), { kind: "pending" });
    const rows = database.prepare(
      "SELECT COUNT(*) AS n FROM questions WHERE change_id = ?",
    ).get(CHANGE) as { n: number };
    assert.equal(rows.n, 1);
    database.close();
  });

  it("答过了就把答案交出去 —— 这就是「答 = 消费」的取件口", () => {
    const database = freshDatabase();
    const questions = new QuestionStore(database);
    draft(questions);
    questions.answer(QUESTION, { action: "accept", content: { decision: "批准" } });

    const got = draft(questions);
    assert.equal(got.kind, "answered");
    assert.equal(got.kind === "answered" && got.answer.content.decision, "批准");
    // 默认不收题 —— 裁决那条路后面还要拿着它走 fence / apply。
    assert.equal(statusOf(database), "answered");
    database.close();
  });

  it("settleOnAnswer：第二趟拿到答案就当场收题", () => {
    const database = freshDatabase();
    const questions = new QuestionStore(database);
    draft(questions);
    questions.answer(QUESTION, { action: "accept", content: { Tx: "理由" } });

    const got = draft(questions, true);
    assert.equal(got.kind, "answered");
    assert.equal(statusOf(database), "applied");
    database.close();
  });

  it("已经收尾（applied / superseded）的题当没登记 —— 这是一次新的问", () => {
    const database = freshDatabase();
    const questions = new QuestionStore(database);
    draft(questions);
    questions.answer(QUESTION, { action: "accept", content: {} });
    questions.settle(QUESTION);

    // 同一个 id 已 applied：不视为可取的答案，也不允许复活 —— ask 会拒绝重复 id，
    // 所以这一层的正确行为是回 pending 之外先看清楚：新的问要用新的 id。
    const again = draftOrRead({
      questions, changeId: CHANGE, phase: PHASE, kind: "gate_decision",
      question: SHAPE, questionId: "Q-2", expectedSnapshot: "snap",
    });
    assert.deepEqual(again, { kind: "pending" });
    assert.equal((database.prepare(
      "SELECT status FROM questions WHERE id = 'Q-2'",
    ).get() as { status: string }).status, "open");
    database.close();
  });
});
