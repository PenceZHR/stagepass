/**
 * 那一屏 `Error: Operation not permitted (os error 1)` 到底是谁报的。
 *
 *   node --import tsx scripts/probe-pty-eperm.ts <cwd>
 *
 * 用**生产的** `startPtySession` 起一个 Codex（和面板一模一样的路），把它吐出来的
 * 字节原样打出来。面板只把字节转发给浏览器、不解释（PRD §9.3），所以那一屏之外的
 * 上下文在界面上是看不到的 —— 而诊断恰恰需要它。
 *
 * 这个文件是验证脚本，它的全部工作就是看 Codex 画了什么，和 §9.3 管的那条路相反，
 * 而且不往产品里发任何行为。
 */
import { startPtySession } from "../src/web/pty-session";
import { codexArgv } from "../src/codex/invocation";

const cwd = process.argv[2] ?? process.cwd();

// 和面板一模一样：插件也挂上（`pluginConfigFor` 的三条）。
const HERE = `${process.cwd()}/src`;
const DB = process.argv[3] ?? `${process.env.HOME}/.stagepass/panel.db`;
const argv = codexArgv({
  threadId: null,
  sandbox: "workspace-write",
  approval: "on-request",
  reasoningEffort: "xhigh",
  config: [
    `mcp_servers.stagepass.command="npx"`,
    `mcp_servers.stagepass.args=["tsx","${HERE}/plugin/server.ts"]`,
    `mcp_servers.stagepass.env={STAGEPASS_DB="${DB}",STAGEPASS_CHANGE="CHG-001"}`,
  ],
});

console.log(`cwd  = ${cwd}`);
console.log(`argv = ${JSON.stringify(argv)}\n--- 它吐了什么 ---`);

const session = startPtySession({
  changeId: "PROBE",
  phase: "PRD",
  argv,
  options: { cwd },
});

const chunks: Uint8Array[] = [];
session.onBytes((bytes) => { chunks.push(bytes); });
session.onExit((code) => {
  const all = Buffer.concat(chunks.map((each) => Buffer.from(each)));
  console.log(all.toString("utf-8"));
  console.log(`--- exitCode=${code}  共 ${all.length} 字节 ---`);
  process.exit(0);
});

setTimeout(() => {
  const all = Buffer.concat(chunks.map((each) => Buffer.from(each)));
  console.log(all.toString("utf-8").slice(0, 4000));
  console.log(`--- 还活着（没退），共 ${all.length} 字节 ---`);
  session.kill();
  process.exit(0);
}, 12_000);
