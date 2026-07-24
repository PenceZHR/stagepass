import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import {
  changeProviderSessions,
  changes,
  codexThreadBindings,
  projects,
} from "../db/schema";
import type { CodexDesktopBridge } from "./codex-desktop-bridge";
import type { CodexPersistentShell } from "./codex-desktop-bridge-types";
import {
  ensureCodexThreadBinding,
  repairCodexThreadBinding,
} from "./codex-thread-binding-service";
import { resolveCanonicalChangeThread } from "./provider-session-service";

const PROJECT_ID = "PRJ-TASK3-BINDING";
const CHANGE_ID = "CHG-TASK3-BINDING";
const NOW = "2026-07-24T00:00:00.000Z";

function cleanup(): void {
  db.delete(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).run();
  db.delete(codexThreadBindings).where(eq(codexThreadBindings.projectId, PROJECT_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seed(): void {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Task 3 binding",
    repoPath: process.cwd(),
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Canonical shell",
    status: "INTAKE_READY",
    provider: "codex",
    codexThreadId: null,
    fixIterations: 0,
    blockedPhase: null,
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    gateState: null,
    docsComplete: 0,
    retroDone: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function seedExpiredAmbiguousBinding(): void {
  db.insert(codexThreadBindings).values({
    bindingId: "BIND-TASK3-AMBIGUOUS",
    scopeKind: "change",
    scopeId: CHANGE_ID,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    codexProjectId: null,
    threadId: null,
    title: `[${CHANGE_ID}] Canonical shell`,
    status: "provisioning",
    bridgeProtocolVersion: "test",
    provisionClaimToken: "old-claim",
    provisionLeaseOwner: "old-owner",
    provisionLeaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
    followerStartProvedAt: null,
    lastTurnId: null,
    lastObservationCursor: 0,
    lastSemanticSnapshotHash: null,
    lastSeenAt: NOW,
    lastErrorCode: "shell_provision_ambiguous",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function fakeBridge(delayMs = 0): {
  bridge: CodexDesktopBridge;
  shells: Map<string, CodexPersistentShell>;
  provisionCount: () => number;
  turnCalls: () => number;
} {
  const shells = new Map<string, CodexPersistentShell>();
  let provisions = 0;
  let turnCalls = 0;
  const bridge = {
    async provisionPersistentShell(input: { projectPath: string; title: string }) {
      provisions += 1;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const shell: CodexPersistentShell = {
        threadId: `task3-shell-${provisions}`,
        title: input.title,
        cwd: input.projectPath,
        ephemeral: false,
      };
      shells.set(shell.threadId, shell);
      return shell;
    },
    async findPersistentShells(input: { projectPath: string; title: string }) {
      return [...shells.values()].filter(
        (shell) => shell.cwd === input.projectPath && shell.title === input.title,
      );
    },
    async readPersistentShell(threadId: string) {
      return shells.get(threadId) ?? null;
    },
    async ensurePersistentShell() {
      throw new Error("shell-only adapter must be used");
    },
    async probe() {
      throw new Error("provision must not probe follower");
    },
    async startTurn() {
      turnCalls += 1;
      throw new Error("provision must not start a turn");
    },
    async recoverTurn() {
      throw new Error("not used");
    },
    async interruptTurn() {},
    async *pollTurn() {},
  } as unknown as CodexDesktopBridge;
  return {
    bridge,
    shells,
    provisionCount: () => provisions,
    turnCalls: () => turnCalls,
  };
}

describe("codex thread binding service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    seed();
  });
  afterEach(cleanup);

  it("atomically writes binding and both Change compatibility mirrors", async () => {
    const fake = fakeBridge();
    const binding = await ensureCodexThreadBinding({
      scope: {
        kind: "change",
        scopeId: CHANGE_ID,
        projectId: PROJECT_ID,
        changeId: CHANGE_ID,
      },
      bridge: fake.bridge,
    });
    assert.equal(binding.threadId, "task3-shell-1");
    assert.equal(
      db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.codexThreadId,
      binding.threadId,
    );
    assert.equal(resolveCanonicalChangeThread(CHANGE_ID), binding.threadId);
    assert.equal(fake.turnCalls(), 0);
  });

  it("claims before create so concurrent callers provision one shell", async () => {
    const fake = fakeBridge(30);
    const scope = {
      kind: "change" as const,
      scopeId: CHANGE_ID,
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
    };
    const [first, second] = await Promise.all([
      ensureCodexThreadBinding({ scope, bridge: fake.bridge }),
      ensureCodexThreadBinding({ scope, bridge: fake.bridge }),
    ]);
    assert.equal(first.threadId, second.threadId);
    assert.equal(fake.provisionCount(), 1);
  });

  it("adopts an identity-proved legacy shell without probing or starting", async () => {
    const fake = fakeBridge();
    const shell: CodexPersistentShell = {
      threadId: "legacy-persistent-shell",
      title: `[${CHANGE_ID}] Canonical shell`,
      cwd: process.cwd(),
      ephemeral: false,
    };
    fake.shells.set(shell.threadId, shell);
    db.insert(changeProviderSessions).values({
      changeId: CHANGE_ID,
      provider: "codex",
      sessionKind: "general",
      externalSessionId: shell.threadId,
      lastRunId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();

    const binding = await ensureCodexThreadBinding({
      scope: {
        kind: "change",
        scopeId: CHANGE_ID,
        projectId: PROJECT_ID,
        changeId: CHANGE_ID,
      },
      bridge: fake.bridge,
    });
    assert.equal(binding.threadId, shell.threadId);
    assert.equal(binding.followerStartProvedAt, null);
    assert.equal(fake.provisionCount(), 0);
    assert.equal(fake.turnCalls(), 0);
  });

  it("marks a proved-deleted finalized shell detached and never recreates it", async () => {
    const fake = fakeBridge();
    const scope = {
      kind: "change" as const,
      scopeId: CHANGE_ID,
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
    };
    const created = await ensureCodexThreadBinding({ scope, bridge: fake.bridge });
    fake.shells.delete(created.threadId!);
    await assert.rejects(repairCodexThreadBinding({ scope, bridge: fake.bridge }));
    assert.equal(
      db.select().from(codexThreadBindings)
        .where(eq(codexThreadBindings.bindingId, created.bindingId)).get()?.status,
      "detached",
    );
    await assert.rejects(ensureCodexThreadBinding({ scope, bridge: fake.bridge }));
    assert.equal(fake.provisionCount(), 1);
  });

  it("explicitly repairs an expired ambiguous provision from one identity match", async () => {
    seedExpiredAmbiguousBinding();
    const fake = fakeBridge();
    fake.shells.set("reconciled-shell", {
      threadId: "reconciled-shell",
      title: `[${CHANGE_ID}] Canonical shell`,
      cwd: process.cwd(),
      ephemeral: false,
    });
    const scope = {
      kind: "change" as const,
      scopeId: CHANGE_ID,
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
    };

    await assert.rejects(ensureCodexThreadBinding({ scope, bridge: fake.bridge }));
    const repaired = await repairCodexThreadBinding({ scope, bridge: fake.bridge });
    assert.equal(repaired.threadId, "reconciled-shell");
    assert.equal(repaired.status, "ready");
    assert.equal(fake.provisionCount(), 0);
  });

  for (const matchCount of [0, 2] as const) {
    it(`keeps an expired ambiguous provision ambiguous for ${matchCount} identity matches`, async () => {
      seedExpiredAmbiguousBinding();
      const fake = fakeBridge();
      for (let index = 0; index < matchCount; index += 1) {
        fake.shells.set(`ambiguous-shell-${index}`, {
          threadId: `ambiguous-shell-${index}`,
          title: `[${CHANGE_ID}] Canonical shell`,
          cwd: process.cwd(),
          ephemeral: false,
        });
      }
      const scope = {
        kind: "change" as const,
        scopeId: CHANGE_ID,
        projectId: PROJECT_ID,
        changeId: CHANGE_ID,
      };

      await assert.rejects(
        repairCodexThreadBinding({ scope, bridge: fake.bridge }),
        (error: unknown) =>
          (error as { code?: unknown }).code === "shell_provision_ambiguous",
      );
      const row = db.select().from(codexThreadBindings)
        .where(eq(codexThreadBindings.scopeId, CHANGE_ID)).get();
      assert.equal(row?.status, "provisioning");
      assert.equal(row?.lastErrorCode, "shell_provision_ambiguous");
      assert.equal(fake.provisionCount(), 0);
    });
  }

  it("binds three canonical scopes without project synthetic changes or sessions", async () => {
    const fake = fakeBridge();
    const results = await Promise.all([
      ensureCodexThreadBinding({
        scope: {
          kind: "change",
          scopeId: CHANGE_ID,
          projectId: PROJECT_ID,
          changeId: CHANGE_ID,
        },
        bridge: fake.bridge,
      }),
      ensureCodexThreadBinding({
        scope: { kind: "project_prd", scopeId: PROJECT_ID, projectId: PROJECT_ID },
        bridge: fake.bridge,
      }),
      ensureCodexThreadBinding({
        scope: { kind: "project_context", scopeId: PROJECT_ID, projectId: PROJECT_ID },
        bridge: fake.bridge,
      }),
    ]);
    assert.equal(new Set(results.map((binding) => binding.threadId)).size, 3);
    assert.equal(
      db.select().from(changes)
        .where(inArray(changes.id, [
          `${PROJECT_ID}-context-select`,
          `${PROJECT_ID}-context-generate`,
        ])).all().length,
      0,
    );
    assert.equal(
      db.select().from(changeProviderSessions)
        .where(eq(changeProviderSessions.changeId, CHANGE_ID)).all().length,
      1,
    );
  });
});
