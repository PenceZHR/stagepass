/*
 * The browser half of the terminal panel — Abstract Cloud & Sea + Circular
 * Stage Orbit, as confirmed on 2026-07-24.
 *
 * Things that are decisions rather than styling, so do not "simplify" them:
 *
 *  - Nodes sit on ONE shared centre and radius. They are placed by rotating out
 *    and counter-rotating back, so the card stays upright and hover scaling
 *    never disturbs the ring.
 *  - Every stage carries a ring; the one whose process is alive breathes. That
 *    is the state you can read across the room.
 *  - Entering a stage fires the portal, converges, and brings the stage in from
 *    slightly small, ~680ms. Repeat triggers are blocked or navigations race.
 *
 * 信息分两层（用户 2026-07-29 定，交接 §5.0.2）。这条决定这个文件的形状：
 *
 *   悬停一个阶段 → 左侧 40% 的常驻面板刷成它的**概要**
 *   点击一个阶段 → 弹窗显示它的**明细**（全部问题 + 闸门 + 动作）
 *   环那一屏本身**什么都不加**
 *
 * 所以：觉得主屏少了点什么，答案是 renderStatus 或 drawSheet，不是往环那屏塞
 * 一块新东西。原来压在环底下那条决策区就是这么长出来的，已经整条撤掉了。
 *
 * And the rule the panel exists under: bytes arrive as Uint8Array and go
 * straight into xterm.js. Nothing here decodes them, because nothing here may
 * understand them (PRD §9.3).
 */
const params = new URLSearchParams(location.search);
const changeId = params.get("change") || "CHG-1";
const projectParam = params.get("project");
const startCollapsed = params.get("collapsed") === "1";

const orbitView = document.getElementById("orbit-view");
const stageView = document.getElementById("stage-view");
const wrap = document.getElementById("orbit-wrap");
const portal = document.getElementById("portal");
const centerKicker = document.getElementById("center-kicker");
const centerTitle = document.getElementById("center-title");
const centerLine = document.getElementById("center-line");
const centerCount = document.getElementById("center-count");
const columns = document.getElementById("columns");
const stageName = document.getElementById("stage-name");
const stageThread = document.getElementById("stage-thread");
const stageNote = document.getElementById("stage-note");
/** 终端底下那行注解的原话。say() 会盖掉它，进终端时还原。 */
const NOTE_DEFAULT = stageNote.textContent;

// 左侧 40% 的常驻面板
const statusKicker = document.getElementById("status-kicker");
const statusTitle = document.getElementById("status-title");
const statusMark = document.getElementById("status-mark");
const statusLine = document.getElementById("status-line");
const statusFacts = document.getElementById("status-facts");
const statusFoot = document.getElementById("status-foot");

// 点小环打开的弹窗
const sheet = document.getElementById("sheet");
const sheetKicker = document.getElementById("sheet-kicker");
const sheetTitle = document.getElementById("sheet-title");
const sheetMark = document.getElementById("sheet-mark");
const sheetLine = document.getElementById("sheet-line");
const sheetGaps = document.getElementById("sheet-gaps");
const enterButton = document.getElementById("enter");
const runButton = document.getElementById("run");
const askButton = document.getElementById("ask");

document.getElementById("crumb-change").textContent = changeId;

const term = new Terminal({
  convertEol: false,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  theme: {
    background: "rgba(0,0,0,0)",
    foreground: "#e6dfd2",
    cursor: "#e4cfad",
    selectionBackground: "rgba(228,207,173,0.28)",
  },
  allowTransparency: true,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term"));

/**
 * 阶段的 pass / fail，用**词**说一遍。
 *
 * 判据在服务端（panel-server.ts 的 markOf），这里只负责显示：绿 = 有人批准过这个
 * 阶段，黄 = 有挡着的问题或上一轮失败了。别在这里凭 gap 数量另算一套 —— 两份拷贝
 * 迟早会互相打架。
 *
 * 文案本身是设计稿 §3 要的"颜色之外的第二个信号"，不是可有可无的提示。
 */
const MARK = {
  approved: { label: "已批准", line: "有人在 Codex 里批准了这个阶段，闸门从这里放行。" },
  problem: { label: "有问题", line: "这个阶段有挡着闸门的问题，或者上一轮跑失败了。" },
};

let phases = [];
let panelState = null;
let current = null;
let stream = null;
let moving = false;
/** 弹窗正在显示哪个阶段，没开时是 null。 */
let sheetPhase = null;
/** run / ask 留下的一句话，盖过默认说明，直到弹窗重开。 */
let notice = null;

const path = (phase, suffix = "") =>
  `/pty/${encodeURIComponent(changeId)}/${encodeURIComponent(phase)}${suffix}`;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Keystrokes out. Text until they are sent; bytes from there on. */
const send = (phase, data) =>
  fetch(path(phase, "/in"), { method: "POST", body: new TextEncoder().encode(data) });

function resize(phase) {
  fit.fit();
  return fetch(path(phase, `/resize?cols=${term.cols}&rows=${term.rows}`), { method: "POST" });
}

function statusOf(entry) {
  if (entry.live) return { short: "进程活着", long: "线程活着，点开直接接上去。" };
  if (entry.threadId) return { short: "有线程", long: "有线程，点开会恢复它的历史。" };
  if (entry.current) return { short: "待运行", long: "Change 就停在这个阶段。跑它会派发一次真的 turn。" };
  return { short: "未开始", long: "还没轮到它。点开只是打开一个终端看看。" };
}

/**
 * 一个阶段的一句话，左面板和弹窗共用。
 *
 * **裁决优先于位置**：`statusOf` 说的是"有没有线程、是不是当前"，一个已经批准过
 * 的阶段照样两样都没有，于是会掉进"还没轮到它"—— 而它明明已经走过去了。所以有
 * mark 就先说 mark。
 */
const lineFor = (entry) => (entry.mark ? MARK[entry.mark].line : statusOf(entry).long);

/**
 * Dispatch the Change's current phase.
 *
 * Which phase runs comes from the state machine, not from what is selected --
 * you cannot run a phase out of order, and the button only appears on the one
 * the Change is actually at.
 */
async function run() {
  runButton.disabled = true;
  runButton.textContent = "派发中…";
  try {
    const result = await (await fetch(
      `/api/run?change=${encodeURIComponent(changeId)}`, { method: "POST" },
    )).json();
    if (result.ran === false) {
      say(result.reason === "phase_already_running"
        ? `${result.phase} 已经开着一个终端了。同一个阶段线程同时只许有一个进程。`
        : `没跑起来：${result.reason}`);
    } else {
      say(`${result.phase} 跑完了：${JSON.stringify(result.outcome)}`);
    }
  } finally {
    runButton.textContent = "跑这个阶段";
    await load();
  }
}

/**
 * 把一句结果留在你按按钮的地方。
 *
 * 派发和问人都是从弹窗里按下去的，所以结果回到弹窗；而「请 Codex 问我」会把你送
 * 进终端、弹窗随即关掉，所以同一句话也写进终端底下那行注解 —— 否则它就没了。
 *
 * 主屏上**没有**一条能挂消息的横幅，这是 §5.0 第 4 条要的：新东西不进主屏。
 */
function say(message) {
  notice = message;
  sheetLine.textContent = message;
  stageNote.textContent = message;
}

/**
 * Put the gate decision to the human, in Codex.
 *
 * This opens the phase's terminal because that is where the answer happens --
 * the selector is drawn by Codex there, and the page has no way to answer it.
 */
async function ask() {
  askButton.disabled = true;
  askButton.textContent = "已送进终端…";
  const at = phases.find((entry) => entry.current);
  // 关掉弹窗再进终端：答题发生在 Codex 的选择器里，弹窗盖在上面就看不见了。
  closeSheet();
  if (at) void enter(at.phase);
  try {
    const result = await (await fetch(
      `/api/ask?change=${encodeURIComponent(changeId)}`, { method: "POST" },
    )).json();
    if (!result.asked) {
      say(result.reason === "no_decision_available"
        ? "这个闸门现在没有可做的裁决。"
        : `没问成：${result.reason}`);
    } else if (!result.answered) {
      say("问题已经在终端里了，等你在 Codex 的选择器里选。");
    } else {
      say(`你选了 ${JSON.stringify(result.answer)} → ${JSON.stringify(result.outcome)}`);
    }
  } finally {
    askButton.textContent = "请 Codex 问我";
    await load();
  }
}

/**
 * One shared centre, one shared radius.
 *
 * 0.455 和 CSS 里 `.halo { inset: 4.5% }` 是同一个数：轨道半径也是
 * (1 - 2×0.045) / 2 = 0.455 倍环宽，节点因此正好骑在轨道上。**改一个就要改另一个**，
 * 否则节点会浮在轨道内侧或外侧。
 */
function placeNodes() {
  const radius = wrap.clientWidth * 0.455;
  wrap.querySelectorAll(".stage-node").forEach((node) => {
    node.style.setProperty("--r", `${radius}px`);
  });
}

function drawOrbit() {
  wrap.querySelectorAll(".stage-node").forEach((node) => { node.remove(); });

  phases.forEach((entry, index) => {
    // Twelve o'clock first, clockwise, so PRD reads first.
    //
    // No -90 offset: the node is placed by rotating the frame and then moving
    // UP (translateY(-r)), so angle 0 already points at twelve o'clock.
    // Subtracting 90 here is the obvious-looking mistake -- it lands PRD at
    // nine o'clock, because it rotates "up" a quarter turn counter-clockwise.
    const angle = (index / phases.length) * 360;
    const node = document.createElement("div");
    // mark 放在最后，CSS 里对应的规则也排在 .bound / .live 之后 —— 一个阶段可以
    // 同时有线程、有进程、又被批准过，颜色以裁决为准。
    node.className = "stage-node"
      + (entry.threadId ? " bound" : "")
      + (entry.live ? " live" : "")
      + (entry.mark ? ` ${entry.mark}` : "");
    node.style.setProperty("--a", `${angle}deg`);

    if (entry.current) node.classList.add("current");

    const status = statusOf(entry);
    const button = document.createElement("button");
    button.type = "button";
    button.title = entry.threadId ? `线程 ${entry.threadId}` : "还没有线程";

    const pip = document.createElement("i");
    const name = document.createElement("span");
    name.textContent = entry.phase;
    const state = document.createElement("em");
    state.textContent = entry.mark ? MARK[entry.mark].label : status.short;
    button.append(pip, name, state);

    // 悬停 → 左边那块常驻面板刷成这个阶段；离开所有节点 → 回到 Change 概览。
    // 点击 → 弹窗看明细。两层，不是二选一（交接 §5.0.2）。
    button.addEventListener("mouseenter", () => { hoverOn(entry.phase); });
    button.addEventListener("focus", () => { hoverOn(entry.phase); });
    button.addEventListener("mouseleave", hoverOff);
    button.addEventListener("blur", hoverOff);
    button.addEventListener("click", () => { openSheet(entry.phase); });

    node.append(button);
    wrap.append(node);
  });

  placeNodes();
}

/**
 * The two workspace columns.
 *
 * Selecting either one only narrows what is shown. It starts no turn and moves
 * no gate -- the design is explicit that picking a Project or a Change must
 * never change flow state.
 */
function drawWorkspace(panel) {
  const selected = panel.selectedProject
    ?? panel.changes.find((change) => change.id === panel.changeId)?.projectId
    ?? panel.projects[0]?.id;

  const projectRows = panel.projects.map((project) => {
    const row = document.createElement("button");
    row.className = "row";
    row.type = "button";
    row.setAttribute("aria-selected", String(project.id === selected));

    const name = document.createElement("strong");
    name.textContent = project.name;
    const sub = document.createElement("span");
    sub.textContent = project.id;
    const count = document.createElement("span");
    count.className = "muted";
    count.textContent = `${project.changes} changes`;
    row.append(name, sub, count);

    // Clicking a project toggles the workspace open and shut. Picking a
    // DIFFERENT one selects it and opens; picking the one already selected
    // collapses down to just this Change's orbit.
    row.addEventListener("click", () => {
      if (project.id !== selected) {
        location.search =
          `?change=${encodeURIComponent(changeId)}&project=${encodeURIComponent(project.id)}`;
        return;
      }
      setCollapsed(!columns.classList.contains("collapsed"));
    });
    return row;
  });
  document.getElementById("projects").replaceChildren(...projectRows);
  document.getElementById("project-count").textContent =
    String(panel.projects.length).padStart(2, "0");

  const rows = panel.changes.map((change) => {
    const row = document.createElement("button");
    row.className = "row";
    row.type = "button";
    row.setAttribute("aria-selected", String(change.id === panel.changeId));
    const name = document.createElement("strong");
    name.textContent = change.title ?? change.id;
    const sub = document.createElement("span");
    sub.textContent = `${change.id} · ${change.phase} · ${change.status}`;
    row.append(name, sub);
    // Switching Change reloads with a new id; it starts nothing and moves no
    // gate, which is what the design says selection must never do.
    row.addEventListener("click", () => {
      location.search = `?change=${encodeURIComponent(change.id)}`;
    });
    return row;
  });
  document.getElementById("changes").replaceChildren(...rows);
  document.getElementById("change-count").textContent =
    String(panel.changes.length).padStart(2, "0");
  // Change 的标题现在是左侧常驻面板的默认标题，由 renderStatus(null) 写 —— 环那
  // 一屏上已经没有标题栏了（§5.0 第 1 条）。
}

/**
 * Open or shut the two workspace columns.
 *
 * The orbit is laid out from its container's size, and that size changes over
 * half a second, so the nodes are re-placed while the transition runs -- once at
 * the end would show them jump into position after the ring has finished moving.
 *
 * The state goes in the URL so a reload keeps it, and so a collapsed view can be
 * linked to. `replaceState` rather than a navigation: reloading the page here
 * would tear down every attached terminal to record a layout preference.
 */
function setCollapsed(collapsed) {
  columns.classList.toggle("collapsed", collapsed);

  const next = new URLSearchParams(location.search);
  if (collapsed) next.set("collapsed", "1");
  else next.delete("collapsed");
  history.replaceState(null, "", `${location.pathname}?${next.toString()}`);

  const until = Date.now() + 620;
  const settle = () => {
    placeNodes();
    if (current) void resize(current);
    if (Date.now() < until) requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}

async function load() {
  const panel = await (await fetch(
    `/api/panel?change=${encodeURIComponent(changeId)}`
    + (projectParam ? `&project=${encodeURIComponent(projectParam)}` : ""))).json();
  phases = panel.phases;
  panelState = panel;
  drawWorkspace(panel);
  drawOrbit();

  drawCenter();
  renderStatus(null);
  // run / ask 走完都会 load()，闸门和问题可能已经变了 —— 弹窗还开着就重画它。
  if (sheetPhase) drawSheet(sheetPhase);
}

/**
 * 闸门里**要人裁决**的那几项。
 *
 * 只有这三个会被拿去问人。`start` / `settle` / `fail` 是系统在陈述发生了什么，
 * 所以一个只允许这些的闸门根本没有要人做的决定 —— 在那儿放出问人的按钮，会组出
 * 一道没有选项的题，然后回来一个 `no_decision_available`。
 * 这份名单和 domain/question.ts 里的 `gateDecisionQuestion` 是同一份。
 */
function decidableActions() {
  return (panelState?.gate?.permitted ?? []).filter((action) =>
    action === "approve" || action === "reject" || action === "retry");
}

/** 闸门此刻说了什么，一句话。只陈述，永远不提供改变它的控件。 */
function gateSentence() {
  const decidable = decidableActions();
  if (decidable.length === 0) {
    return (panelState?.gate?.permitted ?? []).length === 0
      ? "闸门没有可做的动作" : "现在没有要人裁决的事";
  }
  const refusal = panelState?.gate?.refusals?.approve;
  return `可裁决：${decidable.join(" / ")}`
    + (refusal ? `（approve 被拒：${refusal}）` : "");
}

const openGaps = (entry) => entry.gaps.filter((gap) => gap.status === "open");

/** 一行「词条 / 值」。左侧面板和弹窗共用同一种写法。 */
function factRows(rows) {
  statusFacts.replaceChildren(...rows.map(([term, value]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.title = value;
    row.append(dt, dd);
    return row;
  }));
}

function paintMark(element, mark) {
  element.className = "mark-pill" + (mark ? ` ${mark}` : "");
  element.textContent = mark ? MARK[mark].label : "未裁决";
  element.hidden = false;
}

/**
 * 左侧 40% 的常驻面板。
 *
 * 传一个阶段进来就显示那个阶段，传 null 就回到 Change 概览 —— 悬停驱动的那两种
 * 状态（交接 §5.0.2）。这里**只陈述**：一个控件都没有，动作全在弹窗里。
 */
function renderStatus(entry) {
  if (!entry) {
    const at = phases.find((item) => item.current);
    const approved = phases.filter((item) => item.mark === "approved").length;
    const problems = phases.filter((item) => item.mark === "problem").length;

    statusKicker.textContent = "Change Gate Orbit";
    statusTitle.textContent = panelState?.changes
      ?.find((change) => change.id === changeId)?.title ?? changeId;
    statusMark.hidden = true;
    statusLine.textContent = at
      ? (panelState?.status === "settled"
          ? "证据已到齐，等你的明确决定。"
          : "证据未到齐，跑一次当前阶段。")
      : "这个 Change 不在库里，环是空的。";
    factRows([
      ["当前阶段", at ? at.phase : "—"],
      ["闸门状态", panelState?.status ?? "—"],
      ["已批准", `${approved} / ${phases.length}`],
      ["有问题的阶段", String(problems)],
      ["闸门", gateSentence()],
    ]);
    statusFoot.textContent = "把鼠标移到环上任一阶段看它的状态，点开看它的问题。";
    return;
  }

  const open = openGaps(entry);
  statusKicker.textContent = entry.current ? "Current Stage" : "Stage";
  statusTitle.textContent = entry.phase;
  paintMark(statusMark, entry.mark);
  statusLine.textContent = lineFor(entry);
  factRows([
    ["线程", entry.threadId ? entry.threadId.slice(0, 8) : "还没有"],
    ["进程", entry.live ? "活着" : "没开"],
    ["未解决的问题", String(open.length)],
    ["问题总数", String(entry.gaps.length)],
    ["当前阶段", entry.current ? "是" : "否"],
  ]);
  statusFoot.textContent = "点这个阶段的小圈，看它的问题明细。";
}

/**
 * 环心：Change 这一层的锚点，**不随悬停变**。
 *
 * 悬停已经由左边那块面板负责了；中心再跟着变一次，就是同一份信息在一屏上写两遍
 * —— 那正是 §5.0 第 4 条说的"污染"。所以这里放的是整条 Change 的进度。
 */
function drawCenter() {
  const at = phases.find((entry) => entry.current);
  const approved = phases.filter((entry) => entry.mark === "approved").length;

  centerKicker.textContent = panelState?.status
    ? `Gate · ${panelState.status}` : "Stage Orbit";
  centerTitle.textContent = at ? at.phase : "—";
  centerLine.textContent = at
    ? `${phases.length} 个阶段，停在第 ${phases.indexOf(at) + 1} 个。`
    : "十一个阶段，每个阶段一个 Codex 线程。";
  centerCount.replaceChildren(
    document.createTextNode(`${approved} / ${phases.length}`),
  );
  const unit = document.createElement("em");
  unit.textContent = "Approved";
  centerCount.append(unit);
}

/*
 * 悬停：进节点就刷面板，离开所有节点就回默认。
 *
 * 离开要等一帧再恢复 —— 从一个节点划到隔壁会先 leave 再 enter，立刻恢复的话中间
 * 会闪一下 Change 概览，看着像面板在抽搐。
 */
let hoverTimer = null;

function hoverOn(phase) {
  if (hoverTimer !== null) { clearTimeout(hoverTimer); hoverTimer = null; }
  renderStatus(phases.find((entry) => entry.phase === phase) ?? null);
}

function hoverOff() {
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { hoverTimer = null; renderStatus(null); }, 70);
}

/*
 * ── 阶段弹窗 ──────────────────────────────────────────────
 *
 * 点小环打开，显示这个阶段的问题明细（用户 2026-07-29 第 3 条）。它和左边那块
 * 常驻面板是两层：**悬停看概要，点击看明细**，不是二选一。
 *
 * 底下三个动作：进终端 / 跑这个阶段 / 请 Codex 问我。
 * **没有 approve / reject，也不许加** —— 裁决只发生在 Codex 自己的选择器里
 * （PRD §1、§5.2b）。要在这里加一个"接受风险"的按钮之前，先读交接 §5.1：waive
 * 同样是人的裁决，同样必须在选择器里问。
 */
const GAP_STATUS = { open: "未解决", closed: "已关闭", waived: "已接受风险" };

function openSheet(phase) {
  notice = null;
  drawSheet(phase);
  if (!sheet.open) sheet.showModal();
}

function closeSheet() {
  sheetPhase = null;
  notice = null;
  if (sheet.open) sheet.close();
}

function drawSheet(phase) {
  const entry = phases.find((item) => item.phase === phase);
  if (!entry) { closeSheet(); return; }
  sheetPhase = phase;

  sheetKicker.textContent = entry.current ? "Current Stage" : "Stage";
  sheetTitle.textContent = entry.phase;
  paintMark(sheetMark, entry.mark);
  sheetLine.textContent = notice
    ?? (entry.current ? `${lineFor(entry)}　闸门：${gateSentence()}` : lineFor(entry));

  drawGaps(entry);

  // run / ask 只出现在 Change 真正停着的那个阶段上：跑哪个阶段由状态机决定，不由
  // 你点开了谁决定。点开一个未来的阶段只是打开看看。
  const decidable = decidableActions();
  runButton.hidden = !entry.current;
  runButton.disabled = entry.live || panelState?.status === "settled";
  askButton.hidden = !entry.current;
  askButton.disabled = decidable.length === 0 || entry.live;
}

function drawGaps(entry) {
  if (entry.gaps.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sheet-empty";
    empty.textContent = entry.threadId || entry.current
      ? "这个阶段还没有记录到问题。"
      : "还没轮到这个阶段，没有问题可看。";
    sheetGaps.replaceChildren(empty);
    return;
  }

  // 未解决的排最前，然后按严重度。挡着闸门的东西不该要人往下滚才看得见。
  const rank = { P0: 0, P1: 1, P2: 2 };
  const sorted = [...entry.gaps].sort((left, right) =>
    (left.status === "open" ? 0 : 1) - (right.status === "open" ? 0 : 1)
    || rank[left.severity] - rank[right.severity]
    || left.openedRound - right.openedRound);

  const open = openGaps(entry).length;
  const heading = document.createElement("p");
  heading.className = "sheet-section";
  heading.textContent = open > 0
    ? `${open} 项挡着闸门 · 共 ${entry.gaps.length} 项`
    : `${entry.gaps.length} 项，都已了结`;

  sheetGaps.replaceChildren(heading, ...sorted.map((gap) => {
    const row = document.createElement("div");
    row.className = `gap ${gap.status}`;

    const severity = document.createElement("b");
    severity.className = "gap-sev";
    severity.textContent = gap.severity;

    const text = document.createElement("div");
    text.className = "gap-text";
    const title = document.createElement("strong");
    title.textContent = gap.title;
    const meta = document.createElement("span");
    meta.textContent =
      `${gap.id} · ${GAP_STATUS[gap.status]} · 第 ${gap.openedRound} 轮发现`;
    text.append(title, meta);
    // 结案理由。"修好了"和"这一轮忘了提"的区别全在这一行上，所以它必须显示出来，
    // 而不是只留在库里（domain/gap.ts 开头那段说的就是这件事）。
    if (gap.resolution) {
      const why = document.createElement("em");
      why.textContent = gap.resolution;
      text.append(why);
    }

    row.append(severity, text);
    return row;
  }));
}

/** Ring -> stage. Timed and guarded; see the note at the top. */
async function enter(phase) {
  if (moving) return;
  moving = true;
  current = phase;

  const entry = phases.find((item) => item.phase === phase);
  stageName.textContent = phase;
  stageThread.textContent = entry?.threadId ? entry.threadId.slice(0, 8) : "新线程";
  // 上一次 run / ask 的结果不该跟着你进下一个阶段。ask() 会在这之后再写一次。
  stageNote.textContent = NOTE_DEFAULT;

  portal.classList.remove("go");
  void portal.offsetWidth; // restart the animation rather than skip it
  portal.classList.add("go");
  orbitView.classList.add("entering");

  await wait(620);
  orbitView.hidden = true;
  orbitView.classList.remove("entering");
  portal.classList.remove("go");

  stageView.hidden = false;
  void stageView.offsetWidth;
  stageView.classList.add("active");
  await wait(120);
  moving = false;

  term.reset();
  term.focus();
  await attach(phase);
}

async function leave() {
  if (moving) return;
  moving = true;
  if (stream) { stream.abort(); stream = null; }
  current = null;

  stageView.classList.remove("active");
  await wait(420);
  stageView.hidden = true;

  orbitView.hidden = false;
  orbitView.classList.add("entering");
  void orbitView.offsetWidth;
  orbitView.classList.remove("entering");
  await wait(300);
  moving = false;

  await load();
}

async function attach(phase) {
  stream = new AbortController();
  await resize(phase);

  const response = await fetch(path(phase), { signal: stream.signal });
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // value is a Uint8Array. It is drawn, never inspected.
    term.write(value);
  }
}

document.getElementById("back").addEventListener("click", () => { void leave(); });
runButton.addEventListener("click", () => { void run(); });
askButton.addEventListener("click", () => { void ask(); });
document.getElementById("expand").addEventListener("click", () => { setCollapsed(false); });

enterButton.addEventListener("click", () => {
  const phase = sheetPhase;
  closeSheet();
  if (phase) void enter(phase);
});
document.getElementById("sheet-close").addEventListener("click", () => { closeSheet(); });
// 点遮罩也关。<dialog> 的遮罩不是独立元素，点在它上面时 event.target 就是 dialog
// 自己 —— 点在内容上时 target 是里面的节点，所以这个判断足够分开两者。
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});
// Esc 走原生的 cancel/close，不经过 closeSheet，所以状态要在这里跟上。
sheet.addEventListener("close", () => { sheetPhase = null; notice = null; });

// Applied before the first paint, and without a transition -- animating from
// three columns to none on load would look like the page changing its mind.
if (startCollapsed) columns.classList.add("collapsed");
term.onData((data) => { if (current) void send(current, data); });
addEventListener("resize", () => {
  if (current) void resize(current);
  else placeNodes();
});

void load();
