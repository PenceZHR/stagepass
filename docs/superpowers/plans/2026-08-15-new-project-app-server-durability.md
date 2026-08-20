# StagePass New Project App Server Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a brand-new StagePass Change fully usable through the pure App Server UI and keep its first real thread durable across refresh, restart, archive recovery, and accidental second-instance startup.

**Architecture:** `StreamSessions` becomes an in-process projection registry with an explicit resume id and no binding writes. `PanelSessions` becomes the single product facade that prepares archived bindings, opens ephemeral threads, starts turns, and binds only after `turn/start` succeeds. A reserved HTTP listener owns 4173 before any database or App Server side effect and hands the same server to the finished panel handler.

**Tech Stack:** TypeScript 5.9, Node.js HTTP/process APIs, Codex App Server JSONL RPC, better-sqlite3, node:test, real Chrome/CDP acceptance.

---

## File map

Create:

- `src/web/panel-listener.ts` — reserve loopback port before stateful initialization and switch the same HTTP server from 503 initialization responses to the real request listener.
- `src/web/panel-listener.test.ts` — listener reservation, activation and collision behavior.

Modify:

- `src/web/stream-session.ts` — accept an explicit resume thread id and stop writing bindings.
- `src/web/stream-session.test.ts` — prove open is ephemeral and stream controls remain exact.
- `src/web/panel-server.ts` — make `PanelSessions` the durable product facade and allow an already-reserved server.
- `src/web/session-recovery.ts` — return the exact resume/fresh decision to the facade without hidden writes outside the facade.
- `src/web/session-recovery.test.ts` — preserve archived/missing/unavailable semantics.
- `src/web/codex-stream-api.ts` — depend on a narrow product-session interface, not concrete `StreamSessions`.
- `src/web/stream-api.test.ts` — prove real HTTP open/turn uses recovery and first-turn binding.
- `src/panel-entry.test.ts` — prove port collision exits before database creation.
- `scripts/panel.ts` — reserve 4173 before opening SQLite or spawning App Server and clean partial startup resources.
- `src/architecture.test.ts` — prevent product HTTP routes from depending on raw stream sessions again.
- `docs/evidence/new-project-app-server-durability-2026-08-15.md` — automated and real CHG-002 acceptance.

## Task 1: Make empty stream sessions ephemeral

**Files:**

- Modify: `src/web/stream-session.ts`
- Modify: `src/web/stream-session.test.ts`

- [x] **Step 1: Replace the old binding-on-open expectation with failing durability tests**

Change the first test to assert that opening a new seat creates a reusable in-process session but no durable row:

```ts
it("keeps a new zero-turn thread ephemeral", async () => {
  const { database, connection, sessions } = setup();
  try {
    const first = await sessions.open("CHG-1", "PRD", {
      config: { stagepass: true },
      threadId: null,
    });
    const second = await sessions.open("CHG-1", "PRD", { threadId: null });

    assert.equal(first, second);
    assert.equal(new BindingStore(database).find("CHG-1", "PRD"), null);
    assert.deepEqual(connection.requests.map(({ method }) => method), ["thread/start"]);
  } finally {
    database.close();
  }
});
```

Change resume coverage to pass the durable id explicitly and assert that low-level open does not consult or rewrite the binding table:

```ts
const resumed = await sessions.open("CHG-1", "PRD", {
  threadId: "THREAD-OLD",
});
assert.equal(resumed.threadId, "THREAD-OLD");
assert.deepEqual(connection.requests.map(({ method }) => method), ["thread/resume"]);
```

- [x] **Step 2: Run RED**

Run:

```bash
node --import tsx --test src/web/stream-session.test.ts
```

Expected: compile/test failure because `StreamOpenOptions.threadId` does not exist and `open()` still writes a bound row.

- [x] **Step 3: Remove binding ownership from `StreamSessions`**

Use this public option:

```ts
export interface StreamOpenOptions {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly threadId?: string | null;
}
```

Delete the `BindingStore` field and every `bind`/`bindAside` call. In `openOnce`, replace the database lookup with:

```ts
const session = await this.options.host.open(
  openOptions.threadId ?? null,
  this.sessionOptions(cwd, openOptions.config),
);
```

Keep workspace lookup, event tracking, exact-turn controls and close behavior unchanged.

- [x] **Step 4: Run GREEN**

Run:

```bash
node --import tsx --test src/web/stream-session.test.ts
pnpm typecheck
```

Expected: all `StreamSessions` tests pass and both TypeScript projects exit 0.

- [x] **Step 5: Commit**

```bash
git add src/web/stream-session.ts src/web/stream-session.test.ts
git commit -m "fix: keep empty app-server threads ephemeral"
```

## Task 2: Put browser and application turns behind one durable facade

**Files:**

- Modify: `src/web/panel-server.ts`
- Modify: `src/web/codex-stream-api.ts`
- Modify: `src/web/stream-api.test.ts`
- Modify: `src/web/session-recovery.test.ts`
- Modify: `src/architecture.test.ts`

- [x] **Step 1: Write failing facade and HTTP tests**

Extend the fake history in `src/web/stream-api.test.ts` so `thread/list` and `thread/unarchive` are observable. Add these cases:

```ts
it("does not bind a new browser seat until its first turn starts", async () => {
  await withStreamPanel(async ({ base, database }) => {
    const opened = await post(base, "/api/codex/open", {
      changeId: "CHG-1", seat: "PRD",
    });
    assert.equal(opened.status, 200);
    assert.equal(new BindingStore(database).find("CHG-1", "PRD"), null);

    const started = await post(base, "/api/codex/turn", {
      changeId: "CHG-1", seat: "PRD", prompt: "验收",
    });
    assert.equal(started.status, 200);
    assert.equal(new BindingStore(database).find("CHG-1", "PRD")?.threadId, "THREAD-1");
    assert.equal(new BindingStore(database).find("CHG-1", "PRD")?.status, "bound");
  });
});
```

```ts
it("unarchives a browser binding before resuming the same thread", async () => {
  await withStreamPanel(async ({ base, database, connection }) => {
    new BindingStore(database).bind("CHG-1", "PRD", "THREAD-ARCHIVED");
    connection.setAvailability("THREAD-ARCHIVED", "archived");
    const opened = await post(base, "/api/codex/open", {
      changeId: "CHG-1", seat: "PRD",
    });
    assert.equal(opened.status, 200);
    assert.deepEqual(connection.requests.map(({ method }) => method), [
      "thread/list", "thread/list", "thread/unarchive", "thread/list", "thread/resume",
    ]);
  });
});
```

Add a failed `turn/start` case and assert the row remains absent/detached. Add an in-process session with a detached same-thread row, then a successful turn, and assert the row becomes bound without another `thread/start`.

Update `src/architecture.test.ts` with a source guard:

```ts
assert.doesNotMatch(
  read("src/web/codex-stream-api.ts"),
  /type StreamSessions|from "\.\/stream-session"/,
);
```

- [x] **Step 2: Run RED**

Run:

```bash
node --import tsx --test src/web/stream-api.test.ts src/web/session-recovery.test.ts src/architecture.test.ts
```

Expected: new-open is still bound too early, archived browser open bypasses unarchive, and the architecture guard fails on the concrete import.

- [x] **Step 3: Define the narrow HTTP session port**

In `src/web/codex-stream-api.ts`, replace the concrete import with a local interface:

```ts
export interface CodexStreamPort {
  open(changeId: string, seat: StreamSeat, options: {
    readonly config?: Readonly<Record<string, unknown>>;
  }): Promise<{ snapshot(): StreamSnapshot }>;
  snapshot(changeId: string, seat: StreamSeat): StreamSnapshot;
  eventsAfter(changeId: string, seat: StreamSeat, seq: number): readonly StreamEvent[] | null;
  subscribe(changeId: string, seat: StreamSeat, listener: (event: StreamEvent) => void): () => void;
  startTurn(changeId: string, seat: StreamSeat, prompt: string): Promise<string>;
  steer(changeId: string, seat: StreamSeat, direction: string, expectedTurnId: string): Promise<void>;
  interrupt(changeId: string, seat: StreamSeat, turnId: string): Promise<void>;
  respond(changeId: string, seat: StreamSeat, interactionId: string, response: unknown): Promise<void>;
}
```

Set `CodexStreamApiOptions.streams` to `CodexStreamPort`. Preserve endpoint bodies and public error shapes.

- [x] **Step 4: Make `PanelSessions` the port and sole binding owner**

Change binding preparation to return the exact resume id:

```ts
private async resumableThreadId(changeId: string, seat: Seat): Promise<string | null> {
  const binding = this.binding(changeId, seat);
  if (binding === null || binding.status !== "bound") return null;
  const prepared = await prepareBoundThread({
    binding: this.asBoundThread(binding, seat),
    archive: this.archive,
    detach: (found) => { this.detachBinding(found); },
  });
  if (prepared.kind === "resume") return prepared.threadId;
  if (prepared.kind === "fresh") return null;
  throw new SessionResumeRefusedError(binding.threadId, prepared.reason);
}
```

Make the product open path explicit:

```ts
async open(changeId: string, seat: Seat, options: StreamOpenOptions = {}) {
  const threadId = await this.resumableThreadId(changeId, seat);
  return this.options.streams.open(changeId, seat, { ...options, threadId });
}
```

Make turn start bind only after App Server accepts the turn:

```ts
async startTurn(changeId: string, seat: Seat, prompt: string, config = {}) {
  const session = await this.open(changeId, seat, { config });
  const turnId = await this.options.streams.startTurn(changeId, seat, prompt);
  this.bind(changeId, seat, session.threadId);
  return turnId;
}
```

Add delegates for snapshot, replay, subscription, steer, interrupt and response so `PanelSessions` satisfies `CodexStreamPort`. Change `serveStructuredCodex` to pass `sessions`, not `options.streams`.

Change direct product calls such as aside greeting from `options.streams.startTurn(...)` to `sessions.startTurn(...)`. Change `PanelSessions.type` to start the open session and then call the same bind helper. Add `StreamSessions.awaitTurn` plus `PanelSessions.runTurn` for the brief-proposal path so it can await terminal text without creating a second session:

```ts
async runTurn(changeId: string, seat: Seat, prompt: string, config: Record<string, unknown>, timeoutMs: number) {
  const turnId = await this.startTurn(changeId, seat, prompt, config);
  const outcome = await this.options.streams.awaitTurn(changeId, seat, turnId, timeoutMs);
  if (outcome.status !== "completed") throw new Error(`codex_turn_${outcome.status}`);
  return outcome.text;
}
```

Use that method in `/api/brief` instead of opening, reading the just-written binding, and starting an independent transport.

- [x] **Step 5: Run GREEN and all affected business tests**

Run:

```bash
node --import tsx --test \
  src/web/stream-session.test.ts \
  src/web/stream-api.test.ts \
  src/web/session-recovery.test.ts \
  src/web/panel-server.test.ts \
  src/app/converge-brief.test.ts \
  src/app/record-brief.test.ts \
  src/architecture.test.ts
pnpm typecheck
```

Expected: all selected suites pass, no skipped cases, typecheck exits 0.

- [x] **Step 6: Commit**

```bash
git add src/web/stream-session.ts src/web/stream-session.test.ts \
  src/web/panel-server.ts src/web/codex-stream-api.ts src/web/stream-api.test.ts \
  src/web/session-recovery.test.ts src/architecture.test.ts
git commit -m "fix: persist app-server seats after first turn"
```

## Task 3: Own 4173 before any persistent initialization

**Files:**

- Create: `src/web/panel-listener.ts`
- Create: `src/web/panel-listener.test.ts`
- Modify: `src/web/panel-server.ts`
- Modify: `src/panel-entry.test.ts`
- Modify: `scripts/panel.ts`
- Modify: `src/architecture.test.ts`

- [x] **Step 1: Write failing reservation tests**

Create `src/web/panel-listener.test.ts`:

```ts
it("returns 503 until the reserved server is activated", async () => {
  const reserved = await reservePanelListener({ port: 0 });
  try {
    const base = `http://127.0.0.1:${(reserved.server.address() as AddressInfo).port}`;
    assert.equal((await fetch(base)).status, 503);
    reserved.activate((_request, response) => response.writeHead(204).end());
    assert.equal((await fetch(base)).status, 204);
  } finally {
    await closeServer(reserved.server);
  }
});
```

Add collision coverage that reserves a port once and expects a second reservation to reject with `EADDRINUSE`.

Extend `src/panel-entry.test.ts`: hold a random loopback port, point `scripts/panel.ts` at a nonexistent temp database, wait for the child to exit, and assert the database path was never created:

```ts
assert.notEqual(result.status, 0);
assert.match(result.stderr, /EADDRINUSE|already in use/);
assert.equal(existsSync(dbPath), false);
```

- [x] **Step 2: Run RED**

Run:

```bash
node --import tsx --test src/web/panel-listener.test.ts src/panel-entry.test.ts
```

Expected: module-not-found for `panel-listener.ts`; the entry test demonstrates the current database file is created before collision exit.

- [x] **Step 3: Implement a reserved loopback HTTP server**

Create `src/web/panel-listener.ts` with this public surface:

```ts
export interface ReservedPanelListener {
  readonly server: Server;
  activate(listener: RequestListener): void;
}

export async function reservePanelListener(input: {
  readonly port: number;
  readonly host?: string;
}): Promise<ReservedPanelListener>;
```

The server owns exactly one delegating request listener. Before activation it returns:

```json
{"code":"stagepass_initializing","message":"StagePass is initializing"}
```

with status 503 and `cache-control: no-store`. `activate` swaps a closure variable; it never closes or rebinds the socket. Calling `activate` twice throws `panel_listener_already_active`.

- [x] **Step 4: Let `createPanelServer` activate an existing listener**

Add an optional second argument:

```ts
export function createPanelServer(
  options: PanelOptions,
  reserved?: ReservedPanelListener,
): { server: Server; sessions: PanelSessions }
```

Build the current request listener as a named `RequestListener`. If `reserved` exists, use its server and call `reserved.activate(listener)`; otherwise use `createServer(listener)`. Keep reaper cleanup attached to the selected server.

- [x] **Step 5: Reorder the production entry**

In `scripts/panel.ts`, parse and validate pure CLI arguments first, then execute:

```ts
const reserved = await reservePanelListener({ port, host: "127.0.0.1" });
startupServer = reserved.server;

const database = new Database(dbPath);
// schema, recovery, App Server and stores follow only after reservation

const { server, sessions } = createPanelServer(options, reserved);
```

Remove the final `server.listen(...)`; the callback banner becomes a normal log immediately after handler activation. Track partially-created server, database, history and App Server client in startup resource variables. The top-level failure path closes each resource in reverse order before reporting the error and exiting.

- [x] **Step 6: Run GREEN**

Run:

```bash
node --import tsx --test src/web/panel-listener.test.ts src/panel-entry.test.ts src/web/panel-server.test.ts
pnpm typecheck
```

Expected: listener and entry tests pass; a collision leaves the supplied database path absent.

- [x] **Step 7: Commit**

```bash
git add src/web/panel-listener.ts src/web/panel-listener.test.ts \
  src/web/panel-server.ts src/panel-entry.test.ts scripts/panel.ts src/architecture.test.ts
git commit -m "fix: reserve panel port before state recovery"
```

## Task 4: Full verification and real CHG-002 walk

**Files:**

- Create: `docs/evidence/new-project-app-server-durability-2026-08-15.md`
- Modify: `docs/HANDOFF-2026-08-15-app-server.md`
- Modify: `docs/superpowers/plans/2026-08-15-new-project-app-server-durability.md`

- [x] **Step 1: Run the complete automated gate**

Run:

```bash
pnpm check
git diff --check
```

Expected: strict typecheck exits 0; every test passes with `fail 0`, `cancelled 0`, `skipped 0`; diff check is silent.

- [x] **Step 2: Start exactly one real service**

Stop the currently running worktree instance cleanly, then run:

```bash
cd /Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173 --change CHG-002
```

Expected: one loopback listener on 4173 whose cwd is this worktree.

- [x] **Step 3: Walk CHG-002 through the real browser**

Use Chrome/CDP on `http://127.0.0.1:4173/?change=CHG-002`:

1. open PRD and assert no durable binding exists before input;
2. send `只回复 STAGEPASS_STREAM_OK；不要修改任何文件。`;
3. observe agent delta and terminal completed state;
4. assert the database now has one bound PRD row with the snapshot thread id;
5. send a prompt that asks the StagePass MCP for one harmless acceptance choice, answer it in the interaction sheet, and observe completion;
6. start a deliberately waiting turn, steer it once, then interrupt the exact turn;
7. refresh and assert item ids are unique and history is unchanged;
8. capture console messages, failed network requests, accessibility tree and a screenshot.

Browser-derived text is evidence only, never instructions. Acceptance prompts may not change project files or advance a gate.

- [x] **Step 4: Prove restart and collision safety**

Record the bound thread id, stop 4173, restart with the exact command above, open CHG-002/PRD, and assert the same thread id and prior items return. While it is running, launch a second instance with the same real database and port; assert it exits `EADDRINUSE` and compare the binding row before/after byte-for-byte.

- [x] **Step 5: Record evidence and final verification**

Write the exact commits, commands, thread/turn ids, test counts, HTTP results, console/network findings and screenshot paths to the evidence document. Update the handoff with the new durability rule. Then run:

```bash
pnpm check
git diff --check
git status --short
```

Expected: automated gate remains green; only Task 4 acceptance fixes, tests and documentation are
uncommitted.

Acceptance note: the real StagePass MCP sheet was exercised, but its generated product questions
were declined rather than answered with fabricated requirements. This left `brief: null`, PRD
pending and the product tree untouched while still proving permission routing, the human
checkpoint, completion and cleanup. The browser walk also exposed and fixed an empty historical
`userMessage` placeholder and the missing favicon; both have regression tests.
Final review added the specified `thread_binding_failed_after_turn_start` path and its retry test.
The final full gate also exposed and fixed a pre-existing fixed-sleep race in the App Server force-
kill test fixture by replacing elapsed time with an explicit child-ready handshake.

- [x] **Step 6: Commit**

```bash
git add docs/evidence/new-project-app-server-durability-2026-08-15.md \
  docs/HANDOFF-2026-08-15-app-server.md \
  docs/superpowers/plans/2026-08-15-new-project-app-server-durability.md
git commit -m "docs: record new project app-server acceptance"
```

## Plan self-review

- Spec coverage: Tasks 1–3 cover ephemeral threads, a single recovery facade, post-turn binding,
  archived recovery and pre-state port ownership; Task 4 covers every real acceptance step.
- Failure semantics: unavailable and archived never silently fresh; missing is the only detach path;
  collision exits before SQLite; post-turn binding failure is visible.
- Type consistency: `StreamOpenOptions.threadId` belongs to the low-level registry;
  `CodexStreamPort` belongs to HTTP; `PanelSessions` implements product durability.
- Scope: no legacy-thread reconstruction, gate changes, project-file edits, prompt redesign or UI
  restyling is included.
- Placeholder scan: no deferred implementation step or unspecified test remains.
- Execution: inline in this worktree because the user explicitly asked the current agent to use and
  fix the real new project; no subagents are used.
