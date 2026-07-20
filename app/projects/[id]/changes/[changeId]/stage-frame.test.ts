import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getOrderedStageActions,
  type StageActionView,
} from "./stage-action-bar";
import { StageFrame } from "./stage-frame";
import { STAGE_STATUS_BADGE_COPY } from "./stage-status-badge";
import { PhaseStageShell, phaseDisplayName } from "./phase-stage-shell";
import type { UiStageState } from "./pipeline-ui-model";

const __dirname = dirname(fileURLToPath(import.meta.url));
const actionBarSource = readFileSync(resolve(__dirname, "stage-action-bar.tsx"), "utf-8");
const statusBadgeSource = readFileSync(resolve(__dirname, "stage-status-badge.tsx"), "utf-8");
const stageFrameSource = readFileSync(resolve(__dirname, "stage-frame.tsx"), "utf-8");
const phaseStageShellSource = readFileSync(resolve(__dirname, "phase-stage-shell.tsx"), "utf-8");

function action(
  id: string,
  role: StageActionView["role"],
  enabled = true,
  disabledReason: string | null = enabled ? null : "Blocked by gate",
): StageActionView {
  return {
    id,
    label: id,
    role,
    enabled,
    disabledReason,
    onAction: () => undefined,
  };
}

describe("shared stage frame primitives", () => {
  it("supports every canonical UI stage state in the status badge", () => {
    const states: UiStageState[] = [
      "not_started",
      "waiting",
      "running",
      "needs_review",
      "blocked",
      "failed",
      "stale",
      "complete",
    ];

    assert.deepEqual(Object.keys(STAGE_STATUS_BADGE_COPY).sort(), [...states].sort());
    for (const state of states) {
      assert.equal(typeof STAGE_STATUS_BADGE_COPY[state].label, "string", state);
    }
    assert.match(statusBadgeSource, /data-stage-state=\{state\}/);
    assert.match(statusBadgeSource, /aria-label/);
  });

  it("normalizes action ordering and demotes extra primary actions", () => {
    const ordered = getOrderedStageActions([
      action("secondary-first", "secondary"),
      action("primary-first", "primary"),
      action("destroy", "destructive"),
      action("primary-second", "primary"),
    ]);

    assert.deepEqual(
      ordered.map((item) => [item.action.id, item.renderRole]),
      [
        ["primary-first", "primary"],
        ["secondary-first", "secondary"],
        ["primary-second", "secondary"],
        ["destroy", "destructive"],
      ],
    );
    assert.equal(ordered.filter((item) => item.renderRole === "primary").length, 1);
  });

  it("renders standardized action affordances and disabled reasons", () => {
    assert.match(actionBarSource, /export interface StageActionView/);
    assert.match(actionBarSource, /import \{ Button \} from "@\/components\/ui\/button";/);
    assert.match(actionBarSource, /disabledReason/);
    assert.match(actionBarSource, /disabledReasons/);
    assert.match(actionBarSource, /处理中\.\.\./);
    assert.match(actionBarSource, /role="group"/);
    assert.match(actionBarSource, /aria-live="polite"/);
    assert.match(actionBarSource, /role="alert"/);
    assert.match(actionBarSource, /data-render-role=\{item\.renderRole\}/);
  });

  it("uses the shared status badge and action bar from StageFrame", () => {
    assert.match(stageFrameSource, /import \{ StageActionBar/);
    assert.match(stageFrameSource, /import \{ StageStatusBadge \}/);
    assert.match(stageFrameSource, /<StageStatusBadge/);
    assert.match(stageFrameSource, /<StageActionBar/);
    assert.match(stageFrameSource, /children/);
    assert.match(stageFrameSource, /evidence/);
    assert.match(stageFrameSource, /aria-label=\{evidenceLabel/);
  });

  it("renders accessible frame structure without a nested main landmark", () => {
    const html = renderToStaticMarkup(
      createElement(
        StageFrame,
        {
          title: "实施计划",
          label: "Plan",
          state: "blocked",
          description: "整理改动范围、步骤和验证命令。",
          blockers: [
            {
              id: "blocker-1",
              label: "缺少验证命令",
              description: "需要补充 lint 和 typecheck。",
              severity: "error",
            },
          ],
          actions: [
            action("run", "primary"),
            action("locked", "secondary", false, "等待 Plan 门禁通过"),
          ],
        },
        createElement("div", null, "Workspace content"),
      ),
    );

    assert.doesNotMatch(html, /<main[\s>]/);
    assert.match(html, /role="region"/);
    assert.match(html, /aria-label="Plan workspace"/);
    assert.match(html, /data-stage-state="blocked"/);
    assert.match(html, /role="group"/);
    assert.match(html, /等待 Plan 门禁通过/);
    assert.match(html, /data-blocker-severity="error"/);
  });

  it("keeps PhaseStageShell compatible while delegating to StageFrame", () => {
    assert.match(phaseStageShellSource, /import \{ StageFrame/);
    assert.match(phaseStageShellSource, /export function phaseDisplayName/);
    assert.match(phaseStageShellSource, /export function phaseRecordsLabel/);
    assert.match(phaseStageShellSource, /export function PhaseStageShell/);
    assert.match(phaseStageShellSource, /<StageFrame/);
    assert.match(phaseStageShellSource, /Pipeline Stage/);
    assert.match(phaseStageShellSource, /data-phase-stage=\{phase\}/);
    assert.match(phaseStageShellSource, /Latest Run:/);
    assert.match(phaseStageShellSource, /phaseRecordsLabel\(phase\)/);
    assert.match(phaseStageShellSource, /Intake: \{[\s\S]*label: "PRD"/);
    assert.match(phaseStageShellSource, /Check: \{[\s\S]*label: "QA"/);
  });

  it("renders Intake through the shared frame as PRD with selected-stage status", () => {
    const html = renderToStaticMarkup(
      createElement(
        PhaseStageShell,
        {
          phase: "Intake",
          state: "needs_review",
          statusLabel: "INTAKE_READY",
          latestRunStatus: "completed",
          records: createElement("div", { id: "prd-records" }, "PRD phase records"),
        },
        createElement("div", null, "PRD workspace"),
      ),
    );

    assert.equal(phaseDisplayName("Intake"), "PRD");
    assert.match(html, /data-phase-stage="Intake"/);
    assert.match(html, /data-stage-frame="true"/);
    assert.match(html, /aria-label="PRD 阶段概览"/);
    assert.match(html, />PRD<\/span>/);
    assert.match(html, />PRD Briefing<\/h2>/);
    assert.match(html, /data-stage-state="needs_review"/);
    assert.match(html, /PRD workspace/);
    assert.match(html, /PRD 原始记录/);
    assert.match(html, /PRD phase records/);
    assert.doesNotMatch(html, />Intake<\/span>/);
    assert.doesNotMatch(html, /aria-label="Intake 阶段概览"/);
  });
});
