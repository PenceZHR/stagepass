import assert from "node:assert/strict";
import { test } from "node:test";

import { missingSections, renderTemplate, templateFor } from "./phase-template";

/*
 * 覆盖面 = 环 v3 主线的八个阶段（每个都有产出文档 —— Build/Test 交 commit 的
 * 同时也交报告）。退休的不给模板（TechSpec 先例）：留一份在那儿，下一个人会
 * 以为它还在用。
 */
test("八个主线阶段都有模板；退休的没有", () => {
  for (const phase of
    ["PRD", "Spec", "Arch", "BuildPlan", "TestPlan", "Build", "Test", "QA"] as const) {
    assert.ok((templateFor(phase)?.length ?? 0) >= 4, `${phase} 没有模板`);
  }
  for (const phase of
    ["TechSpec", "Plan", "Review", "Fix", "Merge", "Retro", "Done"] as const) {
    assert.equal(templateFor(phase), null, `${phase} 不该有模板`);
  }
});

test("每份模板的节 key 在自己那份里不重复，标题也不重复", () => {
  for (const phase of
    ["PRD", "Spec", "Arch", "BuildPlan", "TestPlan", "Build", "Test", "QA"] as const) {
    const sections = templateFor(phase)!;
    assert.equal(new Set(sections.map((each) => each.key)).size, sections.length, `${phase} key 重复`);
    // 标题重复更要命：`missingSections` 按标题认节，两节同名会互相认领。
    assert.equal(new Set(sections.map((each) => each.title)).size, sections.length, `${phase} 标题重复`);
  }
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
