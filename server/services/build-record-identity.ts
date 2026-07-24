/**
 * One definition each for two questions about a `build_run_records` row that
 * the codebase had been answering separately in a dozen places:
 *
 *   1. which commit does this build run stand for?
 *   2. which of a change's build runs is the current approved one?
 *
 * Both answers are compared across module boundaries -- the Review writer
 * stamps `review_reports.source_head_sha` with (1), and merge readiness, the
 * action contract and the recovery evidence snapshot all read it back and
 * compare -- so a divergence between any two spellings is not a style problem,
 * it is a false equality or a false mismatch.
 *
 * These are pure functions over the row shape on purpose: every caller has its
 * own database seam (`setMergeReadinessDbForTest`,
 * `setActionContractServiceDbForTest`, ...), so an authority that owned a
 * connection could not be shared by all of them.
 */

/** The `build_run_records` columns these rules read. */
export interface BuildRecordHeadFields {
  status: string;
  headSha: string | null;
  baseHeadSha: string | null;
  baseCommit: string | null;
  adoptedHeadSha: string | null;
}

/** The `build_run_records` columns the recency ordering reads. */
export interface BuildRecordRecencyFields {
  id: string;
  status: string;
  adoptedAt: string | null;
  updatedAt: string | null;
}

/** Statuses that make a build run a candidate for "the change's current build". */
export const APPROVED_BUILD_STATUSES: readonly string[] = ["approved_for_absorb", "adopted"];

export function isApprovedBuildStatus(status: string): boolean {
  return APPROVED_BUILD_STATUSES.includes(status);
}

/**
 * The commit a build run record stands for.
 *
 * `adopted_head_sha` and `head_sha` are only written when the build is adopted
 * (`build-workspace-service` fills them at absorb time; until then
 * `recordInputFromBuildRunFile` writes NULL into both). So on an
 * `approved_for_absorb` row the only commit that exists is the base one, and a
 * reader that spells this rule as `headSha ?? adoptedHeadSha` gets NULL for
 * every approved-but-not-yet-absorbed build.
 *
 * That is not hypothetical: `selfHealMissingReviewGate` used exactly that
 * spelling, read NULL, and its `latestBuildHead && report.sourceHeadSha && ...`
 * guard short-circuited -- so it wrote a *passed* Review gate without ever
 * running the head-equality check it exists to run.
 */
export function buildRecordSourceHead(record: BuildRecordHeadFields): string | null {
  if (record.status === "approved_for_absorb") {
    return record.baseCommit ?? record.baseHeadSha ?? null;
  }
  return record.adoptedHeadSha ?? record.headSha ?? record.baseCommit ?? null;
}

/**
 * Newest-approved-first ordering for a change's build runs.
 *
 * `adopted_at` is NULL on every `approved_for_absorb` row by construction
 * (`recordInputFromBuildRunFile`: `adoptedAt: status === "adopted" ? updatedAt
 * : null`), so it cannot be the sole sort key. Coalescing to `updated_at` is
 * what the JavaScript callers already did; the SQL caller instead ordered by
 * `adopted_at DESC, updated_at DESC`, and SQLite sorts NULL *last* under DESC,
 * which pushed every approved_for_absorb row behind every adopted one no matter
 * how much newer it was. With one build absorbed and the next awaiting absorb --
 * an ordinary Fix state, not an edge case -- the two answers disagreed, and the
 * recovery evidence snapshot then reported a healthy Review as missing its
 * `review_gate_commit` evidence.
 */
export function compareBuildRecordRecency(
  left: BuildRecordRecencyFields,
  right: BuildRecordRecencyFields,
): number {
  const byTime = (right.adoptedAt ?? right.updatedAt ?? "").localeCompare(
    left.adoptedAt ?? left.updatedAt ?? "",
  );
  if (byTime !== 0) return byTime;
  const byUpdatedAt = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
  if (byUpdatedAt !== 0) return byUpdatedAt;
  return right.id.localeCompare(left.id);
}

/**
 * The change's current approved build run, or null. Callers pass every
 * `build_run_records` row for the change; filtering and ordering happen here so
 * they cannot drift apart.
 */
export function latestApprovedBuildRecord<T extends BuildRecordRecencyFields>(
  rows: readonly T[],
): T | null {
  return rows.filter((row) => isApprovedBuildStatus(row.status)).sort(compareBuildRecordRecency)[0] ?? null;
}
