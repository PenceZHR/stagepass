import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCodexDesktopHostUiMessageClient,
  HostContinuationDeliveryError,
} from "./host-continuation-delivery";

describe("Codex Desktop host continuation delivery", () => {
  it("starts a proved follower turn in the exact visible Codex task", async () => {
    const requests: unknown[] = [];
    const client = createCodexDesktopHostUiMessageClient({
      async readForStart(logicalTurnId) {
        assert.equal(logicalTurnId, "logical-1");
        return {
          request: {
            threadId: "thread-1",
            cwd: "/tmp/project",
            prompt: "base prompt",
            approvalPolicy: "never",
            sandboxMode: "read-only",
          },
        };
      },
      readAttempt(attemptId) {
        assert.equal(attemptId, "attempt-1");
        return {
          logicalTurnId: "logical-1",
          threadId: "thread-1",
          state: "dispatching",
          normalizedPromptHash:
            "6bb663c6e71f0a713d1fbf2440f83a37e35929da36a89ab5cebcd5cf04510dcc",
        };
      },
      async startFollowerTurn(request) {
        requests.push(request);
        return { status: "started", turnId: "turn-2" };
      },
    });

    const result = await client.sendUiMessage({
      sourceThreadId: "thread-1",
      text: "continue\n\n[marker]",
      logicalTurnId: "logical-1",
      attemptId: "attempt-1",
    });

    assert.deepEqual(result, { turnId: "turn-2" });
    assert.deepEqual(requests, [{
      threadId: "thread-1",
      cwd: "/tmp/project",
      prompt: "continue\n\n[marker]",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    }]);
  });

  it("fails closed when the Desktop host does not prove a new turn id", async () => {
    const client = createCodexDesktopHostUiMessageClient({
      async readForStart() {
        return {
          request: {
            threadId: "thread-1",
            cwd: "/tmp/project",
            prompt: "base prompt",
            approvalPolicy: "never",
            sandboxMode: "read-only",
          },
        };
      },
      readAttempt() {
        return {
          logicalTurnId: "logical-1",
          threadId: "thread-1",
          state: "dispatching",
          normalizedPromptHash:
            "6bb663c6e71f0a713d1fbf2440f83a37e35929da36a89ab5cebcd5cf04510dcc",
        };
      },
      async startFollowerTurn() {
        return { status: "no-client-found" };
      },
    });

    await assert.rejects(
      client.sendUiMessage({
        sourceThreadId: "thread-1",
        text: "continue\n\n[marker]",
        logicalTurnId: "logical-1",
        attemptId: "attempt-1",
      }),
      (error) =>
        error instanceof HostContinuationDeliveryError
        && error.code === "host_continuation_no_client",
    );
  });
});
