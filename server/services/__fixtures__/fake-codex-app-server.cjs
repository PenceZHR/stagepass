#!/usr/bin/env node

const readline = require("node:readline");

const mode = process.env.FAKE_MODE || "normal";
const approvalRequestId = 9001;
let approvalPending = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message) {
  send({ id, error: { code, message } });
}

if (process.argv[2] !== "app-server") {
  process.stderr.write("expected app-server subcommand\n");
  process.exit(64);
}

if (mode === "exit1") {
  process.stderr.write("fake app-server exited with Bearer fixture-secret\n");
  process.exit(1);
}

if (mode === "hang") {
  process.on("SIGTERM", () => {});
  process.stdin.resume();
  setInterval(() => {}, 60_000);
} else {
  const input = readline.createInterface({ input: process.stdin });

  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("fake received invalid JSON\n");
      process.exit(65);
    }

    if (approvalPending && message.id === approvalRequestId && !message.method) {
      approvalPending = false;
      if (message.result?.decision !== "decline") {
        process.stderr.write("approval response was not decline\n");
        process.exit(66);
      }
      send({ method: "fake/approvalReceived", params: { decision: "decline" } });
      return;
    }

    if (!message.method) return;

    if (message.method === "initialize") {
      if (!message.params?.clientInfo?.name || !message.params?.clientInfo?.version) {
        sendError(message.id, -32602, "initialize.clientInfo is required");
        return;
      }
      send({ id: message.id, result: { userAgent: "stagepass-fake/1" } });
      return;
    }

    if (message.method === "initialized") return;

    if (message.method === "thread/start") {
      const thread = { id: "THREAD-1" };
      send({ method: "thread/started", params: { thread } });
      send({ id: message.id, result: { thread } });
      if (mode === "approval") {
        approvalPending = true;
        send({
          id: approvalRequestId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "THREAD-1",
            turnId: "TURN-1",
            itemId: "ITEM-COMMAND-1",
          },
        });
      }
      return;
    }

    if (message.method === "thread/resume") {
      const thread = { id: message.params?.threadId || "THREAD-1" };
      send({ method: "thread/started", params: { thread } });
      send({ id: message.id, result: { thread } });
      return;
    }

    if (message.method === "turn/start") {
      const threadId = message.params?.threadId || "THREAD-1";
      if (mode === "overloaded") {
        sendError(message.id, -32001, "Server overloaded; retry later");
        return;
      }
      if (
        process.env.FAKE_EXPECT_OUTPUT_SCHEMA === "1"
        && !message.params?.outputSchema
      ) {
        sendError(message.id, -32602, "turn/start.outputSchema is required");
        return;
      }
      const turn = { id: "TURN-1", status: "completed", items: [] };
      const text = process.env.FAKE_STRUCTURED_OUTPUT === "1"
        ? "{\"ok\":true}"
        : "Hello world";
      const item = { id: "ITEM-1", type: "agentMessage", text };
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: { id: "TURN-1", status: "inProgress", items: [] },
        },
      });
      if (process.env.FAKE_INCLUDE_FILE_CHANGE === "1") {
        const fileChange = {
          id: "ITEM-FILE-1",
          type: "fileChange",
          changes: [{ path: "server/example.ts" }],
        };
        send({
          method: "item/started",
          params: {
            threadId,
            turnId: "TURN-1",
            item: fileChange,
            startedAtMs: Date.now(),
          },
        });
        send({
          method: "item/completed",
          params: {
            threadId,
            turnId: "TURN-1",
            item: fileChange,
            completedAtMs: Date.now(),
          },
        });
      }
      send({
        method: "item/started",
        params: { threadId, turnId: "TURN-1", item, startedAtMs: Date.now() },
      });
      const deltas = process.env.FAKE_STRUCTURED_OUTPUT === "1"
        ? [text]
        : ["Hello ", "world"];
      for (const delta of deltas) {
        send({
          method: "item/agentMessage/delta",
          params: { threadId, turnId: "TURN-1", itemId: "ITEM-1", delta },
        });
      }
      send({
        method: "item/completed",
        params: { threadId, turnId: "TURN-1", item, completedAtMs: Date.now() },
      });
      send({ method: "turn/completed", params: { threadId, turn } });
      send({ id: message.id, result: { turn } });
      return;
    }

    if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
      return;
    }

    sendError(message.id, -32601, `unknown method: ${message.method}`);
  });

  input.on("close", () => {
    process.exit(approvalPending ? 67 : 0);
  });
}
