import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CodexTaskControl, viewFor } from "./codex-task-control";
import { shouldShowEmergency } from "./emergency-interaction-panel";

const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(directory, "codex-task-control.tsx"), "utf8");
const control = {
  bindingTitle: "Spec task",
  bindingStatus: "running",
  threadId: "thread-1",
  lastTurnId: "turn-7",
  lastObservationCursor: 4,
  lastSeenAt: "2026-07-24T00:00:00.000Z",
  lastErrorCode: null,
  currentInteractionId: null,
  codexDecisionEnabled: true,
  model: "gpt-5.4",
  reasoningEffort: "high",
};
const noop = async () => {};

function renderControl(readOnly: boolean) {
  return renderToStaticMarkup(
    createElement(CodexTaskControl, {
      control,
      health: { status: "ready" },
      readOnly,
      onOpen: noop,
      onInterrupt: noop,
      onStart: noop,
      onRetry: noop,
      onRepair: noop,
      onSaveSettings: noop,
    }),
  );
}

describe("Codex task control", () => {
  it("shows open, interrupt, retry, evidence, and health but no approval button", () => {
    assert.match(source, /Open in Codex/);
    assert.match(source, /Retry|重试/);
    assert.match(source, /Interrupt current turn|中断当前执行/);
    assert.match(source, /Evidence/);
    assert.match(source, /Desktop /);
    assert.doesNotMatch(source, /stop_change/);
    assert.doesNotMatch(source, /onApprove|批准 Merge|批准收编/);
  });

  it("shows emergency decisions only for an unhealthy bridge", () => {
    assert.equal(shouldShowEmergency({ status: "ready" }, true), false);
    assert.equal(shouldShowEmergency({ status: "unavailable" }, true), true);
    assert.equal(shouldShowEmergency({ status: "unavailable" }, false), false);
  });

  it("uses the Server rollout projection per phase", () => {
    assert.equal(viewFor({ phase: "PRD", codexDecisionEnabled: true }).isReadOnly, true);
    assert.equal(viewFor({ phase: "Spec", codexDecisionEnabled: false }).showsLegacyDecision, true);
  });

  it("keeps read-only diagnostics visible without mounting write controls", () => {
    const readOnlyMarkup = renderControl(true);
    assert.match(readOnlyMarkup, /turn-7/);
    assert.match(readOnlyMarkup, /gpt-5\.4/);
    assert.match(readOnlyMarkup, /high/);
    assert.doesNotMatch(readOnlyMarkup, /<input/);
    assert.doesNotMatch(readOnlyMarkup, /Save settings/);
    assert.doesNotMatch(readOnlyMarkup, /Repair binding/);

    const writableMarkup = renderControl(false);
    assert.match(writableMarkup, /<input/);
    assert.match(writableMarkup, /Save settings/);
    assert.match(writableMarkup, /Repair binding/);
  });
});
