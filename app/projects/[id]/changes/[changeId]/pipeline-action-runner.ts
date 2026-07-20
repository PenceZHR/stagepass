/**
 * Sends a pipeline action to the server and decides what the UI must show
 * afterwards. Deliberately React-free so the retry rule below is testable
 * without a renderer.
 *
 * Why the drift retry lives here
 * ------------------------------
 * `POST /<action>` runs `assertActionAllowed`, which rejects with
 * `gate_version_drift` whenever the `expectedGateVersion` in the payload is not
 * the version the server currently computes (server/services/preflight-service.ts).
 * The client's copy of the contract goes stale routinely -- a stage finishing,
 * a merge landing, or the server's own self-heal all bump the gate version
 * between the page's last gate read and the click -- so a single drift is a
 * normal race, not an error worth showing. One automatic retry absorbs it.
 *
 * The retry has to carry a *fresh* version, and the only version that is
 * guaranteed to be fresh is the one the server just reported. The 409 envelope
 * built by `actionNotAllowedEnvelope` calls `getActions(changeId)` and returns
 * the resulting contract as `action`, with only `enabled`/`reasonCode`/`reason`
 * overridden to describe the rejection -- so `action.gateVersion` and
 * `action.sourceDbHash` are the live values the very next preflight will
 * compare against. We read them straight out of the response body.
 *
 * This is what makes the retry race-free. The refreshed contract is a local
 * value derived from an awaited HTTP response inside a single invocation of
 * `runPipelineAction`. It is never read back from React state, a ref, or a
 * value captured when the calling component last rendered, so no render has to
 * have committed for the retry to be correct. The previous implementation
 * called `refresh()` and slept 200ms hoping the parent's `actions` prop would
 * have been rebuilt; the executing closure kept its original `actions`
 * regardless, so the retry re-sent the same stale version and drew an identical
 * 409 every time.
 *
 * Exactly one retry is attempted, and only when the server reports a version
 * that actually differs from the one just refused. A gate that keeps moving
 * therefore surfaces as an error instead of looping.
 */
import {
  createPipelinePreflightPayload,
  findPipelineAction,
  pipelineActionDisabledReason,
  type AiProvider,
  type PipelineActionContract,
} from "./pipeline-action-contract";
import { resolvePipelineActionCommand } from "./pipeline-action-commands";

export const GATE_VERSION_DRIFT_REASON_CODE = "gate_version_drift";

/** A POST already reduced to the two things the runner cares about. */
export interface PipelineActionPostResult {
  ok: boolean;
  /** Parsed rejection envelope. `null` when the body was absent or unparseable. */
  body: unknown;
}

export type PipelineActionRunResult =
  /** The server accepted the action; a run is starting. */
  | { outcome: "started" }
  /** Nothing was sent: unroutable action id, or the contract says it is disabled. */
  | { outcome: "blocked"; error: string }
  /** The server refused it, after the drift retry when one was warranted. */
  | { outcome: "rejected"; error: string };

/** The rejection envelope shape this module reads, all fields optional. */
interface ActionRejectionEnvelope {
  error?: unknown;
  reasonCode?: unknown;
  action?: {
    reason?: unknown;
    reasonCode?: unknown;
    gateVersion?: unknown;
    sourceDbHash?: unknown;
  };
}

function asEnvelope(body: unknown): ActionRejectionEnvelope {
  return typeof body === "object" && body !== null ? (body as ActionRejectionEnvelope) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A human-readable reason for a rejection.
 *
 * `error` is a plain string on the action routes but an object on some
 * infrastructure failures, so an object with a `message` is unwrapped rather
 * than rendered as `[object Object]`. Never returns an empty string: a
 * rejection the user cannot see is indistinguishable from a dead button.
 */
export function pipelineActionRejectionMessage(body: unknown): string {
  const envelope = asEnvelope(body);
  const fromAction = asString(envelope.action?.reason) ?? asString(envelope.action?.reasonCode);
  if (fromAction) return fromAction;
  const error = envelope.error;
  const fromError =
    asString(error) ??
    asString((typeof error === "object" && error !== null ? (error as { message?: unknown }).message : null));
  return fromError ?? asString(envelope.reasonCode) ?? "Action failed";
}

/** True when the server refused the action because our gate version was stale. */
export function isGateVersionDriftRejection(body: unknown): boolean {
  const envelope = asEnvelope(body);
  return (
    envelope.action?.reasonCode === GATE_VERSION_DRIFT_REASON_CODE ||
    envelope.reasonCode === GATE_VERSION_DRIFT_REASON_CODE
  );
}

/**
 * Rebuilds the contract to retry with, using the version stamps the server
 * reported in its own rejection.
 *
 * The stale contract supplies everything else on purpose: the envelope's copy
 * has `enabled: false` forced onto it to describe the refusal, so reusing it
 * wholesale would make the retry look disabled. Only the identity of the gate
 * snapshot is taken from the server.
 *
 * Returns null when the server reported no usable version, or reported the same
 * one we just sent -- resending an identical payload can only earn an identical
 * 409, so the caller should surface the failure instead.
 */
export function refreshedContractFromRejection(
  stale: PipelineActionContract,
  body: unknown,
): PipelineActionContract | null {
  const reported = asEnvelope(body).action;
  const gateVersion = asString(reported?.gateVersion);
  const sourceDbHash = asString(reported?.sourceDbHash);
  if (!gateVersion && !sourceDbHash) return null;
  const refreshed: PipelineActionContract = {
    ...stale,
    gateVersion: gateVersion ?? stale.gateVersion,
    sourceDbHash: sourceDbHash ?? stale.sourceDbHash,
  };
  if (refreshed.gateVersion === stale.gateVersion && refreshed.sourceDbHash === stale.sourceDbHash) {
    return null;
  }
  return refreshed;
}

export async function runPipelineAction(input: {
  actionId: string;
  actions: PipelineActionContract[] | undefined;
  provider: AiProvider | undefined;
  /** False disables the automatic drift retry (used by callers that retry themselves). */
  retryAfterDrift: boolean;
  postAction: (
    endpoint: string,
    payload: Record<string, unknown>,
  ) => Promise<PipelineActionPostResult>;
}): Promise<PipelineActionRunResult> {
  const { actionId, actions, provider, retryAfterDrift, postAction } = input;

  const command = resolvePipelineActionCommand(actionId);
  if (!command) {
    // Previously a silent `return false`: no request, no error, no console
    // output, so an action id missing from ACTION_ENDPOINTS rendered as a
    // button that appeared to do nothing. Surface it instead of swallowing.
    return { outcome: "blocked", error: `该操作未接入任何后端接口：${actionId}` };
  }

  const initialAction = findPipelineAction(actions, actionId);
  const disabledReason = pipelineActionDisabledReason(initialAction);
  if (disabledReason !== null || initialAction === null) {
    return { outcome: "blocked", error: disabledReason ?? "Action contract unavailable." };
  }

  const send = (contractAction: PipelineActionContract) =>
    postAction(
      command.endpoint,
      withSelectedProvider(createPipelinePreflightPayload(contractAction), contractAction, provider),
    );

  const first = await send(initialAction);
  if (first.ok) return { outcome: "started" };

  if (!retryAfterDrift || !isGateVersionDriftRejection(first.body)) {
    return { outcome: "rejected", error: pipelineActionRejectionMessage(first.body) };
  }

  const refreshed = refreshedContractFromRejection(initialAction, first.body);
  if (!refreshed) {
    return { outcome: "rejected", error: pipelineActionRejectionMessage(first.body) };
  }

  const retried = await send(refreshed);
  if (retried.ok) return { outcome: "started" };

  // The gate moved again between the rejection and the retry. One more attempt
  // would just chase it, so tell the user what happened and why reloading helps.
  if (isGateVersionDriftRejection(retried.body)) {
    return {
      outcome: "rejected",
      error: `门禁版本仍在变动，自动重试一次后仍被拒绝，请刷新页面后重试。（${pipelineActionRejectionMessage(retried.body)}）`,
    };
  }
  return { outcome: "rejected", error: pipelineActionRejectionMessage(retried.body) };
}

/**
 * The UI state a finished run must leave behind.
 *
 * Split out from the hook so the invariant that matters can be asserted without
 * a renderer: every outcome that is not `started` clears `running` and carries a
 * non-empty message. A failure that left `running` true disabled the very button
 * that triggered it, which is what made the original bug look like a dead click
 * -- the second drift returned early without touching either piece of state, so
 * the stage stayed busy forever and no error was ever shown.
 */
export interface PipelineActionEffect {
  /** Message to display. Empty only when a run actually started. */
  actionError: string;
  /** Busy state to apply. */
  running: boolean;
  /** Re-read server state, so the buttons reflect why the action failed. */
  refresh: boolean;
  /** Start the post-start refresh watch. */
  startWatch: boolean;
}

export function pipelineActionResultEffect(result: PipelineActionRunResult): PipelineActionEffect {
  if (result.outcome === "started") {
    return { actionError: "", running: true, refresh: false, startWatch: true };
  }
  return {
    actionError: result.error,
    running: false,
    // A blocked action never reached the server, so there is nothing new to read.
    refresh: result.outcome === "rejected",
    startWatch: false,
  };
}

export function withSelectedProvider(
  payload: Record<string, unknown>,
  action: PipelineActionContract | null,
  provider: AiProvider | undefined,
): Record<string, unknown> {
  if (action?.requiresProvider === true && action.providerSelectable === true && provider) {
    payload.provider = provider;
  }
  return payload;
}
