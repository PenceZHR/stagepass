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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../src/db/schema";
import { applyRound, blockersFrom } from "../src/domain/gap";
import { BLUE, RED, readRound } from "../src/domain/round";
import { createSubAgentLookup, readRoleTranscript } from "../src/codex/subagent";
import { CodexTuiTransport } from "../src/codex/tui-transport";
import { ChangeStore } from "../src/store/change-store";
import { GapStore } from "../src/store/gap-store";
import { runRound } from "../src/work/round-runner";

const CHANGE = "CHG-ROUND";
const PHASE = "Spec" as const;
const TASK = [
  "为一个「给 Markdown 文件加行内注释」的小工具写一页 Spec。",
  "写清楚：用户能观察到的行为、边界情况、以及验收标准。",
].join("\n");

/** The old read-only mode: inspect a round that already ran. */
function readOnly(judgeThreadId: string): void {
  const lookup = createSubAgentLookup();
  const children = lookup.children(judgeThreadId);
  console.log("judge     ", judgeThreadId);
  console.log("spawned   ", children.map((child) => child.agentPath).join(", ") || "(nothing)");
  if (children.length === 0) {
    console.error("\nThat thread spawned no sub-agents; there is no round here to read.");
    process.exit(1);
  }

  const transcript = {
    round: 1,
    red: readRoleTranscript({ lookup, parentThreadId: judgeThreadId, agentPath: RED }),
    blue: readRoleTranscript({ lookup, parentThreadId: judgeThreadId, agentPath: BLUE }),
    judge: "",
  };
  console.log("\n--- 红方，它自己说的 ---\n" + transcript.red.slice(0, 400));
  console.log("\n--- 蓝方，它自己说的（没有经过裁判转述）---\n" + transcript.blue.slice(0, 400));

  const reading = readRound(transcript);
  const gaps = applyRound([], reading.outcome);
  console.log("\n--- 这一轮对 gap 的影响 ---");
  console.log("artifacts ", reading.artifactIds.join(", ") || "(none)");
  console.log("blockers  ", blockersFrom(gaps).map((gap) => `${gap.id}[${gap.severity}]`).join(" ") || "(none)");
}

async function live(): Promise<void> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "stagepass-round-")), "ship.db");
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database).create(CHANGE);

  const gaps = new GapStore(database);
  const lookup = createSubAgentLookup();
  const transport = new CodexTuiTransport({
    // An empty directory on purpose: pointed at a big repository the model
    // spends the first minutes reading code instead of doing the round.
    cwd: mkdtempSync(join(tmpdir(), "stagepass-round-cwd-")),
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
      readRole: (parentThreadId, agentPath) =>
        readRoleTranscript({ lookup, parentThreadId, agentPath }),
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
  const [flag, value] = process.argv.slice(2);
  if (flag === "--read") {
    if (!value) {
      console.error("usage: pnpm verify:round --read <judge-thread-id>");
      process.exit(1);
    }
    readOnly(value);
    return;
  }
  await live();
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
