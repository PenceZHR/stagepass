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
  "graph-view.js", "graph-scene.js",
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
    /*
     * 「进阶段页是纯查看」这条判据还在，守法变了：原来靠「只 refresh、不
     * openOrFocus」来证；2026-08-18 网页端退休时 `terminal-bridge.js` 整个删了
     * （插件里没有本机终端座位），所以改成守**一个都不许有**。
     */
    assert.doesNotMatch(panel, /terminalBridge/);
    assert.match(view, /window\.stagepassArtifacts\s*=\s*\{/);
    assert.doesNotMatch(view, /method:\s*["']POST["']/);
  });

  it("keeps every artifact keyboard reachable even when WebGL falls back", () => {
    const html = read("panel.html");
    const view = read("stage-artifact-view.js");
    const scene = read("stage-artifact-scene.js");
    for (const id of [
      "stage-artifact-canvas", "stage-artifact-list", "stage-artifact-detail",
      "stage-artifact-round", "stage-artifact-search", "next-step",
      // 星图现在藏在一个按钮后面（用户 2026-08-17），那个按钮就成了到达它的
      // 唯一入口 —— 它不在，键盘用户根本没有路可以走到画布上。
      "stage-graph-toggle",
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

  it("says everything about one Stage on one page instead of three layers", () => {
    /*
     * 用户 2026-08-17 的原话：「现在每个 stage 点开圆圈有一个界面，进去又有了
     * 一个界面，是不对的，交互太乱了，统一成一个页面。」
     *
     * 拆掉的是中间那层 `<dialog id="sheet">`。这条钉的是**层数**：环上点一下
     * 直接到阶段页，弹层带来的那几块就画在同一页上。
     */
    const html = read("panel.html");
    const panel = read("panel.js");
    // 阶段弹层整个不在了。新建 Project / Change 那两个 <dialog> 不算 —— 它们
    // 打断你去填一件事，填完就走，是真弹窗。
    assert.doesNotMatch(html, /<dialog[^>]*\sid=["']sheet["']/);
    assert.doesNotMatch(html, /id=["']tab-rubric["']/);
    assert.doesNotMatch(panel, /openSheet\(/);
    assert.doesNotMatch(panel, /reopenSheet/);
    assert.match(panel, /addEventListener\("click", \(\) => \{ void enter\(entry\.phase\); \}\)/);
    assert.match(html, />← 阶段环<\/button>/);

    // 弹层那几块现在长在阶段页里 —— 不是搬进了另一个容器又藏起来。
    const page = html.slice(
      html.indexOf('id="stage-view"'), html.indexOf('id="graph-view"'));
    for (const id of [
      "stage-line", "next-step", "last-outcome", "open-question",
      "stage-gaps", "stage-rubric", "run", "ask", "waive", "brief",
    ]) {
      assert.match(page, new RegExp(`id=["']${id}["']`), id);
    }
  });

  it("keeps exactly two surfaces behind a click, and switches by data-mode", () => {
    /*
     * 用户 2026-08-17 第二句：「星图可以内部再点击一个按钮跳转出来切换，其余
     * 语义要明确。」只有关系图和标准允许藏在一次点击后面 —— 第三个开关就是
     * 又开始往回长层。
     *
     * 切态用 `data-mode` 而不是 `[hidden]`：display:grid|flex 会盖掉 UA 给
     * `[hidden]` 的 display:none，这个仓库为它流过两次血。
     */
    const html = read("panel.html");
    const panel = read("panel.js");
    const css = read("stage-artifact.css");
    assert.match(html, /id=["']stage-graph-toggle["']/);
    assert.match(html, /id=["']stage-rubric-toggle["']/);
    assert.match(panel, /function setStageMode\(mode\)/);
    assert.match(panel, /stageSecondary\.dataset\.mode = mode/);
    assert.doesNotMatch(panel, /stageRubric\.hidden/);
    assert.doesNotMatch(panel, /stageGaps\.hidden/);
    for (const mode of ["files", "graph", "rubric"]) {
      assert.match(
        css,
        new RegExp(`\\.stage-secondary\\[data-mode="${mode}"\\] \\.stage-pane-${mode}`),
        mode,
      );
    }
  });

  it("sizes the two resident halves by leftover space, never by viewport fraction", () => {
    /*
     * 2026-08-17 真机，两条都是当天撞出来的：
     *
     * 1. 动作带原来写 `max-height: 52vh`。945px 高的窗口上它是 491px、内容 459px，
     *    看着正好；换到 720px 的真窗口，52vh = 374px 把下半屏压到只剩 81px ——
     *    三个标题挤在一起，一行内容都读不到。**「常驻」不是「DOM 里有」。**
     *    视口比例根本不是判据：这一带该占多少取决于顶带用掉多少、下半屏至少
     *    要留多少。
     *
     * 2. 闸门那一排曾经 `position: sticky` 钉在带底、带不透明背景。命中测试当场
     *    打脸：那条横杠压在题的尾巴上，七个单选和提交按钮一个都点不到。
     *    **在会滚的内容上面浮一块不透明的东西，就是在制造点不到的控件。**
     */
    const css = read("stage-artifact.css");
    const act = css.slice(css.indexOf(".stage-act {"));
    const actRule = act.slice(0, act.indexOf("}"));
    assert.doesNotMatch(actRule, /max-height/, "动作带不许封顶 —— 它有多高由题决定");
    assert.doesNotMatch(actRule, /overflow/, "动作带不许自己滚 —— 整页只有一个滚动容器");
    assert.match(actRule, /flex:\s*0 0 auto/);

    // 整页那个滚动容器。没有它，动作带一长就把下半屏挤没。
    const view = css.slice(css.indexOf("#stage-view {"));
    assert.match(view.slice(0, view.indexOf("}")), /overflow-y:\s*auto/);

    const gates = css.slice(css.indexOf(".stage-gates {"));
    const gatesRule = gates.slice(0, gates.indexOf("}"));
    assert.doesNotMatch(gatesRule, /position:\s*(sticky|fixed|absolute)/,
      "闸门那一排不许浮在会滚的内容上面");

    const body = css.slice(css.indexOf(".stage-cockpit-body {"));
    assert.match(body.slice(0, body.indexOf("}")), /min-height:\s*\d+px/,
      "下半屏要有 px 保底，否则会被动作带压没");

    // 按钮排在题**前面** —— 排在后面就又要靠浮起来才看得见。
    const html = read("panel.html");
    assert.ok(
      html.indexOf('id="stage-gates-row"') < html.indexOf('id="open-question"'),
      "闸门按钮要排在答题表单前面",
    );
  });

  it("builds the star map only while it is on screen", () => {
    // 星图默认不在屏幕上了。一进阶段就 installScene 等于开一个 WebGL 场景在
    // 看不见的地方转 —— 白烧电，而且 setSize 量的是一个还没有尺寸的盒子。
    const view = read("stage-artifact-view.js");
    const openBody = view.slice(view.indexOf("function open(input)"));
    assert.doesNotMatch(openBody.slice(0, openBody.indexOf("\n}")), /installScene/);
    assert.match(view, /function setMode\(next\)[\s\S]*?installScene\(\)/);
    assert.match(view, /window\.stagepassArtifacts\s*=\s*\{[^}]*setMode/);
  });

  it("never leaves another Stage's gate actions standing on the aside page", () => {
    /*
     * 旁路不在任何一条轨道上（DESIGN §3.3）：没有闸门、没有问题、没有可裁决的
     * 东西。这些按钮平时的可见性由 `entry.current` 决定，而旁路根本没有 entry ——
     * 不显式清一遍，上一个阶段那排按钮就原样挂在旁路页上，按下去发的是**别的
     * 阶段**的动作。答题表单尤其：一道 Build 的裁决不许出现在旁路上。
     */
    const panel = read("panel.js");
    assert.match(panel, /function clearStageActions\(\)/);
    assert.match(panel, /if \(!entry\) \{ clearStageActions\(\); return; \}/);
    assert.match(panel, /clearStageActions\(\)[\s\S]*?drawOpenQuestion\(null\)/);
    // 题号仍然写在表单自己身上，不是闭包变量：判据得是「人现在看着的是哪一道」。
    assert.match(panel, /openQuestionForm\.dataset\.question = question\.id/);
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
