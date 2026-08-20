import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";

/**
 * 人在浏览器上对某一节留的意见，和模型对它的下文。
 *
 * ## 为什么意见是一等公民
 *
 * 用户 2026-08-19 定的：**正文归模型，人只提意见**。于是审计链是
 * 「意见 → 模型怎么改的」，而不是一份看不出所以然的 diff —— 那正是
 * 「账本记的是分叉，不是进展」。
 *
 * ## `response` 那一格就是闸门
 *
 * 「每条意见都有下文」是这个阶段代码判得出来的那一半（另一半是七节非空）。
 * 下文可以是「改了，见第二节」，也可以是「不改，因为…」—— **明说不改也算下文**。
 * 空着才算没下文。
 */
export interface Note {
  readonly id: string;
  readonly changeId: string;
  readonly phase: Phase;
  readonly sectionKey: string;
  readonly text: string;
  readonly createdAt: string;
  readonly response: string | null;
  readonly respondedAt: string | null;
}

interface Row {
  id: string; change_id: string; phase: string; section_key: string;
  text: string; created_at: string; response: string | null; responded_at: string | null;
}

const hydrate = (row: Row): Note => ({
  id: row.id,
  changeId: row.change_id,
  phase: row.phase as Phase,
  sectionKey: row.section_key,
  text: row.text,
  createdAt: row.created_at,
  response: row.response,
  respondedAt: row.responded_at,
});

export class NoteStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(input: {
    changeId: string; phase: Phase; sectionKey: string; text: string;
  }): Note {
    /*
     * 号从库里现有的最大号往下发。**id 由这一侧生成** —— 模型和人都不写它，
     * 于是「精确标识符不许手抄」在这条路上天然成立。
     */
    const count = this.database.prepare("SELECT COUNT(*) AS n FROM prd_notes")
      .get() as { n: number };
    const id = `NOTE-${String(count.n + 1).padStart(4, "0")}`;
    this.database.prepare(
      `INSERT INTO prd_notes (id, change_id, phase, section_key, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.changeId, input.phase, input.sectionKey, input.text,
      this.now().toISOString());
    return this.read(id)!;
  }

  read(id: string): Note | null {
    const row = this.database.prepare("SELECT * FROM prd_notes WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? null : hydrate(row);
  }

  /** 这个阶段的全部意见，按留的先后。**倒序是界面的事**，这里不替它决定。 */
  list(changeId: string, phase: Phase): readonly Note[] {
    return (this.database.prepare(
      `SELECT * FROM prd_notes WHERE change_id = ? AND phase = ?
        ORDER BY created_at, id`,
    ).all(changeId, phase) as Row[]).map(hydrate);
  }

  /** 还没下文的那些 —— 闸门和 brief 读的是同一份。 */
  open(changeId: string, phase: Phase): readonly Note[] {
    return this.list(changeId, phase).filter((note) => note.respondedAt === null);
  }

  /**
   * 模型对一条意见的下文。
   *
   * **重答要拒**：一条意见一个下文。改主意就再留一条意见 —— 覆盖会让账本上
   * 「他当时怎么答的」凭空消失，而那正是这套东西要留住的东西。
   */
  respond(id: string, how: string): { ok: boolean; reason?: string } {
    const note = this.read(id);
    if (note === null) return { ok: false, reason: `没有 ${id} 这条意见。` };
    if (note.respondedAt !== null) {
      return {
        ok: false,
        reason: `${id} 已经答过了（「${note.response}」）。改主意就再留一条意见，`
          + "别覆盖 —— 覆盖会让账本上他当时怎么答的凭空消失。",
      };
    }
    this.database.prepare(
      "UPDATE prd_notes SET response = ?, responded_at = ? WHERE id = ?",
    ).run(how, this.now().toISOString(), id);
    return { ok: true };
  }
}
