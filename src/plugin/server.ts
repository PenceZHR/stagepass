import readline from "node:readline";
import Database from "better-sqlite3";

import { QuestionStore } from "../store/question-store";
import { WorklistStore } from "../store/worklist-store";
import {
  elicitationParams,
  handleMessage,
  type JsonRpcMessage,
  type PluginDependencies,
} from "./protocol";

/**
 * The StagePass Codex plugin.
 *
 * Registered with Codex as an MCP server over stdio:
 *
 *   codex -c 'mcp_servers.stagepass.command="npx"' \
 *         -c 'mcp_servers.stagepass.args=["tsx","<repo>/src/plugin/server.ts"]' \
 *         -c 'mcp_servers.stagepass.env={STAGEPASS_DB="<path>",STAGEPASS_CHANGE="<id>"}'
 *
 * ## 为什么 Change 也走环境变量
 *
 * 三个工具**一个入参都不收**（见 `protocol.ts`），所以「问的是哪个 Change 的事」
 * 只能由启动它的那一侧说。面板启动 Codex 时本来就知道，所以跟着库路径一起注册。
 * **它从头到尾没经过模型的嘴** —— 那正是这一整套改动的判据。
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
/** 这一次插件是为哪个 Change 起的。缺席时三个工具一律说「没有」，不猜。 */
const CHANGE_ID = process.env.STAGEPASS_CHANGE;

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
  const worklist = new WorklistStore(database);

  let nextId = 1;
  const waiting = new Map<number, (result: unknown) => void>();

  const dependencies: PluginDependencies = {
    /*
     * **哪个 Change 是从环境变量来的，不是模型说的。**
     *
     * 面板启动 Codex 的时候就知道这一轮是哪个 Change，所以它跟着 `STAGEPASS_DB`
     * 一起注册进去（`web/panel-server.ts` 的 `pluginConfigFor`）。这不是「换个地方
     * 手抄」—— 它从头到尾没经过模型的嘴，而那正是判据。
     *
     * 少了它就只能猜「库里唯一开着的那一个」，而两个 Change 各开一个的时候，猜错一次
     * 就是把人的答案记到别的问题上：静默的、事后查不出来的那一种错。
     */
    openQuestion() {
      if (!CHANGE_ID) return null;
      const found = questions.open(CHANGE_ID);
      return found === null ? null : { id: found.id, question: found.question };
    },
    recordAnswer(questionId, result) {
      questions.answer(questionId, result);
    },
    nextItem() {
      if (!CHANGE_ID) return null;
      return worklist.next(CHANGE_ID);
    },
    recordItem(answer, reason) {
      if (!CHANGE_ID) return { kind: "nothing_open" };
      return worklist.answer(CHANGE_ID, answer, reason);
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
