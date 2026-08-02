import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRound,
  blockersFrom,
  dismiss,
  humanGapId,
  InvalidVerdictError,
  isHumanGap,
  raise,
  waive,
  waivedFrom,
  type Gap,
} from "./gap";

function gap(patch: Partial<Gap> = {}): Gap {
  return {
    id: "G-1",
    kind: "finding", severity: "P1",
    title: "验收标准不可测",
    status: "open",
    openedRound: 1,
    resolution: null,
    note: null,
    ...patch,
  };
}

describe("L4 · silence keeps a gap open", () => {
  /**
   * The rule the whole module exists for. A second round that regenerates its
   * document and never mentions last round's problem must not thereby resolve
   * it -- otherwise forgetting opens the gate, and forgetting is the single
   * most likely thing a model does.
   */
  it("carries an unmentioned gap into the next round", () => {
    const after = applyRound([gap()], { round: 2, found: [], verdicts: {} });
    assert.deepEqual(after, [gap()]);
  });

  it("carries it even when the round found other things", () => {
    const after = applyRound([gap()], {
      round: 2,
      found: [{ id: "G-2", severity: "P0", title: "范围冲突" }],
      verdicts: {},
    });
    assert.deepEqual(after.map((each) => [each.id, each.status]), [
      ["G-1", "open"], ["G-2", "open"],
    ]);
  });

  it("closes one only when the round says so, with a reason", () => {
    const after = applyRound([gap()], {
      round: 2, found: [],
      verdicts: { "G-1": { kind: "closed", reason: "第 3 节补了可测的验收标准" } },
    });
    assert.deepEqual(after, [gap({
      status: "closed", resolution: "第 3 节补了可测的验收标准",
    })]);
  });

  /**
   * A close with no reason is indistinguishable from forgetting, and those two
   * are exactly what must not look the same.
   */
  it("refuses a verdict with no reason", () => {
    for (const reason of ["", "   "]) {
      assert.throws(
        () => applyRound([gap()], {
          round: 2, found: [], verdicts: { "G-1": { kind: "closed", reason } },
        }),
        (error: unknown) =>
          error instanceof InvalidVerdictError && error.code === "reason_missing",
      );
    }
  });

  it("records still_open without changing the gap", () => {
    const after = applyRound([gap()], {
      round: 2, found: [],
      verdicts: { "G-1": { kind: "still_open", reason: "仍然无法测量" } },
    });
    assert.deepEqual(after, [gap()]);
  });

  /**
   * A round claiming to have closed something that was never open is a round
   * whose other claims are worth less.
   */
  it("refuses a verdict on a gap that is not open", () => {
    for (const before of [[], [gap({ status: "closed", resolution: "done" })]]) {
      assert.throws(
        () => applyRound(before, {
          round: 2, found: [],
          verdicts: { "G-1": { kind: "closed", reason: "已修" } },
        }),
        (error: unknown) =>
          error instanceof InvalidVerdictError && error.code === "unknown_gap",
      );
    }
  });

  /**
   * 2026-08-02 真机（CHG-003 Spec 第 2 轮）：蓝方这一轮刚报了一条新问题（还没进库），
   * 裁判尽职地对它也表了态 still_open —— 一句按定义就是无操作的话（和沉默同一个
   * 结果），却把整轮作废。收窄之后：still_open 对不认识的 id 跳过，closed 照拒。
   */
  it("**裁判当场 closed 蓝方本轮的发现 —— 无效力，发现照常落地 open**", () => {
    /*
     * 2026-08-02 TechSpec 第 1 轮真机：裁判有理有据地驳回了蓝方本轮两条新发现
     * （kind=closed）。让它生效 = 蓝方的话在人看见之前被裁判掐掉 ——「发现不经
     * 裁判过滤」是立身之本。所以跳过：发现落地 open，裁判的异议下一轮正式表。
     */
    const after = applyRound([], {
      round: 1,
      found: [{ id: "SPEC-VERIFY-1", severity: "P1", title: "引入了 Spec 外行为" }],
      verdicts: {
        "SPEC-VERIFY-1": { kind: "closed", reason: "对照 Spec 可确认均有上游依据" },
      },
    });
    assert.equal(after.find((g) => g.id === "SPEC-VERIFY-1")?.status, "open",
      "裁判的同轮 closed 生效了 —— 蓝方的发现被过滤掉了");
  });

  it("**closed 一个谁都不认识的 id —— 仍然作废**（真幻觉的绊线保留）", () => {
    assert.throws(
      () => applyRound([], {
        round: 1, found: [],
        verdicts: { "GHOST-1": { kind: "closed", reason: "编的" } },
      }),
      (error: unknown) =>
        error instanceof InvalidVerdictError && error.code === "unknown_gap",
    );
  });

  it("**对不认识的 id 说 still_open —— 跳过，不作废整轮**", () => {
    const after = applyRound([gap()], {
      round: 2,
      found: [{ id: "SPEC-FLOW-1", severity: "P1", title: "loading 期间 game-over 的成绩去向未定义" }],
      verdicts: {
        "G-1": { kind: "closed", reason: "已修" },
        // 裁判对蓝方本轮新报的那条顺手说了 still_open —— 它还不在库里。
        "SPEC-FLOW-1": { kind: "still_open", reason: "仍未说明" },
      },
    });
    // 真裁决照常生效，新发现照常入库，谁也没被炸。
    assert.equal(after.find((g) => g.id === "G-1")?.status, "closed");
    assert.equal(after.find((g) => g.id === "SPEC-FLOW-1")?.status, "open");
  });
});

describe("L4 · finding the same problem again", () => {
  it("does not duplicate a gap that is already open", () => {
    const after = applyRound([gap()], {
      round: 2,
      found: [{ id: "G-1", severity: "P1", title: "验收标准不可测" }],
      verdicts: {},
    });
    assert.equal(after.length, 1);
    assert.equal(after[0]?.openedRound, 1);
  });

  /**
   * A later round looked and it is there. Whatever closed it earlier was wrong,
   * and the gate has to see it again.
   */
  it("reopens one that had been closed", () => {
    const after = applyRound(
      [gap({ status: "closed", resolution: "以为修好了" })],
      {
        round: 3,
        found: [{ id: "G-1", severity: "P1", title: "验收标准不可测" }],
        verdicts: {},
      },
    );
    assert.deepEqual(after, [gap({ openedRound: 3 })]);
  });

  /**
   * A waiver is a person's decision, not a round's finding. A later round
   * re-reporting the problem must not silently revoke it -- only a person can.
   */
  it("leaves a waived gap waived", () => {
    const after = applyRound(
      [gap({ status: "waived", resolution: "本期接受，下期处理" })],
      {
        round: 3,
        found: [{ id: "G-1", severity: "P1", title: "验收标准不可测" }],
        verdicts: {},
      },
    );
    assert.equal(after[0]?.status, "waived");
  });
});

describe("L4 · accepting a risk is a person's act, with a reason", () => {
  it("waives an open gap and keeps the reason", () => {
    const after = waive([gap()], "G-1", "本期接受，下期处理");
    assert.deepEqual(after, [gap({
      status: "waived", resolution: "本期接受，下期处理",
    })]);
    assert.deepEqual(waivedFrom(after).map((each) => each.id), ["G-1"]);
  });

  it("refuses a waiver with no reason", () => {
    assert.throws(
      () => waive([gap()], "G-1", "  "),
      (error: unknown) =>
        error instanceof InvalidVerdictError && error.code === "reason_missing",
    );
  });

  it("refuses to waive something that is not open", () => {
    assert.throws(() => waive([gap()], "G-NOPE", "r"), InvalidVerdictError);
    assert.throws(
      () => waive([gap({ status: "closed", resolution: "done" })], "G-1", "r"),
      InvalidVerdictError,
    );
  });
});

describe("L4 · what the gate is shown", () => {
  it("shows open gaps and nothing else", () => {
    const gaps = [
      gap({ id: "G-open" }),
      gap({ id: "G-closed", status: "closed", resolution: "修了" }),
      gap({ id: "G-waived", status: "waived", resolution: "接受" }),
    ];
    assert.deepEqual(blockersFrom(gaps).map((each) => each.id), ["G-open"]);
  });

  /**
   * Which severities block is the gate's decision, not this module's. Passing
   * P2 through keeps that judgement in one place.
   */
  it("passes every severity through and judges none of them", () => {
    const gaps = (["P0", "P1", "P2"] as const).map((severity) =>
      gap({ id: `G-${severity}`, severity }));
    assert.deepEqual(
      blockersFrom(gaps).map((each) => each.severity),
      ["P0", "P1", "P2"],
    );
  });
});

describe("L4 · a round-by-round walk", () => {
  it("keeps a forgotten problem alive across three rounds", () => {
    // Round 1 finds two problems.
    let gaps = applyRound([], {
      round: 1,
      found: [
        { id: "G-1", severity: "P0", title: "范围与 PRD 冲突" },
        { id: "G-2", severity: "P1", title: "验收标准不可测" },
      ],
      verdicts: {},
    });
    assert.equal(blockersFrom(gaps).length, 2);

    // Round 2 fixes one and says nothing about the other.
    gaps = applyRound(gaps, {
      round: 2, found: [],
      verdicts: { "G-1": { kind: "closed", reason: "范围已按 PRD 收窄" } },
    });
    assert.deepEqual(blockersFrom(gaps).map((each) => each.id), ["G-2"]);

    // Round 3 also says nothing. It is still there.
    gaps = applyRound(gaps, { round: 3, found: [], verdicts: {} });
    assert.deepEqual(blockersFrom(gaps).map((each) => each.id), ["G-2"]);

    // Only a person can let it through, and only on the record.
    gaps = waive(gaps, "G-2", "本期接受：验收改由人工检查覆盖");
    assert.deepEqual(blockersFrom(gaps), []);
    assert.equal(waivedFrom(gaps)[0]?.resolution, "本期接受：验收改由人工检查覆盖");
  });
});

describe("L1 · standard 的出口不是 waive", () => {
  const standard: Gap = {
    id: "RB:producer:RBC-a", kind: "standard", severity: null,
    title: "每条需求都有可测的验收标准",
    status: "open", openedRound: 1, resolution: null, note: null,
  };

  it("waive 一条 standard —— 拒绝", () => {
    // 「接受这个风险」和「撤销这个要求」是两句不同的话。让 waive 能关掉 standard，
    // 就是让人用前者去说后者。它的出口在 rubric 那边：取消勾选阻断或删掉那条
    // criterion（PRD §1.1）。
    assert.throws(
      () => waive([standard], standard.id, "先这样吧"),
      (error: unknown) => {
        assert.ok(error instanceof InvalidVerdictError);
        assert.equal(error.code, "standard_not_waivable");
        return true;
      });
  });

  it("finding 照常可以 waive —— 这条没有被改坏", () => {
    const finding: Gap = { ...standard, id: "G-1", kind: "finding", severity: "P1" };
    const [after] = waive([finding], "G-1", "这一版先接受");
    assert.equal(after?.status, "waived");
  });

  it("dismiss 一条 standard —— 同样拒绝", () => {
    /*
     * 理由和 waive 那条不同，要分开说：一条标准还挂在 rubric 上，这一轮把它派生的
     * gap 驳回了，**下一轮判定会再开一条一模一样的出来**（REMAP §3.4：退休需要
     * 正面证据）。所以这是一条这一轮有效、下一轮就失效的假出口。
     */
    assert.throws(
      () => dismiss([standard], standard.id, "我觉得这条不成立"),
      (error: unknown) => {
        assert.ok(error instanceof InvalidVerdictError);
        assert.equal(error.code, "standard_not_waivable");
        return true;
      });
  });
});

describe("L1 · 人驳回一条发现 —— 以人为主", () => {
  /*
   * 用户 2026-07-30 拍板：「人允许驳回蓝方的发现，以人为主。」
   *
   * 在这之前人没有这条路：一条蓝方提错的问题只能等模型下一轮自己改主意。那时唯一
   * 的出口是 waive —— 也就是被迫说「问题还在但我接受」去表达「你搞错了」。
   * **两句话不是一回事，而账本记的是他说了哪一句。**
   */
  it("驳回落 closed，带着我写的理由", () => {
    const [after] = dismiss([gap()], "G-1", "验收标准在第 3 节，反方没读到");
    assert.equal(after?.status, "closed");
    assert.equal(after?.resolution, "验收标准在第 3 节，反方没读到");
  });

  it("**驳回不是 waive** —— 一条被驳回的问题不进交付说明", () => {
    // waived 说的是「问题还在，我带着它走」，那要列进交付说明；驳回说的是它压根
    // 不成立，没有什么要带着走的。
    assert.deepEqual(waivedFrom(dismiss([gap()], "G-1", "不成立")), []);
  });

  it("没有理由 —— 拒绝", () => {
    for (const reason of ["", "   "]) {
      assert.throws(() => dismiss([gap()], "G-1", reason),
        (error: unknown) => {
          assert.ok(error instanceof InvalidVerdictError);
          assert.equal(error.code, "reason_missing");
          return true;
        });
    }
  });

  it("驳回一条不是 open 的 —— 拒绝", () => {
    assert.throws(
      () => dismiss([gap({ status: "waived", resolution: "r" })], "G-1", "不成立"),
      (error: unknown) => {
        assert.ok(error instanceof InvalidVerdictError);
        assert.equal(error.code, "unknown_gap");
        return true;
      });
  });

  it("被驳回之后，下一轮再报出来它会重开 —— 这条**故意**不拦", () => {
    /*
     * 驳回是「按我现在看到的，这条不成立」，不是给这个 id 永久免疫。反方下一轮
     * 拿着新证据再报一次，它就该回来 —— 那正是 `applyRound` 里「re-finding 一个
     * closed 的会重开它」。
     */
    const dismissed = dismiss([gap()], "G-1", "反方没读到第 3 节");
    const after = applyRound(dismissed, {
      round: 2,
      found: [{ id: "G-1", severity: "P1", title: "第 3 节那条也不可测" }],
      verdicts: {},
    });
    assert.equal(after[0]?.status, "open");
    assert.equal(after[0]?.openedRound, 2);
  });
});

describe("L1 · 人自己提一个问题", () => {
  it("落成 HUMAN-1 / finding / P1", () => {
    /*
     * 用户 2026-07-30 拍板的兼容判据，逐条钉住：
     *   kind    finding —— schema 那条配对 CHECK 要求 finding 必有严重度
     *   severity P1     —— 不是 P0：P0 不可豁免，而这是我自己提的要求，
     *                      「我改主意了」必须还能走 waive
     *   id      HUMAN- 前缀 —— 和 rubric 的 RB: 前缀同一个先例，不新增 kind
     */
    const [only] = raise([], { title: "没说清楚失败时回滚到哪", round: 3 });
    assert.deepEqual(only, {
      id: "HUMAN-1",
      kind: "finding",
      severity: "P1",
      title: "没说清楚失败时回滚到哪",
      status: "open",
      openedRound: 3,
      resolution: null,
      note: null,
    });
    assert.equal(isHumanGap(only!), true);
    assert.equal(isHumanGap(gap()), false);
  });

  it("顺号，而且**算所有的、不只 open 的**", () => {
    /*
     * 让号出来重用会撞上 `applyRound` 里「re-finding 一个 closed 的会重开它」：
     * 新问题顶着旧问题的 id，两条被混成一条，而旧问题的标题还留在那儿。
     */
    const one = raise([], { title: "第一条", round: 1 });
    const closed = dismiss(one, "HUMAN-1", "我自己撤了");
    const two = raise(closed, { title: "第二条", round: 2 });
    assert.deepEqual(two.map((each) => each.id), ["HUMAN-1", "HUMAN-2"]);
  });

  it("和模型报的问题共存，不互相占号", () => {
    const mixed = raise([gap({ id: "SPEC-1" })], { title: "我要的", round: 1 });
    assert.deepEqual(mixed.map((each) => each.id), ["SPEC-1", "HUMAN-1"]);
  });

  it("id 只有这一个拼法", () => {
    // 别在别处再拼一次 `"HUMAN-" + n`：那就是两份实现（E3）。
    assert.equal(raise([], { title: "t", round: 1 })[0]?.id, humanGapId(1));
  });

  it("空标题 —— 拒绝，下一轮没人知道该改什么", () => {
    for (const title of ["", "  \n "]) {
      assert.throws(() => raise([], { title, round: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof InvalidVerdictError);
          assert.equal(error.code, "title_missing");
          return true;
        });
    }
  });

  it("它挡闸门，但我改主意还能 waive", () => {
    const raised = raise([], { title: "我要的", round: 1 });
    assert.deepEqual(blockersFrom(raised).map((each) => each.id), ["HUMAN-1"]);
    assert.equal(waive(raised, "HUMAN-1", "想清楚了，这版先不做")[0]?.status, "waived");
  });
});
