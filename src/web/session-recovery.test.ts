import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArchiveOps } from "../codex/archive";
import type { ThreadAvailability } from "../codex/app-server-history";
import type { BoundThread } from "../store/binding-store";
import {
  inspectBoundThread,
  prepareBoundThread,
  reconcileMissingBindings,
} from "./session-recovery";

function fakeArchive(
  initial: Record<string, ThreadAvailability | "unavailable">,
  options: { lies?: boolean } = {},
): ArchiveOps & { calls: string[] } {
  const state = { ...initial };
  const calls: string[] = [];
  return {
    calls,
    async availability(threadId) {
      const current = state[threadId] ?? "missing";
      if (current === "unavailable") throw new Error("app-server disconnected");
      return current;
    },
    async unarchive(threadId) {
      calls.push(`unarchive ${threadId}`);
      if (options.lies !== true) state[threadId] = "open";
    },
    async archive(threadId) {
      calls.push(`archive ${threadId}`);
      state[threadId] = "archived";
    },
  };
}

const ROUND: BoundThread = {
  changeId: "CHG-1",
  kind: "round",
  phase: "Test",
  threadId: "T-OLD",
};

describe("App Server session recovery", () => {
  it("只读检查能区分 open / archived / missing / unavailable，且不解档不解绑", async () => {
    const archive = fakeArchive({
      "T-OPEN": "open",
      "T-ARCHIVED": "archived",
      "T-MISSING": "missing",
      "T-DOWN": "unavailable",
    });
    const binding = (threadId: string): BoundThread => ({ ...ROUND, threadId });

    assert.deepEqual(await inspectBoundThread(binding("T-OPEN"), archive), {
      kind: "open", threadId: "T-OPEN",
    });
    assert.deepEqual(await inspectBoundThread(binding("T-ARCHIVED"), archive), {
      kind: "archived", threadId: "T-ARCHIVED",
    });
    assert.deepEqual(await inspectBoundThread(binding("T-MISSING"), archive), {
      kind: "missing", threadId: "T-MISSING",
    });
    assert.deepEqual(await inspectBoundThread(binding("T-DOWN"), archive), {
      kind: "unavailable", reason: "app-server disconnected",
    });
    assert.deepEqual(archive.calls, []);
  });

  it("open 原样恢复，archived 经确认解开后恢复", async () => {
    const detached: BoundThread[] = [];
    assert.deepEqual(await prepareBoundThread({
      binding: ROUND,
      archive: fakeArchive({ "T-OLD": "open" }),
      detach: (binding) => { detached.push(binding); },
    }), { kind: "resume", threadId: "T-OLD" });
    assert.deepEqual(detached, []);

    const archived = fakeArchive({ "T-OLD": "archived" });
    assert.deepEqual(await prepareBoundThread({
      binding: ROUND,
      archive: archived,
      detach: () => { assert.fail("不该 detach"); },
    }), { kind: "resume", threadId: "T-OLD" });
    assert.deepEqual(archived.calls, ["unarchive T-OLD"]);
  });

  it("只有 missing 会 detach；断线和撒谎都拒绝但保留 binding", async () => {
    const detached: BoundThread[] = [];
    assert.deepEqual(await prepareBoundThread({
      binding: ROUND,
      archive: fakeArchive({ "T-OLD": "missing" }),
      detach: (binding) => { detached.push(binding); },
    }), { kind: "fresh", replacedThreadId: "T-OLD" });
    assert.deepEqual(detached, [ROUND]);

    assert.deepEqual(await prepareBoundThread({
      binding: ROUND,
      archive: fakeArchive({ "T-OLD": "unavailable" }),
      detach: () => { assert.fail("断线不许 detach"); },
    }), { kind: "refused", reason: "app-server disconnected" });

    assert.deepEqual(await prepareBoundThread({
      binding: ROUND,
      archive: fakeArchive({ "T-OLD": "archived" }, { lies: true }),
      detach: () => { assert.fail("撒谎不许 detach"); },
    }), {
      kind: "refused",
      reason: "thread is still archived after thread/unarchive",
    });
  });

  it("启动巡检只解绑 missing，报告断线，且重复执行幂等", async () => {
    const bindings: BoundThread[] = [
      { changeId: "CHG-1", kind: "round", phase: "Build", threadId: "T-OPEN" },
      { changeId: "CHG-1", kind: "round", phase: "Test", threadId: "T-MISSING" },
      { changeId: "CHG-1", kind: "round", phase: "PRD", threadId: "T-ARCHIVED" },
      { changeId: "CHG-1", kind: "round", phase: "Spec", threadId: "T-DOWN" },
      { changeId: "CHG-1", kind: "aside", phase: null, threadId: "T-ASIDE" },
    ];
    const detached = new Set<string>();
    const store = {
      listBound: () => bindings.filter((binding) => !detached.has(binding.threadId)),
      detach: (changeId: string, phase: string) => {
        const binding = bindings.find((candidate) =>
          candidate.kind === "round" && candidate.changeId === changeId &&
          candidate.phase === phase);
        assert.ok(binding);
        detached.add(binding.threadId);
      },
      detachAside: (changeId: string) => {
        const binding = bindings.find((candidate) =>
          candidate.kind === "aside" && candidate.changeId === changeId);
        assert.ok(binding);
        detached.add(binding.threadId);
      },
    };
    const archive = fakeArchive({
      "T-OPEN": "open",
      "T-MISSING": "missing",
      "T-ARCHIVED": "archived",
      "T-DOWN": "unavailable",
      "T-ASIDE": "missing",
    });

    const first = await reconcileMissingBindings(store, archive);
    assert.deepEqual(first, {
      detached: [bindings[1], bindings[4]],
      unavailable: [{ binding: bindings[3], reason: "app-server disconnected" }],
    });
    assert.deepEqual([...detached], ["T-MISSING", "T-ASIDE"]);

    const second = await reconcileMissingBindings(store, archive);
    assert.deepEqual(second, {
      detached: [],
      unavailable: [{ binding: bindings[3], reason: "app-server disconnected" }],
    });
  });
});
