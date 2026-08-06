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
 * ## 只有 PRD 有
 *
 * 先只做一个，实际用过一轮确认形状对了，再复制给别的阶段 —— 用户 2026-07-22 定的
 * 纪律。没有模板的阶段返回 `null`，调用方按「照旧」走，**不是按「空模板」走**：
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
    key: "deferred",
    title: "留给下游决定的",
    asks: "有意不在 PRD 定的，写明留给哪个阶段。架构、技术栈、模块划分、接口、"
      + "测试用例、实现步骤都不在 PRD 里定 —— 需要提到就写在这一节。",
  },
];

const TEMPLATES: Partial<Readonly<Record<Phase, readonly TemplateSection[]>>> = {
  PRD: PRD_SECTIONS,
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
