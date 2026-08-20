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

  it("有模板的阶段两边的自由清单都不算数 —— 判断全走逐条判定", () => {
    /*
     * 环 v3 里只有 QA 收自由问题清单（`reportsFreeFormBlockers`），红方的发现也
     * 只有 QA 算数（`RED_REVIEWS_OTHERS`）。别的七个阶段两边都走 rubric 逐条判定，
     * 格子文件在那儿只承载 `overall` 和产出路径。
     *
     * 规则一个字没变，换的只是丢在哪一层。
     */
    const reading = readRoundFromSlots({
      phase: "PRD", round: 3,
      red: sheet("red", ["docs/PRD-r3.md"], [[0, "红方自审"]]),
      blue: sheet("blue", ["docs/PRD-r3-opposition.md"], [[0, "蓝方发现"]]),
      verdicts: {}, blueOverall: null,
    });
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    assert.deepEqual(reading.reading.outcome.found, []);
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

  it("有模板的阶段，反方的自由问题清单不算数", () => {
    // 规则和旧解析器的 `discardBlockers` 一字不差 —— 它这一阶段的判断全部走
    // 逐条判定，自由清单丢在读的时候，不靠提示词叮嘱（叮嘱抓不到违反）。
    const reading = readRoundFromSlots({
      phase: "PRD", round: 3,
      red: sheet("red", ["a.md"], []),
      blue: sheet("blue", ["b.md"], [[0, "反方自己列的"]]),
      verdicts: {}, blueOverall: "还行",
    });
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    assert.deepEqual(reading.reading.outcome.found, []);
    assert.equal(reading.reading.blueOverall, "还行");
  });

  it("QA 是唯一收自由清单的阶段，产出路径照旧来自预填", () => {
    const reading = readRoundFromSlots({
      phase: "QA", round: 3,
      red: sheet("red", ["docs/QA-r3.md"], []),
      blue: sheet("blue", ["docs/QA-r3-opposition.md"], [[0, "反方发现"]]),
      verdicts: {}, blueOverall: null,
    });
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    assert.deepEqual(reading.reading.outcome.found.map((f) => f.title), ["反方发现"]);
    assert.deepEqual(reading.reading.artifactIds, ["docs/QA-r3.md"]);
  });
});
