import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { recordBrief } from "./record-brief";
import type { AskSessions } from "./ask-human";

/**
 * 录需求这个用例，**不经过 HTTP，也不经过 Codex**。
 *
 * 「跑一次 turn 让模型提问题」是注进来的（`propose`），所以整条路能在一个假的
 * 提案上跑完 —— 原来验它必须起真服务器 + 假 pty + 一个装成 Codex 的 transport，
 * 而那三样加起来验的是那三样，不是这个用例。
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

/**
 * 一个「人会答」的会话：`type` 一被调用，就把当前那道题按 `pick` 答掉。
 * 这正是真实时序 —— 模型调 `stagepass_ask`、人在选择器里按，插件写库。
 */
function answeringSessions(
  database: Database.Database,
  pick: (field: string, options: readonly string[]) => string,
): AskSessions {
  const questions = new QuestionStore(database);
  return {
    type: async () => {
      const open = questions.open(CHANGE);
      if (!open) return true;
      const content: Record<string, string> = {};
      for (const [field, spec] of Object.entries(
        open.question.requestedSchema.properties,
      )) {
        content[field] = pick(field, spec.enum ?? []);
      }
      questions.answer(open.id, { action: "accept", content });
      return true;
    },
    has: () => true,
  };
}

describe("app · 录需求这个用例（不经过 HTTP，也不经过 Codex）", () => {
  it("没有这个 Change —— 说 no_such_change", async () => {
    const database = freshDatabase();
    const result = await recordBrief({
      database, sessions: { type: async () => true, has: () => true },
      changeId: "CHG-不存在", cannotAskNow: () => null,
      propose: async () => PROPOSAL, timeoutMs: 10,
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
        database, sessions: { type: async () => true, has: () => true },
        changeId: CHANGE, cannotAskNow: () => null,
        propose: async () => proposal, timeoutMs: 10,
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
      database, sessions: { type: async () => true, has: () => true },
      changeId: CHANGE, cannotAskNow: () => null,
      propose: async () => { throw new Error("codex 一起来就退了"); },
      timeoutMs: 10,
    });
    assert.equal(result.outcome.kind, "proposal_failed");
    assert.equal(
      result.outcome.kind === "proposal_failed" && result.outcome.detail,
      "codex 一起来就退了", "真实原因不许被翻译掉");
    database.close();
  });

  it("会话在问出去之前就死了 —— **不许假装问出去了**", async () => {
    const database = freshDatabase();
    const result = await recordBrief({
      database, sessions: { type: async () => false, has: () => true },
      changeId: CHANGE, cannotAskNow: () => null,
      propose: async () => PROPOSAL, timeoutMs: 10,
    });
    assert.equal(result.outcome.kind, "not_asked");
    assert.equal(
      new QuestionStore(database).open(CHANGE), null,
      "题落了库，人却永远看不到它 —— 那道题必须收掉",
    );
    database.close();
  });

  it("没人答就收题、关会话", async () => {
    const database = freshDatabase();
    const result = await recordBrief({
      database, sessions: { type: async () => true, has: () => true },
      changeId: CHANGE, cannotAskNow: () => null,
      propose: async () => PROPOSAL, timeoutMs: 2_000,
    });
    assert.equal(result.outcome.kind, "unanswered");
    assert.equal(result.closeSession, true);
    assert.equal(new QuestionStore(database).open(CHANGE), null);
    database.close();
  });

  it("**全用选项答完的人一个字都不用打** —— 一趟就录进去", async () => {
    const database = freshDatabase();
    let rounds = 0;
    const sessions = answeringSessions(database, (_, options) => {
      // 一律选第一个 —— 也就是「都不对，我自己写」一次都没点。
      return options[0] ?? "";
    });
    const result = await recordBrief({
      database,
      sessions: {
        type: async (...args) => { rounds += 1; return sessions.type(...args); },
        has: sessions.has,
      },
      changeId: CHANGE, cannotAskNow: () => null,
      propose: async () => PROPOSAL, timeoutMs: 2_000,
    });

    assert.equal(result.outcome.kind, "recorded");
    assert.equal(rounds, 1, "没人要写字，第二趟就不该弹 —— 弹了那句话就打了折");
    assert.equal(result.closeSession, true, "办完了也要关，否则下一次派发永远是灰的");

    const brief = new ChangeStore(database).read(CHANGE).brief;
    assert.ok(brief && brief.includes("这次改动给谁用？"), "需求真的落库了");
    assert.equal(new QuestionStore(database).open(CHANGE), null);
    database.close();
  });

  it("答不出一份需求就**不录** —— 不拿一段空白往下走", async () => {
    const database = freshDatabase();
    const result = await recordBrief({
      database,
      // action 是 decline：人按了 Esc。
      sessions: (() => {
        const questions = new QuestionStore(database);
        return {
          type: async () => {
            const open = questions.open(CHANGE);
            if (open) questions.answer(open.id, { action: "decline", content: {} });
            return true;
          },
          has: () => true,
        };
      })(),
      changeId: CHANGE, cannotAskNow: () => null,
      propose: async () => PROPOSAL, timeoutMs: 2_000,
    });
    assert.equal(result.outcome.kind, "not_recorded");
    assert.equal(
      new ChangeStore(database).read(CHANGE).brief, null,
      "拿一段空白往下走等于又回到那份编出来的 PRD",
    );
    database.close();
  });
});
