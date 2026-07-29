import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { GateMovedError, GateRefusedError, type Blocker } from "../domain/gate";
import { ChangeStore } from "./change-store";
import { CommandStore, IdempotencyConflictError } from "./command-store";
import { EvidenceStore } from "./evidence-store";

const AT = "2026-07-28T00:00:00.000Z";
const P0: Blocker = { id: "B-1", kind: "finding", severity: "P0", title: "范围冲突" };
const P1: Blocker = { id: "B-2", kind: "finding", severity: "P1", title: "验收不可测" };

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const now = () => new Date(AT);
  const changes = new ChangeStore(database, { now });
  const evidence = new EvidenceStore(database, now);
  const commands = new CommandStore(database, now);
  changes.create("CHG-1");
  return { database, changes, evidence, commands };
}

/** Drive a Change to `settled` in its current phase, past the command layer. */
function settle(changes: ChangeStore) {
  changes.apply("CHG-1", "start");
  changes.apply("CHG-1", "settle");
}

describe("L1 · a decision only lands if all four checks pass", () => {
  it("applies an approval when the evidence supports it", () => {
    const { database, changes, evidence, commands } = open();
    try {
      settle(changes);
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
      });
      const gate = commands.gateFor("CHG-1");
      const result = commands.apply({
        changeId: "CHG-1",
        action: "approve",
        idempotencyKey: "cmd-1",
        expectedSnapshot: gate.snapshot,
      });
      assert.equal(result.replayed, false);
      assert.equal(result.state.phase, "Spec");
      assert.equal(changes.read("CHG-1").state.phase, "Spec");
    } finally {
      database.close();
    }
  });

  it("refuses an approval the gate does not permit, and leaves no trace", () => {
    const { database, changes, evidence, commands } = open();
    try {
      settle(changes);
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [P0], waivedBlockerIds: [],
      });
      const gate = commands.gateFor("CHG-1");
      assert.throws(
        () => commands.apply({
          changeId: "CHG-1",
          action: "approve",
          idempotencyKey: "cmd-1",
          expectedSnapshot: gate.snapshot,
        }),
        (error: unknown) =>
          error instanceof GateRefusedError
          && error.reason === "blocking_problem_outstanding",
      );
      // Nothing moved, and the key is still free for a later, legitimate try.
      assert.equal(changes.read("CHG-1").state.phase, "PRD");
      assert.equal(changes.read("CHG-1").seq, 2);
      assert.equal(
        (database.prepare("SELECT count(*) AS n FROM commands").get() as { n: number }).n,
        0,
      );
    } finally {
      database.close();
    }
  });

  /**
   * The case the fence exists for: a human opens a decision, thinks, and the
   * evidence changes underneath. Applying their "approve" to evidence they
   * never saw is precisely what must not happen.
   */
  it("refuses a decision whose evidence changed while it was open", () => {
    const { database, changes, evidence, commands } = open();
    try {
      settle(changes);
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
      });
      const opened = commands.gateFor("CHG-1");

      // A later round finds something.
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [P0], waivedBlockerIds: [],
      });

      assert.throws(
        () => commands.apply({
          changeId: "CHG-1",
          action: "approve",
          idempotencyKey: "cmd-1",
          expectedSnapshot: opened.snapshot,
        }),
        GateMovedError,
      );
      assert.equal(changes.read("CHG-1").state.phase, "PRD");
    } finally {
      database.close();
    }
  });

  /**
   * "The ground moved" and "you may not do that" are different problems with
   * different fixes -- re-read versus stop. The old tree reported both as one
   * word, which is why they were expensive to tell apart.
   */
  it("distinguishes a moved fence from a refused action", () => {
    const { database, changes, evidence, commands } = open();
    try {
      settle(changes);
      evidence.put("CHG-1", "PRD", {
        artifactIds: [], blockers: [], waivedBlockerIds: [],
      });
      const gate = commands.gateFor("CHG-1");
      assert.throws(
        () => commands.apply({
          changeId: "CHG-1", action: "approve",
          idempotencyKey: "a", expectedSnapshot: gate.snapshot,
        }),
        GateRefusedError,
      );
      assert.throws(
        () => commands.apply({
          changeId: "CHG-1", action: "approve",
          idempotencyKey: "b", expectedSnapshot: "stale".padEnd(64, "0"),
        }),
        GateMovedError,
      );
    } finally {
      database.close();
    }
  });

  it("refuses an action the machine has no shape for", () => {
    const { database, commands } = open();
    try {
      // PRD/pending accepts only `start`.
      const gate = commands.gateFor("CHG-1");
      assert.throws(
        () => commands.apply({
          changeId: "CHG-1", action: "approve",
          idempotencyKey: "cmd-1", expectedSnapshot: gate.snapshot,
        }),
        (error: unknown) =>
          error instanceof GateRefusedError
          && error.reason === "not_legal_in_this_status",
      );
    } finally {
      database.close();
    }
  });
});

describe("L1 · the same command twice is the same command once", () => {
  it("replays the stored result instead of applying again", () => {
    const { database, changes, evidence, commands } = open();
    try {
      settle(changes);
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
      });
      const request = {
        changeId: "CHG-1" as const,
        action: "approve" as const,
        idempotencyKey: "cmd-1",
        expectedSnapshot: commands.gateFor("CHG-1").snapshot,
      };
      const first = commands.apply(request);
      const second = commands.apply(request);

      assert.equal(first.replayed, false);
      assert.equal(second.replayed, true);
      assert.equal(second.seq, first.seq);
      // One transition, not two: the Change did not advance a second phase.
      assert.equal(changes.read("CHG-1").state.phase, "Spec");
      assert.equal(changes.read("CHG-1").seq, first.seq);
    } finally {
      database.close();
    }
  });

  it("refuses a key already bound to a different request", () => {
    const { database, changes, evidence, commands } = open();
    try {
      settle(changes);
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
      });
      const snapshot = commands.gateFor("CHG-1").snapshot;
      commands.apply({
        changeId: "CHG-1", action: "approve",
        idempotencyKey: "cmd-1", expectedSnapshot: snapshot,
      });
      assert.throws(
        () => commands.apply({
          changeId: "CHG-1", action: "reject",
          idempotencyKey: "cmd-1", expectedSnapshot: snapshot,
        }),
        IdempotencyConflictError,
      );
    } finally {
      database.close();
    }
  });

  /**
   * A refusal is not a durable outcome. The gate that said no may open, and a
   * caller that retries then must get a real answer rather than yesterday's.
   */
  it("does not make a refusal permanent", () => {
    const { database, changes, evidence, commands } = open();
    try {
      settle(changes);
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [P1], waivedBlockerIds: [],
      });
      assert.throws(
        () => commands.apply({
          changeId: "CHG-1", action: "approve",
          idempotencyKey: "cmd-1",
          expectedSnapshot: commands.gateFor("CHG-1").snapshot,
        }),
        GateRefusedError,
      );

      // The human accepts the P1. The same key must now be usable.
      evidence.waive("CHG-1", "PRD", P1.id);
      const result = commands.apply({
        changeId: "CHG-1", action: "approve",
        idempotencyKey: "cmd-1",
        expectedSnapshot: commands.gateFor("CHG-1").snapshot,
      });
      assert.equal(result.replayed, false);
      assert.equal(result.state.phase, "Spec");
    } finally {
      database.close();
    }
  });
});

describe("L1 · waiving a P1 is what opens the gate", () => {
  it("moves the fence, so the decision has to be re-read", () => {
    const { database, changes, evidence, commands } = open();
    try {
      settle(changes);
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [P1], waivedBlockerIds: [],
      });
      const before = commands.gateFor("CHG-1");
      evidence.waive("CHG-1", "PRD", P1.id);
      const after = commands.gateFor("CHG-1");

      assert.notEqual(after.snapshot, before.snapshot);
      assert.ok(!before.permitted.includes("approve"));
      assert.ok(after.permitted.includes("approve"));
    } finally {
      database.close();
    }
  });

  it("never lets a waiver silence a P0", () => {
    const { database, changes, evidence, commands } = open();
    try {
      settle(changes);
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [P0], waivedBlockerIds: [],
      });
      evidence.waive("CHG-1", "PRD", P0.id);
      assert.equal(
        commands.gateFor("CHG-1").refusals.approve,
        "blocking_problem_outstanding",
      );
    } finally {
      database.close();
    }
  });
});
