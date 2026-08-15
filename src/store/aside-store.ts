import type Database from "better-sqlite3";

/**
 * 旁路会话的账本（彗星，2026-08-11）。
 *
 * ## 为什么旁路要留痕
 *
 * 用户 2026-08-11 在旁路里修掉了一个真问题（测试自己启动 Cocos GUI，把 Preview
 * 占死，后面四条人工重放用例全跑不了）—— 那件事**完全正确**：它不是需求变更，
 * 为它重开一轮 PRD→Spec→Arch→BuildPlan→Build 的代价荒谬，而人的注意力是这套
 * 系统里最贵的东西。旁路存在的理由就是这个。
 *
 * 但它留下一个洞：那两个 commit **账本上看不见**。没有蓝方审过、没有裁判判过、
 * 环上画不出来，而下游会对着一份来历不明的树干活 —— QA 拿到的测试被环外的手
 * 改过，而它不知道。
 *
 * ## 判据：动了手才要理由
 *
 * 只是问个名词、聊两句：`head_before === head_after`，这一趟照记（人回头看得出
 * 「这里来过一次」），但不追问。树上真长出了 commit：`note` 必填。
 *
 * 「关掉一个问题必须说明理由」在这条路上的同一句话 —— 轻的用法保持轻，而动过手
 * 的那种在环上留得下痕。
 *
 * ## 它不推任何状态
 *
 * 和旁路本身一样：不产出、不推闸门、不占座。这张表只被读来画彗星的尾迹，和
 * 被人回头翻。
 */

export interface AsideVisit {
  readonly changeId: string;
  readonly seq: number;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly headBefore: string | null;
  readonly headAfter: string | null;
  readonly note: string | null;
  /** 这一趟动过手没有。HEAD 拿不到时是 false —— 不猜。 */
  readonly touched: boolean;
}

interface Row {
  change_id: string;
  seq: number;
  opened_at: string;
  closed_at: string | null;
  head_before: string | null;
  head_after: string | null;
  note: string | null;
}

const hydrate = (row: Row): AsideVisit => ({
  changeId: row.change_id,
  seq: row.seq,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  headBefore: row.head_before,
  headAfter: row.head_after,
  note: row.note,
  touched: row.head_before !== null && row.head_after !== null
    && row.head_before !== row.head_after,
});

export class AsideStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 进旁路。**已经有一趟开着就返回它**（幂等）—— 面板的 `/api/aside` 本来就
   * 是「开着就接上」的语义，两边必须一致，否则每点一次侧栏就记一趟空账。
   */
  open(changeId: string, head: string | null): AsideVisit {
    const live = this.live(changeId);
    if (live !== null) return live;
    const at = this.now().toISOString();
    const seq = (this.database.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS n FROM aside_visits WHERE change_id = ?",
    ).get(changeId) as { n: number }).n + 1;
    this.database.prepare(
      `INSERT INTO aside_visits
         (change_id, seq, opened_at, closed_at, head_before, head_after, note)
       VALUES (?, ?, ?, NULL, ?, NULL, NULL)`,
    ).run(changeId, seq, at, head);
    return this.live(changeId)!;
  }

  /**
   * 出旁路，记下当时的 HEAD。**返回这一趟要不要人写一句** ——
   * 动过手（HEAD 变了）就要，只聊过不要。
   *
   * 没有开着的那一趟就什么都不做（幂等）：关一个已经关掉的窗口不该造账。
   */
  close(changeId: string, head: string | null): { visit: AsideVisit; needsNote: boolean } | null {
    const live = this.live(changeId);
    if (live === null) return null;
    this.database.prepare(
      "UPDATE aside_visits SET closed_at = ?, head_after = ? WHERE change_id = ? AND seq = ?",
    ).run(this.now().toISOString(), head, changeId, live.seq);
    const visit = this.read(changeId, live.seq)!;
    return { visit, needsNote: visit.touched && visit.note === null };
  }

  /**
   * 人自己写的那一句：这次旁路做了什么。
   *
   * 空字符串拒掉 —— 一句「改了点东西」和沉默的信息量一样，而这条账**存在的
   * 全部理由**就是让下游知道环外发生了什么。
   */
  note(changeId: string, seq: number, note: string | Uint8Array): boolean {
    /*
     * **收字节也收字符串。** 面板那一层（`web/`）有条护栏：流式渲染路径上的模块
     * 只转发字节、不许解释（没有 TextDecoder / JSON.parse / toString）—— 它挡的
     * 是「有人顺手在转发层解析起了内容」，而理由和这条账无关，但规矩是规矩。
     * 所以解码落在这儿，和 `domain/rubric-edit.ts` 的 `parseRubricEdit` 同一个
     * 形状：web 层原样把 body 递进来。
     */
    const text = typeof note === "string" ? note : new TextDecoder().decode(note);
    if (text.trim() === "") return false;
    return this.database.prepare(
      "UPDATE aside_visits SET note = ? WHERE change_id = ? AND seq = ?",
    ).run(text.trim(), changeId, seq).changes === 1;
  }

  /** 还开着的那一趟，没有就 null。 */
  live(changeId: string): AsideVisit | null {
    const row = this.database.prepare(
      `SELECT * FROM aside_visits
        WHERE change_id = ? AND closed_at IS NULL ORDER BY seq DESC LIMIT 1`,
    ).get(changeId) as Row | undefined;
    return row === undefined ? null : hydrate(row);
  }

  read(changeId: string, seq: number): AsideVisit | null {
    const row = this.database.prepare(
      "SELECT * FROM aside_visits WHERE change_id = ? AND seq = ?",
    ).get(changeId, seq) as Row | undefined;
    return row === undefined ? null : hydrate(row);
  }

  /** 这个 Change 的全部旁路记录，按先后。彗星的尾迹读它。 */
  list(changeId: string): AsideVisit[] {
    return (this.database.prepare(
      "SELECT * FROM aside_visits WHERE change_id = ? ORDER BY seq",
    ).all(changeId) as Row[]).map(hydrate);
  }
}
