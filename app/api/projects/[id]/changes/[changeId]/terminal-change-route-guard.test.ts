import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db, sqlite } from "@/server/db";
import { changes, projects } from "@/server/db/schema";
import { POST as reworkPost } from "./rework/route.ts";
import { POST as specBattleDecisionPost } from "./spec-battle/decision/route.ts";

/**
 * Two routes that never asked the action contract anything.
 *
 * Both imported `actionPreflightErrorResponse` -- the error *handler* -- and
 * `assertRequestProviderNotApplicable`, which made them look guarded, while
 * neither ever called the gate. Measured against a copy of the shipped database
 * before the fix, with `/block` as the control (it does call
 * `assertRequestActionAllowed`):
 *
 *   POST /block                        -> 409 action_not_allowed / change_terminal
 *   POST /rework            (DONE)     -> 400 "FOREIGN KEY constraint failed"
 *   POST /spec-battle/decision (DONE)  -> 409 "round_not_ready"
 *
 * The last two are business-logic errors: both requests had already reached the
 * service. On /rework the only thing standing between a finished change and an
 * unauthorized rework was an unrelated FK bug (the deferred #10) -- so fixing
 * that bug without fixing this guard would have unmasked the hole rather than
 * closed it. That is what these tests exist to prevent.
 *
 * The refusal is read from `changeTerminalRefusal`, the same set
 * `decideAction` uses, so this cannot drift into a fourth private copy of "what
 * a finished change refuses".
 */

const PROJECT_ID = "PRJ-TERMINAL-GUARD";
const DONE_CHANGE = "CHG-TERMINAL-DONE";
const LIVE_CHANGE = "CHG-TERMINAL-LIVE";

function cleanupRows() {
  sqlite.pragma("foreign_keys = OFF");
  try {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      if (name === "changes") continue;
      const columns = sqlite.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
      if (!columns.some((column) => column.name === "change_id")) continue;
      sqlite.prepare(`DELETE FROM "${name}" WHERE change_id LIKE ?`).run("CHG-TERMINAL-%");
    }
    db.delete(changes).where(eq(changes.projectId, PROJECT_ID)).run();
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}

function seedChange(changeId: string, status: string) {
  const now = new Date().toISOString();
  db.insert(changes)
    .values({
      id: changeId,
      projectId: PROJECT_ID,
      title: `terminal guard ${status}`,
      status,
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
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function params(changeId: string) {
  return { params: Promise.resolve({ id: PROJECT_ID, changeId }) };
}

function post(body: unknown): Request {
  return new Request("http://localhost/irrelevant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("terminal-change route guards", { concurrency: false }, () => {
  beforeEach(() => {
    cleanupRows();
    const now = new Date().toISOString();
    db.insert(projects)
      .values({
        id: PROJECT_ID,
        name: "Terminal guard",
        repoPath: `/tmp/terminal-guard-${Date.now()}`,
        contextStatus: "ready",
        contextProvider: "codex",
        prdStatus: "ready",
        prdProvider: "codex",
        prdJson: null,
        prdMarkdown: null,
        gitEnabled: 0,
        gitDefaultBranch: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    seedChange(DONE_CHANGE, "DONE");
    seedChange(LIVE_CHANGE, "IMPLEMENTED");
  });

  afterEach(cleanupRows);

  it("refuses rework on a finished change instead of reaching the service", async () => {
    const res = await reworkPost(post({ phase: "Check" }), params(DONE_CHANGE));
    const body = (await res.json()) as { reasonCode?: string; error?: string };

    assert.equal(res.status, 409);
    assert.equal(body.reasonCode, "change_terminal");
    // The old failure was "FOREIGN KEY constraint failed" from inside
    // reworkChange -- proof the request had already been accepted.
    assert.doesNotMatch(body.error ?? "", /FOREIGN KEY/);
  });

  it("refuses a spec battle decision on a finished change", async () => {
    const res = await specBattleDecisionPost(
      post({ action: "return_to_spec", reason: "probe" }),
      params(DONE_CHANGE),
    );
    const body = (await res.json()) as { reasonCode?: string; error?: string };

    assert.equal(res.status, 409);
    assert.equal(body.reasonCode, "change_terminal");
    // Previously this reached applySpecBattleDecision and came back with the
    // service's own complaint about battle state.
    assert.doesNotMatch(body.error ?? "", /round_not_ready/);
  });

  it("puts waive_p1 through the real action contract, not just the terminal rule", async () => {
    const res = await specBattleDecisionPost(
      // The gate demands a full preflight snapshot, which this route previously
      // required not at all: omit these and it answers 422
      // invalid_preflight_input ("expectedGateVersion is required"). Deliberately
      // stale values, so what rejects the request is the change being finished
      // rather than a hash mismatch -- the terminal check runs first.
      post({
        action: "waive_p1",
        targetType: "requirement_gap",
        targetId: "GAP-x",
        reason: "probe",
        idempotencyKey: "terminal-guard-waive-probe",
        expectedGateVersion: "999999",
        expectedSourceDbHash: "deadbeef-not-a-real-hash",
      }),
      params(DONE_CHANGE),
    );
    const body = (await res.json()) as { error?: string; reasonCode?: string };

    assert.equal(res.status, 409);
    // The contract's own rejection shape, the same one /block answers with --
    // not the bare terminal refusal the other two decisions get.
    assert.equal(body.error, "action_not_allowed");
    assert.equal(body.reasonCode, "change_terminal");
  });

  it("does not refuse a change that is still live (the guard is not a blanket ban)", async () => {
    // Over-tightening would be just as wrong as the hole: rework exists to
    // rewind an unfinished change. This must fail for some *other* reason --
    // anything except the terminal refusal.
    const res = await reworkPost(post({ phase: "Check" }), params(LIVE_CHANGE));
    const body = (await res.json()) as { reasonCode?: string };

    assert.notEqual(body.reasonCode, "change_terminal");
  });
});
