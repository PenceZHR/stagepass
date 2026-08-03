/**
 * L4: run one real adversarial round, and let the gate read what it produced.
 *
 *   pnpm verify:round                  run a round in a real Codex TUI
 *   pnpm verify:round --read <thread>  only read a round that already happened
 *
 * The judge is not asked what red and blue said. Their session files are read
 * directly, which is the difference between an adversarial round and a summary
 * of one -- a judge that relayed blue could soften it.
 *
 * What this cannot fake, and therefore what it is for: whether a judge really
 * spawns two sub-agents at the paths it was told to use. Everything else is
 * proved offline in `src/work/round-runner.test.ts`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../src/db/schema";
import { childThreadsOf, readThreadTranscript } from "../src/codex/subagent";
import { CodexTuiTransport } from "../src/codex/tui-transport";
import { ChangeStore } from "../src/store/change-store";
import { GapStore } from "../src/store/gap-store";
import { WorklistStore } from "../src/store/worklist-store";
import { runRound } from "../src/work/round-runner";

/**
 * 一个**固定**的空工作区，不是每次新建的临时目录。
 *
 * Codex 对没见过的目录一律先问一次「要不要信任这个文件夹」，而那是一个**必须有人
 * 按键**的提示 —— 脚本会一直卡在那儿，表现为「裁判没有派生子 Agent」，因为它压根
 * 没开始跑。（`-c projects."<dir>".trust_level` 不生效，trust 也不从父目录继承，
 * 两条都实测过，见 scripts/probe-sandbox.ts。）
 *
 * 每次换一个新目录 = 每次都要人按一次。固定一个路径，就只有**第一次**要人按
 * 「Yes, continue」，之后 Codex 记在 ~/.codex/config.toml 里，再也不问。
 *
 * 目录是空的（每次清内容、保留路径）：指向一个大仓库，模型头几分钟都在读代码而
 * 不是做这一轮；而路径必须稳定，否则信任白给。
 */
function stableWorkspace(name: string): string {
  const dir = join(tmpdir(), name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

const CHANGE = "CHG-ROUND";
const PHASE = "Spec" as const;
const TASK = [
  "为一个「给 Markdown 文件加行内注释」的小工具写一页 Spec。",
  "写清楚：用户能观察到的行为、边界情况、以及验收标准。",
].join("\n");

async function live(): Promise<void> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "stagepass-round-")), "ship.db");
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database).create(CHANGE);

  const gaps = new GapStore(database);
  const transport = new CodexTuiTransport({
    // An empty directory on purpose: pointed at a big repository the model
    // spends the first minutes reading code instead of doing the round.
    cwd: stableWorkspace("stagepass-verify-round-cwd"),
    sandbox: "read-only",
    reasoningEffort: "low",
  });

  console.log("database  ", dbPath);
  console.log("\n一个 Codex TUI 窗口正在打开。裁判会自己派生红蓝两个子 Agent。");
  console.log("不需要你操作，看着就行；跑完这里会打印结果。\n");

  const settled = await runRound(
    { changeId: CHANGE, phase: PHASE, round: 1, task: TASK, judgeThreadId: null },
    {
      transport,
      gaps,
      childThreads: (parentThreadId) => childThreadsOf({ parentThreadId }),
      writeRoundFile: (name, content) => {
        const path = join(mkdtempSync(join(tmpdir(), "stagepass-round-")), name);
        writeFileSync(path, content, "utf-8");
        return path;
      },
      worklist: new WorklistStore(database),
      readThread: (threadId) => readThreadTranscript({ threadId }),
    },
  );

  console.log("judge     ", settled.judgeThreadId);
  console.log("artifacts ", settled.artifactIds.join(", ") || "(none)");
  console.log("\n--- gap 落库了吗（直接读表，不看返回值）---");
  console.log(database.prepare(
    "SELECT id, severity, status, opened_round FROM gaps WHERE change_id = ?",
  ).all(CHANGE));

  console.log("\n--- 闸门看到什么 ---");
  const blockers = gaps.blockers(CHANGE, PHASE);
  console.log("blockers  ", blockers.map((b) => `${b.id}[${b.severity}]`).join(" ") || "(none)");
  console.log(blockers.length > 0
    ? "闸门关着 —— 蓝方找到的问题挡住了它。"
    : "闸门开着 —— 蓝方这一轮没找到问题。");

  database.close();
}

async function main(): Promise<void> {
  /*
   * `--read <judge-thread-id>`（事后翻一轮已经跑过的）**删掉了**。
   *
   * 它建在「从 `agent_path` 认红蓝」上，而那条路已经没了 —— 现在红蓝是裁判在答复里
   * 报出来的（`domain/round.ts` 的 `readAgents`），事后只拿一个裁判线程 id 是复原
   * 不出来的。留一个跑不通的模式，就是这棵树最恨的那种「有标签、执行不了」。
   */
  await live();
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
