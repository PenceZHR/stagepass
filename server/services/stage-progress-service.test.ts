import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  emitStageProgress,
  stageProgressRawJson,
  type StageProgressEventWriter,
} from "./stage-progress-service.ts";

describe("stage progress service", () => {
  it("writes stage progress rawJson as { stageProgress }", () => {
    const rawJson = stageProgressRawJson({
      schemaVersion: "stage_progress/v1",
      phase: "prd_briefing_questions",
      runId: "RUN-1",
      stageRunId: "STAGE-1",
      attemptNo: 1,
      status: "ingesting",
      source: "provider_native",
      message: "Extracting provider output",
    });

    assert.deepEqual(JSON.parse(rawJson), {
      stageProgress: {
        schemaVersion: "stage_progress/v1",
        phase: "prd_briefing_questions",
        runId: "RUN-1",
        stageRunId: "STAGE-1",
        attemptNo: 1,
        status: "ingesting",
        source: "provider_native",
        message: "Extracting provider output",
      },
    });
  });

  it("emits stage_progress events through a single boundary", async () => {
    const writes: Parameters<StageProgressEventWriter>[0][] = [];
    const fakeWriter: StageProgressEventWriter = async (input) => {
      writes.push(input);
      return "EVT-999";
    };

    const eventId = await emitStageProgress({
      changeId: "CHG-1",
      repoPath: "/tmp/repo",
      writer: fakeWriter,
      payload: {
        schemaVersion: "stage_progress/v1",
        phase: "prd_briefing_questions",
        runId: "RUN-1",
        stageRunId: "STAGE-1",
        attemptNo: 1,
        status: "failed",
        source: "none",
      },
    });

    assert.equal(eventId, "EVT-999");
    assert.deepEqual(writes, [
      {
        changeId: "CHG-1",
        runId: "RUN-1",
        type: "stage_progress",
        message: "failed",
        rawJson: {
          stageProgress: {
            schemaVersion: "stage_progress/v1",
            phase: "prd_briefing_questions",
            runId: "RUN-1",
            stageRunId: "STAGE-1",
            attemptNo: 1,
            status: "failed",
            source: "none",
          },
        },
        repoPath: "/tmp/repo",
      },
    ]);
  });
});
