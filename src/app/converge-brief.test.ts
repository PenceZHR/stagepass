import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { confirmBrief, draftBrief, briefFileNames } from "./converge-brief";

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
        runTurn: async () => { throw new Error("不该被调"); },
        writeBriefFile,
      });
      assert.equal(outcome.kind, "no_aside_conversation");
    } finally {
      database.close();
    }
  });

  it("起草跑在旁路线程上，草稿和工作稿各落一份、内容相同", async () => {
    const { database, files, writeBriefFile } = open();
    try {
      new BindingStore(database).bindAside(CHANGE, "T-CHAT");
      const turns: string[] = [];
      const outcome = await draftBrief({
        database, changeId: CHANGE,
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
      assert.match(new ChangeStore(database).read(CHANGE).brief ?? "", /演练/);
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
