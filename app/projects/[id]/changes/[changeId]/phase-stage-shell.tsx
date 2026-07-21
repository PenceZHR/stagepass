"use client";

import type { ReactNode } from "react";
import { reviewPhaseToRubricPhase, type ReviewPhase } from "./change-phase-map";
import type { UiStageState } from "./pipeline-ui-model";
import { RubricPanel } from "./rubric-panel";
import { StageFrame, type StageBlockerView } from "./stage-frame";
import type { StageActionView } from "./stage-action-bar";
import type { AiProvider } from "./pipeline-action-contract";

const PHASE_STAGE_COPY: Record<ReviewPhase, { label: string; title: string; description: string }> = {
  Refine: {
    label: "Refine",
    title: "需求澄清",
    description: "把原始想法整理成可以进入 PRD 的输入。",
  },
  Intake: {
    label: "PRD",
    title: "PRD Briefing",
    description: "收集意图、补齐关键问题，并锁定本次 Change 的需求基线。",
  },
  Spec: {
    label: "Spec",
    title: "Spec 对抗",
    description: "我方补需求细节，反方审查边界漏洞，直到可以进入技术设计。",
  },
  TechSpec: {
    label: "Tech Spec",
    title: "技术方案",
    description: "把需求转成可执行的技术边界、接口和实现约束。",
  },
  Plan: {
    label: "Plan",
    title: "实施计划",
    description: "整理改动范围、步骤和验证命令，并通过计划门禁。",
  },
  TestPlan: {
    label: "Test Plan",
    title: "测试计划",
    description: "确认验证路径，确保 Build 前有明确的质量检查方式。",
  },
  Build: {
    label: "Build",
    title: "隔离施工",
    description: "在隔离工作区完成改动、审计差异，并决定是否收编。",
  },
  Implement: {
    label: "Build",
    title: "隔离施工",
    description: "在隔离工作区完成改动、审计差异，并决定是否收编。",
  },
  Review: {
    label: "Review",
    title: "反方 Review",
    description: "用结构化 findings 复核 Build 结果，处理阻断项后进入 QA。",
  },
  Check: {
    label: "QA",
    title: "质量验证",
    description: "运行最终验证动作，并沉淀可追溯的通过或阻断结论。",
  },
  Fix: {
    label: "Fix",
    title: "阻断修复",
    description: "针对 Review 或 QA 阻断项推进修复，并回到对应门禁复核。",
  },
  Merge: {
    label: "Merge",
    title: "合并审批",
    description: "检查所有阶段事实和交付状态，确认是否允许合并。",
  },
  Retro: {
    label: "Retro",
    title: "收尾复盘",
    description: "整理交付结果和经验记录，完成 Change 生命周期。",
  },
  Done: {
    label: "Done",
    title: "交付",
    description: "产出交付单：怎么跑起来、这次改了什么、文件地图、还有哪些没做。",
  },
};

export function phaseDisplayName(phase: ReviewPhase): string {
  return PHASE_STAGE_COPY[phase]?.label ?? phase;
}

export function phaseRecordsLabel(phase: ReviewPhase): string {
  return `${phaseDisplayName(phase)} 原始记录`;
}

/**
 * `projectId` and `changeId` are REQUIRED, and only the rubric drawer needs
 * them.
 *
 * That is the point. Every phase panel in this route goes through this shell,
 * so rendering the drawer here rather than at each call site makes "§7.1: every
 * phase panel has an entry point" a property of the shell instead of a promise
 * ten branches have to keep. Making the two ids required turns forgetting one
 * into a compile error rather than a phase that silently has no rubric UI —
 * which is the failure mode this project has already hit twice, where the
 * backend could do something and the interface never offered it.
 */
export function PhaseStageShell({
  projectId,
  changeId,
  phase,
  statusLabel,
  latestRunStatus,
  children,
  records,
  recordsLabel,
  state = "waiting",
  actions,
  actionError,
  provider,
  onProviderChange,
  providerDisabled,
  providerSelectable,
  error,
  blockers,
}: {
  projectId: string;
  changeId: string;
  phase: ReviewPhase;
  statusLabel: string;
  latestRunStatus?: string | null;
  children: ReactNode;
  records?: ReactNode;
  recordsLabel?: string;
  state?: UiStageState;
  actions?: StageActionView[];
  actionError?: ReactNode;
  provider?: AiProvider;
  onProviderChange?: (provider: AiProvider) => void;
  providerDisabled?: boolean;
  providerSelectable?: boolean;
  error?: ReactNode;
  blockers?: StageBlockerView[];
}) {
  const copy = PHASE_STAGE_COPY[phase] ?? {
    label: phase,
    title: `${phase} 阶段`,
    description: "查看当前阶段的主要状态、动作和审计记录。",
  };
  const resolvedRecordsLabel = recordsLabel ?? phaseRecordsLabel(phase);
  // Null only where the UI phase maps to no rubric phase at all (see
  // reviewPhaseToRubricPhase); every real pipeline stage maps to one.
  const rubricPhase = reviewPhaseToRubricPhase(phase);
  const evidence = records ? (
    <details className="rounded-lg border bg-background p-4">
      <summary className="cursor-pointer text-sm font-medium">{resolvedRecordsLabel}</summary>
      <div className="mt-4 border-t pt-4">{records}</div>
    </details>
  ) : null;

  return (
    <div data-phase-stage={phase}>
      <StageFrame
        title={copy.title}
        label={copy.label}
        state={state}
        description={copy.description}
        eyebrow="Pipeline Stage"
        meta={[
          { id: "status", label: "Status:", value: statusLabel },
          { id: "latest-run", label: "Latest Run:", value: latestRunStatus ?? "none" },
        ]}
        actions={actions}
        actionError={actionError}
        provider={provider}
        onProviderChange={onProviderChange}
        providerDisabled={providerDisabled}
        providerSelectable={providerSelectable}
        error={error}
        blockers={blockers}
        rubric={
          rubricPhase ? (
            <RubricPanel projectId={projectId} changeId={changeId} phase={rubricPhase} />
          ) : null
        }
        evidence={evidence}
        evidenceLabel={resolvedRecordsLabel}
      >
        {children}
      </StageFrame>
    </div>
  );
}
