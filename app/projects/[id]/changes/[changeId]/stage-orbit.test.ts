import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const orbitSource = readFileSync(resolve(directory, "stage-orbit.tsx"), "utf8");
const shellSource = readFileSync(resolve(directory, "pipeline-page-shell.tsx"), "utf8");
const pageSource = readFileSync(resolve(directory, "page.tsx"), "utf8");
const globalsSource = readFileSync(resolve(directory, "../../../../globals.css"), "utf8");
const navigationHookPath = resolve(directory, "use-workspace-navigation.ts");
const navigationColumnsPath = resolve(directory, "workspace-navigation-columns.tsx");
const navigationHookSource = existsSync(navigationHookPath)
  ? readFileSync(navigationHookPath, "utf8")
  : "";
const navigationColumnsSource = existsSync(navigationColumnsPath)
  ? readFileSync(navigationColumnsPath, "utf8")
  : "";

describe("Abstract Cloud & Sea stage orbit", () => {
  it("uses the eleven review stages and leaves Done outside the orbit", () => {
    assert.match(orbitSource, /UI_STAGE_ORDER\.filter\([\s\S]*stageId !== "done"/);
    assert.match(orbitSource, /ORBIT_STAGE_IDS[\s\S]*\.map\(/);
    assert.match(orbitSource, /aria-current=\{position === "active" \? "step" : undefined\}/);
    assert.match(orbitSource, /data-stage-position=\{position\}/);
  });

  it("opens every stage through a transition-locked button", () => {
    assert.match(orbitSource, /<button/);
    assert.match(orbitSource, /onClick=\{\(\) => onSelectStage\(stage\)\}/);
    assert.match(orbitSource, /disabled=\{transitioning\}/);
    assert.match(shellSource, /const \[transitionTargetId, setTransitionTargetId\] = useState/);
    assert.match(shellSource, /if \(!stage\.reviewPhase \|\| transitionTargetId\) return/);
    assert.match(shellSource, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(shellSource, /reduceMotion \? 20 : 680/);
  });

  it("returns to the orbit and keeps future stages read-only", () => {
    assert.match(shellSource, /data-return-to-stage-orbit/);
    assert.match(shellSource, /data-future-preview=\{selectedIsFuture \? "true" : "false"\}/);
    assert.match(shellSource, /未来阶段只读预览/);
    assert.match(pageSource, /readOnly=\{selectedIsFuture\}/);
    assert.match(pageSource, /\{!selectedIsFuture \? \(/);
    assert.match(globalsSource, /\[data-future-preview="true"\] \[data-stage-decision-area\]/);
  });

  it("uses the generated cloud-sea asset and reduced-motion fallback", () => {
    assert.match(globalsSource, /url\("\/assets\/stagepass\/abstract-cloud-sea\.png"\)/);
    assert.match(globalsSource, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(globalsSource, /\.stage-orbit-node > button:hover/);
    assert.match(globalsSource, /\.stage-orbit-node > button:focus-visible/);
  });

  it("loads the Project and Change navigation levels from canonical APIs", () => {
    assert.match(navigationHookSource, /fetch\("\/api\/projects"\)/);
    assert.match(navigationHookSource, /fetch\(`\/api\/projects\/\$\{projectId\}\/changes`\)/);
    assert.match(navigationHookSource, /updatedAt/);
    assert.match(navigationHookSource, /projectId/);
    assert.match(navigationHookSource, /changeId/);
  });

  it("composes independent Project, Change, and Orbit columns at 2:2:6", () => {
    assert.match(shellSource, /data-stagepass-workspace/);
    assert.match(shellSource, /grid-cols-\[minmax\(0,2fr\)_minmax\(0,2fr\)_minmax\(0,6fr\)\]/);
    assert.match(navigationColumnsSource, /data-workspace-projects/);
    assert.match(navigationColumnsSource, /data-workspace-changes/);
    assert.match(shellSource, /data-workspace-orbit/);
    assert.match(navigationColumnsSource, /aria-current=\{active \? "page" : undefined\}/);
  });

  it("anchors every node to the same trigonometric circle", () => {
    assert.match(orbitSource, /const ORBIT_RADIUS_PERCENT = 42\.5/);
    assert.match(orbitSource, /const radians = \(\(index \* 360\) \/ orbitStages\.length - 90\) \* \(Math\.PI \/ 180\)/);
    assert.match(orbitSource, /const x = 50 \+ Math\.cos\(radians\) \* ORBIT_RADIUS_PERCENT/);
    assert.match(orbitSource, /const y = 50 \+ Math\.sin\(radians\) \* ORBIT_RADIUS_PERCENT/);
    assert.match(orbitSource, /left: `\$\{x\}%`/);
    assert.match(orbitSource, /top: `\$\{y\}%`/);
    assert.doesNotMatch(orbitSource, /--stage-angle/);
  });

  it("keeps long Change titles from displacing the orbit", () => {
    assert.match(orbitSource, /line-clamp-2/);
    assert.match(orbitSource, /max-w-\[min\(90%,52rem\)\]/);
  });

  it("layers richer orbit motion without making it interactive", () => {
    assert.match(orbitSource, /stage-orbit-aurora/);
    assert.match(orbitSource, /stage-orbit-inner-track/);
    assert.match(orbitSource, /--stage-delay/);
    assert.match(globalsSource, /@keyframes stagepass-orbit-counter-sweep/);
    assert.match(globalsSource, /@keyframes stagepass-orbit-aurora/);
    assert.match(globalsSource, /@keyframes stagepass-node-relay/);
    assert.match(globalsSource, /prefers-reduced-motion:[\s\S]*stage-orbit-aurora/);
  });
});
