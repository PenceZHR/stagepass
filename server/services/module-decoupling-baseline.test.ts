import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf-8");
}

function hasFacadeExport(source: string, name: string): boolean {
  if (new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(source)) {
    return true;
  }

  const reExportBlocks = source.matchAll(/export\s*\{([^}]*)\}\s*from\s*["'][^"']+["'];/g);
  for (const [, block] of reExportBlocks) {
    const exportedNames = block.split(",").map((specifier) => {
      const parts = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      return parts.at(-1)?.trim();
    });

    if (exportedNames.includes(name)) {
      return true;
    }
  }

  return false;
}

test("pipeline-service keeps legacy public facade exports during decoupling", () => {
  const source = read("server/services/pipeline-service.ts");
  const facadeExports = [
    "runIntake",
    "runSpec",
    "runTechSpec",
    "generatePlan",
    "approvePlan",
    "runTestPlan",
    "runPrdBriefingQuestions",
    "runPrdBriefingDraft",
    "runPrdBriefingFinalReview",
    "runImplement",
    "runImplementStreamed",
    "approveBuildAbsorb",
    "approveFixAbsorb",
    "runReview",
    "preflightReviewRun",
    "runCheck",
    "runFixStreamed",
    "recoverCurrentBuildRun",
    "rejectBuildRun",
    "runRelease",
    "runRetro",
  ];

  for (const name of facadeExports) {
    assert.ok(hasFacadeExport(source, name), `missing facade export: ${name}`);
  }
});

test("action-contract-service remains the action id registry facade", () => {
  const source = read("server/services/action-contract-service.ts");
  const registry = read("server/services/action-contract-registry-service.ts");

  assert.match(registry, /export const ACTION_DEFINITIONS: ActionDefinition\[\] = \[/);
  assert.match(source, /import \{ ACTION_DEFINITIONS \} from "\.\/action-contract-registry-service";/);
  assert.match(source, /\bACTION_DEFINITIONS\.map\(/);
  assert.match(source, /export function computeActions\(/);
  assert.match(source, /export function refreshActions\(changeId: string\): PipelineActionContract\[\]/);
  assert.match(source, /export const getActions = refreshActions/);
  assert.match(source, /export function persistActionContract\(/);
});

test("change detail page still consumes PipelineActionContract through helper seam", () => {
  const source = read("app/projects/[id]/changes/[changeId]/page.tsx");

  assert.match(source, /createPipelinePreflightPayload/);
  assert.match(source, /findPipelineAction/);
  assert.match(source, /pipelineActionDisabledReason/);
});

test("check route still depends on preflight and pipeline facades during phase one", () => {
  const source = read("app/api/projects/[id]/changes/[changeId]/check/route.ts");

  assert.match(
    source,
    /import \{ assertCanRunCheck \} from "@\/server\/services\/pipeline-service";/,
  );
  assert.match(source, /from "@\/server\/services\/preflight-service";/);
  assert.match(source, /\bassertActionAllowedAsync\b/);
});
