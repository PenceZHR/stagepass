import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { join } from "node:path";

const WEB = join(process.cwd(), "src", "web");
const read = (name: string): string => readFileSync(join(WEB, name), "utf-8");

const BROWSER_MODULES = [
  "panel.js", "stage-artifact-view.js", "stage-artifact-scene.js",
  "graph-view.js", "graph-scene.js", "terminal-bridge.js",
];

describe("Browser modules parse", () => {
  // 这些文件从来没被测试套件解析过：面板直接把它们发给浏览器。语法错（重名声明、
  // 落单的括号）以前只会在真机上表现为「一整块界面停在读取中」，而套件全绿。
  //
  // 必须按 ES module 解析。`node --check` 对 .js 走的是 CommonJS 宽松模式，
  // `let x` 撞上 `function x(){}` 在那边合法，在浏览器里是 SyntaxError —— 所以
  // 先抄成 .mjs 再检查，检查的是浏览器真正用的那套规则。
  for (const name of BROWSER_MODULES) {
    it(`${name} parses under module goal`, () => {
      const probe = join(mkdtempSync(join(tmpdir(), "stagepass-parse-")), `${name}.mjs`);
      writeFileSync(probe, read(name));
      assert.doesNotThrow(() => {
        execFileSync(process.execPath, ["--check", probe], { stdio: "pipe" });
      });
    });
  }
});

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
      "stage-artifact-round", "stage-artifact-search", "stage-next",
    ]) {
      assert.match(html, new RegExp(`id=["']${id}["']`), id);
    }
    assert.match(view, /document\.createElement\(["']button["']\)/);
    assert.match(view, /aria-selected/);
    assert.match(scene, /stage-artifact-fallback/);
    assert.match(scene, /new THREE\.WebGLRenderer/);
    // 密目录默认收起，但必须能被摊开 —— 否则 21 个文件里 21 个没有名字。
    assert.match(scene, /folder\.aggregated/);
    assert.match(scene, /expanded\.(?:has|add|delete)\(/);
  });

  it("keeps the active round and file reachable without horizontal scrolling", () => {
    // 上一版把 22 个轮次塞进一条横带，当前轮停在最左端；用户的原话是「必须同时
    // 拖两条横向滚动条」。时间轴回来了，但必须是换行的 —— 所以这里钉的是
    // flex-wrap，而不是「不许有时间轴」。
    const html = read("panel.html");
    const view = read("stage-artifact-view.js");
    const css = read("stage-artifact.css");
    assert.match(html, /id=["']stage-artifact-round["'][^>]+role=["']tablist["']/);
    assert.match(html, /id=["']stage-artifact-list["'][^>]+role=["']tree["']/);
    assert.match(view, /stage-file-group/);
    assert.match(view, /scrollIntoView\(\{ block: ["']nearest["']/);
    assert.match(css, /\.stage-artifact-navigator/);
    assert.doesNotMatch(css, /#stage-artifact-list\s*\{[^}]*overflow-x/s);
    assert.match(css, /#stage-artifact-round\s*\{[^}]*flex-wrap:\s*wrap/s);
    assert.doesNotMatch(css, /#stage-artifact-round\s*\{[^}]*overflow-x/s);
  });

  it("does not re-read the file a human is reading on every poll", () => {
    // 旧实现每 5 秒 selectFile 一次：详情被打回「正在读取」，滚动位置和
    // 正文/DIFF/来源的页签选择一起丢。
    const view = read("stage-artifact-view.js");
    assert.match(view, /wanted !== detailKey/);
    assert.match(view, /listSignature/);
    const scene = read("stage-artifact-scene.js");
    assert.match(scene, /signature === builtSignature/);
  });

  it("returns from artifacts to the same Stage detail instead of losing context", () => {
    const html = read("panel.html");
    const panel = read("panel.js");
    assert.match(html, />← 阶段详情<\/button>/);
    assert.match(panel, /leave\(\{ reopenSheet: true \}\)/);
    assert.match(panel, /if \(reopenSheet && phase\) openSheet\(phase\)/);
  });

  it("collapses unavailable projections instead of repeating a full empty inspector", () => {
    const view = read("stage-artifact-view.js");
    const css = read("stage-artifact.css");
    assert.match(view, /setProjectionState\(["']unavailable["']\)/);
    assert.match(view, /renderTimelineMessage\(["']轮次不可用["']\)/);
    assert.match(css, /data-projection=["']unavailable["']/);
  });

  it("clears the previous Stage before loading a different projection", () => {
    const view = read("stage-artifact-view.js");
    assert.match(view, /renderLoadingRound\s*=/);
    assert.match(view, /function open\(input\)[\s\S]*list\.replaceChildren\(\)[\s\S]*renderLoadingRound\(\)[\s\S]*renderDetailMessage\(/);
  });

  it("gives the cockpit the full workbench and restores the previous workspace state", () => {
    const panel = read("panel.js");
    assert.match(panel, /stageWorkspaceWasCollapsed/);
    assert.match(panel, /columns\.classList\.add\("stage-focus"\)/);
    assert.match(panel, /columns\.classList\.toggle\("collapsed", stageWorkspaceWasCollapsed\)/);
  });

  it("never renders the map into a canvas larger than the box it is clipped to", () => {
    // 真机症状：canvas 的 CSS 尺寸变成容器的 devicePixelRatio 倍（retina 上 2 倍），
    // 而 .stage-artifact-canvas 是 overflow:hidden —— 只看得见左上角四分之一，星图
    // 整个落在看不见的地方，控制台一声不吭，套件全绿。
    //
    // canvas 是替换元素，`width: auto` 取的是 width 属性而不是包含块，所以
    // `inset: 0` 管不住它。尺寸只有两条合法来路：要么 three 用默认 updateStyle
    // 写内联 px，要么样式表把它钉成 100%。钉的是这个不变量，不是某一种写法。
    const scene = read("stage-artifact-scene.js");
    const css = read("stage-artifact.css");
    const disablesUpdateStyle = [...scene.matchAll(/\.setSize\(([^)]*)\)/g)]
      .some((match) => /,\s*(?:false|0|null|undefined)\s*$/.test(match[1] ?? ""));
    if (disablesUpdateStyle) {
      assert.match(
        css,
        /\.stage-artifact-canvas canvas\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/s,
        "setSize 关掉了 updateStyle，样式表就必须把 canvas 钉成容器的 100%",
      );
    }
  });

  it("renders untrusted file content only through textContent", () => {
    const view = read("stage-artifact-view.js");
    assert.match(view, /textContent/);
    assert.doesNotMatch(view, /innerHTML/);
    assert.doesNotMatch(view, /insertAdjacentHTML/);
  });
});
