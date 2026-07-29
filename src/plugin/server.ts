import readline from "node:readline";
import Database from "better-sqlite3";

import { QuestionStore } from "../store/question-store";
import {
  elicitationParams,
  handleMessage,
  type JsonRpcMessage,
  type OpenQuestion,
  type PluginDependencies,
} from "./protocol";

/**
 * The StagePass Codex plugin.
 *
 * Registered with Codex as an MCP server over stdio:
 *
 *   codex -c 'mcp_servers.stagepass.command="npx"' \
 *         -c 'mcp_servers.stagepass.args=["tsx","<repo>/src/plugin/server.ts"]' \
 *         -c 'mcp_servers.stagepass.env={STAGEPASS_DB="<path>"}'
 *
 * ## Why it reads the database rather than calling a server
 *
 * There is no HTTP endpoint, so there is no port to secure, no auth to forge
 * and no actor identity to get wrong -- the three things the tree this replaces
 * spent most of its complexity on. The plugin opens the same SQLite file
 * StagePass writes, and the schema lets it do exactly two things: read a
 * question that was already asked, and append an answer. The `changes` table is
 * protected by a trigger, so it cannot move a gate even by trying.
 *
 * ## All the logic is next door
 *
 * This file is process plumbing: read lines, hand them to `handleMessage`,
 * write lines back. Everything decidable lives in `protocol.ts` and is proved
 * offline. What is left here is the part that genuinely needs a real Codex --
 * and it contains no branches worth testing.
 */

const DB_PATH = process.env.STAGEPASS_DB;

function send(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function main(): void {
  if (!DB_PATH) {
    // Nothing useful can happen, and failing at startup is far better than
    // answering `tools/list` and then breaking on the first real call.
    process.stderr.write("stagepass plugin: STAGEPASS_DB is not set\n");
    process.exit(1);
  }
  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  const questions = new QuestionStore(database);

  let nextId = 1;
  const waiting = new Map<number, (result: unknown) => void>();

  const dependencies: PluginDependencies = {
    readQuestion(questionId): OpenQuestion | null {
      try {
        const found = questions.read(questionId);
        return found.status === "open" ? found.question : null;
      } catch {
        return null;
      }
    },
    recordAnswer(questionId, result) {
      questions.answer(questionId, result);
    },
    elicit(question) {
      const id = nextId++;
      return new Promise<unknown>((resolve) => {
        waiting.set(id, resolve);
        send({
          jsonrpc: "2.0", id, method: "elicitation/create",
          params: elicitationParams(question),
        });
      });
    },
  };

  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // Not framing we own.
    }
    // A reply to our own elicitation, not a request to handle.
    if (typeof message.id === "number" && waiting.has(message.id)
      && message.method === undefined) {
      const resolve = waiting.get(message.id)!;
      waiting.delete(message.id);
      resolve(message.result ?? { action: "cancel" });
      return;
    }
    void handleMessage(message, dependencies).then((reply) => {
      if (reply) send(reply);
    });
  });
}

main();
