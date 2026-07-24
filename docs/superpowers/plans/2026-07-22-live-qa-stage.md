# Live QA 阶段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在静态检查(CHECKING)之后插入 Live QA 阶段:AI 通过真实 Chrome 按 usage.md 逐场景实测,后台监控 agent 可叫停,发现问题经人工门控进 Fix 或非破坏回退到 Spec 起点重走。

**Architecture:** 外层 DB 状态机新增 3 个状态承载 Live QA 生命周期;阶段内部用 LangGraph.js 建图编排(interrupt 门控 + SQLite checkpointer 断点续跑),图节点内 spawn Codex/Claude CLI agent 干活;浏览器工具经引擎中立的 stdio MCP server 交付,Chrome 用系统安装版 + CDP 远程调试端口接管。跨进程信号(halt、浏览器端点)走 `.ship/changes/<id>/qa/` 下的文件,**ship.db 的写入永远只发生在 worker/Next 进程内的 store 里**。

**Tech Stack:** Next.js 16 App Router、TypeScript、drizzle-orm + better-sqlite3、node:test、`@langchain/langgraph` ^1.4.8、`@langchain/langgraph-checkpoint-sqlite` ^1.0.3、`@modelcontextprotocol/sdk` ^1.29.0、`playwright-core` ^1.61.1。

**Spec:** `docs/superpowers/specs/2026-07-22-live-qa-stage-design.md`

## 与 Spec 的三处落地偏差(已论证,实施时不要"纠正"回去)

1. **进入 Live QA 走驻留态而非直连**:spec 写 "CHECKING 通过 → LIVE_QA_RUNNING"。本系统没有服务端自动链式调度(下一个 job 一律由 HTTP 路由入队、人按按钮),运行态由 job 的 beginStageRun 原子进入。所以落地为:CHECKING 成功驻留 **LOCAL_READY**(既有等待态,语义正好是"本地检查已过"),人按"运行 Live QA"按钮 → `LOCAL_READY → LIVE_QA_RUNNING`。LOCAL_READY → MERGE_READY 保留,作为跳过 Live QA 的豁免通路。
2. **进 Fix 落地为 `LIVE_QA_BLOCKED → CHECK_FAILED`**:spec 写 "→ FIXING"。FIXING 是运行态,只能由 fix job 从 `FIX_ALLOWED_STATUSES = ["CHECK_FAILED","SCOPE_FAILED"]`(`server/services/pipeline-build-stage-service.ts:692`)原子进入。approve_fix 决策把 change 置 CHECK_FAILED 驻留,复用现有 fix 按钮/job 全链路。
3. **回退目标落地为 `LIVE_QA_BLOCKED → INTAKE_READY`**:spec 写 "→ SPECCING"。同理 SPECCING 是运行态;INTAKE_READY 是"可以(重)跑 Spec"的既有等待态(既有回退边 `SPEC_READY → INTAKE_READY` 就是这么用的)。回退后人按现有"运行 Spec"按钮,四阶段依次重走。
4. **`qa_browser_events` 表取消,动作日志落磁盘 JSONL**:spec 里它是 DB 表。但动作日志的写入方是 MCP server——它是 CLI agent 的子进程,不在 worker 进程内;让第二个进程写 ship.db 违反本仓库单写者纪律(db-write-policy 体系)。落地为 MCP server 写 `.ship/changes/<id>/qa/browser-events.jsonl`,前端经既有 `/file-content` 路由 + `<ProducedFile>` 展示。DB 只加 2 张表:`qa_scenarios`、`stage_rollbacks`。

实施完成后把这 4 条回写进 spec 文档的对应小节(Task 13 收尾步骤)。

## Global Constraints

- **单写者纪律**:ship.db 的一切写入只能发生在 worker/Next 进程内、且收口在 store 文件里;每个写入点必须登记 `server/db/db-write-policy.json` 并重算快照(`npx tsx scripts/generate-db-write-inventory-snapshot.ts`),否则 `db-write-inventory.test.ts` 红。MCP server 进程、monitor agent 进程**禁止** import `server/db`。
- **LangGraph checkpointer 用独立 DB 文件**(`.ship/changes/<id>/qa/graph-checkpoint.db`),绝不指向 ship.db。
- **测试永远走 `npx tsx scripts/run-tests-isolated.ts <文件>`**,禁止裸 `node --test`(会写生产库);判定成功看输出里 `ℹ fail 0` / `ℹ cancelled 0` 计数,不能只看 exit code。
- **新增依赖锁版本**:`@langchain/langgraph@^1.4.8`、`@langchain/langgraph-checkpoint-sqlite@^1.0.3`、`@modelcontextprotocol/sdk@^1.29.0`、`playwright-core@^1.61.1`。不引入 `langchain`/`@langchain/openai`/`@langchain/anthropic` 等模型绑定包。
- **LangGraph 不直调模型 API**:一切 LLM 调用都通过既有 `getPipelineEngine(provider)` spawn CLI。
- **Chrome 独立 profile**:`--user-data-dir` 指向 `.ship/changes/<id>/qa/chrome-profile`,绝不触碰用户日常浏览器数据。
- **枚举模式**:所有枚举改动遵循 `z.enum([...])` + `export type X = z.infer<typeof X>` 既有写法(`server/types/enums.ts`)。
- **生产代码 import 不带 `.ts` 后缀,测试文件 import 带 `.ts` 后缀**(仓库现状,见 `briefing-question-store.ts` 与其测试)。
- **测试代码中的 seed/夹具辅助是示意**:动手前先读目标测试文件既有写法(如 `briefing-question-store.test.ts` 的 `seedChange()`),能复用就复用,不要按字面新建同名函数。
- **浏览器依赖的测试用环境变量门控**:`STAGEPASS_QA_BROWSER_TEST=1` 才跑,默认 skip,保证 CI/无 Chrome 环境全绿。

## File Structure

### 新建

| 文件 | 职责 |
| --- | --- |
| `server/db/migrations/0027_live_qa_stage.sql` | 建 `qa_scenarios`、`stage_rollbacks` 两张表 |
| `server/services/qa-scenario-store.ts` (+`.test.ts`) | qa_scenarios 唯一读写访问器 |
| `server/services/stage-rollback-store.ts` (+`.test.ts`) | stage_rollbacks 唯一读写访问器 |
| `server/services/qa-browser-service.ts` (+`.test.ts`) | 启动/接管 Chrome(CDP),navigate/click/type/read_page/screenshot 封装 |
| `scripts/qa-mcp-server.ts` (+`server/services/qa-mcp-server.test.ts`) | stdio MCP server:浏览器工具 + halt_qa + 日志读取,供两家 CLI 挂载 |
| `server/services/live-qa-graph.ts` (+`.test.ts`) | LangGraph 图定义(节点实现依赖注入,可 mock 单测) |
| `server/services/pipeline-live-qa-stage-service.ts` (+`.test.ts`) | Live QA 阶段服务:环境准备、节点实现、双 agent、状态收尾 |
| `server/services/live-qa-decision-service.ts` (+`.test.ts`) | 人工决策:approve_fix / rollback_to_spec / dismiss / waive |
| `server/templates/prompts/live-qa-scenarios.md` | parse_usage 节点的 prompt 模板 |
| `server/templates/prompts/live-qa-run-scenario.md` | run_scenario 节点的 prompt 模板 |
| `server/templates/prompts/live-qa-monitor.md` | 监控 agent 的 prompt 模板 |
| `server/templates/prompts/live-qa-triage.md` | triage 节点的 prompt 模板 |
| `app/api/projects/[id]/changes/[changeId]/live-qa/route.ts` | POST 入队 run_live_qa / resume_live_qa |
| `app/api/projects/[id]/changes/[changeId]/live-qa/decision/route.ts` | POST 人工决策 |
| `app/api/projects/[id]/changes/[changeId]/live-qa/state/route.ts` | GET 场景清单+发现+回退记录(前端面板数据源) |
| `app/api/projects/[id]/changes/[changeId]/live-qa/focus-browser/route.ts` | POST 唤起 QA Chrome 窗口(macOS) |
| `app/projects/[id]/changes/[changeId]/live-qa-panel.tsx` | Live QA 阶段面板(场景进度、发现、决策按钮、跳转浏览器) |

### 修改

| 文件 | 改动 |
| --- | --- |
| `server/types/enums.ts` | ChangeStatus +3、RunPhase +`live_qa`、ArtifactType +`usage_guide` |
| `server/state-machine/transitions.ts` (+`.test.ts`) | RUNNING 集合 +1、新流转边、测试硬断言同步 |
| `server/db/schema.ts` | 两张新表的 drizzle 定义 |
| `server/db/migrations/meta/_journal.json` | 追加 idx 27 条目 |
| `server/db/migrate.test.ts` | 迁移总数 27→28 |
| `server/db/db-write-policy.json` + 快照 | 新 store 写入点登记 |
| `server/services/ai-engine-types.ts` | `AiRunInput.extraMcpServers`、`AiRunPhase` +`live_qa`/`live_qa_monitor` |
| `server/services/claude-engine.ts` | 两处 argv 构造加 `--mcp-config` + `--allowedTools mcp__<name>` |
| `server/services/codex-cli-engine.ts` | `buildCodexArgs` 加 `-c mcp_servers.*` 覆写 |
| `server/templates/prompts/implement.md` | 追加 usage.md 必交产物要求 |
| `server/services/pipeline-build-stage-service.ts` | build 收尾校验 usage.md 存在;fix prompt 追加 Live QA findings |
| `server/services/pipeline-qa-stage-service.ts` | 静态检查成功 finalStatus `MERGE_READY` → `LOCAL_READY` |
| `server/services/prompt-service.ts` | `PROMPT_TEMPLATE_FILES` 注册 4 个新模板 |
| `server/services/pipeline-job-types.ts` | 注册 `live_qa: ["run_live_qa", "resume_live_qa"]` |
| `server/services/pipeline-job-runner-service.ts` | `PipelineWorkerStageApi` + 路由表接入两个 runner |
| Spec 阶段服务(grep `assemblePrompt("spec"` 定位) | prompt 追加 QA 回退上下文 |
| `app/projects/[id]/changes/[changeId]/pipeline-ui-model.ts` | UiStageId/顺序/定义/三张映射表 +live_qa |
| `app/projects/[id]/changes/[changeId]/page.tsx` | showingLiveQa 分支挂载新面板 |
| `package.json` | 4 个新依赖 |

---

## Task 1: 状态机——3 个新状态与流转边

**为什么第一个做它:** 所有后续任务(job、决策、UI 映射)都以这 3 个状态为词汇表;而且它有两处测试硬断言(RUNNING 全量集合、BLOCKED 恢复列表)不同步就全红,先把地基打平。

**Files:**
- Modify: `server/types/enums.ts:10-40`(ChangeStatus)
- Modify: `server/state-machine/transitions.ts:33-44`(RUNNING_CHANGE_STATUSES)、`:46-99`(ALLOWED_TRANSITIONS)
- Modify: `server/state-machine/transitions.test.ts:54-84`(BLOCKED 恢复列表)、`:86-102`(RUNNING 硬断言)

**Interfaces:**
- Produces: `ChangeStatus` 新成员 `"LIVE_QA_RUNNING" | "LIVE_QA_BLOCKED" | "LIVE_QA_READY"`;新合法边 `LOCAL_READY→LIVE_QA_RUNNING`、`LIVE_QA_RUNNING→{自身, LIVE_QA_BLOCKED, LIVE_QA_READY}`、`LIVE_QA_BLOCKED→{CHECK_FAILED, INTAKE_READY, LIVE_QA_RUNNING, MERGE_READY}`、`LIVE_QA_READY→MERGE_READY`,三者均可 ↔ BLOCKED。

- [ ] **Step 1: 写失败测试**

在 `server/state-machine/transitions.test.ts` 追加两个用例(与现有用例同级):

```typescript
it("routes the live QA loop through its explicit edges", () => {
  assertLegalTransition("LOCAL_READY", "LIVE_QA_RUNNING");
  assertLegalTransition("LIVE_QA_RUNNING", "LIVE_QA_RUNNING");
  assertLegalTransition("LIVE_QA_RUNNING", "LIVE_QA_BLOCKED");
  assertLegalTransition("LIVE_QA_RUNNING", "LIVE_QA_READY");
  assertLegalTransition("LIVE_QA_BLOCKED", "CHECK_FAILED");
  assertLegalTransition("LIVE_QA_BLOCKED", "INTAKE_READY");
  assertLegalTransition("LIVE_QA_BLOCKED", "LIVE_QA_RUNNING");
  assertLegalTransition("LIVE_QA_BLOCKED", "MERGE_READY");
  assertLegalTransition("LIVE_QA_READY", "MERGE_READY");
});

it("forbids live QA from skipping its waiting-state entry points", () => {
  // 回退只许回 Spec 起点的等待态,不许直插运行态或中间阶段
  assert.throws(() => assertLegalTransition("LIVE_QA_BLOCKED", "SPECCING"), IllegalTransitionError);
  assert.throws(() => assertLegalTransition("LIVE_QA_BLOCKED", "PLANNING"), IllegalTransitionError);
  assert.throws(() => assertLegalTransition("LIVE_QA_BLOCKED", "FIXING"), IllegalTransitionError);
  // 运行态不许绕过 READY/BLOCKED 直达 MERGE_READY
  assert.throws(() => assertLegalTransition("LIVE_QA_RUNNING", "MERGE_READY"), IllegalTransitionError);
});
```

同一步同步两处硬断言(它们描述的是"全量集合",加状态属于其定义变更,不是事后修补):

`transitions.test.ts:86-102` 的 RUNNING 全量断言,期望数组改为(按字典序,`LIVE_QA_RUNNING` 排在 `IMPLEMENTING` 与 `MERGING` 之间):

```typescript
    [
      "CHECKING",
      "FIXING",
      "IMPLEMENTING",
      "LIVE_QA_RUNNING",
      "MERGING",
      "PLANNING",
      "RETRO_PENDING",
      "REVIEWING",
      "SPECCING",
      "TECHSPECCING",
      "TESTPLANNING",
    ],
```

`transitions.test.ts:54-84` 的 BLOCKED 恢复列表(`prdSuspendableStatuses` 一类的硬编码数组)追加 `"LIVE_QA_RUNNING", "LIVE_QA_BLOCKED", "LIVE_QA_READY"` 三项。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx tsx scripts/run-tests-isolated.ts server/state-machine/transitions.test.ts
```

Expected: FAIL——新用例抛 zod/类型错误或 `IllegalTransitionError`(状态尚不存在),RUNNING 全量断言 deepEqual 不匹配。

- [ ] **Step 3: 加枚举成员**

`server/types/enums.ts` 的 ChangeStatus 数组,在 `"LOCAL_READY",` 之后插入:

```typescript
  // Live QA: browser-based, usage-guide-driven testing. RUNNING is a running
  // status (LangGraph job in flight). BLOCKED and READY are WAITING statuses:
  // the change is parked for a human decision (BLOCKED) or for the human to
  // advance to MERGE_READY (READY). See RUNNING_CHANGE_STATUSES.
  "LIVE_QA_RUNNING",
  "LIVE_QA_BLOCKED",
  "LIVE_QA_READY",
```

- [ ] **Step 4: 加流转边**

`server/state-machine/transitions.ts`:

RUNNING_CHANGE_STATUSES 追加(仅 RUNNING,另两个是等待态,刻意不进——参照文件头 DELIVERY_PENDING 注释的先例):

```typescript
  "LIVE_QA_RUNNING",
```

ALLOWED_TRANSITIONS:把 `LOCAL_READY` 行替换为:

```typescript
  ["LOCAL_READY", new Set(["MERGE_READY", "LIVE_QA_RUNNING", "BLOCKED"])],
```

在其后插入三行:

```typescript
  ["LIVE_QA_RUNNING", new Set(["LIVE_QA_RUNNING", "LIVE_QA_BLOCKED", "LIVE_QA_READY", "BLOCKED"])],
  ["LIVE_QA_BLOCKED", new Set(["CHECK_FAILED", "INTAKE_READY", "LIVE_QA_RUNNING", "MERGE_READY", "BLOCKED"])],
  ["LIVE_QA_READY", new Set(["MERGE_READY", "BLOCKED"])],
```

`BLOCKED` 的出边 Set 里追加 `"LIVE_QA_RUNNING", "LIVE_QA_BLOCKED", "LIVE_QA_READY",`。

各边语义:`LIVE_QA_RUNNING→自身` 供续测/重跑;`→CHECK_FAILED` 是 approve_fix 决策(驻留,复用现有 fix 链路);`→INTAKE_READY` 是 rollback_to_spec(非破坏,重走四阶段);`→LIVE_QA_RUNNING` 是 dismiss 误报续测;`→MERGE_READY` 是 waive 豁免。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx tsx scripts/run-tests-isolated.ts server/state-machine/transitions.test.ts
```

Expected: PASS,输出含 `ℹ fail 0`。再跑全量确认无涟漪:

```bash
pnpm test
```

Expected: `ℹ fail 0`(若有别处硬编码状态全集的测试红了,按同样逻辑补三个新状态,不改语义)。

- [ ] **Step 6: Commit**

```bash
git add server/types/enums.ts server/state-machine/transitions.ts server/state-machine/transitions.test.ts
git commit -m "feat(live-qa): 状态机新增 LIVE_QA_RUNNING/BLOCKED/READY 与流转边"
```

## Task 2: 迁移 0027——qa_scenarios 与 stage_rollbacks

**为什么这样切:** 表结构是场景恢复与非破坏回退的持久层地基;迁移体系有三处强制断言(journal 驱动、总数硬编码、幂等),一次做对。

**Files:**
- Create: `server/db/migrations/0027_live_qa_stage.sql`
- Modify: `server/db/migrations/meta/_journal.json`
- Modify: `server/db/schema.ts`(在 `briefingQuestions` 定义之后追加)
- Modify: `server/db/migrate.test.ts:437-450`(迁移总数)
- Modify: `server/services/db-migrations.test.ts`(新表列存在性用例)

**Interfaces:**
- Produces: drizzle 导出 `qaScenarios`、`stageRollbacks`;SQL 表 `qa_scenarios`、`stage_rollbacks`。

- [ ] **Step 1: 写迁移 SQL**

Create `server/db/migrations/0027_live_qa_stage.sql`:

```sql
CREATE TABLE `qa_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`source_anchor` text NOT NULL,
	`title` text NOT NULL,
	`steps_summary` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`attempt` integer NOT NULL DEFAULT 0,
	`last_run_id` text,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_qa_scenarios_change_status` ON `qa_scenarios` (`change_id`, `status`);
--> statement-breakpoint
CREATE TABLE `stage_rollbacks` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`decision_id` text,
	`verdict` text NOT NULL,
	`evidence_path` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`),
	FOREIGN KEY (`decision_id`) REFERENCES `human_decisions`(`id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_stage_rollbacks_change` ON `stage_rollbacks` (`change_id`, `created_at`);
```

(先对照仓库里既有 CREATE TABLE 迁移的外键写法;若旧例把 FOREIGN KEY 写成列内 `REFERENCES`,跟旧例。)

`server/db/migrations/meta/_journal.json` 的 `entries` 末尾追加(前一条 0026 结尾补逗号):

```json
    {
      "idx": 27,
      "version": "7",
      "when": 1784678400000,
      "tag": "0027_live_qa_stage",
      "breakpoints": true
    }
```

- [ ] **Step 2: 更新迁移总数断言并确认失败→通过**

`server/db/migrate.test.ts:437-450` 幂等用例:`assert.equal(migrationRows.length, 27)` 改为 `28`,注释同步为 `// 28 with 0027_live_qa_stage. ...`。

先跑一次确认此刻(未加 journal 时应已加)整体自洽:

```bash
npx tsx scripts/run-tests-isolated.ts server/db/migrate.test.ts
```

Expected: PASS(`ℹ fail 0`)。若 FAIL 提示找不到 `0027_live_qa_stage.sql` 或数目不符,说明 journal/SQL 文件/断言三者没对齐。

- [ ] **Step 3: 写 drizzle 定义(先写 db-migrations 失败测试)**

在 `server/services/db-migrations.test.ts` 追加(参照该文件 11-24 行 fresh-DB 用例的既有写法):

```typescript
it("creates live QA tables with expected columns", () => {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  const scenarioCols = sqlite.prepare("PRAGMA table_info(qa_scenarios)").all()
    .map((c: { name: string }) => c.name);
  assert.deepEqual(
    scenarioCols,
    ["id", "change_id", "source_anchor", "title", "steps_summary", "status",
     "attempt", "last_run_id", "failure_reason", "created_at", "updated_at"],
  );
  const rollbackCols = sqlite.prepare("PRAGMA table_info(stage_rollbacks)").all()
    .map((c: { name: string }) => c.name);
  assert.deepEqual(
    rollbackCols,
    ["id", "change_id", "from_status", "to_status", "decision_id", "verdict",
     "evidence_path", "created_at"],
  );
});
```

```bash
npx tsx scripts/run-tests-isolated.ts server/services/db-migrations.test.ts
```

Expected: PASS(迁移已在 Step 1 落地;此用例锁死列集合防漂移)。

`server/db/schema.ts` 在 `briefingQuestions` 之后追加:

```typescript
export const qaScenarios = sqliteTable(
  "qa_scenarios",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    /**
     * usage.md 章节锚点。场景必须能溯源到使用说明的具体章节;没有锚点的
     * 场景不合法——这是 "QA 只按使用说明测、不许自行发明场景" 的持久层约束。
     */
    sourceAnchor: text("source_anchor").notNull(),
    title: text("title").notNull(),
    stepsSummary: text("steps_summary").notNull(),
    /** pending | passed | failed | blocked | skipped(枚举收口在 qa-scenario-store) */
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    lastRunId: text("last_run_id"),
    failureReason: text("failure_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_qa_scenarios_change_status").on(table.changeId, table.status)],
);

export const stageRollbacks = sqliteTable(
  "stage_rollbacks",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    /** 触发本次回退的人工决策(human_decisions.id),非破坏回退的审计锚点 */
    decisionId: text("decision_id").references(() => humanDecisions.id),
    /** triage 的判定摘要(为什么要回退) */
    verdict: text("verdict").notNull(),
    /** 证据文件相对路径(.ship 下的 triage.md / findings.json) */
    evidencePath: text("evidence_path"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_stage_rollbacks_change").on(table.changeId, table.createdAt)],
);
```

- [ ] **Step 4: 全量测试 + Commit**

```bash
pnpm test
```

Expected: `ℹ fail 0`。注意 `db-write-inventory.test.ts` 此刻应仍绿(还没有写入点)。

```bash
git add server/db/migrations/0027_live_qa_stage.sql server/db/migrations/meta/_journal.json server/db/schema.ts server/db/migrate.test.ts server/services/db-migrations.test.ts
git commit -m "feat(live-qa): qa_scenarios 与 stage_rollbacks 表及迁移 0027"
```

---

## Task 3: 两个 store——qa-scenario-store 与 stage-rollback-store

**为什么这样切:** 单写者纪律要求每张表有唯一访问器;后续阶段服务、决策服务、API 全部只碰 store,不直碰 drizzle。照 `server/services/briefing-question-store.ts` 的依赖注入模式。

**Files:**
- Create: `server/services/qa-scenario-store.ts`、`server/services/qa-scenario-store.test.ts`
- Create: `server/services/stage-rollback-store.ts`、`server/services/stage-rollback-store.test.ts`
- Modify: `server/db/db-write-policy.json`(productionEntries + testFixtures)
- Regenerate: `server/db/db-write-inventory.snapshot.json`

**Interfaces:**
- Produces:
  - `QaScenarioRow`、`QaScenarioStatus = "pending" | "passed" | "failed" | "blocked" | "skipped"`
  - `listQaScenarios(changeId): QaScenarioRow[]`(按 id 升序)
  - `insertQaScenariosWithDb(connection, rows: NewQaScenario[]): void`
  - `markQaScenario(input: { scenarioId: string; status: QaScenarioStatus; failureReason?: string | null; lastRunId?: string | null }): void`(attempt 自增)
  - `resetQaScenariosForRetest(changeId): void`(failed/blocked → pending,供 Fix 后续测)
  - `skipAllQaScenarios(changeId): void`(全部 → skipped,供大回退作废旧场景但保留审计)
  - `StageRollbackRow`、`insertStageRollback(input): StageRollbackRow`、`listStageRollbacks(changeId): StageRollbackRow[]`

- [ ] **Step 1: 写失败测试(qa-scenario-store)**

Create `server/services/qa-scenario-store.test.ts`(seed 夹具先读 `briefing-question-store.test.ts:25-62` 的 `seedChange()` 照抄结构):

```typescript
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db/index.ts";
import { qaScenarios } from "../db/schema.ts";
import {
  insertQaScenariosWithDb,
  listQaScenarios,
  markQaScenario,
  resetQaScenariosForRetest,
} from "./qa-scenario-store.ts";

// seedChange()/cleanupRows() 参照 briefing-question-store.test.ts 既有写法复制适配

describe("qa-scenario-store", { concurrency: false }, () => {
  it("inserts scenarios as pending and lists them in id order", () => {
    const changeId = seedChange();
    db.transaction((tx) => {
      insertQaScenariosWithDb(tx, [
        { id: "QAS-2", changeId, sourceAnchor: "usage.md#login", title: "登录", stepsSummary: "打开首页→点登录" },
        { id: "QAS-1", changeId, sourceAnchor: "usage.md#setup", title: "启动", stepsSummary: "pnpm dev→打开 3000" },
      ]);
    });
    const rows = listQaScenarios(changeId);
    assert.deepEqual(rows.map((r) => r.id), ["QAS-1", "QAS-2"]);
    assert.ok(rows.every((r) => r.status === "pending" && r.attempt === 0));
  });

  it("marks status with attempt increment and resets only failed/blocked for retest", () => {
    const changeId = seedChange();
    db.transaction((tx) => {
      insertQaScenariosWithDb(tx, [
        { id: "QAS-a", changeId, sourceAnchor: "usage.md#a", title: "A", stepsSummary: "..." },
        { id: "QAS-b", changeId, sourceAnchor: "usage.md#b", title: "B", stepsSummary: "..." },
      ]);
    });
    markQaScenario({ scenarioId: "QAS-a", status: "passed", lastRunId: null });
    markQaScenario({ scenarioId: "QAS-b", status: "failed", failureReason: "按钮不存在" });
    resetQaScenariosForRetest(changeId);
    const byId = new Map(listQaScenarios(changeId).map((r) => [r.id, r]));
    assert.equal(byId.get("QAS-a")!.status, "passed");   // 已过场景不重测
    assert.equal(byId.get("QAS-b")!.status, "pending");  // 失败场景回 pending
    assert.equal(byId.get("QAS-b")!.attempt, 1);
  });
});
```

```bash
npx tsx scripts/run-tests-isolated.ts server/services/qa-scenario-store.test.ts
```

Expected: FAIL — `Cannot find module './qa-scenario-store.ts'`。

- [ ] **Step 2: 实现 qa-scenario-store**

Create `server/services/qa-scenario-store.ts`:

```typescript
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { qaScenarios } from "../db/schema";

export type QaScenarioRow = typeof qaScenarios.$inferSelect;
export type QaScenarioStatus = "pending" | "passed" | "failed" | "blocked" | "skipped";
export type NewQaScenario = Omit<
  typeof qaScenarios.$inferInsert,
  "createdAt" | "updatedAt" | "status" | "attempt" | "lastRunId" | "failureReason"
>;

type ReadConnection = Pick<typeof db, "select">;
type WriteConnection = Pick<typeof db, "insert">;

export function listQaScenariosWithDb(connection: ReadConnection, changeId: string): QaScenarioRow[] {
  return connection
    .select()
    .from(qaScenarios)
    .where(eq(qaScenarios.changeId, changeId))
    .orderBy(asc(qaScenarios.id))
    .all();
}

export function listQaScenarios(changeId: string): QaScenarioRow[] {
  return listQaScenariosWithDb(db, changeId);
}

export function insertQaScenariosWithDb(connection: WriteConnection, rows: NewQaScenario[]): void {
  const now = new Date().toISOString();
  for (const row of rows) {
    connection
      .insert(qaScenarios)
      .values({ ...row, status: "pending", attempt: 0, createdAt: now, updatedAt: now })
      .run();
  }
}

export function markQaScenario(input: {
  scenarioId: string;
  status: QaScenarioStatus;
  failureReason?: string | null;
  lastRunId?: string | null;
}): void {
  db.update(qaScenarios)
    .set({
      status: input.status,
      failureReason: input.failureReason ?? null,
      lastRunId: input.lastRunId ?? null,
      attempt: sql`${qaScenarios.attempt} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(qaScenarios.id, input.scenarioId))
    .run();
}

/** Fix 修完回 QA:失败/被阻断的场景回 pending 续测;passed 不动。 */
export function resetQaScenariosForRetest(changeId: string): void {
  db.update(qaScenarios)
    .set({ status: "pending", failureReason: null, updatedAt: new Date().toISOString() })
    .where(and(eq(qaScenarios.changeId, changeId), inArray(qaScenarios.status, ["failed", "blocked"])))
    .run();
}

/** 大回退(回 Spec):usage.md 将重写,旧场景整体作废但保留供审计。 */
export function skipAllQaScenarios(changeId: string): void {
  db.update(qaScenarios)
    .set({ status: "skipped", updatedAt: new Date().toISOString() })
    .where(eq(qaScenarios.changeId, changeId))
    .run();
}
```

- [ ] **Step 3: stage-rollback-store(测试先行,同一节奏)**

Create `server/services/stage-rollback-store.test.ts`(结构同上,用例两条):insert 后 list 按 createdAt 升序返回、字段原样回读;`decisionId` 可空。

Create `server/services/stage-rollback-store.ts`:

```typescript
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { stageRollbacks } from "../db/schema";

export type StageRollbackRow = typeof stageRollbacks.$inferSelect;
export type NewStageRollback = Omit<typeof stageRollbacks.$inferInsert, "createdAt">;

type ReadConnection = Pick<typeof db, "select">;
type WriteConnection = Pick<typeof db, "insert">;

export function listStageRollbacksWithDb(connection: ReadConnection, changeId: string): StageRollbackRow[] {
  return connection
    .select()
    .from(stageRollbacks)
    .where(eq(stageRollbacks.changeId, changeId))
    .orderBy(asc(stageRollbacks.createdAt), asc(stageRollbacks.id))
    .all();
}

export function listStageRollbacks(changeId: string): StageRollbackRow[] {
  return listStageRollbacksWithDb(db, changeId);
}

export function insertStageRollbackWithDb(connection: WriteConnection, row: NewStageRollback): void {
  connection
    .insert(stageRollbacks)
    .values({ ...row, createdAt: new Date().toISOString() })
    .run();
}

export function insertStageRollback(row: NewStageRollback): void {
  insertStageRollbackWithDb(db, row);
}
```

- [ ] **Step 4: 登记 db-write-policy 并重算快照**

`server/db/db-write-policy.json` 的 `productionEntries` 追加(格式对照既有 briefing 条目,`table` 用 drizzle camelCase 变量名):

```json
    {
      "file": "server/services/qa-scenario-store.ts",
      "symbol": "connection.insert",
      "nodeKind": "CallExpression",
      "table": "qaScenarios",
      "owner": "live-qa",
      "reason": "Live QA 场景清单由 parse_usage 节点解析 usage.md 后在此批量落库,是本表唯一插入口"
    },
    {
      "file": "server/services/qa-scenario-store.ts",
      "symbol": "db.update",
      "nodeKind": "CallExpression",
      "table": "qaScenarios",
      "owner": "live-qa",
      "reason": "场景 pass/fail 标记与 Fix 后回 pending 续测都收口在此,保证场景恢复语义单点可审"
    },
    {
      "file": "server/services/stage-rollback-store.ts",
      "symbol": "connection.insert",
      "nodeKind": "CallExpression",
      "table": "stageRollbacks",
      "owner": "live-qa",
      "reason": "非破坏回退的审计记录唯一插入口;回退不删产物,凭这张表追溯每次回退的判定与证据"
    },
```

`testFixtures` 追加两条(`mode: "suite-env"`,reason 同 briefing 既有条目风格)。然后:

```bash
npx tsx scripts/generate-db-write-inventory-snapshot.ts
```

- [ ] **Step 5: 跑测试 + Commit**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/qa-scenario-store.test.ts server/services/stage-rollback-store.test.ts server/db/db-write-inventory.test.ts
```

Expected: PASS(`ℹ fail 0`)。

```bash
git add server/services/qa-scenario-store.ts server/services/qa-scenario-store.test.ts server/services/stage-rollback-store.ts server/services/stage-rollback-store.test.ts server/db/db-write-policy.json server/db/db-write-inventory.snapshot.json
git commit -m "feat(live-qa): 场景与回退记录 store,写入点登记"
```

## Task 4: usage.md——Build 阶段必交的使用说明产物

**为什么在这:** usage.md 是 QA 的唯一剧本,必须在 Live QA 之前由 Build 产出并强制校验;它不依赖后面任何浏览器/图设施,可独立落地。

**Files:**
- Modify: `server/types/enums.ts:106-141`(ArtifactType 加 `"usage_guide"`)
- Modify: `server/templates/prompts/implement.md`(追加产物要求;注意 `server/services/prompt-service.ts:165-170` 对 implement 强制走内置模板,改这里即全局生效)
- Modify: `server/services/pipeline-build-stage-service.ts`(build 收尾校验)
- Test: `server/services/pipeline-build-stage-service.test.ts`(若无此文件,校验函数单独放进新文件 `server/services/usage-guide-service.ts` + `.test.ts`,便于独立测试——推荐这条路)

**Interfaces:**
- Produces: `usageGuidePath(repoPath, changeId): string`(= `changeArtifactDir(repoPath, changeId)/usage.md`);`assertUsageGuidePresent(repoPath, changeId): void`(缺失/空文件抛 `UsageGuideMissingError`)。
- Consumes: `changeArtifactDir`(`server/services/phase-artifact-service.ts:117-119`)。

- [ ] **Step 1: 写失败测试**

Create `server/services/usage-guide-service.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertUsageGuidePresent, usageGuidePath, UsageGuideMissingError } from "./usage-guide-service.ts";

describe("usage-guide-service", () => {
  it("throws when usage.md is missing or blank, passes when present", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "usage-guide-"));
    assert.throws(() => assertUsageGuidePresent(repo, "CHG-1"), UsageGuideMissingError);

    const p = usageGuidePath(repo, "CHG-1");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "   \n");
    assert.throws(() => assertUsageGuidePresent(repo, "CHG-1"), UsageGuideMissingError);

    fs.writeFileSync(p, "# 使用说明\n\n## HOW_TO_RUN\n\n```bash\npnpm dev\n```\n");
    assert.doesNotThrow(() => assertUsageGuidePresent(repo, "CHG-1"));
  });
});
```

```bash
npx tsx scripts/run-tests-isolated.ts server/services/usage-guide-service.test.ts
```

Expected: FAIL — `Cannot find module './usage-guide-service.ts'`。

- [ ] **Step 2: 实现**

Create `server/services/usage-guide-service.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { changeArtifactDir } from "./phase-artifact-service";

export class UsageGuideMissingError extends Error {
  constructor(p: string) {
    super(`usage guide missing or empty: ${p}. Build must produce .ship/changes/<id>/usage.md`);
    this.name = "UsageGuideMissingError";
  }
}

export function usageGuidePath(repoPath: string, changeId: string): string {
  return path.join(changeArtifactDir(repoPath, changeId), "usage.md");
}

export function assertUsageGuidePresent(repoPath: string, changeId: string): void {
  const p = usageGuidePath(repoPath, changeId);
  if (!fs.existsSync(p) || fs.readFileSync(p, "utf8").trim() === "") {
    throw new UsageGuideMissingError(p);
  }
}

export function readUsageGuide(repoPath: string, changeId: string): string {
  assertUsageGuidePresent(repoPath, changeId);
  return fs.readFileSync(usageGuidePath(repoPath, changeId), "utf8");
}
```

`server/types/enums.ts` ArtifactType 数组 `"delivery",` 之后追加 `"usage_guide",`。

- [ ] **Step 3: prompt 模板追加要求**

`server/templates/prompts/implement.md` 末尾追加(变量替换语法与该文件既有 `{changeId}` 用法一致,动手前确认该模板里既有占位符写法):

```markdown
## 必交产物:使用说明(usage.md)

实现完成后,必须写出 `.ship/changes/{changeId}/usage.md`,这是后续 Live QA 阶段照着实测的唯一剧本。缺失则本阶段不通过。结构:

# 使用说明

## HOW_TO_RUN
启动本项目的精确命令(bash 代码块),入口 URL,就绪判定(看到什么算启动成功)。

## 功能操作
本次变更涉及的每个功能一节,标题即功能名。每节必须包含:
- **入口**:从哪个页面/哪个 UI 元素进入
- **操作步骤**:用户视角逐步点什么、输入什么
- **预期结果**:每步之后应该看到什么

只写用户能在界面上做到的事,不写内部实现。步骤必须具体到可盲操作(按钮文案、位置)。
```

- [ ] **Step 4: build 收尾接入校验**

`server/services/pipeline-build-stage-service.ts`:在 build 成功收集产物之后(`collectBuildResult` 调用返回处,约 486-506 行,implement 与 fix 两条路径都要)加:

```typescript
import { assertUsageGuidePresent, UsageGuideMissingError } from "./usage-guide-service";
// collectBuildResult 成功分支内:
try {
  assertUsageGuidePresent(project.repoPath, changeId);
} catch (err) {
  if (err instanceof UsageGuideMissingError) {
    // 与 "Build workspace produced no changes" 同一处理路径:置失败并带 blocker
    // (先读 collectBuildResult 的失败分支 build-workspace-service.ts:714-724 怎么写 blockers,照同样方式落一条)
  } else {
    throw err;
  }
}
```

注意:usage.md 写在 `.ship/changes/<id>/`(主 repo),而 implement agent 工作目录是 workspace(`buildRun.workspacePath`)。确认 implement 模板变量 `{changeId}` 展开后 agent 能写到主 repo 的 `.ship` 路径;若 workspace 是隔离副本,则校验点改为收集产物时从 workspace 同步 usage.md 到主 repo `.ship`(参照 diff/patch 的既有同步方式),再断言主 repo 侧存在。**这一点动手时必须实际验证,不许想当然。**

- [ ] **Step 5: 跑测试 + Commit**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/usage-guide-service.test.ts
pnpm test
```

Expected: 均 `ℹ fail 0`。

```bash
git add server/types/enums.ts server/templates/prompts/implement.md server/services/usage-guide-service.ts server/services/usage-guide-service.test.ts server/services/pipeline-build-stage-service.ts
git commit -m "feat(live-qa): usage.md 成为 Build 必交产物,QA 的唯一剧本"
```

---

## Task 5: 引擎双适配——extraMcpServers 与 live_qa run phase

**为什么这样切:** 浏览器工具经 MCP 交付是引擎中立设计的关键;两个引擎的 argv 构造都是纯函数,可无副作用单测。

**Files:**
- Modify: `server/services/ai-engine-types.ts:12-32`(AiRunPhase)、`:66-78`(AiRunInput)
- Modify: `server/services/claude-engine.ts:189-212`(runClaudeSdk argv)、`:764-782`(runStreamed argv)
- Modify: `server/services/codex-cli-engine.ts:175-202`(buildCodexArgs)
- Test: 先找既有 `codex-cli-engine.test.ts` / `claude-engine.test.ts`(`ls server/services/*engine*.test.ts`),有则追加用例,无则新建,只测 argv 纯函数。

**Interfaces:**
- Produces:
  ```typescript
  export interface AiMcpServerSpec {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }
  // AiRunInput 新增可选字段:
  extraMcpServers?: Record<string, AiMcpServerSpec>;
  // AiRunPhase 新增成员:"live_qa" | "live_qa_monitor"
  ```
- Consumes: 无(纯类型+argv)。

- [ ] **Step 1: 类型**

`ai-engine-types.ts`:AiRunPhase 联合加 `"live_qa"`、`"live_qa_monitor"`;`AiRunInput` 加 `extraMcpServers?: Record<string, AiMcpServerSpec>;` 并导出 `AiMcpServerSpec`(如上)。

- [ ] **Step 2: 写失败测试(codex argv)**

在 codex 引擎测试文件追加:

```typescript
it("injects mcp server config via -c overrides in both exec and resume forms", () => {
  const mcp = { stagepass_qa: { command: "npx", args: ["tsx", "scripts/qa-mcp-server.ts"], env: { STAGEPASS_QA_STATE_DIR: "/tmp/qa" } } };
  const fresh = buildCodexArgs({ sandboxMode: "workspace-write", repoPath: "/repo", mcpServers: mcp });
  const joined = fresh.join(" ");
  assert.ok(joined.includes(`-c mcp_servers.stagepass_qa.command="npx"`));
  assert.ok(joined.includes(`-c mcp_servers.stagepass_qa.args=["tsx","scripts/qa-mcp-server.ts"]`));
  assert.ok(joined.includes(`-c mcp_servers.stagepass_qa.env={"STAGEPASS_QA_STATE_DIR":"/tmp/qa"}`));

  const resume = buildCodexArgs({ threadId: "T-1", sandboxMode: "read-only", mcpServers: mcp });
  assert.ok(resume.join(" ").includes("mcp_servers.stagepass_qa.command"));
});
```

(断言的精确格式以实现为准调整;关键不变量:`-c` 与 `mcp_servers.<name>.command/args/env` 成对出现、fresh 和 resume 两种形态都有。)

Expected: FAIL — `mcpServers` 不在 `BuildCodexArgsInput` 上。

- [ ] **Step 3: 实现 codex 侧**

`buildCodexArgs`:`BuildCodexArgsInput` 加 `mcpServers?: Record<string, AiMcpServerSpec>`;在 `args.push("--json")` 之后插入(fresh/resume 都走到,`-c` 是全局配置覆写,resume 下同样合法——这一点在本地用 `codex exec resume --help` 复核):

```typescript
  for (const [name, spec] of Object.entries(input.mcpServers ?? {})) {
    args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(spec.command)}`);
    args.push("-c", `mcp_servers.${name}.args=${JSON.stringify(spec.args)}`);
    if (spec.env) {
      args.push("-c", `mcp_servers.${name}.env=${JSON.stringify(spec.env)}`);
    }
  }
```

`spawnAndCollect`(704 行起)与 `runStreamed`(916 行起)里构造 `buildCodexArgs` 输入处透传 `mcpServers: input.extraMcpServers`。

- [ ] **Step 4: claude 侧(同样测试先行)**

测试断言:给定 `extraMcpServers`,argv 含 `--mcp-config` 且其 JSON 参数 parse 后等于 `{ mcpServers: {...} }`,并含 `--allowedTools mcp__stagepass_qa`。

实现:`claude-engine.ts` 两处 argv 构造(189-212、764-782)各加:

```typescript
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    args.push("--mcp-config", JSON.stringify({ mcpServers: options.mcpServers }));
    for (const name of Object.keys(options.mcpServers)) {
      args.push("--allowedTools", `mcp__${name}`);
    }
  }
```

(`--allowedTools mcp__<serverName>` 放行该 server 全部工具;`--mcp-config` 接受内联 JSON 字符串。两处 options 类型与 run/runStreamed 的输入映射里都要把 `input.extraMcpServers` 传到 `options.mcpServers`。)

- [ ] **Step 5: 跑测试 + Commit**

```bash
npx tsx scripts/run-tests-isolated.ts <两个引擎测试文件>
pnpm test
```

Expected: `ℹ fail 0`。

```bash
git add server/services/ai-engine-types.ts server/services/claude-engine.ts server/services/codex-cli-engine.ts <测试文件>
git commit -m "feat(live-qa): 两个 CLI 引擎支持按次挂载 stdio MCP server"
```

## Task 6: qa-browser-service——Chrome CDP 启动与工具封装

**为什么这样切:** 浏览器层是纯基础设施,与 pipeline 零耦合,先立起来并用 fixture 页面自测,后面 MCP server 只是薄壳。

**Files:**
- Create: `server/services/qa-browser-service.ts`、`server/services/qa-browser-service.test.ts`
- Create: `server/services/__fixtures__/qa-browser-fixture.html`
- Modify: `package.json`(`playwright-core`)

**Interfaces:**
- Produces:
  ```typescript
  export interface QaChromeLaunch { pid: number; cdpEndpoint: string; port: number }
  export function launchQaChrome(opts: { userDataDir: string; port?: number; chromeBin?: string; startUrl?: string }): Promise<QaChromeLaunch>
  export interface QaBrowserSession { close(): Promise<void>; /* 内部持有 browser+page+console 缓冲 */ }
  export function connectQaBrowser(cdpEndpoint: string): Promise<QaBrowserSession>
  export function qaNavigate(s, url: string): Promise<string>          // 返回落地 URL+title 描述
  export function qaClick(s, target: string): Promise<string>          // target: 可见文本或 CSS selector
  export function qaType(s, target: string, text: string): Promise<string>
  export function qaReadPage(s): Promise<string>                        // a11y 快照文本(role/name 树)
  export function qaScreenshot(s, filePath: string): Promise<string>    // 落盘并返回路径
  export function qaConsoleErrors(s): string[]                          // 自连接起累积的 pageerror/console.error
  ```

- [ ] **Step 1: 装依赖**

```bash
pnpm add playwright-core@^1.61.1
```

(`playwright-core` 不带浏览器下载,恰好符合"用系统 Chrome"的设计。)

- [ ] **Step 2: 写 fixture 与失败测试**

Create `server/services/__fixtures__/qa-browser-fixture.html`:

```html
<!DOCTYPE html>
<html><head><title>QA Fixture</title></head>
<body>
  <h1>fixture-home</h1>
  <button id="go" onclick="document.getElementById('out').textContent='clicked-ok'">开始测试</button>
  <input id="name" placeholder="你的名字" />
  <div id="out"></div>
  <script>console.error("fixture-console-error");</script>
</body></html>
```

Create `server/services/qa-browser-service.test.ts`(整体 env 门控:无 `STAGEPASS_QA_BROWSER_TEST=1` 时 `it.skip`,保证默认套件不依赖 Chrome):

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  launchQaChrome, connectQaBrowser,
  qaNavigate, qaClick, qaType, qaReadPage, qaScreenshot, qaConsoleErrors,
} from "./qa-browser-service.ts";

const enabled = process.env.STAGEPASS_QA_BROWSER_TEST === "1";

describe("qa-browser-service", { concurrency: false }, () => {
  it("drives a real Chrome over CDP against the fixture page", { skip: !enabled }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-chrome-"));
    const launch = await launchQaChrome({ userDataDir: path.join(dir, "profile") });
    const session = await connectQaBrowser(launch.cdpEndpoint);
    try {
      const fixture = pathToFileURL(path.join(__dirname, "__fixtures__", "qa-browser-fixture.html")).href;
      await qaNavigate(session, fixture);
      const page1 = await qaReadPage(session);
      assert.ok(page1.includes("fixture-home"));
      await qaType(session, "#name", "张三");
      await qaClick(session, "开始测试");
      const page2 = await qaReadPage(session);
      assert.ok(page2.includes("clicked-ok"));
      const shot = path.join(dir, "shot.png");
      await qaScreenshot(session, shot);
      assert.ok(fs.existsSync(shot));
      assert.ok(qaConsoleErrors(session).some((e) => e.includes("fixture-console-error")));
    } finally {
      await session.close();
      process.kill(launch.pid, "SIGTERM");
    }
  });
});
```

```bash
STAGEPASS_QA_BROWSER_TEST=1 npx tsx scripts/run-tests-isolated.ts server/services/qa-browser-service.test.ts
```

Expected: FAIL — `Cannot find module './qa-browser-service.ts'`。

- [ ] **Step 3: 实现**

Create `server/services/qa-browser-service.ts`:

```typescript
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";

const DARWIN_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_PORT = 9223; // 避开常见的 9222,减少与用户手头调试实例撞车

export interface QaChromeLaunch { pid: number; cdpEndpoint: string; port: number }

export async function launchQaChrome(opts: {
  userDataDir: string; port?: number; chromeBin?: string; startUrl?: string;
}): Promise<QaChromeLaunch> {
  const port = opts.port ?? DEFAULT_PORT;
  const bin = opts.chromeBin ?? process.env.STAGEPASS_CHROME_BIN ?? DARWIN_CHROME;
  fs.mkdirSync(opts.userDataDir, { recursive: true });
  const proc = spawn(bin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    opts.startUrl ?? "about:blank",
  ], { stdio: "ignore", detached: false });
  if (!proc.pid) throw new Error("failed to spawn Chrome");
  const cdpEndpoint = await waitForCdp(port);
  return { pid: proc.pid, cdpEndpoint, port };
}

async function waitForCdp(port: number, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome CDP endpoint not ready on port ${port} within ${timeoutMs}ms`);
}

export interface QaBrowserSession {
  browser: Browser;
  page: Page;
  consoleErrors: string[];
  close(): Promise<void>;
}

export async function connectQaBrowser(cdpEndpoint: string): Promise<QaBrowserSession> {
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  const consoleErrors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  return { browser, page, consoleErrors, close: () => browser.close() };
}

function locate(s: QaBrowserSession, target: string) {
  // 约定:以 # . [ / 开头按 selector 解释,否则按可见文本
  return /^[#.\[\/]/.test(target) ? s.page.locator(target).first() : s.page.getByText(target, { exact: false }).first();
}

export async function qaNavigate(s: QaBrowserSession, url: string): Promise<string> {
  await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  return `at ${s.page.url()} — title: ${await s.page.title()}`;
}

export async function qaClick(s: QaBrowserSession, target: string): Promise<string> {
  await locate(s, target).click({ timeout: 10_000 });
  return `clicked ${target}`;
}

export async function qaType(s: QaBrowserSession, target: string, text: string): Promise<string> {
  await locate(s, target).fill(text, { timeout: 10_000 });
  return `typed into ${target}`;
}

export async function qaReadPage(s: QaBrowserSession): Promise<string> {
  const snapshot = await s.page.locator("body").ariaSnapshot();
  return `url: ${s.page.url()}\n${snapshot}`;
}

export async function qaScreenshot(s: QaBrowserSession, filePath: string): Promise<string> {
  await s.page.screenshot({ path: filePath, fullPage: false });
  return filePath;
}

export function qaConsoleErrors(s: QaBrowserSession): string[] {
  return [...s.consoleErrors];
}
```

- [ ] **Step 4: 跑测试 + Commit**

```bash
STAGEPASS_QA_BROWSER_TEST=1 npx tsx scripts/run-tests-isolated.ts server/services/qa-browser-service.test.ts
pnpm test
```

Expected: 带 env 的跑 PASS;默认全量套件里此文件 skip、其余 `ℹ fail 0`。

```bash
git add package.json pnpm-lock.yaml server/services/qa-browser-service.ts server/services/qa-browser-service.test.ts server/services/__fixtures__/qa-browser-fixture.html
git commit -m "feat(live-qa): Chrome CDP 接管与浏览器操作封装"
```

---

## Task 7: stagepass-qa-mcp——引擎中立的工具交付层

**为什么这样切:** MCP server 是独立进程(CLI agent 的子进程),只做三件事:代理浏览器操作、读日志、写 halt 信号。**它绝不 import `server/db`**——跨进程只通过 `STAGEPASS_QA_STATE_DIR` 里的文件说话。

**Files:**
- Create: `scripts/qa-mcp-server.ts`
- Create: `server/services/qa-mcp-server.test.ts`
- Modify: `package.json`(`@modelcontextprotocol/sdk`)

**Interfaces:**
- Produces(MCP 工具,name → 行为):
  - `qa_navigate {url}` / `qa_click {target}` / `qa_type {target, text}` / `qa_read_page {}` / `qa_screenshot {label}` / `qa_console_errors {}` — 代理 qa-browser-service,连接信息读 `$STAGEPASS_QA_STATE_DIR/browser.json`
  - `qa_read_server_log {lines?}` — tail `$STAGEPASS_QA_STATE_DIR/server.log`
  - `halt_qa {severity, reason}` — 写 `$STAGEPASS_QA_STATE_DIR/halt.json`,内容 `{severity, reason, at}`
  - 每次浏览器动作后追加一行 JSON 到 `$STAGEPASS_QA_STATE_DIR/browser-events.jsonl`:`{seq, tool, args, result, at}`
- Consumes: Task 6 的全部导出;`browser.json` 格式 `{ cdpEndpoint: string }`(Task 9 的 prepare_env 写入)。

- [ ] **Step 1: 装依赖**

```bash
pnpm add @modelcontextprotocol/sdk@^1.29.0
```

- [ ] **Step 2: 写失败测试(不依赖 Chrome 的工具子集)**

Create `server/services/qa-mcp-server.test.ts`——用 MCP SDK 的 client 从测试进程真实 spawn server,只测 `qa_read_server_log` 与 `halt_qa`(浏览器工具在 Task 6 已测,此处不重复拉 Chrome):

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("qa-mcp-server", { concurrency: false }, () => {
  it("serves log tail and records halt signal as a file", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-mcp-"));
    fs.writeFileSync(path.join(stateDir, "server.log"), "line1\nline2\nERROR boom\n");

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", path.join(process.cwd(), "scripts", "qa-mcp-server.ts")],
      env: { ...process.env, STAGEPASS_QA_STATE_DIR: stateDir },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.ok(["halt_qa", "qa_click", "qa_console_errors", "qa_navigate", "qa_read_page",
        "qa_read_server_log", "qa_screenshot", "qa_type"].every((n) => names.includes(n)));

      const log = await client.callTool({ name: "qa_read_server_log", arguments: { lines: 2 } });
      assert.ok(JSON.stringify(log.content).includes("ERROR boom"));

      await client.callTool({ name: "halt_qa", arguments: { severity: "blocking", reason: "5xx storm" } });
      const halt = JSON.parse(fs.readFileSync(path.join(stateDir, "halt.json"), "utf8"));
      assert.equal(halt.severity, "blocking");
      assert.equal(halt.reason, "5xx storm");
    } finally {
      await client.close();
    }
  });
});
```

```bash
npx tsx scripts/run-tests-isolated.ts server/services/qa-mcp-server.test.ts
```

Expected: FAIL — spawn 后连接失败(脚本不存在)。

- [ ] **Step 3: 实现**

Create `scripts/qa-mcp-server.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  connectQaBrowser, qaClick, qaConsoleErrors, qaNavigate,
  qaReadPage, qaScreenshot, qaType, type QaBrowserSession,
} from "../server/services/qa-browser-service";

const stateDir = process.env.STAGEPASS_QA_STATE_DIR;
if (!stateDir) throw new Error("STAGEPASS_QA_STATE_DIR is required");

let session: QaBrowserSession | null = null;
let seq = 0;

async function browser(): Promise<QaBrowserSession> {
  if (session) return session;
  const raw = fs.readFileSync(path.join(stateDir, "browser.json"), "utf8");
  const { cdpEndpoint } = JSON.parse(raw) as { cdpEndpoint: string };
  session = await connectQaBrowser(cdpEndpoint);
  return session;
}

function journal(tool: string, args: unknown, result: string): void {
  seq += 1;
  fs.appendFileSync(
    path.join(stateDir, "browser-events.jsonl"),
    `${JSON.stringify({ seq, tool, args, result: result.slice(0, 500), at: new Date().toISOString() })}\n`,
  );
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

const server = new McpServer({ name: "stagepass_qa", version: "0.1.0" });

server.tool("qa_navigate", "打开 URL", { url: z.string() }, async ({ url }) => {
  const r = await qaNavigate(await browser(), url); journal("qa_navigate", { url }, r); return text(r);
});
server.tool("qa_click", "点击元素(可见文本或 CSS selector)", { target: z.string() }, async ({ target }) => {
  const r = await qaClick(await browser(), target); journal("qa_click", { target }, r); return text(r);
});
server.tool("qa_type", "在输入框填入文本", { target: z.string(), text: z.string() }, async (a) => {
  const r = await qaType(await browser(), a.target, a.text); journal("qa_type", a, r); return text(r);
});
server.tool("qa_read_page", "读取当前页面结构(a11y 树)", {}, async () => {
  const r = await qaReadPage(await browser()); journal("qa_read_page", {}, "ok"); return text(r);
});
server.tool("qa_screenshot", "截图留证,label 用于命名", { label: z.string() }, async ({ label }) => {
  const dir = path.join(stateDir, "screens"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(seq + 1).padStart(3, "0")}-${label.replace(/[^\w-]/g, "_")}.png`);
  const r = await qaScreenshot(await browser(), file); journal("qa_screenshot", { label }, r); return text(r);
});
server.tool("qa_console_errors", "读取累计的浏览器 console/page 错误", {}, async () => {
  const errs = qaConsoleErrors(await browser()); return text(errs.length ? errs.join("\n") : "(no console errors)");
});
server.tool("qa_read_server_log", "读取 dev server 日志末尾", { lines: z.number().optional() }, async ({ lines }) => {
  const p = path.join(stateDir, "server.log");
  const all = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n") : [];
  return text(all.slice(-(lines ?? 100)).join("\n"));
});
server.tool("halt_qa", "阻断级异常时叫停本轮 QA(写 halt 信号,编排层会终止测试)",
  { severity: z.enum(["blocking"]), reason: z.string() }, async ({ severity, reason }) => {
    fs.writeFileSync(path.join(stateDir, "halt.json"),
      JSON.stringify({ severity, reason, at: new Date().toISOString() }));
    journal("halt_qa", { severity, reason }, "halt recorded");
    return text("halt recorded — testing will stop");
  });

const transport = new StdioServerTransport();
await server.connect(transport);
```

(`server.tool` 的注册签名以装好的 SDK 版本为准——动手时先看 `node_modules/@modelcontextprotocol/sdk` 的 README/类型,1.x 各小版本间 `tool()`/`registerTool()` 命名有过变化,按类型报错调整,不改行为。)

- [ ] **Step 4: 跑测试 + Commit**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/qa-mcp-server.test.ts
```

Expected: PASS(`ℹ fail 0`;此测试不需要 Chrome)。

```bash
git add package.json pnpm-lock.yaml scripts/qa-mcp-server.ts server/services/qa-mcp-server.test.ts
git commit -m "feat(live-qa): stagepass_qa MCP server——浏览器工具/日志/halt 信号"
```

## Task 8: LangGraph 图——编排骨架、interrupt 门控、checkpoint 续跑

**为什么这样切:** 图的流转逻辑(循环边、halt 短路、interrupt/resume)是 Live QA 的大脑,节点实现全部依赖注入,所以可以在不碰引擎/浏览器的前提下把大脑单测到位。

**Files:**
- Create: `server/services/live-qa-graph.ts`、`server/services/live-qa-graph.test.ts`
- Modify: `package.json`(`@langchain/langgraph`、`@langchain/langgraph-checkpoint-sqlite`)

**Interfaces:**
- Produces:
  ```typescript
  export interface LiveQaFinding {
    id: string;               // "LQF-1" 递增
    scenarioId: string | null;
    severity: "blocking" | "major" | "minor" | "doc";
    kind: "impl_mismatch" | "doc_defect" | "runtime_error" | "env_failure";
    summary: string;
    evidencePaths: string[];  // 截图/日志相对路径
  }
  export interface LiveQaVerdict {
    result: "pass" | "fix" | "rollback";
    reasoning: string;
  }
  export type LiveQaGateDecision =
    | { action: "dismiss"; findingIds: string[] }
    | { action: "approve_fix" }
    | { action: "rollback_to_spec" }
    | { action: "waive"; reason: string };
  export interface LiveQaNodeImpls {
    prepareEnv(state: LiveQaStateType): Promise<Partial<LiveQaStateType>>;
    parseUsage(state: LiveQaStateType): Promise<Partial<LiveQaStateType>>;   // 返回 { pendingScenarioIds }
    runScenario(state: LiveQaStateType): Promise<Partial<LiveQaStateType>>;  // 消费队首,返回 findings/halt 增量
    triage(state: LiveQaStateType): Promise<Partial<LiveQaStateType>>;       // 返回 { verdict }
    finalize(state: LiveQaStateType): Promise<Partial<LiveQaStateType>>;
  }
  export function buildLiveQaGraph(impls: LiveQaNodeImpls, opts: { checkpointDbPath: string | null }): CompiledGraph
  // opts.checkpointDbPath = null 时用 MemorySaver(测试);threadId 约定为 changeId
  ```

- [ ] **Step 1: 装依赖**

```bash
pnpm add @langchain/langgraph@^1.4.8 @langchain/langgraph-checkpoint-sqlite@^1.0.3
```

- [ ] **Step 2: 写失败测试**

Create `server/services/live-qa-graph.test.ts`。四个用例,节点全 mock(记录调用序列):

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "@langchain/langgraph";
import { buildLiveQaGraph, type LiveQaNodeImpls } from "./live-qa-graph.ts";

function makeImpls(log: string[], opts?: { scenarios?: number; haltAt?: number; verdict?: "pass" | "fix" }): LiveQaNodeImpls {
  let remaining: string[] = [];
  return {
    async prepareEnv() { log.push("prepare_env"); return {}; },
    async parseUsage() {
      log.push("parse_usage");
      remaining = Array.from({ length: opts?.scenarios ?? 2 }, (_, i) => `QAS-${i + 1}`);
      return { pendingScenarioIds: remaining };
    },
    async runScenario(state) {
      const id = state.pendingScenarioIds[0];
      log.push(`run:${id}`);
      const ran = (opts?.scenarios ?? 2) - state.pendingScenarioIds.length + 1;
      const halt = opts?.haltAt === ran ? { severity: "blocking" as const, reason: "boom" } : null;
      return { pendingScenarioIds: state.pendingScenarioIds.slice(1), halt };
    },
    async triage() { log.push("triage"); return { verdict: { result: opts?.verdict ?? "pass", reasoning: "r" } }; },
    async finalize() { log.push("finalize"); return {}; },
  };
}
const config = { configurable: { thread_id: "CHG-t" } };

describe("live-qa-graph", () => {
  it("runs prepare→parse→each scenario→triage→finalize on the happy path", async () => {
    const log: string[] = [];
    const graph = buildLiveQaGraph(makeImpls(log, { scenarios: 3, verdict: "pass" }), { checkpointDbPath: null });
    await graph.invoke({ changeId: "CHG-t" }, config);
    assert.deepEqual(log, ["prepare_env", "parse_usage", "run:QAS-1", "run:QAS-2", "run:QAS-3", "triage", "finalize"]);
  });

  it("short-circuits remaining scenarios when halt is set", async () => {
    const log: string[] = [];
    const graph = buildLiveQaGraph(makeImpls(log, { scenarios: 3, haltAt: 1, verdict: "fix" }), { checkpointDbPath: null });
    await graph.invoke({ changeId: "CHG-t" }, config);
    assert.ok(log.includes("run:QAS-1") && !log.includes("run:QAS-2"));
    assert.ok(log.includes("triage"));
  });

  it("interrupts at the human gate when verdict is not pass", async () => {
    const log: string[] = [];
    const graph = buildLiveQaGraph(makeImpls(log, { verdict: "fix" }), { checkpointDbPath: null });
    const result = await graph.invoke({ changeId: "CHG-t" }, config);
    assert.ok(result.__interrupt__, "graph should pause at human_gate");
    assert.ok(!log.includes("finalize"));
  });

  it("resumes from the gate: dismiss re-enters the scenario loop", async () => {
    const log: string[] = [];
    const graph = buildLiveQaGraph(makeImpls(log, { scenarios: 1, verdict: "fix" }), { checkpointDbPath: null });
    await graph.invoke({ changeId: "CHG-t" }, config);
    log.length = 0;
    await graph.invoke(new Command({ resume: { action: "dismiss", findingIds: [] } }), config);
    assert.ok(log[0]?.startsWith("run:") || log[0] === "parse_usage",
      "dismiss should resume testing, not finalize");
  });
});
```

```bash
npx tsx scripts/run-tests-isolated.ts server/services/live-qa-graph.test.ts
```

Expected: FAIL — `Cannot find module './live-qa-graph.ts'`。

- [ ] **Step 3: 实现**

Create `server/services/live-qa-graph.ts`:

```typescript
import { Annotation, Command, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// ——(此处放 Interfaces 一节里的 LiveQaFinding / LiveQaVerdict / LiveQaGateDecision 定义,原样)——

export const LiveQaState = Annotation.Root({
  changeId: Annotation<string>,
  pendingScenarioIds: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  findings: Annotation<LiveQaFinding[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  halt: Annotation<{ severity: "blocking"; reason: string } | null>({ reducer: (_, next) => next, default: () => null }),
  verdict: Annotation<LiveQaVerdict | null>({ reducer: (_, next) => next, default: () => null }),
  gateDecision: Annotation<LiveQaGateDecision | null>({ reducer: (_, next) => next, default: () => null }),
});
export type LiveQaStateType = typeof LiveQaState.State;

export interface LiveQaNodeImpls { /* 同 Interfaces 一节 */ }

function routeAfterScenario(state: LiveQaStateType): "run_scenario" | "triage" {
  if (state.halt) return "triage";                       // 阻断:剩余场景不再测
  return state.pendingScenarioIds.length > 0 ? "run_scenario" : "triage";
}

function routeAfterTriage(state: LiveQaStateType): "finalize" | "human_gate" {
  return state.verdict?.result === "pass" ? "finalize" : "human_gate";
}

function humanGate(state: LiveQaStateType): Partial<LiveQaStateType> | Command {
  const decision = interrupt<
    { verdict: LiveQaVerdict | null; findings: LiveQaFinding[] },
    LiveQaGateDecision
  >({ verdict: state.verdict, findings: state.findings });
  if (decision.action === "dismiss") {
    // 误报驳回:清 halt/verdict,回到场景循环把剩下的测完
    return new Command({ goto: "run_scenario", update: { halt: null, verdict: null, gateDecision: decision } });
  }
  // approve_fix / rollback_to_spec / waive:图收尾,外层状态机接管
  return { gateDecision: decision };
}

export function buildLiveQaGraph(impls: LiveQaNodeImpls, opts: { checkpointDbPath: string | null }) {
  const checkpointer = opts.checkpointDbPath
    ? SqliteSaver.fromConnString(opts.checkpointDbPath)
    : new MemorySaver();
  return new StateGraph(LiveQaState)
    .addNode("prepare_env", impls.prepareEnv)
    .addNode("parse_usage", impls.parseUsage)
    .addNode("run_scenario", impls.runScenario)
    .addNode("triage", impls.triage)
    .addNode("human_gate", humanGate, { ends: ["run_scenario", END] })
    .addNode("finalize", impls.finalize)
    .addEdge(START, "prepare_env")
    .addEdge("prepare_env", "parse_usage")
    .addEdge("parse_usage", "run_scenario")
    .addConditionalEdges("run_scenario", routeAfterScenario, ["run_scenario", "triage"])
    .addConditionalEdges("triage", routeAfterTriage, ["finalize", "human_gate"])
    .addEdge("finalize", END)
    .compile({ checkpointer });
}
```

注意两点:(1) `dismiss` 分支清掉 `halt`,否则 `routeAfterScenario` 会立刻又把它送回 triage 死循环;(2) `human_gate` 返回 `Command({goto})` 需要节点声明 `ends`,以装好的 langgraph 1.x 类型为准(报错就查 `node_modules/@langchain/langgraph` 的 `Command`/`interrupt` 类型签名调整写法,不改行为语义)。

- [ ] **Step 4: 跑测试 + Commit**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/live-qa-graph.test.ts
pnpm test
```

Expected: `ℹ fail 0`。

```bash
git add package.json pnpm-lock.yaml server/services/live-qa-graph.ts server/services/live-qa-graph.test.ts
git commit -m "feat(live-qa): LangGraph 编排图——场景循环/halt 短路/interrupt 门控"
```

---

## Task 9: 阶段服务——节点实现、双 agent、prompt 模板

**为什么这样切:** 这是把图、引擎、浏览器、store 缝起来的地方,也是唯一必须"先读邻居代码再落笔"的任务:begin/end run 的账本语义(`stage-orchestrator-service.ts:50-125`)、engine 调用范式(`pipeline-build-stage-service.ts:347-528`)都有既定写法,照抄结构,不发明新范式。

**Files:**
- Create: `server/services/pipeline-live-qa-stage-service.ts`、`server/services/pipeline-live-qa-stage-service.test.ts`
- Create: `server/templates/prompts/live-qa-scenarios.md`、`live-qa-run-scenario.md`、`live-qa-monitor.md`、`live-qa-triage.md`
- Modify: `server/services/prompt-service.ts:75-97`(`PROMPT_TEMPLATE_FILES` 注册 4 个模板,key: `live_qa_scenarios` / `live_qa_run_scenario` / `live_qa_monitor` / `live_qa_triage`)

**Interfaces:**
- Produces:
  ```typescript
  export async function runLiveQa(changeId: string, context: JobExecutionContext, provider: string): Promise<void>
  export async function resumeLiveQa(changeId: string, context: JobExecutionContext, provider: string,
    decision: LiveQaGateDecision): Promise<void>
  export function liveQaStateDir(repoPath: string, changeId: string): string  // = changeArtifactDir()/qa
  ```
- Consumes: Task 3 stores、Task 4 `readUsageGuide`、Task 5 `extraMcpServers`、Task 6 `launchQaChrome`、Task 8 `buildLiveQaGraph`;`emitStageProgress`(`server/services/stage-progress-service.ts:17-19`)、`changeArtifactDir`、`getPipelineEngine`。

- [ ] **Step 1: 四个 prompt 模板**

`live-qa-scenarios.md`(parse_usage 用;结构化输出走引擎既有 outputSchema 机制):

```markdown
你是 QA 场景规划员。下面是本次变更的使用说明(usage.md)。把它转成待测场景清单。

铁律:
- 每个场景必须锚定 usage.md 的一个具体章节(锚点 = 该章节标题的 slug,如 "usage.md#功能操作-登录")。
- 只根据使用说明写场景。说明没写的功能,不许发明场景去测。
- 说明含混得写不出可执行步骤的,不要硬编场景,在 docGaps 里报"文档缺陷"。

使用说明全文:

{usageGuide}
```

其 outputSchema(在阶段服务里定义为常量):

```typescript
const SCENARIOS_SCHEMA = {
  type: "object",
  required: ["scenarios", "docGaps"],
  properties: {
    scenarios: {
      type: "array",
      items: {
        type: "object",
        required: ["sourceAnchor", "title", "steps"],
        properties: {
          sourceAnchor: { type: "string" },
          title: { type: "string" },
          steps: { type: "string" },
        },
      },
    },
    docGaps: { type: "array", items: { type: "string" } },
  },
} as const;
```

`live-qa-run-scenario.md`(run_scenario 用):

```markdown
你是 QA 测试执行员,手上只有一份剧本:下面这个场景。用 stagepass_qa 工具集操作真实浏览器执行它。

铁律:
- 严格照步骤做。步骤说点哪就点哪;界面与剧本不符时,这本身就是发现(impl_mismatch),截图留证后停止本场景,不要自作聪明找替代路径。
- 每个关键步骤前后用 qa_screenshot 留证(label 用步骤名)。
- 每步之后用 qa_read_page 核对预期结果;用 qa_console_errors 检查是否有报错。
- 你只测这一个场景。测完就报结果,不要顺手测别的。

服务地址:{appUrl}

场景(锚点 {sourceAnchor}):
标题:{scenarioTitle}
步骤与预期:
{scenarioSteps}
```

其 outputSchema:

```typescript
const SCENARIO_RESULT_SCHEMA = {
  type: "object",
  required: ["passed", "findings"],
  properties: {
    passed: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "kind", "summary"],
        properties: {
          severity: { enum: ["blocking", "major", "minor", "doc"] },
          kind: { enum: ["impl_mismatch", "doc_defect", "runtime_error", "env_failure"] },
          summary: { type: "string" },
          evidencePaths: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;
```

`live-qa-monitor.md`(监控 agent 用):

```markdown
你是运行监控员。测试员正在浏览器里跑场景,你的职责是盯日志、判严重度。

工作循环:每隔一会用 qa_read_server_log 读 dev server 日志增量、用 qa_console_errors 看浏览器错误,判断有没有异常。持续循环直到进程被终止。

判定标准:
- 阻断级(必须叫停):5xx 连发、进程崩溃/重启循环、数据写坏(日志出现落库失败/约束冲突)、白屏级前端崩溃。发现即调 halt_qa,并在 reason 里给出日志证据摘录。
- 非阻断(警告/偶发 4xx/样式报错):不要叫停,记在心里,不干预。

铁律:你没有浏览器操作权,不要调 qa_click/qa_type/qa_navigate;误叫停的代价很高,拿不准就再观察一轮。
```

`live-qa-triage.md`(triage 用):

```markdown
你是 QA 分诊官。本轮按使用说明的实测已结束(或被阻断)。下面是全部场景结果与发现。给出判定与提案。

判定规则:
- 全部场景通过且无未决发现 → result: "pass"。
- 存在失败/发现,且属于实现层问题(某个功能做错了、局部报错)→ result: "fix"。
- 属于结构性问题(架构做不到使用说明承诺的事、多个功能因同一设计缺陷成片失败、说明与系统能力根本对不上)→ result: "rollback"。

reasoning 必须引用具体场景与证据文件路径,让人不看现场也能裁决。

场景结果:
{scenarioResults}

发现清单:
{findings}

监控/halt 信息:
{haltInfo}
```

其 outputSchema:`{ result: enum["pass","fix","rollback"], reasoning: string }`(required 两者)。

`prompt-service.ts` 的 `PROMPT_TEMPLATE_FILES` 加 4 行映射。模板变量(`{usageGuide}` 等)通过 `assemblePrompt` 的变量表传入——先读 `buildVariables`(prompt-service.ts:36-63)确认自定义变量的传入口;若它只支持固定变量,则模板里留固定占位、阶段服务用字符串拼接补尾部(照 build 阶段 `assemblePrompt("implement",...) + "\n\n" + render...` 的既有范式,`pipeline-build-stage-service.ts:407-412`)。

- [ ] **Step 2: 写失败测试(编排逻辑,mock 引擎与浏览器)**

Create `server/services/pipeline-live-qa-stage-service.test.ts`。测试面收窄到纯逻辑函数(不 spawn 任何进程):

```typescript
// 用例 1: extractHowToRunCommand(usageMd) 从 HOW_TO_RUN 节抽出第一个 bash 代码块命令;
//         无 HOW_TO_RUN 节时抛 UsageGuideMissingError 同类错误。
// 用例 2: buildScenarioRows(parsed, changeId) 把 SCENARIOS_SCHEMA 输出映射成 NewQaScenario[],
//         id 形如 "QAS-<changeId>-<序号>";docGaps 非空时生成 kind="doc_defect" 的 findings。
// 用例 3: nodeImplsForTest 场景选取:pendingScenarioIds 队首被消费后,markQaScenario 被以正确
//         status 调用(passed/failed 映射)。(store 走真实隔离库,引擎注入 fake)
```

(具体断言在实现函数签名定下后补全,保持上面三个行为不变量。)

```bash
npx tsx scripts/run-tests-isolated.ts server/services/pipeline-live-qa-stage-service.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现阶段服务**

Create `server/services/pipeline-live-qa-stage-service.ts`。骨架(账本 begin/end 的准确调用先读 `stage-orchestrator-service.ts:50-125` 与 `runQaLocalCheckWithLedger` 用法,照抄结构):

```typescript
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { changeArtifactDir } from "./phase-artifact-service";
import { readUsageGuide } from "./usage-guide-service";
import { launchQaChrome } from "./qa-browser-service";
import { buildLiveQaGraph, type LiveQaGateDecision, type LiveQaNodeImpls } from "./live-qa-graph";
import { insertQaScenariosWithDb, listQaScenarios, markQaScenario, resetQaScenariosForRetest } from "./qa-scenario-store";
import { getPipelineEngine } from "./pipeline-engine-service";
import { emitStageProgress } from "./stage-progress-service";
import { assemblePrompt } from "./prompt-service";
import { db } from "../db";

export function liveQaStateDir(repoPath: string, changeId: string): string {
  return path.join(changeArtifactDir(repoPath, changeId), "qa");
}

/** HOW_TO_RUN 节的第一个 ```bash 块就是启动命令;抽不出来=文档缺陷=阻断。 */
export function extractHowToRunCommand(usageMd: string): { command: string; appUrl: string } { /* 正则抽取,单测覆盖 */ }

export async function runLiveQa(changeId: string, context: JobExecutionContext, provider: string): Promise<void> {
  // 1) 账本 begin(LOCAL_READY→LIVE_QA_RUNNING 原子推进,照 orchestrator 范式)
  // 2) qaDir 准备:mkdir,清掉上一轮的 halt.json(场景表不清,续测语义靠 store)
  // 3) prepare_env:
  //    - usage = readUsageGuide(repoPath, changeId); const { command, appUrl } = extractHowToRunCommand(usage)
  //    - dev server: spawn(command, {shell:true, cwd:repoPath}) → stdout/stderr 各 pipe 一份 append 到 qaDir/server.log
  //      (tee 写法照 dev-supervisor.ts:304-313 的 writeServerOutput)
  //    - chrome = await launchQaChrome({ userDataDir: path.join(qaDir, "chrome-profile") })
  //    - fs.writeFileSync(qaDir/browser.json, JSON.stringify({ cdpEndpoint: chrome.cdpEndpoint }))
  //    - 就绪探测:轮询 fetch(appUrl) 直到 200 或 60s 超时;超时 → env_failure 阻断发现,直接 triage
  // 4) monitor agent(与场景循环并行,不进图):
  //    const monitor = engine.runStreamed({ changeId, repoPath, phase: "live_qa_monitor",
  //      prompt: assemblePrompt("live_qa_monitor", {...}), sandboxMode: "read-only",
  //      extraMcpServers: mcp(qaDir), lifecycle: pidCapturingSink });
  //    后台 drain 它的事件流;记下 pid,场景循环结束后 SIGTERM。
  // 5) 图节点实现(真实版 LiveQaNodeImpls):
  //    - parseUsage: 先查 listQaScenarios 中非 skipped 的存量——有则不再解析(Fix 后续测:直接返回
  //      pending 场景);无(首轮或大回退后全 skipped)则 engine.run({ phase:"live_qa",
  //      prompt: scenariosPrompt, outputSchema: SCENARIOS_SCHEMA })
  //      → buildScenarioRows(id 带轮次后缀防撞旧 id)→ db.transaction(tx => insertQaScenariosWithDb(tx, rows))
  //      → 返回 { pendingScenarioIds }(仅 status==="pending")
  //    - runScenario: 队首场景 → engine.run({ phase:"live_qa", prompt: runScenarioPrompt(场景),
  //        outputSchema: SCENARIO_RESULT_SCHEMA, extraMcpServers: mcp(qaDir), sandboxMode: "workspace-write" })
  //      → markQaScenario(passed/failed) → emitStageProgress(每场景一条)
  //      → 读 qaDir/halt.json:存在则返回 { halt } 增量
  //    - triage: 汇总 listQaScenarios + findings + halt → engine.run(triage prompt) → 写 qaDir/triage.md
  //      与 qaDir/findings.json → 返回 { verdict }
  //    - finalize: 无操作占位(清理在 finally)
  // 6) const graph = buildLiveQaGraph(impls, { checkpointDbPath: path.join(qaDir, "graph-checkpoint.db") });
  //    const result = await graph.invoke({ changeId }, { configurable: { thread_id: changeId } });
  // 7) 收尾:
  //    - result.__interrupt__ 存在 → 账本 end,change → LIVE_QA_BLOCKED
  //    - verdict.result === "pass" → change → LIVE_QA_READY
  // 8) finally:SIGTERM monitor、dev server、chrome(process.kill(chrome.pid)),浏览器 profile 保留供复查
  //    mcp(qaDir) = { stagepass_qa: { command: "npx", args: ["tsx", "scripts/qa-mcp-server.ts"],
  //                                   env: { STAGEPASS_QA_STATE_DIR: qaDir } } }
}

export async function resumeLiveQa(changeId, context, provider, decision: LiveQaGateDecision): Promise<void> {
  // dismiss:账本 begin(LIVE_QA_BLOCKED→LIVE_QA_RUNNING),重建 prepare_env 之后的运行时(dev server/chrome
  //   进程在上轮 finally 已死,重新拉起并重写 browser.json;图状态由 checkpointer 恢复,场景进度由 store 恢复),
  //   然后 graph.invoke(new Command({ resume: decision }), { configurable: { thread_id: changeId } })。
  // 其余 action 不进这里——approve_fix/rollback/waive 在决策服务里直接走状态机(Task 11)。
}
```

**实现纪律:**(a) 所有 ship.db 写入只经 store;(b) 引擎调用与 lifecycle sink 照 `pipeline-build-stage-service.ts:418-437` 原样式;(c) 每场景步数上限交给 prompt+超时(`timeoutMs: documentStageTimeoutMs` 风格,单场景 10 分钟),整轮上限由 job 心跳超时兜底;(d) monitor agent 崩溃(stream throw)不 fail 整轮——捕获、`emitStageProgress` 记"监控缺位"、继续。

- [ ] **Step 4: 跑测试 + Commit**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/pipeline-live-qa-stage-service.test.ts
pnpm test
```

Expected: `ℹ fail 0`。

```bash
git add server/services/pipeline-live-qa-stage-service.ts server/services/pipeline-live-qa-stage-service.test.ts server/templates/prompts/live-qa-*.md server/services/prompt-service.ts
git commit -m "feat(live-qa): 阶段服务——图节点实现/双 agent/四个 prompt 模板"
```

## Task 10: job 接线——run_live_qa/resume_live_qa 进入 worker 与 API

**为什么这样切:** job 类型系统是编译期强制补全的(`CompletePipelineJobRunnerMap` 缺 runner 即编译错误),一次接线让 TypeScript 把所有遗漏点报出来。

**Files:**
- Modify: `server/types/enums.ts:42-57`(RunPhase 加 `"live_qa"`)
- Modify: `server/services/pipeline-job-types.ts:3-19`
- Modify: `server/services/pipeline-job-runner-service.ts:40-69`(PipelineWorkerStageApi)、`:84-137`(路由表)
- Modify: `server/services/pipeline-service.ts`(导出 runLiveQa/resumeLiveQa 委托)
- Modify: `server/services/pipeline-qa-stage-service.ts:346-355`(静态检查成功 → LOCAL_READY)
- Create: `app/api/projects/[id]/changes/[changeId]/live-qa/route.ts`
- Modify: action contract 注册表(定位:`grep -rn '"run_qa"' server app --include='*.ts' | grep -v test`,在登记 `run_qa` 的同一处按同格式登记 `run_live_qa`、`resume_live_qa`)

**Interfaces:**
- Produces: pipeline job `live_qa:run_live_qa`、`live_qa:resume_live_qa`;POST `/api/projects/:id/changes/:changeId/live-qa`(body `{ actionId: "run_live_qa" | "resume_live_qa", idempotencyKey }`)。
- Consumes: Task 9 `runLiveQa`/`resumeLiveQa`;`enqueueProviderActionAtomically`(照 `check/route.ts:82-86` 范式)。

- [ ] **Step 1: 注册 job 类型(编译错误当向导)**

`pipeline-job-types.ts` 的 `PIPELINE_JOB_ACTIONS_BY_PHASE` 在 `local_check` 行后加:

```typescript
  live_qa: ["run_live_qa", "resume_live_qa"],
```

`enums.ts` RunPhase 数组加 `"live_qa",`。然后:

```bash
npx tsc --noEmit
```

Expected: FAIL——`CompletePipelineJobRunnerMap` 缺两个 runner、`PipelineWorkerStageApi` 缺方法。这个失败清单就是本任务的待办表。

- [ ] **Step 2: 补 runner 与阶段 API**

`pipeline-job-runner-service.ts`:`PipelineWorkerStageApi` 加:

```typescript
  runLiveQa(changeId: string, context: JobExecutionContext, provider: string): Promise<void>;
  resumeLiveQa(changeId: string, context: JobExecutionContext, provider: string): Promise<void>;
```

路由表加:

```typescript
    "live_qa:run_live_qa": (job, context) => pipeline.runLiveQa(job.changeId, context, job.provider),
    "live_qa:resume_live_qa": (job, context) => pipeline.resumeLiveQa(job.changeId, context, job.provider),
```

`pipeline-service.ts` 加两个委托导出(照既有 stage 方法的委托写法)。`resume` 的 gate decision 从哪来:决策服务(Task 11)把决定写进 `human_decisions` 后入队 resume job;`resumeLiveQa` 委托内读该 change 最近一条 `gate="live_qa"`、`action="dismiss"` 的决策还原 `LiveQaGateDecision`。

- [ ] **Step 3: 静态检查成功改为驻留 LOCAL_READY**

`pipeline-qa-stage-service.ts:346-355`:

```typescript
  } else {
    finalStatus = "LOCAL_READY";   // 原 "MERGE_READY":静态门通过后驻留,等人启动 Live QA(或豁免直通 merge)
  }
  return { result: { runId, finalStatus }, summary: `Checks: ${finalStatus}`,
           success: finalStatus === "LOCAL_READY", finalStatus };
```

同文件后续 `computeMergeReadiness` 调用与 `graph-runner.ts:125-142` 的 `markLocalReady` 语义核对:LOCAL_READY→MERGE_READY 豁免通路保持可用。全仓 `grep -rn 'MERGE_READY' server --include='*.ts' | grep -i 'check\|qa'` 过一遍,把假设"CHECKING 成功即 MERGE_READY"的测试/断言同步为 LOCAL_READY。

- [ ] **Step 4: API 路由**

Create `app/api/projects/[id]/changes/[changeId]/live-qa/route.ts`,整体照 `check/route.ts` 抄结构(守卫 `requireProjectChange` → `assertActionAllowed` → `enqueueProviderActionAtomically({ changeId, phase: "live_qa", actionId, idempotencyKey }, actionContract)` → 错误分层)。action contract 登记见 Files 一节的 grep 定位。

- [ ] **Step 5: 验证 + Commit**

```bash
npx tsc --noEmit
pnpm test
```

Expected: 编译零错;`ℹ fail 0`(重点看 job-types/job-runner/qa-stage 相关既有测试)。

```bash
git add server/types/enums.ts server/services/pipeline-job-types.ts server/services/pipeline-job-runner-service.ts server/services/pipeline-service.ts server/services/pipeline-qa-stage-service.ts "app/api/projects/[id]/changes/[changeId]/live-qa/route.ts" <contract 注册文件>
git commit -m "feat(live-qa): live_qa job 接线,静态检查成功驻留 LOCAL_READY"
```

---

## Task 11: 决策服务与回退——门控的四个动作

**为什么这样切:** 这是"人拍板"的落点:approve_fix/rollback_to_spec/dismiss/waive 四个动作各自走状态机一条边,rollback 附带非破坏审计记录与 Spec prompt 上下文注入。

**Files:**
- Create: `server/services/live-qa-decision-service.ts`、`server/services/live-qa-decision-service.test.ts`
- Create: `app/api/projects/[id]/changes/[changeId]/live-qa/decision/route.ts`
- Modify: Spec 阶段服务(定位:`grep -rn 'assemblePrompt("spec"' server --include='*.ts'`)——prompt 追加回退上下文
- Modify: `server/services/pipeline-build-stage-service.ts:790-841`(fix prompt 追加 Live QA findings)
- Modify: `server/db/db-write-policy.json` + 快照(decision-service 写 human_decisions)

**Interfaces:**
- Produces:
  ```typescript
  export type LiveQaDecisionInput =
    | { changeId: string; action: "approve_fix"; reason?: string }
    | { changeId: string; action: "rollback_to_spec"; reason: string }
    | { changeId: string; action: "dismiss"; findingIds: string[]; reason?: string }
    | { changeId: string; action: "waive"; reason: string };
  export async function applyLiveQaDecision(input: LiveQaDecisionInput): Promise<void>
  export function renderQaRollbackForPrompt(changeId: string): string   // 无回退记录时返回 ""
  export function renderLiveQaFindingsForPrompt(repoPath: string, changeId: string): string
  ```
- Consumes: `stage-rollback-store`、`human_decisions` 写入范式(`spec-battle-service.ts:584-599` `recordDecision`,`gate` 填 `"live_qa"`,id 前缀 `DEC`,`nextId`)、`updateChangeStatus`(spec-battle-service 的用法为参照)、`enqueueProviderActionAtomically`(dismiss 入队 resume job)。

- [ ] **Step 1: 写失败测试**

`live-qa-decision-service.test.ts` 用隔离库覆盖四个动作的状态效应(seed change 置 `LIVE_QA_BLOCKED`):

```typescript
// approve_fix → change.status === "CHECK_FAILED";human_decisions 增一条 gate="live_qa" action="approve_fix"
// rollback_to_spec → change.status === "INTAKE_READY";stage_rollbacks 增一条
//   {fromStatus:"LIVE_QA_BLOCKED", toStatus:"INTAKE_READY", verdict:含 reason, decisionId 指向新决策};
//   下游产物零删除(seed 一个 plan artifact,断言仍在)
// waive → change.status === "MERGE_READY";决策带 reason
// dismiss → 入队了 live_qa:resume_live_qa job(查 pipeline_jobs 表);状态仍 LIVE_QA_BLOCKED(由 resume job 推进)
// 非 LIVE_QA_BLOCKED 状态调用 → 抛错,零副作用
```

```bash
npx tsx scripts/run-tests-isolated.ts server/services/live-qa-decision-service.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 2: 实现决策服务**

`applyLiveQaDecision` 每分支一个事务:先 `recordLiveQaDecision`(仿 `recordDecision`,gate `"live_qa"`)→ 再:

- `approve_fix`:`updateChangeStatus(changeId, "CHECK_FAILED", ...)`。
- `rollback_to_spec`:读 `qa/triage.md` 相对路径作 evidencePath → `insertStageRollbackWithDb(tx, { id: nextId(...), changeId, fromStatus: "LIVE_QA_BLOCKED", toStatus: "INTAKE_READY", decisionId, verdict: input.reason, evidencePath })` → `skipAllQaScenarios(changeId)`(usage.md 将重写,旧场景作废留审计)→ `updateChangeStatus(changeId, "INTAKE_READY", ...)`。**不删任何 runs/artifacts——这是与 change-rework-service 的本质区别,测试锁死。**
- `dismiss`:入队 `live_qa:resume_live_qa`(幂等 key 用决策 id)。
- `waive`:`updateChangeStatus(changeId, "MERGE_READY", ...)`。

写入点登记 db-write-policy(human_decisions + stageRollbacks 经 store)并重算快照。

- [ ] **Step 3: 回退上下文注入 Spec、findings 注入 Fix**

`renderQaRollbackForPrompt(changeId)`:`listStageRollbacks` 最近一条 + triage.md 摘录(前 2000 字符),渲染为:

```markdown
## Live QA 回退上下文(为什么回到这里)

上一轮 Live QA 判定存在结构性问题并回退重走。判定:{verdict}
证据:{evidencePath}(triage 摘录如下)
{triageExcerpt}

重写 Spec 时必须正面回应上述判定;不许无视回退原因原样重出。
```

Spec 阶段服务 prompt 拼装处追加 `+ renderQaRollbackForPrompt(changeId)`(照 build 阶段 `render*ForPrompt` 的拼接范式)。同样把 `renderLiveQaFindingsForPrompt`(读 `qa/findings.json`,渲染为 findings 清单)拼进 fix prompt(`pipeline-build-stage-service.ts:803-807` Open Findings 之后)。

- [ ] **Step 4: 决策 API 路由**

Create `live-qa/decision/route.ts`,照 `spec-battle/decision/route.ts` 抄结构:`requireProjectChange` → zod 校验 body(action 四选一,rollback/waive 必带 reason)→ `applyLiveQaDecision` → 错误分层(guard 409 / 校验 422 / 其余 400)。

- [ ] **Step 5: 跑测试 + Commit**

```bash
npx tsx scripts/run-tests-isolated.ts server/services/live-qa-decision-service.test.ts server/db/db-write-inventory.test.ts
pnpm test
```

Expected: `ℹ fail 0`。

```bash
git add server/services/live-qa-decision-service.ts server/services/live-qa-decision-service.test.ts "app/api/projects/[id]/changes/[changeId]/live-qa/decision/route.ts" server/services/pipeline-build-stage-service.ts <spec 阶段服务文件> server/db/db-write-policy.json server/db/db-write-inventory.snapshot.json
git commit -m "feat(live-qa): 四动作人工门控,非破坏回退与上下文注入"
```

## Task 12: 前端——Live QA 节点、阶段面板、跳转浏览器

**为什么这样切:** UI 是纯消费端,等所有状态/API 就位后一次接上;`pipeline-ui-model` 有五处需要同步的映射,TypeScript 穷举会兜底。

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/pipeline-ui-model.ts:9-21`(UiStageId)、`:70-83`(UI_STAGE_ORDER)、`:85-209`(STAGE_DEFINITIONS)、`:211-280`(三张映射表)
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`(showingLiveQa 分支)
- Create: `app/projects/[id]/changes/[changeId]/live-qa-panel.tsx`
- Create: `app/api/projects/[id]/changes/[changeId]/live-qa/state/route.ts`
- Create: `app/api/projects/[id]/changes/[changeId]/live-qa/focus-browser/route.ts`
- Modify(如有):`pipeline-ui-model` 的测试文件(`ls app/projects/**/pipeline-ui-model*.test.*`)

**Interfaces:**
- Produces: GET `/live-qa/state` → `{ scenarios: QaScenarioRow[], findings: LiveQaFinding[], rollbacks: StageRollbackRow[], triagePath: string | null }`;POST `/live-qa/focus-browser` → 唤起 Chrome;stage id `"live_qa"`。
- Consumes: Task 3 stores(读侧)、`requireProjectChange` 守卫、`<ProducedFile>`(`produced-file.tsx:140-190`)展示 triage.md/截图、决策 API(Task 11)。

- [ ] **Step 1: ui-model 五处同步**

`UiStageId` 联合加 `"live_qa"`;`UI_STAGE_ORDER` 在 `"qa"` 之后插入 `"live_qa"`;`STAGE_DEFINITIONS` 加条目(先读 `ReviewPhase`/`ActionPhase` 类型来源,把 `"LiveQA"` 加进对应枚举——TypeScript 会在所有 switch 穷举处报错指路,逐一补齐,语义:Live QA 有自己的面板与 action):

```typescript
  live_qa: {
    id: "live_qa",
    label: "Live QA",
    description: "Browser-based usage-guide testing with human gates.",
    reviewPhase: "LiveQA",
    recordPhase: "LiveQA",
    actionPhase: "LiveQA",
    actionIds: ["run_live_qa", "resume_live_qa"],
  },
```

`STATUS_TO_STAGE` 加:

```typescript
  LIVE_QA_RUNNING: { id: "live_qa", state: "running" },
  LIVE_QA_BLOCKED: { id: "live_qa", state: "failed" },
  LIVE_QA_READY: { id: "live_qa", state: "complete" },
```

`RUN_PHASE_TO_STAGE` 加 `live_qa: "live_qa"`;`REVIEW_PHASE_TO_STAGE` 加 `LiveQA: "live_qa"`。若 ui-model 有测试,先在测试里加断言(三个新状态映射到 live_qa stage)再改实现。

- [ ] **Step 2: state 与 focus-browser 路由**

`state/route.ts`:`requireProjectChange` 守卫 → `listQaScenarios(changeId)` + 读 `qa/findings.json`(不存在则 `[]`)+ `listStageRollbacks(changeId)` + triage.md 存在性 → JSON 返回。

`focus-browser/route.ts`(POST;唤起的是 QA 专用 profile 的 Chrome 实例,macOS 上同 bundle 激活即可前置该窗口):

```typescript
import { execFile } from "node:child_process";
import { NextResponse } from "next/server";

export async function POST() {
  if (process.platform !== "darwin") {
    return NextResponse.json({ error: "focus-browser is only supported on macOS" }, { status: 501 });
  }
  await new Promise<void>((resolve, reject) => {
    execFile("osascript", ["-e", 'tell application "Google Chrome" to activate'],
      (err) => (err ? reject(err) : resolve()));
  });
  return NextResponse.json({ ok: true });
}
```

(加上与其他路由一致的 `requireProjectChange` 守卫与 try/catch 400。)

- [ ] **Step 3: LiveQaPanel 组件**

Create `live-qa-panel.tsx`(client 组件,视觉语言照 `spec-battlefield.tsx` 的 CommandButton/卡片风格):

- 顶部:场景进度条(passed/failed/pending 计数,数据来自 `/live-qa/state`,由父组件传入并随既有 SSE 刷新回调重取);
- "打开测试浏览器"按钮:POST `/live-qa/focus-browser`(仅 `LIVE_QA_RUNNING` 时可用);
- 场景清单:每行 title + 状态徽标 + failureReason;
- 发现清单:severity/kind/summary + `<ProducedFile>` 链接 evidencePaths 与 triage.md;
- `LIVE_QA_BLOCKED` 时渲染四个决策按钮(批准修复/回退重走/驳回误报/豁免放行),rollback 与 waive 弹 `ActionReasonDialog` 收理由,POST `/live-qa/decision`,`finally` 里调父组件传入的刷新回调——fetch 链路照 `page.tsx:593-606` `postDecision` 范式。

`page.tsx`:`showingLiveQa = activeSelectedPhase === "LiveQA"`,分支内 `<PhaseStageShell>` 包 `<LiveQaPanel ...>`(props 透传照 GatePanel 分支 1367-1395 行范式);`/live-qa/state` 的 loader 挂进 `useChangeDetailData` 同层的加载函数集合,SSE 刷新时一并重取。

- [ ] **Step 4: 手工烟测 + Commit**

```bash
pnpm dev
```

打开任一 change 详情页验证:rail 出现 Live QA 节点(灰色 pending);`npx tsc --noEmit` 零错;`pnpm test` `ℹ fail 0`。

```bash
git add "app/projects/[id]/changes/[changeId]/pipeline-ui-model.ts" "app/projects/[id]/changes/[changeId]/page.tsx" "app/projects/[id]/changes/[changeId]/live-qa-panel.tsx" "app/api/projects/[id]/changes/[changeId]/live-qa/state/route.ts" "app/api/projects/[id]/changes/[changeId]/live-qa/focus-browser/route.ts"
git commit -m "feat(live-qa): 前端节点/阶段面板/决策按钮/跳转测试浏览器"
```

---

## Task 13: 端到端沙盒走查与 spec 回写

**为什么最后:** 全链路(测→急停→门控→修→续测→通过 / 回退→重走)只有真跑一遍才算数;本任务无新代码,是验证清单 + 文档收尾。

**Files:**
- Modify: `docs/superpowers/specs/2026-07-22-live-qa-stage-design.md`(回写 4 处落地偏差)

- [ ] **Step 1: 沙盒项目走查**

用一个一次性沙盒项目(隔离仓库,参照记忆中"隔离浏览器验证环境"的配方,不碰生产库)建 change 走完整流水线,重点验证:

1. Build 产出 usage.md,缺失时 build 被阻;
2. 静态检查通过后驻留 LOCAL_READY,"运行 Live QA"按钮出现;
3. Live QA 跑起来:Chrome 独立 profile 弹出、场景逐个执行、`browser-events.jsonl` 与截图落盘、面板进度随 SSE 刷新;
4. "打开测试浏览器"按钮把 Chrome 前置;
5. 人为埋一个 5xx(临时改沙盒代码)→ 监控 agent 调 halt_qa → 驻留 LIVE_QA_BLOCKED,gate 面板出证据;
6. 走 approve_fix → CHECK_FAILED → 既有 fix 按钮 → 修完静态检查 → 再进 Live QA,**只重测失败场景**;
7. 走 rollback_to_spec → INTAKE_READY,产物零删除,重跑 Spec 时 prompt 里出现回退上下文;
8. dismiss → resume job 从 checkpoint 续跑;waive → MERGE_READY;
9. Codex 与 Claude 两个 provider 各跑一遍 3-8(重点:Codex sandbox 下 MCP 子进程能连 CDP、能写 stateDir——若被拦,记录实况并在 `buildCodexArgs` 的 sandbox 选择处对 live_qa phase 放宽,单独提交)。

每一条通过与否记录在本文件末尾(照 spec-battle 计划的 Self-Review 记录风格),失败项按 systematic-debugging 修完复验。

- [ ] **Step 2: spec 回写 + 收尾提交**

把计划头部"与 Spec 的三处落地偏差"(共 4 条)回写进 spec 文档对应小节(状态机小节、门控小节、浏览器执行层小节),标注"实施定稿"。

```bash
git add docs/superpowers/specs/2026-07-22-live-qa-stage-design.md docs/superpowers/plans/2026-07-22-live-qa-stage.md
git commit -m "docs(live-qa): 端到端走查记录与 spec 落地偏差回写"
```

---

## Self-Review 记录

对照 spec 逐节检查:

- **状态机(spec §1)**:Task 1 覆盖;三处偏差(LOCAL_READY 入口、CHECK_FAILED 进 Fix、INTAKE_READY 回退)已在头部声明并有测试锁死。✔
- **非破坏回退(spec §2)**:Task 2/3 表与 store,Task 11 决策落地+"产物零删除"断言+prompt 注入。✔
- **usage.md(spec §3)**:Task 4;"无锚点场景非法"由 SCENARIOS_SCHEMA 的 required sourceAnchor + store 层 notNull 双重锁。✔
- **浏览器执行层(spec §4)**:Task 6(CDP/独立 profile/playwright-core)+ Task 7(动作日志 JSONL、截图仅留证)。✔
- **引擎中立 MCP(spec §5)**:Task 5;Codex sandbox 核查项落在 Task 13 Step 1.9。✔
- **LangGraph 编排(spec §6)**:Task 8(图/interrupt/checkpointer)+ Task 9(节点实现、monitor 为服务层并行进程——图内并行分支改为服务层实现,已在 Task 9 说明,不违背 spec 的行为语义:实时判读+可叫停)。✔
- **门控四动作(spec §7)**:Task 11;决策写 human_decisions(gate="live_qa")。✔
- **场景恢复(spec §8)**:store 的 resetQaScenariosForRetest + parseUsage 幂等(已有场景跳过插入)+ checkpointer。大回退后场景表重生成:rollback 后首次 runLiveQa 时 usage.md 已变——**补充约定:rollback_to_spec 决策里把该 change 的 qa_scenarios 全部置 skipped,重走后 parseUsage 重新插入新一批(id 带轮次后缀)**,此细节实现于 Task 11 Step 2(rollback 分支)与 Task 9 parseUsage(只统计非 skipped)。✔(已把该约定补进对应任务步骤的实现要点)
- **前端(spec §9)**:Task 12,不嵌画面、跳转按钮、SSE 复用。✔
- **预算容错(spec §10)**:单场景超时/整轮心跳兜底/监控缺位降级在 Task 9 实现纪律;env_failure 阻断在 prepare_env。✔
- **测试策略(spec §11)**:每任务 TDD;浏览器 env 门控;图 mock 单测;e2e 走查 Task 13。✔

占位符扫描:无 TBD/TODO;所有"先读再套用"处均给出精确文件:行号锚点与 grep 命令,符合仓库既有计划的约定(参照 spec-battle 计划第 46-50 行同类声明)。

类型一致性:`LiveQaGateDecision`/`LiveQaFinding`/`LiveQaVerdict` 定义于 Task 8,Task 9/11/12 引用同名;store 函数签名 Task 3 定义,Task 9/11/12 引用一致;`liveQaStateDir` Task 9 定义并被 Task 7 的 stateDir 约定消费(经 env 传递,无直接 import,进程边界成立)。






