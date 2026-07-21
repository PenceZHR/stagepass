import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { changes, findings, requirementGaps } from "../db/schema";
import type { RubricPhase } from "./rubric-assessment";
import {
  activeRubricBlockers,
  blockingCriterionKeysInForce,
  criterionKeyFromBlockerId,
  isRubricBlockerId,
  latestRubricVerdictsByKey,
  rubricBlockerEvidence,
  rubricBlockerId,
  rubricBlockerRetirement,
  rubricBlockerTitle,
  RUBRIC_BLOCKER_REQUIRED_FIX,
  type RubricJudgedCriterion,
} from "./rubric-gate-service";
import { isMergeBlockingGap, isSpecBlockingGap, type RuleGap } from "./spec-battle-rules";
import { latestRound } from "./spec-battle-row-readers";
import { resyncSpecStageAfterGapChange } from "./spec-battle-service";
import {
  peekStageAuthority,
  recomputeStageGate,
  type PipelinePhase,
  type StageGateRecord,
} from "./stage-authority-service";
import { withSqliteWriteRetry } from "../db/write-boundary";

/**
 * The per-channel half of §4.3: writing a rubric verdict into the blocking form
 * a phase already has, and taking it back out again when the criterion behind
 * it is withdrawn.
 *
 * ## Why no new table
 *
 * §4.3's stated reason is "do not build a parallel blocking mechanism" -- the
 * gates already count open P0/P1, so a rubric only has to produce something
 * they already count. Reusing `requirement_gaps` has a second payoff the design
 * doc asks for separately: §11.3 warns that the repo has TWO different Spec hash
 * definitions (`spec-battle-service.specSourceDbHash` and
 * `spec-battle-report-service.reportSourceDbHash`) and that a rubric-derived
 * blocker must enter both or war-report freshness will fight the gate. Both
 * already hash `requirement_gaps` verbatim, so a derived gap enters both by
 * construction -- there is nothing to keep in sync, and no way for the two to
 * drift apart later.
 *
 * ## Severity is P0, and that is only safe because retirement works
 *
 * `blocking: true` means the user said this standard stops the pipeline, so the
 * derived record is P0. Nothing weaker would be honest. P0 also means none of
 * the ordinary human escapes apply: gaps refuse `human_cannot_resolve_gap`,
 * findings refuse a P0 waiver four ways, stage gates have no override at all.
 * The retirement path in rubric-gate-service is therefore not a nicety, it is
 * the entire reason P0 is defensible here.
 *
 * ## Writes are change-only, never a no-op
 *
 * Every adapter compares desired state against stored state and writes ONLY the
 * rows that actually change. That is what keeps §4.4 true: `requirement_gaps`
 * is inside both Spec hashes, so a sync that rewrote an unchanged open gap
 * would move `specSourceDbHash` on every rubric save and stale every stamped
 * gate -- the exact `204f3f5` failure the design doc was written about.
 *
 * An open derived record is written ONCE and then left alone until it retires
 * or reopens. Its criterion text is a snapshot of the version that produced the
 * verdict and is never refreshed from the live rubric (§5.1).
 */

export interface RubricGateSyncResult {
  /** Blocking records newly created. */
  opened: string[];
  /** Blocking records closed because their criterion was withdrawn or answered `yes`. */
  retired: string[];
  /** Blocking records reopened by a fresh blocking verdict. */
  reopened: string[];
}

function emptyResult(): RubricGateSyncResult {
  return { opened: [], retired: [], reopened: [] };
}

export function rubricGateSyncChangedAnything(result: RubricGateSyncResult): boolean {
  return result.opened.length > 0 || result.retired.length > 0 || result.reopened.length > 0;
}

function nowISO(): string {
  return new Date().toISOString();
}

function getChangeRow(changeId: string) {
  return db.select().from(changes).where(eq(changes.id, changeId)).get() ?? null;
}

/**
 * The round whose verdicts a phase derives from.
 *
 * Spec is the only phase with rounds; everywhere else assessments are stored
 * with a null `roundId`. Either way this is a ROUND, never a run (§5.2).
 */
function assessmentRoundId(changeId: string, phase: RubricPhase): string | null {
  if (phase !== "Spec") return null;
  return latestRound(changeId)?.id ?? null;
}

interface ResolvedScope {
  projectId: string;
  changeId: string;
  phase: RubricPhase;
  roundId: string | null;
  active: RubricJudgedCriterion[];
  keysInForce: ReadonlySet<string>;
  verdicts: ReadonlyMap<string, RubricJudgedCriterion>;
}

function resolveScope(changeId: string, phase: RubricPhase): ResolvedScope | null {
  const change = getChangeRow(changeId);
  if (!change) return null;
  const scope = {
    projectId: change.projectId,
    changeId,
    phase,
    roundId: assessmentRoundId(changeId, phase),
  };
  return {
    ...scope,
    active: activeRubricBlockers(scope),
    keysInForce: blockingCriterionKeysInForce(scope),
    verdicts: latestRubricVerdictsByKey(scope),
  };
}

// --- Spec: requirement gaps ------------------------------------------------

function toRuleGap(row: typeof requirementGaps.$inferSelect): RuleGap {
  return {
    id: row.id,
    severity: row.severity as RuleGap["severity"],
    originalSeverity: row.originalSeverity as RuleGap["originalSeverity"],
    downgradedTo: row.downgradedTo as RuleGap["downgradedTo"],
    status: row.status as RuleGap["status"],
  };
}

/**
 * Reconciles the Spec phase's rubric-derived requirement gaps.
 *
 * Retirement writes `status: "resolved"` and NOT `overridden`, which reads like
 * the better fit. `isMergeBlockingGap` returns true for ANY overridden gap
 * whose `originalSeverity` is P0, and `computeMergeReadiness` blocks on the
 * stored `merge_blocking` column, so an overridden rubric gap would swap a
 * dead-ended Spec gate for a dead-ended Merge gate -- there is no human waiver
 * for a P0 gap at Merge either. `resolved` is the only status in
 * spec-battle-rules' vocabulary that actually retires a P0.
 *
 * "Resolved" overstates what happened, so the row says so: `resolutionEvidence`
 * states in words that the standard was withdrawn rather than met, and
 * `resolvedByRoundId` stays null, which is the machine-readable difference from
 * a gap that blue actually reviewed as resolved.
 */
export function syncSpecRubricGaps(changeId: string): RubricGateSyncResult {
  const scope = resolveScope(changeId, "Spec");
  if (!scope) return emptyResult();
  // No round means nothing has been judged yet. Deriving from an empty round
  // would be deriving from nothing.
  if (!scope.roundId) return emptyResult();

  const stored = db
    .select()
    .from(requirementGaps)
    .where(eq(requirementGaps.changeId, changeId))
    .all()
    .filter((row) => isRubricBlockerId(row.canonicalGapId));
  const storedByKey = new Map(
    stored.map((row) => [criterionKeyFromBlockerId(row.canonicalGapId)!, row]),
  );
  const activeByKey = new Map(scope.active.map((entry) => [entry.criterionKey, entry]));

  const result = emptyResult();
  const now = nowISO();

  withSqliteWriteRetry("rubric.syncSpecRubricGaps", () =>
    db.transaction((tx) => {
      for (const [criterionKey, entry] of activeByKey) {
        const existing = storedByKey.get(criterionKey);
        if (!existing) {
          const ruleGap: RuleGap = {
            id: criterionKey,
            severity: "P0",
            originalSeverity: "P0",
            downgradedTo: null,
            status: "open",
          };
          tx.insert(requirementGaps)
            .values({
              id: `GAP-${randomUUID()}`,
              changeId,
              // Identity is the criterion key, so a rubric edit -- even a
              // reword -- finds this row again instead of orphaning it (§5.1).
              canonicalGapId: rubricBlockerId(criterionKey),
              firstSeenRoundId: scope.roundId!,
              lastEvaluatedRoundId: scope.roundId!,
              resolvedByRoundId: null,
              sourcePhase: "Spec",
              sourceUnit: `RUBRIC_${entry.role.toUpperCase()}`,
              title: rubricBlockerTitle(entry),
              category: "rubric",
              evidence: rubricBlockerEvidence(entry),
              affectedArtifactsJson: "[]",
              proposedSpecPatch: null,
              severity: "P0",
              originalSeverity: "P0",
              downgradedTo: null,
              status: "open",
              resolutionEvidence: null,
              waiverReason: null,
              downgradeReason: null,
              overrideReason: null,
              specBlocking: isSpecBlockingGap(ruleGap) ? 1 : 0,
              mergeBlocking: isMergeBlockingGap(ruleGap) ? 1 : 0,
              sourceHashesJson: JSON.stringify({
                rubricId: entry.rubricId,
                criterionKey,
                roundId: scope.roundId,
              }),
              createdAt: now,
              updatedAt: now,
              closedAt: null,
            })
            .run();
          result.opened.push(criterionKey);
          continue;
        }

        if (existing.status === "open") continue; // already blocking: leave the row untouched

        // Reopened by a fresh blocking verdict. This IS a new derivation, so
        // the snapshot is taken again from the version that just answered --
        // that is not the retroactive re-derivation §5.1 forbids.
        const ruleGap: RuleGap = { ...toRuleGap(existing), status: "open", downgradedTo: null };
        tx.update(requirementGaps)
          .set({
            lastEvaluatedRoundId: scope.roundId!,
            resolvedByRoundId: null,
            title: rubricBlockerTitle(entry),
            evidence: rubricBlockerEvidence(entry),
            status: "open",
            resolutionEvidence: null,
            specBlocking: isSpecBlockingGap(ruleGap) ? 1 : 0,
            mergeBlocking: isMergeBlockingGap(ruleGap) ? 1 : 0,
            updatedAt: now,
            closedAt: null,
          })
          .where(eq(requirementGaps.id, existing.id))
          .run();
        result.reopened.push(criterionKey);
      }

      for (const [criterionKey, row] of storedByKey) {
        if (row.status !== "open") continue;
        if (activeByKey.has(criterionKey)) continue;
        const retirement = rubricBlockerRetirement({
          criterionKey,
          keysInForce: scope.keysInForce,
          verdicts: scope.verdicts,
        });
        // Absence is not a retirement reason. A round that died before its
        // rubric ran leaves no verdict, and "no verdict" must never read as a
        // pass -- the blocker stays open until a human withdraws the standard
        // or a judgment clears it.
        if (!retirement.retired) continue;
        tx.update(requirementGaps)
          .set({
            status: "resolved",
            resolutionEvidence: retirement.reason,
            specBlocking: 0,
            mergeBlocking: 0,
            updatedAt: now,
            closedAt: now,
          })
          .where(eq(requirementGaps.id, row.id))
          .run();
        result.retired.push(criterionKey);
      }
    }),
  );

  // Only when something moved. The Spec gate is append-only and every row bumps
  // gate_version, which preflight rejects as `gate_version_drift`, so a resync
  // that changed nothing would break in-flight clients for no reason.
  if (rubricGateSyncChangedAnything(result)) resyncSpecStageAfterGapChange(changeId);

  return result;
}

// --- Build / Fix: review findings ------------------------------------------

/**
 * Reconciles the Build and Fix phases' rubric-derived findings.
 *
 * `source` is `rubric`, not `review`. Claiming `review` would put the row into
 * `openBlockingReviewFindingIds`, so every later review attempt would be forced
 * to recheck a criterion no reviewer ever wrote -- and a model answering
 * `PRIOR: <id> | fixed` would silently close a rubric verdict it was never
 * asked about. Honest provenance also keeps the row out of
 * `settlementFindingsForReviewAttempt`, which means it does not distort the
 * review report's own P0/P1 counts.
 *
 * It still blocks where it must: `computeMergeReadiness` filters open P0/P1
 * findings across ALL sources, so an open rubric finding stops the merge. That
 * is the whole point, and it is also exactly why retirement has to work -- a
 * merge blocker with no exit is worse than a spec one.
 */
export function syncRubricFindings(
  changeId: string,
  phase: Extract<RubricPhase, "Build" | "Fix">,
): RubricGateSyncResult {
  const scope = resolveScope(changeId, phase);
  if (!scope) return emptyResult();

  const stored = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((row) => isRubricBlockerId(row.id));
  const storedByKey = new Map(stored.map((row) => [criterionKeyFromBlockerId(row.id)!, row]));
  const activeByKey = new Map(scope.active.map((entry) => [entry.criterionKey, entry]));

  const result = emptyResult();
  const now = nowISO();

  withSqliteWriteRetry("rubric.syncRubricFindings", () =>
    db.transaction((tx) => {
      for (const [criterionKey, entry] of activeByKey) {
        const existing = storedByKey.get(criterionKey);
        if (!existing) {
          tx.insert(findings)
            .values({
              // The criterion key IS the id, so identity survives rubric edits
              // without `findings` needing the canonical key column it lacks.
              id: rubricBlockerId(criterionKey),
              changeId,
              runId: null,
              roundId: null,
              phase,
              source: "rubric",
              severity: "P0",
              category: "rubric",
              title: rubricBlockerTitle(entry),
              file: null,
              line: null,
              evidence: rubricBlockerEvidence(entry),
              requiredFix: RUBRIC_BLOCKER_REQUIRED_FIX,
              status: "open",
              createdAt: now,
              updatedAt: now,
              reviewAttemptId: null,
              sourceBuildRunId: null,
              sourceHeadSha: null,
              // A P0 is never waivable, and chk_findings_waivable_scope would
              // reject a non-review row claiming otherwise.
              waivable: 0,
              waivedBy: null,
              waivedAt: null,
              waiverDecisionId: null,
              legacyState: null,
              legacyFindingKey: null,
              findingVersion: 1,
            })
            .run();
          result.opened.push(criterionKey);
          continue;
        }
        if (existing.status === "open") continue;
        tx.update(findings)
          .set({
            title: rubricBlockerTitle(entry),
            evidence: rubricBlockerEvidence(entry),
            requiredFix: RUBRIC_BLOCKER_REQUIRED_FIX,
            status: "open",
            waivedBy: null,
            waivedAt: null,
            updatedAt: now,
            findingVersion: existing.findingVersion + 1,
          })
          .where(eq(findings.id, existing.id))
          .run();
        result.reopened.push(criterionKey);
      }

      for (const [criterionKey, row] of storedByKey) {
        if (row.status !== "open") continue;
        if (activeByKey.has(criterionKey)) continue;
        const retirement = rubricBlockerRetirement({
          criterionKey,
          keysInForce: scope.keysInForce,
          verdicts: scope.verdicts,
        });
        if (!retirement.retired) continue;
        // `findings` has a status vocabulary that can say which of the two
        // exits was taken, so it does: a later judgment answering `yes` is
        // `fixed`, a withdrawn standard is `waived`. Both stop blocking --
        // every counter in review-report-service and merge-readiness-service
        // filters on `status === "open"`.
        const withdrawn = !scope.keysInForce.has(criterionKey);
        tx.update(findings)
          .set({
            status: withdrawn ? "waived" : "fixed",
            evidence: `${row.evidence ?? ""}\n\n${retirement.reason}`.trim(),
            waivedBy: withdrawn ? "rubric_criterion_withdrawn" : null,
            waivedAt: withdrawn ? now : null,
            updatedAt: now,
            findingVersion: row.findingVersion + 1,
          })
          .where(eq(findings.id, row.id))
          .run();
        result.retired.push(criterionKey);
      }
    }),
  );

  return result;
}

// --- Document phases: stage gate blockers ----------------------------------

interface StoredBlocker {
  id: string;
  severity: string;
  title: string;
}

/**
 * The `PipelinePhase` a rubric phase's stage gate lives under.
 *
 * Refine, Fix, Retro and Done deliberately return null: `PipelinePhase` has no
 * member for them and they own no `stage_gates` row anywhere in the repo, so
 * there is no gate to add a blocker to. Returning null rather than guessing a
 * neighbour keeps the caller's `unsupported` branch explicit -- a rubric verdict
 * that has nowhere to go must be visible as such, not silently dropped into
 * another phase's gate.
 *
 * ## Why Done is null on purpose, and why that is spelled out
 *
 * Done is the pipeline's terminus: the delivery stage runs DELIVERY_PENDING ->
 * DONE and nothing follows it. Merge has already happened, so there is no
 * downstream gate a Done verdict could stop and no unmerge for it to force.
 * The only thing a Done blocker could do is strand the change short of DONE --
 * and it would strand it permanently, because a rubric-derived blocker is P0 by
 * construction (see this file's header) and P0 has no human waiver in any of the
 * three channels. A blocker whose subject has already shipped and whose only
 * effect is an unwaivable dead end is strictly worse than no blocker.
 *
 * That is a decision, not an accident, so it is written as one. Done used to
 * reach null through a bare `default:` arm, which meant nothing distinguished
 * "classified as gateless" from "added to RUBRIC_PHASES and never considered" --
 * exactly how Done itself arrived here when design §3 promoted it from a UI
 * label to a real stage. The arms below are exhaustive and the `never` guard
 * makes the next new phase a compile error instead of a silent `none`.
 */
export function stageGatePhaseFor(phase: RubricPhase): PipelinePhase | null {
  switch (phase) {
    case "PRD":
    case "Spec":
    case "TechSpec":
    case "Plan":
    case "TestPlan":
    case "Build":
    case "QA":
    case "Merge":
      return phase;
    case "Refine":
    case "Fix":
    case "Retro":
    case "Done":
      return null;
    default: {
      // A new RubricPhase must be classified here deliberately. Widening
      // `PipelinePhase` to include one of the four above would also land here,
      // which is the other half of the guard: that phase would start writing
      // blockers onto a gate row, and this forces someone to say so out loud.
      const unclassified: never = phase;
      return unclassified;
    }
  }
}

function readJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toStoredBlocker(value: unknown): StoredBlocker | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return {
    id: record.id,
    severity: typeof record.severity === "string" ? record.severity : "P1",
    title: typeof record.title === "string" ? record.title : "Gate blocker",
  };
}

export type RubricStageGateSyncResult =
  | { applied: false; reason: "unsupported_phase" | "no_gate" | "unchanged" }
  /**
   * `gate` is the row this sync appended. Callers that hand a gate record on to
   * something human-readable need it: `recomputeContentGate` returns its own
   * record straight into a TestPlan markdown mirror, and returning the
   * pre-resync one would print "gate: passed" in a file whose phase is, as of
   * one statement later, blocked.
   */
  | { applied: true; blocking: string[]; status: string; gate: StageGateRecord };

/**
 * Projects rubric verdicts onto a document phase's stage gate.
 *
 * A gate row is append-only and `gateDecision` keys off `status`, not off the
 * blocker count, so blocking means writing a new gate row whose status is
 * `blocked` -- adding blockers to a passing gate would change nothing at all.
 *
 * `sourceDbHash` is carried over from the gate being amended, never recomputed.
 * The rubric's own text is not a source row for any phase (§4.4), and
 * `sourceDbHash` doubles as the optimistic-concurrency token that
 * `preflight-service` and `plan-approval-service` compare against -- moving it
 * would spray `source_db_hash_drift` at clients holding a perfectly valid
 * contract.
 *
 * The status the phase's own inputs implied is stashed under
 * `freshness.rubricGate.baseStatus`, so retirement restores it exactly instead
 * of guessing "passed". `freshness` is read by `stageGateBlockReason` only for
 * its `fresh` key, so a sibling key is inert.
 */
export function syncRubricStageGateBlockers(
  changeId: string,
  phase: RubricPhase,
): RubricStageGateSyncResult {
  const pipelinePhase = stageGatePhaseFor(phase);
  if (!pipelinePhase) return { applied: false, reason: "unsupported_phase" };

  const scope = resolveScope(changeId, phase);
  if (!scope) return { applied: false, reason: "no_gate" };

  const gate = peekStageAuthority(changeId, pipelinePhase).latestGate;
  // Nothing has computed this phase's gate yet. Writing the first gate row a
  // phase ever had, from here, would invent a verdict about inputs this module
  // never looked at.
  if (!gate) return { applied: false, reason: "no_gate" };

  const storedBlockers = readJsonArray(gate.blockersJson)
    .map(toStoredBlocker)
    .filter((entry): entry is StoredBlocker => entry !== null);
  const baseBlockers = storedBlockers.filter((entry) => !isRubricBlockerId(entry.id));
  const previousRubricIds = storedBlockers
    .filter((entry) => isRubricBlockerId(entry.id))
    .map((entry) => entry.id)
    .sort();

  const freshness = readJsonObject(gate.freshnessJson);
  const previousMarker =
    freshness.rubricGate && typeof freshness.rubricGate === "object"
      ? (freshness.rubricGate as Record<string, unknown>)
      : {};
  const baseStatus = typeof previousMarker.baseStatus === "string"
    ? previousMarker.baseStatus
    : gate.status;

  const derived = scope.active.map((entry) => ({
    id: rubricBlockerId(entry.criterionKey),
    severity: "P0" as const,
    title: rubricBlockerTitle(entry),
  }));
  const nextRubricIds = derived.map((entry) => entry.id).sort();

  const unchanged =
    previousRubricIds.length === nextRubricIds.length
    && previousRubricIds.every((id, index) => id === nextRubricIds[index]);
  // Never append a gate row that says the same thing. Every gate row bumps
  // gate_version, and a bumped version is what `preflight-service` rejects as
  // `gate_version_drift`, so a no-op write would break in-flight clients for
  // nothing.
  if (unchanged) return { applied: false, reason: "unchanged" };

  const nextFreshness: Record<string, unknown> = { ...freshness };
  if (derived.length > 0) {
    nextFreshness.rubricGate = { baseStatus, criterionKeys: nextRubricIds };
  } else {
    delete nextFreshness.rubricGate;
  }

  const status = derived.length > 0 ? "blocked" : baseStatus;
  const next = recomputeStageGate({
    changeId,
    phase: pipelinePhase,
    status,
    blockers: [...baseBlockers, ...derived],
    freshness: nextFreshness,
    // requiredActions deliberately keeps whatever the phase itself advertised.
    // The remedy for a rubric blocker is the rubric drawer, not a stage action,
    // and testplan-snapshot-service already carries two comments about
    // requiredActions naming action ids that were never registered -- buttons
    // that cannot resolve. Better no button than a dead one.
    requiredActions: readJsonArray(gate.requiredActionsJson),
    sourceDbHash: gate.sourceDbHash,
  });

  return { applied: true, blocking: nextRubricIds, status, gate: next };
}

/**
 * What every document-phase gate writer must call immediately AFTER writing its
 * own gate row.
 *
 * ## The failure this exists to stop
 *
 * `stage_gates` is append-only and each phase publishes its whole blocker list
 * from its own inputs -- `pipeline-design-stage-service` writes a literal `[]`
 * for TechSpec, `plan-snapshot-service` hand-builds Plan's from missing fields
 * and risks. None of them knows rubric blockers exist. So the sequence
 *
 *     rubric verdict says `no` -> blocker appended to the gate
 *     ... phase re-runs, or anything else recomputes its gate ...
 *     phase writes a fresh gate row from its own inputs
 *
 * ends with the rubric blocker GONE, silently, with the gate reading `passed`.
 * Batch 5 built the projection and wrote this ordering rule down, but left the
 * writers themselves untouched, so until now the rule had no enforcer.
 *
 * Re-deriving after the fact is the only shape that works, because a gate row
 * cannot be amended in place -- `insertStageGate` is the sole production writer
 * of that table and there is no update path anywhere.
 *
 * ## Why it is safe to run on every gate write
 *
 * It is a no-op unless the set of rubric blocker ids actually changed, so the
 * common case -- no rubric, no criteria ticked blocking, or nothing judged --
 * costs a few indexed reads and appends nothing. That matters: a gate row that
 * says the same thing as its predecessor still bumps `gate_version`, which
 * `preflight-service` rejects as `gate_version_drift` for any client holding
 * the older contract.
 *
 * ## Why it is not defensive about failure
 *
 * It deliberately does not swallow errors. Losing a rubric blocker is the exact
 * fail-open this whole mechanism exists to prevent, so a phase whose resync
 * cannot run must fail loudly rather than publish a gate that quietly under-
 * reports what is blocking. The one thing a caller must guarantee is that it is
 * NOT inside a `db.transaction`: `recomputeStageGate` opens its own on the same
 * better-sqlite3 connection, and nesting raises "cannot start a transaction
 * within a transaction". `persistPlanSnapshot` is the only writer that had to be
 * arranged around this, and it calls after its transaction commits.
 */
export function reapplyRubricStageGateBlockers(
  changeId: string,
  phase: RubricPhase,
): RubricStageGateSyncResult {
  return syncRubricStageGateBlockers(changeId, phase);
}

// --- dispatcher -------------------------------------------------------------

export type RubricBlockingChannel = "requirement_gap" | "finding" | "stage_gate" | "none";

/**
 * Which blocking form a phase's verdicts take, decided without writing anything.
 *
 * The drawer reads this so a `blocking` tick on a phase with `none` can say so
 * out loud (`RubricInertNotice`). Ticking `blocking` on such a phase is a no-op,
 * and an invisible no-op in a mechanism whose whole purpose is stopping things
 * is worse than a visible absence.
 *
 * The four `none` phases are Refine, Fix's document side, Retro and Done: they
 * own no `stage_gates` row and are not Spec or Build. QA and Merge are NOT in
 * that set -- both are `PipelinePhase` members with real gate rows, so both are
 * `stage_gate`. They are inert for the unrelated reason that
 * `RUBRIC_ROLE_ANSWERED_BY` gives them no answerer, which is the panel's
 * `answeredBy === null` notice rather than this one. An earlier version of this
 * comment listed QA and Merge here and omitted Done, i.e. it was wrong in both
 * directions at once; `rubric-rollout.test.ts` now pins the channel of every
 * member of RUBRIC_PHASES so the list cannot drift from the code again.
 */
export function rubricBlockingChannel(phase: RubricPhase): RubricBlockingChannel {
  if (phase === "Spec") return "requirement_gap";
  if (phase === "Build" || phase === "Fix") return "finding";
  return stageGatePhaseFor(phase) === null ? "none" : "stage_gate";
}

export interface SyncRubricBlockersResult {
  phase: RubricPhase;
  channel: RubricBlockingChannel;
  records: RubricGateSyncResult;
  stageGate: RubricStageGateSyncResult | null;
}

/**
 * Routes one phase's rubric verdicts to the blocking channel §4.3 assigns it.
 *
 * Call this after the phase's own gate has been written, never before: stage
 * gates are append-only and the phase's own writer does not know about rubric
 * blockers, so a gate row written afterwards would drop them. That ordering is
 * why the Spec pipeline calls this between the verdict rubric and
 * `generateSpecReport` -- the report's `syncSpecReportStageAuthority` is the
 * thing that reads `requirement_gaps` back out and recomputes the Spec gate.
 *
 * `channel: "none"` is a real answer, not a failure: Refine, Fix's document
 * side, Retro and Done have no gate of their own to block. Batch 6 owns giving
 * Refine, Fix and Retro somewhere to land before it starts producing verdicts
 * for them.
 *
 * Done is not in that backlog and should not be added to it: it is terminal and
 * post-merge, so `none` is its permanent answer rather than a gap waiting on a
 * gate. See `stageGatePhaseFor` for the argument.
 */
export function syncRubricBlockers(
  changeId: string,
  phase: RubricPhase,
): SyncRubricBlockersResult {
  // Read from `rubricBlockingChannel` rather than restated as a literal per
  // branch. The drawer decides what to TELL the user from that function and this
  // decides what to DO from the branches below; when both sides spelled the
  // channel out independently, nothing stopped them disagreeing, which is the
  // same "advertised one thing, did another" shape this module exists to avoid.
  // The branches still switch on `phase` because `syncRubricFindings` is typed
  // to Build|Fix and only a phase check narrows to that.
  const channel = rubricBlockingChannel(phase);
  if (phase === "Spec") {
    return { phase, channel, records: syncSpecRubricGaps(changeId), stageGate: null };
  }
  if (phase === "Build" || phase === "Fix") {
    return { phase, channel, records: syncRubricFindings(changeId, phase), stageGate: null };
  }
  if (stageGatePhaseFor(phase) === null) {
    return { phase, channel, records: emptyResult(), stageGate: null };
  }
  return {
    phase,
    channel,
    records: emptyResult(),
    stageGate: syncRubricStageGateBlockers(changeId, phase),
  };
}
