"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProducedFile } from "./produced-file";
import type { StageActionView } from "./stage-action-bar";
import {
  createPipelinePreflightPayload,
  findPipelineAction,
  pipelineActionDisabledReason,
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
  // No `actions` block. The review center used to serve a second opinion on
  // action enablement alongside the action contract, and the two had drifted:
  // retry_review was vetoed at blocked_p0/blocked_p1, and stop_change was still
  // the pre-fix `true` after the contract learned `no_active_run`. This type
  // had drifted from the wire too -- it named `waive_review_p1`, a key the
  // server never sent (it sent `waive_p1`), so that entry was permanently
  // undefined. The action contract (`usePipelineActions`) is the only authority
  // now; `qaAllowed` and `gate.canEnterQa` below remain the center's own, since
  // the review gate is the thing the center actually computes.
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

export function resolveReviewRunCommand(input: {
  gate: ReviewCenterGateStatus;
  pipelineActions?: PipelineActionContract[];
}): {
  actionId: "run_review" | "retry_review";
  label: string;
  enabled: boolean;
  disabledReason: string | null;
} {
  const actionId = input.gate === "not_started" ? "run_review" : "retry_review";
  // The review gate is the review center's own authority, and it carries the
  // one fact the action contract does not: a Review that is still running must
  // not be restarted out from under itself.
  //
  // Whether this change may retry *at all* is the action contract's call and
  // only the action contract's. The review center used to answer that question
  // too, from a private copy of the rule, and the two copies had drifted: the
  // center's list (failed / invalid_output / data_inconsistent / stale) left
  // out blocked_p0 and blocked_p1, so it vetoed the retry at exactly the states
  // that need it -- Review found a P0, and the button to re-run Review was
  // dead -- while the contract (whose requiredStatus list for retry_review
  // covers the post-failure change statuses) and the enqueue authority both
  // accepted the POST. The copy is gone; this resolver now reads the contract
  // and the gate, nothing else.
  const runningReason = input.gate === "running" ? "Review is still running." : null;
  const pipelineReason = pipelineActionDisabledReason(findPipelineAction(input.pipelineActions, actionId));
  const disabledReason = runningReason ?? pipelineReason;
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
  recomputeReason: string | null;
  recomputeAction: PipelineActionContract | null;
  onRunReview: (actionId: "run_review" | "retry_review") => void;
  onRecomputeReport: () => void | Promise<void>;
}): StageActionView[] {
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
      id: "review-recompute-report",
      label: input.recomputeAction?.label ?? "重新计算 Review 结果",
      role: "secondary",
      enabled: !input.actionBusy && input.recomputeReason === null,
      busy: input.actionBusy,
      disabledReason: input.recomputeReason,
      sourceActionId: input.recomputeAction?.actionId ?? "recompute_report",
      onAction: input.onRecomputeReport,
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
  initialState,
  onRunReview,
  onStateChange,
  onStageActionsChange,
  onStageActionError,
}: {
  projectId: string;
  changeId: string;
  busy: boolean;
  actions?: PipelineActionContract[];
  initialState?: ReviewCenterResponse | null;
  onRunReview: (actionId: "run_review" | "retry_review") => void;
  onStateChange?: (state: ReviewCenterResponse) => void;
  onStageActionsChange?: (actions: StageActionView[]) => void;
  onStageActionError?: (error: string | null) => void;
}) {
  const state = initialState ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
          body: JSON.stringify(createPipelinePreflightPayload(action)),
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
    [projectId, changeId, actions, loadState]
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
  const actionBusy = busy || loading;
  const runReviewCommand = useMemo(() => resolveReviewRunCommand({
    gate,
    pipelineActions: actions,
  }), [gate, actions]);
  const recomputeAction = findPipelineAction(actions, "recompute_report");
  const rebuildAction = findPipelineAction(actions, "rebuild_mirror");
  const recomputeReason = pipelineActionDisabledReason(recomputeAction);
  const rebuildReason = pipelineActionDisabledReason(rebuildAction);

  const stageActions = useMemo<StageActionView[]>(() => buildReviewStageActions({
    runReviewCommand,
    actionBusy,
    recomputeReason,
    recomputeAction,
    onRunReview,
    onRecomputeReport: () => postReviewCommand("/review-report/recompute"),
  }), [
    runReviewCommand,
    actionBusy,
    recomputeReason,
    recomputeAction,
    onRunReview,
    postReviewCommand,
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
