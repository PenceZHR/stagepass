import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";

import { db } from "@/server/db";
import { changes, projects, rubricAssessments, rubricCriteria, rubrics } from "@/server/db/schema";
import type { RubricPanelState } from "@/app/projects/[id]/changes/[changeId]/rubric-types";
import { GET, PUT } from "./route.ts";

/**
 * The route is exercised for real -- actual Request objects, actual rows -- not
 * grepped. Two of its guarantees are only observable end to end: that a save
 * round-trips `criterionKey` (so a reworded criterion keeps the identity batch
 * 5 will hang a gap on), and that `scope` decides project-vs-change explicitly
 * rather than being inferred from whatever the drawer happened to be showing.
 */

const PROJECT_ID = "PRJ-RUBRIC-ROUTE-001";
const CHANGE_ID = "CHG-RUBRIC-ROUTE-001";
const OTHER_CHANGE_ID = "CHG-RUBRIC-ROUTE-002";

const params = (changeId = CHANGE_ID) => Promise.resolve({ id: PROJECT_ID, changeId });

function cleanupRows() {
  const rubricIds = db
    .select({ id: rubrics.id })
    .from(rubrics)
    .where(like(rubrics.projectId, "PRJ-RUBRIC-ROUTE-%"))
    .all()
    .map((row) => row.id);
  for (const rubricId of rubricIds) {
    db.delete(rubricAssessments).where(eq(rubricAssessments.rubricId, rubricId)).run();
    db.delete(rubricCriteria).where(eq(rubricCriteria.rubricId, rubricId)).run();
  }
  db.delete(rubrics).where(like(rubrics.projectId, "PRJ-RUBRIC-ROUTE-%")).run();
  db.delete(changes).where(like(changes.id, "CHG-RUBRIC-ROUTE-%")).run();
  db.delete(projects).where(like(projects.id, "PRJ-RUBRIC-ROUTE-%")).run();
}

function seed() {
  const now = new Date().toISOString();
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Rubric route",
      repoPath: `/tmp/rubric-route-${Date.now()}`,
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
  for (const id of [CHANGE_ID, OTHER_CHANGE_ID]) {
    db.insert(changes)
      .values({
        id,
        projectId: PROJECT_ID,
        title: "Rubric route change",
        status: "SPEC_READY",
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
}

function get(phase: string, changeId = CHANGE_ID) {
  return GET(
    new Request(
      `http://localhost/api/projects/${PROJECT_ID}/changes/${changeId}/rubrics?phase=${phase}`,
    ),
    { params: params(changeId) },
  );
}

function put(body: unknown, changeId = CHANGE_ID) {
  return PUT(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/changes/${changeId}/rubrics`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: params(changeId) },
  );
}

beforeEach(() => {
  cleanupRows();
  seed();
});

afterEach(cleanupRows);

describe("rubrics route", () => {
  it("returns three role panels, with critic marked inapplicable where §3 gives none", async () => {
    const spec = (await (await get("Spec")).json()) as RubricPanelState;
    assert.deepEqual(spec.roles.map((role) => role.role), ["producer", "critic", "verdict"]);
    assert.equal(spec.roles.find((role) => role.role === "critic")!.applicable, true);

    const plan = (await (await get("Plan")).json()) as RubricPanelState;
    assert.equal(plan.roles.find((role) => role.role === "critic")!.applicable, false);
  });

  it("rejects a phase that is not a rubric phase", async () => {
    const response = await get("Review");
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /Unknown rubric phase/);
  });

  it("saves a project-level rubric and reads it back as the one in force", async () => {
    const saved = await put({
      phase: "Spec",
      role: "producer",
      scope: "project",
      criteria: [
        { text: "Every requirement has an acceptance criterion" },
        { text: "Wording is consistent", blocking: false },
      ],
    });
    assert.equal(saved.status, 200);

    const state = (await (await get("Spec")).json()) as RubricPanelState;
    const producer = state.roles.find((role) => role.role === "producer")!;
    assert.equal(producer.source, "project");
    assert.equal(producer.version, 1);
    assert.deepEqual(
      producer.criteria.map((criterion) => [criterion.text, criterion.blocking]),
      [
        ["Every requirement has an acceptance criterion", true],
        ["Wording is consistent", false],
      ],
      "blocking defaults to true and an explicit false survives the round trip",
    );

    // The project default applies to a change that has never been touched.
    const other = (await (await get("Spec", OTHER_CHANGE_ID)).json()) as RubricPanelState;
    assert.equal(other.roles.find((role) => role.role === "producer")!.source, "project");
  });

  it("writes a change-level override only when scope says so", async () => {
    await put({
      phase: "Spec",
      role: "producer",
      scope: "project",
      criteria: [{ text: "Project default" }],
    });
    await put({
      phase: "Spec",
      role: "producer",
      scope: "change",
      criteria: [{ text: "Change override" }],
    });

    const mine = (await (await get("Spec")).json()) as RubricPanelState;
    const minePanel = mine.roles.find((role) => role.role === "producer")!;
    assert.equal(minePanel.source, "change");
    assert.equal(minePanel.criteria[0]!.text, "Change override");

    const other = (await (await get("Spec", OTHER_CHANGE_ID)).json()) as RubricPanelState;
    assert.equal(
      other.roles.find((role) => role.role === "producer")!.criteria[0]!.text,
      "Project default",
      "one change's override must not leak into another change",
    );
  });

  it("round-trips criterionKey so a rewording keeps the criterion's identity", async () => {
    await put({
      phase: "Spec",
      role: "producer",
      scope: "project",
      criteria: [{ text: "Evrey requirement has an acceptance criterion" }],
    });
    const before = (await (await get("Spec")).json()) as RubricPanelState;
    const key = before.roles.find((role) => role.role === "producer")!.criteria[0]!.criterionKey;

    // Exactly what the drawer sends: the key it read, with edited text.
    await put({
      phase: "Spec",
      role: "producer",
      scope: "project",
      criteria: [{ criterionKey: key, text: "Every requirement has an acceptance criterion" }],
    });

    const after = (await (await get("Spec")).json()) as RubricPanelState;
    const panel = after.roles.find((role) => role.role === "producer")!;
    assert.equal(panel.version, 2);
    assert.equal(panel.criteria[0]!.text, "Every requirement has an acceptance criterion");
    assert.equal(
      panel.criteria[0]!.criterionKey,
      key,
      "an edit that loses the key here is how a rubric-derived P0 becomes unresolvable",
    );
  });

  it("accepts an empty rubric as 'this phase does no rubric judging'", async () => {
    await put({ phase: "Spec", role: "producer", scope: "project", criteria: [{ text: "Alpha" }] });
    const cleared = await put({
      phase: "Spec",
      role: "producer",
      scope: "project",
      criteria: [],
    });
    assert.equal(cleared.status, 200);

    const state = (await (await get("Spec")).json()) as RubricPanelState;
    const panel = state.roles.find((role) => role.role === "producer")!;
    assert.deepEqual(panel.criteria, []);
    assert.equal(panel.version, 2, "clearing appends a version rather than deleting history");
  });

  it("rejects malformed payloads instead of storing something approximate", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ phase: "Nope", role: "producer", scope: "project", criteria: [] }, /Unknown rubric phase/],
      [{ phase: "Spec", role: "nope", scope: "project", criteria: [] }, /Unknown rubric role/],
      [{ phase: "Spec", role: "producer", scope: "global", criteria: [] }, /scope must be/],
      [{ phase: "Spec", role: "producer", scope: "project" }, /criteria array required/],
      [
        { phase: "Spec", role: "producer", scope: "project", criteria: [{ text: "  " }] },
        /non-empty string/,
      ],
      [
        { phase: "Spec", role: "producer", scope: "project", criteria: [{ text: "ok", blocking: "yes" }] },
        /blocking must be a boolean/,
      ],
    ];
    for (const [body, expected] of cases) {
      const response = await put(body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.match(((await response.json()) as { error: string }).error, expected);
    }
    assert.deepEqual(
      db.select().from(rubrics).where(eq(rubrics.projectId, PROJECT_ID)).all(),
      [],
      "a rejected payload must write nothing at all",
    );
  });

  it("404s for a change that does not belong to this project", async () => {
    assert.equal((await get("Spec", "CHG-RUBRIC-ROUTE-missing")).status, 404);
    assert.equal(
      (await put(
        { phase: "Spec", role: "producer", scope: "project", criteria: [] },
        "CHG-RUBRIC-ROUTE-missing",
      )).status,
      404,
    );
  });
});
