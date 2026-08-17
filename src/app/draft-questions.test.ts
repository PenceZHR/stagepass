import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { DRAFTED_OPTIONS } from "../domain/question";
import { createSlotFiles } from "../system/slot-files";
import { QuestionStore } from "../store/question-store";
import { draftQuestions } from "./draft-questions";

const CHANGE = "CHG-1";
const PHASE = "PRD" as const;

function fixture(root: string) {
  const database = new Database(join(root, "panel.db"));
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure("PRJ-A", "p", join(root, "repo"));
  new ChangeStore(database).create(CHANGE, { projectId: "PRJ-A" });
  const files = createSlotFiles({ root: join(root, "rounds") });
  const questions = new QuestionStore(database, () => new Date("2026-08-17T00:00:00.000Z"));
  return { database, files, questions };
}

const withFixture = async (
  body: (f: ReturnType<typeof fixture>) => Promise<void>,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "stagepass-draft-"));
  const f = fixture(root);
  try { await body(f); } finally {
    f.database.close();
    rmSync(root, { recursive: true, force: true });
  }
};

/** 模型这一轮干了什么：把格子填成 entries 里那些。 */
const fillsWith = (
  f: ReturnType<typeof fixture>,
  entries: readonly (readonly [number, string])[],
) => async (): Promise<void> => {
  const path = f.files.pathOf({
    changeId: CHANGE, phase: PHASE, round: 1, role: "blue",
    artifacts: [], shape: { keys: [], required: [] },
  });
  const doc = JSON.parse(readFileSync(path, "utf8"));
  for (const [index, question] of entries) doc.slots[index].question = question;
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
};

describe("Questions the model drafts into a sheet", () => {
  it("lays a sheet, runs one turn, and books what came back", async () => {
    await withFixture(async (f) => {
      let contract = "";
      const result = await draftQuestions({
        ...f, changeId: CHANGE, phase: PHASE, round: 1, expectedSnapshot: "snap",
        runTurn: async (prompt) => {
          contract = prompt;
          await fillsWith(f, [[0, "结算失败时分数保留吗？"], [1, "断线重连要恢复关卡吗？"]])();
        },
      });

      assert.equal(result.ok, true);
      assert.match(contract, /只填值/, "题面里要带格子契约");
      assert.match(contract, /r1-blue\.json/, "题面里要带那份文件的路径");

      assert.notEqual(result.questionId, null);
      const record = f.questions.read(result.questionId!);
      assert.equal(record.kind, "clarification");
      const fields = record.question.requestedSchema.properties;
      assert.deepEqual(Object.keys(fields), ["G-01", "G-02"]);
      assert.match(fields["G-01"]!.title, /结算失败时分数保留吗/);
      assert.deepEqual(fields["G-01"]!.enum, [...DRAFTED_OPTIONS]);
    });
  });

  it("books nothing when the model had nothing to ask", async () => {
    // 一个字都没填是合法状态，不是错误 —— 不该凭空造一道题出来。
    await withFixture(async (f) => {
      const result = await draftQuestions({
        ...f, changeId: CHANGE, phase: PHASE, round: 1, expectedSnapshot: "snap",
        runTurn: async () => {},
      });
      assert.equal(result.ok, true);
      assert.equal(result.questionId, null);
    });
  });

  it("hands back the refusal instead of booking half a sheet", async () => {
    await withFixture(async (f) => {
      const result = await draftQuestions({
        ...f, changeId: CHANGE, phase: PHASE, round: 1, expectedSnapshot: "snap",
        runTurn: async () => {
          const path = f.files.pathOf({
            changeId: CHANGE, phase: PHASE, round: 1, role: "blue",
            artifacts: [], shape: { keys: [], required: [] },
          });
          writeFileSync(path, "{ 这不是 json", "utf8");
        },
      });
      assert.equal(result.ok, false);
      assert.match(result.reason, /JSON/i);
    });
  });

  it("never waits on a live session, because nobody has to be holding a turn", async () => {
    // 旧路要模型挂着一轮把表单端给人，于是有 session_died_before_answering /
    // ask_turn_ended_without_answer 两种死法，而 waitForAnswer 是 1 秒一轮地轮询。
    // 格子文件之后，题落进库里等人，人什么时候答都行 —— 这里问的是「它到底等不等」。
    await withFixture(async (f) => {
      const started = process.hrtime.bigint();
      const result = await draftQuestions({
        ...f, changeId: CHANGE, phase: PHASE, round: 1, expectedSnapshot: "snap",
        runTurn: async () => { await fillsWith(f, [[0, "问一句"]])(); },
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(result.ok, true);
      assert.ok(elapsedMs < 500, `落完题就该回来，实际等了 ${Math.round(elapsedMs)}ms`);
    });

    // 而且这一层压根不认识会话 —— 没有 sessions，就没有「会话死了」这种下场。
    const source = readFileSync(join(process.cwd(), "src/app/draft-questions.ts"), "utf8");
    assert.doesNotMatch(source, /from "\.\/ask-human"|AskSessions/);
  });
});
