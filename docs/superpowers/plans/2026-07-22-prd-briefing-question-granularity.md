# PRD Briefing 追问粒度重锚 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PRD Briefing 的追问只提方向性问题、并允许模型在问完后声明收敛，从而终结「无限追问 + 越问越细」。

**Architecture:** 三处独立改动。①提示词把「重要性」的锚点从下游 Spec 改成人类裁决权，并把八个 category 砍到四个；②协议层新增 `NO_NEW_QUESTIONS: true` 关键字，把「至少 1 个问题」放宽成三态判定，服务层只禁止首轮收敛；③UI 修掉「0 张卡被报成故障」的轮询 bug 并改为一行一卡。category 枚举同时从 6 份拷贝塌缩为 1 份常量。

**Tech Stack:** TypeScript / Next.js / drizzle + better-sqlite3 / zod / `node:test`

## Global Constraints

- **零数据库 schema 改动，零 migration，不动 `server/db/db-write-policy.json`。** 本计划只改既有测试文件，不新增写库的测试文件。
- **测试一律用 `pnpm test <文件>`**（走 `scripts/run-tests-isolated.ts` 隔离库）。裸跑 `npx tsx --test` 会写生产库 `server/db/ship.db`。
- **判断测试结果看 `ℹ fail` 与 `ℹ cancelled` 计数，不看 exit code。** 全量跑会 exit 0 但藏着失败。
- **不要把测试输出管道给 `tail`**，汇总计数行会被失败详情挤掉。
- **工作区有大量本计划之外的未提交改动。** 每次 commit 必须显式列出文件路径，**禁止 `git add -A` / `git add .`**。
- **当前分支是 `main`。** 执行前先开分支：`git checkout -b feat/prd-briefing-granularity`。
- 不改 Spec Battle；不把 line-protocol 阶段改成 JSON 输出；不引入数量截断或数量硬校验。

---

## File Structure

| 文件 | 职责 | 本计划中的变化 |
|---|---|---|
| `server/services/prd-briefing-ledger.ts` | zod 契约 + 纯函数规则 | **新增 category 常量（单一事实源）**；zod 由常量派生；新增 `noNewQuestions` 字段 |
| `server/services/prd-briefing-line-protocol.ts` | 协议行 → 结构化 payload | category Set 与错误消息改为派生；min-1 改三态判定 |
| `server/services/pipeline-prd-briefing-stage-service.ts` | 阶段编排 + 服务端第二道闸 | JSON schema 的 enum 改为派生；新增 `noNewQuestions` 属性 |
| `server/services/prd-briefing-service.ts` | 业务规则 + 落库 | `completeQuestionGeneration` 新增首轮收敛门禁与收敛留痕 |
| `server/templates/prompts/prd-briefing-questions.md` | 给模型的指令 | 锚点、判据、深挖指令、类别、严重度、收敛出口、数量 |
| `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx` | 追问室 UI | `jobMarker` 增加收敛分量并导出；卡片容器改单列 |

**任务顺序：Task 1 → Task 3 → Task 4 必须按序**（Task 1 建立常量并改动 line-protocol 与 stage service，Task 3 再改同两个文件；Task 4 消费 Task 3 产出的 `noNewQuestions`）。**Task 2 与 Task 5 各自独立**，可与上述任一任务并行或穿插——Task 2 只碰提示词与提示词测试，Task 5 只碰前端与前端测试。Task 6 最后。

---

### Task 1: category 枚举单一事实源 + 砍到四类

当前 `category` 枚举有 6 份代码拷贝。本任务把它塌缩成 1 份常量，并同时把八个类别砍到四个（`negative_case` / `risk` / `constraint` / `spec_blocker` 全部删除——它们天然是实现层的，是细节问题的正门）。

**Files:**
- Modify: `server/services/prd-briefing-ledger.ts:5-14`
- Modify: `server/services/prd-briefing-line-protocol.ts:35-44`（Set）与 `:73-77`（错误消息）
- Modify: `server/services/pipeline-prd-briefing-stage-service.ts:174-177`
- Modify: `server/templates/prompts/prd-briefing-questions.md:35`
- Modify: `docs/prd.md:1372`
- Test: `server/services/prd-briefing-ledger.test.ts`（新增一致性用例）
- Test: `server/services/prd-briefing-prompt.test.ts:24`（断言改为从常量派生）

**Interfaces:**
- Produces: `BRIEFING_QUESTION_CATEGORIES: readonly ["goal", "user", "scope", "success"]`，从 `./prd-briefing-ledger` 导出。Task 3 与 Task 5 会 import 它。

- [ ] **Step 1: 写失败测试——三处派生必须与常量一致**

在 `server/services/prd-briefing-ledger.test.ts` 末尾追加。注意 import 里要带上 `BRIEFING_QUESTION_CATEGORIES`（该文件已有的 import 块里补进去即可）：

```typescript
import { BRIEFING_QUESTION_CATEGORIES } from "./prd-briefing-ledger";
import { parseBriefingQuestionsLineProtocol } from "./prd-briefing-line-protocol";
import { questionOutputSchema } from "./pipeline-prd-briefing-stage-service";

describe("briefing question categories have a single source of truth", () => {
  it("keeps exactly the four directional categories", () => {
    assert.deepEqual(
      [...BRIEFING_QUESTION_CATEGORIES],
      ["goal", "user", "scope", "success"],
    );
  });

  it("derives the zod enum from the constant", () => {
    assert.deepEqual(
      [...BriefingQuestionCategorySchema.options],
      [...BRIEFING_QUESTION_CATEGORIES],
    );
  });

  it("derives the stage JSON schema enum from the constant", () => {
    const schema = questionOutputSchema() as {
      properties: { questions: { items: { properties: { category: { enum: string[] } } } } };
    };
    assert.deepEqual(
      schema.properties.questions.items.properties.category.enum,
      [...BRIEFING_QUESTION_CATEGORIES],
    );
  });

  // 这条守的是那份「另一份独立硬编码」的错误消息：它和判定用的 Set
  // 本来可以各自漂移，报错列出一个系统其实不接受的类别，而没有任何测试会发现。
  it("names exactly the accepted categories in the rejection message", () => {
    const result = parseBriefingQuestionsLineProtocol(
      "QUESTION: spec_blocker | critical | 问题 | 理由 | -",
      { changeId: "CHG-1", repoPath: "/tmp/x" },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, new RegExp(BRIEFING_QUESTION_CATEGORIES.join("/")));
    for (const dropped of ["negative_case", "risk", "constraint", "spec_blocker"]) {
      assert.doesNotMatch(result.message, new RegExp(`\\b${dropped}\\b(?!.*got)`));
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test server/services/prd-briefing-ledger.test.ts
```

预期：FAIL，报 `BRIEFING_QUESTION_CATEGORIES` / `PRD_BRIEFING_QUESTION_STAGE` 不是导出成员。

- [ ] **Step 3: 在 ledger 建立常量并派生 zod**

`server/services/prd-briefing-ledger.ts:5-14` 整段替换为：

```typescript
/**
 * The single source of truth for question categories.
 *
 * This list previously existed as six independent literals (zod enum, parser
 * Set, parser error message, stage JSON schema, prompt template, prompt test).
 * Two of them — the parser's Set and its own error message — could drift apart
 * silently, naming a category the parser does not actually accept. Everything
 * that can import derives from here; the prompt template is markdown and
 * cannot, so prd-briefing-prompt.test.ts asserts against this constant instead
 * of a copied literal.
 *
 * All four are decision-level: they are what a human must rule on before a PRD
 * has a direction. Implementation-level categories (negative_case, constraint,
 * spec_blocker, risk) were removed deliberately — they are Spec Battle's job,
 * and leaving them here is what let detail questions in through the front door.
 */
export const BRIEFING_QUESTION_CATEGORIES = [
  "goal",
  "user",
  "scope",
  "success",
] as const;

export const BriefingQuestionCategorySchema = z.enum(BRIEFING_QUESTION_CATEGORIES);
```

- [ ] **Step 4: 解析器改为派生**

`server/services/prd-briefing-line-protocol.ts` 的 import 块（`:10-14`）补上常量：

```typescript
import {
  BRIEFING_QUESTION_CATEGORIES,
  type BriefingQuestionsOutput,
  type FinalReviewOutput,
  type PrdBriefingDraftOutput,
} from "./prd-briefing-ledger";
```

注意：原 import 是 `import type { ... }`，现在要混入值导入，必须改成 `import { ..., type X }` 形式（如上）。

`:35-44` 的 Set 替换为：

```typescript
const QUESTION_CATEGORIES = new Set<string>(BRIEFING_QUESTION_CATEGORIES);
```

`:73-77` 的错误消息替换为（把硬编码列表换成 join）：

```typescript
    if (!QUESTION_CATEGORIES.has(category)) {
      errors.push(
        `line ${lineNo}: QUESTION category must be one of ${BRIEFING_QUESTION_CATEGORIES.join("/")}, got "${category}"`,
      );
      continue;
    }
```

- [ ] **Step 5: 阶段 JSON schema 改为派生，并导出该函数供测试读取**

`server/services/pipeline-prd-briefing-stage-service.ts:174-177`，把 enum 换成展开：

```typescript
            category: {
              type: "string",
              enum: [...BRIEFING_QUESTION_CATEGORIES],
            },
```

同文件 import 处加入 `BRIEFING_QUESTION_CATEGORIES`（从 `./prd-briefing-ledger`）。

同文件 `:160` 的 `function questionOutputSchema()` 加上 `export`：

```typescript
export function questionOutputSchema(): Record<string, unknown> {
```

该 schema 目前内联在 `runPrdBriefingQuestions`（`:604`）里以 `questionOutputSchema()` 形式传入，**不需要把配置对象提取成常量**——导出这个函数就足够让一致性测试读到它。

- [ ] **Step 6: 提示词与文档同步**

`server/templates/prompts/prd-briefing-questions.md:35` 改为：

```
- category：goal / user / scope / success 之一
```

`docs/prd.md:1372` 所在的类别联合类型，删除 `"negative_case"` / `"risk"` / `"constraint"` / `"spec_blocker"` 四行。

- [ ] **Step 7: 提示词测试改为从常量派生**

`server/services/prd-briefing-prompt.test.ts:24` 那行整体替换（并在文件顶部 import 常量）：

```typescript
    assert.match(
      content,
      new RegExp(`category：${BRIEFING_QUESTION_CATEGORIES.join(" / ")} 之一`),
    );
```

- [ ] **Step 8: 跑测试确认通过**

```bash
pnpm test server/services/prd-briefing-ledger.test.ts
```

```bash
pnpm test server/services/prd-briefing-prompt.test.ts
```

```bash
pnpm test server/services/prd-briefing-line-protocol.test.ts
```

第三条会**红**——既有 fixture 里可能用到被删的类别。逐个把 fixture 的 category 改成保留的四类之一（语义上就近映射：`risk`→`scope`，`constraint`→`scope`，`spec_blocker`→`goal`，`negative_case`→`success`）。全部 `ℹ fail 0` 且 `ℹ cancelled 0` 才算过。

- [ ] **Step 9: Commit**

```bash
git add server/services/prd-briefing-ledger.ts server/services/prd-briefing-ledger.test.ts server/services/prd-briefing-line-protocol.ts server/services/prd-briefing-line-protocol.test.ts server/services/pipeline-prd-briefing-stage-service.ts server/services/prd-briefing-prompt.test.ts server/templates/prompts/prd-briefing-questions.md docs/prd.md && git commit -m "refactor(prd-briefing): 疑点卡类别收敛为四个方向性类别，六份拷贝塌缩为单一常量"
```

---

### Task 2: 提示词重锚——从「Spec 会不会返工」改为「人类能不能裁决」

粒度失控的直接原因全在这一个文件里：优先级锚点挂在下游 Spec、严重度按 Spec 返工标定、每轮被明令「继续深挖问下一层」。本任务把三条绳子一起剪掉，并把每轮期望值从 7 提到 10。

**Files:**
- Modify: `server/templates/prompts/prd-briefing-questions.md:15`、`:22-23`、`:50-52`
- Test: `server/services/prd-briefing-prompt.test.ts`

**Interfaces:**
- Consumes: 无（纯文本改动）
- Produces: 无导出

- [ ] **Step 1: 写失败测试——正向 + 反向断言**

在 `server/services/prd-briefing-prompt.test.ts` 的 `describe("PRD briefing prompt templates", ...)` 内追加：

```typescript
  it("anchors question importance on human adjudication, not on Spec rework", () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, "prd-briefing-questions.md"), "utf-8");

    // 正向：新判据在位
    assert.match(content, /只提出「不回答就无法裁决 PRD 方向」的问题/);
    assert.match(content, /最多输出 10 张疑点卡/);
    assert.match(content, /那是 Spec Battle 的职责/);

    // 反向：旧锚点必须消失。这组才是主要防线——正向断言只能证明
    // 新词句在，证明不了旧锚点已经拔掉，而本次改动的全部价值就在于
    // 旧锚点必须消失。
    assert.doesNotMatch(content, /优先输出会影响 Spec Battle 的关键问题/);
    assert.doesNotMatch(content, /Spec 阶段高概率返工/);
    assert.doesNotMatch(content, /继续深挖/);
    assert.doesNotMatch(content, /最多输出 7 张/);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test server/services/prd-briefing-prompt.test.ts
```

预期：FAIL，`doesNotMatch` 那几条会命中现有文本。

- [ ] **Step 3: 改优先级锚点并补判据（:15）**

`server/templates/prompts/prd-briefing-questions.md:15` 那一行整体替换为：

```
请发现 PRD 前期需求漏洞，最多输出 10 张疑点卡。只提出「不回答就无法裁决 PRD 方向」的问题。

## 提问前先自检

如果人类不回答这个问题，PRD 的**方向**会不会错？

- 会错 → 提。
- 方向已定，只是还没展开成实现细节 → **不提**，那是 Spec Battle 的职责。

反例（这些一律不要问）：用什么数据结构、接口怎么设计、边界值怎么处理、
并发怎么办、失败了怎么回滚。这些不影响人类判断「要不要做、给谁做、做到什么算成功」。
```

- [ ] **Step 4: 深挖指令改成横向补全（:22-23）**

原文两行：

```
- 不要重复已经 answered / assumption_accepted 的卡。请在用户的回答之上继续深挖，
  问下一层还没被回答清楚的问题。
```

替换为：

```
- 不要重复已经 answered / assumption_accepted 的卡。请在用户已确认的方向之外，
  检查还有哪些**方向性维度**尚未覆盖。不要就同一个方向追问下一层实现细节——那属于 Spec 阶段。
```

- [ ] **Step 5: 严重度重定义（:50-52）**

原文三行：

```
- `critical` 只用于不回答就会导致方向错误或核心验收无法判断的问题。
- `important` 用于不回答会导致 Spec 阶段高概率返工的问题。
- `optional` 用于不会阻断 PRD 锁定的细节。
```

替换为：

```
- `critical` 只用于不回答，PRD 方向可能整个错、人类无法裁决的问题。
- `important` 用于不回答，PRD 的范围或成功标准会含糊的问题。
- `optional` 用于澄清了更好、但不影响方向裁决的问题。
```

- [ ] **Step 6: 跑测试确认通过**

```bash
pnpm test server/services/prd-briefing-prompt.test.ts
```

预期：`ℹ fail 0`、`ℹ cancelled 0`。

- [ ] **Step 7: Commit**

```bash
git add server/templates/prompts/prd-briefing-questions.md server/services/prd-briefing-prompt.test.ts && git commit -m "fix(prd-briefing): 追问锚点从 Spec 返工改为人类裁决权，粒度不再单调下滑"
```

---

### Task 3: 收敛出口——协议层三态判定

方向性问题是有限的，而 `至少输出 1 行 QUESTION` 强制每轮必产出。方向的井枯了，模型唯一取之不尽的井就是细节——所以收敛出口是 Task 2 能否成立的前提，不是可选项。

不用「0 行 QUESTION」隐式表示收敛：一个刚要写 QUESTION 就被截断的回复，与一个真正无话可问的回复，在这个观测上完全一样。没有显式标记，系统分不出「想通了」和「网断了」，后者会被静默当成收敛、吞掉一整轮追问。（同类教训见 `prd-line-protocol.ts:328` 关于 `PRD_DONE` 的注释。）

**Files:**
- Modify: `server/services/prd-briefing-ledger.ts`（`BriefingQuestionsOutputSchema` 加字段）
- Modify: `server/services/prd-briefing-line-protocol.ts:53-120`
- Modify: `server/services/pipeline-prd-briefing-stage-service.ts:160-190`
- Modify: `server/templates/prompts/prd-briefing-questions.md:47`
- Test: `server/services/prd-briefing-line-protocol.test.ts`
- Test: `server/services/prd-briefing-prompt.test.ts`

**Interfaces:**
- Consumes: 无导出依赖，但**改动的文件与 Task 1 重叠**（`prd-briefing-line-protocol.ts`、`pipeline-prd-briefing-stage-service.ts`、`prd-briefing-ledger.ts`），必须排在 Task 1 之后
- Produces: `BriefingQuestionsOutput` 与 `ParsedBriefingQuestionsOutput` 新增可选字段 `noNewQuestions?: boolean`。Task 4 依赖它判断是否收敛。

**⚠️ 陷阱：`additionalProperties: false`**
`guardLineProtocolSchema`（`ai-line-protocol.ts:433`）最终会用 `config.outputSchema` 校验 stagepass 自己组装出的 payload，而 `questionOutputSchema()` 带 `additionalProperties: false`。**只在解析器里加 `noNewQuestions` 会被这道闸打回来。** Step 5 必须同步。

- [ ] **Step 1: 写失败测试——四态全覆盖**

在 `server/services/prd-briefing-line-protocol.test.ts` 的 `describe("parseBriefingQuestionsLineProtocol", ...)` 内追加：

```typescript
  it("accepts a converged round: zero questions with the explicit marker", () => {
    const result = parseQuestions("本轮没有发现新的方向性疑点。\nNO_NEW_QUESTIONS: true");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.noNewQuestions, true);
    assert.deepEqual(result.payload.questions, []);
  });

  it("rejects zero questions without the marker — that is truncation, not convergence", () => {
    const result = parseQuestions("我来看看这个改动的需求。");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /NO_NEW_QUESTIONS/);
  });

  it("rejects the marker alongside questions — self-contradictory", () => {
    const result = parseQuestions(`${HAPPY_QUESTIONS}\nNO_NEW_QUESTIONS: true`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /NO_NEW_QUESTIONS/);
  });

  it("rejects a malformed marker value", () => {
    const result = parseQuestions("NO_NEW_QUESTIONS: yes");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /NO_NEW_QUESTIONS/);
  });

  it("leaves a normal round's noNewQuestions falsy", () => {
    const result = parseQuestions(HAPPY_QUESTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(!result.payload.noNewQuestions);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test server/services/prd-briefing-line-protocol.test.ts
```

预期：新增 5 条中至少 4 条 FAIL。

- [ ] **Step 3: zod 契约加字段**

`server/services/prd-briefing-ledger.ts` 的 `BriefingQuestionsOutputSchema`（`:34-40`）改为：

```typescript
export const BriefingQuestionsOutputSchema = z
  .object({
    unit: z.string().optional(),
    changeId: z.string().optional(),
    phase: z.string().optional(),
    questions: z.array(BriefingQuestionInputSchema),
    // Set only when the model explicitly declared it has nothing left to ask.
    // Absent on a normal round. The service layer refuses this on round 1.
    noNewQuestions: z.boolean().optional(),
  })
```

- [ ] **Step 4: 解析器改三态判定**

`server/services/prd-briefing-line-protocol.ts`：

`:62` 的扫描关键字加入新关键字：

```typescript
  let noNewQuestions = false;
  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, ["QUESTION", "NO_NEW_QUESTIONS"])) {
    if (keyword === "NO_NEW_QUESTIONS") {
      if (rest === "true") noNewQuestions = true;
      else errors.push(`line ${lineNo}: NO_NEW_QUESTIONS must be true, got "${rest}"`);
      continue;
    }
    const fields = splitFields(rest);
```

（原 `for` 行的解构从 `{ lineNo, rest }` 改为 `{ lineNo, keyword, rest }`。）

`:102-107` 的 min-1 判定整段替换为：

```typescript
  // Three-state, not "at least one".
  //
  // A reply truncated just before its first QUESTION line and a reply that
  // genuinely has nothing left to ask are indistinguishable on "zero QUESTION
  // lines" alone. Requiring an explicit marker makes truncation a loud failure
  // instead of a silently swallowed round. Same reasoning as PRD_DONE in
  // prd-line-protocol.ts:328.
  if (questions.length === 0 && !noNewQuestions) {
    errors.push("expected at least 1 QUESTION line, or NO_NEW_QUESTIONS: true to declare convergence");
  }
  if (questions.length > 0 && noNewQuestions) {
    errors.push("NO_NEW_QUESTIONS: true cannot appear alongside QUESTION lines");
  }
```

`:113-118` 的返回 payload 加上字段（在 `questions` 之后）：

```typescript
      questions,
      ...(noNewQuestions ? { noNewQuestions: true } : {}),
```

- [ ] **Step 5: 第二道闸同步放行该字段**

`server/services/pipeline-prd-briefing-stage-service.ts` 的 `questionOutputSchema()` 里，在 `questions` 属性之后追加：

```typescript
      noNewQuestions: { type: "boolean" },
```

`required` 保持不变（`["unit", "changeId", "phase", "questions"]`）——收敛字段是可选的。

- [ ] **Step 6: 提示词写明收敛怎么写**

`server/templates/prompts/prd-briefing-questions.md:47` 那行（`- 至少输出 1 行 QUESTION。`）替换为：

```
- 若你发现了新的方向性疑点：输出 1～10 行 QUESTION，不要输出 NO_NEW_QUESTIONS。
- 若确实没有新的方向性疑点：只输出一行 `NO_NEW_QUESTIONS: true`，不要输出任何 QUESTION。
  无话可问是正当结论，不要为了凑数而降低粒度去问实现细节。
```

最后一句是有意加的：模型在「必须产出点什么」的压力下，最省力的出路永远是往细里问。把「可以什么都不问」明确写成正当选项，才真正拆掉逼它编的那股压力。

- [ ] **Step 7: 提示词测试补断言**

在 `server/services/prd-briefing-prompt.test.ts` 的 Task 2 那条用例里追加两行：

```typescript
    assert.match(content, /NO_NEW_QUESTIONS: true/);
    assert.match(content, /无话可问是正当结论/);
    assert.doesNotMatch(content, /- 至少输出 1 行 QUESTION。/);
```

- [ ] **Step 8: 跑测试确认通过**

```bash
pnpm test server/services/prd-briefing-line-protocol.test.ts
```

```bash
pnpm test server/services/prd-briefing-prompt.test.ts
```

```bash
pnpm test server/services/prd-briefing-ledger.test.ts
```

三条都要 `ℹ fail 0`、`ℹ cancelled 0`。

- [ ] **Step 9: Commit**

```bash
git add server/services/prd-briefing-ledger.ts server/services/prd-briefing-line-protocol.ts server/services/prd-briefing-line-protocol.test.ts server/services/pipeline-prd-briefing-stage-service.ts server/services/prd-briefing-prompt.test.ts server/templates/prompts/prd-briefing-questions.md && git commit -m "feat(prd-briefing): 追问允许显式收敛，NO_NEW_QUESTIONS 三态判定替代至少一问"
```

---

### Task 4: 收敛出口——服务层首轮门禁与留痕

`assertQuestionsGenerated`（`prd-briefing-service.ts:383`）要求至少有一张卡才能进草稿。**若首轮就收敛，这道门会被永久焊死。** 本任务用「首轮不许收敛」拆掉这颗雷：首轮强制出卡后 `getQuestions()` 永远非空，草稿门再也锁不上。

**Files:**
- Modify: `server/services/prd-briefing-service.ts:729-804`
- Test: `server/services/prd-briefing-service.test.ts`

**Interfaces:**
- Consumes: `BriefingQuestionsOutput.noNewQuestions`（Task 3）
- Produces: 无新导出；`completeQuestionGeneration` 行为变化

- [ ] **Step 1: 写失败测试**

`server/services/prd-briefing-service.test.ts` 的既有结构：顶层是 `describe("prd-briefing-service", { concurrency: false }, () => {...})`，内有 `PROJECT_ID` / `CHANGE_ID` 常量、`seedChange(repoPath, status)`、`question(severity)`、`seedQuestion(severity)` 等辅助，以及 DB 测试锁与 `cleanupRows()`。**新用例必须写在这个顶层 describe 内部**，否则拿不到锁与清理钩子。

在该 describe 内部追加：

```typescript
  describe("question generation convergence", () => {
    it("refuses convergence on the first round — it would weld the draft gate shut", async () => {
      const repoPath = seedChange(makeRepo());
      await savePrdIntent({ changeId: CHANGE_ID, rawText: "把追问收敛掉" });

      await assert.rejects(
        () => completeQuestionGeneration({
          changeId: CHANGE_ID,
          questionsOutput: { questions: [], noNewQuestions: true },
        }),
        (error: unknown) =>
          error instanceof PrdBriefingError && error.code === "first_round_cannot_converge",
      );
      void repoPath;
    });

    it("accepts convergence on a later round without writing cards", async () => {
      seedChange(makeRepo());
      await savePrdIntent({ changeId: CHANGE_ID, rawText: "把追问收敛掉" });
      await completeQuestionGeneration({
        changeId: CHANGE_ID,
        questionsOutput: { questions: [question("critical")] },
      });

      const before = getPrdBriefingState(CHANGE_ID).questions.length;
      await completeQuestionGeneration({
        changeId: CHANGE_ID,
        questionsOutput: { questions: [], noNewQuestions: true },
      });

      assert.equal(
        getPrdBriefingState(CHANGE_ID).questions.length,
        before,
        "收敛轮不应写入任何卡片",
      );
    });

    it("keeps the draft gate passable after a converged round", async () => {
      seedChange(makeRepo());
      await savePrdIntent({ changeId: CHANGE_ID, rawText: "把追问收敛掉" });
      await completeQuestionGeneration({
        changeId: CHANGE_ID,
        questionsOutput: { questions: [question("optional")] },
      });
      await completeQuestionGeneration({
        changeId: CHANGE_ID,
        questionsOutput: { questions: [], noNewQuestions: true },
      });

      // 雷 1 的回归守卫：收敛之后仍必须能进草稿。若这条红了，
      // 说明 assertQuestionsGenerated 又被 0 卡的轮次饿死了。
      assert.doesNotThrow(() => assertCanStartPrdBriefingDraft(CHANGE_ID));
    });

    it("stamps a completed stage_progress carrying the run id", async () => {
      seedChange(makeRepo());
      await savePrdIntent({ changeId: CHANGE_ID, rawText: "把追问收敛掉" });
      await completeQuestionGeneration({
        changeId: CHANGE_ID,
        questionsOutput: { questions: [question("critical")] },
      });
      await completeQuestionGeneration({
        changeId: CHANGE_ID,
        questionsOutput: { questions: [], noNewQuestions: true },
      });

      const progress = getPrdBriefingState(CHANGE_ID).stageProgress;
      assert.equal(progress?.phase, "prd_briefing_questions");
      assert.equal(progress?.status, "completed");
      // runId 必须真实且非空：前端 jobMarker 用它区分两次连续收敛，
      // 空串会让第二次收敛的 marker 与第一次相同，轮询重新报「产物没有更新」。
      assert.equal(typeof progress?.runId, "string");
      assert.notEqual(progress?.runId, "");
    });
  });
```

**实现者注意：** `makeRepo()` 若该文件无同名辅助，改用它既有用例创建临时 repo 的写法（搜索 `mkdtempSync` 的用法照抄）。`question()` 返回 `BriefingQuestionInput`，`seedChange` 的返回值是 repoPath。`savePrdIntent` / `completeQuestionGeneration` / `getPrdBriefingState` / `assertCanStartPrdBriefingDraft` / `PrdBriefingError` 需在文件顶部 import 块中确保存在。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test server/services/prd-briefing-service.test.ts
```

预期：第一条 FAIL（当前不会抛 `first_round_cannot_converge`）。

- [ ] **Step 3: 实现首轮门禁与收敛短路**

`server/services/prd-briefing-service.ts`，在 `completeQuestionGeneration` 里 `parsed` 赋值成功之后（`:740` 之后）插入：

```typescript
  // Convergence is legal from round 2 on, never on round 1.
  //
  // assertQuestionsGenerated() requires at least one card before a draft may
  // start. A first round that produced nothing would leave getQuestions()
  // empty forever, welding that gate shut with no way back. Forcing round 1 to
  // produce cards means the set is non-empty from then on.
  if (parsed.noNewQuestions === true) {
    const round = nextQuestionRoundNoWithDb(db, input.changeId);
    if (round === 1) {
      throw new PrdBriefingError(
        "first_round_cannot_converge",
        "PRD briefing 首轮必须产出疑点卡，不能直接声明收敛",
      );
    }
    // The run id must be real and distinct per generation. jobMarker() keys the
    // convergence signal on `${runId}:${status}` — an empty or reused id makes
    // two consecutive converged rounds produce an identical marker, and the
    // second one falls through to the "no artifact updated" error all over
    // again. Question generation runs under phase "intake", so the latest
    // intake run IS this generation's run.
    const runId = latestIntakeRun(input.changeId)?.id;
    if (!runId) {
      throw new PrdBriefingError(
        "convergence_run_missing",
        "PRD briefing 收敛需要一条 intake run 记录，但没有找到",
      );
    }
    await insertEvent({
      changeId: input.changeId,
      type: "stage_progress",
      message: "本轮未发现新的方向性疑点，可以进入 PRD 草稿",
      rawJson: {
        stageProgress: {
          schemaVersion: "stage_progress/v1",
          phase: "prd_briefing_questions",
          runId,
          status: "completed",
          source: "prd_briefing_convergence",
        },
      },
    });
    syncPrdStageAuthority(input.changeId, input.provider);
    return getPrdBriefingState(input.changeId);
  }
```

`insertEvent` 的签名已核对（`prd-briefing-service.ts:606`）：`{ changeId: string; type: string; message: string; rawJson?: unknown }`，内部会 `JSON.stringify(rawJson)`，上面的调用与之匹配。`latestIntakeRun` 已定义在同文件 `:234`。

- [ ] **Step 3b: 让 `noNewQuestions` 穿过 ledger 的解析返回值**

`parsed` 的类型来自 `normalizeQuestionGenerationOutput`，而它返回 `ReturnType<typeof parseBriefingQuestionsOutput>`。该函数在 `server/services/prd-briefing-ledger.ts:254-257`，当前丢弃了新字段：

```typescript
export function parseBriefingQuestionsOutput(raw: string): ParsedBriefingQuestionsOutput {
  const parsed = BriefingQuestionsOutputSchema.parse(JSON.parse(raw));
  return { questions: parsed.questions, noNewQuestions: parsed.noNewQuestions };
}
```

并在 `ParsedBriefingQuestionsOutput` 类型定义上补 `noNewQuestions?: boolean`（该类型在同文件中定义，搜索 `ParsedBriefingQuestionsOutput` 找到它）。

同时 `normalizeQuestionGenerationOutput`（`prd-briefing-service.ts:719-727`）的 `questionsOutput` 分支也要带上：

```typescript
  if ("questionsOutput" in input && input.questionsOutput !== undefined) {
    const parsed = BriefingQuestionsOutputSchema.parse(input.questionsOutput);
    return { questions: parsed.questions, noNewQuestions: parsed.noNewQuestions };
  }
```

**这一步漏掉的话，Task 4 的门禁永远不会触发**——`parsed.noNewQuestions` 恒为 `undefined`，收敛轮会走进正常分支写 0 张卡，看起来「成功」但什么也没发生。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test server/services/prd-briefing-service.test.ts
```

预期：`ℹ fail 0`、`ℹ cancelled 0`。

- [ ] **Step 5: 跑相邻契约测试防回归**

```bash
pnpm test server/services/prd-briefing-routes.test.ts
```

```bash
pnpm test server/services/action-contract-service.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add server/services/prd-briefing-service.ts server/services/prd-briefing-service.test.ts server/services/prd-briefing-ledger.ts && git commit -m "feat(prd-briefing): 次轮起允许收敛，首轮强制出卡以免焊死草稿门"
```

---

### Task 5: UI——收敛不再被报成故障，卡片改单列

`jobMarker` 用卡片 ID 集合判断「这一轮跑完没」。收敛轮 0 张卡 → marker 不变 → 轮询走不到完成分支 → 掉进 `:339` 弹出「AI job 已结束，但 PRD 产物没有更新。请重试这一招。」**模型诚实地说没问题了，UI 会告诉用户失败了。**

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx:111-119`（marker + 导出）
- Modify: `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx:690`（布局）
- Test: `app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `jobMarker` 由模块内函数改为具名导出，供测试直接调用

- [ ] **Step 1: 写失败测试**

该测试文件既有辅助（已核对）：`card(overrides)`（需传 `id` 与 `roundNo`）、`stateWith(questions)`（返回完整 `PrdBriefingState`，其 `stageProgress` 为 `null`）、`render(questions)`（返回 `renderToStaticMarkup` 的 HTML）。顶部 import 里补上 `jobMarker`。

追加：

```typescript
describe("questions job completion marker", () => {
  const CARDS = [card({ id: "BQ-1", roundNo: 1 })];

  function withProgress(
    progress: { phase: string; status: string; runId: string } | null,
  ): PrdBriefingState {
    return {
      ...stateWith(CARDS),
      stageProgress: progress
        ? { schemaVersion: "stage_progress/v1", source: "test", ...progress }
        : null,
    } as PrdBriefingState;
  }

  it("changes when a converged round completes with no new cards", () => {
    const before = jobMarker("questions", withProgress(null));
    const after = jobMarker("questions", withProgress({
      phase: "prd_briefing_questions",
      status: "completed",
      runId: "RUN-2",
    }));
    assert.notEqual(before, after, "收敛轮必须让 marker 变化，否则会被报成故障");
  });

  it("changes again on a second consecutive converged round", () => {
    // 两次连续收敛必须产生不同的 marker，否则第二次又会掉进
    // 「AI job 已结束，但 PRD 产物没有更新」。这条守的是 runId 的真实性。
    const first = jobMarker("questions", withProgress({
      phase: "prd_briefing_questions",
      status: "completed",
      runId: "RUN-2",
    }));
    const second = jobMarker("questions", withProgress({
      phase: "prd_briefing_questions",
      status: "completed",
      runId: "RUN-3",
    }));
    assert.notEqual(first, second);
  });

  it("does not change while the run is still in flight", () => {
    const before = jobMarker("questions", withProgress(null));
    const during = jobMarker("questions", withProgress({
      phase: "prd_briefing_questions",
      status: "running",
      runId: "RUN-2",
    }));
    assert.equal(before, during, "运行中不得提前收工");
  });

  it("ignores progress from a different phase", () => {
    const before = jobMarker("questions", withProgress(null));
    const other = jobMarker("questions", withProgress({
      phase: "prd_briefing_draft",
      status: "completed",
      runId: "RUN-9",
    }));
    assert.equal(before, other);
  });
});

describe("question card layout", () => {
  it("stacks cards one per row", () => {
    const html = render([
      card({ id: "BQ-1", roundNo: 1 }),
      card({ id: "BQ-2", roundNo: 1 }),
    ]);
    assert.doesNotMatch(html, /xl:grid-cols-2/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test "app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts"
```

预期：FAIL，`jobMarker` 不是导出成员。

**注意：** 路径含 `[id]`，`node --test` 会把它当 glob 字符类导致**静默不匹配**（汇总显示 `tests 0 … pass 0 fail 0`，看起来像通过）。必须用 `pnpm test`（它内建 `escapeGlobLiteral`）并确认 `tests` 计数非零。

- [ ] **Step 3: marker 加收敛分量并导出**

`app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx:111-119` 整段替换：

```typescript
export function jobMarker(kind: "questions" | "draft" | "final-review", state: PrdBriefingState | null): string {
  if (kind === "questions") {
    const cards = (state?.questions ?? [])
      .map((question) => `${question.id}:${question.updatedAt}`)
      .join("|");
    // A converged round writes no cards, so the card list alone never changes
    // and polling falls through to the "no artifact updated" error — telling
    // the user a truthful "nothing left to ask" was a failure. The run's own
    // completion is the second signal.
    //
    // `status === "completed"` is load-bearing: stage_progress is also emitted
    // mid-run, and keying on runId alone would end polling before the round
    // actually finishes.
    const progress = state?.stageProgress;
    const converged = progress?.phase === "prd_briefing_questions" && progress.status === "completed"
      ? `${progress.runId}:${progress.status}`
      : "";
    return `${cards}#${converged}`;
  }
  if (kind === "draft") return state?.latestDraft?.id ?? "";
  return state?.briefing?.finalReviewJson ?? "";
}
```

- [ ] **Step 4: 卡片容器改单列**

`app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx:690`：

```typescript
                <div className="space-y-3 p-3 pt-0">
```

（原为 `<div className="grid gap-3 p-3 pt-0 xl:grid-cols-2">`。）

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm test "app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts"
```

预期：`ℹ fail 0`、`ℹ cancelled 0`，且 `tests` 计数非零。

- [ ] **Step 6: Commit**

```bash
git add "app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx" "app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts" && git commit -m "fix(prd-briefing-room): 收敛轮不再被报成故障，疑点卡改为一行一张"
```

---

### Task 6: 全量回归与类型检查

**Files:** 无改动（若发现问题在对应任务的文件里修）

- [ ] **Step 1: 类型检查**

```bash
npx tsc --noEmit
```

**注意：** `tsconfig.json` 的 `exclude` 含 `**/*.test.ts` / `**/*.test.tsx`，所以 `tsc` 干净**不代表测试能编过**。这一步只是必要条件，不是充分条件。

- [ ] **Step 2: 跑本次涉及的全部测试文件**

```bash
pnpm test server/services/prd-briefing-ledger.test.ts server/services/prd-briefing-line-protocol.test.ts server/services/prd-briefing-service.test.ts server/services/prd-briefing-prompt.test.ts server/services/prd-briefing-routes.test.ts "app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts"
```

逐个确认 `ℹ fail 0` 与 `ℹ cancelled 0`。**`cancelled` 必须看**：describe 级 timeout 会取消尾部测试而汇总仍报 `fail 0`。

- [ ] **Step 3: 跑受影响的契约与快照测试**

```bash
pnpm test server/services/action-contract-service.test.ts server/services/provider-route-contract.test.ts server/db/db-write-inventory.test.ts
```

`db-write-inventory.test.ts` 应当保持绿——本计划未新增写库的测试文件。若它红了，说明有任务偏离了「零 schema 改动」约束，回头查而不是去改 policy。

- [ ] **Step 4: Commit（仅当前三步有修复时）**

```bash
git add <实际修改的文件> && git commit -m "fix(prd-briefing): 回归修复"
```

---

## 验收标准

全部任务完成后，下列命题应当成立：

1. 提示词中不再出现 `优先输出会影响 Spec Battle 的关键问题`、`Spec 阶段高概率返工`、`继续深挖`。
2. `category` 只接受 `goal` / `user` / `scope` / `success`；解析器错误消息列出的类别与 `BRIEFING_QUESTION_CATEGORIES` 完全一致。
3. 模型输出 `NO_NEW_QUESTIONS: true` 且无 QUESTION 时：首轮被驳回，次轮起被接受且不写卡。
4. 收敛轮之后 `assertCanStartPrdBriefingDraft` 仍可通过。
5. 收敛轮在 UI 上显示为绿色提示而非「请重试这一招」的错误。
6. 疑点卡在宽屏上单列排布。
7. `server/db/db-write-policy.json` 与 `server/db/db-write-inventory.snapshot.json` 未被修改。
