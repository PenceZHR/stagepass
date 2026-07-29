/*
 * The browser half of the terminal panel.
 *
 * Bytes arrive from the server as Uint8Array and go straight into xterm.js,
 * which turns escape sequences into pixels. Nothing here decodes them, and
 * nothing here needs to: xterm.write() takes bytes. That is the whole point --
 * the panel changed which window Codex draws in, not who draws (PRD §9.3).
 */
const changeId = new URLSearchParams(location.search).get("change") || "CHG-1";

const tabs = document.getElementById("tabs");
const term = new Terminal({
  convertEol: false,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  theme: { background: "#0b0d10", foreground: "#d5dbe3" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term"));
fit.fit();

let current = null;
let stream = null;

/** Keystrokes out. Encoded here because a keystroke is text until it is sent. */
async function send(phase, data) {
  await fetch(`/pty/${encodeURIComponent(changeId)}/${encodeURIComponent(phase)}/in`, {
    method: "POST",
    body: new TextEncoder().encode(data),
  });
}

async function resize(phase) {
  fit.fit();
  await fetch(
    `/pty/${encodeURIComponent(changeId)}/${encodeURIComponent(phase)}/resize`
    + `?cols=${term.cols}&rows=${term.rows}`,
    { method: "POST" },
  );
}

async function attach(phase) {
  if (stream) stream.abort();
  current = phase;
  term.reset();
  render();

  stream = new AbortController();
  await resize(phase);

  const response = await fetch(
    `/pty/${encodeURIComponent(changeId)}/${encodeURIComponent(phase)}`,
    { signal: stream.signal },
  );
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // value is a Uint8Array. It is not inspected, only drawn.
    term.write(value);
  }
}

function render() {
  fetch(`/api/panel?change=${encodeURIComponent(changeId)}`)
    .then((response) => response.json())
    .then((panel) => {
      tabs.replaceChildren(...panel.phases.map((entry) => {
        const button = document.createElement("button");
        button.textContent = entry.phase;
        button.setAttribute("aria-selected", String(entry.phase === current));
        if (entry.live) button.classList.add("live");
        const dot = document.createElement("span");
        dot.className = "dot";
        button.append(dot);
        button.title = entry.threadId
          ? `thread ${entry.threadId}`
          : "还没有线程 —— 点开会新起一个";
        button.onclick = () => { void attach(entry.phase); };
        return button;
      }));
    });
}

term.onData((data) => { if (current) void send(current, data); });
addEventListener("resize", () => { if (current) void resize(current); });

render();
