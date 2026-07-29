import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "./change-store";
import { ProjectStore } from "./project-store";
import { ReasonRequiredError, RubricStore } from "./rubric-store";
import { PHASES } from "../domain/phase";
import { RUBRIC_ROLES } from "../domain/rubric";

const PROJECT = "PRJ-1";
const CHANGE = "CHG-1";

function open(): { database: Database.Database; rubrics: RubricStore } {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure(PROJECT, "p");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT });

  let minted = 0;
  const rubrics = new RubricStore(database, {
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    mintKey: () => `K${(minted += 1)}`,
  });
  return { database, rubrics };
}

const projectScope = { projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" } as const;
const changeScope = { projectId: PROJECT, changeId: CHANGE, phase: "Spec", role: "producer" } as const;

describe("rubric store · 版本化写入", () => {
  it("存一版，读回来", () => {
    const { rubrics } = open();
    rubrics.save(projectScope, [{ text: "验收标准必须可测", blocking: true }]);

    const current = rubrics.current(projectScope);
    assert.equal(current?.version, 1);
    assert.deepEqual(current?.criteria.map((entry) => [entry.key, entry.text, entry.blocking]),
      [["K1", "验收标准必须可测", true]]);
  });

  it("再存一版 —— 旧版本还在，不原地改", () => {
    const { database, rubrics } = open();
    const first = rubrics.save(projectScope, [{ text: "一", blocking: true }]);
    rubrics.save(projectScope, [{ text: "一", blocking: true, key: "K1" }, { text: "二", blocking: false }]);

    assert.equal(rubrics.current(projectScope)?.version, 2);
    // 旧行仍在库里，而且已经不是 current —— 已经存过的判定还引用着它。
    const rows = database.prepare(
      "SELECT version, is_current FROM rubrics ORDER BY version",
    ).all() as { version: number; is_current: number }[];
    assert.deepEqual(rows, [{ version: 1, is_current: 0 }, { version: 2, is_current: 1 }]);
    assert.equal(rubrics.byId(first.id)?.criteria.length, 1);
  });

  it("change 级覆盖项目级；没有 change 级就落回项目级", () => {
    const { rubrics } = open();
    rubrics.save(projectScope, [{ text: "项目默认", blocking: true }]);
    assert.equal(rubrics.effective(PROJECT, CHANGE, "Spec", "producer")?.criteria[0]?.text, "项目默认");

    rubrics.save(changeScope, [{ text: "这个 Change 自己的", blocking: true }]);
    assert.equal(
      rubrics.effective(PROJECT, CHANGE, "Spec", "producer")?.criteria[0]?.text,
      "这个 Change 自己的");
    // 项目级那份没被动过。
    assert.equal(rubrics.current(projectScope)?.criteria[0]?.text, "项目默认");
  });

  it("没有 rubric 是合法的 —— 等于这个阶段不做判定", () => {
    const { rubrics } = open();
    assert.equal(rubrics.effective(PROJECT, CHANGE, "Build", "critic"), null);
  });
});

describe("rubric store · 「一个 scope 一行 current」由数据库保证", () => {
  /*
   * SQLite 的唯一索引里 NULL 互不相等 —— 项目级 rubric 的 change_id 正是 NULL。
   * 一条索引会让所有项目级版本同时是 current，而且是**静默**的：读出来是随机哪一
   * 行。所以这两条要绕过 store 直接插，证明是数据库在拒绝，不是 store 在自觉。
   */
  it("两个项目级版本同时 current —— 数据库拒绝", () => {
    const { database, rubrics } = open();
    rubrics.save(projectScope, [{ text: "一", blocking: true }]);

    assert.throws(() => {
      database.prepare(
        `INSERT INTO rubrics (id, project_id, change_id, phase, role, version, is_current, created_at)
         VALUES ('R-X', ?, NULL, 'Spec', 'producer', 2, 1, '2026-07-29T00:00:00.000Z')`,
      ).run(PROJECT);
    }, /UNIQUE constraint failed/);
  });

  it("两个 change 级版本同时 current —— 同样拒绝", () => {
    const { database, rubrics } = open();
    rubrics.save(changeScope, [{ text: "一", blocking: true }]);

    assert.throws(() => {
      database.prepare(
        `INSERT INTO rubrics (id, project_id, change_id, phase, role, version, is_current, created_at)
         VALUES ('R-Y', ?, ?, 'Spec', 'producer', 2, 1, '2026-07-29T00:00:00.000Z')`,
      ).run(PROJECT, CHANGE);
    }, /UNIQUE constraint failed/);
  });

  it("同一个 scope 的版本号不许重复", () => {
    const { database, rubrics } = open();
    rubrics.save(projectScope, [{ text: "一", blocking: true }]);

    assert.throws(() => {
      database.prepare(
        `INSERT INTO rubrics (id, project_id, change_id, phase, role, version, is_current, created_at)
         VALUES ('R-Z', ?, NULL, 'Spec', 'producer', 1, 0, '2026-07-29T00:00:00.000Z')`,
      ).run(PROJECT);
    }, /UNIQUE constraint failed/);
  });
});

describe("rubric store · 撤下一条阻断标准要有理由", () => {
  /*
   * PRD §1.1：网页可以改标准，但一次会退休掉活着的阻断项的编辑，效果等同于把一个
   * gap 标成 closed —— 而「沉默不能关闭一个问题」是 gaps 整套机制的立身之本。
   */
  it("取消勾选阻断而不给理由 —— 拒绝", () => {
    const { rubrics } = open();
    rubrics.save(projectScope, [{ text: "挡着的", blocking: true }]);

    assert.throws(
      () => rubrics.save(projectScope, [{ text: "挡着的", blocking: false, key: "K1" }]),
      ReasonRequiredError);
  });

  it("删掉一条阻断标准而不给理由 —— 拒绝", () => {
    const { rubrics } = open();
    rubrics.save(projectScope, [{ text: "挡着的", blocking: true }]);
    assert.throws(() => rubrics.save(projectScope, []), ReasonRequiredError);
  });

  it("空白理由不算理由", () => {
    const { rubrics } = open();
    rubrics.save(projectScope, [{ text: "挡着的", blocking: true }]);
    assert.throws(
      () => rubrics.save(projectScope, [], "   "),
      ReasonRequiredError);
  });

  it("给了理由就通过，理由落库，退休名单一并返回", () => {
    const { rubrics } = open();
    rubrics.save(projectScope, [{ text: "挡着的", blocking: true }]);

    const saved = rubrics.save(projectScope, [], "这条标准本来就不该要求");
    assert.deepEqual(saved.retired.map((entry) => entry.key), ["K1"]);
    assert.equal(rubrics.current(projectScope)?.reason, "这条标准本来就不该要求");
  });

  it("只改正文不需要理由 —— 标准还在", () => {
    const { rubrics } = open();
    rubrics.save(projectScope, [{ text: "挡着的", blocking: true }]);
    const saved = rubrics.save(projectScope, [{ text: "挡着的（说清楚点）", blocking: true, key: "K1" }]);
    assert.deepEqual(saved.retired, []);
  });

  it("第一版不需要理由 —— 之前什么都没有，退不掉东西", () => {
    const { rubrics } = open();
    assert.deepEqual(rubrics.save(projectScope, [{ text: "一", blocking: true }]).retired, []);
  });
});

describe("rubric store · 判定按轮读", () => {
  it("存的是判定当时的正文与 blocking 快照", () => {
    const { rubrics } = open();
    const version = rubrics.save(projectScope, [{ text: "验收标准必须可测", blocking: true }]);

    rubrics.record(CHANGE, "Spec", "producer", 1, version, [
      { criterionKey: "K1", verdict: "no", evidence: "三条需求都没有验收标准" },
    ]);

    // 之后把标准改了、也不再阻断 —— 已存的判定不许跟着变。
    rubrics.save(projectScope, [{ text: "换了个说法", blocking: false, key: "K1" }], "不再要求");

    const [assessment] = rubrics.assessments(CHANGE, "Spec", "producer", 1);
    assert.equal(assessment?.criterionText, "验收标准必须可测");
    assert.equal(assessment?.blockingThen, true);
    assert.equal(assessment?.verdict, "no");
  });

  it("不同轮互不干扰 —— 第 2 轮读不到第 1 轮的行", () => {
    const { rubrics } = open();
    const version = rubrics.save(projectScope, [{ text: "一", blocking: true }]);
    rubrics.record(CHANGE, "Spec", "producer", 1, version, [
      { criterionKey: "K1", verdict: "no", evidence: null },
    ]);
    rubrics.record(CHANGE, "Spec", "producer", 2, version, [
      { criterionKey: "K1", verdict: "yes", evidence: null },
    ]);

    assert.equal(rubrics.assessments(CHANGE, "Spec", "producer", 1)[0]?.verdict, "no");
    assert.equal(rubrics.assessments(CHANGE, "Spec", "producer", 2)[0]?.verdict, "yes");
  });

  it("同一轮同一条重复记录 —— 后写的覆盖，不是插两行", () => {
    const { rubrics } = open();
    const version = rubrics.save(projectScope, [{ text: "一", blocking: true }]);
    rubrics.record(CHANGE, "Spec", "producer", 1, version, [
      { criterionKey: "K1", verdict: "not_assessed", evidence: null },
    ]);
    rubrics.record(CHANGE, "Spec", "producer", 1, version, [
      { criterionKey: "K1", verdict: "yes", evidence: "补答了" },
    ]);

    const rows = rubrics.assessments(CHANGE, "Spec", "producer", 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.verdict, "yes");
  });

  it("红方的判定不会被当成蓝方的 —— role 分开存", () => {
    const { rubrics } = open();
    const version = rubrics.save(projectScope, [{ text: "一", blocking: true }]);
    rubrics.record(CHANGE, "Spec", "producer", 1, version, [
      { criterionKey: "K1", verdict: "yes", evidence: null },
    ]);

    assert.equal(rubrics.assessments(CHANGE, "Spec", "producer", 1).length, 1);
    assert.equal(rubrics.assessments(CHANGE, "Spec", "critic", 1).length, 0);
  });
});

describe("rubric store · 出厂标准", () => {
  it("**一条都不阻断** —— 这条不是保守，是有出口的问题", () => {
    /*
     * not_assessed 是阻断的。出厂就勾上阻断，等于任何一次模型漏答都会立刻给每个
     * 项目挂上一条挡门的东西，而它的出口只有「进设置里把这条标准撤下来」——
     * 人会在完全不知道 rubric 是什么的情况下先被拦住。
     */
    const { rubrics } = open();
    rubrics.installDefaults(PROJECT);

    const blocking: string[] = [];
    for (const phase of PHASES) {
      for (const role of RUBRIC_ROLES) {
        const current = rubrics.current({ projectId: PROJECT, changeId: null, phase, role });
        for (const entry of current?.criteria ?? []) {
          if (entry.blocking) blocking.push(`${phase}/${role}: ${entry.text}`);
        }
      }
    }
    assert.deepEqual(blocking, []);
  });

  it("只补空缺 —— 人改过的一个字都不碰", () => {
    const { rubrics } = open();
    const mine = rubrics.save(
      { projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" },
      [{ text: "我自己写的一条", blocking: true }]);

    const installed = rubrics.installDefaults(PROJECT);
    assert.ok(installed > 0);
    // Spec/producer 是我写的那一版，没被默认冲掉。
    const spec = rubrics.current({ projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" });
    assert.equal(spec?.id, mine.id);
    assert.equal(spec?.criteria[0]?.text, "我自己写的一条");
  });

  it("反复调是安全的 —— 第二次一份都不补", () => {
    const { rubrics } = open();
    assert.ok(rubrics.installDefaults(PROJECT) > 0);
    assert.equal(rubrics.installDefaults(PROJECT), 0);
  });

  it("Done 没有出厂标准 —— 没有 turn 在那里跑，没人可以被摆一张清单", () => {
    const { rubrics } = open();
    rubrics.installDefaults(PROJECT);
    for (const role of RUBRIC_ROLES) {
      assert.equal(
        rubrics.current({ projectId: PROJECT, changeId: null, phase: "Done", role }), null);
    }
  });

  it("其余每个阶段三个角色都有", () => {
    const { rubrics } = open();
    rubrics.installDefaults(PROJECT);
    const missing: string[] = [];
    for (const phase of PHASES.filter((entry) => entry !== "Done")) {
      for (const role of RUBRIC_ROLES) {
        const current = rubrics.current({ projectId: PROJECT, changeId: null, phase, role });
        if ((current?.criteria.length ?? 0) === 0) missing.push(`${phase}/${role}`);
      }
    }
    assert.deepEqual(missing, []);
  });
});
