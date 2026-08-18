import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { decisionLabel, DECISION_FIELD } from "../domain/question";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { ScriptedTurnRunner, TurnLoop } from "../work/turn-loop";
import { decideGate } from "./decide-gate";
import { recordBrief } from "./record-brief";

const PROPOSAL = [
  "```brief",
  "给谁用？ | 自己 | 团队 | 外部用户",
  "什么算做完？ | 能启动 | 有测试 | 已上线",
  "明确不做什么？ | 不联网 | 不改界面 | 不加依赖",
  "```",
].join("\n");

describe("acceptance · 一条 Change 从需求录入走到下一阶段", () => {
  it("pending → brief → running → settled → 人批准 → Spec/pending", async () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(SCHEMA_SQL);
    new ProjectStore(database).ensure("PRJ-E2E", "E2E", "/tmp/stagepass-e2e");
    const changes = new ChangeStore(database);
    changes.create("CHG-E2E", { projectId: "PRJ-E2E", title: "跑通状态流" });
    const questions = new QuestionStore(database);

    // 录需求的表也在浏览器里答（C 方案）—— 像人一样过一会儿去答。
    const answeringBrief = setInterval(() => {
      if (!database.open) { clearInterval(answeringBrief); return; }
      const open = questions.open("CHG-E2E");
      if (!open) return;
      const content = Object.fromEntries(Object.entries(
        open.question.requestedSchema.properties,
      ).map(([id, field]) => [id, field.enum?.[0] ?? ""]));
      questions.answer(open.id, { action: "accept", content });
    }, 20);
    answeringBrief.unref();
    /*
     * 和真系统同一个节拍：起草完立刻返回 asked，答案落库后再喊一遍用例消费
     * （`/api/answer` 那个循环）。上面的定时器扮演「人在浏览器里答」。
     */
    let brief = await recordBrief({
      database, changeId: "CHG-E2E",
      cannotAskNow: () => null,
      propose: async () => PROPOSAL,
    });
    for (let i = 0; i < 5 && brief.outcome.kind === "asked"; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      brief = await recordBrief({
        database, changeId: "CHG-E2E",
        cannotAskNow: () => null,
        propose: async () => PROPOSAL,
      });
    }
    clearInterval(answeringBrief);
    assert.equal(brief.outcome.kind, "recorded");
    assert.ok(changes.read("CHG-E2E").brief);
    assert.equal(changes.read("CHG-E2E").state.status, "pending");

    const loop = new TurnLoop({
      database,
      runner: new ScriptedTurnRunner([{
        artifactIds: ["PRD.md"],
        blockers: [],
      }]),
    });
    const now = Date.now();
    loop.queueTurn({
      changeId: "CHG-E2E",
      jobId: "JOB-E2E-PRD-1",
      phase: "PRD",
      deadlineAt: now + 60_000,
      maxAttempts: 1,
    });
    assert.equal(changes.read("CHG-E2E").state.status, "running");
    assert.deepEqual(await loop.runOnce({
      owner: "acceptance",
      token: "acceptance-token",
      now,
      ttlMs: 30_000,
    }), { kind: "settled", jobId: "JOB-E2E-PRD-1" });
    assert.equal(changes.read("CHG-E2E").state.status, "settled");

    const answering = setInterval(() => {
      if (!database.open) { clearInterval(answering); return; }
      const open = questions.open("CHG-E2E");
      if (!open) return;
      questions.answer(open.id, {
        action: "accept",
        content: { [DECISION_FIELD]: decisionLabel("approve") },
      });
    }, 20);
    answering.unref();
    const decideOnce = () => decideGate({
      database,
      changeId: "CHG-E2E",
      cannotAskNow: () => null,
      rerun: async () => null,
      onApproved: () => {},
      roundBudget: 5,
      sessions: {},
    });
    let decision = await decideOnce();
    for (let i = 0; i < 5 && decision.outcome.kind === "asked"; i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      decision = await decideOnce();
    }
    clearInterval(answering);
    assert.equal(decision.outcome.kind, "decided");
    assert.deepEqual(changes.read("CHG-E2E").state, {
      phase: "Spec",
      status: "pending",
      returnStack: [],
    });
    assert.deepEqual(
      changes.ledger("CHG-E2E").map((entry) => entry.action),
      ["create", "start", "settle", "approve"],
    );
    database.close();
  });
});
