import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { runLedgerRepository } from "../repositories/run-ledger-repository";
import { changes, findings, projects } from "../db/schema";
import { createChildLogger } from "../logger";
import type { Change, ChangeStatus } from "../types";
import type { JobExecutionContext } from "./job-execution-context";
import { withExecutionFence } from "./execution-fence-service";
import { runLocalChecks } from "./local-check-service";
import { renderMirrorsFromDb } from "./artifact-mirror-service";
import {
  actionNotAllowedEnvelope,
  PreflightBlockedError,
} from "./preflight-service";
import {
  blockStageViolation,
  changeDir,
  insertArtifact,
  nextRunLedgerId as nextId,
  nowISO,
  runArtifactDir,
} from "./pipeline-run-ledger-service";
import { runQaLocalCheckWithLedger } from "./stage-orchestrator-service";
import {
  failQaRun,
  recordQaCommandResult,
  recomputeQaGate,
  startQaRun,
} from "./qa-run-service";
import {
  assertCanEnterQa,
  ReviewQaGateError,
  type ReviewQaGateActor,
  type ReviewQaGateEntrypoint,
  type ReviewQaGateResult,
} from "./review-qa-gate-service";
import { runScopeCheck } from "./scope-check-service";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  validateLocalCheckScope,
} from "./stage-guard-service";
import { getStageAuthority } from "./stage-authority-service";
import { getRequiredValidationCommands } from "./testplan-snapshot-service";
import { buildRunId, readLatestApprovedBuildRun } from "./build-workspace-service";
import { computeMergeReadiness } from "./merge-readiness-service";

const log = createChildLogger("pipeline-service");

const QA_LOG_MIRROR_SCHEMA_VERSION = "qa-log/v1";

function getProject(projectId: string) {
  return db.select().from(projects).where(eq(projects.id, projectId)).get();
}

function getChange(changeId: string): Change | undefined {
  return db.select().from(changes).where(eq(changes.id, changeId)).get() as Change | undefined;
}

/**
 * A TestPlan precondition QA refuses on. Typed rather than a bare Error so the
 * catch below can tell "QA is not allowed yet, and here is which rule said so"
 * apart from "something broke in here" -- the two used to be indistinguishable
 * and both came back as a reasonless 409.
 *
 * The codes match action-contract-qa-policy.ts's, so the contract and the
 * assertion name the same fault the same way instead of the caller having to
 * map between two vocabularies.
 */
export class TestPlanGateNotReadyError extends Error {
  constructor(
    public readonly code:
      | "test_plan_gate_missing"
      | "test_plan_blocked"
      | "test_plan_commands_missing",
    message: string,
  ) {
    super(message);
    this.name = "TestPlanGateNotReadyError";
  }
}

function assertTestPlanGatePassed(changeId: string): void {
  const snapshot = getStageAuthority(changeId, "TestPlan");
  const gate = snapshot.latestGate;
  if (!gate) {
    throw new TestPlanGateNotReadyError("test_plan_gate_missing", "TestPlan gate is missing");
  }
  if (gate.status !== "passed" && gate.status !== "passed_with_warnings") {
    throw new TestPlanGateNotReadyError(
      "test_plan_blocked",
      `TestPlan gate is ${gate.status}`,
    );
  }
  const commands = getRequiredValidationCommands(changeId);
  if (commands.length === 0) {
    throw new TestPlanGateNotReadyError(
      "test_plan_commands_missing",
      "TestPlan required commands are missing",
    );
  }
}

export interface RunCheckOptions {
  entrypoint?: ReviewQaGateEntrypoint;
  actor?: ReviewQaGateActor;
  expectedHeadSha?: string;
}

export function assertCanRunCheck(
  changeId: string,
  options: RunCheckOptions = {},
): ReviewQaGateResult {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);

  try {
    const qaEntry = assertCanEnterQa({
      projectId: change.projectId,
      changeId,
      entrypoint: options.entrypoint ?? "run_check",
      actor: options.actor ?? "system",
      expectedHeadSha: options.expectedHeadSha,
    });
    assertTestPlanGatePassed(changeId);
    return qaEntry;
  } catch (error) {
    // `error instanceof Error` used to sit in this condition, which is true for
    // very nearly everything thrown in JS -- so a TypeError, a SQLite failure,
    // or any other genuine fault was relabelled "action_not_allowed" and its
    // message and stack were dropped on the floor. The `throw error` that
    // followed was unreachable for the same reason. Only the two refusals below
    // are answers this function is entitled to give; anything else is a fault
    // and has to keep travelling with its own message.
    //
    // The envelope also gets the real reason now. Without an override,
    // actionNotAllowedEnvelope rebuilds it from the CURRENT contract, so a 409
    // could carry `error: "action_not_allowed"` next to `enabled: true,
    // reasonCode: null` -- and persist that contradiction via
    // persistActionContract.
    //
    // No test pins the override, and that is not an oversight: the contract's
    // enter_qa policy calls assertCanEnterQa itself (action-contract-qa-policy),
    // so contract and assertion agree in every state that can be constructed,
    // and the rebuilt envelope happens to be right. The gap is a race -- state
    // moving between the refusal and the rebuild -- which has no deterministic
    // fixture. The override is what makes the envelope describe *this attempt's*
    // refusal by construction instead of by coincidence, so a 409 can never
    // hand the client `enabled: true` to immediately retry against. The full
    // fresh contract still travels in the envelope's `actions` for re-syncing.
    if (error instanceof ReviewQaGateError) {
      throw new PreflightBlockedError(
        actionNotAllowedEnvelope(changeId, "enter_qa", {
          enabled: false,
          reasonCode: error.code,
          reason: error.details.reason ?? error.message,
        }),
      );
    }
    if (error instanceof TestPlanGateNotReadyError) {
      throw new PreflightBlockedError(
        actionNotAllowedEnvelope(changeId, "enter_qa", {
          enabled: false,
          reasonCode: error.code,
          reason: error.message,
        }),
      );
    }
    throw error;
  }
}

export async function runCheck(
  changeId: string,
  context: JobExecutionContext,
  options: RunCheckOptions = {},
): Promise<void> {
  return withExecutionFence(context, () => runCheckInExecutionScope(changeId, options));
}

async function runCheckInExecutionScope(
  changeId: string,
  options: RunCheckOptions,
): Promise<void> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  const qaEntry = assertCanRunCheck(changeId, options);
  // Resolve the newest *approved* BuildRun, not the newest run on disk. A failed
  // fix run leaves a higher-numbered build-N.json behind, and picking by number
  // would let it shadow the adopted build the Review gate approved — QA would
  // then be permanently unsatisfiable with no way out through the UI.
  const approvedBuildRun = readLatestApprovedBuildRun(project.repoPath, changeId);
  if (!approvedBuildRun) {
    throw new Error("QA requires an approved Build workspace");
  }
  // The gate resolved the same question against the DB. Requiring both stores to
  // name the same BuildRun keeps QA from validating a workspace Review never saw.
  const approvedBuildRunId = buildRunId(approvedBuildRun);
  if (qaEntry.sourceBuildRunId !== approvedBuildRunId) {
    throw new Error(`QA source BuildRun mismatch: expected ${qaEntry.sourceBuildRunId}, got ${approvedBuildRunId}`);
  }
  if (!fs.existsSync(approvedBuildRun.workspacePath)) {
    throw new Error(`QA approved Build workspace is missing: ${approvedBuildRun.workspacePath}`);
  }
  const qaRepoPath = approvedBuildRun.workspacePath;
  const requiredCommands = getRequiredValidationCommands(changeId);
  const qaRun = startQaRun({
    changeId,
    sourceReviewReportId: qaEntry.reportId,
    sourceBuildRunId: qaEntry.sourceBuildRunId,
    sourceHeadSha: qaEntry.sourceHeadSha ?? options.expectedHeadSha ?? null,
  });

  await runQaLocalCheckWithLedger({
    changeId,
    async beforeFinalStatus() {
      recomputeQaGate(changeId);
    },
    onFailureBeforeStatus({ summary }) {
      failQaRun({ qaRunId: qaRun.id, reason: summary });
      recomputeQaGate(changeId);
    },
    onFailureRecoveryError(recoveryErr) {
      log.error({ changeId, err: String(recoveryErr) }, "Failed to mark QA run failed after Check error");
    },
    async execute({ runId }) {
      const beforeCheck = captureWorkspaceSnapshot(qaRepoPath);
      const runDir = runArtifactDir(project.repoPath, changeId, runId);
      fs.mkdirSync(runDir, { recursive: true });
      // Run local checks
      const localResult = runLocalChecks(qaRepoPath, changeId, runDir, {
        requiredCommands,
      });
      // Mirror each command log so its sha256 is the QA evidence content hash.
      // The log lives under runDir (inside the change artifact dir), so the
      // mirror path guard accepts it. A command that produced no readable log
      // gets no mirror, and its evidence hash stays null rather than fabricated.
      const qaLogMirrors = localResult.checks.map((check) => {
        if (!check.logPath || !fs.existsSync(check.logPath)) return null;
        try {
          return renderMirrorsFromDb({
            changeId,
            repoPath: project.repoPath,
            mirrors: [{
              phase: "QA",
              artifactType: "qa_log",
              path: check.logPath,
              schemaVersion: QA_LOG_MIRROR_SCHEMA_VERSION,
              content: fs.readFileSync(check.logPath, "utf-8"),
              sourceRows: [{
                qaRunId: qaRun.id,
                command: check.command,
                exitCode: check.exitCode,
                durationMs: check.durationMs,
                success: check.success,
              }],
            }],
          })[0] ?? null;
        } catch (mirrorErr) {
          log.warn(
            { changeId, command: check.command, err: String(mirrorErr) },
            "Failed to mirror QA command log; recording evidence without a mirror",
          );
          return null;
        }
      });
      for (const [index, check] of localResult.checks.entries()) {
        const mirror = qaLogMirrors[index];
        recordQaCommandResult({
          qaRunId: qaRun.id,
          commandOrder: index + 1,
          command: check.command,
          status: check.success ? "passed" : "failed",
          exitCode: check.exitCode,
          durationMs: check.durationMs,
          evidence: check.summary,
          outputArtifactMirrorId: mirror?.id ?? null,
          evidenceContentHash: mirror?.contentHash ?? null,
          requiredFix: check.success ? null : `Fix all ${check.name} errors shown in evidence`,
        });
      }

      // Run scope check
      const scopeResult = runScopeCheck(qaRepoPath, changeId, runDir);
      const afterCheck = captureWorkspaceSnapshot(qaRepoPath);
      const mutations = diffWorkspaceSnapshots(beforeCheck, afterCheck);
      const stageViolation = validateLocalCheckScope(changeId, mutations);
      if (stageViolation.blocked) {
        await blockStageViolation(changeId, runId, stageViolation);
      }

      // Combine findings
      const allFindings = [...localResult.findings, ...scopeResult.findings];
      const currentDir = changeDir(project.repoPath, changeId);
      fs.mkdirSync(currentDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "findings.json"),
        JSON.stringify(allFindings, null, 2)
      );
      fs.copyFileSync(path.join(runDir, "local-check.json"), path.join(currentDir, "local-check.json"));
      fs.copyFileSync(path.join(runDir, "scope-check.json"), path.join(currentDir, "scope-check.json"));
      fs.copyFileSync(path.join(runDir, "findings.json"), path.join(currentDir, "findings.json"));
      await insertArtifact(changeId, runId, "local_check", path.join(runDir, "local-check.json"));
      await insertArtifact(changeId, runId, "scope_check", path.join(runDir, "scope-check.json"));
      await insertArtifact(changeId, runId, "findings", path.join(runDir, "findings.json"));

      const nonReviewFindingsToDelete = db
        .select()
        .from(findings)
        .where(eq(findings.changeId, changeId))
        .all()
        .filter((finding) => finding.source !== "review");

      // Clear previous local/check findings for this change without deleting Review lineage rows.
      for (const finding of nonReviewFindingsToDelete) {
        runLedgerRepository.deleteFinding(finding.id, runId);
      }

      // Insert findings into DB
      for (const f of allFindings) {
        const fId = await nextId(findings, "FND");
        runLedgerRepository.insertFinding({
          id: fId,
          changeId,
          runId,
          source: f.source,
          severity: f.severity,
          category: f.category,
          title: f.title,
          file: f.file ?? null,
          line: f.line ?? null,
          evidence: f.evidence ?? null,
          requiredFix: f.requiredFix ?? null,
          status: "open",
          createdAt: nowISO(),
        });
      }

      // Determine final status
      let finalStatus: ChangeStatus;
      if (scopeResult.blocked) {
        finalStatus = "BLOCKED";
      } else if (!scopeResult.success) {
        finalStatus = "SCOPE_FAILED";
      } else if (!localResult.success) {
        finalStatus = "CHECK_FAILED";
      } else {
        finalStatus = "MERGE_READY";
      }

      return {
        result: { runId, finalStatus },
        summary: `Checks: ${finalStatus}`,
        success: finalStatus === "MERGE_READY",
        finalStatus,
      };
    },
  });

  // QA settlement changes the authoritative QA gate and may resolve prior QA findings.
  // Refresh Merge immediately so read-only gate consumers never retain the previous QA result.
  computeMergeReadiness(changeId);

  log.info({ changeId }, "Check completed");
}
