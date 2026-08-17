import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppServerRequest } from "./app-server-protocol";
import { AppServerSessionError } from "./app-server-session";
import { createNativeTuiServerRequest, nativeTuiServerRequest } from "./native-tui-owner";

describe("native TUI interaction owner", () => {
  it("leaves reverse requests with the official native client", async () => {
    const request: AppServerRequest = {
      id: 9,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "019f0000-0000-7000-8000-000000000001",
        turnId: "TURN-TUI",
      },
    };

    await assert.rejects(
      nativeTuiServerRequest(request),
      (error) => error instanceof AppServerSessionError
        && error.code === "interaction_owner_is_native_tui",
    );
  });

  it("says out loud which request it refused", async () => {
    // 2026-08-16 那次故障的全部症状只在 TUI 里：`Error: user rejected MCP tool call`。
    // MCP server 没坏，是所有权交接漏了 unsubscribe，反向请求走到了 StagePass 手上。
    // 拒绝是对的（绝不冒充官方客户端），但当时 StagePass 这边一声不吭 —— 下一次
    // 同样的回归还是只能靠人去猜。收到反向请求本身就是回归的证据，必须留下痕迹。
    const seen: { method: string; threadId: unknown }[] = [];
    const refuse = createNativeTuiServerRequest((entry) => { seen.push(entry); });

    await assert.rejects(
      refuse({
        id: 11,
        method: "mcpServer/elicitation/request",
        params: { threadId: "019f0000-0000-7000-8000-000000000002", turnId: "TURN-X" },
      }),
      (error) => error instanceof AppServerSessionError
        && error.code === "interaction_owner_is_native_tui",
    );

    assert.deepEqual(seen, [{
      method: "mcpServer/elicitation/request",
      threadId: "019f0000-0000-7000-8000-000000000002",
    }]);
  });
});
