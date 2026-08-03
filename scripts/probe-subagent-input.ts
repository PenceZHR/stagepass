/**
 * 这堵墙的边界：**哪些线程会拒绝外部输入？**
 *
 *   node --import tsx scripts/probe-subagent-input.ts
 *
 * 2026-08-03 真机上，StagePass `codex resume` 一条反方子 Agent 线程、补一下回车，
 * Codex 回的是：
 *
 *     ■ This sub-agent is controlled by its parent. Direct input is disabled.
 *
 * 而 2026-07-31 同一个 codex-cli 版本（0.146.0）下，同样用 pty resume 一条子 Agent
 * 线程是**通的**（它正常作答，追加落在自己的 rollout 上）。所以这堵墙不是一直都在，
 * 边界必须问清楚 —— `domain/rubric-round.ts` 的 producer 直连整个建立在这条路上。
 *
 * ## 走 pty，不走 exec
 *
 * 用户明令：StagePass 的每一个 turn 都只走面板里的 Codex TUI，验证性实验也算
 * （2026-07-31）。所以这里用 `node-pty` 起进程 —— 和生产 `PtySession` 同一条路，
 * 只是没有浏览器在另一头。
 *
 * ## 为什么可以读 pty 的字节
 *
 * PRD §9.3 不许 StagePass 解释 pty 的输出。那条约束管的是 `src/` —— 那条路只把
 * 字节转发给浏览器。这个文件是验证脚本，它的全部工作就是看 Codex 画了什么，
 * 而且它不往产品里发任何行为。
 */
import { spawn as ptySpawn } from "node-pty";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 拒绝那句话的原文。认它就是认这堵墙。 */
const REFUSAL = "controlled by its parent";

/** 无害的一句，答完就完，不会去动工作区。 */
const PROMPT = "只回一个数字，别的什么都不要写：1+1 等于几？";

const CWD = process.env.PROBE_CWD
  ?? "/Users/zhanghr/Desktop/stagepass/.stagepass/verification/round-0803/workspace";

interface Subject {
  threadId: string;
  threadSource: string;
  agentPath: string | null;
  parentThreadId: string | null;
  startedAt: string;
  path: string;
}

/** 会话目录下所有 rollout。探针自己走，不逼生产代码为它加导出。 */
function everyRollout(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry);
      if (entry.endsWith(".jsonl")) found.push(path);
      else if (!entry.includes(".") && statSync(path).isDirectory()) walk(path);
    }
  };
  walk(root);
  return found;
}

/** 把会话目录里每条线程的血缘读出来，好解释结果。 */
function subjects(): Subject[] {
  const found: Subject[] = [];
  for (const path of everyRollout(join_home())) {
    // `session_meta` 一定是第一行（2026-08-03 实测），所以不必读整个文件。
    let meta: Record<string, unknown> | undefined;
    try {
      const first = readFileSync(path, "utf-8").split("\n", 1)[0] ?? "";
      const record = JSON.parse(first) as Record<string, unknown>;
      if (record["type"] !== "session_meta") continue;
      meta = record["payload"] as Record<string, unknown>;
    } catch { continue; }
    if (!meta) continue;
    const id = String(meta["id"] ?? "");
    if (!id) continue;
    const source = meta["source"] as Record<string, unknown> | undefined;
    const spawn = (source?.["subagent"] as Record<string, unknown> | undefined)?.["thread_spawn"] as
      Record<string, unknown> | undefined;
    found.push({
      threadId: id,
      threadSource: String(meta["thread_source"] ?? "—"),
      agentPath: (meta["agent_path"] as string | null) ?? null,
      parentThreadId: (spawn?.["parent_thread_id"] as string | null)
        ?? (meta["parent_thread_id"] as string | null) ?? null,
      startedAt: String(meta["timestamp"] ?? ""),
      path,
    });
  }
  return found.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function join_home(): string {
  return `${process.env.HOME ?? ""}/.codex/sessions`;
}

/** 起一个 TUI，投一句话，补一下回车，看它画了什么。 */
async function probe(threadId: string): Promise<{ refused: boolean; screen: string }> {
  const argv = [
    "resume", threadId,
    // read-only：这个探针只想知道输入收不收，不该有能力改任何文件。
    "-s", "read-only",
    "-a", "on-request",
    PROMPT,
  ];
  const child = ptySpawn("codex", argv, {
    name: "xterm-256color", cols: 120, rows: 40, cwd: CWD,
    env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
  });

  let screen = "";
  child.onData((data) => { screen += data; });

  // 让它把 MCP server 起完、把提示词画出来。
  await sleep(20_000);
  // 生产里那一下 nudge 就是这个。
  child.write("\r");
  await sleep(20_000);

  child.kill();
  return { refused: screen.includes(REFUSAL), screen };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

const wanted = process.argv.slice(2).filter((each) => !each.startsWith("--"));
const all = subjects();
const picked = wanted.length > 0
  ? wanted.map((id) => all.find((each) => each.threadId.startsWith(id))).filter(Boolean) as Subject[]
  : all.slice(0, 4);

async function main(): Promise<void> {
  console.log(`会话目录里认出 ${all.length} 条线程，这次探 ${picked.length} 条。cwd=${CWD}\n`);

  for (const subject of picked) {
    console.log(`── ${subject.threadId}`);
    console.log(`   thread_source=${subject.threadSource}  agent_path=${subject.agentPath ?? "—"}`);
    console.log(`   parent=${subject.parentThreadId ?? "—"}  started=${subject.startedAt}`);
    const before = lineCount(subject.path);
    const { refused, screen } = await probe(subject.threadId);
    const after = lineCount(subject.path);
    console.log(`   ⇒ ${refused ? "**拒绝**（controlled by its parent）" : "接受了输入"}`);
    console.log(`   rollout 行数 ${before} → ${after}${after > before ? "  （真的答了）" : ""}`);
    if (!refused && after === before) {
      // 既没拒绝也没作答 —— 第三种情况，要看见它才不会被当成成功。
      console.log(`   ⚠ 既没拒绝也没作答。屏幕尾部：`);
      console.log(`     ${tail(screen)}`);
    }
    console.log();
  }
}

void main();

function lineCount(path: string): number {
  try { return readFileSync(path, "utf-8").split("\n").filter((each) => each.trim()).length; }
  catch { return -1; }
}

function tail(screen: string): string {
  return screen
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "").replace(/\r/g, "\n")
    .split("\n").map((each) => each.trimEnd()).filter((each) => each.trim())
    .slice(-3).join("\n     ");
}
