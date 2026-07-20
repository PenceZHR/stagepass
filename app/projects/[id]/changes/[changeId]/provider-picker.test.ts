import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPipelinePreflightPayload, type PipelineActionContract } from "./pipeline-action-contract";

const providerAction: PipelineActionContract = {
  actionId: "run_plan",
  phase: "Plan",
  label: "生成计划",
  enabled: true,
  reasonCode: null,
  reason: null,
  blockers: [],
  warnings: [],
  gateVersion: "1",
  sourceDbHash: "hash",
  requiresIdempotencyKey: true,
  requiresProvider: true,
  providerSelectable: true,
  defaultProvider: "codex",
};

const localAction: PipelineActionContract = {
  ...providerAction,
  actionId: "run_qa",
  phase: "QA",
  requiresProvider: false,
  providerSelectable: false,
};

describe("per-action provider selection", () => {
  it("includes the selected provider only for provider-backed actions", () => {
    assert.equal(
      createPipelinePreflightPayload(providerAction, { provider: "claude" }).provider,
      "claude",
    );
    assert.equal(
      createPipelinePreflightPayload(localAction, { provider: "claude" }).provider,
      undefined,
    );
  });
});
