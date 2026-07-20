"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  BriefingQuestion,
  BriefingQuestionSeverity,
  BriefingQuestionStatus,
  PrdBriefingState,
  StageProgressDto,
} from "./prd-briefing-types";
import type { StageActionView } from "./stage-action-bar";
import type { AiProvider } from "./pipeline-action-contract";

type QuestionAction = "answer" | "accept_assumption" | "defer";

const STEP_LABELS = [
  { key: "intent", label: "Intent" },
  { key: "questions", label: "Questions" },
  { key: "draft", label: "Draft" },
  { key: "review", label: "Review" },
  { key: "locked", label: "Locked" },
] as const;

const SEVERITY_LABELS: Record<BriefingQuestionSeverity, string> = {
  critical: "关键",
  important: "重要",
  optional: "可选",
};

const SEVERITY_CLASS: Record<BriefingQuestionSeverity, string> = {
  critical: "border-red-300 bg-red-50 text-red-950",
  important: "border-amber-300 bg-amber-50 text-amber-950",
  optional: "border-slate-200 bg-slate-50 text-slate-800",
};

const STATUS_LABELS: Record<BriefingQuestionStatus, string> = {
  open: "待处理",
  answered: "已回答",
  assumption_accepted: "已接受假设",
  deferred: "已推迟",
};

const STAGE_PHASE_LABELS: Record<string, string> = {
  prd_briefing_questions: "追问",
  prd_briefing_draft: "草稿",
  prd_briefing_final_review: "终审",
};

const STAGE_STATUS_LABELS: Record<string, string> = {
  started: "已开始",
  provider_running: "AI 运行中",
  ingesting: "解析输出中",
  file_candidate: "读取候选文件",
  repairing: "修复输出中",
  completed: "已完成",
  failed: "失败",
  invalid_output: "输出格式无效",
  mirror_write_failed: "镜像写入失败",
};

function normalizeState(payload: PrdBriefingState | { state?: PrdBriefingState }): PrdBriefingState {
  return "state" in payload && payload.state ? payload.state : (payload as PrdBriefingState);
}

function parseSourceHashes(state: PrdBriefingState | null): Record<string, string> {
  if (!state?.briefing?.sourceHashesJson) return {};
  try {
    const parsed = JSON.parse(state.briefing.sourceHashesJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getActiveStep(state: PrdBriefingState | null) {
  if (state?.briefing?.status === "locked") return "locked";
  if (state?.finalReview) return "review";
  if (state?.latestDraft) return "draft";
  if ((state?.questions.length ?? 0) > 0) return "questions";
  return "intent";
}

function stageProgressText(progress: StageProgressDto | null | undefined) {
  if (!progress) return null;
  const phase = STAGE_PHASE_LABELS[progress.phase] ?? progress.phase;
  const status = STAGE_STATUS_LABELS[progress.status] ?? progress.status;
  return `${phase}: ${status}`;
}

function statusText(state: PrdBriefingState | null) {
  const progress = stageProgressText(state?.stageProgress);
  if (progress) return progress;
  if (state?.activeRun?.status === "running") return "反方行动中";
  if (state?.activeRun?.status === "failed") return "反方行动失败";
  if (!state?.briefing?.intentText) return "等待输入";
  if (state.briefing.status === "locked") return "已锁定";
  if (state.finalReview) return "终审完成";
  if (state.latestDraft) return "草稿就绪";
  if (state.questions.length > 0) return "追问就绪";
  return "意图已保存";
}

function verdictLabel(verdict?: string) {
  if (verdict === "ready") return "可进入 Spec";
  if (verdict === "risky_but_allowed") return "有风险但可进入";
  if (verdict === "needs_answer") return "需要补充回答";
  return "等待终审";
}

function jobMarker(kind: "questions" | "draft" | "final-review", state: PrdBriefingState | null): string {
  if (kind === "questions") {
    return (state?.questions ?? [])
      .map((question) => `${question.id}:${question.updatedAt}`)
      .join("|");
  }
  if (kind === "draft") return state?.latestDraft?.id ?? "";
  return state?.briefing?.finalReviewJson ?? "";
}

function runFailed(state: PrdBriefingState): string | null {
  if (state.stageProgress?.status === "failed" || state.stageProgress?.status === "invalid_output") {
    return state.stageProgress.message || stageProgressText(state.stageProgress) || "PRD AI job failed";
  }
  if (state.activeRun?.status !== "failed") return null;
  return state.activeRun.summary || "PRD AI job failed";
}

function stageProgressNotice(state: PrdBriefingState | null): { tone: "info" | "success" | "error"; text: string } | null {
  const progress = state?.stageProgress;
  if (!progress) return null;
  const label = stageProgressText(progress);
  const text = progress.message ? `${label}: ${progress.message}` : label;
  if (!text) return null;
  if (progress.status === "completed") return { tone: "success", text };
  if (progress.status === "failed" || progress.status === "invalid_output" || progress.status === "mirror_write_failed") {
    return { tone: "error", text };
  }
  return { tone: "info", text };
}

function QuestionCard({
  question,
  value,
  busy,
  onChange,
  onAction,
}: {
  question: BriefingQuestion;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onAction: (action: QuestionAction, value: string) => void;
}) {
  const isOpen = question.status === "open";
  const answerValue = value.trim();
  const assumption = (question.suggestedDefault ?? value).trim() || "接受 AI 默认假设";

  return (
    <div className={`rounded-md border p-3 ${SEVERITY_CLASS[question.severity]}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-background/80 px-2 py-0.5 text-[11px] font-medium">
          {SEVERITY_LABELS[question.severity]}
        </span>
        <span className="rounded bg-background/70 px-2 py-0.5 text-[11px]">
          {STATUS_LABELS[question.status]}
        </span>
        <span className="font-mono text-[11px] opacity-70">{question.category}</span>
      </div>
      <p className="text-sm font-medium">{question.question}</p>
      <p className="mt-1 text-xs opacity-75">{question.whyItMatters}</p>
      {question.suggestedDefault && (
        <p className="mt-2 rounded border border-current/10 bg-background/70 px-2 py-1 text-xs">
          默认假设: {question.suggestedDefault}
        </p>
      )}
      {question.answer && question.status !== "open" && (
        <p className="mt-2 rounded bg-background/80 px-2 py-1 text-xs">
          处理: {question.answer}
        </p>
      )}
      {isOpen && (
        <div className="mt-3 space-y-2">
          <textarea
            className="min-h-20 w-full resize-y rounded border bg-background px-3 py-2 text-sm text-foreground"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="输入你的回答..."
            disabled={busy}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !answerValue}
              onClick={() => onAction("answer", answerValue)}
            >
              回答
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onAction("accept_assumption", assumption)}
            >
              接受假设
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onAction("defer", answerValue || "推迟到 Spec 阶段处理")}
            >
              稍后处理
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PrdBriefingRoom({
  projectId,
  changeId,
  initialState,
  onLocked,
  onStageActionsChange,
  selectedProvider,
}: {
  projectId: string;
  changeId: string;
  initialState: PrdBriefingState | null;
  onLocked: () => void;
  onStageActionsChange?: (actions: StageActionView[]) => void;
  selectedProvider?: AiProvider;
}) {
  const [state, setState] = useState<PrdBriefingState | null>(initialState);
  const [rawText, setRawText] = useState(initialState?.briefing?.intentText ?? "");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pollingAction, setPollingAction] = useState<"questions" | "draft" | "final-review" | null>(null);
  const [loading, setLoading] = useState(!initialState);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rawTextDirtyRef = useRef(false);

  const syncState = useCallback((nextState: PrdBriefingState) => {
    setState(nextState);
    if (!rawTextDirtyRef.current) {
      setRawText(nextState.briefing?.intentText ?? "");
    }
  }, []);

  const handleRawTextChange = useCallback((value: string) => {
    rawTextDirtyRef.current = true;
    setRawText(value);
  }, []);

  const loadState = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/prd-briefing`, {
      cache: "no-store",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "PRD Briefing 加载失败");
    const nextState = normalizeState(data);
    syncState(nextState);
    return nextState;
  }, [projectId, changeId, syncState]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPollingAction(null);
  }, []);

  const jobComplete = useCallback((kind: "questions" | "draft" | "final-review", previousMarker: string, nextState: PrdBriefingState) => {
    return jobMarker(kind, nextState) !== previousMarker;
  }, []);

  const startPolling = useCallback((kind: "questions" | "draft" | "final-review", previousMarker: string) => {
    stopPolling();
    setPollingAction(kind);
    let ticks = 0;
    pollRef.current = setInterval(() => {
      ticks += 1;
      loadState()
        .then((nextState) => {
          const failure = runFailed(nextState);
          if (jobComplete(kind, previousMarker, nextState)) {
            stopPolling();
            return;
          }
          if (failure) {
            setError(failure);
            stopPolling();
            return;
          }
          if (nextState.activeRun?.status === "completed") {
            setError("AI job 已结束，但 PRD 产物没有更新。请重试这一招。");
            stopPolling();
            return;
          }
          if (ticks >= 120) {
            setError("AI job 仍在运行或没有产物更新。请稍后刷新战报。");
            stopPolling();
          }
        })
        .catch((err) => setError(String(err)));
    }, 1500);
  }, [jobComplete, loadState, stopPolling]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/changes/${changeId}/prd-briefing`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "PRD Briefing 加载失败");
        return normalizeState(data);
      })
      .then((nextState) => {
        if (cancelled) return;
        syncState(nextState);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [projectId, changeId, stopPolling, syncState]);

  const requestCommandJson = useCallback(async (
    url: string,
    options: RequestInit = {},
  ) => {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "操作失败");
    if (data.accepted !== true || typeof data.jobId !== "string") {
      throw new Error("AI 任务回执无效");
    }
    return data as { accepted: true; jobId: string; status?: string };
  }, []);

  const requestStateJson = useCallback(async (
    url: string,
    options: RequestInit = {},
  ) => {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "操作失败");
    const nextState = normalizeState(data);
    syncState(nextState);
    return nextState;
  }, [syncState]);

  const saveIntent = async () => {
    setBusyAction("intent");
    setError("");
    try {
      await requestStateJson(`/api/projects/${projectId}/changes/${changeId}/prd-briefing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText }),
      });
      rawTextDirtyRef.current = false;
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const startAiJob = async (kind: "questions" | "draft" | "final-review") => {
    setBusyAction(kind);
    setError("");
    const previousMarker = jobMarker(kind, state);
    try {
      await requestCommandJson(`/api/projects/${projectId}/changes/${changeId}/prd-briefing/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider }),
      });
      startPolling(kind, previousMarker);
    } catch (err) {
      stopPolling();
      setError(String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleQuestionAction = async (
    questionId: string,
    action: QuestionAction,
    value: string,
  ) => {
    setBusyAction(questionId);
    setError("");
    try {
      await requestStateJson(`/api/projects/${projectId}/changes/${changeId}/prd-briefing/questions/${questionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, value }),
      });
      setAnswers((prev) => ({ ...prev, [questionId]: "" }));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const lockPrd = useCallback(async () => {
    setBusyAction("lock");
    setError("");
    try {
      await requestStateJson(`/api/projects/${projectId}/changes/${changeId}/prd-briefing/lock`, {
        method: "POST",
      });
      onLocked();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyAction(null);
    }
  }, [changeId, onLocked, projectId, requestStateJson]);

  const hashes = useMemo(() => parseSourceHashes(state), [state]);
  const hasIntent = Boolean(state?.briefing?.intentText?.trim());
  const isLocked = state?.briefing?.status === "locked";
  const openCritical = state?.questions.filter(
    (question) => question.severity === "critical" && question.status === "open",
  ) ?? [];
  const hasQuestions = (state?.questions.length ?? 0) > 0;
  const draftFresh = Boolean(state?.latestDraft && state.gate.draftFresh);
  const finalReviewFresh = Boolean(
    state?.finalReview
      && state.latestDraft
      && hashes.finalReviewInputHash === hashes.currentInputHash
      && hashes.finalReviewDraftHash === state.latestDraft.draftHash,
  );
  const finalReviewAllowed = Boolean(
    state?.finalReview
      && ["ready", "risky_but_allowed"].includes(state.finalReview.verdict)
      && state.finalReview.blockingQuestionIds.length === 0,
  );
  const canSaveIntent = rawText.trim().length > 0 && !isLocked;
  const canAskQuestions = hasIntent && !isLocked;
  const canDraft = hasIntent && hasQuestions && openCritical.length === 0 && !isLocked;
  const canFinalReview = draftFresh && !isLocked;
  const canLock = draftFresh && finalReviewFresh && finalReviewAllowed && !isLocked;
  const runInProgress = state?.activeRun?.status === "running";
  const actionLocked = loading || busyAction !== null || pollingAction !== null || runInProgress;
  const activeStep = getActiveStep(state);
  const activeStepIndex = Math.max(
    0,
    STEP_LABELS.findIndex((step) => step.key === activeStep),
  );
  const groupedQuestions = state?.questions ?? [];
  const answeredQuestionCount = groupedQuestions.filter((question) => question.status !== "open").length;
  const progressNotice = stageProgressNotice(state);
  const lockDisabledReason = isLocked
    ? "PRD 已锁定"
    : actionLocked
      ? "PRD 操作进行中"
      : canLock
        ? null
        : "PRD 草稿和终审通过后才能锁定。";
  const stageActions = useMemo<StageActionView[]>(() => [{
    id: "prd-lock",
    label: isLocked ? "PRD 已锁定" : "锁定 PRD",
    role: "primary",
    enabled: lockDisabledReason === null,
    busy: busyAction === "lock",
    providerBusy: actionLocked,
    disabledReason: lockDisabledReason,
    sourceActionId: "lock_prd",
    onAction: lockPrd,
  }], [actionLocked, busyAction, isLocked, lockDisabledReason, lockPrd]);

  useEffect(() => {
    onStageActionsChange?.(stageActions);
  }, [onStageActionsChange, stageActions]);

  useEffect(() => {
    return () => onStageActionsChange?.([]);
  }, [onStageActionsChange]);

  return (
    <section className="space-y-5" data-prd-briefing-workspace>
      <div className="space-y-3 border-b pb-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-semibold">需求基线</h3>
            <p className="mt-1 text-sm text-muted-foreground">{statusText(state)}</p>
          </div>
          <ol className="grid gap-2 text-xs sm:grid-cols-5 xl:min-w-[34rem]">
            {STEP_LABELS.map((step, index) => {
              const active = index === activeStepIndex;
              const done = index < activeStepIndex;
              return (
                <li
                  key={step.key}
                  className={`flex items-center gap-2 rounded-md border px-2.5 py-2 font-medium ${
                    active
                      ? "border-blue-300 bg-blue-50 text-blue-800"
                      : done
                        ? "border-green-200 bg-green-50 text-green-800"
                        : "border-muted bg-muted/30 text-muted-foreground"
                  }`}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-background text-[11px]">
                    {index + 1}
                  </span>
                  <span className="truncate">{step.label}</span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="grid gap-2 text-xs sm:grid-cols-3">
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <span className="text-muted-foreground">关键追问</span>
            <p className="mt-1 font-semibold text-foreground">
              {openCritical.length > 0 ? `${openCritical.length} 个未处理` : "已清空"}
            </p>
          </div>
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <span className="text-muted-foreground">PRD 草稿</span>
            <p className="mt-1 font-semibold text-foreground">
              {draftFresh ? "与输入一致" : state?.latestDraft ? "需要刷新" : "尚未生成"}
            </p>
          </div>
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <span className="text-muted-foreground">终审结论</span>
            <p className="mt-1 font-semibold text-foreground">{verdictLabel(state?.finalReview?.verdict)}</p>
          </div>
        </div>

        {(progressNotice || (state?.activeRun && ["running", "failed"].includes(state.activeRun.status))) && (
          <div className={`rounded-md border px-3 py-2 text-xs ${
            progressNotice?.tone === "error" || state?.activeRun?.status === "failed"
              ? "border-red-200 bg-red-50 text-red-700"
              : progressNotice?.tone === "success"
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-blue-200 bg-blue-50 text-blue-800"
          }`}>
            {progressNotice?.text
              ?? (state?.activeRun?.status === "running"
                ? "反方正在处理，本页会自动刷新战报。"
                : state?.activeRun?.summary || "反方行动失败，请修正后重试。")}
          </div>
        )}
      </div>

      <section className="rounded-md border bg-background p-4" data-prd-intent-panel>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">你的意图</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              这段文字是 PRD 草稿、追问和终审的输入源。
            </p>
          </div>
          {loading && <span className="text-xs text-muted-foreground">加载中...</span>}
        </div>
        <textarea
          className="min-h-32 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-6"
          value={rawText}
          onChange={(event) => handleRawTextChange(event.target.value)}
          placeholder="用几句话写清楚要做什么、为什么做、最小成功标准。"
          disabled={loading || isLocked || actionLocked}
        />
        {!isLocked && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!canSaveIntent || actionLocked}
              onClick={saveIntent}
            >
              {busyAction === "intent" ? "保存中..." : "保存意图"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canAskQuestions || actionLocked}
              onClick={() => startAiJob("questions")}
            >
              {busyAction === "questions" || pollingAction === "questions" ? "追问中..." : "生成追问"}
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-md border bg-background p-4" data-prd-questions-panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">反方追问卡</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {groupedQuestions.length > 0
                ? `${answeredQuestionCount}/${groupedQuestions.length} 已处理`
                : "保存意图后生成第一批追问。"}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {openCritical.length > 0 ? `${openCritical.length} 个关键问题未处理` : "关键问题已清空"}
          </span>
        </div>
        {groupedQuestions.length === 0 ? (
          <div className="mt-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            保存意图后，让反方生成第一批追问。
          </div>
        ) : (
          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            {groupedQuestions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                value={answers[question.id] ?? ""}
                busy={actionLocked}
                onChange={(value) => setAnswers((prev) => ({ ...prev, [question.id]: value }))}
                onAction={(action, value) => handleQuestionAction(question.id, action, value)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-md border bg-background p-4" data-prd-draft-panel>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">PRD 草稿</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {draftFresh ? "草稿与当前输入一致" : state?.latestDraft ? "草稿需要刷新" : "尚未生成"}
            </p>
          </div>
          {!isLocked && (
            <Button
              type="button"
              size="sm"
              disabled={!canDraft || actionLocked}
              onClick={() => startAiJob("draft")}
            >
              {busyAction === "draft" || pollingAction === "draft" ? "生成中..." : "生成草稿"}
            </Button>
          )}
        </div>
        {state?.latestDraft ? (
          <article className="max-h-[34rem] overflow-auto rounded-md border bg-muted/20 p-4 text-sm leading-6 whitespace-pre-wrap">
            {state.latestDraft.markdown}
          </article>
        ) : (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            处理完关键追问后生成 PRD 草稿。
          </div>
        )}
      </section>

      <section className="rounded-md border bg-background p-4" data-prd-review-panel>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">终审结论</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              清晰度 {state?.gate.clarityLevel ?? "low"} · 风险 {state?.gate.riskLevel ?? "low"}
            </p>
          </div>
          {!isLocked && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canFinalReview || actionLocked}
              onClick={() => startAiJob("final-review")}
            >
              {busyAction === "final-review" || pollingAction === "final-review" ? "终审中..." : "终审"}
            </Button>
          )}
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <span className={`rounded-md px-2 py-1 ${state?.gate.canLock ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
            Draft Gate: {state?.gate.canLock ? "可锁定" : "未通过"}
          </span>
          <span className={`rounded-md px-2 py-1 ${finalReviewAllowed ? "bg-green-100 text-green-800" : "bg-muted text-muted-foreground"}`}>
            Verdict: {verdictLabel(state?.finalReview?.verdict)}
          </span>
        </div>
        {state?.finalReview && (
          <div className="mt-3 rounded-md bg-muted/40 p-3 text-sm leading-6">
            <p>{state.finalReview.riskSummary}</p>
            {state.finalReview.blockingQuestionIds.length > 0 && (
              <p className="mt-2 text-xs text-red-600">
                阻塞问题: {state.finalReview.blockingQuestionIds.join(", ")}
              </p>
            )}
            {!finalReviewFresh && (
              <p className="mt-2 text-xs text-amber-700">输入变更后需要重新终审。</p>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
