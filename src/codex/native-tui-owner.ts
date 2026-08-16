import type { AppServerRequest } from "./app-server-protocol";
import { AppServerSessionError } from "./app-server-session";

/**
 * StagePass observes native turns but never impersonates their interactive
 * owner. Approval, elicitation, MCP interaction, and interruption UI remain in
 * the official Codex TUI connected to the managed App Server daemon.
 */
export function nativeTuiServerRequest(_request: AppServerRequest): Promise<never> {
  return Promise.reject(new AppServerSessionError(
    "interaction_owner_is_native_tui",
    "approval and MCP interaction ownership belongs to the native Codex client",
  ));
}
