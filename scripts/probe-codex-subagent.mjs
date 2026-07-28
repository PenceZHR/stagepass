/**
 * Runtime probe for the one capability the judge/sub-agent redesign rests on:
 * can a main agent spawn sub-agents and get their results back, over the
 * app-server protocol StagePass actually uses?
 *
 * Run it against a scratch directory:
 *
 *   node scripts/probe-codex-subagent.mjs /tmp/probe-dir /tmp/probe-dir/out.jsonl
 *
 * ## Why this exists as a script rather than a test
 *
 * It calls the real model on the real account. It cannot run in CI and it is
 * not free, so it is a deliberate, occasional check against a Codex upgrade --
 * the capability is version-dependent and undocumented.
 *
 * ## Why the evidence is structural
 *
 * The model's word is worth nothing here, and this is not a hypothetical: on
 * the `codex exec` path, where spawning does NOT work, the main agent answers
 * as if the sub-agents had replied -- narrating "我会按要求并行启动两个子 Agent"
 * and then writing both sub-agents' expected outputs itself. A probe that read
 * the final message would call that a pass.
 *
 * So the verdict below is taken from `subAgentActivity` items, which carry the
 * spawned agent's own `agentThreadId`, and from that thread's own
 * `item/completed` agentMessage. A sub-agent's output arrives on ITS thread id,
 * which the root agent cannot forge.
 *
 * Note `collabAgentToolCall.receiverThreadIds` is empty even when delegation
 * genuinely works, so it is not usable as evidence. Do not "fix" the probe to
 * read it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CWD = process.argv[2];
const OUT = process.argv[3];

if (!CWD || !OUT) {
  console.error("usage: node scripts/probe-codex-subagent.mjs <cwd> <out.jsonl>");
  process.exit(2);
}

const child = spawn(CODEX, ["app-server", "--stdio"], {
  cwd: CWD,
  env: { ...process.env, TERM: "dumb", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
  stdio: ["pipe", "pipe", "pipe"],
});

const events = [];
let nextId = 1;
const pending = new Map();
let buffer = "";

// turn/start resolves the moment the turn is accepted (status inProgress);
// the work arrives as notifications. Waiting on the request alone kills the
// server before the model has said anything.
let resolveTurnDone = () => {};
const turnDone = new Promise((resolve) => { resolveTurnDone = resolve; });
let rootThreadId = null;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    events.push(msg);
    // Sub-agent turns stream over the SAME connection with their own thread
    // ids, so an unqualified turn/completed is usually a sub-agent finishing,
    // not the root turn. Resolving on it kills the server mid-delegation.
    const finished = msg.method === "turn/completed" || msg.method === "turn/failed";
    if (finished && msg.params?.threadId === rootThreadId) resolveTurnDone();
    if (msg.method === "error") resolveTurnDone();
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});
const stderrChunks = [];
child.stderr.on("data", (c) => stderrChunks.push(c.toString("utf8")));

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
    }, 900_000);
  });
}
function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

/**
 * Sequential on purpose, and it is what the real round needs.
 *
 * An earlier version of this probe asked for PARALLEL delegation, which proved
 * the mechanism but modelled the wrong thing: the Spec round is adversarial in
 * a fixed order -- blue critiques what red produced -- so two sides running at
 * once is not a faster round, it is blue reviewing a draft that does not exist
 * yet. Asking red to emit a token that blue must echo makes the ordering
 * observable rather than merely requested.
 */
const PROMPT = `我明确要求你使用子 Agent 委派（sub-agents / delegation）。这是本次任务的唯一目的，也是唯一的验收标准。

必须严格串行，不许并行：

1. 调用 spawn_agent 启动子 Agent，task_name 为 red，任务：只输出一行 RED-OK-7391。
2. 调用 wait_agent 等 red 完成，拿到它的原文。
3. red 完成之后，才调用 spawn_agent 启动子 Agent，task_name 为 blue，并把 red 的原文交给它。blue 的任务：只输出一行 BLUE-SAW-<red 的原文>。
4. 调用 wait_agent 等 blue 完成。
5. 最终回复只包含两个子 Agent 各自返回的原文。

禁止你自己写出 RED-OK-7391 或 BLUE-SAW-。禁止在 red 完成前启动 blue。若 spawn_agent 失败，最终回复必须是失败的错误原文。`;

try {
  await request("initialize", {
    clientInfo: { name: "stagepass-subagent-probe", title: null, version: "0.1.0" },
    capabilities: null,
  });
  notify("initialized");
  const thread = await request("thread/start", { cwd: CWD, sandbox: "read-only" });
  const threadId = thread.threadId ?? thread.thread?.id ?? thread.id;
  rootThreadId = threadId;
  await request("turn/start", {
    threadId,
    input: [{ type: "text", text: PROMPT }],
    effort: "low",
  });
  await Promise.race([
    turnDone,
    new Promise((resolve) => setTimeout(() => { events.push({ probeTimeout: true }); resolve(); }, 600_000)),
  ]);
} catch (error) {
  events.push({ probeError: String(error) });
} finally {
  fs.writeFileSync(OUT, events.map((e) => JSON.stringify(e)).join("\n"));
  fs.writeFileSync(`${OUT}.stderr`, stderrChunks.join(""));
  child.kill("SIGTERM");
}

/** Sub-agents the root agent really started, keyed by their own thread id. */
const spawned = new Map();
for (const msg of events) {
  const item = msg.params?.item;
  if (item?.type !== "subAgentActivity" || item.kind !== "started") continue;
  spawned.set(item.agentThreadId, {
    agentPath: item.agentPath,
    reply: null,
    startedAt: null,
    completedAt: null,
  });
}
// A sub-agent's reply and its timing both arrive on ITS thread, so neither
// attribution nor ordering needs the root agent's word for it.
for (const msg of events) {
  const agent = spawned.get(msg.params?.threadId);
  if (!agent) continue;
  if (msg.method === "item/completed" && msg.params?.item?.type === "agentMessage") {
    agent.reply = msg.params.item.text;
  }
  if (msg.method === "turn/completed") {
    agent.startedAt = msg.params?.turn?.startedAt ?? null;
    agent.completedAt = msg.params?.turn?.completedAt ?? null;
  }
}

const agents = [...spawned.entries()].map(([threadId, agent]) => ({ threadId, ...agent }));
const red = agents.find((agent) => agent.agentPath?.endsWith("/red"));
const blue = agents.find((agent) => agent.agentPath?.endsWith("/blue"));

const verdict = {
  spawnWorks: spawned.size >= 2,
  // The round is adversarial in a fixed order, so "both sides ran" is not
  // enough -- blue must not have started before red finished.
  ranInTurn: Boolean(
    red?.completedAt != null
    && blue?.startedAt != null
    && blue.startedAt >= red.completedAt,
  ),
  // Independent corroboration of the ordering: blue could only echo this if it
  // actually received red's finished output.
  blueSawRed: Boolean(red?.reply && blue?.reply?.includes(red.reply.trim())),
  agents,
  // The root agent's final text is reported but never used to decide, for the
  // reason given at the top of this file.
  rootFinalMessage: events
    .filter((m) => m.method === "item/completed"
      && m.params?.threadId === rootThreadId
      && m.params?.item?.type === "agentMessage")
    .map((m) => m.params.item.text)
    .at(-1) ?? null,
};
console.log(JSON.stringify(verdict, null, 2));
process.exitCode = verdict.spawnWorks
  && verdict.ranInTurn
  && agents.every((agent) => agent.reply)
  ? 0
  : 1;
