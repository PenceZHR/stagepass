import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHANGE_ACTIONS, PHASE_STATUSES, type ChangeState } from "./change-state";
import { isRetired, PHASES, TERMINAL_PHASE } from "./phase";
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

const p0: Blocker = { id: "B-1", kind: "finding", severity: "P0", title: "范围与 PRD 冲突", where: null, why: null, owner: null };
const p1: Blocker = { id: "B-2", kind: "finding", severity: "P1", title: "验收标准不可测", where: null, why: null, owner: null };
const p2: Blocker = { id: "B-3", kind: "finding", severity: "P2", title: "措辞含糊", where: null, why: null, owner: null };

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
      // 退休的阶段派不了轮，也就没有闸门可算（`assertStateValid` 只放行它的
      // 历史行，`advancesTo` 对它抛）—— 穷举只覆盖主线上的。
      if (isRetired(phase)) continue;
      for (const status of PHASE_STATUSES) {
        if (status === "closed" && phase !== TERMINAL_PHASE) continue;
        const state: ChangeState = { phase, status, returnStack: [] };
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
      ["a different phase", snapshotOf({ ...SETTLED, phase: "BuildPlan" }, evidence())],
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
    why: null, owner: null,
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

/**
 * 第三条闸门：**判据单齐不齐**。
 *
 * ## 为什么它必须存在
 *
 * 在它之前，闸门只看两件事 —— 产物空不空、有没有未解决的 blocker。而 blocker 的
 * severity 是**模型填的**，且 `unresolved()` 里 P2 一条都不挡：今天模型写一个词，
 * 一条问题就从闸门上彻底消失，不需要任何人点头。
 *
 * 判据单把地基换掉：**齐不齐是代码判的**（`domain/rubric-sheet.ts` 数出来的
 * `missing`），模型改不动。
 *
 * ## 为什么 `refusals` 非得说得出第几条
 *
 * 少了这一步，面板上是一个灰按钮和一句「判据单不全」，人不知道去补哪一条 ——
 * 于是这条闸门从「挡住并指路」退化成「挡住」，而挡住而不指路的闸门最后都会被绕开。
 * 所以 `RefusalReason` 从字符串枚举扩成带 payload 的联合类型，这一整节盯的就是
 * payload 真的装上了东西。
 */
describe("L1 · 判据单不全就不许进下一阶段 —— 齐不齐是代码判的", () => {
  it("判据单缺一条就不许批准，而且说得出缺的是第几条", () => {
    const gate = computeGate(SETTLED, evidence({ sheetMissing: [2, 4] }));

    assert.ok(!gate.permitted.includes("approve"));
    const reason = gate.refusals.approve;
    assert.ok(
      reason !== undefined && typeof reason === "object",
      `refusals.approve 还是一个字符串（${String(reason)}）—— 面板上装不下「缺哪几条」`,
    );
    assert.equal(reason.kind, "rubric_sheet_incomplete");
    assert.deepEqual([...reason.missing], [2, 4]);
  });

  it("**拒绝里带的是那几条的原文，而且和序号一一对应** —— 序号本身指不了路", () => {
    /*
     * BuildPlan T7 要的是「序号 + 判据原文」。只有序号的话，人在面板上看到
     * 「缺第 2、4 条」，还得去翻那份题面文件才知道要补什么 —— 而那份文件在每轮一个
     * 随机临时目录里。
     *
     * 一一对应是这条的重点：`texts` 错位比没有 `texts` 更坏，人会照着第 4 条的
     * 措辞去补第 2 条。
     */
    const sheetTexts = ["第一条的原文", "第二条的原文", "第三条的原文", "第四条的原文"];
    const gate = computeGate(SETTLED, evidence({ sheetMissing: [2, 4], sheetTexts }));

    const reason = gate.refusals.approve;
    assert.ok(reason !== undefined && typeof reason === "object");
    assert.deepEqual([...reason.texts], ["第二条的原文", "第四条的原文"]);
  });

  it("拿不到原文时不错位 —— 宁可给空串，也不能让第 4 条的措辞顶到第 2 条头上", () => {
    const gate = computeGate(SETTLED, evidence({ sheetMissing: [2, 4], sheetTexts: [] }));
    const reason = gate.refusals.approve;
    assert.ok(reason !== undefined && typeof reason === "object");
    assert.equal(reason.texts.length, reason.missing.length,
      "texts 和 missing 长度对不上 —— 面板会把它们并排显示");
  });

  it("判据单齐了就不再挡 —— 空数组是「查过了，齐」，不是「没查」", () => {
    const gate = computeGate(SETTLED, evidence({ sheetMissing: [] }));
    assert.ok(gate.permitted.includes("approve"));
    assert.equal(gate.refusals.approve, undefined);
  });

  it("reject / retry / sendBack 不受判据单影响", () => {
    // 出口不能被证据不好挡住，否则 Change 会卡到没有合法动作 —— 判据单填不完的
    // 那一天，人连「打回去重做」都点不了。
    const incomplete = evidence({ sheetMissing: [1] });
    const settled = computeGate(SETTLED, incomplete);
    assert.ok(settled.permitted.includes("reject"));
    assert.ok(settled.permitted.includes("sendBack"));
    assert.ok(
      computeGate({ ...SETTLED, status: "blocked" }, incomplete).permitted.includes("retry"),
    );
    assert.ok(
      computeGate({ ...SETTLED, status: "running" }, incomplete).permitted.includes("fail"),
    );
  });

  it("sheetMissing 进 snapshot —— 补完一条，旧的裁决围栏要失效", () => {
    const complete = snapshotOf(SETTLED, evidence({ sheetMissing: [] }));
    assert.notEqual(snapshotOf(SETTLED, evidence({ sheetMissing: [1] })), complete);
    // 补掉一条也算地面动了：人是对着「缺 2 和 4」那张单子做的判断。
    assert.notEqual(
      snapshotOf(SETTLED, evidence({ sheetMissing: [2, 4] })),
      snapshotOf(SETTLED, evidence({ sheetMissing: [4] })),
    );
  });

  it("重排 sheetMissing 不动围栏 —— 顺序不是决策依据", () => {
    // 和上面那条 "ignores ordering that carries no meaning" 同一条规矩：因为库里
    // 换了个顺序返回就让人重新裁决一次，是被什么都没发生的事推翻了一个决定。
    assert.equal(
      snapshotOf(SETTLED, evidence({ sheetMissing: [2, 4] })),
      snapshotOf(SETTLED, evidence({ sheetMissing: [4, 2] })),
    );
  });

  it("**判据单不进 `unresolved()`** —— 它是另一条闸门，和 blocker 并列", () => {
    /*
     * 最省事的实现方式是把缺的那几条编成 blocker 塞进 `unresolved()`，那样
     * `computeGate` 一个字都不用改。而那会把两件事混成一句话：人在面板上看到
     * 「有未解决的问题」，去翻 gap 列表，一条都没有 —— 真正缺的是判据单上那两行。
     */
    assert.deepEqual([...unresolved(evidence({ sheetMissing: [1, 2, 3] }))], []);
    assert.notEqual(
      computeGate(SETTLED, evidence({ sheetMissing: [1] })).refusals.approve,
      "blocking_problem_outstanding",
    );
  });
});

/**
 * 回归：**`unresolved()` 这一期一个字不改。**
 *
 * 「P2 一条都不挡，而 severity 是模型填的」是 PRD §3.1 点名的病，但治它要先给每条
 * rubric 定分量，这一期不做。判据单是**另一条**闸门，和它并列 —— 而并列的东西最容易
 * 在实现时被顺手合并掉。
 *
 * 所以这里把它现在的真值表整张钉下来。上面那几条测试各自盯着一格，一张表才看得出
 * 「有没有哪一格在加第三条闸门的时候被动过」。
 */
describe("L1 · 回归 —— 加第三条闸门没动 `unresolved()` 的任何一格", () => {
  it("六种情形逐格不变", () => {
    const table: Array<readonly [string, Evidence, readonly string[]]> = [
      ["P0 永远挡", evidence({ blockers: [p0] }), [p0.id]],
      ["P0 进了 waive 名单也照挡", evidence({ blockers: [p0], waivedBlockerIds: [p0.id] }), [p0.id]],
      ["P1 默认挡", evidence({ blockers: [p1] }), [p1.id]],
      ["P1 被人接受了就不挡", evidence({ blockers: [p1], waivedBlockerIds: [p1.id] }), []],
      ["P2 一条都不挡（这一期不治它）", evidence({ blockers: [p2] }), []],
      ["P2 进 waive 名单也还是不挡", evidence({ blockers: [p2], waivedBlockerIds: [p2.id] }), []],
    ];
    for (const [what, given, expected] of table) {
      assert.deepEqual(unresolved(given).map((blocker) => blocker.id), [...expected], what);
    }
  });

  it("判据单不全时，blocker 那一格的算法照旧", () => {
    // 两条闸门同时不满足的那一格：`unresolved()` 的答案不该因为多了一张单子而变。
    const both = evidence({ blockers: [p1, p2], sheetMissing: [1] });
    assert.deepEqual(unresolved(both).map((blocker) => blocker.id), [p1.id]);
  });
});
