# Remove tmux From Native TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex App Server daemon the only durable session owner and use Terminal.app as a disposable `codex resume --remote unix://` client, with no tmux production dependency.

**Architecture:** StagePass keeps the durable `(Change, seat) -> threadId` binding and observes the daemon over its Unix-socket WebSocket. Terminal.app opens, focuses, submits to, closes, and resumes a uniquely marked official Codex TUI; closing a window never changes the binding. Detailed prompts remain private files and only their short envelopes reach the TUI.

**Tech Stack:** TypeScript, Node.js, Codex App Server WebSocket, macOS Terminal AppleScript, `node:test`, SQLite, browser ES modules.

**Design:** `docs/superpowers/specs/2026-08-16-native-tui-without-tmux-design.md`

---

## File map

- `src/system/terminal-app.ts`: deterministic marker, validated `codex resume` command, native window status/open/focus/submit/close.
- `src/system/terminal-app.test.ts`: argv, quoting, stale tab, ambiguity, permission and lifecycle tests.
- `src/web/native-sessions.ts`: binding/thread lifecycle and prompt delivery through Terminal only.
- `src/web/native-sessions.test.ts`: same-thread close/resume, input lease, prompt-file lifetime and cleanup ownership.
- `src/web/terminal-api.ts`: status/open/focus/close-window contract; no end-session.
- `src/web/terminal-bridge.js`: browser rendering for open/focus/resume; no tmux or destructive end button.
- `src/web/panel.html`: remove end-session control and tmux wording.
- `scripts/panel.ts`: remove tmux construction/version gate.
- `src/codex/native-tui-owner.ts`: reject reverse requests on StagePass's observational control connection.
- `src/codex/tmux.ts`, `src/codex/tmux.test.ts`, `src/codex/native-tui-session.ts`, `src/codex/native-tui-session.test.ts`: delete after consumers migrate.
- `src/architecture.test.ts`: enforce zero tmux production references and retain native-TUI ownership rules.

### Task 1: Replace the tmux attach command with a disposable Terminal client

**Files:**
- Modify: `src/system/terminal-app.test.ts`
- Modify: `src/system/terminal-app.ts`

- [x] **Step 1: Write the failing Terminal contract tests**

Replace the tmux target with:

```ts
const TARGET = {
  marker: "STAGEPASS:sp_0123456789abcdef0123",
  threadId: "019f0000-0000-7000-8000-000000000001",
  cwd: "/repo with space",
} as const;
```

Assert these behaviors:

```ts
assert.equal(await terminal.open(TARGET), "opened");
assert.match(command, /^exec codex resume -c 'tui\.terminal_title=\[\]' --remote unix:\/\//);
assert.match(command, /--cd '\/repo with space'/);
assert.match(command, /019f0000-0000-7000-8000-000000000001/);
assert.doesNotMatch(command, /tmux/);
assert.equal(await terminal.status(TARGET), "stale");
assert.equal(await terminal.open(TARGET, "read /tmp/prompt.md"), "resumed");
assert.equal(await terminal.submit(TARGET, "read /tmp/prompt.md"), "submitted");
```

Also assert invalid UUID, non-absolute cwd, newline/NUL envelope, malformed marker, duplicate marker and denied Automation fail before unsafe mutation.

- [x] **Step 2: Run the Terminal tests and confirm RED**

Run:

```bash
node --import tsx --test --test-concurrency=1 src/system/terminal-app.test.ts
```

Expected: compile/assertion failures because `TerminalTarget` still requires `sessionName`, has no `stale` or `submit`, and generates `tmux attach-session`.

- [x] **Step 3: Implement the minimal Terminal client**

Expose this contract:

```ts
export type TerminalWindowState = "closed" | "open" | "stale";

export interface TerminalTarget {
  readonly marker: string;
  readonly threadId: string;
  readonly cwd: string;
}

export interface TerminalAppOps {
  status(target: TerminalTarget): Promise<TerminalWindowState>;
  open(target: TerminalTarget, prompt?: string): Promise<"opened" | "focused" | "resumed">;
  focus(target: TerminalTarget): Promise<void>;
  submit(target: TerminalTarget, envelope: string): Promise<"submitted">;
  close(target: TerminalTarget): Promise<"closed" | "already_closed">;
}
```

Add deterministic marker generation and fixed command construction:

```ts
export function terminalMarker(changeId: string, seat: string): string {
  const suffix = createHash("sha256")
    .update(changeId).update("\0").update(seat).digest("hex").slice(0, 20);
  return `STAGEPASS:sp_${suffix}`;
}

function resumeCommand(target: TerminalTarget, prompt?: string): string {
  return [
    "exec codex resume -c 'tui.terminal_title=[]' --remote unix:// --cd",
    posixShellArg(target.cwd),
    posixShellArg(target.threadId),
    ...(prompt === undefined ? [] : [posixShellArg(prompt)]),
  ].join(" ");
}
```

The fixed AppleScript must inspect `processes of markedTab`: `open` when Codex is present, `stale`
when the marked `exec codex` tab has completed. The resume override disables Codex terminal-title OSC
updates so the StagePass custom-title marker remains stable. `open` creates a new dedicated tab when
missing, replaces the completed dedicated window when stale, and focuses when open. `submit` sends the envelope,
waits 0.2 seconds for the bracketed-paste boundary, then sends a separate empty `do script` as Enter.

- [x] **Step 4: Run the focused Terminal tests**

```bash
node --import tsx --test --test-concurrency=1 src/system/terminal-app.test.ts
```

Expected: Terminal tests pass.

- [x] **Step 5: Continue directly into Task 2 before committing**

`TerminalAppOps` is a public TypeScript contract consumed by `NativeSessions`, so Tasks 1 and 2
form one compile-safe vertical slice and share one commit after both focused suites and typecheck pass.

### Task 2: Migrate NativeSessions from tmux to Terminal delivery

**Files:**
- Modify: `src/web/native-sessions.test.ts`
- Modify: `src/web/native-sessions.ts`
- Modify: `scripts/panel.ts`

- [x] **Step 1: Rewrite the NativeSessions fakes and assertions for RED**

Use a `FakeTerminal` that records `opened`, `submitted`, `focused`, `closed` and supports `closed | open | stale`. Remove `FakeTmux` entirely. Expected status shape:

```ts
{
  changeId: "CHG-1",
  seat: "PRD",
  threadId: THREAD_ONE,
  thread: "idle",
  terminal: "open",
  action: "focus",
}
```

Add explicit tests:

```ts
await sessions.closeWindow("CHG-1", "PRD");
assert.equal((await sessions.status("CHG-1", "PRD")).action, "resume");
assert.equal((await sessions.open("CHG-1", "PRD", config, { showTerminal: true })).threadId, bound);
assert.equal(runtime.startedThreads, 1);
```

For dispatch, assert closed/stale uses `terminal.open(target, envelope)` while open/idle uses `terminal.submit(target, envelope)`. Preserve prompt file until `turn/completed` and reject a second input lease.

- [x] **Step 2: Run NativeSessions tests and confirm RED**

```bash
node --import tsx --test --test-concurrency=1 src/web/native-sessions.test.ts
```

Expected: failures on deleted tmux fields/options and missing Terminal delivery.

- [x] **Step 3: Implement the no-tmux status and target**

Use:

```ts
export interface NativeSessionStatus {
  readonly changeId: string;
  readonly seat: NativeSeat;
  readonly threadId: string | null;
  readonly thread: "none" | "idle" | "running" | "archived" | "missing" | "unavailable";
  readonly terminal: "closed" | "open" | "stale" | "unavailable";
  readonly action: "open" | "focus" | "resume";
}

function targetOf(changeId: string, seat: string, threadId: string, cwd: string): TerminalTarget {
  return { marker: terminalMarker(changeId, seat), threadId, cwd };
}
```

Remove `tmux` from `NativeSessionsOptions`, `status`, `openOnce`, `closeWindow`, cleanup, and all public output. `openOnce` calls `terminal.open` only when `showTerminal` is true.

- [x] **Step 4: Implement prompt delivery through Terminal**

After snapshot/lease/prompt-file creation:

```ts
const target = targetOf(changeId, seat, opened.threadId, this.cwd(changeId));
const state = await this.options.terminal.status(target);
if (state === "open") await this.options.terminal.submit(target, promptFile.envelope);
else await this.options.terminal.open(target, promptFile.envelope);
```

Keep `awaitNextTurn`, `awaitTurn`, input lease, prompt release and disconnect handling unchanged.

- [x] **Step 5: Remove the now-redundant public endSession method**

Delete `endSession` from `NativeSessionsPort` and `NativeSessions`. Business cleanup remains `archiveAndEnd`/`forget`, which close Terminal, archive the thread, then close the StagePass observer.

- [x] **Step 6: Remove the tmux startup dependency**

In `scripts/panel.ts`, remove `createTmuxOps`, the version check/log, and the `tmux` option passed to
`NativeSessions`. Keep the existing App Server daemon WebSocket and Terminal construction unchanged.

- [x] **Step 7: Run NativeSessions, adjacent tests and typecheck**

```bash
node --import tsx --test --test-concurrency=1 \
  src/web/native-sessions.test.ts src/codex/app-server-session.test.ts \
  src/web/session-recovery.test.ts
pnpm typecheck
```

Expected: all pass.

- [x] **Step 8: Commit the compile-safe Terminal/session slice**

```bash
git add src/system/terminal-app.ts src/system/terminal-app.test.ts \
  src/web/native-sessions.ts src/web/native-sessions.test.ts scripts/panel.ts
git commit -m "refactor: resume native Codex sessions without tmux"
```

### Task 3: Remove tmux and end-session from the HTTP/browser contract

**Files:**
- Modify: `src/web/terminal-api.ts`
- Modify: `src/web/terminal-api.test.ts`
- Modify: `src/web/terminal-bridge.js`
- Modify: `src/web/terminal-bridge.test.ts`
- Modify: `src/web/panel.html`
- Modify: `src/web/panel-server.test.ts`

- [x] **Step 1: Write RED API and browser tests**

Assert status keys are exactly:

```ts
["action", "changeId", "seat", "terminal", "thread", "threadId"]
```

Assert `POST /api/terminal/end-session` is 404 and no session method is called. Browser tests must render `resume` from `threadId + closed/stale`, show “恢复系统终端”, never read `tmux`, never call `end-session`, and have no destructive confirmation.

- [x] **Step 2: Run the API/browser tests and confirm RED**

```bash
node --import tsx --test --test-concurrency=1 \
  src/web/terminal-api.test.ts src/web/terminal-bridge.test.ts src/web/panel-server.test.ts
```

Expected: old status fields/action, end-session route and UI control make tests fail.

- [x] **Step 3: Implement the smaller contract**

Set:

```ts
const ACTIONS = new Set(["open", "focus", "close-window"]);
```

Remove the end-session branch. Map only Terminal and thread errors. In the bridge, unavailable is `terminal === "unavailable" || thread === "unavailable"`; render `resume` without tmux wording. Remove `endSession`, `confirmImpl`, related listeners and the `#terminal-end-session` button from `panel.html`.

- [x] **Step 4: Run API/browser/panel tests and typecheck**

```bash
node --import tsx --test --test-concurrency=1 \
  src/web/terminal-api.test.ts src/web/terminal-bridge.test.ts src/web/panel-server.test.ts
pnpm typecheck
```

Expected: all pass; Task 2 already migrated the compile-time startup wiring.

- [x] **Step 5: Commit the public contract slice**

```bash
git add src/web/terminal-api.ts src/web/terminal-api.test.ts \
  src/web/terminal-bridge.js src/web/terminal-bridge.test.ts \
  src/web/panel.html src/web/panel-server.test.ts
git commit -m "refactor: expose resumable Terminal sessions without tmux"
```

### Task 4: Delete tmux production code and rewire startup

**Files:**
- Create: `src/codex/native-tui-owner.ts`
- Create: `src/codex/native-tui-owner.test.ts`
- Modify: `src/architecture.test.ts`
- Delete: `src/codex/tmux.ts`
- Delete: `src/codex/tmux.test.ts`
- Delete: `src/codex/native-tui-session.ts`
- Delete: `src/codex/native-tui-session.test.ts`

- [x] **Step 1: Add RED architecture assertions**

Assert no production source contains tmux:

```ts
for (const file of productionFiles) {
  assert.doesNotMatch(readFileSync(file, "utf8"), /\btmux\b/i, file);
}
```

Assert startup imports `nativeTuiServerRequest` from `native-tui-owner` and the source tree has no
`createTmuxOps`, version call or tmux injection.

- [x] **Step 2: Run architecture/type checks and confirm RED**

```bash
node --import tsx --test --test-concurrency=1 src/architecture.test.ts
pnpm typecheck
```

Expected: tmux files/imports and stale interfaces fail.

- [x] **Step 3: Keep only native interaction ownership**

Create:

```ts
export function nativeTuiServerRequest(_request: AppServerRequest): Promise<never> {
  return Promise.reject(new AppServerSessionError(
    "interaction_owner_is_native_tui",
    "approval and MCP interaction ownership belongs to the native Codex client",
  ));
}
```

Move its focused test to `native-tui-owner.test.ts`. Delete the unused `NativeTuiCodexTransport` and all tmux files/tests.

- [x] **Step 4: Rewire the native ownership import**

In `scripts/panel.ts`, change only the `nativeTuiServerRequest` import to `native-tui-owner`; Task 2
already removed the tmux construction, version gate and injection.

- [x] **Step 5: Run source scans, typecheck and architecture tests**

```bash
test -z "$(rg -l -i '\btmux\b' src scripts || true)"
pnpm typecheck
node --import tsx --test --test-concurrency=1 \
  src/codex/native-tui-owner.test.ts src/architecture.test.ts
```

Expected: scan empty and all commands exit 0.

- [x] **Step 6: Commit the removal slice**

```bash
git add -A src/codex scripts/panel.ts src/architecture.test.ts
git commit -m "refactor: remove tmux from the StagePass runtime"
```

### Task 5: Cut over the live prototype and verify recovery

**Files:**
- Modify: `docs/superpowers/plans/2026-08-16-remove-tmux-native-tui.md` (check completed steps)
- Modify: old implementation plan/docs only where they claim tmux remains production architecture.

- [x] **Step 1: Stop the old 4173 process and clean only mapped legacy runtime**

Stop the current experimental panel. Resolve the known binding marker/session from the existing status response, close its Terminal window through the old API, and terminate only the exact mapped `sp_<20hex>` tmux session. Do not glob, kill tmux server, or touch unrelated sessions.

- [x] **Step 2: Run full automated verification**

```bash
pnpm typecheck
pnpm test
test -z "$(rg -l -i '\btmux\b' src scripts || true)"
git diff --check
```

Expected: typecheck and all tests pass, scan is empty, diff check exits 0.

- [x] **Step 3: Start only 4173 with the real database**

```bash
pnpm panel -- --port 4173 --db /Users/zhanghr/.stagepass/panel.db
```

Expected: listener on `127.0.0.1:4173`, no tmux version gate, existing `CHG-001/PRD` binding preserved.

- [x] **Step 4: Verify open, close and resume on the same thread**

Call status, record threadId, POST open, POST close-window, POST open, then status again. Assert the first and final threadId are identical, Terminal returns open/focus, and no `sp_*` tmux session is created.

- [x] **Step 5: Verify Terminal native behavior**

In the real window verify official Codex colors, navigation and slash commands. Run one file-envelope task from a closed client and one from an already open client. For a running turn, close and resume the window and record whether Codex 0.147.0 continues or resumes pending interaction; do not claim this path without observed evidence.

- [x] **Step 6: Verify isolation and commit docs**

```bash
git -C /Users/zhanghr/Desktop/stagepass status --short --branch
git status --short --branch
git add docs/superpowers
git commit -m "docs: record the no-tmux runtime cutover"
```

Expected: original worktree unchanged, experimental branch clean after the commit, 4173 still running.

## Cutover record · 2026-08-16

- Final automated gate: `pnpm test` passed 1091/1091; both TypeScript projects passed;
  `git diff --check` passed; production `src`/`scripts` scan contained no legacy multiplexer reference.
- Real binding stayed `CHG-001 / PRD / 019fd6d4-0a71-7052-92ae-71a09e7b197e` through
  open, focus, close-window, closed resume, stale-client replacement, and running-turn disconnect.
- Private-file delivery passed from both closed and already-open clients; the observed replies were
  `STAGEPASS_CLOSED_ENVELOPE_OK` and `STAGEPASS_OPEN_ENVELOPE_OK`, and each 0600 prompt file was
  released after the reply.
- Running disconnect passed the exact state sequence `running/open -> running/closed ->
  running/open -> idle/open`, with reply `STAGEPASS_DISCONNECT_RESUME_OK` on the same thread.
- Native Codex colors and StagePass page rendering were inspected with a real Terminal client and
  headless Chrome fallback. Chrome DevTools MCP was not present in this Codex tool session.
- The original worktree remained clean; the final process listens only on `127.0.0.1:4173`; no
  tmux server or `sp_*` session exists.
