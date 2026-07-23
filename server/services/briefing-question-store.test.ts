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

  it("keeps the phase-required-on-insert regression pin in place", () => {
    // NewBriefingQuestion.phase must stay required: `phase` carries a
    // `.notNull().default("PRD")` column definition, and drizzle-orm's
    // `$inferInsert` makes any defaulted column optional regardless of
    // `.notNull()`. Without the explicit re-narrowing in
    // briefing-question-store.ts, a caller could omit `phase`, type-check
    // clean, and have the row land silently on `phase: 'PRD'` -- exactly the
    // failure this store exists to make inexpressible for a Spec-phase insert.
    //
    // This cannot be pinned as a runtime assertion here: TypeScript types are
    // erased at runtime, so no node:test assertion can observe whether `phase`
    // is optional. It also cannot be a `@ts-expect-error` comment in *this*
    // file: tsconfig.json's `exclude` drops every file named `*.test.ts` from
    // the `tsc --noEmit` project (confirmed empirically -- a
    // deliberately-wrong `@ts-expect-error` placed in a .test.ts file produced
    // zero tsc diagnostics), and the isolated test runner invokes `node --test`
    // directly with no type-checking step, so a directive placed here would
    // never be evaluated by anything.
    //
    // The actual pin lives in briefing-question-store.typecheck.ts, a
    // non-test .ts file for exactly that reason: its name doesn't match
    // `*.test.ts`, so tsconfig's `include` picks it up like any other
    // production file, and `npx tsc --noEmit` -- already part of this repo's
    // verification gate -- checks it as a root file whether or not anything
    // imports it, and fails the build if `phase` ever becomes optional again.
    // What we CAN check at runtime is that the pin itself hasn't quietly been
    // deleted or defanged (e.g. "fixed" by adding `phase` back to the fixture
    // row, which would make the `@ts-expect-error` directive unused and fail
    // `tsc --noEmit` for the opposite reason).
    const fixturePath = path.join("server", "services", "briefing-question-store.typecheck.ts");
    const source = fs.readFileSync(fixturePath, "utf-8");
    assert.match(source, /@ts-expect-error/, "the compile-time pin's directive must still be present");
    // Anchored to the start of a (trimmed) line so this only matches an actual
    // `phase: "PRD"` object-literal property -- not the doc comment above,
    // which discusses that exact string in prose.
    assert.doesNotMatch(
      source,
      /^\s*phase:\s*["'](PRD|Spec)["']/m,
      "the fixture row must still omit `phase` -- adding it back defeats the pin",
    );
  });

  it("is the only module that touches the briefing_questions table", () => {
    // The invariant this locks: a reader that forgets the phase filter puts
    // Spec cards in front of computePrdGate, which counts an open critical card
    // as a reason to refuse the PRD draft -- and welds that gate shut for good.
    // A raw insert/update/delete reaching the table directly is exactly as
    // dangerous as a raw select -- none of the four go through the phase
    // argument the accessor forces -- so this matches all four Drizzle verbs,
    // not just `.from(...)` reads. (A prior version of this test matched only
    // `from(briefingQuestions)`, which let a raw `db.insert(briefingQuestions)`
    // bypass the accessor silently.)
    // Discipline cannot hold this line across future edits; a test can.
    const roots = ["server", "app"];
    const allowed = new Set([
      path.join("server", "services", "briefing-question-store.ts"),
      path.join("server", "db", "schema.ts"),
    ]);
    const offenders: string[] = [];
    const tableAccess = /\b(from|insert|update|delete)\(briefingQuestions\)/;

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
        if (tableAccess.test(source)) offenders.push(full);
      }
    };

    for (const root of roots) walk(root);
    assert.deepEqual(
      offenders,
      [],
      `These modules touch briefing_questions directly (select/insert/update/delete). Use `
        + `briefing-question-store.ts, which forces every caller to name its phase: ${offenders.join(", ")}`,
    );
  });
});
