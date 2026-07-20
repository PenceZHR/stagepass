import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const PROJECT_PAGE = path.join(process.cwd(), "app", "projects", "[id]", "page.tsx");
const GIT_WORKSPACE_PANEL = path.join(
  process.cwd(),
  "app",
  "projects",
  "[id]",
  "git-workspace-panel.tsx"
);

describe("baseline project UI", () => {
  const content = fs.readFileSync(PROJECT_PAGE, "utf-8");

  it("adds a project sidebar entry for baseline documents", () => {
    assert.match(content, /type NavSection = "changes" \| "prd" \| "context" \| "baseline" \| "git"/);
    assert.match(content, /\{ key: "baseline", label: "基线文档"/);
  });

  it("fetches and renders baseline documents", () => {
    assert.match(content, /fetch\(`\/api\/projects\/\$\{projectId\}\/baseline`\)/);
    assert.match(content, /fetch\(`\/api\/projects\/\$\{projectId\}\/baseline\/\$\{docName\}`\)/);
    assert.match(content, /activeSection === "baseline"/);
    assert.match(content, /baselineDocs\.map/);
  });

  it("guards optional context and baseline payloads before rendering", () => {
    assert.match(content, /const contextDocs = context\?\.docs \?\? \{\}/);
    assert.match(content, /const baselineDocs = baseline\?\.docs \?\? \[\]/);
    assert.match(content, /Object\.entries\(contextDocs\)\.map/);
    assert.match(content, /baselineDocs\.length/);
  });
});

describe("project changes UI", () => {
  const content = fs.readFileSync(PROJECT_PAGE, "utf-8");

  it("hides the changes status filter bar and lists all changes", () => {
    assert.doesNotMatch(content, /const CHANGE_FILTERS/);
    assert.doesNotMatch(content, /type ChangeFilter/);
    assert.doesNotMatch(content, /matchesChangeFilter/);
    assert.doesNotMatch(content, /setFilter/);
    assert.doesNotMatch(content, /const filtered =/);
    assert.match(content, /\{changes\.map\(\(c\) =>/);
    assert.doesNotMatch(content, /const statuses = \[/);
    assert.doesNotMatch(content, /statuses\.map/);
  });
});

describe("git workspace UI", () => {
  const content = fs.readFileSync(GIT_WORKSPACE_PANEL, "utf-8");

  it("normalizes optional file lists before rendering workspace status", () => {
    assert.match(content, /function normalizeWorkspaceStatus/);
    assert.match(content, /staged: Array\.isArray\(data\.staged\) \? data\.staged : \[\]/);
    assert.match(content, /unstaged: Array\.isArray\(data\.unstaged\) \? data\.unstaged : \[\]/);
  });
});
