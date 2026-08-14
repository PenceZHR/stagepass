import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BoundThread } from "../store/binding-store";
import {
  prepareBoundThread, reconcileMissingBindings,
} from "./session-recovery";

type State = "open" | "archived" | "missing" | "no-rollout" | "unavailable";

function fakeArchive(initial: Record<string, State>, options: {
  readonly lies?: boolean;
  readonly throws?: boolean;
} = {}) {
  const state = { ...initial };
  const calls: string[] = [];
  return {
    calls,
    availability(threadId: string) {
      const current = state[threadId] ?? "missing";
      if (current === "open") {
        return { kind: "open" as const, rolloutPath: `/rollouts/${threadId}.jsonl` };
      }
      if (current === "archived") {
        return { kind: "archived" as const, rolloutPath: `/rollouts/${threadId}.jsonl` };
      }
      if (current === "no-rollout") {
        return { kind: "missing" as const, reason: "no-rollout" as const };
      }
      if (current === "unavailable") {
        return { kind: "unavailable" as const, reason: "state database is locked" };
      }
      return { kind: "missing" as const, reason: "no-row" as const };
    },
    unarchive(threadId: string) {
      calls.push(`unarchive ${threadId}`);
      if (options.throws === true) throw new Error("unarchive failed");
      if (options.lies !== true) state[threadId] = "open";
    },
    archive(threadId: string) {
      calls.push(`archive ${threadId}`);
      state[threadId] = "archived";
    },
  };
}

const ROUND: BoundThread = {
  changeId: "CHG-1", kind: "round", phase: "Test", threadId: "T-OLD",
};

describe("session recovery · PTY 前的单席位守卫", () => {
  it("open 线程原样 resume，不 detach", () => {
    const detached: BoundThread[] = [];
    const result = prepareBoundThread({
      binding: ROUND,
      archive: fakeArchive({ "T-OLD": "open" }),
      detach: (binding) => { detached.push(binding); },
    });

    assert.deepEqual(result, { kind: "resume", threadId: "T-OLD" });
    assert.deepEqual(detached, []);
  });

  it("archived 线程确认解开后 resume", () => {
    const archive = fakeArchive({ "T-OLD": "archived" });
    const result = prepareBoundThread({
      binding: ROUND, archive, detach: () => { assert.fail("不该 detach"); },
    });

    assert.deepEqual(result, { kind: "resume", threadId: "T-OLD" });
    assert.deepEqual(archive.calls, ["unarchive T-OLD"]);
  });

  for (const state of ["missing", "no-rollout"] as const) {
    it(`${state} 线程先 detach，再明确要求 fresh`, () => {
      const detached: BoundThread[] = [];
      const result = prepareBoundThread({
        binding: ROUND,
        archive: fakeArchive({ "T-OLD": state }),
        detach: (binding) => { detached.push(binding); },
      });

      assert.deepEqual(result, { kind: "fresh", replacedThreadId: "T-OLD" });
      assert.deepEqual(detached, [ROUND]);
    });
  }

  it("状态库 unavailable 时拒绝启动，不 detach", () => {
    const detached: BoundThread[] = [];
    const result = prepareBoundThread({
      binding: ROUND,
      archive: fakeArchive({ "T-OLD": "unavailable" }),
      detach: (binding) => { detached.push(binding); },
    });

    assert.deepEqual(result, {
      kind: "refused", reason: "state database is locked",
    });
    assert.deepEqual(detached, []);
  });

  it("unarchive 命令撒谎时拒绝启动，不拿退出码当事实", () => {
    const result = prepareBoundThread({
      binding: ROUND,
      archive: fakeArchive({ "T-OLD": "archived" }, { lies: true }),
      detach: () => { assert.fail("不该 detach"); },
    });

    assert.deepEqual(result, {
      kind: "refused", reason: "thread is still archived after unarchive",
    });
  });
});

describe("session recovery · 启动巡检", () => {
  it("只 detach missing，留下 archived/open，报告 unavailable，而且第二次幂等", () => {
    const bindings: BoundThread[] = [
      { changeId: "CHG-1", kind: "round", phase: "Build", threadId: "T-OPEN" },
      { changeId: "CHG-1", kind: "round", phase: "Test", threadId: "T-MISSING" },
      { changeId: "CHG-1", kind: "round", phase: "PRD", threadId: "T-ARCHIVED" },
      { changeId: "CHG-1", kind: "round", phase: "Spec", threadId: "T-UNAVAILABLE" },
      { changeId: "CHG-1", kind: "aside", phase: null, threadId: "T-MISSING-ASIDE" },
    ];
    const detached = new Set<string>();
    const store = {
      listBound: () => bindings.filter((binding) => !detached.has(binding.threadId)),
      detach: (changeId: string, phase: string) => {
        const binding = bindings.find((candidate) =>
          candidate.kind === "round"
          && candidate.changeId === changeId
          && candidate.phase === phase);
        assert.ok(binding, `找不到要 detach 的 round binding：${changeId}/${phase}`);
        detached.add(binding.threadId);
      },
      detachAside: (changeId: string) => {
        const binding = bindings.find((candidate) =>
          candidate.kind === "aside" && candidate.changeId === changeId);
        assert.ok(binding, `找不到要 detach 的 aside binding：${changeId}`);
        detached.add(binding.threadId);
      },
    };
    const archive = fakeArchive({
      "T-OPEN": "open",
      "T-MISSING": "missing",
      "T-ARCHIVED": "archived",
      "T-UNAVAILABLE": "unavailable",
      "T-MISSING-ASIDE": "no-rollout",
    });

    const first = reconcileMissingBindings(store, archive);
    assert.deepEqual(first, {
      detached: [bindings[1], bindings[4]],
      unavailable: [{ binding: bindings[3], reason: "state database is locked" }],
    });
    assert.deepEqual([...detached], ["T-MISSING", "T-MISSING-ASIDE"]);

    const second = reconcileMissingBindings(store, archive);
    assert.deepEqual(second, {
      detached: [],
      unavailable: [{ binding: bindings[3], reason: "state database is locked" }],
    });
  });
});
