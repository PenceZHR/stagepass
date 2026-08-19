import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_SQL } from "../db/schema";
import { openDatabase } from "./sqlite-handle";
import { ProjectStore } from "../store/project-store";
import { bindProject } from "./bind-project";

function withRepo(body: (dir: string) => void, asRepo = true): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "stagepass-bind-")));
  if (asRepo) mkdirSync(join(dir, ".git"), { recursive: true });
  try { body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const freshDatabase = () => {
  const database = openDatabase(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  return database;
};

/**
 * 工作台绑在**它自己所在的那个仓库**上。
 *
 * 2026-08-19 用户定案：「stagepass 彻底依附在某个项目下，不再自己主动管理项目，
 * 统一 project 用一个，彻底隔离，但是需要管理 change。」
 *
 * 这也一并杀掉了今晚那个「面包屑说谎」的根源 —— 它就是「不知道自己在哪个项目」
 * 造成的：认不出来时编了一个 `CHG-1` 出来。绑定之后这个问题在结构上不存在。
 */
describe("web · 工作台绑在它所在的仓库上", () => {
  it("库里还没有这个项目 —— 建一个，名字取目录名", () => {
    const database = freshDatabase();
    withRepo((dir) => {
      const bound = bindProject(database, dir);

      assert.equal(bound.kind, "bound");
      assert.equal(bound.kind === "bound" && bound.path, dir);
      assert.equal(bound.kind === "bound" && bound.name, dir.split("/").pop());
      assert.equal(new ProjectStore(database).list().length, 1);
    });
    database.close();
  });

  /*
   * **同一个目录不许存成两条。** 每次起工作台都建一个新项目的话，Change 会散在
   * 一堆同名项目下，而人看到的只是「我的 Change 不见了」。
   */
  it("已经有同路径的项目就复用，不重复建", () => {
    const database = freshDatabase();
    withRepo((dir) => {
      new ProjectStore(database).ensure("PRJ-007", "早就建好的", dir);

      const bound = bindProject(database, dir);

      assert.equal(bound.kind === "bound" && bound.id, "PRJ-007");
      assert.equal(bound.kind === "bound" && bound.name, "早就建好的", "名字听库里的");
      assert.equal(new ProjectStore(database).list().length, 1);
    });
    database.close();
  });

  /*
   * 「所有项目必须先 git」（同日定案）。工作台起在一个非仓库目录里时要**当场说**
   * —— 那时人还没建 Change、还没写 brief，纠正的代价最小。
   */
  it("不是仓库就拒，并且说得出是哪个目录", () => {
    const database = freshDatabase();
    withRepo((dir) => {
      const outcome = bindProject(database, dir);

      assert.equal(outcome.kind, "not_a_repository");
      assert.equal(outcome.kind === "not_a_repository" && outcome.path, dir);
      assert.deepEqual(new ProjectStore(database).list(), []);
    }, false);
    database.close();
  });

  /*
   * macOS 上 `/var` 是 `/private/var` 的软链，而 Codex 按真实路径记目录信任。
   * 存两个不同的字符串指同一个目录，只会埋下一个「同一个项目有两条」的坑。
   */
  it("路径归一到 realpath —— 同一个目录只有一条", () => {
    const database = freshDatabase();
    withRepo((dir) => {
      bindProject(database, dir);
      bindProject(database, `${dir}/.`);

      assert.equal(new ProjectStore(database).list().length, 1);
    });
    database.close();
  });
});
