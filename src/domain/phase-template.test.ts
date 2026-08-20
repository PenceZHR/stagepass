import assert from "node:assert/strict";
import { test } from "node:test";

import { missingSections, parseTemplateSections, renderTemplate, templateFor } from "./phase-template";

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

/*
 * 模板正文文本储存（用户 2026-08-13 拍板：提示词要模块化、文本储存）。
 *
 * `src/prompts/templates/<Phase>.md` 是**源头**，这个模块启动时解析它。解析器
 * 必须**响亮地拒绝坏文件**：静默吞掉一节，红方就会收到一份缺格的清单然后照缺的
 * 写 —— 和「空模板」同一个坑（模块头上那段写过为什么 null ≠ 空模板）。
 */
test("解析：`<!-- section: key -->` + `## 标题` + 正文，一节一块", () => {
  const sections = parseTemplateSections([
    "<!-- section: problem -->",
    "## 要解决谁的什么问题",
    "谁在用、他今天怎么受阻。",
    "",
    "<!-- section: outcome -->",
    "## 做完之后什么变了",
    "可观察的结果。",
  ].join("\n"));
  assert.deepEqual(sections, [
    { key: "problem", title: "要解决谁的什么问题", asks: "谁在用、他今天怎么受阻。" },
    { key: "outcome", title: "做完之后什么变了", asks: "可观察的结果。" },
  ]);
});

test("解析：多行正文按行保留 —— 文件里一行就是字符串里一行", () => {
  const sections = parseTemplateSections([
    "<!-- section: graph -->",
    "## 机器可读的架构图",
    "第一行说形状：",
    "`concepts`（数组）；",
    "`relations`（数组）。",
  ].join("\n"));
  assert.equal(
    sections[0]!.asks,
    "第一行说形状：\n`concepts`（数组）；\n`relations`（数组）。",
  );
});

test("解析：第一个节标记之前的东西是文件头注释，不进任何一节", () => {
  const sections = parseTemplateSections([
    "<!--",
    "  这份文件是模板的源头；这段是给编辑它的人看的说明。",
    "-->",
    "",
    "<!-- section: only -->",
    "## 唯一的一节",
    "正文。",
  ].join("\n"));
  assert.deepEqual(sections.map((each) => each.key), ["only"]);
  assert.equal(sections[0]!.asks, "正文。");
});

test("解析：正文首尾的空行修掉，中间的保留原样", () => {
  const sections = parseTemplateSections([
    "<!-- section: s -->",
    "## 标题",
    "",
    "第一段。",
    "",
    "第二段。",
    "",
  ].join("\n"));
  assert.equal(sections[0]!.asks, "第一段。\n\n第二段。");
});

test("解析：坏文件要响亮地拒绝，不许静默吞节", () => {
  // 一节都没有 —— 文件路径错了或整个被清空了，都不该变成「这个阶段没模板」。
  assert.throws(() => parseTemplateSections("只有散文，没有节标记"), /没有任何节/);
  // 节标记后面没有标题行。
  assert.throws(
    () => parseTemplateSections("<!-- section: s -->\n正文没有标题"),
    /没有 `## 标题`/,
  );
  // 标题有了但正文是空的 —— 空 asks 的节和缺节一样害红方。
  assert.throws(
    () => parseTemplateSections("<!-- section: s -->\n## 标题\n\n"),
    /正文是空的/,
  );
  // key 重复 —— rubric 挂在 key 上，两节同 key 会互相认领。
  assert.throws(
    () => parseTemplateSections([
      "<!-- section: dup -->", "## 甲", "正文。",
      "<!-- section: dup -->", "## 乙", "正文。",
    ].join("\n")),
    /key 重复/,
  );
});
