#!/usr/bin/env tsx

import path from "node:path";
import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const DB_PATH = path.join(process.cwd(), "server", "db", "ship.db");
const RECOVERY_KIND = "polluted_implementing_review_blocker";

type SqliteDatabase = Database.Database;
type ReviewBlockerGate = "blocked_p0" | "blocked_p1";

interface ImplementingChange {
  id: string;
  title: string;
}

interface RepairCandidate extends ImplementingChange {
  reviewGate: ReviewBlockerGate;
}

interface ReviewCenterGate {
  status: string;
  canEnterQa: boolean;
  reason: string | null;
  sourceBuildRunId: string | null;
  latestBuildRunId: string | null;
}

interface ReviewCenterState {
  gate: ReviewCenterGate;
}

interface ChangeStatusTransitionInput {
  changeId: string;
  to: string;
  blockedPhase?: string | null;
  message?: string;
  rawJson?: Record<string, unknown>;
}

type GetReviewCenterState = (changeId: string) => ReviewCenterState;
type TransitionChangeStatus = (input: ChangeStatusTransitionInput) => unknown;

function openReadonlyDb(): SqliteDatabase {
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

function implementingChanges(readDb: SqliteDatabase): ImplementingChange[] {
  return readDb
    .prepare("SELECT id, title FROM changes WHERE status = ? ORDER BY id")
    .all("IMPLEMENTING") as ImplementingChange[];
}

function hasRunningRun(readDb: SqliteDatabase, changeId: string): boolean {
  return Boolean(
    readDb
      .prepare("SELECT 1 FROM runs WHERE change_id = ? AND status = ? LIMIT 1")
      .get(changeId, "running"),
  );
}

function latestBuildRunStatus(readDb: SqliteDatabase, changeId: string): string | null {
  const row = readDb
    .prepare(`
      SELECT status
      FROM build_run_records
      WHERE change_id = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `)
    .get(changeId) as { status: string } | undefined;
  return row?.status ?? null;
}

function isAwaitingHumanBuildOrFix(readDb: SqliteDatabase, changeId: string): boolean {
  const status = latestBuildRunStatus(readDb, changeId);
  return status === "awaiting_human" || status === "approved_for_absorb";
}

function dryRunReviewGate(readDb: SqliteDatabase, changeId: string): ReviewBlockerGate | null {
  const row = readDb
    .prepare(`
      SELECT rr.gate_status AS gateStatus
      FROM review_state rs
      JOIN review_reports rr ON rr.id = rs.latest_valid_review_report_id
      WHERE rs.change_id = ?
        AND rr.gate_status IN ('blocked_p0', 'blocked_p1')
        AND rr.source_build_run_id = (
          SELECT COALESCE(adopted.build_run_id, adopted.id)
          FROM build_run_records adopted
          WHERE adopted.change_id = rs.change_id
            AND adopted.status = 'adopted'
          ORDER BY adopted.adopted_at DESC, adopted.updated_at DESC, adopted.id DESC
          LIMIT 1
        )
      LIMIT 1
    `)
    .get(changeId) as { gateStatus: string } | undefined;
  return row?.gateStatus === "blocked_p0" || row?.gateStatus === "blocked_p1"
    ? row.gateStatus
    : null;
}

function findRepairCandidates(readDb: SqliteDatabase): RepairCandidate[] {
  const candidates: RepairCandidate[] = [];

  for (const change of implementingChanges(readDb)) {
    const reviewGate = dryRunReviewGate(readDb, change.id);
    if (!reviewGate) continue;
    if (hasRunningRun(readDb, change.id)) continue;
    if (isAwaitingHumanBuildOrFix(readDb, change.id)) continue;

    candidates.push({ ...change, reviewGate });
  }

  return candidates;
}

function isBlockedReviewGate(reviewState: ReviewCenterState): boolean {
  return reviewState.gate.status === "blocked_p0" || reviewState.gate.status === "blocked_p1";
}

function applyRepair(
  candidate: RepairCandidate,
  reviewState: ReviewCenterState,
  transitionChangeStatus: TransitionChangeStatus,
): void {
  const rawJson = {
    recovery: RECOVERY_KIND,
    reviewGate: reviewState.gate,
  };

  transitionChangeStatus({
    changeId: candidate.id,
    to: "BLOCKED",
    blockedPhase: "review",
    message: "Audited recovery: polluted IMPLEMENTING Review blocker staged as BLOCKED before CHECK_FAILED.",
    rawJson,
  });

  transitionChangeStatus({
    changeId: candidate.id,
    to: "CHECK_FAILED",
    message: "Audited recovery: polluted IMPLEMENTING Review blocker restored to CHECK_FAILED.",
    rawJson,
  });
}

async function main(): Promise<void> {
  const readDb = openReadonlyDb();
  const candidates = findRepairCandidates(readDb);
  readDb.close();

  console.log(`Found ${candidates.length} polluted IMPLEMENTING Review blocker candidate(s).`);
  for (const candidate of candidates) {
    console.log(`- ${candidate.id}: ${candidate.title} (${candidate.reviewGate})`);
  }

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write audited status transitions.");
  } else {
    const { getReviewCenterState } = await import("../services/review-center-service");
    const { transitionChangeStatus } = await import("../services/change-status-service");

    let appliedCount = 0;
    for (const candidate of candidates) {
      const reviewState = (getReviewCenterState as GetReviewCenterState)(candidate.id);
      if (!isBlockedReviewGate(reviewState)) continue;

      applyRepair(
        candidate,
        reviewState,
        transitionChangeStatus as TransitionChangeStatus,
      );
      appliedCount += 1;
    }
    console.log(`Applied audited recovery to ${appliedCount} change(s).`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
