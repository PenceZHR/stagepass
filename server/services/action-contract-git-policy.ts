import type { ActionDecision } from "./action-contract-types";
import {
  changeArtifactIgnoredPrefixes,
  checkGitBaseCamp,
  readLatestBuildRun,
} from "./build-workspace-service";
import { getPorcelainStatus, hasCommits, isGitRepo } from "./git-service";

/**
 * The git side of the action contract.
 *
 * Until this module existed the pipeline could not see git at all: the registry
 * held zero git actions, so "this path is not a git repository" and "there is
 * uncommitted work" were facts only `run_build` ever consulted (through
 * buildBaseCampDecision), and only to refuse itself. A project whose repoPath
 * was never `git init`ed reported `build_base_camp_blocked` /
 * "Path is not a git repository." with no action anywhere in the contract that
 * could clear it -- the init and commit capabilities existed in git-service and
 * in POST /api/projects/[id]/git, but nothing in the pipeline pointed at them.
 *
 * Both decisions here are computed from the *same* probe buildBaseCampDecision
 * uses (checkGitBaseCamp with changeArtifactIgnoredPrefixes), so the Build gate
 * and the commit action can never disagree about whether the tree is dirty or
 * whether the path is a repository at all.
 *
 * Gate identity, and why it is deliberately NOT the stage gate's
 * ------------------------------------------------------------
 * Every other action stamps its contract with the phase gate's
 * (gateVersion, sourceDbHash). That is wrong for these two. A commit's
 * precondition is a property of the working tree, not of any stage gate row, and
 * borrowing the Build gate's version would drag them into a known defect:
 * GET /gate serves `computeActions` (no self-heal, no persist) while preflight
 * runs `getActions` (self-heals and bumps gate versions), so the first POST
 * after a page render can invalidate the very version that render handed out and
 * answer 409 gate_version_drift. Pinning gateVersion to a constant takes these
 * actions out of that race entirely -- the same escape reviewBuildAdoptionDecision
 * already takes when it stamps `gateVersion: "0"`.
 *
 * sourceDbHash tracks HEAD instead, which is the one piece of state that must
 * not move under a commit: if something else lands a commit between the render
 * and the click, HEAD moves, preflight answers source_db_hash_drift, and the
 * stale click is refused. Working-tree *content* is deliberately excluded from
 * the hash -- the pipeline rewrites files constantly during a Build, and hashing
 * them would turn every ordinary edit into a 409 that the client's drift retry
 * (gate_version_drift only) cannot absorb.
 */

/** Git actions are not gated by any stage gate, so their version never moves. */
export const GIT_ACTION_GATE_VERSION = "0";

/** Same wording checkGitBaseCamp uses, so both surfaces name the fault identically. */
export const GIT_REPO_MISSING_BLOCKER_TITLE = "Path is not a git repository.";

export interface GitWorkspaceFacts {
  /** repoPath resolves to a git work tree. */
  isRepo: boolean;
  /** HEAD resolves, i.e. the repo is not on an unborn branch. */
  hasCommits: boolean;
  headSha: string | null;
  /**
   * Something is committable that is not this change's own pipeline artifact
   * churn. The exclusion list is changeArtifactIgnoredPrefixes -- the same one
   * the Build base camp uses -- so a run that only rewrote `.ship/` metadata
   * does not light this up.
   */
  hasUncommittedWork: boolean;
  /** Porcelain detail for the reason string; null when there is nothing to report. */
  uncommittedDetail: string | null;
  /**
   * Set when git could not be probed at all. The whole action contract is built
   * in one pass, so a throwing probe would take every other action down with it
   * (and 500 GET /gate); this degrades to a disabled action with a reason.
   */
  probeError: string | null;
}

function noRepoFacts(probeError: string | null): GitWorkspaceFacts {
  return {
    isRepo: false,
    hasCommits: false,
    headSha: null,
    hasUncommittedWork: false,
    uncommittedDetail: null,
    probeError,
  };
}

export function readGitWorkspaceFacts(repoPath: string, changeId: string): GitWorkspaceFacts {
  try {
    if (!isGitRepo(repoPath)) return noRepoFacts(null);

    // An unborn branch has no HEAD for checkGitBaseCamp to read, and it is the
    // one state where every entry in the tree is committable, so the plain
    // porcelain listing is enough: any line at all means the initial commit has
    // something to record.
    if (!hasCommits(repoPath)) {
      const porcelain = getPorcelainStatus(repoPath);
      return {
        isRepo: true,
        hasCommits: false,
        headSha: null,
        hasUncommittedWork: porcelain.length > 0,
        uncommittedDetail: porcelain.length > 0 ? porcelain.join(", ") : null,
        probeError: null,
      };
    }

    const baseCamp = checkGitBaseCamp(repoPath, {
      ignoredPrefixes: changeArtifactIgnoredPrefixes(changeId),
    });
    return {
      isRepo: true,
      hasCommits: true,
      headSha: baseCamp.headSha,
      hasUncommittedWork: !baseCamp.clean,
      uncommittedDetail: baseCamp.warnings[0] ?? null,
      probeError: null,
    };
  } catch (error) {
    return noRepoFacts(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The identity a git action is issued against: HEAD, or the absence of a repo.
 * Anything that moves HEAD (including the commit this action performs) drifts
 * it, which is what stops a double submit from landing two commits.
 */
export function gitActionSourceDbHash(facts: GitWorkspaceFacts): string {
  if (!facts.isRepo) return "git:no_repo";
  return `git_head:${facts.headSha ?? "unborn"}`;
}

function stamped(facts: GitWorkspaceFacts, decision: Omit<ActionDecision, "gateVersion" | "sourceDbHash">): ActionDecision {
  return {
    ...decision,
    gateVersion: GIT_ACTION_GATE_VERSION,
    sourceDbHash: gitActionSourceDbHash(facts),
  };
}

function probeFailedDecision(facts: GitWorkspaceFacts): ActionDecision {
  return stamped(facts, {
    enabled: false,
    reasonCode: "git_probe_failed",
    reason: `Git working tree could not be inspected: ${facts.probeError}`,
    blockers: [{ id: "git_probe_failed", severity: "P1", title: "Git working tree could not be inspected." }],
  });
}

/**
 * `git init` on the project's repoPath. Enabled exactly when the path is not a
 * repository yet, which is also exactly when run_build refuses itself with
 * build_base_camp_blocked -- this is the action that clears that stall.
 */
export function initGitRepoDecision(repoPath: string, changeId: string): ActionDecision {
  const facts = readGitWorkspaceFacts(repoPath, changeId);
  if (facts.probeError) return probeFailedDecision(facts);
  if (facts.isRepo) {
    return stamped(facts, {
      enabled: false,
      reasonCode: "git_repo_already_initialized",
      reason: "Repository path is already a git repository",
      blockers: [],
    });
  }
  return stamped(facts, { enabled: true, reasonCode: null, reason: null, blockers: [] });
}

/**
 * Commit the work sitting in the project's working tree.
 *
 * Three states, and the middle one is the point of the whole module: a dirty
 * tree is now a fact the contract reports, instead of something only the Git
 * tool panel beside the pipeline could see.
 */
export function commitChangesDecision(repoPath: string, changeId: string): ActionDecision {
  const facts = readGitWorkspaceFacts(repoPath, changeId);
  if (facts.probeError) return probeFailedDecision(facts);

  if (!facts.isRepo) {
    return stamped(facts, {
      enabled: false,
      reasonCode: "git_repo_missing",
      reason: `Cannot commit: ${GIT_REPO_MISSING_BLOCKER_TITLE}`,
      blockers: [{ id: "git_repo_missing", severity: "P1", title: GIT_REPO_MISSING_BLOCKER_TITLE }],
    });
  }

  if (!facts.hasUncommittedWork) {
    // Not a blocker: nothing is wrong, there is simply nothing to commit. A
    // blocker here would render as a stage-level fault on every clean tree.
    return stamped(facts, {
      enabled: false,
      reasonCode: "git_worktree_clean",
      reason: "Working tree has no uncommitted changes",
      blockers: [],
    });
  }

  // Adopting a fix replays its patch onto the commit the fix was cut from, so
  // adoptFix refuses once HEAD no longer equals run.baseCommit -- permanently,
  // with git_head_drift. A commit here is exactly what moves HEAD. Offering it
  // while a fix waits to be absorbed hands the user a button that destroys the
  // absorb they are trying to reach, and the dirty tree that makes the button
  // look necessary is usually the fix's own output. Withhold it and say why.
  const pendingFix = readLatestBuildRunSafely(repoPath, changeId);
  if (
    pendingFix
    && pendingFix.purpose === "fix"
    && pendingFix.status === "approved_for_absorb"
    && pendingFix.baseCommit
    && facts.headSha
    && pendingFix.baseCommit === facts.headSha
  ) {
    return stamped(facts, {
      enabled: false,
      reasonCode: "git_commit_would_drift_fix_base",
      reason: "先收编这一轮 Fix，再提交：现在提交会让 HEAD 离开 Fix 的基准 commit，收编将无法完成",
      blockers: [],
    });
  }

  return stamped(facts, { enabled: true, reasonCode: null, reason: null, blockers: [] });
}

/**
 * The build run lives in a workspace file, so a half-written or missing one must
 * not take the whole action contract down with it. Any read failure just means
 * "no fix is waiting", which leaves commit_changes enabled -- the state it had
 * before this guard existed.
 */
function readLatestBuildRunSafely(repoPath: string, changeId: string) {
  try {
    return readLatestBuildRun(repoPath, changeId);
  } catch {
    return null;
  }
}
