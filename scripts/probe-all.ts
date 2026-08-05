/**
 * 把 Codex 行为契约（docs/CODEX-CONTRACT.md）里**能无人值守验的**一次跑完。
 *
 *   pnpm probe:all
 *
 * ## 什么时候跑
 *
 * Codex 升级之后。2026-08-03 一条假设被 0.146.0 正式版单方面推翻，代价是一套
 * 围栏协议作废加一天排查 —— 这个脚本存在的意义就是把「哪条死了」从一天压到一分钟。
 *
 * ## 为什么不是全部
 *
 * 契约里 12 条，只有一部分能免费、无人值守地验：
 *
 * - **离线的**（C3 血缘继承、C4 session_meta 字段）：扫 `~/.codex/sessions`，零成本。
 * - **起真 Codex 但全自动的**（C6/C12 pty 选择器、C7 零 turn elicitation）：
 *   各一分钟内，不烧 turn。
 * - **要人到场的**（C1 要真子线程、C5 许可框要眼睛看、C8-C11）：这里只打印跑法，
 *   不冒充验过 —— 一个绿灯必须真的意味着验过（证据优先于报告）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS = join(homedir(), ".codex", "sessions");

type Verdict = { contract: string; ok: boolean; detail: string };
const results: Verdict[] = [];

/** 最近的 rollout 文件，按修改时间倒序。 */
function recentRollouts(limit: number): string[] {
  const found: { path: string; mtime: number }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) {
        found.push({ path, mtime: statSync(path).mtimeMs });
      }
    }
  };
  try { walk(SESSIONS); } catch { /* 没有会话目录：下面各条自己报 */ }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.path);
}

const firstLine = (path: string): string => {
  const content = readFileSync(path, "utf-8");
  return content.slice(0, content.indexOf("\n"));
};

// ── C4 · session_meta 里的血缘字段还在不在 ─────────────────────────────
{
  const rollouts = recentRollouts(50);
  const subagents = rollouts.filter((path) =>
    firstLine(path).includes('"thread_source":"subagent"'));
  const withParent = subagents.filter((path) =>
    /"parent_thread_id":"[0-9a-f-]{36}"/.test(firstLine(path)));
  results.push(subagents.length === 0
    ? { contract: "C4 血缘字段", ok: false,
        detail: `最近 ${rollouts.length} 个 rollout 里没有子 Agent —— 验不了，先跑一轮对抗再来` }
    : { contract: "C4 血缘字段", ok: withParent.length === subagents.length,
        detail: `${withParent.length}/${subagents.length} 个子 Agent rollout 带 parent_thread_id` });
}

// ── C3 · 子 Agent 继承父线程历史 ────────────────────────────────────────
{
  const child = recentRollouts(50).find((path) => {
    const head = firstLine(path);
    return head.includes('"thread_source":"subagent"') && head.includes('"forked_from_id"');
  });
  if (child === undefined) {
    results.push({ contract: "C3 继承历史", ok: false,
      detail: "最近的 rollout 里没有带 forked_from_id 的子 Agent —— 验不了" });
  } else {
    // fork 来的历史表现为：文件里有出生之前就存在的 user_message（继承条目）。
    const inherited = readFileSync(child, "utf-8")
      .split("\n").filter((line) => line.includes('"user_message"')).length;
    results.push({ contract: "C3 继承历史", ok: inherited > 0,
      detail: `子 Agent rollout 里有 ${inherited} 条 user_message（0 = fork 变干净了，同阶段 id 稳定性会塌）` });
  }
}

// ── C6/C12 · pty 选择器（起真 Codex，全自动）─────────────────────────────
// ── C7 · 零 turn elicitation ──────────────────────────────────────────
// `--offline` 跳过这两条：它们各要起一个真 Codex（不烧 turn，但要一两分钟）。
const offline = process.argv.includes("--offline");
for (const [contract, script] of offline ? [] : [
  ["C6/C12 pty 选择器", "scripts/probe-pty-elicitation.ts"],
  ["C7 零 turn elicitation", "scripts/probe-elicit-run.ts"],
] as const) {
  try {
    execFileSync("node", ["--import", "tsx", script],
      { stdio: "pipe", timeout: 180_000 });
    results.push({ contract, ok: true, detail: "探针自己的判定全过" });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.slice(0, 120) : String(error);
    results.push({ contract, ok: false, detail: `探针红了：${detail}` });
  }
}

// ── 汇报 ────────────────────────────────────────────────────────────────
console.log("Codex 行为契约 · 无人值守可验的部分（docs/CODEX-CONTRACT.md）\n");
for (const { contract, ok, detail } of results) {
  console.log(`  ${ok ? "✓" : "✗"} ${contract} —— ${detail}`);
}
console.log(`
要人到场的那几条（这里不冒充验过）：
  C1  子线程拒外部输入   pnpm probe:subagent（要一条真子线程的 id）
  C5  许可框每会话一弹    起一轮，看第一次 stagepass_* 调用
  C8  -a never 吃表单     换参数起一个会话即可
  C9  目录信任            未信任目录里跑一次 codex
  C10 归档线程 resume 死  codex archive 后 resume
  C11 子 Agent 继承哪些 MCP  起一轮看反方的工具表
`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
