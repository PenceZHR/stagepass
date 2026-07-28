import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PHASES } from "./phase";
import {
  assertRequestValid,
  InvalidTurnRequestError,
  parseTurnResult,
  requestHash,
  RESULT_CONTRACT,
  TurnResultUnparsableError,
} from "./turn";
import { MINIMAL_PHASE_INSTRUCTIONS } from "../codex/turn-runner";

describe("L2 · a request the far end can act on", () => {
  /**
   * The old tree dispatched turns whose text sat under a field its reader did
   * not read, so every one of them failed the instant it was picked up -- and
   * nothing noticed for as long as nothing reached that path.
   */
  it("refuses a blank prompt before anything is written down", () => {
    for (const prompt of ["", "   ", "\n\t"]) {
      assert.throws(
        () => assertRequestValid({ changeId: "CHG-1", phase: "PRD", prompt }),
        (error: unknown) =>
          error instanceof InvalidTurnRequestError
          && error.code === "prompt_missing",
      );
    }
  });

  it("gives the same request the same identity", () => {
    const request = { changeId: "CHG-1", phase: "PRD" as const, prompt: "go" };
    assert.equal(requestHash(request), requestHash({ ...request }));
    assert.notEqual(
      requestHash(request),
      requestHash({ ...request, prompt: "go further" }),
    );
  });
});

describe("L2 · reading the model's answer", () => {
  it("accepts the contract's shape", () => {
    assert.deepEqual(
      parseTurnResult(
        '```json\n{"artifactIds":["a.md"],"blockers":[{"id":"B","severity":"P1","title":"x"}]}\n```',
      ),
      {
        artifactIds: ["a.md"],
        blockers: [{ id: "B", severity: "P1", title: "x" }],
      },
    );
  });

  it("accepts bare json with no fence", () => {
    assert.deepEqual(
      parseTurnResult('{"artifactIds":[],"blockers":[]}'),
      { artifactIds: [], blockers: [] },
    );
  });

  it("ignores prose around the block", () => {
    assert.deepEqual(
      parseTurnResult(
        'Here is what I did.\n```json\n{"artifactIds":["a"],"blockers":[]}\n```\nHope that helps!',
      ).artifactIds,
      ["a"],
    );
  });

  for (const [label, text, code] of [
    ["no json at all", "all done", "turn_result_no_json"],
    ["an array", "[]", "turn_result_not_an_object"],
    ["null", "null", "turn_result_not_an_object"],
    ["missing artifactIds", '{"blockers":[]}', "turn_result_artifacts_invalid"],
    [
      "a non-string artifact",
      '{"artifactIds":[7],"blockers":[]}',
      "turn_result_artifacts_invalid",
    ],
    [
      "a blank artifact",
      '{"artifactIds":["  "],"blockers":[]}',
      "turn_result_artifacts_invalid",
    ],
    [
      "missing blockers",
      '{"artifactIds":[]}',
      "turn_result_blockers_invalid",
    ],
    [
      "an invented severity",
      '{"artifactIds":[],"blockers":[{"id":"B","severity":"BLOCKER","title":"x"}]}',
      "turn_result_blockers_invalid",
    ],
    [
      "a blocker with no id",
      '{"artifactIds":[],"blockers":[{"severity":"P0","title":"x"}]}',
      "turn_result_blockers_invalid",
    ],
  ] as const) {
    it(`names the failure on ${label}`, () => {
      assert.throws(
        () => parseTurnResult(text),
        (error: unknown) =>
          error instanceof TurnResultUnparsableError && error.code === code,
      );
    });
  }
});

describe("L2 · what every turn is told", () => {
  it("states the exact fields the gate reads", () => {
    assert.match(RESULT_CONTRACT, /artifactIds/);
    assert.match(RESULT_CONTRACT, /blockers/);
    assert.match(RESULT_CONTRACT, /P0\|P1\|P2/);
  });

  /**
   * A phase with no instruction would dispatch a turn carrying only the result
   * contract -- the model would be told how to answer but not what to do.
   */
  it("has an instruction for every phase", () => {
    for (const phase of PHASES) {
      assert.ok(
        MINIMAL_PHASE_INSTRUCTIONS[phase]?.trim(),
        `${phase} has no instruction`,
      );
    }
    assert.equal(
      Object.keys(MINIMAL_PHASE_INSTRUCTIONS).length,
      PHASES.length,
    );
  });
});
