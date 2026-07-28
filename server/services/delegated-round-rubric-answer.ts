import { z } from "zod";

/**
 * How a role answers a rubric inside a delegated round.
 *
 * ## Why blue needs one too, and not only the judge
 *
 * The round injected criteria into the JUDGE's brief only, so the verdict rubric
 * was the only scope anything answered. A critic rubric shipped alongside it
 * would have been a checklist with no answerer -- and `rubric-rollout`'s guard
 * says exactly what that costs: it "would hold a checklist that stays blank
 * forever, and blank reads as 'no rubric', which reads as a pass". Since blue IS
 * the critic, the honest fix is to ask blue the critic's questions rather than
 * to leave the tab empty or, worse, to have the judge answer on blue's behalf --
 * the one thing this whole design refuses.
 *
 * ## Why one definition rather than a copy in each schema
 *
 * Blue's answers and the judge's are the same act against different scopes, and
 * they are read back by the same store. Two copies would be two places for the
 * verdict vocabulary to drift, and a drift here shows up as a round refused for
 * an "unknown verdict" with nothing pointing at which schema was stale.
 */

/**
 * `not_assessed` is absent by design: silence is how a criterion goes
 * unanswered, and rubric-assessment.ts already records an unanswered criterion
 * as `not_assessed` and blocks on it. Letting a role WRITE `not_assessed` would
 * make "I decline to judge" a positive act it could spend on a criterion it
 * simply did not want to fail.
 */
export const DELEGATED_ROUND_RUBRIC_VERDICTS = ["yes", "no"] as const;

export const DELEGATED_ROUND_RUBRIC_JSON_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["criterionId", "verdict", "evidence"],
    properties: {
      criterionId: { type: "string", minLength: 1 },
      verdict: { type: "string", enum: [...DELEGATED_ROUND_RUBRIC_VERDICTS] },
      evidence: { type: "string", minLength: 1 },
    },
  },
};

export const DelegatedRoundRubricAnswerSchema = z
  .object({
    criterionId: z.string().min(1),
    verdict: z.enum(DELEGATED_ROUND_RUBRIC_VERDICTS),
    evidence: z.string().min(1),
  })
  .strict();

export type DelegatedRoundRubricAnswer = z.infer<typeof DelegatedRoundRubricAnswerSchema>;

/**
 * The brief section listing the criterion ids a role must answer by.
 *
 * The ids travel verbatim because a model with no id list invents plausible
 * slugs from the criterion text -- observed on CHG-006, where the judge answered
 * `claims_verified_by_critic` and the store refused the round AFTER red and blue
 * had already been committed. The model's behaviour was reasonable; what was
 * missing was the input.
 */
export function rubricCriteriaSection(
  criteria: readonly { id: string; text: string }[],
  emptyNotice: string,
): string {
  if (criteria.length === 0) return emptyNotice;
  return criteria
    .map((criterion, index) => `${index + 1}. \`${criterion.id}\` — ${criterion.text}`)
    .join("\n");
}
