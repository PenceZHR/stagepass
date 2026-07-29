import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { BLUE, RED } from "../domain/round";
import { standardGapId } from "../domain/rubric-gaps";
import { ScriptedCodexTransport } from "../codex/transport";
import { ChangeStore } from "../store/change-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { RubricStore } from "../store/rubric-store";
import { runRubricRound } from "./rubric-round";

/**
 * L5 offline：一轮对抗 + 三份 rubric 的逐条判定。
 *
 * 唯一还需要真 Codex 的，仍然是 L4 那件事（裁判会不会真的派生两个子 Agent）。
 * rubric 这一层的规则全部可以在这里穷举。
 */

const PROJECT = "PRJ-R";
const CHANGE = "CHG-R";
const AT = "2026-07-29T00:00:00.000Z";

function open() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  new ProjectStore(db).ensure(PROJECT, "p");
  new ChangeStore(db, { now: () => new Date(AT) }).create(CHANGE, { projectId: PROJECT });

  let minted = 0;
  return {
    db,
    gaps: new GapStore(db, () => new Date(AT)),
    rubrics: new RubricStore(db, {
      now: () => new Date(AT), mintKey: () => `K${(minted += 1)}`,
    }),
  };
}

const answer = (blockers: { id: string; severity: string; title: string }[] = []) =>
  "```json\n" + JSON.stringify({ artifactIds: ["spec.md"], blockers }) + "\n```";

const rubricBlock = (lines: string[]) => ["```rubric", ...lines, "```"].join("\n");

/** 红蓝各自的 rollout 由 readRole 提供；裁判的是 transport 的返回。 */
const roles = (red: string, blue: string) =>
  (_thread: string, path: string) => (path === RED ? red : path === BLUE ? blue : "");

async function run(context: ReturnType<typeof open>, input: {
  red?: string; blue?: string; judge?: string; round?: number;
}) {
  return runRubricRound({
    projectId: PROJECT, changeId: CHANGE, phase: "Spec",
    round: input.round ?? 1, task: "写 Spec", judgeThreadId: null,
  }, {
    transport: new ScriptedCodexTransport([
      input.judge ?? '```json\n{"verdicts":{}}\n```',
    ]),
    gaps: context.gaps,
    rubrics: context.rubrics,
    readRole: roles(input.red ?? answer(), input.blue ?? answer()),
  });
}

const seedProducer = (context: ReturnType<typeof open>, blocking = true) =>
  context.rubrics.save(
    { projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" },
    [{ text: "每条需求都有可测的验收标准", blocking }],
  );

describe("L5 · rubric 判定接进一轮对抗", () => {
  it("没有任何 rubric 时，行为和加这套东西之前一样", async () => {
    const context = open();
    const settled = await run(context, {
      blue: answer([{ id: "S-1", severity: "P0", title: "范围冲突" }]),
    });
    assert.deepEqual(settled.gaps.map((gap) => [gap.id, gap.kind]), [["S-1", "finding"]]);
    assert.deepEqual(settled.assessments.producer, []);
  });

  it("正方的 rubric 判 no —— 落一条 standard，和 finding 并存", async () => {
    const context = open();
    seedProducer(context);

    const settled = await run(context, {
      red: answer() + "\n" + rubricBlock(["K1 no 第 2 条只写了「要快」"]),
      blue: answer([{ id: "S-1", severity: "P0", title: "范围冲突" }]),
    });

    const standard = settled.gaps.find((gap) => gap.id === standardGapId("producer", "K1"));
    assert.equal(standard?.kind, "standard");
    assert.equal(standard?.severity, null);
    assert.equal(standard?.status, "open");
    assert.equal(standard?.title, "每条需求都有可测的验收标准");
    // finding 那条没被动过 —— 两套东西并存，不互相吃掉。
    assert.equal(settled.gaps.find((gap) => gap.id === "S-1")?.kind, "finding");
  });

  it("判 yes —— 不落 gap", async () => {
    const context = open();
    seedProducer(context);
    const settled = await run(context, {
      red: answer() + "\n" + rubricBlock(["K1 yes 三条都写了"]),
    });
    assert.deepEqual(settled.gaps, []);
    assert.equal(settled.assessments.producer[0]?.verdict, "yes");
  });

  it("**该答的没答 —— 照样挡住**", async () => {
    const context = open();
    seedProducer(context);
    // 红方压根没写 rubric 块。漏答被静默当成通过，正是这套机制要防的事。
    const settled = await run(context, { red: answer() });
    assert.equal(settled.assessments.producer[0]?.verdict, "not_assessed");
    assert.equal(settled.blockers.length, 1);
  });

  it("**整份判定写坏了 —— fail-closed，不是当作没有 rubric**", async () => {
    const context = open();
    seedProducer(context);
    // 不认识的 key 会让整份作废。若因此跳过 rubric，一份写坏的输出就比一份诚实答
    // no 的输出更容易过闸门 —— 那是这套机制的反面。
    const settled = await run(context, {
      red: answer() + "\n" + rubricBlock(["K1 yes 行", "K-伪造 yes 也行"]),
    });
    assert.equal(settled.assessments.producer[0]?.verdict, "not_assessed");
    assert.match(settled.assessments.producer[0]?.evidence ?? "", /作废/);
    assert.equal(settled.blockers.length, 1, "作废之后闸门必须是关着的");
  });

  it("不阻断的 criterion 判 no —— 只记录，不挡", async () => {
    const context = open();
    seedProducer(context, false);
    const settled = await run(context, {
      red: answer() + "\n" + rubricBlock(["K1 no 确实没写"]),
    });
    assert.equal(settled.assessments.producer[0]?.verdict, "no");
    assert.deepEqual(settled.gaps, []);
  });

  it("三个角色各判各的 —— 红蓝裁判的 rubric 互不相干", async () => {
    const context = open();
    seedProducer(context);
    context.rubrics.save(
      { projectId: PROJECT, changeId: null, phase: "Spec", role: "critic" },
      [{ text: "每条问题都指向正方产出里的具体位置", blocking: true }]);

    const settled = await run(context, {
      red: answer() + "\n" + rubricBlock(["K1 yes 都写了"]),
      blue: answer() + "\n" + rubricBlock(["K2 no 有两条没指位置"]),
    });

    assert.equal(settled.assessments.producer[0]?.verdict, "yes");
    assert.equal(settled.assessments.critic[0]?.verdict, "no");
    assert.deepEqual(settled.gaps.map((gap) => gap.id), [standardGapId("critic", "K2")]);
  });

  it("下一轮答了 yes —— 上一轮开的 standard 关掉", async () => {
    const context = open();
    seedProducer(context);
    await run(context, { red: answer() + "\n" + rubricBlock(["K1 no 缺"]), round: 1 });
    assert.equal(context.gaps.blockers(CHANGE, "Spec").length, 1);

    const settled = await run(context, {
      red: answer() + "\n" + rubricBlock(["K1 yes 补上了"]), round: 2,
    });
    const standard = settled.gaps.find((gap) => gap.id === standardGapId("producer", "K1"));
    assert.equal(standard?.status, "closed");
    assert.equal(context.gaps.blockers(CHANGE, "Spec").length, 0);
  });

  it("判定按轮存下来了 —— 后面读得到", async () => {
    const context = open();
    seedProducer(context);
    await run(context, { red: answer() + "\n" + rubricBlock(["K1 no 缺"]), round: 3 });

    const stored = context.rubrics.assessments(CHANGE, "Spec", "producer", 3);
    assert.equal(stored[0]?.verdict, "no");
    assert.equal(stored[0]?.blockingThen, true);
    assert.equal(stored[0]?.criterionText, "每条需求都有可测的验收标准");
    assert.equal(context.rubrics.assessments(CHANGE, "Spec", "producer", 4).length, 0);
  });

  it("契约进了裁判的提示词 —— 三个角色的 key 都在里面", async () => {
    const context = open();
    seedProducer(context);
    const transport = new ScriptedCodexTransport(['```json\n{"verdicts":{}}\n```']);
    await runRubricRound({
      projectId: PROJECT, changeId: CHANGE, phase: "Spec",
      round: 1, task: "写 Spec", judgeThreadId: null,
    }, {
      transport, gaps: context.gaps, rubrics: context.rubrics,
      readRole: roles(answer(), answer()),
    });

    // 模型答不出它没被问过的题。契约没进提示词，整套就只是在惩罚它不知道的事。
    assert.match(transport.dispatches[0]?.prompt ?? "", /K1/);
    assert.match(transport.dispatches[0]?.prompt ?? "", /每条需求都有可测的验收标准/);
  });
});
