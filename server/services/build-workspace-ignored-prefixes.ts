import fs from "node:fs";
import path from "node:path";

function normalizeIgnoredPrefixPath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/\\/g, "/");
}

/**
 * The same trusted-artifact whitelist, for EVERY change that owns an artifact
 * directory in this repo -- not just the one being adopted.
 *
 * Adoption's dirty check refuses to absorb a patch while files outside it are
 * uncommitted. Scoped to one change, that made the SECOND change in a project
 * unadoptable forever: change A leaves `.ship/changes/A/**` uncommitted (the
 * pipeline never commits its own artifacts), and when change B reaches adopt,
 * A's files are "outside the patch" and unrecognised. The first change in a
 * project adopts fine, every later one is stuck -- which is why this survived
 * until a project had two changes.
 *
 * The two scopes are deliberately asymmetric:
 *
 *  - THE CURRENT change keeps the narrow per-file whitelist below. An
 *    unexpected file under its own directory is worth surfacing: this is the
 *    change being adopted, and something the model wrote outside the known
 *    artifact set is exactly the anomaly the dirty check exists to catch.
 *  - A SIBLING change gets its whole directory ignored. Nothing under another
 *    change's directory can belong to this change's patch (the patch only ever
 *    carries source files, and `evaluateBuildGate` hard-blocks `.ship` writes),
 *    so per-file precision there buys no safety and instead makes adoption
 *    depend on how far the sibling happened to get through the pipeline --
 *    which is what broke: the whitelist covers the artifacts that exist at
 *    adopt time, so a sibling that ran PAST Build (build/, approvals/,
 *    mirrors/, review-*, retro.md, ...) still read as dirty.
 */
export function allChangeArtifactIgnoredPrefixes(repoPath: string, currentChangeId: string): string[] {
  return [
    ...trustedPipelineArtifactIgnoredPrefixes(currentChangeId),
    ...siblingChangeDirectories(repoPath, currentChangeId),
  ];
}

export function trustedPipelineArtifactIgnoredPrefixes(changeId: string): string[] {
  const changeRoot = path.join(".ship", "changes", changeId);
  return [
    path.join(changeRoot, "api-spec-delta.md"),
    path.join(changeRoot, "api-spec-delta.json"),
    path.join(changeRoot, "blue-gap-reviews.json"),
    path.join(changeRoot, "briefing-questions.json"),
    path.join(changeRoot, "change-request.md"),
    path.join(changeRoot, "events.jsonl"),
    path.join(changeRoot, "human-decisions.json"),
    path.join(changeRoot, "plan-critique.json"),
    path.join(changeRoot, "plan.json"),
    path.join(changeRoot, "plan.md"),
    path.join(changeRoot, "prd-delta.md"),
    path.join(changeRoot, "prd-draft.md"),
    path.join(changeRoot, "prd-gate.json"),
    path.join(changeRoot, "prd-intent.md"),
    path.join(changeRoot, "red-fix-claims.json"),
    path.join(changeRoot, "reports"),
    path.join(changeRoot, "requirement-gaps.json"),
    path.join(changeRoot, "rounds"),
    path.join(changeRoot, "spec.md"),
    path.join(changeRoot, "tech-spec-delta.json"),
    path.join(changeRoot, "tech-spec-delta.md"),
    path.join(changeRoot, "test-plan-delta.json"),
    path.join(changeRoot, "test-plan-delta.md"),
    path.join(changeRoot, "runs"),
  ].map(normalizeIgnoredPrefixPath);
}

const PIPELINE_SYSTEM_METADATA_IGNORED_PREFIXES = [
  ".ship/architecture.md",
  ".ship/baseline",
  ".ship/coding-rules.md",
  ".ship/context-progress.json",
  ".ship/file-guide.md",
  ".ship/policy.json",
  ".ship/prd-sources.md",
  ".ship/prd.json",
  ".ship/prd.md",
  ".ship/prompts",
  // Rubric text files, same ownership story as .ship/prompts: maintained by
  // the pipeline (bootstrap + canonical rewrite at stage-resolve), hand-edited
  // by users between runs. Absent from this list, the very first bootstrap
  // write marks the repo dirty and every subsequent build absorb 409s.
  ".ship/rubrics",
  ".ship/tech-stack.md",
].map(normalizeIgnoredPrefixPath);

export function pipelineSystemMetadataIgnoredPrefixes(): string[] {
  return [...PIPELINE_SYSTEM_METADATA_IGNORED_PREFIXES];
}

export function changeArtifactIgnoredPrefixes(changeId: string): string[] {
  return [
    ...pipelineSystemMetadataIgnoredPrefixes(),
    normalizeIgnoredPrefixPath(path.join(".ship", "changes", changeId)),
  ];
}

/**
 * `changeArtifactIgnoredPrefixes` plus every SIBLING change's artifact
 * directory -- the recovery-path counterpart to
 * `allChangeArtifactIgnoredPrefixes`.
 *
 * The live adopt path was fixed first and that was only half the closure: the
 * already-adopted re-check (`assertAdoptedBuildRunMatchesWorkspace`) and the
 * fix-patch path still ignored only the CURRENT change, so a sibling's
 * uncommitted artifacts broke them exactly the same way. Two consequences were
 * reachable: Build absorb RECOVERY 409s outright, and
 * `recovery-business-evidence` swallows the reason in a bare catch and reports
 * `build_adopted_terminal` as missing evidence -- a silent false negative
 * caused by an unrelated change having uncommitted files.
 */
export function changeAndSiblingArtifactIgnoredPrefixes(
  repoPath: string,
  currentChangeId: string,
): string[] {
  return [
    ...changeArtifactIgnoredPrefixes(currentChangeId),
    ...siblingChangeDirectories(repoPath, currentChangeId),
  ];
}

function siblingChangeDirectories(repoPath: string, currentChangeId: string): string[] {
  const changesRoot = path.join(repoPath, ".ship", "changes");
  try {
    return fs.readdirSync(changesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== currentChangeId)
      .map((entry) => normalizeIgnoredPrefixPath(path.join(".ship", "changes", entry.name)));
  } catch {
    return [];
  }
}

export function patchAdoptionIgnoredPrefixes(): string[] {
  return [".ship"];
}
