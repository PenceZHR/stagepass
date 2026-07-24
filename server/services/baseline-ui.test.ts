import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectPage = fs.readFileSync(
  path.join(process.cwd(), "app", "projects", "[id]", "page.tsx"),
  "utf8",
);

describe("project document surfaces", () => {
  it("keeps baseline documents in the project sidebar", () => {
    assert.match(projectPage, /type NavSection = "changes" \| "prd" \| "context" \| "baseline"/);
    assert.match(projectPage, /\{ key: "baseline", label: "基线文档"/);
    assert.match(projectPage, /activeSection === "baseline"/);
  });

  it("loads baseline and context data defensively", () => {
    assert.match(projectPage, /\/baseline/);
    assert.match(projectPage, /const contextDocs = context\?\.docs \?\? \{\}/);
    assert.match(projectPage, /const baselineDocs = baseline\?\.docs \?\? \[\]/);
  });

  it("does not restore the removed project Git workspace", () => {
    assert.doesNotMatch(projectPage, /git-workspace-panel|GitWorkspacePanel|GitSetupPanel/);
    assert.doesNotMatch(projectPage, /key:\s*"git"/);
  });
});
