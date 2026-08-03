import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { standardGapId } from "../domain/rubric-gaps";
import { ScriptedCodexTransport } from "../codex/transport";
import { WorklistStore } from "../store/worklist-store";
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

const RED_THREAD = "T-RED";
const BLUE_THREAD = "T-BLUE";

/** 红蓝各自的 rollout 按线程 id 读；裁判的是 transport 的返回。 */
const roles = (red: string, blue: string) =>
  (threadId: string) => (threadId === RED_THREAD ? red : threadId === BLUE_THREAD ? blue : "");

/**
 * 这一轮派生的两条子 Agent 线程。
 *
 * 裁判**不再报它们的 id**（2026-08-02）—— StagePass 按 rollout 的 `parent_thread_id`
 * 自己认，先出生的是红方。见 docs/DESIGN-no-hand-transcription-2026-08-02.md §三。
 */
const childThreads = () => [RED_THREAD, BLUE_THREAD];

/** 裁判的答复。这里不再需要给它塞两条线程 id。 */
const asJudge = (body: string) => body;

/**
 * 默认：**契约送到了。**
 *
 * 这些用例问的是「模型收到之后怎么答」，不是「转达断没断」。默认成没送到，每一条
 * 漏答的原因都会被写成「契约没送到」—— 那在这些用例里是假话。
 *
 * 名单从 rubric store 现取，所以往 seed 里加一条 criterion 不需要回来改这里。
 */
const deliveredAll = (context: ReturnType<typeof open>) => (): string =>
  (["producer", "critic", "verdict"] as const)
    .flatMap((role) =>
      context.rubrics.effective(PROJECT, CHANGE, "Spec", role)?.criteria ?? [])
    .map((each) => each.key)
    .join(" ");


async function run(context: ReturnType<typeof open>, input: {
  red?: string; blue?: string; judge?: string; round?: number;
  /** 反方那条线程收到过什么。默认：契约送到了。 */
  whole?: () => string;
  /** 补问时反方依次答什么。空 = 补问会把 transport 用光并抛。 */
  again?: (string | Error)[];
  /**
   * 裁判在自己的 turn 里逐条答什么（`stagepass_answer`）。
   *
   * 它那份 rubric 2026-08-02 起走名单，不再写围栏 —— 见
   * docs/DESIGN-no-hand-transcription-2026-08-02.md §四。按顺序给，给多少答多少。
   */
  judgeAnswers?: readonly (readonly [string, string])[];
  /**
   * 反方在 StagePass 单独去问它的那一轮里逐条答什么。
   *
   * 2026-08-03 起 producer 那份也走名单了：不再经裁判转达契约、不再写围栏，
   * 反方**写进答案文件**的那几条，按顺序对应第 1..N 条标准。
   *
   * 形状从「走工具逐条答」变成「写文件」，因为 Codex 禁止外部驱动子 Agent 线程
   * （2026-08-03 实测）—— 见 `blueRubricFiles`。给 `blueRaw` 可以直接指定文件原文，
   * 用来验数不对时整份作废。
   */
  blueAnswers?: readonly (readonly [string, string])[];
  /** 反方写回来的原文。给了它就不看 `blueAnswers`。 */
  blueRaw?: string;
}) {
  const worklist = new WorklistStore(context.db, () => new Date(AT));
  const scripted = new ScriptedCodexTransport([
    asJudge(input.judge ?? '```json\n{"conclusion":{"another_round":false,"reason":"ok"}}\n```'),
    ...(input.again ?? []),
    // 问反方那几轮的返回值没人读（判定从名单里读），但替身得有货可出。
    ...Array.from({ length: 4 }, () => ""),
  ]);
  return runRubricRound({
    projectId: PROJECT, changeId: CHANGE, phase: "Spec",
    round: input.round ?? 1, task: "写 Spec", judgeThreadId: null,
  }, {
    worklist,
    transport: {
      async runTurn(dispatch) {
        const delivery = await scripted.runTurn(dispatch);
        // 裁判在自己的 turn 里调工具 —— 替身也得在同一个位置动手。
        for (const [answer, reason] of input.judgeAnswers ?? []) {
          worklist.answer(CHANGE, answer, reason);
        }
        return delivery;
      },
    },
    gaps: context.gaps,
    rubrics: context.rubrics,
    childThreads,
    writeRoundFile: (name: string) => `/tmp/stagepass-test/${name}`,
    /*
     * 反方写回来的那份。**只有答案文件由测试说了算** —— 标准那份是 StagePass 自己
     * 写的，读它没有意义（真实世界里读它的是反方，不是我们）。
     */
    readRoundFile: (path: string) => (path.includes("rubric-answers-")
      ? input.blueRaw ?? (input.blueAnswers === undefined
        ? null
        : input.blueAnswers
          .map(([verdict, reason], index) => `${index + 1}: ${verdict} —— ${reason}`)
          .join("\n"))
      : null),
    readThread: roles(input.red ?? answer(), input.blue ?? answer()),
    readThreadWhole: input.whole ?? deliveredAll(context),
  });
}

const seedProducer = (context: ReturnType<typeof open>, blocking = true) =>
  context.rubrics.save(
    { projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" },
    [{ text: "每条需求都有可测的验收标准", blocking }],
  );

/**
 * 谁给谁打分。
 *
 * 用户 2026-07-30 拍板：**绝对不能红方自评**，而且所有阶段都改。
 *
 * 依据是实测的：五个阶段跑下来，红方自评累计 20 条**全部 yes，一个 no 都没有** ——
 * 那不是判定，是橡皮图章，和「模型说没问题」是同一件事，正是这个产品存在的理由的反面。
 *
 * 排完之后是一条链，没有人给自己打分：
 *
 *   producer  蓝方判红方   —— 这一轮的产出够不够格
 *   critic    裁判判蓝方   —— 这一轮挑问题挑得怎么样
 *   verdict   谁都不判     —— 交给人（弹窗里对照裁判的表态自己看）
 *
 * **一个参与者只背一份标准**，这不是审美：`readAssessments` 见到 fence 里有不认识的
 * key 会作废整份，所以两份标准塞进同一个人的提示词，两份都会作废。
 */
describe("L5 · 没有人给自己打分", () => {
  const seedCritic = (context: ReturnType<typeof open>) =>
    context.rubrics.save(
      { projectId: PROJECT, changeId: null, phase: "Spec", role: "critic" },
      [{ text: "每条问题都指向正方产出里的具体位置", blocking: true }]);

  it("**producer 的判定读蓝方的话，不读红方的**", async () => {
    const context = open();
    seedProducer(context);
    // 红方给自己打满分，蓝方说不合格。听蓝方的。
    const settled = await run(context, {
      red: answer() + "\n" + rubricBlock(["K1 yes 我写得很好"]),
      blueAnswers: [["no", "第 2 节只写了「要快」"]],
    });
    assert.equal(settled.assessments.producer[0]?.verdict, "no",
      "读的还是红方的自评");
    assert.match(settled.assessments.producer[0]?.evidence ?? "", /要快/);
  });

  it("**谁的提示词里都没有标准了** —— 两份都走名单，不再夹在裁判的提示词里", async () => {
    const context = open();
    seedProducer(context);
    const transport = new ScriptedCodexTransport([asJudge('```json\n{"verdicts":{}}\n```')]);
    await runRubricRound({
      projectId: PROJECT, changeId: CHANGE, phase: "Spec",
      round: 1, task: "写 Spec", judgeThreadId: null,
    }, {
      transport, gaps: context.gaps, rubrics: context.rubrics,
      childThreads,
    writeRoundFile: (name: string) => `/tmp/stagepass-test/${name}`,
    readRoundFile: () => null,
    worklist: new WorklistStore(context.db, () => new Date(AT)),
    readThread: roles(answer(), answer()),
      readThreadWhole: deliveredAll(context),
    });

    // 红方是被判的那个，从来不背标准；而反方那份 2026-08-03 起也不再经裁判转达 ——
    // StagePass 自己 resume 它的线程去问（`askBlueByWorklist`）。所以整份提示词里
    // 一条 criterion 的正文都不该有，一个 ```rubric 围栏也不该有。
    const prompt = transport.dispatches[0]!.prompt;
    assert.doesNotMatch(prompt, /```rubric/, "还在往提示词里塞标准");
    assert.doesNotMatch(prompt, /RBC-/, "还在往提示词里塞 criterion key");
  });

  it("critic 的判定来自裁判 —— 蓝方也不自评", async () => {
    // 裁判那份 2026-08-02 起走名单：它调 stagepass_answer 逐条答，围栏里写什么都不算。
    const context = open();
    seedCritic(context);
    const settled = await run(context, {
      judgeAnswers: [["no", "有两条没指位置"]],
    });
    assert.equal(settled.assessments.critic[0]?.verdict, "no");
    assert.equal(settled.assessments.critic[0]?.evidence, "有两条没指位置");
  });

  it("**verdict 那份不进对抗** —— 谁的提示词里都没有，也不产生判定", async () => {
    const context = open();
    context.rubrics.save(
      { projectId: PROJECT, changeId: null, phase: "Spec", role: "verdict" },
      [{ text: "关闭一个问题必须写清它为什么不再成立", blocking: true }]);

    const transport = new ScriptedCodexTransport([asJudge('```json\n{"verdicts":{}}\n```')]);
    const settled = await runRubricRound({
      projectId: PROJECT, changeId: CHANGE, phase: "Spec",
      round: 1, task: "写 Spec", judgeThreadId: null,
    }, {
      transport, gaps: context.gaps, rubrics: context.rubrics,
      childThreads,
    writeRoundFile: (name: string) => `/tmp/stagepass-test/${name}`,
    readRoundFile: () => null,
    worklist: new WorklistStore(context.db, () => new Date(AT)),
    readThread: roles(answer(), answer()),
      readThreadWhole: deliveredAll(context),
    });

    assert.doesNotMatch(transport.dispatches[0]!.prompt, /```rubric/,
      "verdict 那份被塞给某个模型了 —— 它只该给人看");
    assert.deepEqual(settled.assessments.verdict, []);
    // 也不许因此挂一条挡门的 standard —— 它压根不参与判定。
    assert.deepEqual(settled.gaps, []);
  });
});

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
      blue: answer([{ id: "S-1", severity: "P0", title: "范围冲突" }]),
      blueAnswers: [["no", "第 2 条只写了「要快」"]],
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
      blueAnswers: [["yes", "三条都写了"]],
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



  it("读得懂的一轮 `malformed` 是空的 —— 那条线程要接着用", async () => {
    const context = open();
    seedProducer(context);
    const settled = await run(context, {
      blueAnswers: [["yes", "行"]],
    });
    assert.deepEqual(settled.malformed, []);
  });

  it("不阻断的 criterion 判 no —— 只记录，不挡", async () => {
    const context = open();
    seedProducer(context, false);
    const settled = await run(context, {
      blueAnswers: [["no", "确实没写"]],
    });
    assert.equal(settled.assessments.producer[0]?.verdict, "no");
    assert.deepEqual(settled.gaps, []);
  });

  it("两份标准各判各的 —— 蓝方判红方、裁判判蓝方，互不相干", async () => {
    const context = open();
    seedProducer(context);
    context.rubrics.save(
      { projectId: PROJECT, changeId: null, phase: "Spec", role: "critic" },
      [{ text: "每条问题都指向正方产出里的具体位置", blocking: true }]);

    const settled = await run(context, {
      // 蓝方背 producer 那份（判红方，走围栏），裁判背 critic 那份（判蓝方，走名单）。
      blueAnswers: [["yes", "都写了"]],
      judgeAnswers: [["no", "有两条没指位置"]],
    });

    assert.equal(settled.assessments.producer[0]?.verdict, "yes");
    assert.equal(settled.assessments.critic[0]?.verdict, "no");
    assert.deepEqual(settled.gaps.map((gap) => gap.id), [standardGapId("critic", "K2")]);
  });

  it("下一轮答了 yes —— 上一轮开的 standard 关掉", async () => {
    const context = open();
    seedProducer(context);
    await run(context, { blueAnswers: [["no", "缺"]], round: 1 });
    assert.equal(context.gaps.blockers(CHANGE, "Spec").length, 1);

    const settled = await run(context, {
      blueAnswers: [["yes", "补上了"]], round: 2,
    });
    const standard = settled.gaps.find((gap) => gap.id === standardGapId("producer", "K1"));
    assert.equal(standard?.status, "closed");
    assert.equal(context.gaps.blockers(CHANGE, "Spec").length, 0);
  });

  it("判定按轮存下来了 —— 后面读得到", async () => {
    const context = open();
    seedProducer(context);
    await run(context, { blueAnswers: [["no", "缺"]], round: 3 });

    const stored = context.rubrics.assessments(CHANGE, "Spec", "producer", 3);
    assert.equal(stored[0]?.verdict, "no");
    assert.equal(stored[0]?.blockingThen, true);
    assert.equal(stored[0]?.criterionText, "每条需求都有可测的验收标准");
    assert.equal(context.rubrics.assessments(CHANGE, "Spec", "producer", 4).length, 0);
  });

});

/**
 * 三种失效各自说出是哪一种。
 *
 * **输入取自 2026-07-31 在 `.stagepass/verification/build-0730/panel.db` 和对应
 * rollout 里读到的真实那几轮**，不是编的 —— 编出来的输入证明不了「它挡得住真实
 * 发生过的那次」。见 docs/DESIGN-rubric-delivery-2026-07-31.md §2。
 *
 * 三种今天在库里长得一模一样：`not_assessed` + `evidence` 为 `NULL`。
 */
describe("L5 · 没判上的时候，说清楚是哪一种", () => {
  const seedBoth = (context: ReturnType<typeof open>) => {
    context.rubrics.save(
      { projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" },
      [{ text: "每条需求都有可测的验收标准", blocking: false }]);
    context.rubrics.save(
      { projectId: PROJECT, changeId: null, phase: "Spec", role: "critic" },
      [{ text: "每条问题都指向具体位置", blocking: false }]);
    // producer -> K1（蓝方答），critic -> K2（裁判答）
  };


  it("**它没答就写「它没有作答」** —— 不再有「送没送到」那一层", async () => {
    // 转达链撤掉之后，「契约没送到」这种原因结构上就不存在了：名单是 StagePass
    // 自己开、自己问的。剩下的只有「它没答」和「问它这件事失败了」。
    const context = open();
    seedBoth(context);
    const settled = await run(context, {});
    const evidence = settled.assessments.producer[0]!.evidence ?? "";
    assert.match(evidence, /它没有作答/);
    assert.doesNotMatch(evidence, /送到/);
  });



  it("正常答上的那些，evidence 还是模型写的依据，没被这套话盖掉", async () => {
    const context = open();
    seedBoth(context);
    const settled = await run(context, {
      blueAnswers: [["no", "第 2 节只写了「要快」"]],
    });
    assert.equal(settled.assessments.producer[0]!.evidence, "第 2 节只写了「要快」");
  });



});

describe("L5 · 裁判的结论与反方的整体判断", () => {
  it("两句都读得出来，跟着这一轮交上去", async () => {
    const context = open();
    const settled = await run(context, {
      blue: "```json\n" + JSON.stringify({
        artifactIds: [], blockers: [], overall: "整体够格，边界还差一点",
      }) + "\n```",
      judge: '```json\n{"verdicts":{},"conclusion":{"another_round":true,"reason":"证据还不全"}}\n```',
    });
    assert.deepEqual(settled.conclusion,
      { kind: "advised", anotherRound: true, reason: "证据还不全" });
    assert.equal(settled.blueOverall, "整体够格，边界还差一点");
  });

  it("**哪一句都不动闸门** —— 判了「还要再来一轮」也不多出一条 blocker", async () => {
    const context = open();
    const settled = await run(context, {
      judge: '```json\n{"verdicts":{},"conclusion":{"another_round":true,"reason":"还差得远"}}\n```',
    });
    assert.deepEqual(settled.gaps, []);
    assert.deepEqual(settled.blockers, []);
  });

  it("裁判没给结论 —— null，这一轮照常结算", async () => {
    const context = open();
    const settled = await run(context, { judge: '```json\n{}\n```' });
    assert.equal(settled.conclusion, null);
    assert.equal(settled.blueOverall, null);
  });

  it("**结论写坏了 —— 这一轮照常结算，结论标成读不出来**", async () => {
    const context = open();
    const settled = await run(context, {
      judge: '```json\n{"verdicts":{},"conclusion":{"another_round":"也许"}}\n```',
    });
    assert.equal(settled.conclusion?.kind, "unreadable");
    assert.deepEqual(settled.gaps, []);
  });
});

/**
 * 补问：没答上就直接问反方自己那条线程。
 *
 * 用户 2026-07-31 的三条：**自动接在这一轮里跑完、补到它答上为止（上限 3 次）、
 * 补问本身失败要如实汇报。** 「蓝方一定是要勾的」是硬要求，而契约只能经裁判转达 ——
 * 补问把那条不可靠的链换成直连（2026-07-31 在真 Codex 的 TUI 上验过）。
 */
/**
 * 反方那份标准怎么问到它。
 *
 * 三代了，每一代都是被实测推翻的：
 *
 *   围栏协议    契约夹在裁判提示词里指望它转达，反方写 ```rubric 围栏。
 *               三种断法里两种长在转达链上（2026-08-02）。
 *   直连蓝方    StagePass 自己 resume 反方线程逐条走工具。**Codex 禁止**外部驱动
 *               子 Agent 线程（2026-08-03 实测，`scripts/probe-subagent-input.ts`）。
 *   走文件      现在这一代：StagePass 写一份按 1..N 编号的标准文件，裁判只转达
 *               两个路径，反方把答案写回另一份文件。
 *
 * 第三代保住了前两代各自要的东西：**一个 criterion key 都不经模型的嘴**（第一代的病），
 * 而且**只用父线程这一条还通的通道**（第二代撞的墙）。
 */
describe("L5 · 反方那份标准走文件", () => {
  const seedOne = (context: ReturnType<typeof open>) =>
    context.rubrics.save(
      { projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" },
      [{ text: "每条需求都有可测的验收标准", blocking: false }]);

  it("**答上了就落成真判定，evidence 是它自己写的依据**", async () => {
    const context = open();
    seedOne(context);
    const settled = await run(context, {
      blueAnswers: [["no", "第 2 条只写了「要快」"]],
    });
    assert.equal(settled.assessments.producer[0]?.verdict, "no");
    assert.equal(settled.assessments.producer[0]?.evidence, "第 2 条只写了「要快」");
  });

  it("**文件不在就说文件不在** —— 和「答了但对不上号」不是一件事", async () => {
    const context = open();
    seedOne(context);
    const settled = await run(context, {});   // 反方什么都没写
    assert.equal(settled.assessments.producer[0]?.verdict, "not_assessed");
    assert.match(settled.assessments.producer[0]?.evidence ?? "", /那个文件不在/);
  });

  it("**数不对就整份作废** —— 一条也不采信", async () => {
    const context = open();
    context.rubrics.save(
      { projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" },
      [
        { text: "每条需求都有可测的验收标准", blocking: false },
        { text: "写清楚了这次不做什么", blocking: false },
      ]);
    // 两条标准，它只答了第 1 条 —— 第 2 条要是按位置贴上去就挂错了标准。
    const settled = await run(context, { blueRaw: "1: yes 有的" });
    assert.deepEqual(
      settled.assessments.producer.map((each) => each.verdict),
      ["not_assessed", "not_assessed"],
      "数不对却采信了其中一条 —— 那一条可能挂在错误的标准上",
    );
    assert.match(settled.assessments.producer[0]?.evidence ?? "", /缺了第 2 条/);
  });

  it("**裁判的提示词里一条 criterion key 都没有** —— 只有两个路径", async () => {
    const context = open();
    seedOne(context);
    const key = context.rubrics
      .current({ projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" })!
      .criteria[0]!.key;

    const transport = new ScriptedCodexTransport([
      asJudge('```json\n{"verdicts":{}}\n```'),
      ...Array.from({ length: 8 }, () => ""),
    ]);
    await runRubricRound({
      projectId: PROJECT, changeId: CHANGE, phase: "Spec",
      round: 1, task: "写 Spec", judgeThreadId: null,
    }, {
      transport,
      gaps: context.gaps,
      rubrics: context.rubrics,
      childThreads,
      writeRoundFile: (name: string) => `/tmp/stagepass-test/${name}`,
      readRoundFile: () => null,
      worklist: new WorklistStore(context.db, () => new Date(AT)),
      readThread: roles(answer(), answer()),
      readThreadWhole: deliveredAll(context),
    });

    const prompt = transport.dispatches[0]!.prompt;
    assert.ok(!prompt.includes(key), "criterion key 进了裁判的提示词");
    assert.match(prompt, /rubric-CHG-[^\s]*\.md/, "标准文件的路径没进提示词");
    assert.match(prompt, /rubric-answers-CHG-[^\s]*\.md/, "答案文件的路径没进提示词");
  });

  it("**标准文件按 1..N 编号，key 一个字都不出现**", async () => {
    const context = open();
    seedOne(context);
    const key = context.rubrics
      .current({ projectId: PROJECT, changeId: null, phase: "Spec", role: "producer" })!
      .criteria[0]!.key;

    const written = new Map<string, string>();
    await runRubricRound({
      projectId: PROJECT, changeId: CHANGE, phase: "Spec",
      round: 1, task: "写 Spec", judgeThreadId: null,
    }, {
      transport: new ScriptedCodexTransport([
        asJudge('```json\n{"verdicts":{}}\n```'),
        ...Array.from({ length: 8 }, () => ""),
      ]),
      gaps: context.gaps,
      rubrics: context.rubrics,
      childThreads,
      writeRoundFile: (name: string, content: string) => {
        const path = `/tmp/stagepass-test/${name}`;
        written.set(path, content);
        return path;
      },
      readRoundFile: () => null,
      worklist: new WorklistStore(context.db, () => new Date(AT)),
      readThread: roles(answer(), answer()),
      readThreadWhole: deliveredAll(context),
    });

    const criteria = [...written.entries()]
      .find(([path]) => path.includes("rubric-CHG"))?.[1] ?? "";
    assert.match(criteria, /1\. 每条需求都有可测的验收标准/, "标准正文没按序号写进文件");
    assert.ok(!criteria.includes(key), "criterion key 写进了给模型看的文件");
  });
});