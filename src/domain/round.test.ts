import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Gap } from "./gap";
import { BLUE, judgePrompt, readRound, readVerdicts, RED, UnreadableVerdictError } from "./round";
import { TurnResultUnparsableError } from "./turn";

const answer = (artifacts: string[], blockers: object[] = []) =>
  "```json\n" + JSON.stringify({ artifactIds: artifacts, blockers }) + "\n```";

const gap = (id: string, title: string): Gap => ({
  id, kind: "finding", severity: "P1", title, status: "open", openedRound: 1,
  resolution: null, note: null,
});

describe("L4 · what the judge is told", () => {
  it("names both roles by their exact paths", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "写出 Spec", openGaps: [],
    });
    assert.match(prompt, new RegExp(`"${RED}"`));
    assert.match(prompt, new RegExp(`"${BLUE}"`));
    assert.match(prompt, /Spec/);
    assert.match(prompt, /第 2 轮/);
  });

  it("carries the result contract to both roles", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 1, task: "写出 Spec", openGaps: [],
    });
    assert.match(prompt, /artifactIds/);
    assert.match(prompt, /P0\|P1\|P2/);
  });

  it("lists the open problems the judge must rule on", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 3, task: "t",
      openGaps: [gap("SPEC-1", "范围与 PRD 冲突"), gap("SPEC-2", "验收不可测")],
    });
    assert.match(prompt, /SPEC-1 \[P1\] 范围与 PRD 冲突/);
    assert.match(prompt, /SPEC-2 \[P1\] 验收不可测/);
  });

  /**
   * The rule has to reach the judge, not just the code. A judge that believes
   * silence closes a problem will close problems by staying quiet.
   */
  it("tells the judge that silence keeps a problem open", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "t", openGaps: [gap("SPEC-1", "x")],
    });
    assert.match(prompt, /沉默等于仍然存在/);
  });

  /**
   * Blue investigating the repository turns an attack on the artifact into an
   * investigation of something else, and the gap it reports stops being about
   * the document under review.
   */
  it("tells blue to attack the artifact and nothing else", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 1, task: "t", openGaps: [],
    });
    assert.match(prompt, /只许基于正方产出提出问题/);
    assert.match(prompt, /不要去读仓库/);
  });

  it("says nothing to rule on when nothing is open", () => {
    assert.match(
      judgePrompt({ phase: "PRD", round: 1, task: "t", openGaps: [] }),
      /没有未关闭的问题/,
    );
  });

  /**
   * 一条 `standard` 没有 severity（rubric 是二元判断，REMAP §5.1）。原来无条件插
   * `[${gap.severity}]`，于是每条 rubric 派生的 gap 在裁判眼里都是 `[null]` ——
   * 一个模型看不懂的分级，而它正要对这条表态。
   */
  it("一条 standard 写「标准」，不写 [null]", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "t",
      openGaps: [{
        id: "RB:producer:RBC-a", kind: "standard", severity: null,
        title: "每条需求都有可测的验收标准",
        status: "open", openedRound: 1, resolution: null, note: null,
      }],
    });
    assert.match(prompt, /RB:producer:RBC-a \[标准\]/);
    assert.doesNotMatch(prompt, /\[null\]/);
  });
});

describe("L4 · 裁判必须先跑完正方再派反方", () => {
  /**
   * 2026-07-30 在真 Codex 上撞到的：裁判**把红蓝并行跑了**，它自己的原话是
   * 「反方先因并行时尚未拿到正方产出而无法评估」—— 蓝方审了个空气，然后裁判
   * 自己替两边编了答案交上来。
   *
   * 提示词原来只靠编号 1./2. 和「读正方产出」暗示顺序，那不够。
   */
  it("**说明白：先跑完正方，拿到产出，再派反方**", () => {
    const prompt = judgePrompt({ phase: "Spec", round: 1, task: "t", openGaps: [] });
    assert.match(prompt, /不要并行|先.*正方.*再.*反方/, "没说顺序，裁判会并行跑");
    assert.match(prompt, /拿到正方的产出/, "没说反方要拿着正方的产出才开始");
  });

  /**
   * 同一次里的另一半：两个子 Agent **派生出来了，但 `agent_path` 是空的** ——
   * 裁判把 `/root/red` 当成了「工作路径标识」（它自己的原话）。StagePass 于是
   * 找不到它们，大声失败（这是对的），但一轮白烧。
   */
  it("**点名那个工具和那个参数** —— 另一个入口设不上 task_name", () => {
    /*
     * 2026-07-30 实测出来的真相：有两个派生入口，只有一个设得上 agent_path。
     *
     *   原生 spawn_agent({task_name:"red"})          -> agent_path = /root/red  ✓
     *   exec 里的 multi_agent_v1__spawn_agent({...})  -> agent_path 是空的       ✗
     *
     * 提示词原来只说「路径必须精确是 /root/red」，裁判自己去 ALL_TOOLS 里找，
     * 找到了后者，于是两轮 Review 白烧。说清楚工具名和参数名，别让它猜。
     */
    const prompt = judgePrompt({ phase: "Spec", round: 1, task: "t", openGaps: [] });
    assert.match(prompt, /spawn_agent/, "没点名工具");
    assert.match(prompt, /task_name/, "没点名那个参数 —— 换个入口就设不上");
    assert.match(prompt, /multi_agent_v1/, "没说清哪条路是错的");
  });
});

describe("L4 · Review 里红方找到的缺陷也算数", () => {
  /**
   * 「红方报的问题一概不算」这条规矩有它的理由 —— **产出者报告自己作品的问题不是
   * 对抗性发现**，让红方决定自己的东西有多糟，正是蓝方存在的原因。
   *
   * **到 Review 这条理由不成立了**：红方审的不是自己的作品，是 Build 的产出。而
   * Review 的活儿**就是**找缺陷，照旧丢掉等于这个阶段什么都不产出（用户 2026-07-30
   * 拍板：Review 破例）。
   *
   * 破例只给 Review。QA 看着像同类，但它没被谈过 —— **保守是因为没谈，不是因为
   * 想清楚了**，所以下面有一条守卫钉着它。
   */
  const red = (blockers: object[]) =>
    "```json\n" + JSON.stringify({ artifactIds: ["review.md"], blockers }) + "\n```";

  it("**Review：红方报的缺陷进 gaps**", () => {
    const reading = readRound({
      phase: "Review", round: 1,
      red: red([{ id: "RV-1", severity: "P0", title: "空指针没处理" }]),
      blue: answer([], [{ id: "RVB-1", severity: "P1", title: "你漏了错误路径" }]),
      judge: '```json\n{"verdicts":{}}\n```',
    });
    assert.deepEqual(
      reading.outcome.found.map((each) => each.id).sort(),
      ["RV-1", "RVB-1"],
      "红方的发现被丢了 —— 那正是 Review 唯一的产出",
    );
  });

  it("设计阶段照旧：红方报自己的问题一概不算", () => {
    const reading = readRound({
      phase: "Spec", round: 1,
      red: red([{ id: "SELF-1", severity: "P0", title: "我自己觉得这里不太好" }]),
      blue: answer([], [{ id: "S-1", severity: "P1", title: "验收不可测" }]),
      judge: '```json\n{"verdicts":{}}\n```',
    });
    assert.deepEqual(reading.outcome.found.map((each) => each.id), ["S-1"]);
  });

  it("**Build 也照旧** —— 红方写的代码是它自己的作品", () => {
    const reading = readRound({
      phase: "Build", round: 1,
      red: red([{ id: "SELF-1", severity: "P0", title: "我知道这里有问题" }]),
      blue: answer([], []),
      judge: '```json\n{"verdicts":{}}\n```',
    });
    assert.deepEqual(reading.outcome.found, []);
  });

  it("**QA 没被谈过，一律不动** —— 保守是因为没谈，不是因为想清楚了", () => {
    const reading = readRound({
      phase: "QA", round: 1,
      red: red([{ id: "QA-1", severity: "P0", title: "第 3 条用例挂了" }]),
      blue: answer([], []),
      judge: '```json\n{"verdicts":{}}\n```',
    });
    assert.deepEqual(reading.outcome.found, [],
      "QA 被顺手改了 —— 它的形状还没谈过");
  });

  it("**提示词里给两边分了 id 前缀** —— 让它压根不该撞", () => {
    // Review 里红蓝都在报缺陷，共用一个 id 空间。撞了就只能留一条（下面那条测试），
    // 而「留哪一条」永远是个将就。分前缀让这件事结构上不会发生。
    const prompt = judgePrompt({ phase: "Review", round: 1, task: "t", openGaps: [] });
    const redSection = prompt.slice(prompt.indexOf(`1. ${RED}`), prompt.indexOf(`2. ${BLUE}`));
    const blueSection = prompt.slice(prompt.indexOf(`2. ${BLUE}`));
    assert.match(redSection, /RV-/, "没告诉红方它的 id 前缀");
    assert.match(blueSection, /RVB-/, "没告诉蓝方它的 id 前缀");
  });

  it("设计阶段不提前缀 —— 那儿只有蓝方报问题", () => {
    const prompt = judgePrompt({ phase: "Spec", round: 1, task: "t", openGaps: [] });
    const redSection = prompt.slice(prompt.indexOf(`1. ${RED}`), prompt.indexOf(`2. ${BLUE}`));
    assert.doesNotMatch(redSection, /RV-/, "给红方讲了一套它用不上的规矩");
  });

  it("两边报了同一个 id —— 不许悄悄吃掉一条", () => {
    // 两边都在审同一份代码，撞 id 是真会发生的。撞了就是同一条问题的两种说法，
    // 而 applyRound 按 id 去重 —— 后来那条会被静默丢掉。所以提示词里给两边分了
    // 前缀（见 judgePrompt），这里钉住「撞了也不会多出一条假的」。
    const reading = readRound({
      phase: "Review", round: 1,
      red: red([{ id: "RV-1", severity: "P0", title: "红方这么说" }]),
      blue: answer([], [{ id: "RV-1", severity: "P1", title: "蓝方那么说" }]),
      judge: '```json\n{"verdicts":{}}\n```',
    });
    assert.equal(reading.outcome.found.filter((e) => e.id === "RV-1").length, 1);
  });
});

describe("L4 · 蓝方的规矩按阶段定", () => {
  /**
   * 「只许基于正方产出、不要去读仓库」原来是写死的一句，五个设计阶段共用。
   *
   * 在设计阶段它是对的，而且是必须的：不然「攻击这份 PRD」会滑成「调查这个项目」，
   * 蓝方翻一遍仓库报回来一堆和这份文档无关的毛病，而闸门会拿它们挡住一个本该放行
   * 的阶段。
   *
   * **到 Build 它变成错的** —— 正方的产出就是仓库，那句话等于叫蓝方闭着眼睛审代码。
   * 用户 2026-07-30 定：能读这一轮改动涉及的文件和它们的直接调用方，但不自己执行；
   * 「跑过没有」这类标准由红方交运行证据。范围有界，才不会滑回「调查这个项目」。
   */
  it("设计阶段：不许读仓库", () => {
    for (const phase of ["PRD", "Spec", "TechSpec", "Plan", "TestPlan"] as const) {
      const prompt = judgePrompt({ phase, round: 1, task: "t", openGaps: [] });
      assert.match(prompt, /不要去读仓库/, `${phase} 放开了蓝方`);
    }
  });

  it("**Build：能读改动涉及的代码，但有边界，而且不自己跑**", () => {
    const prompt = judgePrompt({ phase: "Build", round: 1, task: "t", openGaps: [] });
    assert.doesNotMatch(prompt, /不要去读仓库/,
      "Build 还在叫蓝方闭着眼睛审代码");
    assert.match(prompt, /改动/, "没告诉蓝方读什么");
    assert.match(prompt, /调用方/, "范围没说到直接调用方");
    assert.match(prompt, /不要自己(执行|跑)/, "没拦住蓝方自己跑东西");
  });

  it("**Review：和红方一样能读被审的那个 commit**", () => {
    /*
     * Review 的对象就是代码。蓝方不读代码，就只能看着红方的 review 报告自说自话 ——
     * 而它的活儿正是「你漏了什么、这条成不成立」，那要自己去看才答得出来
     * （用户 2026-07-30 拍板）。
     */
    const prompt = judgePrompt({ phase: "Review", round: 1, task: "t", openGaps: [] });
    assert.doesNotMatch(prompt, /不要去读仓库/, "Review 的蓝方还看不见代码");
    assert.match(prompt, /commit/, "没说读的是被审的那个 commit");
    assert.match(prompt, /不要自己(执行|跑)/, "没拦住蓝方自己跑东西");
  });

  it("没谈过的阶段一律不动 —— 保守是因为没谈，不是因为想清楚了", () => {
    // QA / Fix / Merge / Retro 的形状都还没谈过。
    for (const phase of ["QA", "Fix", "Merge", "Retro"] as const) {
      const prompt = judgePrompt({ phase, round: 1, task: "t", openGaps: [] });
      assert.match(prompt, /不要去读仓库/, `${phase} 被顺手改了，而它没被谈过`);
    }
  });
});

describe("L4 · 红方看得到上一轮被挑出了什么", () => {
  /**
   * 「红方根据蓝方的判断修正」在这之前**没有载体**：open gap 只送进裁判那一区，
   * 红方拿到的只有阶段指令 + 需求 + 上游文档。于是它每一轮都是从零重写，而不是
   * 照着意见改 —— 2026-07-30 CHG-002 那次续跑就是这样：人在选择器里逐条写了意见，
   * 那些话进了 gap 的 note，红方一个字都没看到。
   *
   * 裁判仍然要拿到同一份名单，但两边的指令不同：红方是「去改」，裁判是「表态」。
   */
  it("上一轮的问题也送到红方那一区", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "写出 Spec",
      openGaps: [gap("SPEC-1", "验收标准不可测")],
    });
    // 用编号锚点切，不用裸路径 —— 开头那行「路径必须精确是 …」里两个路径都出现过，
    // 拿 indexOf(RED) 切出来的是那一行的中间十几个字符，任何断言都会假红。
    const redSection = prompt.slice(prompt.indexOf(`1. ${RED}`), prompt.indexOf(`2. ${BLUE}`));
    assert.match(redSection, /SPEC-1/, "红方那一区没有上一轮的问题");
    assert.match(redSection, /验收标准不可测/);
  });

  it("**人自己说的那句话跟着送到红方**", () => {
    // 人的原话是这一整套里分量最重的输入。它进了库却到不了动手的那个人手上，
    // 等于没记。
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "t",
      openGaps: [{
        ...gap("SPEC-1", "验收标准不可测"),
        note: "把那个同步接口整段删掉，不要留占位",
      }],
    });
    // 用编号锚点切，不用裸路径 —— 开头那行「路径必须精确是 …」里两个路径都出现过，
    // 拿 indexOf(RED) 切出来的是那一行的中间十几个字符，任何断言都会假红。
    const redSection = prompt.slice(prompt.indexOf(`1. ${RED}`), prompt.indexOf(`2. ${BLUE}`));
    assert.match(redSection, /把那个同步接口整段删掉/);
  });

  it("第一轮没有任何问题时，红方那一区不出现空名单", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 1, task: "写出 Spec", openGaps: [],
    });
    // 用编号锚点切，不用裸路径 —— 开头那行「路径必须精确是 …」里两个路径都出现过，
    // 拿 indexOf(RED) 切出来的是那一行的中间十几个字符，任何断言都会假红。
    const redSection = prompt.slice(prompt.indexOf(`1. ${RED}`), prompt.indexOf(`2. ${BLUE}`));
    assert.doesNotMatch(redSection, /上一轮/,
      "没有上一轮却提上一轮，模型会去找不存在的东西");
  });

  it("裁判那一份没被拿走 —— 两边都要有，指令不同", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "t", openGaps: [gap("SPEC-1", "x")],
    });
    const judgeSection = prompt.slice(prompt.indexOf("轮到你"));
    assert.match(judgeSection, /SPEC-1/, "裁判那一区的名单丢了");
    assert.match(judgeSection, /沉默等于仍然存在/);
  });
});

describe("L4 · 人提的要求单独一区", () => {
  /*
   * 用户 2026-07-30：「judgePrompt 把人开的那些单独列出来，措辞要区别于模型报的。」
   *
   * 混在一起列，「用户明确要求的」和「反方顺口提的」在裁判眼里一模一样 —— 而分量
   * 不一样：判一条模型报的问题不成立是裁判的本职；一条人提的要求，它不该拿「我觉得
   * 这个建议可以不采纳」把它关掉。
   */
  const human = (id: string, title: string): Gap => ({ ...gap(id, title) });

  it("分区，而且措辞明确说了它不是建议", () => {
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t",
      openGaps: [
        gap("SPEC-1", "验收不可测"),
        human("HUMAN-1", "没说清楚失败时回滚到哪"),
      ],
    });
    assert.match(prompt, /人明确要求下一轮处理的（不许当成建议）/);
    assert.match(prompt, /HUMAN-1 \[P1\] 没说清楚失败时回滚到哪/);
    assert.match(prompt, /之前轮次报出来的问题/);
    // 人提的排在模型报的前面 —— 先看要求，再看建议。
    assert.ok(prompt.indexOf("HUMAN-1") < prompt.indexOf("SPEC-1"));
  });

  it("没有人提的问题时**不出现那一区**，也不留一段空白", () => {
    // 提示词里一段没内容的标题是噪音，而噪音会挤掉真正要读的东西。
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t", openGaps: [gap("SPEC-1", "验收不可测")],
    });
    assert.doesNotMatch(prompt, /人明确要求/);
    // 只有模型报的那些时也不加那句分隔标题 —— 没有第二区要跟它分开。
    assert.doesNotMatch(prompt, /之前轮次报出来的问题/);
    assert.match(prompt, /SPEC-1 \[P1\] 验收不可测/);
  });

  it("只有人提的问题时，模型那一区也不出现", () => {
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t", openGaps: [human("HUMAN-1", "我要的")],
    });
    assert.match(prompt, /人明确要求下一轮处理的/);
    assert.doesNotMatch(prompt, /之前轮次报出来的问题/);
    assert.doesNotMatch(prompt, /没有未关闭的问题/);
  });

  it("**人对某一条说的话跟着它进提示词**", () => {
    // 这是「我的话进下一轮」那条的落点。不带上它，人在选择器里逐条写的东西就只存在
    // 于库里，红方下一轮照样不知道他要什么。
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t",
      openGaps: [{ ...gap("SPEC-1", "验收不可测"), note: "按第 3 节那种写法逐条写" }],
    });
    assert.match(prompt, /人说：按第 3 节那种写法逐条写/);
  });

  it("**仍然可以被判 closed** —— 这里管的是措辞，不是给它免疫", () => {
    // 人的要求真被满足了就该关掉。加一层「人提的不可关闭」等于让人给自己设一道
    // 自己也打不开的闸门。
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t", openGaps: [human("HUMAN-1", "我要的")],
    });
    assert.match(prompt, /"kind": "closed" \| "still_open"/);
  });
});

describe("L4 · reading the judge's verdicts", () => {
  it("reads a verdict on each named problem", () => {
    assert.deepEqual(readVerdicts(
      '```json\n{"verdicts":{"SPEC-1":{"kind":"closed","reason":"范围已收窄"},'
      + '"SPEC-2":{"kind":"still_open","reason":"仍不可测"}}}\n```',
    ), {
      verdicts: {
        "SPEC-1": { kind: "closed", reason: "范围已收窄" },
        "SPEC-2": { kind: "still_open", reason: "仍不可测" },
      },
    });
  });

  /**
   * A judge that said nothing readable has ruled on nothing, and every open gap
   * stays open. That is the safe direction, so it is not an error.
   */
  it("yields no verdicts when the judge said nothing readable", () => {
    for (const text of ["都挺好的", "```json\n{}\n```", '{"verdicts":null}']) {
      assert.deepEqual(readVerdicts(text), { verdicts: {} });
    }
  });

  /**
   * But a malformed verdict IS refused: dropping it silently would look exactly
   * like the judge having stayed quiet, and those two must not be confusable.
   */
  it("refuses a verdict that claims to be one and is not", () => {
    for (const bad of [
      '{"verdicts":{"G-1":{"kind":"maybe","reason":"r"}}}',
      '{"verdicts":{"G-1":{"kind":"closed"}}}',
      '{"verdicts":{"G-1":{"kind":"closed","reason":"  "}}}',
      '{"verdicts":[]}',
    ]) {
      assert.throws(() => readVerdicts(bad), UnreadableVerdictError, bad);
    }
  });
});

describe("L4 · each role is read from its own transcript", () => {
  it("takes artifacts from red and problems from blue", () => {
    const reading = readRound({
      phase: "Spec",
      round: 2,
      red: answer(["spec.md"]),
      blue: answer([], [{ id: "SPEC-9", severity: "P0", title: "范围冲突" }]),
      judge: '```json\n{"verdicts":{}}\n```',
    });
    assert.deepEqual(reading.artifactIds, ["spec.md"]);
    assert.deepEqual(reading.outcome.found, [
      { id: "SPEC-9", severity: "P0", title: "范围冲突" },
    ]);
    assert.equal(reading.outcome.round, 2);
  });

  /**
   * A producer grading its own work is not an adversarial finding. Counting
   * red's blockers would let it decide how bad its own output is, which is
   * blue's job precisely because red cannot do it.
   */
  it("ignores problems red reported about its own work", () => {
    const reading = readRound({
      phase: "Spec",
      round: 1,
      red: answer(["spec.md"], [{ id: "RED-SELF", kind: "finding", severity: "P0", title: "我觉得还行" }]),
      blue: answer([], []),
      judge: "",
    });
    assert.deepEqual(reading.outcome.found, []);
  });

  /**
   * A blue that answered in the wrong shape found nothing StagePass can act on.
   * Reading that as "no problems" would turn a broken attacker into a clean
   * bill of health.
   */
  it("fails the round when blue's answer cannot be read", () => {
    assert.throws(
      () => readRound({
        phase: "Spec",
        round: 1, red: answer(["spec.md"]), blue: "看起来没问题", judge: "",
      }),
      (error: unknown) =>
        error instanceof TurnResultUnparsableError
        && error.detail.startsWith("blue:"),
    );
  });

  it("fails the round when red produced nothing readable", () => {
    assert.throws(
      () => readRound({ phase: "Spec", round: 1, red: "写完了", blue: answer([]), judge: "" }),
      TurnResultUnparsableError,
    );
  });

  it("carries the judge's verdicts into the round's outcome", () => {
    const reading = readRound({
      phase: "Spec",
      round: 3,
      red: answer(["spec.md"]),
      blue: answer([]),
      judge: '```json\n{"verdicts":{"SPEC-1":{"kind":"closed","reason":"已收窄"}}}\n```',
    });
    assert.deepEqual(reading.outcome.verdicts, {
      "SPEC-1": { kind: "closed", reason: "已收窄" },
    });
  });
});
