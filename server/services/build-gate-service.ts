import path from "node:path";

import { matchesGlob, SHIP_EXEMPT_PATTERNS } from "./stage-guard-service";
import type { BuildDeviation, BuildGateInput, BuildGateResult } from "./build-types";

const HARD_BLOCK_PATTERNS = [".git/**", ".env*", "**/*.pem", "**/*.key", "secrets/**"];

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/\\/g, "/");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(filePath, pattern));
}

export function isShipArtifact(filePath: string): boolean {
  return matchesAnyPattern(filePath, SHIP_EXEMPT_PATTERNS);
}

function hasPathEscape(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return path.isAbsolute(filePath) || normalized.split("/").includes("..");
}

function deviationReason(filePath: string): BuildDeviation["reason"] {
  const normalized = normalizePath(filePath);
  const basename = path.posix.basename(normalized);

  if (basename === "package.json") return "dependency";
  if (
    basename.endsWith(".lock") ||
    basename.endsWith("-lock.json") ||
    basename.endsWith("-lock.yaml") ||
    basename.endsWith("-lock.yml")
  ) {
    return "lockfile";
  }
  if (normalized.includes("migration")) return "migration";
  if (normalized.includes("generated")) return "generated_file";
  return "outside_expected_files";
}

function severityHint(reason: BuildDeviation["reason"]): BuildDeviation["severityHint"] {
  return reason === "outside_expected_files" ? "P2" : "P1";
}

function uniqueDeviations(deviations: BuildDeviation[]): BuildDeviation[] {
  const byKey = new Map<string, BuildDeviation>();
  for (const deviation of deviations) {
    byKey.set(`${deviation.file}\0${deviation.reason}`, deviation);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const byFile = a.file.localeCompare(b.file);
    if (byFile !== 0) return byFile;
    return a.reason.localeCompare(b.reason);
  });
}

export function evaluateBuildGate(input: BuildGateInput): BuildGateResult {
  const expectedFiles = input.plan.expectedFiles ?? input.plan.allowedFiles ?? [];
  const forbiddenFiles = input.plan.forbiddenFiles ?? [];
  const hardBlockPatterns = [
    ...HARD_BLOCK_PATTERNS,
    ...forbiddenFiles,
    ...input.policy.blockedFiles,
    ...input.policy.blockedGlobs,
  ];

  const sourceMutations = input.mutations
    .map((mutation) => ({ ...mutation, path: normalizePath(mutation.path) }))
    .filter((mutation) => hasPathEscape(mutation.path) || !isShipArtifact(mutation.path));

  const blockingFiles = unique(
    sourceMutations
      .filter((mutation) => hasPathEscape(mutation.path) || matchesAnyPattern(mutation.path, hardBlockPatterns))
      .map((mutation) => mutation.path)
  ).sort();

  const deviations = uniqueDeviations(
    sourceMutations
      .filter((mutation) => !blockingFiles.includes(mutation.path))
      .filter((mutation) => !matchesAnyPattern(mutation.path, expectedFiles))
      .map((mutation) => {
        const reason = deviationReason(mutation.path);
        return {
          file: mutation.path,
          reason,
          severityHint: severityHint(reason),
        };
      })
  );

  return {
    blocked: blockingFiles.length > 0,
    blockingFiles,
    deviations,
  };
}
