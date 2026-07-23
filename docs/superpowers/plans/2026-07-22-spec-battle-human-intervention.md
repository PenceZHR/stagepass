# Spec Battle 介入室 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让人能在 Spec 对抗里介入——蓝方能提出「这得你拍板」的问题卡，人能对每条 requirement gap 补充事实、提异议、否决。

**Architecture:** 复用 `briefing_questions` 表承载两个阶段的问题卡（加 `phase` 列），
但把这张表的所有读取收口到一个必须显式传 `phase` 的访问器，用测试锁死。
gap 的人工动作走既有 `human_decisions`（无 CHECK 约束的 text 列，零 schema 改动），
`disputed` 不进状态枚举而用 `human_decisions` 与 `blue_gap_reviews` 的 roundId 比较派生。
否决 P0 需要两把钥匙：Spec 一把开 Spec 门，Merge 一把开 Merge 门。

**Tech Stack:** Next.js 15 App Router、TypeScript、drizzle-orm + better-sqlite3、
node:test（`node --test`）、Tailwind、zod。

**Spec:** `docs/superpowers/specs/2026-07-22-spec-battle-human-intervention-design.md`

## Global Constraints

- **模型永不输出 JSON。** 所有 AI 产出走 line protocol（前缀行 + `|` 分隔），
  见 `server/services/ai-line-protocol.ts`。新增行类型必须遵循同一形式。
- **人永远不能把 gap 标成 `resolved`。** `spec-battle-service.ts` 的
  `human_cannot_resolve_gap` 守卫必须保留且测试必须仍然通过。
- **阻断标志是派生值，不是模型输出。** `spec_blocking` / `merge_blocking` 列永远由
  `isSpecBlockingGap` / `isMergeBlockingGap` 计算，绝不采信模型或前端传入的值。
- **测试必须走隔离库。** 命令一律 `npx tsx scripts/run-tests-isolated.ts <文件>`。
  **裸跑 `node --test` 会写生产库。**
- **判定成功看 `ℹ fail` 与 `ℹ cancelled` 计数，不看 exit code。** 全量跑会 exit 0
  但藏着失败。
- **新增 DB 写入点必须登记** `server/db/db-write-policy.json`（生产写入进
  `productionEntries`，新的写库测试文件进 `testFixtures`），然后重算快照：
  `npx tsx scripts/generate-db-write-inventory-snapshot.ts`。
  漏登记会让 `db-write-inventory.test.ts` 变红。
- **问题卡严重度用 `critical` / `important` / `optional`**（PRD 的语言）。
  `P0` / `P1` / `P2` 是 gap 的语言，两者不得混用。
- **迁移文件同时要改 `server/db/migrations/meta/_journal.json`**，追加一条
  `{"idx": N, "version": "7", "when": <ms>, "tag": "<文件名去掉 .sql>", "breakpoints": true}`。
- 提交信息用中文，描述症状而非改法，结尾带
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- **测试文件的相对导入必须带 `.ts` / `.tsx` 后缀**（`from "../db/index.ts"`），
  这是本 repo 既有约定，见 `server/services/prd-briefing-service.test.ts:8`。
  生产代码（`server/services/*.ts`）则不带后缀，两者不同，照各自邻居写。
- **本 repo 没有共享测试夹具目录。** 每个测试文件自带建库的
  `before`/`beforeEach`。需要夹具时照抄同目录邻近测试文件的写法，不要新建
  `test-support/` 之类的模块。
- **计划里测试代码中的 seed 辅助函数名是示意，不是既有 API。**
  `seedRoundReadyForBlue` / `seedReportReadyWithOpenP1` /
  `seedMergeReadyExceptOverriddenP0` 等一律不存在。实现时**先读目标测试文件
  已有的建库与推进写法，复用或就地扩展它们**，不要照字面新建这些函数。
  重要的是断言主体，不是这些名字。

---

## File Structure

**新建：**

| 文件 | 职责 |
|---|---|
| `server/db/migrations/0026_spec_battle_human_intervention.sql` | `briefing_questions.phase`、`requirement_gaps.merge_override_reason` |
| `server/services/briefing-question-store.ts` | **`briefing_questions` 表的唯一访问器**，读写都必须显式传 `phase` |
| `server/services/briefing-question-store.test.ts` | 访问器行为 + **禁止其他模块直接 select 该表的守卫测试** |
| `server/services/spec-gap-dispute-rules.ts` | `disputeUnanswered` / `canOverrideGap` 纯函数 |
| `server/services/spec-gap-dispute-rules.test.ts` | 上述纯函数的四态覆盖 |
| `app/projects/[id]/changes/[changeId]/question-card.tsx` | PRD 与 Spec 共用的问题卡组件 |
| `app/projects/[id]/changes/[changeId]/gap-card.tsx` | gap 卡 + 四个人工动作 |
| `app/projects/[id]/changes/[changeId]/spec-battlefield.test.ts` | UI 结构断言（含反向断言） |
| `app/api/projects/[id]/changes/[changeId]/spec-battle/questions/[questionId]/route.ts` | 问题卡表态 |

**修改：**

| 文件 | 改动 |
|---|---|
| `server/db/schema.ts` | 两个新列 |
| `server/services/spec-critique-line-protocol.ts` | `QUESTION` 关键字 |
| `server/services/spec-battle-ledger.ts` | payload 加 `questions` |
| `server/services/spec-battle-rules.ts` | `isMergeBlockingGap` 读第二把钥匙 |
| `server/services/spec-battle-service.ts` | `needs_human_decision` 独立分支、问题卡落库、四个人工动作 |
| `server/services/pipeline-spec-stage-service.ts` | 蓝方输入注入异议与已答问题卡 |
| `server/services/prd-briefing-service.ts` 等 6 处 | 改用访问器 |
| `server/services/merge-readiness-service.ts` | 无需改（读 `merge_blocking` 列即可） |
| `server/templates/prompts/spec-critic.md` | QUESTION 格式、判据、异议必答规则 |
| `server/types/enums.ts` | `HumanDecisionAction` 加四个值 |
| `app/.../spec-battlefield.tsx` | 按设计第 5 节重构 |
| `app/.../prd-briefing-room.tsx` | 改用共享问题卡组件 |
| `app/.../operational-phase-panel.tsx` | Merge 第二把钥匙 |

---

## Task 1: `briefing_questions` 加 phase 列，并把读取收口到唯一访问器

**为什么这是第一个任务且必须做扎实：** 这张表有 6 个读取点，其中
`spec-battle-service.ts:262` 喂的是 **PRD 的 source DB hash**。Spec 的卡一旦漏进
任何一个不带 `phase` 过滤的查询，后果分别是：PRD 阶段哈希无故变动、
`computePrdGate` 把 Spec 的 critical 卡当成未处理从而**焊死 PRD 锁定门**、
PRD 房间显示别的阶段的卡。靠记性加过滤条件是不够的——半年后新增的读取点不会知道。
所以本任务把它变成结构性约束：访问器强制传 `phase`，并用测试禁止其他模块直接访问该表。

**Files:**
- Create: `server/db/migrations/0026_spec_battle_human_intervention.sql`
- Modify: `server/db/migrations/meta/_journal.json`
- Modify: `server/db/schema.ts:1144-1166`（`briefingQuestions`）、`:494-524`（`requirementGaps`）
- Create: `server/services/briefing-question-store.ts`
- Create: `server/services/briefing-question-store.test.ts`
- Modify: `server/services/prd-briefing-service.ts:204`、`:842-843`、`:868-869`、`:886`、`:824`
- Modify: `server/services/spec-battle-service.ts:261-263`
- Modify: `server/services/provider-action-authority-service.ts:513`
- Modify: `server/services/recovery-business-evidence.ts:644-645`、`:946-950`
- Modify: `server/db/db-write-policy.json`

**Interfaces:**
- Produces:
  - `BriefingQuestionPhase = "PRD" | "Spec"`
  - `listBriefingQuestions(changeId: string, phase: BriefingQuestionPhase): BriefingQuestionRow[]`
  - `listBriefingQuestionsWithDb(connection, changeId, phase): BriefingQuestionRow[]`
  - `getBriefingQuestion(changeId: string, questionId: string, phase: BriefingQuestionPhase): BriefingQuestionRow | undefined`
  - `insertBriefingQuestionsWithDb(tx, rows: NewBriefingQuestion[]): void`
  - `updateBriefingQuestionAnswer(changeId, questionId, phase, patch: { status: string; answer: string | null }): void`
  - `type BriefingQuestionRow = typeof briefingQuestions.$inferSelect`

- [ ] **Step 1: 写迁移**

Create `server/db/migrations/0026_spec_battle_human_intervention.sql`:

```sql
ALTER TABLE `briefing_questions` ADD COLUMN `phase` text NOT NULL DEFAULT 'PRD';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_briefing_questions_change_phase`
  ON `briefing_questions` (`change_id`, `phase`, `round_no`);
--> statement-breakpoint
ALTER TABLE `requirement_gaps` ADD COLUMN `merge_override_reason` text;
```

`DEFAULT 'PRD'` 是关键：所有现存行读作 PRD，PRD 侧行为一字不变。

在 `server/db/migrations/meta/_journal.json` 的 `entries` 数组末尾追加：

```json
    {
      "idx": 26,
      "version": "7",
      "when": 1784592000000,
      "tag": "0026_spec_battle_human_intervention",
      "breakpoints": true
    }
```

（注意前一条 `0025` 结尾要补逗号。）

- [ ] **Step 2: 改 schema**

In `server/db/schema.ts`, 在 `briefingQuestions` 的 `roundNo` 之后加：

```typescript
  /**
   * Which pipeline phase's interrogation produced this card. PRD Briefing and
   * Spec Battle both ask the human questions in the same shape, so they share
   * this table -- but nothing may read it without saying which phase it wants:
   * a Spec card reaching computePrdGate reads as an unhandled critical question
   * and welds the PRD draft gate shut. briefing-question-store.ts is the only
   * module allowed to touch this table, and every one of its readers takes a
   * phase argument. Defaults to 'PRD' so every pre-existing row keeps its
   * meaning.
   */
  phase: text("phase").notNull().default("PRD"),
```

在 `requirementGaps` 的 `overrideReason` 之后加：

```typescript
  /**
   * The second of two keys for an overridden P0. `override_reason` clears the
   * Spec gate; this one clears the Merge gate, and is turned separately at the
   * Merge stage. isMergeBlockingGap() reads it -- see spec-battle-rules.ts.
   * Without it an overridden P0 blocks merge forever: merge-readiness only
   * releases on status 'resolved', which only blue can grant, and blue stops
   * rechecking overridden gaps.
   */
  mergeOverrideReason: text("merge_override_reason"),
```

- [ ] **Step 3: 写访问器的失败测试**

Create `server/services/briefing-question-store.test.ts`:

**导入约定**：本 repo 的测试文件用**带 `.ts` 后缀**的相对导入
（见 `prd-briefing-service.test.ts:8` `from "../db/index.ts"`）。全文照此。

**建库夹具**：本 repo **没有** `test-support/` 共享夹具目录，每个测试文件自带
`before`/`beforeEach` 建项目与 change。照抄 `prd-briefing-service.test.ts` 顶部
（`:1-120` 一带）的建库写法，**不要新建夹具模块**。下面 `seedChange()`
指的就是你照抄过来的那个本地函数。

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "fs";
import path from "path";

import { db } from "../db/index.ts";
import {
  insertBriefingQuestionsWithDb,
  listBriefingQuestions,
} from "./briefing-question-store.ts";

describe("briefing question store", () => {
  it("returns only the requested phase's cards", () => {
    const changeId = seedChange();
    db.transaction((tx) => {
      insertBriefingQuestionsWithDb(tx, [
        {
          id: "BQ-prd-1", changeId, phase: "PRD", roundNo: 1,
          category: "goal", severity: "critical", question: "PRD 的问题",
          whyItMatters: "因为方向", suggestedDefault: null, status: "open",
          answer: null, source: "ai_blue",
        },
        {
          id: "BQ-spec-1", changeId, phase: "Spec", roundNo: 1,
          category: "scope", severity: "critical", question: "Spec 的问题",
          whyItMatters: "因为取舍", suggestedDefault: null, status: "open",
          answer: null, source: "ai_blue",
        },
      ]);
    });

    const prd = listBriefingQuestions(changeId, "PRD");
    const spec = listBriefingQuestions(changeId, "Spec");
    assert.deepEqual(prd.map((row) => row.id), ["BQ-prd-1"]);
    assert.deepEqual(spec.map((row) => row.id), ["BQ-spec-1"]);
  });

  it("is the only module that reads the briefing_questions table", () => {
    // The invariant this locks: a reader that forgets the phase filter puts
    // Spec cards in front of computePrdGate, which counts an open critical card
    // as a reason to refuse the PRD draft -- and welds that gate shut for good.
    // Discipline cannot hold this line across future edits; a test can.
    const roots = ["server", "app"];
    const allowed = new Set([
      path.join("server", "services", "briefing-question-store.ts"),
      path.join("server", "db", "schema.ts"),
    ]);
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".next") continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
        if (allowed.has(full)) continue;
        const source = fs.readFileSync(full, "utf-8");
        if (source.includes("from(briefingQuestions)")) offenders.push(full);
      }
    };

    for (const root of roots) walk(root);
    assert.deepEqual(
      offenders,
      [],
      `These modules select from briefing_questions directly. Use briefing-question-store.ts, `
        + `which forces every reader to name its phase: ${offenders.join(", ")}`,
    );
  });
});
```

守卫测试匹配的是字面量 `from(briefingQuestions)`。
`prd-briefing-service.ts` 里的 `nextId(briefingQuestions, "BQ")` 不会误报——
它不含该字面量，那行可以保留不动。

- [ ] **Step 4: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/briefing-question-store.test.ts
```

Expected: FAIL — `Cannot find module './briefing-question-store'`。

- [ ] **Step 5: 写访问器**

Create `server/services/briefing-question-store.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { briefingQuestions } from "../db/schema";

/**
 * The one module allowed to touch briefing_questions.
 *
 * PRD Briefing and Spec Battle ask the human questions in exactly the same
 * shape, so they share one table and one UI component. What they must never
 * share is a query: a Spec card that reaches computePrdGate reads as an
 * unhandled critical question and refuses the PRD draft forever, and a Spec
 * card inside prdAuthorityRows moves the PRD stage hash for no reason.
 *
 * Every reader here takes `phase` as a required argument -- there is no default
 * and no "all phases" reader -- so forgetting the filter is not expressible.
 * briefing-question-store.test.ts additionally fails the build if any other
 * module selects from the table.
 */

export type BriefingQuestionPhase = "PRD" | "Spec";
export type BriefingQuestionRow = typeof briefingQuestions.$inferSelect;
export type NewBriefingQuestion = Omit<
  typeof briefingQuestions.$inferInsert,
  "createdAt" | "updatedAt"
>;

/** Anything with drizzle's select/insert/update surface: `db` or a transaction. */
type Connection = Pick<typeof db, "select" | "insert" | "update">;

function nowISO(): string {
  return new Date().toISOString();
}

/** Oldest round first, stable within a round. The order the room renders. */
function byRound(left: BriefingQuestionRow, right: BriefingQuestionRow): number {
  return left.roundNo - right.roundNo
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

export function listBriefingQuestionsWithDb(
  connection: Connection,
  changeId: string,
  phase: BriefingQuestionPhase,
): BriefingQuestionRow[] {
  return connection
    .select()
    .from(briefingQuestions)
    .where(and(eq(briefingQuestions.changeId, changeId), eq(briefingQuestions.phase, phase)))
    .all()
    .sort(byRound);
}

export function listBriefingQuestions(
  changeId: string,
  phase: BriefingQuestionPhase,
): BriefingQuestionRow[] {
  return listBriefingQuestionsWithDb(db, changeId, phase);
}

export function getBriefingQuestion(
  changeId: string,
  questionId: string,
  phase: BriefingQuestionPhase,
): BriefingQuestionRow | undefined {
  return db
    .select()
    .from(briefingQuestions)
    .where(and(
      eq(briefingQuestions.changeId, changeId),
      eq(briefingQuestions.id, questionId),
      eq(briefingQuestions.phase, phase),
    ))
    .get();
}

export function insertBriefingQuestionsWithDb(
  connection: Connection,
  rows: NewBriefingQuestion[],
): void {
  const now = nowISO();
  for (const row of rows) {
    connection.insert(briefingQuestions).values({ ...row, createdAt: now, updatedAt: now }).run();
  }
}

export function updateBriefingQuestionAnswer(input: {
  changeId: string;
  questionId: string;
  phase: BriefingQuestionPhase;
  status: string;
  answer: string | null;
}): void {
  db.update(briefingQuestions)
    .set({ status: input.status, answer: input.answer, updatedAt: nowISO() })
    .where(and(
      eq(briefingQuestions.changeId, input.changeId),
      eq(briefingQuestions.id, input.questionId),
      eq(briefingQuestions.phase, input.phase),
    ))
    .run();
}
```

- [ ] **Step 6: 把 6 个读取点全部改用访问器**

按下表逐个替换。**每个都必须显式写出 phase**：

| 文件:行 | 现在 | 改为 |
|---|---|---|
| `prd-briefing-service.ts:204` | `connection.select().from(briefingQuestions).where(eq(changeId))...` | `listBriefingQuestionsWithDb(connection, changeId, "PRD")` |
| `prd-briefing-service.ts:824` | `tx.insert(briefingQuestions).values({...})` | `insertBriefingQuestionsWithDb(tx, [...])`，每行加 `phase: "PRD"` |
| `prd-briefing-service.ts:842-843` | `tx.select().from(briefingQuestions).where(...)` | `listBriefingQuestionsWithDb(tx, input.changeId, "PRD")` |
| `prd-briefing-service.ts:868-869` | `db.select()...` | `getBriefingQuestion(input.changeId, input.questionId, "PRD")` |
| `prd-briefing-service.ts:880-886` | `db.update(briefingQuestions).set(...)` | `updateBriefingQuestionAnswer({ ..., phase: "PRD" })` |
| `spec-battle-service.ts:261-263` | `db.select().from(briefingQuestions).where(eq(changeId)).all().sort(...)` | `listBriefingQuestions(changeId, "PRD")`（排序已在访问器内，删掉本地 `.sort`） |
| `provider-action-authority-service.ts:513` | `db.select().from(briefingQuestions).where(eq(changeId)).all()` | `listBriefingQuestions(changeId, "PRD")` |
| `recovery-business-evidence.ts:644-645` | `evidenceDb.select().from(briefingQuestions)...` | `listBriefingQuestionsWithDb(evidenceDb, run.changeId, "PRD")` |
| `recovery-business-evidence.ts:946-950` | 投影 select | `listBriefingQuestionsWithDb(...)` 后在 JS 里取字段 |

改完删掉这些文件里已不再使用的 `briefingQuestions` import。
`prd-briefing-service.ts` 的 `nextId(briefingQuestions, "BQ")` 仍需该 import——
`nextId` 的 `table` 参数是 `void table;`（`prd-briefing-service.ts:76-79`），
改传 `"BQ"` 前缀即可，但**本任务不动它**，保留 import。

**注意 `recovery-business-evidence.ts:946-950` 是投影查询**，访问器返回整行；
把投影改成在 JS 里 `.map()` 取那 6 个字段，保持下游形状不变。

- [ ] **Step 7: 跑访问器测试与全部受影响测试**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/briefing-question-store.test.ts server/services/prd-briefing-service.test.ts server/services/spec-battle-service.test.ts server/services/provider-action-authority-service.test.ts
```

Expected: PASS，`ℹ fail 0`、`ℹ cancelled 0`。
守卫测试的 offender 列表必须为空——若不为空，说明还有读取点没改。

- [ ] **Step 8: 登记 DB 写入点并重算快照**

写入点从 `prd-briefing-service.ts` 迁到了 `briefing-question-store.ts`，
两边的 `productionEntries` 都要动。

**条目的键是 AST 扫描出来的四元组**，不是你自己起的名字：
`{file, symbol, nodeKind, table}`，其中 `symbol` 形如 `"db.insert"` /
`"tx.insert"` / `"connection.update"`（**调用点的写法**，不是函数名），
`nodeKind` 恒为 `"CallExpression"`，`table` 是 drizzle 的**变量名**
`"briefingQuestions"`（不是 SQL 表名）。参照文件里现有的
`server/services/prd-briefing-service.ts` 那几条。

**不要凭空猜四元组。** 按这个顺序做：

```bash
# 1. 先跑，让它把实际扫描结果与快照的差异报出来
npx tsx scripts/run-tests-isolated.ts server/db/db-write-inventory.test.ts
```

失败输出会给出**精确的键**：新出现的（`briefing-question-store.ts` 的两处）
与已消失的（`prd-briefing-service.ts` 的 `db.update`/`briefingQuestions`
和 `tx.insert`/`briefingQuestions`）。

2. 按报出的键改 `db-write-policy.json`：新条目补
`"owner": "prd-briefing"` 与中文 `reason`（说明为什么这里要写库）；
删掉已消失的旧条目。`owner` 缺失会让第 3 步直接抛
`Cannot snapshot unowned production DB writes`。

3. `testFixtures` 加一条：

```json
    {
      "file": "server/services/briefing-question-store.test.ts",
      "mode": "suite-env",
      "reason": "project DB import is isolated by the pre-import STAGEPASS_DB_PATH test runner"
    }
```

（照抄同文件里既有条目的 `reason` 措辞，这一栏是套话。）

4. 重算并复验：

```bash
npx tsx scripts/generate-db-write-inventory-snapshot.ts
npx tsx scripts/run-tests-isolated.ts server/db/db-write-inventory.test.ts
```

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add server/db/migrations server/db/schema.ts server/services/briefing-question-store.ts server/services/briefing-question-store.test.ts server/services/prd-briefing-service.ts server/services/spec-battle-service.ts server/services/provider-action-authority-service.ts server/services/recovery-business-evidence.ts server/db/db-write-policy.json server/db/db-write-inventory.snapshot.json
git commit -m "$(cat <<'EOF'
refactor(briefing-questions): 六个读取点各自记得加过滤是守不住的，收口到唯一访问器

追问卡表要同时装 PRD 与 Spec 两个阶段的卡，而它现在有六处按 changeId 裸读。
漏一处的后果不是显示错乱：spec-battle-service 那处喂的是 PRD 的 source DB hash，
prd-briefing 那处喂的是 computePrdGate——一张 Spec 的 critical 卡会被当成未处理，
把 PRD 草稿门永久焊死。

访问器的每个读函数都强制传 phase，没有默认值也没有「全阶段」读法，
另加一条守卫测试禁止其他模块直接 select 该表。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 协议加 `QUESTION` 行

**Files:**
- Modify: `server/services/spec-critique-line-protocol.ts:22-25`、`:35`、`:37-39`、`:50-244`
- Modify: `server/services/spec-battle-ledger.ts:157-160`（`BlueCritiqueOutputSchema`）、`:162+`（JSON schema）
- Test: `server/services/spec-critique-line-protocol.test.ts`

**Interfaces:**
- Consumes: 无（本任务不依赖 Task 1）
- Produces:
  - `BlueHumanQuestion = { category: string; severity: "critical" | "important" | "optional"; question: string; whyItMatters: string; suggestedDefault: string | null }`
  - `SpecCritiqueLinePayload` 增加 `questions: BlueHumanQuestion[]`
  - `BlueCritiqueOutputSchema` 增加 `questions`（`.default([])`）

- [ ] **Step 1: 写失败测试**

Append to `server/services/spec-critique-line-protocol.test.ts`:

```typescript
describe("QUESTION lines", () => {
  it("parses a question card with five fields", () => {
    const result = parseSpecCritiqueLineProtocol([
      "QUESTION: scope | critical | 导出功能对外承诺吗 | 影响是否要写进对外文档 | 暂不对外承诺",
      "CRITIQUE_DONE: true",
    ].join("\n"));
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.payload.questions, [{
      category: "scope",
      severity: "critical",
      question: "导出功能对外承诺吗",
      whyItMatters: "影响是否要写进对外文档",
      suggestedDefault: "暂不对外承诺",
    }]);
  });

  it("reads - as an absent suggested default", () => {
    const result = parseSpecCritiqueLineProtocol([
      "QUESTION: scope | optional | 问题 | 理由 | -",
      "CRITIQUE_DONE: true",
    ].join("\n"));
    assert.equal(result.ok && result.payload.questions[0].suggestedDefault, null);
  });

  it("rejects a P0/P1/P2 severity on a question card", () => {
    // Question cards carry the PRD room's severity vocabulary, not the gap
    // ledger's. Sharing the word would make "N 个关键问题未处理" count two
    // different things.
    const result = parseSpecCritiqueLineProtocol([
      "QUESTION: scope | P0 | 问题 | 理由 | -",
      "CRITIQUE_DONE: true",
    ].join("\n"));
    assert.equal(result.ok, false);
    assert.match(
      !result.ok ? result.message : "",
      /QUESTION severity must be critical\/important\/optional/,
    );
  });

  it("rejects a question line with the wrong field count", () => {
    const result = parseSpecCritiqueLineProtocol([
      "QUESTION: scope | critical | 问题 | 理由",
      "CRITIQUE_DONE: true",
    ].join("\n"));
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /QUESTION needs exactly 5/);
  });

  it("still requires CRITIQUE_DONE when only questions were produced", () => {
    const result = parseSpecCritiqueLineProtocol(
      "QUESTION: scope | critical | 问题 | 理由 | -",
    );
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /CRITIQUE_DONE/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-critique-line-protocol.test.ts
```

Expected: FAIL — `payload.questions` 是 `undefined`。

- [ ] **Step 3: 实现解析**

In `server/services/spec-critique-line-protocol.ts`:

改 payload 类型（`:22-25`）：

```typescript
export interface SpecCritiqueLinePayload {
  gapReviews: BlueGapReview[];
  requirementGaps: BlueRequirementGap[];
  questions: BlueHumanQuestion[];
}
```

从 ledger import 类型：

```typescript
import type {
  BlueGapReview,
  BlueHumanQuestion,
  BlueRequirementGap,
} from "./spec-battle-ledger";
```

加常量（`:31-39` 一带）：

```typescript
/**
 * Question cards land in briefing_questions alongside the PRD room's cards and
 * render through the same component, so they speak that room's severity
 * vocabulary. P0/P1/P2 belongs to the gap ledger; sharing the words would make
 * one counter mean two things.
 */
const QUESTION_SEVERITIES = new Set(["critical", "important", "optional"]);

const KEYWORDS = ["REVIEW", "GAP", "QUESTION", "ARTIFACT", "CRITIQUE_DONE"] as const;

const QUESTION_FIELDS = 5;
```

在 `parseSpecCritiqueLineProtocol` 里，`const doneMarkers` 旁加：

```typescript
  const questions: BlueHumanQuestion[] = [];
```

在 `if (keyword === "GAP") { ... }` 块之后、`// ARTIFACT` 之前插入：

```typescript
    if (keyword === "QUESTION") {
      const fields = splitFields(rest);
      if (fields.length !== QUESTION_FIELDS) {
        errors.push(
          `line ${lineNo}: QUESTION needs exactly ${QUESTION_FIELDS} "|" fields (category | critical/important/optional | 问题 | 为什么重要 | 建议默认值 或 -), got ${fields.length}. 文本字段不得含 "|"`,
        );
        continue;
      }
      const [category, severity, question, whyItMatters, defaultRaw] = fields as [
        string, string, string, string, string,
      ];
      if (!category) {
        errors.push(`line ${lineNo}: QUESTION category is empty`);
        continue;
      }
      if (!QUESTION_SEVERITIES.has(severity)) {
        errors.push(
          `line ${lineNo}: QUESTION severity must be critical/important/optional, got "${severity}"`,
        );
        continue;
      }
      if (!question) {
        errors.push(`line ${lineNo}: QUESTION question is empty`);
        continue;
      }
      if (!whyItMatters) {
        errors.push(`line ${lineNo}: QUESTION whyItMatters is empty`);
        continue;
      }
      questions.push({
        category,
        severity: severity as BlueHumanQuestion["severity"],
        question,
        whyItMatters,
        suggestedDefault: nullableField(defaultRaw),
      });
      continue;
    }
```

最后把 `questions` 加进返回的 payload：

```typescript
  return {
    ok: true,
    payload: {
      gapReviews,
      requirementGaps: gaps.map((gap) => ({
        ...gap,
        affectedArtifacts: artifactsByGapId.get(gap.canonicalGapId) ?? [],
      })),
      questions,
    },
  };
```

- [ ] **Step 4: 扩 ledger schema**

In `server/services/spec-battle-ledger.ts`:

在 `BlueRequirementGapSchema` 之后加：

```typescript
const QuestionSeveritySchema = z.enum(["critical", "important", "optional"]);

const BlueHumanQuestionSchema = z
  .object({
    category: z.string(),
    severity: QuestionSeveritySchema,
    question: z.string(),
    whyItMatters: z.string(),
    suggestedDefault: z.string().nullable(),
  })
  .strict();

export type BlueHumanQuestion = z.infer<typeof BlueHumanQuestionSchema>;
```

改 `BlueCritiqueOutputSchema`：

```typescript
export const BlueCritiqueOutputSchema = z.object({
  gapReviews: z.array(BlueGapReviewSchema),
  requirementGaps: z.array(BlueRequirementGapSchema),
  // Defaulted, not required: rounds that ran before this field existed, and
  // rounds where blue simply had nothing to ask, both parse to an empty list.
  questions: z.array(BlueHumanQuestionSchema).default([]),
}).strict();
```

在 `BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA` 的 `properties` 里加（`required` **不加**
`questions`，与 zod 的 `.default([])` 保持一致）：

```typescript
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string" },
          severity: { type: "string", enum: ["critical", "important", "optional"] },
          question: { type: "string" },
          whyItMatters: { type: "string" },
          suggestedDefault: { type: ["string", "null"] },
        },
        required: ["category", "severity", "question", "whyItMatters", "suggestedDefault"],
      },
    },
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-critique-line-protocol.test.ts server/services/spec-battle-ledger.test.ts
```

Expected: PASS，`ℹ fail 0`。

- [ ] **Step 6: 提交**

```bash
git add server/services/spec-critique-line-protocol.ts server/services/spec-critique-line-protocol.test.ts server/services/spec-battle-ledger.ts
git commit -m "$(cat <<'EOF'
feat(spec-battle): 协议加 QUESTION 行——蓝方能问人，而不是只能报 gap

有一类东西蓝方本来就不该替人决定：取舍、对外承诺、优先级。
以前它只有 GAP 一种表达，于是这类东西要么被包装成缺陷，要么根本不说。

问题卡用 critical/important/optional 而非 P0/P1/P2：它落进 briefing_questions
与 PRD 的卡同表同渲染，共用严重度词会让「N 个关键问题未处理」同时数两种东西。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `needs_human_decision` 拆出独立分支，问题卡落库

**Files:**
- Modify: `server/services/spec-battle-service.ts:1031-1160`（`completeBlueCritique`）
- Modify: `server/db/db-write-policy.json`
- Test: `server/services/spec-battle-service.test.ts`
- Test: `server/services/prd-briefing-service.test.ts`（串扰测试）

**Interfaces:**
- Consumes: Task 1 的 `insertBriefingQuestionsWithDb`、`listBriefingQuestions`；
  Task 2 的 `BlueHumanQuestion`、payload 的 `questions` 字段
- Produces: `completeBlueCritique` 会为 `needs_human_decision` 的复核和
  `QUESTION` 行各写一张 `phase: "Spec"` 的卡

- [ ] **Step 1: 写失败测试**

Append to `server/services/spec-battle-service.test.ts`（沿用文件里既有的建库夹具
和 `completeBlueCritique` 调用写法，下面只给断言主体）：

```typescript
describe("blue critique human questions", () => {
  it("writes a Spec-phase card for each QUESTION line", async () => {
    const { changeId, roundId } = await seedRoundReadyForBlue();
    await completeBlueCritique({
      changeId,
      roundId,
      output: {
        gapReviews: [],
        requirementGaps: [],
        questions: [{
          category: "scope",
          severity: "critical",
          question: "导出功能对外承诺吗",
          whyItMatters: "影响是否写进对外文档",
          suggestedDefault: null,
        }],
      },
      artifactPath: "x", artifactHash: "y",
    });

    const cards = listBriefingQuestions(changeId, "Spec");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].question, "导出功能对外承诺吗");
    assert.equal(cards[0].status, "open");
    assert.equal(cards[0].phase, "Spec");
  });

  it("keeps a needs_human_decision gap blocking and gives it a card", async () => {
    // Blue saying "a human must decide this" is not blue saying "not a
    // problem". The gap keeps blocking; what changes is that the human now has
    // a handle on it instead of only being able to rerun the whole round.
    const { changeId, roundId, canonicalGapId } = await seedRoundWithOpenP0();
    await completeBlueCritique({
      changeId,
      roundId,
      output: {
        gapReviews: [{
          canonicalGapId,
          verdict: "needs_human_decision",
          reviewSummary: "两个方案都合理，取舍属于人类",
          evidence: "规格第 3 节",
          resolutionEvidence: null,
          downgradedTo: null,
        }],
        requirementGaps: [],
        questions: [],
      },
      artifactPath: "x", artifactHash: "y",
    });

    const gap = getGaps(changeId).find((row) => row.canonicalGapId === canonicalGapId);
    assert.equal(gap?.status, "open");
    assert.equal(gap?.specBlocking, 1);

    const cards = listBriefingQuestions(changeId, "Spec");
    assert.equal(cards.length, 1);
    assert.match(cards[0].question, /取舍属于人类/);
    assert.equal(cards[0].category, "gap_decision");
  });

  it("numbers Spec cards by the battle round that produced them", async () => {
    const { changeId, roundId } = await seedRoundReadyForBlue({ roundNo: 2 });
    await completeBlueCritique({
      changeId, roundId,
      output: {
        gapReviews: [], requirementGaps: [],
        questions: [{
          category: "scope", severity: "optional", question: "问题",
          whyItMatters: "理由", suggestedDefault: null,
        }],
      },
      artifactPath: "x", artifactHash: "y",
    });
    assert.equal(listBriefingQuestions(changeId, "Spec")[0].roundNo, 2);
  });
});
```

Append to `server/services/prd-briefing-service.test.ts`:

```typescript
it("a Spec question card does not touch the PRD gate", async () => {
  // The landmine in sharing briefing_questions: computePrdGate refuses the
  // draft while any critical card is open, and it must never see a card that
  // belongs to another phase. A regression here does not look like a display
  // bug -- it welds the PRD draft gate shut with no way to clear it.
  const changeId = await seedBriefingWithAllQuestionsAnswered();
  const gateBefore = getPrdBriefingState(changeId).gate;
  assert.equal(gateBefore.canLock || gateBefore.openCriticalCount === 0, true);

  db.transaction((tx) => {
    insertBriefingQuestionsWithDb(tx, [{
      id: "BQ-spec-intruder", changeId, phase: "Spec", roundNo: 1,
      category: "scope", severity: "critical", question: "Spec 的关键问题",
      whyItMatters: "理由", suggestedDefault: null, status: "open",
      answer: null, source: "ai_blue",
    }]);
  });

  const gateAfter = getPrdBriefingState(changeId).gate;
  assert.deepEqual(gateAfter, gateBefore);
  assert.deepEqual(
    getPrdBriefingState(changeId).questions.map((row) => row.phase),
    getPrdBriefingState(changeId).questions.map(() => "PRD"),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-battle-service.test.ts
```

Expected: FAIL — `listBriefingQuestions(changeId, "Spec")` 返回空数组。

- [ ] **Step 3: 拆出 `needs_human_decision` 分支**

In `server/services/spec-battle-service.ts`, 把 `:1127` 的合并条件拆开。
**`still_open` 分支保持原样，只把 `|| review.verdict === "needs_human_decision"` 去掉**，
然后在它之后、`const unreachable: never` 之前插入新分支：

```typescript
      if (review.verdict === "needs_human_decision") {
        // Blue is not saying the gap is fine -- it is saying the call is not
        // blue's to make. So the gap keeps blocking exactly as still_open does;
        // what this branch adds is a card, so the human has something to act on
        // instead of only being able to rerun the round or stop the battle.
        // Collapsing this verdict into still_open (which is what used to
        // happen) threw that signal away at the last step before the database.
        const openRuleGap: RuleGap = { ...toRuleGap(gap), status: "open" };
        tx.update(requirementGaps)
          .set({
            lastEvaluatedRoundId: input.roundId,
            status: "open",
            evidence: review.evidence,
            specBlocking: isSpecBlockingGap(openRuleGap) ? 1 : 0,
            mergeBlocking: isMergeBlockingGap(openRuleGap) ? 1 : 0,
            sourceHashesJson,
            updatedAt: now,
            closedAt: null,
          })
          .where(eq(requirementGaps.id, gap.id))
          .run();
        humanDecisionCards.push({
          category: "gap_decision",
          severity: effectiveSeverity(toRuleGap(gap)) === "P2" ? "important" : "critical",
          question: review.reviewSummary,
          whyItMatters: `Requirement Gap ${gap.canonicalGapId}：${gap.title}`,
          suggestedDefault: null,
        });
        continue;
      }
```

在事务开始处（`resolvedByReviewCanonicalGapIds` 声明旁）加：

```typescript
  const humanDecisionCards: BlueHumanQuestion[] = [];
```

- [ ] **Step 4: 把两类卡一起落库**

在同一事务内，gap 循环结束之后加：

```typescript
      // Both sources of card land in one place: the QUESTION lines blue wrote
      // on purpose, and the gaps it marked as the human's call. They are the
      // same thing to the person reading the room.
      const cards = [...humanDecisionCards, ...(input.output.questions ?? [])];
      if (cards.length > 0) {
        insertBriefingQuestionsWithDb(tx, cards.map((card, index) => ({
          id: `${nextRandomId("BQ")}-${index}`,
          changeId: input.changeId,
          phase: "Spec" as const,
          roundNo: round.roundNo,
          category: card.category,
          severity: card.severity,
          question: card.question,
          whyItMatters: card.whyItMatters,
          suggestedDefault: card.suggestedDefault,
          status: "open",
          answer: null,
          source: "ai_blue",
        })));
      }
```

`round` 需在事务外先读出（`latestRound(input.changeId)` 或按 `input.roundId` 查），
以便取 `roundNo`。若函数里已有该行，直接复用，不要重复查询。

import 补 `BlueHumanQuestion` 与 `insertBriefingQuestionsWithDb`。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-battle-service.test.ts server/services/prd-briefing-service.test.ts
```

Expected: PASS，`ℹ fail 0`、`ℹ cancelled 0`。
串扰测试（`a Spec question card does not touch the PRD gate`）必须通过。

- [ ] **Step 6: 登记写入点并重算快照**

`spec-battle-service.ts` 现在通过访问器写 `briefing_questions`。
AST 扫描按调用点归属，若快照生成器报出新条目，按提示补进 `productionEntries`：

```bash
npx tsx scripts/generate-db-write-inventory-snapshot.ts
npx tsx scripts/run-tests-isolated.ts server/db/db-write-inventory.test.ts
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add server/services/spec-battle-service.ts server/services/spec-battle-service.test.ts server/services/prd-briefing-service.test.ts server/db/db-write-policy.json server/db/db-write-inventory.snapshot.json
git commit -m "$(cat <<'EOF'
fix(spec-battle): 蓝方说「这得人来定」，落库时被压成普通阻断项

needs_human_decision 三处都认它——解析器、zod 判别联合、提示词——
唯独 completeBlueCritique 把它和 still_open 合成一个分支写成 status open。
于是蓝方唯一一种「我不该替人决定」的表达，在最后一步变回了又一条人碰不到的阻断项。

拆出独立分支：gap 照旧阻断（蓝方没说它不是问题），但同时挂一张卡，
人终于有把手。QUESTION 行产出的卡走同一条落库路径，phase 记 Spec。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 异议/否决的判定规则与 Merge 第二把钥匙

**Files:**
- Create: `server/services/spec-gap-dispute-rules.ts`
- Create: `server/services/spec-gap-dispute-rules.test.ts`
- Modify: `server/services/spec-battle-rules.ts:11-17`（`RuleGap`）、`:66-74`（`isMergeBlockingGap`）
- Test: `server/services/spec-battle-rules.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `RuleGap` 增加 `mergeOverrideReason: string | null`
  - `disputeUnanswered(input: DisputeStateInput): boolean`
  - `canOverrideGap(input: DisputeStateInput & { blocking: boolean }): boolean`
  - `interface DisputeStateInput { disputes: Array<{ roundId: string | null }>; reviews: Array<{ roundId: string }>; roundOrder: string[] }`

- [ ] **Step 1: 写纯函数的失败测试**

Create `server/services/spec-gap-dispute-rules.test.ts`:

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canOverrideGap, disputeUnanswered } from "./spec-gap-dispute-rules.ts";

const ROUNDS = ["BRD-1", "BRD-2", "BRD-3"];

describe("dispute state", () => {
  it("is not unanswered when no dispute was raised", () => {
    assert.equal(
      disputeUnanswered({ disputes: [], reviews: [{ roundId: "BRD-1" }], roundOrder: ROUNDS }),
      false,
    );
  });

  it("is unanswered when blue has not reviewed since the dispute", () => {
    assert.equal(
      disputeUnanswered({
        disputes: [{ roundId: "BRD-2" }],
        reviews: [{ roundId: "BRD-1" }],
        roundOrder: ROUNDS,
      }),
      true,
    );
  });

  it("is answered once blue reviews in a later round", () => {
    assert.equal(
      disputeUnanswered({
        disputes: [{ roundId: "BRD-1" }],
        reviews: [{ roundId: "BRD-2" }],
        roundOrder: ROUNDS,
      }),
      false,
    );
  });

  it("treats a review in the same round as the dispute as not an answer", () => {
    // The dispute is recorded against the round the human was looking at. A
    // review already written in that round was written before the dispute
    // existed, so it cannot be a response to it.
    assert.equal(
      disputeUnanswered({
        disputes: [{ roundId: "BRD-2" }],
        reviews: [{ roundId: "BRD-2" }],
        roundOrder: ROUNDS,
      }),
      true,
    );
  });

  it("counts a dispute with no round as always unanswered", () => {
    // human_decisions.round_id is nullable. A dispute we cannot place in the
    // round order must not silently unlock override.
    assert.equal(
      disputeUnanswered({
        disputes: [{ roundId: null }],
        reviews: [{ roundId: "BRD-3" }],
        roundOrder: ROUNDS,
      }),
      true,
    );
  });
});

describe("override availability", () => {
  const answered = {
    disputes: [{ roundId: "BRD-1" }],
    reviews: [{ roundId: "BRD-2" }],
    roundOrder: ROUNDS,
  };

  it("requires a dispute first", () => {
    assert.equal(
      canOverrideGap({ disputes: [], reviews: [{ roundId: "BRD-2" }], roundOrder: ROUNDS, blocking: true }),
      false,
    );
  });

  it("requires blue to have answered the dispute", () => {
    assert.equal(
      canOverrideGap({
        disputes: [{ roundId: "BRD-2" }],
        reviews: [{ roundId: "BRD-1" }],
        roundOrder: ROUNDS,
        blocking: true,
      }),
      false,
    );
  });

  it("is unavailable once the gap stopped blocking", () => {
    // Blue conceding -- resolving or downgrading below the blocking line -- is
    // the good outcome. There is nothing left to override.
    assert.equal(canOverrideGap({ ...answered, blocking: false }), false);
  });

  it("is available after a dispute blue answered and did not concede", () => {
    assert.equal(canOverrideGap({ ...answered, blocking: true }), true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-gap-dispute-rules.test.ts
```

Expected: FAIL — `Cannot find module './spec-gap-dispute-rules'`。

- [ ] **Step 3: 实现纯函数**

Create `server/services/spec-gap-dispute-rules.ts`:

```typescript
/**
 * "The human disputed this gap and blue has not answered yet" is a derived
 * fact, not a stored one.
 *
 * Adding `disputed` to GapStatus would mean touching every reader of that
 * enum -- isSpecBlockingGap, isMergeBlockingGap, ACTIVE_GAP_STATUSES,
 * computeGapCounts, activeSpecBlocking, the report, the delivery note -- for a
 * value whose blocking behaviour is identical to `open`. A dispute does not
 * change whether the gap stops you; it changes what blue owes you and what the
 * room shows.
 *
 * It lives in one named function rather than inline conditions at call sites so
 * there is exactly one copy of the rule to keep correct.
 */

export interface DisputeStateInput {
  /** Human `dispute` decisions on this gap. `roundId` is nullable in the table. */
  disputes: Array<{ roundId: string | null }>;
  /** Blue reviews of this gap, one per round it looked at it. */
  reviews: Array<{ roundId: string }>;
  /** Every round id for the change, oldest first. Position is the comparison. */
  roundOrder: string[];
}

function roundIndex(roundOrder: string[], roundId: string | null): number {
  if (roundId === null) return Number.POSITIVE_INFINITY;
  const index = roundOrder.indexOf(roundId);
  // A round we cannot place is treated as newer than everything, so an
  // unplaceable dispute stays unanswered rather than silently unlocking
  // override.
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/** The newest dispute's position, or null when none was raised. */
function latestDisputeIndex(input: DisputeStateInput): number | null {
  if (input.disputes.length === 0) return null;
  return Math.max(...input.disputes.map((dispute) => roundIndex(input.roundOrder, dispute.roundId)));
}

export function disputeUnanswered(input: DisputeStateInput): boolean {
  const disputeAt = latestDisputeIndex(input);
  if (disputeAt === null) return false;
  // Strictly later: a review already written in the disputed round predates the
  // dispute, so it cannot be a response to it.
  return !input.reviews.some((review) => roundIndex(input.roundOrder, review.roundId) > disputeAt);
}

export function canOverrideGap(input: DisputeStateInput & { blocking: boolean }): boolean {
  if (!input.blocking) return false;
  if (latestDisputeIndex(input) === null) return false;
  return !disputeUnanswered(input);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-gap-dispute-rules.test.ts
```

Expected: PASS，10 个用例全绿。

- [ ] **Step 5: 写 Merge 第二把钥匙的失败测试**

Append to `server/services/spec-battle-rules.test.ts`:

```typescript
describe("overridden P0 and the merge gate", () => {
  const overriddenP0 = {
    id: "G1", severity: "P0" as const, originalSeverity: "P0" as const,
    downgradedTo: null, status: "overridden" as const, mergeOverrideReason: null,
  };

  it("clears the spec gate", () => {
    assert.equal(isSpecBlockingGap(overriddenP0), false);
  });

  it("still blocks merge until the second key is turned", () => {
    assert.equal(isMergeBlockingGap(overriddenP0), true);
  });

  it("clears merge once the merge override reason is recorded", () => {
    assert.equal(
      isMergeBlockingGap({ ...overriddenP0, mergeOverrideReason: "已知限制，本次接受" }),
      false,
    );
  });

  it("does not let a merge override reason clear a gap that was never overridden", () => {
    // The second key is only a key for a door the first key already opened.
    assert.equal(
      isMergeBlockingGap({
        ...overriddenP0, status: "open", mergeOverrideReason: "试图绕过",
      }),
      true,
    );
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-battle-rules.test.ts
```

Expected: FAIL — `clears merge once the merge override reason is recorded` 得到 `true`。

- [ ] **Step 7: 改 `isMergeBlockingGap`**

In `server/services/spec-battle-rules.ts`, `RuleGap` 加字段：

```typescript
export interface RuleGap {
  id: string;
  severity: Severity;
  originalSeverity: Severity;
  downgradedTo: "P1" | "P2" | null;
  status: GapStatus;
  /**
   * The second key. `overridden` alone clears the Spec gate but deliberately
   * not the Merge gate -- deferring a P0 is not the same as shipping one. This
   * is turned separately at the Merge stage, and until it is, the gap keeps
   * blocking merge.
   */
  mergeOverrideReason: string | null;
}
```

改 `isMergeBlockingGap`（`:66-74`）：

```typescript
export function isMergeBlockingGap(gap: RuleGap): boolean {
  const severity = effectiveSeverity(gap);

  if (gap.status === "resolved") return false;
  if (gap.status === "waived" && severity === "P1") return false;
  if (gap.status === "overridden" && gap.originalSeverity === "P0") {
    // Two keys. Overriding at Spec says "I am taking this forward knowingly";
    // it does not say "ship it". Without the second key this returned true
    // unconditionally, and merge-readiness only releases on status 'resolved'
    // -- which only blue can grant, and blue stops rechecking overridden gaps.
    // That was a blocker with no exit.
    return gap.mergeOverrideReason === null;
  }

  return severity === "P0" || severity === "P1";
}
```

- [ ] **Step 8: 修所有构造 `RuleGap` 的地方**

`toRuleGap`（`server/services/spec-battle-row-readers.ts`）加
`mergeOverrideReason: gap.mergeOverrideReason`。
TypeScript 会指出其余每一处缺字段的构造点（测试夹具、
`spec-battle-service.ts` 内的 `openRuleGap` / `downgradedRuleGap` 等）——逐个补齐。
`spec-battle-service.ts` 里那些从既有 gap 派生的临时 `RuleGap`
用 `...toRuleGap(gap)` 展开的自然带上，不需额外改。

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 9: 跑测试确认通过**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-battle-rules.test.ts server/services/spec-battle-ledger.test.ts server/services/spec-battle-service.test.ts server/services/merge-readiness-service.test.ts
```

Expected: PASS，`ℹ fail 0`。

- [ ] **Step 10: 提交**

```bash
git add server/services/spec-gap-dispute-rules.ts server/services/spec-gap-dispute-rules.test.ts server/services/spec-battle-rules.ts server/services/spec-battle-rules.test.ts server/services/spec-battle-row-readers.ts
git commit -m "$(cat <<'EOF'
feat(spec-battle): 否决 P0 会通向一堵没有门的墙，补第二把钥匙

rules 里写着「否决的原 P0 仍挡 Merge」，而 merge-readiness 只认 status resolved，
那是只有蓝方能给的结论；同时 computeRoundDelta 已把 overridden 排除出待复核名单。
三条连起来：否决一条 P0 就能一路走到 Merge 再被永久挡住，且没有任何出口。

改成两把钥匙：Spec 那把开 Spec 门，Merge 门口另有一把单独开。
异议是否已被回应用派生判定，不进 GapStatus 枚举——它不改变这条 gap 拦不拦你。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 人对 gap 的四个动作

**Files:**
- Modify: `server/types/enums.ts:177-182`（`HumanDecisionAction`）
- Modify: `server/services/spec-battle-service.ts:73-79`（`SpecBattleDecisionInput`）、`:1335+`（`applySpecBattleDecision`）
- Modify: `app/api/projects/[id]/changes/[changeId]/spec-battle/decision/route.ts`
- Test: `server/services/spec-battle-service.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `canOverrideGap` / `disputeUnanswered`
- Produces: `SpecBattleDecisionInput["action"]` 增加
  `"supply_fact" | "dispute" | "override" | "revoke_override"`；
  `getSpecBattleState` 的每条 gap 增加
  `{ disputeUnanswered: boolean; canOverride: boolean; disputes: HumanDecisionRow[] }`

- [ ] **Step 1: 写失败测试**

Append to `server/services/spec-battle-service.test.ts`:

```typescript
describe("human gap actions", () => {
  it("still refuses to let a human resolve a gap", async () => {
    // The line this whole feature is built to respect: "resolved" is a factual
    // claim about the artifact, and only the side that checked it may make it.
    const { changeId, gapId } = await seedReportReadyWithOpenP1();
    await assert.rejects(
      () => applySpecBattleDecision({
        changeId, action: "approve", targetType: "requirement_gap",
        targetId: gapId, reason: null,
      }),
      (err: Error) => err instanceof SpecBattleError && err.code === "human_cannot_resolve_gap",
    );
  });

  it("records a supplied fact without changing the gap", async () => {
    const { changeId, gapId } = await seedReportReadyWithOpenP1();
    await applySpecBattleDecision({
      changeId, action: "supply_fact", targetType: "requirement_gap",
      targetId: gapId, reason: "导出上限线上是 5000",
    });
    const gap = getGaps(changeId).find((row) => row.id === gapId);
    assert.equal(gap?.status, "open");
    assert.equal(gap?.specBlocking, 1);
    assert.equal(
      getDecisions(changeId).some((row) => row.action === "supply_fact"),
      true,
    );
  });

  it("requires a reason to dispute", async () => {
    const { changeId, gapId } = await seedReportReadyWithOpenP1();
    await assert.rejects(
      () => applySpecBattleDecision({
        changeId, action: "dispute", targetType: "requirement_gap",
        targetId: gapId, reason: null,
      }),
      (err: Error) => err instanceof SpecBattleError && err.code === "decision_reason_required",
    );
  });

  it("refuses an override before blue has answered the dispute", async () => {
    const { changeId, gapId } = await seedReportReadyWithOpenP1();
    await applySpecBattleDecision({
      changeId, action: "dispute", targetType: "requirement_gap",
      targetId: gapId, reason: "蓝方读错了验收条款",
    });
    await assert.rejects(
      () => applySpecBattleDecision({
        changeId, action: "override", targetType: "requirement_gap",
        targetId: gapId, reason: "我认这个风险",
      }),
      (err: Error) => err instanceof SpecBattleError && err.code === "dispute_unanswered",
    );
  });

  it("overrides after blue answered and did not concede", async () => {
    const { changeId, gapId, canonicalGapId } = await seedReportReadyWithOpenP1();
    await applySpecBattleDecision({
      changeId, action: "dispute", targetType: "requirement_gap",
      targetId: gapId, reason: "蓝方读错了验收条款",
    });
    await runAnotherBlueRoundHolding(changeId, canonicalGapId);
    await applySpecBattleDecision({
      changeId, action: "override", targetType: "requirement_gap",
      targetId: gapId, reason: "本次接受，记为已知限制",
    });
    const gap = getGaps(changeId).find((row) => row.id === gapId);
    assert.equal(gap?.status, "overridden");
    assert.equal(gap?.overrideReason, "本次接受，记为已知限制");
    assert.equal(gap?.specBlocking, 0);
  });

  it("revoking an override clears the merge key too", async () => {
    // Otherwise revoke-then-override-again would arrive at Merge with a key
    // that was turned for a decision the human already took back.
    const { changeId, gapId } = await seedOverriddenP0WithMergeKey();
    await applySpecBattleDecision({
      changeId, action: "revoke_override", targetType: "requirement_gap",
      targetId: gapId, reason: null,
    });
    const gap = getGaps(changeId).find((row) => row.id === gapId);
    assert.equal(gap?.status, "open");
    assert.equal(gap?.overrideReason, null);
    assert.equal(gap?.mergeOverrideReason, null);
    assert.equal(gap?.specBlocking, 1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-battle-service.test.ts
```

Expected: FAIL — TypeScript 拒绝 `action: "supply_fact"`。

- [ ] **Step 3: 扩动作枚举**

In `server/types/enums.ts`, `HumanDecisionAction` 加四个值：

```typescript
export const HumanDecisionAction = z.enum([
  "approve",
  "request_changes",
  "return_to_spec",
  "waive_p1",
  // The human's inputs into the battle. None of them claims a gap is fixed --
  // that stays blue's alone (human_cannot_resolve_gap).
  "supply_fact",
  "dispute",
  "override",
  "revoke_override",
]);
```

In `server/services/spec-battle-service.ts:73-79`:

```typescript
export interface SpecBattleDecisionInput {
  changeId: string;
  action:
    | "approve"
    | "request_changes"
    | "return_to_spec"
    | "waive_p1"
    | "supply_fact"
    | "dispute"
    | "override"
    | "revoke_override";
  targetType: "gate" | "requirement_gap" | "finding" | null;
  targetId: string | null;
  reason: string | null;
}
```

- [ ] **Step 4: 实现四个分支**

In `applySpecBattleDecision`，在 `if (input.action === "approve" && input.targetType === "requirement_gap")`
那条守卫**之后**、`if (input.action === "approve")` 之前插入：

```typescript
  if (input.action === "supply_fact") {
    // Nothing about the gap changes. The fact travels to the next round through
    // the decision ledger, which is what the blue prompt reads. A human knowing
    // something is an input to the argument, never a verdict on it.
    if (!input.reason) throw new SpecBattleError("decision_reason_required");
    const gap = findGapByTarget(input.changeId, input.targetId);
    if (!gap) throw new SpecBattleError("gap_not_found");
    await recordDecision(input, round.id, null);
    refreshMirrors(input.changeId);
    return;
  }

  if (input.action === "dispute") {
    if (!input.reason) throw new SpecBattleError("decision_reason_required");
    const gap = findGapByTarget(input.changeId, input.targetId);
    if (!gap) throw new SpecBattleError("gap_not_found");
    // The gap keeps blocking. A dispute obliges blue to answer it next round;
    // it does not by itself move the ledger.
    await recordDecision(input, round.id, null);
    refreshMirrors(input.changeId);
    return;
  }

  if (input.action === "override") {
    if (!input.reason) throw new SpecBattleError("decision_reason_required");
    const gap = findGapByTarget(input.changeId, input.targetId);
    if (!gap) throw new SpecBattleError("override_not_allowed");
    const disputeState = gapDisputeState(input.changeId, gap);
    if (!canOverrideGap({ ...disputeState, blocking: isSpecBlockingGap(toRuleGap(gap)) })) {
      throw new SpecBattleError(
        disputeUnanswered(disputeState) ? "dispute_unanswered" : "override_not_allowed",
      );
    }
    await recordDecision(input, round.id, null);
    const overriddenRuleGap: RuleGap = {
      ...toRuleGap(gap),
      status: "overridden",
      mergeOverrideReason: null,
    };
    db.update(requirementGaps)
      .set({
        status: "overridden",
        overrideReason: input.reason,
        specBlocking: isSpecBlockingGap(overriddenRuleGap) ? 1 : 0,
        mergeBlocking: isMergeBlockingGap(overriddenRuleGap) ? 1 : 0,
        updatedAt: nowISO(),
        closedAt: nowISO(),
      })
      .where(eq(requirementGaps.id, gap.id))
      .run();
    syncSpecStageAuthority(input.changeId);
    refreshMirrors(input.changeId);
    return;
  }

  if (input.action === "revoke_override") {
    const gap = findGapByTarget(input.changeId, input.targetId);
    if (!gap || gap.status !== "overridden") throw new SpecBattleError("override_not_found");
    await recordDecision(input, round.id, null);
    const reopenedRuleGap: RuleGap = {
      ...toRuleGap(gap),
      status: "open",
      mergeOverrideReason: null,
    };
    db.update(requirementGaps)
      .set({
        status: "open",
        overrideReason: null,
        // Cleared with it: a merge key turned for a decision the human has now
        // taken back must not survive to let a re-override skip the Merge gate.
        mergeOverrideReason: null,
        specBlocking: isSpecBlockingGap(reopenedRuleGap) ? 1 : 0,
        mergeBlocking: isMergeBlockingGap(reopenedRuleGap) ? 1 : 0,
        updatedAt: nowISO(),
        closedAt: null,
      })
      .where(eq(requirementGaps.id, gap.id))
      .run();
    syncSpecStageAuthority(input.changeId);
    refreshMirrors(input.changeId);
    return;
  }
```

加辅助函数（放在 `findGapByTarget` 旁）：

```typescript
/** Assembles the dispute-state view spec-gap-dispute-rules.ts reasons over. */
function gapDisputeState(changeId: string, gap: { id: string; canonicalGapId: string }) {
  return {
    disputes: getDecisions(changeId)
      .filter((row) => row.action === "dispute" && row.targetId === gap.id)
      .map((row) => ({ roundId: row.roundId })),
    reviews: getBlueGapReviews(changeId)
      .filter((row) => row.canonicalGapId === gap.canonicalGapId)
      .map((row) => ({ roundId: row.roundId })),
    roundOrder: allRounds(changeId)
      .sort((a, b) => a.roundNo - b.roundNo)
      .map((row) => row.id),
  };
}
```

**注意这四个分支必须放在 `if (change.status !== "SPEC_READY" || round.status !== "report_ready")`
守卫之后**——它们同样只在战报就绪时可用。

import 补 `canOverrideGap`、`disputeUnanswered`。

- [ ] **Step 5: 把 dispute 状态挂进 `getSpecBattleState`**

在 `getSpecBattleState` 组装 gaps 的地方，每条 gap 加三个派生字段供 UI 使用：

```typescript
      const disputeState = gapDisputeState(changeId, gap);
      return {
        ...gap,
        disputeUnanswered: disputeUnanswered(disputeState),
        canOverride: canOverrideGap({
          ...disputeState,
          blocking: isSpecBlockingGap(toRuleGap(gap)),
        }),
        disputes: getDecisions(changeId).filter(
          (row) => row.action === "dispute" && row.targetId === gap.id,
        ),
      };
```

- [ ] **Step 6: 开路由**

In `app/api/.../spec-battle/decision/route.ts`，`PublicSpecBattleDecisionAction`
自动包含新动作（它是 `Exclude<..., "approve">`）。四个新动作没有
`ACTION_DEFINITIONS` 条目，走与 `request_changes` / `return_to_spec` 相同的
`changeTerminalRefusal` 分支——即现有的 `else` 分支，**无需改动**。
确认 `payload.action === "waive_p1"` 那个 if 没有把新动作误吞即可。

- [ ] **Step 7: 跑测试确认通过**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-battle-service.test.ts server/services/spec-battle-routes.test.ts server/services/state-machine-enums.test.ts
```

Expected: PASS，`ℹ fail 0`。
`still refuses to let a human resolve a gap` 必须仍然通过。

- [ ] **Step 8: 提交**

```bash
git add server/types/enums.ts server/services/spec-battle-service.ts server/services/spec-battle-service.test.ts
git commit -m "$(cat <<'EOF'
feat(spec-battle): 人对每条 gap 能表态了，此前只有四个总开关

补充事实 / 异议 / 否决 / 撤销否决。没有「标记已解决」——
那是对产物的事实陈述，只有查证过的一方能说，human_cannot_resolve_gap 保留。

否决要先对质：提过异议且蓝方在更晚的轮次回应过、且它没撤，才解锁。
蓝方装没看见不会让你自动解锁，因为判定问的是「有没有更晚的复核」。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 人的输入送达蓝方，并要求蓝方必须回应

**Files:**
- Modify: `server/templates/prompts/spec-critic.md`
- Modify: `server/services/pipeline-spec-stage-service.ts`
- Test: `server/services/spec-battle-prompt.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `dispute` / `supply_fact` 决定；Task 3 的 Spec 问题卡
- Produces: 蓝方输入上下文中出现 `HUMAN_DISPUTE` / `HUMAN_FACT` / `HUMAN_ANSWER` 三类条目

- [ ] **Step 1: 写提示词的失败测试**

Append to `server/services/spec-battle-prompt.test.ts`:

```typescript
describe("spec-critic prompt: human input", () => {
  const prompt = fs.readFileSync(
    path.join(process.cwd(), "server/templates/prompts/spec-critic.md"),
    "utf-8",
  );

  it("documents the QUESTION line format", () => {
    assert.match(prompt, /QUESTION: category \| severity \| 问题 \| 为什么重要 \| 建议默认值/);
  });

  it("gives a decidable test for GAP vs QUESTION", () => {
    assert.match(prompt, /你能不能替人类给出正确答案/);
  });

  it("uses the question card severity vocabulary, not the gap one", () => {
    assert.match(prompt, /critical \/ important \/ optional/);
  });

  it("requires a REVIEW line for every human dispute", () => {
    assert.match(prompt, /HUMAN_DISPUTE/);
    assert.match(prompt, /不允许沉默略过/);
  });

  it("no longer tells blue that gaps are its only output", () => {
    // Reverse assertion: the value of this change is that the old framing is
    // gone, and a positive assertion cannot prove absence.
    assert.doesNotMatch(prompt, /只能通过 GAP 表达/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-battle-prompt.test.ts
```

Expected: FAIL — 提示词里没有 `QUESTION:`。

- [ ] **Step 3: 改提示词**

In `server/templates/prompts/spec-critic.md`，在输出协议的 `GAP:` 行之后加：

```
QUESTION: category | severity | 问题 | 为什么重要 | 建议默认值
```

在 GAP 字段说明之后加：

```
QUESTION 字段说明（每张交给人类拍板的问题卡一行，**严格 5 个字段，文本字段内不得出现 `|`**）：
- category：scope / goal / user / success / tradeoff 等。
- severity：`critical` / `important` / `optional` 之一。
  **注意这里不用 P0/P1/P2**——那是 Requirement Gap 的词汇，问题卡与 PRD 的追问卡同表同渲染。
- question：要人类回答的问题本身。
- whyItMatters：不回答会怎样。
- suggestedDefault：你建议的默认答案；给不出就写 `-`。

### 写 GAP 还是写 QUESTION

- 规格**写错了或写漏了**，而且你知道该补什么 → `GAP`。
- 规格没写错，但**这个决定本就不该由模型做**（取舍、优先级、对外承诺、
  影响体验的默认值）→ `QUESTION`。

判据：**你能不能替人类给出正确答案？** 能 → GAP。不能，只能列出选项 → QUESTION。

不要把 QUESTION 当作 GAP 的弱化版本用。一个你其实知道答案的问题写成 QUESTION，
只是把本该你做的工作推给人类。
```

在硬性规则一节加：

```
- 若上下文中出现 `HUMAN_DISPUTE` 条目，你**必须**为其中每一条对应的 gap 写一行 REVIEW：
  要么 `resolved` / `downgraded`（接受人类的异议），要么 `still_open` 并在 reviewSummary
  里说清人类哪里判断错了、证据是什么。**不允许沉默略过。**
  人类可能是对的——异议是一次免费的纠错机会，不是要你辩护的攻击。
- 若上下文中出现 `HUMAN_FACT` 或 `HUMAN_ANSWER` 条目，把它们当作已确认的事实，
  不要再就同一点提问或报 gap。
```

- [ ] **Step 4: 注入上下文**

In `server/services/pipeline-spec-stage-service.ts`，组装蓝方输入的地方，
在既有的 `requirement-gaps.json` / `red-fix-claims.json` 之外，追加一段文本块：

```typescript
/**
 * The human's side of the argument, rendered into blue's context.
 *
 * These are inputs, never verdicts: a dispute obliges blue to answer, a fact is
 * something blue should stop asking about. Neither closes a gap -- only blue
 * closes gaps.
 */
function renderHumanInput(changeId: string): string {
  const decisions = getDecisions(changeId);
  const gaps = getGaps(changeId);
  const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
  const lines: string[] = [];

  for (const decision of decisions) {
    const gap = decision.targetId ? gapById.get(decision.targetId) : undefined;
    if (decision.action === "dispute" && gap) {
      lines.push(`HUMAN_DISPUTE: ${gap.canonicalGapId} | ${decision.reason ?? ""}`);
    }
    if (decision.action === "supply_fact" && gap) {
      lines.push(`HUMAN_FACT: ${gap.canonicalGapId} | ${decision.reason ?? ""}`);
    }
  }

  for (const card of listBriefingQuestions(changeId, "Spec")) {
    if (card.status === "open") continue;
    lines.push(`HUMAN_ANSWER: ${card.question} | ${card.answer ?? ""}`);
  }

  if (lines.length === 0) return "";
  return ["## 人类输入", "", ...lines, ""].join("\n");
}
```

把它的返回值拼进蓝方 prompt 的上下文段落。
**不要**把它写进 `requirement-gaps.json`——那是台账，不是对话。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-battle-prompt.test.ts server/services/prompt-templates.test.ts
```

Expected: PASS，`ℹ fail 0`。

- [ ] **Step 6: 提交**

```bash
git add server/templates/prompts/spec-critic.md server/services/pipeline-spec-stage-service.ts server/services/spec-battle-prompt.test.ts
git commit -m "$(cat <<'EOF'
feat(spec-battle): 人的异议与事实送进蓝方上下文，并要求它逐条正面回应

异议不是攻击，是一次免费纠错——蓝方可能真看到了人没看到的东西。
所以先强制对质：蓝方必须写 REVIEW 明说接受还是不接受、不接受的证据是什么。

强制力不靠提示词自觉：沉默略过不会让人自动解锁否决，
因为判定问的是「有没有比异议更晚的复核」。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Merge 门口的第二把钥匙

**Files:**
- Modify: `server/services/merge-readiness-service.ts:636-651`
- Modify: `server/services/spec-battle-service.ts`（新增 `overrideGapForMerge`）
- Modify: `app/projects/[id]/changes/[changeId]/operational-phase-panel.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/gate-types.ts`（`MergeChecks` 加字段）
- Test: `server/services/merge-readiness-service.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `isMergeBlockingGap`、`RuleGap.mergeOverrideReason`
- Produces:
  - `overrideGapForMerge(input: { changeId: string; gapId: string; reason: string }): Promise<void>`
  - `MergeChecks` 增加 `mergeOverridableGaps: Array<{ id: string; canonicalGapId: string; title: string; overrideReason: string | null }>`

- [ ] **Step 1: 写失败测试**

Append to `server/services/merge-readiness-service.test.ts`:

```typescript
describe("overridden P0 at the merge gate", () => {
  it("is listed as a merge blocker", async () => {
    const { changeId } = await seedMergeReadyExceptOverriddenP0();
    const readiness = computeMergeReadiness(changeId);
    assert.equal(
      readiness.blockers.some((blocker) => blocker.blockerType === "requirement_gap"),
      true,
    );
  });

  it("stops blocking once the merge key is turned", async () => {
    const { changeId, gapId } = await seedMergeReadyExceptOverriddenP0();
    await overrideGapForMerge({ changeId, gapId, reason: "已知限制，本次接受" });
    const readiness = computeMergeReadiness(changeId);
    assert.equal(
      readiness.blockers.some((blocker) => blocker.blockerType === "requirement_gap"),
      false,
    );
  });

  it("refuses the merge key on a gap that was never overridden at Spec", async () => {
    const { changeId, gapId } = await seedMergeBlockedByOpenP0();
    await assert.rejects(
      () => overrideGapForMerge({ changeId, gapId, reason: "试图绕过" }),
      (err: Error) => err instanceof SpecBattleError && err.code === "override_not_found",
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/merge-readiness-service.test.ts
```

Expected: FAIL — `overrideGapForMerge` 不存在。

- [ ] **Step 3: 实现第二把钥匙**

In `server/services/spec-battle-service.ts` 新增导出：

```typescript
/**
 * The second key, turned at the Merge gate.
 *
 * Deliberately not part of applySpecBattleDecision: that function requires the
 * change to be SPEC_READY with a report_ready round, and by the time anyone is
 * at the Merge gate neither is true. Same ledger, same reason requirement,
 * different door.
 */
export async function overrideGapForMerge(input: {
  changeId: string;
  gapId: string;
  reason: string;
}): Promise<void> {
  if (!input.reason) throw new SpecBattleError("decision_reason_required");
  const gap = findGapByTarget(input.changeId, input.gapId);
  // Only a door the first key already opened. Without this check the merge key
  // would be a way to walk an undisputed P0 straight past both gates.
  if (!gap || gap.status !== "overridden") throw new SpecBattleError("override_not_found");

  await recordDecision(
    {
      changeId: input.changeId,
      action: "override",
      targetType: "requirement_gap",
      targetId: input.gapId,
      reason: input.reason,
    },
    null,
    null,
  );
  const clearedRuleGap: RuleGap = { ...toRuleGap(gap), mergeOverrideReason: input.reason };
  db.update(requirementGaps)
    .set({
      mergeOverrideReason: input.reason,
      mergeBlocking: isMergeBlockingGap(clearedRuleGap) ? 1 : 0,
      updatedAt: nowISO(),
    })
    .where(eq(requirementGaps.id, gap.id))
    .run();
  refreshMirrors(input.changeId);
}
```

`recordDecision` 的 `roundId` 传 `null`——`human_decisions.round_id` 可空
（`schema.ts:570`），Merge 阶段没有 battle round。

`merge-readiness-service.ts` **不需要改**：它读 `merge_blocking` 列
（`:641`），而该列已由 `isMergeBlockingGap` 派生。

- [ ] **Step 4: 加路由**

Create `app/api/projects/[id]/changes/[changeId]/spec-battle/merge-override/route.ts`
（照抄 `decision/route.ts` 的 guard + 错误映射结构）：

```typescript
import { NextResponse } from "next/server";
import { overrideGapForMerge, SpecBattleError } from "@/server/services/spec-battle-service";
import { changeTerminalRefusal } from "@/server/services/action-contract-decision-router";
import { requireProjectChange } from "../../route-guard";
import { actionPreflightErrorResponse, assertRequestProviderNotApplicable } from "../../action-preflight";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    const payload = (await request.json()) as { gapId?: string; reason?: string };
    assertRequestProviderNotApplicable(payload);
    const terminal = changeTerminalRefusal(guard.change.status, "spec_battle_merge_override");
    if (terminal) {
      return NextResponse.json(
        { error: terminal.reason, reasonCode: terminal.reasonCode },
        { status: 409 },
      );
    }
    if (!payload.gapId || !payload.reason) {
      return NextResponse.json({ error: "decision_reason_required" }, { status: 400 });
    }
    await overrideGapForMerge({ changeId, gapId: payload.gapId, reason: payload.reason });
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const preflightResponse = actionPreflightErrorResponse(err);
    if (preflightResponse) return preflightResponse;
    const message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof SpecBattleError) return NextResponse.json({ error: message }, { status: 409 });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 5: Merge 面板列出它们**

In `app/projects/[id]/changes/[changeId]/gate-types.ts`, `MergeChecks` 加：

```typescript
  /** Gaps overridden at Spec that still hold the merge gate. Each needs its own key. */
  mergeOverridableGaps: Array<{
    id: string;
    canonicalGapId: string;
    title: string;
    overrideReason: string | null;
  }>;
```

In `server/services/gate-service.ts` 的 `canMerge`，从 `requirementGaps` 里
筛出 `status === "overridden" && mergeBlocking === 1` 填进该字段。

In `operational-phase-panel.tsx`，`readinessFacts` 之后加：

```tsx
      {phase === "Merge" && (mergeChecks?.mergeOverridableGaps.length ?? 0) > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-950">Spec 阶段否决、仍挡 Merge 的项</p>
          <p className="mt-1 text-xs text-amber-900/80">
            这些项你在 Spec 阶段已经否决过一次，所以能往下走。上线是另一个决定，需要再确认一次。
          </p>
          <div className="mt-3 space-y-2">
            {mergeChecks?.mergeOverridableGaps.map((gap) => (
              <div key={gap.id} className="rounded-md border bg-background p-3">
                <p className="font-mono text-[11px] text-muted-foreground">{gap.canonicalGapId}</p>
                <p className="mt-1 text-sm font-medium">{gap.title}</p>
                {gap.overrideReason && (
                  <p className="mt-1 text-xs text-muted-foreground">Spec 阶段理由：{gap.overrideReason}</p>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => onMergeOverride?.(gap.id)}
                >
                  确认带病上线
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
```

`onMergeOverride` 作为可选 prop 传入，在 `page.tsx` 里接上
`ActionReasonDialog`（已有，`page.tsx:1190`）收理由后 POST 到新路由。

- [ ] **Step 6: 跑测试确认通过**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/merge-readiness-service.test.ts server/services/spec-battle-service.test.ts server/services/gate-service.test.ts
```

Expected: PASS，`ℹ fail 0`。

- [ ] **Step 7: 登记写入点并提交**

```bash
npx tsx scripts/generate-db-write-inventory-snapshot.ts
npx tsx scripts/run-tests-isolated.ts server/db/db-write-inventory.test.ts
git add server/services/spec-battle-service.ts server/services/gate-service.ts app/api/projects app/projects server/db/db-write-policy.json server/db/db-write-inventory.snapshot.json server/services/merge-readiness-service.test.ts
git commit -m "$(cat <<'EOF'
feat(merge): Spec 阶段否决的 P0 在 Merge 门口给第二把钥匙

否决 P0 让 Spec 放行，但上线是另一个决定，不该被同一次点击一并做掉。
所以 Merge 门口把这些项单独列出来，每条需要再确认一次。
只对已经在 Spec 否决过的项可用——不能拿它绕过一条从没对质过的 P0。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 抽出共享问题卡组件

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/question-card.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx:15-42`、`:175-259`、`:690`
- Test: `app/projects/[id]/changes/[changeId]/phase-review.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `QuestionCard` 组件，props：
    `{ question: QuestionCardData; value: string; busy: boolean; onChange: (value: string) => void; onAction: (action: QuestionAction, value: string) => void }`
  - `type QuestionAction = "answer" | "accept_assumption" | "defer"`
  - `type QuestionCardData = { id: string; roundNo: number | null; category: string; severity: "critical" | "important" | "optional"; status: "open" | "answered" | "assumption_accepted" | "deferred"; question: string; whyItMatters: string; suggestedDefault: string | null; answer: string | null }`
  - `SEVERITY_LABELS` / `SEVERITY_CLASS` / `STATUS_LABELS` 从此模块导出
  - `groupQuestionsByRound(questions: QuestionCardData[]): QuestionRound[]`

- [ ] **Step 1: 建共享模块**

Create `app/projects/[id]/changes/[changeId]/question-card.tsx`，把
`prd-briefing-room.tsx:15-42`（`QuestionAction`、`SEVERITY_LABELS`、
`SEVERITY_CLASS`、`STATUS_LABELS`）、`:142-173`（`QuestionRound`、
`groupQuestionsByRound`）、`:175-259`（`QuestionCard`）原样搬过来。

**唯一的改动**是把 `BriefingQuestion` 类型换成本模块自定义的 `QuestionCardData`
（结构同上「Produces」），使它不依赖 PRD 的类型文件——Spec 侧的数据源不同。

再加一个轮次容器组件，两个房间共用：

```tsx
export function QuestionRounds({
  rounds,
  answers,
  busy,
  onChange,
  onAction,
  roundLabel,
}: {
  rounds: QuestionRound[];
  answers: Record<string, string>;
  busy: boolean;
  onChange: (id: string, value: string) => void;
  onAction: (id: string, action: QuestionAction, value: string) => void;
  roundLabel: (roundNo: number) => string;
}) {
  return (
    <div className="space-y-3">
      {rounds.map((round) => (
        /*
         * An earlier round collapses only once every card in it is handled. A
         * round still holding an open card stays expanded -- those cards remain
         * answerable and still block the gate, so hiding them would hide the
         * reason the next step is refused.
         */
        <details
          key={round.roundNo}
          open={round.isLatest || round.openCount > 0}
          className="rounded-md border bg-muted/10"
          data-question-round={round.roundNo}
        >
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            {roundLabel(round.roundNo)}
            <span className="ml-2 font-normal text-muted-foreground">
              {round.questions.length - round.openCount}/{round.questions.length} 已处理
              {round.openCount > 0 ? ` · ${round.openCount} 个待处理` : ""}
            </span>
          </summary>
          {/*
           * Single column, deliberately. These cards carry a severity order,
           * and a two-column grid reflows them into an order nobody wrote.
           */}
          <div className="space-y-3 p-3 pt-0">
            {round.questions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                value={answers[question.id] ?? ""}
                busy={busy}
                onChange={(value) => onChange(question.id, value)}
                onAction={(action, value) => onAction(question.id, action, value)}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: PRD 房间改用共享组件**

In `prd-briefing-room.tsx`：删掉搬走的那些定义，改为 import；
`:669-704` 的整块 `<details>` 渲染替换为：

```tsx
          <QuestionRounds
            rounds={questionRounds}
            answers={answers}
            busy={actionLocked}
            onChange={(id, value) => setAnswers((prev) => ({ ...prev, [id]: value }))}
            onAction={handleQuestionAction}
            roundLabel={(roundNo) => `第 ${roundNo} 轮`}
          />
```

注意 `handleQuestionAction` 的签名已经是
`(questionId, action, value)`，与 `onAction` 一致，直接传引用。

- [ ] **Step 3: 加 UI 断言**

Append to `app/projects/[id]/changes/[changeId]/phase-review.test.ts`:

```typescript
describe("question card is shared, not copied", () => {
  const room = fs.readFileSync(
    path.join(process.cwd(), "app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx"),
    "utf-8",
  );

  it("the PRD room imports the shared card instead of defining its own", () => {
    assert.match(room, /from "\.\/question-card"/);
    assert.doesNotMatch(room, /^function QuestionCard\(/m);
  });

  it("cards render one per row", () => {
    // Two columns reflow severity-ordered cards into an order nobody wrote.
    const shared = fs.readFileSync(
      path.join(process.cwd(), "app/projects/[id]/changes/[changeId]/question-card.tsx"),
      "utf-8",
    );
    assert.doesNotMatch(shared, /xl:grid-cols-2/);
  });
});
```

- [ ] **Step 4: 跑测试与类型检查**

```bash
npx tsc --noEmit
npx tsx scripts/run-tests-isolated.ts "app/projects/[id]/changes/[changeId]/phase-review.test.ts"
```

Expected: 类型无错误；测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add "app/projects/[id]/changes/[changeId]/question-card.tsx" "app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx" "app/projects/[id]/changes/[changeId]/phase-review.test.ts"
git commit -m "$(cat <<'EOF'
refactor(ui): 问题卡抽成共享组件，两个房间从此不会各自漂移

Spec 也要有追问卡，而「和 PRD 长得一样」如果靠各写一份维持，
第一次改样式就会分岔。共用同一个组件是唯一不随时间漂移的实现方式。

顺带改单列：卡片有严重度顺序，双栏会把它重排成没人写过的顺序。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 重构 Spec 战场界面

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/gap-card.tsx`
- Create: `app/projects/[id]/changes/[changeId]/spec-battlefield.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/spec-battlefield.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`（接问题卡与 gap 动作的回调）

**Interfaces:**
- Consumes: Task 8 的 `QuestionRounds`；Task 5 给 `getSpecBattleState` 每条 gap 加的
  `disputeUnanswered` / `canOverride` / `disputes`
- Produces: `GapCard` 组件，props
  `{ gap: SpecGapView; busy: boolean; onAction: (action: GapAction, gapId: string) => void }`，
  `type GapAction = "supply_fact" | "dispute" | "waive_p1" | "override" | "revoke_override"`

- [ ] **Step 1: 写 UI 结构的失败测试**

Create `app/projects/[id]/changes/[changeId]/spec-battlefield.test.ts`:

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "fs";
import path from "path";

const dir = path.join(process.cwd(), "app/projects/[id]/changes/[changeId]");
const battlefield = fs.readFileSync(path.join(dir, "spec-battlefield.tsx"), "utf-8");

describe("spec battlefield layout", () => {
  it("renders the shared question rounds", () => {
    assert.match(battlefield, /QuestionRounds/);
    assert.match(battlefield, /from "\.\/question-card"/);
  });

  it("renders gap cards from the shared gap card component", () => {
    assert.match(battlefield, /from "\.\/gap-card"/);
  });

  it("has a five-step rail like the PRD room", () => {
    assert.match(battlefield, /STEP_LABELS/);
  });

  it("no longer buries the gaps inside the advanced-details block", () => {
    // Reverse assertion, and the point of the whole task: gaps were an appendix
    // because you could not act on them. Now you can, so they belong on the
    // main surface. A positive assertion cannot prove the old placement is gone.
    const advancedStart = battlefield.indexOf("高级详情");
    const gapCardUse = battlefield.indexOf("<GapCard");
    assert.notEqual(gapCardUse, -1, "GapCard is not rendered at all");
    assert.ok(
      gapCardUse < advancedStart || advancedStart === -1,
      "GapCard is rendered inside 高级详情; gaps must be on the main surface",
    );
  });

  it("does not print raw enum values at the user", () => {
    assert.match(battlefield, /GAP_STATUS_LABELS/);
    assert.doesNotMatch(battlefield, /\{severity\} · \{gap\.status\}/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts "app/projects/[id]/changes/[changeId]/spec-battlefield.test.ts"
```

Expected: FAIL — 找不到 `QuestionRounds`。

- [ ] **Step 3: 建 GapCard**

Create `app/projects/[id]/changes/[changeId]/gap-card.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";

export type GapAction = "supply_fact" | "dispute" | "waive_p1" | "override" | "revoke_override";

export interface SpecGapView {
  id: string;
  canonicalGapId: string;
  title: string;
  evidence: string;
  severity: "P0" | "P1" | "P2";
  originalSeverity: "P0" | "P1" | "P2";
  downgradedTo: "P1" | "P2" | null;
  status: "open" | "resolved" | "waived" | "downgraded" | "overridden";
  proposedSpecPatch: string | null;
  overrideReason: string | null;
  disputeUnanswered: boolean;
  canOverride: boolean;
  disputes: Array<{ id: string; reason: string | null }>;
}

const GAP_STATUS_LABELS: Record<SpecGapView["status"], string> = {
  open: "阻断中",
  resolved: "已解决",
  waived: "已接受风险",
  downgraded: "已降级",
  overridden: "已否决",
};

const SEVERITY_TONE: Record<"P0" | "P1" | "P2", string> = {
  P0: "border-red-300 bg-red-50 text-red-950",
  P1: "border-orange-300 bg-orange-50 text-orange-950",
  P2: "border-slate-200 bg-slate-50 text-slate-800",
};

function effectiveSeverity(gap: SpecGapView): "P0" | "P1" | "P2" {
  return gap.downgradedTo ?? gap.severity;
}

export function GapCard({
  gap,
  busy,
  onAction,
}: {
  gap: SpecGapView;
  busy: boolean;
  onAction: (action: GapAction, gapId: string) => void;
}) {
  const severity = effectiveSeverity(gap);
  const settled = gap.status === "resolved" || gap.status === "waived" || gap.status === "overridden";
  const canWaive = severity === "P1" && (gap.status === "open" || gap.status === "downgraded");

  return (
    <div className={`rounded-md border p-3 ${SEVERITY_TONE[severity]}`} data-spec-gap={gap.canonicalGapId}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-background/80 px-2 py-0.5 text-[11px] font-medium">{severity}</span>
        <span className="rounded bg-background/70 px-2 py-0.5 text-[11px]">
          {GAP_STATUS_LABELS[gap.status]}
        </span>
        {gap.disputeUnanswered && (
          <span className="rounded bg-background/70 px-2 py-0.5 text-[11px]">等待反方回应异议</span>
        )}
        <span className="font-mono text-[11px] opacity-70">{gap.canonicalGapId}</span>
      </div>
      <p className="text-sm font-medium">{gap.title}</p>
      <p className="mt-1 text-xs leading-5 opacity-75">{gap.evidence}</p>
      {gap.proposedSpecPatch && (
        <p className="mt-2 rounded border border-current/10 bg-background/70 px-2 py-1 text-xs">
          反方建议补入：{gap.proposedSpecPatch}
        </p>
      )}
      {gap.disputes.map((dispute) => (
        <p key={dispute.id} className="mt-2 rounded bg-background/80 px-2 py-1 text-xs">
          你的异议：{dispute.reason}
        </p>
      ))}
      {gap.overrideReason && (
        <p className="mt-2 rounded bg-background/80 px-2 py-1 text-xs">否决理由：{gap.overrideReason}</p>
      )}
      {!settled && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy}
            onClick={() => onAction("supply_fact", gap.id)}>
            补充事实
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || gap.disputeUnanswered}
            title={gap.disputeUnanswered ? "已提出异议，等反方本轮回应" : undefined}
            onClick={() => onAction("dispute", gap.id)}>
            我有异议
          </Button>
          {canWaive && (
            <Button type="button" size="sm" variant="outline" disabled={busy}
              onClick={() => onAction("waive_p1", gap.id)}>
              接受风险
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={busy || !gap.canOverride}
            title={gap.canOverride ? undefined : "先提异议，等反方回应过一轮才能否决"}
            onClick={() => onAction("override", gap.id)}>
            否决
          </Button>
        </div>
      )}
      {gap.status === "overridden" && (
        <div className="mt-3">
          <Button type="button" size="sm" variant="ghost" disabled={busy}
            onClick={() => onAction("revoke_override", gap.id)}>
            撤销否决
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 重构 spec-battlefield.tsx**

按设计第 5 节的形状改。骨架照抄 `prd-briefing-room.tsx:540-606`（五步导航 + 三块摘要），
把 STEP_LABELS 换成：

```typescript
const STEP_LABELS = [
  { key: "red", label: "红方出招" },
  { key: "blue", label: "反方审查" },
  { key: "human", label: "你的裁决" },
  { key: "report", label: "战报" },
  { key: "approved", label: "通过" },
] as const;
```

三块摘要：待你拍板（Spec 问题卡 open 数 + `canOverride` 的 gap 数）、
阻断（`counts.blockingP0` / `blockingP1`）、战报新鲜度（`reportFresh`）。

主平面依次是：`<QuestionRounds …>`（Spec 的问题卡）、gap 卡列表（`<GapCard>` 单列）。
**「高级详情」折叠区只保留**：回合历史、红方修复声明、反方复核、审计路径。
Requirement Gaps 那一块（`spec-battlefield.tsx:558-586`）整块移出折叠区。

底部四个总开关保持不变，仍走 stage action bar。

- [ ] **Step 5: page.tsx 接回调**

`onAction` 需要理由的三个动作（`supply_fact` / `dispute` / `override`）走
既有的 `ActionReasonDialog`（`page.tsx:1190`），拿到理由后 POST 到
`/api/projects/{id}/changes/{changeId}/spec-battle/decision`，body
`{ action, targetType: "requirement_gap", targetId: gapId, reason }`。
`revoke_override` / `waive_p1` 沿用现有路径。

Spec 问题卡的表态 POST 到新路由
`/api/projects/{id}/changes/{changeId}/spec-battle/questions/{questionId}`，
body `{ action, value }`。

服务层新增 `applySpecQuestionAction`。**不要拷贝 `applyBriefingQuestionAction` 的函数体**：
它与 Spec 版本共用的两块本就已经是可复用的独立件——
`applyQuestionAction`（`prd-briefing-ledger.ts:281`，纯函数，输入
`{action, value}` 返回 `{status, answer}`）与 Task 1 的
`updateBriefingQuestionAnswer`。两个阶段各写一个薄适配器调用这两件即可，
差异部分（权限断言、认证同步、镜像刷新、返回值）本来就不同，无共同体可抽：

```typescript
export async function applySpecQuestionAction(input: {
  changeId: string;
  questionId: string;
  action: "answer" | "accept_assumption" | "defer";
  value: string;
}): Promise<void> {
  getProjectForChange(input.changeId);
  const question = getBriefingQuestion(input.changeId, input.questionId, "Spec");
  if (!question) throw new SpecBattleError("question_not_found");
  const result = applyQuestionAction({ action: input.action, value: input.value });
  updateBriefingQuestionAnswer({
    changeId: input.changeId,
    questionId: input.questionId,
    phase: "Spec",
    status: result.status,
    answer: result.answer,
  });
  refreshMirrors(input.changeId);
}
```

路由文件的 guard / 错误映射结构参照
`app/api/projects/[id]/changes/[changeId]/spec-battle/decision/route.ts`
（同目录，同错误类型），不是参照 PRD 那个。

- [ ] **Step 6: 跑测试与类型检查**

```bash
npx tsc --noEmit
npx tsx scripts/run-tests-isolated.ts "app/projects/[id]/changes/[changeId]/spec-battlefield.test.ts" "app/projects/[id]/changes/[changeId]/phase-review.test.ts"
```

Expected: 类型无错误；测试 PASS，`ℹ fail 0`。

- [ ] **Step 7: 浏览器实测**

用 `preview_start` 起 dev server，进一个处于 Spec 阶段的 change，确认：
gap 卡在主平面可见、四个按钮的可用性与提示符合预期、
问题卡与 PRD 房间长得一样、单列布局、无 console error。

**这一步必须真的做**，不能靠测试通过推断——UI 断言只读源码文本，
证明不了渲染结果。

- [ ] **Step 8: 提交**

```bash
git add "app/projects/[id]/changes/[changeId]" "app/api/projects/[id]/changes/[changeId]/spec-battle"
git commit -m "$(cat <<'EOF'
feat(spec-battle): gap 从「高级详情」升到主平面，界面对齐 PRD 房间

gap 以前被折在附录里，不是排版取舍——是因为你对它无能为力，它只配当附录。
现在每条 gap 都能补充事实、提异议、否决，它就是这个页面的主体。

五步导航、三块摘要、单列卡片流，与 PRD 房间同骨架同组件。
四个总开关降到底部 stage bar：它们仍在，但不再是你唯一能做的事。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: 全量回归与收尾

**Files:** 无新增

- [ ] **Step 1: 全量单元测试**

```bash
npx tsx scripts/run-tests-isolated.ts
```

Expected: `ℹ fail 0`、`ℹ cancelled 0`。
**逐行看这两个计数，不要看 exit code**——全量跑会 exit 0 但藏着失败。

- [ ] **Step 2: 类型与 lint**

```bash
npx tsc --noEmit && npx eslint .
```

Expected: 两者均无输出。

- [ ] **Step 3: 确认写入策略快照是最新的**

```bash
npx tsx scripts/generate-db-write-inventory-snapshot.ts && git diff --stat server/db/db-write-inventory.snapshot.json
```

Expected: 无 diff。若有，说明前面某个任务漏了重算——补一次提交。

- [ ] **Step 4: 反向验证四条关键不变量**

逐条确认（有对应测试的直接指出测试名）：

1. `human_cannot_resolve_gap` 仍然拒绝人工解 gap
   → `spec-battle-service.test.ts` 的 `still refuses to let a human resolve a gap`
2. Spec 的问题卡不影响 PRD gate
   → `prd-briefing-service.test.ts` 的 `a Spec question card does not touch the PRD gate`
3. 否决的 P0 在没有第二把钥匙时仍挡 Merge
   → `spec-battle-rules.test.ts` 的 `still blocks merge until the second key is turned`
4. 没有任何模块绕过访问器直接读 `briefing_questions`
   → `briefing-question-store.test.ts` 的 offender 列表为空

- [ ] **Step 5: 提交收尾**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(spec-battle): 全量回归通过，介入室落地

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review 记录

**Spec 覆盖检查：**

| Spec 章节 | 对应任务 |
|---|---|
| 第 1 节 协议 QUESTION 行 | Task 2、Task 6 |
| 第 1 节 GAP/QUESTION 判据 | Task 6 |
| 第 2 节 `briefing_questions.phase` | Task 1 |
| 第 2 节 「PRD 查询补 phase 过滤」那颗雷 | Task 1（升级为结构性访问器 + 守卫测试）、Task 3 串扰测试 |
| 第 3 节 四个人工动作 | Task 5 |
| 第 3 节 `disputed` 派生不进枚举 | Task 4 |
| 第 3 节 否决解锁条件 | Task 4（纯函数）、Task 5（服务层） |
| 第 3 节 蓝方必须回应异议 | Task 6 |
| 第 4 节 两把钥匙 | Task 4（规则）、Task 7（Merge 侧） |
| 第 5 节 UI | Task 8、Task 9 |
| 第 6 节 测试策略 | 散在各任务；反向断言在 Task 6、Task 8、Task 9 |
| `needs_human_decision` 接线 | Task 3 |

**与 spec 的两处偏离（均为加强，已在对应任务说明理由）：**

1. spec 说「所有既有 `briefingQuestions` 查询都必须补 `phase` 条件」，
   计划改为**收口到强制传 phase 的访问器 + 禁止直接访问的守卫测试**。
   理由：查询点有 6 个且未来还会增加，靠每次记得加条件是纪律约束，
   守卫测试才是结构约束。
2. spec 未提 `spec-battle-service.ts:262` 也读这张表且**喂的是 PRD 的 source
   DB hash**。这是计划期间核实出来的，提高了 Task 1 的优先级与测试要求。

**未在 spec 中、计划新增的一处：** Task 9 Step 7 的浏览器实测。
UI 断言只读源码文本，证明不了渲染结果。
