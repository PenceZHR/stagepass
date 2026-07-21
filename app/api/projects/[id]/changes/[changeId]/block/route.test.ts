import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db, sqlite } from "@/server/db";
import { changes, projects, runs } from "@/server/db/schema";
import { getActions } from "@/server/services/action-contract-service";
import { RunPhase } from "@/server/types/enums";
import { POST } from "./route.ts";

/**
 * The route is driven for real -- real Request objects, real rows, real
 * preflight -- because the guarantee under test is only observable end to end:
 * that the phase a human blocks at is the phase actually written to
 * `changes.blocked_phase`.
 *
 * The regression: the accepted-phase list was hand-copied from RunPhase and had
 * drifted, omitting `delivery`. Blocking a stuck delivery run therefore 400'd,
 * and blocking it without an explicit phase fell through to graph-runner's
 * `phaseFromStatus` default and recorded `local_check` -- a phase the change was
 * never in. BLOCKED is one of only two exits from DELIVERY_PENDING (the other
 * is DONE; see state-machine/transitions.ts), so that record is the only
 * evidence left of where the change died.
 *
 * The list is now derived from RunPhase, and the round-trip below iterates
 * RunPhase.options rather than a copy of it, so a fourteenth phase gets a case
 * here for free instead of silently going untested.
 */

const PROJECT_ID = "PRJ-BLOCK-ROUTE-001";
const ID_PREFIX = "CHG-BLOCK-";

/**
 * The status each phase's run is in while it is running, read off the writers
 * (beginStageRun's `runningStatus` in the pipeline-*-stage-services, and
 * graph-runner's phaseFromStatus for the two that predate them). A blocked
 * change is one caught mid-run, so these are the pairings production can
 * actually produce -- not an arbitrary status that merely happens to be legal.
 */
const RUNNING_STATUS_FOR_PHASE: Record<RunPhase, string> = {
  refine: "REFINING",
  intake: "INTAKE_PENDING",
  spec: "SPECCING",
  tech_spec: "TECHSPECCING",
  generate_plan: "PLANNING",
  test_plan: "TESTPLANNING",
  implement: "IMPLEMENTING",
  review: "REVIEWING",
  local_check: "CHECKING",
  fix_findings: "FIXING",
  release: "MERGING",
  retro: "RETRO_PENDING",
  delivery: "DELIVERY_PENDING",
};

function cleanupRows() {
  // Sweep every table that carries a change_id rather than naming them, so a
  // new dependent table cannot leave rows behind and fail the next run. FKs are
  // off for the sweep because the dependents form a graph (events reference
  // runs as well as changes), and no single delete order satisfies all of them.
  sqlite.pragma("foreign_keys = OFF");
  try {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      if (name === "changes") continue;
      const columns = sqlite.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
      if (!columns.some((column) => column.name === "change_id")) continue;
      sqlite.prepare(`DELETE FROM "${name}" WHERE change_id LIKE ?`).run(`${ID_PREFIX}%`);
    }
    db.delete(changes).where(eq(changes.projectId, PROJECT_ID)).run();
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}

function seedProject() {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Block route",
      repoPath: `/tmp/block-route-${Date.now()}`,
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
}

/** A change caught mid-run: the status the phase runs under, plus its live run. */
function seedRunningChange(phase: string, status: string): string {
  const changeId = `${ID_PREFIX}${phase.toUpperCase()}`;
  const now = new Date().toISOString();
  db.insert(changes)
    .values({
      id: changeId,
      projectId: PROJECT_ID,
      title: `Blocked during ${phase}`,
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
  // blockChange stops the change's active runs, and the ledger refuses a stop
  // that matches no running row -- so a blockable change always has one.
  db.insert(runs)
    .values({
      id: `RUN-${changeId}`,
      changeId,
      phase,
      status: "running",
      startedAt: now,
      endedAt: null,
      summary: null,
      provider: "codex",
    })
    .run();
  return changeId;
}

/** Posts the way the UI does: echoing back the contract it was just issued. */
function post(changeId: string, body: Record<string, unknown>) {
  const action = getActions(changeId).find((candidate) => candidate.actionId === "stop_change");
  assert.ok(action, "stop_change should be offered for a running change");
  return POST(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/changes/${changeId}/block`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedGateVersion: action.gateVersion,
        expectedSourceDbHash: action.sourceDbHash,
        ...body,
      }),
    }),
    { params: Promise.resolve({ id: PROJECT_ID, changeId }) },
  );
}

const changeRow = (changeId: string) =>
  db.select().from(changes).where(eq(changes.id, changeId)).get();

beforeEach(() => {
  cleanupRows();
  seedProject();
});

afterEach(cleanupRows);

describe("block route", () => {
  it("blocks a stuck delivery run and records delivery as the blocked phase", async () => {
    const changeId = seedRunningChange("delivery", "DELIVERY_PENDING");

    const response = await post(changeId, { phase: "delivery", reason: "delivery run wedged" });
    assert.equal(response.status, 200, await response.text());

    const row = changeRow(changeId);
    assert.equal(row?.status, "BLOCKED");
    assert.equal(
      row?.blockedPhase,
      "delivery",
      "the phase the run was stuck in must survive to the ledger",
    );
    assert.notEqual(
      row?.blockedPhase,
      "local_check",
      "local_check is phaseFromStatus's default -- recording it here would be a phase the change was never in",
    );
  });

  it("round-trips every RunPhase into blocked_phase", async () => {
    for (const phase of RunPhase.options) {
      const changeId = seedRunningChange(phase, RUNNING_STATUS_FOR_PHASE[phase]);

      const response = await post(changeId, { phase, reason: `stuck in ${phase}` });
      assert.equal(response.status, 200, `${phase}: ${await response.text()}`);

      const row = changeRow(changeId);
      assert.equal(row?.status, "BLOCKED", `${phase} should end BLOCKED`);
      assert.equal(row?.blockedPhase, phase, `${phase} should be recorded verbatim`);
    }
  });

  it("rejects a phase that is not a run phase, leaving the change untouched", async () => {
    const changeId = seedRunningChange("delivery", "DELIVERY_PENDING");

    const response = await post(changeId, { phase: "deliverz", reason: "typo" });
    assert.equal(response.status, 400);

    const row = changeRow(changeId);
    assert.equal(row?.status, "DELIVERY_PENDING", "a rejected block must not move the change");
    assert.equal(row?.blockedPhase, null, "a rejected block must not record a phase");
  });
});
