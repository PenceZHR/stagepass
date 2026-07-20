import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isBuildOrFixAwaitingHuman } from "./projects/[id]/changes/[changeId]/change-phase-map";
import type { ChangeDetail } from "./projects/[id]/changes/[changeId]/change-detail-types";

const changeDir = resolve(process.cwd(), "app/projects/[id]/changes/[changeId]");
const pageSource = readFileSync(resolve(changeDir, "page.tsx"), "utf-8");

function changeWithLatestRun({
  status,
  phase,
  runStatus,
}: {
  status: string;
  phase: string;
  runStatus: string;
}): ChangeDetail {
  return {
    id: "CHG-1",
    projectId: "PRJ-1",
    title: "Task 5 fixture",
    status,
    codexThreadId: null,
    fixIterations: 0,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    latestRun: {
      id: "RUN-1",
      phase,
      status: runStatus,
    },
  };
}

describe("Task 5 BuildSandbox routing", () => {
  it("routes BuildSandbox from the selected Build/Fix pipeline stage", () => {
    assert.match(pageSource, /const selectedStage = uiPipelineState\?\.selectedStage \?\? null;/);
    assert.match(pageSource, /const activeSelectedPhase = selectedStage\?\.reviewPhase \?\? "Retro";/);
    assert.match(pageSource, /const showingBuildSandbox = activeSelectedPhase === "Build" \|\| activeSelectedPhase === "Fix";/);
    assert.doesNotMatch(pageSource, /const buildOrFixAwaitingHuman = isBuildOrFixAwaitingHuman\(change\);/);
  });

  const cases: Array<{
    name: string;
    status: string;
    phase: string;
    runStatus: string;
    expected: boolean;
  }> = [
    {
      name: "ordinary running build is not awaiting human",
      status: "IMPLEMENTING",
      phase: "implement",
      runStatus: "running",
      expected: false,
    },
    {
      name: "completed build is awaiting human",
      status: "IMPLEMENTING",
      phase: "implement",
      runStatus: "completed",
      expected: true,
    },
    {
      name: "completed fix findings is awaiting human",
      status: "IMPLEMENTING",
      phase: "fix_findings",
      runStatus: "completed",
      expected: true,
    },
    {
      name: "running fix findings is not awaiting human",
      status: "IMPLEMENTING",
      phase: "fix_findings",
      runStatus: "running",
      expected: false,
    },
    {
      name: "implemented change is not awaiting human",
      status: "IMPLEMENTED",
      phase: "implement",
      runStatus: "completed",
      expected: false,
    },
    {
      name: "failed build is not awaiting human",
      status: "IMPLEMENTING",
      phase: "implement",
      runStatus: "failed",
      expected: false,
    },
    {
      name: "adopted build is not awaiting human",
      status: "IMPLEMENTING",
      phase: "implement",
      runStatus: "adopted",
      expected: false,
    },
    {
      name: "rejected build is not awaiting human",
      status: "IMPLEMENTING",
      phase: "implement",
      runStatus: "rejected",
      expected: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      assert.equal(
        isBuildOrFixAwaitingHuman(changeWithLatestRun(testCase)),
        testCase.expected,
      );
    });
  }
});
