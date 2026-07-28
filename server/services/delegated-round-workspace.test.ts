import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearRoundOutputs,
  materialiseRoleBriefs,
  readRoundOutput,
  roleBriefPath,
  roundOutputPath,
  roundWritableGlobs,
  writtenDuringOwnTurn,
} from "./delegated-round-workspace.ts";

const CHANGE_ID = "CHG-W";
let repoPath = "";

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "round-ws-"));
});
afterEach(() => {
  if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  repoPath = "";
});

function writeOutput(role: "red" | "blue" | "verdict", text: string, roundNo = 1): string {
  const relative = roundOutputPath(CHANGE_ID, "Spec", roundNo, role);
  const absolute = path.join(repoPath, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
  return absolute;
}

describe("delegated round workspace", () => {
  it("keeps every side's output in its own round directory", () => {
    assert.equal(
      roundOutputPath(CHANGE_ID, "Spec", 1, "red"),
      path.join(".ship", "changes", CHANGE_ID, "rounds", "spec", "round-01", "red.json"),
    );
    // Round 2 must not be settleable from round 1's leftovers.
    assert.notEqual(
      roundOutputPath(CHANGE_ID, "Spec", 2, "red"),
      roundOutputPath(CHANGE_ID, "Spec", 1, "red"),
    );
  });

  /**
   * A round that could rewrite its own brief could rewrite its own schema, so
   * the writable glob covers outputs only. These stages were read-only before
   * they produced files, which makes this glob -- not the sandbox -- the thing
   * that keeps a design stage away from the rest of the change.
   */
  it("lets a round write its outputs and nothing else", () => {
    const globs = roundWritableGlobs(CHANGE_ID, "Spec");

    assert.deepEqual(globs, [
      path.join(".ship", "changes", CHANGE_ID, "rounds", "spec", "round-*", "*.json"),
    ]);
    for (const forbidden of [
      roleBriefPath(CHANGE_ID, "Spec", "judge"),
      path.join(".ship", "changes", CHANGE_ID, "prd-delta.md"),
      path.join("server", "services", "anything.ts"),
    ]) {
      assert.equal(
        globs.some((glob) => new RegExp(`^${glob.replace(/\*/g, "[^/]*")}$`).test(forbidden)),
        false,
        forbidden,
      );
    }
  });

  it("rewrites the role briefs every round so a template edit takes effect", () => {
    materialiseRoleBriefs({
      repoPath, changeId: CHANGE_ID, phase: "Spec",
      briefs: { judge: "judge v1", red: "red v1", blue: "blue v1" },
    });
    const written = materialiseRoleBriefs({
      repoPath, changeId: CHANGE_ID, phase: "Spec",
      briefs: { judge: "judge v2", red: "red v2", blue: "blue v2" },
    });

    assert.equal(fs.readFileSync(path.join(repoPath, written.judge), "utf-8"), "judge v2");
    assert.equal(fs.readFileSync(path.join(repoPath, written.red), "utf-8"), "red v2");
  });

  /**
   * A retry that fails before red writes again must not be settled from the
   * previous attempt's file -- a document no side produced this round, whose
   * write time matches no thread now in play.
   */
  it("clears a round's outputs so a retry cannot settle on the last attempt's file", () => {
    writeOutput("red", "{\"stale\":true}");
    assert.equal(readRoundOutput({ repoPath, changeId: CHANGE_ID, phase: "Spec", roundNo: 1, role: "red" }).ok, true);

    clearRoundOutputs({ repoPath, changeId: CHANGE_ID, phase: "Spec", roundNo: 1 });

    const after = readRoundOutput({ repoPath, changeId: CHANGE_ID, phase: "Spec", roundNo: 1, role: "red" });
    assert.equal(after.ok, false);
    assert.equal(after.ok ? null : after.code, "missing");
  });

  it("reports a missing output as missing rather than as empty", () => {
    const read = readRoundOutput({ repoPath, changeId: CHANGE_ID, phase: "Spec", roundNo: 1, role: "blue" });

    assert.equal(read.ok, false);
    assert.equal(read.ok ? null : read.code, "missing");
  });

  it("returns the write time alongside the text", () => {
    writeOutput("red", "{\"markdown\":\"x\"}");

    const read = readRoundOutput({ repoPath, changeId: CHANGE_ID, phase: "Spec", roundNo: 1, role: "red" });

    assert.equal(read.ok, true);
    assert.equal(read.ok ? read.text : "", "{\"markdown\":\"x\"}");
    assert.ok(read.ok && read.writtenAtMs > 0);
  });

  /**
   * Files cannot say who wrote them, so the write time is checked against the
   * side's OWN thread window -- timings the judge does not control. A judge
   * writing red's file for it writes outside red's turn.
   */
  describe("provenance window", () => {
    it("accepts a file written during its author's turn", () => {
      assert.equal(
        writtenDuringOwnTurn({ writtenAtMs: 1_500, startedAtMs: 1_000, completedAtMs: 2_000 }),
        true,
      );
    });

    it("rejects a file written before its author started or after it finished", () => {
      assert.equal(
        writtenDuringOwnTurn({ writtenAtMs: 500, startedAtMs: 100_000, completedAtMs: 200_000 }),
        false,
        "written long before the side ran",
      );
      assert.equal(
        writtenDuringOwnTurn({ writtenAtMs: 500_000, startedAtMs: 100_000, completedAtMs: 200_000 }),
        false,
        "written long after the side finished",
      );
    });

    it("tolerates clock skew of seconds, not of minutes", () => {
      assert.equal(
        writtenDuringOwnTurn({ writtenAtMs: 95_000, startedAtMs: 100_000, completedAtMs: 200_000 }),
        true,
        "5s early is skew",
      );
      assert.equal(
        writtenDuringOwnTurn({ writtenAtMs: 40_000, startedAtMs: 100_000, completedAtMs: 200_000 }),
        false,
        "a minute early is a different turn",
      );
    });
  });
});
