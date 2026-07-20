import {
  RUBRIC_ROLES,
  rubricOutcome,
  type RubricAssessmentDraft,
  type RubricPhase,
  type RubricRole,
} from "./rubric-assessment";
import type { RubricVerdict } from "./rubric-line-protocol";
import {
  getEffectiveRubric,
  indexCriteriaByScope,
  listRubricAssessmentsForScope,
  selectLatestAssessmentBatch,
} from "./rubric-service";

/**
 * Turning rubric verdicts into whatever blocking form a phase already has
 * (§4.3): Spec -> requirement gap, Build/Fix -> review finding, document phases
 * -> stage gate blocker.
 *
 * This module owns the two decisions every channel must make identically, and
 * nothing else. The per-channel adapters live in rubric-gate-adapters.ts.
 *
 * ## The one thing this batch has to get right
 *
 * Batches 1-4 only recorded verdicts. This is the first code that lets a rubric
 * actually stop a human, and every one of the three channels it feeds refuses,
 * by design, to let a human clear a P0:
 *
 *  - Spec: `applySpecBattleDecision` throws `human_cannot_resolve_gap` for any
 *    human approval of a requirement gap, and `waive_p1` is P1-only.
 *  - Build/Fix: a P0 finding is unwaivable four times over (an explicit 403, a
 *    `waivable` flag only ever set for P1, the `chk_findings_waivable_scope`
 *    table CHECK, and the action contract's `hasWaivableOpenReviewP1`), and
 *    only a model's `PRIOR: <id> | fixed` verdict can close one.
 *  - Document phases: `stage_gates` has no approval column at all, and
 *    `approveGate` has no override branch -- it just throws
 *    "Stage gate blocked".
 *
 * So a derived blocker that outlives the reason it was created is a permanent
 * dead end with no exit. THE EXIT IS THE CRITERION ITSELF: a rubric-derived
 * blocker is alive exactly as long as the criterion behind it is still marked
 * blocking in the rubric in force. Withdraw the standard -- untick `blocking`,
 * or delete the criterion -- and the blocker it produced retires with it.
 *
 * That is why §5.1 insists the derived blocker be keyed on `criterionKey` and
 * not on the version-scoped criterion row id. The key is not tidiness; it is
 * the only handle the exit has. Bind a gap to a row id and the first rubric
 * edit orphans it, at which point nothing in the system can ever close it
 * again.
 *
 * It also means the human never has to lie. The exit does not assert that the
 * artifact satisfies the criterion; it withdraws the criterion. That is exactly
 * the distinction `human_cannot_resolve_gap` exists to protect.
 *
 * ## Retirement requires positive evidence, never absence
 *
 * A blocker retires only when the standard was withdrawn, or when a later
 * judgment actually answered `yes`. It never retires because a verdict is
 * MISSING. A round that died before its rubric ran leaves no rows, and reading
 * "no rows" as "cleared" would be the same fail-open this whole mechanism
 * exists to prevent -- the mirror image of §5.2's "read by round, not by run".
 */

/**
 * Prefix marking a blocking record as rubric-derived. The `criterionKey`
 * follows it verbatim, so the identity survives every rubric edit and is
 * recoverable from the stored row without a join.
 */
export const RUBRIC_BLOCKER_PREFIX = "RUBRIC:";

/** What a human must do to clear a rubric-derived blocker. Shown on the record itself. */
export const RUBRIC_BLOCKER_REQUIRED_FIX =
  "让本阶段重跑并对这条标准答 yes；或在该阶段的「评判标准」抽屉里把这条标准改为不阻断、"
  + "或删除它 —— 保存后本阻断项会自动关闭。";

/** Written onto a blocker when the criterion behind it was withdrawn. */
export const RUBRIC_BLOCKER_RETIRED_BY_EDIT =
  "对应的评判标准已被人工撤下（改为不阻断或已删除），本阻断项随之关闭。"
  + "这不代表产物已满足该标准。";

/** Written onto a blocker when a later round answered the same criterion `yes`. */
export const RUBRIC_BLOCKER_RETIRED_BY_VERDICT =
  "后续判定对这条标准答了 yes，本阻断项随之关闭。";

export interface RubricJudgedCriterion {
  /** Identity across rubric versions (§5.1). The handle the exit needs. */
  criterionKey: string;
  role: RubricRole;
  /** The version that actually produced the verdict. */
  rubricId: string;
  /**
   * The criterion's wording AS JUDGED, snapshotted from its own version.
   *
   * §5.1: never re-derived from whatever occupies that slot today. A derived
   * blocker's text is copied into the blocking record once, at derivation, and
   * the record is never rewritten from the live rubric afterwards. Re-deriving
   * would move `requirement_gaps` on every reword, and `requirement_gaps` sits
   * inside BOTH Spec hash definitions (spec-battle-service.specSourceDbHash and
   * spec-battle-report-service.reportSourceDbHash), so a typo fix would
   * invalidate stamped gates and war reports at once -- the §4.4 failure.
   */
  text: string;
  /** `blocking` as it stood in the version that was judged, for the same reason. */
  blocking: boolean;
  verdict: RubricVerdict;
  evidence: string | null;
}

export interface RubricGateScope {
  projectId: string;
  changeId: string;
  phase: RubricPhase;
}

/** `RUBRIC:<criterionKey>` -- the stable id a derived blocking record carries. */
export function rubricBlockerId(criterionKey: string): string {
  return `${RUBRIC_BLOCKER_PREFIX}${criterionKey}`;
}

/** The criterion behind a derived record, or null when the record is not rubric-derived. */
export function criterionKeyFromBlockerId(id: string | null | undefined): string | null {
  if (typeof id !== "string" || !id.startsWith(RUBRIC_BLOCKER_PREFIX)) return null;
  const key = id.slice(RUBRIC_BLOCKER_PREFIX.length);
  return key.length > 0 ? key : null;
}

export function isRubricBlockerId(id: string | null | undefined): boolean {
  return criterionKeyFromBlockerId(id) !== null;
}

/**
 * Every criterion the latest batch for this round actually answered, keyed by
 * `criterionKey` and carrying the wording it was judged against.
 *
 * Selected by ROUND, never by run (§5.2). `resumeBlue` opens a new run for a
 * round whose red half has already answered and does not re-run red, so red's
 * producer verdicts sit under the round's FIRST run id while the round finishes
 * under a second. Filtering on the current run id would find no producer rows,
 * read that as "the producer has no rubric", and let the stage through on a
 * judgment nobody made.
 *
 * A criterion with no row here is ABSENT, which is not the same as passing --
 * see the retirement rule. Note the harvest path writes a row for every
 * criterion in the version it ran (missing lines become `not_assessed`), so a
 * model that simply refused to answer is present here, not absent. Absent means
 * the criterion did not exist when the round was judged, or the round never got
 * that far.
 */
export function latestRubricVerdictsByKey(
  scope: RubricGateScope & { roundId: string | null },
): Map<string, RubricJudgedCriterion> {
  const byKey = new Map<string, RubricJudgedCriterion>();

  for (const role of RUBRIC_ROLES) {
    const roleScope = { ...scope, role };
    const batch = selectLatestAssessmentBatch(listRubricAssessmentsForScope(roleScope), {
      roundId: scope.roundId,
    });
    if (batch.length === 0) continue;
    const criteriaById = indexCriteriaByScope(roleScope);

    for (const assessment of batch) {
      const judged = criteriaById.get(assessment.criterionId);
      // A verdict whose criterion row cannot be resolved is unattributable: we
      // cannot say what standard it answered, so we cannot derive a blocker
      // that names one. Dropping it is safe because it can only ever remove a
      // blocker we would otherwise have opened, never clear one already open.
      if (!judged) continue;
      byKey.set(judged.criterion.criterionKey, {
        criterionKey: judged.criterion.criterionKey,
        role,
        rubricId: assessment.rubricId,
        text: judged.criterion.text,
        blocking: judged.criterion.blocking,
        verdict: assessment.verdict,
        evidence: assessment.evidence,
      });
    }
  }

  return byKey;
}

/**
 * The criteria whose verdicts block, straight out of `rubricOutcome`.
 *
 * `rubricOutcome` is reused rather than reimplemented so the gate can never
 * disagree with the drawer that shows the same verdicts: `blocking: true` +
 * `no` blocks, `blocking: false` + `no` is advisory, and ANY `not_assessed`
 * blocks whatever the flag says (§4.3).
 */
export function deriveRubricBlockers(
  scope: RubricGateScope & { roundId: string | null },
): RubricJudgedCriterion[] {
  const verdicts = [...latestRubricVerdictsByKey(scope).values()];
  if (verdicts.length === 0) return [];

  // rubricOutcome speaks in criterion ids; here identity is the key. Feeding it
  // keys keeps one definition of "what blocks" instead of a second copy that
  // could drift in the passing direction.
  const criteria = verdicts.map((entry, ordinal) => ({
    id: entry.criterionKey,
    criterionKey: entry.criterionKey,
    ordinal,
    text: entry.text,
    blocking: entry.blocking,
  }));
  const drafts: RubricAssessmentDraft[] = verdicts.map((entry) => ({
    criterionId: entry.criterionKey,
    verdict: entry.verdict,
    evidence: entry.evidence,
  }));

  // `blockingCriterionIds`, not failed+notAssessed: silence on a criterion that
  // was advisory WHEN JUDGED must not become a blocker later just because
  // somebody ticked the box afterwards. Opening reads the judged snapshot; only
  // retirement reads the live rubric (§4.3.1).
  const blocked = new Set(rubricOutcome(criteria, drafts).blockingCriterionIds);
  return verdicts.filter((entry) => blocked.has(entry.criterionKey));
}

/**
 * The criterion keys that are marked blocking in the rubric in force RIGHT NOW,
 * across all three roles.
 *
 * This is the live half of the exit. `deriveRubricBlockers` says what the model
 * answered; this says what the user still requires. A key that has dropped out
 * of this set is a standard the user withdrew, and every blocker derived from
 * it retires.
 *
 * Reads `getEffectiveRubric`, so a change-level override withdrawing a criterion
 * retires blockers derived from the project default too -- the override is the
 * rubric in force, which is exactly what "the standard the user still requires"
 * means for this change.
 */
export function blockingCriterionKeysInForce(scope: RubricGateScope): Set<string> {
  const keys = new Set<string>();
  for (const role of RUBRIC_ROLES) {
    const effective = getEffectiveRubric({ ...scope, role });
    for (const criterion of effective?.rubric.criteria ?? []) {
      if (criterion.blocking) keys.add(criterion.criterionKey);
    }
  }
  return keys;
}

export type RubricBlockerRetirement =
  | { retired: false }
  | { retired: true; reason: string };

/**
 * Whether an already-open derived blocker should close, and why.
 *
 * Two ways out, and deliberately no third:
 *
 *  1. the standard was withdrawn -- the human exit;
 *  2. a later judgment answered `yes` -- the pipeline's own loop, the same
 *     shape as blue reviewing one of its own gaps as `resolved`.
 *
 * ABSENCE IS NOT A THIRD WAY. A key with no verdict in the latest batch keeps
 * its blocker open. A round that failed before its rubric ran, a provider that
 * died, a batch that never landed -- none of those are evidence that a standard
 * is now met, and treating them as such would be precisely the silent pass this
 * mechanism exists to catch. The asymmetry is the point: opening needs a
 * verdict, closing needs a verdict or a human.
 */
export function rubricBlockerRetirement(input: {
  criterionKey: string;
  keysInForce: ReadonlySet<string>;
  verdicts: ReadonlyMap<string, RubricJudgedCriterion>;
}): RubricBlockerRetirement {
  if (!input.keysInForce.has(input.criterionKey)) {
    return { retired: true, reason: RUBRIC_BLOCKER_RETIRED_BY_EDIT };
  }
  if (input.verdicts.get(input.criterionKey)?.verdict === "yes") {
    return { retired: true, reason: RUBRIC_BLOCKER_RETIRED_BY_VERDICT };
  }
  return { retired: false };
}

/**
 * The blockers a channel should have open right now.
 *
 * Intersected with the keys in force, so a criterion the user withdrew is never
 * re-opened by an old verdict that is still on file. Opening and retiring
 * therefore agree by construction rather than by two call sites happening to
 * use the same predicate.
 */
export function activeRubricBlockers(
  scope: RubricGateScope & { roundId: string | null },
): RubricJudgedCriterion[] {
  const keysInForce = blockingCriterionKeysInForce(scope);
  return deriveRubricBlockers(scope).filter((entry) => keysInForce.has(entry.criterionKey));
}

/** One line naming the standard, for a blocking record's title. */
export function rubricBlockerTitle(entry: RubricJudgedCriterion): string {
  const label = entry.verdict === "not_assessed" ? "未评估" : "未通过";
  return `评判标准${label}：${entry.text}`;
}

/** The record's body: which rubric said it, what the model offered, and the way out. */
export function rubricBlockerEvidence(entry: RubricJudgedCriterion): string {
  const roleLabel = { producer: "正方自证", critic: "反方复核", verdict: "裁决" }[entry.role];
  const verdictLabel = entry.verdict === "not_assessed"
    ? "未评估（模型没有回答这一条，按 §4.3 视同阻断）"
    : "否";
  return [
    `标准：${entry.text}`,
    `判定（${roleLabel}）：${verdictLabel}`,
    `依据：${entry.evidence ?? "（模型未给出依据）"}`,
    `出口：${RUBRIC_BLOCKER_REQUIRED_FIX}`,
  ].join("\n");
}
