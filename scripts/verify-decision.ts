/**
 * L3 的闸门：人在 Codex 的选择器里做一个决定，阶段跟着动。
 *
 *   pnpm verify:decision
 *
 * ## 2026-07-29：改成走面板，不再自己开 Terminal
 *
 * 这个脚本原先自己拼一段 osascript 去开 Terminal.app —— 那是**一条平行路径**：
 * 它验的东西和人日常真正会走的那条不是同一条。面板落地之后，日常路径是
 * 「点开阶段 → 请 Codex 问我」，走 `/api/ask`。**验一条没人走的路，验过了也不
 * 说明什么。**
 *
 * 所以现在它做的是：造好一个待裁决的阶段，把面板起在上面，然后等你在面板里按
 * 那个按钮。**同一条代码路径，同一个 pty。**
 *
 * 问题以下的东西早就验收过了，所以这里直接种一个 settled 的阶段而不是真跑一轮 ——
 * L2 单独证过，在这儿再证一遍只会让它更慢。
 *
 * 它证不了、因而正是它存在理由的那件事：**选择器到底画不画得出来，以及你选的东西
 * 到不到得了闸门。**
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../src/db/schema";
import { gateDecisionQuestion } from "../src/domain/question";
import { ChangeStore } from "../src/store/change-store";
import { CommandStore } from "../src/store/command-store";
import { EvidenceStore } from "../src/store/evidence-store";
import { QuestionStore } from "../src/store/question-store";
import { createPanelServer } from "../src/web/panel-server";

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
    blockers: [{ id: "B-1", kind: "finding", severity: "P1", title: "验收标准还不可测" }],
    waivedBlockerIds: ["B-1"],
  });
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

  const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 4178);
  const { server, sessions } = createPanelServer({
    database,
    session: {
      cwd: REPO,
      // 写文件的 turn 在 read-only 下必然停在审批上（PRD §6.6）。这里虽然不跑
      // turn，但保持和 panel.ts 一致，免得下一个人照这里抄。
      sandbox: "workspace-write",
      approval: "on-request",
      reasoningEffort: "low",
    },
  });
  await new Promise<void>((resolve) => { server.listen(port, resolve); });

  console.log("database  ", dbPath);
  console.log("asking    ", question.message);
  console.log("options   ", question.requestedSchema.properties.decision?.enum?.join(" / "));
  console.log(`\n面板已经起在 http://localhost:${port}/?change=${CHANGE}`);
  console.log("请在里面：点 PRD 那个小环 → 按「请 Codex 问我」→ 在 Codex 的选择器里选。");
  console.log("**注意这里种下的题会被面板重新组一道** —— 走的是同一条代码路径，");
  console.log("所以这个脚本等的是「有任何一道题被回答了」，不是等它自己那一道。\n");

  const answered = (): string | null => (database.prepare(
    "SELECT question_id FROM answers ORDER BY answered_at DESC LIMIT 1",
  ).get() as { question_id: string } | undefined)?.question_id ?? null;

  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline && answered() === null) {
    await sleep(1_000);
  }
  const questionId = answered();
  if (questionId === null) throw new Error("十五分钟内没有任何答案到达");
  console.log("你选了    ", JSON.stringify(questions.readAnswerFor(questionId)));

  console.log("\n--- read back out of the database ---");
  console.log("questions ", database.prepare(
    "SELECT id, kind, status FROM questions ORDER BY asked_at",
  ).all());
  console.log("answer    ", database.prepare(
    "SELECT question_id, action, content_json FROM answers WHERE question_id = ?",
  ).get(questionId));
  console.log("ledger    ", new ChangeStore(database).ledger(CHANGE)
    .map((entry) => `${entry.seq}:${entry.action}`).join(" "));
  console.log("change    ", new ChangeStore(database).read(CHANGE).state);

  sessions.closeAll();
  server.close();
  database.close();
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
