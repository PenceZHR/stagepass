import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";

/**
 * 备好交给人、还没结算的那一轮（2026-08-19 定案「甲」）。
 *
 * ## 它为什么必须存在
 *
 * StagePass 不再自己跑轮 —— **谁执行 turn，谁就占着那条 Codex 线程**，于是它派的
 * 那一轮，人在 App 里打不开（真机反复撞到的 "This is open in another app"）。
 * 改成把题面交给人：他在自己的会话里跑，那一轮从第一秒起就是他的。
 *
 * 代价是**备和收之间隔着一个人的时间**，可能是几小时，中间工作台还可能重启过。
 * 那段时间里，这一轮的身份和它写出去的几个文件只能存在库里：
 *
 *   `scriptPath`   认回线程的判据（信封里的那个路径，每轮一个随机临时目录）
 *   `worklist`     裁判逐条表态写到哪
 *   `blueRubric`   反方那份标准判定写到哪
 *   `rubricIds`    备的那一刻生效的是哪几个 rubric 版本
 *
 * ## 为什么不能靠「结算时再备一次」
 *
 * 那是最诱人的省事办法，而它会**把人刚跑出来的东西抹掉**：备一轮要铺格子文件、
 * 写一份空的答案文件外壳，两样都是覆盖写（重放要幂等，它们本来就该覆盖）。
 * 结算时再备一次，人跑了一小时的产出就变成「模型没填」。
 */

/** 备的那一刻这一轮把文件放在哪、按哪几个 rubric 版本开的。 */
export interface HandedRoundFiles {
  /** 名单那两个文件。这一轮没什么要表态的就是 null。 */
  readonly worklist: {
    readonly listPath: string;
    readonly answersPath: string;
    readonly count: number;
  } | null;
  /** 反方那份标准的两个文件。这一轮没有要它判的就是 null。 */
  readonly blueRubric: {
    readonly criteriaPath: string;
    readonly answersPath: string;
    readonly count: number;
  } | null;
  /**
   * 备的那一刻，每个角色生效的是哪个 rubric 版本。**键是什么这一层不知道** ——
   * 和 `target` 一样，它只负责原样存回去，解释归上面那层（`work/rubric-round`）。
   *
   * **存 id 而不是重新取一次**：人可能在这一轮跑着的时候改了标准，而反方那份判定
   * 是**按序号映射**回 criteria 的 —— 换一份 criteria，一条判定就挂到别的标准上了，
   * 而那正是这套东西整份作废也要躲开的错（`readBlueRubricAnswers`）。
   */
  readonly rubricIds: Readonly<Record<string, string>>;
}

export interface HandedRound extends HandedRoundFiles {
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly envelope: string;
  readonly scriptPath: string;
  /** 结算时认回的那条线程。还没结算就是 null。 */
  readonly threadId: string | null;
  readonly status: "waiting" | "settled";
  readonly preparedAt: string;
  readonly settledAt: string | null;
}

interface Row {
  change_id: string;
  phase: string;
  round: number;
  envelope: string;
  script_path: string;
  prepared_json: string;
  thread_id: string | null;
  status: string;
  prepared_at: string;
  settled_at: string | null;
}

export class HandoffStore {
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
  }

  /**
   * 记下这一轮备成了什么样。**同一轮再备一次就覆盖它。**
   *
   * 覆盖是对的：人拿了题面没跑、回来又点了一次「取题面」，那仍然是同一轮 ——
   * 新的信封、新的文件路径，旧的那份指着的东西已经没用了。留着两份，结算时就要
   * 猜他跑的是哪一份。
   */
  prepare(input: {
    readonly changeId: string;
    readonly phase: Phase;
    readonly round: number;
    readonly envelope: string;
    readonly scriptPath: string;
    readonly files: HandedRoundFiles;
  }): void {
    this.database.prepare(
      `INSERT INTO handed_rounds
         (change_id, phase, round, envelope, script_path, prepared_json,
          thread_id, status, prepared_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'waiting', ?, NULL)
       ON CONFLICT (change_id, phase, round) DO UPDATE SET
         envelope = excluded.envelope,
         script_path = excluded.script_path,
         prepared_json = excluded.prepared_json,
         thread_id = NULL,
         status = 'waiting',
         prepared_at = excluded.prepared_at,
         settled_at = NULL`,
    ).run(
      input.changeId, input.phase, input.round, input.envelope, input.scriptPath,
      JSON.stringify(input.files), this.now().toISOString(),
    );
  }

  /** 这个阶段现在有没有一轮备着等人跑完。没有就是 null。 */
  waiting(changeId: string, phase: Phase): HandedRound | null {
    const row = this.database.prepare(
      `SELECT * FROM handed_rounds
        WHERE change_id = ? AND phase = ? AND status = 'waiting'
        ORDER BY round DESC LIMIT 1`,
    ).get(changeId, phase) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * **现在备着、还没结算的每一轮**，不问 Change 也不问阶段。
   *
   * 提问那条路要它（`web/ask-route.ts`）：模型调 `stagepass_ask` 时**说不出自己在哪个
   * Change、哪个阶段** —— 那两个正是「精确标识符不许手抄」挡着不让它写的东西。所以
   * StagePass 只能自己认：备着的轮有且只有一条时，那就是它；有两条就照直说这是
   * StagePass 自己的 bug，**不猜**。
   *
   * 按备的时间排，让「有两条」那句话说得出先后。
   */
  /**
   * 这个**项目**里备着、还没结算的那些。
   *
   * **项目是必填的，不给默认值。** 原来这里扫全库，于是工作台绑在 A、而 B 里躺着
   * 一条没结算的旧轮时，模型问的那一句会挂到 B 的轮上，正本也写进 B 的仓库
   * （2026-08-19 真机撞到，我自己的冒烟就落错了地方）。
   *
   * 那正是「工作台绑一个项目，于是『认不出来就编一个』在结构上不存在」那条规矩
   * 要杜绝的事 —— 少一个 WHERE，它就从后门回来了。
   */
  allWaiting(projectId: string): readonly HandedRound[] {
    const rows = this.database.prepare(
      `SELECT h.* FROM handed_rounds h
         JOIN changes c ON c.id = h.change_id
        WHERE h.status = 'waiting' AND c.project_id = ?
        ORDER BY h.prepared_at, h.change_id`,
    ).all(projectId) as Row[];
    return rows.map(hydrate);
  }

  /** 那一轮，不管结没结算。 */
  read(changeId: string, phase: Phase, round: number): HandedRound | null {
    const row = this.database.prepare(
      `SELECT * FROM handed_rounds WHERE change_id = ? AND phase = ? AND round = ?`,
    ).get(changeId, phase, round) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * 收工：记下它最后跑在哪条线程上。
   *
   * **线程 id 落在这里，而不是只落在 bindings 里**：人回头问「我那一轮跑哪去了」，
   * 答案得能从这一轮自己身上读出来，而不是去另一张按 (Change, 阶段) 存的表里
   * 猜哪一轮用的是它。
   */
  settled(changeId: string, phase: Phase, round: number, threadId: string): void {
    this.database.prepare(
      `UPDATE handed_rounds SET status = 'settled', thread_id = ?, settled_at = ?
        WHERE change_id = ? AND phase = ? AND round = ?`,
    ).run(threadId, this.now().toISOString(), changeId, phase, round);
  }

  /**
   * 把它撤掉 —— **人决定不跑那一轮了。**
   *
   * 不做成「标记 abandoned」：一轮没跑就是没发生过，留一条记录只会让「这个阶段
   * 现在有没有备着的轮」多一种要分辨的状态。名单那边由调用方收工。
   */
  discard(changeId: string, phase: Phase, round: number): void {
    this.database.prepare(
      `DELETE FROM handed_rounds WHERE change_id = ? AND phase = ? AND round = ?`,
    ).run(changeId, phase, round);
  }
}

function hydrate(row: Row): HandedRound {
  const files = JSON.parse(row.prepared_json) as HandedRoundFiles;
  return {
    changeId: row.change_id,
    phase: row.phase as Phase,
    round: row.round,
    envelope: row.envelope,
    scriptPath: row.script_path,
    threadId: row.thread_id,
    status: row.status as HandedRound["status"],
    preparedAt: row.prepared_at,
    settledAt: row.settled_at,
    worklist: files.worklist ?? null,
    blueRubric: files.blueRubric ?? null,
    rubricIds: files.rubricIds ?? {},
  };
}
