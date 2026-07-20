import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { changes, events, projects } from "../db/schema";
import { selfHealStuckCheckingQa } from "./action-contract-self-heal-service";

function checkingChange(): typeof changes.$inferSelect {
  return {
    id: "CHG-ACTION-SELF-HEAL",
    projectId: "PRJ-ACTION-SELF-HEAL",
    title: "Action self heal",
    status: "CHECKING",
    provider: "claude",
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
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

const PROJECT_ID = "PRJ-ACTION-SELF-HEAL";
const CHANGE_ID = "CHG-ACTION-SELF-HEAL";

function cleanup(): void {
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedCheckingChange(): void {
  const change = checkingChange();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Action self heal",
    repoPath: process.cwd(),
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
  }).run();
  db.insert(changes).values(change).run();
}

describe("action-contract-self-heal-service", { concurrency: false }, () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("keeps CHECKING unchanged while the latest business run is genuinely running", () => {
    const change = checkingChange();
    const result = selfHealStuckCheckingQa({
      change,
      db,
      nowISO: () => "2026-07-10T00:01:00.000Z",
      latestLocalCheckRun: () => ({ id: "RUN-QA", status: "running", summary: null, endedAt: null }),
      latestQaRunRecord: () => null,
      qaRunHasFailureEvidence: () => false,
      failQaRun: (() => assert.fail("running QA must not be failed")) as never,
      recomputeQaGate: (() => assert.fail("running QA gate must not be recomputed")) as never,
      recomputeStageGate: (() => assert.fail("running stage gate must not be recomputed")) as never,
    });

    assert.equal(result, change);
  });

  it("moves CHECKING to CHECK_FAILED only after terminal failure evidence is present", () => {
    seedCheckingChange();
    const calls: string[] = [];
    const result = selfHealStuckCheckingQa({
      change: checkingChange(),
      db,
      nowISO: () => "2026-07-10T00:01:00.000Z",
      latestLocalCheckRun: () => ({
        id: "RUN-QA-FAILED",
        status: "failed",
        summary: "provider_process_orphaned",
        endedAt: "2026-07-10T00:00:59.000Z",
      }),
      latestQaRunRecord: () => null,
      qaRunHasFailureEvidence: () => false,
      failQaRun: (() => assert.fail("missing QA record must not be failed")) as never,
      recomputeQaGate: (() => assert.fail("missing QA record uses stage gate")) as never,
      recomputeStageGate: ((input: { status: string; requiredActions?: string[] }) => {
        calls.push(`gate:${input.status}:${input.requiredActions?.join(",")}`);
      }) as never,
    });

    assert.equal(result.status, "CHECK_FAILED");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "CHECK_FAILED");
    assert.deepEqual(calls, ["gate:failed:retry_qa"]);
  });
});
