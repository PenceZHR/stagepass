import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BLOCKER_SHAPE,
  createSlotDocument,
  readSlotDocument,
  type SlotHeader,
} from "./round-slots";
import { readRoundFromSlots } from "./round";

const head = (role: "red" | "blue", artifacts: string[]): SlotHeader => ({
  changeId: "CHG-1", phase: "QA", round: 3, role,
  shape: BLOCKER_SHAPE, artifacts,
});

const sheet = (
  role: "red" | "blue",
  artifacts: string[],
  fills: readonly (readonly [number, string, string?])[],
) => {
  const h = head(role, artifacts);
  const doc = JSON.parse(createSlotDocument(h));
  for (const [index, title, severity] of fills) {
    doc.slots[index].title = title;
    doc.slots[index].severity = severity ?? "P1";
    doc.slots[index].where = "src/a.ts:1";
    doc.slots[index].why = "说明";
  }
  return readSlotDocument(JSON.stringify(doc), h);
};

describe("一轮的产出从格子文件读，不从自由文本捞", () => {
  it("红蓝两边的发现都进来，产出路径来自预填", () => {
    // 只有 QA 里红方的发现算数（`RED_REVIEWS_OTHERS`）。
    const reading = readRoundFromSlots({
      phase: "QA", round: 3,
      red: sheet("red", ["docs/QA-r3.md"], [[0, "红方发现"]]),
      blue: sheet("blue", ["docs/QA-r3-opposition.md"], [[0, "蓝方发现", "P0"]]),
      verdicts: {},
      blueOverall: "还差两处",
    });
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    assert.deepEqual(reading.reading.artifactIds, ["docs/QA-r3.md"]);
    assert.deepEqual(
      reading.reading.outcome.found.map((f) => f.title),
      ["红方发现", "蓝方发现"],
    );
    assert.equal(reading.reading.blueOverall, "还差两处");
  });

  it("不评别人的阶段，红方的发现照旧丢掉", () => {
    // 和旧解析器一字不差的规则：只有 Review / QA 里红方报的问题算数。
    const reading = readRoundFromSlots({
      phase: "PRD", round: 3,
      red: sheet("red", ["docs/PRD-r3.md"], [[0, "红方自审"]]),
      blue: sheet("blue", ["docs/PRD-r3-opposition.md"], [[0, "蓝方发现"]]),
      verdicts: {}, blueOverall: null,
    });
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    assert.deepEqual(reading.reading.outcome.found.map((f) => f.title), ["蓝方发现"]);
  });

  it("哪一边的格子文件不合规，整轮说得出是哪一边", () => {
    const bad = readSlotDocument("{坏的", head("blue", []));
    const reading = readRoundFromSlots({
      phase: "PRD", round: 3,
      red: sheet("red", [], []), blue: bad, verdicts: {}, blueOverall: null,
    });
    assert.equal(reading.ok, false);
    if (reading.ok) return;
    assert.match(reading.reason, /反方/);
    assert.match(reading.reason, /JSON/i);
  });

  it("两边都没填 = 这一轮谁都没发现，不是失败", () => {
    const reading = readRoundFromSlots({
      phase: "PRD", round: 3,
      red: sheet("red", ["a.md"], []), blue: sheet("blue", ["b.md"], []),
      verdicts: {}, blueOverall: null,
    });
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    assert.deepEqual(reading.reading.outcome.found, []);
  });
});
