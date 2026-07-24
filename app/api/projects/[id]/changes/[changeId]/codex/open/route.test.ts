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
    readShell: async () => ({
      threadId: "THREAD-1",
      title: "Change",
      cwd: "/tmp/project",
      ephemeral: false,
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

  it("returns detached when the shell is missing or does not match", async () => {
    for (const readShell of [
      async () => null,
      async () => ({
        threadId: "THREAD-OTHER",
        title: "Change",
        cwd: "/tmp/project",
        ephemeral: false as const,
      }),
    ]) {
      const fixture = dependencies({ readShell });
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
