import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import type { RoundNoteSource } from "../domain/round";

/**
 * 一轮里那两句只写给人看的话。
 *
 * ## 它们为什么需要一个自己的地方
 *
 * 用户 2026-07-31：「每对抗一轮，我都是要知情的。」而这一轮到底怎么样，逐条判定
 * 说不全 —— 它说得出「第 3 条没勾上」，说不出「加起来还差在哪」。裁判的结论和反方
 * 的整体判断补的就是这一格。
 *
 * 两句都**不动闸门**：裁判那句是建议（闸门仍然由人推，2026-07-30 拍板），反方那句
 * 是印象。所以它们进不了 `gaps` / `change_evidence` —— 那两张表里的每一行都是会
 * 挡门的东西，混进不挡门的行，读那两张表的人就得先分辨哪些算数。
 *
 * ## 按轮存，写一次
 *
 * 同一轮同一来源重复写是覆盖，不是插两行：一轮里裁判只有一个结论，两行会让
 * 「这一轮它说了什么」没有答案。跨轮不覆盖 —— 人在第 4 轮回头看第 2 轮怎么说，
 * 是他判断「这几轮到底有没有进展」的唯一依据。
 *
 * ## 读不出来的结论也存
 *
 * 裁判给了但写坏了，存的是「读不出来」加原文，`anotherRound` 记 `false`。
 * **那不是「它说不用再来一轮」，是「没有可执行的建议」** —— 两者在界面上必须
 * 靠 text 区分，所以 text 里那句话是承重的，不是装饰。
 */

export interface RoundNote {
  readonly round: number;
  readonly source: RoundNoteSource;
  /** 只有 `judge_conclusion` 有；别的来源是 null。schema 里有配对 CHECK 兜着。 */
  readonly anotherRound: boolean | null;
  readonly text: string;
  readonly createdAt: string;
}

interface RoundNoteRow {
  round: number;
  source: string;
  another_round: number | null;
  text: string;
  created_at: string;
}

export class RoundNoteStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  put(
    changeId: string,
    phase: Phase,
    round: number,
    note: { source: RoundNoteSource; anotherRound?: boolean | null; text: string },
  ): void {
    const text = note.text.trim();
    // 一句空话不如没有：schema 那条 CHECK 会拒，而在这里静默丢掉才是对的 ——
    // 「反方没写整体判断」是常态，不是错误。
    if (text === "") return;

    this.database.prepare(
      `INSERT INTO round_notes (change_id, phase, round, source, another_round, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (change_id, phase, round, source) DO UPDATE SET
         another_round = excluded.another_round,
         text = excluded.text,
         created_at = excluded.created_at`,
    ).run(
      changeId, phase, round, note.source,
      note.anotherRound === undefined || note.anotherRound === null
        ? null : (note.anotherRound ? 1 : 0),
      text,
      this.now().toISOString(),
    );
  }

  /**
   * 某一轮的那几句。**空数组是合法的** —— 裁判没给结论、反方没写整体判断，
   * 都不是错误。
   */
  read(changeId: string, phase: Phase, round: number): RoundNote[] {
    const rows = this.database.prepare(
      `SELECT round, source, another_round, text, created_at
         FROM round_notes
        WHERE change_id = ? AND phase = ? AND round = ?
        ORDER BY source`,
    ).all(changeId, phase, round) as RoundNoteRow[];
    return rows.map((row) => ({
      round: row.round,
      source: row.source as RoundNoteSource,
      anotherRound: row.another_round === null ? null : row.another_round === 1,
      text: row.text,
      createdAt: row.created_at,
    }));
  }

  /**
   * **最近一轮**的那几句。没跑过任何一轮返回空数组。
   *
   * 和 `RubricStore.latestRound` 同一个理由：人要看的是「现在怎么样」。而两处必须
   * 说的是同一轮 —— 裁决那张表上「这一轮判成什么样」和「裁判怎么说」并排放着，
   * 各自取自不同的轮次就是在骗人。
   */
  latest(changeId: string, phase: Phase): RoundNote[] {
    const top = this.database.prepare(
      "SELECT max(round) AS round FROM round_notes WHERE change_id = ? AND phase = ?",
    ).get(changeId, phase) as { round: number | null };
    return top.round === null ? [] : this.read(changeId, phase, top.round);
  }
}
