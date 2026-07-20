"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  FileText,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Swords,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  BattleDecisionAction,
  RequirementGap,
  SpecBattleGateState,
  SpecBattleState,
} from "./spec-battle-types";
import { effectiveSeverity, isActiveGap, severityTone } from "./action-reason-context";
import { ProducedFile } from "./produced-file";

interface SpecBattlefieldProps {
  projectId: string;
  changeId: string;
  specBattle: SpecBattleGateState;
  battleState: SpecBattleState | null;
  approveAction?: {
    enabled: boolean;
    reasonCode: string | null;
    reason: string | null;
  } | null;
  runTechSpecAction?: {
    enabled: boolean;
    reasonCode: string | null;
    reason: string | null;
  } | null;
  busy: boolean;
  loading: boolean;
  error?: string;
  onAcceptRisk: (targetId?: string | null) => void;
  onStopBattle: () => void;
  onBattleDecision: (action: BattleDecisionAction, targetId?: string | null) => void;
  onRestartBattle: () => void;
  onRegenerateReport: () => void;
}

function displayPath(value: string | null | undefined): string {
  if (!value) return "尚未生成";
  return value.split("/").pop() || value;
}

function statusCopy(specBattle: SpecBattleGateState): { label: string; tone: string; detail: string } {
  if (!specBattle.roundId) {
    return {
      label: "开战前",
      tone: "border-slate-200 bg-slate-50 text-slate-800",
      detail: "等待创建第 1 轮 Spec 对抗",
    };
  }
  if (specBattle.roundStatus === "red_running") {
    return {
      label: "我方代理修订中",
      tone: "border-red-200 bg-red-50 text-red-900",
      detail: "我方代理正在按你的意图修订 Spec / PRD Delta",
    };
  }
  if (specBattle.roundStatus === "blue_running") {
    return {
      label: "反方审查中",
      tone: "border-sky-200 bg-sky-50 text-sky-900",
      detail: "反方正在挑刺需求漏洞和边界风险",
    };
  }
  if (specBattle.roundStatus === "not_started") {
    return {
      label: "等待启动",
      tone: "border-amber-200 bg-amber-50 text-amber-900",
      detail: "本轮已创建，等待启动我方修订。",
    };
  }
  if (specBattle.roundStatus === "failed") {
    return {
      label: "Battle 失败",
      tone: "border-red-200 bg-red-50 text-red-900",
      detail: "本轮执行失败，请查看战报和高级详情后重新发起",
    };
  }
  if (!specBattle.reportFresh) {
    return {
      label: "战报待刷新",
      tone: "border-amber-200 bg-amber-50 text-amber-900",
      detail: specBattle.staleReason ?? "当前战报不是最新结算",
    };
  }
  if (specBattle.counts.blockingP0 > 0) {
    return {
      label: "P0 阻断",
      tone: "border-red-200 bg-red-50 text-red-900",
      detail: "必须继续对抗或终止 Battle",
    };
  }
  if (specBattle.counts.blockingP1 > 0) {
    return {
      label: "P1 风险",
      tone: "border-orange-200 bg-orange-50 text-orange-900",
      detail: "可以继续对抗，或接受风险后通过",
    };
  }
  return {
    label: "可通过",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-900",
    detail: "没有阻断型 Requirement Gap",
  };
}

function CommandButton({
  label,
  hint,
  disabled,
  onClick,
  variant = "outline",
  icon,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
  variant?: "default" | "outline" | "destructive";
  icon: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      className="h-auto min-h-14 justify-start gap-3 px-3 py-2 text-left"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-5">{label}</span>
        <span className="block whitespace-normal text-[11px] font-normal leading-4 opacity-75">{hint}</span>
      </span>
    </Button>
  );
}

function MiniCount({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={cn("rounded-md border px-3 py-2", tone)}>
      <p className="text-[11px] font-medium opacity-75">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold leading-none">{value}</p>
    </div>
  );
}

/**
 * Every gap the P1 waiver could land on, in report order. A Spec P1 stays
 * waivable while it is open or downgraded — the same pair the battlefield
 * already counts as blocking.
 */
export function selectWaivableP1Gaps(
  gaps: RequirementGap[] | null | undefined,
): RequirementGap[] {
  return (gaps ?? []).filter(
    (gap) => effectiveSeverity(gap) === "P1" && ["open", "downgraded"].includes(gap.status),
  );
}

/**
 * The gap the waiver will actually hit. The human pick wins for as long as it is
 * still a candidate; once it stops being one — resolved, already waived, or
 * replaced by a fresh round — the pick is dropped instead of being carried onto
 * a gap nobody chose. Falling back to the first target keeps the button usable,
 * and the picker below renders that fallback, so it is never silent.
 */
export function resolveWaiveP1Gap(
  targets: RequirementGap[],
  selectedId: string | null | undefined,
): RequirementGap | null {
  return targets.find((gap) => gap.id === selectedId) ?? targets[0] ?? null;
}

/**
 * Says out loud what accepting the risk does and does not cover. Written for one
 * target as well as many: the picker renders whenever there is a target at all,
 * so a lone P1 still gets named on screen before the button is pressed.
 */
export function waiveP1GapHint(targetCount: number): string {
  if (targetCount <= 1) return "「接受风险并通过」只对这一项生效。";
  return `「接受风险并通过」只对选中的这一项生效，其余 ${targetCount - 1} 项仍然阻断。`;
}

export function SpecBattlefield({
  projectId,
  changeId,
  specBattle,
  battleState,
  approveAction,
  runTechSpecAction,
  busy,
  loading,
  error,
  onAcceptRisk,
  onStopBattle,
  onBattleDecision,
  onRestartBattle,
  onRegenerateReport,
}: SpecBattlefieldProps) {
  const disabled = busy || loading;
  const latestRound = battleState?.latestRound ?? null;
  const rounds = useMemo(() => battleState?.rounds ?? [], [battleState?.rounds]);
  const gaps = useMemo(() => battleState?.gaps ?? [], [battleState?.gaps]);
  const fixClaims = useMemo(() => battleState?.fixClaims ?? [], [battleState?.fixClaims]);
  const gapReviews = useMemo(() => battleState?.gapReviews ?? [], [battleState?.gapReviews]);
  const decisions = useMemo(() => battleState?.decisions ?? [], [battleState?.decisions]);
  const roundDelta = battleState?.roundDelta ?? {
    resolvedThisRound: 0,
    stillOpen: 0,
    newlyFound: 0,
    notRechecked: 0,
  };
  const openGaps = gaps.filter(isActiveGap);
  const latestRoundFixClaims = latestRound ? fixClaims.filter((claim) => claim.roundId === latestRound.id) : [];
  const latestRoundGapReviews = latestRound ? gapReviews.filter((review) => review.roundId === latestRound.id) : [];
  const p1Targets = useMemo(() => selectWaivableP1Gaps(gaps), [gaps]);
  const [selectedP1GapId, setSelectedP1GapId] = useState("");
  const selectedP1Gap = resolveWaiveP1Gap(p1Targets, selectedP1GapId);
  const runningRoundStatuses = ["red_running", "blue_running"];
  const specBattleRunningStatus = runningRoundStatuses.includes(specBattle.roundStatus ?? "") ? specBattle.roundStatus : null;
  const latestRoundRunningStatus = runningRoundStatuses.includes(latestRound?.status ?? "") ? latestRound?.status ?? null : null;
  const runningRoundStatus = specBattleRunningStatus ?? latestRoundRunningStatus;
  const roundRunning = Boolean(runningRoundStatus);
  const currentRoundStatus = runningRoundStatus ?? specBattle.roundStatus ?? latestRound?.status ?? "";
  const roundWaitingToStart = currentRoundStatus === "not_started";
  const countsAreZero = Object.values(specBattle.counts).every((value) => value === 0);
  const status = statusCopy(
    roundRunning
      ? {
          ...specBattle,
          roundId: specBattle.roundId ?? latestRound?.id ?? null,
          roundStatus: currentRoundStatus,
        }
      : specBattle
  );
  const continueAction: BattleDecisionAction | null = specBattle.actions.returnToSpec.available
    ? "return_to_spec"
    : specBattle.actions.requestChanges.available
      ? "request_changes"
      : null;
  const canContinue = Boolean(continueAction) && !roundRunning;
  const reportStale = !roundRunning && !roundWaitingToStart && !specBattle.reportFresh;
  const canApproveGate = approveAction?.enabled === true;
  const canRunTechSpec = runTechSpecAction?.enabled === true;
  const canAcceptP1Risk = specBattle.actions.waiveP1.available && Boolean(selectedP1Gap);
  const canAcceptRisk = !reportStale && (canApproveGate || canRunTechSpec || canAcceptP1Risk);
  const approveLabel = roundRunning
    ? "等待战报"
    : reportStale
      ? "先刷新战报"
      : canApproveGate
      ? "批准进入 TechSpec"
      : canRunTechSpec
      ? "生成 TechSpec"
      : "接受风险并通过";
  const approveHint = roundRunning
    ? "回合完成后再判断是否可以进入 TechSpec"
    : reportStale
      ? "战报已过期，重新结算后再判断"
      : canApproveGate
      ? "批准 Spec Gate，并自动启动 TechSpec"
      : canRunTechSpec
      ? "Spec 已批准，启动 TechSpec"
      : "先接受一个 P1 风险";
  const roundLabel = latestRound ? `第 ${latestRound.roundNo} 轮` : "开战前";
  const roundFailed = currentRoundStatus === "failed";
  const maxRoundBlocked = specBattle.actions.returnToSpec.reason === "max_round_blocked" ||
    specBattle.actions.requestChanges.reason === "max_round_blocked";
  const continueLabel =
    roundWaitingToStart
      ? "启动本轮"
      : roundFailed
      ? "重跑本轮"
      : maxRoundBlocked
      ? "继续追加一轮"
      : "继续对抗一轮";

  const handleContinue = () => {
    if (roundRunning) return;
    if (roundWaitingToStart || roundFailed) {
      onRestartBattle();
      return;
    }
    if (continueAction) onBattleDecision(continueAction);
  };

  const handleAcceptRisk = () => {
    const target = selectedP1Gap?.id ?? null;
    // Pin the pick before the reason dialog opens. The waiver itself travels by
    // value, but the picker below keeps re-deriving its fallback, so a
    // background refresh that reorders the gaps would otherwise leave the screen
    // naming a different one than the dialog is about to waive.
    if (target) setSelectedP1GapId(target);
    onAcceptRisk(target);
  };

  return (
    <section className="mb-6 overflow-hidden rounded-lg border bg-background" aria-label="Spec 回合战场">
      <div className="border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded-md border px-2 py-1 text-xs font-semibold", status.tone)}>
                {status.label}
              </span>
              <h3 className="text-base font-semibold">Spec 回合战场</h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {roundLabel} · {status.detail}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <MiniCount label="P0" value={specBattle.counts.blockingP0} tone="border-red-200 bg-red-50 text-red-900" />
            <MiniCount label="P1" value={specBattle.counts.blockingP1} tone="border-orange-200 bg-orange-50 text-orange-900" />
            <MiniCount label="P2" value={specBattle.counts.nonBlockingP2} tone="border-yellow-200 bg-yellow-50 text-yellow-900" />
          </div>
        </div>
        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="border-b p-4 lg:border-r lg:border-b-0">
          <div className="mb-3 flex items-center gap-2">
            <Swords className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h4 className="text-sm font-semibold">战场</h4>
          </div>

          <div className="rounded-md border bg-[linear-gradient(to_right,rgba(15,23,42,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.06)_1px,transparent_1px)] bg-[size:28px_28px] p-3">
            <div className="grid gap-3">
              <div className="rounded-md border border-red-200 bg-red-50/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-red-950">我方代理出招</p>
                    <p className="mt-1 text-xs text-red-900/70">修订 Spec / PRD Delta</p>
                  </div>
                  <span className="rounded bg-background/80 px-2 py-1 font-mono text-[11px] text-red-900">
                    {latestRound?.status?.includes("red") ? (
                      latestRound.status
                    ) : (
                      <ProducedFile
                        projectId={projectId}
                        changeId={changeId}
                        path={latestRound?.redArtifactPath ?? undefined}
                        label={displayPath(latestRound?.redArtifactPath)}
                      />
                    )}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-center gap-2 text-xs font-medium text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>轮流交手</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <div className="rounded-md border border-sky-200 bg-sky-50/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-sky-950">反方审查</p>
                    <p className="mt-1 text-xs text-sky-900/70">挑刺需求漏洞和边界风险</p>
                  </div>
                  <span className="rounded bg-background/80 px-2 py-1 font-mono text-[11px] text-sky-900">
                    {latestRound?.status?.includes("blue") ? (
                      latestRound.status
                    ) : (
                      <ProducedFile
                        projectId={projectId}
                        changeId={changeId}
                        path={latestRound?.blueArtifactPath ?? undefined}
                        label={displayPath(latestRound?.blueArtifactPath)}
                      />
                    )}
                  </span>
                </div>
              </div>

              <div className="rounded-md border border-amber-200 bg-amber-50/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-amber-950">战报结算</p>
                    <p className="mt-1 text-xs text-amber-900/70">确定性统计阻断项和建议动作</p>
                  </div>
                  <span className="rounded bg-background/80 px-2 py-1 font-mono text-[11px] text-amber-900">
                    {specBattle.reportFresh ? "fresh" : specBattle.staleReason ?? "stale"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {!latestRound && (
            <p className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              当前尚未创建 Spec Battle round。启动 Spec 后会先由我方代理出招，再由反方审查并生成本轮战报。
            </p>
          )}
        </div>

        <div className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h4 className="text-sm font-semibold">本轮战报</h4>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MiniCount label="本轮已解决" value={roundDelta.resolvedThisRound} tone="border-emerald-200 bg-emerald-50 text-emerald-900" />
              <MiniCount label="仍在阻断" value={roundDelta.stillOpen} tone="border-orange-200 bg-orange-50 text-orange-900" />
              <MiniCount label="新发现" value={roundDelta.newlyFound} tone="border-sky-200 bg-sky-50 text-sky-900" />
              <MiniCount label="未复核" value={roundDelta.notRechecked} tone="border-red-200 bg-red-50 text-red-900" />
            </div>

            {roundDelta.notRechecked > 0 && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-900">
                反方本轮没有逐项复核全部旧 P0/P1，未复核项继续阻断；这不是新增 P1，而是旧问题没有完成消账。
              </p>
            )}

            <div className="rounded-md border p-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">我方本轮改进</p>
                  <p className="mt-1 min-w-0 break-words text-sm">
                    {displayPath(latestRound?.redArtifactPath)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">反方本轮攻击</p>
                  <p className="mt-1 text-sm">
                    {openGaps.length > 0 ? `${openGaps.length} 个未关闭 gap` : "暂无未关闭 Requirement Gap"}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-md border p-3">
              <p className="text-xs font-medium text-muted-foreground">结论</p>
              <p className="mt-1 text-sm leading-6">
                {roundRunning
                  ? "当前回合仍在运行，战报会在我方修订和反方审查完成后自动结算；完成后也可以手动刷新。"
                  : roundWaitingToStart && countsAreZero
                  ? "等待启动本轮后再结算是否可以进入 TechSpec。"
                  : reportStale
                  ? "战报已过期，请先刷新战报，再判断是否可以进入 TechSpec。"
                  : specBattle.counts.blockingP0 > 0
                  ? "存在 P0 阻断，不能通过。请继续对抗一轮，或终止 Battle。"
                  : specBattle.counts.blockingP1 > 0
                    ? "存在 P1 风险。你可以继续对抗，也可以接受风险后进入下一阶段。"
                    : "当前没有 P0/P1 阻断，可以通过进入 TechSpec。"}
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <CommandButton
                label={continueLabel}
                hint={roundRunning ? "等待本轮完成后再继续对抗" : roundWaitingToStart ? "通过 /spec 启动本轮我方修订" : roundFailed ? "重新进入我方代理出招和反方审查" : canContinue ? "让我方代理修、反方再审" : "当前没有可继续的阻断目标"}
                disabled={disabled || roundRunning || (!roundWaitingToStart && !roundFailed && !canContinue)}
                icon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}
                onClick={handleContinue}
              />
              <CommandButton
                label="刷新战报"
                hint={roundRunning ? "回合运行中不可刷新；请等待本轮战报生成" : "只重新结算，不重跑我方代理和反方"}
                disabled={disabled || roundRunning}
                icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                onClick={onRegenerateReport}
              />
              <CommandButton
                label={approveLabel}
                hint={approveHint}
                disabled={disabled || roundRunning || !canAcceptRisk}
                variant={canApproveGate || canRunTechSpec ? "default" : "outline"}
                icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                onClick={handleAcceptRisk}
              />
              <CommandButton
                label="终止 Battle"
                hint="停止本 change 的 Spec 推进"
                disabled={disabled}
                variant="destructive"
                icon={<XCircle className="h-4 w-4" aria-hidden="true" />}
                onClick={onStopBattle}
              />
            </div>

            <details className="rounded-md border bg-muted/20">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium">
                高级详情
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </summary>
              <div className="space-y-4 border-t bg-background p-3">
                <div>
                  <h5 className="text-sm font-semibold">我方修复声明 / 反方复核</h5>
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">我方修复声明</p>
                      {latestRoundFixClaims.length === 0 ? (
                        <p className="rounded border px-2 py-2 text-xs text-muted-foreground">暂无</p>
                      ) : (
                        latestRoundFixClaims.map((claim) => (
                          <div key={claim.id} className="rounded-md border border-red-200 bg-red-50/70 p-2 text-red-950">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px]">
                                {claim.canonicalGapId}
                              </span>
                              <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px]">
                                {claim.claimStatus}
                              </span>
                            </div>
                            <p className="mt-1 text-sm font-semibold">{claim.claimSummary}</p>
                            <p className="mt-1 line-clamp-3 text-xs leading-5 opacity-75">{claim.evidence}</p>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">反方复核</p>
                      {latestRoundGapReviews.length === 0 ? (
                        <p className="rounded border px-2 py-2 text-xs text-muted-foreground">暂无</p>
                      ) : (
                        latestRoundGapReviews.map((review) => (
                          <div key={review.id} className="rounded-md border border-sky-200 bg-sky-50/70 p-2 text-sky-950">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px]">
                                {review.canonicalGapId}
                              </span>
                              <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px]">
                                {review.verdict}
                              </span>
                            </div>
                            <p className="mt-1 text-sm font-semibold">{review.reviewSummary}</p>
                            <p className="mt-1 line-clamp-3 text-xs leading-5 opacity-75">
                              {review.resolutionEvidence ?? review.evidence}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <h5 className="text-sm font-semibold">Requirement Gaps</h5>
                  </div>
                  {gaps.length === 0 ? (
                    <p className="text-xs text-muted-foreground">反方尚未记录 Requirement Gap。</p>
                  ) : (
                    <div className="space-y-2">
                      {gaps.map((gap) => {
                        const severity = effectiveSeverity(gap);
                        return (
                          <div key={gap.id} className={cn("rounded-md border p-2", severityTone(severity))}>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px]">
                                {gap.canonicalGapId}
                              </span>
                              <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px]">
                                {severity} · {gap.status}
                              </span>
                            </div>
                            <p className="mt-1 text-sm font-semibold">{gap.title}</p>
                            <p className="mt-1 line-clamp-3 text-xs leading-5 opacity-75">{gap.evidence}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {p1Targets.length > 0 && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="accept-risk-gap">
                      接受风险目标
                    </label>
                    <select
                      id="accept-risk-gap"
                      className="h-8 w-full rounded border bg-background px-2 text-xs"
                      value={selectedP1Gap?.id ?? ""}
                      disabled={disabled || !specBattle.actions.waiveP1.available}
                      onChange={(event) => setSelectedP1GapId(event.target.value)}
                    >
                      {p1Targets.map((gap) => (
                        <option key={gap.id} value={gap.id}>
                          {gap.canonicalGapId} · {gap.title}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-muted-foreground">{waiveP1GapHint(p1Targets.length)}</p>
                  </div>
                )}

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <h5 className="text-sm font-semibold">回合历史</h5>
                    {rounds.length === 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">暂无回合。</p>
                    ) : (
                      <div className="mt-2 space-y-1">
                        {rounds.map((round) => (
                          <p key={round.id} className="rounded border px-2 py-1 font-mono text-[11px]">
                            R{round.roundNo} · {round.status}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <h5 className="text-sm font-semibold">人工记录</h5>
                    {decisions.length === 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">暂无人工裁决。</p>
                    ) : (
                      <div className="mt-2 space-y-1">
                        {decisions.slice(-4).reverse().map((decision) => (
                          <p key={decision.id} className="rounded border px-2 py-1 text-[11px]">
                            <span className="font-mono">{decision.action}</span>
                            {decision.reason ? ` · ${decision.reason}` : ""}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-md border bg-muted/30 p-2">
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    审计路径
                  </div>
                  <p className="min-w-0 break-words font-mono text-[11px] text-muted-foreground">
                    <ProducedFile
                      projectId={projectId}
                      changeId={changeId}
                      path={latestRound?.reportPath ?? undefined}
                      label={displayPath(latestRound?.reportPath)}
                    />
                    {" · "}
                    <ProducedFile
                      projectId={projectId}
                      changeId={changeId}
                      path={latestRound?.blueArtifactPath ?? undefined}
                      label={displayPath(latestRound?.blueArtifactPath)}
                    />
                  </p>
                </div>

                {approveAction?.enabled === false && (
                  <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>通过暂不可用：{approveAction.reason ?? approveAction.reasonCode ?? "not_available"}</span>
                  </p>
                )}
              </div>
            </details>
          </div>
        </div>
      </div>
    </section>
  );
}
