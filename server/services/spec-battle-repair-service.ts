import fs from "fs";
import path from "path";
import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { battleRounds, changes, events, projects, runs, stageRuns } from "../db/schema";

export interface RepairStuckSpecRoundsOptions {
  changeId?: string;
  execute?: boolean;
  minAgeMs?: number;
  now?: Date;
}

export interface RepairStuckSpecRoundResult {
  roundId: string;
  changeId: string;
  roundNo: number;
  action: "would_repair" | "repaired" | "refused";
  reasons: string[];
}

const DEFAULT_MIN_AGE_MS = 5 * 60 * 1000;
const ACTIVE_STAGE_PROGRESS_STATUSES = new Set([
  "started",
  "provider_running",
  "ingesting",
  "file_candidate",
  "repairing",
]);

function roundRedArtifactPath(repoPath: string, changeId: string, roundNo: number): string {
  return path.join(
    repoPath,
    ".ship",
    "changes",
    changeId,
    "rounds",
    `spec-round-${String(roundNo).padStart(2, "0")}-red.md`,
  );
}

function latestRoundForChange(changeId: string): typeof battleRounds.$inferSelect | null {
  return db
    .select()
    .from(battleRounds)
    .where(eq(battleRounds.changeId, changeId))
    .all()
    .sort((a, b) => b.roundNo - a.roundNo || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

function parseStageProgress(rawJson: string | null): {
  phase?: string;
  status?: string;
} | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const progress = (parsed as { stageProgress?: unknown }).stageProgress;
    if (!progress || typeof progress !== "object") return null;
    return progress as { phase?: string; status?: string };
  } catch {
    return null;
  }
}

function hasRecentActiveSpecStageProgress(changeId: string, input: { now: Date; minAgeMs: number }): boolean {
  return db
    .select()
    .from(events)
    .where(and(eq(events.changeId, changeId), eq(events.type, "stage_progress")))
    .all()
    .some((event) => {
      const progress = parseStageProgress(event.rawJson);
      if (!progress) return false;
      if (progress.phase?.toLowerCase() !== "spec") return false;
      if (!progress.status || !ACTIVE_STAGE_PROGRESS_STATUSES.has(progress.status)) return false;
      const ageMs = input.now.getTime() - Date.parse(event.createdAt);
      return Number.isFinite(ageMs) && ageMs < input.minAgeMs;
    });
}

function refusalReasons(
  round: typeof battleRounds.$inferSelect,
  input: { repoPath: string; now: Date; minAgeMs: number },
): string[] {
  const reasons: string[] = [];
  const latest = latestRoundForChange(round.changeId);
  if (!latest || latest.id !== round.id) reasons.push("not_latest_round");
  if (round.status !== "red_running") reasons.push("status_not_red_running");
  if (round.redArtifactPath || round.redArtifactHash) reasons.push("red_artifact_present");
  if (round.blueArtifactPath || round.blueArtifactHash || round.reportPath) reasons.push("blue_or_report_artifact_present");
  const ageMs = input.now.getTime() - Date.parse(round.startedAt);
  if (!Number.isFinite(ageMs) || ageMs < input.minAgeMs) reasons.push("round_too_young");
  const activeSpecRun = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.changeId, round.changeId), eq(runs.phase, "spec"), eq(runs.status, "running")))
    .get();
  if (activeSpecRun) reasons.push("active_spec_run");
  const activeStageRun = db
    .select({ id: stageRuns.id })
    .from(stageRuns)
    .where(and(eq(stageRuns.changeId, round.changeId), eq(stageRuns.phase, "Spec"), eq(stageRuns.status, "running")))
    .get();
  if (activeStageRun) reasons.push("active_spec_stage_run");
  if (hasRecentActiveSpecStageProgress(round.changeId, input)) {
    reasons.push("active_spec_stage_progress");
  }
  if (fs.existsSync(roundRedArtifactPath(input.repoPath, round.changeId, round.roundNo))) {
    reasons.push("red_artifact_file_present");
  }
  return reasons;
}

export function repairStuckSpecRounds(
  options: RepairStuckSpecRoundsOptions = {},
): RepairStuckSpecRoundResult[] {
  const now = options.now ?? new Date();
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const changeRows = options.changeId
    ? db.select().from(changes).where(eq(changes.id, options.changeId)).all()
    : db.select().from(changes).all();
  const results: RepairStuckSpecRoundResult[] = [];

  for (const change of changeRows) {
    const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
    if (!project) continue;
    const rounds = db
      .select()
      .from(battleRounds)
      .where(eq(battleRounds.changeId, change.id))
      .all()
      .filter((round) => round.status === "red_running");
    for (const round of rounds) {
      const reasons = refusalReasons(round, { repoPath: project.repoPath, now, minAgeMs });
      if (reasons.length > 0) {
        results.push({ roundId: round.id, changeId: round.changeId, roundNo: round.roundNo, action: "refused", reasons });
        continue;
      }
      if (options.execute) {
        db.update(battleRounds)
          .set({ status: "not_started", updatedAt: now.toISOString(), endedAt: null })
          .where(eq(battleRounds.id, round.id))
          .run();
      }
      results.push({
        roundId: round.id,
        changeId: round.changeId,
        roundNo: round.roundNo,
        action: options.execute ? "repaired" : "would_repair",
        reasons: [],
      });
    }
  }

  return results;
}
