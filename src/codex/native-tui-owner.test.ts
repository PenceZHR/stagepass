import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppServerRequest } from "./app-server-protocol";
import { AppServerSessionError } from "./app-server-session";
import { nativeTuiServerRequest } from "./native-tui-owner";

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
});
