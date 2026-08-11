import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import {
  nextVersion,
  retiredBy,
  type Assessment,
  type Criterion,
  type CriterionDraft,
  type RubricRole,
  type RubricVerdict,
} from "../domain/rubric";
import { PHASES, type Phase } from "../domain/phase";
import { RUBRIC_ROLES } from "../domain/rubric";
import { defaultCriteria } from "../domain/rubric-defaults";

/**
 * rubric 存在哪里：版本化写入，加上「撤下一条标准要留下理由」。
 *
 * ## 编辑产生新版本，不原地改
 *
 * 每一条判定都记着它当时用的版本 id，所以旧版本必须留着。这也是 rubric 可编辑而
 * 不会让任何已盖章的东西失效的原因：**没有任何东西回溯派生**。
 *
 * ## 为什么 `save` 会拒绝一次合法的写入
 *
 * PRD §1.1：网页可以改「标准」，但一次会退休掉正活着的阻断项的编辑，效果等同于把
 * 一个 gap 标成 closed —— 而「沉默不能关闭一个问题」是 `domain/gap.ts` 整套机制的
 * 立身之本。所以这种编辑必须带理由，和 `applyRound` 拒绝一个没有 reason 的 close
 * 完全同构。
 *
 * 「改标准」仍然自由，**它只是不能是静默的**。
 *
 * ## 作用域
 *
 * `change_id` 为 NULL 是项目级默认，change 级覆盖它。读的时候用 `effective`：
 * change 级有就用，没有就落回项目级，两边都没有就是 null —— 而 null 是合法的，
 * 表示这个阶段不做 rubric 判定。
 */

export interface RubricScope {
  readonly projectId: string;
  /** null = 项目级默认。 */
  readonly changeId: string | null;
  readonly phase: Phase;
  readonly role: RubricRole;
}

export interface RubricVersion {
  readonly id: string;
  readonly scope: RubricScope;
  readonly version: number;
  readonly reason: string | null;
  readonly criteria: readonly Criterion[];
  readonly createdAt: string;
}

export interface SavedRubric extends RubricVersion {
  /**
   * 这次编辑退休掉的阻断标准。
   *
   * 调用方拿它去退休对应的 gap（L5-3）。空数组表示这次编辑没有放松任何东西。
   */
  readonly retired: readonly Criterion[];
}

export interface AssessmentInput {
  readonly criterionKey: string;
  readonly verdict: RubricVerdict;
  readonly evidence: string | null;
}

/** 存下来的判定：领域里的 `Assessment`，加上它属于哪一轮、哪一版。 */
export interface StoredAssessment extends Assessment {
  readonly round: number;
  readonly rubricId: string;
}

export class ReasonRequiredError extends Error {
  constructor(readonly retired: readonly string[]) {
    super(`retiring ${retired.join(", ")} needs a reason`);
    this.name = "ReasonRequiredError";
  }
}

interface RubricRow {
  id: string;
  project_id: string;
  change_id: string | null;
  phase: string;
  role: string;
  version: number;
  reason: string | null;
  created_at: string;
}

interface CriterionRow {
  criterion_key: string;
  ordinal: number;
  text: string;
  blocking: number;
  section: string | null;
}

interface AssessmentRow {
  round: number;
  rubric_id: string;
  criterion_key: string;
  verdict: string;
  evidence: string | null;
  criterion_text: string;
  blocking_then: number;
  section: string | null;
}

export interface RubricStoreOptions {
  now?: () => Date;
  /** 注入进来，好让版本内容在测试里是确定的。 */
  mintKey?: () => string;
}

/**
 * 升级动作写在 `rubrics.reason` 上的标记。
 *
 * **它是「这一版是机器写的」的唯一判据** —— 人自己保存时理由是他写的话或者 null，
 * 两种都对不上。别改这句话的措辞：改了之后，所有已经升过的那些会在下一次升级里
 * 被当成「人改过的」跳过。
 */
export const FACTORY_UPGRADE_REASON = "出厂标准升级（这一份从未被人改过）";

export class RubricStore {
  private readonly now: () => Date;
  private readonly mintKey: () => string;

  constructor(
    private readonly database: Database.Database,
    options: RubricStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.mintKey = options.mintKey ?? (() => `RBC-${randomUUID()}`);
  }

  /**
   * 给一个项目铺上出厂标准，**只补空缺**。
   *
   * 已经有 rubric 的 (阶段, 角色) 一个字都不碰 —— 人改过的东西不会被一次「装默认」
   * 冲掉。所以这个方法可以反复调，也应该反复调：加了新阶段之后再调一次，只会补上
   * 新的那些。
   *
   * 出厂的每一条都不阻断，理由见 domain/rubric-defaults.ts 开头。
   *
   * 返回补了几份。
   */
  installDefaults(projectId: string): number {
    let installed = 0;
    for (const phase of PHASES) {
      for (const role of RUBRIC_ROLES) {
        const scope = { projectId, changeId: null, phase, role };
        if (this.current(scope) !== null) continue;
        const drafts = defaultCriteria(phase, role);
        if (drafts.length === 0) continue;
        this.save(scope, drafts);
        installed += 1;
      }
    }
    return installed;
  }

  /**
   * 把**没被人碰过**的出厂标准升到当前出厂版。
   *
   * ## 为什么需要它
   *
   * `installDefaults` 只补空缺（那条语义是对的，别动它）—— 于是改一次
   * `rubric-defaults.ts` 对**已经存在的项目零效果**，它留着建项目那天装上的那一版。
   * 2026-07-31 真机栽过一次：Review 那条早就改掉的旧措辞还留在老项目里，裁判拿它
   * 判了个假阳性的 `no`。
   *
   * ## 判据：这一版是谁写的
   *
   * 两种算「没被人碰过」：
   *
   * - `version === 1` —— 从来没人按过保存，还是装上那天那份
   * - 当前版本的 `reason` 是 `FACTORY_UPGRADE_REASON` —— **上一次升级自己写的**
   *
   * 第二条 2026-08-06 加的，起因是第一条把自己锁死了：升一次版本就变 2，
   * 下一次出厂标准再改，同一份**永远升不上去了** —— 而它从头到尾没有人碰过。
   * 一个只能用一次的同步动作不是同步动作。
   *
   * 人自己保存的那一版，`reason` 要么是他写的理由、要么是 null，两种都对不上这个
   * 标记 —— 所以**人改过的照旧一个字都不碰**。
   *
   * 漏判的情况：人保存时恰好把理由写成了那句一模一样的话。可以接受 —— 那句话是
   * 括号带说明的完整句子，不是人会随手打出来的。
   */
  upgradeDefaults(projectId: string): {
    upgraded: string[];
    skipped: { scope: string; why: string }[];
    /**
     * 这次升级**撤下**了哪些标准 —— 调用方要拿它去退休那些标准派生的、还开着的
     * 阻断项（`domain/rubric-gaps.ts` 的 `retireStandards`）。
     *
     * ## 为什么非交出来不可（2026-08-10 真机顶出来的）
     *
     * 人手动改标准那条路（`app/edit-rubric.ts`）一直在退休遗留项；**而后台升级
     * 这条路把 `save` 算出的 `retired` 丢掉了**。同一件事两条路，只有一条做对。
     *
     * 代价是真机上量到的：CHG-001 的 Build 上挂着两条谁也关不掉的孤儿 ——
     * 「TestPlan 标为必须通过的用例全部通过」（环 v3 把它挪去 QA 了）和
     * 「改动范围和 Plan 一致」（改名成 BuildPlan 之后的同义重复）。前者更糟：
     * 任务书明令 Build 不许碰测试，**红方结构上不可能满足它**，而新一轮的反方
     * 也不会再判它 —— 没有任何轮次关得掉，它就永远挡着闸门。
     */
    retired: { phase: Phase; role: RubricRole; keys: string[] }[];
  } {
    const upgraded: string[] = [];
    const skipped: { scope: string; why: string }[] = [];
    const retired: { phase: Phase; role: RubricRole; keys: string[] }[] = [];
    for (const phase of PHASES) {
      for (const role of RUBRIC_ROLES) {
        const scope = { projectId, changeId: null, phase, role };
        const current = this.current(scope);
        const drafts = defaultCriteria(phase, role);
        if (current === null || drafts.length === 0) continue;
        const name = `${phase}/${role}`;
        const untouched = current.version === 1
          || current.reason === FACTORY_UPGRADE_REASON;
        if (!untouched) {
          skipped.push({ scope: name, why: "你改过它" });
          continue;
        }
        // 已经和出厂版逐字相同就不动 —— 白升一版会让「v1 = 没人碰过」这条判据失效。
        const same = current.criteria.length === drafts.length
          && current.criteria.every((each, index) =>
            each.text === drafts[index]!.text
            && each.blocking === drafts[index]!.blocking
            && each.section === (drafts[index]!.section ?? null));
        if (same) continue;
        /*
         * **必须带理由** —— 升级会把旧条目整批换掉，其中标着阻断的那些会退休，
         * 而 `save` 对那件事要一句话（`ReasonRequiredError`）。理由写清是**谁**
         * 换的：人回头看版本历史时，「出厂标准升级」和「我那天改的」得分得开。
         */
        const saved = this.save(scope, drafts, FACTORY_UPGRADE_REASON);
        upgraded.push(name);
        if (saved.retired.length > 0) {
          retired.push({
            phase, role, keys: saved.retired.map((entry) => entry.key),
          });
        }
      }
    }
    return { upgraded, skipped, retired };
  }

  /** 这个 scope 当前生效的版本，没有就 null。 */
  current(scope: RubricScope): RubricVersion | null {
    const row = (scope.changeId === null
      ? this.database.prepare(
          `SELECT * FROM rubrics
            WHERE project_id = ? AND change_id IS NULL AND phase = ? AND role = ?
              AND is_current = 1`,
        ).get(scope.projectId, scope.phase, scope.role)
      : this.database.prepare(
          `SELECT * FROM rubrics
            WHERE project_id = ? AND change_id = ? AND phase = ? AND role = ?
              AND is_current = 1`,
        ).get(scope.projectId, scope.changeId, scope.phase, scope.role)) as
      RubricRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** 一个具体版本，按 id。已存的判定引用的就是它。 */
  byId(rubricId: string): RubricVersion | null {
    const row = this.database.prepare(
      "SELECT * FROM rubrics WHERE id = ?",
    ).get(rubricId) as RubricRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  /**
   * 实际生效的那一份：change 级优先，其次项目级默认。
   *
   * 两边都没有返回 null，而 **null 是合法的** —— 表示这个阶段不做 rubric 判定，
   * 行为退回没有 rubric 之前的样子。
   */
  effective(
    projectId: string, changeId: string, phase: Phase, role: RubricRole,
  ): RubricVersion | null {
    return this.current({ projectId, changeId, phase, role })
      ?? this.current({ projectId, changeId: null, phase, role });
  }

  /**
   * 存一个新版本。
   *
   * 会退休掉正活着的阻断标准时，`reason` 必填 —— 见本文件开头。
   */
  save(
    scope: RubricScope,
    drafts: readonly CriterionDraft[],
    reason?: string,
  ): SavedRubric {
    const previous = this.current(scope);
    const criteria = nextVersion(previous?.criteria ?? [], drafts, this.mintKey);
    const retired = retiredBy(previous?.criteria ?? [], criteria);

    if (retired.length > 0 && (reason ?? "").trim() === "") {
      throw new ReasonRequiredError(retired.map((entry) => entry.key));
    }

    const id = `RB-${randomUUID()}`;
    const at = this.now().toISOString();
    const version = (previous?.version ?? 0) + 1;

    this.database.transaction(() => {
      // 先退旧的：两条部分唯一索引保证同一 scope 只有一行 current，不先退就写不进去。
      if (previous) {
        this.database.prepare("UPDATE rubrics SET is_current = 0 WHERE id = ?")
          .run(previous.id);
      }
      this.database.prepare(
        `INSERT INTO rubrics
           (id, project_id, change_id, phase, role, version, is_current, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        id, scope.projectId, scope.changeId, scope.phase, scope.role,
        version, reason ?? null, at,
      );
      const insert = this.database.prepare(
        `INSERT INTO rubric_criteria
           (rubric_id, criterion_key, ordinal, text, blocking, section)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of criteria) {
        insert.run(
          id, entry.key, entry.ordinal, entry.text, entry.blocking ? 1 : 0,
          entry.section);
      }
    })();

    return {
      id, scope, version, reason: reason ?? null, criteria, createdAt: at, retired,
    };
  }

  /**
   * 记下一轮对一份 rubric 的判定。
   *
   * 正文和 blocking 从 `rubricId` 那一版**当时**的内容取，不从当前 rubric 取 ——
   * 开启一条阻断项读的是这份快照，退休才读当前。这个不对称是「编辑 rubric 只能关
   * 不能开」的全部依据。
   *
   * 同一 (change, phase, role, round, criterion) 重复记录是覆盖，不是插两行：一轮
   * 对一条标准只有一个判定，两行会让「这一轮说了什么」没有答案。
   */
  record(
    changeId: string,
    phase: Phase,
    role: RubricRole,
    round: number,
    rubric: RubricVersion,
    assessments: readonly AssessmentInput[],
  ): void {
    const byKey = new Map(rubric.criteria.map((entry) => [entry.key, entry]));
    const at = this.now().toISOString();
    const upsert = this.database.prepare(
      `INSERT INTO rubric_assessments
         (change_id, phase, role, round, rubric_id, criterion_key,
          verdict, evidence, criterion_text, blocking_then, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (change_id, phase, role, round, criterion_key) DO UPDATE SET
         rubric_id = excluded.rubric_id,
         verdict = excluded.verdict,
         evidence = excluded.evidence,
         criterion_text = excluded.criterion_text,
         blocking_then = excluded.blocking_then,
         created_at = excluded.created_at`,
    );

    this.database.transaction(() => {
      for (const entry of assessments) {
        const criterion = byKey.get(entry.criterionKey);
        // 未知 key 在解析层就该作废整份输出（L5-2）。走到这里说明上游放行了一条
        // 不属于这份 rubric 的判定 —— 存下去它就成了一条没有标准的阻断项。
        if (!criterion) {
          throw new Error(`unknown_criterion:${entry.criterionKey}`);
        }
        upsert.run(
          changeId, phase, role, round, rubric.id, entry.criterionKey,
          entry.verdict, entry.evidence, criterion.text, criterion.blocking ? 1 : 0, at,
        );
      }
    })();
  }

  /**
   * 这个阶段**最近一轮**的判定，按角色分。没跑过任何一轮返回 null。
   *
   * ## null 和空数组是两件事
   *
   * `null` = 这个阶段还没跑过 rubric。
   * 有值但某个角色是空数组 = 那个角色没有 rubric（合法）。
   * 有值且全是 `not_assessed` = **跑了，但模型没照契约作答** —— 这一条在 gaps 里
   * 看不出来，因为 `yes` 和 `not_assessed` 都不留痕迹。人最需要看见的正是它。
   *
   * 只给最近一轮：人要看的是「现在怎么样」。历史在库里，要翻再翻。
   */
  latestRound(changeId: string, phase: Phase): {
    round: number;
    byRole: Record<RubricRole, StoredAssessment[]>;
    /**
     * 这一轮的判定落库的时刻（最晚那条）。裁决题面拿它对照账本判「上游在这之后
     * 动过没有」—— 2026-08-09 真机：Plan 的题面写着「9 条全部满足」，其实是
     * 三天前旧轮的判定，而上游 Arch 在那之后整个重写过。
     */
    at: string | null;
  } | null {
    const top = this.database.prepare(
      `SELECT max(round) AS round FROM rubric_assessments
        WHERE change_id = ? AND phase = ?`,
    ).get(changeId, phase) as { round: number | null };
    if (top.round === null) return null;

    const byRole = { producer: [], critic: [], verdict: [] } as
      Record<RubricRole, StoredAssessment[]>;
    for (const role of RUBRIC_ROLES) {
      byRole[role] = this.assessments(changeId, phase, role, top.round);
    }
    const when = this.database.prepare(
      `SELECT max(created_at) AS at FROM rubric_assessments
        WHERE change_id = ? AND phase = ? AND round = ?`,
    ).get(changeId, phase, top.round) as { at: string | null };
    return { round: top.round, byRole, at: when.at };
  }

  /** 一轮的判定。**按 round 读，不按 run 读** —— 理由见 schema 里那段注释。 */
  assessments(
    changeId: string, phase: Phase, role: RubricRole, round: number,
  ): StoredAssessment[] {
    const rows = this.database.prepare(
      /*
       * `section` **join 出来，不另存一列** —— `rubric_id` 记的就是判定当时那一版，
       * 所以 join 到的 section 天然是快照，和 `criterion_text` 同一个语义。
       * 存第二份只会多一个会漂的地方。
       *
       * LEFT JOIN：那一版被删掉的极端情况下读出 NULL，而不是整行消失 ——
       * 少一行判定，人看到的「几条没勾上」就是错的。
       */
      `SELECT a.round, a.rubric_id, a.criterion_key, a.verdict, a.evidence,
              a.criterion_text, a.blocking_then, c.section
         FROM rubric_assessments a
         LEFT JOIN rubric_criteria c
           ON c.rubric_id = a.rubric_id AND c.criterion_key = a.criterion_key
        WHERE a.change_id = ? AND a.phase = ? AND a.role = ? AND a.round = ?
        ORDER BY a.criterion_key`,
    ).all(changeId, phase, role, round) as AssessmentRow[];

    return rows.map((row) => ({
      round: row.round,
      rubricId: row.rubric_id,
      criterionKey: row.criterion_key,
      verdict: row.verdict as RubricVerdict,
      evidence: row.evidence,
      criterionText: row.criterion_text,
      blockingThen: row.blocking_then === 1,
      section: row.section ?? null,
    }));
  }

  private hydrate(row: RubricRow): RubricVersion {
    const criteria = this.database.prepare(
      `SELECT criterion_key, ordinal, text, blocking, section
         FROM rubric_criteria WHERE rubric_id = ? ORDER BY ordinal`,
    ).all(row.id) as CriterionRow[];

    return {
      id: row.id,
      scope: {
        projectId: row.project_id,
        changeId: row.change_id,
        phase: row.phase as Phase,
        role: row.role as RubricRole,
      },
      version: row.version,
      reason: row.reason,
      createdAt: row.created_at,
      criteria: criteria.map((entry) => ({
        key: entry.criterion_key,
        ordinal: entry.ordinal,
        text: entry.text,
        blocking: entry.blocking === 1,
        // 老行读回来可能是 undefined（列是后加的），统一成 null。
        section: entry.section ?? null,
      })),
    };
  }
}
