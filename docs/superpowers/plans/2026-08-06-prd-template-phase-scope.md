# PRD 模板 + 每阶段尺度 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PRD 阶段的红方照固定模板产出、反方只对着模板节逐条判 yes/no，**把收敛从「人的耐心」变成「全 yes」这个机械判据**。

**Architecture:** 新增一个纯模块 `domain/phase-template.ts` 存模板（和 `phase-play.ts` 同层、同纪律：每阶段独自变、不许提公因子）。`rubric_criteria` 加一列 `section` 把标准挂到模板节上。设计阶段反方的 `blockers` 用**已有的** `discardBlockers` 机制丢掉——和红方在自审阶段被丢掉的是同一条路。

**Tech Stack:** TypeScript / Node（`node --import tsx`）、better-sqlite3、`node:test`。

## Global Constraints

- **验收命令**：`pnpm check`（typecheck + test）。**一条红就是真回归**——新树基线是全绿。
- **`.test.ts` 也过类型检查**（`tsconfig.src.json` 包含它们，且更严：`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）。
- **常驻护栏不许红**（`src/architecture.test.ts`）：分层不许下层 import 上层；**没有任何 export 是零引用**；代码里不许出现阶段别名。
- **`domain/round-prompt.golden.txt` 逐字节钉着十二份提示词**：改一条 `PHASE_PLAY` 记录，其余十一条的快照必须纹丝不动。改了 golden 必须**逐行看 diff**，确认只动了该动的那份。
- **出厂 `blocking` 默认仍是 `false`**，只有模板节派生的 PRD producer criteria 例外（Task 5）。别顺手改别处。
- **不许 `exec`，只走面板 TUI**（验证性实验也算）。
- 真库是 `~/.stagepass/panel.db`，**动之前说、动完就报**。只读查询随便跑。

---

### Task 1: PRD 模板模块

**Files:**
- Create: `src/domain/phase-template.ts`
- Create: `src/domain/phase-template.test.ts`
- Modify: `src/architecture.test.ts`（给新模块声明所属层 = domain）

**Interfaces:**
- Produces:
  - `interface TemplateSection { readonly key: string; readonly title: string; readonly asks: string }`
  - `function templateFor(phase: Phase): readonly TemplateSection[] | null` —— `null` = 这个阶段还没有模板
  - `function renderTemplate(sections: readonly TemplateSection[]): string` —— 给红方看的正文
  - `function missingSections(markdown: string, sections: readonly TemplateSection[]): readonly string[]` —— 返回缺掉的 `key`

- [ ] **Step 1: 写失败的测试**

```ts
// src/domain/phase-template.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { missingSections, renderTemplate, templateFor } from "./phase-template";

test("PRD 有模板，别的阶段暂时没有", () => {
  assert.equal(templateFor("PRD")?.length, 6);
  assert.equal(templateFor("Spec"), null);
});

test("节的 key 不重复", () => {
  const keys = templateFor("PRD")!.map((each) => each.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("渲染出来的每一节都带标题和它要回答什么", () => {
  const text = renderTemplate(templateFor("PRD")!);
  for (const section of templateFor("PRD")!) {
    assert.ok(text.includes(section.title), `缺标题 ${section.title}`);
    assert.ok(text.includes(section.asks), `缺说明 ${section.key}`);
  }
});

test("按标题认节 —— 全都在就没有缺的", () => {
  const filled = templateFor("PRD")!
    .map((each) => `## ${each.title}\n\n随便写点什么\n`).join("\n");
  assert.deepEqual(missingSections(filled, templateFor("PRD")!), []);
});

test("少一节就报那一节的 key", () => {
  const sections = templateFor("PRD")!;
  const filled = sections.slice(1)
    .map((each) => `## ${each.title}\n\n随便写点什么\n`).join("\n");
  assert.deepEqual(missingSections(filled, sections), [sections[0]!.key]);
});

test("有标题但底下是空的，也算缺 —— 填了标题不等于回答了", () => {
  const sections = templateFor("PRD")!;
  const filled = sections
    .map((each, index) => index === 2 ? `## ${each.title}\n\n   \n` : `## ${each.title}\n\n有内容\n`)
    .join("\n");
  assert.deepEqual(missingSections(filled, sections), [sections[2]!.key]);
});

test("标题前后的空格和井号个数不计较", () => {
  const sections = templateFor("PRD")!;
  const filled = sections.map((each) => `#   ${each.title}   \n有内容\n`).join("\n");
  assert.deepEqual(missingSections(filled, sections), []);
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `node --import tsx --test src/domain/phase-template.test.ts`
Expected: FAIL —— `Cannot find module './phase-template'`

- [ ] **Step 3: 写实现**

```ts
// src/domain/phase-template.ts
import type { Phase } from "./phase";

/**
 * 一个阶段的产出模板 —— **把散文变成离散的**。
 *
 * ## 为什么要有它
 *
 * `BACKLOG.md` §5.6 已经推过这条理由，只是当时只用在代码上：**文档是连续的，改一处
 * 文字就产生新的可挑剔表面**；模块是离散的，可挑的表面小到能被穷尽。
 *
 * 真库取证（CHG-001，21 轮）：设计阶段每轮开 2~8 条，**没有一个真正收敛**，全靠人
 * waive 才过闸门。PRD 四轮是同一句抱怨在降尺度，第四轮已经追到「13.0 的词法形式」。
 * 红方的隐含标准是「每个词都能唯一裁定」，**任何有限文档都不满足它**。
 *
 * 模板把无限表面切成有限个格子：格子有限 → 可挑表面有限 → **这才第一次有收敛点**。
 * 用户 2026-08-06：「必须照着模板来填，否则如果让模型自己发挥的话，是永远没法收敛的。」
 *
 * ## 和 `phase-play.ts` 同一条纪律
 *
 * 每个阶段各写各的，**不许提取公因子**。提取出来就是把模板悄悄请了回来，
 * 而下一次「只想改 PRD 那一节」又会变成往公共件上挂分支。
 *
 * ## 只有 PRD 有
 *
 * 先只做一个，实际用过一轮确认形状对了，再复制给别的阶段 —— 用户 2026-07-22 定的
 * 纪律。没有模板的阶段返回 `null`，调用方按「照旧」走，不是按「空模板」走：
 * 空模板会让红方收到一份零节的清单然后什么都不写。
 *
 * ## 这个模块是纯的，只 import 一个类型
 */
export interface TemplateSection {
  /** 跨版本稳定，rubric 的 criterion 挂在它上面。 */
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
 * `deferred` 那一节是承重的：它给「这件事属于下游」一个**红方声明**的位置。没有
 * 它，「架构没定」这种话除了开成 gap 无处可去 —— 真库里 PRD 那 18 条越界（追
 * TechSpec 的规范化对象、TestPlan 的失败阈值、Plan 的工具冻结版本）正是这么来的。
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
  return sections
    .map((each) => `## ${each.title}\n${each.asks}`)
    .join("\n\n");
}

/**
 * 标题行认节。**宽的是识别，严的是数数** —— 和 `readBlueRubricAnswers` 同一条：
 * 少认出一节会把一份好产出判成不合格，那和判错一样糟。
 *
 * 井号几个、前后空格、行尾空格一律不计较；**标题底下没有非空内容也算缺** ——
 * 填了标题不等于回答了。
 */
export function missingSections(
  markdown: string,
  sections: readonly TemplateSection[],
): readonly string[] {
  const lines = markdown.split("\n");
  const headingAt = (title: string): number =>
    lines.findIndex((line) => /^#{1,6}\s+(.*?)\s*$/.exec(line)?.[1] === title);

  const missing: string[] = [];
  for (const section of sections) {
    const at = headingAt(section.title);
    if (at < 0) { missing.push(section.key); continue; }
    // 到下一个标题为止，中间要有非空的一行。
    const rest = lines.slice(at + 1);
    const until = rest.findIndex((line) => /^#{1,6}\s+/.test(line));
    const body = (until < 0 ? rest : rest.slice(0, until)).join("").trim();
    if (body === "") missing.push(section.key);
  }
  return missing;
}
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `node --import tsx --test src/domain/phase-template.test.ts`
Expected: PASS，7 个测试全过

- [ ] **Step 5: 给新模块声明所属层**

先 `Read src/architecture.test.ts`，找到那张「每个模块声明所属层」的表和那张引用计数表，
按现有写法给 `domain/phase-template.ts` 加一行。引用计数这一轮先填实际值（跑一次测试，
红了它会告诉你真实数字）。

- [ ] **Step 6: 全量验收 + 提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add src/domain/phase-template.ts src/domain/phase-template.test.ts src/architecture.test.ts
git commit -m "feat: PRD 有模板了 —— 把散文切成六个能被穷尽的格子"
```

---

### Task 2: 模板进红方的提示词

**Files:**
- Modify: `src/domain/round.ts`（`RoundInstructions` 加一格；`judgePrompt` 红方那节印出来）
- Modify: `src/domain/round.test.ts`
- Modify: `src/domain/round-prompt.golden.txt`（**只允许 PRD 那份变**）
- Modify: `src/work/round-turn-runner.ts`（把模板塞进 `RoundInstructions`）

**Interfaces:**
- Consumes: `templateFor`、`renderTemplate`（Task 1）
- Produces: `RoundInstructions.template?: readonly TemplateSection[]`

- [ ] **Step 1: 写失败的测试**

```ts
// 加进 src/domain/round.test.ts
test("PRD 的提示词里带模板，而且抬头写明要转达给正方", () => {
  const prompt = judgePrompt({ ...baseInstructions("PRD"), template: templateFor("PRD")! });
  assert.ok(prompt.includes("要解决谁的什么问题"));
  assert.ok(prompt.includes("留给下游决定的"));
  // 抬头。理由见 round.ts 里那四张脸：只有原文加收件人才到得了。
  assert.ok(/原样转达给正方[\s\S]{0,200}要解决谁的什么问题/.test(prompt));
});

test("没有模板的阶段一个字都不印 —— 空小节会让裁判去猜", () => {
  const prompt = judgePrompt(baseInstructions("Spec"));
  assert.ok(!prompt.includes("必须照下面这个模板"));
});
```

> `baseInstructions(phase)` 是这个测试文件里已有的夹具；照现有写法用，别新造一个。
> 找不到就先 `Read src/domain/round.test.ts` 看它现在怎么造 `RoundInstructions`。

- [ ] **Step 2: 跑一遍确认它红**

Run: `node --import tsx --test src/domain/round.test.ts`
Expected: FAIL —— `template` 不是 `RoundInstructions` 的字段

- [ ] **Step 3: 写实现**

在 `src/domain/round.ts` 的 `RoundInstructions` 里加：

```ts
  /**
   * 这个阶段的产出模板。缺席 = 这个阶段还没有模板，红方照旧自由发挥。
   *
   * **不是空数组** —— 空数组会让红方收到一份零节的清单然后什么都不写。
   */
  readonly template?: readonly TemplateSection[];
```

在 `judgePrompt` 里，紧跟 `input.task`（`round.ts:520`）之后插入：

```ts
    ...(input.template === undefined ? [] : [
      /*
       * 模板走原文不走路径。判据和「打回的理由」那段一样：走文件的是**天然是一份
       * 文档、而且能有几百字**的东西（需求、名单、契约说明）。模板是这一轮活儿的
       * 骨架，红方**必须一眼看见** —— 少了它产出的形状就不对，而形状不对是整轮
       * 作废（`missingSections` 那道闸门），不是「少点信息」。判据是「缺了会怎样」。
       */
      `   下面这份模板**原样转达给${RED}**，一个字都不要改 ——`
      + `它必须照这个模板写，每一节都要有，标题原样用：`,
      renderTemplate(input.template),
      `   模板之外不要另起小节。**架构、技术栈、模块划分、接口、测试用例、实现步骤`
      + `都不在这个阶段定** —— 需要提到就写进「留给下游决定的」那一节。`,
    ]),
```

在 `src/work/round-turn-runner.ts` 里，构造 `RoundInstructions` 的地方加上
（先 `Read` 那个文件找到构造点，按现有写法插入；`?? undefined` 是因为
`exactOptionalPropertyTypes` 开着，`null` 不能直接赋给可选字段）：

```ts
    ...(templateFor(phase) === null ? {} : { template: templateFor(phase)! }),
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `node --import tsx --test src/domain/round.test.ts`
Expected: PASS

- [ ] **Step 5: 更新 golden 并逐行看 diff**

Run: 先跑 `pnpm check`，golden 测试会红并打出差异。按它的提示重生成，然后：

```bash
git diff src/domain/round-prompt.golden.txt
```

Expected: **只有 PRD 那一份变了**，其余十一份纹丝不动。不是这样就说明插入点写错了，回去改。

- [ ] **Step 6: 全量验收 + 提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add src/domain/round.ts src/domain/round.test.ts src/domain/round-prompt.golden.txt src/work/round-turn-runner.ts
git commit -m "feat: PRD 的红方收到模板原文（抬头写明收件人）"
```

---

### Task 3: 缺节 = 这一轮不合格

**Files:**
- Modify: `src/domain/round.ts`（`readRound` 之外新增一个纯函数）
- Modify: `src/domain/round.test.ts`
- Modify: `src/work/round-turn-runner.ts`（读产出文件、判缺节）

**Interfaces:**
- Consumes: `missingSections`（Task 1）
- Produces: `class TemplateIncompleteError extends Error { readonly missing: readonly string[] }`

- [ ] **Step 1: 写失败的测试**

```ts
// 加进 src/domain/round.test.ts
test("缺节就抛，理由说得具体到能照着修", () => {
  const sections = templateFor("PRD")!;
  const partial = sections.slice(0, 3)
    .map((each) => `## ${each.title}\n有内容\n`).join("\n");
  const error = assert.throws(
    () => assertTemplateComplete(partial, sections),
    TemplateIncompleteError,
  ) as TemplateIncompleteError;
  assert.deepEqual([...error.missing], ["out-of-scope", "assumption", "deferred"]);
  assert.ok(error.message.includes("这次不做什么"), "报错要带人读得懂的标题");
});

test("六节齐了就过", () => {
  const sections = templateFor("PRD")!;
  const full = sections.map((each) => `## ${each.title}\n有内容\n`).join("\n");
  assert.doesNotThrow(() => assertTemplateComplete(full, sections));
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `node --import tsx --test src/domain/round.test.ts`
Expected: FAIL —— `assertTemplateComplete is not exported`

- [ ] **Step 3: 写实现**

```ts
// src/domain/round.ts
/**
 * 产出没照模板写 —— **这一轮不合格，不是「少了点内容」**。
 *
 * 为什么是硬闸门不是叮嘱：模板的全部意义是把可挑剔的表面切成有限个。少一节，
 * 那一节的内容就散回散文里去了，反方对着它又只能自由发挥 —— 收敛点当场没了。
 * 和干净树预检同一个形状：机械判据，不是叮嘱（`phase.ts:212` 那条先例）。
 */
export class TemplateIncompleteError extends Error {
  constructor(readonly missing: readonly string[], readonly titles: readonly string[]) {
    super(`产出缺了这几节：${titles.join("、")}`);
    this.name = "TemplateIncompleteError";
  }
}

export function assertTemplateComplete(
  markdown: string,
  sections: readonly TemplateSection[],
): void {
  const missing = missingSections(markdown, sections);
  if (missing.length === 0) return;
  const titles = missing.map(
    (key) => sections.find((each) => each.key === key)!.title,
  );
  throw new TemplateIncompleteError(missing, titles);
}
```

在 `src/work/round-turn-runner.ts` 里，**红方产出落地之后、派反方之前**调它。
先 `Read` 那个文件确认红方产出是怎么读回来的（`redDocPath` 指的文件），然后：

```ts
    const sections = templateFor(phase);
    if (sections !== null) {
      assertTemplateComplete(await repo.readFile(redDocPath(changeId, phase, round)), sections);
    }
```

> ⚠ **读文件的确切 API 名字要照 `round-turn-runner.ts` 现有的写法**，别按这里的
> `repo.readFile` 硬抄 —— 那是示意。找不到现成的读法就往上一层找，别自己新造一个 IO 面。

- [ ] **Step 4: 跑测试确认它绿**

Run: `node --import tsx --test src/domain/round.test.ts`
Expected: PASS

- [ ] **Step 5: 全量验收 + 提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add src/domain/round.ts src/domain/round.test.ts src/work/round-turn-runner.ts
git commit -m "feat: 产出缺模板节 = 这一轮不合格（机械判据，不是叮嘱）"
```

---

### Task 4: `rubric_criteria` 加 `section` 列

**Files:**
- Modify: `src/db/schema.ts:617-626`（`migrate` 的 `added` 表 + `SCHEMA_SQL` 里 `rubric_criteria` 的建表语句）
- Modify: `src/domain/rubric.ts`（`Criterion` / `CriterionDraft` 加 `section`）
- Modify: `src/store/rubric-store.ts`（`save` / `hydrate` 带上它）
- Modify: `src/db/schema.test.ts`、`src/domain/rubric.test.ts`、`src/store/rubric-store.test.ts`

**Interfaces:**
- Produces: `Criterion.section: string | null`、`CriterionDraft.section?: string | null`
  （`null` = 不挂任何节，老数据全是这个）

- [ ] **Step 1: 写失败的测试**

```ts
// 加进 src/store/rubric-store.test.ts
test("criterion 挂的节存得住、读得回来", () => {
  const scope = { projectId: PROJECT, changeId: null, phase: "PRD" as const, role: "producer" as const };
  rubrics.save(scope, [
    { text: "写清楚了要解决谁的什么问题", blocking: true, section: "problem" },
    { text: "老的那种，不挂节", blocking: false },
  ]);
  const current = rubrics.current(scope)!;
  assert.equal(current.criteria[0]!.section, "problem");
  assert.equal(current.criteria[1]!.section, null, "没给就是 null，不是 undefined");
});
```

```ts
// 加进 src/db/schema.test.ts —— 老库升级这条必须自己钉住
test("老库加得上 section 列，而且老行是 NULL", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE rubric_criteria (
    rubric_id TEXT NOT NULL, criterion_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
    text TEXT NOT NULL, blocking INTEGER NOT NULL,
    PRIMARY KEY (rubric_id, criterion_key))`);
  db.prepare("INSERT INTO rubric_criteria VALUES (?,?,?,?,?)").run("R1", "K1", 0, "老的", 0);
  migrate(db);
  const row = db.prepare("SELECT section FROM rubric_criteria WHERE criterion_key = ?").get("K1");
  assert.equal((row as { section: string | null }).section, null);
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `node --import tsx --test src/store/rubric-store.test.ts src/db/schema.test.ts`
Expected: FAIL —— `section` 不在类型里 / 列不存在

- [ ] **Step 3: 写实现**

`src/db/schema.ts` 的 `added` 表加一行（**只加可空列，正是这个机制唯一处理的那一种**）：

```ts
    ["rubric_criteria", "section", "TEXT"],
```

同时把 `SCHEMA_SQL` 里 `rubric_criteria` 的建表语句加上 `section TEXT NULL,`
（新库直接建出来，不靠 migrate 补）。

`src/domain/rubric.ts`：

```ts
export interface Criterion {
  readonly key: string;
  readonly ordinal: number;
  readonly text: string;
  readonly blocking: boolean;
  /**
   * 它判的是模板的哪一节。`null` = 不挂节（老数据、以及还没有模板的阶段）。
   *
   * 挂节是「越界」这件事唯一的机械判据：一条标准说得清自己管哪一节，
   * 才谈得上「这个问题不归这个阶段管」。
   */
  readonly section: string | null;
}

export interface CriterionDraft {
  readonly key?: string | null;
  readonly text: string;
  readonly blocking: boolean;
  readonly section?: string | null;
}
```

`nextVersion` 里造新 `Criterion` 的地方带上 `section: draft.section ?? null`。

`src/store/rubric-store.ts` 的 `save`（INSERT 语句）和 `hydrate`（SELECT 映射）
各带一格。**`hydrate` 里要写 `section: row.section ?? null`** —— 老行读回来是
`undefined` 还是 `null` 取决于驱动，统一成 `null`。

- [ ] **Step 4: 跑测试确认它绿**

Run: `node --import tsx --test src/store/rubric-store.test.ts src/db/schema.test.ts src/domain/rubric.test.ts`
Expected: PASS

- [ ] **Step 5: 全量验收 + 提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add src/db/schema.ts src/db/schema.test.ts src/domain/rubric.ts src/domain/rubric.test.ts src/store/rubric-store.ts src/store/rubric-store.test.ts
git commit -m "feat: criterion 挂到模板节上 —— 越界第一次有了机械判据"
```

---

### Task 5: PRD 的 rubric 按六节铺开

**Files:**
- Modify: `src/domain/rubric-defaults.ts`
- Modify: `src/domain/rubric-defaults.test.ts`

**Interfaces:**
- Consumes: `templateFor`（Task 1）、`CriterionDraft.section`（Task 4）
- Produces: `defaultCriteria("PRD", "producer")` 返回带 `section` 且 `blocking: true` 的条目

- [ ] **Step 1: 写失败的测试**

```ts
// 加进 src/domain/rubric-defaults.test.ts
test("PRD 的 producer 标准每条都挂在一个真实存在的模板节上", () => {
  const keys = new Set(templateFor("PRD")!.map((each) => each.key));
  for (const draft of defaultCriteria("PRD", "producer")) {
    assert.ok(draft.section !== null && draft.section !== undefined, `没挂节：${draft.text}`);
    assert.ok(keys.has(draft.section!), `挂到了不存在的节 ${draft.section}`);
  }
});

test("六节每一节都至少有一条标准 —— 没人判的节等于没有那一节", () => {
  const covered = new Set(defaultCriteria("PRD", "producer").map((each) => each.section));
  for (const section of templateFor("PRD")!) {
    assert.ok(covered.has(section.key), `没人判这一节：${section.key}`);
  }
});

test("模板节派生的这些出厂就阻断，其余照旧不阻断", () => {
  assert.ok(defaultCriteria("PRD", "producer").every((each) => each.blocking));
  assert.ok(defaultCriteria("Spec", "producer").every((each) => !each.blocking));
  assert.ok(defaultCriteria("PRD", "critic").every((each) => !each.blocking));
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `node --import tsx --test src/domain/rubric-defaults.test.ts`
Expected: FAIL —— PRD 那四条既没有 `section` 也不 `blocking`

- [ ] **Step 3: 写实现**

把 `PRODUCER.PRD` 那四条换成按节铺开的版本。**这是这一刀真正的工作量，用户已经明确
选择把成本花在这儿**（2026-08-06：「我宁可在每个阶段写的比较详细，也不要互相的扯皮」）。

`PRODUCER` 的元素类型从 `string` 变成 `{ text: string; section?: string }`。**`CRITIC` /
`VERDICT` / `CRITIC_EXTRA` / `VERDICT_EXTRA` 保持 `string[]` 不动** —— 它们讲的是方法，
和模板节无关，改它们只会得到十一份要维护的 `section: undefined`。

于是 `defaultCriteria` 变成两条路：

```ts
type ProducerEntry = { readonly text: string; readonly section?: string };

export function defaultCriteria(phase: Phase, role: RubricRole): CriterionDraft[] {
  if (role === "producer") {
    return PRODUCER[phase].map((entry) => ({
      text: entry.text,
      // 挂了节就出厂阻断。判据是结构性的 —— 不是一张要维护的例外名单。
      blocking: entry.section !== undefined,
      section: entry.section ?? null,
    }));
  }
  if (PRODUCER[phase].length === 0) return [];          // 终局阶段，照旧
  const texts = role === "critic"
    ? [...CRITIC, ...CRITIC_EXTRA[phase] ?? []]
    : [...VERDICT, ...VERDICT_EXTRA[phase] ?? []];
  return texts.map((text) => ({ text, blocking: false, section: null }));
}
```

十一个阶段的 `PRODUCER` 条目只要写成 `{ text: "…" }`（不带 `section`），行为就和改之前
逐字一致：`blocking: false`、`section: null`。**只有 PRD 那一格变。**

```ts
  PRD: [
    { section: "problem", text: "写清楚了用的人是谁、他今天怎么受阻，而不是先写要做什么功能" },
    { section: "problem", text: "写了不解决会怎样，而不只是说「需要改进」" },
    { section: "outcome", text: "写的是做完之后可观察的变化，不是一张功能清单" },
    { section: "acceptance", text: "每条验收标准都可观察、可测量" },
    { section: "acceptance", text: "验收标准细到一个称职的实施者照着做不会做错就够了，没有去追每个词的唯一裁定" },
    { section: "acceptance", text: "每条验收标准都对得上前面写的那个结果，没有凭空多出来的" },
    { section: "out-of-scope", text: "明确写出了这一次不做什么" },
    { section: "assumption", text: "列出了至少一个会让整个方案不成立的前提" },
    { section: "assumption", text: "每条前提都写了怎么判它成不成立" },
    { section: "deferred", text: "架构、技术栈、模块划分、接口、测试用例、实现步骤都没有在这一份里定" },
    { section: "deferred", text: "有意留给下游的每一项都写明了留给哪个阶段" },
  ],
```

> **`acceptance` 那条「细到…就够了」是这份设计里唯一直接掐颗粒度的标准。** 它对着的
> 是真库那条实证：PRD 四轮是同一句抱怨在降尺度，第四轮追到了「13.0 的词法形式」。

`defaultCriteria` 里 `blocking` 的算法改成：**这一条挂了 `section` 就 `true`，否则
`false`**。这样「出厂一律不阻断」那条老规矩在没有模板的十一个阶段一个字都没变，而
判据是结构性的、不是写一张例外名单。

在 `rubric-defaults.ts` 开头那段注释里补一节说明为什么模板节例外：

```
 * ## 2026-08-06：模板节派生的那些出厂就阻断
 *
 * 原来一律 false 防的是「`not_assessed` 视同阻断 → 任何一次漏答都给新项目挂上挡门
 * 的东西」。**在模板下漏答有了另一个出口**：缺节在红方那一侧就被
 * `assertTemplateComplete` 机械判掉了，轮不到反方漏答；而反方漏判某一节，本来就
 * 该挡 —— 那一节没有人看过。
 *
 * 真库取证：298 条 criterion 全 blocking=0，反方答出来的 64 个 `no` **一条都没挡门、
 * 一条都没变成 gap**。准的那条路只说不算，野的那条路说了算。
```

- [ ] **Step 4: 跑测试确认它绿**

Run: `node --import tsx --test src/domain/rubric-defaults.test.ts`
Expected: PASS

- [ ] **Step 5: 全量验收 + 提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add src/domain/rubric-defaults.ts src/domain/rubric-defaults.test.ts
git commit -m "feat: PRD 的 rubric 按六节铺开，模板节派生的出厂就阻断"
```

---

### Task 6: 设计阶段丢掉反方的 blockers

**Files:**
- Modify: `src/domain/phase.ts`（新增 `FREE_FORM_BLOCKERS` 名单）
- Modify: `src/domain/phase-play.ts`（PRD 那份的 `blue.task` / `blue.after`）
- Modify: `src/domain/round.ts`（`readRound` 里给蓝方也用上 `discardBlockers`；`judgePrompt` 不再向蓝方要 blockers）
- Modify: `src/domain/round-prompt.golden.txt`（**只允许 PRD 那份变**）
- Modify: `src/domain/phase.test.ts`、`src/domain/round.test.ts`

**Interfaces:**
- Produces: `function reportsFreeFormBlockers(phase: Phase): boolean`

- [ ] **Step 1: 写失败的测试**

```ts
// 加进 src/domain/round.test.ts
test("PRD 的反方就算硬报 blockers 也不算数 —— 收敛靠的是逐条判定", () => {
  const reading = readRound({
    ...baseTranscript("PRD"),
    blue: '```json\n{"artifactIds":[],"blockers":[{"id":"X-1","severity":"P1","title":"我偏要报","where":"a","why":"b"}],"overall":"还行"}\n```',
  }, {});
  assert.deepEqual(reading.outcome.found, []);
  assert.equal(reading.blueOverall, "还行", "overall 还要，它是给人看的");
});

test("Build 的反方照旧报得了 —— 它的病是自审，不是这一刀", () => {
  const reading = readRound({
    ...baseTranscript("Build"),
    blue: '```json\n{"artifactIds":[],"blockers":[{"id":"X-1","severity":"P1","title":"真缺陷","where":"a","why":"b"}]}\n```',
  }, {});
  assert.equal(reading.outcome.found.length, 1);
});
```

```ts
// 加进 src/domain/phase.test.ts
test("设计阶段不收自由 blockers，审查阶段收", () => {
  for (const phase of ["PRD", "Spec", "TechSpec", "Plan", "TestPlan"] as const) {
    assert.equal(reportsFreeFormBlockers(phase), false, phase);
  }
  for (const phase of ["Build", "Review", "Fix", "QA", "Merge", "Retro"] as const) {
    assert.equal(reportsFreeFormBlockers(phase), true, phase);
  }
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `node --import tsx --test src/domain/round.test.ts src/domain/phase.test.ts`
Expected: FAIL

- [ ] **Step 3: 写实现**

`src/domain/phase.ts`：

```ts
/**
 * 反方交自由 blockers 的阶段。**设计阶段不在里面。**
 *
 * 设计阶段反方的输出就是逐条判定 —— 每轮上限 = criterion 条数，收敛 = 全 yes。
 * 真库取证（CHG-001，21 轮）：自由 blockers 那条路产出 139 条、全部挡门，而它
 * **没有上限也没有阶段边界**；PRD 18 条里追 TechSpec 规范化对象、TestPlan 失败
 * 阈值、Plan 工具冻结版本的占了大半。
 *
 * 审查阶段（Build / Review / QA / Merge）留着：它们的病是自审（BACKLOG §8.3），
 * 解法是测试归属 + 轮末 diff 闸门，不是这一刀。那几个阶段的 blockers 承载着真正
 * 值钱的具体缺陷，砍掉是净损失。
 */
const FREE_FORM_BLOCKERS: ReadonlySet<Phase> = new Set<Phase>([
  "Build", "Review", "Fix", "QA", "Merge", "Retro",
]);

export function reportsFreeFormBlockers(phase: Phase): boolean {
  return FREE_FORM_BLOCKERS.has(phase);
}
```

`src/domain/round.ts` 的 `readRound`，把蓝方那次解析改成：

```ts
    blueBlockers = parseTurnResult(transcript.blue, {
      // 和红方在自审阶段被丢掉的是同一条路（上面那段注释）：**丢在解析层，不靠
      // 提示词叮嘱** —— 光在提示词里要求是抓不到的，模型违反了没人发现。
      discardBlockers: !reportsFreeFormBlockers(transcript.phase),
    }).blockers.map(...)
```

`judgePrompt` 里 `round.ts:547-550` 那三行（蓝方的 `RESULT_CONTRACT` 转达 +
`play.blue.after.slice(0, 1)`）包一层条件：

```ts
    ...(reportsFreeFormBlockers(input.phase) ? [
      `   下面这段格式要求**原样转达给${BLUE}**，一个字都不要改：`,
      RESULT_CONTRACT,
      ...contractNotes(input.contractNotesPath),
      ...play.blue.after.slice(0, 1),
    ] : [
      /*
       * 不要 blockers 了，但**仍然要那个 json 围栏** —— `overall` 在里面，而
       * `parseTurnResult` 读不到围栏是整轮作废。所以给一个只剩 overall 的契约。
       */
      `   下面这段格式要求**原样转达给${BLUE}**，一个字都不要改：`,
      BLUE_VERDICT_ONLY_CONTRACT,
      `   **不要另外列问题清单** —— 这个阶段你的判断全部走上面那份逐条判定。`
      + `模板之外的事（架构、技术栈、实现细节、测试用例）不归这个阶段管，不要提。`,
    ]),
```

在 `src/domain/turn.ts` 里加（和 `RESULT_CONTRACT` 并排，**同样不许走文件** ——
形状缺了会整轮作废，判据是「缺了会怎样」）：

```ts
/**
 * 设计阶段反方的契约：**只剩一句整体判断，没有问题清单。**
 *
 * `blockers` 那一格拿掉之后仍然要围栏 —— `overall` 在里面，而 `parseTurnResult`
 * 读不到围栏就是整轮作废。
 */
export const BLUE_VERDICT_ONLY_CONTRACT =
  `Reply with one \`\`\`json block and nothing that contradicts it:
{"overall": "<one sentence on whether this round is good enough, and why>"}`;
```

`src/domain/phase-play.ts` 里 **PRD 那一份**（只改这一份）：

```ts
      task: "2. 反方。任务：读正方产出，**照着那份逐条判定的标准**看它每一节写得够不够格 —— 这个阶段你只判那些标准，不另外提问题。",
      after: [
        "   它不要另外列问题清单：这个阶段的判断全部走逐条判定。",
        "   再要它在同一个 json 块里多给一个 `overall` 字段：一句话说这一轮整体够不够格、为什么。这一句不挡任何东西，是写给人看的。",
      ],
```

> ⚠ `judgePrompt` 里那行 `...play.blue.after.slice(0, 1)` 现在只在 free-form 分支里，
> 而 PRD 的 `after[0]` 改成了「不要另外列清单」—— 确认这两处没有互相打架，跑 golden
> 时逐行看。

- [ ] **Step 4: 跑测试确认它绿**

Run: `node --import tsx --test src/domain/round.test.ts src/domain/phase.test.ts`
Expected: PASS

- [ ] **Step 5: 更新 golden 并逐行看 diff**

```bash
git diff src/domain/round-prompt.golden.txt
```

Expected: **只有 PRD 那一份变了。** Spec / TechSpec / Plan / TestPlan 这一轮**不动**
（它们的 `PHASE_PLAY` 没改，`reportsFreeFormBlockers` 虽然对它们也返回 false，
但先只让 PRD 跑通一轮 —— 见「不做」）。

> ⚠ 如果 diff 里 Spec/TechSpec/Plan/TestPlan 也变了，说明 `reportsFreeFormBlockers`
> 已经作用到它们身上了。**那就把 `FREE_FORM_BLOCKERS` 改成只排除 PRD**，让这一刀
> 严格限定在 PRD：`new Set(PHASES.filter((each) => each !== "PRD"))`。先跑通一个。

- [ ] **Step 6: 全量验收 + 提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add src/domain/phase.ts src/domain/phase.test.ts src/domain/phase-play.ts src/domain/round.ts src/domain/round.test.ts src/domain/turn.ts src/domain/round-prompt.golden.txt
git commit -m "feat: PRD 的反方不再交自由 blockers —— 收敛判据变成全 yes"
```

---

### Task 7: 把现有项目的 rubric 升上来

**Files:**
- Modify: `src/store/rubric-store.ts`（新增 `upgradeDefaults`）
- Modify: `src/store/rubric-store.test.ts`
- Modify: `src/app/workspace.ts` 或面板的入口（先 `Read` 找到 `installDefaults` 今天在哪被调）

**Interfaces:**
- Produces: `upgradeDefaults(projectId): { upgraded: string[]; skipped: { scope: string; why: string }[] }`

- [ ] **Step 1: 写失败的测试**

```ts
// 加进 src/store/rubric-store.test.ts
test("没被人改过的（v1 且逐字等于出厂）升到新出厂版", () => {
  rubrics.installDefaults(PROJECT);
  const before = rubrics.current({ projectId: PROJECT, changeId: null, phase: "PRD", role: "producer" })!;
  assert.equal(before.version, 1);

  const result = rubrics.upgradeDefaults(PROJECT);
  assert.ok(result.upgraded.includes("PRD/producer"));
  const after = rubrics.current({ projectId: PROJECT, changeId: null, phase: "PRD", role: "producer" })!;
  assert.equal(after.version, 2);
  assert.ok(after.criteria.every((each) => each.section !== null));
});

test("人改过的一律跳过，而且说得出为什么", () => {
  rubrics.installDefaults(PROJECT);
  const scope = { projectId: PROJECT, changeId: null, phase: "PRD" as const, role: "producer" as const };
  rubrics.save(scope, [{ text: "我自己写的一条", blocking: false }]);

  const result = rubrics.upgradeDefaults(PROJECT);
  assert.ok(!result.upgraded.includes("PRD/producer"));
  assert.ok(result.skipped.some((each) => each.scope === "PRD/producer" && each.why.includes("改过")));
  assert.equal(rubrics.current(scope)!.criteria[0]!.text, "我自己写的一条", "一个字都不许碰");
});
```

- [ ] **Step 2: 跑一遍确认它红**

Run: `node --import tsx --test src/store/rubric-store.test.ts`
Expected: FAIL —— `upgradeDefaults is not a function`

- [ ] **Step 3: 写实现**

```ts
  /**
   * 把**没被人碰过**的出厂标准升到当前出厂版。
   *
   * ## 为什么需要它
   *
   * `installDefaults` 只补空缺（那条语义是对的，别动它）—— 于是改一次
   * `rubric-defaults.ts` 对**已经存在的项目零效果**，它留着建项目那天装上的那一版。
   * 2026-07-31 真机栽过一次：Review 那条早就改掉的旧措辞还留在老项目里，
   * 裁判拿它判了个假阳性的 `no`。
   *
   * ## 判据只有一条：版本还是 1
   *
   * **它是个近似，这里如实写明**：真正想判的是「这一份和它装上那天逐字相同」，
   * 但历史出厂版没存下来，比不了。退而求其次用版本号 —— 编辑一次就产生新版本行
   * （`nextVersion`），所以 `version === 1` 等价于「从来没人在面板上按过保存」。
   *
   * 漏判的情况：人改了一版又改回来（v3 的正文恰好等于出厂版）。那时它是 v3，会被
   * 跳过 —— **宁可漏升也不要覆盖**，而跳过的会报出来让人自己决定。
   *
   * 2026-08-06 实测真库：PRJ-001 全部 33 份 v1，PRJ-002 只有 Build 那三份是 v2。
   * **PRD 在两个项目里都没被改过**，所以这一刀实际一条都不会跳过。
   *
   * 跳过的**要报出来**，不能静默 —— 人得知道他那份为什么没跟着变。
   */
  upgradeDefaults(projectId: string): {
    upgraded: string[];
    skipped: { scope: string; why: string }[];
  } {
    const upgraded: string[] = [];
    const skipped: { scope: string; why: string }[] = [];
    for (const phase of PHASES) {
      for (const role of RUBRIC_ROLES) {
        const scope = { projectId, changeId: null, phase, role };
        const current = this.current(scope);
        const drafts = defaultCriteria(phase, role);
        if (current === null || drafts.length === 0) continue;
        const name = `${phase}/${role}`;
        if (current.version !== 1) {
          skipped.push({ scope: name, why: "你改过它（版本不是 1）" });
          continue;
        }
        // 已经和出厂版逐字相同就不动 —— 白升一版会让「v1 = 没人碰过」这条判据失效。
        const same = current.criteria.length === drafts.length
          && current.criteria.every((each, index) =>
            each.text === drafts[index]!.text
            && each.blocking === drafts[index]!.blocking
            && each.section === (drafts[index]!.section ?? null));
        if (same) continue;
        this.save(scope, drafts);
        upgraded.push(name);
      }
    }
    return { upgraded, skipped };
  }
```

> ⚠ **`save` 会把版本推到 2，所以这个动作对同一份只有第一次有效** —— 第二次调用时
> 它是 v2，会被当成「你改过它」跳过。这是刻意的：升级是一次性的救火动作，不是一个
> 可以反复按的同步按钮。**面板上的文案要说清这一点。**

在面板上给一个入口调它（先 `Read src/app/` 下现有的应用层动作，照那个形状加一个），
把 `upgraded` / `skipped` 都显示出来。

- [ ] **Step 4: 跑测试确认它绿**

Run: `node --import tsx --test src/store/rubric-store.test.ts`
Expected: PASS

- [ ] **Step 5: 全量验收 + 提交**

Run: `pnpm check`
Expected: 全绿

```bash
git add src/store/rubric-store.ts src/store/rubric-store.test.ts src/app/
git commit -m "feat: 没被人碰过的出厂标准能升级了（跳过的报出来，不静默）"
```

---

### Task 8: 裁决表摆出「还剩几个 no」

**Files:**
- Modify: `src/web/panel-server.ts` + `src/web/panel.js`（先 `Read` 找到裁决表那几格今天怎么拼的）
- Modify: 对应的测试文件

**Interfaces:**
- Consumes: `rubric_assessments` 里这一轮的判定、`Criterion.section`（Task 4）

- [ ] **Step 1: 写失败的测试**

先 `Read src/web/panel-server.ts` 找到裁决表的数据是哪个函数拼的，照它现有的测试
写法加一个：给一轮判定（3 个 `no`，分别落在 `acceptance` ×2、`assumption` ×1），
断言拼出来的那一格文字里同时出现 `3`、`acceptance`、`assumption`。

- [ ] **Step 2: 跑一遍确认它红**

Run: `pnpm check`
Expected: 新加的那个测试 FAIL

- [ ] **Step 3: 写实现**

在裁决表上加一格，形如：

```
PRD 第 4 轮 · 六节 · 14 条判定
  还剩 3 个 no：acceptance ×2、assumption ×1
```

**这一格是「还要不要再来一轮」的依据**（用户 2026-08-06：「人的耐心也是要有
依据的」）。今天人按批准时手上只有一堆散着的 finding，没有任何东西告诉他还差多少。

> **别往阶段环那一屏加东西**（交接 §5.0 第 4 条）—— 这一格在裁决弹窗里。

- [ ] **Step 4: 跑测试确认它绿**

Run: `pnpm check`
Expected: 全绿

- [ ] **Step 5: 在真浏览器里点一遍**

**这一步不许跳。** 有两个按钮的处理器曾指向不存在的函数，411 个测试 + typecheck
全绿，因为 `ReferenceError` 只在点下去那一刻才发生。

面板必须**从真终端起**（Run 按钮起的面板 spawn codex 必 EPERM 秒死）：

```bash
node --import tsx scripts/panel.ts --db ~/.stagepass/panel.db
```

然后 `preview_start {url}`（**一个会话只开一次 tab，之后一律 navigate**），
打开 CHG-001 的裁决弹窗，确认新那一格显示出来了、数字对得上库里的判定。

- [ ] **Step 6: 提交**

```bash
git add src/web/
git commit -m "feat: 裁决表摆出还剩几个 no、卡在哪一节 —— 人的耐心也要有依据"
```

---

### Task 9: 真跑一轮 PRD

**这是这份计划唯一的完成判据，前八个任务全绿也不算做完。**

- [ ] **Step 1: 先说再动**

真库 `~/.stagepass/panel.db` 是共用的。开跑前把「要在哪个 Change 上跑、会写什么」
说给用户，跑完把结果报回去。

- [ ] **Step 2: 起面板（真终端）并升级 rubric**

```bash
node --import tsx scripts/panel.ts --db ~/.stagepass/panel.db
```

在面板上跑 Task 7 那个升级动作，确认 PRD/producer 升到了 v2、`skipped` 是空的。

- [ ] **Step 3: 跑一轮 PRD，逐条核这四件事**

| 要看的 | 判据 |
|---|---|
| 红方产出**按六节** | `docs/stagepass/<change>/PRD-r1.md` 里六个标题都在，缺一个就该被机械判掉 |
| 反方**没有自由 blockers** | 库里这一轮 `gaps` 没有新的 `finding` 行 |
| 判定**挡门了** | `rubric_assessments` 里的 `no` 派生出了 `RB:producer:*` 的 `standard` gap（真库今天这个数是 **0**） |
| 裁决表**摆出了依据** | 弹窗里看得到「还剩几个 no、卡在哪一节」 |

- [ ] **Step 4: 再跑一轮，看收敛**

**连续两轮全 yes = 收敛。** 如果第二轮仍然有新的 `no` 冒出来，说明模板没有真的封住
表面 —— **这份设计要整体重估**，别硬往下做。把两轮的判定数字记进 `BACKLOG.md`。

- [ ] **Step 5: 记账**

在 `docs/BACKLOG.md` §8.2 加一段：这一刀落了什么、真跑的数字是多少、
**原来那个 `renderSettled` 校准修法已作废**（治的是症状，而且要等有人 waive 过才有信号）。

---

## 不做（照设计文档 §6）

- 模板不铺开到十二个阶段 —— **先 PRD 一个跑通再复制**（用户 2026-07-22 的纪律）
- Build 的自审（BACKLOG §8.3 / §8.4）不在这一刀里
- 越界的问题**不转交下游**（用户已拍：漏了也不能留）
- 不动 `standard` 无 severity 那条不变量
- 不碰 `change-state.ts:279` 和 `:206` 那两条硬校验（和 §8.11 同一条纪律：只补能力）
