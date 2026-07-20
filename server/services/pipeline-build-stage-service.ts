import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { runLedgerRepository } from "../repositories/run-ledger-repository";
import {
  changes,
  runs,
  findings,
  projects,
} from "../db/schema";
import { createChildLogger } from "../logger";
import type { Change, ChangeStatus, Project } from "../types";
import { emitEvent } from "./event-service";
import { assemblePrompt } from "./prompt-service";
import type { AiRunItem, AiRunResult, AiStreamEvent } from "./ai-engine-types";
import {
  StaleLeaseFenceError,
  type JobExecutionContext,
} from "./job-execution-context";
import {
  assertCurrentExecutionFence,
  withExecutionFence,
} from "./execution-fence-service";
import {
  buildStreamStartTimeoutMs,
  createProviderLifecycleSink,
  documentStageTimeoutMs,
  getPipelineEngine,
  type EngineProvider,
} from "./pipeline-engine-service";
import { withTimeout } from "./ai-timeout-policy";
import {
  beginStageRun,
  blockStageViolation,
  endStageRun,
  setStatus,
  StageBoundaryViolationError,
  writeRunArtifact,
} from "./pipeline-run-ledger-service";
import { recoverStaleBuildRun } from "./build-stale-run-recovery-service";
import { recoverStrandedRunningStatus } from "./pipeline-document-stage-runner-service";
import {
  absorbBuildPatch,
  adoptFixPatch,
  approveBuildForAbsorb,
  collectBuildResult,
  createBuildWorkspace,
  markBuildRunFailed,
  markBuildRunRunning,
  readLatestBuildRun,
  rejectLatestBuildRun,
  type BuildRunFile,
} from "./build-workspace-service";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  loadDbPlanScope,
  loadPolicy,
  validateFixScope,
  type FindingScope,
  type WorkspaceMutation,
} from "./stage-guard-service";
import type { Provider } from "./provider-selection-service";
import { checkoutBranch, commitAll } from "./git-service";
import { runCheck } from "./pipeline-qa-stage-service";
import {
  recordProviderSession,
  resolveProviderSession,
} from "./provider-session-service";
import {
  MAX_FIX_ITERATIONS,
  maxFixIterationsErrorMessage,
} from "../state-machine/iteration-policy";
import {
  loadBuildDesignInputs,
  renderBuildGitFactsForPrompt,
  renderDbPlanScopeForPrompt,
  renderDbTestPlanForPrompt,
  renderDesignInputsForPrompt,
} from "./pipeline-prompt-context-service";

const log = createChildLogger("pipeline-service");

interface FencedStreamedStageCompletion<TResult> {
  result: TResult;
  summary: string;
  success: boolean;
  finalStatus: ChangeStatus;
}

async function runFencedStreamedStageWithLedger<TResult>(input: {
  changeId: string;
  context: JobExecutionContext;
  provider?: Provider;
  phase: "implement" | "fix_findings";
  runningStatus: ChangeStatus;
  failureStatus: ChangeStatus;
  formatFailureSummary?: (err: unknown) => string;
  execute: (input: { runId: string }) => Promise<FencedStreamedStageCompletion<TResult>>;
}): Promise<TResult> {
  const runId = beginStageRun({
    changeId: input.changeId, phase: input.phase,
    runningStatus: input.runningStatus, provider: input.provider,
  });

  try {
    const completion = await input.execute({ runId });
    assertCurrentExecutionFence(input.context, runId);
    endStageRun({
      changeId: input.changeId, runId, status: completion.finalStatus,
      summary: completion.summary, success: completion.success,
    });
    return completion.result;
  } catch (err) {
    if (err instanceof StaleLeaseFenceError || err instanceof StageBoundaryViolationError) {
      throw err;
    }
    const summary = input.formatFailureSummary
      ? input.formatFailureSummary(err)
      : err instanceof Error ? err.message : String(err);
    assertCurrentExecutionFence(input.context, runId);
    endStageRun({ changeId: input.changeId, runId, status: input.failureStatus, summary, success: false });
    throw err;
  }
}

function getProject(projectId: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, projectId)).get() as Project | undefined;
}

function getChange(changeId: string): Change | undefined {
  return db.select().from(changes).where(eq(changes.id, changeId)).get() as Change | undefined;
}

function assertStatus(change: Change, ...allowed: ChangeStatus[]) {
  if (!allowed.includes(change.status as ChangeStatus)) {
    throw new Error(
      `Invalid status: ${change.status}. Expected: ${allowed.join(", ")}`
    );
  }
}

export async function consumeBuildStreamWithStartupTimeout(
  stream: AsyncIterable<AiStreamEvent>,
  onEvent: (event: AiStreamEvent) => Promise<void>,
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  let first = true;
  try {
    while (true) {
      const next = first
        ? await withTimeout(iterator.next(), buildStreamStartTimeoutMs(), "Build stream start")
        : await iterator.next();
      first = false;
      if (next.done) return;
      await onEvent(next.value);
    }
  } catch (err) {
    if (typeof iterator.return === "function") {
      try {
        await iterator.return();
      } catch (returnErr) {
        log.warn(
          { err: String(returnErr), primaryErr: String(err) },
          "Failed to close Build stream after consumer failure",
        );
      }
    }
    throw err;
  }
}

function includesReviewFindings(items: FindingScope[]): boolean {
  return items.some((finding) => {
    const reviewFinding = finding as FindingScope & {
      source?: string;
      sourceReviewRunId?: string;
    };
    return reviewFinding.source === "review" || typeof reviewFinding.sourceReviewRunId === "string";
  });
}

export interface FormattedEvent {
  type: "codex_output" | "ai_reasoning" | "ai_message";
  message: string;
  raw: Record<string, unknown>;
}

export function formatThreadEvent(event: AiStreamEvent): FormattedEvent | null {
  const e = event as { type: string; item?: AiRunItem; [key: string]: unknown };

  // Stream reasoning as it updates
  if ((e.type === "item.started" || e.type === "item.updated") && e.item) {
    const item = e.item;
    if (item.type === "reasoning") {
      const text = (item as { text?: string }).text ?? "";
      if (!text) return null;
      return {
        type: "ai_reasoning",
        message: text.slice(0, 300),
        raw: { itemType: "reasoning", text },
      };
    }
    if (item.type === "agent_message") {
      const text = (item as { text?: string }).text ?? "";
      if (!text) return null;
      return {
        type: "ai_message",
        message: text.slice(0, 300),
        raw: { itemType: "message", text },
      };
    }
  }

  if (e.type === "item.completed" && e.item) {
    const item = e.item;
    if (item.type === "agent_message") {
      const text = (item as { text?: string }).text ?? "";
      return { type: "ai_message", message: text.slice(0, 300), raw: { itemType: "message", text, completed: true } };
    }
    if (item.type === "reasoning") {
      const text = (item as { text?: string }).text ?? "";
      return { type: "ai_reasoning", message: text.slice(0, 300), raw: { itemType: "reasoning", text, completed: true } };
    }
    if (item.type === "command_execution") {
      const cmd = item as { command?: string; exitCode?: number };
      const exitPart = cmd.exitCode !== undefined ? ` (exit ${cmd.exitCode})` : "";
      return {
        type: "codex_output",
        message: `$ ${cmd.command ?? "?"}${exitPart}`,
        raw: { itemType: "command", command: cmd.command, exitCode: cmd.exitCode },
      };
    }
    if (item.type === "file_change") {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((c) => c.path)
        : Array.isArray(item.paths)
          ? item.paths
          : [];
      return {
        type: "codex_output",
        message: `Changed: ${paths.join(", ")}`,
        raw: { itemType: "file_change", paths },
      };
    }
  }

  if (e.type === "turn.completed") {
    const usage = (e as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    return {
      type: "codex_output",
      message: `Turn done (${usage?.input_tokens ?? 0} in, ${usage?.output_tokens ?? 0} out)`,
      raw: { turnCompleted: true, usage },
    };
  }

  return null;
}

export async function runImplementStreamed(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<void> {
  return withExecutionFence(context, () => runImplementStreamedInExecutionScope(changeId, context, provider));
}

async function runImplementStreamedInExecutionScope(
  changeId: string,
  context: JobExecutionContext,
  requestedProvider?: Provider,
): Promise<void> {
  const startupStartedAt = Date.now();
  const startupTimeoutMs = buildStreamStartTimeoutMs();
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const provider = requestedProvider ?? context.provider ?? (change.provider as Provider);
  assertStatus(change, "PLAN_APPROVED");

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);
  const buildDesign = loadBuildDesignInputs(changeId);

  const active = db
    .select()
    .from(changes)
    .where(eq(changes.projectId, change.projectId))
    .all()
    .filter(
      (c) =>
        c.id !== changeId &&
        (c.status === "IMPLEMENTING" || c.status === "FIXING")
    );

  if (active.length > 0) {
    throw new Error(
      `Another change is active: ${active[0].id} (${active[0].status})`
    );
  }

  let buildRun: BuildRunFile | null = null;

  await runFencedStreamedStageWithLedger({
    changeId,
    context,
    provider,
    phase: "implement",
    runningStatus: "IMPLEMENTING",
    failureStatus: change.status as ChangeStatus,
    async execute({ runId }) {
      try {
        buildRun = createBuildWorkspace({
          repoPath: project.repoPath,
          changeId,
          designSourceDbHash: buildDesign.sourceDbHash,
        });
        buildRun = markBuildRunRunning({
          repoPath: project.repoPath,
          changeId,
          run: buildRun,
        });
        const prompt = `${assemblePrompt("implement", {
          changeId,
          repoPath: buildRun.workspacePath,
        })}\n\n${renderDbPlanScopeForPrompt(changeId)}\n\n${renderDbTestPlanForPrompt(changeId)}\n\n${renderDesignInputsForPrompt(buildDesign.designInputs)}\n\n${renderBuildGitFactsForPrompt(buildRun)}`;

        if (Date.now() - startupStartedAt >= startupTimeoutMs) {
          throw new Error(`Build stream start timed out after ${startupTimeoutMs}ms`);
        }

        const engine = await getPipelineEngine(provider as "codex" | "claude");
        const stream = engine.runStreamed({
          changeId,
          repoPath: buildRun.workspacePath,
          phase: "implement",
          threadId: resolveProviderSession({ changeId, provider, sessionKind: "build" })
            ?? resolveProviderSession({ changeId, provider, sessionKind: "general" })
            ?? undefined,
          prompt,
          sandboxMode: "workspace-write",
          timeoutMs: documentStageTimeoutMs("implement"),
          lifecycle: createProviderLifecycleSink({
            ...context,
            changeId,
            runId,
            phase: "implement",
            provider: provider as EngineProvider,
            closeBusinessRunOnProviderFailure: false,
          }),
        });

        let threadId = change.codexThreadId ?? "unknown";

        await consumeBuildStreamWithStartupTimeout(stream, async (event) => {
          const e = event as { type: string; item?: AiRunItem; threadId?: string };

          if (e.type === "thread.started" && e.threadId) {
            threadId = e.threadId;
          }

          const formatted = formatThreadEvent(event);
          if (formatted) {
            await emitEvent({
              changeId,
              runId,
              type: formatted.type,
              message: formatted.message,
              rawJson: formatted.raw,
              repoPath: project.repoPath,
            });
          }
        });
        assertCurrentExecutionFence(context, runId);

        // Save the write-phase thread under its own session kind: recording it
        // as "general" would poison later read-only stages with a session whose
        // sandbox/cwd belong to a per-run build worktree (codex resume inherits
        // both, and the worktree is deleted after absorb).
        if (threadId && threadId.toLowerCase() !== "unknown") {
          recordProviderSession({
            changeId,
            provider,
            sessionKind: "build",
            externalSessionId: threadId,
            lastRunId: runId,
          });
          if (provider === "codex") {
            runLedgerRepository.patchChange(changeId, { codexThreadId: threadId }, { runId });
          }
        }

        assertCurrentExecutionFence(context, runId);
        const collected = collectBuildResult({
          repoPath: project.repoPath,
          changeId,
          designSourceDbHash: buildDesign.sourceDbHash,
        });
        assertCurrentExecutionFence(context, runId);

        const summary = collected.status === "gate_blocked"
          ? "Build completed with gate blockers"
          : "Build completed and awaits human absorb";

        log.info(
          { changeId, changedFiles: collected.changedFiles.length, buildStatus: collected.status },
          "Build done, awaiting absorb"
        );

        return {
          result: undefined,
          summary,
          success: collected.status !== "gate_blocked",
          finalStatus: collected.status === "gate_blocked" ? "PLAN_APPROVED" : "IMPLEMENTING",
        };
      } catch (err) {
        if (err instanceof StaleLeaseFenceError) {
          throw err;
        }
        if (err instanceof StageBoundaryViolationError) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (buildRun) {
          buildRun = markBuildRunFailed({
            repoPath: project.repoPath,
            changeId,
            run: buildRun,
            reason: message,
          });
        }
        throw err;
      }
    },
  });
}

export async function retryBuildStreamed(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<void> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);

  if (change.status === "IMPLEMENTING") {
    const recovery = await recoverStaleBuildRun(changeId);
    if (!recovery.recovered) {
      throw new Error(`Build retry did not recover a stale running run: ${recovery.reason}`);
    }
  }

  const recoveredChange = getChange(changeId);
  if (recoveredChange?.status !== "PLAN_APPROVED") {
    throw new Error(`Build retry recovery left invalid status: ${recoveredChange?.status ?? "missing"}`);
  }
  await runImplementStreamed(changeId, context, provider);
}

export async function recoverCurrentBuildRun(changeId: string): Promise<BuildRunFile> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  assertStatus(change, "IMPLEMENTING");

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  const latestRunningRun = db
    .select()
    .from(runs)
    .where(and(eq(runs.changeId, changeId), eq(runs.phase, "implement"), eq(runs.status, "running")))
    .all()
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))[0];
  if (!latestRunningRun) {
    throw new Error(`No running Build run found for change: ${changeId}`);
  }

  const latestBuildRun = readLatestBuildRun(project.repoPath, changeId);
  if (!latestBuildRun) {
    throw new Error(`No Build workspace run found for change: ${changeId}`);
  }

  const buildDesign = loadBuildDesignInputs(changeId);
  const collected = collectBuildResult({
    repoPath: project.repoPath,
    changeId,
    designSourceDbHash: latestBuildRun.designSourceDbHash ?? buildDesign.sourceDbHash,
  });
  const summary = collected.status === "gate_blocked"
    ? "Build recovered with gate blockers"
    : "Build recovered from existing workspace and awaits human absorb";
  endStageRun({
    changeId, runId: latestRunningRun.id,
    status: collected.status === "gate_blocked" ? "PLAN_APPROVED" : "IMPLEMENTING",
    summary, success: collected.status !== "gate_blocked",
  });
  log.warn(
    { changeId, runId: latestRunningRun.id, buildStatus: collected.status },
    "Recovered Build run from existing workspace"
  );
  return collected;
}

export async function approveBuildAbsorb(changeId: string): Promise<void> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  assertStatus(change, "IMPLEMENTING", "IMPLEMENTED");

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);
  const latestRun = readLatestBuildRun(project.repoPath, changeId);
  if (
    change.status === "IMPLEMENTED" &&
    (!latestRun || (latestRun.status !== "approved_for_absorb" && latestRun.status !== "adopted"))
  ) {
    throw new Error(
      `IMPLEMENTED Build absorb recovery requires an approved_for_absorb or adopted latest run; current status is ${latestRun?.status ?? "missing"}`
    );
  }

  const approved = approveBuildForAbsorb({
    repoPath: project.repoPath,
    changeId,
  });
  const commit = { enabled: Boolean(project.gitEnabled && change.gitBranch) };
  const adopted = approved.status === "adopted"
    ? approved
    : approved.purpose === "fix"
      ? adoptFixPatch({ repoPath: project.repoPath, changeId, commit })
      : absorbBuildPatch({ repoPath: project.repoPath, changeId, commit });
  if (adopted.status !== "adopted" || !adopted.adoptedHeadSha || !adopted.adoptionDecisionId) {
    throw new Error("Build patch adoption did not persist complete adopted metadata");
  }

  await setStatus(changeId, "IMPLEMENTED");
}

export async function approveFixAbsorb(changeId: string): Promise<void> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  assertStatus(change, "IMPLEMENTING");

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);
  const latestRun = readLatestBuildRun(project.repoPath, changeId);
  if (latestRun?.purpose !== "fix") {
    throw new Error("Latest BuildRun is not a fix run");
  }

  approveBuildForAbsorb({
    repoPath: project.repoPath,
    changeId,
  });

  await setStatus(changeId, "IMPLEMENTED");
}

export async function rejectBuildRun(changeId: string): Promise<BuildRunFile> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  if (change.status !== "PLAN_APPROVED" && change.status !== "IMPLEMENTING") {
    throw new Error(`Build can only be rejected from PLAN_APPROVED or IMPLEMENTING; current status is ${change.status}`);
  }

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  const rejected = rejectLatestBuildRun({
    repoPath: project.repoPath,
    changeId,
  });
  await setStatus(changeId, "PLAN_APPROVED");
  return rejected;
}

export async function runFixStreamed(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<void> {
  return withExecutionFence(context, () => runFixStreamedInExecutionScope(changeId, context, provider));
}

/**
 * Exactly what the fix guard below accepts, named so the action contract can
 * mirror it instead of guessing (`fix_blockers`'s requiredStatus, and
 * reviewControlDecision's own status check).
 *
 * FIXING is deliberately absent: it is the stage's own running status, and
 * letting the guard accept it would make "FIXING" stop meaning "a fix_findings
 * run is in flight". A change stranded there is repaired first, then runs
 * through this guard unchanged.
 */
const FIX_ALLOWED_STATUSES: ChangeStatus[] = ["CHECK_FAILED", "SCOPE_FAILED"];

async function runFixStreamedInExecutionScope(
  changeId: string,
  context: JobExecutionContext,
  requestedProvider?: Provider,
): Promise<void> {
  const initialChange = getChange(changeId);
  if (!initialChange) throw new Error(`Change not found: ${changeId}`);
  const provider = requestedProvider ?? context.provider ?? (initialChange.provider as Provider);
  // Repair a FIXING claim no run is backing before the guard reads it,
  // otherwise a retry can never get past assertStatus to create one -- the
  // permanent dead end 8ac5c4ec fixed for TechSpec. The fix stage runs through
  // runFencedStreamedStageWithLedger, which neither runDocumentStage nor
  // generatePlan cover, so that commit's recovery never reached it either; it
  // has to be invoked here.
  const recovery = recoverStrandedRunningStatus({
    changeId,
    phase: "fix_findings",
    status: initialChange.status as ChangeStatus,
    allowedStatuses: FIX_ALLOWED_STATUSES,
    runningStatus: "FIXING",
    // runFixStreamed's own failureStatus is `change.status`, i.e. whichever of
    // CHECK_FAILED / SCOPE_FAILED it entered from -- unknowable once the claim
    // is all that survives. CHECK_FAILED is the sweeper's rollback target for
    // this phase (fallbackStatusByProviderPhase.fix_findings), it is a legal
    // FIXING exit in ALLOWED_TRANSITIONS, and it is in the allowed list above,
    // so the repaired change lands somewhere the retry can actually run from.
    failureStatus: "CHECK_FAILED",
    eventSource: "fix_stage_stranded_status_recovery",
  });
  const change = recovery.recovered ? getChange(changeId) ?? initialChange : initialChange;
  assertStatus(change, ...FIX_ALLOWED_STATUSES);

  if ((change.fixIterations ?? 0) >= MAX_FIX_ITERATIONS) {
    throw new Error(maxFixIterationsErrorMessage());
  }

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);
  const buildDesign = loadBuildDesignInputs(changeId);

  const fixResult = await runFencedStreamedStageWithLedger<{
    reviewFindings: boolean;
    iteration: number;
    buildRunId: string;
  } | null>({
    changeId,
    context,
    provider,
    phase: "fix_findings",
    runningStatus: "FIXING",
    failureStatus: change.status as ChangeStatus,
    formatFailureSummary: (err) => String(err),
    async execute({ runId }) {
      // Event 1: Fix started
      await emitEvent({
        changeId,
        runId,
        type: "fix.started",
        message: `开始修复迭代 #${(change.fixIterations ?? 0) + 1}`,
        rawJson: { iteration: (change.fixIterations ?? 0) + 1 },
      });

      // Event 2: Creating workspace
      await emitEvent({
        changeId,
        runId,
        type: "fix.workspace.creating",
        message: "正在创建 Fix workspace...",
      });

      const buildRun = createBuildWorkspace({
        repoPath: project.repoPath,
        changeId,
        designSourceDbHash: buildDesign.sourceDbHash,
        purpose: "fix",
      });

      // Event 3: Workspace ready
      await emitEvent({
        changeId,
        runId,
        type: "fix.workspace.ready",
        message: `Workspace 就绪: ${buildRun.branchName}`,
        rawJson: {
          workspacePath: buildRun.workspacePath,
          branchName: buildRun.branchName,
          runNumber: buildRun.runNumber,
        },
      });

      let prompt = assemblePrompt("fix", {
        changeId,
        repoPath: buildRun.workspacePath,
      });
      prompt += `\n\n${renderDbPlanScopeForPrompt(changeId)}\n\n${renderDesignInputsForPrompt(buildDesign.designInputs)}\n\n${renderBuildGitFactsForPrompt(buildRun)}`;

      const openFindings = db
        .select()
        .from(findings)
        .where(eq(findings.changeId, changeId))
        .all()
        .filter((f) => f.status === "open");

      if (openFindings.length > 0) {
        prompt +=
          "\n\n## Open Findings\n\n```json\n" +
          JSON.stringify(openFindings, null, 2) + "\n```";
      }

      // Event 4: Findings loaded
      await emitEvent({
        changeId,
        runId,
        type: "fix.findings.loaded",
        message: `加载了 ${openFindings.length} 个待修复问题`,
        rawJson: {
          count: openFindings.length,
          findings: openFindings.map(f => ({
            id: f.id,
            severity: f.severity,
            category: f.category,
            file: f.file,
            line: f.line,
            title: f.title,
          }))
        },
      });

      // Event 5: AI engine starting
      const engine = await getPipelineEngine(provider as "codex" | "claude");
      await emitEvent({
        changeId,
        runId,
        type: "fix.ai.started",
        message: `启动 AI 引擎: ${provider}`,
        rawJson: { provider },
      });

      const stream = engine.runStreamed({
        changeId,
        repoPath: buildRun.workspacePath,
        phase: "fix",
        threadId: resolveProviderSession({ changeId, provider, sessionKind: "fix" })
          ?? resolveProviderSession({ changeId, provider, sessionKind: "general" })
          ?? undefined,
        prompt,
        sandboxMode: "workspace-write",
        timeoutMs: documentStageTimeoutMs("fix_findings"),
        lifecycle: createProviderLifecycleSink({
          ...context,
          changeId,
          runId,
          phase: "fix_findings",
          provider: provider as EngineProvider,
          closeBusinessRunOnProviderFailure: false,
        }),
      });

      let threadId = change.codexThreadId ?? "unknown";

      for await (const event of stream) {
        const e = event as { type: string; item?: AiRunItem; threadId?: string };

        if (e.type === "thread.started" && e.threadId) {
          threadId = e.threadId;
          // Event 6: AI thread started
          await emitEvent({
            changeId,
            runId,
            type: "fix.ai.thread.started",
            message: `AI thread 启动: ${threadId.substring(0, 8)}...`,
            rawJson: { threadId },
          });
        }

        const formatted = formatThreadEvent(event);
        if (formatted) {
          await emitEvent({
            changeId,
            runId,
            type: formatted.type,
            message: formatted.message,
            rawJson: formatted.raw,
            repoPath: buildRun.workspacePath,
          });
        }
      }
      assertCurrentExecutionFence(context, runId);

      // Event 7: AI completed, collecting results
      await emitEvent({
        changeId,
        runId,
        type: "fix.ai.completed",
        message: "AI 修复完成，正在收集结果...",
      });

      assertCurrentExecutionFence(context, runId);
      const collected = collectBuildResult({
        repoPath: project.repoPath,
        changeId,
        designSourceDbHash: buildDesign.sourceDbHash,
      });
      // A failed/no-op workspace is not a completed fix iteration.
      assertCurrentExecutionFence(context, runId);
      if (threadId && threadId.toLowerCase() !== "unknown") {
        // Write-phase session kind: keep worktree-scoped sessions out of the
        // shared "general" slot (codex resume inherits sandbox/cwd).
        recordProviderSession({
          changeId,
          provider,
          sessionKind: "fix",
          externalSessionId: threadId,
          lastRunId: runId,
        });
      }
      const fixPatch = { fixIterations: (change.fixIterations ?? 0) + 1 };
      if (provider === "codex" && threadId && threadId.toLowerCase() !== "unknown") {
        Object.assign(fixPatch, { codexThreadId: threadId });
      }
      runLedgerRepository.patchChange(changeId, fixPatch, { runId });
      assertCurrentExecutionFence(context, runId);
      const summary = collected.status === "gate_blocked"
        ? "Fix completed with gate blockers"
        : "Fix completed and awaits human absorb";

      // Event 8: Fix completed with status
      assertCurrentExecutionFence(context, runId);
      await emitEvent({
        changeId,
        runId,
        type: collected.status === "gate_blocked" ? "fix.completed.blocked" : "fix.completed.success",
        message: summary,
        rawJson: {
          status: collected.status,
          changedFiles: collected.changedFiles?.length ?? 0,
          blockers: collected.blockers?.length ?? 0,
          runNumber: collected.runNumber,
        },
      });
      assertCurrentExecutionFence(context, runId);

      if (collected.status === "gate_blocked") {
        return {
          result: null,
          summary,
          success: false,
          finalStatus: "CHECK_FAILED",
        };
      }

      return {
        result: {
          reviewFindings: includesReviewFindings(openFindings),
          iteration: (change.fixIterations ?? 0) + 1,
          buildRunId: `build-${collected.runNumber}`,
        },
        summary,
        success: true,
        finalStatus: "IMPLEMENTING",
      };
    },
  });

  if (!fixResult) {
    return;
  }

  if (fixResult.reviewFindings) {
    log.info(
      {
        changeId,
        iteration: fixResult.iteration,
        buildRunId: fixResult.buildRunId,
      },
      "Fix (streamed) done, awaiting absorb before Review rerun"
    );
    return;
  }

  log.info(
    {
      changeId,
      iteration: fixResult.iteration,
      buildRunId: fixResult.buildRunId,
    },
    "Fix (streamed) done, awaiting absorb before checks"
  );
}

// --- Non-streamed implement/fix orchestration (moved from pipeline-service) ---

function selectedProvider(
  change: Change,
  context: JobExecutionContext,
  requested?: Provider,
): Provider {
  return requested ?? context.provider ?? (change.provider as Provider);
}

function changedFilesFromMutations(mutations: WorkspaceMutation[]): string[] {
  return Array.from(new Set(mutations.map((mutation) => mutation.path))).sort();
}

function normalizedProviderThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : undefined;
}

export async function runImplement(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  await runImplementStreamed(changeId, context, provider);

  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);

  const implementRuns = db
    .select()
    .from(runs)
    .where(eq(runs.changeId, changeId))
    .all()
    .filter((run) => run.phase === "implement");
  const latestRun = implementRuns[implementRuns.length - 1];

  return {
    threadId: change.codexThreadId ?? `${changeId}-build-thread`,
    runId: latestRun?.id ?? `${changeId}-build-run`,
    summary: latestRun?.summary ?? "Build workspace run started",
    success: latestRun?.status === "completed",
    changedFiles: [],
    structuredOutput: undefined,
    items: [],
  };
}

export async function runFix(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  return withExecutionFence(context, async () => {
    const change = getChange(changeId);
    if (!change) throw new Error(`Change not found: ${changeId}`);
    const selected = selectedProvider(change, context, provider);
    assertStatus(change, "CHECK_FAILED", "SCOPE_FAILED");

    if ((change.fixIterations ?? 0) >= MAX_FIX_ITERATIONS) {
      throw new Error(maxFixIterationsErrorMessage());
    }

    const project = getProject(change.projectId);
    if (!project) throw new Error(`Project not found: ${change.projectId}`);

    // Check no other change is IMPLEMENTING or FIXING
    const active = db
      .select()
      .from(changes)
      .where(eq(changes.projectId, change.projectId))
      .all()
      .filter(
        (c) =>
          c.id !== changeId &&
          (c.status === "IMPLEMENTING" || c.status === "FIXING")
      );

    if (active.length > 0) {
      throw new Error(
        `Another change is active: ${active[0].id} (${active[0].status})`
      );
    }

    assertCurrentExecutionFence(context);
    const runId = beginStageRun({ changeId, phase: "fix_findings", runningStatus: "FIXING", provider: selected });

    try {
      // Switch to change branch before fix
      assertCurrentExecutionFence(context, runId);
      if (project.gitEnabled && change.gitBranch) {
        checkoutBranch(project.repoPath, change.gitBranch);
      }

      // Assemble fix prompt with findings appended
      let prompt = assemblePrompt("fix", {
        changeId,
        repoPath: project.repoPath,
      });
      prompt += `\n\n${renderDbPlanScopeForPrompt(changeId)}`;

      // DB is authoritative for open findings (matches the streamed Fix path
      // above, :667-672) -- findings.json/review-findings.json are human-
      // editable phase artifacts, so reading them here could inject arbitrary
      // content into the AI's prompt unrelated to any real finding, and
      // `source` (which includesReviewFindings depends on) is only guaranteed
      // accurate from the DB column. See
      // docs/state-projection-audit-2026-07-14.md §4, Site 6.
      const openFindings = db
        .select()
        .from(findings)
        .where(eq(findings.changeId, changeId))
        .all()
        .filter((finding) => finding.status === "open");
      if (openFindings.length > 0) {
        prompt += "\n\n## Open Findings\n```json\n" +
          JSON.stringify(openFindings, null, 2) + "\n```";
      }

      assertCurrentExecutionFence(context, runId);
      const beforeAi = captureWorkspaceSnapshot(project.repoPath);
      const engine = await getPipelineEngine(selected as "codex" | "claude");
      const result = await engine.run({
        changeId,
        repoPath: project.repoPath,
        phase: "fix",
        threadId: resolveProviderSession({ changeId, provider: selected, sessionKind: "fix" })
          ?? resolveProviderSession({ changeId, provider: selected, sessionKind: "general" })
          ?? undefined,
        prompt,
        sandboxMode: "workspace-write",
        lifecycle: createProviderLifecycleSink({
          ...context,
          changeId,
          runId,
          phase: "fix",
          provider: selected as EngineProvider,
          closeBusinessRunOnProviderFailure: false,
        }),
      });
      assertCurrentExecutionFence(context, runId);
      const afterAi = captureWorkspaceSnapshot(project.repoPath);
      const mutations = diffWorkspaceSnapshots(beforeAi, afterAi);
      const plan = loadDbPlanScope(changeId);
      const policy = loadPolicy(project.repoPath);
      const violation = validateFixScope(mutations, openFindings, plan, policy);
      if (violation.blocked) {
        assertCurrentExecutionFence(context, runId);
        await blockStageViolation(changeId, runId, violation);
      }
      const changedFiles = changedFilesFromMutations(mutations);
      result.changedFiles = changedFiles;

      // Update thread + fixIterations
      assertCurrentExecutionFence(context, runId);
      const threadId = normalizedProviderThreadId(result.threadId);
      if (threadId) {
        // Write-phase session kind (see the build path): keep workspace-write
        // sessions out of the shared read-only "general" slot.
        recordProviderSession({
          changeId,
          provider: selected,
          sessionKind: "fix",
          externalSessionId: threadId,
          lastRunId: runId,
        });
      }
      const changePatch = { fixIterations: (change.fixIterations ?? 0) + 1 };
      if (selected === "codex" && threadId) {
        Object.assign(changePatch, { codexThreadId: threadId });
      }
      runLedgerRepository.patchChange(changeId, changePatch, { runId });

      assertCurrentExecutionFence(context, runId);
      await writeRunArtifact(
        project.repoPath,
        changeId,
        runId,
        "changed_files",
        "changed-files.json",
        JSON.stringify(changedFiles, null, 2)
      );

      assertCurrentExecutionFence(context, runId);
      endStageRun({ changeId, runId, status: "IMPLEMENTED", summary: "Fix completed", success: true });
      if (includesReviewFindings(openFindings)) {
        log.info({ changeId, iteration: (change.fixIterations ?? 0) + 1 }, "Fix done, awaiting Review rerun");
        return result;
      }

      // Auto-commit if git is enabled
      assertCurrentExecutionFence(context, runId);
      if (project.gitEnabled && change.gitBranch) {
        commitAll(project.repoPath, `fix(${changeId}): iteration ${(change.fixIterations ?? 0) + 1}`);
      }

      log.info({ changeId, iteration: (change.fixIterations ?? 0) + 1 }, "Fix done, auto-running checks");

      // Auto-trigger checks -- runCheck's own beginStageRun atomically advances
      // IMPLEMENTED -> CHECKING alongside creating the local_check run. Setting
      // CHECKING here first was redundant (runCheckInExecutionScope has no
      // precondition on it) and reopened the exact crash window this file's
      // other gaps were just closed for (D6 audit Tier 2).
      assertCurrentExecutionFence(context, runId);
      await runCheck(changeId, context);

      return result;
    } catch (err) {
      if (err instanceof StaleLeaseFenceError) {
        throw err;
      }
      if (err instanceof StageBoundaryViolationError) {
        throw err;
      }
      assertCurrentExecutionFence(context, runId);
      endStageRun({
        changeId, runId, status: change.status as ChangeStatus,
        summary: String(err), success: false,
      });
      throw err;
    }
  });
}
