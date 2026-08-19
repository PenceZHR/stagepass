import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProcessOps, ProcessRequest } from "../system/process";
import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ParallelStore } from "../store/parallel-store";
import { ProjectStore } from "../store/project-store";
import { nudgeAfterRound, nudgeFor, sendNudge } from "./nudge";
import { openDatabase } from "./sqlite-handle";

const AT = "2026-07-28T00:00:00.000Z";

describe("plugin · 轮到人了才响", () => {
  /*
   * 打的是真实症状：**一轮跑完，闸门在等人，而人不知道。**
   *
   * 一轮实测 60~343 分钟。跑完之后没有任何东西说话 —— 人得自己记得回来看。
   * 这套东西的命题是「人要看得见它跑」，而不是「人要记得去看」。
   */
  it("有问题要裁决 —— 响，并且说清楚等的是裁决不是批准", () => {
    const nudge = nudgeFor({
      changeId: "CHG-002", phase: "Arch", status: "blocked", failure: null,
    });

    assert.notEqual(nudge, null);
    assert.equal(nudge!.title.includes("CHG-002"), true);
    assert.equal(nudge!.title.includes("Arch"), true);
    assert.equal(nudge!.body.includes("裁决"), true);
  });

  it("干净跑完等批准 —— 响，而且和裁决那条说的不是同一句", () => {
    const decide = nudgeFor({
      changeId: "CHG-002", phase: "Arch", status: "blocked", failure: null,
    });
    const approve = nudgeFor({
      changeId: "CHG-002", phase: "Arch", status: "settled", failure: null,
    });

    assert.equal(approve!.body.includes("批准"), true);
    assert.notEqual(approve!.body, decide!.body);
  });

  it("最后一个阶段批准了 —— 说这件事结束了", () => {
    const nudge = nudgeFor({
      changeId: "CHG-002", phase: "QA", status: "closed", failure: null,
    });

    assert.equal(nudge!.body.includes("结束"), true);
  });

  /*
   * 还在跑不是「有事」。每一轮中途都响一次，人两天之内就会把通知关掉，
   * 那时候真有事也叫不动他了。
   */
  it("还在跑就不响", () => {
    assert.equal(nudgeFor({
      changeId: "CHG-002", phase: "Arch", status: "running", failure: null,
    }), null);
    assert.equal(nudgeFor({
      changeId: "CHG-002", phase: "Arch", status: "pending", failure: null,
    }), null);
  });

  it("没跑成要把原因带上 —— 「失败了」和「为什么」是两件事", () => {
    const nudge = nudgeFor({
      changeId: "CHG-002", phase: "Arch", status: "blocked",
      failure: "codex_unavailable: daemon 没应答",
    });

    assert.equal(nudge!.body.includes("daemon 没应答"), true);
  });

  /*
   * **人自己按的「停掉这一轮」不响。** 他就在屏幕跟前，刚松开鼠标。
   * 对着人已经知道的事再叫一声，是这类通知失去可信度的第一步。
   */
  it("人自己中止的不响", () => {
    assert.equal(nudgeFor({
      changeId: "CHG-002", phase: "Arch", status: "blocked", failure: "aborted_by_human",
    }), null);
  });
});

describe("plugin · 通知怎么送出去", () => {
  /*
   * **文本走 argv，不拼进脚本。** 失败原因里带一个引号（模型的输出里到处都是），
   * 拼字符串的话 osascript 会把后面的东西当代码 —— 一条通知变成一次任意执行。
   */
  it("标题和正文作为参数交出去，不拼进 osascript 脚本", async () => {
    const seen: ProcessRequest[] = [];
    const fake = {
      run: async (request: ProcessRequest) => {
        seen.push(request);
        return { code: 0, signal: null, stdout: "", stderr: "" };
      },
    } as unknown as ProcessOps;

    await sendNudge(
      { title: "StagePass · CHG-002 Arch", body: ' 没跑成："引号" 和 $(rm -rf /)' },
      fake,
    );

    const request = seen[0]!;
    assert.equal(request.command, "osascript");
    const script = request.args.filter((_, index) => index % 2 === 1).join("\n");
    assert.equal(script.includes("引号"), false, "正文不许出现在脚本里");
    assert.equal(request.args.includes(' 没跑成："引号" 和 $(rm -rf /)'), true, "正文该在 argv 里");
  });

  /** 通知送不出去不能让这一轮的结算失败 —— 它是提醒，不是功能。 */
  it("osascript 炸了也不抛", async () => {
    const fake = {
      run: async () => { throw new Error("osascript 不在"); },
    } as unknown as ProcessOps;

    await sendNudge({ title: "t", body: "b" }, fake);
  });
});

describe("plugin · 一轮之后该问谁要状态", () => {
  const open = () => {
    const database = openDatabase(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(SCHEMA_SQL);
    new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "小游戏", "/tmp/repo");
    new ChangeStore(database, { now: () => new Date(AT) }).create("CHG-1", { projectId: "PRJ-1" });
    return database;
  };
  const recorder = () => {
    const sent: string[] = [];
    return {
      sent,
      ops: {
        run: async (request: ProcessRequest) => {
          sent.push(request.args[request.args.length - 1] ?? "");
          return { code: 0, signal: null, stdout: "", stderr: "" };
        },
      } as unknown as ProcessOps,
    };
  };

  /*
   * **座位的轮要问座位。** 并行座位跑完时主线可能还是 `running`（它自己那一轨在忙），
   * 问错了对象就永远读到 running，于是这条通知在整条并行轨上一次都不会响 ——
   * 而那正是最容易被忘掉的一轨。
   */
  it("座位上的轮读座位的状态，不读主线的", async () => {
    const database = open();
    try {
      new ChangeStore(database, { now: () => new Date(AT) }).apply("CHG-1", "start");
      new ParallelStore(database).open("CHG-1", "TestPlan");
      new ParallelStore(database).apply("CHG-1", "TestPlan", "start");
      new ParallelStore(database).apply("CHG-1", "TestPlan", "fail");
      const spy = recorder();

      await nudgeAfterRound({
        database, changeId: "CHG-1", phase: "TestPlan", onSeat: true,
        result: { kind: "settled", jobId: "JOB-1" },
        process: spy.ops,
      });

      assert.equal(spy.sent.length, 1);
      assert.equal(spy.sent[0]?.includes("TestPlan"), true);
    } finally {
      database.close();
    }
  });

  it("主线的轮读主线 —— 还在跑就不响", async () => {
    const database = open();
    try {
      new ChangeStore(database, { now: () => new Date(AT) }).apply("CHG-1", "start");
      const spy = recorder();

      await nudgeAfterRound({
        database, changeId: "CHG-1", phase: "PRD", onSeat: false,
        result: { kind: "settled", jobId: "JOB-1" },
        process: spy.ops,
      });

      assert.deepEqual(spy.sent, []);
    } finally {
      database.close();
    }
  });

  /** 一条活儿都没领到（`idle`）不是「一轮跑完了」—— 一个字都不该说。 */
  it("空转不响", async () => {
    const database = open();
    try {
      const spy = recorder();

      await nudgeAfterRound({
        database, changeId: "CHG-1", phase: "PRD", onSeat: false,
        result: { kind: "idle" }, process: spy.ops,
      });

      assert.deepEqual(spy.sent, []);
    } finally {
      database.close();
    }
  });
});
