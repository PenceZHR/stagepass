/**
 * Decides which change-stream events must wake the change detail page up.
 *
 * Why this exists: the parent page's refresh loop is gated by
 * `shouldPollChangeDetailParent`, which can only recognise work it already sees
 * in flight -- a `running` run row, or a change status in
 * PARENT_POLLING_CHANGE_STATUSES. Both edges of a stage fall outside that:
 *
 *   - Entry. Dispatching a stage only enqueues a job; the worker inserts the
 *     `running` run row and flips `changes.status` a beat later (measured at
 *     ~110ms for run_build). The one refresh fired right after the POST lands
 *     inside that window, sees the pre-dispatch state, concludes nothing is
 *     running and never starts the interval -- so the panel stays frozen on the
 *     pre-dispatch view for the entire stage.
 *   - Exit. When a stage ends, the run goes terminal and the status settles on a
 *     value that deliberately does not poll (IMPLEMENTING awaiting absorb,
 *     TESTPLAN_DONE). That is precisely the moment a human is supposed to press
 *     a button, and it is the moment the page stops re-reading.
 *
 * The event stream is the server announcing that it wrote something, so it is
 * the right authority on when to re-read. Waking on an event only triggers a
 * refetch: button enablement still comes from the server's gate/action
 * contract, never from the client inferring what the pipeline "must" be doing.
 *
 * The filter is a DENYLIST on purpose. Only pure narration -- provider chatter
 * that the event log already renders and that never moves the gate -- is
 * filtered out; anything else refreshes. An allowlist would silently
 * re-introduce this freeze the first time the server grows a new
 * state-affecting event type.
 */
export const NARRATION_ONLY_CHANGE_EVENT_TYPES = new Set([
  "ai_message",
  "ai_reasoning",
  "codex_output",
  "stage_raw_output",
  "prd_assistant",
  "prd_user",
]);

/**
 * Pulls the `type` off a raw SSE `data:` payload without throwing.
 *
 * Returns null only when the frame is not JSON at all. A frame that parses but
 * carries no usable type still yields a refresh (see below) -- losing an update
 * is the failure mode that strands the human, an extra GET is not.
 */
export function parseChangeStreamEventType(data: unknown): string | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return null;
    const type = (parsed as { type?: unknown }).type;
    return typeof type === "string" ? type : "";
  } catch {
    return null;
  }
}

/**
 * True when an event should trigger a re-read of change/gate state.
 *
 * Unrecognised and malformed-but-parseable types refresh: the cost of being
 * wrong in that direction is one extra GET, while the cost of the other
 * direction is the panel silently freezing on a stale view.
 */
export function shouldRefreshOnChangeEvent(type: string | null): boolean {
  if (type === null) return false;
  return !NARRATION_ONLY_CHANGE_EVENT_TYPES.has(type);
}
