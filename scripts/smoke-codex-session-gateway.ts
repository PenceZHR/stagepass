/**
 * Live smoke for CodexSessionGateway against the real installed Codex.
 *
 * Not a unit test: it spends real tokens on the real account, so it cannot run
 * in CI. It exists because the capability it proves -- that a turn started off
 * Desktop still renders a StagePass MCP App card -- is version-dependent and
 * undocumented, exactly like `probe-codex-subagent.mjs`.
 *
 *   npx tsx scripts/smoke-codex-session-gateway.ts
 */
import { execFile } from "node:child_process";

import {
  CodexSessionGateway,
  codexThreadDeepLink,
} from "../server/services/codex-session-gateway.ts";

const CODEX_BIN = process.env.STAGEPASS_CODEX_BIN
  ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const REPO = process.cwd();

const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;

const PROMPT = [
  "Call the MCP tool `present_stagepass_choices` on server `stagepass-card`",
  "directly as a native tool call. Do NOT use the exec/js sandbox and do NOT",
  "read files. Use exactly: interactionId=\"gw-smoke-0001\",",
  "logicalTurnId=\"gw-turn-0001\", projectId=\"stagepass\", changeId=null,",
  "batchTitle=\"Gateway smoke\". Two questions with ids \"session_validity\"",
  "and \"third_failed_attempt\", each with A/B/C choices.",
].join(" ");

async function main() {
  const gateway = new CodexSessionGateway({ bin: CODEX_BIN, cwd: REPO });

  console.log(`${stamp()} connecting…`);
  await gateway.connect();
  console.log(`${stamp()} connected`);

  const threadId = await gateway.startThread({ cwd: REPO, sandbox: "read-only" });
  console.log(`${stamp()} threadId = ${threadId}`);

  const cardCalls: string[] = [];
  const result = await gateway.runTurn({
    threadId,
    prompt: PROMPT,
    observer: {
      onItemStarted: (id, item) => {
        if (id !== threadId) return;
        console.log(`${stamp()}   item/started: ${item.type}`);
      },
      onItemCompleted: (id, item) => {
        if (item.type !== "mcpToolCall") return;
        const tool = `${String(item.server)}/${String(item.tool)}`;
        cardCalls.push(tool);
        console.log(`${stamp()} *** ${tool} status=${String(item.status)}`);
      },
    },
  });

  console.log(`\n${stamp()} turn ${result.status}`);
  console.log(`card tool calls: ${cardCalls.length ? cardCalls.join(", ") : "(none)"}`);

  const link = codexThreadDeepLink(threadId);
  execFile("open", [link], () => console.log(`${stamp()} deep link: ${link}`));

  const ok = result.status === "completed"
    && cardCalls.some((call) => call.includes("present_stagepass_choices"));
  console.log(`\nVERDICT: ${ok ? "GATEWAY OK" : "GATEWAY FAILED"}`);

  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await gateway.close();
  process.exit(ok ? 0 : 1);
}

void main().catch((error) => {
  console.error("smoke failed:", error);
  process.exit(1);
});
