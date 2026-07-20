import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NARRATION_ONLY_CHANGE_EVENT_TYPES,
  parseChangeStreamEventType,
  shouldRefreshOnChangeEvent,
} from "./change-event-refresh-policy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const refreshHookSource = readFileSync(
  resolve(__dirname, "use-change-event-refresh.ts"),
  "utf-8"
);
const changeDetailDataHookSource = readFileSync(
  resolve(__dirname, "use-change-detail-data.ts"),
  "utf-8"
);

function frame(payload: unknown): string {
  return JSON.stringify(payload);
}

describe("change event refresh policy", () => {
  it("refreshes on the events that hand a decision back to the human", () => {
    // Observed on a real end-to-end run: dispatch flips the status ~110ms after
    // the POST returns, and the build finishing emits these before the gate
    // enables adopt_build. Each one must re-read server state.
    for (const type of [
      "change_status_changed",
      "pipeline_job_queued",
      "provider_process_started",
      "provider_process_leased",
      "provider_process_ended",
      "provider_process_failed",
      "stage_progress",
      "spec_run_claim",
      "prd_briefing_locked",
      "finding_waived",
      "fix.completed.success",
      "business_run_reconciled",
    ]) {
      assert.equal(
        shouldRefreshOnChangeEvent(type),
        true,
        `${type} should refresh change detail state`
      );
    }
  });

  it("does not refresh on provider narration", () => {
    for (const type of [
      "ai_message",
      "ai_reasoning",
      "codex_output",
      "stage_raw_output",
      "prd_assistant",
      "prd_user",
    ]) {
      assert.equal(
        NARRATION_ONLY_CHANGE_EVENT_TYPES.has(type),
        true,
        `${type} should be classified as narration`
      );
      assert.equal(
        shouldRefreshOnChangeEvent(type),
        false,
        `${type} should not refresh change detail state`
      );
    }
  });

  it("treats unknown event types as refresh-worthy so new server events cannot freeze the panel", () => {
    // A denylist is the point: an allowlist would silently stop refreshing the
    // first time the server grows a new state-affecting event type, which is
    // exactly the freeze this policy exists to prevent.
    assert.equal(shouldRefreshOnChangeEvent("some_future_gate_event"), true);
    assert.equal(shouldRefreshOnChangeEvent(""), true);
  });

  it("reads the type off a stream frame without throwing", () => {
    assert.equal(
      parseChangeStreamEventType(frame({ id: "E-1", type: "change_status_changed" })),
      "change_status_changed"
    );
    assert.equal(parseChangeStreamEventType(frame({ id: "E-1" })), "");
    assert.equal(parseChangeStreamEventType(frame(["not-an-object"])), "");
    assert.equal(parseChangeStreamEventType(frame(null)), null);
    assert.equal(parseChangeStreamEventType("not json at all"), null);
    assert.equal(parseChangeStreamEventType(undefined), null);
    assert.equal(parseChangeStreamEventType(42), null);
  });

  it("refreshes on a malformed-but-parseable frame and ignores an unparseable one", () => {
    assert.equal(
      shouldRefreshOnChangeEvent(parseChangeStreamEventType(frame({ id: "E-1" }))),
      true
    );
    assert.equal(
      shouldRefreshOnChangeEvent(parseChangeStreamEventType("<html>oops</html>")),
      false
    );
  });

  it("routes a full stream frame end to end", () => {
    const statusFrame = frame({
      id: "E-9",
      type: "change_status_changed",
      message: "Status → IMPLEMENTING",
      rawJson: null,
      createdAt: "2026-07-18T14:07:01.360Z",
    });
    const chatterFrame = frame({
      id: "E-10",
      type: "ai_message",
      message: "still working",
      rawJson: null,
      createdAt: "2026-07-18T14:08:04.888Z",
    });

    assert.equal(
      shouldRefreshOnChangeEvent(parseChangeStreamEventType(statusFrame)),
      true
    );
    assert.equal(
      shouldRefreshOnChangeEvent(parseChangeStreamEventType(chatterFrame)),
      false
    );
  });
});

describe("change event refresh wiring", () => {
  it("subscribes to the existing event stream endpoint", () => {
    assert.match(refreshHookSource, /new EventSource\(/);
    assert.match(refreshHookSource, /events\/stream/);
    assert.match(refreshHookSource, /source\.close\(\)/);
  });

  it("debounces so the replay burst on connect collapses into one refresh", () => {
    assert.match(refreshHookSource, /CHANGE_EVENT_REFRESH_DEBOUNCE_MS/);
    assert.match(refreshHookSource, /clearTimeout\(timer\)/);
  });

  it("keeps the refresh callback in a ref so a new identity does not reopen the stream", () => {
    assert.match(refreshHookSource, /onRefreshRef/);
    // Reconnecting on every callback identity change would replay the whole
    // event history, so the stream effect must depend only on the ids.
    assert.match(refreshHookSource, /\}, \[projectId, changeId\]\);/);
    assert.doesNotMatch(refreshHookSource, /\}, \[projectId, changeId, onRefresh\]\);/);
  });

  it("wires the stream into the hook that owns change and gate state", () => {
    assert.match(changeDetailDataHookSource, /useChangeEventRefresh\(\{/);
    assert.match(changeDetailDataHookSource, /onRefresh: refreshChangeDetailPage/);
  });

  it("refreshes from the server instead of inferring gate state on the client", () => {
    // The stream may only trigger a re-read. Enablement stays the server's call.
    assert.doesNotMatch(refreshHookSource, /setGateStatus|enabled\s*[:=]/);
  });
});
