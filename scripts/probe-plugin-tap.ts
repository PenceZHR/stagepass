/**
 * A pass-through wrapper around the plugin that writes every JSON-RPC frame to
 * a file. Probe infrastructure only -- nothing imports it from `src/`.
 *
 * Reading a TUI's redraw stream to find out what happened is guesswork: frames
 * overwrite each other and the concatenated bytes show text that was never on
 * screen at the same time. The protocol underneath is not ambiguous, so the
 * probe reads that instead.
 *
 *   STAGEPASS_TAP=/path/to/frames.jsonl tsx scripts/probe-plugin-tap.ts
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Codex runs an MCP server with ITS cwd, not the repo's. Resolving from this
// file's own location is the difference between working and a startup failure
// whose only symptom is "connection closed: initialize response".
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const tap = process.env.STAGEPASS_TAP;
const record = (direction: "client->plugin" | "plugin->client", line: string): void => {
  if (!tap || !line.trim()) return;
  appendFileSync(tap, `${JSON.stringify({ direction, line })}\n`, "utf-8");
};

const child = spawn(
  process.execPath,
  [join(REPO, "node_modules", "tsx", "dist", "cli.mjs"),
    join(REPO, "src", "plugin", "server.ts")],
  { stdio: ["pipe", "pipe", "inherit"], env: process.env },
);

let fromClient = "";
process.stdin.on("data", (chunk: Buffer) => {
  fromClient += chunk.toString("utf-8");
  const lines = fromClient.split("\n");
  fromClient = lines.pop() ?? "";
  for (const line of lines) record("client->plugin", line);
  child.stdin.write(chunk);
});

let fromPlugin = "";
child.stdout.on("data", (chunk: Buffer) => {
  fromPlugin += chunk.toString("utf-8");
  const lines = fromPlugin.split("\n");
  fromPlugin = lines.pop() ?? "";
  for (const line of lines) record("plugin->client", line);
  process.stdout.write(chunk);
});

child.on("exit", (code) => { process.exit(code ?? 0); });
