import type Database from "better-sqlite3";

import type { ChangeAction } from "../domain/change-state";
import {
  decisionFrom,
  readAnswer,
  sendBackTargetFrom,
  type Answer,
  type Question,
  type QuestionKind,
  type RequestedSchema,
} from "../domain/question";
import type { Phase } from "../domain/phase";
import { GateMovedError } from "../domain/gate";
import { CommandStore } from "./command-store";

/**
 * The questions StagePass has put to a human, and what they said.
 *
 * ## Two writers, and only one of them can move anything
 *
 * StagePass writes `questions`; the Codex plugin writes `answers`. They share a
 * SQLite file rather than an HTTP endpoint, which removes the entire surface
 * the tree this replaces drowned in -- no port, no auth, no actor identity to
 * forge. The plugin cannot touch `changes`, so the worst a compromised one can
 * do is answer a question StagePass already chose to ask.
 *
 * ## The fence is stored at the moment of asking
 *
 * A person takes as long as they take. `expected_snapshot` records the evidence
 * the question was asked against, and applying the answer re-checks it -- so an
 * approval given on last week's evidence is refused rather than applied to
 * evidence nobody has seen.
 */

export type QuestionStatus = "open" | "answered" | "applied" | "superseded";

export interface QuestionRecord {
  readonly id: string;
  readonly changeId: string;
  readonly phase: Phase;
  readonly kind: QuestionKind;
  readonly status: QuestionStatus;
  readonly question: Question;
  readonly expectedSnapshot: string;
}

export class QuestionNotFoundError extends Error {
  constructor(readonly questionId: string) {
    super(`No question with id ${questionId}`);
    this.name = "QuestionNotFoundError";
  }
}

export class QuestionNotOpenError extends Error {
  constructor(readonly questionId: string, readonly status: QuestionStatus) {
    super(`Question ${questionId} is ${status}, not open`);
    this.name = "QuestionNotOpenError";
  }
}

interface QuestionRow {
  id: string;
  change_id: string;
  phase: Phase;
  kind: QuestionKind;
  message: string;
  schema_json: string;
  expected_snapshot: string;
  status: QuestionStatus;
}

function toRecord(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    changeId: row.change_id,
    phase: row.phase,
    kind: row.kind,
    status: row.status,
    expectedSnapshot: row.expected_snapshot,
    question: {
      message: row.message,
      requestedSchema: JSON.parse(row.schema_json) as RequestedSchema,
    },
  };
}

export type ApplyOutcome =
  | { readonly kind: "advanced"; readonly action: ChangeAction }
  /** A human declined. Recorded, not treated as a failure. */
  | { readonly kind: "declined" }
  /** Answered, but it carries no gate action -- a clarification batch. */
  | { readonly kind: "recorded" }
  /**
   * 裁决选了「打回上游」，目标那格却是「不打回」（或读不出来）—— 半个决定推不动
   * 闸门，而**人已经答完走了，必须报回去**，不许静默当成没发生（§3.2 的老病）。
   * 形状和闸门拒的那种一致，前端一条横幅两处用。
   */
  | { readonly kind: "refused"; readonly action: ChangeAction; readonly reason: string };

export class QuestionStore {
  private readonly commands: CommandStore;

  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.commands = new CommandStore(database, now);
  }

  /**
   * Put a question to the human.
   *
   * Any question already open for this Change is superseded first: two open
   * questions would be two decisions racing for the same gate, and whichever
   * answer landed second would be applied against a snapshot its asker never
   * saw. The unique index makes the race impossible; this makes it orderly.
   */
  ask(input: {
    id: string;
    changeId: string;
    phase: Phase;
    kind: QuestionKind;
    question: Question;
    expectedSnapshot: string;
  }): QuestionRecord {
    const at = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare(
        "UPDATE questions SET status = 'superseded', updated_at = ? WHERE change_id = ? AND status = 'open'",
      ).run(at, input.changeId);
      this.database.prepare(
        `INSERT INTO questions
           (id, change_id, phase, kind, message, schema_json,
            expected_snapshot, status, asked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(
        input.id, input.changeId, input.phase, input.kind,
        input.question.message,
        JSON.stringify(input.question.requestedSchema),
        input.expectedSnapshot, at, at,
      );
    })();
    return this.read(input.id);
  }

  read(questionId: string): QuestionRecord {
    const row = this.database.prepare("SELECT * FROM questions WHERE id = ?")
      .get(questionId) as QuestionRow | undefined;
    if (!row) throw new QuestionNotFoundError(questionId);
    return toRecord(row);
  }

  /** The one question this Change is waiting on, if any. */
  open(changeId: string): QuestionRecord | null {
    const row = this.database.prepare(
      "SELECT * FROM questions WHERE change_id = ? AND status = 'open'",
    ).get(changeId) as QuestionRow | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * Record what the human said. This is the plugin's only write.
   *
   * It moves the question to `answered` and nothing else -- deliberately. The
   * answer becoming a state change is StagePass's job, through the gate, in
   * `apply` below.
   */
  answer(questionId: string, result: unknown): Answer {
    const record = this.read(questionId);
    if (record.status !== "open") {
      throw new QuestionNotOpenError(questionId, record.status);
    }
    const answer = readAnswer(result as { action?: unknown; content?: unknown });
    const at = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO answers (question_id, action, content_json, answered_at)
         VALUES (?, ?, ?, ?)`,
      ).run(questionId, answer.action, JSON.stringify(answer.content), at);
      this.database.prepare(
        "UPDATE questions SET status = 'answered', updated_at = ? WHERE id = ?",
      ).run(at, questionId);
    })();
    return answer;
  }

  readAnswerFor(questionId: string): Answer | null {
    const row = this.database.prepare(
      "SELECT action, content_json FROM answers WHERE question_id = ?",
    ).get(questionId) as { action: string; content_json: string } | undefined;
    return row
      ? {
          action: row.action as Answer["action"],
          content: JSON.parse(row.content_json) as Answer["content"],
        }
      : null;
  }

  /**
   * 这次裁决的下场，落库（§3.2·5）。
   *
   * 「闸门拒了」原来只活在 `/api/ask` 的一次响应里，前端把它写进终端底下那行 ——
   * 而至少两处会覆盖那一行，其中一处是「进程已经结束了」，**那正是答完之后必然
   * 发生的事**。所以下场必须是留得住的状态。成功的下场也记：它自己就把上一次的
   * 拒绝顶下去了，不用另写清除逻辑。
   */
  recordOutcome(questionId: string, outcome: unknown): void {
    this.database.prepare(
      "UPDATE questions SET outcome_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(outcome), this.now().toISOString(), questionId);
  }

  /**
   * 这个阶段最近一次裁决的下场，带上什么时候。null = 这个阶段还没裁决落过。
   *
   * 形状就是当时存进去的 outcome（`{kind:"refused",action,reason}` 那种），
   * 摊平加一个 `at` —— 界面直接讲人话用的，不是给状态机的。
   */
  latestOutcomeFor(changeId: string, phase: Phase): Record<string, unknown> | null {
    const row = this.database.prepare(
      `SELECT outcome_json, updated_at FROM questions
       WHERE change_id = ? AND phase = ? AND outcome_json IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(changeId, phase) as
      | { outcome_json: string; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      ...(JSON.parse(row.outcome_json) as Record<string, unknown>),
      at: row.updated_at,
    };
  }

  /**
   * fence：这道题问出去时的那份证据，现在还是不是同一份。
   *
   * ## 为什么要有一个单独的方法
   *
   * `apply` 把 fence 交给 command 层去查（`expectedSnapshot` 传下去，闸门动过就
   * 抛 `GateMovedError`）。但**不是每个答案都走 command** —— 接受一条风险不推动
   * 状态机，没有 command 可走。那条路要是不显式查一次，「人对着他没看见过的证据
   * 做了决定」这条防线就只覆盖了一半的答案。
   *
   * 单独摆出来，是为了让「忘了查」这件事在读代码时看得见。
   */
  assertFenceHolds(questionId: string): void {
    const record = this.read(questionId);
    const now = this.commands.gateFor(record.changeId);
    if (now.snapshot !== record.expectedSnapshot) {
      throw new GateMovedError(record.expectedSnapshot, now.snapshot);
    }
  }

  /**
   * 收尾：把题标成 applied。
   *
   * 不走 `apply` 的那些答案也必须收尾，否则题会永远停在 `answered` —— 库里就有了
   * 一批「有人答过、但没人说这答案被怎么处理了」的行，而那正是这张表要避免的状态。
   */
  settle(questionId: string): void {
    this.database.prepare(
      "UPDATE questions SET status = 'applied', updated_at = ? WHERE id = ?",
    ).run(this.now().toISOString(), questionId);
  }

  /**
   * Turn an answer into a state change, through the gate.
   *
   * The stored fence is passed to the command, so an answer given against
   * evidence that has since moved is refused with `GateMovedError` rather than
   * applied to evidence the human never saw.
   */
  apply(questionId: string, options?: {
    /**
     * 这个答案**自己**动了闸门所依据的证据，所以 command 那一层要对着新的快照查。
     *
     * 唯一的用处是「回应蓝方」那道题：人在同一次回答里既驳回了几条问题、又做了裁决。
     * 驳回改的正是 `snapshotOf` 哈希的那份 blocker 名单，于是**存下来的 fence 必然
     * 对不上** —— 而它对不上的原因是人自己刚说的话，不是「有人在他想的时候动了东西」。
     *
     * **fence 没有被放宽，只是挪了位置**：调用方必须在落表态**之前**先
     * `assertFenceHolds` 一次。那一次查的才是真问题（别人动过没有），这里查的只是
     * 「我刚写完的东西还在不在」。顺序反过来就成了真的绕过 fence。
     */
    readonly rebaseFence?: boolean;
    /**
     * 打回的理由（第二趟 `Tx` 格）。理由在**合并后**的答案里，而这里只重读得到
     * 第一趟落库的那份 —— 所以由掌握合并答案的调用方递进来，进账本的 reason 列。
     */
    readonly sendBackReason?: string;
  }): ApplyOutcome {
    const record = this.read(questionId);
    const answer = this.readAnswerFor(questionId);
    if (!answer) throw new QuestionNotOpenError(questionId, record.status);

    const finish = (): void => {
      this.database.prepare(
        "UPDATE questions SET status = 'applied', updated_at = ? WHERE id = ?",
      ).run(this.now().toISOString(), questionId);
    };

    if (answer.action !== "accept") {
      // A decline leaves the phase where it is, with a record that someone
      // looked and chose not to decide. Not a failure, not a default approval.
      finish();
      return { kind: "declined" };
    }
    const action = decisionFrom(record.question, answer);
    if (!action) {
      finish();
      return { kind: "recorded" };
    }
    // 目标从**这道题自己的答案**读（T 是第一趟的格子，就在这份里）。
    let to: Phase | undefined;
    if (action === "sendBack") {
      const target = sendBackTargetFrom(record.question, answer);
      if (target === null) {
        finish();
        return { kind: "refused", action, reason: "no_target_chosen" };
      }
      to = target;
    }
    const reason = options?.sendBackReason?.trim() ?? "";
    this.commands.apply({
      changeId: record.changeId,
      action,
      idempotencyKey: `question:${questionId}`,
      expectedSnapshot: options?.rebaseFence === true
        ? this.commands.gateFor(record.changeId).snapshot
        : record.expectedSnapshot,
      ...(to === undefined ? {} : { to }),
      ...(action === "sendBack" && reason !== "" ? { reason } : {}),
    });
    finish();
    return { kind: "advanced", action };
  }
}
