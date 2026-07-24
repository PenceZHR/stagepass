import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  handleInterruptCodex,
  type InterruptCodexDependencies,
  type InterruptTarget,
} from "./route";

const target: InterruptTarget = {
  bindingId: "BIND-1",
  threadId: "THREAD-1",
  turnId: "TURN-1",
  pipelineJobId: "JOB-1",
};

describe("Codex interrupt route", () => {
  it("interrupts only the lease-matched active target and records Web ops", async () => {
    const interrupted: InterruptTarget[] = [];
    const recorded: InterruptTarget[] = [];
    const dependencies: InterruptCodexDependencies = {
      readTarget: () => target,
      interrupt: async (value) => { interrupted.push(value); },
      record: ({ target: value }) => {
        recorded.push(value);
        return "CMD-1";
      },
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    };
    const response = await handleInterruptCodex("PRJ-1", "CHG-1", dependencies);
    assert.equal(response.status, 200);
    assert.deepEqual(interrupted, [target]);
    assert.deepEqual(recorded, [target]);
    assert.equal((await response.json()).commandId, "CMD-1");
  });

  it("does not issue a blind interrupt without a live target", async () => {
    let called = false;
    const response = await handleInterruptCodex("PRJ-1", "CHG-1", {
      readTarget: () => null,
      interrupt: async () => { called = true; },
      record: () => "CMD-1",
      now: () => new Date(),
    });
    assert.equal(response.status, 409);
    assert.equal(called, false);
  });
});
