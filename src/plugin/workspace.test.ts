import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema";
import { ProjectStore } from "../store/project-store";
import { openDatabase } from "./sqlite-handle";
import { projectForWorkspace, workspacePaths } from "./workspace";

const AT = "2026-07-28T00:00:00.000Z";

/** Codex 真的发来的那个形状（2026-08-18 从 `tools/call` 的 `_meta` 里抄下来的）。 */
const REAL_META = {
  "x-codex-turn-metadata": {
    session_id: "01a014e5-77df-7f21-9838-001a4c89aafa",
    workspace_kind: "project",
    workspaces: {
      "/Users/zhanghr/Desktop/stagepass": {
        associated_remote_urls: { origin: "git@github.com:PenceZHR/stagepass.git" },
        latest_git_commit_hash: "e21d0079385763ef1fb293d5a2052a39ff37a773",
        has_changes: true,
      },
    },
    model: "gpt-5.6-sol",
  },
  plugin_id: "stagepass@stagepass-local",
};

function open() {
  const database = openDatabase(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const projects = new ProjectStore(database, () => new Date(AT));
  projects.ensure("PRJ-1", "小游戏", "/Users/zhanghr/Desktop/demo");
  projects.ensure("PRJ-2", "海战小游戏", "/Users/zhanghr/Desktop/海战小游戏");
  return database;
}

describe("plugin · 跟着 Codex 的工作目录走", () => {
  /*
   * 打的是真实症状：**项目认不出来，面板显示成空的。**
   * 成因是 `workspaces` 是**以路径为键的对象**，而第一版的兜底只遍历了值。
   */
  it("从 Codex 真发来的那个形状里读出工作目录（键，不是值）", () => {
    assert.deepEqual(workspacePaths(REAL_META), ["/Users/zhanghr/Desktop/stagepass"]);
  });

  it("形状变了还能顶一阵 —— 值里的绝对路径也捞得到", () => {
    const odd = { "x-codex-turn-metadata": { workspaces: ["/Users/zhanghr/Desktop/demo"] } };

    assert.deepEqual(workspacePaths(odd), ["/Users/zhanghr/Desktop/demo"]);
  });

  it("什么都没有时返回空，不抛", () => {
    assert.deepEqual(workspacePaths({}), []);
    assert.deepEqual(workspacePaths(null), []);
  });

  it("在项目的子目录里开的会话也认得出来", () => {
    const database = open();
    try {
      const found = projectForWorkspace(database, ["/Users/zhanghr/Desktop/海战小游戏/src/scene"]);

      assert.equal(found?.id, "PRJ-2");
    } finally {
      database.close();
    }
  });

  it("两个项目都沾边时，取更具体的那个", () => {
    const database = open();
    try {
      new ProjectStore(database, () => new Date(AT))
        .ensure("PRJ-3", "只是子目录", "/Users/zhanghr/Desktop/海战小游戏/src");

      const found = projectForWorkspace(database, ["/Users/zhanghr/Desktop/海战小游戏/src/scene"]);

      assert.equal(found?.id, "PRJ-3");
    } finally {
      database.close();
    }
  });

  /*
   * 认不出来必须返回 null。猜一个最近的项目，人会看着**别人的**阶段环做决定 ——
   * 那比显示成空的坏得多。
   */
  it("目录不属于任何项目时返回 null，不猜一个最近的", () => {
    const database = open();
    try {
      assert.equal(projectForWorkspace(database, ["/Users/zhanghr/Desktop/无关目录"]), null);
    } finally {
      database.close();
    }
  });
});
