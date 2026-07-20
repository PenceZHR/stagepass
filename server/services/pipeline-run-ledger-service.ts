import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import { runLedgerRepository } from "../repositories/run-ledger-repository";
import type { ChangeStatus } from "../types";
import type { Provider } from "./provider-selection-service";
import { transitionChangeStatus, transitionChangeStatusWithDb } from "./change-status-service";
import { withCurrentExecutionFenceWrite } from "./execution-fence-service";
import type { StageViolationResult } from "./stage-guard-service";

export class StageBoundaryViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageBoundaryViolationError";
  }
}

export function nextRunLedgerId(prefix: string): string;
export function nextRunLedgerId(_legacyTable: unknown, prefix: string): string;
export function nextRunLedgerId(prefixOrLegacyTable: string | unknown, prefix?: string): string {
  return runLedgerRepository.nextRunLedgerId(prefix ?? String(prefixOrLegacyTable));
}

export function nowISO(): string {
  return new Date().toISOString();
}

export async function insertArtifact(
  changeId: string,
  runId: string,
  type: string,
  filePath: string,
): Promise<string> {
  const artId = await nextRunLedgerId("ART");
  runLedgerRepository.insertArtifact({
    id: artId,
    changeId,
    runId,
    type,
    path: filePath,
    createdAt: nowISO(),
  });
  return artId;
}

export function changeDir(repoPath: string, changeId: string): string {
  return path.join(repoPath, ".ship", "changes", changeId);
}

export function runArtifactDir(repoPath: string, changeId: string, runId: string): string {
  return path.join(changeDir(repoPath, changeId), "runs", runId);
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

async function recordPostCommitArtifactFailure(input: {
  changeId: string;
  runId: string;
  phase: string;
  artifactType: string;
  fileName: string;
  sideEffect: "default_artifact_write" | "run_artifact_write";
  error: unknown;
}): Promise<void> {
  try {
    const summary = errorSummary(input.error);
    const evtId = await nextRunLedgerId("EVT");
    runLedgerRepository.insertEvent({
      id: evtId,
      changeId: input.changeId,
      runId: input.runId,
      type: "document_stage_post_commit_side_effect_failed",
      message: `Document stage post-commit side-effect failed: ${input.artifactType}/${input.fileName}`,
      rawJson: JSON.stringify({
        phase: input.phase,
        runId: input.runId,
        sideEffect: input.sideEffect,
        artifactType: input.artifactType,
        fileName: input.fileName,
        errorSummary: summary,
      }),
      createdAt: nowISO(),
    });
  } catch {
    // Best-effort telemetry must not turn a committed stage result into failure.
  }
}

export async function recordPostCommitSideEffectFailure(input: {
  changeId: string;
  runId: string;
  phase: string;
  sideEffect: string;
  message: string;
  error: unknown;
  rawJson?: Record<string, unknown>;
}): Promise<void> {
  try {
    const summary = errorSummary(input.error);
    const evtId = await nextRunLedgerId("EVT");
    runLedgerRepository.insertEvent({
      id: evtId,
      changeId: input.changeId,
      runId: input.runId,
      type: "stage_post_commit_side_effect_failed",
      message: input.message,
      rawJson: JSON.stringify({
        phase: input.phase,
        runId: input.runId,
        sideEffect: input.sideEffect,
        errorSummary: summary,
        ...(input.rawJson ?? {}),
      }),
      createdAt: nowISO(),
    });
  } catch {
    // Best-effort telemetry must not turn a committed stage result into failure.
  }
}

export async function writeRunArtifact(
  repoPath: string,
  changeId: string,
  runId: string,
  type: string,
  fileName: string,
  content: string
): Promise<{ currentPath: string; runPath: string }> {
  const currentDir = changeDir(repoPath, changeId);
  const runDir = runArtifactDir(repoPath, changeId, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(currentDir, { recursive: true });

  const currentPath = path.join(currentDir, fileName);
  const runPath = path.join(runDir, fileName);
  fs.writeFileSync(currentPath, content);
  fs.writeFileSync(runPath, content);
  const artifactId = await insertArtifact(changeId, runId, type, runPath);
  if (type === "release_note") {
    // Persist the immutable approved-content hash so the retro action authority
    // can trust the DB instead of re-hashing this run-scoped copy on disk. The
    // run and current copies are written from the same `content`, so this hash
    // matches both at approval time; the current copy is later re-hashed live to
    // detect drift against this value.
    runLedgerRepository.insertReleaseNoteState({
      id: `RNS-${crypto.randomUUID()}`,
      changeId,
      runId,
      artifactId,
      approvedContentHash: crypto.createHash("sha256").update(content).digest("hex"),
      createdAt: nowISO(),
    });
  }
  return { currentPath, runPath };
}

export async function writeRunOnlyArtifact(
  repoPath: string,
  changeId: string,
  runId: string,
  type: string,
  fileName: string,
  content: string
): Promise<{ runPath: string }> {
  const runDir = runArtifactDir(repoPath, changeId, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const runPath = path.join(runDir, fileName);
  fs.writeFileSync(runPath, content);
  await insertArtifact(changeId, runId, type, runPath);
  return { runPath };
}

export async function writeRunArtifactBestEffort(
  repoPath: string,
  changeId: string,
  runId: string,
  phase: string,
  type: string,
  fileName: string,
  content: string
): Promise<{ currentPath: string; runPath: string } | null> {
  try {
    return await writeRunArtifact(repoPath, changeId, runId, type, fileName, content);
  } catch (error) {
    await recordPostCommitArtifactFailure({
      changeId,
      runId,
      phase,
      artifactType: type,
      fileName,
      sideEffect: "default_artifact_write",
      error,
    });
    return null;
  }
}

export async function writeRunOnlyArtifactBestEffort(
  repoPath: string,
  changeId: string,
  runId: string,
  phase: string,
  type: string,
  fileName: string,
  content: string
): Promise<{ runPath: string } | null> {
  try {
    return await writeRunOnlyArtifact(repoPath, changeId, runId, type, fileName, content);
  } catch (error) {
    await recordPostCommitArtifactFailure({
      changeId,
      runId,
      phase,
      artifactType: type,
      fileName,
      sideEffect: "run_artifact_write",
      error,
    });
    return null;
  }
}

export async function setStatus(
  changeId: string,
  status: ChangeStatus,
  blockedPhase?: string | null,
): Promise<void> {
  transitionChangeStatus({
    changeId,
    to: status,
    blockedPhase,
    message: `Status → ${status}`,
    rawJson: { status },
  });
}

/**
 * Stops every running run for the change and advances the status in ONE
 * transaction -- used by GraphRunner's stop/block operations, which stop an
 * arbitrary number of running runs rather than one specific run id (so this
 * doesn't fit beginStageRun/endStageRun's single-runId shape).
 *
 * As two transactions, a crash in between leaves every run `stopped` (terminal)
 * with the status still at the running phase -- the same dead end as the other
 * D6 findings, just triggered by a user action (Stop/Block) instead of a crash
 * mid-stage. See docs/state-projection-audit-2026-07-14.md.
 */
export function stopActiveRunsAndSetStatus(input: {
  changeId: string;
  status: ChangeStatus;
  blockedPhase?: string | null;
  message?: string;
  rawJson?: Record<string, unknown>;
}): void {
  withCurrentExecutionFenceWrite("run-ledger.stop-active-runs-and-set-status", undefined, (tx) => {
    runLedgerRepository.stopActiveRunsWithDb(tx, input.changeId, nowISO());
    transitionChangeStatusWithDb(tx, {
      changeId: input.changeId,
      to: input.status,
      blockedPhase: input.blockedPhase,
      message: input.message ?? `Status → ${input.status}`,
      rawJson: input.rawJson ?? { status: input.status },
    });
  });
}

/**
 * Advances the change status and creates the run row in ONE transaction.
 *
 * Doing these as two transactions is what leaves a change with an advanced
 * status and no run row behind it -- and recovery selects its candidates from
 * `runs` (stale-provider-run-recovery-service.ts:267), so it never sees that
 * change again. See docs/state-projection-audit-2026-07-14.md.
 */
export function beginStageRun(input: {
  changeId: string;
  phase: string;
  runningStatus: ChangeStatus;
  provider?: Provider;
  runId?: string;
}): string {
  const id = input.runId ?? nextRunLedgerId("RUN");
  withCurrentExecutionFenceWrite("run-ledger.begin-stage-run", undefined, (tx) => {
    transitionChangeStatusWithDb(tx, {
      changeId: input.changeId,
      to: input.runningStatus,
      message: `Status → ${input.runningStatus}`,
      rawJson: { status: input.runningStatus },
    });
    runLedgerRepository.createRunWithDb(tx, {
      id,
      changeId: input.changeId,
      phase: input.phase,
      status: "running",
      startedAt: nowISO(),
      endedAt: null,
      summary: null,
      provider: input.provider ?? null,
    });
  });
  return id;
}

/**
 * Ends the run and advances the change status in ONE transaction -- the exit-side
 * counterpart to beginStageRun.
 *
 * endRun()-then-setStatus() as two transactions is the D6 audit's "Tier 1"
 * finding (docs/state-projection-audit-2026-07-14.md): a crash in between leaves
 * the run terminal but the status still at the running phase. Since the run is
 * already terminal, recovery's candidate query (which only selects `running`
 * runs) never sees the change again -- same dead end as the entry-side gap
 * beginStageRun closes, just on exit.
 */
export function endStageRun(input: {
  changeId: string;
  runId: string;
  status: ChangeStatus;
  summary: string;
  success: boolean;
  blockedPhase?: string | null;
}): void {
  withCurrentExecutionFenceWrite("run-ledger.end-stage-run", input.runId, (tx) => {
    runLedgerRepository.endRunWithDb(tx, input.runId, {
      status: input.success ? "completed" : "failed",
      endedAt: nowISO(),
      summary: input.summary,
    });
    transitionChangeStatusWithDb(tx, {
      changeId: input.changeId,
      to: input.status,
      blockedPhase: input.blockedPhase,
      message: `Status → ${input.status}`,
      rawJson: { status: input.status },
    });
  });
}

export function createRun(changeId: string, phase: string, provider?: Provider): string {
  const id = nextRunLedgerId("RUN");
  runLedgerRepository.createRun({
    id,
    changeId,
    phase,
    status: "running",
    startedAt: nowISO(),
    endedAt: null,
    summary: null,
    provider: provider ?? null,
  });
  return id;
}

export function endRun(runId: string, summary: string, success: boolean): void {
  runLedgerRepository.endRun(runId, {
    status: success ? "completed" : "failed",
    endedAt: nowISO(),
    summary,
  });
}

export async function blockStageViolation(
  changeId: string,
  runId: string,
  violation: StageViolationResult
): Promise<never> {
  // The finding and event reference runId but don't depend on the run's ended
  // state, so they run first; endStageRun lands last with nothing after it,
  // closing the "run ended but status never advanced" crash window (D6 audit).
  const fId = await nextRunLedgerId("FND");
  runLedgerRepository.insertFinding({
    id: fId,
    changeId,
    runId,
    source: "scope",
    severity: "P0",
    category: "stage-boundary",
    title: `${violation.stage} stage boundary violation`,
    file: violation.files[0] ?? null,
    line: null,
    evidence: violation.files.join(", "),
    requiredFix: "Revert the out-of-scope file changes and rerun the correct phase.",
    status: "open",
    createdAt: nowISO(),
  });

  const evtId = await nextRunLedgerId("EVT");
  runLedgerRepository.insertEvent({
    id: evtId,
    changeId,
    runId,
    type: "scope_check_failed",
    message: violation.message,
    rawJson: JSON.stringify(violation),
    createdAt: nowISO(),
  });

  endStageRun({
    changeId, runId, status: "BLOCKED", blockedPhase: violation.stage,
    summary: violation.message, success: false,
  });
  throw new StageBoundaryViolationError(violation.message);
}
