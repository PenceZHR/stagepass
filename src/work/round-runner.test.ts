import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { RESULT_CONTRACT } from "../domain/turn";
import { BLUE, RED } from "../domain/round";
import { ScriptedCodexTransport } from "../codex/transport";
import { ChangeStore } from "../store/change-store";
import { GapStore } from "../store/gap-store";
import { runRound } from "./round-runner";

/**
 * L4 offline: a whole adversarial round, minus the one thing only a real Codex
 * can answer (whether a judge really spawns two sub-agents).
 */

const CHANGE = "CHG-R";
const AT = "2026-07-29T00:00:00.000Z";

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  const changes = new ChangeStore(db, { now: () => new Date(AT) });
  changes.create(CHANGE);
  return db;
}

/** A role transcript in the shape the result contract asks for. */
function answer(input: {
  artifactIds?: string[];
  blockers?: { id: string; severity: string; title: string }[];
}): string {
  return "```json\n" + JSON.stringify({
    artifactIds: input.artifactIds ?? [],
    blockers: input.blockers ?? [],
  }) + "\n```";
}

function verdicts(record: Record<string, { kind: string; reason: string }>): string {
  return "```json\n" + JSON.stringify({ verdicts: record }) + "\n```";
}

const roles = (red: string, blue: string) =>
  (_parent: string, path: string): string => {
    if (path === RED) return red;
    if (path === BLUE) return blue;
    throw new Error(`unexpected role ${path}`);
  };

describe("L4 · a round turns blue's attack into gaps the gate can read", () => {
  it("opens what blue found, and blocks the gate with it", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    const settled = await runRound(
      { changeId: CHANGE, phase: "Spec", round: 1, task: "写 Spec", judgeThreadId: null },
      {
        transport,
        gaps,
        readRole: roles(
          answer({ artifactIds: ["spec.md"] }),
          answer({ blockers: [{ id: "SPEC-1", severity: "P1", title: "验收不可测" }] }),
        ),
      },
    );

    assert.equal(settled.judgeThreadId, "JUDGE-1");
    assert.deepEqual(settled.artifactIds, ["spec.md"]);
    assert.deepEqual(settled.blockers.map((b) => b.id), ["SPEC-1"]);
    // and it is state, not just a return value
    assert.deepEqual(gaps.blockers(CHANGE, "Spec").map((b) => b.id), ["SPEC-1"]);
  });

  it("puts the open gaps to the judge, and asks red for the contract shape", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({}), verdicts({})], "JUDGE-1");
    const dependencies = {
      transport,
      gaps,
      readRole: roles(
        answer({ artifactIds: ["spec.md"] }),
        answer({ blockers: [{ id: "SPEC-1", severity: "P1", title: "验收不可测" }] }),
      ),
    };
    const request = {
      changeId: CHANGE, phase: "Spec" as const, task: "写 Spec", judgeThreadId: null,
    };

    await runRound({ ...request, round: 1 }, dependencies);
    await runRound({ ...request, round: 2, judgeThreadId: "JUDGE-1" }, dependencies);

    // Round 1 had nothing open to judge; round 2 must carry round 1's finding.
    assert.match(transport.dispatches[0]!.prompt, /没有未关闭的问题/);
    assert.match(transport.dispatches[1]!.prompt, /SPEC-1 \[P1\] 验收不可测/);
    // Red is told the shape to answer in, or its result is unreadable later.
    assert.ok(transport.dispatches[0]!.prompt.includes(RESULT_CONTRACT));
  });

  it("closes a gap only when the judge says why", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([
      verdicts({}),
      verdicts({ "SPEC-1": { kind: "closed", reason: "已补可测的验收标准" } }),
    ], "JUDGE-1");
    // Blue stops reporting it in round 2. Silence must NOT close it -- only the
    // judge's verdict does.
    const dependencies = {
      transport,
      gaps,
      readRole: (_parent: string, path: string) => path === RED
        ? answer({ artifactIds: ["spec.md"] })
        : answer({ blockers: [] }),
    };
    const first = {
      transport,
      gaps,
      readRole: roles(
        answer({ artifactIds: ["spec.md"] }),
        answer({ blockers: [{ id: "SPEC-1", severity: "P1", title: "验收不可测" }] }),
      ),
    };
    const request = {
      changeId: CHANGE, phase: "Spec" as const, task: "写 Spec", judgeThreadId: null,
    };

    await runRound({ ...request, round: 1 }, first);
    assert.deepEqual(gaps.blockers(CHANGE, "Spec").map((b) => b.id), ["SPEC-1"]);

    const settled = await runRound({ ...request, round: 2, judgeThreadId: "JUDGE-1" }, dependencies);
    assert.deepEqual(settled.blockers, []);
    assert.equal(gaps.all(CHANGE, "Spec")[0]!.resolution, "已补可测的验收标准");
  });

  it("keeps a gap the judge said nothing about", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([
      verdicts({}),
      verdicts({}), // judge says nothing in round 2
    ], "JUDGE-1");
    const request = {
      changeId: CHANGE, phase: "Spec" as const, task: "写 Spec", judgeThreadId: null,
    };
    const withBlue = (blockers: { id: string; severity: string; title: string }[]) => ({
      transport,
      gaps,
      readRole: roles(answer({ artifactIds: ["spec.md"] }), answer({ blockers })),
    });

    await runRound({ ...request, round: 1 },
      withBlue([{ id: "SPEC-1", severity: "P1", title: "验收不可测" }]));
    const settled = await runRound({ ...request, round: 2, judgeThreadId: "JUDGE-1" },
      withBlue([]));

    assert.deepEqual(settled.blockers.map((b) => b.id), ["SPEC-1"]);
  });
});

describe("L4 · a round that half happened settles nothing", () => {
  it("writes no gaps when blue cannot be read", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    await assert.rejects(() => runRound(
      { changeId: CHANGE, phase: "Spec", round: 1, task: "写 Spec", judgeThreadId: null },
      {
        transport,
        gaps,
        readRole: (_parent, path) => {
          if (path === RED) return answer({ artifactIds: ["spec.md"] });
          throw new Error("no sub-agent at /root/blue");
        },
      },
    ), /no sub-agent/);

    // The gate must still read the state from before the round.
    assert.deepEqual(gaps.all(CHANGE, "Spec"), []);
  });

  it("refuses a blue that answered in the wrong shape", async () => {
    const db = database();
    const gaps = new GapStore(db, () => new Date(AT));
    const transport = new ScriptedCodexTransport([verdicts({})], "JUDGE-1");

    await assert.rejects(() => runRound(
      { changeId: CHANGE, phase: "Spec", round: 1, task: "写 Spec", judgeThreadId: null },
      {
        transport,
        gaps,
        readRole: roles(
          answer({ artifactIds: ["spec.md"] }),
          "蓝方觉得这份 Spec 大体没问题。",
        ),
      },
    ), /blue:/);

    assert.deepEqual(gaps.all(CHANGE, "Spec"), []);
  });
});
