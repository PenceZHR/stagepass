import fs from "fs";
import path from "path";
import { createChildLogger } from "../logger";
import { isShipArtifact } from "./build-gate-service";
import { getWorkingTreeStatus, hasCommits, isGitRepo } from "./git-service";
import type { Finding } from "./local-check-service";
import { loadDbPlanScope, loadPolicy, matchesGlob } from "./stage-guard-service";

const log = createChildLogger("scope-check-service");

export interface ScopeCheckResult {
  success: boolean;
  blocked: boolean;
  changedFiles: string[];
  allowedFiles: string[];
  forbiddenFiles: string[];
  outOfScopeFiles: string[];
  blockedFiles: string[];
  findings: Finding[];
}

export function runScopeCheck(
  repoPath: string,
  changeId: string,
  outputDir?: string
): ScopeCheckResult {
  const changeDir = path.join(repoPath, ".ship", "changes", changeId);
  const reportDir = outputDir ?? changeDir;

  // DB is authoritative for plan scope (matches Build-time enforcement, which
  // already used loadDbPlanScope; scope-check was the one holdout still
  // reading plan.json directly. See docs/state-projection-audit-2026-07-14.md
  // §4, Site 7 -- a human editing plan.json via the phase-artifact UI could
  // otherwise change what QA-time scope enforcement allows.)
  const plan = loadDbPlanScope(changeId);

  const policy = loadPolicy(repoPath);

  // `git status --porcelain` (via getWorkingTreeStatus) rather than
  // `git diff --name-only`. The latter lists only unstaged edits to files git
  // already tracks: it shows neither newly created files nor staged ones. So an
  // agent that wrote a brand new file outside the approved scope -- the exact
  // violation this check exists to catch -- walked through it untouched, and
  // every test here happened to modify a tracked file, so nothing noticed.
  //
  // getWorkingTreeStatus owns the repo's one porcelain parse, rename entries
  // included. A second scanner here could disagree with the Git panel about
  // what counts as a changed file.
  let changedFiles: string[] = [];
  let statusUnavailable = false;
  try {
    // The reachability check has to be explicit. getWorkingTreeStatus answers
    // `{clean: true, staged: [], unstaged: []}` for a path that is not a git
    // repo or has no commits -- isGitRepo and hasCommits both swallow their
    // errors and return false. That is right for the Git panel on a fresh
    // checkout and wrong here: a scope check that could not reach the
    // repository has verified nothing, and an empty changeset passes.
    if (!isGitRepo(repoPath) || !hasCommits(repoPath)) {
      statusUnavailable = true;
      log.warn({ repoPath }, "Repository unreadable; scope cannot be verified");
    } else {
      // expandUntrackedDirectories: a new directory collapses to one porcelain
      // entry (`?? secrets/`), which matches neither `secrets/**` nor any other
      // plan glob -- the files inside would be judged by a path that is not
      // theirs. isShipArtifact drops stagepass's own bookkeeping, the same rule
      // the Build gate applies to the same question.
      const status = getWorkingTreeStatus(repoPath, { expandUntrackedDirectories: true });
      changedFiles = [...new Set([...status.staged, ...status.unstaged].map((entry) => entry.path))]
        .filter((filePath) => !isShipArtifact(filePath));
    }
  } catch (err) {
    statusUnavailable = true;
    log.warn({ err, repoPath }, "Failed to read git status; scope cannot be verified");
  }

  // expectedFiles is what loadDbPlanScope actually populates; allowedFiles is
  // a vestigial fallback (matches validateImplementScope's own precedence).
  const allowedFiles = plan.expectedFiles ?? plan.allowedFiles ?? [];
  const forbiddenFiles = plan.forbiddenFiles ?? [];
  const allBlockedPatterns = policy.blockedGlobs;

  const blockedFiles: string[] = [];
  const outOfScopeFiles: string[] = [];

  for (const file of changedFiles) {
    // Check forbidden files
    if (forbiddenFiles.some((f) => matchesGlob(file, f))) {
      blockedFiles.push(file);
      continue;
    }

    // Check always-blocked patterns
    if (allBlockedPatterns.some((p) => matchesGlob(file, p))) {
      blockedFiles.push(file);
      continue;
    }

    // Check if in allowed files
    if (allowedFiles.length > 0 && !allowedFiles.some((a) => matchesGlob(file, a))) {
      outOfScopeFiles.push(file);
    }
  }

  const blocked = blockedFiles.length > 0 || statusUnavailable;
  const success = !blocked && outOfScopeFiles.length === 0;

  const findings: Finding[] = [];
  if (statusUnavailable) {
    findings.push({
      source: "scope-check",
      severity: "BLOCKER",
      category: "scope",
      title: "Scope could not be checked",
      evidence: "the repository could not be read, so the set of written files is unknown",
      requiredFix: "Repair the repository state so git can report status, then re-run QA",
      status: "open",
    });
  }
  if (blockedFiles.length > 0) {
    findings.push({
      source: "scope-check",
      severity: "BLOCKER",
      category: "scope",
      title: "Blocked files modified",
      evidence: blockedFiles.join(", "),
      requiredFix: "Revert changes to blocked files",
      status: "open",
    });
  }
  if (outOfScopeFiles.length > 0) {
    findings.push({
      source: "scope-check",
      severity: "P1",
      category: "scope",
      title: "Out-of-scope files modified",
      evidence: outOfScopeFiles.join(", "),
      requiredFix: "Revert changes to out-of-scope files or update plan",
      status: "open",
    });
  }

  const result: ScopeCheckResult = {
    success,
    blocked,
    changedFiles,
    allowedFiles,
    forbiddenFiles,
    outOfScopeFiles,
    blockedFiles,
    findings,
  };

  fs.mkdirSync(reportDir, { recursive: true });
  const outputPath = path.join(reportDir, "scope-check.json");
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  log.info({ changeId, success, blocked }, "Scope check completed");
  return result;
}
