import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  prdBriefings,
  prdDrafts,
  projects,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
} from "../db/schema";
import { writeClarifiedPrdBaseline } from "./clarified-prd-baseline-service";
import { getStageAuthority } from "./stage-authority-service";

const PROJECT_ID = "PRJ-CLARIFIED-BASELINE";
const CHANGE_ID = "CHG-CLARIFIED-BASELINE";
const NOW = "2026-07-27T00:00:00.000Z";
const DOCUMENT = "# CHG 变更请求\n\n## 变更目标\n\n限时海底宝藏关卡。";

function cleanup(): void {
  // stage_reports references stage_runs, and stage_states references the
  // change, so both go before the rows they point at.
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

describe("clarified PRD baseline", () => {
  beforeEach(() => {
    cleanup();
    db.insert(projects).values({
      id: PROJECT_ID, name: "P", repoPath: process.cwd(),
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: CHANGE_ID, projectId: PROJECT_ID, title: "C",
      status: "INTAKE_READY", createdAt: NOW, updatedAt: NOW,
    }).run();
  });

  afterEach(cleanup);

  // Downstream stages read the PRD from these tables, not from the artifact
  // file. A PRD settled through Codex cards has to land in the same shape or
  // every later stage refuses to start on a missing baseline.
  it("records the converged document as a locked PRD baseline", () => {
    writeClarifiedPrdBaseline({ changeId: CHANGE_ID, document: DOCUMENT });

    const briefing = db.select().from(prdBriefings)
      .where(eq(prdBriefings.changeId, CHANGE_ID)).get();
    const draft = db.select().from(prdDrafts)
      .where(eq(prdDrafts.changeId, CHANGE_ID)).get();

    assert.equal(briefing?.status, "locked");
    assert.ok(briefing?.lockedAt);
    assert.equal(draft?.markdown, DOCUMENT);
  });

  // The Spec stage refuses to run when the PRD gate hash disagrees with the
  // baseline tables, so the gate has to be computed from them rather than from
  // a second hash of its own.
  it("leaves the PRD gate agreeing with the baseline it just wrote", () => {
    const { sourceDbHash } = writeClarifiedPrdBaseline({
      changeId: CHANGE_ID,
      document: DOCUMENT,
    });

    const gate = getStageAuthority(CHANGE_ID, "PRD").latestGate;
    assert.ok(gate, "PRD gate missing");
    assert.equal(gate!.status, "pass");
    // Spec recomputes this hash from the baseline tables and refuses to run if
    // the gate disagrees, so the two must be produced by the same rule.
    assert.equal(gate!.sourceDbHash, sourceDbHash);
  });

  it("keeps one baseline when a stage is adopted twice", () => {
    writeClarifiedPrdBaseline({ changeId: CHANGE_ID, document: DOCUMENT });
    writeClarifiedPrdBaseline({ changeId: CHANGE_ID, document: DOCUMENT });

    assert.equal(
      db.select().from(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).all().length,
      1,
    );
    assert.equal(
      db.select().from(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).all().length,
      1,
    );
  });

  it("records a new draft version when the stage is re-run with a new document", () => {
    writeClarifiedPrdBaseline({ changeId: CHANGE_ID, document: DOCUMENT });
    writeClarifiedPrdBaseline({ changeId: CHANGE_ID, document: `${DOCUMENT}\n\n## 补充` });

    const drafts = db.select().from(prdDrafts)
      .where(eq(prdDrafts.changeId, CHANGE_ID)).all();
    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts.map((draft) => draft.version).sort(), [1, 2]);
  });
});
