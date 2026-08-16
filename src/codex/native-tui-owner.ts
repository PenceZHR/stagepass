import type { AppServerRequest } from "./app-server-protocol";
import { AppServerSessionError } from "./app-server-session";

/**
 * The StagePass control connection provisions a thread, unsubscribes, and then
 * uses read-only protocol queries. Receiving a reverse request here means the
 * ownership handoff regressed; never impersonate the official Codex TUI.
 */
export function nativeTuiServerRequest(_request: AppServerRequest): Promise<never> {
  return Promise.reject(new AppServerSessionError(
    "interaction_owner_is_native_tui",
    "approval and MCP interaction ownership belongs to the native Codex client",
  ));
}
