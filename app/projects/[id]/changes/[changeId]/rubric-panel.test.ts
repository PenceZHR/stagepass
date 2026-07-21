import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PhaseStageShell } from "./phase-stage-shell";
import {
  RubricEditor,
  RubricPanel,
  rubricScopeLabel,
  verdictTone,
  verdictToneClass,
} from "./rubric-panel";
import { reviewPhaseToRubricPhase, REVIEW_PHASES } from "./change-phase-map";
import type {
  RubricPanelState,
  RubricRolePanel,
  RubricVerdict,
} from "./rubric-types";

/**
 * Real renders, not source greps: every assertion below goes through
 * renderToStaticMarkup on the component that actually ships, the way
 * phase-review.test.ts does. A panel that reads correctly in source and renders
 * a criterion as invisible would pass a grep and fail a user.
 */

function rolePanel(overrides: Partial<RubricRolePanel> = {}): RubricRolePanel {
  return {
    role: "producer",
    applicable: true,
    rubricId: "RUB-1",
    version: 2,
    source: "project",
    hasChangeOverride: false,
    criteria: [
      { criterionKey: "RBK-alpha", text: "Every requirement has an acceptance criterion", blocking: true, tier: 3 },
      { criterionKey: "RBK-beta", text: "Wording is consistent", blocking: false, tier: 3 },
    ],
    verdicts: [],
    judgedVersion: null,
    judgedByOutdatedVersion: false,
    blocked: false,
    answeredBy: "spec",
    ...overrides,
  };
}

function panelState(overrides: Partial<RubricPanelState> = {}): RubricPanelState {
  return {
    phase: "Spec",
    projectId: "PRJ-1",
    changeId: "CHG-1",
    roundId: "BR-1",
    blockingChannel: "requirement_gap",
    tier1Deterministic: [],
    roles: [
      rolePanel(),
      rolePanel({ role: "critic", rubricId: "RUB-2" }),
      rolePanel({ role: "verdict", rubricId: "RUB-3" }),
    ],
    ...overrides,
  };
}

function render(state: RubricPanelState) {
  return renderToStaticMarkup(
    createElement(RubricPanel, {
      projectId: "PRJ-1",
      changeId: "CHG-1",
      phase: state.phase,
      initialState: state,
    }),
  );
}

function verdict(
  value: RubricVerdict,
  overrides: Partial<RubricRolePanel["verdicts"][number]> = {},
) {
  return {
    criterionKey: `RBK-${value}`,
    text: `criterion for ${value}`,
    blocking: true,
    verdict: value,
    evidence: `evidence for ${value}`,
    stillCurrent: true,
    ...overrides,
  };
}

describe("rubric drawer: verdict display", () => {
  it("renders the three verdicts with the glyphs §7.4 specifies", () => {
    const markup = render(
      panelState({
        roles: [
          rolePanel({
            verdicts: [verdict("yes"), verdict("no"), verdict("not_assessed")],
            blocked: true,
          }),
        ],
      }),
    );

    assert.match(markup, /✓ 是/);
    assert.match(markup, /✗ 否/);
    assert.match(markup, /— 未评估/);
    assert.match(markup, /evidence for no/, "evidence has to be on screen, not just stored");
  });

  it("gives not_assessed exactly the same visual weight as no (§7.5)", () => {
    // The single most dangerous thing this panel could do is render a blocking
    // state as an absence. `not_assessed` means the model was asked and did not
    // answer; §4.3 blocks on it regardless of the criterion's blocking flag,
    // because silence is otherwise a free way to skip the questions a model
    // expects to fail. A quiet grey dash would hide that.
    assert.equal(verdictTone("not_assessed"), verdictTone("no"));
    assert.equal(verdictToneClass("not_assessed"), verdictToneClass("no"));
    assert.notEqual(verdictToneClass("not_assessed"), verdictToneClass("yes"));

    const markup = render(
      panelState({
        roles: [rolePanel({ verdicts: [verdict("yes"), verdict("no"), verdict("not_assessed")] })],
      }),
    );

    const classOf = (value: RubricVerdict): string => {
      const match = new RegExp(
        `<li[^>]*class="([^"]*)"[^>]*data-rubric-verdict="${value}"`,
      ).exec(markup);
      assert.ok(match, `no rendered <li> for ${value}`);
      return match![1]!;
    };
    assert.equal(
      classOf("not_assessed"),
      classOf("no"),
      "not_assessed must be styled identically to no -- it blocks identically",
    );
    assert.notEqual(classOf("not_assessed"), classOf("yes"));

    assert.match(markup, /data-rubric-verdict="not_assessed"[^>]*data-rubric-tone="block"/);
    assert.match(markup, /data-rubric-verdict="no"[^>]*data-rubric-tone="block"/);
    assert.match(markup, /data-rubric-verdict="yes"[^>]*data-rubric-tone="pass"/);
    assert.equal(
      (markup.match(/data-rubric-blocks-gate/g) ?? []).length,
      2,
      "both blocking verdicts carry the 阻断 tag; the passing one does not",
    );
  });

  it("labels a verdict that came from an older rubric version (§7.6)", () => {
    const stale = render(
      panelState({
        roles: [
          rolePanel({
            version: 3,
            judgedVersion: 1,
            judgedByOutdatedVersion: true,
            verdicts: [verdict("no")],
          }),
        ],
      }),
    );
    assert.match(stale, /data-rubric-stale-verdicts/);
    assert.match(stale, /判定来自旧版本 rubric v1/);
    assert.match(stale, /当前已是 v3/);

    const fresh = render(
      panelState({ roles: [rolePanel({ judgedVersion: 2, verdicts: [verdict("no")] })] }),
    );
    assert.doesNotMatch(
      fresh,
      /data-rubric-stale-verdicts/,
      "a current verdict must not be labelled stale, or the label stops meaning anything",
    );
  });

  it("says so when a judged criterion is no longer in the rubric", () => {
    const markup = render(
      panelState({
        roles: [rolePanel({ verdicts: [verdict("no", { stillCurrent: false })] })],
      }),
    );
    assert.match(markup, /data-rubric-criterion-dropped/);
    assert.match(markup, /该标准已从当前 rubric 移除/);
  });

  it("distinguishes 'not judged yet' from 'judged and passed'", () => {
    assert.match(render(panelState({ roles: [rolePanel()] })), /data-rubric-verdicts="none"/);
    assert.match(
      render(panelState({ roles: [rolePanel({ verdicts: [verdict("yes")] })] })),
      /data-rubric-verdicts="present"/,
    );
  });
});

describe("rubric drawer: tabs", () => {
  it("shows all three role tabs when the phase has a critic", () => {
    const markup = render(panelState());
    assert.match(markup, /data-rubric-role-tab="producer"/);
    assert.match(markup, /data-rubric-role-tab="critic"/);
    assert.match(markup, /data-rubric-role-tab="verdict"/);
    assert.match(markup, /正方/);
    assert.match(markup, /反方/);
    assert.match(markup, /裁决/);
  });

  it("hides the middle tab on a phase with no critic (§7.1)", () => {
    const markup = render(
      panelState({
        phase: "Plan",
        roles: [
          rolePanel(),
          rolePanel({ role: "critic", applicable: false }),
          rolePanel({ role: "verdict" }),
        ],
      }),
    );
    assert.match(markup, /data-rubric-role-tab="producer"/);
    assert.doesNotMatch(markup, /data-rubric-role-tab="critic"/);
    assert.match(markup, /data-rubric-role-tab="verdict"/);
    assert.doesNotMatch(markup, /反方/);
  });

  it("flags on the tab itself that another role is blocked", () => {
    const markup = render(
      panelState({
        roles: [
          rolePanel(),
          rolePanel({ role: "critic", blocked: true, verdicts: [verdict("not_assessed")] }),
          rolePanel({ role: "verdict" }),
        ],
      }),
    );
    // Without this a blocking not_assessed on an unselected tab is invisible.
    assert.match(markup, /有阻断判定/);
  });
});

describe("rubric drawer: which scope is in force (§7.7)", () => {
  it("names the scope currently in force", () => {
    assert.match(render(panelState()), /当前生效：项目默认 v2/);
    assert.match(
      render(panelState({ roles: [rolePanel({ source: "change", hasChangeOverride: true, version: 1 })] })),
      /当前生效：本 Change 覆盖 v1/,
    );
    assert.match(
      render(panelState({ roles: [rolePanel({ source: null, version: null })] })),
      /当前生效：尚未设置/,
    );
  });

  it("exposes the scope as data, not only as prose", () => {
    assert.match(render(panelState()), /data-rubric-scope-source="project"/);
    assert.match(
      render(panelState({ roles: [rolePanel({ source: "change" })] })),
      /data-rubric-scope-source="change"/,
    );
  });

  it("maps every scope to a label", () => {
    assert.equal(rubricScopeLabel("project"), "项目默认");
    assert.equal(rubricScopeLabel("change"), "本 Change 覆盖");
    assert.equal(rubricScopeLabel(null), "尚未设置");
  });
});

describe("rubric drawer: the editor is reachable (§7.2, §7.3)", () => {
  it("renders the edit entry point unconditionally, outside any disclosure", () => {
    const markup = render(panelState());
    assert.match(markup, /data-rubric-edit-open/);
    assert.match(markup, /编辑评判标准/);
    assert.doesNotMatch(
      markup,
      /<details/,
      "the rubric editor must not be behind a <details> -- §7.3, after two rounds of shipping "
      + "backend capability with no way to reach it",
    );
  });

  it("lists the criteria and their blocking flags without a click", () => {
    const markup = render(panelState());
    assert.match(markup, /Every requirement has an acceptance criterion/);
    assert.match(markup, /data-rubric-blocking="true"/);
    assert.match(markup, /data-rubric-blocking="false"/);
    assert.match(markup, /标准清单（2）/);
  });

  it("says an empty rubric is legal rather than looking broken", () => {
    const markup = render(panelState({ roles: [rolePanel({ criteria: [] })] }));
    assert.match(markup, /data-rubric-criteria="empty"/);
    assert.match(markup, /空 rubric 是合法的/);
    assert.match(markup, /data-rubric-edit-open/, "an empty rubric still offers the editor");
  });
});

describe("the drawer is on every phase panel (§7.1)", () => {
  it("renders inside the stage frame, above the workspace and the collapsed records", () => {
    const markup = renderToStaticMarkup(
      createElement(
        PhaseStageShell,
        {
          projectId: "PRJ-1",
          changeId: "CHG-1",
          phase: "Spec",
          statusLabel: "SPECCING",
          latestRunStatus: "running",
          records: createElement("p", null, "records"),
        },
        createElement("p", null, "workspace"),
      ),
    );

    const rubricAt = markup.indexOf('aria-label="Spec 评判标准"');
    const workspaceAt = markup.indexOf('aria-label="Spec workspace"');
    const detailsAt = markup.indexOf("<details");
    assert.notEqual(rubricAt, -1, "every phase panel gets the rubric section");
    assert.notEqual(workspaceAt, -1, "this fixture does render the workspace");
    assert.notEqual(detailsAt, -1, "this fixture does render the collapsed records");
    assert.ok(
      rubricAt < detailsAt,
      "the rubric section must sit before the collapsed 原始记录 disclosure, not inside it",
    );
    assert.ok(
      rubricAt < workspaceAt,
      "the rubric section must sit ABOVE the workspace: measured in a browser, the Plan "
      + "stage's task map pushes anything after it ~3900px down, which is the same "
      + "below-the-fold burial §7.3 forbids",
    );
  });

  it("maps every pipeline phase in the UI to a rubric phase", () => {
    // A phase with no mapping renders no drawer at all, which is the "backend
    // can, UI cannot" failure §7.3 exists to prevent. The Review stage maps to
    // Build on purpose: §3 makes Review Build's critic, not a phase of its own.
    for (const phase of REVIEW_PHASES) {
      assert.notEqual(
        reviewPhaseToRubricPhase(phase),
        null,
        `${phase} has no rubric phase, so its panel would silently have no rubric editor`,
      );
    }
    assert.equal(reviewPhaseToRubricPhase("Review"), "Build");
    assert.equal(reviewPhaseToRubricPhase("Implement"), "Build");
    assert.equal(reviewPhaseToRubricPhase("Intake"), "PRD");
    assert.equal(reviewPhaseToRubricPhase("Check"), "QA");
  });

  it("names the rubric phase it is editing, so Review cannot be mistaken for its own", () => {
    const markup = render(panelState({ phase: "Build" }));
    assert.match(markup, /评判标准 · Build/);
    assert.match(markup, /data-rubric-phase="Build"/);
  });
});

function tieredCriteria() {
  return [
    {
      criterionKey: "RBK-factory-Spec-producer-03",
      text: "我没有在 delta 里引入 PRD 从未提过的新需求。",
      blocking: true,
      tier: 1 as const,
    },
    {
      criterionKey: "RBK-factory-Spec-producer-01",
      text: "我列出的每一条 PRD delta 都指明了它改的是 PRD 的哪一节。",
      blocking: false,
      tier: 2 as const,
    },
    { criterionKey: "RBK-user-1", text: "User-added standard", blocking: true, tier: 3 as const },
  ];
}

describe("rubric drawer: tiers in the read view (design §2.1)", () => {
  it("badges each criterion with its tier, tier-1 as 恒阻断", () => {
    const markup = render(
      panelState({ roles: [rolePanel({ criteria: tieredCriteria() })] }),
    );
    assert.match(markup, /data-rubric-tier="1"/);
    assert.match(markup, /一级 · 恒阻断/);
    assert.match(markup, /data-rubric-tier="2"/);
    assert.match(markup, /出厂/);
    assert.match(markup, /data-rubric-tier="3"/);
    assert.match(markup, /自加/);
  });
});

describe("rubric drawer: the deterministic tier-1 checks (design §2.1)", () => {
  const items = [
    {
      id: "stage-write-scope",
      title: "本阶段只允许写这些文件",
      detail: "落在 .ship/changes/**/prd-delta.md 之外的改动一律阻断",
      enforcedBy: "stage-guard-service · validatePlannedChanges（pipeline-spec-stage-service）",
    },
  ];

  it("renders them read-only, naming the real execution point", () => {
    const markup = render(panelState({ tier1Deterministic: items }));
    assert.match(markup, /data-rubric-tier1-deterministic/);
    assert.match(markup, /data-rubric-deterministic-id="stage-write-scope"/);
    assert.match(markup, /由代码强制执行，此处仅呈现/);
    assert.match(markup, /本阶段只允许写这些文件/);
    assert.match(
      markup,
      /执行点：stage-guard-service · validatePlannedChanges/,
      "enforcedBy has to be on screen: a guard with no named execution point reads as prose",
    );
    // Read-only means read-only: the section ships no toggle of any kind. The
    // whole view-mode render has none either (the editor is closed), so the
    // stronger assertion costs nothing and catches a toggle leaking anywhere.
    assert.doesNotMatch(markup, /data-rubric-blocking-toggle/);
  });

  it("renders nothing for a phase with no deterministic guards", () => {
    assert.doesNotMatch(
      render(panelState({ tier1Deterministic: [] })),
      /data-rubric-tier1-deterministic/,
      "an empty section would imply Merge has guards it does not have",
    );
  });
});

describe("rubric editor: tier-1 rows are locked, tier-2/3 rows are not", () => {
  const editorProps = {
    draftScope: "project" as const,
    saving: false,
    error: "",
    hasChangeOverride: false,
    onChangeText: () => undefined,
    onToggleBlocking: () => undefined,
    onRemove: () => undefined,
    onMove: () => undefined,
    onAdd: () => undefined,
    onScopeChange: () => undefined,
    onCancel: () => undefined,
    onSave: () => undefined,
  };
  const draftFromCriteria = () =>
    tieredCriteria().map((criterion) => ({
      criterionKey: criterion.criterionKey,
      text: criterion.text,
      blocking: criterion.blocking,
      tier: criterion.tier,
    }));
  const renderEditor = (draft = draftFromCriteria()) =>
    renderToStaticMarkup(createElement(RubricEditor, { ...editorProps, draft }));
  const rowOf = (markup: string, marker: string): string => {
    const rows = markup.split("<li").filter((chunk) => chunk.includes(marker));
    assert.equal(rows.length, 1, `expected exactly one row containing ${marker}`);
    return rows[0]!;
  };

  it("renders the tier-1 row read-only: no delete, no move, blocking locked on", () => {
    const markup = renderEditor();
    const row = rowOf(markup, 'data-rubric-tier1-locked');
    assert.match(row, /readonly/i, "the tier-1 text input is read-only");
    assert.match(row, /data-rubric-tier1-blocking-lock/);
    assert.match(row, /恒阻断/);
    assert.match(row, /一级条款恒阻断，不可撤下/);
    assert.doesNotMatch(row, /data-rubric-remove/, "no delete button on a tier-1 row");
    assert.doesNotMatch(row, /data-rubric-blocking-toggle/, "no blocking toggle on a tier-1 row");
    assert.doesNotMatch(row, /data-rubric-move-up/, "no reordering on a tier-1 row");
    assert.match(markup, /data-rubric-tier1-edit-note/);
  });

  it("keeps tier-2 rows fully editable -- the lock must not creep downward", () => {
    // THE over-locking canary: lock tier-2 rows too and this goes red.
    const markup = renderEditor();
    const row = rowOf(markup, 'data-rubric-criterion-key="RBK-factory-Spec-producer-01"');
    assert.doesNotMatch(row, /readonly/i, "tier-2 text stays editable");
    assert.match(row, /data-rubric-blocking-toggle/, "tier-2 blocking stays the user's choice");
    assert.match(row, /data-rubric-remove/, "tier-2 stays deletable -- 删除即撤下 is the one exit");
    assert.match(row, /出厂/, "tier-2 is visibly factory-authored");
  });

  it("keeps tier-3 rows fully editable and visibly user-authored", () => {
    const markup = renderEditor();
    const row = rowOf(markup, 'data-rubric-criterion-key="RBK-user-1"');
    assert.doesNotMatch(row, /readonly/i);
    assert.match(row, /data-rubric-blocking-toggle/);
    assert.match(row, /data-rubric-remove/);
    assert.match(row, /自加/, "tier-3 is visibly user-authored, distinct from 出厂");
  });

  it("disables moving an editable row up into the pinned tier-1 prefix", () => {
    const markup = renderEditor();
    const row = rowOf(markup, 'data-rubric-criterion-key="RBK-factory-Spec-producer-01"');
    const moveUp = /data-rubric-move-up[^>]*/.exec(row) ?? /disabled[^>]*data-rubric-move-up/.exec(row);
    assert.ok(moveUp, "the tier-2 row renders a move-up button");
    assert.match(
      row.slice(0, row.indexOf("data-rubric-move-up") + 40),
      /disabled/,
      "row 1 sits directly under the tier-1 prefix, so moving up is a no-op the server would undo",
    );
  });

  it("shows no tier-1 note on a scope without tier-1 rows", () => {
    const markup = renderEditor(
      [{ criterionKey: "RBK-user-1", text: "Only mine", blocking: true, tier: 3 as const }],
    );
    assert.doesNotMatch(markup, /data-rubric-tier1-edit-note/);
    assert.doesNotMatch(markup, /data-rubric-tier1-locked/);
  });
});

describe("rubric drawer: Done's blocking story is told in both halves", () => {
  it("says tier-2/3 verdicts only record, while tier-1 is enforced by the delivery gate", () => {
    const markup = render(
      panelState({
        phase: "Done",
        blockingChannel: "none",
        roles: [rolePanel({ answeredBy: "delivery" })],
      }),
    );
    assert.match(markup, /data-rubric-inert-notice/);
    assert.match(markup, /二级\/三级条款的判定仅记录、不拦截/);
    assert.match(markup, /一级条款另由交付完成门在 delivery 阶段强制/);
  });

  it("keeps the generic wording on other channel-less phases", () => {
    const markup = render(
      panelState({
        phase: "Retro",
        blockingChannel: "none",
        roles: [rolePanel({ answeredBy: "retro" })],
      }),
    );
    assert.match(markup, /data-rubric-inert-notice/);
    assert.match(markup, /勾选「阻断」不会拦住任何东西/);
    assert.doesNotMatch(
      markup,
      /交付完成门/,
      "the delivery-gate sentence is Done's fact, not a blanket claim",
    );
  });
});
