"use client";

import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Flag,
  FlaskConical,
  ListChecks,
  Route,
  ShieldAlert,
  Swords,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  findPipelineAction,
  pipelineActionDisabledReason,
  type PipelineActionContract,
} from "./pipeline-action-contract";
import type { PlanRisk, PlanSandboxState } from "./plan-sandbox-types";
import { ProducedFile } from "./produced-file";

interface PlanSandboxProps {
  projectId: string;
  changeId: string;
  state: PlanSandboxState | null;
  actions?: PipelineActionContract[];
  busy: boolean;
  loading: boolean;
  onWaiveRisk: (riskId: string) => void;
}

const MISSING_FIELD_LABELS: Record<string, string> = {
  "plan.json": "缺少结构化计划",
  "plan.md": "缺少计划说明",
  planName: "缺少计划名称",
  allowedFiles: "缺少允许改动范围",
  validationCommands: "缺少验证命令",
  implementationSteps: "缺少实施步骤",
  step_sequence: "步骤编号不连续",
  forbiddenFiles: "允许/禁止范围冲突",
  unsafePath: "包含不安全路径",
  invalid_plan_json: "计划 JSON 无效",
  invalid_plan_critique: "反方审查 JSON 无效",
};

function severityTone(risk: PlanRisk): string {
  if (risk.status === "resolved") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (risk.status === "waived") return "border-slate-200 bg-slate-50 text-slate-800";
  if (risk.severity === "P0") return "border-red-200 bg-red-50 text-red-900";
  if (risk.severity === "P1") return "border-orange-200 bg-orange-50 text-orange-900";
  return "border-yellow-200 bg-yellow-50 text-yellow-900";
}

function displayFile(file: string | undefined): string {
  return file?.trim() || "未绑定文件";
}

function missingCopy(field: string): string {
  return MISSING_FIELD_LABELS[field] ?? field;
}

function activeRisk(risk: PlanRisk): boolean {
  return risk.status === "open";
}

function canWaiveRisk(risk: PlanRisk): boolean {
  return risk.severity === "P1" && risk.status === "open";
}

function taskStatusCopy(status: "pending" | "blocked" | "done" | undefined) {
  if (status === "blocked") {
    return {
      label: "blocked",
      tone: "border-orange-200 bg-orange-50 text-orange-900",
    };
  }
  if (status === "done") {
    return {
      label: "done",
      tone: "border-emerald-200 bg-emerald-50 text-emerald-900",
    };
  }
  return {
    label: "pending",
    tone: "border-slate-200 bg-slate-50 text-slate-800",
  };
}

export function PlanSandbox({
  projectId,
  changeId,
  state,
  actions,
  busy,
  loading,
  onWaiveRisk,
}: PlanSandboxProps) {
  const disabled = busy || loading;
  const plan = state?.plan ?? null;
  const planName = plan?.planName?.trim() || "未命名计划";
  const steps = plan?.implementationSteps ?? [];
  const allowedFiles = plan?.allowedFiles ?? [];
  const validationCommands = plan?.validationCommands ?? [];
  const testPlan = plan?.testPlan ?? [];
  // Model-authored risk notes. Distinct from `state.risks` (structured 反方 risks
  // with a severity that gates approval) -- these carry no severity and never block.
  const modelRisks = plan?.risks ?? [];
  const risks = state?.risks ?? [];
  const openRisks = risks.filter(activeRisk);
  const waivePlanP1Action = findPipelineAction(actions, "waive_plan_p1");
  const waiveDisabledReason = pipelineActionDisabledReason(waivePlanP1Action);
  const waiveDisabled = disabled || waivePlanP1Action?.enabled !== true;

  return (
    <div className="space-y-4" data-plan-workspace>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="min-w-0 rounded-md border px-3 py-2">
          <p className="font-medium">当前 Change</p>
          <p className="mt-1 break-all font-mono text-foreground">
            {state?.changeId ?? "未加载"}
          </p>
        </div>
        <div className="min-w-0 rounded-md border px-3 py-2">
          <p className="font-medium">计划名称</p>
          <p className="mt-1 break-words text-foreground">{planName}</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-2">
          <section className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              {state?.gate.canApprove ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              ) : (
                <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              )}
              <h4 className="text-sm font-semibold">执行许可</h4>
            </div>

            <div className="space-y-3">
              {state?.gate.missingFields.length ? (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-900">
                  <div className="mb-2 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    <p className="text-sm font-semibold">门禁缺口</p>
                  </div>
                  <div className="space-y-1">
                    {state.gate.missingFields.map((field) => (
                      <p key={field} className="text-xs">{missingCopy(field)}</p>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
                  <div className="flex items-center gap-2">
                    <Flag className="h-4 w-4" aria-hidden="true" />
                    <p className="text-sm font-semibold">计划结构完整</p>
                  </div>
                  <p className="mt-1 text-xs">剩余判断来自反方风险和结果新鲜度。</p>
                </div>
              )}

              {state && !state.reportFresh && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                  当前 Plan 结果不是最新结算。计划或反方审查变化后，需要重新计算再审批。
                </p>
              )}

              {openRisks.length > 0 && (
                <p className="rounded-md border px-3 py-2 text-xs leading-5 text-muted-foreground">
                  仍有 {openRisks.length} 个反方风险。P0 必须修计划；P1 可以继续修，也可以写明理由接受风险。
                </p>
              )}
            </div>
          </section>

          <section className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <Swords className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <h4 className="text-sm font-semibold">反方拦截</h4>
            </div>

            {risks.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                暂无反方风险。重新计算后会更新计划门禁。
              </div>
            ) : (
              <div className="grid gap-3 xl:grid-cols-2">
                {risks.map((risk) => (
                  <div key={risk.id} className={`rounded-md border p-3 ${severityTone(risk)}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-background/80 px-2 py-0.5 font-mono text-[11px] font-semibold">
                          {risk.severity}
                        </span>
                        <span className="rounded bg-background/80 px-2 py-0.5 text-[11px]">
                          {risk.status === "waived" ? "已接受" : risk.status === "resolved" ? "已解决" : "阻断中"}
                        </span>
                      </div>
                      {canWaiveRisk(risk) && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={waiveDisabled}
                          onClick={() => onWaiveRisk(risk.id)}
                          title={waiveDisabledReason ?? undefined}
                        >
                          接受 P1
                        </Button>
                      )}
                    </div>
                    <p className="mt-2 text-sm font-semibold">{risk.title}</p>
                    {risk.evidence && <p className="mt-1 text-xs leading-5 opacity-80">{risk.evidence}</p>}
                    {risk.requiredPlanChange && (
                      <p className="mt-2 rounded bg-background/80 px-2 py-1 text-xs leading-5">
                        需要改计划：{risk.requiredPlanChange}
                      </p>
                    )}
                    {risk.waiverReason && (
                      <p className="mt-2 rounded bg-background/80 px-2 py-1 text-xs leading-5">
                        接受理由：{risk.waiverReason}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="min-w-0">
          <div className="mb-3 flex items-center gap-2">
            <Route className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h4 className="text-sm font-semibold">任务地图</h4>
          </div>

          {steps.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              尚未生成实施步骤。先让 AI 生成一份可执行计划。
            </div>
          ) : (
            <div className="space-y-3">
              {steps.map((step) => {
                const taskStatus = taskStatusCopy(step.status);
                return (
                  <div key={step.step} className="rounded-md border p-3">
                    <div className="flex items-start gap-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-900 font-mono text-xs font-semibold text-white">
                        {step.step}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                          <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${taskStatus.tone}`}>
                            {taskStatus.label}
                          </span>
                          <p className="min-w-0 break-words text-sm font-medium leading-5">{step.description}</p>
                        </div>
                        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                          {step.file ? (
                            <ProducedFile
                              projectId={projectId}
                              changeId={changeId}
                              path={step.file}
                              label={displayFile(step.file)}
                            />
                          ) : (
                            displayFile(step.file)
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <p className="text-xs font-medium text-muted-foreground">允许改动</p>
              </div>
              {allowedFiles.length === 0 ? (
                <p className="text-sm text-muted-foreground">未声明</p>
              ) : (
                <div className="space-y-1">
                  {allowedFiles.map((file) => (
                    <p key={file} className="break-all font-mono text-[11px]">
                      <ProducedFile projectId={projectId} changeId={changeId} path={file} label={file} />
                    </p>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center gap-2">
                <ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <p className="text-xs font-medium text-muted-foreground">验证命令</p>
              </div>
              {validationCommands.length === 0 ? (
                <p className="text-sm text-muted-foreground">未声明</p>
              ) : (
                <div className="space-y-1">
                  {validationCommands.map((command) => (
                    <p key={command} className="break-all font-mono text-[11px]">{command}</p>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-md border p-3" data-plan-test-plan>
              <div className="mb-2 flex items-center gap-2">
                <FlaskConical className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <p className="text-xs font-medium text-muted-foreground">测试计划</p>
              </div>
              {testPlan.length === 0 ? (
                <p className="text-sm text-muted-foreground">未声明</p>
              ) : (
                <ul className="space-y-1">
                  {testPlan.map((item) => (
                    <li key={item} className="break-words text-xs leading-5">
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-md border p-3" data-plan-model-risks>
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <p className="text-xs font-medium text-muted-foreground">计划自述风险</p>
              </div>
              {modelRisks.length === 0 ? (
                <p className="text-sm text-muted-foreground">未声明</p>
              ) : (
                <>
                  <ul className="space-y-1">
                    {modelRisks.map((item) => (
                      <li key={item} className="break-words text-xs leading-5">
                        {item}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                    这些是计划自己写下的风险提示，不带等级、不参与门禁。拦截以左侧反方风险为准。
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
