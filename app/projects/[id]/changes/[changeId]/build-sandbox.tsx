"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  Hammer,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import {
  createPipelinePreflightPayload,
  findPipelineAction,
  pipelineActionDisabledReason,
  type PipelineActionContract,
} from "./pipeline-action-contract";
import {
  buildActionErrorSignature,
  shouldShowBuildAdoptAction,
  shouldShowBuildRejectAction,
  shouldShowBuildStartAction,
} from "./build-action-policy";
import { ProducedFile } from "./produced-file";
import type { AiProvider } from "./pipeline-action-contract";
import type { StageActionView } from "./stage-action-bar";

type BaseCampStatus = "ready" | "blocked" | "dirty";
type BuildRunStatus =
  | "created"
  | "running"
  | "gate_blocked"
  | "awaiting_human"
  | "approved_for_absorb"
  | "audit_ready"
  | "adopted"
  | "rejected"
  | "failed";

interface GitBaseCampView {
  status: BaseCampStatus;
  headSha: string | null;
  clean: boolean;
  blockers: string[];
  warnings: string[];
}

interface BuildDeviationView {
  file: string;
  reason: string;
  severityHint: "P1" | "P2" | string;
}

interface BuildRunView {
  status: BuildRunStatus;
  runNumber: number;
  baseCommit: string | null;
  workspacePath: string;
  branchName: string;
  expectedFiles: string[];
  forbiddenFiles: string[];
  changedFiles: string[];
  deviations: BuildDeviationView[];
  blockers: string[];
  patchPath: string | null;
  diffPath: string | null;
  auditPath: string | null;
  reportPath: string | null;
  purpose?: "build" | "fix";
}

interface BuildWorkspaceState {
  baseCamp: GitBaseCampView;
  buildRun: BuildRunView | null;
}

interface BuildSandboxProps {
  projectId: string;
  changeId: string;
  actions?: PipelineActionContract[];
  selectedProvider?: AiProvider;
  refreshToken?: string | number | null;
  onStageActionsChange?: (actions: StageActionView[]) => void;
  onStageActionError?: (error: string | null) => void;
  onChanged: () => void | Promise<unknown>;
}

const DEVIATION_REASON_COPY: Record<string, string> = {
  outside_expected_files: "计划外改动",
  dependency: "依赖变更",
  lockfile: "锁文件变更",
  migration: "迁移文件",
  generated_file: "生成文件",
};

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : "-";
}

function deviationReasonCopy(reason: string): string {
  return DEVIATION_REASON_COPY[reason] ?? reason;
}

function PanelHeader({
  icon,
  title,
  eyebrow,
}: {
  icon: ReactNode;
  title: string;
  eyebrow: string;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
        <h2 className="mt-1 text-sm font-semibold">{title}</h2>
      </div>
      <div className="rounded-md border bg-muted/40 p-2 text-muted-foreground">{icon}</div>
    </div>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{children}</p>;
}

function artifactStatus(filePath?: string | null): string {
  return filePath ? "已生成" : "未生成";
}

function selectBuildStartAction(actions: PipelineActionContract[] | undefined): PipelineActionContract | null {
  const runBuild = findPipelineAction(actions, "run_build");
  const retryBuild = findPipelineAction(actions, "retry_build");
  if (runBuild?.enabled) return runBuild;
  if (retryBuild?.enabled) return retryBuild;
  if (retryBuild && runBuild?.reasonCode === "not_at_gate") return retryBuild;
  return runBuild ?? retryBuild ?? null;
}

function buildAbsorbBaseCampReason(baseCamp: GitBaseCampView | null): string | null {
  if (!baseCamp || baseCamp.status === "ready") return null;
  if (!baseCamp.headSha) return "Git HEAD could not be verified before absorbing Build output.";
  if (baseCamp.blockers.length > 0) return baseCamp.blockers.join("; ");
  return "主仓需清理后才能收编 Build。";
}

export function BuildSandbox({
  projectId,
  changeId,
  actions,
  selectedProvider,
  refreshToken,
  onStageActionsChange,
  onStageActionError,
  onChanged,
}: BuildSandboxProps) {
  const [state, setState] = useState<BuildWorkspaceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (options?: { preserveError?: boolean }) => {
    const preserveError = options?.preserveError ?? false;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/build-workspace`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Build workspace load failed");
      }
      setState(data as BuildWorkspaceState);
      if (!preserveError) setError(null);
      return data as BuildWorkspaceState;
    } catch (err) {
      if (!preserveError) setError(err instanceof Error ? err.message : String(err));
      setState(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId, changeId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load, refreshToken]);

  const runBuildAction = useCallback(
    async (action: "approve_absorb" | "reject_build") => {
      const contractAction =
        action === "approve_absorb"
          ? findPipelineAction(actions, state?.buildRun?.purpose === "fix" ? "adopt_fix" : "adopt_build")
          : findPipelineAction(actions, "reject_build");
      const disabledReason = pipelineActionDisabledReason(contractAction);
      if (disabledReason) {
        setError(disabledReason);
        return;
      }
      setBusyAction(action);
      setError(null);
      let actionSucceeded = false;
      try {
        const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/build-workspace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createPipelinePreflightPayload(contractAction, {
            provider: selectedProvider,
            action,
            expectedHeadSha: state?.baseCamp.headSha ?? undefined,
          })),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : "Build action failed");
        }
        actionSucceeded = true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        await load({ preserveError: !actionSucceeded });
        await Promise.resolve(onChanged());
        setBusyAction(null);
      }
    },
    [projectId, changeId, actions, selectedProvider, state?.baseCamp.headSha, state?.buildRun?.purpose, load, onChanged]
  );

  const runBuildStart = useCallback(async () => {
    const contractAction = selectBuildStartAction(actions);
    const disabledReason = pipelineActionDisabledReason(contractAction);
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    setBusyAction("start_build");
    setError(null);
    let actionSucceeded = false;
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/implement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createPipelinePreflightPayload(contractAction, {
          provider: selectedProvider,
          expectedHeadSha: state?.baseCamp.headSha ?? undefined,
        })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Build start failed");
      }
      actionSucceeded = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      await load({ preserveError: !actionSucceeded });
      await Promise.resolve(onChanged());
      setBusyAction(null);
    }
  }, [projectId, changeId, actions, selectedProvider, state?.baseCamp.headSha, load, onChanged]);

  const buildRun = state?.buildRun ?? null;
  const baseCamp = state?.baseCamp ?? null;
  const startBuildAction = selectBuildStartAction(actions);
  const approveAbsorbAction = findPipelineAction(actions, buildRun?.purpose === "fix" ? "adopt_fix" : "adopt_build");
  const rejectBuildAction = findPipelineAction(actions, "reject_build");
  const startBuildReason = pipelineActionDisabledReason(startBuildAction);
  const absorbBaseCampReason = buildAbsorbBaseCampReason(baseCamp);
  const approveAbsorbReason = absorbBaseCampReason ?? pipelineActionDisabledReason(approveAbsorbAction);
  const rejectBuildReason = pipelineActionDisabledReason(rejectBuildAction);
  const canStartBuild = startBuildAction?.enabled === true;
  const canApproveAbsorb = approveAbsorbAction?.enabled === true && absorbBaseCampReason === null;
  const canRejectBuild = rejectBuildAction?.enabled === true;
  const buildRetryRunningBlocked =
    startBuildAction?.actionId === "retry_build" &&
    startBuildAction.reasonCode === "build_run_running";
  const isBuildActionBusy = busyAction !== null;
  const showStartBuildAction = shouldShowBuildStartAction(buildRun, startBuildAction);
  const showApproveAbsorbAction = shouldShowBuildAdoptAction(buildRun, approveAbsorbAction);
  const showRejectBuildAction = shouldShowBuildRejectAction(buildRun, rejectBuildAction);
  const stageActions = useMemo<StageActionView[]>(() => {
    const nextActions: StageActionView[] = [];

    if (showStartBuildAction) {
      nextActions.push({
        id: "build-start",
        label: startBuildAction?.label ?? "开始 Build",
        role: "primary",
        enabled: !isBuildActionBusy && canStartBuild,
        busy: busyAction === "start_build",
        disabledReason: startBuildReason,
        sourceActionId: startBuildAction?.actionId,
        onAction: runBuildStart,
      });
    }

    if (showApproveAbsorbAction) {
      nextActions.push({
        id: "build-adopt",
        label: approveAbsorbAction?.label ?? "批准收编",
        role: "primary",
        enabled: !isBuildActionBusy && canApproveAbsorb,
        busy: busyAction === "approve_absorb",
        disabledReason: approveAbsorbReason,
        sourceActionId: approveAbsorbAction?.actionId,
        onAction: () => runBuildAction("approve_absorb"),
      });
    }

    if (showRejectBuildAction) {
      nextActions.push({
        id: "build-reject",
        label: rejectBuildAction?.label ?? "请求修改 / 拒绝本轮 Build",
        role: "destructive",
        enabled: !isBuildActionBusy && canRejectBuild,
        busy: busyAction === "reject_build",
        disabledReason: rejectBuildReason,
        sourceActionId: rejectBuildAction?.actionId,
        onAction: () => runBuildAction("reject_build"),
      });
    }

    return nextActions;
  }, [
    showStartBuildAction,
    showApproveAbsorbAction,
    showRejectBuildAction,
    startBuildAction?.label,
    startBuildAction?.actionId,
    isBuildActionBusy,
    canStartBuild,
    busyAction,
    startBuildReason,
    runBuildStart,
    approveAbsorbAction?.label,
    approveAbsorbAction?.actionId,
    canApproveAbsorb,
    approveAbsorbReason,
    runBuildAction,
    rejectBuildAction?.label,
    rejectBuildAction?.actionId,
    canRejectBuild,
    rejectBuildReason,
  ]);
  const stageActionSignature = useMemo(
    () => buildActionErrorSignature({ buildRun, slots: stageActions }),
    [buildRun, stageActions],
  );
  const combinedBlockers = useMemo(
    () => [...(baseCamp?.blockers ?? []), ...(buildRun?.blockers ?? [])],
    [baseCamp?.blockers, buildRun?.blockers]
  );

  // Reset the transient error whenever the action signature changes. Done during
  // render (React's recommended pattern) instead of in an effect to avoid a
  // cascading-render pass on every signature change.
  const [prevStageActionSignature, setPrevStageActionSignature] = useState(stageActionSignature);
  if (prevStageActionSignature !== stageActionSignature) {
    setPrevStageActionSignature(stageActionSignature);
    setError(null);
  }

  useEffect(() => {
    onStageActionsChange?.(stageActions);
  }, [onStageActionsChange, stageActions]);

  useEffect(() => {
    return () => {
      onStageActionsChange?.([]);
    };
  }, [onStageActionsChange]);

  useEffect(() => {
    onStageActionError?.(error);
  }, [error, onStageActionError]);

  useEffect(() => {
    return () => {
      onStageActionError?.(null);
    };
  }, [onStageActionError]);

  return (
    <div className="grid min-h-[32rem] gap-0 lg:grid-cols-[0.9fr_1.15fr_1fr]">
      <section className="border-b p-4 lg:border-r lg:border-b-0">
        <PanelHeader
          eyebrow="BASE"
          title="Git Base Camp"
          icon={<GitBranch className="h-4 w-4" aria-hidden="true" />}
        />
        <div className="grid gap-3">
          <div className="rounded-md border p-3">
            <p className="text-[11px] font-medium text-muted-foreground">主仓状态</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${
                baseCamp?.status === "ready"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              }`}>
                {baseCamp?.status === "ready" ? "可开始" : loading ? "侦测中" : "需清理"}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                HEAD {shortSha(baseCamp?.headSha)}
              </span>
            </div>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-[11px] font-medium text-muted-foreground">工作区</p>
            <p className="mt-2 break-all font-mono text-xs">{buildRun?.workspacePath ?? "尚未建立"}</p>
            {buildRun?.branchName && (
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {buildRun.branchName}
              </p>
            )}
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              base {shortSha(buildRun?.baseCommit)}
            </p>
          </div>
          {buildRetryRunningBlocked && (
            <p className="text-xs text-muted-foreground">
              Build run is still recorded as running. Recovery is required before retry.
            </p>
          )}
          {loading || !baseCamp ? (
            <EmptyLine>Git Base Camp 侦测中。</EmptyLine>
          ) : combinedBlockers.length > 0 ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-900">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <p className="text-sm font-semibold">阻断项</p>
              </div>
              <div className="space-y-1">
                {combinedBlockers.map((blocker) => (
                  <p key={blocker} className="break-words text-xs leading-5">{blocker}</p>
                ))}
              </div>
            </div>
          ) : baseCamp.warnings.length > 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <p className="text-sm font-semibold">Base Camp warning</p>
              </div>
              <div className="space-y-1">
                {baseCamp.warnings.map((warning) => (
                  <p key={warning} className="break-words font-mono text-xs leading-5">{warning}</p>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                <p className="text-sm font-semibold">Base Camp 稳定</p>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="border-b p-4 lg:border-r lg:border-b-0">
        <PanelHeader
          eyebrow="BUILD"
          title="Build 进度 / 差异"
          icon={<Hammer className="h-4 w-4" aria-hidden="true" />}
        />
        <div className="mb-3 grid grid-cols-3 gap-2">
          <div className="rounded-md border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">变更文件</p>
            <p className="mt-1 font-mono text-xl font-semibold leading-none">{buildRun?.changedFiles.length ?? 0}</p>
          </div>
          <div className="rounded-md border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">计划外</p>
            <p className="mt-1 font-mono text-xl font-semibold leading-none">{buildRun?.deviations.length ?? 0}</p>
          </div>
          <div className="rounded-md border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">硬阻断</p>
            <p className="mt-1 font-mono text-xl font-semibold leading-none">{buildRun?.blockers.length ?? 0}</p>
          </div>
        </div>
        {(buildRun?.changedFiles.length ?? 0) === 0 ? (
          <EmptyLine>暂无 Build diff。</EmptyLine>
        ) : (
          <div className="max-h-[23rem] space-y-1 overflow-auto rounded-md border p-2">
            {buildRun?.changedFiles.map((file) => (
              <ProducedFile
                key={file}
                projectId={projectId}
                changeId={changeId}
                path={file}
                label={file}
                className="w-full break-all rounded bg-muted px-2 py-1 text-xs"
              />
            ))}
          </div>
        )}
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
          <div className="rounded-md border p-3">
            <p className="mb-2 font-medium text-muted-foreground">期望范围</p>
            {(buildRun?.expectedFiles.length ?? 0) === 0 ? (
              <p className="text-muted-foreground">未声明</p>
            ) : (
              <div className="space-y-1">
                {buildRun?.expectedFiles.map((file) => (
                  <ProducedFile
                    key={file}
                    projectId={projectId}
                    changeId={changeId}
                    path={file}
                    label={file}
                    className="w-full break-all"
                  />
                ))}
              </div>
            )}
          </div>
          <div className="rounded-md border p-3">
            <p className="mb-2 font-medium text-muted-foreground">禁止范围</p>
            {(buildRun?.forbiddenFiles.length ?? 0) === 0 ? (
              <p className="text-muted-foreground">未声明</p>
            ) : (
              <div className="space-y-1">
                {buildRun?.forbiddenFiles.map((file) => (
                  // Not made clickable: entries here may be glob patterns (e.g.
                  // from policy blockedGlobs), not concrete files — they can't
                  // reliably resolve to openable content.
                  <p key={file} className="w-full break-all font-mono">{file}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="p-4">
        <PanelHeader
          eyebrow="AUDIT"
          title="反方 Audit / 收编许可"
          icon={<ShieldQuestion className="h-4 w-4" aria-hidden="true" />}
        />
        <div className="space-y-3">
          {(buildRun?.deviations.length ?? 0) === 0 ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                <p className="text-sm font-semibold">暂无计划外 diff</p>
              </div>
              <p className="mt-1 text-xs">Audit 没有发现需要人工解释的偏航。</p>
            </div>
          ) : (
            <div className="max-h-[17rem] space-y-2 overflow-auto">
              {buildRun?.deviations.map((item) => (
                <div key={`${item.file}:${item.reason}`} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 font-mono text-[11px] font-semibold ${
                      item.severityHint === "P1"
                        ? "bg-orange-100 text-orange-800"
                        : "bg-yellow-100 text-yellow-800"
                    }`}>
                      {item.severityHint}
                    </span>
                    <span className="text-xs text-muted-foreground">{deviationReasonCopy(item.reason)}</span>
                  </div>
                  <ProducedFile
                    projectId={projectId}
                    changeId={changeId}
                    path={item.file}
                    label={item.file}
                    className="mt-2 w-full break-all text-xs"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="rounded-md border p-3 text-xs">
            <p className="font-medium text-muted-foreground">产物状态</p>
            <div className="mt-2 space-y-1">
              <p>Build 结果：{artifactStatus(buildRun?.reportPath)}</p>
              <p>Audit 记录：{artifactStatus(buildRun?.auditPath)}</p>
              <p>Patch 包：{artifactStatus(buildRun?.patchPath)}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
