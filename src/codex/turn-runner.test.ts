import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import {
  BindingStore,
  ChangeNotBoundError,
  ThreadAlreadyBoundError,
} from "../store/binding-store";
import {
  TurnNotFoundError,
  TurnNotInStatusError,
  TurnStore,
} from "../store/turn-store";
import { TurnLoop } from "../work/turn-loop";
import { CodexTurnRunner } from "./turn-runner";
import { CodexUnavailableError, ScriptedCodexTransport } from "./transport";

const AT = "2026-07-28T00:00:00.000Z";
const T0 = 1_000_000;
const DEADLINE = T0 + 300_000;
const WORKER = { owner: "w-a", token: "t-1", now: T0, ttlMs: 30_000 };

const GOOD = '```json\n{"artifactIds":["prd.md"],"blockers":[]}\n```';

function open(replies: (string | Error)[]) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const now = () => new Date(AT);
  const changes = new ChangeStore(database, { now });
  changes.create("CHG-1");
  const transport = new ScriptedCodexTransport(replies);
  return {
    database,
    changes,
    transport,
    turns: new TurnStore(database, now),
    bindings: new BindingStore(database, now),
    commands: new CommandStore(database, now),
    loop: new TurnLoop({
      database,
      now,
      runner: new CodexTurnRunner({ database, transport, now }),
    }),
  };
}

function queue(loop: TurnLoop, jobId = "JOB-1") {
  loop.queueTurn({
    changeId: "CHG-1", jobId, deadlineAt: DEADLINE, maxAttempts: 3,
  });
}

describe("L2 · a turn goes out, an answer comes back, the gate opens", () => {
  it("binds a thread, records the turn, and settles the phase", async () => {
    const { database, changes, bindings, turns, commands, loop } = open([GOOD]);
    try {
      queue(loop);
      assert.deepEqual(await loop.runOnce(WORKER), {
        kind: "settled", jobId: "JOB-1",
      });

      assert.equal(bindings.require("CHG-1"), "THREAD-1");
      const turn = turns.read("TURN-JOB-1-1");
      assert.equal(turn.status, "completed");
      assert.equal(turn.threadId, "THREAD-1");
      assert.equal(turn.response, GOOD);
      assert.equal(changes.read("CHG-1").state.status, "settled");
      assert.ok(commands.gateFor("CHG-1").permitted.includes("approve"));
    } finally {
      database.close();
    }
  });

  /**
   * A turn dispatched without the result contract is a turn whose answer cannot
   * be read, and the failure shows up far from the cause.
   */
  it("sends the result contract with every turn", async () => {
    const { database, transport, loop } = open([GOOD]);
    try {
      queue(loop);
      await loop.runOnce(WORKER);
      assert.equal(transport.prompts.length, 1);
      assert.match(transport.prompts[0]!, /artifactIds/);
      assert.match(transport.prompts[0]!, /P0\|P1\|P2/);
      // And the phase's own instruction, not only the contract.
      assert.match(transport.prompts[0]!, /product requirement/);
    } finally {
      database.close();
    }
  });

  it("reuses the bound thread on the next phase instead of opening another", async () => {
    const { database, transport, commands, loop } = open([GOOD, GOOD]);
    try {
      queue(loop);
      await loop.runOnce(WORKER);
      commands.apply({
        changeId: "CHG-1", action: "approve",
        idempotencyKey: "cmd-1",
        expectedSnapshot: commands.gateFor("CHG-1").snapshot,
      });
      queue(loop, "JOB-2");
      await loop.runOnce(WORKER);
      assert.equal(transport.prompts.length, 2);
      // The second turn asked Spec's question, on the same thread.
      assert.match(transport.prompts[1]!, /product specification/);
    } finally {
      database.close();
    }
  });

  it("carries blockers through to the gate", async () => {
    const { database, commands, loop } = open([
      '```json\n{"artifactIds":["prd.md"],"blockers":[{"id":"B-1","severity":"P0","title":"范围冲突"}]}\n```',
    ]);
    try {
      queue(loop);
      await loop.runOnce(WORKER);
      assert.equal(
        commands.gateFor("CHG-1").refusals.approve,
        "blocking_problem_outstanding",
      );
    } finally {
      database.close();
    }
  });
});

describe("L2 · the record exists before anything is sent", () => {
  /**
   * The durability guarantee. A crash between dispatch and response must leave
   * a row recovery can see -- not silence, which a retry would turn into the
   * same work running twice.
   */
  it("leaves a dispatched turn behind when Codex never answers", async () => {
    const { database, changes, turns, loop } = open([
      new CodexUnavailableError("socket closed"),
    ]);
    try {
      queue(loop);
      const result = await loop.runOnce(WORKER);
      assert.equal(result.kind, "failed");

      const turn = turns.read("TURN-JOB-1-1");
      assert.equal(turn.status, "failed");
      assert.match(turn.error!, /turn_dispatch_failed: codex_unavailable/);
      assert.equal(turn.threadId, "THREAD-1", "it had been dispatched");
      assert.equal(changes.read("CHG-1").state.status, "blocked");
    } finally {
      database.close();
    }
  });

  it("lists turns that were sent and never came back", () => {
    const { database, turns, loop } = open([]);
    try {
      // A turn belongs to a job -- the foreign key says so -- so the job has to
      // exist before the turn that runs it.
      queue(loop);
      turns.allocate({
        id: "TURN-X", jobId: "JOB-1",
        request: { changeId: "CHG-1", phase: "PRD", prompt: "do the thing" },
      });
      assert.deepEqual(turns.inFlight(), []);
      turns.markDispatched("TURN-X", "THREAD-1");
      assert.deepEqual(turns.inFlight().map((turn) => turn.id), ["TURN-X"]);
      turns.markCompleted("TURN-X", "done");
      assert.deepEqual(turns.inFlight(), []);
    } finally {
      database.close();
    }
  });
});

describe("L2 · an answer in the wrong shape is a failure with a name", () => {
  for (const [label, reply, code] of [
    ["prose with no json", "Looks good to me!", "turn_result_no_json"],
    ["a bare array", "```json\n[]\n```", "turn_result_not_an_object"],
    [
      "artifacts missing",
      '```json\n{"blockers":[]}\n```',
      "turn_result_artifacts_invalid",
    ],
    [
      "an invented severity",
      '```json\n{"artifactIds":["a"],"blockers":[{"id":"B","severity":"CRITICAL","title":"x"}]}\n```',
      "turn_result_blockers_invalid",
    ],
  ] as const) {
    it(`fails the turn on ${label}`, async () => {
      const { database, changes, turns, loop } = open([reply]);
      try {
        queue(loop);
        const result = await loop.runOnce(WORKER);
        assert.deepEqual(result, {
          kind: "failed", jobId: "JOB-1", reason: code,
        });
        // The response is kept: the turn completed, it just said nothing usable.
        const turn = turns.read("TURN-JOB-1-1");
        assert.equal(turn.status, "completed");
        assert.equal(turn.response, reply);
        assert.equal(changes.read("CHG-1").state.status, "blocked");
      } finally {
        database.close();
      }
    });
  }

  /**
   * A model that reconsiders emits a second block. Taking the first would act
   * on a draft it had already replaced.
   */
  it("reads the last json block, not the first", async () => {
    const { database, commands, loop } = open([
      '```json\n{"artifactIds":[],"blockers":[]}\n```\n'
      + 'Actually:\n```json\n{"artifactIds":["prd.md"],"blockers":[]}\n```',
    ]);
    try {
      queue(loop);
      await loop.runOnce(WORKER);
      assert.ok(commands.gateFor("CHG-1").permitted.includes("approve"));
    } finally {
      database.close();
    }
  });
});

describe("L2 · the turn record refuses moves it cannot make", () => {
  it("reports an unknown turn instead of returning an empty one", () => {
    const { database, turns } = open([]);
    try {
      assert.throws(() => turns.read("TURN-NOPE"), TurnNotFoundError);
    } finally {
      database.close();
    }
  });

  /**
   * A completed turn must not be dispatched again. Without this, a retry after
   * a lost acknowledgement runs the same work twice.
   */
  it("refuses to dispatch or complete out of order", () => {
    const { database, turns, loop } = open([]);
    try {
      queue(loop);
      turns.allocate({
        id: "TURN-X", jobId: "JOB-1",
        request: { changeId: "CHG-1", phase: "PRD", prompt: "go" },
      });
      assert.throws(
        () => turns.markCompleted("TURN-X", "early"),
        TurnNotInStatusError,
      );
      turns.markDispatched("TURN-X", "THREAD-1");
      assert.throws(
        () => turns.markDispatched("TURN-X", "THREAD-1"),
        TurnNotInStatusError,
      );
      turns.markCompleted("TURN-X", "done");
      assert.throws(
        () => turns.markFailed("TURN-X", "too late"),
        TurnNotInStatusError,
      );
    } finally {
      database.close();
    }
  });
});

describe("L2 · one Change, one thread", () => {
  it("names the failure when a Change has no thread", () => {
    const { database, bindings } = open([]);
    try {
      assert.throws(() => bindings.require("CHG-1"), ChangeNotBoundError);
      bindings.bind("CHG-1", "THREAD-1");
      bindings.detach("CHG-1");
      assert.throws(() => bindings.require("CHG-1"), ChangeNotBoundError);
    } finally {
      database.close();
    }
  });

  it("refuses to move a bound Change onto a different thread", () => {
    const { database, bindings } = open([]);
    try {
      bindings.bind("CHG-1", "THREAD-1");
      assert.equal(bindings.bind("CHG-1", "THREAD-1").threadId, "THREAD-1");
      assert.throws(
        () => bindings.bind("CHG-1", "THREAD-2"),
        ThreadAlreadyBoundError,
      );
    } finally {
      database.close();
    }
  });

  it("refuses to hand one thread to two Changes", () => {
    const { database, changes, bindings } = open([]);
    try {
      changes.create("CHG-2");
      bindings.bind("CHG-1", "THREAD-1");
      assert.throws(
        () => bindings.bind("CHG-2", "THREAD-1"),
        ThreadAlreadyBoundError,
      );
    } finally {
      database.close();
    }
  });

  it("lets a detached Change bind somewhere new", () => {
    const { database, bindings } = open([]);
    try {
      bindings.bind("CHG-1", "THREAD-1");
      bindings.detach("CHG-1");
      assert.equal(bindings.bind("CHG-1", "THREAD-2").threadId, "THREAD-2");
    } finally {
      database.close();
    }
  });
});
