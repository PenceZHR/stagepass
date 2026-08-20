import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * ## 环 v3：主线八个阶段每个都有
 *
 * 用户 2026-08-06：「覆盖到所有 stage。」原来止于「产出文档的阶段」，把 Build
 * 挡在外面 —— **而那个判据是错的**：Build 拿不到文档路径不是因为它交 commit，
 * 是因为 `round-turn-runner` 拿 `producesCommit` 顺手决定了「给不给路径」，
 * 把两件事绑成了互斥。解开之后交 commit 的阶段交两样：代码进 commit，报告进
 * 模板。退休的阶段不给（TechSpec 先例，理由见 TEMPLATES 上面那段）。
 *
 * 没有模板的阶段返回 `null`，调用方按「照旧」走，**不是按「空模板」走**：
 * 空模板会让红方收到一份零节的清单然后什么都不写。
 *
 * ## 正文文本储存（2026-08-13）
 *
 * 用户拍板：**提示词要模块化、文本储存**。每个阶段的节在
 * `src/prompts/templates/<Phase>.md` 里，那里是**源头** —— 改模板去改 .md，
 * 不是改这里。这个模块从纯数据变成装配器：启动时读自己包里的文件
 * （和 `panel-server` 找 `panel.html` 同一个动作），解析失败**响亮地抛**。
 * 迁移那天用往返对比证过逐字节相等，此后 `round-prompt.golden.txt` 继续钉着
 * 装配出的每一个字节。
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
 * 把一份模板源文件解析成节（用户 2026-08-13 拍板：提示词要模块化、文本储存）。
 *
 * 格式（`src/prompts/templates/<Phase>.md`）：
 *
 * ```
 * <!-- section: key -->
 * ## 标题
 * 正文（可以多行；文件里一行就是字符串里一行，首尾空行修掉）
 * ```
 *
 * 第一个节标记之前的内容是文件头注释，整个跳过 —— 给编辑模板的人放说明用。
 *
 * **坏文件要响亮地拒绝，不许静默吞节。** 吞掉一节，红方就会收到一份缺格的清单
 * 然后照缺的写 —— 和「空模板」同一个坑（模块头上写过为什么 null ≠ 空模板）。
 * 这儿抛出去会让面板起不来，而「起不来 + 一句指到文件的话」远好过跑了三轮才
 * 发现模板缺了一节。
 */
export function parseTemplateSections(text: string): TemplateSection[] {
  const marker = /^<!--\s*section:\s*([A-Za-z0-9-]+)\s*-->$/;
  const lines = text.split("\n");
  const sections: TemplateSection[] = [];
  const seen = new Set<string>();

  let at = lines.findIndex((line) => marker.test(line));
  if (at < 0) throw new Error("模板文件里没有任何节标记（<!-- section: … -->）");
  while (at >= 0) {
    const key = marker.exec(lines[at]!)![1]!;
    if (seen.has(key)) throw new Error(`模板的节 key 重复：${key}`);
    seen.add(key);
    const next = lines.findIndex(
      (line, index) => index > at && marker.test(line));
    const block = lines.slice(at + 1, next < 0 ? lines.length : next);

    const titleAt = block.findIndex((line) => line.startsWith("## "));
    if (titleAt < 0) throw new Error(`节 ${key} 没有 \`## 标题\` 行`);
    const body = block.slice(titleAt + 1);
    while (body.length > 0 && body[0]!.trim() === "") body.shift();
    while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
    if (body.length === 0) throw new Error(`节 ${key} 的正文是空的`);

    sections.push({
      key,
      title: block[titleAt]!.slice("## ".length).trim(),
      asks: body.join("\n"),
    });
    at = next;
  }
  return sections;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 模板目录在哪。两个候选，按序取第一个存在的：
 *
 * - `HERE/prompts` —— **打包后**：构建把模板装进插件目录本身。装在版本目录**旁边**
 *   的那版被真机咬过（2026-08-18 晚）：`~/.codex/plugins/cache/…` 是 Codex 的缓存，
 *   刷新时只物化插件包自己，兄弟目录被抹掉 —— 于是 server 在第一条消息之前就抛
 *   ENOENT，Codex 那边只看到「握手超时」。
 * - `HERE/../prompts` —— **源码树**：`src/domain/` 旁边就是 `src/prompts/`。
 *
 * 都不在就抛，路径全列出来 —— 「模板不见了」必须说得出它去哪儿找过。
 */
function promptsRoot(): string {
  const candidates = [join(HERE, "prompts"), join(HERE, "..", "prompts")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "templates"))) return candidate;
  }
  throw new Error(`找不到提示词模板目录，找过：${candidates.join("、")}`);
}

/** 读一份模板源文件。文件名就是阶段名 —— 一处约定，别在别处再写一遍。 */
function load(phase: string): readonly TemplateSection[] {
  const path = join(promptsRoot(), "templates", `${phase}.md`);
  try {
    return parseTemplateSections(readFileSync(path, "utf-8"));
  } catch (error: unknown) {
    // 把文件路径带上再抛 —— 「节 x 的正文是空的」不带路径，人不知道去改哪份。
    throw new Error(`${path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

/*
 * 各份模板的历史（正文在 .md 里，**为什么长成那样**的账在这儿）：
 *
 * - **PRD 七节**。`deferred` 是承重的：它给「这件事属于下游」一个红方声明的位置，
 *   没有它，「架构没定」除了开成 gap 无处可去（真库 18 条越界正是这么来的）。
 *   `fixed` 是 2026-08-06 真机撞出来的：第 3、5 轮红方连输两轮，因为六节里没有
 *   一节放得下「人已经定死的东西」—— 一条**结构上满足不了**的标准比没有更糟。
 * - **Spec 五节**。`scope` 排第一：Spec 唯一的立身之本是它回答的是 PRD 提的问题。
 * - **Arch 十一节**（2026-08-08 用户拍：TechSpec 并进来 —— 两份文档讲同一批决定
 *   的两个粒度必然漂移，真机证据是 Arch 产出里七次「留给 TechSpec」）。每节写死
 *   粒度下限，因为用户 2026-08-08：「精细到一个文件的函数和模块」——
 *   **问到哪一层，就只会答到哪一层**。`graph` 那节要求另存 arch.graph.json，
 *   机器对账 + 画图谱（spec 2026-08-12）。
 * - **BuildPlan 五节**（环 v3 前叫 Plan，.md 文件名跟着现役阶段名走）。
 * - **TestPlan 五节**。职责两步收窄：2026-08-06 撤掉 `ran`（写方案的人自己不跑）；
 *   环 v3 连测试代码也挪去 Test —— 文档和 commit 混在一个阶段，正是并行工作区
 *   冲突的根源。用例的「落点文件」从「我写在哪了」变成**声明**：Test 照它写、
 *   批 4 的工作区围栏按它挡门。
 * - **Build 六节** —— 施工报告，不是代码本身。`tests` 那节是承重的：两轨互盲，
 *   Build 连读测试都不许，这一节只收「改动本身的验证」，露馅由轮末 diff 闸门兜。
 * - **Test 四节**（环 v3 从 TestPlan 拆出）。`selfrun` 不许拿实现来跑 ——
 *   测试对不对得上实现是 QA 对撞的事。
 * - **QA 八节** —— 两轨对撞点（批 5）。三攻各有落点：读 → against/findings、
 *   跑 → executed/failures、变 → mutation。案卷不在这儿装订 —— 任务书里的上游
 *   投递就是案卷，不另建第二份事实。
 *
 * 退休阶段（TechSpec 08-08；Plan / Review / Merge / Retro 环 v3）**不给模板**，
 * 也不留 .md：留一份在那儿，下一个人会以为它还在用。`templateFor` 返回 null =
 * 红方不受模板约束、缺节也不挡门（`domain/phase.ts` 的 `RETIRED_PHASES`）。
 * 历史读产出时对节标题，靠的是产出文档自己，不靠这儿留底。
 */
const TEMPLATES: Partial<Readonly<Record<Phase, readonly TemplateSection[]>>> = {
  PRD: load("PRD"),
  Spec: load("Spec"),
  Arch: load("Arch"),
  BuildPlan: load("BuildPlan"),
  TestPlan: load("TestPlan"),
  Build: load("Build"),
  Test: load("Test"),
  QA: load("QA"),
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
