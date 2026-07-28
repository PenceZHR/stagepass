import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  STAGE_CLARIFICATION_ORDER,
  STAGE_CLARIFICATION_POLICIES,
} from "@/lib/stage-clarification-policy";
import { createCodexDesktopRunContext } from "./codex-desktop-run-context";

test("stage work tells Codex to use the StagePass checkbox card for requirement choices", () => {
  const context = createCodexDesktopRunContext({
    logicalTurnId: "logical-stage-1",
    role: "stage",
    phase: "spec",
    prompt: "Start the requested stage.",
    projectId: "PRJ-004",
    scopeKind: "change",
    scopeId: "CHG-006",
    threadId: "thread-visible-in-codex",
  });

  assert.match(context.prompt, /StagePass Card plugin/);
  assert.match(context.prompt, /present_stagepass_choices/);
  assert.match(context.prompt, /one to ten concrete requirement questions/i);
  assert.match(context.prompt, /not category names or PRD dimensions/i);
  assert.match(context.prompt, /each question.*A\/B\/C/i);
  assert.match(context.prompt, /STAGEPASS_SELECTION_CONFIRMED/);
  assert.match(context.prompt, /same Codex task/i);
  assert.match(context.prompt, /logicalTurnId=logical-stage-1/);
  assert.match(context.prompt, /projectId=PRJ-004/);
  assert.match(context.prompt, /changeId=CHG-006/);
  assert.match(context.prompt, /threadId=thread-visible-in-codex/);
});

test("card instruction requires iterative batches until no execution blocker remains", () => {
  const context = createCodexDesktopRunContext({
    logicalTurnId: "logical-stage-2",
    role: "stage",
    phase: "Spec",
    prompt: "Run the Spec stage.",
    projectId: "PRJ-004",
    scopeKind: "change",
    scopeId: "CHG-006",
    threadId: "thread-visible-in-codex",
  });

  assert.match(context.prompt, /summarize the answers/i);
  assert.match(context.prompt, /remaining execution-blocking questions/i);
  assert.match(context.prompt, /another batch/i);
  assert.match(context.prompt, /no blocking questions remain/i);
});

test("a line-protocol role is never told to ask via a card", () => {
  const context = createCodexDesktopRunContext({
    logicalTurnId: "logical-prd-1",
    role: "prd_turn",
    phase: "intake",
    prompt: "Create the PRD.",
    projectId: "PRJ-004",
    scopeKind: "change",
    scopeId: "CHG-006",
    threadId: "thread-visible-in-codex",
  });

  // This used to append the card instruction, and the PRD parser then rejected
  // every reply: told to ask via a card and required to emit TITLE / OVERVIEW /
  // TARGETUSERS / PRD_DONE, the model obeyed the instruction and wrote no
  // protocol at all. The prompt has to arrive exactly as the caller wrote it.
  assert.equal(context.prompt, "Create the PRD.");
  assert.doesNotMatch(context.prompt, /present_stagepass_choices/);
});

test("interaction wakeup does not append a second requirement-card instruction", () => {
  const context = createCodexDesktopRunContext({
    logicalTurnId: "logical-wakeup-1",
    role: "interaction_wakeup",
    phase: "Spec",
    prompt: "Continue after the saved decision.",
    projectId: "PRJ-004",
    scopeKind: "change",
    scopeId: "CHG-006",
    threadId: "thread-visible-in-codex",
  });

  assert.equal(context.prompt, "Continue after the saved decision.");
});

test("requirement-card instruction is idempotent for a logical turn", () => {
  const first = createCodexDesktopRunContext({
    logicalTurnId: "logical-spec-1",
    role: "spec_writer",
    phase: "spec",
    prompt: "Write the specification.",
    projectId: "PRJ-004",
    scopeKind: "change",
    scopeId: "CHG-006",
    threadId: "thread-visible-in-codex",
  }).prompt;
  const second = createCodexDesktopRunContext({
    logicalTurnId: "logical-spec-1",
    role: "spec_writer",
    phase: "spec",
    prompt: first,
    projectId: "PRJ-004",
    scopeKind: "change",
    scopeId: "CHG-006",
    threadId: "thread-visible-in-codex",
  }).prompt;

  assert.equal(
    second.match(/\[stagepass-choice-card:logical-spec-1:spec_writer\]/g)?.length,
    1,
  );
});

test("every canonical stage receives its own concrete clarification policy", () => {
  for (const stageId of STAGE_CLARIFICATION_ORDER) {
    const policy = STAGE_CLARIFICATION_POLICIES[stageId];
    const context = createCodexDesktopRunContext({
      logicalTurnId: `logical-${stageId}`,
      role: "stage",
      phase: policy.phaseAliases[0],
      prompt: `Run ${policy.label}.`,
      projectId: "PRJ-004",
      scopeKind: "change",
      scopeId: "CHG-006",
      threadId: "thread-visible-in-codex",
    });

    assert.match(
      context.prompt,
      new RegExp(`stageClarificationPolicy=${stageId}`),
    );
    assert.match(context.prompt, /one to ten concrete requirement questions/i);
    assert.match(
      context.prompt,
      /formal stage result only when no execution blocker remains/i,
    );
    assert.ok(
      context.prompt.includes(policy.exampleQuestions[0]),
      `${stageId} prompt needs a concrete stage example`,
    );
  }
});

test("production desktop bridge passes the persisted phase into run context", () => {
  const source = readFileSync(
    new URL("./codex-desktop-engine.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /createCodexDesktopRunContext\(\{[\s\S]*phase:\s*logical\.phase/,
  );
});
