import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const TEMPLATES_DIR = path.join(process.cwd(), "server", "templates", "prompts");

describe("plan.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "plan.md"), "utf-8");

  it("contains role definition", () => {
    assert.match(content, /架构级实现规划师/);
  });

  it("contains splitting principles", () => {
    assert.match(content, /每个 step 只做一件事/);
  });

  it("contains granularity requirements", () => {
    assert.match(content, /描述必须说明具体改动内容/);
  });

  it("contains step count constraint", () => {
    assert.match(content, /至少.*5 个 STEP/);
  });

  it("contains counter-example", () => {
    assert.match(content, /不合格.*STEP/);
  });

  it("teaches the line protocol and never JSON output", () => {
    assert.match(content, /PLAN:/);
    assert.match(content, /EXPECT:/);
    assert.match(content, /FORBID:/);
    assert.match(content, /STEP:/);
    assert.match(content, /不要输出\s*任何?\s*JSON|不要输出 JSON/);
    assert.doesNotMatch(content, /allowedFiles/);
    assert.doesNotMatch(content, /```json/);
  });

  it("contains hard constraints", () => {
    assert.match(content, /不要修改源码/);
    assert.match(content, /只能读文件、搜索代码、分析上下文/);
    assert.match(content, /不要写入 plan\.json 或 plan\.md/);
    assert.match(content, /不要新增依赖/);
    assert.match(content, /不要修改 package\.json/);
  });

  it("preserves changeId placeholder", () => {
    assert.match(content, /\{changeId\}/);
  });
});

describe("review.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "review.md"), "utf-8");

  it("teaches the line protocol and never JSON output", () => {
    assert.match(content, /FINDING: severity \| category \| file \| line \| title \| evidence \| requiredFix/);
    assert.match(
      content,
      /PRIOR: priorFindingId \| verdict \| evidence \| requiredFix \| replacementFindingId \| reviewerNotes/,
    );
    assert.match(content, /APPROVED: true/);
    assert.match(content, /SUMMARY<</);
    // The terminator must be named (`>>SUMMARY`), not a bare `>>`. A bare
    // terminator truncated the summary when its body contained a `>>`.
    assert.match(content, />>SUMMARY/);
    assert.match(content, /Do not output any JSON, code fences, or brace structures/);
    // The template must not model a JSON fence — the review prompt's only
    // ```json blocks are injected read-only DB context, never output shape.
    assert.doesNotMatch(content, /```json/);
  });

  it("declares the verdict vocabulary the parser accepts", () => {
    assert.match(content, /still_open \/ fixed \/ downgraded \/ not_reviewable \/ not_rechecked/);
  });

  it("requires requiredFix rather than suggestion", () => {
    assert.match(content, /always use requiredFix/);
    assert.doesNotMatch(content, /"requiredFix": "required remediation/);
  });

  it("preserves the original review scope constraints", () => {
    assert.match(content, /You are a code reviewer/);
    assert.match(content, /Report only review findings/);
    assert.match(content, /Do not implement fixes, edit files, or suggest unrelated improvements/);
  });

  it("preserves changeId placeholder", () => {
    assert.match(content, /\{changeId\}/);
  });
});

describe("implement.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "implement.md"), "utf-8");

  it("contains role definition", () => {
    assert.match(content, /严格按计划执行的实现者/);
  });

  it("contains progress reporting format", () => {
    assert.match(content, /\[Step N\/Total\]/);
  });

  it("contains final output table format", () => {
    assert.match(content, /文件路径/);
    assert.match(content, /操作类型/);
    assert.match(content, /改动摘要/);
    assert.match(content, /原因/);
  });

  it("contains hard constraints", () => {
    assert.match(content, /DB Plan Scope/);
    assert.match(content, /expectedFiles/);
    assert.match(content, /forbiddenFiles/);
    assert.match(content, /DB TestPlan/);
    assert.match(content, /DB TechSpec/);
    assert.match(content, /DB API/);
    assert.match(content, /Git facts/);
    assert.match(content, /不得读取.*plan\.json/s);
    assert.match(content, /不得读取.*plan\.md/s);
    assert.match(content, /不得读取.*spec\.md/s);
    assert.doesNotMatch(content, /plan\.json\.allowedFiles/);
    assert.doesNotMatch(content, /\.ship\/architecture\.md/);
    assert.doesNotMatch(content, /\.ship\/coding-rules\.md/);
    assert.doesNotMatch(content, /\.ship\/changes\/\{changeId\}\/spec\.md/);
    assert.doesNotMatch(content, /\.ship\/changes\/\{changeId\}\/plan\.md/);
    assert.doesNotMatch(content, /\.ship\/changes\/\{changeId\}\/plan\.json/);
    assert.match(content, /禁止修改 package\.json/);
    assert.match(content, /禁止新增依赖/);
    assert.match(content, /必须新增或更新测试/);
  });

  it("preserves changeId placeholder", () => {
    assert.match(content, /\{changeId\}/);
  });
});

describe("fix.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "fix.md"), "utf-8");

  it("contains stage boundary constraints", () => {
    assert.match(content, /当前阶段是 fix_findings/);
    assert.match(content, /status=open/);
    assert.match(content, /DB Plan Scope/);
    assert.match(content, /expectedFiles/);
    assert.doesNotMatch(content, /plan\.json\.allowedFiles/);
    assert.match(content, /BLOCKED/);
  });
});

describe("release.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "release.md"), "utf-8");

  it("requires a delivery handoff section with user-facing usage details", () => {
    assert.match(content, /交付与使用说明/);
    assert.match(content, /使用入口/);
    assert.match(content, /运行命令/);
    assert.match(content, /验证命令/);
    assert.match(content, /交付位置/);
    assert.match(content, /已知限制/);
  });
});

describe("refine.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "refine.md"), "utf-8");

  it("contains read-only requirements boundary", () => {
    assert.match(content, /当前阶段是 refine/);
    assert.match(content, /禁止创建、修改、删除任何文件/);
    // Was `/requirements JSON/`, which pinned the instruction to emit a
    // ```requirements fenced JSON array -- i.e. it pinned the model authoring
    // JSON, the exact thing the project rule forbids. The boundary this test
    // cares about (refine outputs requirements and never writes spec) is now
    // expressed by the REQ line protocol.
    assert.match(content, /REQ 需求行|REQ 行/);
    assert.match(content, /spec 文件只能由系统/);
  });

  it("teaches the line protocol and never JSON output", () => {
    assert.match(
      content,
      /REQ: id \| functional\/non-functional\/constraint \| confirmed\/uncertain\/new \| 标题 \| 详细描述/,
    );
    assert.match(content, /不要输出 JSON/);
    assert.doesNotMatch(content, /```requirements/);
    assert.doesNotMatch(content, /```json/);
  });
});

describe("tech-spec.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "tech-spec.md"), "utf-8");

  it("teaches the line protocol and never JSON output", () => {
    assert.match(content, /INTERFACE: 名称 \| 类型/);
    assert.match(content, /CONTRACT: 名称 \| 必填字段/);
    assert.match(content, /MIGRATION:/);
    assert.match(content, /BUILD:/);
    assert.match(content, /REVIEW:/);
    assert.match(content, /不要输出 JSON/);
    // The old template asked for "一个 JSON object" and modelled it with a
    // ```json fence -- the invitation to author JSON by hand.
    assert.doesNotMatch(content, /```json/);
    assert.doesNotMatch(content, /只输出一个 JSON object/);
  });

  it("preserves the stage boundary and changeId placeholder", () => {
    assert.match(content, /当前阶段是 tech_spec/);
    assert.match(content, /禁止创建、修改、删除源码文件/);
    assert.match(content, /\{changeId\}/);
  });
});

describe("api-spec.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "api-spec.md"), "utf-8");

  it("teaches the API_ line protocol and never JSON output", () => {
    assert.match(content, /API_INTERFACE: 名称 \| 类型/);
    assert.match(content, /API_CONTRACT: 名称 \| 必填字段/);
    assert.match(content, /不要输出 JSON/);
    assert.doesNotMatch(content, /```json/);
    assert.doesNotMatch(content, /只输出一个 JSON object/);
  });

  it("documents that the API_ group is optional and derives when omitted", () => {
    assert.match(content, /API_ 行整体是可选的/);
    assert.match(content, /至少有一条 API_INTERFACE/);
  });
});
