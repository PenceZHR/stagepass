"use client";

import { GitWorkspacePanel } from "../../git-workspace-panel";
import type { ReviewPhase } from "./change-phase-map";
import type { PipelineActionContract } from "./pipeline-action-contract";

/**
 * The panel used to be project-scoped only: it knew which repository it was
 * looking at but not which change the work in that repository belonged to, so a
 * commit made from a change's Fix stage was indistinguishable from one made from
 * the project page. Handing it the changeId (and the change's commit_changes
 * contract) lets the commit go through the change-scoped, preflight-checked
 * route and lets the AI message suggestion see what the change is about.
 */
export function StageGitPanel({
  projectId,
  changeId,
  selectedPhase,
  commitAction,
  initAction,
}: {
  projectId: string;
  changeId: string;
  selectedPhase: ReviewPhase;
  commitAction?: PipelineActionContract | null;
  initAction?: PipelineActionContract | null;
}) {
  return (
    <section className="mt-4" aria-label={`${selectedPhase} Git tools`} data-stage-git-panel>
      <GitWorkspacePanel
        projectId={projectId}
        changeId={changeId}
        commitAction={commitAction}
        initAction={initAction}
      />
    </section>
  );
}
