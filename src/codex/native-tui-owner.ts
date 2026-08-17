import type { AppServerRequest } from "./app-server-protocol";
import { AppServerSessionError } from "./app-server-session";

export interface RefusedReverseRequest {
  readonly method: string;
  readonly threadId: unknown;
}

/**
 * The StagePass control connection provisions a thread, unsubscribes, and then
 * uses read-only protocol queries. Receiving a reverse request here means the
 * ownership handoff regressed; never impersonate the official Codex TUI.
 *
 * 拒绝是对的，但不能安静地拒绝。2026-08-16 的故障里，唯一的症状是 Codex TUI 上
 * 一句 `Error: user rejected MCP tool call` —— MCP server 好端端的，是漏了
 * `thread/unsubscribe`，反向请求落到了 StagePass 手上。StagePass 当时什么都没说，
 * 于是排查从「MCP server 是不是坏了」开始，方向整个是反的。
 * 收到反向请求 = 所有权交接已经回归，这件事必须留下痕迹。
 */
export function createNativeTuiServerRequest(
  report: (entry: RefusedReverseRequest) => void,
): (request: AppServerRequest) => Promise<never> {
  return (request) => {
    const params = request.params as { threadId?: unknown } | undefined;
    report({ method: request.method, threadId: params?.threadId });
    return Promise.reject(new AppServerSessionError(
      "interaction_owner_is_native_tui",
      "approval and MCP interaction ownership belongs to the native Codex client",
    ));
  };
}

export const nativeTuiServerRequest = createNativeTuiServerRequest((entry) => {
  console.error(
    `[app-server] 所有权回归：反向请求 ${entry.method} 落到了 StagePass 控制连接上`
    + `（thread ${String(entry.threadId)}）。这一轮的 MCP 调用会在 TUI 里显示为被拒绝；`
    + "投递信封之前漏了 thread/unsubscribe。",
  );
});
