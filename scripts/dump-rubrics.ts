import { writeFileSync } from "node:fs";

import { isRetired, PHASES } from "../src/domain/phase";
import { reportsFreeFormBlockers } from "../src/domain/phase-play";
import { renderTemplate, templateFor } from "../src/domain/phase-template";
import { defaultCriteria } from "../src/domain/rubric-defaults";
import type { RubricRole } from "../src/domain/rubric";

/**
 * 把九份模板和每个阶段的标准导成一份人能读的文档。
 *
 * ## 为什么要有它
 *
 * 用户要看这两样东西的全貌，而它们住在两个代码文件里、按阶段散开。手抄一份出来
 * 就是**第二份拷贝**，而这棵树反复吃过那个亏（`upstreamOf` 那个错想法有过三份）。
 * 生成的那一份天然对得上，改了代码重跑一次就行。
 *
 * ## 它不进 `src/`
 *
 * 这是个导出工具，不是产品的一部分 —— 没有任何生产代码 import 它。
 *
 * 用法：`node --import tsx scripts/dump-rubrics.ts`
 */

const OUT = "docs/RUBRICS-AND-TEMPLATES.md";

const lines: string[] = [];
const p = (line = ""): void => { lines.push(line); };

p("# 环 v3 八个阶段的产出模板与评分标准");
p();
p("> **这份文档是从代码生成的**（`domain/phase-template.ts` + `domain/rubric-defaults.ts`），");
p("> 不是手抄的。改了代码就重新生成：`node --import tsx scripts/dump-rubrics.ts`");
p();
p("> **它们是起点，不是权威。** 真正的权威是你在面板「标准」页签里改出来的那一版 ——");
p("> 这里只保证一个新项目不是从空白开始。改动会随「把出厂标准升到最新版」进到已有项目，");
p("> **但只升从没被人改过的那些**。");
p();
p("## 怎么读这张表");
p();
p("| | |");
p("|---|---|");
p("| **模板** | 红方**必须照着写**，标题原样用。缺一节 → 开一条 `TEMPLATE-<节>` 挡住闸门（P1，你能 waive） |");
p("| **producer 标准** | 反方逐条判 yes/no，**挂了节的出厂就阻断**。这是这个阶段的尺度 —— 挂不上的问题就是越界，不许报 |");
p("| **critic / verdict 标准** | 讲的是**方法**不是产物，十二个阶段共用一份，永远不挂节、永远不阻断 |");
p();

const live = PHASES.filter((phase) => !isRetired(phase));
p(`**主线八个阶段每个都有模板**：${live.join(" / ")}`);
p();
p("**退休的不在这份文档里**（TechSpec / Plan / Review / Fix / Merge / Retro / Done）——"
  + "名字只为读历史而留着，没有 Change 会再走到它们。");
p();
p("---");
p();

for (const phase of PHASES) {
  if (isRetired(phase)) continue;
  const sections = templateFor(phase);
  const producer = defaultCriteria(phase, "producer");

  p(`# ${phase}`);
  p();
  p("反方在这一阶段：**" + (reportsFreeFormBlockers(phase)
    ? "自己去看，照旧交问题清单（无上限）"
    : "只判下面那几条标准，不另外提问题（每轮上限 = 标准条数，收敛 = 全 yes）") + "**");
  p();

  if (sections === null) {
    p("**没有模板** —— 产出是一个 commit。");
    p();
    p(`## 评分标准 · producer（${producer.length} 条，都不挂节、都不阻断）`);
    p();
    for (const entry of producer) p(`- ${entry.text}`);
    p();
    p();
    continue;
  }

  p(`## 填写模板（${sections.length} 节）`);
  p();
  p("```markdown");
  p(renderTemplate(sections));
  p("```");
  p();
  p(`## 评分标准 · producer（${producer.length} 条）`);
  p();
  for (const section of sections) {
    p(`**${section.title}**（\`${section.key}\`）`);
    p();
    for (const entry of producer.filter((each) => each.section === section.key)) {
      p(`- ${entry.text}`);
    }
    p();
  }
  p();
}

p("---");
p();
p("# 所有阶段共用的两份");
p();
p("> 它们讲的是**方法**：怎么质疑一份东西、怎么裁一场争论。这两件事在 PRD 和在 Merge");
p("> 是一样的，所以只有一份 —— 给每个阶段各抄一份只会得到十一份同样的话，然后各自漂移。");
p();

for (const [role, label] of [
  ["critic", "反方怎么质疑"], ["verdict", "裁判怎么裁"],
] as const) {
  p(`## ${role} · ${label}`);
  p();
  const shared = defaultCriteria("PRD", role as RubricRole);
  for (const entry of shared) p(`- ${entry.text}`);
  p();
  // Build 那两条是**追加**的，不是另一份 —— 见 rubric-defaults.ts 的 CRITIC_EXTRA。
  const extra = defaultCriteria("Build", role as RubricRole)
    .filter((each) => !shared.some((base) => base.text === each.text));
  if (extra.length > 0) {
    p("**Build 额外多判这几条**（追加，不是另一份）：");
    p();
    for (const entry of extra) p(`- ${entry.text}`);
    p();
  }
}

writeFileSync(OUT, `${lines.join("\n")}\n`);
console.log(`写好了：${OUT}（${lines.length} 行）`);
