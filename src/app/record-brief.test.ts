import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ESCAPE_OPTION, readBriefProposal } from "../domain/brief";
import { clarificationQuestion, MULTI_JOIN } from "../domain/question";
import { ChangeStore } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { recordBrief } from "./record-brief";

/**
 * 录需求这个用例，**不经过 HTTP，也不经过 Codex**。
 *
 * 「跑一次 turn 让模型提问题」是注进来的（`propose`），所以整条路能在一个假的
 * 提案上跑完。答题的节拍和真系统一样：用例起草完立刻返回 `asked`，测试替
 * `/api/answer` 落答案、再喊一遍用例消费 —— 没有定时器、没有等待。
 */

const PROJECT = "PRJ-A";
const CHANGE = "CHG-A";

/** 模型「读完仓库」交回来的那段话。三条问题、每条四个选项 —— 合格的提案。 */
const PROPOSAL = [
  "```brief",
  "这次改动给谁用？ | 只有我 | 团队 | 外部用户 | 还不确定",
  "什么算做完？ | 能跑通一遍 | 有测试 | 上线了 | 还不确定",
  "什么明确不做？ | 不动数据库 | 不改界面 | 不加依赖 | 还不确定",
  "```",
].join("\n");

function freshDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure(PROJECT, "p", "/tmp");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT, title: "把 X 做出来" });
  return database;
}

const plain = { cannotAskNow: () => null };

/**
 * `/api/answer` 那个循环的镜像：问出来就按 `pick` 答掉、再喊一遍，直到终局。
 * `seen` 收每一张真的弹出来的表 —— 「第二趟该不该弹」的判据靠它。
 */
async function drive(
  database: Database.Database,
  propose: () => Promise<string>,
  pick: (field: string, options: readonly string[]) => string,
  seen?: string[][],
): ReturnType<typeof recordBrief> {
  const questions = new QuestionStore(database);
  for (let round = 0; round < 5; round += 1) {
    const result = await recordBrief({
      database, changeId: CHANGE, ...plain, propose,
    });
    if (result.outcome.kind !== "asked") return result;
    const open = questions.open(CHANGE);
    assert.ok(open, "说了 asked 却没有 open 的题");
    const fields = Object.entries(open.question.requestedSchema.properties);
    seen?.push(fields.map(([id]) => id));
    const content: Record<string, string> = {};
    for (const [field, spec] of fields) content[field] = pick(field, spec.enum ?? []);
    questions.answer(open.id, { action: "accept", content });
  }
  throw new Error("驱动 5 次还没到终局");
}

describe("app · 录需求这个用例（不经过 HTTP，也不经过 Codex）", () => {
  it("没有这个 Change —— 说 no_such_change", async () => {
    const database = freshDatabase();
    const result = await recordBrief({
      database, changeId: "CHG-不存在", ...plain,
      propose: async () => PROPOSAL,
    });
    assert.deepEqual(result.outcome, { kind: "no_such_change" });
    database.close();
  });

  /**
   * **模型一条都没提，不许降级成「不需要问」。**
   *
   * 那样需求录入就被静默跳过了，而下游那份 PRD 仍然会生成出来 —— 看着一切正常，
   * 而它建立在一段没人说过的需求上。这正是这棵树重建的起因。
   */
  it("提案不成形就说不成形，**不当成「不需要问」**", async () => {
    const database = freshDatabase();
    for (const [proposal, code] of [
      ["模型今天什么都不想说。", "no_items"],
      ["```brief\n这次改动给谁用？ | 只有我\n```", "too_few_options"],
    ] as const) {
      const result = await recordBrief({
        database, changeId: CHANGE, ...plain,
        propose: async () => proposal,
      });
      assert.equal(result.outcome.kind, "proposal_failed");
      assert.equal(
        result.outcome.kind === "proposal_failed" && result.outcome.reason, code);
      assert.equal(
        new ChangeStore(database).read(CHANGE).brief, null,
        "提案废了却把需求录进去了 —— 那就是那份编出来的 PRD",
      );
    }
    database.close();
  });

  it("跑 turn 本身炸了也照实说，**不静默跳过**", async () => {
    const database = freshDatabase();
    const result = await recordBrief({
      database, changeId: CHANGE, ...plain,
      propose: async () => { throw new Error("codex 一起来就退了"); },
    });
    assert.equal(result.outcome.kind, "proposal_failed");
    assert.equal(
      result.outcome.kind === "proposal_failed" && result.outcome.detail,
      "codex 一起来就退了", "真实原因不许被翻译掉");
    database.close();
  });

  /**
   * **没人答就让题挂着 —— 那不是失败，也没有截止。** 再问一遍不重跑模型、
   * 不另起草稿 —— 另起会把人正对着的那张表 supersede 掉，还白烧一轮。
   */
  it("没人答：题挂着，再问一遍不重跑模型", async () => {
    const database = freshDatabase();
    let proposed = 0;
    const propose = async (): Promise<string> => { proposed += 1; return PROPOSAL; };
    const first = await recordBrief({
      database, changeId: CHANGE, ...plain, propose,
    });
    assert.equal(first.outcome.kind, "asked");
    assert.equal(first.closeSession, false);
    assert.equal(proposed, 1);

    const open = new QuestionStore(database).open(CHANGE);
    assert.ok(open, "题该摆着等人");

    const second = await recordBrief({
      database, changeId: CHANGE, ...plain, propose,
    });
    assert.equal(second.outcome.kind, "asked");
    assert.equal(
      second.outcome.kind === "asked" && second.outcome.questionId, open.id,
      "同一道题 —— 不许 supersede 人正对着的表",
    );
    assert.equal(proposed, 1, "重问一遍不许再烧一轮模型");
    database.close();
  });

  it("**全用选项答完的人一个字都不用打** —— 一趟就录进去", async () => {
    const database = freshDatabase();
    const seen: string[][] = [];
    // 一律选第一个 —— 也就是「都不对，我自己写」一次都没点。
    const result = await drive(
      database, async () => PROPOSAL, (_, options) => options[0] ?? "", seen);

    assert.equal(result.outcome.kind, "recorded");
    assert.equal(seen.length, 1, "没人要写字，第二趟就不该弹 —— 弹了那句话就打了折");
    assert.equal(result.closeSession, true, "办完了也要关，否则下一次派发永远是灰的");

    const brief = new ChangeStore(database).read(CHANGE).brief;
    assert.ok(brief && brief.includes("这次改动给谁用？"), "需求真的落库了");
    assert.equal(new QuestionStore(database).open(CHANGE), null);
    database.close();
  });

  it("服务重启后续上已经落库的完整回答，不再重跑模型或重问人", async () => {
    const database = freshDatabase();
    const questions = new QuestionStore(database);
    const items = readBriefProposal(PROPOSAL);
    const question = clarificationQuestion({
      title: `${CHANGE}：先把这次改动要什么说清楚`,
      items,
    });
    assert.ok(question);
    const questionId = `BR-${CHANGE}-interrupted`;
    questions.ask({
      id: questionId,
      changeId: CHANGE,
      phase: "PRD",
      kind: "clarification",
      question,
      expectedSnapshot: new CommandStore(database).gateFor(CHANGE).snapshot,
    });
    const content = Object.fromEntries(Object.entries(
      question.requestedSchema.properties,
    ).map(([id, field]) => [id, field.enum?.[0] ?? ""]));
    questions.answer(questionId, { action: "accept", content });

    const result = await recordBrief({
      database, changeId: CHANGE, ...plain,
      propose: async () => { throw new Error("已经答完，不该再跑模型"); },
    });

    assert.equal(result.outcome.kind, "recorded");
    assert.match(new ChangeStore(database).read(CHANGE).brief ?? "", /这次改动给谁用/);
    assert.equal(questions.read(questionId).status, "applied");
    database.close();
  });

  it("重启发生在两趟表单之间时，只补问人要求自己写的那一格", async () => {
    const database = freshDatabase();
    const questions = new QuestionStore(database);
    const items = readBriefProposal(PROPOSAL);
    const question = clarificationQuestion({
      title: `${CHANGE}：先把这次改动要什么说清楚`,
      items,
    });
    assert.ok(question);
    const questionId = `BR-${CHANGE}-follow-up-interrupted`;
    questions.ask({
      id: questionId,
      changeId: CHANGE,
      phase: "PRD",
      kind: "clarification",
      question,
      expectedSnapshot: new CommandStore(database).gateFor(CHANGE).snapshot,
    });
    const content = Object.fromEntries(Object.entries(
      question.requestedSchema.properties,
    ).map(([id, field]) => [id, id === "B01" ? ESCAPE_OPTION : field.enum?.[0] ?? ""]));
    questions.answer(questionId, { action: "accept", content });

    const seen: string[][] = [];
    const result = await drive(
      database,
      async () => { throw new Error("恢复时不该重跑模型"); },
      (field) => field === "B01x" ? "给值班运营同学使用" : "",
      seen,
    );

    assert.equal(result.outcome.kind, "recorded");
    // 第二趟只有那一格要写的（没有「确认」门把手 —— 浏览器有真提交按钮）。
    assert.deepEqual(seen, [["B01x"]]);
    assert.match(new ChangeStore(database).read(CHANGE).brief ?? "", /给值班运营同学使用/);
    assert.equal(questions.read(questionId).status, "applied");
    assert.equal(questions.read(`${questionId}-x`).status, "applied");
    database.close();
  });

  it("答不出一份需求就**不录** —— 不拿一段空白往下走", async () => {
    const database = freshDatabase();
    const questions = new QuestionStore(database);
    const first = await recordBrief({
      database, changeId: CHANGE, ...plain, propose: async () => PROPOSAL,
    });
    assert.equal(first.outcome.kind, "asked");
    // 人按了 Esc（action = decline）。
    const open = questions.open(CHANGE);
    assert.ok(open);
    questions.answer(open.id, { action: "decline", content: {} });

    const result = await recordBrief({
      database, changeId: CHANGE, ...plain,
      propose: async () => { throw new Error("已有答案，不该重跑模型"); },
    });
    assert.equal(result.outcome.kind, "not_recorded");
    assert.equal(
      new ChangeStore(database).read(CHANGE).brief, null,
      "拿一段空白往下走等于又回到那份编出来的 PRD",
    );
    database.close();
  });

  it("多选题答几项，需求里就落几项", async () => {
    const database = freshDatabase();
    const multiProposal = [
      "```brief",
      "要支持哪些平台？ | 多选 | iOS | Android | Web",
      "什么算做完？ | 能跑通一遍 | 有测试 | 上线了",
      "```",
    ].join("\n");
    const result = await drive(
      database, async () => multiProposal,
      (field, options) => field === "B01"
        ? [options[0]!, options[2]!].join(MULTI_JOIN)
        : options[0] ?? "");

    assert.equal(result.outcome.kind, "recorded");
    const brief = new ChangeStore(database).read(CHANGE).brief ?? "";
    assert.match(brief, /iOS；Web/, "两项都要落进需求");
    database.close();
  });
});
