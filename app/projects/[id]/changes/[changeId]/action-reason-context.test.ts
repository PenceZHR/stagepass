import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ActionReasonContextPanel } from "./action-reason-dialog";
import {
  effectiveSeverity,
  isActiveGap,
  selectPlanRiskWaiverContext,
  selectReviewFindingWaiverContext,
  selectSpecBattleDecisionContext,
  selectSpecRiskWaiverContext,
  severityRank,
  type WaivableFinding,
} from "./action-reason-context";
import type { PlanRisk } from "./plan-sandbox-types";
import type { RequirementGap } from "./spec-battle-types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dialogSource = readFileSync(resolve(__dirname, "action-reason-dialog.tsx"), "utf-8");
const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const reviewCenterSource = readFileSync(resolve(__dirname, "review-report-center.tsx"), "utf-8");

function gap(overrides: Partial<RequirementGap> & Pick<RequirementGap, "id">): RequirementGap {
  return {
    canonicalGapId: `RG-${overrides.id}`,
    title: `title-${overrides.id}`,
    category: "correctness",
    severity: "P1",
    originalSeverity: "P1",
    downgradedTo: null,
    status: "open",
    evidence: `evidence-${overrides.id}`,
    proposedSpecPatch: null,
    ...overrides,
  };
}

function planRisk(overrides: Partial<PlanRisk> & Pick<PlanRisk, "id">): PlanRisk {
  return {
    severity: "P1",
    category: "scope",
    title: `risk-title-${overrides.id}`,
    evidence: `risk-evidence-${overrides.id}`,
    requiredPlanChange: null,
    affectedStepNumbers: [],
    status: "open",
    waiverReason: null,
    ...overrides,
  };
}

function finding(overrides: Partial<WaivableFinding> & Pick<WaivableFinding, "id">): WaivableFinding {
  return {
    severity: "P1",
    category: "security",
    title: `finding-title-${overrides.id}`,
    file: null,
    line: null,
    evidence: `finding-evidence-${overrides.id}`,
    requiredFix: null,
    status: "open",
    ...overrides,
  };
}

describe("action reason context selection", () => {
  it("treats only open/downgraded/overridden gaps as still on the battlefield", () => {
    assert.equal(isActiveGap({ status: "open" }), true);
    assert.equal(isActiveGap({ status: "downgraded" }), true);
    assert.equal(isActiveGap({ status: "overridden" }), true);
    assert.equal(isActiveGap({ status: "resolved" }), false);
    assert.equal(isActiveGap({ status: "waived" }), false);
  });

  it("ranks and reports the effective severity of a downgraded gap", () => {
    assert.equal(effectiveSeverity({ severity: "P0", downgradedTo: "P1" }), "P1");
    assert.equal(effectiveSeverity({ severity: "P0", downgradedTo: null }), "P0");
    assert.ok(severityRank("P0") < severityRank("P1"));
    assert.ok(severityRank("P1") < severityRank("P2"));
    assert.ok(severityRank("P2") < severityRank(null));
  });

  it("shows every still-open gap when continuing the battle", () => {
    const context = selectSpecBattleDecisionContext([
      gap({ id: "a", severity: "P2", status: "open" }),
      gap({ id: "b", severity: "P0", status: "open" }),
      gap({ id: "c", severity: "P1", status: "downgraded", downgradedTo: "P2" }),
    ]);

    assert.ok(context);
    assert.deepEqual(context.items.map((item) => item.id), ["b", "a", "c"]);
    assert.equal(context.summary, "共 3 项");
  });

  it("excludes gaps the battle already closed", () => {
    const context = selectSpecBattleDecisionContext([
      gap({ id: "open-one", status: "open" }),
      gap({ id: "resolved-one", status: "resolved" }),
      gap({ id: "waived-one", status: "waived" }),
    ]);

    assert.ok(context);
    assert.deepEqual(context.items.map((item) => item.id), ["open-one"]);
  });

  it("orders gaps P0 before P1 before P2 and keeps input order inside a severity", () => {
    const context = selectSpecBattleDecisionContext([
      gap({ id: "p2", severity: "P2" }),
      gap({ id: "p1-first", severity: "P1" }),
      gap({ id: "p0", severity: "P0" }),
      gap({ id: "p1-second", severity: "P1" }),
    ]);

    assert.ok(context);
    assert.deepEqual(
      context.items.map((item) => item.id),
      ["p0", "p1-first", "p1-second", "p2"],
    );
  });

  it("carries the evidence a human needs to rule, not just the title", () => {
    const context = selectSpecBattleDecisionContext([
      gap({
        id: "a",
        title: "并发写入没有约束",
        evidence: "两个 worker 可以同时写同一行",
        proposedSpecPatch: "补一条唯一约束",
      }),
    ]);

    assert.ok(context);
    assert.equal(context.items[0].title, "并发写入没有约束");
    assert.equal(context.items[0].detail, "两个 worker 可以同时写同一行");
    assert.match(context.items[0].note ?? "", /补一条唯一约束/);
  });

  it("reports a downgraded gap at its effective severity and says where it came from", () => {
    const context = selectSpecBattleDecisionContext([
      gap({ id: "a", severity: "P0", originalSeverity: "P0", downgradedTo: "P1", status: "downgraded" }),
    ]);

    assert.ok(context);
    assert.equal(context.items[0].severity, "P1");
    assert.match(context.items[0].note ?? "", /已从 P0 降级为 P1/);
  });

  it("degrades to no context when nothing is still open", () => {
    assert.equal(selectSpecBattleDecisionContext([gap({ id: "a", status: "resolved" })]), null);
    assert.equal(selectSpecBattleDecisionContext([]), null);
    assert.equal(selectSpecBattleDecisionContext(null), null);
  });

  it("shows only the one P1 a Spec risk waiver actually waives", () => {
    const gaps = [
      gap({ id: "other-p1", title: "别的 P1" }),
      gap({ id: "target", title: "被豁免的 P1" }),
      gap({ id: "another-p1", title: "再一个 P1" }),
    ];

    const context = selectSpecRiskWaiverContext(gaps, "target");

    assert.ok(context);
    assert.deepEqual(context.items.map((item) => item.id), ["target"]);
    assert.equal(context.items[0].title, "被豁免的 P1");
  });

  it("degrades when the Spec waiver target is missing or unknown", () => {
    const gaps = [gap({ id: "a" })];
    assert.equal(selectSpecRiskWaiverContext(gaps, null), null);
    assert.equal(selectSpecRiskWaiverContext(gaps, ""), null);
    assert.equal(selectSpecRiskWaiverContext(gaps, "not-a-gap"), null);
    assert.equal(selectSpecRiskWaiverContext(null, "a"), null);
  });

  it("shows only the one Plan risk being waived, with its required change", () => {
    const risks = [
      planRisk({ id: "other" }),
      planRisk({
        id: "target",
        severity: "P1",
        title: "迁移不可回滚",
        evidence: "迁移脚本没有 down",
        requiredPlanChange: "补一个 down 迁移",
        affectedStepNumbers: [3, 4],
      }),
    ];

    const context = selectPlanRiskWaiverContext(risks, "target");

    assert.ok(context);
    assert.deepEqual(context.items.map((item) => item.id), ["target"]);
    assert.equal(context.items[0].severity, "P1");
    assert.equal(context.items[0].detail, "迁移脚本没有 down");
    assert.match(context.items[0].note ?? "", /必须修改: 补一个 down 迁移/);
    assert.match(context.items[0].note ?? "", /影响步骤: 3, 4/);
  });

  it("degrades when the Plan waiver target is missing or unknown", () => {
    const risks = [planRisk({ id: "a" })];
    assert.equal(selectPlanRiskWaiverContext(risks, null), null);
    assert.equal(selectPlanRiskWaiverContext(risks, "not-a-risk"), null);
    assert.equal(selectPlanRiskWaiverContext(null, "a"), null);
  });

  it("shows only the one Review finding being waived, located at file:line", () => {
    const findings = [
      finding({ id: "other", title: "别的发现" }),
      finding({
        id: "target",
        title: "未校验的重定向",
        file: "server/auth.ts",
        line: 42,
        evidence: "callback 未做白名单",
        requiredFix: "限制到已注册域名",
      }),
    ];

    const context = selectReviewFindingWaiverContext(findings, "target");

    assert.ok(context);
    assert.deepEqual(context.items.map((item) => item.id), ["target"]);
    assert.match(context.items[0].reference ?? "", /server\/auth\.ts:42/);
    assert.equal(context.items[0].detail, "callback 未做白名单");
    assert.match(context.items[0].note ?? "", /必须修复: 限制到已注册域名/);
  });

  it("falls back to the category when a Review finding has no file", () => {
    const context = selectReviewFindingWaiverContext(
      [finding({ id: "a", category: "security", file: null, line: null })],
      "a",
    );

    assert.ok(context);
    assert.match(context.items[0].reference ?? "", /security/);
  });

  it("degrades when the Review waiver target is missing or unknown", () => {
    const findings = [finding({ id: "a" })];
    assert.equal(selectReviewFindingWaiverContext(findings, null), null);
    assert.equal(selectReviewFindingWaiverContext(findings, "not-a-finding"), null);
    assert.equal(selectReviewFindingWaiverContext(null, "a"), null);
  });
});

describe("action reason context panel", () => {
  it("renders severity, title and evidence so the reason is not written blind", () => {
    const context = selectSpecBattleDecisionContext([
      gap({
        id: "a",
        severity: "P0",
        canonicalGapId: "RG-007",
        title: "缺少幂等键",
        evidence: "重试会重复扣款",
      }),
    ]);

    const html = renderToStaticMarkup(createElement(ActionReasonContextPanel, { context }));

    assert.match(html, /本轮未关闭的 Requirement Gap/);
    assert.match(html, /P0/);
    assert.match(html, /RG-007/);
    assert.match(html, /缺少幂等键/);
    assert.match(html, /重试会重复扣款/);
  });

  it("scrolls a long list inside the dialog instead of the page", () => {
    const context = selectSpecBattleDecisionContext(
      Array.from({ length: 20 }, (_unused, index) => gap({ id: `gap-${index}` })),
    );

    const html = renderToStaticMarkup(createElement(ActionReasonContextPanel, { context }));

    assert.match(html, /max-h-56/);
    assert.match(html, /overflow-y-auto/);
    assert.match(html, /overscroll-contain/);
    assert.match(html, /evidence-gap-19/);
  });

  it("renders nothing at all when the call site has no findings to show", () => {
    assert.equal(renderToStaticMarkup(createElement(ActionReasonContextPanel, { context: null })), "");
    assert.equal(
      renderToStaticMarkup(createElement(ActionReasonContextPanel, { context: undefined })),
      "",
    );
    assert.equal(
      renderToStaticMarkup(
        createElement(ActionReasonContextPanel, { context: { heading: "空", items: [] } }),
      ),
      "",
    );
  });
});

describe("action reason dialog wiring", () => {
  it("takes findings through one generic prop instead of domain-specific markup", () => {
    assert.match(dialogSource, /context\?: ActionReasonContext \| null;/);
    assert.match(dialogSource, /<ActionReasonContextPanel context=\{context\} \/>/);
    // The shared dialog must stay domain-neutral: no gap/risk/finding vocabulary.
    assert.doesNotMatch(dialogSource, /RequirementGap|PlanRisk|ReviewFindingView/);
  });

  it("keeps the panel above the textarea so both are readable at once", () => {
    const panelIndex = dialogSource.indexOf("<ActionReasonContextPanel");
    const textareaIndex = dialogSource.indexOf("<textarea");
    assert.notEqual(panelIndex, -1, "dialog should render the context panel");
    assert.notEqual(textareaIndex, -1, "dialog should render the textarea");
    assert.ok(panelIndex < textareaIndex, "context should sit above the textarea, not behind a tab");
  });

  it("gives every page-level reason dialog the findings it rules on", () => {
    assert.match(pageSource, /const reasonDialogContext = useMemo\(/);
    assert.match(pageSource, /selectSpecBattleDecisionContext\(gaps\)/);
    assert.match(pageSource, /selectSpecRiskWaiverContext\(gaps, reasonDialog\.targetId\)/);
    assert.match(
      pageSource,
      /selectPlanRiskWaiverContext\(planSandboxState\?\.risks, reasonDialog\.riskId\)/,
    );
    assert.match(pageSource, /context=\{reasonDialogContext\}/);
  });

  it("gives the Review P1 waiver dialog the finding it waives", () => {
    assert.match(reviewCenterSource, /selectReviewFindingWaiverContext\(state\?\.findings, p1Target\)/);
    assert.match(reviewCenterSource, /context=\{waiverContext\}/);
  });

  it("keeps the battlefield and the dialog on one definition of an open gap", () => {
    const battlefieldSource = readFileSync(resolve(__dirname, "spec-battlefield.tsx"), "utf-8");

    assert.match(
      battlefieldSource,
      /import \{ effectiveSeverity, isActiveGap, severityTone \} from "\.\/action-reason-context";/,
    );
    assert.doesNotMatch(battlefieldSource, /function activeGap/);
    assert.doesNotMatch(battlefieldSource, /function effectiveSeverity/);
  });
});
