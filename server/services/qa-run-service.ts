import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { and, eq } from "drizzle-orm";

import {
  changes,
  qaCommandResults,
  qaEvidence,
  qaFailures,
  qaRuns,
} from "../db/schema";
import { getRequiredValidationCommands } from "./testplan-snapshot-service";
import {
  computeSourceDbHash,
  recomputeStageGate as recomputeAuthorityStageGate,
  type StageGateRecord,
} from "./stage-authority-service";

type QaRunDb = typeof import("../db/index").db;
export type QaRunRecord = typeof qaRuns.$inferSelect;
export type QaCommandResultRecord = typeof qaCommandResults.$inferSelect;

export interface StartQaRunInput {
  changeId: string;
  sourceReviewReportId?: string | null;
  sourceBuildRunId?: string | null;
  sourceHeadSha?: string | null;
  idempotencyKey?: string | null;
  startedAt?: string;
}

export interface RecordQaCommandResultInput {
  qaRunId: string;
  command: string;
  commandOrder: number;
  status: "pending" | "passed" | "failed" | "skipped";
  exitCode?: number | null;
  durationMs?: number | null;
  outputArtifactMirrorId?: string | null;
  evidence?: string | null;
  evidenceContentHash?: string | null;
  requiredFix?: string | null;
  completedAt?: string | null;
}

export interface FailQaRunInput {
  qaRunId: string;
  reason: string;
  completedAt?: string;
}

const requireDefaultDb = createRequire(import.meta.url);
let qaRunDbForTest: QaRunDb | null = null;
let defaultQaRunDb: QaRunDb | null = null;

export function setQaRunServiceDbForTest(nextDb: QaRunDb): () => void {
  const previous = qaRunDbForTest;
  qaRunDbForTest = nextDb;
  return () => {
    qaRunDbForTest = previous;
  };
}

function getQaRunDb(): QaRunDb {
  if (qaRunDbForTest) return qaRunDbForTest;
  if (!defaultQaRunDb) {
    defaultQaRunDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultQaRunDb;
}

function nowISO(): string {
  return new Date().toISOString();
}

function nextId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * qa_evidence.content_hash is a sha256 of the mirrored command log, or null.
 * It previously fell back to the raw evidence summary, so rows landed holding
 * literal text like "passed" in a column every reader treats as a hash. Reject
 * anything that is not a sha256 rather than persisting a lie.
 */
function assertContentHash(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function latestQaRun(db: QaRunDb, changeId: string): QaRunRecord | null {
  const rows = db.select().from(qaRuns).where(eq(qaRuns.changeId, changeId)).all();
  return rows.sort((left, right) => {
    const started = right.startedAt.localeCompare(left.startedAt);
    if (started !== 0) return started;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

function commandRows(db: QaRunDb, qaRunId: string): QaCommandResultRecord[] {
  return db
    .select()
    .from(qaCommandResults)
    .where(eq(qaCommandResults.qaRunId, qaRunId))
    .all()
    .sort((left, right) => left.commandOrder - right.commandOrder || left.id.localeCompare(right.id));
}

function failureRows(db: QaRunDb, qaRunId: string): Array<typeof qaFailures.$inferSelect> {
  return db.select().from(qaFailures).where(eq(qaFailures.qaRunId, qaRunId)).all();
}

function evidenceRows(db: QaRunDb, qaRunId: string): Array<typeof qaEvidence.$inferSelect> {
  return db.select().from(qaEvidence).where(eq(qaEvidence.qaRunId, qaRunId)).all();
}

export function startQaRun(input: StartQaRunInput): QaRunRecord {
  const db = getQaRunDb();
  const existingChange = db.select().from(changes).where(eq(changes.id, input.changeId)).get();
  if (!existingChange) {
    throw new Error(`Change not found: ${input.changeId}`);
  }

  const startedAt = input.startedAt ?? nowISO();
  const run: QaRunRecord = {
    id: nextId("QA-RUN"),
    changeId: input.changeId,
    sourceReviewReportId: input.sourceReviewReportId ?? null,
    sourceBuildRunId: input.sourceBuildRunId ?? null,
    sourceHeadSha: input.sourceHeadSha ?? null,
    status: "running",
    startedAt,
    completedAt: null,
  };
  db.insert(qaRuns).values(run).run();

  const commands = getRequiredValidationCommands(input.changeId);
  commands.forEach((command, index) => {
    db.insert(qaCommandResults).values({
      id: nextId("QA-CMD"),
      qaRunId: run.id,
      command,
      commandOrder: index + 1,
      status: "pending",
      exitCode: null,
      durationMs: null,
      outputArtifactMirrorId: null,
      completedAt: null,
    }).run();
  });

  return run;
}

export function recordQaCommandResult(
  input: RecordQaCommandResultInput,
): QaCommandResultRecord {
  const db = getQaRunDb();
  const run = db.select().from(qaRuns).where(eq(qaRuns.id, input.qaRunId)).get();
  if (!run) {
    throw new Error(`QA run not found: ${input.qaRunId}`);
  }
  const completedAt = input.completedAt ?? nowISO();
  const existing = db
    .select()
    .from(qaCommandResults)
    .where(
      and(
        eq(qaCommandResults.qaRunId, input.qaRunId),
        eq(qaCommandResults.commandOrder, input.commandOrder),
      ),
    )
    .get();
  const values = {
    qaRunId: input.qaRunId,
    command: input.command,
    commandOrder: input.commandOrder,
    status: input.status,
    exitCode: input.exitCode ?? null,
    durationMs: input.durationMs ?? null,
    outputArtifactMirrorId: input.outputArtifactMirrorId ?? null,
    completedAt: input.status === "pending" ? null : completedAt,
  };

  const result = existing
    ? (() => {
        db.update(qaCommandResults).set(values).where(eq(qaCommandResults.id, existing.id)).run();
        return { ...existing, ...values };
      })()
    : (() => {
        const inserted = { id: nextId("QA-CMD"), ...values };
        db.insert(qaCommandResults).values(inserted).run();
        return inserted;
      })();

  if (input.evidence || input.evidenceContentHash || input.outputArtifactMirrorId) {
    db.insert(qaEvidence).values({
      id: nextId("QA-EVD"),
      qaRunId: input.qaRunId,
      evidenceType: "command_log",
      artifactMirrorId: input.outputArtifactMirrorId ?? null,
      // content_hash holds a hash or nothing. It must never fall back to the
      // raw evidence text (the human-readable summary lives on qa_failures).
      contentHash: assertContentHash(input.evidenceContentHash),
      createdAt: completedAt,
    }).run();
  }

  if (input.status === "failed") {
    const existingFailure = db
      .select()
      .from(qaFailures)
      .where(
        and(
          eq(qaFailures.qaRunId, input.qaRunId),
          eq(qaFailures.commandResultId, result.id),
        ),
      )
      .get();
    const failureValues = {
      qaRunId: input.qaRunId,
      commandResultId: result.id,
      severity: "P1",
      title: `${input.command} failed`,
      evidence: input.evidence ?? `exit_code=${input.exitCode ?? "unknown"}`,
      requiredFix: input.requiredFix ?? `Fix QA command: ${input.command}`,
      status: "open",
      createdAt: completedAt,
    };
    if (existingFailure) {
      db.update(qaFailures)
        .set(failureValues)
        .where(eq(qaFailures.id, existingFailure.id))
        .run();
    } else {
      db.insert(qaFailures).values({ id: nextId("QA-FAL"), ...failureValues }).run();
    }
  }

  return result;
}

export function failQaRun(input: FailQaRunInput): QaRunRecord {
  const db = getQaRunDb();
  const run = db.select().from(qaRuns).where(eq(qaRuns.id, input.qaRunId)).get();
  if (!run) {
    throw new Error(`QA run not found: ${input.qaRunId}`);
  }

  const completedAt = input.completedAt ?? nowISO();
  const commands = commandRows(db, input.qaRunId);
  const pending = commands.find((command) => command.status === "pending");
  recordQaCommandResult({
    qaRunId: input.qaRunId,
    commandOrder: pending?.commandOrder ?? commands.length + 1,
    command: pending?.command ?? "QA execution",
    status: "failed",
    exitCode: null,
    durationMs: null,
    evidence: input.reason,
    requiredFix: "Fix the QA execution failure and retry QA.",
    completedAt,
  });

  db.update(qaRuns)
    .set({ status: "failed", completedAt })
    .where(eq(qaRuns.id, run.id))
    .run();
  return { ...run, status: "failed", completedAt };
}

export function recomputeQaGate(changeId: string): StageGateRecord {
  const db = getQaRunDb();
  const run = latestQaRun(db, changeId);
  if (!run) {
    return recomputeAuthorityStageGate({
      changeId,
      phase: "QA",
      status: "missing",
      blockers: [{ id: "qa_run", severity: "P1", title: "QA run is missing" }],
      freshness: { fresh: false, reason: "qa_run_missing" },
      requiredActions: ["run_qa"],
      rows: [],
    });
  }

  const commands = commandRows(db, run.id);
  const failures = failureRows(db, run.id);
  const evidence = evidenceRows(db, run.id);
  const requiredCommands = getRequiredValidationCommands(changeId);
  const hasPending = commands.some((command) => command.status === "pending");
  const hasFailed = commands.some((command) => command.status === "failed") || failures.length > 0;
  const hasAllRequiredCommands =
    requiredCommands.length > 0 &&
    requiredCommands.every((command) => commands.some((row) => row.command === command));
  const status = hasFailed
    ? "failed"
    : hasPending || !hasAllRequiredCommands
      ? "running"
      : "passed";
  const completedAt = status === "running" ? null : nowISO();

  db.update(qaRuns)
    .set({ status, completedAt })
    .where(eq(qaRuns.id, run.id))
    .run();

  const rows = [
    { table: "qa_runs", ...run, status, completedAt },
    ...commands.map((row) => ({ table: "qa_command_results", ...row })),
    ...failures.map((row) => ({ table: "qa_failures", ...row })),
    ...evidence.map((row) => ({ table: "qa_evidence", ...row })),
  ];
  const sourceDbHash = computeSourceDbHash({ changeId, phase: "QA", rows });
  return recomputeAuthorityStageGate({
    changeId,
    phase: "QA",
    status,
    blockers: failures.map((failure) => ({
      id: failure.id,
      severity: failure.severity,
      title: failure.title ?? "QA failure",
    })),
    freshness: {
      fresh: true,
      sourceHeadSha: run.sourceHeadSha,
    },
    requiredActions: status === "passed" ? [] : ["retry_qa"],
    sourceDbHash,
    rows,
  });
}
