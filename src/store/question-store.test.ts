import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { GateMovedError, type Blocker } from "../domain/gate";
import { gateDecisionQuestion, DECISION_FIELD } from "../domain/question";
import { ChangeStore } from "./change-store";
import { CommandStore } from "./command-store";
import { EvidenceStore } from "./evidence-store";
import {
  QuestionNotFoundError,
  QuestionNotOpenError,
  QuestionStore,
} from "./question-store";

const AT = "2026-07-28T00:00:00.000Z";
const P0: Blocker = { id: "B-1", kind: "finding", severity: "P0", title: "范围冲突" };

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const now = () => new Date(AT);
  const changes = new ChangeStore(database, { now });
  changes.create("CHG-1");
  // A settled PRD with something to show for it: the shape a decision is made in.
  changes.apply("CHG-1", "start");
  changes.apply("CHG-1", "settle");
  const evidence = new EvidenceStore(database, now);
  evidence.put("CHG-1", "PRD", {
    artifactIds: ["prd.md"], blockers: [], waivedBlockerIds: [],
  });
  const commands = new CommandStore(database, now);
  return {
    database, changes, evidence, commands,
    questions: new QuestionStore(database, now),
  };
}

function askAbout(
  commands: CommandStore,
  questions: QuestionStore,
  id = "Q-1",
) {
  const gate = commands.gateFor("CHG-1");
  const question = gateDecisionQuestion({
    phase: "PRD", gate, summary: "第 1 轮已结算",
  })!;
  return questions.ask({
    id, changeId: "CHG-1", phase: "PRD", kind: "gate_decision",
    question, expectedSnapshot: gate.snapshot,
  });
}

describe("L3 · a question, an answer, a state change", () => {
  it("advances the phase when the human approves", async () => {
    const { database, changes, commands, questions } = open();
    try {
      askAbout(commands, questions);
      questions.answer("Q-1", {
        action: "accept", content: { [DECISION_FIELD]: "approve" },
      });
      assert.deepEqual(questions.apply("Q-1"), {
        kind: "advanced", action: "approve",
      });
      assert.equal(changes.read("CHG-1").state.phase, "Spec");
      assert.equal(questions.read("Q-1").status, "applied");
    } finally {
      database.close();
    }
  });

  it("reopens the phase when the human sends it back", () => {
    const { database, changes, commands, questions } = open();
    try {
      askAbout(commands, questions);
      questions.answer("Q-1", {
        action: "accept", content: { [DECISION_FIELD]: "reject" },
      });
      assert.deepEqual(questions.apply("Q-1"), {
        kind: "advanced", action: "reject",
      });
      assert.deepEqual(changes.read("CHG-1").state, {
        phase: "PRD", status: "pending", returnPhase: null,
      });
    } finally {
      database.close();
    }
  });

  /**
   * Measured: pressing Esc returns `{"action":"cancel"}`. It has to land as a
   * decision to not decide -- the phase stays, the record exists, it can be
   * asked again. Treating it as a timeout would turn "I will decide later" into
   * "that round was wasted"; treating it as approval would be worse.
   */
  it("records a decline without moving anything", () => {
    const { database, changes, commands, questions } = open();
    try {
      askAbout(commands, questions);
      questions.answer("Q-1", { action: "cancel" });
      assert.deepEqual(questions.apply("Q-1"), { kind: "declined" });
      assert.deepEqual(changes.read("CHG-1").state, {
        phase: "PRD", status: "settled", returnPhase: null,
      });
      assert.equal(questions.readAnswerFor("Q-1")?.action, "cancel");
      // And it can be put again.
      const again = askAbout(commands, questions, "Q-2");
      assert.equal(again.status, "open");
    } finally {
      database.close();
    }
  });
});

describe("L3 · the fence holds across the time a person takes", () => {
  /**
   * The whole reason the snapshot is stored at the moment of asking. Someone
   * reads, thinks, and answers; if a round landed in between, their approval
   * would otherwise apply to evidence they never saw.
   */
  it("refuses an answer given against evidence that has moved", () => {
    const { database, changes, evidence, commands, questions } = open();
    try {
      askAbout(commands, questions);

      // A later round finds something while the human is deciding.
      evidence.put("CHG-1", "PRD", {
        artifactIds: ["prd.md"], blockers: [P0], waivedBlockerIds: [],
      });

      questions.answer("Q-1", {
        action: "accept", content: { [DECISION_FIELD]: "approve" },
      });
      assert.throws(() => questions.apply("Q-1"), GateMovedError);
      assert.equal(changes.read("CHG-1").state.phase, "PRD");
    } finally {
      database.close();
    }
  });
});

describe("L3 · one Change asks one question at a time", () => {
  /**
   * Two open questions would be two decisions racing for the same gate, and
   * whichever answer landed second would apply against a snapshot its asker
   * never saw.
   */
  it("supersedes the previous question rather than running two", () => {
    const { database, commands, questions } = open();
    try {
      askAbout(commands, questions, "Q-1");
      askAbout(commands, questions, "Q-2");
      assert.equal(questions.read("Q-1").status, "superseded");
      assert.equal(questions.read("Q-2").status, "open");
      assert.equal(questions.open("CHG-1")?.id, "Q-2");
    } finally {
      database.close();
    }
  });

  it("refuses to answer a question that is no longer open", () => {
    const { database, commands, questions } = open();
    try {
      askAbout(commands, questions, "Q-1");
      askAbout(commands, questions, "Q-2");
      assert.throws(
        () => questions.answer("Q-1", { action: "accept", content: {} }),
        QuestionNotOpenError,
      );
    } finally {
      database.close();
    }
  });

  it("refuses to answer the same question twice", () => {
    const { database, commands, questions } = open();
    try {
      askAbout(commands, questions);
      questions.answer("Q-1", {
        action: "accept", content: { [DECISION_FIELD]: "approve" },
      });
      assert.throws(
        () => questions.answer("Q-1", {
          action: "accept", content: { [DECISION_FIELD]: "reject" },
        }),
        QuestionNotOpenError,
      );
    } finally {
      database.close();
    }
  });
});

describe("L3 · the plugin cannot move a gate", () => {
  /**
   * The reason a shared SQLite file is safe where an open HTTP endpoint was
   * not: the plugin's only write is an answer row. `changes` is protected by
   * the ledger trigger, so even a direct attempt aborts.
   */
  it("cannot write a Change even by going straight at the table", () => {
    const { database } = open();
    try {
      assert.throws(
        () => database.prepare(
          "UPDATE changes SET phase = 'Merge', seq = 3 WHERE id = 'CHG-1'",
        ).run(),
        /change_updated_without_ledger_entry/,
      );
    } finally {
      database.close();
    }
  });

  it("cannot answer a question that was never asked", () => {
    const { database, questions } = open();
    try {
      assert.throws(
        () => questions.answer("Q-NOPE", { action: "accept", content: {} }),
        QuestionNotFoundError,
      );
      assert.throws(() => questions.read("Q-NOPE"), QuestionNotFoundError);
      assert.throws(
        () => database.prepare(
          "INSERT INTO answers (question_id, action, content_json, answered_at) VALUES ('Q-NOPE','accept','{}',?)",
        ).run(AT),
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      database.close();
    }
  });
});

describe("L3 · 不推动状态机的答案，fence 也得查", () => {
  /*
   * `apply` 把 fence 交给 command 层查。但接受一条风险不推动状态机、没有 command
   * 可走 —— 那条路要是不显式查一次，「人对着他没看见过的证据做了决定」这条防线
   * 就只覆盖了一半的答案。
   */
  it("证据没动 —— 放行", () => {
    const { commands, questions } = open();
    askAbout(commands, questions);
    assert.doesNotThrow(() => { questions.assertFenceHolds("Q-1"); });
  });

  it("**证据动了 —— 拒绝**", () => {
    const { commands, questions, evidence } = open();
    askAbout(commands, questions);
    // 问出去之后证据变了：闸门读到的东西已经不是他看见的那份。
    evidence.put("CHG-1", "PRD", {
      artifactIds: ["prd.md"], blockers: [P0], waivedBlockerIds: [],
    });
    assert.throws(() => { questions.assertFenceHolds("Q-1"); }, GateMovedError);
  });

  it("settle 把题收掉 —— 否则库里会攒下一批「答过但没人说怎么处理」的行", () => {
    const { database, commands, questions } = open();
    askAbout(commands, questions);
    questions.settle("Q-1");
    assert.equal(
      (database.prepare("SELECT status FROM questions WHERE id = ?").get("Q-1") as
        { status: string }).status,
      "applied");
  });
});
