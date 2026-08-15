#!/usr/bin/env node

const readline = require("node:readline");

const mode = process.env.FAKE_APP_SERVER_MODE || "normal";
const approvalId = 9001;
let approvalPending = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendChunked(message) {
  const line = `${JSON.stringify(message)}\n`;
  const middle = Math.max(1, Math.floor(line.length / 2));
  process.stdout.write(line.slice(0, middle));
  setImmediate(() => process.stdout.write(line.slice(middle)));
}

function fail(id, code, message) {
  send({ id, error: { code, message } });
}

if (
  process.argv[2] !== "app-server"
  || process.argv[3] !== "--listen"
  || process.argv[4] !== "stdio://"
) {
  process.stderr.write("expected app-server --listen stdio://\n");
  process.exit(64);
}

if (mode === "exit1") {
  process.stderr.write("provider failed with Bearer fixture-secret and sk-fixture-secret\n");
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

    if (approvalPending && message.id === approvalId && !message.method) {
      approvalPending = false;
      if (message.result?.decision !== "decline") {
        process.stderr.write("approval response was not decline\n");
        process.exit(66);
      }
      send({
        method: "fake/approvalReceived",
        params: { decision: message.result.decision },
      });
      return;
    }

    if (message.method === "initialize") {
      if (
        message.params?.clientInfo?.name !== "stagepass"
        || message.params?.clientInfo?.version !== "0.1.0"
        || message.params?.capabilities?.experimentalApi !== true
      ) {
        fail(message.id, -32602, "invalid initialize params");
        return;
      }
      const response = {
        id: message.id,
        result: {
          userAgent: "stagepass-fake/1",
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      };
      if (mode === "chunked") sendChunked(response);
      else send(response);
      return;
    }

    if (message.method === "initialized") return;

    if (message.method === "thread/start") {
      const thread = { id: "THREAD-1", turns: [] };
      send({ method: "thread/started", params: { thread } });
      send({ id: message.id, result: { thread } });
      if (mode === "approval") {
        approvalPending = true;
        send({
          id: approvalId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "THREAD-1",
            turnId: "TURN-1",
            itemId: "ITEM-COMMAND-1",
            command: "git status --short",
          },
        });
      }
      return;
    }

    if (message.method === "fake/ping") {
      send({ id: message.id, result: { pong: true } });
      return;
    }

    if (message.method === "fake/slow") return;

    fail(message.id, -32601, `unknown method: ${message.method}`);
  });

  input.on("close", () => {
    process.exit(approvalPending ? 67 : 0);
  });
}
