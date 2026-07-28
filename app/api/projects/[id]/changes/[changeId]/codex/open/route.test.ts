import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleOpenCodex, type OpenCodexDependencies } from "./route";

function dependencies(patch: Partial<OpenCodexDependencies> = {}) {
  const opened: string[] = [];
  const value: OpenCodexDependencies = {
    readBinding: () => ({
      threadId: "THREAD-1",
      title: "Change",
      status: "ready",
      repoPath: "/tmp/project",
    }),
    openThread: async (threadId) => {
      opened.push(threadId);
    },
    ...patch,
  };
  return { value, opened };
}

describe("open in Codex route", () => {
  it("opens the bound persistent shell without starting a turn", async () => {
    const fixture = dependencies();
    const response = await handleOpenCodex(
      "PRJ-1",
      "CHG-1",
      fixture.value,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(fixture.opened, ["THREAD-1"]);
  });

  it("opens from the canonical binding without a bridge shell round-trip", async () => {
    const fixture = dependencies();
    const response = await handleOpenCodex(
      "PRJ-1",
      "CHG-1",
      fixture.value,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(fixture.opened, ["THREAD-1"]);
  });

  it("returns detached when there is no usable canonical binding", async () => {
    for (const readBinding of [
      () => null,
      () => ({
        threadId: null,
        title: "Change",
        status: "ready",
        repoPath: "/tmp/project",
      }),
      () => ({
        threadId: "THREAD-1",
        title: "Change",
        status: "detached",
        repoPath: "/tmp/project",
      }),
    ]) {
      const fixture = dependencies({ readBinding });
      const response = await handleOpenCodex(
        "PRJ-1",
        "CHG-1",
        fixture.value,
      );
      assert.equal(response.status, 409);
      assert.deepEqual(fixture.opened, []);
    }
  });
});
