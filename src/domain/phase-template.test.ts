import assert from "node:assert/strict";
import { test } from "node:test";

import {
  missingSections, renderTemplate, reportsFreeFormBlockers, templateFor,
} from "./phase-template";

test("PRD 有模板，别的阶段暂时没有", () => {
  assert.equal(templateFor("PRD")?.length, 6);
  assert.equal(templateFor("Spec"), null);
});

test("节的 key 不重复", () => {
  const keys = templateFor("PRD")!.map((each) => each.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("渲染出来的每一节都带标题和它要回答什么", () => {
  const text = renderTemplate(templateFor("PRD")!);
  for (const section of templateFor("PRD")!) {
    assert.ok(text.includes(section.title), `缺标题 ${section.title}`);
    assert.ok(text.includes(section.asks), `缺说明 ${section.key}`);
  }
});

test("按标题认节 —— 全都在就没有缺的", () => {
  const filled = templateFor("PRD")!
    .map((each) => `## ${each.title}\n\n随便写点什么\n`).join("\n");
  assert.deepEqual(missingSections(filled, templateFor("PRD")!), []);
});

test("少一节就报那一节的 key", () => {
  const sections = templateFor("PRD")!;
  const filled = sections.slice(1)
    .map((each) => `## ${each.title}\n\n随便写点什么\n`).join("\n");
  assert.deepEqual(missingSections(filled, sections), [sections[0]!.key]);
});

test("有标题但底下是空的，也算缺 —— 填了标题不等于回答了", () => {
  const sections = templateFor("PRD")!;
  const filled = sections
    .map((each, index) => index === 2
      ? `## ${each.title}\n\n   \n`
      : `## ${each.title}\n\n有内容\n`)
    .join("\n");
  assert.deepEqual(missingSections(filled, sections), [sections[2]!.key]);
});

test("标题前后的空格和井号个数不计较", () => {
  const sections = templateFor("PRD")!;
  const filled = sections.map((each) => `#   ${each.title}   \n有内容\n`).join("\n");
  assert.deepEqual(missingSections(filled, sections), []);
});

/*
 * 这一条盯的是「宽的是识别，严的是数数」那半里**宽**的那一半会不会宽过头：
 * 标题只是**包含**节名不算数，否则「## 验收标准怎么写」会被认成「验收标准」那一节。
 */
test("标题必须逐字相等，只是包含不算", () => {
  const sections = templateFor("PRD")!;
  const filled = sections
    .map((each, index) => index === 0
      ? `## ${each.title}怎么写\n有内容\n`
      : `## ${each.title}\n有内容\n`)
    .join("\n");
  assert.deepEqual(missingSections(filled, sections), [sections[0]!.key]);
});

/*
 * 反方交不交自由 blockers，判据**只有一个**：这个阶段有没有模板。
 *
 * 不是一张手维护的名单 —— 名单要人记着「加了模板回来改第二处」，而这棵树刚为
 * 「同一个想法的第二份拷贝」吃过亏（§8.6·① 三份）。
 */
test("有模板的阶段不收自由 blockers，没模板的照收", () => {
  assert.equal(reportsFreeFormBlockers("PRD"), false, "PRD 有模板，判断走逐条判定");
  for (const phase of
    ["Spec", "TechSpec", "Plan", "TestPlan", "Build", "Review", "Fix", "QA", "Merge", "Retro"] as const) {
    assert.equal(reportsFreeFormBlockers(phase), true, phase);
  }
});

test("**判据就是 templateFor，不是第二张名单**", () => {
  for (const phase of
    ["PRD", "Spec", "TechSpec", "Plan", "TestPlan", "Build", "Review", "Fix", "QA", "Merge", "Retro", "Done"] as const) {
    assert.equal(reportsFreeFormBlockers(phase), templateFor(phase) === null, phase);
  }
});
