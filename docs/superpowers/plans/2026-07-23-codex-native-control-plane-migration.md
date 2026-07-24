# Codex-Native Control Plane Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild StagePass so Web is the control plane, each Change executes and receives human decisions in one persistent Codex Desktop task, MCP App clicks flow through the authoritative StagePass Server, and StagePass-owned Git UI is removed without weakening repository evidence or workspace protection.

**Architecture:** Introduce a fail-closed Codex Hybrid Bridge behind a Phase 0 viability gate: app-server provisions/names/repairs persistent shells and read-only polls Desktop-started turns through `thread/read(includeTurns:true)`, while Codex Desktop follower IPC exclusively starts/interrupts managed turns. After a deep link, the real start call's explicit `no-client-found` or success is the only readiness signal; there is no separate readiness probe. Add a durable Human Interaction Broker and one Pipeline Command Gateway shared by Web and MCP. Migrate decisions stage-by-stage into a private-submit MCP App, then simplify Web and split user-facing Git operations from the retained repository-evidence/workspace-versioning substrate.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.9, Node test runner, SQLite, Drizzle ORM, Codex app-server shell-control JSON-RPC, Codex Desktop follower IPC/deep links, Model Context Protocol SDK, MCP App SDK, esbuild, Pino.

---

## Preconditions and execution rules

- Do not start Task 1 until every Task 0 acceptance item passes on the user's installed Codex Desktop.
- If Task 0 fails, commit only the spike, tests, and evidence; do not remove or reroute existing Web, app-server, or Git behavior.
- Run each test through `pnpm test -- <literal-path>` so `scripts/run-tests-isolated.ts` protects `server/db/ship.db`.
- Stage only files listed in the current task. The existing untracked `.agents/` and `plugins/` trees are user-owned and must never be staged or edited.
- Keep `CodexAppServerEngine` available behind a rollback flag until Task 20 passes.
- Every human-decision mutation must enter through `executePipelineCommand`; UI code and MCP tools may not write business tables directly.

## Target file map

### New boundaries

- Create: `server/services/codex-desktop-bridge-types.ts` — stable bridge interface and capability/result types.
- Create: `server/services/codex-app-server-shell-control.ts` — persistent shell provision/name/read/list/model control plus `thread/read(includeTurns:true)` lifecycle polling; no managed `turn/start`.
- Create: `server/services/codex-app-server-shell-control.test.ts` — shell-control allowlist and forbidden-turn boundary.
- Create: `server/services/codex-desktop-ipc-transport.ts` — the only module allowed to know Desktop follower start (`no-client-found`/success) and interrupt frames.
- Create: `server/services/codex-desktop-ipc-discovery.ts` — locate and authenticate the running local Desktop endpoint without hard-coded user paths.
- Create: `server/services/codex-desktop-bridge.ts` — capability-gated Hybrid shell/follower facade.
- Create: `server/services/codex-desktop-engine.ts` — Hybrid `AiEngineAdapter`: app-server shell control plus follower-owned turns.
- Create: `server/services/codex-follower-start-attempt-service.ts` — durable exactly-once start fence and ambiguous-dispatch reconciliation.
- Create: `server/services/codex-thread-binding-service.ts` — One Change → One Task binding and repair.
- Create: `server/services/codex-logical-turn-service.ts` — Server-owned deterministic role/round/ordinal slot resolution and correlation derivation.
- Create: `server/services/project-ai-run-service.ts` — durable project-level owner lease for PRD and Context managed turns.
- Create: `server/services/codex-managed-ai-caller-inventory.ts` — AST-backed inventory requiring every production AI caller to resolve a logical turn or stay in the flagged rollback boundary.
- Create: `server/config/codex-decision-rollout.ts` — global master, strict phase/kind registry, and the sole rollout helper.
- Create: `server/services/pipeline-command-types.ts` — shared command/receipt schema.
- Create: `server/services/pipeline-command-gateway.ts` — authoritative command validation, routing, and next-stage orchestration.
- Create: `server/services/interaction-types.ts` — `InteractionEnvelope` and form schema.
- Create: `server/services/human-interaction-broker.ts` — durable interaction projection/lifecycle.
- Create: `server/services/repository-evidence-service.ts` — retained read-only Git evidence.
- Create: `server/services/workspace-versioning-service.ts` — retained internal worktree/adoption Git mutations.
- Create: `mcp/server.ts` — StagePass MCP tools and UI resource registration.
- Create: `mcp/supervisor.ts` — Host-attested MCP launcher and inherited submit-auth channel owner.
- Create: `mcp/stagepass-api-client.ts` — loopback-only Server client.
- Create: `mcp/ui/interaction-app.tsx` — decision card application.
- Create: `mcp/ui/interaction-app.css` — decision card styles.
- Create: `scripts/build-mcp-app.ts` — deterministic UI bundle.
- Create: `scripts/verify-codex-desktop-bridge.ts` — real-client Phase 0 verifier.
- Create: `scripts/verify-codex-native-e2e.ts` — final real-client acceptance verifier.
- Create: `spikes/codex-desktop-mcp/phase0-journal.ts` — disposable SQLite journal with production-isomorphic owner/binding/logical/attempt/execution constraints.

### Existing authority to preserve and reuse

- Modify: `server/services/action-contract-service.ts`
- Modify: `server/services/action-contract-registry-service.ts`
- Modify: `server/services/action-contract-decision-router.ts`
- Modify: `server/services/gate-service.ts`
- Modify: `server/services/job-dispatch-service.ts`
- Modify: `server/services/pipeline-job-runner-service.ts`
- Modify: `server/services/prd-service.ts`
- Modify: `server/services/context-init-service.ts`
- Modify: `server/services/provider-session-service.ts`
- Modify: `server/services/build-workspace-service.ts`
- Modify: `server/services/merge-readiness-service.ts`
- Modify: `server/db/schema.ts`
- Modify: `server/types/enums.ts`
- Modify: `server/types/models.ts`
- Modify: `server/types/api.ts`

### Existing Web surface to shrink

- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/pipeline-page-shell.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/change-api-client.ts`
- Modify: `app/projects/[id]/changes/[changeId]/use-change-commands.ts`
- Modify: `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/spec-battlefield.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/plan-sandbox.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/testplan-sandbox.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/review-report-center.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/gate-panel.tsx`
- Delete after MCP parity: `app/projects/[id]/changes/[changeId]/refine-chat-panel.tsx`
- Delete after MCP parity: `app/projects/[id]/changes/[changeId]/action-reason-dialog.tsx`

### StagePass Git product surface to delete after internal split

- Delete: `app/projects/[id]/git-setup-panel.tsx`
- Delete: `app/projects/[id]/git-workspace-panel.tsx`
- Delete: `app/projects/[id]/changes/[changeId]/stage-git-panel.tsx`
- Delete: `app/projects/[id]/changes/[changeId]/git-action-policy.ts`
- Delete: `app/projects/[id]/changes/[changeId]/git-action-policy.test.ts`
- Delete: `app/api/projects/[id]/git/route.ts`
- Delete: `app/api/projects/[id]/git/workspace/route.ts`
- Delete: `app/api/projects/[id]/git/suggest-message/route.ts`
- Delete: `app/api/projects/[id]/changes/[changeId]/git/route.ts`
- Delete: `server/services/action-contract-git-policy.ts`
- Delete: `server/services/action-contract-git-policy.test.ts`
- Delete: `server/services/commit-message-service.ts`
- Delete: `server/services/commit-message-service.test.ts`
- Delete: `server/services/git-service.ts`
- Delete: `server/services/git-service.test.ts`
- Modify: `server/services/git-service-consumer-inventory.test.ts`

---

### Task 0: Prove Hybrid shell ownership and Desktop follower execution before changing production behavior

**Files:**
- Create: `server/services/codex-desktop-bridge-types.ts`
- Create: `server/services/codex-app-server-shell-control.ts`
- Create: `server/services/codex-app-server-shell-control.test.ts`
- Create: `server/services/codex-desktop-ipc-transport.ts`
- Create: `server/services/codex-desktop-ipc-discovery.ts`
- Create: `server/services/codex-desktop-bridge.ts`
- Create: `server/services/codex-desktop-bridge.test.ts`
- Create: `spikes/codex-desktop-mcp/phase0-journal.ts`
- Create: `spikes/codex-desktop-mcp/phase0-journal.test.ts`
- Create: `spikes/codex-desktop-mcp/server.ts`
- Create: `spikes/codex-desktop-mcp/supervisor.ts`
- Create: `spikes/codex-desktop-mcp/ui.ts`
- Create: `spikes/codex-desktop-mcp/server.test.ts`
- Create: `scripts/build-codex-desktop-mcp-spike.ts`
- Create: `scripts/verify-codex-desktop-bridge.ts`
- Create at runtime: `.stagepass/verification/codex-desktop-bridge-phase0.json`
- Create at runtime: `.stagepass/verification/codex-desktop-bridge-phase0-attempts.sqlite`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`

- [ ] **Step 1: Install the self-contained spike dependencies**

Run:

```bash
pnpm add @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps
pnpm add -D esbuild
```

Expected: dependency installation exits `0`; no code under the user-owned `.agents/` or `plugins/` tree is read or reused.

- [ ] **Step 2: Write the bridge contract test**

Create `phase0-journal.test.ts`, `codex-app-server-shell-control.test.ts`, and `codex-desktop-bridge.test.ts` with separate fake shell/follower transports. The tests initialize a disposable SQLite journal first, using the production-isomorphic scope binding, managed owner lease, immutable logical request, full-unique start-attempt, and execution constraints described below. Provisioning is two phase: creator-session exact zero-turn read/full-list proof records only `bootstrap_ready`; one dedicated read-only `shell_materialization` logical turn then uses the normal attempt/marker/dispatch CAS contract, and an independent app-server exact read/full-list proof promotes `durable_ready`. `seedManagedRun()` may read the canonical shell only after that promotion and returns only the `logicalTurnId` needed by the public start interface.

```ts
it("fails closed when either half of the hybrid contract is absent", async () => {
  const bridge = createCodexDesktopBridge({
    shellControl: fakeShellControl({ capabilities: ["thread/start:persistent"] }),
    follower: fakeFollower({ capabilities: [] }),
  });
  await assert.rejects(
    bridge.probe(),
    (error: unknown) =>
      error instanceof CodexDesktopBridgeError &&
      error.code === "codex_hybrid_bridge_unsupported",
  );
});

it("provisions a persistent named shell but starts turns only through the follower", async () => {
  const shellControl = fakeShellControlWithPersistentThreads({
    turnSnapshots: [
      turnSnapshot("turn-1", "inProgress", ["item-1"]),
      turnSnapshot("turn-1", "completed", ["item-1", "agentMessage"]),
    ],
  });
  const follower = fakeFollowerStartResponses([
    "no-client-found",
    { turnId: "turn-1" },
  ]);
  const bridge = createCodexDesktopBridge({ shellControl, follower });
  const shell = await bridge.ensurePersistentShell({
    projectPath: "/repo",
    scope: { kind: "project_context", scopeId: "P-1", projectId: "P-1" },
    title: "[P-1] Project Context",
  });
  const seeded = phase0Journal.seedManagedRun({
    owner: { kind: "project_ai_run", projectAiRunId: "phase0-owner-1" },
    binding: {
      scopeKind: "project_context",
      scopeId: "P-1",
      projectId: "P-1",
      threadId: shell.threadId,
    },
    request: {
      threadId: shell.threadId,
      cwd: "/repo",
      prompt: "verify hybrid execution",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    },
    phase: "Context",
    role: "context_select",
    round: 0,
    ordinal: 0,
  });
  const started = await bridge.startTurn({ logicalTurnId: seeded.logicalTurnId });
  const observations: CodexTurnObservation[] = [];
  for await (const item of bridge.pollTurn({
    threadId: shell.threadId,
    turnId: started.turnId,
    deadlineAt: seeded.deadlineAt,
  })) if (item.kind === "observation") observations.push(item);
  assert.deepEqual(shellControl.startThreadCalls[0], {
    cwd: "/repo",
    ephemeral: false,
  });
  assert.equal(shellControl.nameCalls[0]?.name, "[P-1] Project Context");
  assert.equal(shellControl.turnStartCalls, 0);
  assert.equal(follower.startCalls[0]?.threadId, shell.threadId);
  assert.equal(follower.turnsCreatedByAttempt[0], 0);
  assert.equal(follower.turnsCreatedByAttempt[1], 1);
  assert.equal(follower.readinessProbeCalls, 0);
  assert.equal(follower.lifecycleSubscriptionCalls, 0);
  assert.equal(shellControl.threadReadCalls.at(-1)?.includeTurns, true);
  assert.equal(observations.at(-1)?.snapshot.status, "completed");
});

it("reuses the shell after bounded no-client-found start failures and on the second turn", async () => {
  const shellControl = fakeShellControlWithPersistentThreads();
  const follower = fakeFollowerStartResponsesThatExhaustThenSucceed();
  const bridge = createCodexDesktopBridge({ shellControl, follower });
  const first = await bridge.ensurePersistentShell({
    projectPath: "/repo",
    scope: { kind: "change", scopeId: "CHG-1", projectId: "P-1", changeId: "CHG-1" },
    title: "[CHG-1] First",
  });
  phase0Journal.seedLivePipelineJob({
    pipelineJobId: "JOB-1", workerId: "phase0-worker", leaseToken: "phase0-lease",
    ownerAttempt: 1, ownerEpoch: 1, deadlineAt: futureDeadline(),
  });
  const failedRun = phase0Journal.seedManagedRun({
    owner: { kind: "pipeline_job", pipelineJobId: "JOB-1" },
    binding: changeBinding({ projectId: "P-1", changeId: "CHG-1", threadId: first.threadId }),
    request: turnRequest({ threadId: first.threadId, deadlineMs: 1_000 }),
    phase: "Build", role: "build", round: 1, ordinal: 0,
  });
  await assert.rejects(bridge.startTurn({ logicalTurnId: failedRun.logicalTurnId }), {
    code: "desktop_follower_not_ready",
  });
  const repaired = await bridge.ensurePersistentShell({
    projectPath: "/repo",
    scope: { kind: "change", scopeId: "CHG-1", projectId: "P-1", changeId: "CHG-1" },
    title: "[CHG-1] First",
  });
  const successfulRun = phase0Journal.seedManagedRun({
    owner: { kind: "pipeline_job", pipelineJobId: "JOB-1" },
    binding: changeBinding({ projectId: "P-1", changeId: "CHG-1", threadId: repaired.threadId }),
    request: turnRequest({ threadId: repaired.threadId, deadlineMs: 15_000 }),
    phase: "Build", role: "build", round: 2, ordinal: 0,
  });
  await bridge.startTurn({ logicalTurnId: successfulRun.logicalTurnId });
  const secondRun = phase0Journal.seedManagedRun({
    owner: { kind: "pipeline_job", pipelineJobId: "JOB-1" },
    binding: changeBinding({ projectId: "P-1", changeId: "CHG-1", threadId: repaired.threadId }),
    request: turnRequest({ threadId: repaired.threadId, deadlineMs: 15_000 }),
    phase: "Build", role: "build", round: 3, ordinal: 0,
  });
  await bridge.startTurn({ logicalTurnId: secondRun.logicalTurnId });
  assert.equal(shellControl.startThreadCalls.length, 1);
  assert.equal(follower.successfulStartCallsFor(repaired.threadId), 2);
  assert.equal(shellControl.completedDesktopStartedTurns(repaired.threadId), 2);
  assert.equal(follower.failedAttemptsCreatedTurns, 0);
  assert.equal(follower.successfulAttemptsCreatedTurns, 2);
});

it("deduplicates full snapshots, advances a local cursor monotonically, and reconnects reads", async () => {
  const shellControl = fakeShellControlWithReadDisconnect([
    turnSnapshot("turn-1", "inProgress", ["item-1"]),
    turnSnapshot("turn-1", "inProgress", ["item-1"]),
    new Error("connection_lost"),
    turnSnapshot("turn-1", "completed", ["item-1", "agentMessage"]),
  ]);
  const bridge = createCodexDesktopBridge({ shellControl, follower: fakeFollowerStarted("turn-1") });
  const seeded = phase0Journal.seedManagedRun({
    ...phase0OwnerFixture(),
    binding: projectContextBinding({ projectId: "P-1", threadId: "thread-1" }),
    request: turnRequest({ threadId: "thread-1" }),
  });
  const started = await bridge.startTurn({ logicalTurnId: seeded.logicalTurnId });
  const observations: CodexTurnObservation[] = [];
  for await (const item of bridge.pollTurn({
    threadId: "thread-1",
    turnId: started.turnId,
    deadlineAt: seeded.deadlineAt,
  })) if (item.kind === "observation") observations.push(item);
  assert.equal(shellControl.initializeCount, 2);
  assert.deepEqual(observations.map((item) => item.cursor), [1, 2]);
  assert.equal(observations.at(-1)?.snapshot.status, "completed");
  assert.equal((observations.at(-1)?.snapshot.terminal?.output ?? "").length > 0, true);
});

it("fences every follower-start crash window through the public bridge/recovery facades", async () => {
  for (const checkpoint of [
    "before_dispatch_cas",
    "after_ipc_write_before_response",
    "success_before_cas",
    "unknown_response",
  ] as const) {
    const fixture = phase0Journal.seedManagedCrashFixture({
      checkpoint,
      owner: phase0Journal.seedLivePipelineJob(),
    });
    phase0Journal.armFailpoint(fixture.logicalTurnId, checkpoint);
    await bridge.startTurn({ logicalTurnId: fixture.logicalTurnId }).catch(assertInjectedCrash);
    phase0Journal.close();
    phase0Journal.reopen();
    if (checkpoint === "before_dispatch_cas") {
      assert.equal(phase0Journal.readAttempt(fixture.logicalTurnId).state, "prepared");
      await bridge.recoverTurn({ logicalTurnId: fixture.logicalTurnId });
    } else {
      assert.equal(fakeFollower.startCountFor(fixture.logicalTurnId), 1);
      await bridge.recoverTurn({ logicalTurnId: fixture.logicalTurnId });
      assert.equal(fakeFollower.startCountFor(fixture.logicalTurnId), 1);
    }
  }
});

it("derives the marker only after startTurn rereads the durable logical row", async () => {
  const seeded = phase0Journal.seedManagedRun({
    ...phase0PipelineOwnerFixture(),
    request: turnRequest({ prompt: "BUILD_PROMPT" }),
    runCorrelationId: "run-42",
  });
  await bridge.startTurn({ logicalTurnId: seeded.logicalTurnId });
  const prepared = phase0Journal.readAttemptByLogicalTurn(seeded.logicalTurnId);
  assert.equal(
    prepared.correlationMarker,
    `[stagepass-run:run-42:attempt:${prepared.attemptId}]`,
  );
  assert.equal(prepared.persistedRequest.prompt.includes(prepared.correlationMarker), true);
  assert.equal(prepared.normalizedPromptHash, hashNormalized(prepared.persistedRequest.prompt));
  assert.equal(isUuid(prepared.attemptId), true);
  assert.equal(fakeFollower.startCalls.length, 1);
});

it("rejects stale pipeline and project fences through start/recovery facades", async () => {
  for (const owner of [
    phase0Journal.seedExpiredPipelineJob(),
    phase0Journal.seedExpiredProjectAiRun(),
  ]) {
    const fixture = phase0Journal.seedManagedRun({ owner, request: turnRequest() });
    await assert.rejects(
      bridge.startTurn({ logicalTurnId: fixture.logicalTurnId }),
      hasCode("logical_turn_owner_lease_stale"),
    );
    await assert.rejects(
      bridge.recoverTurn({ logicalTurnId: fixture.logicalTurnId }),
      hasCode("logical_turn_owner_lease_stale"),
    );
  }
  assert.equal(fakeFollower.startCalls.length, 0);
});

it("hands off safe states through recovery only after durable owner takeover", async () => {
  for (const fixture of [
    phase0Journal.seedExpiredSafeAttempt("prepared", "pipeline_job"),
    phase0Journal.seedExpiredSafeAttempt("no_client_found", "project_ai_run"),
  ]) {
    await bridge.recoverTurn({ logicalTurnId: fixture.logicalTurnId });
    const recovered = phase0Journal.readAttempt(fixture.logicalTurnId);
    assert.equal(recovered.attemptId, fixture.attemptId);
    assert.equal(recovered.correlationMarker, fixture.originalMarker);
    assert.equal(recovered.preStartSemanticHash, fixture.originalBaseline);
    assert.equal(recovered.ownerEpoch, fixture.expiredOwnerEpoch + 1);
    assert.equal(phase0Journal.oldFenceCanSettle(fixture.attemptId), false);
  }
  await assert.rejects(
    bridge.recoverTurn({ logicalTurnId: phase0Journal.seedDispatchingAttempt().logicalTurnId }),
    hasCode("unsafe_start_attempt_handoff"),
  );
  assert.equal(
    await bridge.recoverTurn({
      logicalTurnId: phase0Journal.seedDeadlineExpiredSafeAttempt().logicalTurnId,
    }),
    "quarantine_ambiguous",
  );
});

it("adopts exactly one correlated baseline-delta turn and quarantines zero or multiple", async () => {
  const one = ambiguousStartFixture({ matchingNewTurns: 1 });
  await one.recover();
  assert.equal(one.attempt.state, "succeeded");
  assert.equal(one.attempt.turnId, "correlated-turn-1");
  assert.equal(one.followerStartCallsAfterRecovery, 0);

  for (const matchingNewTurns of [0, 2]) {
    const fixture = ambiguousStartFixture({ matchingNewTurns });
    await fixture.recoverThroughDeadline();
    assert.equal(fixture.attempt.state, "quarantined");
    assert.equal(fixture.errorCode, "desktop_follower_start_ambiguous");
    assert.equal(fixture.followerStartCallsAfterRecovery, 0);
  }
});

it("waits read-only when a durable turn id is not yet visible", async () => {
  fakeShellControl.queueThreadReads(
    snapshotWithoutTurn("turn-1"),
    snapshotWithoutTurn("turn-1"),
    snapshotWithTurn("turn-1", "inProgress"),
  );
  const result = await pollKnownTurn("turn-1");
  assert.equal(result.notYetVisibleCount, 2);
  assert.equal(result.cursor, 1);
  assert.equal(fakeFollower.startCalls.length, 0);
});

it("enforces deterministic semantic item evolution", async () => {
  assert.deepEqual(projectSnapshots([
    semanticSnapshot([item("a", "user_message", "v1")]),
    semanticSnapshot([item("a", "user_message", "v2"), item("b", "agent_message", "v1")]),
  ]), ["append:a", "update:a", "append:b"]);
  assert.deepEqual(projectSnapshots([
    semanticSnapshot([item("a", "user_message", "v1")], { durationMs: 1 }),
    semanticSnapshot([item("a", "user_message", "v1")], { durationMs: 999 }),
  ]), ["append:a"]);
  for (const invalid of [
    reorderedItems(),
    removedItem(),
    duplicateItemId(),
    missingItemId(),
    unknownItemType(),
    terminalSemanticDrift(),
  ]) {
    assert.throws(() => projectSnapshots(invalid), hasCode("turn_snapshot_invalid"));
  }
});
```

`phase0-journal.test.ts` must open a real temporary SQLite file, not `:memory:`, and assert the journal creates these minimal production-isomorphic records before any `bridge.startTurn()`:

```ts
const seeded = journal.seedManagedRun({
  owner: { kind: "project_ai_run", projectAiRunId: "PHASE0-RUN-1" },
  binding: {
    scopeKind: "project_prd",
    scopeId: "P-1",
    projectId: "P-1",
    threadId: "thread-prd-1",
  },
  request: turnRequest({ threadId: "thread-prd-1" }),
  phase: "PRD",
  role: "prd_turn",
  round: 0,
  ordinal: 0,
});
assert.equal(journal.readProjectAiRun("PHASE0-RUN-1").leaseToken.length > 0, true);
assert.equal(journal.readBinding("project_prd", "P-1").projectId, "P-1");
assert.equal(
  journal.readLogicalTurn(seeded.logicalTurnId).projectAiRunId,
  "PHASE0-RUN-1",
);
await assert.rejects(
  journal.insertSecondAttempt(seeded.logicalTurnId),
  uniqueViolation("logical_turn_id"),
);
```

The disposable schema includes separate `phase0_pipeline_jobs` and `phase0_project_ai_runs` owner tables plus `phase0_thread_bindings`, `phase0_binding_run_leases`, `phase0_logical_turns`, `phase0_start_attempts`, and `phase0_turn_executions`. Every pipeline-owned fixture first inserts a real live `phase0_pipeline_jobs` row, then inserts its binding/logical row through the real FK; a string constant is never treated as an owner. It mirrors the owner XOR/real FKs, two partial slot indexes, full unique attempt/execution identity, and primary-key binding lease. `bridge.startTurn` must claim the binding lease before internal prepare; terminal/quarantine releases it fenced. A concurrent logical turn on the same binding waits/fails rather than dispatching. Close/reopen the same file across every crash failpoint.

The executable Phase 0 verifier and its bridge integration tests may call only journal seed/failpoint/read helpers plus `bridge.startTurn`, `bridge.recoverTurn`, and `bridge.pollTurn`. They must contain zero direct calls to attempt transition ports (`prepare`, `claimDispatch`, `record*`, `adopt*`, `quarantine`, or safe-handoff CAS). Those ports receive isolated unit tests, but their results are not accepted as Phase 0 evidence.

- [ ] **Step 3: Run the bridge contract test and verify failure**

Run: `pnpm test -- spikes/codex-desktop-mcp/phase0-journal.test.ts server/services/codex-app-server-shell-control.test.ts server/services/codex-desktop-bridge.test.ts`

Expected: FAIL because the disposable durable journal, Hybrid shell/follower adapters, and exported types do not exist.

- [ ] **Step 4: Define the stable bridge interface**

Create `server/services/codex-desktop-bridge-types.ts` with this public boundary:

```ts
export const REQUIRED_APP_SERVER_SHELL_CAPABILITIES = [
  "thread/start:persistent",
  "thread/name/set",
  "thread/read:includeTurns",
  "thread/list",
  "model/list",
] as const;

export const REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES = [
  "deep-link:codex-thread",
  "thread-follower-start-turn",
  "turn/interrupt",
  "project/alternate-cwd",
] as const;

export const REQUIRED_PHASE0_MCP_HOST_EVIDENCE = [
  "app/source-thread-attestation",
  "app/protected-submit-channel",
  "ui-message/same-thread",
] as const;

export interface CodexDesktopProbe {
  appServerVersion: string;
  appServerProtocolFingerprint: string;
  desktopClientVersion: string;
  desktopFollowerProtocolFingerprint: string;
  shellCapabilities: string[];
  followerCapabilities: string[];
}

export interface CodexPhase0McpHostEvidence {
  verifiedBy: "real-mcp-fixture";
  checks: Record<(typeof REQUIRED_PHASE0_MCP_HOST_EVIDENCE)[number], "passed">;
  hostFingerprint: string;
  verifiedAt: string;
}

export interface CodexPersistentShell {
  threadId: string;
  title: string;
  cwd: string;
  ephemeral: false;
}

export interface CodexDesktopTurnRequest {
  threadId: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy: "never";
  sandboxMode: "read-only" | "workspace-write";
}

export interface CodexFollowerStartFence {
  logicalTurnId: string;
  owner:
    | { kind: "pipeline_job"; pipelineJobId: string }
    | { kind: "project_ai_run"; projectAiRunId: string };
  projectId: string;
  scopeKind: "change" | "project_prd" | "project_context";
  scopeId: string;
  workerId: string;
  leaseToken: string;
  ownerAttempt: number;
  ownerEpoch: number;
  purpose: "stage_run" | "interaction_present" | "interaction_wakeup";
  deadlineAt: string;
}

type CodexItemMetadata = {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

export type NormalizedCodexTurnItem =
  | { id: string; kind: "user_message"; semantic: { text: string }; metadata?: CodexItemMetadata }
  | { id: string; kind: "agent_message"; semantic: { text: string }; metadata?: CodexItemMetadata }
  | {
      id: string;
      kind: "command_execution";
      semantic: {
        command: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        output: string | null;
      };
      metadata?: CodexItemMetadata;
    }
  | {
      id: string;
      kind: "tool_call";
      semantic: {
        name: string;
        status: "running" | "completed" | "failed";
        result: string | null;
      };
      metadata?: CodexItemMetadata;
    }
  | {
      id: string;
      kind: "file_change";
      semantic: { path: string; change: "added" | "modified" | "deleted" };
      metadata?: CodexItemMetadata;
    }
  | {
      id: string;
      kind: "error";
      semantic: { code: string; message: string };
      metadata?: CodexItemMetadata;
    };

export interface CodexTurnSnapshot {
  threadId: string;
  turnId: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  items: NormalizedCodexTurnItem[];
  terminal?: { output?: string; errorCode?: string; errorMessage?: string };
  metadata: {
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    observedAt: string;
  };
}

export interface CodexTurnObservation {
  kind: "observation";
  cursor: number; // StagePass-local monotonic observation sequence
  semanticSnapshotHash: string;
  snapshot: CodexTurnSnapshot;
}

export type CodexTurnPollResult =
  | CodexTurnObservation
  | {
      kind: "turn_not_yet_visible";
      threadId: string;
      turnId: string;
      observedAt: string;
    };

export interface CodexFollowerStartRecoveryFence {
  recoveryOwnerId: string;
  recoveryLeaseToken: string;
  recoveryEpoch: number;
}

export interface CodexFollowerStartAttemptPort {
  prepare(input: {
    attemptId: string; // generated by bridge, never accepted from an AI caller
    logicalTurnId: string;
  }): Promise<{
    state: "prepared";
    correlationMarker: string;
    normalizedPromptHash: string;
    persistedRequestWithMarker: CodexDesktopTurnRequest;
  }>;
  claimDispatch(input: { attemptId: string; fence: CodexFollowerStartFence }): Promise<number>;
  claimSafeAttemptForWorker(input: {
    attemptId: string;
    expectedState: "prepared" | "no_client_found";
    expectedOldFence: CodexFollowerStartFence;
    newFence: CodexFollowerStartFence;
  }): Promise<void>;
  recordNoClientFound(input: {
    attemptId: string;
    dispatchOrdinal: number;
    fence: CodexFollowerStartFence;
  }): Promise<void>;
  recordSuccess(input: {
    attemptId: string;
    dispatchOrdinal: number;
    turnId: string;
    fence: CodexFollowerStartFence;
  }): Promise<void>; // same transaction writes execution row + binding proof
  recordAmbiguous(input: {
    attemptId: string;
    dispatchOrdinal: number;
    reason: "timeout" | "disconnect" | "unknown_response";
    fence: CodexFollowerStartFence;
  }): Promise<void>;
  claimReconciliation(input: {
    attemptId: string;
    recoveryOwnerId: string;
    recoveryLeaseToken: string;
    recoveryEpoch: number;
  }): Promise<CodexFollowerStartRecoveryFence>;
  adoptSuccess(input: {
    attemptId: string;
    dispatchOrdinal: number;
    turnId: string;
    fence: CodexFollowerStartRecoveryFence;
  }): Promise<void>; // same transaction writes execution row + binding proof
  quarantine(input: {
    attemptId: string;
    dispatchOrdinal: number;
    code: "desktop_follower_start_ambiguous";
    fence: CodexFollowerStartRecoveryFence;
  }): Promise<void>;
}
```

`CodexFollowerStartAttemptPort.prepare()` is an internal durable port. From only `attemptId + logicalTurnId`, it re-reads the immutable canonical request/hash, binding/thread, concrete owner FK, live lease fence, deadline, and correlation from the logical row; it performs the pre-start `thread/read` itself and persists the baseline. No overload accepts request, fence, correlation, thread, or baseline from a runtime caller. Contract tests seed the journal and invoke only `bridge.startTurn({ logicalTurnId })`.

- [ ] **Step 5: Implement the two private transport boundaries**

Create `server/services/codex-app-server-shell-control.ts`. Its allowlisted interface contains no managed-turn method:

```ts
export interface CodexAppServerShellControl {
  probe(): Promise<{ version: string; protocolFingerprint: string; capabilities: string[] }>;
  startPersistentThread(input: { cwd: string; ephemeral: false }): Promise<{ threadId: string }>;
  setThreadName(input: { threadId: string; name: string }): Promise<void>;
  findPersistentShell(input: { cwd: string; title: string }): Promise<CodexPersistentShell[]>;
  readPersistentShell(threadId: string): Promise<CodexPersistentShell | null>;
  readThreadWithTurns(input: { threadId: string; includeTurns: true }): Promise<{
    shell: CodexPersistentShell;
    turns: CodexTurnSnapshot[];
  }>;
  listModels(): Promise<CodexModel[]>;
}
```

Internally it may issue only initialized control methods, `thread/start` with literal `ephemeral:false`, `thread/name/set`, `thread/read` with literal `includeTurns:true`, the verified thread-list method, and model-list. A source/runtime contract test fails on any app-server request with method exactly `turn/start`. `readThreadWithTurns` validates the returned thread id and uses a protocol-fingerprint-specific allowlist to normalize item ids/kinds/semantic payload plus terminal output/error. Unknown kind/field, missing or duplicate id, invalid status, or malformed terminal data fails `turn_snapshot_invalid`; timestamps/duration/read time go only to metadata.

The pinned Phase 0 runtime adapter currently supports only the exact signed Desktop identity `com.openai.codex` / `26.721.30844` / build `5813` / Chromium `150.0.7871.128` / Team `2DC432GLL2`, its bundled `codex-cli 0.146.0-alpha.3`, and the observed initialize user-agent `Codex Desktop/0.146.0-alpha.3 (Mac OS 26.5.1; arm64) dumb (stagepass; 0.1.0)`. The 698-file experimental generated schema has canonical relative-tree hash `fd6f8bb9872165ce1e991c7ec175aa370bf1b4bbf797b5574b53eafd194711a1`, computed from sorted per-file hashes after removing the leading `./` from each path; `v2/Turn.ts` remains `5a0852e46a13446ccb3aa3f493c06a9151a43772d530521789ac741ed115da5f`. Critical initialize/thread start-name-list-read/model-list/Turn/Model types are byte-identical to the previous supported snapshot; `v2/Thread.ts` adds `canAcceptDirectInput`, while new audio variants in `UserInput`/dynamic-tool output are outside shell-control's use. Any other signed build remains unsupported until it receives its own explicit fingerprint and compatibility review.

Create `server/services/codex-desktop-ipc-transport.ts` with only follower execution:

```ts
export interface CodexDesktopFollowerTransport {
  probe(): Promise<{ clientVersion: string; protocolFingerprint: string; capabilities: string[] }>;
  openThreadDeepLink(input: { url: `codex://threads/${string}` }): Promise<void>;
  startFollowerTurn(
    input: CodexDesktopTurnRequest,
  ): Promise<{ status: "started"; turnId: string } | { status: "no-client-found" }>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
}
```

Map the verified Desktop request only inside `startFollowerTurn`; include literal `thread-follower-start-turn` in this file and nowhere else. Do not invent `probeFollower`, another non-mutating readiness call, `project/resolve`, Desktop `thread/create`, generic `thread/events`, or a Desktop lifecycle notification stream. The real start response's explicit `no-client-found` or `{ status:"started", turnId }` is the only readiness result. The follower transport ends at deep link, start, and targeted interrupt; all lifecycle reads belong to app-server shell/read control.

Create `server/services/codex-desktop-ipc-discovery.ts` with an injectable filesystem/process probe. Resolve only an endpoint advertised by the running Codex Desktop instance, validate owner UID and file permissions before connecting, and return `desktop_bridge_unavailable` when discovery is ambiguous. Tests must prove that a stale endpoint, a world-writable socket, and a socket owned by another UID are rejected.

- [ ] **Step 6: Implement the fail-closed facade**

Create `server/services/codex-desktop-bridge.ts` with:

```ts
export class CodexDesktopBridgeError extends Error {
  constructor(
    readonly code:
      | "desktop_bridge_disabled"
      | "desktop_bridge_unavailable"
      | "codex_hybrid_bridge_unsupported"
      | "desktop_protocol_invalid"
      | "desktop_follower_not_ready"
      | "desktop_follower_start_ambiguous"
      | "app_server_turn_observation_lost"
      | "turn_observation_timeout"
      | "turn_snapshot_invalid"
      | "shell_provision_ambiguous"
      | "desktop_thread_detached",
    message: string,
  ) {
    super(message);
    this.name = "CodexDesktopBridgeError";
  }
}

export interface CodexDesktopBridge {
  probe(): Promise<CodexDesktopProbe>;
  ensurePersistentShell(input: {
    projectPath: string;
    scope:
      | { kind: "change"; scopeId: string; projectId: string; changeId: string }
      | { kind: "project_prd"; scopeId: string; projectId: string }
      | { kind: "project_context"; scopeId: string; projectId: string };
    title: string;
  }): Promise<CodexPersistentShell>;
  startTurn(input: { logicalTurnId: string }): Promise<{ attemptId: string; turnId: string }>;
  recoverTurn(input: { logicalTurnId: string }): Promise<
    { attemptId: string; turnId: string } | "quarantine_ambiguous"
  >;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
  pollTurn(input: {
    threadId: string;
    turnId: string;
    afterCursor?: number;
    lastSemanticSnapshotHash?: string;
    deadlineAt: string;
  }): AsyncIterable<CodexTurnPollResult>;
}
```

`probe()` compares only the app-server shell/read and Desktop follower observed capability groups. It never returns MCP Host attestation/protected-submit/`ui-message` claims; those are independently proven by the real fixture and stored as `CodexPhase0McpHostEvidence`.

`ensurePersistentShell()` uses the strict state sequence `provisioning → bootstrap_ready → materializing → durable_ready`. Candidate id is journaled before deep-link activation. Creator-session proof requires exact id/title/cwd/`ephemeral:false` and zero turns; its immutable empty turn-id baseline/hash is persisted by the bootstrap CAS. Deep link records only `activation_requested`; it is not a persistence or readiness probe. The dedicated materialization turn is the first real managed read-only follower turn and is exactly-once under the existing attempt/correlation/lease rules. Its `prepare` consumes only the creator-persisted baseline—never a pre-dispatch independent read that the target client cannot satisfy. A second app-server client must prove exact shell plus exactly one terminal completed, effect-free turn/marker and exact `STAGEPASS_SHELL_MATERIALIZED` output before the final fenced CAS. Ordinary logical turns cannot read candidate/bootstrap state and continue to obtain a real independent baseline.

Recovery never searches by title/cwd/post-baseline to invent a winner. Creator proof complete resumes materialization without another `thread/start`; candidate recorded but incomplete creator proof/session loss is ambiguous; a possibly committed start without candidate is permanently ambiguous. Provision has an immutable deadline plus renewable owner lease and monotonic owner attempt/epoch. Expired `bootstrap_ready|materializing` claims preserve candidate/logical/attempt/marker/ordinal: prepared/no-client may safe-handoff only the same attempt and budget; dispatching/ambiguous only reconcile; succeeded only repeats proof/promotion. Dispatching/timeout/disconnect/unknown response never resend: exact marker count one adopts, more than one quarantines, zero polls to deadline then quarantines. A crash after independent proof but before final CAS repeats read-only proof and promotes. Live proof-budget exhaustion uses `failMaterializationProof`; immutable deadline expiry is a separate transition.

`startTurn()` accepts only the Server-resolved `logicalTurnId`. It re-reads the immutable canonical request, binding id, XOR owner FK, worker/lease/owner-attempt/epoch/deadline fence, and service-derived correlation from durable storage; none are supplied by the runtime caller. It generates a UUID `attemptId` and reads the pre-start baseline. One `prepare()` transaction verifies the owner FK/live lease and binding/canonical thread, enforces full one-row unique `(logical_turn_id)`, derives `[stagepass-run:${runCorrelationId}:attempt:${attemptId}]`, injects it into the persisted canonical request, hashes the normalized final prompt, and atomically persists marker/hash/baseline/fence as `prepared`. Only after CAS to `dispatching` may it open the deep link and call `requestWithMarker`. Explicit no-client retries the same logical turn/attempt; success writes attempt, execution, logical status, and binding proof in one transaction.

Every state CAS matches `attemptId + logicalTurnId + expected state + dispatchOrdinal + concrete owner FK + workerId/leaseToken/ownerAttempt/ownerEpoch`; stale workers cannot settle. Recovery must first acquire/renew the corresponding live owner lease. Only then may `claimSafeAttemptForWorker` take `prepared|no_client_found`, prove the old lease expired and logical turn belongs to that live owner, preserve attempt id/marker/baseline/ordinal, and replace the owner fence; prepared may first-dispatch, while no-client may advance to the next ordinal only inside its original budget. Dispatching/ambiguous can never use handoff.

Timeout/disconnect/unknown response is fenced to `ambiguous`; crash after dispatch or success-before-CAS may remain `dispatching`. Recovery claims a separate recovery fence and uses baseline delta + exact marker/hash. Unique adoption writes attempt, execution, logical status, and binding proof in one transaction; zero candidates poll until deadline then quarantine; multiple/mismatch quarantine immediately. No ambiguous/quarantined attempt dispatches again.

After a durable start success/adoption, `pollTurn()` calls only app-server `thread/read { threadId, includeTurns:true }`: start at 500ms and back off unchanged semantic snapshots to at most 2 seconds; give each RPC a 5-second deadline; stop at the existing run/job deadline. If the known turn id is absent, yield/record `turn_not_yet_visible` without cursor/output and continue read-only; never call start. Deadline exhaustion is `turn_observation_timeout`.

For a visible turn, require unique item ids. Existing ids may update allowlisted semantic payload but cannot reorder or disappear; new ids append only. Project only appended items and same-id semantic updates. Compute the semantic hash from threadId, turnId, normalized status, ordered item id/kind/semantic payload, and terminal output/error; exclude `startedAt`, `completedAt`, `durationMs`, `observedAt`, and other volatile metadata. Identical reconnect snapshots or duration-only changes emit zero output/cursor. Reject reorder, removal, duplicate/missing ids, unknown kind/fields, state regression, turn mismatch, or any post-terminal semantic drift as `turn_snapshot_invalid`.

On app-server read disconnect, respawn and initialize that control connection with 250ms exponential backoff capped at 2 seconds and a 15-second consecutive-outage budget. Resume from persisted `lastSemanticSnapshotHash`/cursor because `thread/read` returns a full snapshot. Exhaustion returns recoverable `app_server_turn_observation_lost`; deadline exhaustion returns `turn_observation_timeout`. Neither is success, neither creates a shell, and neither falls back to app-server `turn/start`.

- [ ] **Step 7: Run the bridge test**

Run: `pnpm test -- spikes/codex-desktop-mcp/phase0-journal.test.ts server/services/codex-app-server-shell-control.test.ts server/services/codex-desktop-bridge.test.ts`

Expected: PASS for the 21-check manifest, including separate `persistent_shell_provisioned_and_named` bootstrap evidence and `shell_materialized_and_independently_proved` strict evidence; one candidate, one `thread/start`, one terminal effect-free materialization turn and no blind adoption/resend across recovery; creator baseline dispatch despite pre-materialization independent invisibility; durable exactly-once start across crash-before-dispatch/after-IPC-write-before-response/success-before-CAS/unknown response; unique baseline+marker adoption and zero/multiple quarantine; bounded explicit `no-client-found` retry; `turn_not_yet_visible` read-only waiting; deterministic append/same-id update with duplicate turn/item, reorder/removal/unknown/terminal-drift rejection and volatile-metadata dedupe; restart reuse of the same durable shell for first and second ordinary turns; read reconnect; targeted interrupt; no invented readiness/lifecycle subscription; and zero app-server `turn/start`. The verifier-specific test/typecheck gate must compile the verifier, contract, restart orchestration, and their tests together. The independent bootstrap crash database keeps a stable journal id in the report and resume reopens it to reconcile every provision/candidate/binding/materialization/attempt/turn field plus exact 1/1/1 cardinality. Each crash child must emit the expected checkpoint tag; after-IPC additionally emits `writeCommitted:true`, while untagged initialization/pre-write failures reject. Checkpoint、resume、change-isolation、real-crash sentinel 都必须等待 terminal `completed` 并 byte-exact 匹配预期输出；错误、`inProgress`、尾随空白或错误文本均为失败。

- [ ] **Step 8: Build the minimal real MCP/App fixture**

`spikes/codex-desktop-mcp/server.ts` must register one UI resource and exactly two tools:

```text
present_phase0_card  visibility=["model","app"], widgetAccessible=true
submit_phase0_card   visibility=["app"], openai/visibility="private"
```

The present tool puts a single-use nonce only in App-private `_meta`. Status requests and invalid/cross-binding verification requests finish before nonce minting; if presentation fails after mint but before private `_meta` handoff, the MCP server revokes that nonce over the protected channel. Repeated negative requests must keep active nonce and retained-secret counts at zero. The App business click calls only the private continuation action; Server atomically saves the click, ensures the queued wake job/outbox, authorizes it, and returns a one-shot signed dispatch bound to thread/interaction/job/attempt/marker/expiry. The workspace-locked official `@modelcontextprotocol/ext-apps@1.7.4` API exposes `App.sendMessage()` on the view and describes the Host capability as “receiving content messages (ui/message) from the view”; it exposes no Server/supervisor direct-send API. Accordingly `spikes/codex-desktop-mcp/host-transport.ts` is the view's sole Host transport endpoint: it consumes the signed dispatch, calls `App.sendMessage()` with `STAGEPASS_PHASE0_WAKEUP <threadId> <nonceId> <jobId> <attemptId>`, then invokes protected ack so Server can durably record a receipt before settlement. Recovery reads that receipt first; without one it reconciles the same-thread marker and never redispatches an unknown send result. Tests cover both ack-before-receipt and receipt-before-settlement crashes, plus a known rejection whose real retry increments `dispatch_count`.

`spikes/codex-desktop-mcp/supervisor.ts` remains the disposable Host-side launcher/broker: it keeps an ephemeral secret in its own memory, verifies the direct Codex parent ancestry available to it, and passes only an already-open authorization channel to the MCP child. The submit tool rejects missing Host source-thread attestation, wrong thread, reused/expired nonce, model invocation, and any caller without that protected channel. Node/macOS inherited-FD APIs expose no Server-readable peer PID/audit token, so Server launch attestation remains explicitly `phase0_server_launch_attestation_unsupported`; parent-process checks, channel possession, launch records, and bundle hashes must not be reported as Server peer attestation.

`scripts/build-codex-desktop-mcp-spike.ts` produces a disposable bundle in `.stagepass/phase0-mcp/`. `server.test.ts` asserts the locked ext-apps package/type boundary, tool metadata, nonce rules, source binding, protected-channel requirement, private-continuation-before-message order, and that `.sendMessage()` exists only in the receipt-validating view transport. The fixture must not create an auth key in the repo/worktree, command line, environment, or MCP-readable filesystem.

- [ ] **Step 9: Run the fixture contract test**

Run:

```bash
pnpm test -- spikes/codex-desktop-mcp/server.test.ts
pnpm tsx scripts/build-codex-desktop-mcp-spike.ts
```

Expected: test PASS and both `.stagepass/phase0-mcp/supervisor.mjs` and `.stagepass/phase0-mcp/server.mjs` exist.

- [ ] **Step 10: Build the real-client verifier**

Create `scripts/verify-codex-desktop-bridge.ts` to execute these named checks and write one JSON result:

```ts
const checks = [
  "persistent_shell_provisioned_and_named",
  "deep_link_visible_and_persistent",
  "shell_materialized_and_independently_proved",
  "durable_follower_start_exactly_once_all_crash_windows",
  "managed_turn_started_only_by_follower",
  "turn_visibility_lag_and_terminal_read_observed",
  "same_shell_second_follower_turn_completed",
  "shell_reused_after_follower_timeout",
  "ambiguous_provision_reconciled_or_failed_closed",
  "read_reconnect_and_semantic_snapshot_rules",
  "two_changes_named_and_isolated",
  "target_interrupt_and_detach_handled",
  "model_effort_sandbox_and_worktree_forwarded",
  "mcp_app_presented_without_host_tool_dependency",
  "present_status_submit_source_attested_and_cross_task_isolated",
  "user_click_saved_once_and_woke_same_shell",
  "managed_turn_cannot_mint_submit_auth",
  "ordinary_process_cannot_authorize_submit",
  "host_mcp_channel_can_submit",
  "shell_control_read_list_and_model_catalog_work",
  "app_server_managed_turn_start_count_zero",
] as const;
```

`persistent_shell_provisioned_and_named` is satisfied only by creator-session bootstrap proof. `deep_link_visible_and_persistent`, reusable canonical binding, and ordinary managed-turn eligibility remain false until `shell_materialized_and_independently_proved` reaches `durable_ready`. The observed pre-materialization invisibility from a second app-server client is target behavior evidence, not a generic visibility-timeout success.

The report must carry an explicit schema version and validate its envelope, exact check manifest, required-evidence map, arrays, and records before any nested access. It serializes the bootstrap candidate/state/baseline, stable semantic baseline hash, materialization logical turn, attempt id/state/ordinal, turn id, marker, candidate/thread-start/attempt/execution counts, child/recovery app-server method counts, and final promotion state. `startAttemptEvidence` is general evidence for checkpoint/resume/ordinary/crash paths and includes logical id, attempt id/state/ordinal, baseline count/ids/semantic hash, normalized prompt hash, correlation marker, turn id, recovery outcome, ambiguity reason, correlated count, and outcome. `after_thread_start` crash evidence must reopen fail-closed with the same candidate, one start, zero materialization attempts, and no recovery create. A separate real child process crash after the `bootstrap_ready` CAS must reopen and materialize the same candidate with child `thread/start=1` and recovery `thread/start=0`.

Desktop restart authority lives in the versioned SQLite `phase0_restart_checkpoints` row, not in JSON alone. Fresh execution persists the complete checkpoint identity and normalized terminal snapshot before writing report JSON. `--resume` validates the report envelope, reconciles report↔SQLite byte-for-byte, and may reconstruct missing JSON evidence only from SQLite. A resume turn that already succeeded before a process crash is recovered from its existing durable attempt with zero new follower starts. The consume call supplies expected resumed logical id, attempt id, request thread, canonical binding thread, and the normalized prompt hash derived from the intended `PHASE0_RESTART_RESUME_OK` attempt; the transaction must match all of them against the succeeded row before UPDATE. A different succeeded prompt on the same canonical thread is fenced and leaves the checkpoint awaiting. Successful consume writes logical/attempt/marker/normalized-prompt hash/baseline hash/canonical binding thread/ordinal/turn as a durable SQLite tombstone. If the process crashes after that consume and before report completion is written, the production restart-resume orchestrator reads the consumed tombstone, validates the exact succeeded attempt and byte-exact terminal, reconstructs completion, invokes neither restart nor consume callback, and invokes the downstream Phase 0 continuation exactly once with follower-start delta zero. Tests exercise this production function for both stale and missing completion JSON, rather than checking source text or only a lower-level helper. A consumed checkpoint is not a full-run completion tombstone and therefore cannot permanently reject this continuation; only a separate complete-run tombstone may reject rerunning the whole verifier. The original primary start count remains one and the resume shell-create delta remains zero. Old unversioned/`ready` Phase 0 journal files are incompatible disposable evidence and must demand a fresh run rather than migrate.

Record the already observed baseline in the verifier evidence notes without treating it as a substitute for rerunning the checks: `thread/start(ephemeral:false)` + `thread/name/set` produced a deep-linkable persistent shell; a roughly 1-second follower attempt returned `no-client-found`, a roughly 10-second wait succeeded and completed, and a second follower turn on the same thread also completed. An independent backend `thread/read { threadId, includeTurns:true }` then read both Desktop-started turns with id, items, `status=completed`, `startedAt`, `completedAt`, `durationMs`, and `agentMessage`. Do not record or invoke the conversation-only `codex_app` host tool as a backend capability, and do not require a Desktop lifecycle notification stream.

The verifier creates a unique temporary MCP registration named `stagepass-phase0-<runId>` pointing only to `.stagepass/phase0-mcp/supervisor.mjs` (which launches `server.mjs` through the protected channel), snapshots any prior registration state, and removes/restores exactly that entry in `finally`. It initializes `.stagepass/verification/codex-desktop-bridge-phase0-attempts.sqlite` through `phase0-journal.ts`, provisions/binds the canonical shell, then seeds the concrete live owner lease and Server-owned logical row with immutable request/fence before every formal `bridge.startTurn({ logicalTurnId })`; `prepare()` creates the constrained attempt only after re-reading that storage. Scripted process exits close and reopen the same file, so every failpoint genuinely crosses a persistence boundary; no in-memory fake, caller-supplied request/fence, or direct follower transport call may satisfy the crash checks. It presents the fixture in the created task and waits for the user to click its button.

The target run `66be53ed-3ecc-4cad-af61-1a7d834502b4` recorded candidate `019f9151-a098-7e92-b0eb-8fe33c0c91ed`: creator-session exact read/list proved title/cwd/`ephemeral:false`/zero turns, while 137 independent lists never saw it. This is the regression fixture for the two-phase contract and must not be converted into title-based reconciliation or a second `thread/start`.

For the start checks, use durable verifier storage and deterministic failpoints at before-dispatch CAS, after the follower-start IPC frame is committed to the local kernel but before a response, success-before-CAS, and unknown response. Every prepared attempt records the complete fence, normalized prompt hash, injected correlation marker, pre-start ids/count/semantic hash, attempt state/ordinal, logical id, and child process app-server method counts before an external call; recovery records its outcome and post-recovery attempt evidence. Kill/restart the verifier at each failpoint. The post-write boundary does not prove Desktop processed the frame, so its observed turn delta must be `0|1`; recovery must reconcile read-only and never resend either outcome. For `after_ipc_write_before_response`, delta 0 must end quarantined with no terminal read, while delta 1 must end succeeded and byte-exact completed; both branches require recovery follower-start delta 0 and recovery app-server managed `turn/start=0`. `before_dispatch_cas` may perform the one initial start during recovery; `success_before_cas` and discarded-success `unknown_response` must reconcile one exact existing turn with recovery start delta zero. Prove prepared-before-dispatch may resume, while every dispatching attempt performs read-only baseline+marker reconciliation and never sends again. Exactly one candidate is adopted; forced zero/multiple candidates reach deadline/immediate quarantine. A separate `after_dispatch_cas_before_send` unit failpoint may exercise the pre-send state machine but is not strict external-dispatch evidence. Every verifier start/recover path must inspect the durable attempt and upsert complete evidence; final main-journal attempt cardinality and every immutable field must equal the report's unique attempt evidence, while separate journals carry equivalent dedicated evidence. Record that explicit `no-client-found` creates zero turns, each successful managed run creates exactly one, and Build/Fix fault injection produces one workspace mutation/adoption identity.

For the read checks, immediately poll the real `thread/read(includeTurns:true)` after follower success and record its natural visibility timeline. In addition, a verifier fault-injection wrapper hides the known real turn for two polls to force `turn_not_yet_visible`; prove cursor/output remain unchanged and follower start count does not increase. Force one read connection drop and prove reinitialize/resume yields no duplicate observation and strictly increasing local cursors. Capture real normalized items, then replay them through append, same-id semantic update, reorder, removal, duplicate-id, unknown-kind, volatile-duration-only, identical-reconnect, and terminal-drift fixtures. Only append/update may project; volatile/identical snapshots produce zero output; invalid transitions fail closed. Save semantic hashes separately from raw timestamps/duration metadata.

For the auth-boundary checks, the real follower-started managed turn attempts to discover/read any submit/presentation secret and mint valid authorization, and must fail. A separately spawned ordinary workspace process with route/interaction/body/endpoint details must still fail. The Host-launched MCP process uses the protected inherited channel to present, status-read, submit, and continue only its same-thread interaction. Missing/wrong/cross-task source for present/status/submit returns `source_thread_mismatch`; present/status return zero structured content. The verifier also loses the first submit response after durable authorization and kills the disposable MCP Server child. The originally launch-attested supervisor owns the long-lived broker/signing state and performs bounded backoff respawn with a fresh protected FD; the replacement child proves that the same run id, nonce, canonical job, attempt, and marker retrieve the same signed dispatch without another durable dispatch. Any identity drift or replay mismatch is rejected. Once Host acknowledgement or the durable verification receipt settles the dispatch, every later child gets `dispatch_settled` and no sendable dispatch. These checks produce independent `CodexPhase0McpHostEvidence`, not follower metadata.

- [ ] **Step 11: Run the real-client verifier**

Run: `pnpm tsx scripts/verify-codex-desktop-bridge.ts`

Current expected result: the verifier can enumerate and collect evidence for all 20 checks, but must finish with hard `PHASE0 BLOCKED`, not PASS. Server-readable launch peer/process attestation is currently unavailable (`phase0_server_launch_attestation_unsupported`), and the two marker crash windows remain unobserved across a real view-owned `App.sendMessage` followed by app-server marker/receipt reads (`real_view_marker_crash_windows_unobserved`). Callback or SQLite-only simulation is unit coverage and cannot satisfy either strict real-client check.

Do not begin Task 1 while either blocker remains. Task 1 is unlocked only after a future implementation provides Server-readable peer/process attestation and a complete rerun on the target Codex Desktop client reports overall `PHASE0 PASS` with every check passed.

- [ ] **Step 12: Record only the verification directory rule**

Modify `.gitignore` to ignore transient verifier output while allowing a deliberately copied release artifact:

```gitignore
.stagepass/verification/*
!.stagepass/verification/.gitkeep
.stagepass/phase0-mcp/
```

- [ ] **Step 13: Commit the viability spike**

```bash
git add .gitignore package.json pnpm-lock.yaml server/services/codex-desktop-bridge-types.ts server/services/codex-app-server-shell-control.ts server/services/codex-app-server-shell-control.test.ts server/services/codex-desktop-ipc-discovery.ts server/services/codex-desktop-ipc-transport.ts server/services/codex-desktop-bridge.ts server/services/codex-desktop-bridge.test.ts spikes/codex-desktop-mcp/phase0-journal.ts spikes/codex-desktop-mcp/phase0-journal.test.ts spikes/codex-desktop-mcp/server.ts spikes/codex-desktop-mcp/supervisor.ts spikes/codex-desktop-mcp/ui.ts spikes/codex-desktop-mcp/server.test.ts scripts/build-codex-desktop-mcp-spike.ts scripts/verify-codex-desktop-bridge.ts
git commit -m "spike(codex): verify hybrid persistent tasks"
```

Expected: one commit containing no pipeline route change.

---

### Task 1: Rebaseline the product requirements only after a target-Desktop Phase 0 PASS

**Hard gate:** forbidden while Phase 0 is BLOCKED. A future Server-readable peer/process attestation implementation and a full target-Desktop verifier rerun ending in overall `PHASE0 PASS` are both required before any Task 1 work starts.

**Files:**
- Modify: `docs/STAGEPASS-ACTUAL-REQUIREMENTS.md`
- Create: `server/config/codex-native-flags.ts`
- Create: `server/config/codex-native-flags.test.ts`
- Create: `server/config/codex-decision-rollout.ts`
- Create: `server/config/codex-decision-rollout.test.ts`

- [ ] **Step 1: Write the feature-flag test**

```ts
it("keeps every Codex-native migration surface disabled by default", () => {
  assert.deepEqual(readCodexNativeFlags({}), {
    desktopBridge: false,
    mcpInteractions: false,
    codexDecisionSurfaceMaster: false,
    codexDecisionPhases: [],
    codexDecisionRolloutError: null,
  });
});

it("accepts only explicit on values", () => {
  assert.equal(readCodexNativeFlags({
    STAGEPASS_CODEX_DESKTOP_BRIDGE: "on",
  }).desktopBridge, true);
  assert.equal(readCodexNativeFlags({
    STAGEPASS_CODEX_DESKTOP_BRIDGE: "true",
  }).desktopBridge, false);
});

it("requires master and a phase allowlist entry", () => {
  const partial = readCodexNativeFlags({
    STAGEPASS_CODEX_DECISION_SURFACE: "on",
    STAGEPASS_CODEX_DECISION_PHASES: "PRD,Intake",
  });
  assert.equal(isCodexDecisionSurfaceEnabled("PRD", partial), true);
  assert.equal(isCodexDecisionSurfaceEnabled({
    phase: "PRD",
    kind: "prd_question",
  }, partial), true);
  assert.equal(isCodexDecisionSurfaceEnabled("Spec", partial), false);

  const masterOff = { ...partial, codexDecisionSurfaceMaster: false };
  assert.equal(isCodexDecisionSurfaceEnabled("PRD", masterOff), false);
});

it("fails closed on unknown or blank phase tokens", () => {
  for (const value of ["PRD,Unknown", "PRD,,Spec", " "]) {
    const flags = readCodexNativeFlags({
      STAGEPASS_CODEX_DECISION_SURFACE: "on",
      STAGEPASS_CODEX_DECISION_PHASES: value,
    });
    assert.deepEqual(flags.codexDecisionPhases, []);
    assert.equal(flags.codexDecisionRolloutError, "codex_decision_rollout_invalid");
    assert.equal(isCodexDecisionSurfaceEnabled("PRD", flags), false);
  }
});

it("recognizes the exact complete release set", () => {
  const parsed = parseCodexDecisionPhases(
    "PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge",
  );
  assert.equal(parsed.errorCode, null);
  assert.deepEqual(parsed.phases, CODEX_DECISION_PHASES);
});

it("maps every interaction kind and centralizes rollout env reads", () => {
  assert.deepEqual(
    Object.keys(INTERACTION_KIND_ALLOWED_PHASES).sort(),
    CODEX_DECISION_INTERACTION_KINDS.slice().sort(),
  );
  assert.deepEqual(
    findDecisionRolloutEnvReaders({ exclude: ["server/config/codex-decision-rollout.ts"] }),
    [],
  );
});

it("uses one desktop bridge flag for change and project managed scopes", () => {
  const on = readCodexNativeFlags({ STAGEPASS_CODEX_DESKTOP_BRIDGE: "on" });
  for (const scopeKind of ["change", "project_prd", "project_context"] as const) {
    assert.equal(isCodexManagedScopeEnabled(scopeKind, on), true);
  }
  const off = readCodexNativeFlags({});
  assert.equal(isCodexManagedScopeEnabled("project_prd", off), false);
  assert.equal(isCodexManagedScopeEnabled("project_context", off), false);
});
```

- [ ] **Step 2: Run the flag test and verify failure**

Run: `pnpm test -- server/config/codex-native-flags.test.ts server/config/codex-decision-rollout.test.ts`

Expected: FAIL because `readCodexNativeFlags`, the rollout registry, and its shared helper do not exist.

- [ ] **Step 3: Implement strict flags**

```ts
export function readCodexNativeFlags(
  env: NodeJS.ProcessEnv = process.env,
): CodexNativeFlags {
  const rollout = readCodexDecisionRollout(env);
  return {
    desktopBridge: env.STAGEPASS_CODEX_DESKTOP_BRIDGE === "on",
    mcpInteractions: env.STAGEPASS_MCP_INTERACTIONS === "on",
    codexDecisionSurfaceMaster: rollout.masterEnabled,
    codexDecisionPhases: rollout.phases,
    codexDecisionRolloutError: rollout.errorCode,
  };
}
```

In `codex-decision-rollout.ts`, export the fixed `CODEX_DECISION_PHASES` and `CODEX_DECISION_INTERACTION_KINDS` tuples, one exhaustive `interactionKind → allowed phases` registry, strict `parseCodexDecisionPhases()`, and the only authorization helper. Task 7 imports the kind tuple rather than defining a second list:

```ts
isCodexDecisionSurfaceEnabled(
  target:
    | CodexDecisionPhase
    | { phase: CodexDecisionPhase; kind: CodexDecisionInteractionKind },
  flags: CodexNativeFlags,
): boolean;
```

The parser returns `{ phases, errorCode }`, trims and deduplicates valid tokens, defaults an absent variable to `[]`, and returns no enabled phases plus `codex_decision_rollout_invalid` for an unknown/blank token. The exhaustive registry maps each kind to its allowed phase set because shared kinds such as `gate_decision` span multiple phases; an invalid kind/phase pair returns false and emits that health/config error. No Gateway, Web, Broker, or recovery module may read either rollout environment variable directly.

`STAGEPASS_CODEX_DESKTOP_BRIDGE` gates the Hybrid adapter for every managed scope, not only pipeline jobs. Export `isCodexManagedScopeEnabled(scopeKind, flags)` over the closed `change|project_prd|project_context` union. While off, `prd-service.ts` and `context-init-service.ts` remain explicitly routed to the rollback adapter; while on, they must use project-level owner/binding/logical resolution. Per-caller ad hoc flag reads are forbidden.

- [ ] **Step 4: Rewrite the conflicting requirement statements**

Update `docs/STAGEPASS-ACTUAL-REQUIREMENTS.md` so it explicitly states:

- Components are Server, Web, Codex Hybrid Bridge (app-server shell control + Desktop follower), and StagePass MCP App.
- Codex-only provider removal is already achieved and is no longer the migration priority.
- MCP is required for human-interaction cards and is no longer excluded.
- Web is a control plane, not the primary human-decision surface.
- Codex decision rollout uses one global master plus the strict Server-owned 11-phase allowlist/helper; partial rollout preserves disabled-phase Web paths.
- One Change maps to one persistent Codex task.
- Each Project additionally has one reusable Project PRD task and one reusable Project Context task; project-level AI uses durable project runs rather than synthetic Change ids.
- StagePass Git UI/operations are removed while internal Git evidence remains.
- Phase 0 private-IPC viability is a hard release gate.
- Existing acceptance items 1–18 remain non-regression requirements, with “only through Web” replaced by “through Web control plus Codex task decisions.”

- [ ] **Step 5: Verify flags and requirement contradictions**

Run: `pnpm test -- server/config/codex-native-flags.test.ts server/config/codex-decision-rollout.test.ts`

Expected: PASS.

Run:

```bash
rg -n "不做 MCP|Claude 链路完整在用|当前只包含 Server 和 Web|只通过 Web 完成" docs/STAGEPASS-ACTUAL-REQUIREMENTS.md
```

Expected: no output.

- [ ] **Step 6: Commit the rebaseline**

```bash
git add docs/STAGEPASS-ACTUAL-REQUIREMENTS.md server/config/codex-native-flags.ts server/config/codex-native-flags.test.ts server/config/codex-decision-rollout.ts server/config/codex-decision-rollout.test.ts
git commit -m "docs: rebaseline StagePass around Codex Desktop"
```

---

### Task 2: Add durable thread, interaction, command, and audit state

**Files:**
- Create: `server/db/migrations/0028_codex_native_control_plane.sql`
- Modify: `server/db/migrations/meta/_journal.json`
- Modify: `server/db/migrate.ts`
- Modify: `server/db/schema.ts`
- Modify: `server/services/db-migrations.test.ts`
- Modify: `server/services/change-delete-plan.ts`
- Modify: `server/services/change-delete-plan.test.ts`
- Create: `server/services/project-delete-plan.ts`
- Create: `server/services/project-delete-plan.test.ts`
- Modify: `server/services/project-service.ts`
- Modify: `server/services/project-service.test.ts`
- Modify: `app/api/projects/[id]/route.ts`
- Create: `app/api/projects/[id]/route.test.ts`
- Modify: `server/types/enums.ts`
- Modify: `server/types/models.ts`
- Create: `server/services/codex-native-schema.test.ts`
- Create: `server/services/human-decision-audit-projection.ts`
- Create: `server/services/human-decision-audit-projection.test.ts`

- [ ] **Step 1: Write migration expectations**

Add a migration test that asserts:

```ts
assert.deepEqual(columnNames(sqlite, "codex_thread_bindings"), [
  "binding_id", "scope_kind", "scope_id", "project_id", "change_id",
  "codex_project_id", "thread_id", "title",
  "status", "bridge_protocol_version", "provision_claim_token",
  "provision_lease_owner", "provision_lease_expires_at",
  "follower_start_proved_at", "last_turn_id",
  "last_observation_cursor", "last_semantic_snapshot_hash", "last_seen_at",
  "last_error_code", "created_at", "updated_at",
]);
for (const column of [
  "id", "project_id", "kind", "request_key", "sequence",
  "status", "worker_id", "lease_token", "owner_attempt", "owner_epoch",
  "deadline_at", "created_at", "updated_at", "completed_at",
]) {
  assert.ok(columnNames(sqlite, "project_ai_runs").includes(column));
}
assert.deepEqual(readCheckValues(sqlite, "project_ai_runs", "status"), [
  "pending", "leased", "running", "succeeded", "failed", "cancelled", "quarantined",
]);
assert.ok(columnNames(sqlite, "human_decisions").includes("interaction_id"));
assert.ok(columnNames(sqlite, "human_decisions").includes("actor_surface"));
assert.ok(columnNames(sqlite, "human_decisions").includes("codex_thread_id"));
assert.ok(columnNames(sqlite, "human_decisions").includes("command_id"));
assert.ok(columnNames(sqlite, "projects").includes("default_codex_model"));
assert.ok(columnNames(sqlite, "projects").includes("default_reasoning_effort"));
assert.ok(columnNames(sqlite, "changes").includes("codex_model"));
assert.ok(columnNames(sqlite, "changes").includes("reasoning_effort"));
for (const column of [
  "job_kind", "effect_type", "interaction_id", "command_id",
  "effect_schema_version", "effect_payload_json",
  "next_turn_ordinal", "effect_deadline_at",
]) {
  assert.ok(columnNames(sqlite, "pipeline_jobs").includes(column));
}
assert.deepEqual(readCheckValues(sqlite, "pipeline_jobs", "job_kind"), [
  "stage", "interaction_present", "interaction_wakeup",
]);
for (const column of [
  "start_attempt_id",
  "logical_turn_id",
  "dispatch_surface",
  "last_observation_cursor",
  "normalized_items_json",
  "last_semantic_snapshot_hash",
  "terminal_semantic_hash",
  "not_yet_visible_count",
]) {
  assert.ok(columnNames(sqlite, "codex_turn_executions").includes(column));
}
for (const column of [
  "logical_turn_id", "pipeline_job_id", "project_ai_run_id", "binding_id",
  "interaction_id", "command_id", "phase", "role", "round", "ordinal",
  "turn_slot", "run_correlation_id", "canonical_request_json",
  "canonical_request_hash", "dispatch_surface", "status",
]) {
  assert.ok(columnNames(sqlite, "codex_logical_turns").includes(column));
}
for (const column of [
  "attempt_id", "logical_turn_id", "run_correlation_id",
  "pipeline_job_id", "project_ai_run_id",
  "worker_id", "lease_token", "owner_attempt", "owner_epoch", "thread_id",
  "purpose", "dispatch_surface", "normalized_prompt_hash",
  "correlation_marker", "cwd", "model", "reasoning_effort", "sandbox_mode",
  "approval_policy", "pre_start_turn_ids_json", "pre_start_semantic_hash",
  "state", "dispatch_ordinal", "dispatch_count", "budget_deadline",
  "follower_turn_id", "recovery_owner_id", "recovery_lease_token",
  "recovery_epoch", "last_result", "last_error_code",
]) {
  assert.ok(columnNames(sqlite, "codex_follower_start_attempts").includes(column));
}
for (const column of [
  "binding_id", "logical_turn_id", "attempt_id", "worker_id",
  "lease_token", "owner_epoch", "lease_expires_at", "deadline_at",
]) {
  assert.ok(columnNames(sqlite, "codex_binding_run_leases").includes(column));
}
for (const table of [
  "codex_logical_turns",
  "codex_follower_start_attempts",
  "codex_turn_executions",
]) {
  assert.deepEqual(readCheckValues(sqlite, table, "dispatch_surface"), [
    "follower_ipc", "host_ui_message",
  ]);
}
```

Also assert that `codex_thread_bindings`, `codex_binding_run_leases`, `project_ai_runs`, `codex_interactions`, `pipeline_command_receipts`, `pipeline_command_outbox`, `codex_logical_turns`, `codex_turn_executions`, and `codex_follower_start_attempts` exist. Binding-run lease primary key/foreign key `binding_id` enforces at most one active managed execution per shell. Bindings enforce the scope union and unique `(scope_kind, scope_id)`. Logical turns have DB UUID identity and unique owner-slot/correlation constraints. Start attempts have full unique `logical_turn_id`; executions have unique start-attempt/logical-turn/thread-turn identity.

`codex_project_id` is nullable because the verified Hybrid path identifies Project ownership by persistent shell cwd/repo and may not expose a Desktop Project id. `thread_id` is nullable only during provisioning; once ready it is the app-server-provisioned shell id used by the Desktop follower.

- [ ] **Step 2: Run migration tests and verify failure**

Run: `pnpm test -- server/services/db-migrations.test.ts server/services/codex-native-schema.test.ts server/services/human-decision-audit-projection.test.ts`

Expected: FAIL because migration `0028_codex_native_control_plane` and schema exports do not exist.

- [ ] **Step 3: Add the additive SQL migration**

Create the nine tables and indexes defined in the design. Use these fixed status checks:

```sql
CHECK (status IN ('provisioning','ready','running','waiting_human','failed','detached'))
CHECK (status IN ('pending','presented','submitting','completed','expired','superseded','cancelled','failed'))
CHECK (status IN ('accepted','completed','rejected','failed'))
CHECK (kind IN ('prd_turn','context_init'))
CHECK (status IN ('pending','leased','running','succeeded','failed','cancelled','quarantined'))
CHECK (scope_kind IN ('change','project_prd','project_context'))
CHECK (state IN ('prepared','dispatching','no_client_found','ambiguous','succeeded','quarantined'))
```

The SQL must encode scope and owner identity directly. `codex_thread_bindings` checks that change scope has non-null matching `change_id`, while project scopes have `change_id IS NULL` and `scope_id=project_id`; `project_id` is always non-null. `project_ai_runs` carries durable worker/lease/owner-attempt/owner-epoch/deadline fields and unique `(project_id, kind, request_key)`.

`project_ai_runs` uses the exact state machine `pending→leased→running→succeeded|failed|cancelled|quarantined`; expired `leased|running` may only CAS to a new `leased` worker/token with incremented owner attempt/epoch. Its shared `isLiveProjectAiRunLease()` predicate requires status `leased|running`, matching non-null worker/token, `lease_expires_at > now`, and `deadline_at > now`. Migration/service/recovery tests cover every allowed edge and reject terminal resurrection, stale token, expired lease, and expired deadline.

Extend the existing `pipeline_jobs` table additively instead of overloading its stage identity. Add `job_kind='stage'|'interaction_present'|'interaction_wakeup'`, nullable `effect_type`, `interaction_id`, `command_id`, `effect_schema_version`, and `effect_payload_json`, plus non-null `next_turn_ordinal DEFAULT 0` and nullable `effect_deadline_at`. The typed payload is parsed by a closed Zod union: presentation payload `{ schemaVersion:"stagepass.pipeline-effect/v1", kind:"interaction_present", interactionId }`; wake payload `{ schemaVersion:"stagepass.pipeline-effect/v1", kind:"interaction_wakeup", interactionId, commandId }`; stage jobs cannot carry an effect payload. SQL checks require presentation rows to have interaction/effect/deadline and no command, and wake rows to have interaction/command/effect/deadline. Add real FKs for interaction and command ownership.

Replace the old unconditional stage uniqueness index with a partial index applying only to `job_kind='stage'`. Add partial unique indexes on `(interaction_id,effect_type) WHERE job_kind='interaction_present'` and `(command_id,effect_type) WHERE job_kind='interaction_wakeup'`. Presentation `effect_deadline_at` is copied from `codex_interactions.expires_at` in the interaction-creation transaction. Wake deadline is fixed by command completion policy in its transaction. `next_turn_ordinal` is allocated and incremented by fenced CAS on the job row before logical resolution; it never derives from worker retry/lease attempt counters. Migration tests prove two effect jobs do not collide with the existing Change/phase stage unique key, duplicate presentation/wake identities collapse, malformed typed payloads fail, and ordinal/deadline survive reopen/recovery.

`codex_logical_turns.logical_turn_id` is a DB-generated UUID. Store nullable `pipeline_job_id` and `project_ai_run_id`, add real foreign keys to both owner tables, and add `CHECK ((pipeline_job_id IS NOT NULL) <> (project_ai_run_id IS NOT NULL))`. Enforce slot identity with two partial unique indexes: pipeline `(pipeline_job_id, phase, role, round, ordinal) WHERE pipeline_job_id IS NOT NULL`, and project `(project_ai_run_id, phase, role, round, ordinal) WHERE project_ai_run_id IS NOT NULL`; also unique-index `turn_slot` and `run_correlation_id`. Persist the fully normalized canonical Desktop request and its hash in the logical row during resolver scheduling; it is immutable on conflict, and `bridge.startTurn({ logicalTurnId })` must re-read it. Wakeup `turn_slot` includes the concrete owner FK, interaction id, command id, role, round, and ordinal.

`codex_follower_start_attempts` references `logical_turn_id`, repeats the same nullable owner FK pair with XOR `CHECK` and real foreign keys, and validates in `prepare()` that it equals the logical row's owner columns. It has a full unique index on `logical_turn_id` so one logical turn cannot own a second attempt even after terminal state. `codex_turn_executions` has separate unique indexes for `start_attempt_id`, `logical_turn_id`, and `(thread_id, turn_id)`. Persist `owner_epoch` in the start-attempt owner fence and keep execution→attempt→logical→owner foreign keys child-first for deletion. Migration tests insert missing/both-owner rows and require SQLite constraint failure, proving ownership is not merely application-enforced.

Add immutable non-null `dispatch_surface` to `codex_logical_turns`, `codex_follower_start_attempts`, and `codex_turn_executions`, each with `CHECK (dispatch_surface IN ('follower_ipc','host_ui_message'))`. Export one exhaustive `STAGEPASS_DISPATCH_SURFACE_BY_ROLE` registry over the authoritative logical-role union: `stage`, `spec_writer`, `spec_critic`, `spec_verdict`, `build`, `fix`, `prd_turn`, `context_select`, `context_generate`, and `interaction_present` map to `follower_ipc`; only `interaction_wakeup` maps to `host_ui_message`. Pipeline phase names such as intake, tech-spec, plan, test-plan, review, QA, and merge remain `phase` values and do not create additional logical roles. Resolver inserts the logical value from that registry. Attempt `prepare` must copy and compare it with the logical row; every settlement and recovery adoption must compare execution→attempt→logical equality and the role registry again. Any mismatch returns `dispatch_surface_mismatch`, performs zero follower/Host/app-server calls, and cannot mutate status.

`codex_binding_run_leases.binding_id` is both primary key and real FK to bindings. A competing logical turn on the same binding must fail claim while the row is live; expired takeover increments epoch, and stale release fails. Attempt prepare requires a matching binding lease and copies its token/epoch. Terminal/quarantine/cancel performs fenced delete/release in the settlement transaction.

Do not backfill `actor_surface` on historical rows. Add it as nullable with:

```sql
CHECK (
  actor_surface IS NULL OR actor_surface IN (
    'codex_mcp_app',
    'stagepass_web_emergency',
    'stagepass_web_ops',
    'legacy_web_migration',
    'recovery'
  )
)
```

Only new commands that still enter through a not-yet-migrated Web decision surface write `legacy_web_migration`; historical `NULL` stays `NULL` and is labeled `legacy` only by the read projection.

Do not drop or rename `changes.codex_thread_id` or `change_provider_sessions`.

Append an `idx: 28` entry for `0028_codex_native_control_plane` to `server/db/migrations/meta/_journal.json`. Extend `server/db/migrate.ts` with `repairCodexNativeControlPlaneSchema(sqlite)` and call it for 0028 before recording the tag. Add a replay test where 0028 columns/tables already exist but its `__migrations` row is absent; migration must repair indexes/FKs and record the tag without deleting data.

- [ ] **Step 4: Mirror the SQL in Drizzle schema and Zod types**

Export `codexThreadBindings`, `codexInteractions`, and `pipelineCommandReceipts` from `server/db/schema.ts`. Add Zod enums for binding, interaction, actor surface, and receipt status. Extend `HumanDecisionSchema` with nullable compatibility fields:

```ts
interactionId: z.string().nullable().optional(),
actorSurface: ActorSurface.nullable().optional(),
codexThreadId: z.string().nullable().optional(),
commandId: z.string().nullable().optional(),
```

Implement `projectHumanDecisionAudit()` in `human-decision-audit-projection.ts`: a non-null stored surface returns `{ actorSurface: row.actorSurface, provenance: "recorded" }`; a historical `NULL` returns the display-only legacy value above. The function must never mutate/backfill the row.

Also export `codexBindingRunLeases`, `projectAiRuns`, `codexLogicalTurns`, `codexTurnExecutions`, `codexFollowerStartAttempts`, `pipelineJobs`, and `pipelineCommandOutbox`. `DispatchSurfaceSchema` is the exact `follower_ipc|host_ui_message` Zod enum used by all three row schemas, and the role→surface registry is type-exhaustive over the logical-role enum. `PipelineJobEffectPayload` is the exact discriminated union above, and repository reads reject a `job_kind`/payload/identity mismatch before dispatch. Bindings expose a discriminated scope union; logical turns expose a discriminated owner union. Binding leases expose only claim/renew/fenced-release/takeover operations. Executions use unique start-attempt/logical-turn/thread-turn constraints.

- [ ] **Step 5: Add new foreign keys to Change deletion planning**

In `change-delete-plan.ts`, delete in this exact child-first order before `changes`:

```text
pipeline_command_outbox
codex_turn_executions
codex_follower_start_attempts
codex_binding_run_leases
codex_logical_turns
pipeline_jobs
human_decisions references to command/interaction
codex_interactions
pipeline_command_receipts
codex_thread_bindings
change_provider_sessions
changes
```

`change-delete-plan.test.ts` must seed a change-scoped binding plus stage, `interaction_present`, and `interaction_wakeup` pipeline jobs; both effect jobs have their real interaction/command FKs, and each job owns logical/attempt/execution rows with foreign keys enabled. Delete the Change and assert the exact order above removes logical children, then `pipeline_jobs`, then interaction/receipt parents with no orphan or FK failure. It must leave the same Project's `project_prd`/`project_context` bindings and `project_ai_runs` intact.

Add `project-delete-plan.ts` for project-level children. After all Changes are deleted through the existing Change plan, delete project-scoped rows in this child-first order:

```text
codex_turn_executions for project_ai_run owners
codex_follower_start_attempts for project_ai_run owners
codex_binding_run_leases for project bindings
codex_logical_turns for project_ai_run owners
project_ai_runs
codex_thread_bindings where scope_kind in (project_prd, project_context)
projects
```

`project-delete-plan.test.ts` seeds PRD and Context runs, bindings, logical turns, attempts, and executions with FKs/checks enabled and proves Project deletion leaves no orphan while never treating their ids as Change ids.

`project-service.ts.deleteProject()` must run the complete Change deletion plans and `project-delete-plan` inside its production transaction before deleting `projects`; no route may issue a direct project delete. `project-service.test.ts` and `app/api/projects/[id]/route.test.ts` create real Project PRD/Context bindings plus project AI owners/logical/attempt/execution rows, call the production service/API DELETE path, and assert success with zero orphan/FK error. A failpoint before commit must roll back both domain and Codex-native deletions.

- [ ] **Step 6: Run schema and deletion tests**

Run: `pnpm test -- server/services/db-migrations.test.ts server/services/codex-native-schema.test.ts server/services/human-decision-audit-projection.test.ts server/services/change-delete-plan.test.ts server/services/project-delete-plan.test.ts server/services/project-service.test.ts 'app/api/projects/[id]/route.test.ts'`

Expected: PASS, including legacy-row preservation and unique thread/idempotency constraints.

- [ ] **Step 7: Commit the additive schema**

```bash
git add server/db/migrations/0028_codex_native_control_plane.sql server/db/migrations/meta/_journal.json server/db/migrate.ts server/db/schema.ts server/services/db-migrations.test.ts server/services/codex-native-schema.test.ts server/services/human-decision-audit-projection.ts server/services/human-decision-audit-projection.test.ts server/services/change-delete-plan.ts server/services/change-delete-plan.test.ts server/services/project-delete-plan.ts server/services/project-delete-plan.test.ts server/services/project-service.ts server/services/project-service.test.ts 'app/api/projects/[id]/route.ts' 'app/api/projects/[id]/route.test.ts' server/types/enums.ts server/types/models.ts
git commit -m "feat(db): persist Codex threads and human interactions"
```

---

### Task 3: Make the persistent thread binding authoritative and repairable

**Files:**
- Create: `server/services/codex-thread-binding-service.ts`
- Create: `server/services/codex-thread-binding-service.test.ts`
- Create: `server/services/codex-logical-turn-service.ts`
- Create: `server/services/codex-logical-turn-service.test.ts`
- Create: `server/services/project-ai-run-service.ts`
- Create: `server/services/project-ai-run-service.test.ts`
- Create: `server/services/canonical-session-callers.test.ts`
- Modify: `server/services/provider-session-service.ts`
- Modify: `server/services/provider-session-service.test.ts`
- Modify: `server/services/pipeline-prd-briefing-stage-service.ts`
- Modify: `server/services/pipeline-spec-stage-service.ts`
- Modify: `server/services/pipeline-document-stage-runner-service.ts`
- Modify: `server/services/pipeline-plan-stage-service.ts`
- Modify: `server/services/pipeline-build-stage-service.ts`
- Modify: `server/services/pipeline-review-stage-service.ts`

- [ ] **Step 1: Write binding invariants**

```ts
beforeEach(() => {
  seedLivePipelineJob({
    pipelineJobId: PIPELINE_JOB_ID,
    workerId: WORKER_ID,
    leaseToken: LEASE_TOKEN,
    ownerAttempt: 1,
    ownerEpoch: 1,
    deadlineAt: futureDeadline(),
  });
});

it("atomically writes binding, changes.codexThreadId, and codex/general session", async () => {
  const binding = await ensureCodexThreadBinding({ scope: changeScope(CHANGE_ID), bridge });
  assert.equal(readBinding(CHANGE_ID)?.threadId, binding.threadId);
  assert.equal(readChange(CHANGE_ID)?.codexThreadId, binding.threadId);
  assert.equal(resolveProviderSession({
    changeId: CHANGE_ID,
    provider: "codex",
    sessionKind: "general",
  }), binding.threadId);
});

it("marks a deleted persistent shell detached without creating a replacement", async () => {
  await assert.rejects(ensureCodexThreadBinding({ scope: changeScope(CHANGE_ID), bridge: detachedBridge }));
  assert.equal(readBinding(CHANGE_ID)?.status, "detached");
  assert.equal(detachedBridge.createCount, 0);
});

it("promotes a uniquely identified persistent legacy shell without a fictional attach probe", async () => {
  seedLegacyProviderSession("legacy-persistent-shell");
  fakeShellControl.seedPersistentShell({
    threadId: "legacy-persistent-shell",
    cwd: normalizedRepoPath(),
    title: `[${CHANGE_ID}] First`,
  });
  const binding = await ensureCodexThreadBinding({ scope: changeScope(CHANGE_ID), bridge });
  assert.equal(binding.threadId, "legacy-persistent-shell");
  assert.equal(binding.followerStartProvedAt, null);
  assert.equal(bridge.desktopCalls.length, 0);
});

it("reuses a task shell when the first turn failed to start", async () => {
  const first = await provisionUntilTurnStartFailure();
  const repaired = await ensureCodexThreadBinding({ scope: changeScope(CHANGE_ID), bridge });
  assert.equal(repaired.threadId, first.threadId);
  assert.equal(bridge.provisionedShells, 1);
});

it("claims before external create so concurrent callers create once", async () => {
  const [first, second] = await Promise.all([
    ensureCodexThreadBinding({ scope: changeScope(CHANGE_ID), bridge }),
    ensureCodexThreadBinding({ scope: changeScope(CHANGE_ID), bridge }),
  ]);
  assert.equal(first.threadId, second.threadId);
  assert.equal(bridge.provisionedShells, 1);
});

it("binds Change, Project PRD, and Project Context as three canonical scopes", async () => {
  const [change, prd, context] = await Promise.all([
    ensureCodexThreadBinding({
      scope: { kind: "change", scopeId: CHANGE_ID, projectId: PROJECT_ID, changeId: CHANGE_ID },
      bridge,
    }),
    ensureCodexThreadBinding({
      scope: { kind: "project_prd", scopeId: PROJECT_ID, projectId: PROJECT_ID },
      bridge,
    }),
    ensureCodexThreadBinding({
      scope: { kind: "project_context", scopeId: PROJECT_ID, projectId: PROJECT_ID },
      bridge,
    }),
  ]);
  assert.equal(new Set([change.threadId, prd.threadId, context.threadId]).size, 3);
  assert.equal(readChange(CHANGE_ID)?.codexThreadId, change.threadId);
  assert.equal(readChangeBySyntheticId(`${PROJECT_ID}-context-select`), null);
  assert.equal(readProviderSessionByExternalId(prd.threadId), null);
  assert.equal(readProviderSessionByExternalId(context.threadId), null);
});

it("creates one PRD owner per user turn and reuses the Project PRD shell", async () => {
  const first = await createProjectAiRun({
    projectId: PROJECT_ID, kind: "prd_turn", requestKey: "prd-user-event-1",
  });
  const duplicate = await createProjectAiRun({
    projectId: PROJECT_ID, kind: "prd_turn", requestKey: "prd-user-event-1",
  });
  const second = await createProjectAiRun({
    projectId: PROJECT_ID, kind: "prd_turn", requestKey: "prd-user-event-2",
  });
  assert.equal(first.id, duplicate.id);
  assert.notEqual(first.id, second.id);
  assert.equal(
    (await resolveProjectPrdTurn(first.id)).bindingId,
    (await resolveProjectPrdTurn(second.id)).bindingId,
  );
});

it("uses one Context owner with select and generate logical slots", async () => {
  const owner = await createProjectAiRun({
    projectId: PROJECT_ID, kind: "context_init", requestKey: "prd-confirm-7",
  });
  const [select, generate] = await resolveContextInitTurns(owner.id);
  assert.deepEqual([select.role, generate.role], ["context_select", "context_generate"]);
  assert.notEqual(select.logicalTurnId, generate.logicalTurnId);
  assert.equal(select.bindingId, generate.bindingId);
  assert.equal(readBindingById(select.bindingId).scopeKind, "project_context");
});

it("enforces the project AI run state machine and live lease predicate", async () => {
  const run = await createProjectAiRun({
    projectId: PROJECT_ID, kind: "context_init", requestKey: "prd-confirm-8",
  });
  const leased = await acquireProjectAiRunLease(run.id, WORKER_ID);
  assert.equal(isLiveProjectAiRunLease(leased, now()), true);
  await markProjectAiRunRunning(leased.fence);
  await assert.rejects(markProjectAiRunSucceeded(staleFence(leased.fence)));
  await markProjectAiRunSucceeded(leased.fence);
  await assert.rejects(acquireProjectAiRunLease(run.id, "worker-2"), hasCode("owner_terminal"));
  for (const fixture of [expiredLeaseRun(), expiredDeadlineRun()]) {
    assert.equal(isLiveProjectAiRunLease(fixture, now()), false);
  }
});

it("never executes seeded writer critic build or fix session ids", async () => {
  seedCanonicalBinding(CHANGE_ID, "canonical-shell");
  seedProviderSessions(CHANGE_ID, {
    spec_writer: "legacy-writer",
    spec_critic: "legacy-critic",
    build: "legacy-build",
    fix: "legacy-fix",
  });
  seedLatestSpecRetryThreadEvent(CHANGE_ID, "legacy-spec-retry");
  await runEveryStageCaller(CHANGE_ID);
  assert.deepEqual(new Set(followerStartThreadIds()), new Set(["canonical-shell"]));
  assert.deepEqual(new Set(openedDeepLinks()), new Set(["codex://threads/canonical-shell"]));
  assert.equal(bridge.provisionedShells, 0);
});

it("creates distinct Spec writer critic and verdict slots in one job run", async () => {
  const turns = await resolveSpecLogicalTurns({
    pipelineJobId: PIPELINE_JOB_ID,
    round: 2,
  });
  assert.deepEqual(turns.map((turn) => turn.role), [
    "spec_writer", "spec_critic", "spec_verdict",
  ]);
  assert.equal(new Set(turns.map((turn) => turn.logicalTurnId)).size, 3);
  assert.equal(new Set(turns.map((turn) => turn.turnSlot)).size, 3);
});

it("concurrent duplicate callers resolve one logical id regardless of random input", async () => {
  const slot = logicalTurnSlot({
    owner: { kind: "pipeline_job", pipelineJobId: PIPELINE_JOB_ID },
    phase: "Build",
    role: "build",
    round: 3,
    ordinal: 0,
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      resolveLogicalTurn({ ...slot, callerRandom: crypto.randomUUID() } as never)),
  );
  assert.equal(new Set(results.map((item) => item.logicalTurnId)).size, 1);
  assert.equal(countActiveStartAttempts(results[0].logicalTurnId), 1);
  assert.equal(followerDispatchCount(results[0].logicalTurnId), 1);
});

it("reuses retry slots and separates new Build and Fix rounds", async () => {
  assert.equal(
    (await resolveBuildTurn({ pipelineJobId: PIPELINE_JOB_ID, round: 1, retry: 0 })).logicalTurnId,
    (await resolveBuildTurn({ pipelineJobId: PIPELINE_JOB_ID, round: 1, retry: 9 })).logicalTurnId,
  );
  assert.notEqual(
    (await resolveBuildTurn({ pipelineJobId: PIPELINE_JOB_ID, round: 1 })).logicalTurnId,
    (await resolveBuildTurn({ pipelineJobId: PIPELINE_JOB_ID, round: 2 })).logicalTurnId,
  );
  assert.notEqual(
    (await resolveBuildTurn({ pipelineJobId: PIPELINE_JOB_ID, round: 1 })).logicalTurnId,
    (await resolveFixTurn({ pipelineJobId: PIPELINE_JOB_ID, round: 1 })).logicalTurnId,
  );
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/codex-thread-binding-service.test.ts server/services/codex-logical-turn-service.test.ts server/services/project-ai-run-service.test.ts`

Expected: FAIL because the binding, project-AI-run, and logical-turn services do not exist.

- [ ] **Step 3: Implement binding creation with a database transaction**

Export:

```ts
export async function ensureCodexThreadBinding(input: {
  scope:
    | { kind: "change"; scopeId: string; projectId: string; changeId: string }
    | { kind: "project_prd"; scopeId: string; projectId: string }
    | { kind: "project_context"; scopeId: string; projectId: string };
  bridge: CodexDesktopBridge;
}): Promise<CodexThreadBinding>;

export async function repairCodexThreadBinding(input: {
  scope: CodexManagedScope;
  bridge: CodexDesktopBridge;
}): Promise<CodexThreadBinding>;

export function readCodexThreadBinding(scope: CodexManagedScope): CodexThreadBinding | null;
```

Implement `claimProvisioning(scopeKind, scopeId, owner, now)` first: a transaction inserts or CAS-claims a row with required project id, nullable change/thread id, random claim token, lease owner, and expiry. Only the claim owner calls Hybrid Bridge `ensurePersistentShell()`, which issues app-server `thread/start(ephemeral:false)` and the stable scope title; it never starts a turn. A second transaction CAS-finalizes on `(scopeKind, scopeId, claimToken, leaseOwner)` and writes `threadId`. For Change scope only, the same transaction mirrors `changes.codexThreadId` and codex/general provider session. Project PRD/Context scopes never write a synthetic Change or provider session. Concurrent losers wait/read the winner and never provision a second shell.

Require shell identity proof before adoption: app-server read/list must say the shell is persistent and matches normalized repo cwd + stable `[changeId]` title. Do not deep-link, start a turn, or call a fictional follower attach/readiness probe during provision/repair. Reconcile an expired provisioning lease by that same read/list identity. If exactly one shell matches, finalize it; if none or multiple match after an external result may have occurred, set `lastErrorCode="shell_provision_ambiguous"` and do not create again automatically. Only a proved deleted finalized shell may transition to `detached`.

`followerStartProvedAt` starts null. Preserve an existing non-null proof only when repair retains the identical canonical thread id. The Task 4 engine writes it only after a real `thread-follower-start-turn` success; otherwise the next managed turn revalidates by performing the real start sequence.

Implement `project-ai-run-service.ts` with idempotent `createProjectAiRun`, live lease acquire/renew, fenced completion/failure, and recovery claim. `prd_turn` request identity is the durable user event/idempotency key; each distinct user turn creates a new owner. `context_init` request identity is the confirmed PRD revision/version; one owner contains both AI calls. No project run may use a fake `changeId`.

Implement `resolveLogicalTurn()` as a managed-owner scheduling transaction over the two partial unique owner-slot indexes. The discriminated input contains either `pipelineJobId` or `projectAiRunId`; it validates the corresponding lease, writes only that FK, resolves the binding scope, normalizes and persists the complete canonical request/hash, then generates the DB UUID `logicalTurnId`, deterministic `turnSlot`, and service-derived `runCorrelationId` only on insert. A conflict returns the existing row only when request hash and immutable slot fields match; otherwise fail `logical_turn_request_conflict`. Wakeup resolution additionally requires interaction/command identity in the canonical slot. Caller random/owner/correlation/thread fields are rejected before this boundary and never influence identity.

Use explicit roles: `stage`, `spec_writer`, `spec_critic`, `spec_verdict`, `build`, `fix`, `prd_turn`, `context_select`, `context_generate`, `interaction_present`, and `interaction_wakeup`. Spec schedules writer→critic→verdict as three sequential logical rows. Build/Fix retry within a round resolves the same row; a new round or role resolves another row. Project PRD resolves one slot per user-turn owner; Context resolves select→generate under one owner. A managed owner may therefore contain multiple turns.

- [ ] **Step 4: Narrow provider sessions to the canonical general thread**

Modify all six listed stage callers so user-visible continuation resolves `sessionKind: "general"`. Remove their writes of new `spec_writer`, `spec_critic`, `build`, and `fix` external sessions. Writer, critic, Build, and Fix are role-scoped sequential parent turns on the same canonical shell; this is not technical context isolation. Keep legacy per-stage rows readable for audit only, but never use them for execution or create a second Desktop task.

In each caller, resolve the deterministic logical slot in the scheduling transaction and pass only `AiRunInput.logicalTurnId` to the Hybrid engine. Remove executable `threadId` and `runCorrelationId` from the Hybrid input. In `pipeline-spec-stage-service.ts`, migrate `latestSpecRetryThread` to read-only audit. Apply the same rule to legacy stage sessions.

In `canonical-session-callers.test.ts`, read each of the six caller sources and assert it contains the canonical resolver while rejecting new stage-session literals:

```ts
for (const source of stageCallerSources) {
  assert.match(source, /resolveCanonicalChangeThread/);
  assert.doesNotMatch(
    source,
    /sessionKind:\s*"(spec_writer|spec_critic|build|fix)"/,
  );
}
const allStageSourceText = stageCallerSources.join("\n");
assert.doesNotMatch(specStageSource, /threadId:\s*latestSpecRetryThread/);
assert.doesNotMatch(allStageSourceText, /runCorrelationId\s*:/);
assert.match(allStageSourceText, /logicalTurnId/);
```

- [ ] **Step 5: Run binding and provider session tests**

Run:

```bash
pnpm test -- server/services/codex-thread-binding-service.test.ts server/services/codex-logical-turn-service.test.ts server/services/project-ai-run-service.test.ts server/services/provider-session-service.test.ts server/services/canonical-session-callers.test.ts server/services/pipeline-build-stage-service.test.ts
```

Expected: PASS for atomic mapping, deterministic logical slots, writer/critic/verdict multi-turn sequencing, concurrent duplicate collapse, retry/round boundaries, single active attempt/dispatch, identity-only shell adoption, and legacy ids never reaching execution.

- [ ] **Step 6: Commit binding authority**

```bash
git add server/services/codex-thread-binding-service.ts server/services/codex-thread-binding-service.test.ts server/services/codex-logical-turn-service.ts server/services/codex-logical-turn-service.test.ts server/services/project-ai-run-service.ts server/services/project-ai-run-service.test.ts server/services/canonical-session-callers.test.ts server/services/provider-session-service.ts server/services/provider-session-service.test.ts server/services/pipeline-prd-briefing-stage-service.ts server/services/pipeline-spec-stage-service.ts server/services/pipeline-document-stage-runner-service.ts server/services/pipeline-plan-stage-service.ts server/services/pipeline-build-stage-service.ts server/services/pipeline-review-stage-service.ts
git commit -m "feat(codex): bind each change to one hybrid task"
```

---

### Task 4: Implement follower-owned execution as an AI engine adapter

**Files:**
- Create: `server/services/codex-desktop-engine.ts`
- Create: `server/services/codex-desktop-engine.test.ts`
- Create: `server/services/codex-turn-lifecycle-service.ts`
- Create: `server/services/codex-turn-lifecycle-service.test.ts`
- Create: `server/services/codex-follower-start-attempt-service.ts`
- Create: `server/services/codex-follower-start-attempt-service.test.ts`
- Create: `server/services/codex-binding-run-lease-service.ts`
- Create: `server/services/codex-binding-run-lease-service.test.ts`
- Create: `server/services/codex-desktop-run-context.ts`
- Create: `server/services/spec-role-context-service.ts`
- Create: `server/services/spec-role-context-service.test.ts`
- Create: `server/services/codex-managed-ai-caller-inventory.ts`
- Create: `server/services/codex-managed-ai-caller-inventory.test.ts`
- Modify: `server/services/prd-service.ts`
- Modify: `server/services/prd-service.test.ts`
- Modify: `server/services/context-init-service.ts`
- Modify: `server/services/context-init-service.test.ts`
- Modify: `server/services/pipeline-engine-service.ts`
- Modify: `server/services/pipeline-engine-service.test.ts`
- Modify: `server/services/crash-resilience-harness.ts`
- Modify: `server/services/ai-engine-adapter.ts`
- Modify: `server/services/ai-engine-adapter.test.ts`
- Modify: `server/services/active-provider-registry.ts`
- Modify: `server/services/ai-engine-types.ts`
- Modify: `server/services/codex-model-catalog-service.ts`
- Modify: `server/services/codex-model-catalog-service.test.ts`
- Modify: `server/services/codex-app-server-client.ts`
- Modify: `server/services/codex-app-server-client.test.ts`
- Modify: `server/services/codex-engine-shared.ts`
- Modify: `server/services/codex-engine-shared.test.ts`
- Modify: `server/services/codex-managed-ai-caller-inventory.ts`
- Modify: `server/services/codex-managed-ai-caller-inventory.test.ts`
- Modify: `server/services/prd-service.ts`
- Modify: `server/services/prd-service.test.ts`
- Modify: `server/services/context-init-service.ts`
- Modify: `server/services/context-init-service.test.ts`
- Modify: `server/services/provider-process-lease-service.ts`
- Modify: `server/services/provider-process-lease-service.test.ts`
- Modify: `server/services/provider-run-lifecycle-service.ts`
- Modify: `server/services/provider-run-lifecycle-service.test.ts`
- Modify: `server/services/stale-provider-run-recovery-service.ts`
- Modify: `server/services/stale-provider-run-recovery-service.test.ts`
- Modify: `server/services/recovery-executors.ts`
- Modify: `server/services/recovery-predicates.ts`
- Modify: `server/services/recovery-types.ts`
- Modify: `server/services/pipeline-job-runner-service.ts`
- Modify: `server/services/pipeline-job-runner-service.test.ts`
- Modify: `server/templates/prompts/spec-critic.md`

- [ ] **Step 1: Write engine behavior tests**

```ts
beforeEach(() => {
  seedLivePipelineJob({
    pipelineJobId: PIPELINE_JOB_ID,
    workerId: WORKER_ID,
    leaseToken: LEASE_TOKEN,
    ownerAttempt: 1,
    ownerEpoch: 1,
    deadlineAt: futureDeadline(),
  });
});

it("starts a follower-owned turn on the app-server-provisioned binding", async () => {
  const result = await engine.run({ logicalTurnId: LOGICAL_SPEC_WRITER_ID });
  assert.equal(result.threadId, "desktop-thread-1");
  assert.equal(fakeBridge.followerStarted[0]?.threadId, "desktop-thread-1");
  assert.equal(fakeBridge.desktopLifecycleSubscriptions, 0);
  assert.equal(fakeShellControl.threadReadCalls.at(-1)?.includeTurns, true);
  assert.equal(fakeShellControl.turnStartCalls, 0);
  assert.notEqual(readBinding(CHANGE_ID)?.followerStartProvedAt, null);
  assert.equal(result.success, true);
});

it("retries actual start only after explicit no-client-found without reprovisioning", async () => {
  fakeBridge.queueFollowerStartResults(
    { status: "no-client-found", turnsCreated: 0 },
    { status: "no-client-found", turnsCreated: 0 },
    { status: "started", turnId: "desktop-turn-1", turnsCreated: 1 },
  );
  await engine.run({ logicalTurnId: LOGICAL_SPEC_WRITER_ID });
  assert.equal(fakeBridge.deepLinks, ["codex://threads/desktop-thread-1"]);
  assert.equal(fakeBridge.provisionedShells, 1);
  assert.equal(fakeBridge.followerStarted.length, 1);
  assert.equal(fakeBridge.readinessProbeCalls, 0);
  assert.equal(fakeBridge.failedStartTurnsCreated, 0);
  assert.equal(fakeBridge.totalTurnsCreated, 1);
});

it("does not claim success when app-server observation reconnect budget is exhausted", async () => {
  const result = await engine.run({ logicalTurnId: LOGICAL_SPEC_WRITER_ID }, disconnectingShellReader);
  assert.equal(result.success, false);
  assert.equal(result.providerErrorCode, "app_server_turn_observation_lost");
});

it("records deduplicated snapshot lifecycle without a provider process pid", async () => {
  fakeShellControl.queueTurnSnapshots(
    turnSnapshot("desktop-turn-1", "inProgress", ["item-1"]),
    turnSnapshot("desktop-turn-1", "inProgress", ["item-1"]),
    turnSnapshot("desktop-turn-1", "completed", ["item-1", "agentMessage"]),
  );
  await engine.run({ logicalTurnId: LOGICAL_SPEC_WRITER_ID });
  const execution = readTurnExecution(CHANGE_ID);
  assert.equal(execution.threadId, "desktop-thread-1");
  assert.equal(execution.turnId, "desktop-turn-1");
  assert.equal(execution.lastObservationCursor, 2);
  assert.equal(execution.lastSemanticSnapshotHash, hashTerminalFixture());
  assert.equal("pid" in execution, false);
});

it("reconciles dispatching after success-before-CAS without a second start", async () => {
  const fixture = engineWithStartFailpoint("success_before_cas");
  await assert.rejects(fixture.run(), SimulatedCrash);
  assert.equal(fixture.readAttempt().state, "dispatching");
  assert.equal(fixture.followerStartCalls, 1);
  await fixture.recover();
  assert.equal(fixture.followerStartCalls, 1);
  assert.equal(fixture.readAttempt().state, "succeeded");
  assert.equal(fixture.readAttempt().followerTurnId, "desktop-turn-1");
});

it("does not restart a durable turn while thread/read visibility lags", async () => {
  seedSucceededStartAttempt({ turnId: "desktop-turn-1" });
  fakeShellControl.queueThreadReads(
    snapshotWithoutTurn("desktop-turn-1"),
    snapshotWithoutTurn("desktop-turn-1"),
    snapshotWithTurn("desktop-turn-1", "inProgress"),
  );
  await engine.resume({ logicalTurnId: LOGICAL_SPEC_WRITER_ID });
  assert.equal(fakeBridge.followerStartCalls, 0);
  assert.equal(readTurnExecution(CHANGE_ID).lastObservationCursor, 1);
});

it("does not duplicate Build or Fix workspace effects after ambiguous-start adoption", async () => {
  const fixture = buildFixCrashFixture("success_before_cas");
  await fixture.crashAndRecover();
  assert.equal(fixture.followerTurnsCreated, 1);
  assert.equal(fixture.workspaceMutations, 1);
  assert.equal(fixture.patchAdoptions, 1);
});

it("accepts only a Server-owned logical turn id and rejects caller identity overrides", async () => {
  seedCanonicalBinding(CHANGE_ID, "canonical-shell");
  seedLogicalTurn({
    logicalTurnId: LOGICAL_SPEC_WRITER_ID,
    pipelineJobId: PIPELINE_JOB_ID,
    projectAiRunId: null,
    bindingId: CHANGE_BINDING_ID,
    phase: "Spec",
    role: "spec_writer",
    round: 1,
    ordinal: 0,
  });
  await assert.rejects(
    engine.run({
      logicalTurnId: LOGICAL_SPEC_WRITER_ID,
      threadId: "legacy-spec-retry",
      runCorrelationId: "caller-random",
    } as never),
    hasCode("caller_identity_override"),
  );
  assert.deepEqual(fakeBridge.deepLinks, []);
  assert.deepEqual(fakeBridge.followerStarted, []);
  assert.equal(readMigrationEvents("caller_identity_override").length, 1);
});

it("rejects missing and stale pipeline/project owners before external calls", async () => {
  await assert.rejects(engine.run({ logicalTurnId: "unknown" }), hasCode("logical_turn_not_found"));
  for (const fixture of [
    stalePipelineLogicalTurnFixture(),
    staleProjectAiLogicalTurnFixture(),
  ]) {
    await assert.rejects(
      engine.run({ logicalTurnId: fixture.logicalTurnId }),
      hasCode("logical_turn_owner_lease_stale"),
    );
    await assert.rejects(
      fixture.recordSuccessWithStaleFence(),
      hasCode("stale_start_attempt_fence"),
    );
  }
  assert.deepEqual(fakeBridge.deepLinks, []);
  assert.deepEqual(fakeBridge.followerStarted, []);
});

it("fails closed when logical, attempt, execution, or role surface differs", async () => {
  for (const fixture of [
    wrongLogicalSurface({ role: "build", surface: "host_ui_message" }),
    wrongAttemptSurface({ role: "interaction_present", surface: "host_ui_message" }),
    wrongExecutionSurface({ role: "interaction_wakeup", surface: "follower_ipc" }),
  ]) {
    await assert.rejects(
      fixture.runOrRecover(),
      hasCode("dispatch_surface_mismatch"),
    );
  }
  assert.equal(fakeBridge.followerStartCalls, 0);
  assert.equal(fakeHostContinuation.calls.length, 0);
  assert.equal(fakeShellControl.turnStartCalls, 0);
  assert.equal(countMutatedWrongSurfaceRows(), 0);
});

it("allows three Spec role slots in one job but only one dispatch per logical turn", async () => {
  const ids = seedSpecLogicalTurns(PIPELINE_JOB_ID, ["spec_writer", "spec_critic", "spec_verdict"]);
  const writer = await engine.run({ logicalTurnId: ids[0] });
  assert.equal(writer.success, true);
  assert.equal(readFrozenSpecArtifact(PIPELINE_JOB_ID).status, "frozen");
  const critic = await engine.run({ logicalTurnId: ids[1] });
  assert.equal(critic.success, true);
  assert.equal(readCriticArtifact(PIPELINE_JOB_ID).status, "completed");
  await engine.run({ logicalTurnId: ids[2] });
  assert.equal(new Set(readExecutions(PIPELINE_JOB_ID).map((row) => row.logicalTurnId)).size, 3);

  const duplicate = ids[0];
  await Promise.all(
    Array.from({ length: 12 }, () => engine.run({ logicalTurnId: duplicate })),
  );
  assert.equal(readActiveAttemptCount(duplicate), 1);
  assert.equal(fakeBridge.dispatchCountFor(duplicate), 1);
});

it("serializes Context roles and multiple PRD runs through the binding lease", async () => {
  const context = seedContextLogicalTurns(CONTEXT_RUN_ID);
  await assert.rejects(
    Promise.all(context.map((logicalTurnId) => engine.run({ logicalTurnId }))),
    hasCode("binding_run_lease_busy"),
  );
  await engine.run({ logicalTurnId: context[0] });
  await engine.run({ logicalTurnId: context[1] });
  assert.equal(maxConcurrentExecutions(PROJECT_CONTEXT_BINDING_ID), 1);

  await Promise.all([runPrdUserTurn(PROJECT_ID, "event-a"), runPrdUserTurn(PROJECT_ID, "event-b")]);
  assert.equal(maxConcurrentExecutions(PROJECT_PRD_BINDING_ID), 1);
  assert.equal(readQueuedPrdRuns(PROJECT_ID).length, 0);
});

it("runs each PRD user turn under a project owner and reuses the PRD binding", async () => {
  const first = await runPrdUserTurn(PROJECT_ID, "event-1");
  const second = await runPrdUserTurn(PROJECT_ID, "event-2");
  assert.notEqual(first.projectAiRunId, second.projectAiRunId);
  assert.notEqual(first.logicalTurnId, second.logicalTurnId);
  assert.equal(first.threadId, second.threadId);
  assert.equal(readBindingByThread(first.threadId).scopeKind, "project_prd");
  assert.equal(readChangeBySyntheticId("__prd__"), null);
  assert.equal(readLegacyPrdRetryThreadUseCount(), 0);
});

it("runs Context select and generate under one project owner and context shell", async () => {
  const result = await initializeProjectContext(PROJECT_ID, {
    requestKey: "prd-confirm-7",
  });
  assert.equal(result.logicalTurns.length, 2);
  assert.deepEqual(result.logicalTurns.map((turn) => turn.role), [
    "context_select", "context_generate",
  ]);
  assert.equal(new Set(result.logicalTurns.map((turn) => turn.projectAiRunId)).size, 1);
  assert.equal(new Set(result.logicalTurns.map((turn) => turn.threadId)).size, 1);
  assert.equal(readBindingByThread(result.logicalTurns[0].threadId).scopeKind, "project_context");
  assert.equal(readSyntheticContextChangeCount(PROJECT_ID), 0);
});

it("requires every production AI caller to resolve logical identity or use rollback", () => {
  const inventory = buildManagedAiCallerInventory(PROJECT_ROOT);
  assert.deepEqual(inventory.unclassified, []);
  for (const caller of inventory.callers) {
    assert.equal(
      caller.mode === "logical_resolver" ||
        (caller.mode === "rollback_adapter" && caller.guard === "desktopBridge=off"),
      true,
      caller.file,
    );
  }
  assert.equal(inventory.byFile["server/services/prd-service.ts"].mode, "logical_resolver");
  assert.equal(inventory.byFile["server/services/context-init-service.ts"].mode, "logical_resolver");
  assert.equal(
    inventory.byFile["server/services/crash-resilience-harness.ts"].mode,
    "logical_resolver",
  );
});

it("rebuilds critic input without writer scratch or transcript", () => {
  const context = buildSpecCriticContext({
    frozenSpecArtifact: "SPEC_V7",
    requirements: "REQS_V3",
    checklist: "CHECKLIST_V2",
    writerScratch: "WRITER_SCRATCH_SECRET",
    writerTranscript: "WRITER_TRANSCRIPT_SECRET",
  } as unknown as SpecCriticContextInput);
  assert.match(context.prompt, /fresh adversarial evaluation/i);
  assert.match(context.prompt, /SPEC_V7|REQS_V3|CHECKLIST_V2/);
  assert.doesNotMatch(context.prompt, /WRITER_SCRATCH_SECRET|WRITER_TRANSCRIPT_SECRET/);
  assert.equal(context.outputArtifactKind, "spec_critic_review");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/codex-desktop-engine.test.ts server/services/codex-follower-start-attempt-service.test.ts server/services/spec-role-context-service.test.ts server/services/prd-service.test.ts server/services/context-init-service.test.ts server/services/codex-managed-ai-caller-inventory.test.ts`

Expected: FAIL because `CodexDesktopEngine`, the durable start-attempt service, project-level managed owner migration, caller inventory, and the critic context boundary do not exist.

- [ ] **Step 3: Implement snapshot-to-AiStreamEvent mapping**

Implement `AiEngineAdapter` with:

```ts
export class CodexDesktopEngine implements AiEngineAdapter {
  constructor(
    private readonly bridge: CodexDesktopBridge,
    private readonly bindings: CodexThreadBindingPort,
  ) {}

  run(input: AiRunInput): Promise<AiRunResult>;
  runStreamed(input: AiRunInput): AsyncGenerator<AiStreamEvent>;
}
```

Before any app-server or Desktop call, accept only `AiRunInput.logicalTurnId`, then re-read `codex_logical_turns`. Assert its owner XOR check defensively, follow the non-null `pipeline_job_id` or `project_ai_run_id` foreign key, validate that owner's live lease, then resolve the binding recorded by the logical row. Validate deterministic slot, phase/role/round/ordinal, owner/scope ownership, and canonical thread. Runtime input containing caller project/change/thread/owner/`runCorrelationId`/slot fields or unknown identity overrides is rejected and audited before external calls; the engine derives all execution identity from persisted rows.

Resolve/provision the binding through app-server shell control, then delegate every start to `codex-follower-start-attempt-service.ts`. It captures the pre-start turn baseline/hash, injects and persists the run/attempt correlation marker, hashes the normalized final prompt, writes the full request/managed-owner lease fence as `prepared`, opens the canonical deep link while the attempt remains safely prepared, and only then CASes to `dispatching` before external follower start. Explicit `no-client-found` is durably zero-turn and may retry the same attempt/budget. Success must CAS its turn id before execution proceeds. Any after-IPC-write-before-response/unknown/success-before-CAS/crash-after-dispatch state is reconciled from baseline difference + exact marker; unique adopt succeeds, zero/multiple/mismatch quarantine under Task 0's deadline rules, and no dispatching attempt is ever resent.

Before attempt `prepare`, `codex-binding-run-lease-service.ts` CAS-claims the logical row's binding. The binding primary-key lease serializes stage, PRD/Context, presentation, Host wake, and compensation across otherwise independent owners/commands. Attempt settlement, quarantine, cancellation, and recovery release/takeover with token+epoch fencing. A busy live binding queues the logical owner; it never opens a deep link or dispatches.

Once a durable success/adoption provides `turnId`, observe it only through app-server `thread/read(includeTurns:true)`. A missing known turn is `turn_not_yet_visible`: continue read-only within the original deadline with no cursor/output/start. Visible snapshots pass the Task 0 normalized semantic item/order/upsert/hash contract before projection. Persist `lastTurnId`, `lastObservationCursor`, normalized item state, and `lastSemanticSnapshotHash` after each semantic change; unchanged/reconnected/volatile-only snapshots are no-ops. Map only a proved immutable terminal semantic snapshot to success/failure. Preserve `model`, `reasoningEffort`, `sandboxMode`, lifecycle heartbeat, changed-file extraction, structured-output ingestion, and sanitized error behavior used by `CodexAppServerEngine`.

For Build/Fix, keep the task under the repo saved Project while passing the StagePass worktree as turn cwd. Set `approvalPolicy: "never"` so Codex host permission prompts cannot become a second unrecorded approval path. Fence workspace mutation and patch adoption with the same start attempt/job/lease identity so ambiguous recovery cannot repeat Build/Fix side effects. Replace process lifecycle persistence with `codex_turn_executions`; legacy `provider_run_processes` remains historical only.

Keep model catalog reads on the supervised app-server shell/control connection. Narrow `codex-app-server-client.ts` so shell control/catalog methods are separately allowlisted from the rollback engine; production Hybrid code must have no callable app-server managed `turn/start`. Replace shared `.codex/agents` setup/cleanup with inline role instructions or run-scoped files inside the target worktree, and delete only files created by the matching run identity.

Migrate the two project-level production callers explicitly:

- `prd-service.ts`: after persisting the user event, idempotently create `project_ai_runs(kind=prd_turn, requestKey=userEventId)`, acquire its lease, resolve the Project PRD binding, resolve `(PRD, prd_turn, 0, 0)`, and call the engine with only `logicalTurnId`. Remove `changeId:"__prd__"`, provider timeout retry thread execution, and all project PRD caller thread overrides. Each user turn gets a new owner/logical turn while reusing the Project PRD shell.
- `context-init-service.ts`: create one `project_ai_runs(kind=context_init, requestKey=confirmedPrdVersion)` before static/AI work, acquire its lease, resolve the Project Context binding, then run `(Context, context_select, 0, 0)` followed by `(Context, context_generate, 0, 0)` on the same owner/shell. Remove `${projectId}-context-select`, `${projectId}-context-generate`, and direct legacy `AiRunInput` fields. `confirmPrd`/`confirmPrdRevision` passes the durable confirmed version/idempotency key into context init.

Create `codex-managed-ai-caller-inventory.ts` with the TypeScript compiler API, not regex. Walk production `server/**/*.ts` excluding tests/generated fixtures; resolve imports/aliases and find `getAiEngine`, `AiEngineAdapter.run`, and `runStreamed` call sites. Compare them to a checked-in typed manifest covering `prd-service.ts`, `context-init-service.ts`, `pipeline-engine-service.ts`, all six stage callers, and `crash-resilience-harness.ts` because it is production-compiled despite its name. Migrate the harness to create a durable fixture owner/logical turn and pass only `logicalTurnId`; it is not allowed a test-only exemption. Each entry declares `logical_resolver` with the resolver symbol, or `rollback_adapter` with the exact `desktopBridge=off` guard. Unknown caller, missing resolver, direct Hybrid legacy input, or rollback use while the flag is on fails the test.

Writer and critic execute as sequential parent turns on that same canonical binding. `spec-role-context-service.ts` must build critic input solely from the frozen spec artifact, current requirements, and the versioned review checklist, and the prompt must explicitly demand a fresh adversarial evaluation. Do not accept writer scratch, chain-of-thought/reasoning, or writer transcript fields; discard unknown runtime fields before prompt construction. Persist the critic's result and decision as an independent `spec_critic_review` artifact. The same Codex task history may remain visible to the model, so this contract provides role-scoped input reconstruction—not technical context isolation. A later requirement for stronger independence needs a separately verified capability gate.

- [ ] **Step 4: Implement Desktop-started, app-server-observed turn lifecycle instead of a fake process**

`codex-follower-start-attempt-service.ts` owns all transitions, safe handoff, and recovery adoption. Full one-row uniqueness is `logical_turn_id`, including terminal states; retry and recovery reuse that row, while a genuinely new purpose requires a new deterministic logical slot. Run correlation is read-only derived metadata, never the business identity. Every mutation matches logical turn plus owner-kind/id, worker/lease/owner-attempt/owner-epoch or recovery fence. It never exposes a generic “retry ambiguous” method.

`codex-turn-lifecycle-service.ts` owns executions with unique start-attempt/logical-turn/thread-turn constraints. `startTurnExecution` requires a succeeded/adopted attempt and permits multiple executions in one managed owner only through different logical turns. Observation semantics remain fenced by logical turn + matching pipeline-job or project-AI-run lease.

```ts
type AiExecutionLifecycle =
  | { kind: "process"; onProcessStarted: ProcessStartedHandler }
  | { kind: "desktop_follower_turn"; onTurnStarted: TurnStartedHandler };
```

`provider-process-lease-service.ts`, `provider-run-lifecycle-service.ts`, and `active-provider-registry.ts` remain process-only rollback code while the old adapter exists. They must reject `kind: "desktop_follower_turn"` rather than create a row with null/fake PID. `stale-provider-run-recovery-service.ts`, `recovery-executors.ts`, `recovery-predicates.ts`, and `recovery-types.ts` branch on lifecycle kind: follower recovery reads shell binding plus app-server full-turn snapshots and persisted observation cursor/hash; a new turn uses deep-link + actual start retry with no separate readiness probe, while process identity probing and kill apply only to rollback rows.

- [ ] **Step 5: Gate engine and model-catalog selection in the real factory**

Modify `ai-engine-adapter.ts`—the actual `getAiEngine()` factory—to return `CodexDesktopEngine` when `flags.desktopBridge` is on, otherwise `CodexAppServerEngine`. `active-provider-registry.ts` is not an engine factory and only retains old PID signal handling.

The factory decision applies identically to Change and project scopes. Callers do not choose adapters: they always resolve a managed owner/logical turn first when Hybrid is on. During migration the AST inventory may classify a caller as rollback-only only when the call is structurally dominated by `desktopBridge=off`; Task 20 removes every such production exception.

Under the Hybrid flag, inject both `CodexAppServerShellControl` and `CodexDesktopFollowerTransport`; the engine uses the first for shell identity/control, model catalog, and read-only `thread/read(includeTurns:true)` lifecycle observation, while the second is limited to deep-link, actual start, and interrupt. Modify `codex-model-catalog-service.ts` to use shell control `listModels()` in Hybrid mode and the rollback client's catalog only under rollback. Move prompt composition, structured-output, changed-file extraction, and sanitized error helpers needed by both engines out of process cleanup branches in `codex-engine-shared.ts`; `codex-desktop-run-context.ts` creates run-scoped role context without shared-directory deletion.

Never silently switch adapters after a follower-owned turn has started, and never fall back to app-server `turn/start` after `no-client-found` exhaustion or ambiguous start.

- [ ] **Step 6: Run engine, lifecycle, factory, catalog, and recovery tests**

Run:

```bash
pnpm test -- server/services/codex-desktop-engine.test.ts server/services/codex-binding-run-lease-service.test.ts server/services/codex-follower-start-attempt-service.test.ts server/services/codex-turn-lifecycle-service.test.ts server/services/spec-role-context-service.test.ts server/services/codex-managed-ai-caller-inventory.test.ts server/services/prd-service.test.ts server/services/context-init-service.test.ts server/services/pipeline-engine-service.test.ts server/services/ai-engine-adapter.test.ts server/services/codex-model-catalog-service.test.ts server/services/codex-app-server-client.test.ts server/services/codex-app-server-shell-control.test.ts server/services/codex-engine-shared.test.ts server/services/provider-process-lease-service.test.ts server/services/provider-run-lifecycle-service.test.ts server/services/stale-provider-run-recovery-service.test.ts server/services/pipeline-job-runner-service.test.ts server/services/codex-app-server-engine.test.ts
```

Expected: PASS; old engine remains green with the flag off; all start crash windows reconcile without duplicate turn/Build/Fix effects; visibility lag never starts again; semantic snapshot rules and terminal immutability hold; Desktop lifecycle subscription count is zero; and app-server read reconnect never starts a turn.

- [ ] **Step 7: Commit desktop execution**

```bash
git add server/services/codex-desktop-engine.ts server/services/codex-desktop-engine.test.ts server/services/codex-binding-run-lease-service.ts server/services/codex-binding-run-lease-service.test.ts server/services/codex-follower-start-attempt-service.ts server/services/codex-follower-start-attempt-service.test.ts server/services/codex-turn-lifecycle-service.ts server/services/codex-turn-lifecycle-service.test.ts server/services/codex-desktop-run-context.ts server/services/spec-role-context-service.ts server/services/spec-role-context-service.test.ts server/services/codex-managed-ai-caller-inventory.ts server/services/codex-managed-ai-caller-inventory.test.ts server/services/prd-service.ts server/services/prd-service.test.ts server/services/context-init-service.ts server/services/context-init-service.test.ts server/services/pipeline-engine-service.ts server/services/pipeline-engine-service.test.ts server/services/crash-resilience-harness.ts server/services/ai-engine-adapter.ts server/services/ai-engine-adapter.test.ts server/services/active-provider-registry.ts server/services/ai-engine-types.ts server/services/codex-model-catalog-service.ts server/services/codex-model-catalog-service.test.ts server/services/codex-app-server-client.ts server/services/codex-app-server-client.test.ts server/services/codex-engine-shared.ts server/services/codex-engine-shared.test.ts server/services/provider-process-lease-service.ts server/services/provider-process-lease-service.test.ts server/services/provider-run-lifecycle-service.ts server/services/provider-run-lifecycle-service.test.ts server/services/stale-provider-run-recovery-service.ts server/services/stale-provider-run-recovery-service.test.ts server/services/recovery-executors.ts server/services/recovery-predicates.ts server/services/recovery-types.ts server/services/pipeline-job-runner-service.ts server/services/pipeline-job-runner-service.test.ts server/templates/prompts/spec-critic.md
git commit -m "feat(codex): execute pipeline turns through desktop follower"
```

---

### Task 5: Introduce the unified Pipeline Command Gateway

**Files:**
- Create: `server/services/pipeline-command-types.ts`
- Create: `server/services/pipeline-command-unit-of-work.ts`
- Create: `server/services/pipeline-command-unit-of-work.test.ts`
- Create: `server/services/pipeline-command-action-map.ts`
- Create: `server/services/pipeline-command-action-map.test.ts`
- Create: `server/services/pipeline-command-gateway.ts`
- Create: `server/services/pipeline-command-gateway.test.ts`
- Create: `server/repositories/pipeline-command-repository.ts`
- Modify: `server/services/action-contract-service.ts`
- Modify: `server/services/action-contract-decision-router.ts`
- Modify: `server/services/gate-service.ts`
- Modify: `server/services/gate-service.test.ts`
- Modify: `server/services/briefing-question-store.ts`
- Modify: `server/services/briefing-question-store.test.ts`
- Modify: `server/services/spec-battle-service.ts`
- Modify: `server/services/spec-battle-routes.test.ts`
- Modify: `server/services/plan-approval-service.ts`
- Modify: `server/services/plan-sandbox-service.test.ts`
- Modify: `server/services/build-workspace-service.ts`
- Modify: `server/services/build-workspace-service.test.ts`
- Modify: `server/services/review-waiver-service.ts`
- Modify: `server/services/review-waiver-service.test.ts`
- Modify: `server/services/qa-run-service.ts`
- Modify: `server/services/qa-run-service.test.ts`
- Modify: `server/services/merge-readiness-service.ts`
- Modify: `server/services/merge-readiness-service.test.ts`
- Modify: `server/services/change-rework-service.ts`
- Modify: `server/services/change-rework-service.test.ts`
- Modify: `server/services/change-status-service.ts`
- Modify: `server/services/change-service.test.ts`

- [ ] **Step 1: Write stale, duplicate, and actor tests**

```ts
it("rejects a stale interaction before calling the handler", async () => {
  await assert.rejects(
    gateway.execute(command({ expectedGateVersion: "old" })),
    hasCode("gate_version_drift"),
  );
  assert.equal(handler.calls.length, 0);
});

it("returns the first receipt for a duplicate idempotency key", async () => {
  const first = await gateway.execute(command({ idempotencyKey: "same" }));
  const second = await gateway.execute(command({ idempotencyKey: "same" }));
  assert.equal(second.commandId, first.commandId);
  assert.equal(handler.calls.length, 1);
});

it("rejects human decisions from the model surface", async () => {
  await assert.rejects(
    gateway.execute(command({
      actor: { kind: "human", surface: "codex_model" as never },
    })),
    hasCode("actor_surface_forbidden"),
  );
});

it("rejects source HEAD and request hash drift", async () => {
  await assert.rejects(
    gateway.execute(command({
      expectedHeadSha: "old-head",
      requestHash: "wrong-request-hash",
    })),
    hasCode("command_freshness_drift"),
  );
});

for (const crashPoint of [
  "before_claim_commit",
  "after_claim_commit",
  "before_decision_commit",
  "after_decision_commit_before_outbox_dispatch",
  "after_filesystem_effect_before_finalize",
] as const) {
  it(`recovers ${crashPoint} without duplicate decisions`, async () => {
    await crashAndRecover(crashPoint);
    assert.equal(readHumanDecisions(COMMAND_ID).length, 1);
    assert.equal(readCompletedReceipts(COMMAND_ID).length, 1);
    assert.equal(readPendingEffects(COMMAND_ID).length, 0);
  });
}
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/pipeline-command-gateway.test.ts`

Expected: FAIL because gateway types and implementation do not exist.

- [ ] **Step 3: Define command and receipt types**

Use the design's `PipelineCommand` shape and:

```ts
export interface PipelineCommandResult {
  commandId: string;
  status: "completed";
  changeStatus: string;
  gateVersion: string;
  sourceDbHash: string;
  sourceHeadSha: string | null;
  interactionId: string | null;
  humanDecisionId: string | null;
  enqueuedJobId: string | null;
}
```

Allowed actor surfaces are `codex_mcp_app`, `stagepass_web_emergency`, `stagepass_web_ops`, `legacy_web_migration`, and `recovery`. `stagepass_web_ops` is restricted to operational ids (`start_stage`, `retry_stage`, `interrupt_turn`, `recover_change`, `open_codex`, `update_codex_settings`) and must fail `actor_surface_forbidden` for every human decision. The Gateway calls Task 1's `isCodexDecisionSurfaceEnabled(phaseOrKind)` before actor classification: `legacy_web_migration` is accepted only when that exact phase/kind is disabled; `codex_mcp_app` is accepted only when enabled. The ability to create new legacy commands is removed in Task 20, after the complete allowlist release gate.

`pipeline-command-action-map.ts` returns both external and canonical ids using this immutable alias map:

```ts
export const INTERACTION_ACTION_ALIASES = {
  supply_spec_fact: "request_spec_changes",
  dispute_spec_gap: "request_spec_changes",
  approve_test_plan: "approve_plan",
  request_qa_fix: "fix_blockers",
} as const;
```

Receipts/events retain both ids; `requireCurrentActionContract` always reads the canonical id.

- [ ] **Step 4: Implement gateway validation order**

Implement `executePipelineCommand(command)` in this order:

```ts
validateCommandShape(command);
const duplicate = readReceiptByIdempotency(command.changeId, command.idempotencyKey);
if (duplicate) return duplicateResultOnlyWhenRequestHashMatches(duplicate, command.requestHash);
const action = requireCurrentActionContract(command);
assertActorAllowed(command, action);
assertInteractionBinding(command);
assertFreshness(command, action);
return executeAndRecord(command, action);
```

Implement `PipelineCommandUnitOfWork` around the Drizzle transaction type and `pipeline-command-repository.ts`. `claim()` atomically CASes `presented → submitting` and inserts the unique accepted receipt with the Server-computed canonical request hash. For DB-only handlers, `complete()` revalidates and in one transaction writes the domain mutation, optional `human_decisions.command_id`, completed receipt, completed interaction, and deduplicated outbox effects.

Add explicit transaction ports—no singleton fallback inside a command—for:

```text
approveGateWithDb / rejectGateWithDb
answer/accept/defer/lock briefing WithDb
applySpecBattleDecisionWithDb
approvePlanSnapshotWithDb / rejectPlanSnapshotWithDb
recordBuildAdoptionIntentWithDb / finalizeBuildAdoptionWithDb
waiveReviewFindingWithDb
recordQaManualCheckWithDb / requestQaFixWithDb
approve/reject/override merge WithDb
reworkChangeWithDb / transitionChangeStatusWithDb
```

Build/Fix adoption is the one filesystem boundary: claim + adoption outbox are committed first; the idempotent dispatcher applies the exact patch identity; finalization then writes build state, human decision, completed receipt/interaction, and consumed outbox in one transaction. If the process dies after patch apply, recovery recognizes target HEAD/patch hash and finalizes without applying twice. A crash before any SQLite commit leaves no business mutation; a crash after a final commit replays only pending outbox effects.

- [ ] **Step 5: Add handler registration without moving policies**

Register explicit handlers by canonical action id. The first slice must cover `approve_intake`, `reject_intake`, `approve_spec`, `reject_spec`, `approve_tech_spec`, `reject_tech_spec`, `approve_plan`, `approve_merge`, and `reject_merge`. Call only the new transaction ports; do not duplicate blocker logic.

- [ ] **Step 6: Run gateway tests**

Run:

```bash
pnpm test -- server/services/pipeline-command-unit-of-work.test.ts server/services/pipeline-command-action-map.test.ts server/services/pipeline-command-gateway.test.ts server/services/action-contract-service.test.ts server/services/gate-service.test.ts server/services/briefing-question-store.test.ts server/services/spec-battle-routes.test.ts server/services/plan-sandbox-service.test.ts server/services/build-workspace-service.test.ts server/services/review-waiver-service.test.ts server/services/qa-run-service.test.ts server/services/merge-readiness-service.test.ts server/services/change-rework-service.test.ts server/services/change-service.test.ts
```

Expected: PASS for freshness, idempotency, actor, transaction receipt, and existing action decisions.

- [ ] **Step 7: Commit the gateway foundation**

```bash
git add server/services/pipeline-command-types.ts server/services/pipeline-command-unit-of-work.ts server/services/pipeline-command-unit-of-work.test.ts server/services/pipeline-command-action-map.ts server/services/pipeline-command-action-map.test.ts server/services/pipeline-command-gateway.ts server/services/pipeline-command-gateway.test.ts server/repositories/pipeline-command-repository.ts server/services/action-contract-service.ts server/services/action-contract-decision-router.ts server/services/gate-service.ts server/services/gate-service.test.ts server/services/briefing-question-store.ts server/services/briefing-question-store.test.ts server/services/spec-battle-service.ts server/services/spec-battle-routes.test.ts server/services/plan-approval-service.ts server/services/plan-sandbox-service.test.ts server/services/build-workspace-service.ts server/services/build-workspace-service.test.ts server/services/review-waiver-service.ts server/services/review-waiver-service.test.ts server/services/qa-run-service.ts server/services/qa-run-service.test.ts server/services/merge-readiness-service.ts server/services/merge-readiness-service.test.ts server/services/change-rework-service.ts server/services/change-rework-service.test.ts server/services/change-status-service.ts server/services/change-service.test.ts
git commit -m "feat(pipeline): centralize authoritative commands"
```

---

### Task 6: Move next-stage orchestration out of React and into the Server

**Files:**
- Create: `server/services/pipeline-command-orchestration.ts`
- Create: `server/services/pipeline-command-orchestration.test.ts`
- Modify: `server/services/pipeline-command-gateway.ts`
- Modify: `app/projects/[id]/changes/[changeId]/use-change-commands.ts`
- Modify: `app/projects/[id]/changes/[changeId]/next-stage-handoff.test.ts`
- Create: `app/api/projects/[id]/changes/[changeId]/commands/route.ts`
- Create: `app/api/projects/[id]/changes/[changeId]/commands/route.test.ts`

- [ ] **Step 1: Pin the current chained behavior in a Server test**

```ts
it("approving intake enqueues Spec from a freshly recomputed contract", async () => {
  const result = await orchestrateAfterCommand(fixture("approve_intake"));
  assert.deepEqual(result.enqueued, [{ actionId: "run_spec", phase: "spec" }]);
});

it("approving a test plan enqueues Build exactly once", async () => {
  const result = await orchestrateAfterCommand(fixture("approve_plan", {
    previousStatus: "TESTPLAN_DONE",
  }));
  assert.deepEqual(result.enqueued, [{ actionId: "run_build", phase: "implement" }]);
});

it("approving a plan does not skip TestPlan", async () => {
  const result = await orchestrateAfterCommand(fixture("approve_plan", {
    previousStatus: "PLAN_READY",
  }));
  assert.deepEqual(result.enqueued, []);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/pipeline-command-orchestration.test.ts`

Expected: FAIL because Server orchestration does not exist.

- [ ] **Step 3: Implement the explicit transition map**

```ts
const FOLLOW_UP: Record<string, {
  whenPreviousStatus?: string;
  actionId: string;
  phase: string;
} | null> = {
  approve_intake: { actionId: "run_spec", phase: "spec" },
  approve_spec: { actionId: "run_tech_spec", phase: "tech-spec" },
  approve_tech_spec: { actionId: "run_plan", phase: "plan" },
  approve_plan: null,
  approve_merge: { actionId: "merge", phase: "release" },
};
```

Handle the TestPlan reuse of `approve_plan` by matching `previousStatus === "TESTPLAN_DONE"` and enqueueing `run_build`. Recompute the action contract after the approval and before enqueue; never reuse the pre-approval version/hash.

- [ ] **Step 4: Expose one public command route**

Implement `POST /api/projects/:projectId/changes/:changeId/commands`. Parse:

```ts
{
  actionId: z.string().min(1),
  expectedGateVersion: z.string().min(1),
  expectedSourceDbHash: z.string().min(1),
  expectedHeadSha: z.string().min(1).nullable(),
  idempotencyKey: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
}
```

Do not accept actor or request hash from the request body. Server canonicalizes route project/change, external/canonical action ids, freshness fields, and parsed payload, then computes SHA-256 `requestHash`.

Classify through a Server-owned registry: operational actions become `{ kind: "system", surface: "stagepass_web_ops" }`; a still-unmigrated legacy Web human action becomes `{ kind: "human", surface: "legacy_web_migration" }` only when Task 1's shared helper returns false for that phase/kind. Once the helper returns true, the same default Web action returns `403 actor_surface_forbidden`. Add route tests for a forged actor, forged request hash, missing expected HEAD, ops attempting `approve_merge`, a partial allowlist where Intake is Codex-native but Spec remains legacy, an unknown kind that fails closed, and a legacy action after its phase becomes enabled.

- [ ] **Step 5: Replace React chaining with one command call**

In `use-change-commands.ts`, remove `GATE_NEXT_STAGE_ENDPOINTS`, `GATE_NEXT_STAGE_ACTION_IDS`, and `startNextStage`. Each handler posts one command and then refreshes read models. No React hook may enqueue the following stage.

- [ ] **Step 6: Run route, orchestration, and Web handoff tests**

Run:

```bash
pnpm test -- server/services/pipeline-command-orchestration.test.ts 'app/api/projects/[id]/changes/[changeId]/commands/route.test.ts' 'app/projects/[id]/changes/[changeId]/next-stage-handoff.test.ts'
```

Expected: PASS and the Web test asserts absence of `startNextStage`.

- [ ] **Step 7: Commit Server-side orchestration**

```bash
git add server/services/pipeline-command-orchestration.ts server/services/pipeline-command-orchestration.test.ts server/services/pipeline-command-gateway.ts 'app/api/projects/[id]/changes/[changeId]/commands/route.ts' 'app/api/projects/[id]/changes/[changeId]/commands/route.test.ts' 'app/projects/[id]/changes/[changeId]/use-change-commands.ts' 'app/projects/[id]/changes/[changeId]/next-stage-handoff.test.ts'
git commit -m "refactor(pipeline): move stage handoffs to server"
```

---

### Task 7: Build the durable Human Interaction Broker

**Files:**
- Create: `server/services/interaction-types.ts`
- Create: `server/services/human-interaction-broker.ts`
- Create: `server/services/human-interaction-broker.test.ts`
- Create: `server/services/interaction-presentation-orchestrator.ts`
- Create: `server/services/interaction-presentation-orchestrator.test.ts`
- Create: `server/repositories/codex-interaction-repository.ts`
- Modify: `server/services/job-dispatch-service.ts`
- Modify: `server/services/job-dispatch-service.test.ts`
- Modify: `server/services/pipeline-job-runner-service.ts`
- Modify: `server/services/pipeline-job-runner-service.test.ts`
- Modify: `server/services/event-service.ts`
- Modify: `server/types/enums.ts`

- [ ] **Step 1: Write envelope and lifecycle tests**

```ts
it("deduplicates the active interaction identity", () => {
  const first = broker.ensureInteraction(input);
  const second = broker.ensureInteraction(input);
  assert.equal(second.id, first.id);
});

it("expires the card when gate identity moves", () => {
  const card = broker.ensureInteraction(input);
  broker.reconcileChange(CHANGE_ID, currentContract({
    gateVersion: "8",
    sourceDbHash: "new",
  }));
  assert.equal(broker.get(card.id)?.status, "expired");
});

it("presents only through the Host-attested protected facade", async () => {
  const interaction = await broker.ensureInteraction(input);
  assert.equal("present" in broker, false);
  const presented = await protectedPresentationFacade.present({
    interactionId: interaction.id,
    hostAttestation: canonicalHostAttestation("thread-1"),
  });
  assert.equal(readInteraction(presented.envelope.id)?.invocationNonceHash.length, 64);
  assert.equal("privateInvocationNonce" in broker.get(interaction.id)!, false);
  assert.equal("invocationNonceHash" in broker.get(interaction.id)!, false);
});

it("never serializes secrets or raw stderr into payload", () => {
  const card = broker.ensureInteraction(inputWithSensitiveEvidence());
  assert.doesNotMatch(JSON.stringify(card.payload), /Bearer |sk-|SECRET_VALUE|\\/Users\\//);
});

it("ensures one dedicated presentation job for every enabled interaction", async () => {
  const [first, duplicate] = await Promise.all([
    broker.ensureInteraction(input),
    broker.ensureInteraction(input),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal(readPresentationJobs(first.id).length, 1);
  await runInteractionPresentation(first.id);
  assert.equal(readPresentationLogicalTurns(first.id).length, 1);
  assert.equal(readPresentationAttempts(first.id).length, 1);
});

it("creates no presentation job or turn for a disabled phase", async () => {
  const interaction = await broker.ensureInteraction(disabledPhaseInput);
  assert.equal(interaction, null);
  assert.equal(readPresentationJobsForPhase("Spec").length, 0);
});

it("recovers crash after interaction commit before presentation dispatch", async () => {
  const interaction = await ensureInteractionAndCrashBeforePresentation(input);
  assert.equal(readPresentationJobs(interaction.id).length, 1);
  await recoverQueuedPresentationJobs();
  assert.equal(readPresentationTurns(interaction.id).length, 1);
});

it("settles presentation only after Host-attested present succeeds", async () => {
  const interaction = await broker.ensureInteraction(input);
  await runPresentationWithoutModelCallingPresent(interaction.id);
  assert.equal(readInteraction(interaction.id).status, "pending");
  const retry = await retryPresentationSameJob(interaction.id);
  assert.equal(retry.ordinal, 1);
  await hostAttestedPresentAndLoseResponse(interaction.id);
  assert.equal(readInteraction(interaction.id).status, "presented");
  await recoverQueuedPresentationJobs();
  assert.equal(readPresentationDispatches(interaction.id), 2);
  assert.equal(readSuccessfulPresentations(interaction.id), 1);
});

it("fails closed when the bounded presentation budget is exhausted", async () => {
  const interaction = await exhaustPresentationBudget(input);
  assert.equal(readInteraction(interaction.id).status, "failed");
  assert.equal(readPresentationJob(interaction.id).status, "failed");
  assert.equal(readEmergencyProjection(interaction.id).available, true);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/human-interaction-broker.test.ts server/services/interaction-presentation-orchestrator.test.ts server/services/job-dispatch-service.test.ts server/services/pipeline-job-runner-service.test.ts`

Expected: FAIL because interaction types, repository, and broker do not exist.

- [ ] **Step 3: Define the versioned envelope**

Create the discriminated schema from Task 1's sole kind tuple:

```ts
export const InteractionKind = z.enum(CODEX_DECISION_INTERACTION_KINDS);
```

Define `InteractionEnvelopeSchema` with literal `schemaVersion: "stagepass.interaction/v1"`, the fields in the design, and form controls limited to `text`, `textarea`, `radio`, `select`, `checkbox`, and `confirmation`. Status includes both `expired` (no longer fresh) and `superseded` (a replacement interaction exists).

- [ ] **Step 4: Implement repository transitions with compare-and-set**

Export:

```ts
createInteraction(input): InteractionEnvelope;
getInteraction(id: string): InteractionEnvelope | null;
findActiveInteraction(identity): InteractionEnvelope | null;
markPresented(id: string, expectedStatus: "pending"): InteractionEnvelope;
completeInteraction(id: string, commandId: string): InteractionEnvelope;
expireInteraction(id: string, supersededById?: string): InteractionEnvelope;
```

Every update must include the expected prior status in the SQL `WHERE`; zero changed rows returns `interaction_state_conflict`.

Do not export a standalone `beginSubmit`. Only `PipelineCommandUnitOfWork.claim(tx, interactionId, receipt)` may move `presented → submitting`, consume the invocation nonce, and insert the accepted receipt in one transaction. Recovery treats a submitting interaction as owned only when a matching accepted receipt/request hash exists; otherwise it safely restores `presented`.

Store an invocation nonce hash, source thread id, expiry, consumed timestamp, `expectedHeadSha`, and request hash. The raw nonce exists only in model-hidden App metadata, expires after 10 minutes, and is consumed once.

The repository and Broker expose no `present()` operation and no return type containing a raw nonce. Their public read projections omit both raw nonce and nonce hash. Only Task 8's Host-attested protected presentation facade may call the package-private nonce rotation/CAS transaction and receive the raw value for App-private `_meta`.

- [ ] **Step 5: Implement broker projections**

`ensureInteraction()` reads current `stage_actions`, `stage_gates`, phase-specific facts, and the canonical binding. Before creating a card it calls Task 1's shared rollout helper; disabled/unmapped kind creates neither interaction nor presentation job. For an enabled kind, the same DB transaction creates/deduplicates the interaction and directly ensures one dedicated queued presentation `pipeline_job` keyed uniquely by `(interactionId, effectType="interaction_present")`; presentation does not enter `pipeline_command_outbox`.

`enqueueInteractionPresentation()`/`interaction-presentation-orchestrator.ts` is generic across the complete interaction-kind registry. The job persists `next_turn_ordinal` as the next presentation logical-turn ordinal plus the absolute deadline. A fenced CAS allocates/increments that ordinal before logical resolution; the worker's existing `attempt_no` remains only a lease/worker retry counter and never participates in logical identity. Its worker CAS-acquires the dedicated job lease, resolves `pipelineJobId + role=interaction_present + interactionId + ordinal` with `dispatchSurface=follower_ipc`, and calls the engine with only `logicalTurnId`.

Wire this path into production dispatch, not only the orchestrator test fixture. `job-dispatch-service.ts` recognizes the typed `job_kind="interaction_present"` row and submits its id to the normal runner. `pipeline-job-runner-service.ts` registers an exhaustive `interaction_present` handler that parses the persisted effect payload, checks `effect_deadline_at`, and invokes `interaction-presentation-orchestrator.ts`; unknown/mismatched payloads fail closed without starting a turn. Its tests enqueue through the real dispatcher/runner and prove one live lease, one ordinal allocation, one logical turn, and one execution across duplicate dispatch and restart. The stage handler remains unchanged and is selected only for `job_kind="stage"`.

A follower turn reaching terminal does not by itself complete presentation. Only a Host-attested successful `present_stagepass_interaction` operation may CAS interaction `pending→presented` and complete the job. If the model never calls present and interaction is still pending, the same job may allocate the next ordinal/logical slot within its deadline; response loss after successful present is absorbed by the persisted `presented` state and cannot retry. Duplicate present is idempotent for the same source thread. Budget exhaustion marks interaction/job failed and exposes the audited emergency surface. `reconcileChange()` expires stale interactions and cancels queued presentation work.

- [ ] **Step 6: Emit interaction events**

Extend `EventType` and `event-service.ts` for created, presented, expired, completed, and failed events. Raw JSON contains only ids, kind, phase, status, action ids, gate version, and source hash.

- [ ] **Step 7: Run broker tests**

Run: `pnpm test -- server/services/human-interaction-broker.test.ts server/services/interaction-presentation-orchestrator.test.ts server/services/job-dispatch-service.test.ts server/services/pipeline-job-runner-service.test.ts server/services/db-first-pipeline-contract.test.ts`

Expected: PASS for deduplication, compare-and-set, stale expiry, serialization, and existing DB-first authority.

- [ ] **Step 8: Commit the interaction broker**

```bash
git add server/services/interaction-types.ts server/services/human-interaction-broker.ts server/services/human-interaction-broker.test.ts server/services/interaction-presentation-orchestrator.ts server/services/interaction-presentation-orchestrator.test.ts server/repositories/codex-interaction-repository.ts server/services/job-dispatch-service.ts server/services/job-dispatch-service.test.ts server/services/pipeline-job-runner-service.ts server/services/pipeline-job-runner-service.test.ts server/services/event-service.ts server/types/enums.ts
git commit -m "feat(interactions): project durable human decision cards"
```

---

### Task 8: Expose interaction and Desktop control APIs

**Files:**
- Create: `app/api/interactions/[interactionId]/route.ts`
- Create: `app/api/interactions/[interactionId]/submit/route.ts`
- Create: `app/api/interactions/[interactionId]/route.test.ts`
- Create: `server/services/mcp-submit-auth-service.ts`
- Create: `server/services/mcp-submit-auth-service.test.ts`
- Create: `server/services/mcp-presentation-auth-service.ts`
- Create: `server/services/mcp-presentation-auth-service.test.ts`
- Create: `mcp/supervisor.ts`
- Create: `mcp/supervisor.test.ts`
- Create: `mcp/stagepass-submit-signer.ts`
- Create: `app/api/codex/health/route.ts`
- Create: `app/api/codex/health/route.test.ts`
- Create: `app/api/projects/[id]/changes/[changeId]/codex/open/route.ts`
- Create: `app/api/projects/[id]/changes/[changeId]/codex/open/route.test.ts`
- Modify: `server/services/pipeline-command-gateway.ts`

- [ ] **Step 1: Write API security tests**

```ts
it("does not expose sensitive interaction fields", async () => {
  const response = await GET(interactionRequest);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal("requestHash" in body, false);
  assert.doesNotMatch(JSON.stringify(body), /Bearer |sk-|\\/Users\\//);
});

it("rejects an ordinary HTTP submit that bypasses MCP", async () => {
  const response = await POST(unsignedSubmitRequest());
  assert.equal(response.status, 401);
  assert.equal(executedCommands.length, 0);
});

it("cannot mint auth from an ordinary workspace process", async () => {
  const result = await runWorkspaceProcessWithKnownSubmitDetails();
  assert.equal(result.signError, "submit_auth_channel_unavailable");
  assert.equal((await POST(result.request)).status, 401);
  assert.equal(executedCommands.length, 0);
});

it("does not expose submit auth to a managed Codex turn", async () => {
  const probe = await runManagedTurnAuthProbe();
  assert.equal(probe.secretReadable, false);
  assert.equal(probe.validMacMinted, false);
});

it("accepts authorization minted over the Host/App channel", async () => {
  const request = await hostLaunchedMcpProcess.authorize(validSubmit);
  assert.equal((await POST(request)).status, 200);
});

it("rejects a signed submit from the wrong source thread", async () => {
  const response = await POST(signedSubmitRequest({ sourceThreadId: "other-thread" }));
  assert.equal(response.status, 403);
  assert.equal(executedCommands.length, 0);
});

it("consumes a signed interaction nonce only once", async () => {
  assert.equal((await POST(signedSubmitRequest())).status, 200);
  assert.equal((await POST(signedSubmitRequest())).status, 409);
});

it("forces the submit actor to codex_mcp_app", async () => {
  await POST(signedSubmitRequest({ bodyActor: { surface: "recovery" } }));
  assert.equal(executedCommand.actor.surface, "codex_mcp_app");
});

it("protects present and status before returning structured content", async () => {
  for (const operation of [protectedPresent, protectedStatus]) {
    for (const sourceThreadId of [undefined, "other-thread"]) {
      const result = await operation({ interactionId: INTERACTION_ID, sourceThreadId });
      assert.equal(result.errorCode, "source_thread_mismatch");
      assert.equal(result.structuredContent, undefined);
    }
  }
});

it("delivers raw presentation nonce only through the Host-attested channel", async () => {
  const presented = await hostLaunchedMcpProcess.present(INTERACTION_ID, CANONICAL_THREAD);
  assert.equal(presented.envelope.id, INTERACTION_ID);
  assert.equal(typeof presented.privateInvocationNonce, "string");
  assert.equal(readInteraction(INTERACTION_ID).invocationNonceHash.length, 64);
  assert.equal("invocationNonce" in await publicInteractionGet(INTERACTION_ID), false);
  for (const caller of [ordinaryProcess, managedModelTurn]) {
    await assert.rejects(
      caller.present(INTERACTION_ID),
      hasCode("presentation_auth_channel_unavailable"),
    );
  }
});

it("safely rotates a nonce when present response is lost", async () => {
  const lost = await presentAndCrashAfterHashBeforeResponse(INTERACTION_ID);
  const retried = await hostLaunchedMcpProcess.present(INTERACTION_ID, CANONICAL_THREAD);
  assert.notEqual(hash(retried.privateInvocationNonce), lost.persistedHash);
  assert.equal(await submitWithNonce(lost.rawNonceIfObserved), "invocation_nonce_invalid");
  assert.equal(await submitWithNonce(retried.privateInvocationNonce), "accepted");
  assert.equal(await submitWithNonce(retried.privateInvocationNonce), "invocation_nonce_consumed");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- 'app/api/interactions/[interactionId]/route.test.ts' app/api/codex/health/route.test.ts 'app/api/projects/[id]/changes/[changeId]/codex/open/route.test.ts' server/services/mcp-submit-auth-service.test.ts server/services/mcp-presentation-auth-service.test.ts mcp/supervisor.test.ts`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Implement interaction GET and private submit**

`GET /api/interactions/:id` returns a public envelope view. `POST /api/interactions/:id/submit` accepts only action id, expected gate/hash/head, idempotency key, raw invocation nonce, and form values; it never accepts actor or request hash.

Public GET never returns raw nonce or nonce hash. Model-visible present/status tools do not use public GET directly. They call `mcp-presentation-auth-service.ts` over the inherited Host-attested FD channel, which validates OS peer/Host ancestry/bundle/launch record and requires the attested source thread to equal both interaction thread and current binding before returning any structured content; missing/wrong source returns `source_thread_mismatch` with zero content.

The protected `presentInteraction` broker operation atomically CASes `pending→presented` (or safely re-presents the same interaction/source), generates a cryptographic raw nonce, stores only its hash/expiry/generation, and returns the public envelope plus raw nonce to the MCP server. The present tool places the raw nonce only in App-private `_meta`. If the process crashes after hash commit but before response, a same-source re-present transaction increments nonce generation and rotates the hash; every prior nonce becomes invalid. Wrong source, ordinary process, model invocation, replay, and cross-task present/status fail before content.

`mcp-submit-auth-service.ts` generates a 32-byte ephemeral secret in StagePass Server memory at startup; it never writes that secret to the repository, worktree, filesystem, environment, command line, MCP config, or child-process arguments. It exposes a Host/App-only authorization broker outside every project/worktree sandbox. The runtime directory may live under the OS user runtime/Application Support location with parent mode `0700`, but permissions are defense in depth—not the authorization boundary.

Codex Desktop launches the registered StagePass MCP through a StagePass supervisor. Only that Host-attested launch receives an already-open broker FD/one-time pipe; `mcp/stagepass-submit-signer.ts` asks the Server over that channel to MAC method, path, canonical body hash, Host-attested source thread id, timestamp, and transport nonce, and never receives the secret itself. The broker validates the connection's OS peer PID/audit token, expected Codex Host ancestry, MCP bundle digest, and one-time launch record. Opening the endpoint as the same UID is insufficient. If the Host cannot provide an inherited channel plus peer/process attestation, health is `unsupported` and Phase 0 fails closed.

The route verifies the broker MAC and rejects missing/invalid authorizations, timestamps outside 30 seconds, and replayed transport nonces before reading the interaction. Tests must prove that a managed Codex turn cannot read a key or mint a MAC, an ordinary workspace process still fails when given the route/interaction/body/endpoint, and the valid Host-launched MCP process succeeds.

After transport authentication, the route hashes the raw interaction nonce, compares it to the current generation's unconsumed/unexpired DB hash, and requires the signed source thread id to equal both interaction and canonical binding. It recomputes `requestHash` from the canonical Server payload and atomically calls the UnitOfWork claim; it does not call a separate unfenced `beginSubmit`. Retry/recovery follows the Task 5 receipt fence.

- [ ] **Step 4: Implement Desktop health**

Return:

```ts
{
  status: "ready" | "disabled" | "unavailable" | "unsupported",
  appServerVersion: string | null,
  appServerProtocolFingerprint: string | null,
  desktopClientVersion: string | null,
  desktopFollowerProtocolFingerprint: string | null,
  shellCapabilities: { required: string[], available: string[] },
  followerCapabilities: { required: string[], available: string[] },
  followerStart: {
    lastResults: Array<{ at: string, result: "no-client-found" | "started" | "ambiguous" }>,
    readinessProbeSupported: false,
  },
  mcpHostEvidence: {
    status: "passed" | "missing" | "failed",
    verifiedBy: "real-mcp-fixture" | null,
    hostFingerprint: string | null,
    verifiedAt: string | null,
  },
  followerStartAttempts: {
    prepared: number,
    dispatching: number,
    quarantined: number,
    oldestAmbiguousAgeMs: number | null,
  },
  turnObservation: {
    notYetVisible: number,
    lastSemanticCursor: number | null,
    invalidSnapshotCount: number,
  },
  decisionRollout: {
    masterEnabled: boolean,
    phases: CodexDecisionPhase[],
    errorCode: "codex_decision_rollout_invalid" | null,
  },
  bindings: { ready: number, running: number, detached: number },
  interactions: { pending: number, expired: number, failed: number },
}
```

No absolute socket path or raw IPC error is returned.

- [ ] **Step 5: Implement open-in-Codex**

The open route reads the binding, verifies app-server shell control still sees the persistent shell and that it belongs to the route's project/change, then calls the follower transport with `codex://threads/<threadId>`. This user-facing open does not start a turn. A missing/deleted shell returns `409` with `desktop_thread_detached`.

- [ ] **Step 6: Run API tests**

Run: `pnpm test -- 'app/api/interactions/[interactionId]/route.test.ts' app/api/codex/health/route.test.ts 'app/api/projects/[id]/changes/[changeId]/codex/open/route.test.ts' server/services/mcp-submit-auth-service.test.ts mcp/supervisor.test.ts`

Expected: PASS for actor forcing, response redaction, rollout config-error reporting, health degradation, and correct thread opening.

- [ ] **Step 7: Commit APIs**

```bash
git add 'app/api/interactions/[interactionId]/route.ts' 'app/api/interactions/[interactionId]/submit/route.ts' 'app/api/interactions/[interactionId]/route.test.ts' app/api/codex/health/route.ts app/api/codex/health/route.test.ts 'app/api/projects/[id]/changes/[changeId]/codex/open/route.ts' 'app/api/projects/[id]/changes/[changeId]/codex/open/route.test.ts' server/services/mcp-submit-auth-service.ts server/services/mcp-submit-auth-service.test.ts server/services/mcp-presentation-auth-service.ts server/services/mcp-presentation-auth-service.test.ts mcp/supervisor.ts mcp/supervisor.test.ts mcp/stagepass-submit-signer.ts server/services/pipeline-command-gateway.ts
git commit -m "feat(api): expose Codex interaction and bridge controls"
```

---

### Task 9: Build the StagePass MCP Server with model/app separation

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/run-tests-isolated.ts`
- Create: `mcp/stagepass-api-client.ts`
- Create: `mcp/tool-metadata.ts`
- Create: `mcp/server.ts`
- Create: `mcp/server.test.ts`
- Modify: `mcp/supervisor.ts`
- Modify: `mcp/supervisor.test.ts`
- Create: `scripts/build-mcp-app.ts`

- [ ] **Step 1: Verify and reuse the Phase 0 dependency lock**

Run: `pnpm list @modelcontextprotocol/sdk @modelcontextprotocol/ext-apps esbuild`

Expected: all three Phase 0 dependencies resolve from `pnpm-lock.yaml`; Task 9 does not introduce a second MCP stack.

- [ ] **Step 2: Write metadata and authorization tests**

```ts
it("keeps submit invisible to the model", () => {
  assert.deepEqual(SUBMIT_TOOL_META.ui.visibility, ["app"]);
  assert.equal(SUBMIT_TOOL_META["openai/visibility"], "private");
});

it("keeps presentation read-only and widget accessible", () => {
  assert.deepEqual(PRESENT_TOOL_META.ui.visibility, ["model", "app"]);
  assert.equal(PRESENT_TOOL_META["openai/widgetAccessible"], true);
});

it("rejects a submit without app invocation context", async () => {
  await assert.rejects(
    callSubmitTool({ invocationSurface: "model" }),
    hasCode("app_invocation_required"),
  );
});

it("rejects a valid nonce from the wrong source task", async () => {
  await assert.rejects(
    callSubmitTool({ invocationSurface: "app", sourceThreadId: "other-thread" }),
    hasCode("source_thread_mismatch"),
  );
});
```

- [ ] **Step 3: Run and verify failure**

Run: `pnpm test -- mcp/server.test.ts`

Expected: FAIL because the MCP server and metadata do not exist.

- [ ] **Step 4: Implement the loopback API client**

`mcp/stagepass-api-client.ts` accepts only an `http://127.0.0.1:<port>` or `http://localhost:<port>` base URL. It exposes:

```ts
getInteraction(id: string): Promise<PublicInteractionEnvelope>;
submitInteraction(id: string, input: SubmitInteractionInput): Promise<SubmitInteractionResult>;
getInteractionStatus(id: string): Promise<{ status: InteractionStatus }>;
```

Use an `AbortController` timeout and return sanitized error codes; never forward Server stack traces to tool results.

- [ ] **Step 5: Register exactly four tools and one UI resource**

Register:

```text
present_stagepass_interaction       model + app, read-only
get_stagepass_interaction_status    model + app, read-only
submit_stagepass_interaction        app-only, private
continue_stagepass_interaction      app-only, private
ui://stagepass/interaction-v1       bundled App HTML
```

The present tool returns the envelope as structured content and references `ui://stagepass/interaction-v1`. The submit tool forwards to the private Server route only after verifying App invocation context.

Put the single-use nonce only in model-hidden `_meta`, and require Host-attested source thread identity to match the binding. `submit_stagepass_interaction` uses `mcp/stagepass-submit-signer.ts` as a broker client: over the inherited Host/App authorization FD it asks StagePass Server to MAC the canonical request, attested thread id, timestamp, and transport nonce, without ever reading the secret. `continue_stagepass_interaction` accepts only the completed interaction/command pair returned by submit; through the same protected channel it invokes the Server-owned wake resolver/prepare/dispatch path and delivers only the persisted marker-bearing continuation to the attested same shell. Neither tool sends an unsigned POST or falls back to a filesystem key. If the Host cannot provide the identity and protected channel, tool registration health is `unsupported` and Phase 0 fails. Enforce Zod schemas, a 64 KiB submit limit, evidence ids instead of raw paths, and loopback-only URLs.

- [ ] **Step 6: Add deterministic build/start scripts**

Add:

```json
{
  "scripts": {
    "mcp:build": "tsx scripts/build-mcp-app.ts",
    "mcp:start": "tsx mcp/supervisor.ts",
    "premcp:start": "pnpm mcp:build"
  }
}
```

`build-mcp-app.ts` bundles the UI to `mcp/dist/interaction-app.js` and the Host entry to `mcp/dist/supervisor.mjs`; the supervisor launches the bundled MCP server only after acquiring the protected broker channel. It inlines the UI bundle and CSS into the registered HTML, and fails if any entry or asset is missing. Directly registering or starting `mcp/server.ts` is forbidden because that would bypass Host/process attestation.

Add `visit(path.join(root, "mcp"));` to `listTests()` in `scripts/run-tests-isolated.ts` so the normal `pnpm test` release gate includes MCP server and App tests.

- [ ] **Step 7: Run MCP tests and build**

Run:

```bash
pnpm test -- mcp/server.test.ts mcp/supervisor.test.ts
pnpm mcp:build
```

Expected: tests PASS; build prints `MCP App bundle ready`; submit metadata remains app-only/private.

- [ ] **Step 8: Commit the MCP server**

```bash
git add package.json pnpm-lock.yaml mcp/stagepass-api-client.ts mcp/tool-metadata.ts mcp/server.ts mcp/server.test.ts mcp/supervisor.ts mcp/supervisor.test.ts scripts/build-mcp-app.ts scripts/run-tests-isolated.ts
git commit -m "feat(mcp): expose private StagePass decision tools"
```

---

### Task 10: Build the MCP interaction card and same-thread wakeup

**Files:**
- Create: `mcp/ui/interaction-app.tsx`
- Create: `mcp/ui/interaction-app.css`
- Create: `mcp/ui/interaction-app.test.ts`
- Create: `server/services/interaction-wakeup-orchestrator.ts`
- Create: `server/services/interaction-wakeup-orchestrator.test.ts`
- Create: `server/services/interaction-wakeup-recovery-service.ts`
- Create: `server/services/interaction-wakeup-recovery-service.test.ts`
- Create: `server/services/host-continuation-delivery.ts`
- Create: `server/services/host-continuation-delivery.test.ts`
- Create: `server/services/pipeline-command-outbox-dispatcher.ts`
- Create: `server/services/pipeline-command-outbox-dispatcher.test.ts`
- Modify: `server/services/pipeline-command-unit-of-work.ts`
- Modify: `server/services/pipeline-command-unit-of-work.test.ts`
- Modify: `server/services/pipeline-command-gateway.ts`
- Modify: `server/services/pipeline-command-gateway.test.ts`
- Modify: `server/services/job-dispatch-service.ts`
- Modify: `server/services/job-dispatch-service.test.ts`
- Modify: `server/services/pipeline-job-runner-service.ts`
- Modify: `server/services/pipeline-job-runner-service.test.ts`
- Modify: `mcp/server.ts`
- Modify: `mcp/server.test.ts`
- Modify: `mcp/supervisor.ts`
- Modify: `mcp/supervisor.test.ts`

- [ ] **Step 1: Write pure UI-state tests**

```ts
it("disables submission until required reasons are present", () => {
  assert.equal(canSubmit(waiverEnvelope, { reason: "" }), false);
  assert.equal(canSubmit(waiverEnvelope, { reason: "accepted after review" }), true);
});

it("never sends ui/message before private submit succeeds", async () => {
  await submitCard(failingSubmitContext);
  assert.equal(failingSubmitContext.uiMessages.length, 0);
});

it("wakes the same task after success", async () => {
  await submitCard(successContext);
  assert.equal(successContext.directUiMessages.length, 0);
  assert.deepEqual(successContext.privateToolCalls.at(-1), {
    name: "continue_stagepass_interaction",
    input: { interactionId: "INT-1", commandId: "CMD-1" },
  });
  assert.match(successContext.persistedContinuation, /\\[stagepass-run:.*:attempt:.*\\]/);
});

it("does not let host wake and recovery start two turns", async () => {
  await Promise.all([
    prepareAndSendHostWake({ interactionId: "INT-1", commandId: "CMD-1" }),
    runWakeRecovery({ interactionId: "INT-1", commandId: "CMD-1" }),
  ]);
  const logical = readInteractionWakeLogicalTurns("INT-1", "CMD-1");
  assert.equal(logical.length, 1);
  assert.equal(readAttempts(logical[0].logicalTurnId).length, 1);
  assert.equal(readDispatchCount(logical[0].logicalTurnId), 1);
  assert.equal(readExecutions(logical[0].logicalTurnId).length, 1);
});

it("recovers wakeup ownership across commit, delay, and lease takeover", async () => {
  const decision = await commitDecisionAndCrashBeforeWakeOwner("INT-1");
  assert.equal(readWakePipelineJobs(decision.commandId).length, 1);
  await recoverPendingWake(decision.commandId);
  assert.equal(readWakeExecutions(decision.commandId).length, 1);

  const delayed = seedExpiredWakeLease(decision.commandId);
  const claimed = await recoverPendingWake(decision.commandId);
  assert.equal(claimed.pipelineJobId, delayed.pipelineJobId);
  await assert.rejects(delayed.oldWorkerSettle(), hasCode("stale_start_attempt_fence"));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- mcp/ui/interaction-app.test.ts`

Expected: FAIL because card state and submit behavior do not exist.

- [ ] **Step 3: Implement generic schema-driven controls**

Render the envelope title, phase, summary, blockers, warnings, evidence references, actions, and form controls. Derive validation solely from `form.fields[].required`; never derive action enablement locally. Before submit, refresh the interaction and replace the visible card if the Server reports `expired`.

- [ ] **Step 4: Implement private submit and wakeup ordering**

Use this order:

```ts
const current = await callTool("get_stagepass_interaction_status", { interactionId });
if (current.status !== "presented") throw new Error("interaction_not_presented");
const result = await callTool("submit_stagepass_interaction", submitInput);
await callTool("continue_stagepass_interaction", {
  interactionId,
  commandId: result.commandId,
});
```

The decision-completion transaction uses `(commandId, effectType="interaction_wakeup")` to atomically ensure one dedicated queued interaction-wakeup `pipeline_job` and its outbox row. `continue_stagepass_interaction` calls Server `prepareInteractionWake`: it CAS-acquires that job's live lease, resolves the deterministic `pipelineJobId + interactionId + commandId + role/round/ordinal` slot, durably prepares its full-unique attempt from persisted request/fence, claims dispatch, and asks the attested Host channel to deliver the persisted marker-bearing continuation to the same shell. The App never calls `sendUiMessage` directly and never constructs message identity or marker.

Implement that backend path explicitly. `PipelineCommandUnitOfWork.complete()` and Gateway persist the completed decision, typed wake job, and wake outbox effect in one transaction. `pipeline-command-outbox-dispatcher.ts` consumes the wake effect by id and asks `job-dispatch-service.ts` to dispatch the already-existing job; it cannot create a second job. `pipeline-job-runner-service.ts` registers an exhaustive `interaction_wakeup` handler that parses the typed payload and invokes `interaction-wakeup-orchestrator.ts`. The orchestrator allocates `next_turn_ordinal` by fenced CAS, claims the binding-run lease, resolves `dispatchSurface=host_ui_message`, and calls `host-continuation-delivery.ts` with only the persisted logical/attempt identity.

`host-continuation-delivery.ts` is the sole Server-side adapter for the Host continuation broker exposed by `mcp/supervisor.ts`. The supervisor validates the inherited Host channel and attested source thread, then delivers the already persisted marker-bearing message to that exact Codex task. Neither `mcp/server.ts`, UI code, the model, Gateway, outbox dispatcher, runner, nor recovery can call a raw `sendUiMessage`; repository-wide AST tests allow the Host API only from this adapter. `continue_stagepass_interaction` invokes this backend service and returns its durable status, never a caller-constructed message.

If protected continuation delivery fails, show “决策已保存，任务将在恢复后继续”; do not call submit again. Recovery scans queued/expired-lease wake jobs, CAS-acquires the same job, then invokes the same durable continuation service; it never directly sends a UI message. If Host already claimed/sent, compensation only performs marker/baseline reconciliation; if Host has a proved pre-send failure, it may continue the same safe attempt within the original deadline. Tests cover crash after decision commit but before owner acquisition, long wait/lease expiry with fenced takeover, and Host/recovery concurrency; all require one job, logical row, prepare, dispatch, and execution.

- [ ] **Step 5: Add accessibility and destructive-action treatment**

Use semantic field labels, focus the first invalid field, include an `aria-live` status region, require a confirmation checkbox for reject/waive/override/adopt actions, and render P0 blockers as non-submittable.

- [ ] **Step 6: Run UI and server tests**

Run:

```bash
pnpm test -- mcp/ui/interaction-app.test.ts mcp/server.test.ts
pnpm test -- server/services/interaction-wakeup-orchestrator.test.ts server/services/interaction-wakeup-recovery-service.test.ts server/services/host-continuation-delivery.test.ts server/services/pipeline-command-outbox-dispatcher.test.ts server/services/pipeline-command-unit-of-work.test.ts server/services/pipeline-command-gateway.test.ts server/services/job-dispatch-service.test.ts server/services/pipeline-job-runner-service.test.ts mcp/supervisor.test.ts
pnpm mcp:build
```

Expected: PASS; bundled resource includes no Server URL other than the configured loopback origin.

- [ ] **Step 7: Commit the MCP App**

```bash
git add mcp/ui/interaction-app.tsx mcp/ui/interaction-app.css mcp/ui/interaction-app.test.ts server/services/interaction-wakeup-orchestrator.ts server/services/interaction-wakeup-orchestrator.test.ts server/services/interaction-wakeup-recovery-service.ts server/services/interaction-wakeup-recovery-service.test.ts server/services/host-continuation-delivery.ts server/services/host-continuation-delivery.test.ts server/services/pipeline-command-outbox-dispatcher.ts server/services/pipeline-command-outbox-dispatcher.test.ts server/services/pipeline-command-unit-of-work.ts server/services/pipeline-command-unit-of-work.test.ts server/services/pipeline-command-gateway.ts server/services/pipeline-command-gateway.test.ts server/services/job-dispatch-service.ts server/services/job-dispatch-service.test.ts server/services/pipeline-job-runner-service.ts server/services/pipeline-job-runner-service.test.ts mcp/server.ts mcp/server.test.ts mcp/supervisor.ts mcp/supervisor.test.ts
git commit -m "feat(mcp): render durable StagePass decision cards"
```

---

### Task 11: Deliver PRD and Intake interactions end-to-end

**Files:**
- Modify: `server/services/human-interaction-broker.ts`
- Modify: `server/services/pipeline-command-gateway.ts`
- Modify: `server/services/briefing-question-store.ts`
- Modify: `server/services/prd-briefing-service.ts`
- Modify: `server/services/action-contract-registry-service.ts`
- Modify: `server/services/action-contract-decision-router.ts`
- Modify: `server/services/action-contract-types.ts`
- Modify: `server/services/action-contract-service.test.ts`
- Create: `server/services/prd-interaction-flow.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts`

- [ ] **Step 1: Write PRD interaction flow tests**

```ts
it("answers, accepts an assumption, and defers only non-critical questions", async () => {
  await submit("answer_prd_question", { questionId: "Q1", answer: "B2B teams" });
  await submit("accept_prd_assumption", { questionId: "Q2", confirmation: true });
  await submit("defer_prd_question", { questionId: "Q3", reason: "Post-MVP" });
  assert.equal(question("Q1").status, "answered");
  assert.equal(question("Q2").status, "assumption_accepted");
  assert.equal(question("Q3").status, "deferred");
  await assert.rejects(submit("defer_prd_question", {
    questionId: "CRITICAL",
    reason: "skip",
  }), hasCode("critical_question_cannot_defer"));
});

it("locks PRD and enqueues Spec through one gateway command", async () => {
  const result = await submit("approve_intake", {});
  assert.equal(result.humanDecisionId !== null, true);
  assert.deepEqual(enqueuedActions(), ["run_spec"]);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/prd-interaction-flow.test.ts`

Expected: FAIL because PRD question actions are not registered in the Gateway/Broker.

- [ ] **Step 3: Add PRD interaction actions**

Add `answer_prd_question`, `accept_prd_assumption`, `defer_prd_question`, and `lock_prd_briefing` to `ACTION_DEFINITIONS`, `action-contract-types.ts`, and `action-contract-decision-router.ts`; their policies use current briefing identity/gate hash and never fall through to an unrelated stage gate. Register these plus existing `approve_intake` and `reject_intake` in the Gateway with these exact payload rules:

```ts
const PrdInteractionPayloads = {
  answer_prd_question: z.object({
    questionId: z.string().min(1),
    answer: z.string().trim().min(1).max(8_000),
  }),
  accept_prd_assumption: z.object({
    questionId: z.string().min(1),
    confirmation: z.literal(true),
  }),
  defer_prd_question: z.object({
    questionId: z.string().min(1),
    reason: z.string().trim().min(1).max(2_000),
  }),
  lock_prd_briefing: z.object({
    briefingId: z.string().min(1),
    confirmation: z.literal(true),
  }),
  approve_intake: z.object({
    confirmation: z.literal(true),
  }),
  reject_intake: z.object({
    reason: z.string().trim().min(1).max(2_000),
  }),
} as const;
```

`accept_prd_assumption` must re-read the question and require a non-empty Server-stored `suggestedDefault`; the client cannot provide replacement assumption text. `defer_prd_question` must reject critical questions. Question input writes the question domain row, receipt, and event but not `human_decisions`; lock/approve/reject are decisions and do write `human_decisions`. Call existing briefing store/service transaction ports and preserve critical-question gate behavior.

- [ ] **Step 4: Use the generic interaction presentation orchestrator**

PRD/Intake use Task 7's same transactional `enqueueInteractionPresentation()` path as every other interaction kind; do not enqueue from this stage service or borrow the PRD/stage execution lease. The dedicated presentation job resolves the canonical Change binding and uses this exact instruction:

```text
StagePass has a human interaction ready. Call
present_stagepass_interaction with the interactionId supplied in this turn's
structured StagePass context.
Do not decide, approve, reject, waive, or submit on the user's behalf.
```

Its job identity is deduplicated by interaction id and its logical turn uses `role=interaction_present`. Duplicate Broker calls/restart must not create a second job/attempt/turn.

- [ ] **Step 5: Roll out PRD and Intake without breaking later phases**

Retain questions, answers, draft, final review, gate, and progress display. Both Web and Broker call the shared rollout helper. After real MCP parity passes, expand the deployment allowlist to exactly `PRD,Intake`: those Web controls become `Open in Codex` + interaction status, while Spec and every later phase must still accept `legacy_web_migration` and must not present an MCP decision card. Under the emergency flag only, render the same envelope form and submit to the Gateway with `stagepass_web_emergency`.

- [ ] **Step 6: Run PRD and Intake tests**

Run:

```bash
pnpm test -- server/services/prd-interaction-flow.test.ts server/services/prd-briefing-service.test.ts server/services/action-contract-service.test.ts 'app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts'
```

Expected: PASS; with `PRD,Intake` enabled, default PRD Web source contains no direct question mutation fetch and Spec remains on the legacy migration path. Master off makes both phases legacy again.

- [ ] **Step 7: Commit PRD/Intake migration**

```bash
git add server/services/human-interaction-broker.ts server/services/pipeline-command-gateway.ts server/services/briefing-question-store.ts server/services/prd-briefing-service.ts server/services/action-contract-registry-service.ts server/services/action-contract-decision-router.ts server/services/action-contract-types.ts server/services/action-contract-service.test.ts server/services/prd-interaction-flow.test.ts 'app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx' 'app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts'
git commit -m "feat(interactions): move PRD decisions into Codex"
```

---

### Task 12: Deliver Spec, TechSpec, Plan, and TestPlan interactions

All interactions in this task use Task 7's dedicated idempotent presentation-job orchestrator; stage services only create authoritative interaction facts and never start presentation turns directly.

**Files:**
- Modify: `server/services/human-interaction-broker.ts`
- Modify: `server/services/pipeline-command-gateway.ts`
- Modify: `server/services/spec-battle-service.ts`
- Modify: `server/services/plan-approval-service.ts`
- Modify: `server/services/action-contract-registry-service.ts`
- Modify: `server/services/action-contract-decision-router.ts`
- Modify: `server/services/action-contract-types.ts`
- Modify: `server/services/action-contract-service.test.ts`
- Modify: `server/services/pipeline-command-action-map.ts`
- Modify: `server/services/pipeline-command-action-map.test.ts`
- Create: `server/services/design-interaction-flow.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/spec-battlefield.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/plan-sandbox.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/testplan-sandbox.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/gate-panel.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/plan-sandbox.test.ts`

- [ ] **Step 1: Write the design-stage decision matrix test**

```ts
const cases = [
  ["supply_spec_fact", "request_spec_changes", "Spec", "Spec"],
  ["dispute_spec_gap", "request_spec_changes", "Spec", "Spec"],
  ["return_to_spec", "return_to_spec", "Spec", "Spec"],
  ["waive_spec_p1", "waive_spec_p1", "Spec", "Spec"],
  ["approve_spec", "approve_spec", "Spec", "Spec"],
  ["reject_spec", "reject_spec", "Spec", "Spec"],
  ["approve_tech_spec", "approve_tech_spec", "TechSpec", "TechSpec"],
  ["reject_tech_spec", "reject_tech_spec", "TechSpec", "TechSpec"],
  ["waive_plan_p1", "waive_plan_p1", "Plan", "Plan"],
  ["approve_plan", "approve_plan", "Plan", "Plan"],
  ["reject_plan", "reject_plan", "Plan", "Plan"],
  ["approve_test_plan", "approve_plan", "TestPlan", "Plan"],
  ["reject_test_plan", "reject_test_plan", "TestPlan", "TestPlan"],
] as const;
for (const [externalId, canonicalId, interactionPhase, canonicalPhase] of cases) {
  assert.deepEqual(resolveInteractionAction(externalId), { externalId, canonicalId });
  assert.equal(projectInteractionPhase(externalId), interactionPhase);
  assert.equal(requireActionDefinition(canonicalId).phase, canonicalPhase);
}
```

This is a dual-identity contract: the external action and source envelope retain the user-facing phase, while policy/handler lookup uses the canonical definition's own phase. Add explicit tests that P0 cannot be waived, P1 waiver requires a reason/target, stale report hashes are rejected, Plan approval does not skip TestPlan, and TestPlan approval enqueues Build once.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/design-interaction-flow.test.ts`

Expected: FAIL because the complete matrix is not registered.

- [ ] **Step 3: Implement phase-specific envelope projections**

For Spec include current round, report hash, open gaps, severity, evidence, and proposed patch. For TechSpec/Plan/TestPlan include artifact content hash, blockers, risks, and freshness. Bind every action to its current action contract version/hash.

- [ ] **Step 4: Register canonical actions, aliases, payloads, and handlers**

Add canonical `request_spec_changes`, `return_to_spec`, `reject_plan`, and `reject_test_plan` definitions and policies to registry/router/types. Keep the Task 5 aliases `supply_spec_fact → request_spec_changes`, `dispute_spec_gap → request_spec_changes`, and `approve_test_plan → approve_plan`; receipts record both ids.

Use these exact payload contracts:

```ts
const DesignDecisionPayloads = {
  supply_spec_fact: z.object({
    fact: z.string().trim().min(1).max(8_000),
    affectedArtifactIds: z.array(z.string().min(1)).max(20),
  }),
  dispute_spec_gap: z.object({
    gapId: z.string().min(1),
    reason: z.string().trim().min(1).max(4_000),
    evidenceIds: z.array(z.string().min(1)).max(20),
  }),
  return_to_spec: z.object({ reason: z.string().trim().min(1).max(4_000) }),
  waive_spec_p1: z.object({
    gapId: z.string().min(1),
    reason: z.string().trim().min(1).max(4_000),
  }),
  reject_plan: z.object({ reason: z.string().trim().min(1).max(4_000) }),
  approve_test_plan: z.object({ confirmation: z.literal(true) }),
  reject_test_plan: z.object({ reason: z.string().trim().min(1).max(4_000) }),
} as const;
```

Route canonical decisions through the Task 5 transaction ports for spec battle, gate, plan approval, and testplan state. Approval external id remains unambiguous in receipt/audit even though its canonical contract is `approve_plan`.

- [ ] **Step 5: Extend rollout through the design phases**

After the design-stage MCP suite passes, expand the same allowlist to `PRD,Intake,Spec,TechSpec,Plan,TestPlan`. Keep reports/artifacts/risk lists. For enabled phases, remove default decision callbacks/direct mutation fetches and render one shared `Open in Codex` control plus interaction status; Build/Fix and later phases remain on `legacy_web_migration`. Keep the emergency surface behind the health gate.

- [ ] **Step 6: Run design-stage tests**

Run:

```bash
pnpm test -- server/services/design-interaction-flow.test.ts server/services/action-contract-service.test.ts server/services/pipeline-command-action-map.test.ts server/services/spec-battle-routes.test.ts server/services/plan-sandbox-routes.test.ts 'app/projects/[id]/changes/[changeId]/plan-sandbox.test.ts'
```

Expected: PASS; enabled design phases are MCP-native, Build remains legacy, and no stage handoff is implemented in React.

- [ ] **Step 7: Commit design-stage migration**

```bash
git add server/services/human-interaction-broker.ts server/services/pipeline-command-gateway.ts server/services/spec-battle-service.ts server/services/plan-approval-service.ts server/services/action-contract-registry-service.ts server/services/action-contract-decision-router.ts server/services/action-contract-types.ts server/services/action-contract-service.test.ts server/services/pipeline-command-action-map.ts server/services/pipeline-command-action-map.test.ts server/services/design-interaction-flow.test.ts 'app/projects/[id]/changes/[changeId]/spec-battlefield.tsx' 'app/projects/[id]/changes/[changeId]/plan-sandbox.tsx' 'app/projects/[id]/changes/[changeId]/testplan-sandbox.tsx' 'app/projects/[id]/changes/[changeId]/gate-panel.tsx' 'app/projects/[id]/changes/[changeId]/plan-sandbox.test.ts'
git commit -m "feat(interactions): move design gates into Codex"
```

---

### Task 13: Deliver Build and Fix adoption interactions without weakening isolation

Build/Fix interaction presentation also uses Task 7's dedicated presentation job and lease; it must not reuse the Build/Fix workspace job lease or create a stage-owned presentation turn.

**Files:**
- Modify: `server/services/human-interaction-broker.ts`
- Modify: `server/services/pipeline-command-gateway.ts`
- Modify: `server/services/build-workspace-service.ts`
- Modify: `server/services/build-workspace-service.test.ts`
- Create: `server/services/build-interaction-flow.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`

- [ ] **Step 1: Write adoption identity tests**

```ts
it("adopts only the run and patch shown in the card", async () => {
  const card = buildAdoptionCard({ buildRunId: "build-3", patchHash: "abc" });
  replaceLatestBuild({ buildRunId: "build-4", patchHash: "def" });
  await assert.rejects(submitCard(card, "adopt_build"), hasCode("build_identity_drift"));
});

it("records a human decision before marking a Build adopted", async () => {
  const result = await submitCurrentBuild("adopt_build");
  assert.equal(readBuild().adoptionDecisionId, result.humanDecisionId);
  assert.equal(readBuild().status, "adopted");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/build-interaction-flow.test.ts`

Expected: FAIL because adoption interactions do not bind run/patch identity.

- [ ] **Step 3: Project Build/Fix evidence**

The envelope must include `buildRunId`, purpose, base commit, source HEAD, patch hash, changed-files hash, changed files, deviations, blockers, warnings, and sanitized diff reference. Do not inline an unbounded diff.

- [ ] **Step 4: Register `adopt_build`, `adopt_fix`, and `reject_build`**

Require build run id, patch hash, changed-files hash, and confirmation. Re-read `checkGitBaseCamp`, build record, and patch identity inside the Gateway immediately before calling existing adoption/rejection logic.

- [ ] **Step 5: Keep Build workspace safety tests green**

Run:

```bash
pnpm test -- server/services/build-interaction-flow.test.ts server/services/build-workspace-service.test.ts server/services/scope-check-service.test.ts server/services/adoption-commit-branch.test.ts
```

Expected: PASS for drift rejection, worktree isolation, scope, and adoption commit identity.

- [ ] **Step 6: Extend rollout through Build and Fix**

After the Build/Fix MCP and workspace-safety suites pass, add `Build,Fix` to the existing allowlist. Retain base-camp status, changed files, diff, deviations, run identity, and evidence. For those enabled phases replace adopt/reject controls with the Codex control and interaction status; Review/QA/Merge remain on `legacy_web_migration`. Emergency submission uses the same envelope/Gateway.

- [ ] **Step 7: Run Web Build tests**

Run: `pnpm test -- 'app/projects/[id]/changes/[changeId]/build-sandbox.test.ts' 'app/projects/[id]/changes/[changeId]/implement-diff.test.ts'`

Expected: PASS; Build/Fix have no default direct adoption POST, while Review remains on the legacy migration path.

- [ ] **Step 8: Commit Build/Fix migration**

```bash
git add server/services/human-interaction-broker.ts server/services/pipeline-command-gateway.ts server/services/build-workspace-service.ts server/services/build-workspace-service.test.ts server/services/build-interaction-flow.test.ts 'app/projects/[id]/changes/[changeId]/build-sandbox.tsx' 'app/projects/[id]/changes/[changeId]/build-sandbox.test.ts'
git commit -m "feat(interactions): move build adoption into Codex"
```

---

### Task 14: Deliver Review, QA, and Merge interactions

Review/QA/Merge presentation uses the same generic interaction-id keyed presentation job, logical slot, attempt, rollout guard, and recovery rules; no phase-specific presentation enqueue path is allowed.

**Files:**
- Modify: `server/services/human-interaction-broker.ts`
- Modify: `server/services/pipeline-command-gateway.ts`
- Modify: `server/services/review-waiver-service.ts`
- Modify: `server/services/qa-run-service.ts`
- Modify: `server/services/merge-readiness-service.ts`
- Modify: `server/services/change-rework-service.ts`
- Modify: `server/services/action-contract-registry-service.ts`
- Modify: `server/services/action-contract-decision-router.ts`
- Modify: `server/services/action-contract-types.ts`
- Modify: `server/services/action-contract-service.test.ts`
- Modify: `server/services/pipeline-command-action-map.ts`
- Modify: `server/services/pipeline-command-action-map.test.ts`
- Create: `server/services/release-interaction-flow.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/review-report-center.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/gate-panel.tsx`

- [ ] **Step 1: Write release decision tests**

```ts
it("waives only the selected current P1 finding with a reason", async () => {
  const result = await submit("waive_review_p1", {
    findingId: "F-P1",
    reason: "Accepted compatibility limitation",
  });
  assert.equal(readFinding("F-P1").waiverDecisionId, result.humanDecisionId);
});

it("refuses merge approval after source HEAD changes", async () => {
  const card = mergeCardAtHead("aaa");
  setRepoHead("bbb");
  await assert.rejects(submitCard(card, "approve_merge"), hasCode("source_head_drift"));
});
```

Also cover canonical `fix_blockers`, `stop_change`, `enter_qa`, `retry_qa`, `record_qa_manual_check`, `approve_merge`, `reject_merge`, `override_merge`, and `request_rework`. For external `request_qa_fix → fix_blockers`, assert `projectInteractionPhase("request_qa_fix") === "QA"` while `requireActionDefinition("fix_blockers").phase === "Review"`; receipts retain both identities and the handler still routes to Fix.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/release-interaction-flow.test.ts`

Expected: FAIL because the release interaction matrix is incomplete.

- [ ] **Step 3: Register the release action matrix and exact payloads**

Review cards include report id/hash, source build/head, findings and waiver eligibility. QA cards include test-plan link, command result/evidence, freshness, and manual checks. Merge cards include readiness id/hash/head, all blockers, accepted risk, and approval eligibility.

Add `record_qa_manual_check`, `override_merge`, and `request_rework` to registry/router/types with explicit policies. Existing `retry_qa`, `fix_blockers`, `stop_change`, `enter_qa`, `approve_merge`, and `reject_merge` stay canonical; Task 5 maps external `request_qa_fix` to `fix_blockers`.

```ts
const ReleaseDecisionPayloads = {
  waive_review_p1: z.object({
    findingId: z.string().min(1),
    reason: z.string().trim().min(1).max(4_000),
  }),
  fix_blockers: z.object({ confirmation: z.literal(true) }),
  stop_change: z.object({
    reason: z.string().trim().min(1).max(4_000),
    confirmation: z.literal(true),
  }),
  enter_qa: z.object({ confirmation: z.literal(true) }),
  retry_qa: z.object({
    qaRunId: z.string().min(1),
    reason: z.string().trim().min(1).max(2_000),
  }),
  record_qa_manual_check: z.object({
    qaRunId: z.string().min(1),
    checkId: z.string().min(1),
    outcome: z.enum(["passed", "failed"]),
    evidenceIds: z.array(z.string().min(1)).min(1).max(20),
    notes: z.string().trim().max(4_000).default(""),
  }),
  request_qa_fix: z.object({
    qaRunId: z.string().min(1),
    reason: z.string().trim().min(1).max(4_000),
  }),
  approve_merge: z.object({ confirmation: z.literal(true) }),
  reject_merge: z.object({ reason: z.string().trim().min(1).max(4_000) }),
  override_merge: z.object({
    blockerIds: z.array(z.string().min(1)).min(1).max(50),
    reason: z.string().trim().min(1).max(4_000),
    confirmation: z.literal(true),
  }),
  request_rework: z.object({
    phase: z.enum(["Plan", "TestPlan", "Build", "Implement", "Check", "Fix"]),
    reason: z.string().trim().min(1).max(4_000),
  }),
} as const;
```

`retry_qa` is a rerun command and writes receipt/event, not `human_decisions`; manual check outcome, request fix, Merge decisions, stop, waiver, and rework are human decisions.

- [ ] **Step 4: Recompute at submit time**

Before Review waiver, reload the finding and report. Before QA decision, reload QA run and source HEAD. Before Merge decision, call `computeMergeReadiness({ requireApproval: false, persist: true })`; reject any card identity drift.

- [ ] **Step 5: Complete the phase rollout**

After the release MCP/freshness suite passes, add `Review,QA,Merge`, producing the exact full allowlist `PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge`. Keep reports, findings, QA evidence, readiness, and blockers. Because these phases are now enabled, remove default waiver/fix/approve/reject callbacks and use the shared Codex control and emergency fallback only. Do not yet delete the legacy classifier; Task 20 first proves the complete release configuration.

- [ ] **Step 6: Run release and freshness suites**

Run:

```bash
pnpm test -- server/services/release-interaction-flow.test.ts server/services/action-contract-service.test.ts server/services/pipeline-command-action-map.test.ts server/services/review-waiver-service.test.ts server/services/qa-run-service.test.ts server/services/merge-readiness-service.test.ts server/services/review-qa-gate-service.test.ts server/services/change-rework-service.test.ts
```

Expected: PASS with P0 non-waivable, stale evidence rejected, human decision linkage intact, and all 11 target phases enabled through the shared helper.

- [ ] **Step 7: Commit release-stage migration**

```bash
git add server/services/human-interaction-broker.ts server/services/pipeline-command-gateway.ts server/services/review-waiver-service.ts server/services/qa-run-service.ts server/services/merge-readiness-service.ts server/services/change-rework-service.ts server/services/action-contract-registry-service.ts server/services/action-contract-decision-router.ts server/services/action-contract-types.ts server/services/action-contract-service.test.ts server/services/pipeline-command-action-map.ts server/services/pipeline-command-action-map.test.ts server/services/release-interaction-flow.test.ts 'app/projects/[id]/changes/[changeId]/review-report-center.tsx' 'app/projects/[id]/changes/[changeId]/gate-panel.tsx'
git commit -m "feat(interactions): move release decisions into Codex"
```

---

### Task 15: Turn Web into the operational control plane

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/codex-task-control.tsx`
- Create: `app/projects/[id]/changes/[changeId]/codex-task-control.test.ts`
- Create: `app/projects/[id]/changes/[changeId]/emergency-interaction-panel.tsx`
- Create: `app/api/codex/models/route.ts`
- Create: `app/api/codex/models/route.test.ts`
- Create: `app/api/projects/[id]/codex-settings/route.ts`
- Create: `app/api/projects/[id]/changes/[changeId]/codex-settings/route.ts`
- Create: `app/api/projects/[id]/changes/[changeId]/codex/interrupt/route.ts`
- Create: `app/api/projects/[id]/changes/[changeId]/codex/interrupt/route.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/pipeline-page-shell.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/change-api-client.ts`
- Modify: `app/projects/[id]/changes/[changeId]/use-change-detail-data.ts`
- Modify: `app/projects/[id]/changes/[changeId]/operational-phase-panel.tsx`

- [ ] **Step 1: Write control-surface tests**

```ts
it("shows open, interrupt, retry, evidence, and health but no approval button", () => {
  assert.match(source, /Open in Codex/);
  assert.match(source, /Retry|重试/);
  assert.match(source, /Interrupt current turn|中断当前执行/);
  assert.doesNotMatch(source, /stop_change/);
  assert.doesNotMatch(source, /onApprove|批准 Merge|批准收编/);
});

it("shows emergency decisions only for an unhealthy bridge", () => {
  assert.equal(shouldShowEmergency({ status: "ready" }, true), false);
  assert.equal(shouldShowEmergency({ status: "unavailable" }, true), true);
  assert.equal(shouldShowEmergency({ status: "unavailable" }, false), false);
});

it("uses the Server rollout projection per phase", () => {
  assert.equal(viewFor({ phase: "PRD", codexDecisionEnabled: true }).isReadOnly, true);
  assert.equal(viewFor({ phase: "Spec", codexDecisionEnabled: false }).showsLegacyDecision, true);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- 'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts'`

Expected: FAIL because the control component does not exist.

- [ ] **Step 3: Implement task control**

Display binding title/status, Desktop and MCP health, last turn/observation, current interaction, model/effort, Open in Codex, repair, start/retry, `interrupt_turn`, and recovery guidance. `interrupt_turn` calls the dedicated Codex interrupt route, matches the active turn/job lease, and records `stagepass_web_ops`; it does not transition the Change or write `human_decisions`. Business `stop_change` appears only in the MCP/emergency decision envelope.

Expose the existing `listCodexModels()` through `GET /api/codex/models`, and persist Project defaults/Change overrides through the two settings routes. Validate that the selected reasoning effort belongs to the selected catalog model. Execution resolves settings in this fixed order: per-command override, Change override, Project default, Codex default.

- [ ] **Step 4: Implement emergency fallback**

Render only when the Server's shared rollout helper projects the current phase/kind as enabled and health is disabled/unavailable/unsupported/detached. Require an explicit disclosure checkbox and reason, then submit the current envelope through the Gateway as `stagepass_web_emergency`.

- [ ] **Step 5: Wire the Change page**

`change-api-client.ts` adds `getCodexHealth`, `openCodexTask`, `getInteraction`, and `executeCommand`. The Server-produced Change/control projection includes `codexDecisionEnabled` computed only by `isCodexDecisionSurfaceEnabled(phaseOrKind)`; React never reads rollout env vars or recomputes the allowlist. Enabled phases are read-only by default, while a disabled phase retains its migration Web controls until Task 20 cleanup. The page keeps phase rail, artifacts, diff, findings, tests, logs, and decisions read-only where rollout is enabled.

- [ ] **Step 6: Run Web control tests**

Run:

```bash
pnpm test -- 'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts' 'app/api/projects/[id]/changes/[changeId]/codex/interrupt/route.test.ts' 'app/projects/[id]/changes/[changeId]/pipeline-ui-model.test.ts' 'app/projects/[id]/changes/[changeId]/phase-review.test.ts'
```

Expected: PASS with no user decision available on the default Web surface.

- [ ] **Step 7: Commit the control plane UI**

```bash
git add app/api/codex/models/route.ts app/api/codex/models/route.test.ts 'app/api/projects/[id]/codex-settings/route.ts' 'app/api/projects/[id]/changes/[changeId]/codex-settings/route.ts' 'app/api/projects/[id]/changes/[changeId]/codex/interrupt/route.ts' 'app/api/projects/[id]/changes/[changeId]/codex/interrupt/route.test.ts' 'app/projects/[id]/changes/[changeId]/codex-task-control.tsx' 'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts' 'app/projects/[id]/changes/[changeId]/emergency-interaction-panel.tsx' 'app/projects/[id]/changes/[changeId]/page.tsx' 'app/projects/[id]/changes/[changeId]/pipeline-page-shell.tsx' 'app/projects/[id]/changes/[changeId]/change-api-client.ts' 'app/projects/[id]/changes/[changeId]/use-change-detail-data.ts' 'app/projects/[id]/changes/[changeId]/operational-phase-panel.tsx'
git commit -m "refactor(web): make StagePass the Codex control plane"
```

---

### Task 16: Remove obsolete Web chat and decision plumbing

**Files:**
- Delete: `app/projects/[id]/changes/[changeId]/refine-chat-panel.tsx`
- Delete: `app/projects/[id]/changes/[changeId]/action-reason-dialog.tsx`
- Delete: `app/projects/[id]/changes/[changeId]/action-reason-context.ts`
- Delete: `app/projects/[id]/changes/[changeId]/action-reason-context.test.ts`
- Modify: `app/projects/[id]/prd-editor.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/use-change-commands.ts`
- Modify: `app/projects/[id]/changes/[changeId]/use-pipeline-actions.ts`
- Modify: `app/projects/[id]/changes/[changeId]/pipeline-action-runner.ts`
- Modify: `app/projects/[id]/changes/[changeId]/phase-review.test.ts`

- [ ] **Step 1: Add a source-boundary test**

Assert no production TSX imports the obsolete components and no default decision panel posts directly to `gate/approve`, `gate/reject`, `plan-sandbox/decision`, `build-workspace`, finding waiver routes, or `stop_change`. The only default Web stop-like control is the dedicated operational `interrupt_turn` route.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- 'app/projects/[id]/changes/[changeId]/phase-review.test.ts'`

Expected: FAIL while obsolete imports and direct decision fetches remain.

- [ ] **Step 3: Delete chat/reason components and narrow hooks**

Keep only operational run/retry/`interrupt_turn`/recover commands in the Web hooks. Remove business `stop_change`, reason-dialog state, gate approval callbacks, and obsolete props from page/panels. `prd-editor.tsx` becomes a document viewer/editor only where artifact editing remains a supported Server action.

- [ ] **Step 4: Run the Change UI suite**

Run:

```bash
pnpm test -- 'app/projects/[id]/changes/[changeId]/phase-review.test.ts' 'app/projects/[id]/changes/[changeId]/pipeline-action-runner.test.ts' 'app/projects/[id]/changes/[changeId]/pipeline-action-commands.test.ts'
```

Expected: PASS and source-boundary scan reports zero direct decision routes.

- [ ] **Step 5: Commit obsolete UI removal**

```bash
git add 'app/projects/[id]/prd-editor.tsx' 'app/projects/[id]/changes/[changeId]/refine-chat-panel.tsx' 'app/projects/[id]/changes/[changeId]/action-reason-dialog.tsx' 'app/projects/[id]/changes/[changeId]/action-reason-context.ts' 'app/projects/[id]/changes/[changeId]/action-reason-context.test.ts' 'app/projects/[id]/changes/[changeId]/use-change-commands.ts' 'app/projects/[id]/changes/[changeId]/use-pipeline-actions.ts' 'app/projects/[id]/changes/[changeId]/pipeline-action-runner.ts' 'app/projects/[id]/changes/[changeId]/phase-review.test.ts'
git commit -m "refactor(web): remove duplicated decision UI"
```

---

### Task 17: Split retained Git evidence from user-facing Git operations

**Files:**
- Create: `server/services/repository-evidence-service.ts`
- Create: `server/services/repository-evidence-service.test.ts`
- Create: `server/services/workspace-versioning-service.ts`
- Create: `server/services/workspace-versioning-service.test.ts`
- Create: `server/services/git-service-consumer-inventory.ts`
- Create: `server/services/git-service-consumer-inventory.test.ts`
- Modify: `server/services/build-workspace-service.ts`
- Modify: `server/services/build-workspace-service.test.ts`
- Modify: `server/services/pipeline-build-stage-service.ts`
- Modify: `server/services/pipeline-build-stage-service.test.ts`
- Modify: `server/services/change-service.ts`
- Modify: `server/services/change-service.test.ts`
- Modify: `server/services/scope-check-service.ts`
- Modify: `server/services/scope-check-service.test.ts`
- Modify: `server/services/merge-readiness-service.ts`
- Modify: `server/services/merge-readiness-service.test.ts`
- Modify: `server/services/project-git-state-service.ts`
- Modify: `server/services/project-git-state-service.test.ts`
- Modify: `server/services/pipeline-service.test.ts`
- Modify: `server/services/git-service.ts`
- Modify: `server/services/git-service.test.ts`

- [ ] **Step 1: Write boundary tests**

```ts
it("exports repository facts without remote, push, stage, or commit UI methods", async () => {
  const exports = await import("./repository-evidence-service");
  assert.equal("getHeadSha" in exports, true);
  assert.equal("getBinaryDiff" in exports, true);
  assert.equal("pushCurrentBranch" in exports, false);
  assert.equal("createRemoteRepo" in exports, false);
  assert.equal("commitAll" in exports, false);
});

it("keeps internal adoption commits in workspace versioning", async () => {
  const exports = await import("./workspace-versioning-service");
  assert.equal("createBuildWorktree" in exports, true);
  assert.equal("applyAdoptionPatch" in exports, true);
  assert.equal("commitAdoptedPatch" in exports, true);
});

it("classifies every git-service import and call before deletion", () => {
  const inventory = buildGitServiceConsumerInventory(PROJECT_ROOT);
  assert.deepEqual(inventory.unclassified, []);
  assert.deepEqual(inventory.productionConsumers.sort(), [
    "server/services/build-workspace-service.ts",
    "server/services/change-service.ts",
    "server/services/merge-readiness-service.ts",
    "server/services/pipeline-build-stage-service.ts",
    "server/services/project-git-state-service.ts",
    "server/services/scope-check-service.ts",
  ]);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/repository-evidence-service.test.ts server/services/workspace-versioning-service.test.ts`

Expected: FAIL because the split services do not exist.

- [ ] **Step 3: Move read-only facts**

Move repo detection, HEAD/branch, status, diff, name-status, changed-file and hash helpers to `repository-evidence-service.ts`. Preserve timeouts, output limits, path normalization, secret/path redaction, and test injection seams.

- [ ] **Step 4: Move internal mutations**

Move worktree create/remove, internal branch create/delete, patch apply, and adoption commit to `workspace-versioning-service.ts`. Do not move remote creation, push, GitHub CLI, generic stage, or user-authored commit.

- [ ] **Step 5: Inventory and rewire every consumer**

Use the TypeScript compiler API to resolve imports, re-exports, namespace calls, destructured calls, and test imports of `git-service`; regex is not the authority. Freeze the initial manifest including `pipeline-build-stage-service.ts`, `change-service.ts`, all four Git API routes, and every listed test consumer. Rewire repository facts to `repository-evidence-service`, internal worktree/adoption calls to `workspace-versioning-service`, and delete user-operation calls with their UI/API. No production or test module may retain an import/re-export/require before Task 18 deletes `git-service`.

- [ ] **Step 6: Run internal Git safety suites**

Run:

```bash
pnpm test -- server/services/repository-evidence-service.test.ts server/services/workspace-versioning-service.test.ts server/services/git-service-consumer-inventory.test.ts server/services/build-workspace-service.test.ts server/services/pipeline-build-stage-service.test.ts server/services/change-service.test.ts server/services/scope-check-service.test.ts server/services/merge-readiness-service.test.ts server/services/project-git-state-service.test.ts server/services/pipeline-service.test.ts server/services/git-service.test.ts
```

Expected: PASS with identical evidence hashes, worktree isolation, adoption, and readiness results.

- [ ] **Step 7: Commit the internal split**

```bash
git add server/services/repository-evidence-service.ts server/services/repository-evidence-service.test.ts server/services/workspace-versioning-service.ts server/services/workspace-versioning-service.test.ts server/services/git-service-consumer-inventory.ts server/services/git-service-consumer-inventory.test.ts server/services/build-workspace-service.ts server/services/build-workspace-service.test.ts server/services/pipeline-build-stage-service.ts server/services/pipeline-build-stage-service.test.ts server/services/change-service.ts server/services/change-service.test.ts server/services/scope-check-service.ts server/services/scope-check-service.test.ts server/services/merge-readiness-service.ts server/services/merge-readiness-service.test.ts server/services/project-git-state-service.ts server/services/project-git-state-service.test.ts server/services/pipeline-service.test.ts server/services/git-service.ts server/services/git-service.test.ts
git commit -m "refactor(git): isolate repository evidence from Git UX"
```

---

### Task 18: Remove StagePass Git UI, APIs, and action contracts

**Files:**
- Modify: `app/projects/create-project-dialog.tsx`
- Modify: `app/projects/create-project-dialog.test.ts`
- Modify: `server/types/api.ts`
- Modify: `server/types/models.ts`
- Modify: `server/services/project-service.ts`
- Modify: `server/services/action-contract-registry-service.ts`
- Modify: `server/services/action-contract-decision-router.ts`
- Modify: `app/projects/[id]/page.tsx`
- Create: `app/projects/project-detail-git-removal.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/pipeline-action-commands.ts`
- Modify: `app/projects/[id]/changes/[changeId]/pipeline-ui-model.ts`
- Delete: `app/projects/[id]/git-setup-panel.tsx`
- Delete: `app/projects/[id]/git-workspace-panel.tsx`
- Delete: `app/projects/[id]/changes/[changeId]/stage-git-panel.tsx`
- Delete: `app/projects/[id]/changes/[changeId]/git-action-policy.ts`
- Delete: `app/projects/[id]/changes/[changeId]/git-action-policy.test.ts`
- Delete: `app/api/projects/[id]/git/route.ts`
- Delete: `app/api/projects/[id]/git/workspace/route.ts`
- Delete: `app/api/projects/[id]/git/suggest-message/route.ts`
- Delete: `app/api/projects/[id]/changes/[changeId]/git/route.ts`
- Delete: `server/services/action-contract-git-policy.ts`
- Delete: `server/services/action-contract-git-policy.test.ts`
- Delete: `server/services/commit-message-service.ts`
- Delete: `server/services/commit-message-service.test.ts`
- Delete: `server/services/git-service.ts`
- Delete: `server/services/git-service.test.ts`

- [ ] **Step 1: Write removal tests**

```ts
it("does not send or render a Git-enabled project option", () => {
  assert.doesNotMatch(dialogSource, /gitEnabled|启用 Git 集成/);
});

it("does not publish Git actions", () => {
  const ids = ACTION_DEFINITIONS.map((item) => item.actionId);
  assert.equal(ids.includes("init_git_repo"), false);
  assert.equal(ids.includes("commit_changes"), false);
});
```

Add a route inventory test asserting the four deleted Git route modules do not exist.
`app/projects/project-detail-git-removal.test.ts` must also assert `app/projects/[id]/page.tsx` has no Git panel imports, no `"git"` `NavSection`, no Git nav item, and no Git enabled/default-branch badge.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- app/projects/create-project-dialog.test.ts app/projects/project-detail-git-removal.test.ts server/services/action-contract-service.test.ts`

Expected: FAIL while Git checkbox/actions remain.

- [ ] **Step 3: Remove Project Git choice and auto-detect**

Remove `gitEnabled` from CreateProject input and dialog. Project creation records repository facts from `repository-evidence-service`. Keep legacy DB columns readable until a later database cleanup, but do not use them to enable UI.

- [ ] **Step 4: Remove actions, routes, panels, and user-operation functions**

Delete the listed Git surface files. In `app/projects/[id]/page.tsx`, remove both Git panel imports, the `git` nav section/item, rendering branches, and Git badges/fields. Remove `init_git_repo` and `commit_changes` from registry, decision router, endpoint maps, UI model, and tests. Remove remote/GitHub/push/manual stage/commit exports from `git-service.ts`.

Before deleting `git-service.ts`, run the Task 17 AST inventory in final mode and require zero production and test import/re-export/require/call consumers. This gate explicitly includes `pipeline-build-stage-service.ts`, `change-service.ts`, Build/scope/merge/project/pipeline tests, and the four deleted routes. Only after the count is zero may the file and its test be deleted.

- [ ] **Step 5: Add the non-Git Build blocker**

`buildBaseCampDecision` returns:

```ts
{
  enabled: false,
  reasonCode: "repository_required_for_protected_build",
  reason: "Initialize Git in Codex, then run repository recovery in StagePass.",
  blockers: [{
    id: "repository_required_for_protected_build",
    severity: "P1",
    title: "Protected Build requires a Git repository.",
  }],
}
```

Do not offer a StagePass initialization action.

- [ ] **Step 6: Run removal and safety tests**

Run:

```bash
pnpm test -- app/projects/create-project-dialog.test.ts app/projects/project-detail-git-removal.test.ts server/services/action-contract-service.test.ts server/services/git-service-consumer-inventory.test.ts server/services/build-workspace-service.test.ts server/services/pipeline-build-stage-service.test.ts server/services/change-service.test.ts server/services/merge-readiness-service.test.ts
pnpm lint
```

Expected: PASS; the TypeScript AST gate reports zero `git-service` consumers, and `rg -n "init_git_repo|commit_changes|pushCurrentBranch|createRemoteRepo" app server` returns no production matches.

- [ ] **Step 7: Commit Git surface removal**

```bash
git add app/projects/create-project-dialog.tsx app/projects/create-project-dialog.test.ts app/projects/project-detail-git-removal.test.ts 'app/projects/[id]/page.tsx' 'app/projects/[id]/git-setup-panel.tsx' 'app/projects/[id]/git-workspace-panel.tsx' 'app/projects/[id]/changes/[changeId]/stage-git-panel.tsx' 'app/projects/[id]/changes/[changeId]/git-action-policy.ts' 'app/projects/[id]/changes/[changeId]/git-action-policy.test.ts' 'app/projects/[id]/changes/[changeId]/pipeline-action-commands.ts' 'app/projects/[id]/changes/[changeId]/pipeline-ui-model.ts' 'app/api/projects/[id]/git/route.ts' 'app/api/projects/[id]/git/workspace/route.ts' 'app/api/projects/[id]/git/suggest-message/route.ts' 'app/api/projects/[id]/changes/[changeId]/git/route.ts' server/types/api.ts server/types/models.ts server/services/project-service.ts server/services/action-contract-registry-service.ts server/services/action-contract-decision-router.ts server/services/action-contract-git-policy.ts server/services/action-contract-git-policy.test.ts server/services/commit-message-service.ts server/services/commit-message-service.test.ts server/services/git-service-consumer-inventory.test.ts server/services/git-service.ts server/services/git-service.test.ts
git commit -m "refactor(git): remove StagePass Git operation surface"
```

---

### Task 19: Add restart, concurrency, detachment, and wakeup recovery

**Files:**
- Create: `server/services/codex-native-recovery-service.ts`
- Create: `server/services/codex-native-recovery-service.test.ts`
- Modify: `server/services/interaction-wakeup-recovery-service.ts`
- Modify: `server/services/interaction-wakeup-recovery-service.test.ts`
- Modify: `server/services/startup-recovery-service.ts`
- Modify: `server/services/startup-recovery-service.test.ts`
- Modify: `server/services/pipeline-worker-recovery-service.ts`
- Modify: `server/services/supervisor-health-service.ts`
- Modify: `server/services/event-service.ts`

- [ ] **Step 1: Write recovery matrix tests**

```ts
const cases = [
  ["persistent_shell_start_returns_no_client_found", "retry_actual_start_bounded"],
  ["start_attempt_prepared_old_lease_expired", "acquire_job_lease_then_handoff_same_attempt"],
  ["start_attempt_no_client_found_old_lease_expired", "acquire_job_lease_then_handoff_same_attempt"],
  ["start_attempt_safe_state_old_lease_live", "leave_owned_by_live_worker"],
  ["start_attempt_safe_state_deadline_expired", "quarantine_without_dispatch"],
  ["start_attempt_dispatching_unique_marker_delta", "adopt_turn_without_start"],
  ["start_attempt_dispatching_zero_after_deadline", "quarantine_ambiguous"],
  ["start_attempt_dispatching_multiple_matches", "quarantine_ambiguous"],
  ["durable_turn_not_yet_visible", "poll_read_only_without_cursor"],
  ["turn_running", "resume_app_server_snapshot_poll"],
  ["turn_completed_job_running", "settle_from_terminal_snapshot"],
  ["app_server_read_disconnected", "reinitialize_and_resume_snapshot_poll"],
  ["thread_missing", "mark_detached"],
  ["decision_completed_message_failed", "retry_wakeup_only"],
  ["interaction_stale", "expire_and_reproject"],
] as const;
for (const [desktopState, expected] of cases) {
  assert.equal(await recover(desktopState), expected);
}

seedCanonicalBinding(CHANGE_ID, "canonical-shell");
seedRunningExecution(CHANGE_ID, { threadId: "legacy-build-shell" });
assert.equal(await recover("execution_binding_mismatch"), "quarantine_noncanonical");
assert.deepEqual(fakeBridge.deepLinks, []);
assert.deepEqual(fakeBridge.followerStarted, []);
assert.equal(readMigrationEvents("noncanonical_thread_override").length, 1);

const prepared = seedAttempt({
  logicalTurnId: "logical-build-r1",
  pipelineJobId: "JOB-1",
  projectAiRunId: null,
  state: "prepared",
  workerId: "worker-old",
  leaseToken: "lease-old-expired",
  ownerAttempt: 1,
  ownerEpoch: 7,
});
await acquireLiveJobLease({ jobId: prepared.jobId, workerId: "worker-new" });
const claimed = await recover(prepared);
assert.equal(claimed.attemptId, prepared.attemptId);
assert.equal(claimed.logicalTurnId, prepared.logicalTurnId);
assert.equal(claimed.correlationMarker, prepared.correlationMarker);
assert.equal(claimed.preStartSemanticHash, prepared.preStartSemanticHash);
assert.equal(claimed.dispatchOrdinal, prepared.dispatchOrdinal);
assert.equal(claimed.workerId, "worker-new");
assert.equal(claimed.ownerEpoch, 8);
await assert.rejects(() => settleWithOldFence(prepared), hasCode("stale_attempt_owner"));

const projectRun = seedProjectAiRun({
  kind: "context_init",
  state: "running",
  leaseToken: "project-lease-expired",
});
const contextAttempt = seedAttempt({
  logicalTurnId: "logical-context-generate",
  pipelineJobId: null,
  projectAiRunId: projectRun.id,
  state: "prepared",
});
await acquireLiveProjectAiRunLease({ projectAiRunId: projectRun.id, workerId: "worker-new" });
assert.equal((await recover(contextAttempt)).projectAiRunId, projectRun.id);

await Promise.all([
  recoverHostWake("INT-1", "CMD-1"),
  recoverWakeCompensation("INT-1", "CMD-1"),
]);
const wake = readInteractionWakeIdentity("INT-1", "CMD-1");
assert.equal(wake.pipelineJobs, 1);
assert.equal(wake.logicalTurns, 1);
assert.equal(wake.attempts, 1);
assert.equal(wake.dispatches, 1);
assert.equal(wake.executions, 1);
```

Also simulate two changes with interleaved full thread/turn snapshots and assert no cross-change update. Feed the same semantic snapshot before and after a forced app-server reconnect and assert one projection, a strictly increasing StagePass-local cursor, and no follower lifecycle-subscription call. Add recovery fixtures for append, same-id update, reorder, removal, duplicate id, volatile-duration-only change, unknown kind, and terminal drift. Explicitly crash pipeline and project-AI owners after durable `prepared` and after durable `no_client_found`: recovery follows the non-null owner FK, first reacquires that lease, claims the same attempt through `claimSafeAttemptForWorker`, preserves marker/baseline/ordinal, rejects the old worker fence, and dispatches only within the original deadline. Deadline-expired safe states quarantine. `dispatching|ambiguous` safe-handoff attempts fail and remain reconciliation-only. Recover a PRD turn and both Context roles without synthetic Change identity. Finally crash Build/Fix after follower success but before attempt CAS and assert unique turn adoption, one workspace mutation, and one patch adoption.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- server/services/codex-native-recovery-service.test.ts`

Expected: FAIL because Codex-native recovery does not exist.

- [ ] **Step 3: Implement fenced Hybrid recovery**

Before any recovery deep link, observation, or follower start, re-read the authoritative `codex_thread_bindings` row. Compare its thread id with every execution/job/interaction thread reference. A mismatch is quarantined as `noncanonical_thread_override`, emits a sanitized migration diagnostic, and performs zero external calls; recovery must never resume a caller-provided or legacy stage-session id.

Recovery first follows the logical row's XOR owner FK and acquires or renews that live pipeline-job or project-AI-run lease, then re-reads the logical turn and canonical scope binding. A `prepared|no_client_found` row may move to a new worker only through `claimSafeAttemptForWorker({ attemptId, expectedState, expectedOldFence, newFence })`: the transaction proves the old lease expired, attempt/logical owner FK pairs match, immutable marker/baseline/ordinal match, and the original deadline remains open, then increments `ownerEpoch` while retaining the same logical/attempt identity. The old worker's later CAS must fail. An expired deadline quarantines without dispatch.

After that safe-state path, inspect every other `codex_follower_start_attempts` row before external start. A `dispatching|ambiguous` row—including after-IPC-write-before-response/unknown/success-before-CAS crashes—must reject safe handoff and only reconcile through app-server reads: compute baseline turn-id difference, require the exact persisted correlation marker and normalized prompt hash, and CAS-adopt exactly one candidate. Zero candidates remain read-only `turn_not_yet_visible` until the original attempt/job deadline, then quarantine; multiple/mismatched/terminal-conflicting candidates quarantine immediately. No dispatching/ambiguous/quarantined attempt may call follower start.

For a durably succeeded/adopted turn, verify the scope binding through app-server shell read/list and resume `thread/read(includeTurns:true)` from stored normalized item state, semantic snapshot hash, and observation cursor. A known turn absent from a read remains `turn_not_yet_visible`, produces no cursor/output, and never starts again. Visible snapshots must obey unique id, append/same-id update, no reorder/removal, volatile exclusion, and terminal immutability before projection. Use the corresponding owner lease token/attempt fence for every write.

Recovery may prepare only for a newly Server-resolved `logicalTurnId`/`turnSlot` that has no attempt row at all. If the same `logicalTurnId` already has any state, recovery must resume, hand off, reconcile, settle, or quarantine that row and never prepare another. A legitimate new business turn may reopen `codex://threads/<id>` and retry explicit `no-client-found` under the original rules. Never call an independent readiness probe or app-server `turn/start`. For completed interaction wakeup, recovery finds the transactionally ensured dedicated queued pipeline job, acquires or takes over its live lease, and resolves the same job/interaction/command slot as Host; it cannot invent another job or purpose-specific slot.

- [ ] **Step 4: Add startup reconciliation**

At startup:

1. Probe app-server shell/read control and Desktop follower transports separately; app-server must prove `thread/read(includeTurns:true)`, while Desktop is not required to expose lifecycle notifications.
2. Reconcile persistent shell bindings through read/list, failing ambiguous identity closed.
3. Follow each logical row's XOR owner FK; CAS acquire/renew the recoverable pipeline job or project AI run lease before touching its attempt, and validate the slot/binding belongs to that owner.
4. Safe-handoff only expired-owner `prepared|no_client_found` attempts through the explicit old-fence/new-fence CAS, preserving attempt/marker/baseline/ordinal and original deadline; reject stale old-worker settlement.
5. After the corresponding live job lease and logical-turn validation in step 3, reconcile `dispatching|ambiguous` attempts read-only; adopt unique marker candidates or quarantine ambiguity without handoff or redispatch.
6. Reconcile running pipeline jobs and project AI runs against app-server full-turn snapshots for their durably succeeded/adopted turn ids, including visibility lag and deterministic semantic validation; resume PRD or Context at its persisted logical role.
7. Expire stale interactions, including cards whose phase/kind is no longer enabled by Task 1's shared rollout helper.
8. Retry pending presentation only for enabled phase/kinds through its deterministic slot. For wakeup, scan dedicated queued/expired-lease jobs ensured by the decision transaction; Host and recovery CAS the same job lease, resolve the same interaction/command slot, and compete its single attempt. Disabled phases remain on the migration Web path.
9. Emit one health summary.

Reconcile accepted command receipts by request hash and `human_decisions.command_id`; dispatch pending outbox effects once. Recovery imports the same `isCodexDecisionSurfaceEnabled()` helper as Gateway/Web/Broker and never reads rollout env vars directly. Change deletion was already made FK-safe in Task 2. Migration rollback is roll-forward: disable flags and leave additive tables intact; a repair migration may add/fix indexes but never drop decision evidence.

- [ ] **Step 5: Run recovery and crash suites**

Run:

```bash
pnpm test -- server/services/codex-native-recovery-service.test.ts server/services/startup-recovery-service.test.ts server/services/pipeline-worker-recovery-service.test.ts
pnpm test:acceptance
```

Expected: PASS; no disconnected/unknown state is converted into success or redispatched, visibility lag never advances cursor/starts again, semantic invalidity fails closed, and Build/Fix recovery has no duplicate turn or filesystem effect.

- [ ] **Step 6: Commit recovery**

```bash
git add server/services/codex-native-recovery-service.ts server/services/codex-native-recovery-service.test.ts server/services/interaction-wakeup-recovery-service.ts server/services/interaction-wakeup-recovery-service.test.ts server/services/startup-recovery-service.ts server/services/startup-recovery-service.test.ts server/services/pipeline-worker-recovery-service.ts server/services/supervisor-health-service.ts server/services/event-service.ts
git commit -m "feat(recovery): reconcile Codex tasks and interactions"
```

---

### Task 20: Run the full migration acceptance gate and remove the rollback adapter

**Files:**
- Create: `scripts/verify-codex-native-e2e.ts`
- Create: `server/services/codex-native-acceptance.test.ts`
- Create: `server/services/codex-standalone-boundary.test.ts`
- Modify: `server/config/codex-decision-rollout.ts`
- Modify: `server/config/codex-decision-rollout.test.ts`
- Modify: `server/services/pipeline-command-types.ts`
- Modify: `server/services/pipeline-command-gateway.ts`
- Modify: `server/services/pipeline-command-gateway.test.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/commands/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/commands/route.test.ts`
- Modify: `server/services/ai-engine-adapter.ts`
- Modify: `server/services/ai-engine-adapter.test.ts`
- Modify: `server/services/codex-model-catalog-service.ts`
- Modify: `server/services/codex-model-catalog-service.test.ts`
- Modify: `server/services/codex-app-server-client.ts`
- Modify: `server/services/codex-app-server-client.test.ts`
- Modify: `server/services/codex-app-server-shell-control.ts`
- Modify: `server/services/codex-app-server-shell-control.test.ts`
- Modify: `server/services/codex-engine-shared.ts`
- Modify: `server/services/codex-engine-shared.test.ts`
- Delete after all checks pass: `server/services/codex-app-server-engine.ts`
- Delete after all checks pass: `server/services/codex-app-server-engine.test.ts`
- Modify: `docs/STAGEPASS-ACTUAL-REQUIREMENTS.md`

- [ ] **Step 1: Write the automated acceptance contract**

The test must assert:

```ts
assert.equal(await oneChangeOneThread(), true);
assert.equal(await appServerProvisionsFollowerExecutes(), true);
assert.equal(await appServerManagedTurnStartCount(), 0);
assert.equal(await stagePrdContextAndPresentationUseFollowerIpc(), true);
assert.equal(await interactionWakeUsesHostUiMessage(), true);
assert.equal(await dispatchSurfaceMismatchCount(), 0);
assert.equal(await actualStartRetriesAreBoundedAndCreateExactlyOneTurn(), true);
assert.equal(await logicalTurnSlotsAreServerOwnedAndDeterministic(), true);
assert.equal(await specWriterCriticVerdictUseThreeDistinctLogicalTurns(), true);
assert.equal(await buildFixRetriesReuseRoundAndNewRoundsDoNot(), true);
assert.equal(await concurrentRandomCallerIdentityCollapsesToOneLogicalTurnAndDispatch(), true);
assert.equal(await projectPrdTurnsUseDurableOwnersAndOnePrdShell(), true);
assert.equal(await projectContextSelectGenerateUseOneOwnerAndContextShell(), true);
assert.equal(await prdConfirmStartsFencedContextInit(), true);
assert.equal(await sqliteRejectsMissingOrDoubleLogicalOwner(), true);
assert.equal(await productionAiCallerInventoryHasNoUnclassifiedOrRollbackCaller(), true);
assert.equal(await durableStartAttemptsSurviveEveryCrashWindow(), true);
assert.equal(await safeAttemptHandoffRequiresLiveJobLeaseAndExpiredOldFence(), true);
assert.equal(await oldWorkerCannotSettleAfterHandoff(), true);
assert.equal(await expiredSafeAttemptQuarantinesWithoutDispatch(), true);
assert.equal(await dispatchingAndAmbiguousAttemptsCannotHandoff(), true);
assert.equal(await ambiguousStartReconcilesOrQuarantinesWithoutRedispatch(), true);
assert.equal(await staleStartAttemptFencesCannotSettle(), true);
assert.equal(await appServerReadObservesDesktopStartedTurns(), true);
assert.equal(await turnVisibilityLagNeverRestartsOrAdvancesCursor(), true);
assert.equal(await deterministicSemanticSnapshotsRejectInvalidEvolution(), true);
assert.equal(await snapshotPollDeduplicatesAndReconnects(), true);
assert.equal(await buildFixCrashRecoveryHasOneTurnAndOneFilesystemEffect(), true);
assert.equal(await desktopLifecycleSubscriptionCount(), 0);
assert.equal(await mcpHostEvidenceComesFromRealFixtureNotFollowerProbe(), true);
assert.equal(await legacyStageIdsNeverOverrideCanonicalBinding(), true);
assert.equal(await criticContextExcludesWriterScratch(), true);
assert.equal(await modelCannotSubmitHumanDecision(), true);
assert.equal(await duplicateClickCreatesOneDecision(), true);
assert.equal(await concurrentHostWakeAndCompensationCreateOneLogicalAttemptDispatchExecution(), true);
assert.equal(await staleCardCannotAdvance(), true);
assert.equal(await webAndMcpShareGateway(), true);
assert.equal(await gitSafetyWithoutGitUi(), true);
assert.equal(await restartAndConcurrencyRecover(), true);
assert.equal(await allCodexDecisionPhasesEnabled(), true);
assert.equal(await noNewLegacyWebCommandPath(), true);
```

`allCodexDecisionPhasesEnabled()` must compare the configured set to `CODEX_DECISION_PHASES` exactly, with master on and no rollout config error. A table test removes each phase in turn and proves release fails with `codex_decision_rollout_incomplete`; unknown/blank config also fails closed.

- [ ] **Step 2: Run unit, lint, and build gates**

Run:

```bash
pnpm test
STAGEPASS_CODEX_DECISION_SURFACE=on STAGEPASS_CODEX_DECISION_PHASES='PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge' pnpm test:acceptance
pnpm lint
pnpm build
pnpm mcp:build
```

Expected: every command exits `0`.

- [ ] **Step 3: Run the real-client PRD-to-Done verifier**

`verify-codex-native-e2e.ts` creates reusable Project PRD and Project Context tasks plus two fixture Change tasks in one Project. It submits two PRD user turns and proves distinct `project_ai_runs`/logical turns reuse the Project PRD shell, with no `__prd__`, synthetic Change, or legacy retry thread execution. Confirming the accepted PRD creates one `context_init` owner and runs `context_select` then `context_generate` as two logical turns on the Project Context shell before the Change PRD→Done flow proceeds.

Before Change execution it seeds conflicting legacy `spec_writer`, `spec_critic`, `build`, `fix`, and `latestSpecRetryThread` ids. The scheduler resolves Server-owned logical slots before the engine: one Spec business run must produce distinct writer, critic, and verdict logical turns; Build/Fix retry in a round must reuse its logical turn, while a new round must produce a new one. Concurrent duplicate callers with random caller correlation/thread values must resolve one logical row, one attempt, and one follower dispatch. SQLite negative fixtures prove missing/both-owner logical and attempt rows fail their FK/XOR constraints.

Each managed turn first persists its UUID attempt, exact service-derived marker, normalized prompt hash, complete job/lease/request fence, and pre-start turn baseline. It opens the canonical deep link before the dispatch CAS. The verifier uses deterministic process failpoints after durable prepare, after durable no-client, after the follower-start IPC write is committed but before a response, success-before-CAS, and unknown response. The post-write crash accepts only a real `0|1` turn delta and treats both outcomes as read-only reconciliation cases. After restart, recovery first acquires the live job lease; prepared/no-client safe-handoff retains the same attempt/marker/baseline/ordinal and rejects the old worker, while expired deadlines quarantine. Dispatching/ambiguous reject handoff and only perform baseline+marker reconciliation. The verifier proves unique adoption, zero/multiple quarantine, stale job/recovery fence rejection, and no redispatch.

For normal execution it opens the canonical deep link and directly retries the real follower start only on durably recorded explicit `no-client-found`; it never waits through a separate readiness API. One Change runs through PRD→Done using follower-started turns only, and every turn's progress/output/terminal proof is read through app-server `thread/read(includeTurns:true)`. A real-client fault wrapper hides a known turn for two polls to prove `turn_not_yet_visible` causes no cursor/output/start. Captured real snapshots are replayed through append/same-id update/reorder/removal/duplicate/unknown/volatile-only/identical reconnect/terminal drift cases. Build and Fix each cross a success-before-CAS restart and still show one follower turn, one workspace mutation, and one adoption.

Every deep link and follower-start provenance must use only the scope binding id, with no second shell provision for that scope. For every logical→attempt→execution chain, the verifier records immutable surface provenance and proves every stage, Project PRD/Context, and interaction-presentation chain is `follower_ipc`, while the interaction-wakeup chain is `host_ui_message`; role/surface mismatches total zero. Negative fixtures corrupt each of the three layers in turn and require `dispatch_surface_mismatch`, zero external calls, and zero state mutation during prepare, settlement, and recovery. The verifier also forces an app-server read disconnect, pauses the other Change at an MCP decision, restarts Server and Desktop, submits one duplicate click and one stale card, and races Host `ui/message` wake against recovery compensation. Both resolve the same owner/interaction/command logical slot; evidence must show one logical row, prepare, dispatch, and execution. It then interrupts one target turn and validates the complete correlation chain plus zero app-server managed `turn/start`. MCP Host attestation/protected-submit/`ui-message` pass only from real fixture evidence, never follower initialize metadata.

Run: `STAGEPASS_CODEX_DECISION_SURFACE=on STAGEPASS_CODEX_DECISION_PHASES='PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge' pnpm tsx scripts/verify-codex-native-e2e.ts`

Expected:

```text
CODEX-NATIVE E2E PASS
threads: 4 distinct, 4 persistent
project_prd_runs: 2
project_prd_shells: 1
project_context_runs: 1
project_context_role_turns: 2
synthetic_change_ids: 0
unclassified_ai_callers: 0
rollback_ai_callers: 0
completed_change: 1
duplicate_decisions: 0
stale_advances: 0
cross_change_events: 0
duplicate_turn_observations: 0
ambiguous_start_redispatches: 0
start_attempt_quarantines: 2
visibility_lag_cursor_advances: 0
visibility_lag_start_calls: 0
semantic_snapshot_invalid_accepts: 0
duplicate_build_fix_effects: 0
desktop_readiness_probe_calls: 0
desktop_lifecycle_subscriptions: 0
failed_start_turns_created: 0
logical_turn_slot_collisions: 0
duplicate_logical_turn_dispatches: 0
wakeup_logical_turns: 1
wakeup_prepares: 1
wakeup_dispatches: 1
wakeup_executions: 1
spec_role_turns: 3 distinct
round_boundary_identity_errors: 0
safe_handoff_identity_changes: 0
old_worker_settlements: 0
expired_safe_attempt_dispatches: 0
noncanonical_thread_uses: 0
extra_shell_provisions: 0
app_server_managed_turn_starts: 0
```

- [ ] **Step 4: Remove rollback execution and the legacy command writer**

Only after Steps 2–3 pass:

1. Call `assertCompleteCodexDecisionRollout()` and abort cleanup unless master is on and all 11 phases are enabled.
2. Remove the route/classifier branch that creates new `{ surface: "legacy_web_migration" }` commands; remove that value from live `PipelineCommandActorSurface` while retaining it in the persisted audit enum/read projection for historical rows. Gateway tests prove no new legacy receipt/decision can be written.
3. Change `ai-engine-adapter.ts` so its sole default loader imports/returns the Hybrid-backed `CodexDesktopEngine`; remove the dynamic `require("./codex-app-server-engine")`.
4. Retain `codex-app-server-client.ts` only as a supervised connection primitive for `CodexAppServerShellControl`, model catalog, and read-only `thread/read(includeTurns:true)` turn observation. Its exported production API must not expose app-server `turn/start`.
5. Keep `codex-model-catalog-service.ts` on shell control `listModels()`; do not invent a Desktop model-list requirement.
6. Remove rollback app-server-turn/process exports from `codex-engine-shared.ts` after remaining Hybrid consumers use shared prompt/output helpers.
7. Delete only the old `codex-app-server-engine.ts` managed-turn adapter and its test. Retain the app-server client, shell-control adapter/tests, and fixture needed to test persistent shell/control APIs.
8. Keep the bridge kill switch, which blocks follower execution rather than falling back silently to app-server `turn/start`.
9. Run the AST caller inventory in final mode: every production `AiEngineAdapter.run/runStreamed` call, including PRD and Context, must be classified `logical_resolver`; `rollback_adapter`, synthetic project change id, direct thread/correlation input, and an unclassified caller are release failures.

`codex-standalone-boundary.test.ts` scans production `server/**/*.ts` and fails if it finds an import/require of `codex-app-server-engine` or an exact app-server RPC method `"turn/start"` outside historical fixtures. It explicitly allows `spawn(..., ["app-server"])`, `thread/start` with `ephemeral:false`, `thread/name/set`, `thread/read` with `includeTurns:true`, thread list, and model-list inside the shell/read-control boundary. It rejects `probeFollower`, `openAndWaitForFollower`, Desktop lifecycle subscription/`thread/events` code, follower-derived MCP Host capability claims, direct follower start outside the fenced attempt service, any ambiguous-state redispatch method, synthetic PRD/Context change ids, and production construction such as `threadId: latestSpecRetryThread`. The AST inventory must classify every production AI caller as `logical_resolver` and find zero rollback entries. It proves Hybrid `AiRunInput` accepts only `logicalTurnId`; caller project/change/thread/correlation/slot overrides are rejected before external calls, and engine identity is reloaded through the concrete owner FK, live lease, and scope binding. Completed managed turns must have succeeded/adopted attempt provenance, exact marker/prompt/baseline evidence, one created turn, app-server semantic terminal evidence, and app-server managed `turn/start` count zero. The acceptance test also covers Project PRD/Context, wakeup race, visibility lag, semantic item evolution, logical role/round identity, safe handoff, Build/Fix exactly-once effects, and critic-context sentinels.

- [ ] **Step 5: Mark the requirements as achieved**

Update the requirement statuses for Server/Web separation, Desktop execution, MCP human decisions, model/effort controls, and Git surface migration. Record the verified Codex client version/protocol fingerprint and link the retained Phase 0/E2E evidence paths.

- [ ] **Step 6: Re-run the complete gate after cleanup**

Run:

```bash
pnpm test
STAGEPASS_CODEX_DECISION_SURFACE=on STAGEPASS_CODEX_DECISION_PHASES='PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge' pnpm test:acceptance
pnpm lint
pnpm build
pnpm mcp:build
git diff --check
```

Expected: all exit `0`; `rg -n "CodexAppServerEngine|codex-app-server-engine|init_git_repo|commit_changes" app server mcp` returns no production match. The Hybrid source-boundary test reports zero app-server managed `"turn/start"` requests while retaining shell/read-control calls and zero Desktop lifecycle subscriptions. The AST inventory reports zero unclassified/rollback production AI callers and explicitly covers PRD/Context. Acceptance proves each deterministic slot resolves one Server-owned logical turn, Spec writer/critic/verdict are distinct, PRD/Context use project owners, same-round retries reuse identity, new rounds do not, and concurrent random callers create one attempt/dispatch. Every external follower start is preceded by a durable prepared→dispatching fence; recovery first owns the concrete pipeline/project owner lease, safe-state handoff preserves identity and rejects old workers, expired safe states quarantine, all start/recovery CASes reject stale fences, and dispatching is neither handed off nor redispatched. Host wake and compensation create one logical/attempt/dispatch/execution. Visibility lag never starts/advances and semantic snapshot invalidity fails closed. It also finds no new `legacy_web_migration` construction or executable legacy thread/synthetic Change input. Seeded legacy ids never open/start/provision a second shell, and critic prompt reconstruction excludes writer sentinels.

- [ ] **Step 7: Commit the completed migration**

```bash
git add scripts/verify-codex-native-e2e.ts server/services/codex-native-acceptance.test.ts server/services/codex-standalone-boundary.test.ts server/services/codex-managed-ai-caller-inventory.ts server/services/codex-managed-ai-caller-inventory.test.ts server/services/prd-service.ts server/services/prd-service.test.ts server/services/context-init-service.ts server/services/context-init-service.test.ts server/config/codex-decision-rollout.ts server/config/codex-decision-rollout.test.ts server/services/pipeline-command-types.ts server/services/pipeline-command-gateway.ts server/services/pipeline-command-gateway.test.ts 'app/api/projects/[id]/changes/[changeId]/commands/route.ts' 'app/api/projects/[id]/changes/[changeId]/commands/route.test.ts' server/services/ai-engine-adapter.ts server/services/ai-engine-adapter.test.ts server/services/codex-model-catalog-service.ts server/services/codex-model-catalog-service.test.ts server/services/codex-app-server-client.ts server/services/codex-app-server-client.test.ts server/services/codex-app-server-shell-control.ts server/services/codex-app-server-shell-control.test.ts server/services/codex-engine-shared.ts server/services/codex-engine-shared.test.ts server/services/codex-app-server-engine.ts server/services/codex-app-server-engine.test.ts docs/STAGEPASS-ACTUAL-REQUIREMENTS.md
git commit -m "feat: complete Codex-native StagePass migration"
```

---

## Final release checklist

- [ ] Phase 0 evidence is PASS for the exact Codex Desktop version being released against.
- [ ] One Project contains two correctly named, persistent Change tasks.
- [ ] The same Project has one reusable Project PRD task and one reusable Project Context task; PRD user turns and Context select/generate use durable `project_ai_runs`, never synthetic Changes or legacy thread inputs.
- [ ] One Change uses one thread across all stages.
- [ ] Seeded legacy writer/critic/build/fix and `latestSpecRetryThread` ids never override the canonical binding, open a deep link, start a follower turn, or provision a second shell.
- [ ] Every shell is provisioned/named by app-server with `ephemeral:false`; stage, Project PRD/Context, and presentation logical→attempt→execution chains have immutable `follower_ipc`, wake chains have immutable `host_ui_message`, role/surface mismatch count is zero, and app-server managed `turn/start` count is zero.
- [ ] After deep link, the real start retries only explicit `no-client-found` within the bounded deadline; failed attempts create zero turns, first success creates exactly one and stops, no readiness probe is called, and the same shell is reused after exhaustion.
- [ ] Every follower start has a durable UUID attempt, derived marker, prompt hash, pre-start baseline, and concrete pipeline/project owner lease fence before dispatch; all crash windows reconcile without redispatch, unique candidates adopt, zero/multiple quarantine, and stale workers/recovery owners cannot settle.
- [ ] Every managed turn begins with a Server-owned logical slot backed by exactly one real `pipeline_job_id` or `project_ai_run_id` FK; SQLite XOR/partial unique constraints, immutable canonical request hash, role/round semantics, and caller-override rejection are proven.
- [ ] `dispatch_surface` has the same checked value across logical, attempt, and execution rows; prepare, settlement, and recovery reject every wrong-surface fixture with zero external call or mutation.
- [ ] Crash after `prepared|no_client_found` first reacquires the concrete live owner lease and safe-handoffs the same attempt/marker/baseline/ordinal; the old worker cannot settle, expired deadlines quarantine, and `dispatching|ambiguous` never hand off.
- [ ] Known-turn visibility lag remains read-only with zero cursor/output/start until visible or timeout.
- [ ] Snapshot projection enforces unique ids, append/same-id semantic update, no reorder/removal, volatile-field exclusion, identical reconnect dedupe, and terminal immutability.
- [ ] Build/Fix crash recovery creates one follower turn, one workspace mutation, and one patch adoption.
- [ ] Every Desktop-started turn is observed only through app-server `thread/read(includeTurns:true)` with bounded poll/reconnect, deterministic semantic deduplication, monotonic local cursor, and zero Desktop lifecycle subscriptions.
- [ ] Critic input is rebuilt only from the frozen spec, requirements, checklist, and fresh-evaluation instruction; writer scratch/transcript sentinels are absent and the review is an independent artifact.
- [ ] Model-visible tools cannot submit a human decision.
- [ ] Decision rollout master is on, all 11 fixed phases are enabled through the shared helper, and no new legacy Web command can be created.
- [ ] Every click is revalidated by current gate version, source hash, action contract, and interaction binding.
- [ ] Duplicate clicks and failed `ui/message` delivery do not duplicate decisions.
- [ ] Concurrent Host wake and recovery compensation resolve the same owner/interaction/command logical slot and produce one prepare, dispatch, and execution.
- [ ] Web contains operational controls and evidence but no default business-decision controls.
- [ ] Emergency Web actions are health-gated and audit as `stagepass_web_emergency`.
- [ ] StagePass Git setup/stage/commit/push/remote surfaces are absent.
- [ ] Worktree isolation, diff/hash, scope, adoption, Review/QA freshness, and Merge readiness are unchanged or stronger.
- [ ] Server/Desktop restart, detached task, two-Change concurrency, and targeted interrupt are proven.
- [ ] The TypeScript AST production AI caller inventory contains PRD, Context, pipeline engine, and all stage callers, with zero unclassified or rollback entries after cleanup.
- [ ] `pnpm test`, `pnpm test:acceptance`, `pnpm lint`, `pnpm build`, `pnpm mcp:build`, and `git diff --check` pass.
