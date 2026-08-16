import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";

const WEB = join(process.cwd(), "src", "web");
const read = (name: string): string => readFileSync(join(WEB, name), "utf-8");

describe("Stage artifact cockpit browser contract", () => {
  it("mounts through one panel handshake and entering a Stage stays read-only", () => {
    const panel = read("panel.js");
    const view = read("stage-artifact-view.js");
    assert.match(panel, /window\.stagepassArtifacts\?\.open\(/);
    assert.match(panel, /await terminalBridge\.refresh\(\)/);
    assert.doesNotMatch(panel, /await terminalBridge\.openOrFocus\(\)/);
    assert.match(view, /window\.stagepassArtifacts\s*=\s*\{/);
    assert.doesNotMatch(view, /method:\s*["']POST["']/);
  });

  it("keeps every artifact keyboard reachable even when WebGL falls back", () => {
    const html = read("panel.html");
    const view = read("stage-artifact-view.js");
    const scene = read("stage-artifact-scene.js");
    for (const id of [
      "stage-artifact-canvas", "stage-artifact-list", "stage-artifact-detail",
      "stage-artifact-timeline", "stage-artifact-search", "stage-next",
    ]) {
      assert.match(html, new RegExp(`id=["']${id}["']`), id);
    }
    assert.match(view, /document\.createElement\(["']button["']\)/);
    assert.match(view, /aria-selected/);
    assert.match(scene, /stage-artifact-fallback/);
    assert.match(scene, /new THREE\.WebGLRenderer/);
    assert.match(scene, /aggregatedFolders/);
  });

  it("gives the cockpit the full workbench and restores the previous workspace state", () => {
    const panel = read("panel.js");
    assert.match(panel, /stageWorkspaceWasCollapsed/);
    assert.match(panel, /columns\.classList\.add\("stage-focus"\)/);
    assert.match(panel, /columns\.classList\.toggle\("collapsed", stageWorkspaceWasCollapsed\)/);
  });

  it("renders untrusted file content only through textContent", () => {
    const view = read("stage-artifact-view.js");
    assert.match(view, /textContent/);
    assert.doesNotMatch(view, /innerHTML/);
    assert.doesNotMatch(view, /insertAdjacentHTML/);
  });
});
