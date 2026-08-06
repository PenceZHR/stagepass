import type { Phase } from "./phase";

/**
 * 一个阶段的产出模板 —— **把散文变成离散的**。
 *
 * ## 为什么要有它
 *
 * `BACKLOG.md` §5.6 已经推过这条理由，只是当时只用在代码上：**文档是连续的，改一处
 * 文字就产生新的可挑剔表面**；模块是离散的，可挑的表面小到能被穷尽。
 *
 * 真库取证（`~/.stagepass/panel.db` 的 CHG-001，21 轮跑完）：设计阶段每轮开 2~8 条，
 * **没有一个真正收敛**，全靠人 waive 才过闸门。PRD 四轮是同一句抱怨在降尺度，
 * 第四轮已经追到「13.0 的词法形式」。红方的隐含标准是「每个词都能唯一裁定」，
 * **任何有限文档都不满足它**，所以它能永远产出 4~5 条。
 *
 * 模板把无限表面切成有限个格子：格子有限 → 可挑表面有限 → **这才第一次有收敛点**。
 * 用户 2026-08-06：「必须照着模板来填，否则如果让模型自己发挥的话，是永远没法收敛的。」
 *
 * ## 和 `phase-play.ts` 同一条纪律
 *
 * 每个阶段各写各的，**不许提取公因子**。提取出来就是把模板悄悄请了回来，而下一次
 * 「只想改 PRD 那一节」又会变成往公共件上挂分支。
 *
 * ## 九个阶段有，Build / Fix 没有
 *
 * 用户 2026-08-06：「覆盖到所有 stage。」覆盖面止于**产出文档的阶段** ——
 * Build 和 Fix 交的是 commit，见 `TEMPLATES` 上面那段。
 *
 * 没有模板的阶段返回 `null`，调用方按「照旧」走，**不是按「空模板」走**：
 * 空模板会让红方收到一份零节的清单然后什么都不写。
 *
 * ## 这个模块是纯的，只 import 一个类型
 */
export interface TemplateSection {
  /** 跨版本稳定。rubric 的 criterion 挂在它上面（`domain/rubric.ts` 的 `section`）。 */
  readonly key: string;
  /** 红方要写的那个标题，**也是认节的依据**。 */
  readonly title: string;
  /** 这一节要回答什么。 */
  readonly asks: string;
}

/**
 * PRD 的六节。
 *
 * 内容是**起点不是权威** —— 和 `rubric-defaults.ts` 同一句话。真正的权威是用户改
 * 出来的那一版。
 *
 * `deferred` 那一节是承重的：它给「这件事属于下游」一个**红方声明**的位置。没有它，
 * 「架构没定」这种话除了开成 gap 无处可去 —— 真库里 PRD 那 18 条越界（追 TechSpec 的
 * 规范化对象、TestPlan 的失败阈值、Plan 的工具冻结版本）正是这么来的。
 */
const PRD_SECTIONS: readonly TemplateSection[] = [
  {
    key: "problem",
    title: "要解决谁的什么问题",
    asks: "谁在用、他今天怎么受阻、不解决会怎样。不要写要做什么功能。",
  },
  {
    key: "outcome",
    title: "做完之后什么变了",
    asks: "可观察的结果，不是功能清单。",
  },
  {
    key: "acceptance",
    title: "验收标准",
    asks: "每条可观察、可测量 —— 到「一个称职的实施者照着做不会做错」为止，"
      + "不要求每个词都能唯一裁定。",
  },
  {
    key: "out-of-scope",
    title: "这次不做什么",
    asks: "明确排除掉的。",
  },
  {
    key: "assumption",
    title: "前提",
    asks: "至少一条会让整个方案不成立的前提，以及怎么判它成不成立。",
  },
  {
    key: "fixed",
    title: "已经定死的约束",
    asks: "人已经拍死、这次不容商量的：技术栈、平台、必须兼容什么、不许动什么。"
      + "**只转述，不新定** —— 这里写的每一条都要说得出是谁定的。没有就写「没有」。",
  },
  {
    key: "deferred",
    title: "留给下游决定的",
    asks: "有意留给下游去定的，写明留给哪个阶段。架构、模块划分、接口、测试用例、"
      + "实现步骤都不在 PRD 里定；**已经被人定死的不写这儿，写上一节**。",
  },
];

/*
 * `fixed` 那一节是 2026-08-06 真机撞出来的。
 *
 * 第 3 轮和第 5 轮，`deferred` 那条标准**连着两轮判 no，而且红方两轮都改了**：
 * 它先把「Cocos Creator 3.8.8」写在结果和验收里（判 no），再挪进「留给下游决定的」
 * （还是判 no —— 一个不可退让的约束根本不是「留给谁决定」）。
 *
 * **红方赢不了，因为六节里没有一节放得下「人已经定死的东西」。** 那不是模型的问题，
 * 是模板漏了一格 —— 和 `rubric-defaults.ts` 里那句「一条只能靠猜的标准比没有更糟」
 * 同一个形状：一条**结构上满足不了**的标准，比没有更糟。
 */


/**
 * Spec 的五节。消费 PRD（`CONSUMES`）。
 *
 * `scope` 排第一是因为 Spec 唯一的立身之本是**它回答的是 PRD 提的那些问题** ——
 * 一份对不回上游的 Spec，后面每个阶段都在给一个没人要过的东西做实现。
 */
const SPEC_SECTIONS: readonly TemplateSection[] = [
  {
    key: "scope",
    title: "这份 Spec 覆盖 PRD 的哪几条",
    asks: "逐条对应回 PRD，写清哪条验收标准由这里的哪几段行为满足。没有凭空多出来的。",
  },
  {
    key: "behaviour",
    title: "行为",
    asks: "每条行为的正常路径：给什么、做什么、出什么。",
  },
  {
    key: "edge",
    title: "边界和出错",
    asks: "每条行为在边界上和出错时的表现。没有「其余情况未定义」这种写法。",
  },
  {
    key: "terms",
    title: "用词",
    asks: "这份文档里的关键词各是什么意思。和上游一致，同一个概念不发明第二个名字。",
  },
  {
    key: "deferred",
    title: "留给下游决定的",
    asks: "有意不在 Spec 定的，写明留给哪个阶段。数据怎么存、模块怎么划分、"
      + "用什么技术都不在 Spec 里定 —— 需要提到就写在这一节。",
  },
];

/** TechSpec 的六节。消费 Spec。 */
const TECHSPEC_SECTIONS: readonly TemplateSection[] = [
  {
    key: "data",
    title: "数据怎么存、状态怎么迁移",
    asks: "不只是模块怎么划分。哪些是权威、哪些是镜像，状态之间怎么走。",
  },
  {
    key: "interfaces",
    title: "接口与契约",
    asks: "模块之间谁调谁、传什么、返回什么、出错时返回什么。",
  },
  {
    key: "tradeoffs",
    title: "选择和它的代价",
    asks: "每一个技术选择都写代价，不只写好处。没有代价的选择说明还没想。",
  },
  {
    key: "riskiest",
    title: "最可能出错的一处",
    asks: "指名一处，写为什么是它。并列罗列多项风险不算回答了这一节。",
  },
  {
    key: "traceability",
    title: "对得回 Spec",
    asks: "这里的每条设计对应 Spec 的哪一条。没有引入 Spec 里不存在的行为。",
  },
  {
    key: "deferred",
    title: "留给下游决定的",
    asks: "有意留给 Plan 或 Build 的，写明留给哪个阶段。",
  },
];

/** Plan 的五节。消费 TechSpec。 */
const PLAN_SECTIONS: readonly TemplateSection[] = [
  {
    key: "steps",
    title: "步骤",
    asks: "每一步一个能独立交付的东西。一步做完就能看出对不对。",
  },
  {
    key: "order",
    title: "依赖和顺序",
    asks: "哪几步必须先后，为什么。没有两步在改同一处却没定顺序。",
  },
  {
    key: "verification",
    title: "每一步怎么验",
    asks: "每一步各自的判据，不要等到最后才知道对不对。",
  },
  {
    key: "rollback",
    title: "出问题怎么退",
    asks: "实施到一半失败了怎么退回去。只写停止条件不算回答了这一节。",
  },
  {
    key: "riskiest",
    title: "哪一步风险最高",
    asks: "指名一步，以及为什么先做或后做它。",
  },
];

/**
 * TestPlan 的五节。消费 TechSpec。
 *
 * ⚠ **不含「实际跑出来的结果」那一节。** 用户 2026-08-06 拍了「TestPlan 可以出测试
 * 方案和执行」，但今天 `PRODUCES_COMMIT` 只有 Build / Fix —— TestPlan 就算写了测试
 * 代码也会被静默丢掉（BACKLOG §8.4）。在那一刀落之前放这一节进来，就是造一条
 * 永远满足不了的硬要求，而那正是这套机制要防的事。
 */
const TESTPLAN_SECTIONS: readonly TemplateSection[] = [
  {
    key: "coverage",
    title: "验收标准到用例的映射",
    asks: "上游每条验收标准对应这里的哪几个用例。逐条列，不留空。",
  },
  {
    key: "cases",
    title: "用例",
    asks: "每个用例：给什么输入、在什么前置状态下、期望什么输出。",
  },
  {
    key: "failure",
    title: "失败长什么样",
    asks: "不只写成功。每个用例失败时看到的是什么，怎么和「测试自己写错了」区分开。",
  },
  {
    key: "gating",
    title: "哪些必须通过",
    asks: "区分「必须通过」和「知道会失败但先记着」，后者写明为什么先记着。",
  },
  {
    key: "how",
    title: "怎么跑",
    asks: "命令、环境、前置条件。别人照着能重现。没有「跑一遍看看」这种写法。",
  },
];

/** Review 的五节。消费 Build（以及它审的那几份上游）。 */
const REVIEW_SECTIONS: readonly TemplateSection[] = [
  {
    key: "subject",
    title: "审的是哪一个 commit",
    asks: "写出 sha。不要笼统地说「当前代码」—— 这份报告会被下一轮和下一个阶段当事实引用。",
  },
  {
    key: "against",
    title: "逐条对照上游的结果",
    asks: "对着 Spec 和 TechSpec 一条条看的结果，不是通读一遍谈感受。",
  },
  {
    key: "findings",
    title: "发现的问题",
    asks: "每条指明文件和位置，看的人能直接翻到那儿。没有就明写没有。",
  },
  {
    key: "severity",
    title: "哪些必须改",
    asks: "区分「必须改」和「可以这样也可以那样」。",
  },
  {
    key: "paths",
    title: "错误路径和边界",
    asks: "查过的错误路径和边界情况，不只是主流程。",
  },
];

/** QA 的五节。消费 Build 和 TestPlan。 */
const QA_SECTIONS: readonly TemplateSection[] = [
  {
    key: "subject",
    title: "测的是哪一个 commit",
    asks: "写出 sha。不要笼统地说「当前代码」。",
  },
  {
    key: "executed",
    title: "按 TestPlan 逐条执行的结果",
    asks: "一条都不跳。跳过的写明为什么。",
  },
  {
    key: "failures",
    title: "失败的用例",
    asks: "实际输出是什么、它来自哪一条用例。不只写「没过」。",
  },
  {
    key: "regression",
    title: "有没有让别处退化",
    asks: "这一轮的改动之外的地方，查过没有、结果是什么。",
  },
  {
    key: "repro",
    title: "怎么重现",
    asks: "跑的命令和环境写下来，别人照着能重现。",
  },
];

/** Merge 的四节。消费 Build。 */
const MERGE_SECTIONS: readonly TemplateSection[] = [
  {
    key: "what",
    title: "这次改了什么",
    asks: "对谁有影响。不要复述阶段名。",
  },
  {
    key: "risks",
    title: "被接受的风险",
    asks: "每一条写理由和影响范围。没有就明写没有 —— 默默放行不算回答了这一节。",
  },
  {
    key: "rollback",
    title: "怎么回滚",
    asks: "具体怎么做，不只是说「可以回滚」。",
  },
  {
    key: "coverage",
    title: "说明和实际改动对得上",
    asks: "这一次的每个 commit 都在上面的说明里，没有漏掉的。",
  },
];

/** Retro 的四节。 */
const RETRO_SECTIONS: readonly TemplateSection[] = [
  {
    key: "happened",
    title: "这一次真实发生了什么",
    asks: "真实发生的事，不是应该发生的事。",
  },
  {
    key: "process",
    title: "关于流程本身的",
    asks: "至少一条是关于流程的，不能全是关于代码的。",
  },
  {
    key: "next",
    title: "下次会不一样的做法",
    asks: "每条结论落到一个具体的做法。「以后要注意」不是一个做法。",
  },
  {
    key: "kept",
    title: "这次做对的事",
    asks: "不只写做错的。",
  },
];

/**
 * 哪些阶段有模板。
 *
 * ## Build 和 Fix 不在里面，而且这不是「还没做」
 *
 * `producesCommit = {Build, Fix}` —— 它们轮末交的是**一个 commit，不是一份文档**
 * （`work/round-turn-runner.ts` 明确不给它们文档路径）。给它们套模板等于造一份
 * 永远缺齐所有节的产出，每一节永远挡着闸门 —— 那是 `rubric-defaults.ts` 里那句
 * 「一条只能靠猜的标准比没有更糟」换个形状复发。
 *
 * 它们两个的不收敛是**自审**（BACKLOG §8.3：Build 自己写验证器、自己判），
 * 解法是测试归属 + 轮末 diff 闸门（§8.4），不是这一刀。
 *
 * `Done` 是终点，什么都不派。
 */
const TEMPLATES: Partial<Readonly<Record<Phase, readonly TemplateSection[]>>> = {
  PRD: PRD_SECTIONS,
  Spec: SPEC_SECTIONS,
  TechSpec: TECHSPEC_SECTIONS,
  Plan: PLAN_SECTIONS,
  TestPlan: TESTPLAN_SECTIONS,
  Review: REVIEW_SECTIONS,
  QA: QA_SECTIONS,
  Merge: MERGE_SECTIONS,
  Retro: RETRO_SECTIONS,
};

/** 这个阶段的模板，没有就 `null`。 */
export function templateFor(phase: Phase): readonly TemplateSection[] | null {
  return TEMPLATES[phase] ?? null;
}

/** 印给红方看的那份。 */
export function renderTemplate(sections: readonly TemplateSection[]): string {
  return sections.map((each) => `## ${each.title}\n${each.asks}`).join("\n\n");
}

/**
 * 哪几节没写。返回缺掉的 `key`，按模板顺序。
 *
 * ## 宽的是识别，严的是数数
 *
 * 和 `readBlueRubricAnswers` 同一条：少认出一节会把一份好产出判成不合格，**那和判错
 * 一样糟**。所以井号几个、标题前后的空格、行尾空格一律不计较。
 *
 * 但**标题要逐字相等，不是包含** —— 「## 验收标准怎么写」不是「验收标准」那一节。
 * 松到按包含认，两个标题会互相认领，而错认比没认出来更难查。
 *
 * ## 标题底下空着也算缺
 *
 * 填了标题不等于回答了。只查「到下一个标题之间有没有非空的一行」—— 再深就变成
 * 判内容质量了，而那是 rubric 的活儿，不是这儿的。
 */
export function missingSections(
  markdown: string,
  sections: readonly TemplateSection[],
): readonly string[] {
  const lines = markdown.split("\n");
  const titleOf = (line: string): string | null =>
    /^#{1,6}\s+(.*?)\s*$/.exec(line)?.[1] ?? null;

  const missing: string[] = [];
  for (const section of sections) {
    const at = lines.findIndex((line) => titleOf(line) === section.title);
    if (at < 0) {
      missing.push(section.key);
      continue;
    }
    const rest = lines.slice(at + 1);
    const until = rest.findIndex((line) => titleOf(line) !== null);
    const body = (until < 0 ? rest : rest.slice(0, until)).join("").trim();
    if (body === "") missing.push(section.key);
  }
  return missing;
}
