"use client";

import { Button } from "@/components/ui/button";
import type { BridgeHealthStatus } from "./emergency-interaction-panel";

export interface CodexControlProjection {
  bindingTitle: string | null;
  bindingStatus: string;
  threadId: string | null;
  lastTurnId: string | null;
  lastObservationCursor: number | null;
  lastSeenAt: string | null;
  lastErrorCode: string | null;
  currentInteractionId: string | null;
  codexDecisionEnabled: boolean;
  model: string | null;
  reasoningEffort: string | null;
}

export interface CodexHealthProjection {
  status: BridgeHealthStatus;
  desktopClientVersion?: string | null;
  mcpHostEvidence?: { status?: string } | null;
}

export function CodexTaskControl({
  control,
  health,
  busy = false,
  readOnly = false,
  startLabel,
  onOpen,
  onStart,
}: {
  control: CodexControlProjection;
  health: CodexHealthProjection | null;
  busy?: boolean;
  readOnly?: boolean;
  /**
   * What the start button will actually do, taken from the action contract.
   *
   * The label used to be hardcoded to "重新运行本阶段"/"开始本阶段" regardless of
   * which action the stage had selected. Once a Spec round settles, the action
   * behind this button becomes "another adversarial round" -- which supersedes
   * the finished round and spends a full red/blue cycle -- while the button
   * still read "重新运行本阶段". A control that misnames a destructive action is
   * worse than one that is missing.
   */
  startLabel?: string;
  onOpen: () => Promise<void>;
  onStart: () => Promise<void>;
}) {
  const hasBoundTask = Boolean(control.threadId);
  const healthReady = health?.status === "ready";
  const healthKnown = health !== null;
  const stageStatus = control.lastErrorCode
    ? "failed"
    : control.currentInteractionId
      ? "needs_input"
      : control.bindingStatus === "running"
        ? "running"
        : hasBoundTask
          ? "ready"
          : "not_started";
  const statusCopy = {
    failed: {
      label: "Codex 连接或执行失败",
      description: "请打开 Codex App 查看任务错误并继续处理。",
      dot: "bg-destructive",
    },
    needs_input: {
      label: "有问题等待你选择",
      description: "大模型已经给出选项，请到 Codex App 勾选一个。",
      dot: "bg-primary",
    },
    running: {
      label: "Codex 正在运行",
      description: "当前阶段正在原 Codex 会话中执行。",
      dot: "bg-primary",
    },
    ready: {
      label: "Codex 会话已就绪",
      description: "当前阶段会继续使用这个 Codex 会话。",
      dot: "bg-success",
    },
    not_started: {
      label: "当前阶段尚未开始",
      description: "开始后会在 Codex App 中创建或复用阶段会话。",
      dot: "bg-muted-foreground/60",
    },
  }[stageStatus];

  return (
    <section
      className="border-t border-white/10 pt-4"
      aria-labelledby="codex-task-control-title"
      data-codex-task-control
      data-codex-stage-status={stageStatus}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`mt-1.5 size-2 shrink-0 rounded-full ${statusCopy.dot}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="stagepass-kicker">Codex</p>
            <h2 id="codex-task-control-title" className="mt-1 text-base font-semibold">
              {statusCopy.label}
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {statusCopy.description}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${
              healthReady
                ? "bg-success"
                : healthKnown
                  ? "bg-destructive"
                  : "bg-muted-foreground/60"
            }`}
            aria-hidden="true"
          />
          <span>
            {healthReady
              ? "Codex App 已连接"
              : healthKnown
                ? "Codex App 未连接"
                : "Codex App 连接检测中"}
          </span>
        </div>
      </div>

      {control.lastErrorCode && (
        <p className="mt-3 border-l-2 border-destructive/70 pl-3 text-xs text-muted-foreground">
          错误代码：
          <span className="ml-1 font-mono text-foreground">{control.lastErrorCode}</span>
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {hasBoundTask ? (
          <Button type="button" size="sm" disabled={busy} onClick={onOpen}>
            {stageStatus === "needs_input"
              ? "去 Codex 选择"
              : stageStatus === "running"
                ? "查看 Codex 运行"
                : "打开 Codex"}
          </Button>
        ) : null}
        {!readOnly ? (
          <Button
            type="button"
            size="sm"
            variant={hasBoundTask ? "outline" : "default"}
            disabled={busy}
            onClick={onStart}
          >
            {startLabel ?? (hasBoundTask ? "重新运行本阶段" : "开始本阶段")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
