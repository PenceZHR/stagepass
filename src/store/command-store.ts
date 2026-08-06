import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import type { ChangeAction, ChangeState } from "../domain/change-state";
import type { Phase } from "../domain/phase";
import {
  assertFence,
  assertPermitted,
  computeGate,
  type Gate,
} from "../domain/gate";
import { ChangeStore, type ChangeRecord } from "./change-store";
import { EvidenceStore } from "./evidence-store";

/**
 * The one way a decision becomes a state change.
 *
 * Four things have to hold, in this order, and any of them may say no:
 *
 *   1. the caller has not already applied this command (idempotency)
 *   2. the evidence the caller decided against is still the evidence (fence)
 *   3. the gate permits the action given that evidence
 *   4. the machine permits it given the phase's status  (L0)
 *
 * Order matters. Checking the fence before the gate means a caller whose ground
 * moved is told *that*, rather than being told the action is not permitted --
 * two very different problems that the old tree reported with the same word.
 */

export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(
      `Idempotency key ${idempotencyKey} is already bound to a different request`,
    );
    this.name = "IdempotencyConflictError";
  }
}

export interface CommandRequest {
  readonly changeId: string;
  readonly action: ChangeAction;
  readonly idempotencyKey: string;
  /** The gate snapshot the caller decided against. */
  readonly expectedSnapshot: string;
  /**
   * 动作的目标阶段：`sendBack` 打回哪一份上游文档，`approve` 之后进哪个阶段
   * （§8.10 —— 不给就是走推荐那条）。别的动作不带。
   */
  readonly to?: Phase;
  /** 这一步为什么发生，人的话。进账本，环上历史箭头读它。 */
  readonly reason?: string;
}

export interface CommandResult {
  readonly changeId: string;
  readonly action: ChangeAction;
  readonly state: ChangeState;
  readonly seq: number;
  /** True when this call replayed a command that had already been applied. */
  readonly replayed: boolean;
}

interface CommandRow {
  request_hash: string;
  action: string;
  result_seq: number;
  result_phase: string;
  result_status: string;
}

function requestHash(request: CommandRequest): string {
  return createHash("sha256").update(JSON.stringify({
    changeId: request.changeId,
    action: request.action,
    expectedSnapshot: request.expectedSnapshot,
    // 目标和理由都进哈希：同一个 key 打回到不同的地方（或换了说法）不是重放，
    // 是另一个请求 —— 必须撞出来，不能拿旧结果应付。
    to: request.to ?? null,
    reason: request.reason ?? null,
  })).digest("hex");
}

export class CommandStore {
  private readonly changes: ChangeStore;
  private readonly evidence: EvidenceStore;

  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.changes = new ChangeStore(database, { now });
    this.evidence = new EvidenceStore(database, now);
  }

  /** The gate as it stands right now, which is what a caller fences against. */
  gateFor(changeId: string): Gate {
    const record = this.changes.read(changeId);
    return computeGate(
      record.state,
      this.evidence.read(changeId, record.state.phase),
      // 图也进闸门：一张只走 Build->Done 的图上，Build 没有上游，sendBack 必须
      // 在这儿就被拒 —— 而不是等 transition 抛出来变成一个 500。
      this.changes.graphOf(changeId),
    );
  }

  apply(request: CommandRequest): CommandResult {
    const existing = this.database.prepare(
      "SELECT request_hash, action, result_seq, result_phase, result_status FROM commands WHERE idempotency_key = ?",
    ).get(request.idempotencyKey) as CommandRow | undefined;
    if (existing) {
      // Same key, different request. Returning the stored result would answer a
      // question the caller did not ask; applying it would apply the command
      // twice. Refuse, and say which key is the problem.
      if (existing.request_hash !== requestHash(request)) {
        throw new IdempotencyConflictError(request.idempotencyKey);
      }
      const record = this.changes.read(request.changeId);
      return {
        changeId: request.changeId,
        action: request.action,
        state: record.state,
        seq: existing.result_seq,
        replayed: true,
      };
    }

    return this.database.transaction((): CommandResult => {
      const before = this.changes.read(request.changeId);
      const gate = computeGate(
        before.state,
        this.evidence.read(request.changeId, before.state.phase),
        this.changes.graphOf(request.changeId),
      );
      assertFence(request.expectedSnapshot, gate);
      assertPermitted(gate, request.action);

      const after: ChangeRecord = this.changes.apply(
        request.changeId,
        request.action,
        {
          ...(request.to === undefined ? {} : { to: request.to }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        },
      );
      this.database.prepare(
        `INSERT INTO commands
           (idempotency_key, change_id, action, request_hash, expected_snapshot,
            result_seq, result_phase, result_status, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        request.idempotencyKey,
        request.changeId,
        request.action,
        requestHash(request),
        request.expectedSnapshot,
        after.seq,
        after.state.phase,
        after.state.status,
        this.now().toISOString(),
      );
      return {
        changeId: request.changeId,
        action: request.action,
        state: after.state,
        seq: after.seq,
        replayed: false,
      };
    })();
  }
}
