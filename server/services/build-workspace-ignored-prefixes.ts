import path from "node:path";

function normalizeIgnoredPrefixPath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/\\/g, "/");
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

export function patchAdoptionIgnoredPrefixes(): string[] {
  return [".ship"];
}
