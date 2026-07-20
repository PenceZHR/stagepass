import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createChildLogger } from "../logger";
import type { Finding } from "./local-check-service";
import { loadDbPlanScope, loadPolicy, matchesGlob } from "./stage-guard-service";

const log = createChildLogger("scope-check-service");
const GIT_COMMAND_TIMEOUT_MS = 30_000;

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

  // Get changed files from git
  let changedFiles: string[] = [];
  try {
    const output = execSync("git diff --name-only", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
    changedFiles = output.trim().split("\n").filter(Boolean);
  } catch {
    log.warn("Failed to get git diff, using empty changeset");
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

  const blocked = blockedFiles.length > 0;
  const success = !blocked && outOfScopeFiles.length === 0;

  const findings: Finding[] = [];
  if (blocked) {
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
