import type { RubricPhase, RubricRole } from "./rubric-assessment";
import { factoryCriteria, type FactoryRubricCriterion } from "./rubric-defaults";

/**
 * The three rubric tiers (design doc §2.1).
 *
 *  - Tier 1 «绝对对齐»: judged by BOTH deterministic code checks and the model,
 *    text immutable, ALWAYS blocking, and -- deliberately -- with no human
 *    exit. `rubricBlockerRetirement`'s first exit (withdrawing the standard)
 *    can never fire for these because no write path lets their key leave the
 *    rubric; the only way past a tier-1 `no` is the pipeline's own loop: fix
 *    the artifact and be judged `yes`. A misjudgment therefore deadlocks the
 *    change. THAT IS THE ACCEPTED DESIGN (§2.2): the user chose deadlock over
 *    an escape hatch, twice, with the counter-evidence on the table. Do not
 *    "fix" this by adding an exit.
 *
 *  - Tier 2 «阶段特有»: factory-authored, editable, blocking is the user's
 *    per-criterion choice.
 *
 *  - Tier 3 «用户自加»: user-authored, editable, blocking is the user's
 *    per-criterion choice.
 *
 * ## Why tier is derived from the key instead of stored in a column
 *
 * Tier-1 membership must be unforgeable and unremovable. A DB column would
 * make it writable by anything that can write the row, and a migration would
 * have to chase every historical version. The key is already the one identity
 * that survives edits (§5.1), factory keys are already code constants no
 * request can mint (`RBK-factory-…` vs the runtime's `RBK-<uuid>`), so the
 * registry below is the single source of truth and the DB stays untouched.
 *
 * ## The tier-1 registry is a PROMOTION list, not new wording
 *
 * Every tier-1 clause is an existing factory criterion, chosen 2026-07-21 by
 * the user (one per category they named, plus the §3.4 delivery clause):
 *
 *  - `RBK-factory-Spec-producer-03`  «严格对齐 PRD»
 *  - `RBK-factory-Build-producer-01` «不许在计划范围外写文件»
 *  - `RBK-factory-Build-producer-02` «代码怎么写»（不许删/跳过/放宽测试）
 *  - `RBK-factory-Done-producer-01`  §3.4: 交付单的启动方式必须真的跑通
 *
 * Promoting existing keys keeps identity continuous (historical verdicts and
 * derived blockers keep meaning what they meant) and reuses wording that has
 * already been through the 8d59eb8 discipline pass. Each entry must be able to
 * name a concrete artifact that makes it answer `no` (§2.2 mitigation 1):
 *
 *  - Spec-03: a delta line introducing a requirement no PRD section contains.
 *  - Build-01: a diff touching a file outside the plan's expectedFiles.
 *  - Build-02: a diff deleting an existing assertion or adding a test skip.
 *  - Done-01: a delivery note whose start command names a file or script that
 *    does not exist in the repository at delivery time.
 */
export const TIER1_CRITERION_KEYS: ReadonlySet<string> = new Set([
  "RBK-factory-Spec-producer-03",
  "RBK-factory-Build-producer-01",
  "RBK-factory-Build-producer-02",
  "RBK-factory-Done-producer-01",
]);

export type RubricTier = 1 | 2 | 3;

/**
 * `RBK-factory-` is the seam between tiers 2 and 3: factory keys are authored
 * in rubric-defaults.ts and can only enter a rubric through code (seeding or
 * the tier-1 merge), while every runtime-minted key is `RBK-<uuid>`
 * (rubric-service.ts resolveCriterionKeys rule 3). A user CAN hand-write a
 * `RBK-factory-…` key through the PUT route -- resolveCriterionKeys rule 1
 * honours it if the key exists in some version of the scope -- but that is
 * exactly the "still the same standard" case tier 2 describes, so classifying
 * it as tier 2 is correct rather than a spoof.
 */
export function tierOfCriterionKey(key: string): RubricTier {
  if (TIER1_CRITERION_KEYS.has(key)) return 1;
  if (key.startsWith("RBK-factory-")) return 2;
  return 3;
}

/**
 * The canonical tier-1 rows for one scope, in factory order. Text comes from
 * the factory table (the single authored source), so a drifted copy in the DB
 * or in a `.ship/rubrics/` file is always corrected back to this.
 */
export function tier1CriteriaForScope(
  phase: RubricPhase,
  role: RubricRole,
): FactoryRubricCriterion[] {
  return factoryCriteria(phase, role).filter((criterion) =>
    TIER1_CRITERION_KEYS.has(criterion.criterionKey),
  );
}

/** True when this scope carries at least one tier-1 criterion. */
export function scopeHasTier1(phase: RubricPhase, role: RubricRole): boolean {
  return tier1CriteriaForScope(phase, role).length > 0;
}
