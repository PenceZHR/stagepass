import fs from "node:fs";
import path from "node:path";

import { recordBuildRunFromWorkspaceFile } from "./build-run-record-service";
import {
  buildRunPath,
  buildRunsDir,
  ensureSafeDirectory,
} from "./build-workspace-paths";
import type { BuildRunFile, BuildRunStatus } from "./build-types";

export { assertSafeChangeId, buildRunPath, buildRunsDir } from "./build-workspace-paths";

export function buildRunId(run: Pick<BuildRunFile, "runNumber">): string {
  return `build-${run.runNumber}`;
}

/**
 * The statuses that mean "a human approved this workspace as the change's
 * deliverable". Downstream stages (Review, QA) validate an approved workspace,
 * never merely the newest one. Mirrors the DB-side filter that
 * `review-qa-gate-service` applies to `build_run_records`, so the filesystem
 * and the DB agree on which BuildRun is authoritative.
 */
export function isApprovedBuildRunStatus(status: BuildRunStatus): boolean {
  return status === "approved_for_absorb" || status === "adopted";
}

/** Run numbers present on disk, newest first. */
function descendingRunNumbers(repoPath: string, changeId: string): number[] {
  const runsDir = buildRunsDir(repoPath, changeId);
  if (!fs.existsSync(runsDir)) return [];

  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => /^build-(\d+)\.json$/.exec(entry.name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1], 10))
    .sort((a, b) => b - a);
}

export function readLatestBuildRun(repoPath: string, changeId: string): BuildRunFile | null {
  const latestRunNumber = descendingRunNumbers(repoPath, changeId)[0];
  if (!latestRunNumber) return null;

  const runsDir = buildRunsDir(repoPath, changeId);
  const content = fs.readFileSync(path.join(runsDir, `build-${latestRunNumber}.json`), "utf-8");
  return JSON.parse(content) as BuildRunFile;
}

/**
 * The newest BuildRun a human approved, skipping any newer run that was never
 * approved. A failed or rejected fix run writes a higher-numbered build-N.json,
 * and that file must not shadow the adopted build the change actually carries —
 * otherwise QA can never resolve the workspace Review signed off on.
 */
export function readLatestApprovedBuildRun(repoPath: string, changeId: string): BuildRunFile | null {
  for (const runNumber of descendingRunNumbers(repoPath, changeId)) {
    const run = readBuildRunByNumber(repoPath, changeId, runNumber);
    if (run && isApprovedBuildRunStatus(run.status)) return run;
  }
  return null;
}

/**
 * The statuses that mean "this run is over and was never approved". Nothing more
 * will happen to it and no human decision is pending on it, so it is inert — a
 * newer run in one of these statuses must not shadow the approved BuildRun the
 * change actually carries.
 *
 * Deliberately a whitelist, because being wrong in the other direction is worse.
 * Every other unapproved status is still in play: `created` and `running` may yet
 * produce the deliverable, and `awaiting_human`/`gate_blocked` are exactly the two
 * statuses `rejectLatestBuildRun` accepts — the ones parked on a human decision.
 * `audit_ready` is declared in `BuildRunStatus` but written by no server path;
 * treat it as undecided rather than assume it away.
 */
export function isDeadBuildRunStatus(status: BuildRunStatus): boolean {
  return status === "failed" || status === "rejected";
}

export interface ApprovedBuildRunResolution {
  /** The approved BuildRun to operate on, or null when none is usable. */
  run: BuildRunFile | null;
  /**
   * The newer run that stopped the search, when it is still live or undecided.
   * A caller must refuse rather than fall back to an older approved run.
   */
  blockedBy: BuildRunFile | null;
}

/**
 * The approved BuildRun a stage may re-enter, skipping newer runs only once they
 * are dead.
 *
 * Unlike `readLatestApprovedBuildRun`, which answers "newest approved, period",
 * this refuses outright while a newer run is still live or awaiting a human:
 * re-running a stage then would validate a workspace that is about to be
 * superseded, or pre-empt a decision nobody has made yet. Callers that already
 * pin the run some other way — QA pins `sourceBuildRunId`, merge requires the
 * newest run on disk to be the approved one — do not need this and keep using
 * the simpler reader.
 */
export function resolveApprovedBuildRun(
  repoPath: string,
  changeId: string,
): ApprovedBuildRunResolution {
  for (const runNumber of descendingRunNumbers(repoPath, changeId)) {
    const run = readBuildRunByNumber(repoPath, changeId, runNumber);
    if (!run) continue;
    if (isApprovedBuildRunStatus(run.status)) return { run, blockedBy: null };
    if (isDeadBuildRunStatus(run.status)) continue;
    return { run: null, blockedBy: run };
  }
  return { run: null, blockedBy: null };
}

export function readBuildRunByNumber(
  repoPath: string,
  changeId: string,
  runNumber: number
): BuildRunFile | null {
  const targetPath = path.join(buildRunsDir(repoPath, changeId), `build-${runNumber}.json`);
  if (!fs.existsSync(targetPath)) return null;
  return JSON.parse(fs.readFileSync(targetPath, "utf-8")) as BuildRunFile;
}

export function readPreviousAdoptedBuildRun(
  repoPath: string,
  changeId: string,
  beforeRunNumber: number
): BuildRunFile | null {
  const runNumbers = descendingRunNumbers(repoPath, changeId)
    .filter((runNumber) => runNumber < beforeRunNumber);

  for (const runNumber of runNumbers) {
    const run = readBuildRunByNumber(repoPath, changeId, runNumber);
    if (run?.status === "adopted") return run;
  }
  return null;
}

export function writeBuildRun(repoPath: string, run: BuildRunFile): void {
  const targetPath = buildRunPath(repoPath, run);
  const dir = path.dirname(targetPath);
  ensureSafeDirectory(repoPath, run.changeId, dir);

  const tempPath = path.join(
    dir,
    `.build-${run.runNumber}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(run, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function markBuildRunRunning(input: {
  repoPath: string;
  changeId: string;
  run: BuildRunFile;
}): BuildRunFile {
  const runningRun: BuildRunFile = {
    ...input.run,
    status: "running",
    updatedAt: new Date().toISOString(),
  };
  writeBuildRun(input.repoPath, runningRun);
  recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, runningRun);
  return runningRun;
}

export function markBuildRunFailed(input: {
  repoPath: string;
  changeId: string;
  run: BuildRunFile;
  reason: string;
}): BuildRunFile {
  const failedRun: BuildRunFile = {
    ...input.run,
    status: "failed",
    blockers: [input.reason],
    updatedAt: new Date().toISOString(),
  };
  writeBuildRun(input.repoPath, failedRun);
  recordBuildRunFromWorkspaceFile(input.repoPath, input.changeId, failedRun);
  return failedRun;
}
