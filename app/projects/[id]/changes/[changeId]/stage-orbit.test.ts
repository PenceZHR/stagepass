import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const orbitSource = readFileSync(resolve(directory, "stage-orbit.tsx"), "utf8");
const shellSource = readFileSync(resolve(directory, "pipeline-page-shell.tsx"), "utf8");
const pageSource = readFileSync(resolve(directory, "page.tsx"), "utf8");
const stageWorkspaceSource = readFileSync(
  resolve(directory, "stage-codex-workspace.tsx"),
  "utf8",
);
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
    // Read-only follows authorization, not stage order. Order is derived from
    // change.status, which only advances once a stage runs, so an ordinal veto
    // made every later stage permanently unstartable. Running out of turn is
    // refused by the enqueue authority (not_at_gate), which is the real rule.
    assert.match(pageSource, /readOnly=\{!startControlAction\}/);
    assert.match(pageSource, /isFuture=\{selectedIsFuture\}/);
    assert.doesNotMatch(pageSource, /\{selectedIsFuture \? \(/);
    assert.doesNotMatch(pageSource, /data-stage-decision-area/);
  });

  it("uses the same read-only Codex boundary for current and future stages", () => {
    assert.equal((pageSource.match(/<PhaseStageShell/g) ?? []).length, 1);
    assert.equal((pageSource.match(/<StageCodexWorkspace/g) ?? []).length, 1);
    assert.match(stageWorkspaceSource, /data-stage-codex-workspace/);
    assert.match(
      stageWorkspaceSource,
      /当前尚未进入该阶段，因此这里只显示规则和只读记录/,
    );
    assert.match(pageSource, /<PhaseReviewPanel[\s\S]*?readOnly/);
    assert.doesNotMatch(pageSource, /<GatePanel|data-future-stage-overview/);
  });

  it("removes the destructive Change action only from future previews", () => {
    assert.match(
      shellSource,
      /<PipelinePageHeader[\s\S]*?readOnly=\{selectedIsFuture\}/,
    );
    assert.match(
      shellSource,
      /\{!readOnly && !isRunning && \([\s\S]*?aria-label=\{`删除 \$\{change\.id\}`\}/,
    );
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

  it("keeps every stage detail header compact so the stage action stays near the fold", () => {
    const detailHeader = shellSource.slice(
      shellSource.indexOf("function PipelinePageHeader"),
    );

    assert.match(detailHeader, /data-stage-detail-header/);
    assert.match(detailHeader, /truncate/);
    assert.doesNotMatch(detailHeader, /<h1/);
    assert.doesNotMatch(detailHeader, /selectedStage\.description/);
    assert.doesNotMatch(detailHeader, />\s*Change Board\s*</);
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
