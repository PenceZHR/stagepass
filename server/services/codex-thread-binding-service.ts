import { randomUUID } from "node:crypto";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  changeProviderSessions,
  changes,
  codexThreadBindings,
  projects,
} from "../db/schema";
import type {
  CodexManagedScope,
  CodexPersistentShell,
} from "./codex-desktop-bridge-types";
import {
  CodexDesktopBridgeError,
  type CodexDesktopBridge,
} from "./codex-desktop-bridge";

const PROVISION_LEASE_MS = 30_000;
const WINNER_WAIT_MS = 5_000;
const BRIDGE_PROTOCOL_VERSION = "codex-hybrid/v1";

export type CodexThreadBinding = typeof codexThreadBindings.$inferSelect;

type ProvisionClaim = {
  binding: CodexThreadBinding;
  owner: boolean;
  reconcileOnly: boolean;
  claimToken: string | null;
  leaseOwner: string | null;
};

function nowISO(now = new Date()): string {
  return now.toISOString();
}

function scopePredicate(scope: CodexManagedScope) {
  return and(
    eq(codexThreadBindings.scopeKind, scope.kind),
    eq(codexThreadBindings.scopeId, scope.scopeId),
  );
}

function normalizedRepoPath(repoPath: string): string {
  return path.resolve(repoPath);
}

function scopeMetadata(scope: CodexManagedScope): {
  projectPath: string;
  title: string;
} {
  const project = db.select().from(projects)
    .where(eq(projects.id, scope.projectId)).get();
  if (!project) throw new Error(`Project not found: ${scope.projectId}`);

  if (scope.kind === "change") {
    const change = db.select().from(changes)
      .where(eq(changes.id, scope.changeId)).get();
    if (!change || change.projectId !== scope.projectId) {
      throw new Error(`Change not found in project: ${scope.changeId}`);
    }
    return {
      projectPath: normalizedRepoPath(project.repoPath),
      title: `[${change.id}] ${change.title}`,
    };
  }
  return {
    projectPath: normalizedRepoPath(project.repoPath),
    title: scope.kind === "project_prd"
      ? `[${project.id}] Project PRD`
      : `[${project.id}] Project Context`,
  };
}

function readByScope(scope: CodexManagedScope): CodexThreadBinding | null {
  return db.select().from(codexThreadBindings)
    .where(scopePredicate(scope)).get() ?? null;
}

function isLiveProvisionLease(
  row: CodexThreadBinding,
  now: Date,
): boolean {
  return row.status === "provisioning"
    && row.provisionLeaseExpiresAt !== null
    && Date.parse(row.provisionLeaseExpiresAt) > now.getTime();
}

export function claimProvisioning(
  scope: CodexManagedScope,
  owner: string,
  now = new Date(),
): ProvisionClaim {
  const { title } = scopeMetadata(scope);
  return db.transaction((tx) => {
    const existing = tx.select().from(codexThreadBindings)
      .where(scopePredicate(scope)).get();
    if (existing) {
      if (existing.status !== "provisioning") {
        return {
          binding: existing,
          owner: false,
          reconcileOnly: false,
          claimToken: null,
          leaseOwner: null,
        };
      }
      if (existing.lastErrorCode === "shell_provision_ambiguous") {
        return {
          binding: existing,
          owner: false,
          reconcileOnly: true,
          claimToken: null,
          leaseOwner: null,
        };
      }
      if (isLiveProvisionLease(existing, now)) {
        return {
          binding: existing,
          owner: false,
          reconcileOnly: false,
          claimToken: null,
          leaseOwner: null,
        };
      }

      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + PROVISION_LEASE_MS).toISOString();
      const updated = tx.update(codexThreadBindings).set({
        provisionClaimToken: claimToken,
        provisionLeaseOwner: owner,
        provisionLeaseExpiresAt: leaseExpiresAt,
        updatedAt: nowISO(now),
      }).where(and(
        scopePredicate(scope),
        eq(codexThreadBindings.status, "provisioning"),
        eq(codexThreadBindings.updatedAt, existing.updatedAt),
      )).run();
      const row = tx.select().from(codexThreadBindings)
        .where(scopePredicate(scope)).get()!;
      return {
        binding: row,
        owner: updated.changes === 1,
        reconcileOnly: true,
        claimToken: updated.changes === 1 ? claimToken : null,
        leaseOwner: updated.changes === 1 ? owner : null,
      };
    }

    const timestamp = nowISO(now);
    const claimToken = randomUUID();
    const bindingId = randomUUID();
    tx.insert(codexThreadBindings).values({
      bindingId,
      scopeKind: scope.kind,
      scopeId: scope.scopeId,
      projectId: scope.projectId,
      changeId: scope.kind === "change" ? scope.changeId : null,
      codexProjectId: null,
      threadId: null,
      title,
      status: "provisioning",
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      provisionClaimToken: claimToken,
      provisionLeaseOwner: owner,
      provisionLeaseExpiresAt: new Date(now.getTime() + PROVISION_LEASE_MS).toISOString(),
      followerStartProvedAt: null,
      lastTurnId: null,
      lastObservationCursor: 0,
      lastSemanticSnapshotHash: null,
      lastSeenAt: timestamp,
      lastErrorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    return {
      binding: tx.select().from(codexThreadBindings)
        .where(eq(codexThreadBindings.bindingId, bindingId)).get()!,
      owner: true,
      reconcileOnly: false,
      claimToken,
      leaseOwner: owner,
    };
  });
}

function shellMatches(
  shell: { threadId: string; title: string; cwd: string; ephemeral: false },
  expected: { projectPath: string; title: string },
): boolean {
  return shell.ephemeral === false
    && normalizedRepoPath(shell.cwd) === expected.projectPath
    && shell.title === expected.title
    && shell.threadId.trim().length > 0;
}

function mirrorChangeBinding(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scope: CodexManagedScope,
  threadId: string,
  timestamp: string,
): void {
  if (scope.kind !== "change") return;
  tx.update(changes).set({
    codexThreadId: threadId,
    updatedAt: timestamp,
  }).where(eq(changes.id, scope.changeId)).run();
  tx.insert(changeProviderSessions).values({
    changeId: scope.changeId,
    provider: "codex",
    sessionKind: "general",
    externalSessionId: threadId,
    lastRunId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoUpdate({
    target: [
      changeProviderSessions.changeId,
      changeProviderSessions.provider,
      changeProviderSessions.sessionKind,
    ],
    set: {
      externalSessionId: threadId,
      updatedAt: timestamp,
    },
  }).run();
}

function finalizeClaim(
  scope: CodexManagedScope,
  claim: ProvisionClaim,
  threadId: string,
): CodexThreadBinding {
  if (!claim.claimToken || !claim.leaseOwner) {
    throw new Error("binding provision claim is not owned");
  }
  const claimToken = claim.claimToken;
  const leaseOwner = claim.leaseOwner;
  const timestamp = nowISO();
  return db.transaction((tx) => {
    const before = tx.select().from(codexThreadBindings)
      .where(scopePredicate(scope)).get();
    if (!before) throw new Error("binding provision row disappeared");
    const updated = tx.update(codexThreadBindings).set({
      threadId,
      status: "ready",
      provisionClaimToken: null,
      provisionLeaseOwner: null,
      provisionLeaseExpiresAt: null,
      followerStartProvedAt:
        before.threadId === threadId ? before.followerStartProvedAt : null,
      lastSeenAt: timestamp,
      lastErrorCode: null,
      updatedAt: timestamp,
    }).where(and(
      scopePredicate(scope),
      eq(codexThreadBindings.status, "provisioning"),
      eq(codexThreadBindings.provisionClaimToken, claimToken),
      eq(codexThreadBindings.provisionLeaseOwner, leaseOwner),
    )).run();
    if (updated.changes !== 1) {
      throw new Error("binding provision finalize was fenced");
    }
    mirrorChangeBinding(tx, scope, threadId, timestamp);
    return tx.select().from(codexThreadBindings)
      .where(scopePredicate(scope)).get()!;
  });
}

function markAmbiguous(
  scope: CodexManagedScope,
  claim: ProvisionClaim,
): void {
  if (!claim.claimToken || !claim.leaseOwner) return;
  db.update(codexThreadBindings).set({
    lastErrorCode: "shell_provision_ambiguous",
    updatedAt: nowISO(),
  }).where(and(
    scopePredicate(scope),
    eq(codexThreadBindings.status, "provisioning"),
    eq(codexThreadBindings.provisionClaimToken, claim.claimToken),
    eq(codexThreadBindings.provisionLeaseOwner, claim.leaseOwner),
  )).run();
}

function claimAmbiguousReconciliation(
  scope: CodexManagedScope,
  owner: string,
  now = new Date(),
): ProvisionClaim {
  return db.transaction((tx) => {
    const existing = tx.select().from(codexThreadBindings)
      .where(scopePredicate(scope)).get();
    if (!existing) throw new Error("binding provision row disappeared");
    if (
      existing.status !== "provisioning"
      || existing.lastErrorCode !== "shell_provision_ambiguous"
      || !existing.provisionLeaseExpiresAt
      || Date.parse(existing.provisionLeaseExpiresAt) > now.getTime()
    ) {
      return {
        binding: existing,
        owner: false,
        reconcileOnly: true,
        claimToken: null,
        leaseOwner: null,
      };
    }
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + PROVISION_LEASE_MS).toISOString();
    const updated = tx.update(codexThreadBindings).set({
      provisionClaimToken: claimToken,
      provisionLeaseOwner: owner,
      provisionLeaseExpiresAt: leaseExpiresAt,
      updatedAt: nowISO(now),
    }).where(and(
      scopePredicate(scope),
      eq(codexThreadBindings.status, "provisioning"),
      eq(codexThreadBindings.lastErrorCode, "shell_provision_ambiguous"),
      eq(
        codexThreadBindings.provisionLeaseExpiresAt,
        existing.provisionLeaseExpiresAt,
      ),
      eq(codexThreadBindings.updatedAt, existing.updatedAt),
    )).run();
    return {
      binding: tx.select().from(codexThreadBindings)
        .where(scopePredicate(scope)).get()!,
      owner: updated.changes === 1,
      reconcileOnly: true,
      claimToken: updated.changes === 1 ? claimToken : null,
      leaseOwner: updated.changes === 1 ? owner : null,
    };
  });
}

async function uniqueIdentityMatch(
  bridge: CodexDesktopBridge,
  metadata: { projectPath: string; title: string },
): Promise<CodexPersistentShell | null> {
  if (!bridge.findPersistentShells) return null;
  const matches = (await bridge.findPersistentShells(metadata))
    .filter((shell) => shellMatches(shell, metadata));
  return matches.length === 1 ? matches[0] : null;
}

async function adoptLegacyShell(
  scope: CodexManagedScope,
  bridge: CodexDesktopBridge,
  metadata: { projectPath: string; title: string },
): Promise<string | null> {
  if (scope.kind !== "change" || !bridge.readPersistentShell) return null;
  const legacy = db.select().from(changeProviderSessions).where(and(
    eq(changeProviderSessions.changeId, scope.changeId),
    eq(changeProviderSessions.provider, "codex"),
    eq(changeProviderSessions.sessionKind, "general"),
  )).get()?.externalSessionId;
  if (!legacy) return null;
  const shell = await bridge.readPersistentShell(legacy);
  return shell && shellMatches(shell, metadata) ? shell.threadId : null;
}

async function waitForWinner(scope: CodexManagedScope): Promise<CodexThreadBinding> {
  const deadline = Date.now() + WINNER_WAIT_MS;
  while (Date.now() < deadline) {
    const row = readByScope(scope);
    if (row && row.status !== "provisioning") return row;
    if (row?.lastErrorCode === "shell_provision_ambiguous") {
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        "persistent shell provision result is ambiguous",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("binding_provision_in_progress");
}

export async function ensureCodexThreadBinding(input: {
  scope: CodexManagedScope;
  bridge: CodexDesktopBridge;
}): Promise<CodexThreadBinding> {
  const existing = readByScope(input.scope);
  if (existing?.status === "detached") {
    throw new CodexDesktopBridgeError(
      "desktop_thread_detached",
      "canonical persistent shell was deleted",
    );
  }
  if (existing?.threadId && existing.status !== "provisioning") {
    return repairCodexThreadBinding(input);
  }

  const owner = randomUUID();
  const claim = claimProvisioning(input.scope, owner);
  if (!claim.owner) {
    if (claim.reconcileOnly) {
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        "persistent shell provision requires explicit reconciliation",
      );
    }
    return waitForWinner(input.scope);
  }

  const metadata = scopeMetadata(input.scope);
  if (claim.reconcileOnly) {
    const match = await uniqueIdentityMatch(input.bridge, metadata);
    if (!match) {
      markAmbiguous(input.scope, claim);
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        "expired shell provision has no unique identity match",
      );
    }
    return finalizeClaim(input.scope, claim, match.threadId);
  }

  const legacyThreadId = await adoptLegacyShell(
    input.scope,
    input.bridge,
    metadata,
  );
  if (legacyThreadId) return finalizeClaim(input.scope, claim, legacyThreadId);

  try {
    if (!input.bridge.provisionPersistentShell) {
      throw new CodexDesktopBridgeError(
        "codex_hybrid_bridge_unsupported",
        "shell-only persistent provision adapter is unavailable",
      );
    }
    const shell = await input.bridge.provisionPersistentShell(metadata);
    if (!shellMatches(shell, metadata)) {
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        "created shell identity does not match the canonical scope",
      );
    }
    return finalizeClaim(input.scope, claim, shell.threadId);
  } catch (error) {
    markAmbiguous(input.scope, claim);
    throw error;
  }
}

export async function repairCodexThreadBinding(input: {
  scope: CodexManagedScope;
  bridge: CodexDesktopBridge;
}): Promise<CodexThreadBinding> {
  const row = readByScope(input.scope);
  if (!row) return ensureCodexThreadBinding(input);
  if (row.status === "detached") {
    throw new CodexDesktopBridgeError(
      "desktop_thread_detached",
      "canonical persistent shell was deleted",
    );
  }
  if (row.status === "provisioning") {
    const owner = randomUUID();
    const claim = row.lastErrorCode === "shell_provision_ambiguous"
      ? claimAmbiguousReconciliation(input.scope, owner)
      : claimProvisioning(input.scope, owner);
    if (!claim.owner) {
      if (row.lastErrorCode === "shell_provision_ambiguous") {
        throw new CodexDesktopBridgeError(
          "shell_provision_ambiguous",
          "ambiguous shell provision lease is still live",
        );
      }
      return waitForWinner(input.scope);
    }
    const metadata = scopeMetadata(input.scope);
    const match = await uniqueIdentityMatch(input.bridge, metadata);
    if (!match) {
      markAmbiguous(input.scope, claim);
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        "provisioning shell cannot be uniquely reconciled",
      );
    }
    return finalizeClaim(input.scope, claim, match.threadId);
  }
  if (!row.threadId) throw new Error("finalized binding has no thread id");
  if (!input.bridge.readPersistentShell) return row;

  const metadata = scopeMetadata(input.scope);
  const shell = await input.bridge.readPersistentShell(row.threadId);
  if (!shell) {
    db.update(codexThreadBindings).set({
      status: "detached",
      lastErrorCode: "desktop_thread_detached",
      updatedAt: nowISO(),
    }).where(eq(codexThreadBindings.bindingId, row.bindingId)).run();
    throw new CodexDesktopBridgeError(
      "desktop_thread_detached",
      "canonical persistent shell was deleted",
    );
  }
  if (!shellMatches(shell, metadata)) {
    throw new Error("canonical shell identity mismatch");
  }
  const timestamp = nowISO();
  return db.transaction((tx) => {
    tx.update(codexThreadBindings).set({
      title: metadata.title,
      status: "ready",
      lastSeenAt: timestamp,
      lastErrorCode: null,
      updatedAt: timestamp,
    }).where(eq(codexThreadBindings.bindingId, row.bindingId)).run();
    mirrorChangeBinding(tx, input.scope, row.threadId!, timestamp);
    return tx.select().from(codexThreadBindings)
      .where(eq(codexThreadBindings.bindingId, row.bindingId)).get()!;
  });
}

export function readCodexThreadBinding(
  scope: CodexManagedScope,
): CodexThreadBinding | null {
  return readByScope(scope);
}
