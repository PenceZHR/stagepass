import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changeProviderSessions,
  changes,
  projects,
  providerRunProcesses,
  runs,
} from "../db/schema";
import {
  recordProviderSession,
  resolveProviderSession,
} from "./provider-session-service";

const PROJECT_ID = "PRJ-PROVIDER-SESSION";
const CHANGE_ID = "CHG-PROVIDER-SESSION";
const NOW = "2026-07-13T00:00:00.000Z";

function clearFixture(): void {
  db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).run();
  db.delete(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function insertProviderRun(input: {
  id: string;
  provider: "codex" | "claude";
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

  it("does not treat an unproven legacy thread as a Codex session", () => {
    db.update(changes).set({ provider: "claude" }).where(eq(changes.id, CHANGE_ID)).run();
    insertProviderRun({
      id: "PRP-LEGACY-CLAUDE",
      provider: "claude",
      status: "completed",
      externalRef: "legacy-codex-thread",
    });
    insertProviderRun({
      id: "PRP-FAILED-CODEX-RESUME",
      provider: "codex",
      status: "failed",
      externalRef: "legacy-codex-thread",
    });

    assert.equal(resolveProviderSession({ changeId: CHANGE_ID, provider: "codex", sessionKind: "general" }), null);
    assert.equal(db.select().from(changeProviderSessions).all().length, 0);
  });

  it("backfills a legacy Codex session only with completed Codex lifecycle proof", () => {
    insertProviderRun({
      id: "PRP-LEGACY-CODEX",
      provider: "codex",
      status: "completed",
      externalRef: "legacy-codex-thread",
    });

    assert.equal(resolveProviderSession({ changeId: CHANGE_ID, provider: "codex", sessionKind: "general" }), "legacy-codex-thread");
    assert.equal(resolveProviderSession({ changeId: CHANGE_ID, provider: "claude", sessionKind: "general" }), null);
    assert.equal(db.select().from(changeProviderSessions).all().length, 1);
    assert.equal(db.select().from(changeProviderSessions).get()?.provider, "codex");
  });

  it("never resumes a session from another provider", () => {
    recordProviderSession({ changeId: CHANGE_ID, provider: "claude", sessionKind: "general", externalSessionId: "claude-session" });
    assert.equal(resolveProviderSession({ changeId: CHANGE_ID, provider: "claude", sessionKind: "general" }), "claude-session");
    assert.equal(resolveProviderSession({ changeId: CHANGE_ID, provider: "codex", sessionKind: "spec" }), null);
  });
});
