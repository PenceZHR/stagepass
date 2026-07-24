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

describe("Codex-native Web boundary", () => {
  it("mounts task control, emergency disclosure and evidence stages", () => {
    assert.match(changePage, /<CodexTaskControl/);
    assert.match(changePage, /<EmergencyInteractionPanel/);
    assert.match(changePage, /<PhaseStageShell/);
  });

  it("does not import deleted Web decision or Git components", () => {
    assert.doesNotMatch(changePage, /ActionReasonDialog|RefineChatPanel|StageGitPanel/);
    assert.doesNotMatch(projectPage, /GitSetupPanel|GitWorkspacePanel/);
  });

  it("keeps the Project PRD surface read-only", () => {
    assert.match(prdViewer, /data-prd-document-viewer/);
    assert.match(prdViewer, /交互与确认请在绑定的 Codex task 中完成/);
    assert.doesNotMatch(prdViewer, /fetch\(|textarea|onSubmit/);
  });
});
