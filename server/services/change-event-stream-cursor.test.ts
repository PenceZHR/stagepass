import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { advanceStreamCursor } from "./change-event-stream-cursor.ts";

/**
 * The SSE route used to track its position as a COUNT (`lastCount`) and slice
 * the re-read with it. Every case below is one way that arithmetic loses
 * events; they are written against the ids the route actually observes, not
 * against a tidy synthetic sequence, because the two properties that break the
 * count cursor -- ids are not monotonic, and rows get deleted -- are both real
 * (see 0025's migration note and change-rework-service.ts's rework delete).
 */
describe("advanceStreamCursor", () => {
  it("emits nothing when nothing changed", () => {
    const delivered = new Set(["EVT-1", "EVT-2"]);
    const result = advanceStreamCursor(["EVT-1", "EVT-2"], delivered);
    assert.deepEqual(result.newIds, []);
  });

  it("emits only ids never delivered before", () => {
    const result = advanceStreamCursor(["EVT-1", "EVT-2", "EVT-3"], new Set(["EVT-1", "EVT-2"]));
    assert.deepEqual(result.newIds, ["EVT-3"]);
  });

  it("preserves the order the query returned", () => {
    const result = advanceStreamCursor(["A", "B", "C"], new Set());
    assert.deepEqual(result.newIds, ["A", "B", "C"]);
  });

  // The count cursor's headline failure: rework deletes a run's events, the
  // total drops below lastCount, `all.length > lastCount` is false forever.
  it("keeps emitting after a deletion shrinks the table below the delivered count", () => {
    const delivered = advanceStreamCursor(["E1", "E2", "E3", "E4", "E5"], new Set()).nextDelivered;
    assert.equal(delivered.size, 5);

    // Rework deletes E2..E5, then one new event lands. Total (2) is far below
    // the 5 already delivered -- the count cursor goes permanently deaf here.
    const afterDelete = advanceStreamCursor(["E1", "NEW-1"], delivered);
    assert.deepEqual(afterDelete.newIds, ["NEW-1"]);
  });

  // The insidious half: the count cursor recovers once the total climbs back
  // past lastCount, but `slice(lastCount)` silently skips everything in between.
  it("emits every event produced while the table was smaller, skipping none", () => {
    let delivered = advanceStreamCursor(["E1", "E2", "E3", "E4", "E5"], new Set()).nextDelivered;
    delivered = advanceStreamCursor(["E1"], delivered).nextDelivered;

    const refilled = ["E1", "N1", "N2", "N3", "N4", "N5", "N6", "N7"];
    const result = advanceStreamCursor(refilled, delivered);
    assert.deepEqual(result.newIds, ["N1", "N2", "N3", "N4", "N5", "N6", "N7"]);
  });

  // The client appends without deduping and keys on evt.id
  // (event-stream-panel.tsx), so a re-delivered event is a duplicate React key,
  // not a harmless retry.
  it("never re-emits an id that was already delivered", () => {
    const first = advanceStreamCursor(["E1", "E2"], new Set());
    const second = advanceStreamCursor(["E1", "E2"], first.nextDelivered);
    const third = advanceStreamCursor(["E1", "E2", "E3"], second.nextDelivered);
    assert.deepEqual(second.newIds, []);
    assert.deepEqual(third.newIds, ["E3"]);
  });

  // ids carry no ordering: "EVT-1000" sorts before "EVT-975", and the pipeline
  // also mints "EVT-provider_process_started-PRP-..." alongside "EVT-704".
  // A cursor that compared ids would stall on either shape.
  it("handles ids that are not lexicographically ordered", () => {
    const delivered = advanceStreamCursor(["EVT-975", "EVT-1000"], new Set()).nextDelivered;
    const result = advanceStreamCursor(
      ["EVT-975", "EVT-1000", "EVT-provider_process_started-PRP-lease-abc", "EVT-704"],
      delivered,
    );
    assert.deepEqual(result.newIds, ["EVT-provider_process_started-PRP-lease-abc", "EVT-704"]);
  });

  // created_at ties are real (two rows share ...T23:29:07.291Z in the shipped
  // database), so a (created_at, id) comparison cursor could skip a row that
  // lands in an already-passed millisecond. Identity tracking cannot.
  it("emits a late arrival that shares a timestamp with an already delivered row", () => {
    const delivered = advanceStreamCursor(["SAME-MS-B"], new Set()).nextDelivered;
    const result = advanceStreamCursor(["SAME-MS-A", "SAME-MS-B"], delivered);
    assert.deepEqual(result.newIds, ["SAME-MS-A"]);
  });

  // Without this the set grows for the lifetime of the connection -- one stream
  // in the logs stayed open 96 minutes.
  it("drops deleted ids from the cursor so it cannot grow without bound", () => {
    const delivered = advanceStreamCursor(["E1", "E2", "E3"], new Set()).nextDelivered;
    const result = advanceStreamCursor(["E3"], delivered);
    assert.deepEqual([...result.nextDelivered].sort(), ["E3"]);
  });

  it("re-emits an id that was deleted and later re-created", () => {
    const delivered = advanceStreamCursor(["E1"], new Set()).nextDelivered;
    const afterDelete = advanceStreamCursor([], delivered);
    const afterRecreate = advanceStreamCursor(["E1"], afterDelete.nextDelivered);
    assert.deepEqual(afterRecreate.newIds, ["E1"]);
  });

  it("does not mutate the set it was given", () => {
    const delivered = new Set(["E1"]);
    advanceStreamCursor(["E1", "E2"], delivered);
    assert.deepEqual([...delivered], ["E1"]);
  });
});
