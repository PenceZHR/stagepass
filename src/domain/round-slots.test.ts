import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSlotDocument,
  readSlotDocument,
  slotContract,
  SLOT_COUNT,
  SLOT_FILL_LIMIT,
} from "./round-slots";

const HEAD = {
  changeId: "CHG-002", phase: "PRD" as const, round: 7,
  artifacts: ["docs/stagepass/CHG-002/PRD-r7.md"],
};
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
    // 产出路径 StagePass 自己知道，不问模型要 —— 旧契约就是因为模型漏了这一格
    // 而每轮整轮作废。
    assert.deepEqual(doc.artifacts, ["docs/stagepass/CHG-002/PRD-r7.md"]);
    assert.equal("overall" in doc, false, "这一阶段没要总评，就不该出现这一格");
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

  it("gives back the artifact paths it filled in itself", () => {
    const result = readSlotDocument(write(), HEAD);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts, ["docs/stagepass/CHG-002/PRD-r7.md"]);
  });

  it("refuses a document whose artifact paths the model touched", () => {
    for (const mutate of [
      (doc: any) => { doc.artifacts.push("src/somewhere-else.ts"); },
      (doc: any) => { doc.artifacts = []; },
      (doc: any) => { doc.artifacts[0] = "docs/别的.md"; },
    ]) {
      assert.equal(readSlotDocument(reparse(mutate), HEAD).ok, false);
    }
  });

  it("carries an overall line only where the phase asks for one", () => {
    const wants = { ...HEAD, wantsOverall: true };
    const doc = JSON.parse(createSlotDocument(wants));
    assert.equal(doc.overall, null);

    const answered = JSON.stringify({ ...doc, overall: "够好了，两处措辞待改" }, null, 2);
    const result = readSlotDocument(answered, wants);
    assert.equal(result.ok, true);
    assert.equal(result.overall, "够好了，两处措辞待改");

    // 不要总评的阶段，模型自己加一格也不行
    const sneaked = JSON.stringify({ ...JSON.parse(write()), overall: "顺手加的" }, null, 2);
    assert.equal(readSlotDocument(sneaked, HEAD).ok, false);
  });

  it("refuses a missing file rather than inventing an empty round", () => {
    const result = readSlotDocument(null, HEAD);
    assert.equal(result.ok, false);
    assert.match(result.reason, /没有/);
  });

  it("tells the model the path and the rules, not the shape", () => {
    // 形状在文件里，不在提示词里 —— 这正是格子文件相对旧契约的关键差别。
    const contract = slotContract("/x/r7.json");
    assert.match(contract, /\/x\/r7\.json/);
    assert.match(contract, new RegExp(`最多填 ${SLOT_FILL_LIMIT} 个`));
    assert.match(contract, new RegExp(`${SLOT_COUNT} 个是余量`));
    assert.match(contract, /不要新建文件/);
    assert.match(contract, /半条不算数/);
    // 不复述骨架：契约里不该出现字段清单
    assert.doesNotMatch(contract, /"blockers"|artifactIds/);
  });
});
