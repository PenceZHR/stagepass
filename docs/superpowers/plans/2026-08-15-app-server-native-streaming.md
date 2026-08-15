# StagePass Pure App Server Native Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every production Codex TUI/PTY/rollout dependency in this isolated branch with Codex App Server JSON-RPC and render its native structured stream in the StagePass interface.

**Architecture:** One supervised `codex app-server --listen stdio://` process serves StagePass. A narrow client owns JSON-RPC, a session layer owns thread/turn/interaction state, and a materialized stream projection feeds snapshot + SSE endpoints. The browser renders that projection in the existing StagePass cloud-sea design; StagePass remains authoritative for Change, phase, rubric, gap, job and gate state.

**Tech Stack:** TypeScript 5.9, Node.js child processes and HTTP/SSE, better-sqlite3 bindings, browser JavaScript, Codex App Server 0.147 JSONL protocol, node:test.

---

## File map

New production files:

- `src/codex/app-server-protocol.ts` — minimal protocol types and runtime guards.
- `src/codex/app-server-client.ts` — stdio JSON-RPC process client.
- `src/codex/stream-state.ts` — materialized item/turn/interaction state and replay sequence.
- `src/codex/app-server-session.ts` — thread, turn, steer, interrupt and interaction lifecycle.
- `src/codex/app-server-transport.ts` — existing `CodexTransport` implemented through App Server.
- `src/web/stream-session.ts` — `(change, seat)` registry, binding bridge and SSE subscription source.
- `src/web/codex-stream.js` — browser snapshot/SSE renderer and composer.

New test support:

- `src/codex/__fixtures__/fake-app-server.cjs` — deterministic protocol peer.
- One colocated `*.test.ts` file for each new TypeScript module.

Modified integration files:

- `src/web/panel-server.ts`, `src/web/panel-view.ts`, `src/web/panel.html`, `src/web/panel.js`,
  `src/web/panel-globals.d.ts`.
- `scripts/panel.ts`, `src/architecture.test.ts`, `package.json`, `pnpm-lock.yaml`, `README.md`,
  `docs/PRD-stagepass-rebuild-2026-07-28.md`, `docs/CODEX-CONTRACT.md`.

Deleted after replacement is green:

- `src/web/pty-session.ts` and its test.
- `src/codex/tui-transport.ts`, `src/codex/rollout.ts` and their tests.
- PTY-only probes under `scripts/`.
- `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` dependencies.

## Task 1: JSON-RPC App Server client

**Files:**
- Create: `src/codex/app-server-protocol.ts`
- Create: `src/codex/app-server-client.ts`
- Create: `src/codex/app-server-client.test.ts`
- Create: `src/codex/__fixtures__/fake-app-server.cjs`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write the fake peer and failing process-boundary tests**

The fixture accepts only the real launch shape (`app-server --listen stdio://`) and supports
`normal`, `chunked`, `approval`, `hang`, and `exit1` modes. Tests must assert:

```ts
const client = AppServerClient.spawn({
  command: process.execPath,
  args: [FAKE_APP_SERVER],
  cwd: process.cwd(),
  onNotification: (message) => notifications.push(message),
  onServerRequest: async (message) => ({ decision: "decline" }),
});

await client.initialize();
const started = await client.request("thread/start", { cwd: process.cwd() });
assert.equal(readThreadId(started), "THREAD-1");
```

Also prove a response split across stdout chunks is parsed once, an approval request receives the
response under the same id, timeout rejects only the target request, process exit rejects every
pending request, and stderr sanitization removes bearer/sk-like tokens.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- src/codex/app-server-client.test.ts`

Expected: FAIL because `app-server-client.ts` and protocol guards do not exist.

- [ ] **Step 3: Implement the minimal protocol and client**

Required public surface:

```ts
export type RpcId = number | string;
export interface AppServerNotification {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}
export interface AppServerRequest extends AppServerNotification {
  readonly id: RpcId;
}

export class AppServerClient {
  static spawn(options: AppServerClientOptions): AppServerClient;
  initialize(): Promise<Readonly<Record<string, unknown>>>;
  request(method: string, params?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<unknown>;
  respond(id: RpcId, result: unknown): void;
  reject(id: RpcId, code: number, message: string): void;
  close(graceMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
```

`initialize` sends client capabilities with `experimentalApi: true`, then sends `initialized`.
The reader buffers partial lines. Unknown notifications are routed, not discarded. Unknown server
requests are rejected by the injected handler, never auto-approved.

- [ ] **Step 4: Run GREEN and structural checks**

Run: `pnpm test -- src/codex/app-server-client.test.ts`

Expected: all App Server client tests pass, `fail 0`.

Run: `pnpm typecheck`

Expected: exit 0. Add both new production modules to the architecture layer map at L2.

- [ ] **Step 5: Commit**

```bash
git add src/codex/app-server-protocol.ts src/codex/app-server-client.ts \
  src/codex/app-server-client.test.ts src/codex/__fixtures__/fake-app-server.cjs \
  src/architecture.test.ts
git commit -m "feat: add supervised app-server protocol client"
```

## Task 2: Materialized stream state and session lifecycle

**Files:**
- Create: `src/codex/stream-state.ts`
- Create: `src/codex/stream-state.test.ts`
- Create: `src/codex/app-server-session.ts`
- Create: `src/codex/app-server-session.test.ts`
- Modify: `src/codex/__fixtures__/fake-app-server.cjs`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing state tests**

Use state assertions, not callback-call assertions:

```ts
const state = new StreamState("THREAD-1", { replayLimit: 8 });
state.accept(notification("turn/started", { threadId: "THREAD-1", turn }));
state.accept(notification("item/agentMessage/delta", {
  threadId: "THREAD-1", turnId: "TURN-1", itemId: "ITEM-1", delta: "你好",
}));
assert.equal(state.snapshot().items[0]?.text, "你好");
assert.equal(state.eventsAfter(0).at(-1)?.seq, 2);
```

Cover item start/delta/completion, command output, reasoning summary, file change, MCP tool,
unknown item, terminal turn, duplicate delivery, foreign thread filtering, replay gap and pending
interaction resolution.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- src/codex/stream-state.test.ts src/codex/app-server-session.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement stream contracts and session API**

Required union and API:

```ts
export type StreamEvent =
  | { seq: number; kind: "snapshot.changed"; threadId: string }
  | { seq: number; kind: "turn.started"; threadId: string; turnId: string }
  | { seq: number; kind: "item.changed"; threadId: string; turnId: string; itemId: string }
  | { seq: number; kind: "interaction.requested"; interactionId: string }
  | { seq: number; kind: "interaction.resolved"; interactionId: string }
  | { seq: number; kind: "turn.completed"; threadId: string; turnId: string; status: TurnStatus }
  | { seq: number; kind: "error"; code: string; message: string };

export class AppServerSession {
  static start(client: AppServerClient, options: SessionOptions): Promise<AppServerSession>;
  static resume(client: AppServerClient, threadId: string, options: SessionOptions): Promise<AppServerSession>;
  snapshot(): StreamSnapshot;
  subscribe(listener: (event: StreamEvent) => void): () => void;
  startTurn(prompt: string): Promise<string>;
  steer(text: string, expectedTurnId: string): Promise<void>;
  interrupt(expectedTurnId: string): Promise<void>;
  respond(interactionId: string, answer: InteractionAnswer): Promise<void>;
  awaitTurn(turnId: string, timeoutMs: number): Promise<CompletedTurn>;
}
```

The client must allow multiple notification listeners and route server requests to the matching
thread session. `completed` item/turn payloads replace incremental partial values as final truth.

- [ ] **Step 4: Run GREEN**

Run: `pnpm test -- src/codex/stream-state.test.ts src/codex/app-server-session.test.ts`

Expected: pass with no skipped cases.

Run: `pnpm typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/codex/stream-state.ts src/codex/stream-state.test.ts \
  src/codex/app-server-session.ts src/codex/app-server-session.test.ts \
  src/codex/__fixtures__/fake-app-server.cjs src/architecture.test.ts
git commit -m "feat: materialize app-server stream sessions"
```

## Task 3: Move background turns onto App Server

**Files:**
- Create: `src/codex/app-server-transport.ts`
- Create: `src/codex/app-server-transport.test.ts`
- Modify: `src/codex/transport.ts`
- Modify: `src/web/panel-server.ts`
- Modify: `scripts/panel.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing `CodexTransport` contract tests**

```ts
const delivery = await transport.runTurn({
  threadId: null,
  prompt: "Return the contract",
  onThread: (id) => observedThread = id,
});
assert.equal(observedThread, "THREAD-1");
assert.deepEqual(delivery, { threadId: "THREAD-1", text: "final answer" });
```

Cover resume, terminal failed, terminal interrupted, timeout, and exact onThread-before-terminal
ordering.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- src/codex/app-server-transport.test.ts src/codex/turn-runner.test.ts`

Expected: App Server transport import failure.

- [ ] **Step 3: Implement transport and wire background runners**

`AppServerCodexTransport` uses the shared client/session manager, not a per-turn process. It passes
cwd/model/effort/sandbox/approval and StagePass MCP config through `thread/start|resume`. Final text
comes from terminal agentMessage items. `turn/start` output schema is used where StagePass already
has a response contract.

- [ ] **Step 4: Run GREEN and relevant business suite**

Run: `pnpm test -- src/codex/app-server-transport.test.ts src/codex/turn-runner.test.ts src/work/round-turn-runner.test.ts`

Expected: pass, `fail 0`.

Run: `pnpm typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/codex/app-server-transport.ts src/codex/app-server-transport.test.ts \
  src/codex/transport.ts src/web/panel-server.ts scripts/panel.ts src/architecture.test.ts
git commit -m "feat: run stage turns through app-server"
```

## Task 4: Snapshot, SSE and command endpoints

**Files:**
- Create: `src/web/stream-session.ts`
- Create: `src/web/stream-session.test.ts`
- Modify: `src/web/panel-server.ts`
- Modify: `src/web/panel-server.test.ts`
- Modify: `src/web/panel-view.ts`
- Modify: `scripts/panel.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing registry and HTTP tests**

Prove one seat/one thread, no implicit turn on open, snapshot shape, SSE ids, Last-Event-ID replay,
replay gap, turn-busy, stale steer/interrupt, interaction response idempotency, and listener removal
when the HTTP connection closes.

```ts
const response = await request("POST", "/api/codex/open", { changeId, seat: "PRD" });
assert.equal(response.status, 200);
assert.equal(fake.requests.filter((r) => r.method === "turn/start").length, 0);
```

- [ ] **Step 2: Run RED**

Run: `pnpm test -- src/web/stream-session.test.ts src/web/panel-server.test.ts`

Expected: new endpoints return 404.

- [ ] **Step 3: Implement registry and endpoints**

SSE frames use:

```text
id: <seq>
event: <kind>
data: <single-line JSON>

```

`/api/codex/open` resolves workspace from the Change's Project, then start/resume. Every write body
is length-limited JSON. Existing job/gate endpoints call the same App Server session registry.

- [ ] **Step 4: Run GREEN**

Run: `pnpm test -- src/web/stream-session.test.ts src/web/panel-server.test.ts`

Expected: pass, no open handles.

Run: `pnpm typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/web/stream-session.ts src/web/stream-session.test.ts \
  src/web/panel-server.ts src/web/panel-server.test.ts src/web/panel-view.ts \
  scripts/panel.ts src/architecture.test.ts
git commit -m "feat: expose app-server snapshot and event stream"
```

## Task 5: StagePass-native stream renderer

**Files:**
- Create: `src/web/codex-stream.js`
- Create: `src/web/codex-stream.test.ts`
- Modify: `src/web/panel.html`
- Modify: `src/web/panel.js`
- Modify: `src/web/panel-globals.d.ts`
- Modify: `src/web/panel-server.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing source/DOM-behavior tests**

Tests prove the browser module renders text deltas without replacing existing DOM, renders command,
file, MCP and reasoning items with semantic elements, sends idle composer input to `/turn`, running
input to `/steer`, sends interrupt with expected turn id, and opens a real dialog for interactions.
They also prove xterm scripts and the `/pty` browser path are absent.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- src/web/codex-stream.test.ts src/architecture.test.ts`

Expected: missing module and old xterm/PTY assertions.

- [ ] **Step 3: Implement the renderer in the existing art system**

Required DOM roots:

```html
<section class="stream-surface" id="codex-stream" aria-live="polite"></section>
<form class="composer" id="codex-composer">
  <textarea id="codex-input" aria-label="给 Codex 的消息"></textarea>
  <button type="submit" id="codex-send">发送</button>
  <button type="button" id="codex-interrupt">中断</button>
</form>
<dialog class="sheet" id="codex-interaction"></dialog>
```

Reuse current `--background`, `--sand*`, `--rose`, `--serif`, divider and sheet rules. Agent prose is
unboxed; secondary execution items use thin dividers and disclosure, not a dashboard card grid.

- [ ] **Step 4: Run GREEN, typecheck and browser verification**

Run: `pnpm test -- src/web/codex-stream.test.ts src/architecture.test.ts`

Run: `pnpm typecheck`

Then start only this worktree on `4173`, inspect console/network/DOM, and capture 1440/1024/768/320
screenshots. Verify keyboard submit, Shift+Enter, interrupt and dialog focus.

- [ ] **Step 5: Commit**

```bash
git add src/web/codex-stream.js src/web/codex-stream.test.ts src/web/panel.html \
  src/web/panel.js src/web/panel-globals.d.ts src/web/panel-server.ts src/architecture.test.ts
git commit -m "feat: render native codex stream in stagepass"
```

## Task 6: Replace archive, recovery and rollout readers

**Files:**
- Create: `src/codex/app-server-history.ts`
- Create: `src/codex/app-server-history.test.ts`
- Modify: `src/codex/archive.ts`, `src/codex/archive.test.ts`
- Modify: `src/codex/subagent.ts`, `src/codex/subagent.test.ts`
- Modify: `src/web/session-recovery.ts`, `src/web/session-recovery.test.ts`
- Modify: `src/app/ask-human.ts`, `src/app/ask-human.test.ts`
- Modify: `src/app/converge-brief.ts`, `src/app/converge-brief.test.ts`
- Modify: `src/web/panel-view.ts`, `src/web/panel-server.ts`

- [ ] **Step 1: Write failing compatibility tests against App Server history**

Prove thread availability from `thread/resume/read`, archive/unarchive requests, last completed turn,
all user/agent text, context usage when present, subagent lineage from collab/subagent items, and
"turn ended without answer" without filesystem access.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- src/codex/app-server-history.test.ts src/codex/subagent.test.ts src/web/session-recovery.test.ts src/app/ask-human.test.ts`

Expected: history adapter missing.

- [ ] **Step 3: Implement async App Server history ports**

Replace synchronous filesystem interfaces with injected async ports:

```ts
export interface CodexHistory {
  readThread(threadId: string): Promise<ThreadHistory | null>;
  archive(threadId: string): Promise<void>;
  unarchive(threadId: string): Promise<void>;
}
```

Move callers to await these operations. Missing is only an explicit App Server not-found response;
disconnect/protocol errors keep bindings intact. Preserve every StagePass business outcome.

- [ ] **Step 4: Run GREEN and the complete affected suite**

Run: `pnpm test -- src/codex/app-server-history.test.ts src/codex/subagent.test.ts src/web/session-recovery.test.ts src/app/ask-human.test.ts src/app/converge-brief.test.ts src/work/round-runner.test.ts src/work/rubric-round.test.ts`

Run: `pnpm typecheck`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/codex/app-server-history.ts src/codex/app-server-history.test.ts \
  src/codex/archive.ts src/codex/archive.test.ts src/codex/subagent.ts src/codex/subagent.test.ts \
  src/web/session-recovery.ts src/web/session-recovery.test.ts src/app/ask-human.ts \
  src/app/ask-human.test.ts src/app/converge-brief.ts src/app/converge-brief.test.ts \
  src/web/panel-view.ts src/web/panel-server.ts
git commit -m "refactor: derive codex history from app-server"
```

## Task 7: Delete the TUI/PTY/private-record path

**Files:**
- Delete: `src/web/pty-session.ts`, `src/web/pty-session.test.ts`
- Delete: `src/codex/tui-transport.ts`, `src/codex/tui-transport.test.ts`
- Delete: `src/codex/rollout.ts`, `src/codex/rollout.test.ts`
- Delete: PTY/rollout-only scripts discovered by `rg`
- Modify: `package.json`, `pnpm-lock.yaml`, `src/architecture.test.ts`, `scripts/panel.ts`

- [ ] **Step 1: Add failing purity guards**

The architecture test scans production files and dependencies:

```ts
assert.deepEqual(matches(/node-pty|@xterm|\/pty\/|state_5\.sqlite|rollout-/), []);
assert.equal(dependencies.has("node-pty"), false);
assert.equal(dependencies.has("@xterm/xterm"), false);
```

It must also assert `app-server-client.ts` is the only module that spawns Codex.

- [ ] **Step 2: Run RED**

Run: `pnpm test -- src/architecture.test.ts`

Expected: failures name the remaining legacy files/imports.

- [ ] **Step 3: Delete legacy modules, probes and dependencies**

Remove only files whose behavior is already covered by Tasks 1–6. Regenerate the pnpm lock with
`pnpm install --lockfile-only`. Update the layer map, orphan guard and closure ratchet intentionally.

- [ ] **Step 4: Run full verification**

Run: `pnpm check`

Expected: typecheck passes and test summary reports `fail 0`, `cancelled 0`.

Run:

```bash
rg -n 'node-pty|@xterm|/pty/|state_5\.sqlite|rollout-' src scripts package.json
```

Expected: no production matches; historical docs/tests may match only when explicitly describing the
removed route.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove the codex tui and rollout pipeline"
```

## Task 8: Contract docs and real 4173 acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/PRD-stagepass-rebuild-2026-07-28.md`
- Modify: `docs/CODEX-CONTRACT.md`
- Create: `docs/evidence/app-server-native-streaming-2026-08-15.md`

- [ ] **Step 1: Update live documentation**

State that this branch replaces the old "StagePass never renders Codex semantics" invariant. Record
Codex 0.147 methods, event/interaction support, failure semantics and the exact schema generation
command. Keep the original branch untouched.

- [ ] **Step 2: Run the real service only on 4173**

Run:

```bash
pnpm panel -- --port 4173 --db <isolated-acceptance-db>
```

Walk: fresh thread, resume, streaming text, command output, MCP tool, StagePass elicitation, steer,
interrupt, post-interrupt turn, browser refresh, server restart. Record thread/turn ids with any
sensitive values removed.

- [ ] **Step 3: Browser and protocol acceptance**

Verify console has zero errors; only one SSE connection per visible stage; DOM does not duplicate
deltas after reconnect; keyboard and dialog focus work; screenshots match StagePass art at 1440,
1024, 768 and 320 widths.

- [ ] **Step 4: Final full verification**

Run: `pnpm check`

Expected: `fail 0`, `cancelled 0`.

Run: `git status --short`

Expected: only the evidence/doc changes for this task before commit.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/PRD-stagepass-rebuild-2026-07-28.md docs/CODEX-CONTRACT.md \
  docs/evidence/app-server-native-streaming-2026-08-15.md
git commit -m "docs: record app-server native streaming acceptance"
```

## Plan self-review

- Spec coverage: Tasks 1–7 cover protocol, stream state, background turns, web control, renderer,
  recovery/history and legacy deletion; Task 8 covers the complete acceptance matrix.
- Scope discipline: no TUI fallback or mixed ownership is introduced in this branch.
- Type consistency: `AppServerClient` owns wire ids; `AppServerSession` owns one thread;
  `StreamSessions` owns StagePass seat mapping; `CodexTransport` stays the business-run seam.
- No placeholders: every task has concrete files, failing behavior, command, expected result and
  commit boundary.
- Execution mode: inline, because the user explicitly instructed the current agent to start directly;
  no subagents are used.
