"use client";

import { Check, Circle, CircleDot } from "lucide-react";
import type { CSSProperties } from "react";

import { StageStatusBadge } from "./stage-status-badge";
import {
  UI_STAGE_ORDER,
  type UiStage,
  type UiStageId,
} from "./pipeline-ui-model";

const ORBIT_STAGE_IDS = UI_STAGE_ORDER.filter(
  (stageId): stageId is Exclude<UiStageId, "done"> => stageId !== "done",
);

type StagePosition = "complete" | "active" | "future";

export function StageOrbit({
  stages,
  activeStage,
  selectedStage,
  changeTitle,
  changeStatus,
  riskCount,
  transitioning,
  transitionTargetId,
  onSelectStage,
}: {
  stages: UiStage[];
  activeStage: UiStage;
  selectedStage: UiStage;
  changeTitle: string;
  changeStatus: string;
  riskCount: number;
  transitioning: boolean;
  transitionTargetId: UiStageId | null;
  onSelectStage: (stage: UiStage) => void;
}) {
  const orbitStages = ORBIT_STAGE_IDS
    .map((stageId) => stages.find((stage) => stage.id === stageId))
    .filter((stage): stage is UiStage => Boolean(stage));
  const activeIndex = activeStage.id === "done"
    ? orbitStages.length
    : orbitStages.findIndex((stage) => stage.id === activeStage.id);

  return (
    <section
      className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-6 overflow-hidden px-3 py-8 sm:px-8"
      aria-labelledby="stage-orbit-title"
      data-stage-orbit-home
    >
      <div className="max-w-2xl text-center">
        <p className="stagepass-kicker">Change gate orbit</p>
        <h1
          id="stage-orbit-title"
          className="stagepass-serif mt-3 text-balance text-2xl leading-tight text-foreground sm:text-4xl"
        >
          {changeTitle}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          选择任一阶段查看门禁摘要。未来阶段始终为只读预览，点击不会改变流程状态。
        </p>
      </div>

      <div
        className="stage-orbit"
        data-transitioning={transitioning ? "true" : "false"}
        aria-label="Stagepass 圆形阶段轨道"
      >
        {orbitStages.map((stage, index) => {
          const angle = (360 / orbitStages.length) * index;
          const position = stagePosition(index, activeIndex);
          const selected = stage.id === selectedStage.id
            || stage.id === transitionTargetId;
          const style = {
            "--stage-angle": `${angle}deg`,
            "--stage-angle-inverse": `${angle * -1}deg`,
          } as CSSProperties;

          return (
            <div
              key={stage.id}
              className="stage-orbit-node"
              style={style}
            >
              <button
                type="button"
                data-stage-position={position}
                data-selected={selected ? "true" : "false"}
                aria-label={`${stage.label}，${stagePositionLabel(position, stage.state)}`}
                aria-current={position === "active" ? "step" : undefined}
                disabled={transitioning}
                onClick={() => onSelectStage(stage)}
              >
                <span aria-hidden="true">
                  <StageNodeIcon position={position} />
                </span>
                <span className="stage-orbit-tooltip">
                  {stagePositionLabel(position, stage.state)}
                  <br />
                  {position === "future" ? "只读预览" : stage.description}
                </span>
                <span className="stage-orbit-label">{stage.label}</span>
              </button>
            </div>
          );
        })}

        <div className="stage-orbit-center" aria-live="polite">
          <p className="stagepass-kicker">
            {activeStage.id === "done" ? "Delivery complete" : "Current gate"}
          </p>
          <h2 className="stagepass-serif mt-2 text-2xl text-foreground sm:text-4xl">
            {activeStage.id === "done" ? "Delivered" : activeStage.label}
          </h2>
          <StageStatusBadge state={activeStage.state} className="mt-3" />
          <p className="mt-4 max-w-56 text-xs leading-5 text-muted-foreground sm:text-sm">
            {gateConclusion(activeStage)}
          </p>
          <div className="mt-4 flex items-end gap-2" aria-label={`${riskCount} 个关键风险`}>
            <strong className="stagepass-serif text-3xl font-normal text-primary">
              {riskCount}
            </strong>
            <span className="pb-1 text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">
              blocking risks
            </span>
          </div>
          <p className="mt-2 max-w-48 truncate font-mono text-[0.62rem] text-muted-foreground/70">
            {changeStatus}
          </p>
        </div>
      </div>
    </section>
  );
}

function StageNodeIcon({ position }: { position: StagePosition }) {
  if (position === "complete") return <Check className="size-4" strokeWidth={2} />;
  if (position === "active") return <CircleDot className="size-5" strokeWidth={1.8} />;
  return <Circle className="size-3.5" strokeWidth={1.4} />;
}

function stagePosition(index: number, activeIndex: number): StagePosition {
  if (index < activeIndex) return "complete";
  if (index === activeIndex) return "active";
  return "future";
}

function stagePositionLabel(position: StagePosition, state: UiStage["state"]): string {
  if (position === "complete") return "已完成";
  if (position === "future") return "未开始";
  if (state === "needs_review") return "等待人工决定";
  if (state === "blocked" || state === "failed") return "当前门禁已阻断";
  if (state === "running") return "Codex 正在运行";
  return "当前阶段";
}

function gateConclusion(stage: UiStage): string {
  if (stage.state === "needs_review") return "证据已到齐，当前门禁正在等待你的明确决定。";
  if (stage.state === "blocked" || stage.state === "failed") {
    return "关键风险阻断了流程，需要先查看异议与证据。";
  }
  if (stage.state === "running") return "Codex 正在生成本阶段证据，Stagepass 会保持同步。";
  if (stage.state === "complete") return "全部门禁已完成，交付事实已经归档。";
  if (stage.state === "stale") return "门禁证据已过期，需要重新生成后再做决定。";
  return "当前阶段已就位，选择节点查看必要摘要与可用动作。";
}
