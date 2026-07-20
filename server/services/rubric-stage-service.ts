import { createHash } from "node:crypto";

import { emitIdempotentEvent } from "./event-service";
import type { RubricPhase, RubricRole } from "./rubric-assessment";
import { stripRubricLines } from "./rubric-line-protocol";
import { renderRubricPromptSection } from "./rubric-prompt";
import {
  getEffectiveRubric,
  recordRubricAssessments,
  recordUnansweredRubric,
  type RubricVersionRecord,
} from "./rubric-service";

/**
 * The seam between "a rubric exists in the database" and "a pipeline stage asks
 * a model to answer it".
 *
 * Everything phase-specific stays out: a caller says which project, change,
 * phase and role, gets back a prompt section to append and a harvester to run
 * over the reply. Wiring another phase (batch 6) is those two calls and nothing
 * else -- which is the point of having built the mechanism phase-agnostically in
 * batch 2.
 *
 * ## Absent and empty rubrics are legal and mean "off"
 *
 * `resolveStageRubric` returns null when no rubric is configured for the scope,
 * and a binding with `promptSection: null` when one exists but has no criteria
 * (§4.5). Both make the stage behave exactly as it did before rubrics existed:
 * no prompt text, no parsing, no rows. Since nothing ships default criteria yet,
 * this is the state every existing project is in.
 */

export interface StageRubricScope {
  projectId: string;
  changeId: string;
  phase: RubricPhase;
  role: RubricRole;
}

export interface StageRubric {
  rubric: RubricVersionRecord;
  /** Which scope won: the change's own override, or the project default. */
  source: "change" | "project";
  /** null when the rubric has no criteria -- nothing to ask, nothing to judge. */
  promptSection: string | null;
}

/**
 * Thrown when a reply's RUBRIC lines are malformed: an unknown criterion id, an
 * unknown verdict, a duplicate, missing evidence. §4.2 voids the whole output
 * for these rather than recording them, because they are not judgments -- they
 * are a reply to a checklist other than the one the model was given, so nothing
 * in it is attributable. Callers turn this into a retryable stage failure.
 */
export class RubricOutputVoidError extends Error {
  readonly rubricId: string;
  constructor(rubricId: string, message: string) {
    super(message);
    this.name = "RubricOutputVoidError";
    this.rubricId = rubricId;
  }
}

/**
 * Resolves the rubric in force for one stage role and records, on the round,
 * which version that was.
 *
 * The version is pinned to an EVENT rather than to a column on `battle_rounds`.
 * That is not a stylistic choice: `battle_rounds` rows are hashed verbatim into
 * the Spec stage's `sourceDbHash` (spec-battle-service.specSourceDbHash), so a
 * new column there would move the hash of every already-stamped round -- the
 * exact `204f3f5` failure §4.4 was written about, where adding a column to
 * `briefing_questions` invalidated every stamped PRD gate. `events` is in no
 * stage's hash inputs, so an event carries the same record at zero blast radius.
 */
export function resolveStageRubric(scope: StageRubricScope, pin?: {
  runId: string;
  roundId?: string | null;
}): StageRubric | null {
  const effective = getEffectiveRubric({
    projectId: scope.projectId,
    changeId: scope.changeId,
    phase: scope.phase,
    role: scope.role,
  });
  if (!effective) return null;

  const stageRubric: StageRubric = {
    rubric: effective.rubric,
    source: effective.source,
    promptSection: renderRubricPromptSection(effective.rubric),
  };
  if (pin) pinStageRubricVersion(scope, stageRubric, pin);
  return stageRubric;
}

function pinStageRubricVersion(
  scope: StageRubricScope,
  stageRubric: StageRubric,
  pin: { runId: string; roundId?: string | null },
): void {
  const roundId = pin.roundId ?? null;
  const eventId = `EVT-rubric-pin-${createHash("sha256")
    .update([pin.runId, roundId ?? "", stageRubric.rubric.id].join("\0"))
    .digest("hex")}`;
  try {
    emitIdempotentEvent({
      id: eventId,
      changeId: scope.changeId,
      runId: pin.runId,
      type: "rubric_version_pinned",
      message: `${scope.phase} ${scope.role} rubric v${stageRubric.rubric.version} in force`,
      rawJson: {
        rubricVersionPin: {
          schemaVersion: "rubric_version_pin/v1",
          rubricId: stageRubric.rubric.id,
          version: stageRubric.rubric.version,
          phase: scope.phase,
          role: scope.role,
          source: stageRubric.source,
          roundId,
          criterionCount: stageRubric.rubric.criteria.length,
        },
      },
    });
  } catch {
    // Diagnostic only. rubric_assessments.rubric_id is the authoritative record
    // of which version produced a verdict; losing the event must never cost a
    // round.
  }
}

export interface HarvestStageRubricInput {
  stageRubric: StageRubric;
  changeId: string;
  runId: string;
  roundId?: string | null;
  /** The model's raw reply. */
  rawText: string;
  /** Block names the HOST stage legitimately emits. */
  expectedBlockNames?: readonly string[];
}

/**
 * Parses one reply against one rubric, stores a verdict per criterion, and
 * returns the reply with the RUBRIC lines removed so the host stage's own
 * parser and artifacts never see them.
 *
 * Throws RubricOutputVoidError on malformed protocol. Silence is NOT malformed:
 * a reply with no RUBRIC lines at all stores `not_assessed` for every criterion
 * and returns normally, because the model refusing to answer is precisely the
 * case this mechanism exists to record rather than to hide.
 */
export function harvestStageRubric(input: HarvestStageRubricInput): { cleanedText: string } {
  if (input.stageRubric.rubric.criteria.length === 0) {
    return { cleanedText: input.rawText };
  }
  const recorded = recordRubricAssessments({
    changeId: input.changeId,
    runId: input.runId,
    roundId: input.roundId ?? null,
    rubric: input.stageRubric.rubric,
    rawText: input.rawText,
    expectedBlockNames: input.expectedBlockNames,
  });
  if (!recorded.ok) {
    throw new RubricOutputVoidError(input.stageRubric.rubric.id, recorded.message);
  }
  return { cleanedText: stripRubricLines(input.rawText) };
}

/**
 * Records every criterion as `not_assessed` for a rubric whose question never
 * got an answer -- the provider failed, timed out, or replied with malformed
 * protocol on a call that has no retry vehicle.
 *
 * Writing nothing would be the dangerous option: no rows is indistinguishable
 * from "this phase has no rubric", which reads as a pass. `not_assessed` rows
 * are blocking under rubricOutcome().
 */
export function recordUnansweredStageRubric(input: {
  stageRubric: StageRubric;
  changeId: string;
  runId: string;
  roundId?: string | null;
  reason: string;
}): void {
  if (input.stageRubric.rubric.criteria.length === 0) return;
  recordUnansweredRubric({
    changeId: input.changeId,
    runId: input.runId,
    roundId: input.roundId ?? null,
    rubric: input.stageRubric.rubric,
  });
  try {
    emitIdempotentEvent({
      id: `EVT-rubric-unanswered-${createHash("sha256")
        .update([input.runId, input.roundId ?? "", input.stageRubric.rubric.id].join("\0"))
        .digest("hex")}`,
      changeId: input.changeId,
      runId: input.runId,
      type: "rubric_unanswered",
      message: `${input.stageRubric.rubric.phase} ${input.stageRubric.rubric.role} rubric recorded as not_assessed`,
      rawJson: {
        rubricUnanswered: {
          schemaVersion: "rubric_unanswered/v1",
          rubricId: input.stageRubric.rubric.id,
          roundId: input.roundId ?? null,
          reason: input.reason,
        },
      },
    });
  } catch {
    // Diagnostic only; the not_assessed rows are the record that matters.
  }
}

/** Appends a rubric section to a prompt. No rubric, or an empty one, changes nothing. */
export function appendRubricPromptSection(
  prompt: string,
  stageRubric: StageRubric | null,
): string {
  if (!stageRubric?.promptSection) return prompt;
  return `${prompt}\n\n${stageRubric.promptSection}`;
}
