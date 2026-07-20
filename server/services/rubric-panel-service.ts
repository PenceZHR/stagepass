import {
  RUBRIC_ROLES,
  rubricOutcome,
  type RubricAssessmentDraft,
  type RubricPhase,
  type RubricRole,
  rubricPhaseHasCritic,
} from "./rubric-assessment";
import { rubricRoleAnsweredBy } from "./rubric-defaults";
import { rubricBlockingChannel, type RubricBlockingChannel } from "./rubric-gate-adapters";
import { blockingCriterionKeysInForce } from "./rubric-gate-service";
import type { RubricVerdict } from "./rubric-line-protocol";
import {
  getCurrentRubric,
  getEffectiveRubric,
  indexCriteriaByScope,
  listRubricAssessmentsForScope,
  selectLatestAssessmentBatch,
} from "./rubric-service";
import { latestRound } from "./spec-battle-row-readers";

/**
 * Everything one phase's rubric drawer shows: the three editable checklists,
 * which scope each came from, and this round's verdicts (§7).
 *
 * This is a read model, not a second source of truth. It owns exactly two
 * decisions that the UI must not be trusted to make for itself:
 *
 *  1. WHICH verdicts count as "this run's" -- by round, never by run (§5.2).
 *  2. WHETHER a verdict was made against the rubric that is in force now, so
 *     the UI can label a stale one instead of presenting it as current (§7.6).
 *
 * Both are the sort of thing that fails silently and in the passing direction
 * if a component gets it slightly wrong, which is why neither is left to JSX.
 */

export interface RubricPanelCriterion {
  criterionKey: string;
  text: string;
  blocking: boolean;
}

export interface RubricPanelVerdict {
  criterionKey: string;
  /** The wording that was actually judged, snapshotted from its own version. */
  text: string;
  blocking: boolean;
  verdict: RubricVerdict;
  evidence: string | null;
  /** The criterion is still in the rubric that is in force now. */
  stillCurrent: boolean;
}

export interface RubricRolePanel {
  role: RubricRole;
  /**
   * False only for `critic` on a phase that has none (§7.1: hide the middle
   * tab). Distinct from "applicable but empty", which means the user simply has
   * not written this rubric yet.
   */
  applicable: boolean;
  rubricId: string | null;
  version: number | null;
  /** Which scope is in force RIGHT NOW: this change's override, or the project default (§7.7). */
  source: "change" | "project" | null;
  /** True when this change has its own override row for this scope. */
  hasChangeOverride: boolean;
  criteria: RubricPanelCriterion[];
  verdicts: RubricPanelVerdict[];
  /** The version that produced `verdicts`; null when nothing has been judged. */
  judgedVersion: number | null;
  /**
   * The verdicts on display were produced by a rubric version that is no longer
   * the one in force. Drives the explicit staleness label (§7.6).
   */
  judgedByOutdatedVersion: boolean;
  /** Anything here blocks, through the phase's `blockingChannel`. */
  blocked: boolean;
  /**
   * The pipeline stage that answers this role, or null when nothing does.
   *
   * `applicable` says the tab is worth showing; this says whether writing a
   * criterion into it will ever get a verdict. They differ: Fix's critic tab is
   * applicable (§3 gives Fix a critic) but unanswered, because the single review
   * stage answers Build's critic rubric. Surfacing it is the point -- a checklist
   * nobody answers collects no rows, and no rows is indistinguishable from "no
   * rubric", which reads as a pass.
   */
  answeredBy: string | null;
}

export interface RubricPanelState {
  phase: RubricPhase;
  projectId: string;
  changeId: string;
  /**
   * The round the verdicts belong to, or null for a phase with no rounds.
   * Present so a caller can prove which round it is looking at rather than
   * inferring it.
   */
  roundId: string | null;
  /**
   * The blocking form this phase's verdicts take. `none` means a criterion
   * ticked `blocking` here records a verdict and stops nothing, which the drawer
   * must say rather than let the user infer from silence.
   */
  blockingChannel: RubricBlockingChannel;
  roles: RubricRolePanel[];
}

/**
 * The round whose verdicts a phase should display.
 *
 * Only Spec has rounds today. Returning the round id rather than a run id is
 * the whole point: see selectLatestAssessmentBatch.
 */
export function resolveAssessmentRoundId(changeId: string, phase: RubricPhase): string | null {
  if (phase !== "Spec") return null;
  return latestRound(changeId)?.id ?? null;
}

export function buildRubricPanelState(input: {
  projectId: string;
  changeId: string;
  phase: RubricPhase;
}): RubricPanelState {
  const roundId = resolveAssessmentRoundId(input.changeId, input.phase);
  const roles = RUBRIC_ROLES.map((role) => buildRolePanel({ ...input, role, roundId }));
  return {
    phase: input.phase,
    projectId: input.projectId,
    changeId: input.changeId,
    roundId,
    blockingChannel: rubricBlockingChannel(input.phase),
    roles,
  };
}

function buildRolePanel(input: {
  projectId: string;
  changeId: string;
  phase: RubricPhase;
  role: RubricRole;
  roundId: string | null;
}): RubricRolePanel {
  const scope = {
    projectId: input.projectId,
    changeId: input.changeId,
    phase: input.phase,
    role: input.role,
  };
  const applicable = input.role !== "critic" || rubricPhaseHasCritic(input.phase);
  const effective = getEffectiveRubric(scope);
  const hasChangeOverride = getCurrentRubric(scope) !== null;
  // The live half of §4.3.1's exit, straight from the gate's own definition.
  const keysInForce = blockingCriterionKeysInForce({
    projectId: input.projectId,
    changeId: input.changeId,
    phase: input.phase,
  });

  const batch = selectLatestAssessmentBatch(listRubricAssessmentsForScope(scope), {
    roundId: input.roundId,
  });
  const criteriaById = batch.length > 0 ? indexCriteriaByScope(scope) : new Map();

  // A verdict is described by the criterion row it was made against, NOT by the
  // criterion that occupies the same slot today. Re-deriving the wording from
  // the current version would silently re-caption a past judgment with text the
  // model never saw -- the same "never derive retroactively" rule §5.1 states
  // for the gap snapshot.
  const currentKeys = new Set(
    (effective?.rubric.criteria ?? []).map((criterion) => criterion.criterionKey),
  );
  const verdicts: RubricPanelVerdict[] = batch
    .map((assessment) => {
      const judged = criteriaById.get(assessment.criterionId);
      if (!judged) return null;
      return {
        ordinal: judged.criterion.ordinal,
        verdict: {
          criterionKey: judged.criterion.criterionKey,
          text: judged.criterion.text,
          blocking: judged.criterion.blocking,
          verdict: assessment.verdict,
          evidence: assessment.evidence,
          stillCurrent: currentKeys.has(judged.criterion.criterionKey),
        } satisfies RubricPanelVerdict,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((entry) => entry.verdict);

  const judgedRubricId = batch[0]?.rubricId ?? null;
  const judgedVersion = judgedRubricId
    ? criteriaById.get(batch[0]!.criterionId)?.version ?? null
    : null;

  // rubricOutcome is the one definition of what a set of verdicts blocks, and
  // it is reused rather than reimplemented so the drawer can never disagree
  // with the gate batch 5 will build on the same function. It needs the
  // criteria the verdicts were judged against, not today's.
  const judgedCriteria = batch
    .map((assessment) => criteriaById.get(assessment.criterionId)?.criterion)
    .filter((criterion): criterion is NonNullable<typeof criterion> => criterion !== undefined);
  const drafts: RubricAssessmentDraft[] = batch.map((assessment) => ({
    criterionId: assessment.criterionId,
    verdict: assessment.verdict,
    evidence: assessment.evidence,
  }));

  return {
    role: input.role,
    applicable,
    rubricId: effective?.rubric.id ?? null,
    version: effective?.rubric.version ?? null,
    source: effective?.source ?? null,
    hasChangeOverride,
    criteria: (effective?.rubric.criteria ?? []).map((criterion) => ({
      criterionKey: criterion.criterionKey,
      text: criterion.text,
      blocking: criterion.blocking,
    })),
    verdicts,
    judgedVersion,
    judgedByOutdatedVersion:
      judgedRubricId !== null && effective !== null && judgedRubricId !== effective.rubric.id,
    // Exactly `activeRubricBlockers`: what the verdicts imply, INTERSECTED with
    // the standards the user still requires. Both halves are needed and the
    // intersection is the one that kept being forgotten -- without it the drawer
    // went on showing a blocking dot after the user had taken §4.3.1's exit and
    // the gate had already reopened, which makes the only exit look broken.
    //
    // Reusing the gate's own function rather than re-deriving "still in force"
    // here is deliberate: batch 5 believed sharing `rubricOutcome` was enough to
    // keep the two in step, and it was not, because each side then applied its
    // own second filter. Sharing BOTH filters is what actually binds them.
    blocked: batch.length > 0
      && rubricOutcome(judgedCriteria, drafts)
        .blockingCriterionIds.some((criterionId) =>
          keysInForce.has(criteriaById.get(criterionId)?.criterion.criterionKey ?? "")),
    answeredBy: rubricRoleAnsweredBy(input.phase, input.role),
  };
}
