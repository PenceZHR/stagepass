import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { draftedQuestions } from "../domain/question";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { answerFromChoices, openQuestionOf } from "./panel-view";

const QUESTION = {
  fields: [
    { id: "G-01", options: ["同意", "不同意", "先接受风险", "我自己说"] },
    { id: "G-02", options: ["同意", "不同意", "先接受风险", "我自己说"] },
  ],
};

describe("Choices the browser sends back", () => {
  it("maps a position to the option text, so nobody retypes the wording", () => {
    // 长措辞一旦要被谁抄一遍就迟早抄歪，而抄歪之后落进库里的是一个看起来合法的错答案。
    assert.deepEqual(answerFromChoices(QUESTION, { "G-01": "0", "G-02": "2" }), {
      "G-01": "同意", "G-02": "先接受风险",
    });
  });

  it("refuses a half-filled form rather than booking part of it", () => {
    assert.equal(answerFromChoices(QUESTION, { "G-01": "0" }), null);
  });

  it("refuses a position that is not one of the offered options", () => {
    for (const bad of ["4", "-1", "1.5", "", "同意", "NaN"]) {
      assert.equal(
        answerFromChoices(QUESTION, { "G-01": "0", "G-02": bad }), null, bad,
      );
    }
  });

  it("answers nothing when there is nothing to answer", () => {
    assert.deepEqual(answerFromChoices({ fields: [] }, {}), {});
  });

  it("hands the ledger the envelope it has always taken", () => {
    // 换的是人在哪儿答，**不是账本的语义**。`questions.answer` 收的是
    // elicitation 那个信封（`{action, content}`），不是裸的答案表 —— 直接塞答案表
    // 会炸 `answer_action_unknown`，而这是真机点出来的，纯映射的单测碰不到。
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(SCHEMA_SQL);
    new ProjectStore(database).ensure("PRJ-A", "p", "/tmp/x");
    new ChangeStore(database).create("CHG-A", { projectId: "PRJ-A" });
    const questions = new QuestionStore(database);
    questions.ask({
      id: "Q-1", changeId: "CHG-A", phase: "PRD", kind: "clarification",
      question: draftedQuestions({
        phase: "PRD", drafted: [{ id: "G-01", question: "保留吗？", why: null }],
      })!,
      expectedSnapshot: "snap",
    });

    const open = openQuestionOf(questions, "CHG-A", "PRD")!;
    const answer = answerFromChoices(open, { "G-01": "2" })!;
    assert.doesNotThrow(() => {
      questions.answer(open.id, { action: "accept", content: answer });
    });
    const stored = questions.readAnswerFor("Q-1");
    assert.equal(stored?.content["G-01"], "先接受这个风险（问题还在，只是不再挡闸门）");
    database.close();
  });

  it("shows a question only on the phase it belongs to", () => {
    // 库里「在等的那道题」是 Change 级的，但它记着自己属于哪个阶段。不收窄的话，
    // 一道 Build 的裁决会出现在 BuildPlan、Spec、QA 每一个弹层里。
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(SCHEMA_SQL);
    new ProjectStore(database).ensure("PRJ-A", "p", "/tmp/x");
    new ChangeStore(database).create("CHG-A", { projectId: "PRJ-A" });
    const questions = new QuestionStore(database);
    questions.ask({
      id: "Q-1", changeId: "CHG-A", phase: "Build", kind: "gate_decision",
      question: draftedQuestions({
        phase: "Build", drafted: [{ id: "G-01", question: "裁决？", why: null }],
      })!,
      expectedSnapshot: "snap",
    });

    assert.notEqual(openQuestionOf(questions, "CHG-A", "Build"), null);
    for (const other of ["BuildPlan", "Spec", "QA", "PRD"]) {
      assert.equal(openQuestionOf(questions, "CHG-A", other), null, other);
    }
    database.close();
  });
});
