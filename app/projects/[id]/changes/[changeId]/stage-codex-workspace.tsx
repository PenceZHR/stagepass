"use client";

import type { ReactNode } from "react";

import { resolveStageClarificationPolicy } from "@/lib/stage-clarification-policy";
import type { UiStageId } from "./pipeline-ui-model";

export function StageCodexWorkspace({
  stageId,
  isFuture,
  isWaitingForInput,
  children,
}: {
  stageId: UiStageId;
  isFuture: boolean;
  isWaitingForInput: boolean;
  children: ReactNode;
}) {
  const policy = resolveStageClarificationPolicy(stageId);
  const stateMessage = isFuture
    ? "当前尚未进入该阶段，因此这里只显示规则和只读记录。"
    : isWaitingForInput
      ? "Codex 正在等待你逐题选择；提交后会回到同一个任务继续检查。"
      : "开始后，问题、选择、执行和修订都会留在同一个 Codex 任务中。";

  return (
    <section
      className="border-y border-white/10 py-5"
      aria-labelledby={`stage-codex-workspace-${stageId}`}
      data-stage-codex-workspace
      data-stage-policy={policy.id}
    >
      <p className="stagepass-kicker">Codex 工作区</p>
      <h3
        id={`stage-codex-workspace-${stageId}`}
        className="stagepass-serif mt-1 text-lg font-normal"
      >
        {policy.label} 在 Codex App 中完成
      </h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        {policy.webSummary}
      </p>
      <div className="mt-4 border-l-2 border-primary/60 pl-3">
        <p className="text-sm font-medium text-foreground">
          每批最多 10 个具体问题，逐题选择
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          本批答案提交后，Codex 会先整理决定；仍有问题就继续下一批，直到没有阻塞项才产出正式阶段结果。
        </p>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        {stateMessage}
      </p>
      <div className="mt-4">{children}</div>
    </section>
  );
}
