import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ACTION_DEFINITIONS } from "./action-contract-registry-service";
import {
  assertProviderApplicable,
  isProviderBackedAction,
  parseRequestedProvider,
  resolveProviderSelection,
} from "./provider-selection-service";
import { readActionPayload } from "../../app/api/projects/[id]/changes/[changeId]/action-preflight";

describe("provider selection policy", () => {
  it("classifies every provider-backed action from the shared action registry", () => {
    const providerActions = ACTION_DEFINITIONS
      .filter((definition) => definition.requiresProvider)
      .map((definition) => definition.actionId);

    assert.deepEqual(providerActions, [
      "run_prd",
      "retry_prd",
      "run_prd_briefing_questions",
      "run_prd_briefing_draft",
      "run_prd_briefing_final_review",
      "run_spec",
      "retry_spec",
      "run_tech_spec",
      "retry_tech_spec",
      "run_plan",
      "retry_plan",
      "run_test_plan",
      "retry_test_plan",
      "run_build",
      "retry_build",
      "run_review",
      "retry_review",
      "fix_blockers",
      "merge",
      "run_retro",
      // The Done stage calls a provider: the delivery note has to read the
      // repository to answer 「怎么跑起来」, so it cannot be assembled from
      // existing artifacts (design §3.1).
      "run_delivery",
    ]);
    assert.equal(isProviderBackedAction("run_qa"), false);
    assert.equal(isProviderBackedAction("approve_plan"), false);
  });

  it("parses only codex and claude and preserves omitted provider", () => {
    assert.equal(parseRequestedProvider(undefined), undefined);
    assert.equal(parseRequestedProvider("codex"), "codex");
    assert.equal(parseRequestedProvider("claude"), "claude");
    assert.throws(
      () => parseRequestedProvider("openai"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_provider",
    );
  });

  it("falls back to the change provider only when the request omits one", () => {
    assert.equal(resolveProviderSelection(undefined, "claude"), "claude");
    assert.equal(resolveProviderSelection("codex", "claude"), "codex");
  });

  it("rejects a provider on local or human actions", () => {
    assert.throws(
      () => assertProviderApplicable("run_qa", "claude"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "provider_not_applicable",
    );
    assert.doesNotThrow(() => assertProviderApplicable("run_qa", undefined));
    assert.doesNotThrow(() => assertProviderApplicable("run_spec", "claude"));
  });

  it("rejects an invalid provider at the shared action preflight boundary", async () => {
    await assert.rejects(
      () => readActionPayload(new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ provider: "openai" }),
      })),
      (error: unknown) => error instanceof Error && "reasonCode" in error && error.reasonCode === "invalid_provider",
    );
  });
});
