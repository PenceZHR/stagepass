import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import type {
  AnswerOutcome, WorkItemDraft, WorkItemKind,
} from "../domain/worklist";

/**
 * 裁判这一轮要逐条答的东西。
 *
 * ## 它取代了什么
 *
 * 在它之前，裁判把 gap id（50 字符）和 criterion key（40 字符）**手抄**进一个 json
 * 块的 key 位置上，而 StagePass 拿它们做精确相等匹配。抄漏一段，一整份判定作废 ——
 * 2026-08-02 实测：同一个抄错的 UUID 连抄三轮。
 *
 * 现在身份留在库里（`target`），**模型从头到尾看不到它**：它只被问「第 N 项：<正文>，
 * 答 A 还是 B」，然后交一个枚举值和一句散文。判据是用户 2026-08-02 立的规矩 ——
 * 凡是 StagePass 会拿去做精确匹配的字符串，都不许出现在模型必须生成的文本里。
 *
 * ## 「当前那一份」是库里的事实，不是约定
 *
 * 问「下一项是什么」的是插件（`plugin/protocol.ts`），而**插件不知道自己在哪个
 * Change、哪个阶段、第几轮** —— 它只有这个库文件。所以开一份新的会把别的全部
 * `closed`，于是全库任何时刻至多一份开着，`next()` 的答案是唯一的。
 *
 * 这同时挡住一件会静默出错的事：上一轮没答完的条目**不许漏到下一轮** —— 那些条目
 * 对应的 gap 可能早就关掉了，喂给裁判就是让它对不存在的东西表态。
 */

export interface WorkItem extends WorkItemDraft {
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly ordinal: number;
  /** 这一份一共几项 —— 让模型知道还剩多少，它才停得下来。 */
  readonly total: number;
  readonly answer: string | null;
  readonly reason: string | null;
}

interface Row {
  change_id: string;
  phase: string;
  round: number;
  ordinal: number;
  kind: string;
  target: string;
  prompt: string;
  choices: string;
  answer: string | null;
  reason: string | null;
}

export class WorklistStore {
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
  }

  /**
   * 开一份新的，**并把这个 Change 之前那几份关掉**。
   *
   * 空名单也照开（然后立刻就是「没有下一项」）—— 「这一轮没什么要表态的」和
   * 「这一轮的名单没开出来」是两件事，而后者会让裁判去答上一轮的剩饭。
   *
   * ## 关的范围只到这个 Change 为止
   *
   * 原来这一句是 `WHERE status = 'open'`，**全库**。2026-08-03 真机撞出来的：一轮正
   * 等着裁判逐条表态，同一个面板里给另一个 Change 派了一轮，那句话把这一份**正在用
   * 的**名单一起关了。表现是「裁判一条都没答」（于是记 `worklist_unanswered`、放开
   * 线程），而它其实是被 StagePass 自己掐掉的 —— 最难查的那一类。
   *
   * 全库关是早期设计的遗留：那时插件只能猜「全库唯一开着的那一份」，所以必须保证
   * 唯一。现在读那一侧按 `changeId` 取（`next`，id 来自 `STAGEPASS_CHANGE`），
   * 唯一性只在一个 Change 内部需要。
   */
  open(
    changeId: string,
    phase: Phase,
    round: number,
    items: readonly WorkItemDraft[],
  ): void {
    const write = this.database.transaction(() => {
      this.database.prepare(
        "UPDATE round_worklist SET status = 'closed' WHERE change_id = ? AND status = 'open'",
      ).run(changeId);
      this.database.prepare(
        "DELETE FROM round_worklist WHERE change_id = ? AND phase = ? AND round = ?",
      ).run(changeId, phase, round);
      const insert = this.database.prepare(
        `INSERT INTO round_worklist
           (change_id, phase, round, ordinal, kind, target, prompt, choices,
            status, answer, reason, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL)`,
      );
      items.forEach((item, index) => {
        insert.run(
          changeId, phase, round, index + 1,
          item.kind, item.target, item.prompt, JSON.stringify([...item.choices]),
        );
      });
    });
    write();
  }

  /**
   * 往**同一轮**里再追加几条，序号接着往下排。
   *
   * ## 为什么不是再 `open` 一份
   *
   * 一轮里有两批要逐条表态的东西，答它们的是**两条不同的线程、两个不同的时刻**：
   * 裁判先答（gap 表态 + critic 标准），完了之后 StagePass 再单独去问反方
   * （producer 标准，跑在反方自己那条线程上）。
   *
   * 再 `open` 一份会把裁判那几行**删掉**（那句 DELETE 按 change/phase/round 走），
   * 账就断了 —— 而「人要看得见每一轮问了什么、答了什么」是这套东西的前提。改主键
   * 加一列 audience 又要重建表。追加是最小的那条路：序号接着排，`next` 自然轮到
   * 新的这几条，旧的连同答案原样留着。
   *
   * 和 `open` 一样会把这个 Change 别处开着的关掉 —— 同一时刻只该有一批在等答，
   * 否则 `next` 就得猜。
   */
  append(
    changeId: string,
    phase: Phase,
    round: number,
    items: readonly WorkItemDraft[],
  ): void {
    if (items.length === 0) return;
    const write = this.database.transaction(() => {
      this.database.prepare(
        "UPDATE round_worklist SET status = 'closed' WHERE change_id = ? AND status = 'open'",
      ).run(changeId);
      const last = this.database.prepare(
        `SELECT COALESCE(MAX(ordinal), 0) AS n FROM round_worklist
          WHERE change_id = ? AND phase = ? AND round = ?`,
      ).get(changeId, phase, round) as { n: number };
      const insert = this.database.prepare(
        `INSERT INTO round_worklist
           (change_id, phase, round, ordinal, kind, target, prompt, choices,
            status, answer, reason, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL)`,
      );
      items.forEach((item, index) => {
        insert.run(
          changeId, phase, round, last.n + index + 1,
          item.kind, item.target, item.prompt, JSON.stringify([...item.choices]),
        );
      });
    });
    write();
  }

  /** 这一份答完了，收起来。**幂等** —— 一轮失败重跑时会再调一次。 */
  close(changeId: string, phase: Phase, round: number): void {
    this.database.prepare(
      `UPDATE round_worklist SET status = 'closed'
        WHERE change_id = ? AND phase = ? AND round = ?`,
    ).run(changeId, phase, round);
  }

  /**
   * 这个 Change 当前那一份里**还没答的第一项**，没有就 null。
   *
   * ## `changeId` 从哪来 —— 不是模型给的
   *
   * 插件从环境变量 `STAGEPASS_CHANGE` 拿它，和 `STAGEPASS_DB` 同一条路：面板启动
   * Codex 的时候就知道这一轮是哪个 Change。**那是 StagePass 侧的配置，不经模型的
   * 嘴** —— 所以这个参数不违反「不许手抄标识符」那条，反而是它的落实方式。
   *
   * 不这么做的话只能猜「全库唯一开着的那一份」，而两个 Change 各开一份的时候，
   * 猜错一次就是把答案记到别人的条目上 —— 静默的、事后查不出来的那一种错。
   */
  next(changeId: string): WorkItem | null {
    const row = this.database.prepare(
      `SELECT * FROM round_worklist
        WHERE change_id = ? AND status = 'open' AND answer IS NULL
        ORDER BY phase, round, ordinal LIMIT 1`,
    ).get(changeId) as Row | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  /**
   * 把答案记在 `next()` 那一项上。
   *
   * **答案必须在 choices 里，理由必须非空。** 前者是这套机制的全部意义（模型只在
   * 一个极小的枚举里做选择）；后者是这个产品一贯的要求 —— 关掉一个问题必须写清楚
   * 它为什么不再成立，一句「已修复」和沉默的信息量是一样的。
   */
  answer(changeId: string, answer: string, reason: string): AnswerOutcome {
    const item = this.next(changeId);
    if (!item) return { kind: "nothing_open" };
    if (!item.choices.includes(answer)) {
      return { kind: "bad_answer", choices: item.choices };
    }
    if (reason.trim() === "") return { kind: "no_reason" };

    this.database.prepare(
      `UPDATE round_worklist SET answer = ?, reason = ?, answered_at = ?
        WHERE change_id = ? AND phase = ? AND round = ? AND ordinal = ?`,
    ).run(
      answer, reason.trim(), this.now().toISOString(),
      item.changeId, item.phase, item.round, item.ordinal,
    );
    return { kind: "recorded", remaining: item.total - item.ordinal };
  }

  /** 这一轮的名单和它答成什么样，按顺序。 */
  read(changeId: string, phase: Phase, round: number): WorkItem[] {
    const rows = this.database.prepare(
      `SELECT * FROM round_worklist
        WHERE change_id = ? AND phase = ? AND round = ? ORDER BY ordinal`,
    ).all(changeId, phase, round) as Row[];
    return rows.map((row) => this.hydrate(row, rows.length));
  }

  private hydrate(row: Row, total?: number): WorkItem {
    return {
      changeId: row.change_id,
      phase: row.phase as Phase,
      round: row.round,
      ordinal: row.ordinal,
      total: total ?? (this.database.prepare(
        `SELECT COUNT(*) AS n FROM round_worklist
          WHERE change_id = ? AND phase = ? AND round = ?`,
      ).get(row.change_id, row.phase, row.round) as { n: number }).n,
      kind: row.kind as WorkItemKind,
      target: row.target,
      prompt: row.prompt,
      choices: JSON.parse(row.choices) as string[],
      answer: row.answer,
      reason: row.reason,
    };
  }
}
