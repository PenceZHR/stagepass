# Native Codex TUI Terminal Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace StagePass's browser-rendered Codex stream with one durable official Codex remote TUI per `(Change, seat)`, displayed in macOS Terminal.app and controlled from the StagePass browser without losing the thread or TUI when the window closes.

**Architecture:** A managed Codex App Server daemon remains the durable thread/turn/history authority. StagePass observes it through `codex app-server proxy`, while tmux owns each long-lived official `codex resume --remote unix:// 019f0000-0000-7000-8000-000000000001` TUI and Terminal.app is only an attach/detach view. StagePass sends short file envelopes through tmux, never renders terminal bytes, and never answers approvals or MCP elicitations on behalf of the TUI.

**Tech Stack:** TypeScript 5.9, Node.js 25, Codex CLI 0.147.0 App Server, tmux, macOS Terminal.app/AppleScript, better-sqlite3, browser JavaScript, Node test runner.

---

## Locked file structure

New production modules have one responsibility each:

- `src/system/process.ts` — the only production module allowed to call Node `spawn`; supports short commands and supervised streaming children.
- `src/codex/app-server-daemon.ts` — starts the managed daemon and opens/closes the StagePass proxy client without stopping the daemon.
- `src/codex/prompt-file.ts` — writes detailed prompts to private temporary files and returns the short TUI envelope.
- `src/codex/tmux.ts` — deterministic tmux names, TUI creation, prompt paste, attach state, detach, and explicit termination.
- `src/system/terminal-app.ts` — fixed AppleScript and normalized Terminal.app window operations.
- `src/codex/native-tui-session.ts` — observes TUI-started turns and implements the Codex transport contract without calling `turn/start`.
- `src/web/native-sessions.ts` — maps StagePass `(Change, seat)` bindings to observer sessions, tmux sessions, and Terminal windows.
- `src/web/terminal-api.ts` — owns only `/api/terminal/*` HTTP parsing and error mapping.
- `src/web/terminal-bridge.js` — browser controller for status/open/focus/close/end; never receives terminal output.

Existing integration modules change only at their boundary: `src/codex/app-server-client.ts`, `src/codex/app-server-session.ts`, `src/codex/app-server-transport.ts`, `src/web/panel-server.ts`, `scripts/panel.ts`, `src/web/panel.html`, `src/web/panel.js`, `src/web/panel-globals.d.ts`, `tsconfig.panel.json`, `src/architecture.test.ts`, and `docs/CODEX-CONTRACT.md`.

The old browser stream files are deleted only after the native path is green: `src/web/codex-stream-api.ts`, `src/web/codex-stream.js`, `src/web/codex-stream.test.ts`, `src/web/stream-session.ts`, `src/web/stream-session.test.ts`, and `src/web/stream-api.test.ts`.

## Task 1: Prove and lock the native runtime prerequisites

**Files:**
- Modify: `docs/superpowers/plans/2026-08-15-native-tui-terminal-bridge.md` (check boxes and record observed versions only)

- [ ] **Step 1: Confirm the worktree boundary and port**

Run:

```bash
pwd
git status --short --branch
git -C /Users/zhanghr/Desktop/stagepass status --short --branch
lsof -nP -iTCP:4173 -sTCP:LISTEN
```

Expected: current directory ends in `native-streaming-app-server`, the experiment branch is `codex/native-streaming-app-server`, both trees have no unexpected changes, and no process listens on 4173.

- [ ] **Step 2: Install the approved tmux dependency**

```bash
brew install tmux
tmux -V
```

Expected: Homebrew completes and `tmux -V` prints a version.

- [ ] **Step 3: Verify the exact official daemon/proxy/remote interfaces**

```bash
codex app-server daemon start
codex app-server daemon version
codex app-server proxy --help
codex resume --help
```

Expected: daemon version returns JSON, proxy documents the managed socket, and resume accepts `unix://` plus a session id. If the CLI says remote control is disabled, use its official `codex app-server daemon enable-remote-control` command once and rerun; do not invent a socket path.

- [ ] **Step 4: Preserve the passing baseline**

```bash
pnpm check
```

Expected: 1,073 tests pass and typecheck succeeds. A sandbox-only loopback `EPERM` is rerun with the approved unsandboxed test command and is not accepted as a product failure.

## Task 2: Centralize child processes and connect through the managed daemon

**Files:**
- Create: `src/system/process.ts`
- Create: `src/system/process.test.ts`
- Create: `src/codex/app-server-daemon.ts`
- Create: `src/codex/app-server-daemon.test.ts`
- Modify: `src/codex/app-server-client.ts`
- Modify: `src/codex/app-server-client.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing process-boundary tests**

```ts
it("passes command arguments without a shell", async () => {
  const calls: ProcessRequest[] = [];
  const result = await runProcess(
    { command: "/usr/bin/printf", args: ["%s", "a b;$HOME"] },
    { spawn: fakeSpawn(calls, { code: 0, stdout: "a b;$HOME", stderr: "" }) },
  );
  assert.deepEqual(calls[0], {
    command: "/usr/bin/printf", args: ["%s", "a b;$HOME"], shell: false,
  });
  assert.equal(result.stdout, "a b;$HOME");
});
```

Add a daemon-owner test:

```ts
it("starts daemon, opens proxy, and never stops daemon on close", async () => {
  const runtime = await startManagedAppServer({ process: fakeProcess, client: fakeClient });
  await runtime.close();
  assert.deepEqual(fakeProcess.calls, [["codex", "app-server", "daemon", "start"]]);
  assert.deepEqual(fakeClient.args, ["app-server", "proxy"]);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/system/process.test.ts src/codex/app-server-daemon.test.ts
```

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Implement the process seam and daemon owner**

```ts
export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}
export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
export interface ProcessOps {
  run(request: ProcessRequest): Promise<ProcessResult>;
  spawn(request: Omit<ProcessRequest, "input">): ChildProcessWithoutNullStreams;
}
export function createProcessOps(): ProcessOps;
```

Every Node spawn uses `{ shell: false, stdio: ["pipe", "pipe", "pipe"] }`. `AppServerClient.spawn` accepts optional `processOps`. `startManagedAppServer` runs `codex app-server daemon start`, maps nonzero exit to `app_server_daemon_unavailable`, spawns `codex app-server proxy`, initializes it, and closes only the proxy.

- [ ] **Step 4: Update the architecture layer map and spawner guard**

Put both production modules in layer 2 and assert:

```ts
it("only the system process boundary calls Node spawn", () => {
  const spawners = production
    .filter((file) => /\bspawn\s*\(/.test(withoutComments(file.text)))
    .map((file) => file.path);
  assert.deepEqual(spawners, ["system/process.ts"]);
});
```

- [ ] **Step 5: Validate and commit**

```bash
node --import tsx --test --test-concurrency=1 src/system/process.test.ts src/codex/app-server-client.test.ts src/codex/app-server-daemon.test.ts src/architecture.test.ts
pnpm typecheck
git add src/system/process.ts src/system/process.test.ts src/codex/app-server-daemon.ts src/codex/app-server-daemon.test.ts src/codex/app-server-client.ts src/codex/app-server-client.test.ts src/architecture.test.ts
git commit -m "feat: connect StagePass through managed app server"
```

Expected: focused tests and typecheck pass.

## Task 3: Put every detailed prompt in a private file

**Files:**
- Create: `src/codex/prompt-file.ts`
- Create: `src/codex/prompt-file.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write the failing prompt-file contract tests**

```ts
it("writes the full prompt privately and returns only a short envelope", () => {
  const files = createPromptFiles({ root: temporaryRoot });
  const prompt = "一段非常详尽的任务说明\n".repeat(200);
  const written = files.create(prompt);
  assert.equal(readFileSync(written.path, "utf8"), prompt);
  assert.equal(statSync(written.path).mode & 0o777, 0o600);
  assert.doesNotMatch(written.envelope, /一段非常详尽/);
  assert.match(written.envelope, new RegExp(escapeRegExp(written.path)));
  written.release();
  assert.equal(existsSync(written.path), false);
});
```

Also test blank prompts, NUL bytes, and idempotent `release()`.

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/codex/prompt-file.test.ts
```

Expected: FAIL because `createPromptFiles` is missing.

- [ ] **Step 3: Implement the exact contract**

```ts
export interface PromptFile {
  readonly path: string;
  readonly envelope: string;
  release(): void;
}
export interface PromptFiles { create(prompt: string): PromptFile; }
```

Create `stagepass-prompt-*` under `tmpdir()`, write `prompt.md` with mode `0o600`, and use the fixed envelope form `请先完整读取这个 UTF-8 文件，并把文件内容作为本轮完整任务执行：/private/tmp/stagepass-prompt-8h2k/prompt.md`. The runtime substitutes only the created absolute path. Reject blank/NUL input. Release only after the observed turn reaches a terminal state.

- [ ] **Step 4: Validate and commit**

```bash
node --import tsx --test --test-concurrency=1 src/codex/prompt-file.test.ts src/architecture.test.ts
pnpm typecheck
git add src/codex/prompt-file.ts src/codex/prompt-file.test.ts src/architecture.test.ts
git commit -m "feat: deliver detailed prompts through private files"
```

## Task 4: Build the deterministic tmux owner

**Files:**
- Create: `src/codex/tmux.ts`
- Create: `src/codex/tmux.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing naming, paste, and lifecycle tests**

```ts
it("derives an opaque stable name", () => {
  const name = tmuxSessionName("CHG / 有空格", "PRD");
  assert.match(name, /^sp_[0-9a-f]{20}$/);
  assert.equal(name, tmuxSessionName("CHG / 有空格", "PRD"));
  assert.doesNotMatch(name, /CHG|PRD|有空格/);
});

it("pastes before sending Enter as a separate command", async () => {
  await tmux.submit(
    "sp_0123456789abcdef0123",
    "请先读取：/private/tmp/stagepass-prompt-1/prompt.md",
  );
  assert.deepEqual(calls.map(({ args }) => args[0]), [
    "load-buffer", "paste-buffer", "send-keys",
  ]);
  assert.equal(calls[2]!.args.at(-1), "Enter");
});
```

Also prove `has-session` exit 1 means absent; concurrent ensure creates once; TUI command contains no prompt/title/path; close/detach never kills; explicit end kills once; and errors are `tmux_unavailable`, `tmux_command_failed`, `invalid_thread_id`.

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/codex/tmux.test.ts
```

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the tmux port**

```ts
export interface TmuxIdentity { readonly changeId: string; readonly seat: string; }
export interface TmuxSession { readonly name: string; readonly marker: string; }
export interface TmuxOps {
  version(): Promise<string>;
  status(identity: TmuxIdentity): Promise<"absent" | "detached" | "attached">;
  ensureSession(identity: TmuxIdentity, threadId: string, cwd: string): Promise<TmuxSession>;
  submit(sessionName: string, envelope: string): Promise<void>;
  detach(sessionName: string): Promise<void>;
  endSession(sessionName: string): Promise<void>;
}
```

Use SHA-256 for the 20-hex suffix. Validate thread ids as UUIDs and names as `^sp_[0-9a-f]{20}$`. The concrete argv shape is `tmux new-session -d -s sp_0123456789abcdef0123 -c /Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server "exec codex resume --remote unix:// '019f0000-0000-7000-8000-000000000001'"`; runtime project values occupy the same `-c` argv position. Test POSIX single-quote encoding for spaces, quotes, dollar signs, semicolons, newlines, and backticks. Only the validated UUID enters the shell-command; cwd remains a `-c` argv.

Prompt submission is exactly `load-buffer -b sp_input -` with the short envelope on stdin, `paste-buffer -d -b sp_input -t sp_0123456789abcdef0123`, then `send-keys -t sp_0123456789abcdef0123 Enter`; the runtime substitutes the validated session name. The detailed prompt remains only in its private file.

- [ ] **Step 4: Validate and commit**

```bash
node --import tsx --test --test-concurrency=1 src/codex/tmux.test.ts src/architecture.test.ts
pnpm typecheck
git add src/codex/tmux.ts src/codex/tmux.test.ts src/architecture.test.ts
git commit -m "feat: own durable Codex TUI sessions with tmux"
```

## Task 5: Control only the marked Terminal.app window

**Files:**
- Create: `src/system/terminal-app.ts`
- Create: `src/system/terminal-app.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing Terminal controller tests**

```ts
it("passes action, marker, and attach command as osascript argv", async () => {
  await terminal.open({
    marker: "STAGEPASS:sp_0123456789abcdef0123",
    sessionName: "sp_0123456789abcdef0123",
  });
  assert.equal(calls[0]!.command, "/usr/bin/osascript");
  assert.deepEqual(calls[0]!.args.slice(-3), [
    "open",
    "STAGEPASS:sp_0123456789abcdef0123",
    "exec tmux attach-session -t sp_0123456789abcdef0123",
  ]);
});
```

Add tests that focus/close fail closed on multiple marker matches, no OS window id is reused across calls, and Apple event `-1743` maps to `terminal_automation_denied`.

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/system/terminal-app.test.ts
```

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the fixed AppleScript boundary**

```ts
export type TerminalWindowState = "closed" | "open";
export interface TerminalTarget {
  readonly marker: string;
  readonly sessionName: string;
}
export interface TerminalAppOps {
  status(target: TerminalTarget): Promise<TerminalWindowState>;
  open(target: TerminalTarget): Promise<"opened" | "focused">;
  focus(target: TerminalTarget): Promise<void>;
  close(target: TerminalTarget): Promise<"closed" | "already_closed">;
}
```

The embedded AppleScript receives `[action, marker, attachCommand]` through `on run argv`, discovers tabs by exact `custom title`, gives a new tab the marker, activates Terminal for open/focus, and closes only a unique marked target. It prints one JSON object. Dynamic free text is forbidden; validate marker/name before creating the fixed attach command. Zero matches means closed; multiple matches yield `terminal_window_ambiguous` without mutation.

- [ ] **Step 4: Validate offline**

```bash
node --import tsx --test --test-concurrency=1 src/system/terminal-app.test.ts src/architecture.test.ts
pnpm typecheck
```

Expected: all pass without launching Terminal because the process seam is fake.

- [ ] **Step 5: Run the narrow real Terminal smoke test**

Add one opt-in test named `real marked window survives close` to `terminal-app.test.ts`. It creates `sp_00000000000000000000`, runs production open/focus/close, asserts `tmux has-session -t sp_00000000000000000000`, and kills that exact disposable session in `finally`. Run:

```bash
STAGEPASS_TERMINAL_SMOKE=1 node --import tsx --test --test-name-pattern="real marked window survives close" src/system/terminal-app.test.ts
```

Expected: focus does not duplicate the window, close removes only the marked window, and tmux remains.

- [ ] **Step 6: Commit**

```bash
git add src/system/terminal-app.ts src/system/terminal-app.test.ts src/architecture.test.ts
git commit -m "feat: control marked macOS Terminal windows"
```

## Task 6: Observe turns started by the official TUI

**Files:**
- Modify: `src/codex/app-server-session.ts`
- Modify: `src/codex/app-server-session.test.ts`
- Create: `src/codex/native-tui-session.ts`
- Create: `src/codex/native-tui-session.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing external-turn tests**

```ts
it("waits for a turn newer than the baseline", async () => {
  const waiting = session.awaitNextTurn("TURN-OLD", 1_000);
  connection.emit("turn/started", { threadId: THREAD_ID, turn: { id: "TURN-NEW" } });
  assert.equal(await waiting, "TURN-NEW");
});

it("submits through tmux and never calls App Server turn/start", async () => {
  const delivery = runtime.runTurn({ threadId: THREAD_ID, prompt: "full prompt" });
  connection.emit("turn/started", { threadId: THREAD_ID, turn: { id: "TURN-TUI" } });
  connection.emit("turn/completed", {
    threadId: THREAD_ID,
    turn: { id: "TURN-TUI", status: "completed", items: [agent("done")] },
  });
  assert.equal((await delivery).text, "done");
  assert.equal(connection.calls.some(({ method }) => method === "turn/start"), false);
});
```

Also test busy baseline, timeout, failed/interrupted completion, duplicate notification, prompt-file cleanup after completion, and disconnect while waiting.

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/codex/app-server-session.test.ts src/codex/native-tui-session.test.ts
```

Expected: FAIL because `awaitNextTurn` and native transport are missing.

- [ ] **Step 3: Add the observer primitive**

```ts
awaitNextTurn(afterTurnId: string | null, timeoutMs: number): Promise<string>;
```

Resolve only on a new `turn.started`, unregister on every exit, and throw `turn_start_timeout` on timeout.

- [ ] **Step 4: Implement the TUI-backed transport**

```ts
export interface NativeTuiTurnPort {
  ensure(identity: TmuxIdentity, threadId: string, cwd: string): Promise<TmuxSession>;
  submit(sessionName: string, envelope: string): Promise<void>;
}
export class NativeTuiCodexTransport implements CodexTransport {
  runTurn(dispatch: TurnDispatch): Promise<TurnDelivery>;
}
```

`runTurn` starts/resumes the observer with per-thread config; calls `onThread`; captures `lastTurnId`; rejects an active turn; creates the prompt file; ensures tmux; submits only the envelope; awaits the new exact turn and its terminal state; returns normalized text or the existing failure class; and releases the prompt file in `finally`.

The StagePass proxy's reverse-request handler returns `interaction_owner_is_native_tui`; it never answers or rejects on the TUI's behalf and never creates a browser interaction sheet.

- [ ] **Step 5: Validate and commit**

```bash
node --import tsx --test --test-concurrency=1 src/codex/app-server-session.test.ts src/codex/native-tui-session.test.ts src/architecture.test.ts
pnpm typecheck
git add src/codex/app-server-session.ts src/codex/app-server-session.test.ts src/codex/native-tui-session.ts src/codex/native-tui-session.test.ts src/architecture.test.ts
git commit -m "feat: observe turns owned by native Codex TUI"
```

## Task 7: Map StagePass seats to thread, tmux, and Terminal state

**Files:**
- Create: `src/web/native-sessions.ts`
- Create: `src/web/native-sessions.test.ts`
- Modify: `src/web/session-recovery.ts`
- Modify: `src/web/session-recovery.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it("binds on explicit open and reuses thread and tmux", async () => {
  const first = await sessions.open("CHG-1", "PRD", config, { showTerminal: true });
  const second = await sessions.open("CHG-1", "PRD", config, { showTerminal: true });
  assert.equal(first.threadId, second.threadId);
  assert.equal(first.tmuxSession, second.tmuxSession);
  assert.equal(appServer.startedThreads, 1);
  assert.equal(tmux.created.length, 1);
});

it("close-window preserves binding and tmux", async () => {
  const opened = await sessions.open("CHG-1", "PRD", config, { showTerminal: true });
  await sessions.closeWindow("CHG-1", "PRD");
  assert.equal(await tmux.status(identity), "detached");
  assert.equal(bindings.find("CHG-1", "PRD")?.threadId, opened.threadId);
  assert.equal(appServer.archived.length, 0);
});
```

Also cover archived reuse, explicit missing detach/replacement, unavailable preservation, missing-tmux recreation on the same thread, restart reconstruction with empty memory, concurrent open, per-seat input lease, prompt-file retention until externally started turn completion, release-without-kill, end-with-binding-preserved, archive-and-end, and Change-scoped forget.

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/web/native-sessions.test.ts src/web/session-recovery.test.ts
```

Expected: FAIL because `NativeSessions` is missing.

- [ ] **Step 3: Implement the normalized state and port**

```ts
export type NativeSeat = Exclude<Phase, "Done"> | "aside";
export interface NativeSessionStatus {
  readonly changeId: string;
  readonly seat: NativeSeat;
  readonly threadId: string | null;
  readonly thread: "none" | "idle" | "running" | "archived" | "missing" | "unavailable";
  readonly tmuxSession: string;
  readonly tmux: "absent" | "detached" | "attached" | "unavailable";
  readonly terminal: "closed" | "open" | "unavailable";
  readonly action: "open" | "focus" | "reopen";
}
export interface NativeSessionsPort {
  status(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus>;
  open(changeId: string, seat: NativeSeat, config: Readonly<Record<string, unknown>>, options: { readonly showTerminal: boolean }): Promise<NativeSessionStatus>;
  focus(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus>;
  closeWindow(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus>;
  endSession(changeId: string, seat: NativeSeat): Promise<NativeSessionStatus>;
  archiveAndEnd(changeId: string, seat: NativeSeat): Promise<void>;
  releaseObserver(changeId: string, seat: NativeSeat): void;
  forget(changeId: string): Promise<void>;
  closeControlConnection(): void;
}
```

Bind a new thread before opening Terminal; a failed binding is a named error. Keep the deterministic tmux name in absent status. Never persist a window id or tmux state.

Keep pending prompt files in the in-memory seat entry keyed by observed turn id. Release each file on terminal completion or explicit dispatch failure; `releaseObserver` must first attach a completion cleanup listener so a still-running TUI turn does not leak its file merely because StagePass released the foreground observer.

- [ ] **Step 4: Make recovery state-driven**

Keep `prepareBoundThread` as the sole open/archived/missing classifier. Combine binding result, `tmux.status`, and `terminal.status`. Startup inspection may report but must not kill tmux or detach on unavailable. Explicit open may recreate missing tmux on the same thread.

- [ ] **Step 5: Validate and commit**

```bash
node --import tsx --test --test-concurrency=1 src/web/native-sessions.test.ts src/web/session-recovery.test.ts src/architecture.test.ts
pnpm typecheck
git add src/web/native-sessions.ts src/web/native-sessions.test.ts src/web/session-recovery.ts src/web/session-recovery.test.ts src/architecture.test.ts
git commit -m "feat: bind StagePass seats to durable native TUI sessions"
```

## Task 8: Expose the terminal bridge API without terminal bytes

**Files:**
- Create: `src/web/terminal-api.ts`
- Create: `src/web/terminal-api.test.ts`
- Modify: `src/web/panel-server.ts`
- Modify: `src/web/panel-server.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing route tests**

```ts
it("close-window preserves runtime while end-session terminates it", async () => {
  assert.equal((await post("/api/terminal/close-window", identity)).status, 200);
  assert.equal(fakeNative.ended.length, 0);
  assert.equal(fakeNative.closedWindows.length, 1);
  assert.equal((await post("/api/terminal/end-session", identity)).status, 200);
  assert.equal(fakeNative.ended.length, 1);
});
```

Test all routes, invalid identity/method/body size, idempotence, and mappings: `tmux_unavailable`/`terminal_automation_denied` → 503, `terminal_window_ambiguous`/`turn_busy` → 409, `no_such_change` → 404, invalid request/seat → 400. Old `/api/terminal?change=&phase=` and `/api/codex/*` write routes must return 404 after cutover.

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/web/terminal-api.test.ts src/web/panel-server.test.ts
```

Expected: FAIL because the new routes are missing.

- [ ] **Step 3: Implement the route-only API**

```ts
export async function serveTerminalApi(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly sessions: NativeSessionsPort;
    readonly configFor: (changeId: string, seat: NativeSeat) => Readonly<Record<string, unknown>>;
  },
): Promise<boolean>;
```

Own exactly `GET /api/terminal/status?change=&seat=` and POST `/api/terminal/open`, `/focus`, `/close-window`, `/end-session`. POST bodies are `{ "changeId": "...", "seat": "PRD" }`. Responses contain only normalized state, never screen text, ANSI, prompt, RPC, environment, or window ids.

- [ ] **Step 4: Delegate from panel server without raising ratchets**

Add `nativeSessions` to `PanelOptions`, call `serveTerminalApi` before business routes, and delete the old `/api/terminal` block. If `handle()` grows, extract an existing helper rather than raising the line ratchet.

- [ ] **Step 5: Validate and commit**

```bash
node --import tsx --test --test-concurrency=1 src/web/terminal-api.test.ts src/web/panel-server.test.ts src/architecture.test.ts
pnpm typecheck
git add src/web/terminal-api.ts src/web/terminal-api.test.ts src/web/panel-server.ts src/web/panel-server.test.ts src/architecture.test.ts
git commit -m "feat: expose native Terminal lifecycle API"
```

## Task 9: Cut every StagePass turn over to the native TUI owner

**Files:**
- Modify: `src/web/panel-server.ts`
- Modify: `src/web/panel-server.test.ts`
- Modify: `scripts/panel.ts`
- Modify: `src/codex/app-server-transport.ts`
- Modify: `src/codex/app-server-transport.test.ts`
- Modify: `src/codex/transport.ts`
- Modify: `src/codex/turn-runner.test.ts`
- Modify: `src/work/round-turn-runner.test.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing end-to-end routing tests**

Exercise the real `/api/run` seam with fakes and prove:

```ts
assert.equal(connection.calls.some(({ method }) => method === "turn/start"), false);
assert.equal(nativeTui.submissions.length, 1);
assert.equal(nativeTui.submissions[0]!.seat, "PRD");
assert.match(readFileSync(promptFiles.created[0]!.path, "utf8"), /rubric/);
```

Add approval coverage:

```ts
assert.deepEqual(nativeSessions.archivedAndEnded, [
  { changeId: "CHG-1", seat: "PRD" },
]);
```

Prove routine business cleanup calls `releaseObserver`, while approved gate/delete calls `archiveAndEnd`/`forget`.

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/web/panel-server.test.ts src/codex/app-server-transport.test.ts src/codex/turn-runner.test.ts src/work/round-turn-runner.test.ts
```

Expected: FAIL because production still dispatches direct App Server `turn/start`.

- [ ] **Step 3: Replace the panel runtime seam**

Replace `streams + appServerTransport` in `PanelOptions` with:

```ts
readonly nativeSessions: NativeSessions;
```

`PanelSessions` stays the StagePass facade and exposes:

```ts
transportFor(changeId, seat, config, timeoutMs): CodexTransport;
openForChat(changeId, seat, config): Promise<void>;
startTurn(changeId, seat, prompt, config): Promise<string>;
runTurn(changeId, seat, prompt, config, timeoutMs): Promise<string>;
releaseObserver(changeId, seat): void;
archiveAndEnd(changeId, seat): Promise<void>;
```

Keep `has`, `active`, `quietForMs`, `recordCount`, and `turnEnded` backed by native state plus `AppServerHistory`. Rename internal `close` calls to `releaseObserver`; it must not close a Terminal window or kill tmux.

- [ ] **Step 4: Wire managed runtime in `scripts/panel.ts`**

```ts
const appServer = await startManagedAppServer({
  command: "codex",
  cwd: process.cwd(),
  onServerRequest: async () => {
    throw new AppServerError(
      "interaction_owner_is_native_tui", "native TUI owns interactions",
    );
  },
});
const history = new AppServerHistory(appServer.client);
const nativeSessions = new NativeSessions({
  database,
  host: new AppServerSessionHost(appServer.client),
  history,
  tmux: createTmux(),
  terminal: createTerminalApp(),
  promptFiles: createPromptFiles(),
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  effort,
  ...(model === undefined ? {} : { model }),
});
```

SIGINT/SIGTERM closes HTTP, DB, history subscription, and proxy control connection only. It does not stop daemon, kill tmux, close Terminal, archive, or delete binding.

- [ ] **Step 5: Update archive and delete ownership**

Approved gate calls `archiveFinished` then `nativeSessions.archiveAndEnd(changeId, phase)`. Change/project delete calls `nativeSessions.forget` before deleting bindings and reports cleanup failure rather than claiming success.

- [ ] **Step 6: Validate and commit**

```bash
node --import tsx --test --test-concurrency=1 src/web/panel-server.test.ts src/codex/app-server-transport.test.ts src/codex/turn-runner.test.ts src/work/round-turn-runner.test.ts src/app/decide-gate.test.ts src/app/workspace.test.ts src/architecture.test.ts
pnpm typecheck
git add src/web/panel-server.ts src/web/panel-server.test.ts scripts/panel.ts src/codex/app-server-transport.ts src/codex/app-server-transport.test.ts src/codex/transport.ts src/codex/turn-runner.test.ts src/work/round-turn-runner.test.ts src/architecture.test.ts
git commit -m "feat: route every StagePass turn through native Codex TUI"
```

## Task 10: Replace browser stream with the art-matched terminal portal

**Files:**
- Create: `src/web/terminal-bridge.js`
- Create: `src/web/terminal-bridge.test.ts`
- Modify: `src/web/panel.html`
- Modify: `src/web/panel.js`
- Modify: `src/web/panel-globals.d.ts`
- Modify: `tsconfig.panel.json`
- Modify: `src/web/panel-server.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: Write failing browser-controller tests**

```ts
it("renders reopen when tmux lives but Terminal is closed", async () => {
  const view = fixture(status({ tmux: "detached", terminal: "closed", action: "reopen" }));
  await view.controller.refresh();
  assert.equal(view.primary.textContent, "重新打开终端");
  assert.match(view.summary.textContent, /Codex 仍在后台继续/);
});

it("close window never calls end-session", async () => {
  const view = fixture(status({ terminal: "open", action: "focus" }));
  await view.controller.refresh();
  view.close.dispatch("click");
  await tick();
  assert.equal(view.calls.at(-1)?.path, "/api/terminal/close-window");
});
```

Also cover open/focus labels, unavailable errors, destructive confirmation for end-session, polling cleanup, and absence of EventSource/composer behavior.

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/web/terminal-bridge.test.ts
```

Expected: FAIL because the controller is missing.

- [ ] **Step 3: Implement the lifecycle-only controller**

```js
export function createTerminalBridge({
  changeId, seat, primary, closeWindow, endSession, summary,
  fetchImpl = fetch, confirmImpl = confirm, pollMs = 2000,
}) {
  return {
    async refresh() {},
    async openOrFocus() {},
    close() {},
  };
}
```

It consumes only `NativeSessionStatus`; never EventSource, WebSocket, escape handling, keyboard forwarding, prompt input, interaction form, or JSON-RPC.

- [ ] **Step 4: Replace markup in the existing visual language**

```html
<section class="terminal-portal" id="terminal-portal" aria-live="polite">
  <div class="terminal-portal__halo" aria-hidden="true"></div>
  <p class="terminal-portal__kicker">SYSTEM TERMINAL · OFFICIAL CODEX TUI</p>
  <h2 id="terminal-title">原生会话在系统终端中运行</h2>
  <p id="terminal-summary"></p>
  <div class="terminal-portal__actions">
    <button class="enter" id="terminal-primary" type="button">打开终端</button>
    <button class="back" id="terminal-close-window" type="button" hidden>关闭终端窗口</button>
    <button class="terminal-danger" id="terminal-end-session" type="button">结束会话</button>
  </div>
</section>
```

Reuse cloud-sea background, sand variables, halo/portal motion, translucent border, serif display hierarchy, and reduced-motion rules. Do not add a black terminal rectangle or generic dashboard card. Explicitly explain that window close leaves Codex running in tmux.

- [ ] **Step 5: Rewire browser integration**

Remove `createCodexStream`, composer lookups, and interaction dialog. `enter(phase)` creates the terminal bridge and calls `openOrFocus()` after the portal animation; `leave()` stops polling only. `openAside()` uses seat `aside`. Serve `/terminal-bridge.js`, remove `/codex-stream.js`, and typecheck the new file.

- [ ] **Step 6: Validate and commit**

```bash
node --import tsx --test --test-concurrency=1 src/web/terminal-bridge.test.ts src/architecture.test.ts
pnpm typecheck
git add src/web/terminal-bridge.js src/web/terminal-bridge.test.ts src/web/panel.html src/web/panel.js src/web/panel-globals.d.ts tsconfig.panel.json src/web/panel-server.ts src/architecture.test.ts
git commit -m "feat: replace browser stream with native terminal portal"
```

## Task 11: Delete the browser-owned Codex path and tighten guards

**Files:**
- Delete: `src/web/codex-stream-api.ts`
- Delete: `src/web/codex-stream.js`
- Delete: `src/web/codex-stream.test.ts`
- Delete: `src/web/stream-session.ts`
- Delete: `src/web/stream-session.test.ts`
- Delete: `src/web/stream-api.test.ts`
- Modify: `src/codex/app-server-session.ts`
- Modify: `src/codex/app-server-session.test.ts`
- Modify: `src/codex/app-server-transport.ts`
- Modify: `src/codex/app-server-transport.test.ts`
- Modify: `src/architecture.test.ts`
- Modify: `docs/CODEX-CONTRACT.md`

- [ ] **Step 1: Add the new standing guards before deletion**

```ts
describe("standing · official native TUI owns interaction", () => {
  it("has no browser terminal renderer or browser Codex writer", () => {
    const forbidden = [
      "node-pty", "@xterm", "EventSource", "/api/codex/turn",
      "/api/codex/steer", "/api/codex/interrupt", "/api/codex/respond",
      "turn/start",
    ];
    const found = production.flatMap((file) => forbidden
      .filter((token) => withoutComments(file.text).includes(token))
      .map((token) => `${file.path}: ${token}`));
    assert.deepEqual(found, []);
  });
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test --test-concurrency=1 src/architecture.test.ts
```

Expected: FAIL and list only obsolete browser/direct-turn modules.

- [ ] **Step 3: Delete obsolete modules and writers**

Before removing exports, run:

```bash
rg -n "codex-stream|StreamSessions|serveCodexStreamApi|AppServerCodexTransport|startTurn\(|\.steer\(|\.respond\(" src scripts
```

Delete the six stream files. Remove direct `startTurn`, `steer`, `interrupt`, and `respond` from the production observer once no caller remains. Remove `AppServerCodexTransport` and browser reverse-interaction routing; retain start/resume observation, next-turn waiting, history, archive/unarchive.

- [ ] **Step 4: Rewrite the Codex contract**

Document: daemon owns thread/turn/history; StagePass proxy starts/resumes/reads/archives but does not own interactions; official TUI starts turns and owns approval/MCP/Ctrl+C; tmux survives window/StagePass shutdown; window close is detach only; detailed prompts are private files; there is no rollout/state DB fallback or screen parsing.

- [ ] **Step 5: Validate and commit**

```bash
pnpm check
git add -A src/web src/codex src/architecture.test.ts docs/CODEX-CONTRACT.md
git commit -m "refactor: remove browser-owned Codex interaction path"
```

## Task 12: Verify real recovery, native interaction, and only port 4173

**Files:**
- Modify: `docs/HANDOFF-2026-08-15-app-server.md`
- Modify: `README.md` only if it contains the panel command

- [ ] **Step 1: Run complete static and automated verification**

```bash
git diff --check
pnpm typecheck
pnpm test
rg -n "codex-stream|/api/codex/(turn|steer|interrupt|respond)|node-pty|@xterm|rollout-|state_5\.sqlite" src scripts
```

Expected: checks pass and forbidden production search has no results.

- [ ] **Step 2: Confirm original worktree stayed untouched**

```bash
git -C /Users/zhanghr/Desktop/stagepass status --short --branch
git status --short --branch
```

Expected: original has exactly its prior branch/ahead state and no file changes; experiment contains this work only.

- [ ] **Step 3: Start only the experiment on 4173 with real data**

```bash
lsof -nP -iTCP:4173 -sTCP:LISTEN
pnpm panel -- --port 4173 --db /Users/zhanghr/.stagepass/panel.db
```

Expected: exactly one `127.0.0.1:4173` listener, never `0.0.0.0`, and passive page load creates no thread/tmux/window.

- [ ] **Step 4: Run the real acceptance matrix**

For one selected Change/seat:

1. passive view creates nothing;
2. “打开终端” creates one binding, tmux, Terminal window, and official TUI;
3. second click focuses only;
4. native colors, arrows, slash commands, MCP approval, StagePass elicitation, Ctrl+C work;
5. a real task reads its detailed prompt file;
6. closing Terminal leaves tmux and active turn;
7. reopening returns to the same thread/TUI;
8. StagePass restart reconstructs the state;
9. Terminal.app quit/reopen returns to the same tmux/thread;
10. daemon restart resumes the configured thread before TUI reconnect;
11. explicit end kills tmux/window but leaves binding resumable;
12. stage approval archives and cleans tmux/window;
13. unrelated Terminal windows are never focused or closed.

- [ ] **Step 5: Record handoff and restart command**

Record branch/final commit, the real database path without any token or environment secret, tmux/Codex versions, exact single-4173 command, acceptance results, Automation permission instruction, and rollback (stop experiment listener, restart original worktree, no merge).

- [ ] **Step 6: Final verification and handoff commit**

```bash
pnpm check
git diff --check
git add docs/HANDOFF-2026-08-15-app-server.md README.md
git commit -m "docs: hand off native TUI terminal runtime"
git status --short --branch
```

Expected: full suite passes, experiment tree is clean, and original tree is untouched. If `README.md` did not change, omit it from `git add`.

## Rollback boundary

Each task is an atomic commit on `codex/native-streaming-app-server`. Rollback never uses `git reset --hard` and never edits the original worktree. Stop the single experiment listener on 4173, detach or explicitly end only tmux sessions matching `^sp_[0-9a-f]{20}$` that this branch can map back to a binding, and use ordinary `git revert` for experiment commits. The daemon and Codex history are not deleted by rollback.
