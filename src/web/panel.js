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
const runButton = document.getElementById("run");
const askButton = document.getElementById("ask");
const columns = document.getElementById("columns");
const stageName = document.getElementById("stage-name");
const stageThread = document.getElementById("stage-thread");

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

const IDLE = {
  kicker: "Stage Orbit",
  title: "选择一个阶段",
  line: "十一个阶段，每个阶段一个 Codex 线程。",
};

let phases = [];
let panelState = null;
let current = null;
let stream = null;
let moving = false;

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
      centerLine.textContent = result.reason === "phase_already_running"
        ? `${result.phase} 已经开着一个终端了。同一个阶段线程同时只许有一个进程。`
        : `没跑起来：${result.reason}`;
    } else {
      centerLine.textContent = `${result.phase} 跑完了：${JSON.stringify(result.outcome)}`;
    }
  } finally {
    runButton.textContent = "跑这个阶段";
    await load();
  }
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
  if (at) void enter(at.phase);
  try {
    const result = await (await fetch(
      `/api/ask?change=${encodeURIComponent(changeId)}`, { method: "POST" },
    )).json();
    if (!result.asked) {
      centerLine.textContent = result.reason === "no_decision_available"
        ? "这个闸门现在没有可做的裁决。"
        : `没问成：${result.reason}`;
    } else if (!result.answered) {
      centerLine.textContent = "问题已经在终端里了，等你在 Codex 的选择器里选。";
    } else {
      centerLine.textContent =
        `你选了 ${JSON.stringify(result.answer)} → ${JSON.stringify(result.outcome)}`;
    }
  } finally {
    askButton.textContent = "请 Codex 问我";
    await load();
  }
}

/** One shared centre, one shared radius. The halo is inset 7%, so nodes ride 43%. */
function placeNodes() {
  const radius = wrap.clientWidth * 0.43;
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
    node.className = "stage-node"
      + (entry.threadId ? " bound" : "")
      + (entry.live ? " live" : "");
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
    state.textContent = status.short;
    button.append(pip, name, state);

    const describe = () => {
      centerKicker.textContent = status.short;
      centerTitle.textContent = entry.phase;
      centerLine.textContent = status.long;
      centerCount.replaceChildren(document.createTextNode(entry.threadId ? "1" : "0"));
      const unit = document.createElement("em");
      unit.textContent = "Thread";
      centerCount.append(unit);
    };
    button.addEventListener("mouseenter", describe);
    button.addEventListener("focus", describe);
    button.addEventListener("mouseleave", restoreCenter);
    button.addEventListener("blur", restoreCenter);
    button.addEventListener("click", () => { void enter(entry.phase); });

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

  const here = panel.changes.find((change) => change.id === panel.changeId);
  document.getElementById("change-title").textContent = here?.title ?? panel.changeId;
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

  const at = phases.find((entry) => entry.current);
  drawDecision(panel, at);
  if (at) {
    IDLE.kicker = `Current Gate · ${panel.status ?? ""}`.trim();
    IDLE.title = at.phase;
    IDLE.line = panel.blockers > 0
      ? `${panel.blockers} 项问题挡着闸门。`
      : panel.status === "settled"
        ? "证据已到齐，等你的明确决定。"
        : "证据未到齐，跑一次这个阶段。";
  }
  restoreCenter();
}

/**
 * The decision area.
 *
 * It shows what the gate says and offers exactly one primary action: put the
 * decision to the human IN CODEX. There is no approve/reject control here and
 * there must never be -- the web surface carries no decision entrance (PRD §1),
 * and the only answer path is the elicitation selector (§5.2b).
 */
function drawDecision(panel, at) {
  const risks = panel.gate?.risks ?? [];
  const risksEl = document.getElementById("risks");
  if (risks.length === 0) {
    const none = document.createElement("span");
    none.className = "none";
    none.textContent = panel.status === "settled"
      ? "没有挡住闸门的问题。" : "还没有这个阶段的证据。";
    risksEl.replaceChildren(none);
  } else {
    // Numbers, not titles: §4.4 wants how many risks actually hold the gate,
    // in severity order. A truncated sentence reads as broken; a count does not.
    // The ids and titles are on the chip's tooltip, which is where detail
    // belongs -- the main surface carries no long-form output (§4.4 末句).
    const bySeverity = ["P0", "P1", "P2"]
      .map((severity) => ({
        severity,
        items: risks.filter((risk) => risk.severity === severity),
      }))
      .filter((group) => group.items.length > 0);

    risksEl.replaceChildren(...bySeverity.map((group) => {
      const chip = document.createElement("span");
      chip.className = `risk ${group.severity.toLowerCase()}`;
      chip.title = group.items
        .map((risk) => `${risk.id} — ${risk.title}`).join("\n");
      const label = document.createElement("b");
      label.textContent = group.severity;
      const count = document.createElement("span");
      count.textContent = `${group.items.length} 项挡着闸门`;
      chip.append(label, count);
      return chip;
    }));
  }

  // What the gate permits, stated rather than acted on.
  const verdictEl = document.getElementById("verdict");
  const permitted = panel.gate?.permitted ?? [];
  verdictEl.replaceChildren();
  const label = document.createElement("b");
  label.textContent = "Gate";
  const text = document.createElement("span");
  text.textContent = permitted.length === 0
    ? "没有可做的裁决"
    : `可做：${permitted.join(" / ")}`
      + (panel.gate?.refusals?.approve ? `　approve 被拒：${panel.gate.refusals.approve}` : "");
  verdictEl.append(label, text);

  const canAsk = permitted.length > 0 && at && !at.live;
  runButton.hidden = !at;
  runButton.disabled = !at || at.live || panel.status === "settled";
  askButton.hidden = !at;
  askButton.disabled = !canAsk;
}

/** The idle centre, i.e. nothing hovered. */
function restoreCenter() {
  centerKicker.textContent = IDLE.kicker;
  centerTitle.textContent = IDLE.title;
  centerLine.textContent = IDLE.line;
  centerCount.replaceChildren(
    document.createTextNode(String(panelState?.blockers ?? phases.length)),
  );
  const unit = document.createElement("em");
  unit.textContent = panelState?.currentPhase ? "Blocking Risks" : "Stages";
  centerCount.append(unit);
}

/** Ring -> stage. Timed and guarded; see the note at the top. */
async function enter(phase) {
  if (moving) return;
  moving = true;
  current = phase;

  const entry = phases.find((item) => item.phase === phase);
  stageName.textContent = phase;
  stageThread.textContent = entry?.threadId ? entry.threadId.slice(0, 8) : "新线程";

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

// Applied before the first paint, and without a transition -- animating from
// three columns to none on load would look like the page changing its mind.
if (startCollapsed) columns.classList.add("collapsed");
term.onData((data) => { if (current) void send(current, data); });
addEventListener("resize", () => {
  if (current) void resize(current);
  else placeNodes();
});

void load();
