import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const ROUTE_ROOT = path.join(
  process.cwd(),
  "app",
  "api",
  "projects",
  "[id]",
  "changes",
  "[changeId]",
  "prd-briefing"
);

function readRoute(...segments: string[]): string {
  const routePath = path.join(ROUTE_ROOT, ...segments, "route.ts");
  assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
  return fs.readFileSync(routePath, "utf-8");
}

function assertGuarded(content: string): void {
  assert.match(content, /const \{ id: projectId, changeId[^}]*\} = await params/);
  assert.match(content, /requireProjectChange\(projectId, changeId\)/);
  assert.match(content, /if \(guard\.response\) return guard\.response;/);
}

function assertBriefingErrorMapping(content: string): void {
  assert.match(content, /PrdBriefingError/);
  assert.match(content, /err instanceof PrdBriefingError/);
  assert.match(content, /status: 409/);
  assert.match(content, /status: 400/);
}

/**
 * The enqueue response contract. These routes used to start a background runner
 * and answer `started: true`; they now enqueue a job atomically and hand back the
 * job id, so the caller can follow it. Nothing asserted the response shape.
 */
function assertEnqueueAccepted(content: string): void {
  assert.match(content, /const \{ job \} = enqueueProviderActionAtomically\(\{/);
  assert.match(content, /idempotencyKey: resolveRequestIdempotencyKey\(payload, request\)/);
  assert.match(content, /accepted: true/);
  assert.match(content, /jobId: job\.id/);
  assert.match(content, /status: "queued"/);
  assert.match(content, /\{ status: 202 \}/);
}

describe("PRD briefing routes", () => {
  it("GET /prd-briefing returns briefing state and guards project/change ownership", () => {
    const content = readRoute();

    assert.match(content, /import \{[^}]*getPrdBriefingState[^}]*savePrdIntent[^}]*PrdBriefingError[^}]*\}/s);
    assert.match(content, /export async function GET/);
    assertGuarded(content);
    assert.match(content, /getPrdBriefingState\(changeId\)/);
    assertBriefingErrorMapping(content);
  });

  it("POST /prd-briefing saves raw intent text", () => {
    const content = readRoute();

    assert.match(content, /export async function POST/);
    assert.match(content, /await request\.json\(\)/);
    assert.match(content, /rawText/);
    assert.match(content, /savePrdIntent\(\{\s*changeId,\s*rawText/s);
    assertGuarded(content);
    assertBriefingErrorMapping(content);
  });

  it("POST /prd-briefing/questions validates then enqueues question generation", () => {
    const content = readRoute("questions");

    assert.match(content, /enqueueProviderActionAtomically/);
    assert.match(content, /assertCanStartPrdBriefingQuestions/);
    assert.match(content, /export async function POST/);
    assertGuarded(content);
    assert.match(content, /assertCanStartPrdBriefingQuestions\(changeId\)/);
    assert.match(content, /phase: "prd_briefing_questions"/);
    assertEnqueueAccepted(content);
    assertBriefingErrorMapping(content);
  });

  it("PATCH /prd-briefing/questions/[questionId] applies a human question action", () => {
    const content = readRoute("questions", "[questionId]");

    assert.match(content, /applyBriefingQuestionAction/);
    assert.match(content, /export async function PATCH/);
    assert.match(content, /questionId/);
    assert.match(content, /await request\.json\(\)/);
    assert.match(content, /action/);
    assert.match(content, /value/);
    assert.match(content, /applyBriefingQuestionAction\(\{\s*changeId,\s*questionId,\s*action/s);
    assertGuarded(content);
    assertBriefingErrorMapping(content);
  });

  it("POST /prd-briefing/draft validates then enqueues draft generation", () => {
    const content = readRoute("draft");

    assert.match(content, /enqueueProviderActionAtomically/);
    assert.match(content, /assertCanStartPrdBriefingDraft/);
    assert.match(content, /export async function POST/);
    assertGuarded(content);
    assert.match(content, /assertCanStartPrdBriefingDraft\(changeId\)/);
    assert.match(content, /phase: "prd_briefing_draft"/);
    assertEnqueueAccepted(content);
    assertBriefingErrorMapping(content);
  });

  it("POST /prd-briefing/final-review validates then enqueues final review", () => {
    const content = readRoute("final-review");

    assert.match(content, /enqueueProviderActionAtomically/);
    assert.match(content, /assertCanStartPrdBriefingFinalReview/);
    assert.match(content, /export async function POST/);
    assertGuarded(content);
    assert.match(content, /assertCanStartPrdBriefingFinalReview\(changeId\)/);
    assert.match(content, /phase: "prd_briefing_final_review"/);
    assertEnqueueAccepted(content);
    assertBriefingErrorMapping(content);
  });

  it("POST /prd-briefing/lock locks the PRD briefing", () => {
    const content = readRoute("lock");

    assert.match(content, /lockPrdBriefing/);
    assert.match(content, /export async function POST/);
    assertGuarded(content);
    assert.match(content, /lockPrdBriefing\(\{\s*changeId\s*\}\)/);
    assertBriefingErrorMapping(content);
  });
});
