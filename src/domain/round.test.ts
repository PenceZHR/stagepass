import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { humanGapId, type Gap } from "./gap";
import {
  BLUE, judgePrompt, readBlueRubricAnswers, readConclusion, readRound,
  readVerdicts, RED, renderOpenGaps, renderSettled, summariseConvergence,
  summariseRoundNotes,
  UnreadableVerdictError,
} from "./round";
import { TurnResultUnparsableError } from "./turn";

const answer = (artifacts: string[], blockers: object[] = []) =>
  "```json\n" + JSON.stringify({ artifactIds: artifacts, blockers }) + "\n```";

const gap = (id: string, title: string): Gap => ({
  id, kind: "finding", severity: "P1", title, status: "open", openedRound: 1,
  resolution: null, note: null, closedBy: null,
  where: null,
  why: null,
});

describe("L4 · what the judge is told", () => {
  it("两方各占一段，并说明白是哪个阶段的第几轮", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "写出 Spec", openGaps: [],
    });
    assert.match(prompt, new RegExp(`1\\. ${RED}`));
    assert.match(prompt, new RegExp(`2\\. ${BLUE}`));
    assert.match(prompt, /Spec/);
    assert.match(prompt, /第 2 轮/);
  });

  it("carries the result contract to both roles", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 1, task: "写出 Spec", openGaps: [],
    });
    /*
     * **契约原文要出现两遍 —— 红蓝各一份。** 第 4 轮实测：蓝方那节原来只写
     * 「按同样的格式」，裁判不转，蓝方自己发明了 {"id","question"}，整轮作废。
     * 经裁判转达的文本只有原文加收件人才到得了。
     */
    assert.equal(prompt.split("artifactIds").length - 1, 2,
      "契约该出现两遍（红蓝各一份原文）—— 少一遍就是有一边又变回了「同上」");
    assert.match(prompt, /P0\|P1\|P2/);
    assert.match(prompt, new RegExp(`原样转达给${BLUE}`));
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
    // 2026-08-02 改的措辞：产出是个文件路径，正文在文件里 —— 蓝方要读得到那份
    // 文件本身，但仓库的其余部分照旧不许翻。
    assert.match(prompt, /读正方报出来的那份产出文件本身/);
    assert.match(prompt, /不要读仓库的其他内容/);
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
        status: "open", openedRound: 1, resolution: null, note: null, closedBy: null,
        where: null,
        why: null,
      }],
    });
    assert.match(prompt, /RB:producer:RBC-a \[标准\]/);
    assert.doesNotMatch(prompt, /\[null\]/);
  });
});

describe("L4 · 结果契约：形状留在提示词里，说明走文件", () => {
  /**
   * BACKLOG §3.4：`RESULT_CONTRACT` 占整份提示词 44.3%（它在提示词里出现两遍，
   * 红蓝各一份原文）。当初不敢文件化的顾虑是「藏到文件读取后面是自举风险」，
   * 而三处文件转达（需求、开着的问题、rubric 那两个路径）都真机验通了。
   *
   * **但这一份和那三份不是同一种东西，不能照抄。**
   *
   *   需求 / 问题名单没读到  →  模型少了信息，它会大声说读不到
   *   **结果契约没读到**     →  它答的形状不对，**整轮无法解析、直接作废**
   *
   * 所以按「缺了会怎样」切开，而不是按「长不长」切：
   *
   *   **形状**（那两行 json 骨架）留在提示词里 —— 缺了整轮作废，不许赌它去读文件
   *   **说明**（where / why 各是什么意思）走文件 —— 缺了只是写得糙一点，rubric 在判
   */
  it("**骨架永远在提示词里** —— 它缺了整轮就废了，不赌文件读没读", () => {
    const withFile = judgePrompt({
      phase: "Spec", round: 1, task: "t", openGaps: [],
      contractNotesPath: "/tmp/round/contract-notes.md",
    });
    assert.match(withFile, /artifactIds/, "骨架被一起挪走了");
    assert.match(withFile, /P0\|P1\|P2/, "严重度取值不在提示词里了");
  });

  it("**给了路径，说明就不再印正文**", () => {
    const path = "/tmp/round/contract-notes.md";
    const withFile = judgePrompt({
      phase: "Spec", round: 1, task: "t", openGaps: [], contractNotesPath: path,
    });
    // 说明里那句「不要复述标题」是它独有的，拿它当在不在的判据。
    assert.doesNotMatch(withFile, /Do not restate the title/,
      "说明正文还在提示词里，文件化没生效");
    assert.ok(withFile.includes(path), "路径没进提示词");
  });

  it("**没给路径就照旧全文印** —— 这一层不知道文件是谁写的", () => {
    const inline = judgePrompt({ phase: "Spec", round: 1, task: "t", openGaps: [] });
    assert.match(inline, /Do not restate the title/);
  });

  it("**省下来的是真的** —— 文件化之后提示词短一大截", () => {
    const inline = judgePrompt({ phase: "Spec", round: 1, task: "t", openGaps: [] });
    const withFile = judgePrompt({
      phase: "Spec", round: 1, task: "t", openGaps: [],
      contractNotesPath: "/tmp/round/contract-notes.md",
    });
    /*
     * 说明在提示词里出现两遍（红蓝各一份原文），所以省下来的也是两份。
     * 实测 13.9%（2140 → 1842 字符）—— 毛省两份说明约 23%，减去那两行路径本身。
     * 阈值 10% 是给措辞留的余地，**不是「差不多就行」**：它要挡的是
     * 「换成一行同样长的东西」那种假文件化。
     */
    assert.ok(withFile.length < inline.length * 0.9,
      `只省了 ${((1 - withFile.length / inline.length) * 100).toFixed(1)}% —— 没省到两份`);
  });

  it("**路径也要有收件人** —— 无主的一行到不了红蓝手里", () => {
    /*
     * 2026-08-02 那三张脸的教训：一段没有抬头的文本递到裁判手上，它就当成可以
     * 自己消化的背景。rubric 那两个路径、settled 那份、任务那段，全都写了
     * 「原样转达给谁」—— 这一行不能例外。
     */
    const withFile = judgePrompt({
      phase: "Spec", round: 1, task: "t", openGaps: [],
      contractNotesPath: "/tmp/round/contract-notes.md",
    });
    const line = withFile.split("\n").find((each) => each.includes("contract-notes.md")) ?? "";
    assert.match(line, /原样转达|转达给/, `那一行没写收件人：${line}`);
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
  it("**不指定用哪个 spawn 工具，也不禁止任何一个**", () => {
    /*
     * 走过一次弯路，记下来免得再走：那会儿 StagePass 靠 `agent_path` 认红蓝，而那一列
     * 只有原生 `spawn_agent({task_name})` 会设，所以提示词点名了那个工具、并禁止了
     * `multi_agent_v1__spawn_agent`。
     *
     * 然后取证改成「裁判报 agent_id」了，禁令却忘了撤 —— 而那个会话**恰好只有被禁的
     * 那一个**。裁判的答复是：「无法完成本轮：当前工具集中没有原生 spawn_agent，
     * 只有你明确禁止使用的 multi_agent_v1__spawn_agent。」它拒绝得完全正确，
     * 而拦住它的是我自己写的一句过时的话。
     *
     * 现在这一条是判据：**取证只认 id，所以工具用哪个都行。** 任何一句指定或禁止
     * 都是在替一个我们不控制的工具集做假设。
     */
    const prompt = judgePrompt({ phase: "Spec", round: 1, task: "t", openGaps: [] });
    assert.doesNotMatch(prompt, /不要用|禁止/, "又在禁止某个 spawn 工具了");
    assert.doesNotMatch(prompt, /task_name/, "又在假设某个工具的参数了");
    assert.match(prompt, /哪个 spawn 工具都行/, "没说清工具随便挑");
    // 取证靠 id 那一版也过去了（2026-08-02）：连 id 都不再让它报，StagePass 按
    // rollout 的 parent_thread_id 自己认。所以工具用哪个、叫什么路径都不要紧。
    assert.doesNotMatch(prompt, /agent_id/, "又在要它报 id 了");
    assert.match(prompt, /什么路径都不要紧/, "没说清路径也不重要");
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
      red: red([{ id: "RV-1", severity: "P0", title: "空指针没处理", where: null, why: null }]),
      blue: answer([], [{ id: "RVB-1", severity: "P1", title: "你漏了错误路径", where: null, why: null }]),
      judge: '```json\n{"verdicts":{}}\n```',
    }, {});
    assert.deepEqual(
      reading.outcome.found.map((each) => each.id).sort(),
      ["RV-1", "RVB-1"],
      "红方的发现被丢了 —— 那正是 Review 唯一的产出",
    );
  });

  it("设计阶段照旧：红方报自己的问题一概不算", () => {
    const reading = readRound({
      phase: "Spec", round: 1,
      red: red([{ id: "SELF-1", severity: "P0", title: "我自己觉得这里不太好", where: null, why: null }]),
      blue: answer([], [{ id: "S-1", severity: "P1", title: "验收不可测", where: null, why: null }]),
      judge: '```json\n{"verdicts":{}}\n```',
    }, {});
    assert.deepEqual(reading.outcome.found.map((each) => each.id), ["S-1"]);
  });

  it("**Build 也照旧** —— 红方写的代码是它自己的作品", () => {
    const reading = readRound({
      phase: "Build", round: 1,
      red: red([{ id: "SELF-1", severity: "P0", title: "我知道这里有问题", where: null, why: null }]),
      blue: answer([], []),
      judge: '```json\n{"verdicts":{}}\n```',
    }, {});
    assert.deepEqual(reading.outcome.found, []);
  });

  it("**QA 也算** —— 红方跑的是 Build 的产出，不是自审", () => {
    /*
     * 用户 2026-07-30 定的通则：「红方写或者审，但绝对不能自审，然后蓝方来纠错，
     * 都是按这个格式。」QA 的红方跑测试，报的是 Build 那份代码的问题 —— 和 Review
     * 同一个形状，所以同一个待遇。
     *
     * （在这之前 QA 被排除在外，理由是「还没谈过」。现在谈过了。）
     */
    const reading = readRound({
      phase: "QA", round: 1,
      red: red([{ id: "QA-1", severity: "P0", title: "第 3 条用例挂了", where: null, why: null }]),
      blue: answer([], [{ id: "QAB-1", severity: "P1", title: "你跳过了第 5 条", where: null, why: null }]),
      judge: '```json\n{"verdicts":{}}\n```',
    }, {});
    assert.deepEqual(reading.outcome.found.map((e) => e.id).sort(),
      ["QA-1", "QAB-1"], "QA 红方跑出来的失败被丢了");
  });

  it("**Merge / Retro / Fix 仍然不算** —— 它们红方产的是自己的东西", () => {
    // Fix 的红方在改自己要交的代码，Merge/Retro 在写自己的总结 —— 都是自审，
    // 那条默认规矩在那儿是对的。
    for (const phase of ["Merge", "Retro", "Fix"] as const) {
      const reading = readRound({
        phase, round: 1,
        red: red([{ id: "X-1", severity: "P0", title: "我自己觉得有问题", where: null, why: null }]),
        blue: answer([], []),
        judge: '```json\n{"verdicts":{}}\n```',
      }, {});
      assert.deepEqual(reading.outcome.found, [], `${phase} 被顺手改了`);
    }
  });

  /**
   * 红方那半 blockers 在这些阶段**注定被丢掉** —— 那它的形状就不许毁掉整轮。
   *
   * 2026-08-05 真机（Build 第 4 轮）：红方把 blockers 交成字符串数组，解析在
   * 「要不要用」之前就抛了。整轮作废、蓝方 11 条有效发现陪葬、58 分钟白烧 ——
   * 为一份没人要用的数据。
   */
  it("**Build：红方 blockers 形状烂掉 → 轮照常成立，产物和蓝方的发现都保住**", () => {
    const reading = readRound({
      phase: "Build", round: 4,
      // 真机那次的原样形状：数组套字符串。
      red: "```json\n" + JSON.stringify({
        artifactIds: ["x.ts"],
        blockers: ["BUILD-WEB-1/BUILD-SCENE-SCOPE-1: npm run build 失败了"],
      }) + "\n```",
      blue: answer([], [{ id: "B-1", severity: "P1", title: "改动没接进调用方", where: null, why: null }]),
      judge: '```json\n{"verdicts":{}}\n```',
    }, {});
    assert.deepEqual(reading.artifactIds, ["x.ts"], "红方的产物被陪葬了");
    assert.deepEqual(reading.outcome.found.map((e) => e.id), ["B-1"],
      "蓝方的发现被陪葬了");
  });

  it("**Review：红方的发现算数，形状错了就该照旧作废**", () => {
    // 这里红方审的是别人的代码，它的 blockers 就是这个阶段的产出 —— 读不出来
    // 等于这一轮什么都没产出，作废是对的，不是误伤。
    assert.throws(
      () => readRound({
        phase: "Review", round: 1,
        red: '```json\n{"artifactIds":["review.md"],"blockers":["RV-1: 就一句话"]}\n```',
        blue: answer([], []),
        judge: '```json\n{"verdicts":{}}\n```',
      }, {}),
      (error: unknown) => error instanceof TurnResultUnparsableError,
    );
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

  it("**QA 也要分前缀** —— 那儿两边同样都在报问题", () => {
    const prompt = judgePrompt({ phase: "QA", round: 1, task: "t", openGaps: [] });
    const redSection = prompt.slice(prompt.indexOf(`1. ${RED}`), prompt.indexOf(`2. ${BLUE}`));
    assert.match(redSection, /QA-/, "没告诉红方它的 id 前缀");
    assert.match(prompt.slice(prompt.indexOf(`2. ${BLUE}`)), /QAB-/, "没告诉蓝方它的");
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
      red: red([{ id: "RV-1", severity: "P0", title: "红方这么说", where: null, why: null }]),
      blue: answer([], [{ id: "RV-1", severity: "P1", title: "蓝方那么说", where: null, why: null }]),
      judge: '```json\n{"verdicts":{}}\n```',
    }, {});
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
  it("设计阶段：只读那份产出文件，仓库其余不许翻", () => {
    /*
     * 措辞 2026-08-02 改过：产出是个文件路径，正文在文件里 —— 蓝方读不到那份文件
     * 就只能连开「无法核验正文」的 gap（CHG-003 连着两轮实测）。放开的只有**那一份
     * 文件**，「攻击文档不许滑成调查项目」原样成立。
     */
    for (const phase of ["PRD", "Spec", "TechSpec", "Plan", "TestPlan"] as const) {
      const prompt = judgePrompt({ phase, round: 1, task: "t", openGaps: [] });
      assert.match(prompt, /读正方报出来的那份产出文件本身/, `${phase} 的蓝方读不到产出`);
      assert.match(prompt, /不要读仓库的其他内容/, `${phase} 放开了整个仓库`);
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

  it("**Merge：能读这一次的全部 commit**", () => {
    /*
     * 交付说明里「改了什么、对谁有影响、能不能回滚」全是对代码的断言。蓝方不读，
     * 就只能看着红方的说法点头 —— 而一份没人核对的交付说明，正是这个阶段该防的东西
     * （用户 2026-07-30 拍板）。
     *
     * 范围是「这一次的全部 commit」，不是「改动涉及的文件」：Merge 看的是整件事，
     * 不是某一轮。
     */
    const prompt = judgePrompt({ phase: "Merge", round: 1, task: "t", openGaps: [] });
    assert.doesNotMatch(prompt, /不要去读仓库/, "Merge 的蓝方还看不见代码");
    assert.match(prompt, /这一次的全部 commit/, "没说清读的范围是整件事");
    assert.match(prompt, /不要自己(执行|跑)/, "没拦住蓝方自己跑东西");
  });

  it("**QA：两边都能跑** —— 这是唯一一个活儿本身就是执行的阶段", () => {
    /*
     * Review 那条规矩里写着「跑起来验是 QA 的活儿」。到了 QA，跑就是正题 ——
     * 而一个跑不了东西的蓝方，没法核对一份「我跑了、结果是这样」的报告，
     * 它只能检查报告自洽不自洽。
     */
    const prompt = judgePrompt({ phase: "QA", round: 1, task: "t", openGaps: [] });
    assert.doesNotMatch(prompt, /不要去读仓库/, "QA 的蓝方还看不见代码");
    assert.doesNotMatch(prompt, /不要自己执行/, "QA 的蓝方还不许跑 —— 那它核对不了");
    assert.match(prompt, /自己跑一遍/, "没告诉蓝方它可以自己跑");
  });

  it("没谈过的阶段一律不动 —— 保守是因为没谈，不是因为想清楚了", () => {
    // Fix / Merge / Retro 的形状还没谈过。
    // Retro 写的是复盘 —— 它对着前面每个阶段的产出和账本，不需要读代码。
    // （措辞 2026-08-02 随设计阶段一起改：产出文件本身要读得到，仓库其余不许翻。）
    assert.match(
      judgePrompt({ phase: "Retro", round: 1, task: "t", openGaps: [] }),
      /不要读仓库的其他内容/, "Retro 被顺手改了");
    // Fix 和 Build 同形状（红方写代码），所以蓝方够得着的东西也一样。
    assert.doesNotMatch(
      judgePrompt({ phase: "Fix", round: 1, task: "t", openGaps: [] }),
      /不要去读仓库/, "Fix 的蓝方还看不见它要审的代码");
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
        note: "把那个同步接口整段删掉，不要留占位", closedBy: null,
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
    // 自己也打不开的闸门。它和模型报的问题走的是同一条路（stagepass_next），
    // 而那条路只认顺序，不认这一条是谁提的。
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t", openGaps: [human("HUMAN-1", "我要的")],
    });
    assert.match(prompt, /stagepass_next/);
    assert.doesNotMatch(prompt, /不许关闭|不可关闭/);
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
      unreadable: false,
    });
  });

  /**
   * A judge that said nothing readable has ruled on nothing, and every open gap
   * stays open. That is the safe direction, so it is not an error.
   */
  it("yields no verdicts when the judge said nothing readable", () => {
    for (const text of ["都挺好的", "```json\n{}\n```", '{"verdicts":null}']) {
      assert.deepEqual(readVerdicts(text).verdicts, {});
    }
  });

  /**
   * **「它没给裁决」和「信封根本没读出来」不是一回事。**
   *
   * 两者在 `verdicts` 上长得一模一样（都是空的），而要做的事完全不同：前者是一次
   * 正常的轮，后者意味着一份坏格式留在了裁判线程的历史里，resume 回去它会接着抄
   * （2026-08-02 实测：同一个坏形状连写两轮）。上层靠这个标记去放开线程。
   */
  it("**信封读不出来，和它没给裁决，分得开**", () => {
    // 一个 json 都没有 —— 它把整个信封的要求忽略了。
    assert.equal(readVerdicts("都挺好的").unreadable, true);
    assert.equal(readVerdicts('```json\n{"verdicts":{}}}\n```').unreadable, true);

    // 解析得开，只是没有裁决可说 —— 这是正常的一轮，闸门方向也是安全的。
    assert.equal(readVerdicts("```json\n{}\n```").unreadable, false);
    assert.equal(readVerdicts('{"verdicts":null}').unreadable, false);
    assert.equal(readVerdicts('```json\n{"verdicts":{}}\n```').unreadable, false);
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
      blue: answer([], [{ id: "SPEC-9", severity: "P0", title: "范围冲突", where: null, why: null }]),
      judge: '```json\n{"verdicts":{}}\n```',
    }, {});
    assert.deepEqual(reading.artifactIds, ["spec.md"]);
    assert.deepEqual(reading.outcome.found, [
      { id: "SPEC-9", severity: "P0", title: "范围冲突", where: null, why: null },
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
      red: answer(["spec.md"], [{ id: "RED-SELF", kind: "finding", severity: "P0", title: "我觉得还行", where: null, why: null }]),
      blue: answer([], []),
      judge: "",
    }, {});
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
      }, {}),
      (error: unknown) =>
        error instanceof TurnResultUnparsableError
        && error.detail.startsWith("blue:"),
    );
  });

  it("fails the round when red produced nothing readable", () => {
    assert.throws(
      () => readRound({ phase: "Spec", round: 1, red: "写完了", blue: answer([]), judge: "" }, {}),
      TurnResultUnparsableError,
    );
  });

  it("**表态从名单里来，不从裁判写的 json 里来**", () => {
    // 2026-08-02 起：裁判调 stagepass_answer 逐条答，`work/round-runner.ts` 把名单
    // 翻译成这份 verdicts 交进来。它写在 json 里的东西**一个字都不算数** ——
    // 算数就等于把那条 50 字符的手抄路重新打开了。
    const reading = readRound({
      phase: "Spec",
      round: 3,
      red: answer(["spec.md"]),
      blue: answer([]),
      judge: '```json\n{"verdicts":{"SPEC-9":{"kind":"closed","reason":"它自己写的"}}}\n```',
    }, { "SPEC-1": { kind: "closed", reason: "已收窄" } });

    assert.deepEqual(reading.outcome.verdicts, {
      "SPEC-1": { kind: "closed", reason: "已收窄" },
    });
  });
});

/**
 * 裁判不再报线程 id —— 那一版把 36 字符的 UUID 放进了它必须手抄的文本里。
 *
 * 现在 StagePass 按 rollout 的 `parent_thread_id` 自己认（`work/round-runner.ts`），
 * 而提示词里剩下的唯一要求是**派生的先后顺序** —— 它现在是红蓝的判据。
 * 见 docs/DESIGN-no-hand-transcription-2026-08-02.md §三。
 */
describe("L4 · 裁判的答复里不再有任何线程 id", () => {
  const prompt = () =>
    judgePrompt({ phase: "Spec", round: 1, task: "t", openGaps: [] });

  it("**不再要它报 `agent_id`**", () => {
    assert.doesNotMatch(prompt(), /agent_id/);
    assert.doesNotMatch(prompt(), /"agents"/);
  });

  it("**顺序反而必须说死** —— 它是红蓝的判据", () => {
    assert.match(prompt(), /先派正方/);
    assert.match(prompt(), /不要并行/);
    // 说清楚顺序反了的后果，否则这条要求读起来只是个效率建议。
    assert.match(prompt(), /记到对方头上/);
  });

  it("**json 里只剩 conclusion** —— 逐条表态搬去工具了", () => {
    assert.match(prompt(), /里面只放这一样东西/);
    assert.doesNotMatch(prompt(), /"verdicts":/);
    assert.match(prompt(), /写在这里不算数/);
  });
});

/**
 * 契约要有收件人，结论要有落点。
 *
 * 这一组打的都是 2026-07-31 在 `build-0730` 那次真实数据里查出来的症状，不是我
 * 改了哪个函数（见 docs/DESIGN-rubric-delivery-2026-07-31.md §2）。
 */
describe("L4 · 契约转达给谁、结论谁来下", () => {
  const build = (task: string) =>
    judgePrompt({ phase: "Build", round: 1, task, openGaps: [] });

  it("**红方的任务带着「原样转达」** —— CHG-003 第一轮裁判把人答的需求转丢了", () => {
    /*
     * 2026-08-02 实测：裁判的提示词里有「人要的是这些：…」（人自己答的需求），
     * 红方的 rollout 里一个字都没有 —— 裁判改写任务时丢了它，红方报「缺少产品
     * 输入」，四条 rubric 全 no，一整轮白烧。和丢 rubric 契约是同一个病。
     */
    const prompt = judgePrompt({
      phase: "PRD", round: 1,
      task: "写 PRD\n\n人要的是这些（他自己在选择器里答的，不是模型猜的）：\n本地排行榜",
      openGaps: [],
    });
    assert.match(prompt, new RegExp(`原样转达给${RED}`));
    assert.match(prompt, /一个字都不要改/);
    // 需求正文原样在场。
    assert.match(prompt, /本地排行榜/);
  });

  it("**反方那一份也不再走转达** —— 2026-08-03 起 StagePass 直接问它自己那条线程", () => {
    /*
     * 曾经这里有一段「原样转达给反方」的抬头，因为它那份 rubric 契约只能经裁判的手
     * 递过去 —— 而实测三种断法里有两种长在那条链上。现在 StagePass 自己 resume
     * 反方线程逐条走工具问（`work/rubric-round.ts` 的 `askBlueByWorklist`），
     * 那条链整个不存在了，抬头也就不该再出现。
     */
    const prompt = build("写代码");
    assert.doesNotMatch(prompt, /不是给你答的/, "rubric 契约的转达抬头还在");
    // 而**答复格式**那条转达还在，而且必须在：反方是子 Agent，格式只能经裁判递给它，
    // 2026-08-02 实测过不递的后果 —— 它自己发明了一个形状，整轮作废。
    assert.match(prompt, /下面这段格式要求\*\*原样转达给反方\*\*/);
    // 而红方那一句转达是无条件的，另一回事 —— 任务本来就只能经裁判的手。
    assert.match(prompt, new RegExp(`原样转达给${RED}`));
  });

  it("**裁判那一份不再走提示词** —— 它调工具逐条答", () => {
    // 2026-08-02：裁判是 user 线程，手上有 StagePass 的工具，所以它那份标准进名单。
    // 反方是子 Agent，拿不到工具（真机验过），所以只剩它还走转达这条路。
    const prompt = judgePrompt({ phase: "Build", round: 1, task: "t", openGaps: [] });
    assert.match(prompt, /stagepass_next/);
    assert.doesNotMatch(prompt, /只答这一份/);
  });

  it("没有 addenda 时 rubric 那两个抬头不出现（任务的转达抬头是无条件的，另一回事）", () => {
    const prompt = judgePrompt({ phase: "Build", round: 1, task: "t", openGaps: [] });
    // rubric 特有的抬头只跟着 addenda 走。答复契约的转达抬头（2026-08-02 加的）
    // 是无条件的 —— 别拿它当判据。
    assert.doesNotMatch(prompt, /不是给你答的/);
    assert.doesNotMatch(prompt, /只答这一份/);
    // 而任务的转达抬头**始终在** —— 2026-08-02 实测裁判会把人答的需求转丢。
    assert.match(prompt, new RegExp(`原样转达给${RED}`));
  });

  it("裁判被要求做**两件**事，第二件是给结论并自己去读上游", () => {
    const prompt = judgePrompt({ phase: "Build", round: 1, task: "t", openGaps: [] });
    assert.match(prompt, /两件事/);
    assert.match(prompt, /还要不要再来一轮/);
    assert.match(prompt, /自己读一遍/);
    // **不许写死「上游」**：PRD 没有上游，而那一节是动态出现的。
    assert.match(prompt, /上面任务里列出来的那些/);
    // 闸门仍然是人推的（2026-07-30 拍板），所以要明说它不必考虑闸门。
    assert.match(prompt, /你不需要考虑闸门/);
    assert.match(prompt, /"conclusion"/);
  });

  it("**只有反方被要求给整体判断，正方没有** —— 让正方给自己打分是自评", () => {
    const prompt = judgePrompt({ phase: "Build", round: 1, task: "t", openGaps: [] });
    const blueSection = prompt.slice(prompt.indexOf(`2. ${BLUE}`));
    const redSection = prompt.slice(prompt.indexOf(`1. ${RED}`), prompt.indexOf(`2. ${BLUE}`));
    assert.match(blueSection, /overall/);
    assert.doesNotMatch(redSection, /overall/);
  });

  it("**Build 的反方够得着上游文档** —— 判「做到要求没有」得对着要求看", () => {
    const prompt = judgePrompt({ phase: "Build", round: 1, task: "t", openGaps: [] });
    assert.match(prompt, /已批准上游产物/);
    // 边界没有被放开成整个仓库。
    assert.match(prompt, /不要把整个仓库读一遍/);
  });
});

describe("L4 · 裁判的结论", () => {
  const judged = (body: object) => "```json\n" + JSON.stringify(body) + "\n```";

  it("读得出来 —— 还要不要再来一轮，加理由", () => {
    assert.deepEqual(
      readConclusion(judged({ conclusion: { another_round: true, reason: "证据还不全" } })),
      { kind: "advised", anotherRound: true, reason: "证据还不全" },
    );
  });

  it("说可以过了，也读得出来", () => {
    const read = readConclusion(judged({ conclusion: { another_round: false, reason: "都对上了" } }));
    assert.deepEqual(read, { kind: "advised", anotherRound: false, reason: "都对上了" });
  });

  it("**没给结论 —— null，不作废这一轮**（沉默 = 没有建议）", () => {
    assert.equal(readConclusion(judged({ verdicts: {} })), null);
    assert.equal(readConclusion("我什么 json 都没写"), null);
  });

  /**
   * 和 `verdicts` 的分工：改状态的东西读不准就拒，给人看的东西读不准就照实说读不准。
   * 为一句读不准的建议作废一轮几分钟的对抗不成比例。
   */
  it("**结构坏掉 —— 不抛，带着原文说「读不出来」**", () => {
    for (const bad of [
      { another_round: "yes", reason: "字符串不是布尔" },
      { another_round: true, reason: "" },
      { another_round: true },
      { reason: "少了 another_round" },
    ]) {
      const read = readConclusion(judged({ conclusion: bad }));
      assert.equal(read?.kind, "unreadable", JSON.stringify(bad));
      assert.ok((read as { detail: string }).detail.length > 0);
    }
  });

  it("同一份答复里 verdicts 坏掉时仍然抛 —— 这一条没被改松", () => {
    assert.throws(
      () => readVerdicts(judged({
        verdicts: { "G-1": { kind: "closed" } },
        conclusion: { another_round: false, reason: "好" },
      })),
      UnreadableVerdictError,
    );
  });
});

describe("L4 · 反方那句整体判断", () => {
  const blueSaid = (body: object) => "```json\n" + JSON.stringify(body) + "\n```";

  it("读得出来，跟着这一轮交出去", () => {
    const reading = readRound({
      phase: "Spec", round: 1,
      red: answer(["Spec.md"]),
      blue: blueSaid({ artifactIds: [], blockers: [], overall: "整体够格，边界还差一点" }),
      judge: "```json\n{}\n```",
    }, {});
    assert.equal(reading.blueOverall, "整体够格，边界还差一点");
  });

  it("**没写就是 null，不作废这一轮** —— 它不挡任何东西", () => {
    const reading = readRound({
      phase: "Spec", round: 1,
      red: answer(["Spec.md"]),
      blue: answer([], []),
      judge: "```json\n{}\n```",
    }, {});
    assert.equal(reading.blueOverall, null);
  });

  it("空字符串当成没写", () => {
    const reading = readRound({
      phase: "Spec", round: 1,
      red: answer(["Spec.md"]),
      blue: blueSaid({ artifactIds: [], blockers: [], overall: "   " }),
      judge: "```json\n{}\n```",
    }, {});
    assert.equal(reading.blueOverall, null);
  });
});

/**
 * 那两句话在人裁决前看的那张表上长什么样。
 *
 * 裁决发生在 Codex 画的选择器里 —— 人按下去那一刻眼前只有那张表。要他判断的信息
 * 不在那张表上，就等于要他凭记忆判断（和 `summariseAssessments` 同一个理由）。
 */
describe("L4 · 裁决那张表上的两句话", () => {
  it("裁判说还要再来一轮 —— 照实说，并带上理由", () => {
    const summary = summariseRoundNotes([
      { source: "judge_conclusion", anotherRound: true, text: "运行证据还不完整" },
    ]);
    assert.match(summary, /还需要再来一轮/);
    assert.match(summary, /运行证据还不完整/);
  });

  it("裁判说可以了 —— 也照实说", () => {
    assert.match(
      summariseRoundNotes([
        { source: "judge_conclusion", anotherRound: false, text: "都对上了" },
      ]),
      /可以了/,
    );
  });

  /**
   * 早先这里的 schema 逼着「读不出来」记 0，于是这一句会被渲染成「可以了」——
   * 替裁判说了一句它没说过的话。这一整套东西的立身之本正是不许出现这种话。
   */
  it("**结论读不出来 —— 绝不能说成「可以了」**", () => {
    const summary = summariseRoundNotes([
      { source: "judge_conclusion", anotherRound: null, text: "裁判给了结论但读不出来：…" },
    ]);
    assert.match(summary, /读不出来/);
    assert.doesNotMatch(summary, /可以了/);
    assert.doesNotMatch(summary, /还需要再来一轮/);
  });

  it("反方那句整体判断也进去", () => {
    assert.match(
      summariseRoundNotes([{ source: "blue_overall", anotherRound: null, text: "整体够格" }]),
      new RegExp(`${BLUE}的整体判断：整体够格`),
    );
  });

  it("两句都在时都写出来", () => {
    const summary = summariseRoundNotes([
      { source: "blue_overall", anotherRound: null, text: "整体够格" },
      { source: "judge_conclusion", anotherRound: true, text: "还差运行证据" },
    ]);
    assert.match(summary, /裁判：/);
    assert.match(summary, /整体判断/);
  });

  it("一句都没有 —— 空串，不是一段空白", () => {
    assert.equal(summariseRoundNotes([]), "");
  });
});

/**
 * conclusion 塞错位置不作废整轮。
 *
 * 2026-08-02 CHG-003 第 2 轮实测：裁判把 conclusion 放进了 verdicts 里（还少了个
 * 花括号 —— 那一半救不了，只能重试）。红方第一次真拿到了需求、四条旧 gap 被逐条
 * 表态、蓝方开了新的 —— 内容全对，毁在信封上。花括号配平的那部分，这里兜住。
 */
describe("L4 · conclusion 塞进 verdicts 里", () => {
  const judged = (body: object) => "```json\n" + JSON.stringify(body) + "\n```";
  const NESTED = judged({
    verdicts: {
      "G-1": { kind: "closed", reason: "修了" },
      conclusion: { another_round: true, reason: "边界还冲突" },
    },
  });

  it("**readVerdicts 跳过它，真裁决照常读**", () => {
    const { verdicts } = readVerdicts(NESTED);
    assert.deepEqual(Object.keys(verdicts), ["G-1"]);
    assert.equal(verdicts["G-1"]!.kind, "closed");
  });

  it("**readConclusion 从 verdicts 里捞得到它**", () => {
    assert.deepEqual(readConclusion(NESTED),
      { kind: "advised", anotherRound: true, reason: "边界还冲突" });
  });

  it("顶层的 conclusion 优先于塞进去的那个", () => {
    const both = judged({
      verdicts: { conclusion: { another_round: true, reason: "里面的" } },
      conclusion: { another_round: false, reason: "外面的" },
    });
    assert.deepEqual(readConclusion(both),
      { kind: "advised", anotherRound: false, reason: "外面的" });
  });

  it("提示词写明 json 里只放 conclusion", () => {
    const prompt = judgePrompt({ phase: "PRD", round: 1, task: "t", openGaps: [] });
    assert.match(prompt, /里面只放这一样东西/);
  });
});

/**
 * 结尾没关严的 json 补得回来 —— 用第 3 轮的**原样形状**打。
 *
 * 2026-08-02 CHG-003 连着两轮：conclusion 塞进 verdicts + 结尾少一个右花括号。
 * resume 的线程抄自己上一轮的格式，提示词的告诫压不过历史，所以解析端必须兜。
 */
describe("L4 · 裁判的 json 少了右花括号", () => {
  // 第 3 轮真实答复的骨架：两个闭括号收尾，根对象没关。
  const ROUND3_SHAPE = [
    "我会先派正方完成修订。",
    "```json",
    '{"verdicts":{'
    + '"G-1":{"kind":"closed","reason":"修了"},'
    + '"conclusion":{"another_round":true,"reason":"还要一轮"}}',
    "```",
  ].join("\n");

  it("**verdicts 和塞错位置的 conclusion 都读得出来 —— 整轮不再作废**", () => {
    const { verdicts } = readVerdicts(ROUND3_SHAPE);
    assert.deepEqual(Object.keys(verdicts), ["G-1"]);
    assert.deepEqual(readConclusion(ROUND3_SHAPE),
      { kind: "advised", anotherRound: true, reason: "还要一轮" });
  });

  it("**关错了的不补** —— 多一个闭括号，一条裁决都不许编出来", () => {
    const broken = '```json\n{"verdicts":{"G-1":{"kind":"closed","reason":"修了"}}}}\n```';
    assert.deepEqual(readVerdicts(broken).verdicts, {});
    assert.equal(readConclusion(broken), null);
  });

  it("**断在字符串中间的不补** —— 那不是没关严，是内容缺了", () => {
    const truncated = '```json\n{"verdicts":{"G-1":{"kind":"closed","reason":"修\n```';
    assert.deepEqual(readVerdicts(truncated).verdicts, {});
  });

  it("设计阶段的反方被告知去读那份产出文件本身", () => {
    const prompt = judgePrompt({ phase: "PRD", round: 1, task: "t", openGaps: [] });
    assert.match(prompt, /读正方报出来的那份产出文件本身/);
    // 边界没放开：产出之外的仓库内容照旧不许翻。
    assert.match(prompt, /不要读仓库的其他内容/);
  });
});

/**
 * Codex 禁止外部驱动子 Agent 线程（2026-08-03 实测），所以反方那半 rubric 只能经
 * 它的父线程转达。转的是**两个路径**，答案按 `1..N` 的序号写回文件 —— 模型手上
 * 一个 criterion key 都没有。
 *
 * 位置映射的代价是错位，而错位比没答糟得多：一条言之凿凿却挂在别的标准上的判定，
 * 人没有任何办法察觉。所以用户 2026-08-03 定的是**数不对就整份作废**。
 */
describe("L4 · 反方写回来的逐条判定", () => {
  it("序号齐了就按序号排好", () => {
    const read = readBlueRubricAnswers(
      "1: yes —— 第一条有\n2: no —— 第二条没有\n3: yes —— 第三条有\n", 3);
    assert.equal(read.voided, null);
    assert.deepEqual(read.answers.map((each) => each.verdict), ["yes", "no", "yes"]);
    assert.equal(read.answers[1]!.evidence, "第二条没有");
  });

  it("**乱序也认** —— 它按什么顺序写不重要，序号才是身份", () => {
    const read = readBlueRubricAnswers("3: no 丙\n1: yes 甲\n2: yes 乙\n", 3);
    assert.equal(read.voided, null);
    assert.deepEqual(read.answers.map((each) => each.evidence), ["甲", "乙", "丙"]);
  });

  it("**缺一条就整份作废** —— 少的那条会让后面全部错位", () => {
    const read = readBlueRubricAnswers("1: yes 甲\n3: no 丙\n", 3);
    assert.deepEqual(read.answers, []);
    assert.match(read.voided ?? "", /缺了第 2 条/);
    assert.match(read.voided ?? "", /整份作废/);
  });

  it("重号、越界一样作废，而且说得出是哪一种", () => {
    const duplicated = readBlueRubricAnswers("1: yes 甲\n1: no 又一次\n2: yes 乙\n", 2);
    assert.deepEqual(duplicated.answers, []);
    assert.match(duplicated.voided ?? "", /第 1 条答了不止一次/);

    const beyond = readBlueRubricAnswers("1: yes 甲\n2: yes 乙\n9: yes 哪来的\n", 2);
    assert.deepEqual(beyond.answers, []);
    assert.match(beyond.voided ?? "", /范围外的序号 9/);
  });

  it("**文件不在和答错了要分开说** —— 人对这两件事做的事不一样", () => {
    const missing = readBlueRubricAnswers(null, 3);
    assert.deepEqual(missing.answers, []);
    assert.match(missing.voided ?? "", /那个文件不在/);
  });

  it("排版一律不计较：全角冒号、列表符号、破折号有几个都行", () => {
    const read = readBlueRubricAnswers(
      "# 判定\n\n- 1：YES — 甲\n* 2 : no  ——  乙\n3:yes 丙\n", 3);
    assert.equal(read.voided, null);
    assert.deepEqual(read.answers.map((each) => each.verdict), ["yes", "no", "yes"]);
    assert.deepEqual(read.answers.map((each) => each.evidence), ["甲", "乙", "丙"]);
  });

  it("一条都不要判的时候，空文件不算作废", () => {
    assert.deepEqual(readBlueRubricAnswers(null, 0), { answers: [], voided: null });
  });
});

describe("L4 · 那两个路径要经裁判转达给反方", () => {
  const base = {
    phase: "PRD" as const, round: 1, task: "写需求", openGaps: [],
  };

  it("**抬头写明收件人，正文一个字都不进提示词**", () => {
    const prompt = judgePrompt({
      ...base,
      blueRubric: { criteriaPath: "/tmp/criteria.md", answersPath: "/tmp/answers.md", count: 4 },
    });
    assert.match(prompt, /原样转达给/);
    assert.ok(prompt.includes("/tmp/criteria.md"), "标准文件的路径没进提示词");
    assert.ok(prompt.includes("/tmp/answers.md"), "答案文件的路径没进提示词");
    assert.match(prompt, /恰好 4 行/);
    assert.match(prompt, /数不对整份判定作废/);
  });

  it("**没有要反方判的标准就一行都不印** —— 空小节会让裁判去猜", () => {
    const without = judgePrompt(base);
    assert.ok(!without.includes("逐条判定"), "没有标准却印了那一节");
    const zero = judgePrompt({
      ...base,
      blueRubric: { criteriaPath: "/tmp/a", answersPath: "/tmp/b", count: 0 },
    });
    assert.equal(zero, without, "count=0 和压根没给，印出来该一模一样");
  });
});

/**
 * 人已经裁定过的事要跨阶段跟着走。
 *
 * 每个阶段一条新线程、一个新反方，从零开始怀疑。2026-08-02 实测：去重语义被重提
 * 5 次、范围定义 3 次，每次烧一轮 turn 加一次裁决 —— 而人早就裁过了，只是那句话
 * 结构上到不了下一个阶段。
 */
describe("L4 · 已裁定的事跨阶段跟着走", () => {
  const settled = (patch: Partial<Gap> & { phase: string }) => ({
    id: "SPEC-DEDUP-1", kind: "finding" as const, severity: "P1" as const,
    title: "去重语义没定义", status: "closed" as const, openedRound: 1,
    resolution: "实测过了，那个定义在第 3 节", note: null,
    closedBy: "human" as const, where: null, why: null, ...patch,
  });

  it("**驳回的和接受风险的分开列** —— 两句话不一样", () => {
    const text = renderSettled([
      settled({ phase: "Spec" }),
      settled({
        phase: "QA", id: "QA-007", title: "兼容性回归没有唯一基线",
        status: "waived", closedBy: null, resolution: "本期接受，人工检查覆盖",
      }),
    ]);
    assert.match(text, /他驳回的（这条不成立）/);
    assert.match(text, /\[Spec\] SPEC-DEDUP-1/);
    assert.match(text, /他接受的风险/);
    assert.match(text, /\[QA\] QA-007/);
    assert.match(text, /本期接受，人工检查覆盖/);
  });

  it("**留了重提的口子** —— 人也会裁错", () => {
    const text = renderSettled([settled({ phase: "Spec" })]);
    assert.match(text, /不要把它们当成新问题重新报出来/);
    assert.match(text, /真有他没考虑到的证据/, "写死成永久免疫了 —— 人裁错时没有出路");
  });

  it("一条都没有就是空的 —— 不写一个空文件让三方去猜", () => {
    assert.equal(renderSettled([]), "");
  });

  it("**路径要转达给正方和反方两边**，不是只给裁判自己看", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "写 Spec", openGaps: [],
      settledPath: "/tmp/settled-CHG-1.md",
    });
    assert.match(prompt, /原样转达给正方和反方/);
    assert.equal(
      prompt.split("/tmp/settled-CHG-1.md").length - 1, 2,
      "路径只出现了一次 —— 裁判自己读那一处和转达那一处要各有一份",
    );
  });

  it("没有裁定过任何事就一行都不印", () => {
    const without = judgePrompt({ phase: "Spec", round: 2, task: "写 Spec", openGaps: [] });
    assert.ok(!without.includes("已经裁定过"), "没有裁定却印了那一节");
  });
});

/**
 * 跑满轮次预算之后，把收敛数据摊给人看。
 *
 * 蓝方每轮关 N 条铸 M 条，纯靠轮次永远清不了零。用户 2026-08-03 选的是**软预算**：
 * 「再来一轮」仍然提供，只是不再让人抱着「再跑一轮就清零」的幻想 —— 阻断归人管。
 */
describe("L4 · 跑满预算就把收敛数据摊出来", () => {
  it("**不到预算不出声** —— 前几轮本来就该跑", () => {
    for (const round of [1, 2, 3, 4]) {
      assert.equal(
        summariseConvergence({ round, budget: 5, raised: 12, open: 7 }), "",
        `第 ${round} 轮就开始念叨，等于劝人别对抗`,
      );
    }
  });

  it("**到了就说得很具体** —— 两个数直接回答「它在不在收敛」", () => {
    const text = summariseConvergence({ round: 5, budget: 5, raised: 12, open: 7 });
    assert.match(text, /已经跑了 5 轮/);
    assert.match(text, /一共提出过 12 条/);
    assert.match(text, /还开着 7 条/);
  });

  it("**它不拦人** —— 明说再来一轮仍然可以", () => {
    const text = summariseConvergence({ round: 9, budget: 5, raised: 30, open: 11 });
    assert.match(text, /再来一轮仍然可以/, "说成拦住了 —— 而阻断该归人管");
    assert.match(text, /该由你判断/);
  });

  it("**这段话不进选项文案** —— 选项是按原文精确匹配回动作的", () => {
    /*
     * `ACTION_BY_LABEL` 拿标签原文查动作。往标签里拼「已跑 5 轮」，人选完就映射不回
     * `reject` —— 静默失败。标签是枚举值，这段是散文，两者不能混。
     */
    const text = summariseConvergence({ round: 5, budget: 5, raised: 12, open: 7 });
    assert.ok(!text.includes("再来一轮（红蓝在这个阶段重新跑）"), "把选项原文抄进散文里了");
  });
});

describe("L4 · 「在哪儿」和「为什么」要活到下一轮的提示词里", () => {
  const found = (patch: Partial<Gap>): Gap => ({
    id: "RV-NPE-1", kind: "finding", severity: "P0",
    title: "空指针", status: "open", openedRound: 1,
    resolution: null, note: null, closedBy: null,
    where: null, why: null, ...patch,
  });

  /**
   * 这条钉的是那条语义损失链子的**最后一环**。
   *
   * 契约收下了、gaps 存下了，如果渲染这一步不印，红方下一轮读到的**照样只是一个
   * 标题** —— 前面两环白做，而且是安静地白做（库里查得到，提示词里没有）。
   * 用户 2026-08-04：「绝对不能出现语义损失」。
   */
  it("**两样都印出来**", () => {
    const text = renderOpenGaps([found({
      where: "src/foo.ts:42",
      why: "list 为空时 head() 返回 undefined，调用方没判",
    })]);
    assert.ok(text.includes("src/foo.ts:42"), `位置没进提示词：\n${text}`);
    assert.ok(text.includes("head() 返回 undefined"), `理由没进提示词：\n${text}`);
  });

  /**
   * 没有就一行都不印。
   *
   * 印一个空标签（`在这儿：` 后面什么都没有）比不印更糟：模型分不出「没人写」和
   * 「写了但是空的」，而这两件事该有的反应不一样。
   */
  it("**没有的那一样，连标签都不出现**", () => {
    const text = renderOpenGaps([found({ where: "src/foo.ts:42", why: null })]);
    assert.ok(text.includes("在这儿："), "有 where 却没印");
    assert.ok(!text.includes("为什么是问题："), `why 是空的，却印了标签：\n${text}`);
  });

  /** 两样都没有时，这一行和加这个功能之前**逐字节相同** —— 老用例不该被惊动。 */
  it("**两样都没有时，和以前一模一样**", () => {
    assert.equal(renderOpenGaps([found({})]), "- RV-NPE-1 [P0] 空指针");
  });

  /** 人说的话排在最后：上面两行是模型说的，这一行是人说的，分量不同。 */
  it("**人说的排在模型说的后面**", () => {
    const text = renderOpenGaps([found({
      where: "src/foo.ts:42", why: "空列表", note: "这条必须这轮修掉",
    })]);
    assert.ok(
      text.indexOf("人说：") > text.indexOf("为什么是问题："),
      `人说的没有排在最后：\n${text}`,
    );
  });
});

describe("L4 · 被打回的阶段，红方必须知道是谁打回来的、为什么（§5.5 最后一米）", () => {
  /*
   * F 档把长回边做进了状态机，但理由只落在账本上 —— **目标阶段的红方读不到**。
   * 于是 Build 发现 Spec 错了、人打回 Spec，Spec 的红方从零重写一份 Spec，
   * 完全不知道下游为什么把它退回来。反馈链路（§5.5）就断在这最后一米。
   */
  const sentBack = (patch: Partial<{ from: string; reason: string | null; round: number }> = {}) =>
    judgePrompt({
      phase: "Spec", round: 3, task: "写出 Spec", openGaps: [],
      sentBack: { from: "Build", reason: "接口边界在 Spec 里就画错了", round: 2, ...patch },
    });

  it("说清是谁打回的、什么时候、原话是什么", () => {
    const prompt = sentBack();
    assert.match(prompt, /被 Build 打回来的/);
    assert.match(prompt, /第 2 轮/);
    // **原文照抄** —— 转述必然改写，而这是人写的话。
    assert.match(prompt, /接口边界在 Spec 里就画错了/);
  });

  it("**写明收件人**，原样转达给红蓝两方（2026-08-02 四张脸的教训）", () => {
    const prompt = sentBack();
    assert.match(prompt, new RegExp(`原样转达给${RED}和${BLUE}`));
    // 那句话必须出现两次：裁判自己读一次，转达的原文一次 —— 只写一次就又变回
    // 「参照上文」，而那正是四次转丢的成因。
    assert.equal(prompt.split("接口边界在 Spec 里就画错了").length - 1, 2);
  });

  it("红方的活儿改了：不是重写一份，是修好被指出的地方", () => {
    assert.match(sentBack(), /不是从零重写/);
  });

  it("人没写理由 —— 照实说「没留理由」，不编一个", () => {
    const prompt = sentBack({ reason: null });
    assert.match(prompt, /被 Build 打回来的/);
    assert.match(prompt, /没有留下理由/);
  });

  it("没被打回 —— 一个字都不印（和加这个参数之前逐字一样）", () => {
    const plain = judgePrompt({ phase: "Spec", round: 3, task: "写出 Spec", openGaps: [] });
    assert.ok(!plain.includes("打回"), "正常进入的阶段不该看见打回那一段");
  });
});

describe("L4 · 人的批注和上游文档打架时，谁说了算要写死（旧账 G）", () => {
  /*
   * 2026-08-02 记的账：**操作员批注和上游文档打架会制造震荡** —— 红方一边读
   * 上游那份已批准的文档、一边读人的批注，两者冲突时它每轮各按一次，人只好
   * 每轮再说一遍。原话给的出路是「批注要么对着上游写，要么就去改上游」。
   *
   * 「去改上游」这条边 2026-08-05 才有（sendBack）。所以这里把两件事都写进
   * 那份名单：**冲突时以人的话为准**（以人为主，那条从 07-30 就定了），
   * 而且**必须把冲突写进产出** —— 否则人根本不知道自己在跟一份文档拧着。
   */
  const humanGap = (title: string, note: string | null = null): Gap => ({
    id: humanGapId(1), kind: "finding", severity: "P1", title,
    status: "open", openedRound: 2, resolution: null, note,
    closedBy: null, where: null, why: null,
  });

  it("有人提的问题时，名单里写明「冲突以人的话为准」", () => {
    const text = renderOpenGaps([humanGap("排行榜要按周重置")]);
    assert.match(text, /以人的话为准/);
  });

  it("**并且要求把冲突报出来** —— 闷头照做，人就不知道自己在跟文档拧着", () => {
    const text = renderOpenGaps([humanGap("排行榜要按周重置")]);
    assert.match(text, /写进产出/);
    // 彻底的解法是去改上游，而那条边现在有了（§5.9.1 的 sendBack）。
    assert.match(text, /打回上游/);
  });

  it("模型报的问题不带这段 —— 它们跟上游没有「谁说了算」这回事", () => {
    const found: Gap = { ...humanGap("x"), id: "SPEC-1" };
    const text = renderOpenGaps([found]);
    assert.doesNotMatch(text, /以人的话为准/);
  });
});
