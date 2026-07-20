"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionReasonDialog } from "./action-reason-dialog";
import { selectReviewFindingWaiverContext, waivableFindingLocator } from "./action-reason-context";
import { ProducedFile } from "./produced-file";
import type { StageActionView } from "./stage-action-bar";
import {
  createIdempotencyKey,
  createPipelinePreflightPayload,
  findPipelineAction,
  pipelineActionDisabledReason,
  type AiProvider,
  type PipelineActionContract,
} from "./pipeline-action-contract";

export type ReviewRunStatus =
  | "running"
  | "passed"
  | "issues_found"
  | "failed"
  | "invalid_output"
  | "data_inconsistent";

export type ReviewCenterGateStatus =
  | "not_started"
  | "running"
  | "passed"
  | "blocked_p0"
  | "blocked_p1"
  | "failed"
  | "invalid_output"
  | "data_inconsistent"
  | "stale";

export interface ReviewCenterAttempt {
  runId: string;
  runStatus: string;
  reviewStatus: ReviewRunStatus;
  sourceBuildRunId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  findingCount: number;
}

export type ReviewCenterActionId =
  | "run_review"
  | "retry_review"
  | "fix_blockers"
  | "waive_review_p1"
  | "enter_qa"
  | "stop_change"
  | "recompute_report"
  | "rebuild_mirror";

export interface ReviewCenterAction {
  id: ReviewCenterActionId;
  enabled: boolean;
  reason: string | null;
  idempotencyRequired: boolean;
}

export interface ReviewCenterCounts {
  p0: number;
  p1: number;
  p2: number;
  waived: number;
}

export interface ReviewFindingView {
  id: string;
  changeId: string;
  runId: string;
  source: "review";
  severity: "P0" | "P1" | "P2";
  category: string;
  title: string;
  file: string | null;
  line: number | null;
  evidence: string;
  requiredFix: string | null;
  status: "open" | "fixed" | "waived";
  waivable: boolean;
  createdAt: string;
  updatedAt: string | null;
  isLegacyIncomplete: boolean;
  isNotRechecked: boolean;
}

export interface ReviewCenterResponse {
  headlineStatus: ReviewCenterGateStatus;
  qaAllowed: boolean;
  latestAttempt: ReviewCenterAttempt | null;
  latestValidReview: ReviewCenterAttempt | null;
  counts: ReviewCenterCounts;
  gate: {
    status: ReviewCenterGateStatus;
    canEnterQa: boolean;
    reason: string | null;
    sourceBuildRunId: string | null;
    latestBuildRunId: string | null;
  };
  findings: ReviewFindingView[];
  waivers: Array<{
    findingId: string;
    title: string;
    severity: "P1";
    reason: string | null;
    decisionId: string | null;
  }>;
  mirrorWarnings: Array<{
    kind: string;
    status: string;
    reason: string | null;
    artifactId: string | null;
  }>;
  actions: {
    run_review?: ReviewCenterAction;
    retry_review?: ReviewCenterAction;
    fix_blockers?: ReviewCenterAction;
    waive_review_p1?: ReviewCenterAction;
    enter_qa?: ReviewCenterAction;
    stop_change?: ReviewCenterAction;
    recompute_report?: ReviewCenterAction;
    rebuild_mirror?: ReviewCenterAction;
    canRunReview: boolean;
    canRetryReview: boolean;
    canFixBlockers: boolean;
    canWaiveP1: boolean;
    canEnterQa: boolean;
    canStopChange: boolean;
  };
  advancedDetails: {
    latestAttempt: ReviewAttemptAdvancedDetails | null;
    latestValidReview: ReviewAttemptAdvancedDetails | null;
  };
}

interface ReviewAttemptAdvancedDetails {
  attemptId: string | null;
  reportArtifactId: string | null;
  reportDbHash: string | null;
  findingsDbHash: string | null;
  sourceBuildRunId: string | null;
  sanitizedErrorSummary: string | null;
  rawOutputArtifact: {
    id: string;
    type: string;
    path: null;
    createdAt: string;
  } | null;
  mirrors: Array<{
    kind: string;
    status: string | null;
    artifactId: string | null;
    contentHash: string | null;
    artifactHash: string | null;
    sourceDbHash: string | null;
    schemaVersion: string | null;
    path: null;
  }>;
}

const GATE_COPY: Record<ReviewCenterGateStatus, { label: string; tone: string; description: string }> = {
  not_started: {
    label: "待审查",
    tone: "border-slate-300 bg-slate-50 text-slate-800",
    description: "Build 已收编，等待反方 Reviewer 出战。",
  },
  running: {
    label: "反方审查中",
    tone: "border-blue-300 bg-blue-50 text-blue-800",
    description: "反方正在检查代码包，Review 结果生成前不能进入 QA。",
  },
  failed: {
    label: "审查失败",
    tone: "border-red-300 bg-red-50 text-red-800",
    description: "反方执行失败，需要重新审查。",
  },
  invalid_output: {
    label: "输出不合格",
    tone: "border-red-300 bg-red-50 text-red-800",
    description: "反方输出缺少必要字段，不能当作有效 Review 结果。",
  },
  data_inconsistent: {
    label: "结果不一致",
    tone: "border-red-300 bg-red-50 text-red-800",
    description: "Review 摘要和数据库记录不一致，需要重新结算。",
  },
  stale: {
    label: "结果过期",
    tone: "border-amber-300 bg-amber-50 text-amber-900",
    description: "Build 或人工裁决改变了事实，需要重新审查。",
  },
  blocked_p0: {
    label: "P0 阻断",
    tone: "border-red-400 bg-red-50 text-red-900",
    description: "存在必须修复的问题，不能豁免，也不能进入 QA。",
  },
  blocked_p1: {
    label: "P1 待裁决",
    tone: "border-orange-300 bg-orange-50 text-orange-900",
    description: "存在重大风险，可以修复，或由人类填写理由接受风险。",
  },
  passed: {
    label: "可进入 QA",
    tone: "border-emerald-300 bg-emerald-50 text-emerald-900",
    description: "Review 结果已通过当前 QA gate。",
  },
};

function countLabel(label: string, value: number, className: string) {
  return (
    <div className={`rounded-md border px-3 py-2 ${className}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function statusText(status: string | null | undefined) {
  if (!status) return "无";
  return status.replace(/_/g, " ");
}

function findingBadge(finding: ReviewFindingView) {
  if (finding.isNotRechecked) return "未复核";
  if (finding.isLegacyIncomplete) return "历史不完整 Review";
  if (finding.status === "waived") return "已接受";
  return finding.status === "open" ? "待处理" : "已关闭";
}

function reviewCenterActionDisabledReason(action: ReviewCenterAction | undefined): string | null {
  if (!action) return "Action contract unavailable.";
  if (action.enabled) return null;
  return action.reason ?? "Action is not available.";
}

export function resolveReviewRunCommand(input: {
  gate: ReviewCenterGateStatus;
  centerActions?: ReviewCenterResponse["actions"] | null;
  pipelineActions?: PipelineActionContract[];
}): {
  actionId: "run_review" | "retry_review";
  label: string;
  enabled: boolean;
  disabledReason: string | null;
} {
  const actionId = input.gate === "not_started" ? "run_review" : "retry_review";
  const centerReason = input.centerActions
    ? reviewCenterActionDisabledReason(input.centerActions[actionId])
    : null;
  const runningReason = input.gate === "running" && !input.centerActions
    ? "Review is still running."
    : null;
  const pipelineReason = pipelineActionDisabledReason(findPipelineAction(input.pipelineActions, actionId));
  const disabledReason = centerReason ?? runningReason ?? pipelineReason;
  return {
    actionId,
    label: actionId === "run_review" ? "开始反方审查" : "重新审查",
    enabled: disabledReason === null,
    disabledReason,
  };
}

export function buildReviewStageActions(input: {
  runReviewCommand: ReturnType<typeof resolveReviewRunCommand>;
  actionBusy: boolean;
  p1Target: string | null;
  waiveReason: string | null;
  fixReason: string | null;
  enterQaReason: string | null;
  stopReason: string | null;
  recomputeReason: string | null;
  waiveAction: PipelineActionContract | null;
  fixAction: PipelineActionContract | null;
  enterQaAction: PipelineActionContract | null;
  stopAction: PipelineActionContract | null;
  recomputeAction: PipelineActionContract | null;
  onRunReview: (actionId: "run_review" | "retry_review") => void;
  onWaiveP1: () => void | Promise<void>;
  onFixBlockers: () => void;
  onRecomputeReport: () => void | Promise<void>;
  onEnterQa: () => void;
  onBlockChange: () => void;
}): StageActionView[] {
  const waiveDisabledReason = input.waiveReason ?? (input.p1Target ? null : "No open waivable P1 finding.");

  return [
    {
      id: "review-run",
      label: input.runReviewCommand.label,
      role: "primary",
      enabled: !input.actionBusy && input.runReviewCommand.enabled,
      busy: input.actionBusy,
      disabledReason: input.runReviewCommand.disabledReason,
      sourceActionId: input.runReviewCommand.actionId,
      onAction: () => input.onRunReview(input.runReviewCommand.actionId),
    },
    {
      id: "review-waive-p1",
      label: input.waiveAction?.label ?? "接受 P1 风险",
      role: "secondary",
      enabled: !input.actionBusy && waiveDisabledReason === null,
      busy: input.actionBusy,
      disabledReason: waiveDisabledReason,
      sourceActionId: input.waiveAction?.actionId ?? "waive_review_p1",
      onAction: input.onWaiveP1,
    },
    {
      id: "review-fix-blockers",
      label: input.fixAction?.label ?? "修复阻断项",
      role: "primary",
      enabled: !input.actionBusy && input.fixReason === null,
      busy: input.actionBusy,
      disabledReason: input.fixReason,
      sourceActionId: input.fixAction?.actionId ?? "fix_blockers",
      onAction: input.onFixBlockers,
    },
    {
      id: "review-recompute-report",
      label: input.recomputeAction?.label ?? "重新计算 Review 结果",
      role: "secondary",
      enabled: !input.actionBusy && input.recomputeReason === null,
      busy: input.actionBusy,
      disabledReason: input.recomputeReason,
      sourceActionId: input.recomputeAction?.actionId ?? "recompute_report",
      onAction: input.onRecomputeReport,
    },
    {
      id: "review-enter-qa",
      label: input.enterQaAction?.label ?? "进入 QA",
      role: "primary",
      enabled: !input.actionBusy && input.enterQaReason === null,
      busy: input.actionBusy,
      disabledReason: input.enterQaReason,
      sourceActionId: input.enterQaAction?.actionId ?? "enter_qa",
      onAction: input.onEnterQa,
    },
    {
      id: "review-stop-change",
      label: input.stopAction?.label ?? "终止 Change",
      role: "destructive",
      enabled: !input.actionBusy && input.stopReason === null,
      busy: input.actionBusy,
      disabledReason: input.stopReason,
      sourceActionId: input.stopAction?.actionId ?? "stop_change",
      onAction: input.onBlockChange,
    },
  ];
}

/**
 * Every finding the P1 waiver could land on, in report order. A Review P1 is
 * waivable only while it is still open and the finding itself allows it.
 */
export function selectWaivableP1Findings(
  findings: ReviewFindingView[] | null | undefined,
): ReviewFindingView[] {
  return (findings ?? []).filter(
    (finding) => finding.severity === "P1" && finding.status === "open" && finding.waivable,
  );
}

/**
 * The finding the waiver will actually hit. The human pick wins for as long as
 * it is still a candidate; once it stops being one — fixed, already waived, or
 * replaced by a fresh Review — the pick is dropped instead of being carried onto
 * a finding nobody chose. Falling back to the first target keeps the button
 * usable, and the picker below renders that fallback, so it is never silent.
 */
export function resolveWaiveP1Target(
  targets: ReviewFindingView[],
  selectedId: string | null | undefined,
): ReviewFindingView | null {
  return targets.find((finding) => finding.id === selectedId) ?? targets[0] ?? null;
}

/**
 * Says out loud what the waiver does and does not cover. Written for one target
 * as well as many: the picker renders whenever there is a target at all, so a
 * lone P1 still gets named on screen before the button is pressed.
 */
export function waiveP1TargetHint(targetCount: number): string {
  if (targetCount <= 1) return "「接受 P1 风险」只对这一项生效。";
  return `「接受 P1 风险」只对选中的这一项生效，其余 ${targetCount - 1} 项仍然阻断。`;
}

export function ReviewReportCenter({
  projectId,
  changeId,
  busy,
  actions,
  selectedProvider,
  initialState,
  onRunReview,
  onEnterQa,
  onFixBlockers,
  onBlockChange,
  onStateChange,
  onStageActionsChange,
  onStageActionError,
}: {
  projectId: string;
  changeId: string;
  busy: boolean;
  actions?: PipelineActionContract[];
  selectedProvider?: AiProvider;
  initialState?: ReviewCenterResponse | null;
  onRunReview: (actionId: "run_review" | "retry_review") => void;
  onEnterQa: () => void;
  onFixBlockers: () => void;
  onBlockChange: () => void;
  onStateChange?: (state: ReviewCenterResponse) => void;
  onStageActionsChange?: (actions: StageActionView[]) => void;
  onStageActionError?: (error: string | null) => void;
}) {
  const state = initialState ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [waiving, setWaiving] = useState(false);
  const [waiveDialogOpen, setWaiveDialogOpen] = useState(false);
  const [selectedP1FindingId, setSelectedP1FindingId] = useState("");

  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/review-center`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Review center load failed");
      onStateChange?.(data as ReviewCenterResponse);
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, changeId, onStateChange]);

  const postReviewCommand = useCallback(
    async (endpoint: "/review-report/recompute" | "/review-artifacts/rebuild") => {
      const action = endpoint === "/review-report/recompute"
        ? findPipelineAction(actions, "recompute_report")
        : findPipelineAction(actions, "rebuild_mirror");
      const disabledReason = pipelineActionDisabledReason(action);
      if (disabledReason) {
        setError(disabledReason);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/projects/${projectId}/changes/${changeId}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createPipelinePreflightPayload(action, { provider: selectedProvider })),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Review command failed");
        await loadState();
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [projectId, changeId, actions, selectedProvider, loadState]
  );

  const gate = state?.headlineStatus ?? state?.gate.status ?? "not_started";
  const gateCopy = GATE_COPY[gate];
  const counts = useMemo(() => {
    if (state?.counts) return state.counts;
    const all = state?.findings ?? [];
    return {
      p0: all.filter((finding) => finding.severity === "P0" && finding.status === "open").length,
      p1: all.filter((finding) => finding.severity === "P1" && finding.status === "open").length,
      p2: all.filter((finding) => finding.severity === "P2").length,
      waived: all.filter((finding) => finding.severity === "P1" && finding.status === "waived").length,
    };
  }, [state]);
  const p1Targets = useMemo(() => selectWaivableP1Findings(state?.findings), [state?.findings]);
  const p1Target = resolveWaiveP1Target(p1Targets, selectedP1FindingId)?.id ?? null;
  // The waiver is binding, so the dialog shows the finding it waives — and only that one.
  const waiverContext = useMemo(
    () => selectReviewFindingWaiverContext(state?.findings, p1Target),
    [state?.findings, p1Target],
  );
  const actionBusy = busy || loading || waiving;
  const runReviewCommand = useMemo(() => resolveReviewRunCommand({
    gate,
    centerActions: state?.actions,
    pipelineActions: actions,
  }), [gate, state?.actions, actions]);
  const waiveAction = findPipelineAction(actions, "waive_review_p1");
  const fixAction = findPipelineAction(actions, "fix_blockers");
  const enterQaAction = findPipelineAction(actions, "enter_qa");
  const stopAction = findPipelineAction(actions, "stop_change");
  const recomputeAction = findPipelineAction(actions, "recompute_report");
  const rebuildAction = findPipelineAction(actions, "rebuild_mirror");
  const waiveReason = pipelineActionDisabledReason(waiveAction);
  const fixReason = pipelineActionDisabledReason(fixAction);
  const enterQaReason = pipelineActionDisabledReason(enterQaAction);
  const stopReason = pipelineActionDisabledReason(stopAction);
  const recomputeReason = pipelineActionDisabledReason(recomputeAction);
  const rebuildReason = pipelineActionDisabledReason(rebuildAction);

  const submitP1Waiver = async (reason: string) => {
    if (!p1Target) return;
    setWaiveDialogOpen(false);
    setWaiving(true);
    setError("");
    try {
      const res = await fetch(
        `/api/projects/${projectId}/changes/${changeId}/findings/${p1Target}/waive`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason,
            ...createPipelinePreflightPayload(waiveAction, {
              idempotencyKey: createIdempotencyKey("waive_review_p1"),
            }),
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "P1 waiver failed");
      await loadState();
    } catch (err) {
      setError(String(err));
    } finally {
      setWaiving(false);
    }
  };

  const waiveP1 = useCallback(async () => {
    if (!p1Target) return;
    // Pin the target before the dialog opens. From here it is a human choice, so
    // a background refresh that reorders the findings must not slide the waiver
    // onto a different one while the reason is being typed.
    setSelectedP1FindingId(p1Target);
    setWaiveDialogOpen(true);
  }, [p1Target]);

  const stageActions = useMemo<StageActionView[]>(() => buildReviewStageActions({
    runReviewCommand,
    actionBusy,
    p1Target,
    waiveReason,
    fixReason,
    enterQaReason,
    stopReason,
    recomputeReason,
    waiveAction,
    fixAction,
    enterQaAction,
    stopAction,
    recomputeAction,
    onRunReview,
    onWaiveP1: waiveP1,
    onFixBlockers,
    onRecomputeReport: () => postReviewCommand("/review-report/recompute"),
    onEnterQa,
    onBlockChange,
  }), [
    runReviewCommand,
    actionBusy,
    p1Target,
    waiveReason,
    fixReason,
    enterQaReason,
    stopReason,
    recomputeReason,
    waiveAction,
    fixAction,
    enterQaAction,
    stopAction,
    recomputeAction,
    onRunReview,
    waiveP1,
    onFixBlockers,
    postReviewCommand,
    onEnterQa,
    onBlockChange,
  ]);

  useEffect(() => {
    onStageActionsChange?.(stageActions);
  }, [onStageActionsChange, stageActions]);

  useEffect(() => {
    return () => {
      onStageActionsChange?.([]);
    };
  }, [onStageActionsChange]);

  useEffect(() => {
    onStageActionError?.(error || null);
  }, [error, onStageActionError]);

  useEffect(() => {
    return () => {
      onStageActionError?.(null);
    };
  }, [onStageActionError]);

  return (
    <div className="space-y-4">
      <ActionReasonDialog
        open={waiveDialogOpen}
        title="填写 P1 风险接受理由"
        description="提交前请写明本次人工接受 Review P1 风险的依据。"
        confirmLabel="提交"
        required
        context={waiverContext}
        busy={waiving}
        onOpenChange={setWaiveDialogOpen}
        onConfirm={submitP1Waiver}
      />
      <section className="space-y-2" aria-label="Review facts">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review 事实</p>
        <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2 xl:grid-cols-5">
          <span>结果状态: {gateCopy.label}</span>
          <span>最近尝试: {state?.latestAttempt?.runId ?? "未开始"} / {statusText(state?.latestAttempt?.reviewStatus)}</span>
          <span>上一轮有效 Review: {state?.latestValidReview?.runId ?? "无"}</span>
          <span>Build: {state?.gate.latestBuildRunId ?? "无 adopted build"}</span>
          <span>QA: {state?.qaAllowed ? "允许" : "未开放"}</span>
          {state?.gate.sourceBuildRunId && <span>Review 来源: {state.gate.sourceBuildRunId}</span>}
        </div>
        <p className="text-sm text-muted-foreground">{gateCopy.description}</p>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-medium">Review 结果</h3>
            <p className="text-sm text-muted-foreground">只展示阻断、复核和裁决信息，原始记录在下方折叠区。</p>
          </div>
          {loading && <span className="text-xs text-muted-foreground">加载中...</span>}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="grid gap-2 sm:grid-cols-4">
          {countLabel("P0 必修", counts.p0, "border-red-200 bg-red-50 text-red-900")}
          {countLabel("P1 待裁决", counts.p1, "border-orange-200 bg-orange-50 text-orange-900")}
          {countLabel("P2 记录", counts.p2, "border-yellow-200 bg-yellow-50 text-yellow-900")}
          {countLabel("P1 已接受", counts.waived, "border-emerald-200 bg-emerald-50 text-emerald-900")}
        </div>

        {p1Targets.length > 0 && (
          <div>
            <label
              className="mb-1 block text-xs font-medium text-muted-foreground"
              htmlFor="waive-review-p1-target"
            >
              接受风险目标
            </label>
            <select
              id="waive-review-p1-target"
              className="h-8 w-full rounded border bg-background px-2 text-xs"
              value={p1Target ?? ""}
              disabled={actionBusy || waiveReason !== null}
              onChange={(event) => setSelectedP1FindingId(event.target.value)}
            >
              {p1Targets.map((finding) => (
                <option key={finding.id} value={finding.id}>
                  {waivableFindingLocator(finding)} · {finding.title}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{waiveP1TargetHint(p1Targets.length)}</p>
          </div>
        )}

        <div className="space-y-2">
          {(state?.findings ?? []).length === 0 ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">没有 DB 记录的 Review findings。</div>
          ) : (
            state?.findings.map((finding) => (
              <div key={finding.id} className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-medium">{finding.severity} · {finding.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {finding.file ? (
                        <ProducedFile
                          projectId={projectId}
                          changeId={changeId}
                          path={finding.file}
                          label={finding.file}
                          className="font-mono"
                        />
                      ) : (
                        "未绑定文件"
                      )}
                      {finding.line ? `:${finding.line}` : ""}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">{findingBadge(finding)}</span>
                </div>
                <p className="mt-2 text-xs">{finding.evidence || "无 evidence"}</p>
                {finding.requiredFix && <p className="mt-1 text-xs">必须修复: {finding.requiredFix}</p>}
              </div>
            ))
          )}
        </div>

        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">高级详情</summary>
          <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
            <span>状态: {statusText(state?.latestAttempt?.reviewStatus)}</span>
            <span>错误摘要: {state?.advancedDetails.latestAttempt?.sanitizedErrorSummary ?? state?.gate.reason ?? "无"}</span>
            <span>尝试 artifact: {state?.advancedDetails.latestAttempt?.rawOutputArtifact?.id ?? "无"}</span>
            <span>Review artifact: {state?.advancedDetails.latestValidReview?.reportArtifactId ?? "无"}</span>
            <span>Review hash: {state?.advancedDetails.latestValidReview?.reportDbHash ?? "无"}</span>
            <span>findings hash: {state?.advancedDetails.latestValidReview?.findingsDbHash ?? "无"}</span>
            {(state?.mirrorWarnings ?? []).length > 0 && (
              <span>
                镜像需要处理: {state?.mirrorWarnings.map((warning) => `${warning.kind}:${warning.status}`).join(", ")}
              </span>
            )}
            {(state?.advancedDetails.latestValidReview?.mirrors ?? []).map((mirror) => (
              <span key={`${mirror.kind}-${mirror.artifactId ?? "none"}`}>
                镜像 {mirror.kind}: {mirror.status ?? "unknown"} / {mirror.artifactId ?? "无 artifact"} / {mirror.contentHash ?? "无 hash"}
              </span>
            ))}
            {(state?.waivers ?? []).map((waiver) => (
              <span key={waiver.findingId}>
                waiver {waiver.findingId}: {waiver.decisionId ?? "无裁决"} / {waiver.reason ?? "无理由"}
              </span>
            ))}
          </div>
        </details>

        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">高级动作</summary>
          <div className="mt-3 grid gap-2 sm:max-w-64">
            <Button
              variant="outline"
              disabled={actionBusy || rebuildAction?.enabled !== true}
              onClick={() => postReviewCommand("/review-artifacts/rebuild")}
              title={rebuildReason ?? undefined}
            >
              重建镜像
            </Button>
          </div>
        </details>
      </section>
    </div>
  );
}
