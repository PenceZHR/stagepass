import { Button } from "@/components/ui/button";
import type { ChangeDetail } from "./change-detail-types";
import { summarizeFailedRunForBanner, type ReviewPhase } from "./change-phase-map";

export function FailedRunBanner({
  run,
  phase,
  explicitSelectedPhase,
  onSelectPhase,
}: {
  run: NonNullable<ChangeDetail["latestRun"]>;
  phase: ReviewPhase | null;
  explicitSelectedPhase: ReviewPhase | null;
  onSelectPhase: (phase: ReviewPhase) => void;
  changeId: string;
}) {
  return (
    <div className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">
            {phase ?? "当前阶段"} 执行失败
          </p>
          <p className="mt-1 break-words text-red-800 dark:text-red-200">
            {summarizeFailedRunForBanner(run)}
          </p>
        </div>
        {phase && explicitSelectedPhase !== phase && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSelectPhase(phase)}
          >
            查看失败阶段
          </Button>
        )}
      </div>
    </div>
  );
}
