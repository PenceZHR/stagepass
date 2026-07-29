/**
 * §五.10, answered without a model in the loop.
 *
 *   pnpm probe:elicit
 *
 * Starts Codex in a pty with one MCP server -- the probe server, which elicits
 * as soon as the handshake finishes. No prompt is sent, so no turn runs and no
 * model decides anything. What is measured is only this: given an
 * `elicitation/create`, does the Codex TUI draw a selector, do arrow keys move
 * it, and does Enter commit it.
 *
 * Down-then-Enter lands on the SECOND option, so a selector that never drew
 * (Enter would confirm the first) cannot be mistaken for one that worked.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as ptySpawn } from "node-pty";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OPTIONS = ["approve", "reject"] as const;
/** The schema title the probe server sends; unique enough to detect the draw. */
const TITLE = "请裁决";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strip the escape sequences a TUI interleaves with its text.
 *
 * Two traps, both of which cost a run each:
 *
 * 1. The CSI pattern must allow intermediate bytes. Codex emits `ESC [ 0 SP q`
 *    (a space before the final `q`); a `[0-9;?]*[a-zA-Z]` pattern leaves it in.
 * 2. Stripping is not enough to match a phrase. The TUI positions words with
 *    cursor motion rather than spaces, so "Allow the X MCP server" arrives as
 *    "AllowtheXMCPserver". Compare with `squash`, never with the plain text.
 */
const clean = (text: string): string => text
  .replace(/\x1b\][^\x07]*\x07/g, "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[()][AB012]/g, "")
  .replace(/\x1b[=>]/g, "");

/** Whitespace-free view, for matching text a TUI laid out with cursor moves. */
const squash = (text: string): string => clean(text).replace(/\s+/g, "");

interface TapEntry { direction: string; payload: { result?: unknown; error?: unknown } }

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "stagepass-elicit-"));
  const tapPath = join(directory, "frames.jsonl");

  const tap = (): TapEntry[] => existsSync(tapPath)
    ? readFileSync(tapPath, "utf-8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as TapEntry)
    : [];
  const sent = () => tap().some((entry) =>
    entry.direction === "server->client"
    && (entry.payload as { method?: string }).method === "elicitation/create");
  const reply = () => tap().find((entry) => entry.direction === "ELICIT_REPLY")?.payload;

  console.log("no prompt, no turn, no model -- only Codex and one eliciting MCP server\n");

  const term = ptySpawn("codex", [
    "-c", `mcp_servers.elicitprobe.command="npx"`,
    "-c", `mcp_servers.elicitprobe.args=["tsx","${REPO}/scripts/probe-elicit-server.ts"]`,
    "-c", `mcp_servers.elicitprobe.env={STAGEPASS_TAP="${tapPath}"}`,
    "-c", `model_reasoning_effort="low"`,
    "-s", "read-only",
    "-a", process.argv[2] ?? "never",
    "调用 ask_the_human 工具一次。它没有参数。调用完就停下，不要解释。",
  ], {
    name: "xterm-256color", cols: 120, rows: 40, cwd: "/tmp",
    env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
  });

  const chunks: Buffer[] = [];
  term.onData((data) => { chunks.push(Buffer.from(data, "utf-8")); });
  const raw = () => Buffer.concat(chunks).toString("utf-8");
  const seen = () => squash(raw());

  let asked = false;
  let rendered = false;
  let keysSent = false;
  let approvals = 0;
  let approved = false;
  let prods = 0;
  let lastProd = Date.now();

  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const screen = seen();

    // Codex's own gate, separate from -a: may this server run this tool?
    // Approve EXACTLY once. The buffer is cumulative and the TUI redraws, so a
    // "still matches" check re-fires forever -- and a stray Enter arriving after
    // the selector opens would dismiss it, which would look exactly like Codex
    // declining. One press, then never again.
    if (!asked && !approved && /MCPservertoruntool/i.test(screen.slice(-6_000))) {
      approved = true;
      approvals += 1;
      console.log("· tool-approval prompt -> Enter (once)");
      term.write(KEY_ENTER);
      await sleep(2_500);
      lastProd = Date.now();
      continue;
    }

    if (!asked && sent()) {
      asked = true;
      console.log("· server sent elicitation/create (from inside the tool call)");
    }

    // The model is not reliable about calling the tool -- measured, four of six
    // earlier runs never did. Prod it rather than spend the run waiting.
    if (!asked && Date.now() - lastProd > 75_000 && prods < 3) {
      prods += 1;
      console.log(`· no tool call yet -> prodding (${prods}/3)`);
      term.write("现在就调用 ask_the_human 工具，不要说别的。");
      await sleep(600);
      term.write(KEY_ENTER);
      lastProd = Date.now();
      continue;
    }

    if (asked && !keysSent) {
      // Match on the schema's title plus both options. Slicing from a remembered
      // offset was wrong -- squashing changes the index as the buffer grows, and
      // the check silently never fired on a selector that was plainly drawn.
      // These strings appear nowhere else, so the whole buffer is safe to scan.
      const since = seen();
      if (since.includes(TITLE) && OPTIONS.every((option) => since.includes(option))) {
        rendered = true;
        console.log("· selector is on screen -> Down, Enter");
        term.write(KEY_DOWN);
        await sleep(1_000);
        term.write(KEY_ENTER);
        keysSent = true;
      }
    }
    if (reply()) {
      console.log(`· client replied: ${JSON.stringify(reply())}`);
      break;
    }
    await sleep(400);
  }

  const answer = reply();
  const chosen = (answer?.result as { content?: { decision?: string } } | undefined)
    ?.content?.decision;

  console.log("\n--- verdict ---");
  console.log(`elicitation/create sent     ${asked ? "PASS" : "FAIL"}`);
  console.log(`selector drawn in the TUI   ${rendered ? "PASS" : "FAIL"}`);
  console.log(`client replied              ${answer ? "PASS" : "FAIL"}`);
  console.log(`Down+Enter chose 2nd option ${chosen === OPTIONS[1]
    ? `PASS (got "${chosen}")` : `FAIL (got ${JSON.stringify(chosen)})`}`);
  console.log("\nraw reply  ", JSON.stringify(answer));

  const transcript = join(directory, "pty-output.txt");
  writeFileSync(transcript, raw(), "utf-8");
  console.log("transcript ", transcript);
  console.log("frames     ", tapPath);

  term.kill();
  const pass = asked && rendered && chosen === OPTIONS[1];
  console.log(`\n${pass ? "§五.10 PASSED" : "§五.10 STILL RED"}`);
  if (!pass) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
