import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PipelineActionContract } from "./pipeline-action-contract";
import {
  isGateVersionDriftRejection,
  pipelineActionRejectionMessage,
  pipelineActionResultEffect,
  refreshedContractFromRejection,
  runPipelineAction,
  type PipelineActionPostResult,
} from "./pipeline-action-runner";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookSource = readFileSync(resolve(__dirname, "use-pipeline-actions.ts"), "utf-8");

const DRIFT_REASON = "Gate version drifted since the action contract was issued";

function contract(overrides: Partial<PipelineActionContract> = {}): PipelineActionContract {
  return {
    actionId: "run_retro",
    phase: "Merge",
    label: "运行 Retro",
    enabled: true,
    reasonCode: null,
    reason: null,
    blockers: [],
    warnings: [],
    gateVersion: "7",
    sourceDbHash: "hash-7",
    requiresIdempotencyKey: true,
    requiresProvider: false,
    providerSelectable: false,
    defaultProvider: "codex",
    ...overrides,
  };
}

/**
 * Mirrors `actionNotAllowedEnvelope` in server/services/preflight-service.ts:
 * the refused action is echoed back with `enabled`/`reasonCode`/`reason`
 * overridden, but with the version stamps the server freshly computed.
 */
function driftEnvelope(freshGateVersion: string, freshSourceDbHash = "hash-7"): unknown {
  const fresh = contract({
    enabled: false,
    reasonCode: "gate_version_drift",
    reason: DRIFT_REASON,
    gateVersion: freshGateVersion,
    sourceDbHash: freshSourceDbHash,
  });
  return {
    status: 409,
    error: "action_not_allowed",
    reasonCode: "gate_version_drift",
    action: fresh,
    actions: [fresh],
  };
}

type SentRequest = { endpoint: string; payload: Record<string, unknown> };

function recorder(responses: PipelineActionPostResult[]) {
  const sent: SentRequest[] = [];
  const postAction = async (endpoint: string, payload: Record<string, unknown>) => {
    sent.push({ endpoint, payload });
    const next = responses.shift();
    assert.ok(next, `unexpected POST #${sent.length} to ${endpoint}`);
    return next;
  };
  return { sent, postAction };
}

describe("pipeline action runner", () => {
  it("retries a gate_version_drift rejection with the gate version the server just reported", async () => {
    // The live failure: after a merge lands and the change reaches
    // RETRO_PENDING, the page's cached contract still carries the pre-merge
    // gate version. The first POST is refused; the retry must carry the version
    // the server reported in that refusal, not the stale one it just refused.
    const { sent, postAction } = recorder([
      { ok: false, body: driftEnvelope("8", "hash-8") },
      { ok: true, body: null },
    ]);

    const result = await runPipelineAction({
      actionId: "run_retro",
      actions: [contract({ gateVersion: "7", sourceDbHash: "hash-7" })],
      provider: undefined,
      retryAfterDrift: true,
      postAction,
    });

    assert.deepEqual(result, { outcome: "started" });
    assert.equal(sent.length, 2, "exactly one retry");
    assert.equal(sent[0].payload.expectedGateVersion, "7");
    assert.equal(
      sent[1].payload.expectedGateVersion,
      "8",
      "the retry must carry the fresh gate version, not the stale one",
    );
    assert.equal(sent[1].payload.expectedSourceDbHash, "hash-8");
    assert.equal(sent[1].endpoint, "retro");
    assert.equal(sent[1].payload.actionId, "run_retro");
    assert.notEqual(
      sent[1].payload.idempotencyKey,
      sent[0].payload.idempotencyKey,
      "the retry is a new attempt and needs its own idempotency key",
    );
  });

  it("does not depend on the caller's action list being refreshed between attempts", async () => {
    // The `actions` handed in stay frozen for the whole call, exactly as a
    // captured React closure would. The retry must still be correct.
    const frozen = [contract({ gateVersion: "7" })];
    const { sent, postAction } = recorder([
      { ok: false, body: driftEnvelope("12") },
      { ok: true, body: null },
    ]);

    const result = await runPipelineAction({
      actionId: "run_retro",
      actions: frozen,
      provider: undefined,
      retryAfterDrift: true,
      postAction,
    });

    assert.deepEqual(result, { outcome: "started" });
    assert.equal(sent[1].payload.expectedGateVersion, "12");
    assert.equal(frozen[0].gateVersion, "7", "the caller's contract is not mutated");
  });

  it("surfaces an error when the retry drifts again instead of failing silently", async () => {
    const { sent, postAction } = recorder([
      { ok: false, body: driftEnvelope("8") },
      { ok: false, body: driftEnvelope("9") },
    ]);

    const result = await runPipelineAction({
      actionId: "run_retro",
      actions: [contract()],
      provider: undefined,
      retryAfterDrift: true,
      postAction,
    });

    assert.equal(sent.length, 2, "it must not keep chasing a moving gate");
    assert.equal(result.outcome, "rejected");
    assert.ok(
      result.outcome === "rejected" && result.error.length > 0,
      "a rejection the user cannot see is indistinguishable from a dead button",
    );
    assert.match(result.outcome === "rejected" ? result.error : "", /刷新页面/);
  });

  it("does not send a second identical request when the server reports the same version", async () => {
    const { sent, postAction } = recorder([{ ok: false, body: driftEnvelope("7", "hash-7") }]);

    const result = await runPipelineAction({
      actionId: "run_retro",
      actions: [contract({ gateVersion: "7", sourceDbHash: "hash-7" })],
      provider: undefined,
      retryAfterDrift: true,
      postAction,
    });

    assert.equal(sent.length, 1, "resending an identical payload can only earn an identical 409");
    assert.deepEqual(result, { outcome: "rejected", error: DRIFT_REASON });
  });

  it("does not retry a rejection that is not gate version drift", async () => {
    const { sent, postAction } = recorder([
      {
        ok: false,
        body: {
          status: 409,
          error: "action_not_allowed",
          reasonCode: "source_db_hash_drift",
          action: contract({
            enabled: false,
            reasonCode: "source_db_hash_drift",
            reason: "Source DB hash drifted since the action contract was issued",
            sourceDbHash: "hash-9",
          }),
        },
      },
    ]);

    const result = await runPipelineAction({
      actionId: "run_retro",
      actions: [contract()],
      provider: undefined,
      retryAfterDrift: true,
      postAction,
    });

    assert.equal(sent.length, 1);
    assert.deepEqual(result, {
      outcome: "rejected",
      error: "Source DB hash drifted since the action contract was issued",
    });
  });

  it("honours retryAfterDrift=false and still reports the drift", async () => {
    const { sent, postAction } = recorder([{ ok: false, body: driftEnvelope("8") }]);

    const result = await runPipelineAction({
      actionId: "run_retro",
      actions: [contract()],
      provider: undefined,
      retryAfterDrift: false,
      postAction,
    });

    assert.equal(sent.length, 1);
    assert.deepEqual(result, { outcome: "rejected", error: DRIFT_REASON });
  });

  it("blocks without sending anything when the action id reaches no endpoint", async () => {
    const { sent, postAction } = recorder([]);

    const result = await runPipelineAction({
      actionId: "approve_spec",
      actions: [contract({ actionId: "approve_spec" })],
      provider: undefined,
      retryAfterDrift: true,
      postAction,
    });

    assert.equal(sent.length, 0);
    assert.equal(result.outcome, "blocked");
    assert.match(result.outcome === "blocked" ? result.error : "", /approve_spec/);
  });

  it("blocks without sending anything when the contract itself says the action is disabled", async () => {
    const { sent, postAction } = recorder([]);

    const result = await runPipelineAction({
      actionId: "run_retro",
      actions: [contract({ enabled: false, reason: "Merge is not complete" })],
      provider: undefined,
      retryAfterDrift: true,
      postAction,
    });

    assert.equal(sent.length, 0);
    assert.deepEqual(result, { outcome: "blocked", error: "Merge is not complete" });
  });

  it("blocks when the contract is missing entirely", async () => {
    const { sent, postAction } = recorder([]);

    const result = await runPipelineAction({
      actionId: "run_retro",
      actions: undefined,
      provider: undefined,
      retryAfterDrift: true,
      postAction,
    });

    assert.equal(sent.length, 0);
    assert.deepEqual(result, { outcome: "blocked", error: "Action contract unavailable." });
  });

  it("carries the selected provider on both the first attempt and the retry", async () => {
    const { sent, postAction } = recorder([
      { ok: false, body: driftEnvelope("8") },
      { ok: true, body: null },
    ]);

    await runPipelineAction({
      actionId: "run_build",
      actions: [
        contract({ actionId: "run_build", requiresProvider: true, providerSelectable: true }),
      ],
      provider: "claude",
      retryAfterDrift: true,
      postAction,
    });

    assert.equal(sent[0].payload.provider, "claude");
    assert.equal(sent[1].payload.provider, "claude", "the retry must not silently change provider");
    assert.equal(sent[1].payload.expectedGateVersion, "8");
  });
});

describe("pipeline action rejection reading", () => {
  it("recognises drift reported at either level of the envelope", () => {
    assert.equal(isGateVersionDriftRejection(driftEnvelope("8")), true);
    assert.equal(isGateVersionDriftRejection({ reasonCode: "gate_version_drift" }), true);
    assert.equal(
      isGateVersionDriftRejection({ action: { reasonCode: "gate_version_drift" } }),
      true,
    );
    assert.equal(isGateVersionDriftRejection({ reasonCode: "not_at_gate" }), false);
    assert.equal(isGateVersionDriftRejection(null), false);
    assert.equal(isGateVersionDriftRejection("nonsense"), false);
  });

  it("always produces a message the user can read", () => {
    for (const body of [
      null,
      undefined,
      {},
      "nonsense",
      { error: "action_not_allowed" },
      { error: { code: "GATE_STATUS_UNAVAILABLE", message: "Gate status is unavailable" } },
      { reasonCode: "not_at_gate" },
      driftEnvelope("8"),
    ]) {
      const message = pipelineActionRejectionMessage(body);
      assert.equal(typeof message, "string");
      assert.ok(message.length > 0, `empty message for ${JSON.stringify(body)}`);
      assert.doesNotMatch(message, /\[object Object\]/);
    }
    assert.equal(
      pipelineActionRejectionMessage({
        error: { code: "GATE_STATUS_UNAVAILABLE", message: "Gate status is unavailable" },
      }),
      "Gate status is unavailable",
    );
  });

  it("takes only the version stamps from the rejection, never its disabled flags", () => {
    const stale = contract({ gateVersion: "7", sourceDbHash: "hash-7" });
    const refreshed = refreshedContractFromRejection(stale, driftEnvelope("8", "hash-8"));

    assert.ok(refreshed);
    assert.equal(refreshed.gateVersion, "8");
    assert.equal(refreshed.sourceDbHash, "hash-8");
    assert.equal(refreshed.enabled, true, "the retry must not inherit the refusal's enabled=false");
    assert.equal(refreshed.reasonCode, null);
    assert.equal(refreshed.reason, null);
  });

  it("reports no refreshed contract when the server gave nothing new", () => {
    const stale = contract({ gateVersion: "7", sourceDbHash: "hash-7" });
    assert.equal(refreshedContractFromRejection(stale, driftEnvelope("7", "hash-7")), null);
    assert.equal(refreshedContractFromRejection(stale, { action: {} }), null);
    assert.equal(refreshedContractFromRejection(stale, {}), null);
    assert.equal(refreshedContractFromRejection(stale, null), null);
  });
});

describe("pipeline action UI effect", () => {
  it("never leaves a failure invisible or the stage stuck busy", () => {
    // The original bug in one assertion: the second drift returned early
    // without setting an error or clearing `running`, so the stage button it
    // came from stayed disabled and nothing explained why.
    for (const result of [
      { outcome: "rejected", error: "Gate version drifted" },
      { outcome: "blocked", error: "该操作未接入任何后端接口：run_retro" },
    ] as const) {
      const effect = pipelineActionResultEffect(result);
      assert.equal(effect.running, false, `${result.outcome} must release the busy state`);
      assert.ok(effect.actionError.length > 0, `${result.outcome} must show the user a message`);
      assert.equal(effect.actionError, result.error);
      assert.equal(effect.startWatch, false);
    }
  });

  it("re-reads server state after a rejection but not after a locally blocked action", () => {
    assert.equal(pipelineActionResultEffect({ outcome: "rejected", error: "x" }).refresh, true);
    assert.equal(pipelineActionResultEffect({ outcome: "blocked", error: "x" }).refresh, false);
  });

  it("starts the post-start watch and clears the error when a run begins", () => {
    assert.deepEqual(pipelineActionResultEffect({ outcome: "started" }), {
      actionError: "",
      running: true,
      refresh: false,
      startWatch: true,
    });
  });
});

describe("usePipelineActions wiring", () => {
  it("applies every runner outcome to the UI instead of returning early", () => {
    assert.match(hookSource, /runPipelineAction\(\{/);
    assert.match(hookSource, /const effect = pipelineActionResultEffect\(result\)/);
    assert.match(hookSource, /setActionError\(effect\.actionError\)/);
    assert.match(hookSource, /setRunning\(effect\.running\)/);
    assert.match(hookSource, /if \(effect\.startWatch\) startPostStartWatch\(\)/);
    assert.match(hookSource, /if \(effect\.refresh\) void refresh\(\)/);
  });

  it("no longer sleeps hoping a React re-render lands before the retry", () => {
    assert.doesNotMatch(hookSource, /setTimeout\(resolve/);
    assert.doesNotMatch(hookSource, /Wait for state update/);
    assert.doesNotMatch(hookSource, /gate_version_drift/);
    assert.doesNotMatch(hookSource, /shouldRetry/);
  });

  it("routes network failures into the same visible-error path", () => {
    assert.match(hookSource, /catch \(err\) \{\s*result = \{ outcome: "rejected", error: String\(err\) \}/);
  });
});
