# 回跳火箭 + 删中心圆盘 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 环上「回跳」的红线和红 V 动画换成小火箭轨道转移（起飞→转移→入轨），历史回跳换成凝结尾迹，并删掉环中心的圆盘。

**Architecture:** 只动前端两个文件。panel.js 的 `drawMap` 里 backward 分支改画复合路径（起点 RIM 轨道弧 + 向心贝塞尔 + 目标 RIM 轨道弧）并让描边小火箭骑 `animateMotion`；历史弦改成端点缩进 RIM 的圆点虚线。中心圆盘整块删除，`drawCenter` 瘦身成 `drawProgress`（进度弧保留）。

**Tech Stack:** 原生 SVG + SMIL（`animateMotion`/`mpath`/`animate`），无新依赖。

## Global Constraints

- 只动 `src/web/panel.js` 和 `src/web/panel.html`；服务端、panel-view.ts、数据流零改动。
- 几何常量复用：RIM 轨道就是自环用的 `RIM = 7.5`，弯度沿用 `bend = 0.45`；不另立新数。
- `prefers-reduced-motion: reduce` 下所有新动画必须真不动（SMIL 不受 CSS 那条 media query 管，要在 JS 里问，和 `flyingArrow` 现有处理同一套）。
- 向前的边、自环的 V 字动画完全不动。
- tooltip（历史：第几轮/理由；选项：`edge.why`）原样保留。
- 无 DOM/SMIL 单测装置：回归靠 `pnpm check`（panel.js 过 tsconfig.panel.json 类型检查 + architecture 护栏），视觉靠真面板目检（Task 4）。
- 测试库安全：目检用真库 `~/.stagepass/panel.db` 只读浏览，动之前说、动完就报（用户 2026-08-03 定的规矩）。

---

### Task 1: 删中心圆盘

**Files:**
- Modify: `src/web/panel.html`（约 574–595 行 `.center` 规则块与 `centerFloat`、约 955 行 reduced-motion 选择器、约 1014–1019 行 `<div class="center">` 块）
- Modify: `src/web/panel.js`（62–65 行四个 `pick`、1148 行调用、1330–1361 行 `drawCenter`）

**Interfaces:**
- Consumes: 现有 `pick()`、`phases`。
- Produces: `drawProgress()`（无参无返回），替代 `drawCenter()`；后续任务不依赖本任务。

- [ ] **Step 1: 删 HTML 与 CSS**

panel.html 里删掉三处：

1. `<div class="center">…</div>` 整块（`center-kicker` / `center-title` / `center-line` / `center-count` 都在里面）。
2. `/* 中心信息锚点 */` 起的 `.center`、`.center small`、`.center h3`、`.center p`、`.center b`、`.center b em` 规则和 `@keyframes centerFloat`。
3. reduced-motion 那条选择器里去掉 `.center, `：

```css
  body::before, .halo::before, .live-flag i,
  .stage-node.live button, .portal { animation: none !important; }
```

- [ ] **Step 2: panel.js 里瘦身 drawCenter**

删 62–65 行：

```js
const centerKicker = pick("center-kicker");
const centerTitle = pick("center-title");
const centerLine = pick("center-line");
const centerCount = pick("center-count");
```

`drawCenter` 整个函数（含头注释）换成：

```js
/**
 * 进度圆弧走到当前阶段，不是走到「批准了几个」。
 *
 * 问的是「走到哪了」，而那是 Change 的位置 —— 一个阶段可以正在跑、还没批准，
 * 弧线该已经到它那儿。用批准数会让弧线永远落后一格，看着像卡住了。
 *
 * 原来这里还画环心的圆盘（阶段名 / Gate 状态 / approved 计数）——2026-08-09
 * 用户删掉了它：左侧面板和节点本身都有这些，纯重复，还压着环内的弦。
 */
function drawProgress() {
  const at = phases.find((entry) => entry.current);
  const reached = at === undefined ? 0 : phases.indexOf(at) / phases.length;
  pick("progress").style.setProperty("--progress", String(reached));
}
```

1148 行的调用 `drawCenter();` 改成 `drawProgress();`。

- [ ] **Step 3: 查漏 + 回归**

```bash
grep -rn "center-kicker\|center-title\|center-line\|center-count\|centerFloat\|drawCenter\|\.center\b" src/web/panel.js src/web/panel.html
```

Expected: 零命中（`align-items: center` 之类的 CSS 值不算，grep 词形上不会撞）。

```bash
pnpm check
```

Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add src/web/panel.html src/web/panel.js
git commit -m "feat: 删掉环心圆盘 —— 信息全是重复的，还压着环内的弦"
```

---

### Task 2: 历史红线 → 凝结尾迹

**Files:**
- Modify: `src/web/panel.js`（`chordPath` 约 742–753 行、`drawMap` 的 journey 循环约 860–870 行）
- Modify: `src/web/panel.html`（`.orbit-map .chord` / `.chord.hot` 约 388–392 行）

**Interfaces:**
- Consumes: `nodeAt`、`svgNode`、`RIM`。
- Produces: `chordApex(from, to) -> {x, y}`、`rimEdgePoint(centre, towards) -> {x, y}`（Task 3 的 `rocketFlight` 要用 `chordApex`）。

- [ ] **Step 1: chordPath 拆成 chordApex（chordPath 先留薄壳）**

backward 选项分支这时还引用着 `chordPath`（Task 3 才换掉它），所以本步**不删** `chordPath`，只把它拆薄。`chordPath` 函数（含头注释）换成：

```js
/**
 * 回头那条曲线的「顶点」：控制点拉向圆心 —— 直线也能连上，但一堆直线会和轨道
 * 缠在一起；往圆心弯一下，回边就天然落在环的内部，和沿环走的推进泾渭分明
 * （§5.9.3④）。烟迹（历史）和火箭的转移段（选项）共用这一个弯 —— 火箭飞的
 * 就是烟迹说的那条路，两样东西才对得上。
 */
function chordApex(from, to) {
  const bend = 0.45;   // 0 = 直线，1 = 顶到圆心
  return {
    x: from.x + (50 - from.x) * bend + (to.x - from.x) / 2 * (1 - bend),
    y: from.y + (50 - from.y) * bend + (to.y - from.y) / 2 * (1 - bend),
  };
}

/** 从节点圆心朝 towards 方向缩到 RIM 轨道上的点 —— 尾迹不压着节点画。 */
function rimEdgePoint(centre, towards) {
  const len = Math.hypot(towards.x - centre.x, towards.y - centre.y) || 1;
  return {
    x: centre.x + (towards.x - centre.x) / len * RIM,
    y: centre.y + (towards.y - centre.y) / len * RIM,
  };
}
```

并紧随其后保留薄壳：

```js
/** 只剩 backward 选项分支在用；Task 3 换掉那个调用方后，连这层薄壳一起删。 */
function chordPath(from, to) {
  const apex = chordApex(from, to);
  return `M ${from.x} ${from.y} Q ${apex.x} ${apex.y} ${to.x} ${to.y}`;
}
```

- [ ] **Step 2: journey 循环改画 vapor**

`drawMap` 里 ① 那段循环体换成：

```js
  for (const jump of panel.journey ?? []) {
    if (jump.kind !== "backward") continue;
    const from = indexOf(jump.fromPhase);
    const to = indexOf(jump.toPhase);
    if (from < 0 || to < 0) continue;
    /*
     * 走过的回头路 = 火箭飞过残留的**凝结尾迹**：圆点虚线，端点缩到两个 RIM
     * 轨道上。上一版是红实线弦，用户 2026-08-09 判丑 —— 病历要留着，但它是
     * 烟，不是伤口。
     */
    const a = nodeAt(from, total);
    const b = nodeAt(to, total);
    const apex = chordApex(a, b);
    const start = rimEdgePoint(a, apex);
    const end = rimEdgePoint(b, apex);
    map.append(svgNode("path", {
      class: `vapor${jump.action === "sendBack" ? " hot" : ""}`,
      d: `M ${start.x} ${start.y} Q ${apex.x} ${apex.y} ${end.x} ${end.y}`,
    }, `第 ${jump.round} 轮：${jump.fromPhase} → ${jump.toPhase}`
      + (jump.reason ? `\n理由：${jump.reason}` : "")));
  }
```

- [ ] **Step 3: CSS 换 vapor**

panel.html 里 `.orbit-map .chord` 和 `.chord.hot` 两条规则（连同上方那段「实线/虚线」注释里过时的措辞先不动，措辞在 Task 3 一并改）换成：

```css
.orbit-map .vapor {
  fill: none; stroke: rgba(226,200,164,.32); stroke-width: .5;
  stroke-linecap: round; stroke-dasharray: .05 1.15; pointer-events: stroke;
}
/* sendBack 比其它回跳略暖略亮一档 —— 语义分层保留，只是不再报警。 */
.orbit-map .vapor.hot { stroke: rgba(255,178,150,.42); }
```

- [ ] **Step 4: 查漏 + 回归**

```bash
grep -n "chordPath\|class: \`chord\|\"chord" src/web/panel.js src/web/panel.html
```

Expected: `chordPath` 只剩薄壳定义 + backward 选项分支那一处调用（905–910 行附近，Task 3 处理）；`chord` 类名零命中。

```bash
pnpm check
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/web/panel.js src/web/panel.html
git commit -m "feat: 历史回跳改成凝结尾迹 —— 病历留着，但它是烟不是伤口"
```

---

### Task 3: 回跳选项 = 小火箭轨道转移

**Files:**
- Modify: `src/web/panel.js`（`flyingArrow` 的 reduced-motion 判断、`orbitAround` 之后新增四个函数、`drawMap` 的 options 循环 backward 分支、删 `chordPath` 薄壳）
- Modify: `src/web/panel.html`（删 `.live.back` / `.arrow.back` / `.arrow.back.trail`，新增 `.flight` / `.rocket`，更新注释措辞）

**Interfaces:**
- Consumes: `chordApex`（Task 2）、`RIM`、`nodeAt`、`svgNode`。
- Produces: `reducedMotion() -> boolean`、`rocketFlight(from, to) -> {d, p1, p2}`、`rocketGlyph(className) -> SVGGElement`、`rocketRide(rocket, pathId, flight, seconds) -> SVGGElement`。

- [ ] **Step 1: 抽 reducedMotion 帮手**

在 `flyingArrow` 上方加：

```js
/** SMIL 不受 CSS 的 `animation: none` 管，所以每个造动画的函数都要自己问它。 */
const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
```

`flyingArrow` 里的 `if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {` 改成 `if (reducedMotion()) {`（那条「说了不要动效就真的不动」注释保留）。

- [ ] **Step 2: 新增飞行路径与火箭**

`orbitAround` 之后加（`orbitAround` 本体不动）：

```js
/*
 * ── 回跳 = 轨道转移（用户 2026-08-09 定的画法，第三版重做）───────
 *
 * 小火箭贴着起点的 RIM 轨道滑行蓄力（60°），切线脱离、走向环心弯的转移曲线
 * （「穿心 = 回头」的旧语义还在），再切进目标的 RIM 轨道滑小半圈（120°），
 * 熄火淡出，从头再来。上一版的淡红发丝 + 三个红 V 被用户判丑：回跳是这一屏
 * 最有戏的事件，配得上一次完整的起飞—入轨。
 *
 * 切线是免费的：二次贝塞尔在起点的切向指向控制点、在终点的切向来自控制点，
 * 所以把脱离点选在「轨道切线正对 apex」的地方（atan2），起飞就顺滑；入轨同理。
 * rimPoint 的参数角和 nodeAt 同一套：0 = 正上方，顺时针增，速度方向恰好是
 * (cos a, sin a) —— 弧、贝塞尔、再入弧连成一笔，rotate="auto" 全程不跳。
 */
const LAUNCH_ARC = Math.PI / 3;       // 起飞段贴轨道滑行 60°
const INSERT_ARC = (Math.PI * 2) / 3; // 入轨段滑行 120°

/** centre 的 RIM 轨道上参数角 a 处的点。 */
function rimPoint(centre, a) {
  return { x: centre.x + RIM * Math.sin(a), y: centre.y - RIM * Math.cos(a) };
}

function rocketFlight(from, to) {
  const apex = chordApex(from, to);
  const aD = Math.atan2(apex.y - from.y, apex.x - from.x);  // 脱离角
  const aA = Math.atan2(to.y - apex.y, to.x - apex.x);      // 入轨角
  const launch = rimPoint(from, aD - LAUNCH_ARC);
  const depart = rimPoint(from, aD);
  const arrive = rimPoint(to, aA);
  const parked = rimPoint(to, aA + INSERT_ARC);
  const d = `M ${launch.x} ${launch.y} `
    + `A ${RIM} ${RIM} 0 0 1 ${depart.x} ${depart.y} `
    + `Q ${apex.x} ${apex.y} ${arrive.x} ${arrive.y} `
    + `A ${RIM} ${RIM} 0 0 1 ${parked.x} ${parked.y}`;
  /*
   * keyPoints 按**路程占比**分段，速度感才对：转移段的长度用「弦长和经停
   * apex 的折线长取平均」近似 —— 对二次贝塞尔这个近似误差 <2%，够用。
   */
  const hop = Math.hypot(arrive.x - depart.x, arrive.y - depart.y);
  const viaApex = Math.hypot(apex.x - depart.x, apex.y - depart.y)
    + Math.hypot(arrive.x - apex.x, arrive.y - apex.y);
  const legs = [RIM * LAUNCH_ARC, (hop + viaApex) / 2, RIM * INSERT_ARC];
  const total = legs[0] + legs[1] + legs[2];
  return { d, p1: legs[0] / total, p2: (legs[0] + legs[1]) / total };
}

/**
 * 描边小火箭，头朝 +x、原点在箭身中心 —— rotate="auto" 才能让它顺着路径扭。
 * 和 V 字同一种笔触：细描边、圆头、无填充。喷焰单独一条 path，只有它在闪。
 */
function rocketGlyph(className) {
  const rocket = svgNode("g", { class: className });
  rocket.append(
    svgNode("path", {
      class: "hull",
      d: "M 1.35 0 C 0.95 -0.5 0.1 -0.52 -0.7 -0.3 L -0.7 0.3 C 0.1 0.52 0.95 0.5 1.35 0 Z",
    }),
    svgNode("path", {
      class: "hull",
      d: "M -0.45 -0.38 L -0.95 -0.78 M -0.45 0.38 L -0.95 0.78",
    }),
  );
  const flame = svgNode("path", {
    class: "flame",
    d: "M -0.85 -0.16 L -1.7 0 L -0.85 0.16",
  });
  if (!reducedMotion()) {
    const flicker = document.createElementNS("http://www.w3.org/2000/svg", "animate");
    flicker.setAttribute("attributeName", "opacity");
    flicker.setAttribute("values", "1;.3;1");
    flicker.setAttribute("dur", "0.55s");
    flicker.setAttribute("repeatCount", "indefinite");
    flame.append(flicker);
  }
  rocket.append(flame);
  return rocket;
}

/** 让火箭骑上飞行路径：起飞慢 → 转移快 → 入轨减速 → 熄火停一拍再从头来。 */
function rocketRide(rocket, pathId, flight, seconds) {
  const motion = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion");
  motion.setAttribute("rotate", "auto");
  motion.setAttribute("calcMode", "linear");
  const mpath = document.createElementNS("http://www.w3.org/2000/svg", "mpath");
  mpath.setAttribute("href", `#${pathId}`);
  mpath.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${pathId}`);
  motion.append(mpath);
  if (reducedMotion()) {
    // 停在起飞点，朝向仍由 rotate="auto" 给出 —— 和 flyingArrow 同一套处理。
    motion.setAttribute("dur", "1s");
    motion.setAttribute("repeatCount", "1");
    motion.setAttribute("fill", "freeze");
    motion.setAttribute("keyPoints", "0;0");
    motion.setAttribute("keyTimes", "0;1");
    rocket.append(motion);
    return rocket;
  }
  motion.setAttribute("dur", `${seconds}s`);
  motion.setAttribute("repeatCount", "indefinite");
  /*
   * 节奏就是「火箭感」的一大半：起飞段占 30% 时间只走 p1 的路（慢），转移段
   * 前半 12% 时间冲一半路（最快），后半开始收，入轨段用 24% 时间滑完最后一段
   * （减速），.82 之后抱着终点不动 —— 那一拍里透明度已经是 0，瞬移回起点
   * 不穿帮。
   */
  const mid = (flight.p1 + flight.p2) / 2;
  motion.setAttribute("keyPoints", `0;${flight.p1};${mid};${flight.p2};1;1`);
  motion.setAttribute("keyTimes", "0;.3;.42;.58;.82;1");
  rocket.append(motion);
  const fade = document.createElementNS("http://www.w3.org/2000/svg", "animate");
  fade.setAttribute("attributeName", "opacity");
  fade.setAttribute("values", "0;1;1;0;0");
  fade.setAttribute("keyTimes", "0;.06;.74;.82;1");
  fade.setAttribute("dur", `${seconds}s`);
  fade.setAttribute("repeatCount", "indefinite");
  rocket.append(fade);
  return rocket;
}
```

- [ ] **Step 3: drawMap 的 backward 分支换火箭**

options 循环里，自环分支之后的那段（`const to = indexOf(edge.to);` 起到循环体结束）换成：

```js
    const to = indexOf(edge.to);
    if (to < 0) return;
    const id = `map-live-${order}`;
    if (edge.kind === "backward") {
      /*
       * **回跳 = 小火箭轨道转移**。路线本身退成极淡发丝（只承接 hover 的
       * tooltip），方向、事件感全交给火箭 —— 形状带语义这条没丢：转移段
       * 还是那条向心弯的弦，沿环走的推进照旧是弧。
       */
      const flight = rocketFlight(from, nodeAt(to, total));
      map.append(svgNode("path", { id, class: "flight", d: flight.d }, edge.why));
      map.append(rocketRide(rocketGlyph("rocket"), id, flight, 6.5));
      return;
    }
    map.append(svgNode("path", {
      id,
      class: "live",
      d: arcAlongRing(from, nodeAt(to, total)),
    }, edge.why));
    /*
     * **一串 V 飞向目标 stage**（用户 2026-08-05 定的画法，第二版重做）。
     * 路线是极淡的发丝（只说「走哪条道」），三个 V 错开出发 —— 「往那边流」
     * 由队形说出来。
     */
    const trip = 2.8;
    map.append(flyingArrow(id, trip, "arrow"));
    for (const behind of [0.34, 0.68]) {
      map.append(flyingArrow(id, trip, "arrow trail", behind));
    }
```

然后删掉 `chordPath` 薄壳（Task 2 Step 4 留下的），以及它上面那句薄壳注释。

- [ ] **Step 4: CSS 收尾**

panel.html：

1. 删 `.orbit-map .live.back`、`.orbit-map .arrow.back`、`.orbit-map .arrow.back.trail` 三条。
2. `.orbit-map .rail` 之后加：

```css
/* 回跳的飞行路径：极淡发丝，只承接 hover（理由在 tooltip 上），方向全交给火箭。 */
.orbit-map .flight {
  fill: none; stroke: rgba(255,178,150,.14); stroke-width: .35;
  stroke-linecap: round; pointer-events: stroke;
}
/* 小火箭：和 V 字同一种笔触。喷焰略暖，是整条边上唯一的一点「火」。 */
.orbit-map .rocket .hull {
  fill: none; stroke: rgba(240,220,190,.95); stroke-width: .45;
  stroke-linecap: round; stroke-linejoin: round;
}
.orbit-map .rocket .flame {
  fill: none; stroke: rgba(255,166,120,.9); stroke-width: .4;
  stroke-linecap: round; stroke-linejoin: round;
}
```

3. 387 行上方那段「实线/虚线」注释更新措辞：历史 = 凝结尾迹（圆点虚线，永久留着），回跳选项 = 火箭 + 发丝，向前选项 = V 字 + 发丝。

- [ ] **Step 5: 查漏 + 回归**

```bash
grep -n "chordPath\|arrow back\|\.back\b\|arrow\${" src/web/panel.js
grep -n "\.live\.back\|\.arrow\.back" src/web/panel.html
```

Expected: panel.js 里零命中（`.back` 按钮类在 HTML/CSS 里另有其人，js 里没有）；panel.html 里零命中。

```bash
pnpm check
```

Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/web/panel.js src/web/panel.html
git commit -m "feat: 回跳 = 小火箭轨道转移 —— 起飞、转移、入轨，红 V 退役"
```

---

### Task 4: 真面板目检 + 调参

**Files:**
- 可能微调: `src/web/panel.html`（颜色/线宽）、`src/web/panel.js`（节奏常量）

**Interfaces:** 无新接口；只调 Task 2/3 引入的常量。

- [ ] **Step 1: 起面板、开浏览器**

面板服务从 Bash 起（只做只读浏览，不 spawn codex，不碰 EPERM 那条雷）；说明会读真库 `~/.stagepass/panel.db`。浏览器 pane 一个会话只开一次 tab，之后一律 navigate。

- [ ] **Step 2: 目检三样**

1. 中心圆盘没了，环内干净，进度弧还在走。
2. 找一条有回跳历史的 Change：烟迹是圆点虚线、端点缩进 RIM、tooltip 还在。
3. 回跳选项：火箭起飞/入轨节奏、rotate 不跳、淡出后无「瞬移穿帮」。若真库当下没有活的回跳边，用浏览器 console 直接调 `drawMap({journey: […], options: [{kind: "backward", to: "…", why: "目检用"}]})` 造一帧看（纯前端函数、不落库、刷新即散）。

- [ ] **Step 3: reduced-motion 目检**

浏览器模拟 `prefers-reduced-motion: reduce`，确认火箭静止在起飞点、喷焰不闪、V 字那套旧行为不回归。

- [ ] **Step 4: 按目检结果调参**

允许调的旋钮：`6.5`（周期秒数）、keyTimes 分配、`.flame`/`.flight`/`.vapor` 的颜色透明度、`LAUNCH_ARC`/`INSERT_ARC`。每次调完刷新重看。

- [ ] **Step 5: 最终回归 + Commit**

```bash
pnpm check
```

Expected: 全绿。

```bash
git add -A src/web
git commit -m "polish: 火箭动画目检调参"
```

（若 Step 4 一个参数都没动，本步跳过 commit。）
