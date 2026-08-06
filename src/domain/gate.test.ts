import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHANGE_ACTIONS, PHASE_STATUSES, type ChangeState } from "./change-state";
import { PHASES } from "./phase";
import {
  assertFence,
  assertPermitted,
  computeGate,
  EMPTY_EVIDENCE,
  GateMovedError,
  GateRefusedError,
  snapshotOf,
  unresolved,
  type Blocker,
  type Evidence,
} from "./gate";

/** A settled Spec, the shape every approval decision is made in. */
const SETTLED: ChangeState = {
  phase: "Spec",
  status: "settled",
  returnStack: [],
};

function evidence(patch: Partial<Evidence> = {}): Evidence {
  return { ...EMPTY_EVIDENCE, artifactIds: ["spec.md"], ...patch };
}

const p0: Blocker = { id: "B-1", kind: "finding", severity: "P0", title: "范围与 PRD 冲突", where: null, why: null };
const p1: Blocker = { id: "B-2", kind: "finding", severity: "P1", title: "验收标准不可测", where: null, why: null };
const p2: Blocker = { id: "B-3", kind: "finding", severity: "P2", title: "措辞含糊", where: null, why: null };

describe("L1 · the gate decides from facts, never from a summary", () => {
  it("permits approval when something was produced and nothing blocks", () => {
    const gate = computeGate(SETTLED, evidence());
    // sendBack 也在：Spec 有上游（PRD），闸门把长回边摆出来（§5.9.1）。
    assert.deepEqual([...gate.permitted].sort(), ["approve", "reject", "sendBack"]);
    assert.equal(gate.refusals.approve, undefined);
  });

  it("refuses approval when the phase produced nothing", () => {
    const gate = computeGate(SETTLED, evidence({ artifactIds: [] }));
    assert.equal(gate.refusals.approve, "nothing_was_produced");
    assert.ok(!gate.permitted.includes("approve"));
    // Rejecting must stay open: an empty phase still has to be sendable back.
    assert.ok(gate.permitted.includes("reject"));
  });

  it("refuses approval while a blocking problem stands", () => {
    for (const blocker of [p0, p1]) {
      const gate = computeGate(SETTLED, evidence({ blockers: [blocker] }));
      assert.equal(
        gate.refusals.approve,
        "blocking_problem_outstanding",
        `${blocker.severity} must block approval`,
      );
    }
  });

  it("lets a P2 through", () => {
    const gate = computeGate(SETTLED, evidence({ blockers: [p2] }));
    assert.ok(gate.permitted.includes("approve"));
  });

  /**
   * 「严重到不可接受的问题不能通过普通确认绕过」. A waiver list that could silence a
   * P0 would make the severity decorative.
   */
  it("honours a P1 waiver and ignores a P0 one", () => {
    assert.deepEqual(
      unresolved(evidence({ blockers: [p1], waivedBlockerIds: [p1.id] })),
      [],
    );
    assert.deepEqual(
      unresolved(evidence({ blockers: [p0], waivedBlockerIds: [p0.id] })),
      [p0],
    );
    assert.ok(
      computeGate(
        SETTLED,
        evidence({ blockers: [p1], waivedBlockerIds: [p1.id] }),
      ).permitted.includes("approve"),
    );
    assert.equal(
      computeGate(
        SETTLED,
        evidence({ blockers: [p0], waivedBlockerIds: [p0.id] }),
      ).refusals.approve,
      "blocking_problem_outstanding",
    );
  });

  /**
   * The way out must never be gated on the evidence being good. Gating `reject`
   * or `retry` on a clean gate is how a Change ends up with no legal move at
   * all -- stuck in a state whose only exits are refused.
   */
  it("never gates the ways out of a bad place", () => {
    const bad = evidence({ artifactIds: [], blockers: [p0] });
    assert.ok(computeGate(SETTLED, bad).permitted.includes("reject"));
    assert.ok(
      computeGate({ ...SETTLED, status: "blocked" }, bad)
        .permitted.includes("retry"),
    );
    assert.ok(
      computeGate({ ...SETTLED, status: "running" }, bad)
        .permitted.includes("fail"),
    );
  });

  it("gives every action either a permit or a stated reason", () => {
    for (const phase of PHASES) {
      for (const status of PHASE_STATUSES) {
        if (status === "closed" && phase !== "Done") continue;
        const state: ChangeState = {
          phase,
          status,
          returnStack: phase === "Fix" ? ["Review"] : [],
        };
        const gate = computeGate(state, evidence({ blockers: [p1] }));
        for (const action of CHANGE_ACTIONS) {
          const decided = gate.permitted.includes(action)
            || gate.refusals[action] !== undefined;
          assert.ok(decided, `${phase}/${status} left ${action} undecided`);
        }
      }
    }
  });
});

describe("L1 · the fence catches ground that moved", () => {
  it("changes the snapshot when any input the decision used changes", () => {
    const base = snapshotOf(SETTLED, evidence());
    const variants: Array<[string, string]> = [
      ["another artifact", snapshotOf(SETTLED, evidence({ artifactIds: ["spec.md", "b.md"] }))],
      ["a new blocker", snapshotOf(SETTLED, evidence({ blockers: [p1] }))],
      ["a waiver", snapshotOf(SETTLED, evidence({ waivedBlockerIds: ["B-2"] }))],
      ["a different phase", snapshotOf({ ...SETTLED, phase: "Plan" }, evidence())],
      ["a different status", snapshotOf({ ...SETTLED, status: "running" }, evidence())],
    ];
    for (const [what, snapshot] of variants) {
      assert.notEqual(snapshot, base, `${what} must move the fence`);
    }
    assert.equal(new Set(variants.map(([, s]) => s)).size, variants.length);
  });

  /**
   * Reordering is not a change. If it moved the fence, a human would be asked
   * to decide again because a list came back from the database in another
   * order -- a decision invalidated by nothing.
   */
  it("ignores ordering that carries no meaning", () => {
    assert.equal(
      snapshotOf(SETTLED, evidence({
        artifactIds: ["a.md", "b.md"],
        blockers: [p1, p2],
      })),
      snapshotOf(SETTLED, evidence({
        artifactIds: ["b.md", "a.md"],
        blockers: [p2, p1],
      })),
    );
  });

  it("refuses a decision made against a snapshot that no longer holds", () => {
    const opened = computeGate(SETTLED, evidence());
    const now = computeGate(SETTLED, evidence({ blockers: [p0] }));
    assert.doesNotThrow(() => assertFence(opened.snapshot, opened));
    assert.throws(() => assertFence(opened.snapshot, now), GateMovedError);
  });

  it("names the action and the reason when it refuses", () => {
    const gate = computeGate(SETTLED, evidence({ artifactIds: [] }));
    assert.throws(
      () => assertPermitted(gate, "approve"),
      (error: unknown) =>
        error instanceof GateRefusedError
        && error.action === "approve"
        && error.reason === "nothing_was_produced",
    );
    assert.doesNotThrow(() => assertPermitted(gate, "reject"));
  });
});

/**
 * 一条没被满足的标准，和一个发现的问题，不是一回事。
 *
 * rubric 判的是「满足了没有」，二元 —— 没有严重度可言。硬给它编一个 P0/P1/P2 是
 * 凭空发明一个维度；而真正让它必须单独存在的，是**出口不同**：P1 靠 waive 出去
 * （人接受这个风险），standard 靠撤下那条标准出去（人说这件事本来就不该要求）。
 */
describe("L1 · 一条没被满足的标准，waive 不掉", () => {
  const standard: Blocker = {
    id: "RB:producer:RBC-a", kind: "standard", severity: null,
    title: "每条需求都有可测的验收标准",
    where: null,
    why: null,
  };

  it("照挡 —— 有一条标准没满足，就不能批准", () => {
    const gate = computeGate(SETTLED, evidence({ blockers: [standard] }));
    assert.equal(gate.refusals.approve, "blocking_problem_outstanding");
  });

  it("把它写进 waive 名单也没用 —— 那是在用「我接受风险」说「我撤销要求」", () => {
    const outstanding = unresolved(evidence({
      blockers: [standard],
      waivedBlockerIds: [standard.id],
    }));
    assert.deepEqual(outstanding.map((blocker) => blocker.id), [standard.id]);
  });

  it("同一个 id 换了 kind，fence 就变 —— 出口变了就是决策依据变了", () => {
    const asFinding = snapshotOf(SETTLED, evidence({
      blockers: [{ ...standard, kind: "finding", severity: "P1" }],
    }));
    const asStandard = snapshotOf(SETTLED, evidence({ blockers: [standard] }));
    assert.notEqual(asFinding, asStandard);
  });

  it("P2 仍然不挡，standard 没有「不挡」这一档", () => {
    assert.deepEqual(unresolved(evidence({ blockers: [p2] })), []);
    assert.equal(unresolved(evidence({ blockers: [standard] })).length, 1);
  });
});
