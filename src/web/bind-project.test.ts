import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_SQL } from "../db/schema";
import { openDatabase } from "./sqlite-handle";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { bindProject, defaultChange } from "./bind-project";

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

/**
 * 工作台绑定一个项目之后，「看哪条 Change」也不该再问人。
 *
 * 2026-08-19 真机：用户起在海战小游戏上，库里明明有 CHG-002，而面板说「认不出是
 * 哪个 Change」、环是空的 —— 他的结论是「里面什么都没有」。**数据在，只是没被选中。**
 *
 * 插件那一层原来就替人挑了第一条（「一个项目通常只有一条在办的 Change，让人为此
 * 再点一下没有意义」）；删插件时那段跟着没了，这里补回来。
 */
describe("web · 没指定就看这个项目的第一条", () => {
  it("按建立顺序取第一条", () => {
    const database = freshDatabase();
    new ProjectStore(database).ensure("PRJ-1", "小游戏", "/tmp/x");
    const changes = new ChangeStore(database);
    changes.create("CHG-002", { projectId: "PRJ-1" });
    changes.create("CHG-003", { projectId: "PRJ-1" });

    assert.equal(defaultChange(database, "PRJ-1"), "CHG-002");
    database.close();
  });

  /** 一条都没有就是 null —— **不编一个**，面板照实说「这个项目还没有 Change」。 */
  it("一条都没有就说没有", () => {
    const database = freshDatabase();
    new ProjectStore(database).ensure("PRJ-1", "小游戏", "/tmp/x");

    assert.equal(defaultChange(database, "PRJ-1"), null);
    database.close();
  });

  /** 别的项目的 Change 不算数 —— 绑定的意义就是隔离。 */
  it("只看绑定的那个项目", () => {
    const database = freshDatabase();
    const projects = new ProjectStore(database);
    projects.ensure("PRJ-1", "小游戏", "/tmp/x");
    projects.ensure("PRJ-2", "别的", "/tmp/y");
    new ChangeStore(database).create("CHG-009", { projectId: "PRJ-2" });

    assert.equal(defaultChange(database, "PRJ-1"), null);
    database.close();
  });
});
