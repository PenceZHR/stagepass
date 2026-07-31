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

const RED_THREAD = "T-RED";
const BLUE_THREAD = "T-BLUE";

/** 红蓝各自的 rollout 按线程 id 读；裁判的是 transport 的返回。 */
const roles = (red: string, blue: string) =>
  (threadId: string) => (threadId === RED_THREAD ? red : threadId === BLUE_THREAD ? blue : "");

/** 裁判的答复必须带上那两条线程 id，正文才读得到。 */
const asJudge = (body: string) => body.replace(
  '{"verdicts"', `{"agents":{"red":"${RED_THREAD}","blue":"${BLUE_THREAD}"},"verdicts"`);

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

/** 反过来：**契约一个字都没到反方手上**（Review 那一轮的真实情形）。 */
const deliveredNothing = () => "";

async function run(context: ReturnType<typeof open>, input: {
  red?: string; blue?: string; judge?: string; round?: number;
  /** 反方那条线程收到过什么。默认：契约送到了。 */
  whole?: () => string;
}) {
  return runRubricRound({
    projectId: PROJECT, changeId: CHANGE, phase: "Spec",
    round: input.round ?? 1, task: "写 Spec", judgeThreadId: null,
  }, {
    transport: new ScriptedCodexTransport([
      asJudge(input.judge ?? '```json\n{"verdicts":{}}\n```'),
    ]),
    gaps: context.gaps,
    rubrics: context.rubrics,
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
      blue: answer() + "\n" + rubricBlock(["K1 no 第 2 节只写了「要快」"]),
    });
    assert.equal(settled.assessments.producer[0]?.verdict, "no",
      "读的还是红方的自评");
    assert.match(settled.assessments.producer[0]?.evidence ?? "", /要快/);
  });

  it("**红方的提示词里一条标准都没有** —— 它是被判的那个", async () => {
    const context = open();
    seedProducer(context);
    const transport = new ScriptedCodexTransport([asJudge('```json\n{"verdicts":{}}\n```')]);
    await runRubricRound({
      projectId: PROJECT, changeId: CHANGE, phase: "Spec",
      round: 1, task: "写 Spec", judgeThreadId: null,
    }, {
      transport, gaps: context.gaps, rubrics: context.rubrics,
      readThread: roles(answer(), answer()),
      readThreadWhole: deliveredAll(context),
    });

    const prompt = transport.dispatches[0]!.prompt;
    const redSection = prompt.slice(prompt.indexOf(`1. ${RED}`), prompt.indexOf(`2. ${BLUE}`));
    assert.doesNotMatch(redSection, /```rubric/,
      "红方还是拿到了一份标准 —— 它会对着它给自己打分");
    // 而蓝方拿到了，并且被告知判的是谁的活儿。
    const blueSection = prompt.slice(prompt.indexOf(`2. ${BLUE}`));
    assert.match(blueSection, /```rubric/);
    assert.match(blueSection, /正方/, "没告诉蓝方它判的是谁");
  });

  it("critic 的判定读裁判的话 —— 蓝方也不自评", async () => {
    const context = open();
    seedCritic(context);
    const settled = await run(context, {
      blue: answer() + "\n" + rubricBlock(["K1 yes 我挑得很准"]),
      judge: '```json\n{"verdicts":{}}\n```\n' + rubricBlock(["K1 no 有两条没指位置"]),
    });
    assert.equal(settled.assessments.critic[0]?.verdict, "no", "读的还是蓝方的自评");
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
      blue: answer([{ id: "S-1", severity: "P0", title: "范围冲突" }])
        + "\n" + rubricBlock(["K1 no 第 2 条只写了「要快」"]),
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
      blue: answer() + "\n" + rubricBlock(["K1 yes 三条都写了"]),
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
      blue: answer() + "\n" + rubricBlock(["K1 yes 行", "K-伪造 yes 也行"]),
    });
    assert.equal(settled.assessments.producer[0]?.verdict, "not_assessed");
    assert.match(settled.assessments.producer[0]?.evidence ?? "", /作废/);
    assert.equal(settled.blockers.length, 1, "作废之后闸门必须是关着的");
  });

  it("不阻断的 criterion 判 no —— 只记录，不挡", async () => {
    const context = open();
    seedProducer(context, false);
    const settled = await run(context, {
      blue: answer() + "\n" + rubricBlock(["K1 no 确实没写"]),
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
      // 蓝方背 producer 那份（判红方），裁判背 critic 那份（判蓝方）。
      blue: answer() + "\n" + rubricBlock(["K1 yes 都写了"]),
      judge: '```json\n{"verdicts":{}}\n```\n' + rubricBlock(["K2 no 有两条没指位置"]),
    });

    assert.equal(settled.assessments.producer[0]?.verdict, "yes");
    assert.equal(settled.assessments.critic[0]?.verdict, "no");
    assert.deepEqual(settled.gaps.map((gap) => gap.id), [standardGapId("critic", "K2")]);
  });

  it("下一轮答了 yes —— 上一轮开的 standard 关掉", async () => {
    const context = open();
    seedProducer(context);
    await run(context, { blue: answer() + "\n" + rubricBlock(["K1 no 缺"]), round: 1 });
    assert.equal(context.gaps.blockers(CHANGE, "Spec").length, 1);

    const settled = await run(context, {
      blue: answer() + "\n" + rubricBlock(["K1 yes 补上了"]), round: 2,
    });
    const standard = settled.gaps.find((gap) => gap.id === standardGapId("producer", "K1"));
    assert.equal(standard?.status, "closed");
    assert.equal(context.gaps.blockers(CHANGE, "Spec").length, 0);
  });

  it("判定按轮存下来了 —— 后面读得到", async () => {
    const context = open();
    seedProducer(context);
    await run(context, { blue: answer() + "\n" + rubricBlock(["K1 no 缺"]), round: 3 });

    const stored = context.rubrics.assessments(CHANGE, "Spec", "producer", 3);
    assert.equal(stored[0]?.verdict, "no");
    assert.equal(stored[0]?.blockingThen, true);
    assert.equal(stored[0]?.criterionText, "每条需求都有可测的验收标准");
    assert.equal(context.rubrics.assessments(CHANGE, "Spec", "producer", 4).length, 0);
  });

  it("契约进了裁判的提示词 —— 三个角色的 key 都在里面", async () => {
    const context = open();
    seedProducer(context);
    const transport = new ScriptedCodexTransport([asJudge('```json\n{"verdicts":{}}\n```')]);
    await runRubricRound({
      projectId: PROJECT, changeId: CHANGE, phase: "Spec",
      round: 1, task: "写 Spec", judgeThreadId: null,
    }, {
      transport, gaps: context.gaps, rubrics: context.rubrics,
      readThread: roles(answer(), answer()),
      readThreadWhole: deliveredAll(context),
    });

    // 模型答不出它没被问过的题。契约没进提示词，整套就只是在惩罚它不知道的事。
    assert.match(transport.dispatches[0]?.prompt ?? "", /K1/);
    assert.match(transport.dispatches[0]?.prompt ?? "", /每条需求都有可测的验收标准/);
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

  it("**Review 那次：契约没送到反方** —— 不再和「它没作答」混成一句", async () => {
    const context = open();
    seedBoth(context);
    const settled = await run(context, {
      blue: answer(),                 // 反方什么标准都没答
      whole: deliveredNothing,        // 而且它的 rollout 里一个 key 都没有
    });
    const evidence = settled.assessments.producer[0]!.evidence ?? "";
    assert.equal(settled.assessments.producer[0]!.verdict, "not_assessed");
    assert.match(evidence, /没有送到/);
    assert.match(evidence, /裁判没有转达/);
    // 没送到的时候不该再说「它没有作答」—— 那是同义反复。
    assert.doesNotMatch(evidence, /它没有作答/);
  });

  it("**QA 那次：送到了，反方一条没答** —— 和上一条必须分得开", async () => {
    const context = open();
    seedBoth(context);
    const settled = await run(context, { blue: answer() });
    const evidence = settled.assessments.producer[0]!.evidence ?? "";
    assert.match(evidence, /标准送到了/);
    assert.match(evidence, /它没有作答/);
    assert.doesNotMatch(evidence, /没有送到/);
  });

  it("**Retro 那次：反方答的是裁判那一份**（等于给自己打分）", async () => {
    const context = open();
    seedBoth(context);
    const settled = await run(context, {
      // 反方答的 key 是 critic 那份的 K2，而且没包围栏 —— 真实那次就是这样，
      // 于是走「没围栏就捡认识的」那条路，4 行全被静默跳过。
      blue: answer() + "\nK2 yes 我挑的问题都指向了具体位置",
    });
    const evidence = settled.assessments.producer[0]!.evidence ?? "";
    assert.match(evidence, /它答的是另一份标准/);
    assert.doesNotMatch(evidence, /它没有作答/);
  });

  it("**Review 那次的另一半：裁判把反方那份也答了** —— 记下来，但不采信", async () => {
    const context = open();
    seedBoth(context);
    const settled = await run(context, {
      blue: answer(),                                       // 反方没答
      judge: '```json\n{"verdicts":{}}\n```\n'
        + rubricBlock(["K1 no 需求没有可测的验收标准", "K2 yes 问题都指了位置"]),
    });

    // 裁判本职那一条照常读出来 —— 这就是不再连坐作废。
    assert.equal(settled.assessments.critic[0]!.verdict, "yes");
    // 而它替反方答的那一条不算数，但人看得见是谁答的。
    const producer = settled.assessments.producer[0]!;
    assert.equal(producer.verdict, "not_assessed", "裁判代答的被采信了");
    assert.match(producer.evidence ?? "", /由裁判作答/);
    assert.match(producer.evidence ?? "", /不采信/);
  });

  it("正常答上的那些，evidence 还是模型写的依据，没被这套话盖掉", async () => {
    const context = open();
    seedBoth(context);
    const settled = await run(context, {
      blue: answer() + "\n" + rubricBlock(["K1 no 第 2 节只写了「要快」"]),
    });
    assert.equal(settled.assessments.producer[0]!.evidence, "第 2 节只写了「要快」");
  });

  it("**整份作废那一种保留它自己的原因** —— 那是另一件事，不许被送达情况盖掉", async () => {
    const context = open();
    seedBoth(context);
    const settled = await run(context, {
      // 围栏里一个谁都不认识的 key：凭空多答，仍然作废整份。
      blue: answer() + "\n" + rubricBlock(["K1 yes 好", "K-凭空 yes 编的"]),
    });
    const evidence = settled.assessments.producer[0]!.evidence ?? "";
    assert.match(evidence, /整份判定作废/);
    assert.doesNotMatch(evidence, /送到/);
  });

  it("**裁判那一份不查送达** —— 它的提示词是 StagePass 自己写的", async () => {
    const context = open();
    seedBoth(context);
    const settled = await run(context, { whole: deliveredNothing });
    // 反方那份说没送到；裁判那份一个字都不该提送达。
    assert.match(settled.assessments.producer[0]!.evidence ?? "", /没有送到/);
    assert.doesNotMatch(settled.assessments.critic[0]!.evidence ?? "", /送到/);
  });

  it("**读不到 rollout 时说「没作答」，不说「没送到」** —— 查不出来不等于没送到", async () => {
    const context = open();
    seedBoth(context);
    const settled = await run(context, {
      blue: answer(),
      whole: () => { throw new Error("rollout 找不到"); },
    });
    const evidence = settled.assessments.producer[0]!.evidence ?? "";
    assert.equal(settled.assessments.producer[0]!.verdict, "not_assessed");
    assert.doesNotMatch(evidence, /送到/, "把「查不出来」说成了「没送到」");
    assert.match(evidence, /它没有作答/);
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
    const settled = await run(context, {});
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
