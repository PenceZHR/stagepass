import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

import { db } from "../db/index.ts";
import { briefingQuestions, changes, projects } from "../db/schema.ts";
import {
  insertBriefingQuestionsWithDb,
  listBriefingQuestions,
} from "./briefing-question-store.ts";

const PROJECT_ID = "PRJ-BRIEFING-QUESTION-STORE";
const CHANGE_ID = "CHG-BRIEFING-QUESTION-STORE";

function cleanupRows() {
  db.delete(briefingQuestions).where(eq(briefingQuestions.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

/** Seeds a project + change and returns the change id. Mirrors the fixture
 * style at the top of prd-briefing-service.test.ts. */
function seedChange(): string {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Briefing Question Store",
    repoPath: "/tmp/briefing-question-store-fixture",
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
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Briefing question store change",
    status: "INTAKE_PENDING",
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
  }).run();
  return CHANGE_ID;
}

describe("briefing question store", { concurrency: false }, () => {
  before(() => {
    cleanupRows();
  });

  after(() => {
    cleanupRows();
  });

  it("returns only the requested phase's cards", () => {
    const changeId = seedChange();
    db.transaction((tx) => {
      insertBriefingQuestionsWithDb(tx, [
        {
          id: "BQ-prd-1", changeId, phase: "PRD", roundNo: 1,
          category: "goal", severity: "critical", question: "PRD 的问题",
          whyItMatters: "因为方向", suggestedDefault: null, status: "open",
          answer: null, source: "ai_blue",
        },
        {
          id: "BQ-spec-1", changeId, phase: "Spec", roundNo: 1,
          category: "scope", severity: "critical", question: "Spec 的问题",
          whyItMatters: "因为取舍", suggestedDefault: null, status: "open",
          answer: null, source: "ai_blue",
        },
      ]);
    });

    const prd = listBriefingQuestions(changeId, "PRD");
    const spec = listBriefingQuestions(changeId, "Spec");
    assert.deepEqual(prd.map((row) => row.id), ["BQ-prd-1"]);
    assert.deepEqual(spec.map((row) => row.id), ["BQ-spec-1"]);
  });

  it("is the only module that reads the briefing_questions table", () => {
    // The invariant this locks: a reader that forgets the phase filter puts
    // Spec cards in front of computePrdGate, which counts an open critical card
    // as a reason to refuse the PRD draft -- and welds that gate shut for good.
    // Discipline cannot hold this line across future edits; a test can.
    const roots = ["server", "app"];
    const allowed = new Set([
      path.join("server", "services", "briefing-question-store.ts"),
      path.join("server", "db", "schema.ts"),
    ]);
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".next") continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
        if (allowed.has(full)) continue;
        const source = fs.readFileSync(full, "utf-8");
        if (source.includes("from(briefingQuestions)")) offenders.push(full);
      }
    };

    for (const root of roots) walk(root);
    assert.deepEqual(
      offenders,
      [],
      `These modules select from briefing_questions directly. Use briefing-question-store.ts, `
        + `which forces every reader to name its phase: ${offenders.join(", ")}`,
    );
  });
});
