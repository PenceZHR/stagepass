import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import type { Criterion, RubricRole } from "../domain/rubric";
import { RUBRIC_ROLES, UntrustedKeyError, InvalidCriterionError } from "../domain/rubric";
import type { RubricEdit } from "../domain/rubric-edit";
import { retireStandards } from "../domain/rubric-gaps";
import { ChangeStore } from "../store/change-store";
import { GapStore } from "../store/gap-store";
import { RubricStore, ReasonRequiredError } from "../store/rubric-store";
import { assessorOf } from "../work/rubric-round";

/**
 * **看和改这个阶段的评分标准** —— PRD §1.1 那个唯一的例外，从 `handle()` 里搬
 * 出来（BACKLOG §4.1·J）。
 *
 * > 改标准可以在网页上，裁决不行（2026-07-29 用户拍板）。
 *
 * 所以这个文件里有 `saveRubric`，而**永远不会有 approve / reject / waive** ——
 * 那三个只能走裁决那道题，在 Codex 自己画的选择器里。
 *
 * 落到能查的判据上：这两条路只碰 rubric 表和它派生的 standard gap，
 * **碰不到 changes、commands、questions 一个字节**。
 */

export interface RoleRubric {
  readonly role: RubricRole;
  /**
   * 这一份是项目级默认还是这个 Change 自己的。编辑器要显示出来，否则人不知道
   * 自己在改的是谁。
   */
  readonly scope: "project" | "change" | null;
  readonly version: number;
  readonly criteria: readonly Criterion[];
  /**
   * 这一份由谁判，null = 不进对抗（人自己看）。
   *
   * **从 domain 读，界面不许自己抄一份。** 少了它，verdict 那一栏会显示「这个角色
   * 当时没有 rubric」—— 标准明明在，只是不再由模型判。
   */
  readonly assessedBy: ReturnType<typeof assessorOf>;
}

export type RubricOutcome =
  /**
   * **不要把「没有这个 Change」降级成「所有角色都没有 rubric」。**
   *
   * 后者是合法状态（空 rubric = 这个阶段不做判定），前者是问错了地方 —— 混在
   * 一起，界面会摆出一个空编辑器，人填完按保存才收到 404。
   */
  | { readonly kind: "no_such_change" }
  | { readonly kind: "ok"; readonly roles: readonly RoleRubric[] };

/** 每个角色一份，取「这个 Change 自己的，没有就项目级默认」。 */
export function rubricFor(input: {
  database: Database.Database;
  changeId: string;
  phase: Phase;
}): RubricOutcome {
  const projectId = projectOf(input.database, input.changeId);
  if (projectId === null) return { kind: "no_such_change" };

  const rubrics = new RubricStore(input.database);
  return {
    kind: "ok",
    roles: RUBRIC_ROLES.map((role) => {
      const current = rubrics.effective(projectId, input.changeId, input.phase, role);
      return {
        role,
        scope: current === null ? null
          : (current.scope.changeId === null ? "project" : "change"),
        version: current?.version ?? 0,
        criteria: current?.criteria ?? [],
        assessedBy: assessorOf(role),
      };
    }),
  };
}

export type UpgradeRubricsOutcome =
  | { readonly kind: "no_such_change" }
  | {
    readonly kind: "done";
    /** 升上来的那几份，`阶段/角色`。 */
    readonly upgraded: readonly string[];
    /** 没升的那几份，连同为什么。**一定要显示出来** —— 静默跳过等于骗人。 */
    readonly skipped: readonly { readonly scope: string; readonly why: string }[];
  };

/**
 * 把这个项目里**从没被人改过**的出厂标准升到当前出厂版。
 *
 * ## 为什么这个动作必须存在
 *
 * `installDefaults` 只补空缺（那条语义是对的），于是改一次 `rubric-defaults.ts`
 * 对**已经存在的项目零效果** —— 它留着建项目那天装上的那一版。2026-07-31 真机
 * 栽过一次：Review 那条早就改掉的旧措辞还留在老项目里，裁判拿它判了个假阳性的 `no`。
 *
 * ## 它仍然属于「网页上唯一可以改的东西」
 *
 * 改的是**标准**，不是对这一次产物的裁决 —— 和 `saveRubric` 同一条线（PRD §1.1）。
 * 只碰 rubric 表；不碰 changes / commands / questions 一个字节。
 *
 * ## 对同一份只有第一次有效
 *
 * 升完版本就是 2，再按一次会被当成「你改过它」跳过（`RubricStore.upgradeDefaults`
 * 的判据）。这是刻意的：它是一次性的救火动作，不是一个可以反复按的同步按钮。
 */
export function upgradeRubrics(input: {
  database: Database.Database;
  changeId: string;
}): UpgradeRubricsOutcome {
  const projectId = projectOf(input.database, input.changeId);
  if (projectId === null) return { kind: "no_such_change" };
  const result = new RubricStore(input.database).upgradeDefaults(projectId);
  return { kind: "done", upgraded: result.upgraded, skipped: result.skipped };
}

export type SaveRubricOutcome =
  | { readonly kind: "no_such_change" }
  | {
    readonly kind: "saved";
    readonly version: number;
    readonly retired: readonly string[];
  }
  /** 撤下一条正活着的阻断标准，理由必填 —— 三种拒绝都要说清是哪一种。 */
  | { readonly kind: "reason_required"; readonly retired: readonly string[] }
  | { readonly kind: "untrusted_key"; readonly key: string }
  | { readonly kind: "invalid"; readonly code: string };

/**
 * 存一个新版本。
 *
 * 进来的是**已经解好的**那份编辑（`parseRubricEdit`）—— 把字节变成字符串是
 * `domain/rubric-edit.ts` 的活，而调用方就在那条边界上（PRD §9.3 第五条常驻
 * 护栏：`src/web/` 不许自己解码）。
 */
export function saveRubric(input: {
  database: Database.Database;
  changeId: string;
  phase: Phase;
  role: RubricRole;
  edit: RubricEdit;
}): SaveRubricOutcome {
  const { database, changeId, phase, edit } = input;
  const projectId = projectOf(database, changeId);
  if (projectId === null) return { kind: "no_such_change" };

  const scope = {
    projectId,
    // 改项目级默认，还是只给这个 Change 覆盖 —— 人要显式选，不给默认。
    changeId: edit.scope === "change" ? changeId : null,
    phase,
    role: input.role,
  };

  try {
    const saved = new RubricStore(database).save(scope, edit.drafts, edit.reason);
    /*
     * 撤下一条标准，它派生的阻断项跟着退休。理由带进 `resolution` ——
     * **关掉一个问题必须说明理由，rubric 这条路也不例外。**
     */
    if (saved.retired.length > 0) {
      const gaps = new GapStore(database);
      gaps.replace(changeId, phase, retireStandards(
        gaps.all(changeId, phase), scope.role,
        saved.retired.map((entry) => entry.key),
        edit.reason ?? "",
      ));
    }
    return {
      kind: "saved",
      version: saved.version,
      retired: saved.retired.map((entry) => entry.key),
    };
  } catch (error: unknown) {
    if (error instanceof ReasonRequiredError) {
      return { kind: "reason_required", retired: error.retired };
    }
    if (error instanceof UntrustedKeyError) return { kind: "untrusted_key", key: error.key };
    if (error instanceof InvalidCriterionError) return { kind: "invalid", code: error.code };
    throw error;
  }
}

/** 这个 Change 属于哪个项目。null = 没有这个 Change，或者它不属于任何项目。 */
function projectOf(database: Database.Database, changeId: string): string | null {
  try {
    return new ChangeStore(database).read(changeId).projectId;
  } catch {
    return null;
  }
}
