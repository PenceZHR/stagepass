# Codex App Without Signature Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 StagePass 在不调用或依赖 macOS 代码签名校验的前提下，继续通过 ChatGPT/Codex App 创建、复用和运行真实持久任务。

**Architecture:** 保留现有 `codex app-server` shell/read control、Desktop follower IPC、SQLite thread binding、logical turn、lease/fencing 与 observation 架构。把 trust boundary 收窄为运行进程、固定 App 路径、realpath、非 symlink、文件 identity、当前用户 IPC socket、精确 app-server 版本与协议能力；App conversation health 与可选 MCP presentation health 分开计算。Codex CLI 执行链零修改。

**Tech Stack:** TypeScript 5.9、Node.js test runner、Next.js 16 Route Handlers、React 19、Drizzle/SQLite、Codex app-server JSON-RPC、Desktop follower IPC、Codex in-app browser automation。

---

## File Map

**Runtime discovery**

- Modify: `server/services/codex-desktop-ipc-discovery.ts`
- Modify/Test: `server/services/codex-desktop-bridge.test.ts`

**App-server runtime validation**

- Modify: `server/services/codex-app-server-shell-control.ts`
- Modify/Test: `server/services/codex-app-server-shell-control.test.ts`

**Health contract**

- Modify: `app/api/codex/health/route.ts`
- Modify/Test: `app/api/codex/health/route.test.ts`

**StagePass App control UI**

- Modify: `app/projects/[id]/changes/[changeId]/codex-task-control.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/emergency-interaction-panel.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Modify/Test: `app/projects/[id]/changes/[changeId]/codex-task-control.test.ts`

**Integrated verification**

- Modify: `scripts/verify-codex-desktop-bridge.ts`
- Preserve unless directly required by a failing test:
  `server/services/codex-desktop-bridge.ts`,
  `server/services/codex-desktop-ipc-transport.ts`
- Do not add: `.superpowers/`,
  `scripts/probe-codex-desktop-mcp-prompt.ts`,
  `scripts/probe-codex-desktop-plugin-card.ts`
- Do not modify: any Codex CLI engine, CLI fallback, provider schema, or CLI test.

## Dirty Worktree Rule

The worktree already contains user-owned App bridge changes. Before each task:

```bash
git status --short
git diff -- <target files>
```

Do not discard or rewrite existing hunks. The current version-pin updates for
`26.721.31836` and `0.146.0-alpha.3.1` may remain when they are required by the
current App protocol. Unrelated Phase 0 crash-injection, verifier recovery, probe,
or transport hunks must not be staged with this migration. Before every commit:

```bash
git diff --cached --name-status
git diff --cached --check
```

The staged file list must match the task's `Files` section exactly.

### Task 1: Discover the running App without a signature gate

**Files:**

- Modify: `server/services/codex-desktop-ipc-discovery.ts`
- Test: `server/services/codex-desktop-bridge.test.ts`

- [ ] **Step 1: Replace signed/attested fixture vocabulary in the discovery tests**

Rename the discovery-only types and fixture fields:

```ts
export interface CodexDesktopBundleMetadata {
  bundleIdentifier: string;
  bundleShortVersion: string;
  bundleVersion: string;
  chromiumBaseVersion: string;
}

export interface CodexDesktopObservedAppServerBinary {
  path: string;
  version: string;
  file: CodexDesktopSocketStat;
  bundlePath: string;
  bundleFile: CodexDesktopSocketStat;
  bundleIdentifier: string;
}

export interface CodexDesktopObservedIpcEndpoint {
  path: string;
  pid: number;
  desktopBundleIdentity: CodexDesktopBundleMetadata;
  appServerBinary: CodexDesktopObservedAppServerBinary;
  socket: CodexDesktopSocketStat;
  parentPath: string;
  parent: CodexDesktopSocketStat;
}
```

In `processDiscoveryFixtures`, delete `codesignIdentities`,
`codesignVerificationFailures`, and `codesignTargets`. Keep `commandFiles` so the
test can prove the forbidden executables were never invoked.

- [ ] **Step 2: Write the failing no-signature discovery test**

Add this assertion to the happy-path discovery case:

```ts
it("discovers the observed ChatGPT App without invoking signature tools", async () => {
  const fixtures = processDiscoveryFixtures({
    lsofPids: [9410],
    commands: {
      9410: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    },
    kernelExecutables: {
      9410: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
    },
    procPidPathOutputs: {
      9410: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    },
    bundleMetadataSequences: {
      CFBundleShortVersionString: ["26.721.41059", "26.721.41059"],
      CFBundleVersion: ["5848", "5848"],
      ChromiumBaseVersion: ["150.0.7871.128", "150.0.7871.128"],
    },
    codexVersionSequence: [
      "codex-cli 0.146.0-alpha.3.1",
      "codex-cli 0.146.0-alpha.3.1",
    ],
  });

  const endpoint = await discoverCodexDesktopIpcEndpoint(fixtures.dependencies);

  assert.equal(endpoint.pid, 9410);
  assert.equal(endpoint.appServerBinary.bundleIdentifier, "com.openai.codex");
  assert.ok(!fixtures.commandFiles.includes("/usr/bin/codesign"));
  assert.ok(!fixtures.commandFiles.includes("/usr/sbin/spctl"));
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 \
  server/services/codex-desktop-bridge.test.ts
```

Expected: FAIL because discovery still invokes `/usr/bin/codesign` or the renamed
fixture/type contract does not exist.

- [ ] **Step 4: Remove signature commands from discovery**

In `codex-desktop-ipc-discovery.ts`:

```ts
// Delete SYSTEM_CODESIGN and TRUSTED_OPENAI_TEAM_IDENTIFIER.

async function readBundleMetadata(
  infoPlist: string,
  runCommand: CodexDesktopProbeCommandRunner,
): Promise<CodexDesktopBundleMetadata | null> {
  // Preserve the existing plutil field reads and scalar validation.
}

async function observedDesktopProcess(
  pid: number,
  dependencies: Pick<
    CodexDesktopProcessProbeOptions,
    "runCommand" | "realpath" | "lstat"
  >,
): Promise<{
  desktopBundleIdentity: CodexDesktopBundleMetadata;
  appServerBinary: CodexDesktopObservedAppServerBinary;
} | null> {
  // Preserve pid, executable, canonical path, lstat, metadata, version,
  // before/after realpath and file-identity checks.
  // Do not call codesign or spctl.
}
```

Change the advertised endpoint flag from `desktopVerified` to
`desktopObserved`. `discoverCodexDesktopIpcEndpoint` must require
`desktopObserved`, bundle metadata, and app-server runtime evidence, then retain
the existing live PID, unique candidate, socket type/owner/mode, and parent
directory checks.

- [ ] **Step 5: Keep all non-signature rejection tests**

Retain and update tests proving rejection of:

```ts
[
  "unexpected process executable",
  "bundle realpath drift",
  "Info.plist metadata drift",
  "app-server realpath drift",
  "app-server version drift",
  "executable or app-server file identity drift",
  "symlink socket",
  "foreign-owner socket",
  "group/other-accessible socket",
  "group/other-writable parent",
  "multiple live candidates",
]
```

Delete only assertions whose sole expected failure is invalid signature or wrong
TeamIdentifier.

- [ ] **Step 6: Run discovery tests and commit**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 \
  server/services/codex-desktop-bridge.test.ts
```

Expected: PASS with zero `/usr/bin/codesign` and `/usr/sbin/spctl` calls.

Commit only the two task files:

```bash
git add server/services/codex-desktop-ipc-discovery.ts \
  server/services/codex-desktop-bridge.test.ts
git commit -m "refactor(codex): discover app without signature gate"
```

### Task 2: Validate the embedded app-server by runtime evidence

**Files:**

- Modify: `server/services/codex-app-server-shell-control.ts`
- Test: `server/services/codex-app-server-shell-control.test.ts`

- [ ] **Step 1: Write a failing shell-control test that forbids signature tools**

Replace the attestation callback test with:

```ts
it("validates the observed app-server before and after spawn without signing", async () => {
  const phases: string[] = [];
  const binaries: string[] = [];
  const shellControl = createCodexAppServerShellControl({
    appServerBinary: observedBinary(),
    clientFactory(_cwd, binary) {
      binaries.push(binary);
      return new FakeShellClient();
    },
    validateAppServerBinary: async (_identity, phase) => {
      phases.push(phase);
    },
  });

  await shellControl.listModels();

  assert.deepEqual(phases, ["before_spawn", "after_spawn"]);
  assert.deepEqual(binaries, [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ]);
});
```

Add a source assertion:

```ts
assert.doesNotMatch(shellControlSource, /codesign|spctl|TeamIdentifier/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 \
  server/services/codex-app-server-shell-control.test.ts
```

Expected: FAIL because `validateAppServerBinary` does not exist and source still
contains `codesign`/TeamIdentifier.

- [ ] **Step 3: Implement runtime-only validation**

Rename the option and exported validator:

```ts
export interface ShellControlOptions {
  appServerBinary: CodexDesktopObservedAppServerBinary;
  validateAppServerBinary?: (
    identity: CodexDesktopObservedAppServerBinary,
    phase: "before_spawn" | "after_spawn",
  ) => Promise<void>;
  // Preserve all existing options.
}

export async function validateObservedAppServerBinary(
  identity: CodexDesktopObservedAppServerBinary,
): Promise<void> {
  // Require canonical absolute bundle/path and com.openai.codex metadata.
  // Require realpath equality, regular non-symlink file, stable dev/inode/mode,
  // and exact --version output before returning.
  // Do not call codesign or spctl.
}
```

`createCodexAppServerShellControl` must call the runtime validator immediately
before client creation and immediately after client creation. Preserve active
client limits, deadline/abort handling, initialize, close behavior, allowlisted
methods, protocol fingerprint, and managed-turn prohibition.

- [ ] **Step 4: Preserve mutation and drift failures**

Keep tests that fail closed when:

```ts
resolvedPath !== identity.path
bundleResolvedPath !== identity.bundlePath
!sameFileIdentity(before, after)
exactVersionOutput(stdout) !== identity.version
identity.bundleIdentifier !== "com.openai.codex"
```

Remove only codesign output and TeamIdentifier fixtures.

- [ ] **Step 5: Run shell-control and bridge tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 \
  server/services/codex-app-server-shell-control.test.ts \
  server/services/codex-desktop-bridge.test.ts
```

Expected: PASS; managed `turn/start` remains outside the shell-control
allowlist.

- [ ] **Step 6: Commit**

```bash
git add server/services/codex-app-server-shell-control.ts \
  server/services/codex-app-server-shell-control.test.ts
git commit -m "refactor(codex): validate app-server without codesign"
```

### Task 3: Separate App conversation health from MCP presentation health

**Files:**

- Modify: `app/api/codex/health/route.ts`
- Test: `app/api/codex/health/route.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/emergency-interaction-panel.tsx`
- Test: `app/projects/[id]/changes/[changeId]/codex-task-control.test.ts`

- [ ] **Step 1: Write the failing health contract test**

Add:

```ts
it("keeps App conversation ready when optional MCP evidence is missing", async () => {
  const response = await handleCodexHealth({
    flags: flags(),
    probe: readyProbe,
    hostEvidence: {
      status: "missing",
      verifiedBy: null,
      hostFingerprint: null,
      verifiedAt: null,
    },
    now: Date.now,
  });
  const json = await response.json() as {
    status: string;
    mcpInteractionStatus: string;
  };

  assert.equal(json.status, "ready");
  assert.equal(json.mcpInteractionStatus, "unsupported");
});
```

Define `readyProbe` in the test as the current successful probe object; do not
include paths, sockets, stderr, or process IDs.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 \
  app/api/codex/health/route.test.ts
```

Expected: FAIL because the current route returns `status: "unsupported"` when
MCP evidence is missing.

- [ ] **Step 3: Split the two health dimensions**

In `handleCodexHealth`:

```ts
let status: "ready" | "disabled" | "unavailable" | "unsupported" =
  dependencies.flags.desktopBridge ? "unavailable" : "disabled";

if (dependencies.flags.desktopBridge) {
  try {
    probe = await dependencies.probe();
    status = "ready";
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    status = code.includes("unsupported") ? "unsupported" : "unavailable";
  }
}

const mcpInteractionStatus =
  !dependencies.flags.mcpInteractions
    ? "disabled"
    : dependencies.hostEvidence.status === "passed"
      ? "ready"
      : "unsupported";
```

Return `mcpInteractionStatus` beside the existing `mcpHostEvidence`. Do not
remove MCP evidence from diagnostics.

- [ ] **Step 4: Keep emergency decisions tied to the interaction surface**

Change:

```ts
export function shouldShowEmergency(
  health: {
    status: BridgeHealthStatus;
    mcpInteractionStatus?: "ready" | "disabled" | "unsupported";
  } | null,
  codexDecisionEnabled: boolean,
): boolean {
  return codexDecisionEnabled
    && health !== null
    && (
      health.status !== "ready"
      || health.mcpInteractionStatus === "unsupported"
    );
}
```

Add assertions:

```ts
assert.equal(shouldShowEmergency({
  status: "ready",
  mcpInteractionStatus: "unsupported",
}, true), true);
assert.equal(shouldShowEmergency({
  status: "ready",
  mcpInteractionStatus: "ready",
}, true), false);
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 \
  app/api/codex/health/route.test.ts \
  'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts'
```

Expected: PASS. App conversation remains ready while MCP-dependent human
decisions still receive the audited emergency fallback.

Commit:

```bash
git add app/api/codex/health/route.ts \
  app/api/codex/health/route.test.ts \
  'app/projects/[id]/changes/[changeId]/emergency-interaction-panel.tsx' \
  'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts'
git commit -m "fix(codex): decouple app health from mcp evidence"
```

### Task 4: Make the StagePass control card report the real App capability

**Files:**

- Modify: `app/projects/[id]/changes/[changeId]/codex-task-control.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Test: `app/projects/[id]/changes/[changeId]/codex-task-control.test.ts`

- [ ] **Step 1: Write failing rendering assertions**

Update the test to require:

```ts
assert.match(source, /App /);
assert.match(source, /MCP .*optional/);
assert.doesNotMatch(source, /Desktop /);

const markup = renderToStaticMarkup(createElement(CodexTaskControl, {
  control: { ...control, threadId: null, bindingStatus: "detached" },
  health: {
    status: "ready",
    mcpInteractionStatus: "unsupported",
    mcpHostEvidence: { status: "missing" },
  },
  canStart: false,
  canRetry: false,
  readOnly: false,
  onOpen: noop,
  onInterrupt: noop,
  onStart: noop,
  onRetry: noop,
  onRepair: noop,
  onSaveSettings: noop,
}));

assert.doesNotMatch(markup, />Start stage in Codex</);
assert.doesNotMatch(markup, />Retry</);
assert.match(markup, /No runnable stage action/);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 \
  'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts'
```

Expected: FAIL because the component always renders Start/Retry when unbound and
still labels health as Desktop/MCP without optionality.

- [ ] **Step 3: Implement explicit control availability**

Extend props:

```ts
canStart: boolean;
canRetry: boolean;
```

Render:

```tsx
<span>App {health?.status ?? "checking"}</span>
<span className="text-white/25">·</span>
<span>
  MCP {health?.mcpHostEvidence?.status ?? "unknown"} (optional for conversation)
</span>
```

Only render Start and Retry when their matching capability is true. When the
task is unbound and neither action exists, render:

```tsx
<p className="text-xs text-muted-foreground">
  No runnable stage action. App conversation health is available independently.
</p>
```

In `page.tsx` pass:

```tsx
canStart={Boolean(startControlAction)}
canRetry={Boolean(retryControlAction)}
```

Keep `onStart` and `onRetry` fail-closed guards even though unavailable buttons
are not rendered.

- [ ] **Step 4: Run component and page contract tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 \
  'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts' \
  'app/projects/[id]/changes/[changeId]/phase-review.test.ts'
```

Expected: PASS; `SPEC_READY` no longer exposes a button that deterministically
throws `No start action is available`.

- [ ] **Step 5: Commit**

```bash
git add \
  'app/projects/[id]/changes/[changeId]/codex-task-control.tsx' \
  'app/projects/[id]/changes/[changeId]/page.tsx' \
  'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts'
git commit -m "fix(ui): report app conversation readiness"
```

### Task 5: Verify the full App bridge without signature evidence

**Files:**

- Modify: `scripts/verify-codex-desktop-bridge.ts`
- Conditionally modify only when required by a failing test:
  `server/services/codex-desktop-bridge.ts`
- Conditionally modify only when required by a failing test:
  `server/services/codex-desktop-ipc-transport.ts`

- [ ] **Step 1: Remove signature assertions from the verifier**

Delete report fields and assertions that record or require:

```ts
codesign
spctl
TeamIdentifier
signature
signed bundle
```

Keep verifier evidence for:

```ts
{
  uniqueRunningAppProcess: true,
  canonicalExecutablePath: true,
  stableFileIdentity: true,
  ownedPrivateSocket: true,
  appServerVersionMatched: true,
  protocolCapabilitiesMatched: true,
  persistentThreadNamed: true,
  followerTurnStarted: true,
  terminalTurnObserved: true,
}
```

- [ ] **Step 2: Run all focused suites**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 \
  server/services/codex-app-server-shell-control.test.ts \
  server/services/codex-desktop-bridge.test.ts \
  app/api/codex/health/route.test.ts \
  'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts' \
  'app/projects/[id]/changes/[changeId]/phase-review.test.ts'
```

Expected: PASS.

- [ ] **Step 3: Run static and full regression checks**

Run:

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```

Expected: all commands exit 0. If an existing unrelated failure occurs, record
the exact command and failure without weakening this task's assertions.

- [ ] **Step 4: Run the real App verifier**

Run:

```bash
pnpm verify:codex-desktop-bridge
```

Expected evidence:

- Project: `Stagepass`;
- a named persistent task is created or reused;
- one real turn starts and reaches a terminal state;
- thread ID and turn ID are non-empty and persisted;
- no verifier output or command contains `codesign` or `spctl`;
- MCP absence is reported separately and does not invalidate ordinary App
  conversation readiness.

- [ ] **Step 5: Commit verifier changes**

Stage only verifier changes that belong to this plan:

```bash
git add scripts/verify-codex-desktop-bridge.ts
git diff --cached --check
git commit -m "test(codex): verify app bridge without signing"
```

Do not stage unrelated recovery or crash-injection hunks. If verifier changes
cannot be separated safely from existing user-owned hunks, leave the verifier
unstaged and record its passing command output instead.

### Task 6: Perform independent App reviews and browser regression

**Files:**

- No source changes unless a review fails.
- Verification evidence is reported in the persistent Codex tasks and final
  delivery.

- [ ] **Step 1: Create or reuse the formal App fix task**

Use Project `Stagepass` and the task name:

```text
[STAGEPASS APP][FIX] 移除验签门禁
```

The task must contain the implementation commit IDs, run a real turn, and report
the thread ID, turn ID, changed files, focused tests, full tests, and unresolved
items.

- [ ] **Step 2: Run independent specification review**

Use a separate persistent App task:

```text
[STAGEPASS APP][SPEC REVIEW] 移除验签门禁
```

Audit against:

```text
docs/superpowers/specs/2026-07-25-codex-app-without-signature-gate-design.md
```

Required result: explicit PASS with P0-P3 findings and a real turn ID. On FAIL,
send findings back to the fix task, modify, retest, and repeat this step.

- [ ] **Step 3: Run independent code-quality review**

After spec PASS, use another persistent App task:

```text
[STAGEPASS APP][QUALITY REVIEW] 移除验签门禁
```

Required result: explicit PASS with P0-P3 findings and a real turn ID. Review
must verify no signature calls remain, non-signature checks remain, CLI is
untouched, worktree scope is correct, and all tests are fresh. On FAIL, return
findings to the fix task and repeat both reviews.

- [ ] **Step 4: Reproduce and regress in the real browser**

Open:

```text
http://localhost:3000/projects/PRJ-004/changes/CHG-003
```

Record:

1. App health text and optional MCP text;
2. whether the control exposes an impossible Start/Retry action;
3. console error/warning count;
4. task/thread/turn evidence visible after an enabled StagePass action;
5. `Open in Codex`, retry, and interrupt behavior where applicable.

Expected for current `SPEC_READY` state:

- no deterministic `No start action is available` button;
- App conversation status is independent from MCP status;
- console has zero errors and warnings;
- existing bound task opens, or the UI states that no runnable stage action
  exists without claiming failure of App conversation health.

- [ ] **Step 5: Final delivery gate**

Do not say “complete” unless the delivery contains:

```text
Codex Project name
fix task name + thread ID + turn ID
spec review task name + thread ID + turn ID
quality review task name + thread ID + turn ID
browser reproduction and regression result
focused/full test result
all implementation commit IDs
confirmation that Codex CLI files were unchanged
```

If any item is missing, report `代码已修改、App 未完整验收`.
