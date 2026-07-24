import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changeProviderSessions,
  changes,
  codexThreadBindings,
  projects,
  providerRunProcesses,
  runs,
} from "../db/schema";
import {
  recordProviderSession,
  resolveCanonicalChangeThread,
  resolveProviderSession,
} from "./provider-session-service";

const PROJECT_ID = "PRJ-PROVIDER-SESSION";
const CHANGE_ID = "CHG-PROVIDER-SESSION";
const NOW = "2026-07-13T00:00:00.000Z";

function clearFixture(): void {
  db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).run();
  db.delete(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).run();
  db.delete(codexThreadBindings).where(eq(codexThreadBindings.scopeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function insertProviderRun(input: {
  id: string;
  provider: "codex";
  status: "completed" | "failed";
  externalRef: string;
}): void {
  const runId = `RUN-${input.id}`;
  db.insert(runs).values({
    id: runId,
    changeId: CHANGE_ID,
    phase: "fix_findings",
    status: input.status,
    startedAt: NOW,
    endedAt: NOW,
    provider: input.provider,
  }).run();
  db.insert(providerRunProcesses).values({
    id: input.id,
    changeId: CHANGE_ID,
    runId,
    phase: "fix_findings",
    provider: input.provider,
    ppid: process.pid,
    status: input.status,
    externalRef: input.externalRef,
    startedAt: NOW,
    endedAt: NOW,
  }).run();
}

describe("provider session service", () => {
  beforeEach(() => {
    clearFixture();
    db.insert(projects).values({
      id: PROJECT_ID, name: "Provider sessions", repoPath: process.cwd(),
      contextStatus: "ready", contextProvider: "codex", prdStatus: "ready", prdProvider: "codex",
      prdJson: null, prdMarkdown: null, gitEnabled: 0, gitDefaultBranch: null,
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: CHANGE_ID, projectId: PROJECT_ID, title: "Session isolation", status: "INTAKE_PENDING",
      provider: "codex", codexThreadId: "legacy-codex-thread", fixIterations: 0,
      blockedPhase: null, reworkFromPhase: null, suspendedByPrd: 0, preSuspendStatus: null,
      gitBranch: null, gateState: null, docsComplete: 0, retroDone: 0, createdAt: NOW, updatedAt: NOW,
    }).run();
  });

  afterEach(() => {
    clearFixture();
  });

  it("does not backfill a session without completed Codex lifecycle proof", () => {
    insertProviderRun({
      id: "PRP-FAILED-CODEX-RESUME",
      provider: "codex",
      status: "failed",
      externalRef: "legacy-codex-thread",
    });

    assert.equal(resolveProviderSession({ changeId: CHANGE_ID, provider: "codex", sessionKind: "general" }), null);
    assert.equal(db.select().from(changeProviderSessions).all().length, 0);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.provider, "codex");
  });

  it("backfills a legacy Codex session only with completed Codex lifecycle proof", () => {
    insertProviderRun({
      id: "PRP-LEGACY-CODEX",
      provider: "codex",
      status: "completed",
      externalRef: "legacy-codex-thread",
    });

    assert.equal(resolveProviderSession({ changeId: CHANGE_ID, provider: "codex", sessionKind: "general" }), "legacy-codex-thread");
    assert.equal(db.select().from(changeProviderSessions).all().length, 1);
    assert.equal(db.select().from(changeProviderSessions).get()?.provider, "codex");
  });

  it("never resumes a session from another session kind", () => {
    recordProviderSession({ changeId: CHANGE_ID, provider: "codex", sessionKind: "general", externalSessionId: "codex-session" });
    assert.equal(resolveProviderSession({ changeId: CHANGE_ID, provider: "codex", sessionKind: "general" }), "codex-session");
    assert.equal(resolveProviderSession({ changeId: CHANGE_ID, provider: "codex", sessionKind: "spec" }), null);
  });

  it("repairs divergent compatibility mirrors from the authoritative binding", () => {
    db.insert(codexThreadBindings).values({
      bindingId: "BIND-PROVIDER-SESSION",
      scopeKind: "change",
      scopeId: CHANGE_ID,
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      codexProjectId: null,
      threadId: "canonical-binding-thread",
      title: `[${CHANGE_ID}] Session isolation`,
      status: "ready",
      bridgeProtocolVersion: "test",
      provisionClaimToken: null,
      provisionLeaseOwner: null,
      provisionLeaseExpiresAt: null,
      followerStartProvedAt: null,
      lastTurnId: null,
      lastObservationCursor: 0,
      lastSemanticSnapshotHash: null,
      lastSeenAt: NOW,
      lastErrorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    recordProviderSession({
      changeId: CHANGE_ID,
      provider: "codex",
      sessionKind: "general",
      externalSessionId: "divergent-legacy-thread",
    });

    assert.equal(resolveCanonicalChangeThread(CHANGE_ID), "canonical-binding-thread");
    assert.equal(
      resolveProviderSession({
        changeId: CHANGE_ID,
        provider: "codex",
        sessionKind: "general",
      }),
      "canonical-binding-thread",
    );
    assert.equal(
      db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.codexThreadId,
      "canonical-binding-thread",
    );
  });
});
