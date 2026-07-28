import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const changePage = fs.readFileSync(
  path.join(root, "app", "projects", "[id]", "changes", "[changeId]", "page.tsx"),
  "utf8",
);
const projectPage = fs.readFileSync(
  path.join(root, "app", "projects", "[id]", "page.tsx"),
  "utf8",
);
const prdViewer = fs.readFileSync(
  path.join(root, "app", "projects", "[id]", "prd-editor.tsx"),
  "utf8",
);
const detailDataHook = fs.readFileSync(
  path.join(
    root,
    "app",
    "projects",
    "[id]",
    "changes",
    "[changeId]",
    "use-change-detail-data.ts",
  ),
  "utf8",
);

describe("Codex-native Web boundary", () => {
  it("mounts one Codex bridge and one shared read-only stage surface", () => {
    assert.match(changePage, /<CodexTaskControl/);
    assert.match(changePage, /<StageCodexWorkspace/);
    assert.match(changePage, /<PhaseStageShell/);
    assert.equal((changePage.match(/<PhaseStageShell/g) ?? []).length, 1);
    assert.match(changePage, /stageId=\{selectedStage\.id\}/);
    assert.match(changePage, /readOnly/);
  });

  it("does not mount phase-specific Web workspaces or decision fallbacks", () => {
    assert.doesNotMatch(
      changePage,
      /<EmergencyInteractionPanel|<PrdBriefingRoom|<GatePanel|<PlanSandbox|<TestPlanSandbox|<BuildSandbox|<ReviewReportCenter|<OperationalPhasePanel/,
    );
    assert.doesNotMatch(
      changePage,
      /ActionReasonDialog|RefineChatPanel|StageGitPanel|FailedRunBanner/,
    );
    assert.doesNotMatch(changePage, /\sactions=\{|\sactionError=\{|\sblockers=\{/);
  });

  it("does not import Web workspaces that duplicate Codex", () => {
    assert.doesNotMatch(
      changePage,
      /from "\.\/(emergency-interaction-panel|prd-briefing-room|gate-panel|plan-sandbox|testplan-sandbox|build-sandbox|review-report-center|operational-phase-panel|failed-run-banner)"/,
    );
    assert.doesNotMatch(projectPage, /GitSetupPanel|GitWorkspacePanel/);
  });

  it("does not preload removed Web workspaces or emergency decisions", () => {
    assert.doesNotMatch(
      detailDataHook,
      /getPlanSandbox|getTestPlanSandbox|getPrdBriefing|getInteraction/,
    );
    assert.doesNotMatch(
      detailDataHook,
      /PlanSandboxState|TestPlanSandboxState|PrdBriefingState|EmergencyInteraction/,
    );
  });

  it("keeps the Project PRD surface read-only", () => {
    assert.match(prdViewer, /data-prd-document-viewer/);
    assert.match(prdViewer, /交互与确认请在绑定的 Codex task 中完成/);
    assert.doesNotMatch(prdViewer, /fetch\(|textarea|onSubmit/);
  });
});
