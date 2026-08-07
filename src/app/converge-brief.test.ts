import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import {
  confirmBrief, draftBrief, draftPrompt, briefFileNames, humanTurnsIn, STAGEPASS_SAID,
} from "./converge-brief";

/**
 * 批 2「模型起草，人改」，不经过 HTTP、不碰 Codex。
 *
 * 这里最值得钉的是那条**机械判据**：未经人编辑的草稿不算 brief。它是
 * `round-turn-runner` 那句「人要的是这些，他自己答的，不是模型猜的」的地基 ——
 * 靠流程叮嘱守不住，所以由代码拒绝，而这几条测试钉住「真的会拒」。
 */

const CHANGE = "CHG-B2";

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database).create(CHANGE);
  /** 内存里的 briefs 目录 —— 测试不摸真文件系统。 */
  const files = new Map<string, string>();
  const writeBriefFile = (name: string, content: string): string => {
    files.set(name, content);
    return `/briefs/${name}`;
  };
  const readBriefFile = (name: string): string | null => files.get(name) ?? null;
  return { database, files, writeBriefFile, readBriefFile };
}

describe("app · 闲聊起草 brief（draftBrief）", () => {
  it("没有旁路对话就不起草 —— 没有对话可整理，草稿只能是编的", async () => {
    const { database, writeBriefFile } = open();
    try {
      const outcome = await draftBrief({
        database, changeId: CHANGE,
        saidIn: () => [],
        runTurn: async () => { throw new Error("不该被调"); },
        writeBriefFile,
      });
      assert.equal(outcome.kind, "no_aside_conversation");
    } finally {
      database.close();
    }
  });

  /**
   * **2026-08-06 真机上放过去的那一份。**
   *
   * 判据原来是「有没有旁路会话」，而按一下「旁路窗口」会话当场就建好 —— 那道闸
   * 永远放行。模型于是交回一份四节全是「本会话尚未谈到具体改动内容」的草稿，
   * StagePass 把它写进了 ~/.stagepass/briefs/。一份没有对话的草稿不是差一点的
   * 草稿，是**凭空的需求**。
   */
  it("**窗口开着但人没说过话 —— 拒**，一个 turn 都不跑", async () => {
    const { database, files, writeBriefFile } = open();
    try {
      new BindingStore(database).bindAside(CHANGE, "T-CHAT");
      const outcome = await draftBrief({
        database, changeId: CHANGE,
        // rollout 里只有 StagePass 自己打进去的那两句（开场白 + 上次的起草指令）。
        saidIn: () => [
          `${STAGEPASS_SAID} 这是 StagePass 里 ${CHANGE} 的旁路会话（…）。`,
          draftPrompt(CHANGE),
        ],
        runTurn: async () => { throw new Error("不该被调 —— 没对话就不该起草"); },
        writeBriefFile,
      });
      assert.equal(outcome.kind, "no_conversation_yet");
      assert.equal(files.size, 0, "空对话也落了草稿文件");
    } finally {
      database.close();
    }
  });

  it("StagePass 自己的话不算「人说过」—— 标记是判据，不靠比对正文", () => {
    assert.equal(humanTurnsIn([`${STAGEPASS_SAID} 开场白`, draftPrompt(CHANGE)]), 0);
    assert.equal(humanTurnsIn([`${STAGEPASS_SAID} 开场白`, "我要重构存档"]), 1);
    // 前面有空白也认得出来 —— composer 有时会带一格缩进。
    assert.equal(humanTurnsIn([`  ${STAGEPASS_SAID} 开场白`]), 0);
  });

  it("起草的提示词必须是一行 —— 它要被打进 composer，换行就是提交", () => {
    assert.ok(!draftPrompt(CHANGE).includes("\n"),
      "多行提示词打进 composer 会被截成半句发出去");
  });

  it("起草跑在旁路线程上，草稿和工作稿各落一份、内容相同", async () => {
    const { database, files, writeBriefFile } = open();
    try {
      new BindingStore(database).bindAside(CHANGE, "T-CHAT");
      const turns: string[] = [];
      const outcome = await draftBrief({
        database, changeId: CHANGE,
        saidIn: () => ["我要一键回滚"],
        runTurn: async (threadId, prompt) => {
          turns.push(threadId, prompt);
          return "要一键回滚：上线砸了要能在一分钟内回去。\n";
        },
        writeBriefFile,
      });
      assert.equal(outcome.kind, "drafted");
      assert.equal(turns[0], "T-CHAT", "没跑在旁路线程上 —— 对话在那条线程的历史里");
      const names = briefFileNames(CHANGE);
      assert.equal(files.get(names.draft), files.get(names.edit),
        "工作稿的起点必须就是草稿 —— 人是在它上面改");
      assert.match(files.get(names.draft) ?? "", /一键回滚/);
    } finally {
      database.close();
    }
  });

  it("模型交回空白 —— 说失败，不落一份空草稿", async () => {
    const { database, files, writeBriefFile } = open();
    try {
      new BindingStore(database).bindAside(CHANGE, "T-CHAT");
      const outcome = await draftBrief({
        database, changeId: CHANGE,
        saidIn: () => ["我要一键回滚"],
        runTurn: async () => "  \n ",
        writeBriefFile,
      });
      assert.equal(outcome.kind, "draft_failed");
      assert.equal(files.size, 0);
    } finally {
      database.close();
    }
  });
});

describe("app · brief 定稿（confirmBrief）—— 未经编辑的草稿不算", () => {
  const drafted = async () => {
    const context = open();
    new BindingStore(context.database).bindAside(CHANGE, "T-CHAT");
    await draftBrief({
      database: context.database, changeId: CHANGE,
      saidIn: () => ["我要一键回滚"],
      runTurn: async () => "草稿：要一键回滚。",
      writeBriefFile: context.writeBriefFile,
    });
    return context;
  };

  it("**逐字未改 —— 拒绝**，brief 不落库", async () => {
    const { database, readBriefFile } = await drafted();
    try {
      const outcome = confirmBrief({ database, changeId: CHANGE, readBriefFile });
      assert.equal(outcome.kind, "draft_unedited");
      assert.equal(new ChangeStore(database).read(CHANGE).brief, null,
        "未经编辑的草稿被录成了 brief ——「他自己答的」从此是假话");
    } finally {
      database.close();
    }
  });

  it("只动了行尾和首尾空白 —— 仍算没改（编辑器自动做的事不是人的编辑）", async () => {
    const { database, files, readBriefFile } = await drafted();
    try {
      const names = briefFileNames(CHANGE);
      files.set(names.edit, `  ${files.get(names.draft)!.replaceAll("\n", " \r\n")}  `);
      assert.equal(
        confirmBrief({ database, changeId: CHANGE, readBriefFile }).kind,
        "draft_unedited");
    } finally {
      database.close();
    }
  });

  it("真改过了 —— 录进去的是人改过的那版", async () => {
    const { database, files, readBriefFile } = await drafted();
    try {
      const names = briefFileNames(CHANGE);
      files.set(names.edit,
        "要一键回滚，而且回滚本身要有演练：每次发布前自动演练一次回滚路径。");
      const outcome = confirmBrief({ database, changeId: CHANGE, readBriefFile });
      assert.equal(outcome.kind, "recorded");
      assert.equal(outcome.kind === "recorded" ? outcome.replaced : "?", null,
        "本来就没有 brief，不该报「顶掉了谁」");
      assert.match(new ChangeStore(database).read(CHANGE).brief ?? "", /演练/);
    } finally {
      database.close();
    }
  });

  /**
   * **顶掉一份已经存在的 brief 要说出来。** 下游每个阶段的任务书都读它 ——
   * 换掉它就是换掉整条流水线的地基，而 2026-08-06 真机上界面一个字都没提醒：
   * CHG-001 手里有一份人答过九道题的真 brief，而一份空对话草稿差点顶掉它。
   */
  it("顶掉已有的 brief —— 把被顶掉的那份原文交出去", async () => {
    const { database, files, readBriefFile } = await drafted();
    try {
      new ChangeStore(database).setBrief(CHANGE, "人当初答出来的那份需求");
      files.set(briefFileNames(CHANGE).edit, "改过的新需求");
      const outcome = confirmBrief({ database, changeId: CHANGE, readBriefFile });
      assert.equal(outcome.kind, "recorded");
      assert.equal(outcome.kind === "recorded" ? outcome.replaced : null,
        "人当初答出来的那份需求", "顶掉了一份 brief 却没说");
    } finally {
      database.close();
    }
  });

  it("改成空白 —— 拒绝；没起草过 —— 说清楚", async () => {
    const { database, files, readBriefFile } = await drafted();
    try {
      const names = briefFileNames(CHANGE);
      files.set(names.edit, "  \n ");
      assert.equal(
        confirmBrief({ database, changeId: CHANGE, readBriefFile }).kind,
        "empty_brief");

      files.clear();
      assert.equal(
        confirmBrief({ database, changeId: CHANGE, readBriefFile }).kind,
        "nothing_drafted");
    } finally {
      database.close();
    }
  });
});
