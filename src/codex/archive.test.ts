import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveFinished,
  type ArchiveOps,
} from "./archive";
import type { ThreadAvailability } from "./app-server-history";

function fake(
  initial: Record<string, ThreadAvailability>,
  options: { throws?: boolean; lies?: boolean; unavailable?: boolean } = {},
): ArchiveOps & { calls: string[] } {
  const state = { ...initial };
  const calls: string[] = [];
  return {
    calls,
    async availability(threadId) {
      if (options.unavailable === true) throw new Error("app-server disconnected");
      return state[threadId] ?? "missing";
    },
    async archive(threadId) {
      calls.push(`archive ${threadId}`);
      if (options.throws === true) throw new Error("archive failed");
      if (options.lies !== true) state[threadId] = "archived";
    },
    async unarchive(threadId) {
      calls.push(`unarchive ${threadId}`);
      if (options.throws === true) throw new Error("unarchive failed");
      if (options.lies !== true) state[threadId] = "open";
    },
  };
}

describe("App Server archive policy", () => {
  it("批准后才归档", async () => {
    const ops = fake({ "T-FIX": "open" });
    assert.equal(await archiveFinished("T-FIX", ops), "archived");
    assert.deepEqual(ops.calls, ["archive T-FIX"]);
  });

  it("归档请求失败或状态没变时说真话", async () => {
    assert.equal(
      await archiveFinished("T-1", fake({ "T-1": "open" }, { throws: true })),
      "still_open",
    );
    assert.equal(
      await archiveFinished("T-1", fake({ "T-1": "open" }, { lies: true })),
      "still_open",
    );
    assert.equal(await archiveFinished("T-MISSING", fake({})), "unknown");
  });
});
