/**
 * Position tracking for the change event SSE stream.
 *
 * The stream used to remember how many events it had sent and slice the next
 * re-read with that number. Two properties of the events table make that
 * arithmetic lose data rather than merely misorder it:
 *
 *  - Rows are deleted. `change-rework-service` drops every event belonging to
 *    the runs a rework unwinds, so the total can fall below the number already
 *    sent. `all.length > lastCount` is then false forever: the stream goes
 *    silent with no error and no log, and once new events push the total back
 *    past the old count, `slice(lastCount)` skips everything produced in
 *    between. Measured on a copy of the shipped database: deleting one run's
 *    events cost a live connection 78 events, permanently.
 *
 *  - Neither column is a usable cursor on its own. `id` is not ordered
 *    ("EVT-1000" sorts before "EVT-975", and the pipeline also mints
 *    "EVT-provider_process_started-PRP-..." shapes), and `created_at` both ties
 *    (two rows share ...T23:29:07.291Z in the shipped database) and is stamped
 *    before the transaction that inserts the row, so it is not commit-ordered.
 *    A `WHERE (created_at, id) > (:c, :i)` cursor silently drops any row that
 *    commits into an already-passed millisecond.
 *
 * So the cursor tracks identity, not position: the set of ids already sent.
 * Correct under deletion, re-ordering, timestamp ties and late commits, because
 * none of those change what an id is. The caller reads ids only -- covered by
 * `idx_events_change_created_id`, so the poll is an index-only scan of one
 * change's rows instead of the full-table read of every column (`raw_json`
 * included) it replaced.
 *
 * The returned set is rebuilt from the rows that currently exist, which is what
 * keeps it bounded: a deleted id drops out instead of accumulating for the life
 * of the connection.
 */
export interface StreamCursorAdvance {
  /** Ids not yet sent, in the order the query returned them. */
  newIds: string[];
  /** Cursor for the next poll. Contains exactly the ids that exist now. */
  nextDelivered: Set<string>;
}

export function advanceStreamCursor(
  currentIdsInOrder: readonly string[],
  delivered: ReadonlySet<string>,
): StreamCursorAdvance {
  const newIds: string[] = [];
  const nextDelivered = new Set<string>();

  for (const id of currentIdsInOrder) {
    // Guard against a duplicate inside one result set: without it the same row
    // would be enqueued twice, and the client keys on evt.id.
    if (!nextDelivered.has(id)) {
      if (!delivered.has(id)) newIds.push(id);
      nextDelivered.add(id);
    }
  }

  return { newIds, nextDelivered };
}
