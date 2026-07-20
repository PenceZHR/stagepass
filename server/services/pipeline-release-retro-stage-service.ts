import { eq } from "drizzle-orm";
import { db } from "../db";
import { runLedgerRepository } from "../repositories/run-ledger-repository";
import { changes, projects } from "../db/schema";
import type { Change } from "../types";
import type { AiRunResult } from "./ai-engine-types";
import type { JobExecutionContext } from "./job-execution-context";
import type { Provider } from "./provider-selection-service";
import { updateChangelog } from "./baseline-service";
import {
  absorbBuildPatch,
  adoptFixPatch,
  buildRunId,
  readLatestApprovedBuildRun,
  readLatestBuildRun,
} from "./build-workspace-service";
import { runDocumentStage } from "./pipeline-document-stage-runner-service";
import { appendRetroDebtsToBacklog } from "./retro-service";
import { assertCanMerge } from "./merge-readiness-service";
import { resolveRetroActionAuthority } from "./provider-action-authority-service";

function getProject(projectId: string) {
  return db.select().from(projects).where(eq(projects.id, projectId)).get();
}

function getChange(changeId: string): Change | undefined {
  return db.select().from(changes).where(eq(changes.id, changeId)).get() as Change | undefined;
}

export async function runRelease(
  changeId: string,
  _context?: JobExecutionContext,
  provider?: Provider,
): Promise<void> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);
  if (change.status !== "MERGE_READY") {
    throw new Error(`Invalid status: ${change.status}. Expected: MERGE_READY`);
  }
  assertCanMerge({ changeId });

  // Resolve the newest *approved* BuildRun, not the newest run on disk. A failed
  // fix run leaves a higher-numbered build-N.json behind, and picking by number
  // would let it shadow the adopted build the merge gate cleared -- the gate reads
  // build_run_records filtered to approved/adopted, so it would promise a merge
  // this executor then refuses. Same resolution rule as QA.
  const approvedBuildRun = readLatestApprovedBuildRun(project.repoPath, changeId);
  if (!approvedBuildRun) throw new Error(`No approved BuildRun found for change: ${changeId}`);
  if (approvedBuildRun.status === "approved_for_absorb") {
    // absorbBuildPatch/adoptFixPatch re-resolve the workspace themselves through
    // the unfiltered newest-by-number reader. Deciding here on one run and letting
    // them act on another is the one outcome worse than refusing to merge, so
    // require both readers to name the same run before handing over the patch.
    const latestBuildRun = readLatestBuildRun(project.repoPath, changeId);
    if (!latestBuildRun || latestBuildRun.runNumber !== approvedBuildRun.runNumber) {
      throw new Error(
        `Cannot absorb ${buildRunId(approvedBuildRun)} during merge: `
        + `${latestBuildRun ? buildRunId(latestBuildRun) : "a newer run"} is the newest BuildRun on disk`
        + `${latestBuildRun ? ` (status ${latestBuildRun.status})` : ""}. `
        + `Adopt or discard the newer run, then retry the merge.`
      );
    }
    const commit = { enabled: Boolean(project.gitEnabled && change.gitBranch) };
    if (approvedBuildRun.purpose === "fix") {
      adoptFixPatch({ repoPath: project.repoPath, changeId, commit });
    } else {
      absorbBuildPatch({ repoPath: project.repoPath, changeId, commit });
    }
  } else if (approvedBuildRun.status !== "adopted") {
    // Unreachable while readLatestApprovedBuildRun only yields approved/adopted,
    // but merging on an unapproved workspace is not a failure mode worth leaving
    // to an invariant held in another module.
    throw new Error(`BuildRun must be approved before merge; current status is ${approvedBuildRun.status}`);
  }

  const result = await runDocumentStage(changeId, {
    phase: "release",
    promptPhase: "release",
    allowedStatuses: ["MERGE_READY"],
    runningStatus: "MERGING",
    successStatus: "RETRO_PENDING",
    failureStatus: "MERGE_READY",
    artifactType: "release_note",
    artifactFileName: "release-note.md",
    successSummary: "Release completed",
    provider,
    sessionKind: "general",
  });

  updateChangelog(project.repoPath, {
    changeId,
    summary: result.summary,
  });
}

export async function runRetro(
  changeId: string,
  _context?: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);
  if (!resolveRetroActionAuthority(db, changeId)) {
    throw new Error(`Retro release authority is unavailable or has drifted: ${changeId}`);
  }

  const result = await runDocumentStage(changeId, {
    phase: "retro",
    promptPhase: "retro",
    allowedStatuses: ["RETRO_PENDING"],
    runningStatus: "RETRO_PENDING",
    successStatus: "DONE",
    failureStatus: "RETRO_PENDING",
    artifactType: "retro",
    artifactFileName: "retro.md",
    successSummary: "Retro completed",
    provider,
    sessionKind: "general",
    resumeThread: false,
    afterSuccessfulResult: async ({ runId }) => {
      runLedgerRepository.patchChange(changeId, { retroDone: 1 }, { runId });
    },
  });

  appendRetroDebtsToBacklog(project.repoPath, changeId);

  return result;
}
