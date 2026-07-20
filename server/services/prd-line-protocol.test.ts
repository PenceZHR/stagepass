import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parsePrdLineProtocol, stripPrdProtocol } from "./prd-line-protocol";
import { StructuredPrdSchema } from "../types/prd";


function parse(text: string) {
  return parsePrdLineProtocol(text);
}

/** The minimum a turn must produce: title + overview + targetUsers + anchor. */
const MINIMAL = [
  "TITLE: stagepass — 产品需求文档",
  "OVERVIEW<<",
  "把对话变成可执行的 PRD 草案。",
  ">>OVERVIEW",
  "TARGETUSERS<<",
  "产品经理与工程师。",
  ">>TARGETUSERS",
  "PRD_DONE: true",
].join("\n");

const FULL = [
  "我已经根据你的需求整理了一版草案。",
  "",
  "TITLE: stagepass — 产品需求文档",
  "OVERVIEW<<",
  "把对话变成可执行的 PRD 草案。",
  "",
  "第二段：解决评审来回拉扯的问题。",
  ">>OVERVIEW",
  "TARGETUSERS<<",
  "产品经理与工程师。",
  ">>TARGETUSERS",
  "STORY: US-001 | 产品经理 | 提交一句需求 | 拿到结构化草案",
  "FR: FR-001 | 生成 PRD | 从用户输入生成结构化 PRD 草案 | must",
  "AC: FR-001 | AC-001 | 草案被保存且可评审 | true",
  "AC: FR-001 | AC-002 | 缺字段时给出校验提示 | true",
  "NFR<<",
  "单次生成 30 秒内返回。",
  ">>NFR",
  "OUTOFSCOPE<<",
  "不做实现工作。",
  ">>OUTOFSCOPE",
  "METRICS<<",
  "评审者可直接确认草案。",
  ">>METRICS",
  "RISKS<<",
  "输入不足时需要追问。",
  ">>RISKS",
  "OQ: OQ-001 | 是否需要多语言？ | true | -",
  "CONSTRAINTS<<",
  "只能改 .ship 下的 PRD 产物。",
  ">>CONSTRAINTS",
  "MODULE: server/services/prd-service.ts",
  "MODULE: app/prd/page.tsx",
  "CONTRACTS<<",
  "POST /api/prd/turn",
  ">>CONTRACTS",
  "TESTSTRATEGY<<",
  "node:test 覆盖解析与保存。",
  ">>TESTSTRATEGY",
  "BOUNDARIES<<",
  "空输入直接拒绝。",
  ">>BOUNDARIES",
  "PHASECONSTRAINTS<<",
  "先锁 PRD 再进 Spec。",
  ">>PHASECONSTRAINTS",
  "SOURCE: Spec Kit | https://example.com/spec-kit",
  "ADOPTED: Spec Kit | 用户故事结构",
  "ADOPTED: Spec Kit | 验收标准格式",
  "REJECTED: Spec Kit | 完整的模板样板",
  "REJECTREASON: Spec Kit | 与本项目阶段模型不符",
  "PRD_DONE: true",
].join("\n");

describe("parsePrdLineProtocol", () => {
  it("parses a full PRD and supplies version itself", () => {
    const result = parse(FULL);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.version, 1);
    assert.equal(result.payload.body.title, "stagepass — 产品需求文档");
    assert.equal(
      result.payload.body.overview,
      "把对话变成可执行的 PRD 草案。\n\n第二段：解决评审来回拉扯的问题。",
    );
    assert.equal(result.payload.body.targetUsers, "产品经理与工程师。");
    assert.deepEqual(result.payload.body.userStories, [
      { id: "US-001", persona: "产品经理", action: "提交一句需求", benefit: "拿到结构化草案" },
    ]);
    assert.equal(result.payload.body.nonFunctionalRequirements, "单次生成 30 秒内返回。");
    assert.deepEqual(result.payload.aiAppendix.affectedModules, [
      "server/services/prd-service.ts",
      "app/prd/page.tsx",
    ]);
    assert.equal(result.payload.aiAppendix.phaseConstraints, "先锁 PRD 再进 Spec。");
  });

  it("nests acceptance criteria under their functional requirement", () => {
    const result = parse(FULL);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const requirement = result.payload.body.functionalRequirements[0]!;
    assert.equal(requirement.id, "FR-001");
    assert.equal(requirement.priority, "must");
    assert.deepEqual(requirement.acceptanceCriteria, [
      { id: "AC-001", description: "草案被保存且可评审", testable: true },
      { id: "AC-002", description: "缺字段时给出校验提示", testable: true },
    ]);
  });

  it("groups the three parallel lists under their source", () => {
    const result = parse(FULL);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.payload.sources, [
      {
        name: "Spec Kit",
        url: "https://example.com/spec-kit",
        adopted: ["用户故事结构", "验收标准格式"],
        rejected: ["完整的模板样板"],
        rejectionReasons: ["与本项目阶段模型不符"],
      },
    ]);
  });

  it("assembles a payload the StructuredPrd schema accepts", () => {
    for (const text of [MINIMAL, FULL]) {
      const result = parse(text);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(StructuredPrdSchema.safeParse(result.payload).success, true);
    }
  });

  it("defaults every optional prose field to the empty string", () => {
    const result = parse(MINIMAL);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.body.risks, "");
    assert.equal(result.payload.body.outOfScope, "");
    assert.equal(result.payload.aiAppendix.testStrategy, "");
    assert.deepEqual(result.payload.body.functionalRequirements, []);
    assert.deepEqual(result.payload.sources, []);
  });

  it("rejects a chat reply that carries no protocol", () => {
    const result = parse("好的，我先问你几个问题：这个产品给谁用？");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /expected exactly 1 TITLE line/);
    assert.match(result.message, /OVERVIEW/);
  });

  it("rejects a reply truncated before the anchor", () => {
    // savePrd() overwrites the whole PRD, so a partial document must not settle.
    const result = parse(MINIMAL.replace("\nPRD_DONE: true", ""));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /expected exactly 1 PRD_DONE: true line, got 0/);
  });

  it("rejects an empty or missing required block", () => {
    assert.equal(parse(MINIMAL.replace("把对话变成可执行的 PRD 草案。", "")).ok, false);
    const missing = parse("TITLE: t\nTARGETUSERS<<\nu\n>>TARGETUSERS\nPRD_DONE: true");
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.match(missing.message, /expected a non-empty OVERVIEW<< … >>OVERVIEW block/);
  });

  it("fails loud when a block body contains its own terminator instead of truncating the PRD", () => {
    // The reviewer's motivating case: a PRD that documents the terminator syntax
    // with a standalone `>>OVERVIEW` inside its overview. savePrd() overwrites the
    // whole PRD, so a silent truncation here is maximally destructive.
    const raw = [
      "TITLE: 讲解行协议的 PRD",
      "OVERVIEW<<",
      "本项目概述。收尾行写成：",
      ">>OVERVIEW",
      "以上这句必须保留。",
      ">>OVERVIEW",
      "TARGETUSERS<<",
      "工程师。",
      ">>TARGETUSERS",
      "PRD_DONE: true",
    ].join("\n");
    const result = parse(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /stray ">>OVERVIEW"/);
  });

  it("fails loud on a stray opener rather than dropping records after it", () => {
    const result = parse([
      "TITLE: t",
      "OVERVIEW<<\no\n>>OVERVIEW",
      "TARGETUSERS<<\nu\n>>TARGETUSERS",
      "SCRATCH<<",
      "FR: FR-1 | t | d | must",
      "PRD_DONE: true",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /unterminated SCRATCH<< block/);
  });

  it("fails loud on a balanced unexpected block that hides a STORY and MODULE", () => {
    // The seventh shape through the PRD stage: a NOTE<< … >>NOTE that swallows
    // records savePrd would otherwise overwrite the PRD without.
    const result = parse([
      "TITLE: t",
      "OVERVIEW<<\no\n>>OVERVIEW",
      "TARGETUSERS<<\nu\n>>TARGETUSERS",
      "STORY: US-1 | a | b | c",
      "NOTE<<",
      "STORY: US-2 | d | e | f",
      "MODULE: server/auth.ts",
      ">>NOTE",
      "PRD_DONE: true",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /unexpected NOTE<< block/);
  });

  it("rejects an AC that references no declared FR", () => {
    const result = parse(`${MINIMAL}\nAC: FR-404 | AC-001 | 描述 | true`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /AC references unknown FR id "FR-404"/);
  });

  it("rejects source lists that reference no declared SOURCE", () => {
    const result = parse(`${MINIMAL}\nADOPTED: Ghost Source | 某段内容`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /ADOPTED references unknown SOURCE name "Ghost Source"/);
  });

  it("rejects duplicate AC ids under one FR", () => {
    const result = parse([
      MINIMAL.replace("\nPRD_DONE: true", ""),
      "FR: F1 | t | d | must",
      "AC: F1 | A1 | desc | true",
      "AC: F1 | A1 | desc | false",
      "PRD_DONE: true",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /duplicate AC id under F1: A1/);
  });

  it("rejects duplicate ids rather than silently keeping one", () => {
    const result = parse([
      MINIMAL,
      "FR: FR-001 | A | 描述 A | must",
      "FR: FR-001 | B | 描述 B | should",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /duplicate FR id: FR-001/);
  });

  it("rejects an unknown priority and a non-boolean testable/blocking", () => {
    assert.equal(parse(`${MINIMAL}\nFR: FR-1 | t | d | urgent`).ok, false);
    assert.equal(parse(`${MINIMAL}\nFR: FR-1 | t | d | must\nAC: FR-1 | AC-1 | d | yes`).ok, false);
    assert.equal(parse(`${MINIMAL}\nOQ: OQ-1 | q | maybe | -`).ok, false);
  });

  it("rejects a wrong field count rather than silently shifting fields", () => {
    const result = parse(`${MINIMAL}\nSTORY: US-1 | 角色 | 动作`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /STORY needs exactly 4 "\|" fields/);
  });

  it("rejects structural garbage in a module path", () => {
    const result = parse(`${MINIMAL}\nMODULE: server/a.ts"},{"x`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /MODULE contains JSON fragment garbage/);
  });

  it("reads `-` as a null open-question answer", () => {
    const result = parse(`${MINIMAL}\nOQ: OQ-1 | 需要多语言吗？ | false | 暂定只做中文`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.body.openQuestions[0]!.answer, "暂定只做中文");
    const nulled = parse(`${MINIMAL}\nOQ: OQ-1 | 需要多语言吗？ | true | -`);
    assert.equal(nulled.ok, true);
    if (!nulled.ok) return;
    assert.equal(nulled.payload.body.openQuestions[0]!.answer, null);
  });
});

describe("stripPrdProtocol", () => {
  it("leaves the human only the prose", () => {
    // The legacy PRD turn shows `summary` in the chat, so protocol syntax must
    // never reach the user.
    assert.equal(stripPrdProtocol(FULL), "我已经根据你的需求整理了一版草案。");
  });

  it("strips block bodies, not just the markers", () => {
    const stripped = stripPrdProtocol(FULL);
    assert.doesNotMatch(stripped, /OVERVIEW|TARGETUSERS|PRD_DONE|>>|<</);
    assert.doesNotMatch(stripped, /把对话变成可执行的 PRD 草案/);
    assert.doesNotMatch(stripped, /FR-001|AC-001|Spec Kit/);
  });

  it("keeps a reply that has no protocol untouched", () => {
    assert.equal(stripPrdProtocol("这个产品给谁用？"), "这个产品给谁用？");
  });

  it("returns empty when the reply is protocol only", () => {
    assert.equal(stripPrdProtocol(MINIMAL), "");
  });
});
