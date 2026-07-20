"use client";

import { useEffect, useRef } from "react";

import {
  parseChangeStreamEventType,
  shouldRefreshOnChangeEvent,
} from "./change-event-refresh-policy";

/**
 * Coalesces a burst of events into one refresh. The server replays every stored
 * event on connect, so without this a busy change would fire one refresh per
 * historical event on mount.
 */
export const CHANGE_EVENT_REFRESH_DEBOUNCE_MS = 250;

/**
 * Subscribes to the change event stream and re-reads server state whenever the
 * server reports something that could move the gate.
 *
 * This complements `shouldPollChangeDetailParent` rather than replacing it: the
 * interval keeps covering long-running work, while the stream covers the two
 * edges the interval structurally cannot see (dispatch not yet visible in the
 * DB, and a finished stage settling on a status that deliberately stops
 * polling). See change-event-refresh-policy.ts for the full reasoning.
 */
export function useChangeEventRefresh(input: {
  projectId: string;
  changeId: string;
  onRefresh: () => void | Promise<void>;
}): void {
  const { projectId, changeId, onRefresh } = input;

  // Hold the callback in a ref so that a new callback identity re-points the
  // handler instead of tearing down the EventSource -- reconnecting would
  // replay the whole event history and restart the debounce for nothing.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (disposed) return;
        void onRefreshRef.current();
      }, CHANGE_EVENT_REFRESH_DEBOUNCE_MS);
    };

    const source = new EventSource(
      `/api/projects/${projectId}/changes/${changeId}/events/stream`
    );
    source.onmessage = (event: MessageEvent) => {
      if (shouldRefreshOnChangeEvent(parseChangeStreamEventType(event.data))) {
        scheduleRefresh();
      }
    };
    // EventSource reconnects on its own; a dropped connection replays history
    // on reconnect, which lands a refresh and re-syncs whatever was missed.

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [projectId, changeId]);
}
