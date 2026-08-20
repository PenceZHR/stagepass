import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";

/**
 * 并行座位（批 3，DESIGN-phase-not-the-only-axis §3.1 的第一阶段）。
 *
 * ## 它是什么、不是什么
 *
 * 主线（`changes.phase/status`）**原样不动** —— 账本触发器、fence、seq 全部照旧。
 * 这张表放的是「同时活着的第二个阶段」：主线停在 TestPlan 时，Build 在这儿有
 * 一行，各自跑轮、各自积累 evidence / gaps / rubric（那三张表本来就按
 * (change, phase) 建键，一行不用改）。
 *
 * ## 终点只有一个：被主线收编。但轨内能自己转
 *
 * 座位没有自己的裁决面。主线推进到这个阶段时，`ChangeStore.apply` 把这一行的
 * status 原样收编进主状态、删掉这一行，之后走正常的裁决流 ——「人只在状态的
 * 出口表一次态」保持成立，网页上不长第二个裁决入口（PRD §1）。
 *
 * **收编之前，这条轨自己是活的**（2026-08-13 用户拍：并行轨必须能独立重来）：
 * settled 的座位接受 `start` 原地再来一轮，blocked 的接受 `retry` —— 两轨才是
 * 真并行，不是一轨依附另一轨。裁决（approve / reject / sendBack）仍然只在主线。
 *
 * ## 小状态机是主线那台的子集
 *
 * pending → start → running → settle/fail → settled/blocked → retry → running，
 * settled → start → running（再来一轮）。没有 approve / reject / sendBack ——
 * 那些是裁决，裁决发生在主线的出口。没有 closed —— 座位不自己关，终点是被收编。
 */

export type ParallelStatus = "pending" | "running" | "settled" | "blocked";
export type ParallelAction = "start" | "settle" | "fail" | "retry";

const ACCEPTS: Readonly<Record<ParallelStatus, readonly ParallelAction[]>> = {
  pending: ["start"],
  running: ["settle", "fail"],
  /*
   * **settled 的座位能再来一轮**（2026-08-13 用户拍：并行轨必须能独立重来）。
   *
   * 原来是 `[]` —— 冻结到被收编为止。后果是两轨名义并行、实际依附：座位轨
   * settled 之后想重跑，必须先裁决完主线孪生、等收编、再在主线上 reject ——
   * 「每个阶段都要是独立的」在座位这半边不成立。
   *
   * `start` 就是主线 reject 的座位对等物：产物按轮替换（evidence 的既有语义）、
   * gaps 跨轮存活，一步落到 running。收编语义不变 —— 主线到达时接的是
   * **当时**的状态，正在重跑就接 running，跑完了就接新的 settled。
   */
  settled: ["start"],
  blocked: ["retry"],
};

const LANDS: Readonly<Record<ParallelAction, ParallelStatus>> = {
  start: "running",
  settle: "settled",
  fail: "blocked",
  retry: "running",
};

export interface ParallelSeat {
  readonly changeId: string;
  readonly phase: Phase;
  readonly status: ParallelStatus;
}

export class ParallelSeatError extends Error {
  constructor(
    readonly code: "no_such_seat" | "seat_already_open" | "illegal_action",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ParallelSeatError";
  }
}

interface SeatRow {
  change_id: string;
  phase: Phase;
  status: ParallelStatus;
}

export class ParallelStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 开一个座位。已经开着就抛 —— 静默幂等会掩盖「两个人都以为是自己开的」。 */
  open(changeId: string, phase: Phase): ParallelSeat {
    const at = this.now().toISOString();
    if (this.find(changeId, phase) !== null) {
      throw new ParallelSeatError("seat_already_open", `${changeId}/${phase}`);
    }
    this.database.prepare(
      `INSERT INTO change_states (change_id, phase, status, opened_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?)`,
    ).run(changeId, phase, at, at);
    return { changeId, phase, status: "pending" };
  }

  find(changeId: string, phase: Phase): ParallelSeat | null {
    const row = this.database.prepare(
      "SELECT change_id, phase, status FROM change_states WHERE change_id = ? AND phase = ?",
    ).get(changeId, phase) as SeatRow | undefined;
    return row === undefined
      ? null
      : { changeId: row.change_id, phase: row.phase, status: row.status };
  }

  /** 这个 Change 开着的所有座位，按开座先后。 */
  list(changeId: string): ParallelSeat[] {
    const rows = this.database.prepare(
      `SELECT change_id, phase, status FROM change_states
        WHERE change_id = ? ORDER BY opened_at, phase`,
    ).all(changeId) as SeatRow[];
    return rows.map((row) => ({
      changeId: row.change_id, phase: row.phase, status: row.status,
    }));
  }

  /** 座位上的一步。非法的一步抛出来 —— 和主线 `transition` 同一条纪律。 */
  apply(changeId: string, phase: Phase, action: ParallelAction): ParallelSeat {
    const seat = this.find(changeId, phase);
    if (seat === null) {
      throw new ParallelSeatError("no_such_seat", `${changeId}/${phase}`);
    }
    if (!ACCEPTS[seat.status].includes(action)) {
      throw new ParallelSeatError(
        "illegal_action",
        `${action} in ${changeId}/${phase}/${seat.status}`
        + ` (accepts: ${ACCEPTS[seat.status].join(", ") || "nothing"})`,
      );
    }
    const status = LANDS[action];
    this.database.prepare(
      `UPDATE change_states SET status = ?, updated_at = ?
        WHERE change_id = ? AND phase = ?`,
    ).run(status, this.now().toISOString(), changeId, phase);
    return { changeId, phase, status };
  }
}
