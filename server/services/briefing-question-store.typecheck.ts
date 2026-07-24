import type { NewBriefingQuestion } from "./briefing-question-store";

/**
 * Compile-time pin: `NewBriefingQuestion.phase` must stay required.
 *
 * `phase` is declared `.notNull().default("PRD")` in server/db/schema.ts.
 * drizzle-orm's `$inferInsert` makes any column carrying `.default(...)`
 * optional regardless of `.notNull()`, so without the explicit re-narrowing in
 * briefing-question-store.ts, a caller could omit `phase` entirely,
 * type-check clean, and have the row silently land as `phase: 'PRD'` -- the
 * exact failure briefing-question-store.ts exists to make inexpressible for a
 * Spec-phase insert.
 *
 * This assertion lives in its own file instead of as a `@ts-expect-error`
 * inside briefing-question-store.test.ts because tsconfig.json's `exclude`
 * drops every file named `*.test.ts` from the `tsc --noEmit` project
 * (confirmed empirically: a deliberately-wrong `@ts-expect-error` placed in a
 * .test.ts file produced zero tsc diagnostics), and the isolated test runner
 * invokes `node --test` directly with no type-checking step -- so a directive
 * placed there would never be evaluated by anything. This file's name does
 * not match `*.test.ts`, so tsconfig's `include` picks it up like any other
 * production file: `npx tsc --noEmit` checks it as a root file whether or not
 * anything imports it, and fails the build if `phase` ever becomes optional
 * again.
 *
 * Not imported by anything, and not collected by
 * scripts/run-tests-isolated.ts (which only gathers files named *.test.ts or
 * *.test.tsx) -- this file exists only to be type-checked, never to run.
 * briefing-question-store.test.ts has a companion runtime smoke test
 * ("keeps the phase-required-on-insert regression pin in place") that fails
 * if this file disappears or loses its `@ts-expect-error`.
 */
// @ts-expect-error `phase` must be required -- if this line stops erroring, it has silently become optional again.
const phaseOmittedOnInsert: NewBriefingQuestion = {
  id: "BQ-typecheck-fixture",
  changeId: "CHG-typecheck-fixture",
  roundNo: 1,
  category: "goal",
  severity: "critical",
  question: "fixture row for the phase-required compile-time pin",
  whyItMatters: "fixture row for the phase-required compile-time pin",
  suggestedDefault: null,
  status: "open",
  answer: null,
  source: "ai_blue",
};

void phaseOmittedOnInsert;
