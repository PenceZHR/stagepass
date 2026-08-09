import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EDIT_GATE_ID, editGateClosed, isEditGateGap, withEditGate,
} from "./edit-gate";
import type { Gap } from "./gap";

/**
 * 批 6 · 编辑过门的纯规则。
 *
 * 门的存在理由（Arch 是共模点，人的编辑是唯一防线）见模块头；这里钉的是
 * 数据变换的三条硬性质：每轮重开、开着不动号、关门要证据。
 */

const other: Gap = {
  id: "S-1", kind: "finding", severity: "P1", title: "别的问题",
  status: "open", openedRound: 1, resolution: null, note: null,
  closedBy: null, where: null, why: null,
};

describe("L0 · 编辑过门", () => {
  it("没有就补一条 open 的 P1 —— 它靠既有的 blocking 机制挡批准", () => {
    const gaps = withEditGate([other], 2);
    const gate = gaps.find(isEditGateGap)!;
    assert.equal(gate.status, "open");
    assert.equal(gate.severity, "P1", "P1 才能被 waive —— 阻断归人管的出口");
    assert.equal(gate.openedRound, 2);
    assert.equal(gaps.length, 2, "别的 gap 被动了");
  });

  it("已关的翻回 open —— 红方重写了产出，上一版的手迹作废", () => {
    const closed = editGateClosed(withEditGate([], 1), "docs/x.md");
    assert.equal(closed.find(isEditGateGap)!.status, "closed");
    const reopened = withEditGate(closed, 3);
    const gate = reopened.find(isEditGateGap)!;
    assert.equal(gate.status, "open");
    assert.equal(gate.openedRound, 3, "重开要记这一轮的号");
  });

  it("开着的原样不动 —— openedRound 不许往后挪", () => {
    const once = withEditGate([], 1);
    const twice = withEditGate(once, 5);
    assert.equal(twice.find(isEditGateGap)!.openedRound, 1);
  });

  it("关门带证据，closedBy 是 human —— 没门可关就是幂等", () => {
    const gaps = editGateClosed(withEditGate([], 1), "docs/stagepass/CHG-1/Arch-r1.md");
    const gate = gaps.find(isEditGateGap)!;
    assert.equal(gate.status, "closed");
    assert.equal(gate.closedBy, "human");
    assert.match(gate.resolution ?? "", /human_edited: docs\/stagepass/);
    // 已关再关：原样返回，不写第二遍。
    assert.deepEqual(editGateClosed(gaps, "别的证据"), gaps);
    assert.deepEqual(editGateClosed([other], "x"), [other]);
  });

  it("id 是固定的 —— 检测那一侧按它认门，别的 gap 一概不是", () => {
    assert.ok(isEditGateGap({ id: EDIT_GATE_ID }));
    assert.ok(!isEditGateGap(other));
  });
});
