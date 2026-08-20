import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema";
import { PluginRuntime } from "./runtime";
import { openDatabase } from "./sqlite-handle";
import type { RepoOps } from "../work/repo";

/** 这一组一轮都不派，所以 git 一次都不会被问到。 */
const repo = { trackedFiles: () => null } as unknown as RepoOps;

describe("plugin · 执行通道", () => {
  /*
   * 打的是真实症状：**打开面板看一眼，机器上多了一个 codex 进程。**
   *
   * `codex app-server` 是懒起的（只在第一次真派轮时）。所以每一个「只是问问」的
   * 入口都必须能在没有连接的时候回答 —— 拿不到就说拿不到，不许顺手把 daemon
   * 拉起来（用户的界面原则：看状态不该有副作用）。
   */
  it("没派过轮时，问进度和问归档都拿到 null —— 不去起 daemon", () => {
    const database = openDatabase(":memory:");
    try {
      database.exec(SCHEMA_SQL);
      const runtime = new PluginRuntime({ database, repo });

      assert.equal(runtime.liveProgress(), null);
      assert.equal(runtime.archiveOps(), null);
    } finally {
      database.close();
    }
  });
});
