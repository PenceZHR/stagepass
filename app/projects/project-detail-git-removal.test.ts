import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectPageSource = readFileSync(resolve(appRoot, "projects/[id]/page.tsx"), "utf-8");

describe("project Git surface removal", () => {
  it("removes the four Git API routes", () => {
    for (const route of [
      "api/projects/[id]/git/route.ts",
      "api/projects/[id]/git/workspace/route.ts",
      "api/projects/[id]/git/suggest-message/route.ts",
      "api/projects/[id]/changes/[changeId]/git/route.ts",
    ]) {
      assert.equal(existsSync(resolve(appRoot, route)), false, route);
    }
  });

  it("removes Git panels, navigation, and badges from project details", () => {
    assert.doesNotMatch(projectPageSource, /git-(?:setup|workspace)-panel/);
    assert.doesNotMatch(projectPageSource, /"git"\s*\|\s*|key:\s*"git"/);
    assert.doesNotMatch(projectPageSource, /gitEnabled|gitDefaultBranch/);
    assert.doesNotMatch(projectPageSource, /<Git(?:Setup|Workspace)Panel/);
  });
});
