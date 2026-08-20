import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type Database from "better-sqlite3";

import type { Ask } from "../domain/ask";
import type { Phase } from "../domain/phase";

/**
 * 问过什么、答过什么 —— **文件为准，库为索引。**
 *
 * ## 为什么正本是一份 JSONL，而不是这张表
 *
 * 用户 2026-08-19：定位转向人类查看友好，数据库不那么强调了。可审计是这个产品的
 * 第一根柱子，而半年后要回答「当初为什么否掉方案 A」的那份东西，不该只活在一个
 * sqlite 里 —— 它跟着 Change 走、可 commit、可 diff、可以用眼睛读。
 *
 * 所以 `<项目>/.stagepass/asks.jsonl` 是正本，`asks` 表只是查询投影：**库丢了能从
 * 文件逐条重建（`rebuildFrom`），反过来不行。**
 *
 * ## 写的顺序是承重的
 *
 * **文件写成功才写库。** 反过来会出现「库里有、文件里没有」，而重建以文件为准 ——
 * 那一条提问会在下一次重建时静静地消失，而库里当时是有的，没有任何东西说得出它
 * 去哪了。反过来的那种失败（文件有、库没有）重建一次就补齐了。
 *
 * ## 回答是追加一条补记，不改原行
 *
 * 只追加的文件不能有原地改写，否则 diff 会撒谎：改一行的 diff 看起来和「当初就是
 * 这么写的」一模一样。所以人答完之后追加的是 `{id, chosen, note, answeredAt}`，
 * 原来那一行一个字节都不动。
 */

interface Row {
  id: string;
  change_id: string;
  phase: string;
  round: number;
  rubric_id: string | null;
  ordinal: number | null;
  question: string;
  why: string | null;
  options_json: string;
  asked_at: string;
  chosen: string | null;
  note: string | null;
  answered_at: string | null;
}

/** 问出去那一刻写进文件的一行。**没有 `chosen` 那三格** —— 它们还不存在。 */
type AskedLine = Omit<Ask, "chosen" | "note" | "answeredAt">;

/** 人答完之后追加的那一行补记。 */
interface AnsweredLine {
  readonly id: string;
  readonly chosen: string;
  readonly note: string | null;
  readonly answeredAt: string;
}

/**
 * 索引里的那几条，**不需要知道正本在哪**。
 *
 * 单独一个函数，是因为只读那一侧（`GET /api/asks`）常常拿不到项目路径（老库的
 * `projects.path` 可空），而它只是看一眼。逼它编一个正本路径出来才能读一张索引表，
 * 那个编出来的路径迟早会被谁当真，然后往那儿写一行。
 */
export function listAsks(
  database: Database.Database,
  changeId: string,
): readonly Ask[] {
  const rows = database.prepare(
    "SELECT * FROM asks WHERE change_id = ? ORDER BY asked_at, id",
  ).all(changeId) as Row[];
  return rows.map(hydrate);
}

/**
 * 按 id 找一条。
 *
 * 和 `listAsks` 同一个理由做成模块级：**答一条的时候还不知道它属于哪个 Change**，
 * 而正本路径要从 Change 才算得出来。先查到它，才知道该往哪份文件里追加。
 */
export function askById(database: Database.Database, id: string): Ask | null {
  const row = database.prepare("SELECT * FROM asks WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : hydrate(row);
}

export class AskStore {
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    /** 正本落在哪。**`list` 不碰它** —— 读只走索引。 */
    private readonly jsonlPath: string,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
  }

  /**
   * 记下这一问。id 和时间都由 StagePass 生成 —— 模型一个字都不写。
   *
   * 号从库里现有的最大号往下发（`ASK-0007`）。**重建之后再发号**才对得上：先
   * `rebuildFrom` 把文件里的号读回库，这里才知道发到几了。
   */
  record(input: Omit<Ask, "id" | "askedAt" | "chosen" | "note" | "answeredAt">): Ask {
    /*
     * 逐格拼，不 `...input` —— 文件是拿去 diff 的，而展开出来的键序跟着调用方走：
     * 换一处调用方，同样的一条提问会写出不一样的一行。
     */
    const asked: AskedLine = {
      id: this.mintId(),
      changeId: input.changeId,
      phase: input.phase,
      round: input.round,
      rubricId: input.rubricId,
      ordinal: input.ordinal,
      question: input.question,
      why: input.why,
      options: input.options,
      askedAt: this.now().toISOString(),
    };
    this.append(asked);
    this.insert(asked);
    return { ...asked, chosen: null, note: null, answeredAt: null };
  }

  /**
   * 人选了哪一条。**追加一条补记**，原行不动。
   *
   * 不认识的 id 直接抛：那不是模型答错（模型从来不写 id），是调用方拿着一个不存在
   * 的号来落答案 —— 静静地写一条孤儿补记，只会让下一次重建多出一条没有问题的答案。
   */
  answer(id: string, chosen: string, note: string | null): void {
    const exists = this.database.prepare(
      "SELECT id FROM asks WHERE id = ?",
    ).get(id) as { id: string } | undefined;
    if (exists === undefined) throw new Error(`No ask with id ${id}`);
    const answered: AnsweredLine = {
      id, chosen, note, answeredAt: this.now().toISOString(),
    };
    this.append(answered);
    this.database.prepare(
      "UPDATE asks SET chosen = ?, note = ?, answered_at = ? WHERE id = ?",
    ).run(chosen, note, answered.answeredAt, id);
  }

  /** 这个 Change 问过的每一条，按问的先后。**倒序是界面的事**，这里不替它决定。 */
  list(changeId: string): readonly Ask[] {
    return listAsks(this.database, changeId);
  }

  /**
   * 从正本重建索引，返回重建了几**条提问**（不是几行 —— 一条答过的提问占两行）。
   *
   * 读不懂的行跳过：一份被截断在半行上的文件，重建出前面那些仍然比整份作废强，
   * 而少的那几条会从返回的条数上看出来。
   */
  rebuildFrom(jsonlPath: string): number {
    let text: string;
    try {
      text = readFileSync(jsonlPath, "utf8");
    } catch {
      // 文件不在就是没问过 —— 不是故障，不必编一个空文件出来。
      return 0;
    }
    let rebuilt = 0;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      if ("question" in parsed) {
        this.insert(parsed as AskedLine);
        rebuilt += 1;
        continue;
      }
      if ("chosen" in parsed) {
        const answered = parsed as AnsweredLine;
        this.database.prepare(
          "UPDATE asks SET chosen = ?, note = ?, answered_at = ? WHERE id = ?",
        ).run(answered.chosen, answered.note ?? null, answered.answeredAt, answered.id);
      }
    }
    return rebuilt;
  }

  /** 一行 JSON，末尾一个换行。**只追加。** */
  private append(line: AskedLine | AnsweredLine): void {
    mkdirSync(dirname(this.jsonlPath), { recursive: true });
    appendFileSync(this.jsonlPath, `${JSON.stringify(line)}\n`, "utf8");
  }

  /**
   * 索引里的那一行。**重放要幂等** —— 重建会把同一条再写一次，而它必须还是同一条。
   */
  private insert(asked: AskedLine): void {
    this.database.prepare(
      `INSERT INTO asks
         (id, change_id, phase, round, rubric_id, ordinal, question, why,
          options_json, asked_at, chosen, note, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         change_id = excluded.change_id,
         phase = excluded.phase,
         round = excluded.round,
         rubric_id = excluded.rubric_id,
         ordinal = excluded.ordinal,
         question = excluded.question,
         why = excluded.why,
         options_json = excluded.options_json,
         asked_at = excluded.asked_at`,
    ).run(
      asked.id, asked.changeId, asked.phase, asked.round, asked.rubricId,
      asked.ordinal, asked.question, asked.why, JSON.stringify(asked.options),
      asked.askedAt,
    );
  }

  /** 下一个空号：`ASK-0007`。认不出形状的旧号不参与，也不挡路。 */
  private mintId(): string {
    const rows = this.database.prepare("SELECT id FROM asks").all() as { id: string }[];
    const used = rows
      .map((row) => /^ASK-(\d+)$/.exec(row.id)?.[1])
      .filter((digits): digits is string => digits !== undefined)
      .map((digits) => Number(digits));
    const next = (used.length === 0 ? 0 : Math.max(...used)) + 1;
    return `ASK-${String(next).padStart(4, "0")}`;
  }
}

function hydrate(row: Row): Ask {
  return {
    id: row.id,
    changeId: row.change_id,
    phase: row.phase as Phase,
    round: row.round,
    rubricId: row.rubric_id,
    ordinal: row.ordinal,
    question: row.question,
    why: row.why,
    options: JSON.parse(row.options_json) as string[],
    askedAt: row.asked_at,
    chosen: row.chosen,
    note: row.note,
    answeredAt: row.answered_at,
  };
}
