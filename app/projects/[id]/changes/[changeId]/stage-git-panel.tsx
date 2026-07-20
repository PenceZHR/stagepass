"use client";

import { GitWorkspacePanel } from "../../git-workspace-panel";
import type { ReviewPhase } from "./change-phase-map";

export function StageGitPanel({
  projectId,
  selectedPhase,
}: {
  projectId: string;
  selectedPhase: ReviewPhase;
}) {
  return (
    <section className="mt-4" aria-label={`${selectedPhase} Git tools`} data-stage-git-panel>
      <GitWorkspacePanel projectId={projectId} />
    </section>
  );
}
