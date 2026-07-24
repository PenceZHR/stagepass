import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { viewFor } from "./codex-task-control";
import { shouldShowEmergency } from "./emergency-interaction-panel";

const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(directory, "codex-task-control.tsx"), "utf8");

describe("Codex task control", () => {
  it("shows open, interrupt, retry, evidence, and health but no approval button", () => {
    assert.match(source, /Open in Codex/);
    assert.match(source, /Retry|重试/);
    assert.match(source, /Interrupt current turn|中断当前执行/);
    assert.match(source, /Evidence/);
    assert.match(source, /Desktop:/);
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
});
