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

/**
 * **这个文件本身就是 §4.1 那条抱怨的答案。**
 *
 * > 用例没法单独测 —— 746 个测试全是模块级的。
 *
 * 接受风险这条路原来整个写在 `handle()` 的 HTTP 分支里，于是验它只有一条路：
 * 起一个真服务器、真 socket、假 pty，再从响应的 JSON 倒推逻辑对不对。下面这些
 * 用例**一个 HTTP、一个进程都没有** —— 库、直接调那个函数。
 *
 * 答题的节拍和真系统一样：`waive` 起草完立刻返回 `asked`，测试替 `/api/answer`
 * 落答案、再喊一遍用例消费 —— 没有定时器、没有等待。
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

/** 一条开着的 P1 —— 也就是「可以带着走」的那一种。 */
function openP1(database: Database.Database, id = "G-1"): void {
  new GapStore(database).replace(CHANGE, "PRD", [{
    id, kind: "finding", severity: "P1", title: "接口没有错误码",
    status: "open", openedRound: 1, resolution: null,
  } as never]);
}

const plain = { cannotAskNow: () => null };

/** `/api/answer` 那个循环的镜像：问出来就按 `fill` 答掉、再喊一遍，直到终局。 */
async function drive(
  database: Database.Database,
  fill: (fieldId: string) => string,
): ReturnType<typeof waive> {
  const questions = new QuestionStore(database);
  for (let round = 0; round < 5; round += 1) {
    const result = await waive({ database, changeId: CHANGE, ...plain });
    if (result.outcome.kind !== "asked") return result;
    const open = questions.open(CHANGE);
    assert.ok(open, "说了 asked 却没有 open 的题");
    const content: Record<string, string> = {};
    for (const key of Object.keys(open.question.requestedSchema.properties)) {
      content[key] = fill(key);
    }
    questions.answer(open.id, { action: "accept", content });
  }
  throw new Error("驱动 5 次还没到终局");
}

describe("app · 接受风险这个用例（不经过 HTTP）", () => {
  it("没有这个 Change —— 说 no_such_change，**不是** 404", async () => {
    const database = freshDatabase();
    const result = await waive({ database, changeId: "CHG-不存在", ...plain });
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
    const result = await waive({ database, changeId: CHANGE, ...plain });
    assert.equal(result.outcome.kind, "nothing_waivable");
    assert.equal(new QuestionStore(database).open(CHANGE), null, "连题都不该落");
    database.close();
  });

  it("**P0 不在候选里** —— 严重到不可接受的问题不能靠普通确认绕过", async () => {
    const database = freshDatabase();
    new GapStore(database).replace(CHANGE, "PRD", [{
      id: "G-1", kind: "finding", severity: "P0", title: "会丢数据",
      status: "open", openedRound: 1, resolution: null,
    } as never]);
    const result = await waive({ database, changeId: CHANGE, ...plain });
    assert.equal(result.outcome.kind, "nothing_waivable");
    database.close();
  });

  it("现在不能问就不问，并说出是什么挡着", async () => {
    const database = freshDatabase();
    openP1(database);
    const result = await waive({
      database, changeId: CHANGE,
      cannotAskNow: () => ({ reason: "phase_already_running", busy: "terminal" }),
    });
    assert.equal(result.outcome.kind, "busy");
    database.close();
  });

  /**
   * **没人答就让题挂着 —— 那不是失败。** 旧形状是 15 分钟死线 + 收题 +
   * `no_answer_in_time`；现在题没有截止，跟会话活不活着也没关系（它压根就
   * 在浏览器里）。再问一遍也不另起 —— 另起会 supersede 掉人正对着的表。
   */
  it("没人答：题挂着、不收、不重复起草", async () => {
    const database = freshDatabase();
    openP1(database);
    const first = await waive({ database, changeId: CHANGE, ...plain });
    assert.equal(first.outcome.kind, "asked");
    assert.equal(first.closeSession, false);

    const open = new QuestionStore(database).open(CHANGE);
    assert.ok(open, "题该摆着等人");

    const second = await waive({ database, changeId: CHANGE, ...plain });
    assert.equal(second.outcome.kind, "asked");
    assert.equal(
      second.outcome.kind === "asked" && second.outcome.questionId, open.id,
      "同一道题 —— 不许 supersede 人正对着的表",
    );
    database.close();
  });

  it("重启后把已经答完的两趟风险表落库，不重新起草", async () => {
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

    const result = await waive({ database, changeId: CHANGE, ...plain });

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

    // 第一趟纯选项格，第二趟才要理由 —— drive 一趟一趟地答，和人一样。
    const result = await drive(database, (key) =>
      key.endsWith("x") ? "这一版先不做，下一版补" : WAIVE_ACCEPT);

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
