import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatSequencedId,
  maxSequencedNumber,
  nextSequencedId,
  parseSequencedId,
} from "./record-identity.ts";

// Copied verbatim out of the production database on 2026-07-22 via
//   sqlite3 'file:server/db/ship.db?mode=ro' "SELECT id FROM events ..."
// Its trailing digit run is the tail of a UUID, not a sequence number.
const PRODUCTION_PROCESS_EVENT_ID =
  "EVT-provider_process_ended-PRP-lease-PJOB-647fbb5b-6dd3-4b50-a598-1424f5c142fb-RUN-mruu64wj-09eb81e3-spec-attempt-1-lease-3b00a3d8-e516-4591-9fd6-d25758540648-spec-attempt-1-lease-3b00a3d8-e516-4591-9fd6-d25758540648-1-3b00a3d8-e516-4591-9fd6-d25758540648";

// Also verbatim from production. `randomBytes(8).toString("hex")` produced a
// suffix ending in seven digits.
const PRODUCTION_HEX_ARTIFACT_ID = "ART-mrut313g-70f24fb3f0768944";

describe("parseSequencedId reads sequence numbers, not trailing digits", () => {
  it("accepts a real sequenced id", () => {
    assert.equal(parseSequencedId("EVT-975", "EVT"), 975);
    assert.equal(parseSequencedId("CHG-001", "CHG"), 1);
    assert.equal(parseSequencedId("ART-074", "ART"), 74);
  });

  it("rejects the production process-event id whose UUID tail is 11 digits", () => {
    // The defect: `/\d+$/` returns 25758540648 here, and max+1 over it mints
    // `EVT-25758540649` -- which then satisfies the anchored `^EVT-(\d+)$` that
    // every other EVT minter reads, moving the whole sequence to 25.7 billion.
    assert.equal(parseSequencedId(PRODUCTION_PROCESS_EVENT_ID, "EVT"), null);
  });

  it("rejects the production hex artifact id", () => {
    assert.equal(parseSequencedId(PRODUCTION_HEX_ARTIFACT_ID, "ART"), null);
  });

  it("rejects an id belonging to a different prefix", () => {
    assert.equal(parseSequencedId("ART-001", "EVT"), null);
    // "EVT" must not match "EVTX-001" by prefix-string luck.
    assert.equal(parseSequencedId("EVTX-001", "EVT"), null);
  });

  it("rejects a sequence number past 2^53", () => {
    // A 16-digit run is reachable: `randomBytes(8).toString("hex")` is sixteen
    // contiguous hex characters with no separator to break the run. Past 2^53
    // `n + 1 === n`, so a max+1 minter that trusted such a value would return
    // the same id forever -- a hard primary-key collision, not a cosmetic one.
    assert.equal(Number.isSafeInteger(Number("9999999999999999")), false);
    assert.equal(parseSequencedId("ART-9999999999999999", "ART"), null);
  });

  it("still accepts the largest safe sequence number", () => {
    assert.equal(
      parseSequencedId(`ART-${Number.MAX_SAFE_INTEGER}`, "ART"),
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("nextSequencedId is immune to the ids that poisoned the ledger", () => {
  it("ignores the production process-event id when minting the next EVT", () => {
    const ledger = ["EVT-001", "EVT-002", "EVT-975", PRODUCTION_PROCESS_EVENT_ID];
    assert.equal(nextSequencedId(ledger, "EVT"), "EVT-976");
  });

  it("ignores hex artifact ids when minting the next ART", () => {
    const ledger = ["ART-074", PRODUCTION_HEX_ARTIFACT_ID, "ART-mru1j576-c7b7baad4d24f004"];
    assert.equal(nextSequencedId(ledger, "ART"), "ART-075");
  });

  it("does not freeze on an unsafe-integer id already in the table", () => {
    // The fixed-point failure, pinned: a minter that trusted this value would
    // return the same id on every call.
    const poisoned = "ART-9999999999999999";
    const first = nextSequencedId(["ART-074", poisoned], "ART");
    const second = nextSequencedId(["ART-074", poisoned, first], "ART");
    assert.equal(first, "ART-075");
    assert.notEqual(first, second);
    assert.equal(second, "ART-076");
  });

  it("mints the first id for an empty table", () => {
    assert.equal(nextSequencedId([], "CHG"), "CHG-001");
  });

  it("steps past an id that is in the sequence but above the maximum", () => {
    // maxSequencedNumber and the collision walk must agree; this is the case
    // that separates them.
    assert.equal(nextSequencedId(["EVT-001", "EVT-002"], "EVT"), "EVT-003");
  });

  it("pads to three digits and stops padding beyond that", () => {
    assert.equal(formatSequencedId("EVT", 7), "EVT-007");
    assert.equal(formatSequencedId("EVT", 1234), "EVT-1234");
  });
});

describe("sequenced id allocation never reuses a freed number", () => {
  // The git-branch takeover in change-service turned on this exact property.
  // With CHG-002 gone, the lowest-free-gap allocator returned "CHG-002" again;
  // monotonic allocation must not.
  it("skips a gap left by a deleted row", () => {
    assert.equal(nextSequencedId(["CHG-001", "CHG-003"], "CHG"), "CHG-004");
  });

  it("keeps advancing as rows are deleted and re-created", () => {
    let ledger = ["CHG-001", "CHG-002", "CHG-003"];
    const first = nextSequencedId(ledger, "CHG");
    assert.equal(first, "CHG-004");

    ledger = ["CHG-001", "CHG-003", first]; // CHG-002 deleted
    const second = nextSequencedId(ledger, "CHG");
    assert.equal(second, "CHG-005");
    assert.notEqual(second, "CHG-002");
  });

  it("maxSequencedNumber is 0 for a table holding only unsequenced ids", () => {
    assert.equal(maxSequencedNumber([PRODUCTION_HEX_ARTIFACT_ID], "ART"), 0);
  });
});
