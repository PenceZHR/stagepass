import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  pipelineJobOwnerDeadlineAt,
  stageTurnBudgetMs,
} from "./pipeline-owner-deadline";

const STARTED_AT = "2026-07-10T00:01:00.000Z";

describe("pipeline owner deadline", () => {
  // The Codex turn observation budget is this deadline. When it collapsed to
  // the lease expiry, every App turn longer than one 30 second lease period
  // died as turn_observation_timeout while it was still running.
  it("gives a stage job a budget that outlives its renewable lease", () => {
    const deadline = pipelineJobOwnerDeadlineAt({
      jobKind: "stage",
      effectDeadlineAt: null,
      startedAt: STARTED_AT,
      leaseExpiresAt: "2026-07-10T00:01:30.000Z",
    });

    assert.equal(
      deadline,
      new Date(Date.parse(STARTED_AT) + stageTurnBudgetMs()).toISOString(),
    );
  });

  it("keeps the budget fixed while the lease is renewed", () => {
    const facts = { jobKind: "stage", startedAt: STARTED_AT } as const;
    const first = pipelineJobOwnerDeadlineAt({
      ...facts,
      leaseExpiresAt: "2026-07-10T00:01:30.000Z",
    });
    const afterHeartbeats = pipelineJobOwnerDeadlineAt({
      ...facts,
      leaseExpiresAt: "2026-07-10T00:09:30.000Z",
    });

    assert.equal(afterHeartbeats, first);
  });

  it("honours the budget an interaction job was queued with", () => {
    assert.equal(
      pipelineJobOwnerDeadlineAt({
        jobKind: "interaction_wakeup",
        effectDeadlineAt: "2026-07-10T00:31:00.000Z",
        startedAt: STARTED_AT,
        leaseExpiresAt: "2026-07-10T00:01:30.000Z",
      }),
      "2026-07-10T00:31:00.000Z",
    );
  });

  // A job re-leased long after its budget elapsed must keep the reach it had
  // before this rule existed, rather than being refused outright.
  it("never returns less reach than the live lease", () => {
    assert.equal(
      pipelineJobOwnerDeadlineAt({
        jobKind: "stage",
        startedAt: "2026-07-09T00:00:00.000Z",
        leaseExpiresAt: "2026-07-10T00:01:30.000Z",
      }),
      "2026-07-10T00:01:30.000Z",
    );
  });

  it("falls back to the lease when the job never started", () => {
    assert.equal(
      pipelineJobOwnerDeadlineAt({
        jobKind: "stage",
        startedAt: null,
        leaseExpiresAt: "2026-07-10T00:01:30.000Z",
      }),
      "2026-07-10T00:01:30.000Z",
    );
  });
});
