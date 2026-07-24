import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const orbitSource = readFileSync(resolve(directory, "stage-orbit.tsx"), "utf8");
const shellSource = readFileSync(resolve(directory, "pipeline-page-shell.tsx"), "utf8");
const pageSource = readFileSync(resolve(directory, "page.tsx"), "utf8");
const globalsSource = readFileSync(resolve(directory, "../../../../globals.css"), "utf8");

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
});
