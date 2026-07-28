import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES,
  type CodexDesktopTurnRequest,
} from "./codex-desktop-bridge-types";
import type { CodexDesktopFollowerTransport } from "./codex-desktop-ipc-transport";
import type { CodexToolSurface } from "./codex-home-profile";
import {
  CodexSessionGateway,
  CodexSessionGatewayError,
  codexThreadDeepLink,
} from "./codex-session-gateway";

const execFileAsync = promisify(execFile);

/**
 * A follower transport that starts turns over app-server instead of over Codex
 * Desktop's private IPC socket.
 *
 * ## Why it wears the follower interface
 *
 * Every caller in the pipeline already talks to `CodexDesktopFollowerTransport`
 * -- there are exactly two production call sites for `startFollowerTurn`. Fitting
 * the existing shape means the swap happens once at composition, and the stages,
 * recovery and journal keep working against a contract they already trust,
 * rather than every call site learning a second protocol.
 *
 * ## What genuinely differs from the Desktop path
 *
 * The Desktop path needs a running, signed, version-matched Codex Desktop and
 * fails closed when the bundle fingerprint is unknown. This path needs only the
 * `codex` binary. It reports the same capability names because it really does
 * provide them, but its fingerprint identifies the gateway, not a Desktop
 * bundle -- callers that key off the fingerprint must not assume Desktop.
 *
 * ## What is deliberately NOT claimed
 *
 * Nothing here makes Codex Desktop render a *live* turn. A turn started through
 * this transport is visible in Desktop by opening its thread (`openThreadDeepLink`),
 * and its MCP App cards do render there -- verified 2026-07-28 -- but Desktop is
 * a viewer of this turn, not its owner.
 */
const GATEWAY_PROTOCOL_FINGERPRINT = "app-server-gateway-v1";

export interface GatewayFollowerTransportOptions {
  /**
   * Resolves the gateway for a turn's tool surface.
   *
   * A surface is a distinct `CODEX_HOME`, and a `CODEX_HOME` is fixed when the
   * app-server process starts -- so one surface means one process. The pool is
   * therefore not an optimisation; it is the only way a line-protocol turn and
   * a card turn can both run without restarting anything.
   */
  gatewayFor: (surface: CodexToolSurface) => CodexSessionGateway;
  /** Injectable so tests never shell out to `open`. */
  openUrl?: (url: string) => Promise<void>;
}

export function createGatewayFollowerTransport(
  options: GatewayFollowerTransportOptions,
): CodexDesktopFollowerTransport {
  // The probe answers for the transport as a whole, and every surface runs the
  // same binary and protocol, so it uses the default one.
  const gateway = options.gatewayFor("full");
  const openUrl = options.openUrl
    ?? (async (url: string) => {
      await execFileAsync("open", [url]);
    });

  return {
    async probe() {
      // Connecting IS the probe: if app-server will not start and initialize,
      // this transport has nothing to offer and should not report capabilities.
      await gateway.connect();
      const capabilities = [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES];
      return {
        clientVersion: "app-server-gateway",
        protocolFingerprint: GATEWAY_PROTOCOL_FINGERPRINT,
        capabilities,
        protocolCapabilities: capabilities,
      };
    },

    async openThreadDeepLink(input) {
      await openUrl(input.url);
    },

    async startFollowerTurn(request: CodexDesktopTurnRequest) {
      const surfaced = options.gatewayFor(request.toolSurface ?? "full");
      try {
        const { turnId } = await surfaced.startTurn({
          threadId: request.threadId,
          prompt: request.prompt,
          cwd: request.cwd,
          approvalPolicy: request.approvalPolicy,
          sandboxMode: request.sandboxMode,
          ...(request.model ? { model: request.model } : {}),
          ...(request.reasoningEffort
            ? { effort: request.reasoningEffort }
            : {}),
          ...(request.outputSchema
            ? { outputSchema: request.outputSchema }
            : {}),
        });
        if (!turnId) {
          // The follower contract promises a turn id; without one the caller
          // cannot journal or interrupt this turn, so treat it as a protocol
          // failure rather than inventing an id.
          throw new CodexSessionGatewayError(
            "PROTOCOL_ERROR",
            "turn/start returned no turn id",
          );
        }
        return { status: "started" as const, turnId };
      } catch (error) {
        // "No Codex to talk to" is the one condition the follower contract
        // expresses as a value rather than a throw, because the pipeline
        // retries it. Every other failure stays an exception.
        if (
          error instanceof CodexSessionGatewayError
          && (error.code === "APP_SERVER_UNAVAILABLE"
            || error.code === "APP_SERVER_DISCONNECTED")
        ) {
          return { status: "no-client-found" as const };
        }
        throw error;
      }
    },

    async interruptTurn(input) {
      await gateway.interruptTurn(input.threadId);
    },
  };
}

/** Convenience for callers that only have a thread id and want it on screen. */
export async function revealThreadInDesktop(
  threadId: string,
  openUrl?: (url: string) => Promise<void>,
): Promise<void> {
  const url = codexThreadDeepLink(threadId);
  if (openUrl) {
    await openUrl(url);
    return;
  }
  await execFileAsync("open", [url]);
}
