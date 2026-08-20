import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { artifactPathOf, splitSections } from "./prd-doc";
import type { TemplateSection } from "./phase-template";

const SECTIONS: readonly TemplateSection[] = [
  { key: "problem", title: "要解决谁的什么问题", asks: "" },
  { key: "outcome", title: "做完之后什么变了", asks: "" },
];

describe("L0 · 产物按节切开", () => {
  it("认标题，不认 <!-- section --> 注释", () => {
    // 模型写出来的产物里没有那行注释 —— 要它逐字抄，就是又开一个手抄面。
    const out = splitSections("## 要解决谁的什么问题\n张三卡在第三步。\n\n## 做完之后什么变了\n少一步。", SECTIONS);
    assert.equal(out[0]!.body, "张三卡在第三步。");
    assert.equal(out[1]!.body, "少一步。");
  });

  it("认不出来的节是空串，不抛 —— 写了一半的 PRD 也要看得见", () => {
    const out = splitSections("## 要解决谁的什么问题\n有。", SECTIONS);
    assert.equal(out[1]!.body, "");
    assert.equal(out.length, 2);
  });

  it("正文保留换行 —— 逐节渲染要靠它", () => {
    const out = splitSections("## 要解决谁的什么问题\n第一行\n第二行", SECTIONS);
    assert.equal(out[0]!.body, "第一行\n第二行");
  });

  it("路径由代码拼，模型一个字都不写", () => {
    assert.equal(artifactPathOf("CHG-004", "PRD"), "docs/PRD-CHG-004.md");
  });
});
