import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  prdJobBaseline,
  progressForThisJob,
  runFailed,
  runForThisJob,
  stageProgressNotice,
  statusText,
} from "./prd-briefing-room";
import type { PrdBriefingState } from "./prd-briefing-types";

/**
 * The PRD briefing panel read two change-scoped facts as if they described the
 * job the user had just started:
 *
 *   activeRun     = the newest intake run for this change
 *   stageProgress = the last stage_progress event ever recorded for it
 *
 * Neither is scoped to a job, and neither expires. That produced two separate
 * user-visible defects, both pinned below.
 */

function state(overrides: Partial<PrdBriefingState> = {}): PrdBriefingState {
  return {
    briefing: {
      id: "PBR-1",
      changeId: "CHG-003",
      status: "draft_ready",
      intentText: "做一个战前会议室。",
      finalReviewJson: null,
      sourceHashesJson: "{}",
      lockedAt: null,
      createdAt: "2026-07-22T18:00:00.000Z",
      updatedAt: "2026-07-22T18:00:00.000Z",
    },
    questions: [],
    latestDraft: null,
    finalReview: null,
    gate: {} as PrdBriefingState["gate"],
    activeRun: null,
    stageProgress: null,
    ...overrides,
  } as PrdBriefingState;
}

function run(id: string, status: string): PrdBriefingState["activeRun"] {
  return {
    id,
    changeId: "CHG-003",
    phase: "intake",
    status,
    startedAt: "2026-07-22T18:00:00.000Z",
    endedAt: null,
    summary: null,
  } as PrdBriefingState["activeRun"];
}

function progress(runId: string, status: string): PrdBriefingState["stageProgress"] {
  return {
    schemaVersion: "stage_progress/v1",
    phase: "prd_briefing_final_review",
    runId,
    status,
  } as PrdBriefingState["stageProgress"];
}

describe("a PRD job only answers for its own run", () => {
  it("does not let the previous completed run declare this job finished", () => {
    // The reproduction: click an AI button a second time on the same change.
    // The worker is a single-threaded loop, so the new job sits `queued` and no
    // new run row exists yet -- while RUN-045, completed minutes ago, is still
    // the newest run. Polling read it as this job's result, showed "AI job 已结
    // 束，但 PRD 产物没有更新" and called stopPolling(), so the page stopped
    // refreshing while the job was still waiting its turn.
    const before = state({ activeRun: run("RUN-045", "completed") });
    const baseline = prdJobBaseline(before);

    const duringPoll = state({ activeRun: run("RUN-045", "completed") });
    assert.equal(
      runForThisJob(duringPoll, baseline),
      null,
      "the run that was already there must not answer for the new job",
    );

    const jobActuallyStarted = state({ activeRun: run("RUN-046", "completed") });
    assert.equal(
      runForThisJob(jobActuallyStarted, baseline)?.id,
      "RUN-046",
      "a genuinely new run does answer for this job",
    );
  });

  it("does not report the previous run's failure against this job", () => {
    const before = state({ activeRun: { ...run("RUN-045", "failed"), summary: "上一次失败" } });
    const baseline = prdJobBaseline(before);

    assert.equal(runFailed(state({ activeRun: before.activeRun }), baseline), null);
    assert.equal(
      runFailed(state({ activeRun: { ...run("RUN-046", "failed"), summary: "这次失败" } }), baseline),
      "这次失败",
    );
  });

  it("ignores the progress event that was already on screen", () => {
    const before = state({ stageProgress: progress("RUN-045", "completed") });
    const baseline = prdJobBaseline(before);

    assert.equal(progressForThisJob(state({ stageProgress: before.stageProgress }), baseline), null);
    assert.equal(
      progressForThisJob(state({ stageProgress: progress("RUN-046", "started") }), baseline)?.runId,
      "RUN-046",
    );
    // Same run advancing to a new status is this job's news too.
    assert.equal(
      progressForThisJob(state({ stageProgress: progress("RUN-045", "failed") }), baseline)?.status,
      "failed",
    );
  });
});

describe("durable briefing state outranks a stale progress event", () => {
  it("says 已锁定 rather than replaying the run that locked it", () => {
    // Measured on the shipped database: CHG-003 is locked at 18:29:20 while its
    // last progress event is 18:08:38. The headline used to open with the
    // progress text, which never expires, so 已锁定 / 终审完成 / 草稿就绪 /
    // 追问就绪 / 意图已保存 were all unreachable once a change had run any PRD job.
    const locked = state({
      briefing: { ...state().briefing!, status: "locked", lockedAt: "2026-07-22T18:29:20.977Z" },
      stageProgress: progress("RUN-047", "completed"),
    });

    assert.equal(statusText(locked), "已锁定");
  });

  it("still reports a run that is genuinely in flight", () => {
    assert.equal(statusText(state({ activeRun: run("RUN-048", "running") })), "反方行动中");
  });

  it("drops the success banner once the briefing is locked", () => {
    const locked = state({
      briefing: { ...state().briefing!, status: "locked" },
      stageProgress: progress("RUN-047", "completed"),
    });
    assert.equal(
      stageProgressNotice(locked),
      null,
      "a banner about the run that locked the PRD must not outlive the stage",
    );

    // Before locking it is real news and still shows.
    assert.equal(
      stageProgressNotice(state({ stageProgress: progress("RUN-047", "completed") }))?.tone,
      "success",
    );
  });
});
