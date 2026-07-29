import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { InvalidVerdictError } from "../domain/gap";
import { computeGate } from "../domain/gate";
import { ChangeStore } from "./change-store";
import { GapStore } from "./gap-store";

const AT = "2026-07-28T00:00:00.000Z";
const SETTLED = { phase: "PRD" as const, status: "settled" as const, returnPhase: null };

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const now = () => new Date(AT);
  new ChangeStore(database, { now }).create("CHG-1");
  return { database, gaps: new GapStore(database, now) };
}

const found = (id: string, severity: "P0" | "P1" | "P2", title: string) =>
  ({ id, severity, title });

describe("L4 · a gap outlives the round that found it", () => {
  it("survives a round that never mentions it", () => {
    const { database, gaps } = open();
    try {
      gaps.settleRound("CHG-1", "PRD", {
        round: 1, found: [found("G-1", "P1", "验收标准不可测")], verdicts: {},
      });
      gaps.settleRound("CHG-1", "PRD", { round: 2, found: [], verdicts: {} });
      assert.deepEqual(
        gaps.blockers("CHG-1", "PRD").map((each) => each.id), ["G-1"],
      );
    } finally {
      database.close();
    }
  });

  it("goes away only when a round says so, with a reason", () => {
    const { database, gaps } = open();
    try {
      gaps.settleRound("CHG-1", "PRD", {
        round: 1, found: [found("G-1", "P1", "验收标准不可测")], verdicts: {},
      });
      gaps.settleRound("CHG-1", "PRD", {
        round: 2, found: [],
        verdicts: { "G-1": { kind: "closed", reason: "第 3 节补了可测标准" } },
      });
      assert.deepEqual(gaps.blockers("CHG-1", "PRD"), []);
      assert.equal(gaps.all("CHG-1", "PRD")[0]?.resolution, "第 3 节补了可测标准");
    } finally {
      database.close();
    }
  });

  /**
   * A round whose verdicts do not match what is open must not write anything.
   * A partially applied round leaves the gate reading a state no round ever
   * produced.
   */
  it("writes nothing when the round's verdicts are incoherent", () => {
    const { database, gaps } = open();
    try {
      gaps.settleRound("CHG-1", "PRD", {
        round: 1, found: [found("G-1", "P1", "验收标准不可测")], verdicts: {},
      });
      assert.throws(
        () => gaps.settleRound("CHG-1", "PRD", {
          round: 2,
          found: [found("G-2", "P0", "新问题")],
          verdicts: { "G-NOPE": { kind: "closed", reason: "并不存在" } },
        }),
        InvalidVerdictError,
      );
      // G-2 was in the same call and must not have landed either.
      assert.deepEqual(
        gaps.all("CHG-1", "PRD").map((each) => each.id), ["G-1"],
      );
    } finally {
      database.close();
    }
  });
});

describe("L4 · the gate reads gaps, so forgetting cannot open it", () => {
  /**
   * The property this layer exists for, asserted end to end: a second round
   * that regenerates the document and forgets the problem does not make the
   * phase approvable.
   */
  it("keeps approval refused after a round that forgot", () => {
    const { database, gaps } = open();
    try {
      gaps.settleRound("CHG-1", "PRD", {
        round: 1, found: [found("G-1", "P0", "范围与 PRD 冲突")], verdicts: {},
      });
      const evidence = {
        artifactIds: ["prd.md"],
        blockers: gaps.blockers("CHG-1", "PRD"),
        waivedBlockerIds: [],
      };
      assert.equal(
        computeGate(SETTLED, evidence).refusals.approve,
        "blocking_problem_outstanding",
      );

      gaps.settleRound("CHG-1", "PRD", { round: 2, found: [], verdicts: {} });
      assert.equal(
        computeGate(SETTLED, {
          ...evidence, blockers: gaps.blockers("CHG-1", "PRD"),
        }).refusals.approve,
        "blocking_problem_outstanding",
      );
    } finally {
      database.close();
    }
  });

  it("opens once the round closes it, or a person accepts it", () => {
    const { database, gaps } = open();
    try {
      gaps.settleRound("CHG-1", "PRD", {
        round: 1, found: [found("G-1", "P1", "验收标准不可测")], verdicts: {},
      });
      gaps.waive("CHG-1", "PRD", "G-1", "本期接受：改由人工检查覆盖");
      assert.ok(computeGate(SETTLED, {
        artifactIds: ["prd.md"],
        blockers: gaps.blockers("CHG-1", "PRD"),
        waivedBlockerIds: [],
      }).permitted.includes("approve"));
      assert.equal(
        gaps.waived("CHG-1", "PRD")[0]?.resolution,
        "本期接受：改由人工检查覆盖",
      );
    } finally {
      database.close();
    }
  });
});

describe("L4 · the row shape cannot lie", () => {
  /**
   * "Closed" and "forgotten" must not be the same row. The schema refuses a
   * resolved gap with nothing said about why.
   */
  it("refuses a resolved gap with no resolution", () => {
    const { database } = open();
    try {
      for (const status of ["closed", "waived"]) {
        assert.throws(
          () => database.prepare(
            `INSERT INTO gaps (id, change_id, phase, severity, title, status,
                               opened_round, resolution, updated_at)
             VALUES ('G-BAD','CHG-1','PRD','P1','t',?,1,NULL,?)`,
          ).run(status, AT),
          /CHECK constraint failed/,
          status,
        );
      }
    } finally {
      database.close();
    }
  });

  it("keeps each phase's gaps to itself", () => {
    const { database, gaps } = open();
    try {
      gaps.settleRound("CHG-1", "PRD", {
        round: 1, found: [found("G-1", "P0", "PRD 的问题")], verdicts: {},
      });
      gaps.settleRound("CHG-1", "Spec", {
        round: 1, found: [found("G-1", "P1", "Spec 的问题")], verdicts: {},
      });
      assert.equal(gaps.all("CHG-1", "PRD")[0]?.title, "PRD 的问题");
      assert.equal(gaps.all("CHG-1", "Spec")[0]?.title, "Spec 的问题");
    } finally {
      database.close();
    }
  });
});
