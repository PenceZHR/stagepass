import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { standardGapId } from "../domain/rubric-gaps";
import { ChangeStore } from "../store/change-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";
import { rubricFor, saveRubric } from "./edit-rubric";

/**
 * 看和改评分标准，**不经过 HTTP**。
 *
 * 这是 PRD §1.1 那个唯一的例外（改标准可以在网页上，裁决不行），也是 `web/` 唯一
 * 一条会写的路 —— 所以它的规矩最值得单独钉住，而不是从 400/404 的状态码倒推。
 */

const PROJECT = "PRJ-A";
const CHANGE = "CHG-A";

function freshDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure(PROJECT, "p", "/tmp");
  new ChangeStore(database).create(CHANGE, { projectId: PROJECT });
  return database;
}

describe("app · 看和改评分标准（不经过 HTTP）", () => {
  /**
   * **不要把「没有这个 Change」降级成「所有角色都没有 rubric」。**
   *
   * 后者是合法状态（空 rubric = 这个阶段不做判定），前者是问错了地方。混在一起，
   * 界面会摆出一个空编辑器，人填完按保存才收到 404。
   */
  it("没有这个 Change 和「三个角色都是空的」**不是同一件事**", () => {
    const database = freshDatabase();

    const missing = rubricFor({ database, changeId: "CHG-不存在", phase: "PRD" });
    assert.equal(missing.kind, "no_such_change");

    const empty = rubricFor({ database, changeId: CHANGE, phase: "PRD" });
    assert.equal(empty.kind, "ok");
    assert.deepEqual(
      empty.kind === "ok" ? empty.roles.map((r) => [r.role, r.version, r.scope]) : [],
      [["producer", 0, null], ["critic", 0, null], ["verdict", 0, null]],
      "空 rubric 是合法状态，要说得出来",
    );
    database.close();
  });

  /**
   * `assessedBy` **从 domain 读，界面不许自己抄一份**。少了它，verdict 那一栏会
   * 显示「这个角色当时没有 rubric」—— 标准明明在，只是不再由模型判。
   */
  it("每个角色说得出「这一份由谁判」", () => {
    const database = freshDatabase();
    const view = rubricFor({ database, changeId: CHANGE, phase: "PRD" });
    assert.equal(view.kind, "ok");
    if (view.kind !== "ok") return;
    assert.equal(
      view.roles.every((role) => "assessedBy" in role), true,
      "null 也是一个答案（不进对抗，人自己看）—— 但这一格必须在",
    );
    database.close();
  });

  it("存一个新版本，scope 说得出改的是项目级还是这个 Change", () => {
    const database = freshDatabase();
    for (const [scope, expected] of [["project", "project"], ["change", "change"]] as const) {
      const saved = saveRubric({
        database, changeId: CHANGE, phase: "PRD", role: "critic",
        edit: {
          scope,
          drafts: [{ text: `${scope}：验收标准必须可测`, blocking: true }],
          reason: undefined,
        },
      });
      assert.equal(saved.kind, "saved");

      const view = rubricFor({ database, changeId: CHANGE, phase: "PRD" });
      const critic = view.kind === "ok"
        ? view.roles.find((role) => role.role === "critic") : undefined;
      assert.equal(critic?.scope, expected, "人要看得见自己在改的是谁");
    }
    database.close();
  });

  /**
   * **撤下一条正活着的阻断标准，理由必填。** 三种拒绝都要说清是哪一种 ——
   * 前端要分别提示，一句笼统的「保存失败」等于让人自己猜。
   */
  it("撤下一条阻断标准不给理由 —— 拒，而且说得出是哪一种拒", () => {
    const database = freshDatabase();
    const first = saveRubric({
      database, changeId: CHANGE, phase: "PRD", role: "critic",
      edit: { scope: "change", drafts: [{ text: "验收标准必须可测", blocking: true }], reason: undefined },
    });
    assert.equal(first.kind, "saved");

    // 把它整条撤下来（drafts 里不再有它），不给理由。
    const refused = saveRubric({
      database, changeId: CHANGE, phase: "PRD", role: "critic",
      edit: { scope: "change", drafts: [], reason: undefined },
    });
    assert.equal(refused.kind, "reason_required");
    assert.equal(
      refused.kind === "reason_required" && refused.retired.length, 1,
      "要说出是哪几条被撤，否则人不知道该给谁写理由",
    );

    // 版本没动 —— 拒了就是拒了，不许半保存。
    const still = new RubricStore(database).effective(PROJECT, CHANGE, "PRD", "critic");
    assert.equal(still?.criteria.length, 1);
    database.close();
  });

  /**
   * 撤下一条标准，**它派生的阻断项跟着退休**，理由带进 `resolution` ——
   * 关掉一个问题必须说明理由，rubric 这条路也不例外。
   */
  it("撤下标准，它派生的阻断项跟着退休，理由留得住", () => {
    const database = freshDatabase();
    const saved = saveRubric({
      database, changeId: CHANGE, phase: "PRD", role: "critic",
      edit: { scope: "change", drafts: [{ text: "验收标准必须可测", blocking: true }], reason: undefined },
    });
    assert.equal(saved.kind, "saved");
    const key = new RubricStore(database)
      .effective(PROJECT, CHANGE, "PRD", "critic")!.criteria[0]!.key;

    // 这条标准判 no 之后开出来的那个 standard gap。**id 的形状是承重的** ——
    // `retireStandards` 靠 `RB:<role>:<key>` 认出「这条 gap 是那条标准派生的」。
    new GapStore(database).replace(CHANGE, "PRD", [{
      id: standardGapId("critic", key), kind: "standard", severity: null,
      title: "验收标准必须可测",
      status: "open", openedRound: 1, resolution: null,
    }] as never);

    const retired = saveRubric({
      database, changeId: CHANGE, phase: "PRD", role: "critic",
      edit: { scope: "change", drafts: [], reason: "这条挪到 TestPlan 去判了" },
    });
    assert.equal(retired.kind, "saved");
    assert.deepEqual(retired.kind === "saved" ? [...retired.retired] : [], [key]);

    const gap = new GapStore(database).all(CHANGE, "PRD")[0]!;
    assert.notEqual(gap.status, "open", "标准撤了，它派生的阻断项不该还挡着");
    assert.match(
      gap.resolution ?? "", /这条挪到 TestPlan 去判了/,
      "关掉一个问题必须说明理由，rubric 这条路也不例外",
    );
    database.close();
  });

  it("往一个不存在的 Change 上存 —— 拒，不静默建一份", () => {
    const database = freshDatabase();
    const outcome = saveRubric({
      database, changeId: "CHG-不存在", phase: "PRD", role: "critic",
      edit: { scope: "change", drafts: [{ text: "x", blocking: false }], reason: undefined },
    });
    assert.equal(outcome.kind, "no_such_change");
    database.close();
  });
});
