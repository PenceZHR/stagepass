import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveFinished,
  ensureResumable,
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
  it("open 不动，archived 解开并二次确认", async () => {
    const open = fake({ "T-OPEN": "open" });
    assert.equal(await ensureResumable("T-OPEN", open), "already_open");
    assert.deepEqual(open.calls, []);

    const archived = fake({ "T-ARCHIVED": "archived" });
    assert.equal(await ensureResumable("T-ARCHIVED", archived), "unarchived");
    assert.deepEqual(archived.calls, ["unarchive T-ARCHIVED"]);
  });

  it("只有明确 missing 才说 missing；断线说 unavailable", async () => {
    assert.equal(await ensureResumable("T-X", fake({})), "missing");
    assert.equal(
      await ensureResumable("T-X", fake({}, { unavailable: true })),
      "unavailable",
    );
  });

  it("请求失败或事后二次确认仍归档，不伪装成成功", async () => {
    assert.equal(
      await ensureResumable("T-1", fake({ "T-1": "archived" }, { throws: true })),
      "still_archived",
    );
    assert.equal(
      await ensureResumable("T-1", fake({ "T-1": "archived" }, { lies: true })),
      "still_archived",
    );
  });

  it("批准后才归档，且归档和解归档可逆", async () => {
    const ops = fake({ "T-FIX": "open" });
    assert.equal(await archiveFinished("T-FIX", ops), "archived");
    assert.equal(await ensureResumable("T-FIX", ops), "unarchived");
    assert.deepEqual(ops.calls, ["archive T-FIX", "unarchive T-FIX"]);
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
