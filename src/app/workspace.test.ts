import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";
import {
  createChange, createProject, deleteChange, deleteProject,
} from "./workspace";

/**
 * 新建和删除 Project / Change，**不经过 HTTP**。
 *
 * 这几条是「可以在网页上做」的那一类（PRD §1.1：它们不推动闸门、不对产物下判断）。
 * 两条硬规矩都是撞出来的：路径必填且当场校验、有活儿在跑就不许删。
 */

const NOT_BUSY = () => null;
const nothingToForget = (): void => {};

function freshDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  return database;
}

/** 一个真的临时目录 —— 路径校验查的是磁盘，给它一个假的就什么都没验到。 */
function withTempDir(body: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "stagepass-ws-")));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("app · 新建和删除（不经过 HTTP）", () => {
  /**
   * **路径必填，而且当场校验。** 一个 Project 就是一个仓库，Codex 就跑在那个目录
   * 里 —— 建一个没有路径的项目等于建一个「不知道在哪」的项目，那正是用户撞上的洞。
   *
   * 错在这里发现比在 pty 里发现便宜得多，所以三条都查，而且**每一条各有名字**：
   * 一句笼统的「路径不对」等于让人自己猜是哪不对。
   */
  it("路径的四种不对，各有各的名字", () => {
    const database = freshDatabase();
    withTempDir((dir) => {
      const file = join(dir, "不是目录.txt");
      writeFileSync(file, "x");
      const cases = [
        [{ name: "", path: dir }, "name_required"],
        [{ name: "p", path: "  " }, "path_required"],
        [{ name: "p", path: "./relative" }, "path_must_be_absolute"],
        [{ name: "p", path: join(dir, "不存在") }, "path_does_not_exist"],
        [{ name: "p", path: file }, "path_is_not_a_directory"],
      ] as const;
      for (const [input, expected] of cases) {
        assert.equal(createProject({ database, ...input }).kind, expected);
      }
      assert.deepEqual(
        new ProjectStore(database).list(), [],
        "一条都不该建出来 —— 拒了就是拒了",
      );
    });
    database.close();
  });

  it("建好的项目带上出厂标准，而且回得出「它建在哪」", () => {
    const database = freshDatabase();
    withTempDir((dir) => {
      const created = createProject({ database, name: "我的项目", path: dir });
      assert.equal(created.kind, "created");
      if (created.kind !== "created") return;
      assert.match(created.id, /^PRJ-\d{3}$/);
      assert.equal(created.path, dir, "人得看得见它建在哪 —— 那正是用户撞上的洞");

      // 不装出厂标准的话，这个项目每个阶段都是空 rubric，人得逐个手写才能开始用。
      const rubric = new RubricStore(database)
        .effective(created.id, "CHG-任意", "PRD", "critic");
      assert.notEqual(rubric, null, "新项目该带着出厂标准出生");
    });
    database.close();
  });

  it("id 是下一个空号，不重号", () => {
    const database = freshDatabase();
    withTempDir((dir) => {
      const first = createProject({ database, name: "a", path: dir });
      const second = createProject({ database, name: "b", path: dir });
      assert.equal(first.kind === "created" && first.id, "PRJ-001");
      assert.equal(second.kind === "created" && second.id, "PRJ-002");

      const projectId = first.kind === "created" ? first.id : "";
      assert.equal(
        createChange({ database, projectId, title: "一" }).kind === "created"
        && (createChange({ database, projectId, title: "二" }) as { id: string }).id,
        "CHG-002",
      );
    });
    database.close();
  });

  it("往一个不存在的项目里建 Change —— 拒；标题为空也拒", () => {
    const database = freshDatabase();
    assert.equal(
      createChange({ database, projectId: "PRJ-不存在", title: "x" }).kind,
      "no_such_project");
    assert.equal(
      createChange({ database, projectId: "PRJ-不存在", title: "  " }).kind,
      "title_required", "标题先查 —— 两个都不对时说更早的那个");
    database.close();
  });

  /**
   * **有活儿在跑就不许删。** 不是出于谨慎：删掉一个正在跑的 Change 会留下一个没人
   * 认领的 codex 进程，而它会继续往一个已经不存在的账本上写。
   */
  it("在跑的 Change 删不掉，而且不碰它的终端", () => {
    const database = freshDatabase();
    withTempDir((dir) => {
      const project = createProject({ database, name: "p", path: dir });
      const projectId = project.kind === "created" ? project.id : "";
      const change = createChange({ database, projectId, title: "t" });
      const changeId = change.kind === "created" ? change.id : "";

      const forgotten: string[] = [];
      const busy = deleteChange({
        database, changeId,
        isBusy: () => ({ reason: "phase_already_running", busy: "running", jobId: "J-1" }),
        forget: (id) => { forgotten.push(id); },
      });
      assert.equal(busy.kind, "busy");
      /*
       * `assert.deepEqual(x, [])` 会把 `x` 收窄成 `never[]`（它是个 assertion
       * 签名），后面再 push 就不过类型检查了 —— 所以这里数个数。
       */
      assert.equal(forgotten.length, 0, "拒了就一个进程都不该动");
      assert.equal(new ChangeStore(database).list().length, 1, "它还在");

      const gone = deleteChange({
        database, changeId, isBusy: NOT_BUSY,
        forget: (id) => { forgotten.push(id); },
      });
      assert.equal(gone.kind, "deleted");
      assert.deepEqual(
        forgotten, [changeId],
        "forget 而不是 close —— 连尸体一起收，否则下一个重名的会继承这一屏",
      );
      assert.equal(new ChangeStore(database).list().length, 0);
    });
    database.close();
  });

  it("删不存在的东西 —— 说不存在，不假装删掉了", () => {
    const database = freshDatabase();
    assert.equal(
      deleteChange({
        database, changeId: "CHG-不存在", isBusy: NOT_BUSY, forget: nothingToForget,
      }).kind, "no_such_change");
    assert.equal(
      deleteProject({
        database, projectId: "PRJ-不存在", isBusy: NOT_BUSY, forget: nothingToForget,
      }).kind, "no_such_project");
    database.close();
  });

  it("删项目把它底下的 Change 一起带走；有一条在跑就整个拒", () => {
    const database = freshDatabase();
    withTempDir((dir) => {
      const project = createProject({ database, name: "p", path: dir });
      const projectId = project.kind === "created" ? project.id : "";
      createChange({ database, projectId, title: "一" });
      const second = createChange({ database, projectId, title: "二" });
      const busyId = second.kind === "created" ? second.id : "";

      const forgotten: string[] = [];
      const refused = deleteProject({
        database, projectId,
        // 只有第二条在跑 —— 一条挡着，整个项目就删不得。
        isBusy: (id) => id === busyId
          ? { reason: "phase_already_running", busy: "running" } : null,
        forget: (id) => { forgotten.push(id); },
      });
      assert.equal(refused.kind, "busy");
      assert.equal(refused.kind === "busy" && refused.changeId, busyId, "要说出是哪一条挡着");
      assert.equal(forgotten.length, 0, "**先全查一遍再动手** —— 否则第一条已经被收了");
      assert.equal(new ChangeStore(database).list().length, 2);

      const gone = deleteProject({
        database, projectId, isBusy: NOT_BUSY,
        forget: (id) => { forgotten.push(id); },
      });
      assert.equal(gone.kind, "deleted");
      assert.equal(gone.kind === "deleted" && gone.changes, 2);
      assert.equal(forgotten.length, 2, "每条 Change 的尸体都要跟着走");
      assert.deepEqual(new ProjectStore(database).list(), []);
      assert.equal(new ChangeStore(database).list().length, 0);
    });
    database.close();
  });
});
