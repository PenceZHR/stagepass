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
  return { short: "未开始", long: "还没有线程。点开会在这个阶段起一个新的。" };
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

    const status = statusOf(entry);
    const button = document.createElement("button");
    button.type = "button";
    button.title = entry.threadId ? `线程 ${entry.threadId}` : "还没有线程";

    const name = document.createElement("span");
    name.textContent = entry.phase;
    const state = document.createElement("em");
    state.textContent = status.short;
    button.append(name, state);

    const describe = () => {
      centerKicker.textContent = status.short;
      centerTitle.textContent = entry.phase;
      centerLine.textContent = status.long;
      centerCount.innerHTML = "";
      centerCount.append(entry.threadId ? "1" : "0");
      const unit = document.createElement("em");
      unit.textContent = "Thread";
      centerCount.append(unit);
    };
    const restore = () => {
      centerKicker.textContent = IDLE.kicker;
      centerTitle.textContent = IDLE.title;
      centerLine.textContent = IDLE.line;
      centerCount.innerHTML = "";
      centerCount.append(String(phases.length));
      const unit = document.createElement("em");
      unit.textContent = "Stages";
      centerCount.append(unit);
    };

    button.addEventListener("mouseenter", describe);
    button.addEventListener("focus", describe);
    button.addEventListener("mouseleave", restore);
    button.addEventListener("blur", restore);
    button.addEventListener("click", () => { void enter(entry.phase); });

    node.append(button);
    wrap.append(node);
  });

  placeNodes();
}

async function load() {
  const response = await fetch(`/api/panel?change=${encodeURIComponent(changeId)}`);
  phases = (await response.json()).phases;
  drawOrbit();
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
term.onData((data) => { if (current) void send(current, data); });
addEventListener("resize", () => {
  if (current) void resize(current);
  else placeNodes();
});

void load();
