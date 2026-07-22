import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  BattleRoundStatus,
  OCCUPIED_BATTLE_ROUND_STATUSES,
  RUNNING_BATTLE_ROUND_STATUSES,
  isOccupiedBattleRoundStatus,
  isRunningBattleRoundStatus,
} from "./enums";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("battle round running-status authority", () => {
  it("holds exactly the two executing statuses", () => {
    assert.deepEqual([...RUNNING_BATTLE_ROUND_STATUSES], ["red_running", "blue_running"]);
  });

  /**
   * The guard that matters. The pipeline UI's copy of this set carried a bare
   * "running" member -- not a BattleRoundStatus, never written to
   * battle_rounds.status by any writer, so it silently matched nothing. Every
   * member must parse as a real round status.
   */
  it("every member is a real BattleRoundStatus", () => {
    for (const status of RUNNING_BATTLE_ROUND_STATUSES) {
      assert.equal(BattleRoundStatus.parse(status), status);
    }
    for (const status of OCCUPIED_BATTLE_ROUND_STATUSES) {
      assert.equal(BattleRoundStatus.parse(status), status);
    }
    assert.throws(() => BattleRoundStatus.parse("running"), "bare \"running\" must not be a round status");
  });

  it("treats occupied as running plus the created-but-unclaimed round", () => {
    assert.deepEqual([...OCCUPIED_BATTLE_ROUND_STATUSES], ["not_started", "red_running", "blue_running"]);
    for (const status of RUNNING_BATTLE_ROUND_STATUSES) {
      assert.ok(isOccupiedBattleRoundStatus(status), `${status} occupies the slot`);
    }
    // The distinction the two predicates exist to preserve.
    assert.ok(isOccupiedBattleRoundStatus("not_started"));
    assert.equal(isRunningBattleRoundStatus("not_started"), false);
  });

  it("answers for every declared round status and for absent input", () => {
    const expectedRunning = new Set<string>(["red_running", "blue_running"]);
    const expectedOccupied = new Set<string>(["not_started", "red_running", "blue_running"]);
    // Drive off the enum so a newly added status cannot slip past this table.
    const allStatuses = BattleRoundStatus.options;
    assert.equal(allStatuses.length, 9, "round status count changed -- revisit both predicates");
    for (const status of allStatuses) {
      assert.equal(isRunningBattleRoundStatus(status), expectedRunning.has(status), `running(${status})`);
      assert.equal(isOccupiedBattleRoundStatus(status), expectedOccupied.has(status), `occupied(${status})`);
    }
    for (const absent of [null, undefined, "", "running"]) {
      assert.equal(isRunningBattleRoundStatus(absent), false, `running(${String(absent)})`);
      assert.equal(isOccupiedBattleRoundStatus(absent), false, `occupied(${String(absent)})`);
    }
  });
});

/**
 * Structural guard against the copy growing back. Finds every bracketed literal
 * in non-test source that names both running statuses, then classifies each by
 * its exact membership -- because three genuinely different rules share those
 * two members and only one of them is this authority's business:
 *
 *   [red_running, blue_running]                        -> "is executing"  (this authority)
 *   [not_started, red_running, blue_running]           -> "spec battle owns the active stage"
 *   [not_started, red_running, blue_running, failed]   -> "round is claimable" (gate-panel/page)
 */
const RUNNING_SET_LITERAL = /\[[^\]]*"red_running"[^\]]*"blue_running"[^\]]*\]/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function scanLiteralSets(): Array<{ file: string; members: string[] }> {
  const found: Array<{ file: string; members: string[] }> = [];
  for (const root of ["server", "app", "components", "lib"]) {
    for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
      const src = readFileSync(file, "utf-8");
      for (const match of src.matchAll(RUNNING_SET_LITERAL)) {
        found.push({
          file: path.relative(REPO_ROOT, file),
          members: [...match[0].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
        });
      }
    }
  }
  return found;
}

describe("running-status literal inventory", () => {
  /**
   * Scanner effectiveness, asserted before any conclusion is drawn from it. A
   * regex that silently matches nothing would make every assertion below pass
   * against the empty set.
   */
  it("actually matches the shape it is looking for", () => {
    const control = 'const runningRoundStatuses = ["red_running", "blue_running"];';
    assert.match(control, /\[[^\]]*"red_running"[^\]]*"blue_running"[^\]]*\]/);
    const multiline = 'const x = [\n  "red_running",\n  "blue_running",\n];';
    assert.match(multiline, /\[[^\]]*"red_running"[^\]]*"blue_running"[^\]]*\]/);

    assert.ok(sourceFiles(path.join(REPO_ROOT, "server")).length > 100, "server tree barely scanned");
    assert.ok(
      sourceFiles(path.join(REPO_ROOT, "app")).length > 20,
      "app tree barely scanned",
    );
    assert.ok(scanLiteralSets().length >= 4, "scanner found suspiciously few literal sets");
  });

  it("keeps the three rules distinguishable and unduplicated", () => {
    const found = scanLiteralSets();

    // The "is executing" pair may only appear in the authority itself, plus one
    // documented holdout this task was not allowed to edit. When
    // recovery-executors.ts imports the authority, delete it from this list --
    // the assertion is meant to fail loudly at that point, not be loosened.
    const runningPairOwners = found
      .filter((hit) => hit.members.length === 2)
      .map((hit) => hit.file)
      .sort();
    // Was ["server/services/recovery-executors.ts", "server/types/enums.ts"].
    // Both entries moved for a reason, and neither is a loosening:
    //   - the authority itself relocated to battle-round-status.ts, a
    //     dependency-free module, so client components can import the predicate
    //     without dragging zod into their bundle. enums.ts now derives its zod
    //     enum from that list rather than restating it.
    //   - recovery-executors.ts was the documented holdout. It now imports the
    //     authority, which is exactly the moment this assertion was written to
    //     fail loudly at. The list shrinks; it does not relax.
    assert.deepEqual(runningPairOwners, ["server/types/battle-round-status.ts"]);

    // The claimable rule (page.tsx / gate-panel.tsx) is deliberately NOT merged
    // into the authority: it additionally admits "failed".
    const claimable = found.filter((hit) => hit.members.includes("failed") && hit.members.length === 4);
    assert.deepEqual(
      claimable.map((hit) => hit.file).sort(),
      [
        "app/projects/[id]/changes/[changeId]/gate-panel.tsx",
        "app/projects/[id]/changes/[changeId]/page.tsx",
      ],
    );
    for (const hit of claimable) {
      assert.deepEqual(hit.members, ["not_started", "red_running", "blue_running", "failed"]);
    }

    // No literal set anywhere may contain a member that is not a real status.
    for (const hit of found) {
      for (const member of hit.members) {
        assert.doesNotThrow(
          () => BattleRoundStatus.parse(member),
          `${hit.file} names "${member}", which is not a BattleRoundStatus`,
        );
      }
    }
  });
});
