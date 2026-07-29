/*
 * The browser half of the terminal panel, in the Abstract Cloud & Sea direction
 * confirmed on 2026-07-24.
 *
 * Two things it must keep from that design, because both were decided rather
 * than styled:
 *
 * 1. Phase navigation is the Circular Stage Orbit. Nodes sit on ONE shared
 *    centre and radius computed with trigonometry -- not per-node percentage
 *    guesses -- so hover scaling never disturbs the ring.
 * 2. Entering a stage converges, fades the ring, and brings the stage in from
 *    slightly small, ~620-720ms, ease-out, no spring. Repeat triggers are
 *    blocked until it settles, or navigations race.
 *
 * And the rule this panel exists under: bytes arrive as Uint8Array and go
 * straight into xterm.js. Nothing here decodes them, because nothing here may
 * understand them (PRD §9.3).
 */
const changeId = new URLSearchParams(location.search).get("change") || "CHG-1";

const orbitView = document.getElementById("orbit-view");
const stageView = document.getElementById("stage-view");
const orbit = document.getElementById("orbit");
const centerTitle = document.getElementById("center-title");
const centerLine = document.getElementById("center-line");
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
    cursor: "#e0b878",
    selectionBackground: "rgba(224,184,120,0.28)",
  },
  allowTransparency: true,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term"));

let phases = [];
let current = null;
let stream = null;
let moving = false;

const path = (phase, suffix = "") =>
  `/pty/${encodeURIComponent(changeId)}/${encodeURIComponent(phase)}${suffix}`;

/** Keystrokes out. Text until it is sent; bytes from there on. */
function send(phase, data) {
  return fetch(path(phase, "/in"), { method: "POST", body: new TextEncoder().encode(data) });
}

function resize(phase) {
  fit.fit();
  return fetch(path(phase, `/resize?cols=${term.cols}&rows=${term.rows}`), { method: "POST" });
}

/** Lay the nodes out on one circle. Shared centre, shared radius, trig. */
function placeNodes() {
  const radius = 42; // percent of the orbit box, leaving room for labels
  orbit.querySelectorAll(".node").forEach((node, index) => {
    // Start at twelve o'clock and go clockwise, so PRD reads first.
    const angle = (index / phases.length) * Math.PI * 2 - Math.PI / 2;
    node.style.left = `${50 + radius * Math.cos(angle)}%`;
    node.style.top = `${50 + radius * Math.sin(angle)}%`;
  });
}

function drawOrbit() {
  orbit.querySelectorAll(".node").forEach((node) => { node.remove(); });
  for (const entry of phases) {
    const node = document.createElement("button");
    node.className = "node"
      + (entry.threadId ? " bound" : "")
      + (entry.live ? " live" : "");
    node.type = "button";
    node.title = entry.threadId
      ? `线程 ${entry.threadId}` + (entry.live ? "（进程活着）" : "")
      : "还没有线程 —— 点开会新起一个";

    const dot = document.createElement("span");
    dot.className = "dot";
    const label = document.createElement("span");
    label.textContent = entry.phase;
    node.append(dot, label);

    node.addEventListener("mouseenter", () => {
      centerTitle.textContent = entry.phase;
      centerLine.textContent = entry.threadId
        ? (entry.live ? "线程活着，点开接上去。" : "有线程，点开会恢复它的历史。")
        : "还没有线程。点开会在这个阶段起一个新的。";
    });
    node.addEventListener("click", () => { void enter(entry.phase); });
    orbit.append(node);
  }
  placeNodes();
}

async function load() {
  const panel = await (await fetch(`/api/panel?change=${encodeURIComponent(changeId)}`)).json();
  phases = panel.phases;
  drawOrbit();
}

/** Ring -> stage. See the note at the top on why this is timed and guarded. */
async function enter(phase) {
  if (moving) return;
  moving = true;
  current = phase;

  const entry = phases.find((item) => item.phase === phase);
  stageName.textContent = phase;
  stageThread.textContent = entry?.threadId ? entry.threadId : "新线程";

  orbitView.classList.add("leaving");
  await new Promise((resolve) => { setTimeout(resolve, 340); });
  orbitView.hidden = true;
  orbitView.classList.remove("leaving");

  stageView.hidden = false;
  stageView.classList.add("entering");
  requestAnimationFrame(() => { stageView.classList.remove("entering"); });
  await new Promise((resolve) => { setTimeout(resolve, 340); });
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

  stageView.classList.add("leaving");
  await new Promise((resolve) => { setTimeout(resolve, 340); });
  stageView.hidden = true;
  stageView.classList.remove("leaving");

  orbitView.hidden = false;
  orbitView.classList.add("entering");
  requestAnimationFrame(() => { orbitView.classList.remove("entering"); });
  await new Promise((resolve) => { setTimeout(resolve, 340); });
  moving = false;

  centerTitle.textContent = "选择一个阶段";
  centerLine.textContent = "十一个阶段，每个阶段一个 Codex 线程。";
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
