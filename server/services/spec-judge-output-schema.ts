/**
 * The schema the judge fills in, and the only structured thing it is asked for.
 *
 * ## What is deliberately NOT here
 *
 * No PRD delta, no fix claims, no gap list. Those belong to red and blue, and
 * they are read off the sub-agent threads that produced them
 * (codex-subagent-attribution.ts). The first draft of this design had the judge
 * relay all three sides in one reply; runtime evidence killed that, because a
 * judge whose sub-agents never spawned writes both sides' answers itself and
 * the turn still completes successfully. Asking the judge to relay content is
 * asking it to restate a fact the server can already establish -- and handing
 * it the chance to restate a fact that isn't true.
 *
 * So the judge is asked only for what nothing else can supply: its judgment.
 *
 * ## What the server does NOT take from this
 *
 * Counts. There is no `blockingP0` field and there must never be one: P0/P1
 * tallies, gate blocking and gap closure are computed from
 * `requirement_gaps` / `red_fix_claims` / `blue_gap_reviews` by
 * rubric-assessment.ts and the report services. The judge's opinion about how
 * many blockers remain is not evidence of how many blockers remain.
 *
 * `verdict` is prose for the war report and carries no decision.
 */

import {
  DELEGATED_ROUND_RUBRIC_JSON_SCHEMA,
  DELEGATED_ROUND_RUBRIC_VERDICTS,
} from "./delegated-round-rubric-answer";

/**
 * Re-exported rather than declared, so the judge and blue answer a rubric the
 * same way. See delegated-round-rubric-answer.ts.
 */
export const SPEC_JUDGE_RUBRIC_VERDICTS = DELEGATED_ROUND_RUBRIC_VERDICTS;

export const SPEC_JUDGE_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "rubric", "roundDone"],
  properties: {
    /** Reasoning for the war report. Never parsed for decisions. */
    verdict: { type: "string", minLength: 1 },
    rubric: DELEGATED_ROUND_RUBRIC_JSON_SCHEMA,
    /**
     * The judge's assertion that it finished, not that the round may close.
     * A round closes when the server has both sides attributed, both payloads
     * schema-valid, and the rubric harvested -- `roundDone: true` on a round
     * missing a side is a protocol violation, not a close.
     */
    roundDone: { type: "boolean" },
  },
};

export interface SpecJudgeOutput {
  verdict: string;
  rubric: Array<{
    criterionId: string;
    verdict: (typeof SPEC_JUDGE_RUBRIC_VERDICTS)[number];
    evidence: string;
  }>;
  roundDone: boolean;
}
