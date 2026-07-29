/**
 * The L3 gate: a human answers a StagePass question in the Codex TUI, and the
 * phase moves.
 *
 *   pnpm verify:decision
 *
 * Everything below the question is already accepted, so this seeds a settled
 * phase directly rather than running a real turn -- L2 proved that separately
 * and re-proving it here would only make this slower to run.
 *
 * What it cannot fake, and therefore what it is for: whether the selector
 * actually appears, and whether what you pick reaches the gate.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../src/db/schema";
import { gateDecisionQuestion } from "../src/domain/question";
import { ChangeStore } from "../src/store/change-store";
import { CommandStore } from "../src/store/command-store";
import { EvidenceStore } from "../src/store/evidence-store";
import { QuestionStore } from "../src/store/question-store";

const CHANGE = "CHG-DECIDE";
const QUESTION = "Q-DECIDE";
const REPO = process.cwd();

function seed(database: Database.Database) {
  const changes = new ChangeStore(database);
  changes.create(CHANGE);
  changes.apply(CHANGE, "start");
  changes.apply(CHANGE, "settle");
  new EvidenceStore(database).put(CHANGE, "PRD", {
    artifactIds: ["prd.md"],
    blockers: [{ id: "B-1", severity: "P1", title: "验收标准还不可测" }],
    waivedBlockerIds: ["B-1"],
  });
}

function launch(dbPath: string, questionId: string) {
  const directory = mkdtempSync(join(tmpdir(), "stagepass-decide-"));
  const promptFile = join(directory, "prompt.txt");
  writeFileSync(promptFile, [
    `调用 stagepass_ask 工具一次，questionId 用 "${questionId}"。`,
    "这个工具会把 StagePass 的问题交给我来选。",
    "不要替我做决定，不要解释我该选什么，调用完就停下。",
  ].join("\n"), "utf-8");

  const script = join(directory, "run.sh");
  writeFileSync(script, [
    "#!/bin/zsh",
    "cd /tmp",
    "export LANG=en_US.UTF-8",
    "exec codex \\",
    `  -c 'mcp_servers.stagepass.command="npx"' \\`,
    `  -c 'mcp_servers.stagepass.args=["tsx","${REPO}/src/plugin/server.ts"]' \\`,
    `  -c 'mcp_servers.stagepass.env={STAGEPASS_DB="${dbPath}"}' \\`,
    `  -c 'model_reasoning_effort="low"' \\`,
    "  -s read-only \\",
    `  "$(cat ${promptFile})"`,
    "",
  ].join("\n"), { mode: 0o755 });

  spawn("osascript", [
    "-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`,
    "-e", 'tell application "Terminal" to activate',
  ], { stdio: "ignore", detached: true }).unref();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "stagepass-db-")), "ship.db");
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);

  seed(database);
  const commands = new CommandStore(database);
  const questions = new QuestionStore(database);

  const gate = commands.gateFor(CHANGE);
  const question = gateDecisionQuestion({
    phase: "PRD", gate, summary: "第 1 轮已结算，1 项 P1 已被接受",
  });
  if (!question) throw new Error("the gate offers no decision to ask about");
  questions.ask({
    id: QUESTION, changeId: CHANGE, phase: "PRD", kind: "gate_decision",
    question, expectedSnapshot: gate.snapshot,
  });

  console.log("database  ", dbPath);
  console.log("asking    ", question.message);
  console.log("options   ", question.requestedSchema.properties.decision?.enum?.join(" / "));
  console.log("\n一个 Codex TUI 窗口正在打开。请在里面做出选择。\n");
  launch(dbPath, QUESTION);

  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline && !questions.readAnswerFor(QUESTION)) {
    await sleep(1_000);
  }
  const answer = questions.readAnswerFor(QUESTION);
  if (!answer) throw new Error("no answer arrived within 15 minutes");
  console.log("你选了    ", JSON.stringify(answer));

  const outcome = questions.apply(QUESTION);
  console.log("结果      ", JSON.stringify(outcome));

  console.log("\n--- read back out of the database ---");
  console.log("question  ", database.prepare(
    "SELECT id, kind, status FROM questions WHERE id = ?",
  ).get(QUESTION));
  console.log("answer    ", database.prepare(
    "SELECT question_id, action, content_json FROM answers WHERE question_id = ?",
  ).get(QUESTION));
  console.log("ledger    ", new ChangeStore(database).ledger(CHANGE)
    .map((entry) => `${entry.seq}:${entry.action}`).join(" "));
  console.log("change    ", new ChangeStore(database).read(CHANGE).state);
  database.close();
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
