import type { MergeChecks } from "./gate-types";

export function OperationalPhasePanel({
  phase,
  actionCount,
  mergeChecks,
}: {
  phase: "Check" | "Merge";
  actionCount: number;
  mergeChecks?: MergeChecks;
}) {
  const readinessFacts = phase === "Merge" && mergeChecks
    ? buildMergeReadinessFacts(mergeChecks)
    : [];

  return (
    <div className="space-y-4" data-operational-workspace>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {phase === "Check" ? "QA 工作区" : "Merge 工作区"}
        </p>
        <h3 className="mt-1 text-base font-semibold tracking-normal">
          {phase === "Check" ? "验证当前变更" : "准备合并"}
        </h3>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {phase === "Check"
            ? "这里只展示质量验证工作区说明，主状态、可执行动作和阻断原因由阶段顶部统一呈现，原始运行记录在下方折叠区。"
            : "合并前只展示审批后的动作契约和阻断原因，主状态与操作入口由阶段顶部统一呈现，避免首屏暴露底层路径或日志。"}
        </p>
      </div>
      <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        {actionCount > 0
          ? `当前阶段有 ${actionCount} 个动作契约，执行入口和不可用原因已收拢到阶段顶部。`
          : "当前没有可展示的动作契约。"}
      </div>
      {readinessFacts.length > 0 && (
        <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm" aria-label="Merge readiness facts">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Merge readiness
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {readinessFacts.map((fact) => (
              <span
                key={fact.id}
                className={fact.ok ? "text-emerald-700" : "text-amber-700"}
              >
                {fact.label}
              </span>
            ))}
          </div>
          {mergeChecks?.missing.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Missing: {mergeChecks.missing.join(", ")}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function buildMergeReadinessFacts(mergeChecks: MergeChecks) {
  const requirementBlockers = mergeChecks.mergeBlockingRequirementGaps ?? 0;
  const requirementsOk = mergeChecks.requirementGapsPassed !== false && requirementBlockers === 0;

  return [
    {
      id: "qa",
      label: mergeChecks.qaPassed ? "QA passed" : "QA pending",
      ok: mergeChecks.qaPassed,
    },
    {
      id: "review",
      label: mergeChecks.reviewPassed ? "Review passed" : "Review pending",
      ok: mergeChecks.reviewPassed,
    },
    {
      id: "docs",
      label: mergeChecks.docsComplete ? "Docs complete" : "Docs missing",
      ok: mergeChecks.docsComplete,
    },
    {
      id: "requirements",
      label: `Requirements ${requirementBlockers} blocking`,
      ok: requirementsOk,
    },
  ];
}
