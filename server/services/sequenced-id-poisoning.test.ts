import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { runMigrations } from "../db/migrate.ts";
import * as dbSchema from "../db/schema.ts";
import { events } from "../db/schema.ts";
import {
  nextRunLedgerId,
  type RunLedgerDb,
} from "../repositories/run-ledger-repository.ts";

/**
 * These tests pin *symptoms* of a poisoned id ledger, not the shape of any one
 * minter. Every assertion below is phrased as something a user of the product
 * would notice -- "the next id is not astronomical", "the same id is never
 * minted twice", "allocation terminates" -- so that changing how allocation is
 * implemented cannot make them vacuous.
 *
 * All three symptoms were reproduced against the real `nextRunLedgerId` before
 * the fix; see the comments on each test for the observed pre-fix behavior.
 */

function createLedgerDb(): RunLedgerDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  runMigrations(sqlite);
  return drizzle(sqlite, { schema: dbSchema }) as unknown as RunLedgerDb;
}

function seedEvent(database: RunLedgerDb, id: string): void {
  database
    .insert(events)
    .values({ id, type: "test", createdAt: "2026-07-22T00:00:00.000Z" })
    .run();
}

// Verbatim from the production database on 2026-07-22. Its trailing digit run
// is the tail of a UUID (25758540648), not a sequence number.
const PRODUCTION_PROCESS_EVENT_ID =
  "EVT-provider_process_ended-PRP-lease-PJOB-647fbb5b-6dd3-4b50-a598-1424f5c142fb-RUN-mruu64wj-09eb81e3-spec-attempt-1-lease-3b00a3d8-e516-4591-9fd6-d25758540648";

describe("a poisoned ledger row cannot capture the id sequence", () => {
  it("an id past 2^53 does not freeze allocation or repeat itself", () => {
    // Pre-fix, reproduced: the first call returned `EVT-9007199254740992`
    // (parseInt saturated), and after the caller inserted it the second call
    // spun at 99.4% CPU forever, because `nextNum += 1` is a no-op past 2^53
    // so the candidate never changed and `while (used.has(candidate))` never
    // exited. Both halves of that are asserted here.
    const database = createLedgerDb();
    seedEvent(database, "EVT-001");
    seedEvent(database, "EVT-9007199254740993");

    const first = nextRunLedgerId("EVT", database);
    seedEvent(database, first);
    const second = nextRunLedgerId("EVT", database);
    seedEvent(database, second);
    const third = nextRunLedgerId("EVT", database);

    // Symptom 1: allocation terminates at all. (Pre-fix this line was never
    // reached -- the run had to be killed.)
    // Symptom 2: no id is ever handed out twice. `events.id` is the primary
    // key, so a repeat is a hard insert failure in production.
    assert.equal(new Set([first, second, third]).size, 3);

    // Symptom 3: the sequence is not dragged up to the poisoned magnitude.
    for (const id of [first, second, third]) {
      const sequence = Number(id.slice("EVT-".length));
      assert.ok(
        Number.isSafeInteger(sequence) && sequence < 1_000_000,
        `${id} left the human-scale sequence`,
      );
    }
  });

  it("a descriptive id whose UUID tail is 11 digits does not move the sequence", () => {
    // This is the original defect, end to end: the tail-reading minters turned
    // this row into `EVT-25758540649`, which the anchored minters then believed.
    const database = createLedgerDb();
    seedEvent(database, "EVT-001");
    seedEvent(database, "EVT-975");
    seedEvent(database, PRODUCTION_PROCESS_EVENT_ID);

    assert.equal(nextRunLedgerId("EVT", database), "EVT-976");
  });

  it("a new id always outranks every id already in the ledger", () => {
    // Monotonic allocation is load-bearing, not cosmetic: change ids name git
    // branches, and deleting a change deliberately leaves its branch behind, so
    // reissuing a sequence number below the high-water mark hands a fresh record
    // the old record's branch and commits.
    //
    // The gap between 999 and 1005 is what makes this discriminating. With no
    // gap the trailing collision walk hides an over-tight membership rule (it
    // simply steps over the ids it failed to recognize); with a gap, a rule that
    // stops counting past three digits reports max=999 and hands back EVT-1000,
    // which is below the EVT-1005 already on disk.
    const database = createLedgerDb();
    seedEvent(database, "EVT-999");
    seedEvent(database, "EVT-1005");

    const next = nextRunLedgerId("EVT", database);
    assert.equal(next, "EVT-1006");
  });

  it("a hex artifact id is not read as a sequence number", () => {
    const database = createLedgerDb();
    seedEvent(database, "EVT-074");
    seedEvent(database, "EVT-mrut313g-70f24fb3f0768944");

    assert.equal(nextRunLedgerId("EVT", database), "EVT-075");
  });
});

/**
 * The structural half: the walk above must exist in exactly one place, so that
 * a future edit to the authority cannot be silently bypassed by a surviving
 * private copy.
 */
describe("the sequence walk is not reimplemented outside the authority", () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
  const AUTHORITY = path.join("server", "services", "record-identity.ts");

  // A local max+1 walk is recognizable by its anchored per-prefix id regex.
  // Both spellings the codebase used are covered: the interpolated
  // `new RegExp(\`^${prefix}-(\\d+)$\`)` and the literal `/^EVT-(\d+)$/`.
  const LOCAL_WALK = /\^\$\{prefix\}-\(\\\\d\+\)\$|\/\^[A-Z]+-\\\(?\\d\+\\?\)?\$\/|\/\^[A-Z]+-\(\\d\+\)\$\//;

  function sourceFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
      }
    };
    for (const top of ["server", "app"]) walk(path.join(REPO_ROOT, top));
    return found;
  }

  it("the scanner is wired up and can actually see a violation", () => {
    // Guard against the whole suite silently passing on an empty corpus or a
    // regex that no longer matches anything. Without this, a rename or a broken
    // glob turns the assertion below into a claim about zero files.
    const files = sourceFiles();
    assert.ok(files.length > 200, `scanned only ${files.length} source files`);

    // Positive control: the exact body that was removed from thirteen callers
    // must still be recognized as a violation.
    const removedBody = [
      "const match = id.match(new RegExp(`^${prefix}-(\\\\d+)$`));",
      "const match = id.match(/^EVT-(\\d+)$/);",
      "const match = runId.match(/^RUN-(\\d+)$/);",
    ];
    for (const sample of removedBody) {
      assert.ok(LOCAL_WALK.test(sample), `scanner blind to: ${sample}`);
    }

    // Negative control: ordinary code must not trip it.
    assert.equal(LOCAL_WALK.test('const x = id.match(/\\d+$/);'), false);
  });

  it("no production source outside record-identity.ts carries its own walk", () => {
    const offenders = sourceFiles()
      .filter((file) => LOCAL_WALK.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file))
      .filter((file) => file !== AUTHORITY);

    assert.deepEqual(offenders, []);
  });
});
