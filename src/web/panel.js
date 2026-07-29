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
const changeId = new URLSearchParams(location.search).get("change") || "CHG-1";

const orbitView = document.getElementById("orbit-view");
const stageView = document.getElementById("stage-view");
const wrap = document.getElementById("orbit-wrap");
const portal = document.getElementById("portal");
const centerKicker = document.getElementById("center-kicker");
const centerTitle = document.getElementById("center-title");
const centerLine = document.getElementById("center-line");
const centerCount = document.getElementById("center-count");
const runButton = document.getElementById("run");
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
 * There is no `projects` table and `changes` has no title, so these show the id,
 * phase and status that actually exist. Inventing a title field to make the
 * layout look fuller would put something on screen that nothing can produce.
 */
function drawWorkspace(panel) {
  const project = document.createElement("button");
  project.className = "row";
  project.type = "button";
  project.setAttribute("aria-selected", "true");
  const projectName = document.createElement("strong");
  projectName.textContent = panel.workspace || "workspace";
  const projectSub = document.createElement("span");
  projectSub.textContent = `${panel.changes.length} changes`;
  project.append(projectName, projectSub);
  document.getElementById("projects").replaceChildren(project);
  document.getElementById("project-count").textContent = "01";

  const rows = panel.changes.map((change) => {
    const row = document.createElement("button");
    row.className = "row";
    row.type = "button";
    row.setAttribute("aria-selected", String(change.id === panel.changeId));
    const name = document.createElement("strong");
    name.textContent = change.id;
    const sub = document.createElement("span");
    sub.textContent = `${change.phase} · ${change.status}`;
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
  document.getElementById("change-title").textContent = panel.changeId;
}

async function load() {
  const panel = await (await fetch(
    `/api/panel?change=${encodeURIComponent(changeId)}`)).json();
  phases = panel.phases;
  panelState = panel;
  drawWorkspace(panel);
  drawOrbit();

  const at = phases.find((entry) => entry.current);
  runButton.hidden = !at;
  runButton.disabled = !at || at.live;
  if (at) {
    IDLE.kicker = `Current Gate · ${panel.status ?? ""}`.trim();
    IDLE.title = at.phase;
    IDLE.line = panel.blockers > 0
      ? `${panel.blockers} 项问题挡着闸门。`
      : "证据未到齐，跑一次这个阶段。";
  }
  restoreCenter();
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
term.onData((data) => { if (current) void send(current, data); });
addEventListener("resize", () => {
  if (current) void resize(current);
  else placeNodes();
});

void load();
