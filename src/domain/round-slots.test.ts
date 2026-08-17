import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSlotDocument,
  readSlotDocument,
  SLOT_COUNT,
  SLOT_FILL_LIMIT,
} from "./round-slots";

const HEAD = { changeId: "CHG-002", phase: "PRD" as const, round: 7 };
const write = (): string => createSlotDocument(HEAD);
const reparse = (mutate: (doc: any) => void): string => {
  const doc = JSON.parse(write());
  mutate(doc);
  return JSON.stringify(doc, null, 2);
};
const fill = (doc: any, index: number, over: Record<string, unknown> = {}): void => {
  Object.assign(doc.slots[index], {
    severity: "P1", title: "验收标准不可测", where: "docs/PRD.md §3", why: "没有可观测的判据",
    ...over,
  });
};

describe("Round slot file", () => {
  it("hands the model a fully shaped document it only has to fill", () => {
    // 判据是「结构由谁决定」。id 也由 StagePass 写死 —— 模型连 id 都不用打，
    // 手抄那条顺带焊死。
    const doc = JSON.parse(write());
    assert.equal(doc.slots.length, SLOT_COUNT);
    assert.equal(SLOT_COUNT, 15);
    assert.equal(SLOT_FILL_LIMIT, 10);
    assert.deepEqual(doc.stagepass, {
      change: "CHG-002", phase: "PRD", round: 7, maxFilled: 10,
    });
    assert.deepEqual(doc.slots[0], {
      id: "G-1", severity: null, title: null, where: null, why: null, owner: null,
    });
    assert.deepEqual(doc.slots.at(-1).id, "G-15");
  });

  it("reads only the filled slots and keeps their order", () => {
    const text = reparse((doc) => {
      fill(doc, 0, { title: "第一条" });
      fill(doc, 4, { title: "第五条", severity: "P0" });
    });
    const result = readSlotDocument(text, HEAD);
    assert.equal(result.ok, true);
    assert.deepEqual(result.filled, [
      { id: "G-1", severity: "P1", title: "第一条", where: "docs/PRD.md §3", why: "没有可观测的判据", owner: null },
      { id: "G-5", severity: "P0", title: "第五条", where: "docs/PRD.md §3", why: "没有可观测的判据", owner: null },
    ]);
  });

  it("treats an untouched document as a round with nothing to raise", () => {
    // 没有要问的是合法状态，不是错误。
    const result = readSlotDocument(write(), HEAD);
    assert.equal(result.ok, true);
    assert.deepEqual(result.filled, []);
  });

  it("refuses more filled slots than the round allows, without truncating", () => {
    const text = reparse((doc) => {
      for (let i = 0; i < SLOT_FILL_LIMIT + 1; i += 1) fill(doc, i, { title: `第 ${i} 条` });
    });
    const result = readSlotDocument(text, HEAD);
    assert.equal(result.ok, false);
    assert.match(result.reason, /11 条.*上限 10/);
  });

  it("refuses a half-written slot instead of guessing the rest", () => {
    const text = reparse((doc) => { doc.slots[2].where = "src/a.ts"; });
    const result = readSlotDocument(text, HEAD);
    assert.equal(result.ok, false);
    assert.match(result.reason, /G-3/);
    assert.match(result.reason, /title/);
  });

  it("refuses a severity outside the fixed set", () => {
    const text = reparse((doc) => { fill(doc, 0, { severity: "URGENT" }); });
    const result = readSlotDocument(text, HEAD);
    assert.equal(result.ok, false);
    assert.match(result.reason, /severity/);
  });

  it("refuses a document whose structure the model edited", () => {
    for (const [name, mutate] of [
      ["改 id", (doc: any) => { doc.slots[0].id = "G-99"; }],
      ["删格子", (doc: any) => { doc.slots.pop(); }],
      ["加格子", (doc: any) => { doc.slots.push({ ...JSON.parse(write()).slots[0], id: "G-16" }); }],
      ["加字段", (doc: any) => { doc.slots[0].note = "顺手加的"; }],
      ["删字段", (doc: any) => { delete doc.slots[0].owner; }],
      ["改抬头", (doc: any) => { doc.stagepass.maxFilled = 99; }],
      ["调顺序", (doc: any) => { doc.slots.reverse(); }],
    ] as const) {
      const result = readSlotDocument(reparse(mutate), HEAD);
      assert.equal(result.ok, false, `${name} 应该被拒`);
    }
  });

  it("refuses a document belonging to another round or seat", () => {
    const text = write();
    assert.equal(readSlotDocument(text, { ...HEAD, round: 8 }).ok, false);
    assert.equal(readSlotDocument(text, { ...HEAD, changeId: "CHG-001" }).ok, false);
    assert.equal(readSlotDocument(text, { ...HEAD, phase: "Spec" }).ok, false);
  });

  it("hands back the parser's own words when the model breaks the JSON", () => {
    // 不修复、不猜 —— 原话留给下一轮，人才查得清发生了什么。
    const result = readSlotDocument('{"stagepass": {,,,', HEAD);
    assert.equal(result.ok, false);
    assert.match(result.reason, /JSON/i);
  });

  it("refuses a missing file rather than inventing an empty round", () => {
    const result = readSlotDocument(null, HEAD);
    assert.equal(result.ok, false);
    assert.match(result.reason, /没有/);
  });
});
