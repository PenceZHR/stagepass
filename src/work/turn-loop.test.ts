import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import type { Finding } from "../domain/gate";
import { ChangeStore } from "../store/change-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { CommandStore } from "../store/command-store";
import { JobStore } from "./job-store";
import {
  recoverStuckTurns, ScriptedTurnRunner, STRANDED_GRACE_MS, TurnLoop, type TurnOutcome,
} from "./turn-loop";

const AT = "2026-07-28T00:00:00.000Z";
const T0 = 1_000_000;
const TTL = 30_000;
const DEADLINE = T0 + 300_000;
const WORKER = { owner: "w-a", token: "t-1", now: T0, ttlMs: TTL };

const P0: Finding = { id: "B-1", kind: "finding", severity: "P0", title: "范围冲突", where: null, why: null };

function open(script: (TurnOutcome | Error)[]) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const now = () => new Date(AT);
  const changes = new ChangeStore(database, { now });
  changes.create("CHG-1");
  return {
    database,
    changes,
    jobs: new JobStore(database, now),
    commands: new CommandStore(database, now),
    loop: new TurnLoop({
      database,
      runner: new ScriptedTurnRunner(script),
      now,
    }),
  };
}

/*
 * 收拾主已经死了的活。
 *
 * `JobStore.recover` 早就写好、也离线证过 —— 但在这之前**一个生产调用者都没有**。
 * 2026-07-30 于是实测到了它本该防住的那件事：面板被杀掉，库里留下一个 `running` 的
 * Change，而 `running` 只允许 `settle` / `fail`，两个都不是人能裁决的动作 ——
 * 那个 Change 永远动不了了，界面上所有按钮全灰。
 */
describe("L1 · 进程死了之后，那个 Change 还能动", () => {
  const LEASE = 30 * 60_000;

  /** 摆出「有人 claim 了这个 job 然后进程死了」那个状态。 */
  const stranded = () => {
    const context = open([]);
    context.jobs.enqueue({
      id: "JOB-DEAD", changeId: "CHG-1", kind: "phase_turn",
      deadlineAt: T0 + LEASE, maxAttempts: 1,
    });
    context.jobs.claimNext({ owner: "panel", token: "tok", now: T0, ttlMs: LEASE });
    context.changes.apply("CHG-1", "start");
    return context;
  };

  it("**租约过期之后，job 和 Change 两边都记上失败**", () => {
    const { database, changes, jobs } = stranded();
    // 只记一边，就是老树那种「绿色的 job 压在一个从没动过的 Change 上面」。
    const summary = recoverStuckTurns(database, T0 + LEASE + 1);
    assert.deepEqual(summary.failed.map((each) => each.id), ["JOB-DEAD"]);
    assert.equal(jobs.read("JOB-DEAD").status, "failed");
    assert.equal(changes.read("CHG-1").state.status, "blocked");
  });

  it("收拾完之后人能 retry —— 那个 Change 不再是死的", () => {
    const { database, changes } = stranded();
    recoverStuckTurns(database, T0 + LEASE + 1);
    // blocked 允许 retry，而 running 只允许 settle / fail（两个都不是人能裁决的）。
    assert.doesNotThrow(() => changes.apply("CHG-1", "retry"));
  });

  it("**租约还没过期的不许碰** —— 判据是租约，不是「跑了很久」", () => {
    const { database, changes } = stranded();
    assert.deepEqual(recoverStuckTurns(database, T0 + 1),
      { resumed: [], failed: [], stranded: [] });
    assert.equal(changes.read("CHG-1").state.status, "running");
  });

  it("没有死掉的活时什么都不做", () => {
    const { database } = open([]);
    assert.deepEqual(recoverStuckTurns(database, T0 + LEASE + 1),
      { resumed: [], failed: [], stranded: [] });
  });

  it("再收拾一次是幂等的", () => {
    const { database, changes } = stranded();
    recoverStuckTurns(database, T0 + LEASE + 1);
    const status = changes.read("CHG-1").state.status;
    recoverStuckTurns(database, T0 + LEASE + 2);
    assert.equal(changes.read("CHG-1").state.status, status);
  });
});

describe("L1 · running 却没有任何活儿的 Change，也要被收尸", () => {
  /**
   * `queueTurn` 的注释写明了不变量：**a running Change always has work behind it**。
   *
   * 而 retry 那条路先推状态、后派发（`questions.apply` 把 blocked 推到 running，
   * 预检才跑）—— 派发被拒（比如树脏）时曾把 Change 永远留在 running：running 只
   * 允许 settle / fail，两个都不是人能按的按钮。2026-08-05 真机：Build/running
   * 挂着、库里没有 job、没有进程，人一个出口都没有。
   *
   * 租约收尸人看不见它 —— **没有 job 就没有租约**。所以这一档单独收：
   * 判据是「不变量已经破了」（running 而身后没有任何未完成的 job），不是「跑了很久」。
   */
  const NOW = Date.parse(AT);

  it("**running 而身后一个未完成的 job 都没有 → blocked，而且说出来**", () => {
    const { database, changes } = open([]);
    changes.apply("CHG-1", "start"); // running，没有排任何 job —— 不变量已破
    const summary = recoverStuckTurns(database, NOW + STRANDED_GRACE_MS + 1);
    assert.equal(changes.read("CHG-1").state.status, "blocked");
    // 静默恢复和什么都没发生在屏幕上一模一样 —— 收了谁要说出来。
    assert.deepEqual(summary.stranded, ["CHG-1"]);
  });

  it("收完人能 retry —— 这正是收它的全部意义", () => {
    const { database, changes } = open([]);
    changes.apply("CHG-1", "start");
    recoverStuckTurns(database, NOW + STRANDED_GRACE_MS + 1);
    assert.doesNotThrow(() => changes.apply("CHG-1", "retry"));
  });

  it("**刚变成 running 的不碰** —— 正常派发就在这几百毫秒里排 job", () => {
    // retry 先推状态、runRound 再预检再 queueTurn —— 这个窗口里「running 且没 job」
    // 是合法的中间态。宽限期就是给它留的；过了宽限还没有 job，才是真的断了。
    const { database, changes } = open([]);
    changes.apply("CHG-1", "start");
    const summary = recoverStuckTurns(database, NOW + 1_000);
    assert.equal(changes.read("CHG-1").state.status, "running");
    assert.deepEqual(summary.stranded, []);
  });

  it("身后有排着的 job 就不碰 —— 不变量没破", () => {
    const { database, changes, jobs } = open([]);
    jobs.enqueue({
      id: "JOB-QUEUED", changeId: "CHG-1", kind: "phase_turn",
      deadlineAt: NOW + 300_000, maxAttempts: 1,
    });
    changes.apply("CHG-1", "start");
    recoverStuckTurns(database, NOW + STRANDED_GRACE_MS + 1);
    assert.equal(changes.read("CHG-1").state.status, "running");
  });
});

describe("L1 · a phase runs, produces evidence, and the gate reads it", () => {
  /**
   * The whole of L0 and L1 exercised end to end with no Codex, no network and
   * no human. This is what "the foundation is built" has to mean before L2 is
   * allowed to exist.
   */
  it("goes from start to an approvable gate offline", async () => {
    const { database, changes, loop, commands } = open([
      { artifactIds: ["prd.md"], blockers: [] },
    ]);
    try {
      loop.queueTurn({
        changeId: "CHG-1", jobId: "JOB-1",
        deadlineAt: DEADLINE, maxAttempts: 3,
      });
      assert.equal(changes.read("CHG-1").state.status, "running");

      assert.deepEqual(await loop.runOnce(WORKER), {
        kind: "settled", jobId: "JOB-1",
      });
      assert.equal(changes.read("CHG-1").state.status, "settled");

      const gate = commands.gateFor("CHG-1");
      assert.ok(gate.permitted.includes("approve"));

      const applied = commands.apply({
        changeId: "CHG-1", action: "approve",
        idempotencyKey: "cmd-1", expectedSnapshot: gate.snapshot,
      });
      assert.equal(applied.state.phase, "Spec");
      assert.equal(applied.state.status, "pending");
    } finally {
      database.close();
    }
  });

  it("leaves the gate shut when the turn reported a blocker", async () => {
    const { database, loop, commands } = open([
      { artifactIds: ["prd.md"], blockers: [P0] },
    ]);
    try {
      loop.queueTurn({
        changeId: "CHG-1", jobId: "JOB-1",
        deadlineAt: DEADLINE, maxAttempts: 3,
      });
      await loop.runOnce(WORKER);
      assert.equal(
        commands.gateFor("CHG-1").refusals.approve,
        "blocking_problem_outstanding",
      );
    } finally {
      database.close();
    }
  });

  it("does nothing when there is no work", async () => {
    const { database, loop } = open([]);
    try {
      assert.deepEqual(await loop.runOnce(WORKER), { kind: "idle" });
    } finally {
      database.close();
    }
  });
});

describe("L1 · a failed turn is failed in both places", () => {
  /**
   * The old tree's signature failure: a green job sitting above a Change that
   * had never moved. Recording the failure on only one of the two is what makes
   * that possible, so both are asserted together.
   */
  it("marks the job and the Change, with the same reason available", async () => {
    const { database, changes, jobs, loop } = open([
      new Error("provider_refused"),
    ]);
    try {
      loop.queueTurn({
        changeId: "CHG-1", jobId: "JOB-1",
        deadlineAt: DEADLINE, maxAttempts: 3,
      });
      const result = await loop.runOnce(WORKER);

      assert.deepEqual(result, {
        kind: "failed", jobId: "JOB-1", reason: "provider_refused",
      });
      assert.equal(jobs.read("JOB-1").status, "failed");
      assert.equal(jobs.read("JOB-1").error, "provider_refused");
      assert.equal(changes.read("CHG-1").state.status, "blocked");
    } finally {
      database.close();
    }
  });

  it("lets a human retry a blocked phase, and the second turn settles it", async () => {
    const { database, changes, commands, loop } = open([
      new Error("provider_refused"),
      { artifactIds: ["prd.md"], blockers: [] },
    ]);
    try {
      loop.queueTurn({
        changeId: "CHG-1", jobId: "JOB-1",
        deadlineAt: DEADLINE, maxAttempts: 3,
      });
      await loop.runOnce(WORKER);
      assert.equal(changes.read("CHG-1").state.status, "blocked");

      commands.apply({
        changeId: "CHG-1", action: "retry",
        idempotencyKey: "cmd-retry",
        expectedSnapshot: commands.gateFor("CHG-1").snapshot,
      });
      assert.equal(changes.read("CHG-1").state.status, "running");

      // A fresh job for the retried turn; the previous one is terminal.
      loop.queueTurn({
        changeId: "CHG-1", jobId: "JOB-2",
        deadlineAt: DEADLINE, maxAttempts: 3,
      });
      assert.deepEqual(await loop.runOnce(WORKER), {
        kind: "settled", jobId: "JOB-2",
      });
      assert.ok(commands.gateFor("CHG-1").permitted.includes("approve"));
    } finally {
      database.close();
    }
  });
});

describe("L1 · a re-run replaces artifacts but never resolves a problem", () => {
  /**
   * This test used to assert the opposite -- that a second round finding
   * nothing cleared the first round's P0 -- and that assertion encoded the bug:
   * 「旧问题必须被明确复核，不能因为重新生成文档而消失」. A round that regenerates
   * its document and forgets last round's problem must not thereby open the
   * gate, because forgetting is the likeliest thing a model does.
   */
  it("keeps a problem the next round forgot to mention", async () => {
    const { database, commands, loop } = open([
      { artifactIds: ["prd.md"], blockers: [P0] },
      { artifactIds: ["prd.md", "notes.md"], blockers: [] },
    ]);
    try {
      loop.queueTurn({
        changeId: "CHG-1", jobId: "JOB-1",
        deadlineAt: DEADLINE, maxAttempts: 3,
      });
      await loop.runOnce(WORKER);
      assert.equal(
        commands.gateFor("CHG-1").refusals.approve,
        "blocking_problem_outstanding",
      );

      commands.apply({
        changeId: "CHG-1", action: "reject",
        idempotencyKey: "cmd-reject",
        expectedSnapshot: commands.gateFor("CHG-1").snapshot,
      });
      loop.queueTurn({
        changeId: "CHG-1", jobId: "JOB-2",
        deadlineAt: DEADLINE, maxAttempts: 3,
      });
      await loop.runOnce(WORKER);

      // The second round said nothing about it, so it stands.
      assert.equal(
        commands.gateFor("CHG-1").refusals.approve,
        "blocking_problem_outstanding",
      );
      // The artifacts, which ARE the round's own output, were replaced.
      assert.deepEqual(
        new EvidenceStore(database).read("CHG-1", "PRD").artifactIds,
        ["prd.md", "notes.md"],
      );
    } finally {
      database.close();
    }
  });

  it("clears it only when a round says so, with a reason", async () => {
    const { database, commands, loop } = open([
      { artifactIds: ["prd.md"], blockers: [P0] },
      {
        artifactIds: ["prd.md"],
        blockers: [],
        verdicts: { [P0.id]: { kind: "closed", reason: "范围已按 PRD 收窄" } },
      },
    ]);
    try {
      loop.queueTurn({
        changeId: "CHG-1", jobId: "JOB-1",
        deadlineAt: DEADLINE, maxAttempts: 3,
      });
      await loop.runOnce(WORKER);
      commands.apply({
        changeId: "CHG-1", action: "reject", idempotencyKey: "cmd-reject",
        expectedSnapshot: commands.gateFor("CHG-1").snapshot,
      });
      loop.queueTurn({
        changeId: "CHG-1", jobId: "JOB-2",
        deadlineAt: DEADLINE, maxAttempts: 3,
      });
      await loop.runOnce(WORKER);

      assert.ok(commands.gateFor("CHG-1").permitted.includes("approve"));
      assert.equal(
        new GapStore(database).all("CHG-1", "PRD")[0]?.resolution,
        "范围已按 PRD 收窄",
      );
    } finally {
      database.close();
    }
  });
});
