# 删除 Claude 收敛单 Provider + Codex exec → App Server 迁移实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Stage Pass 收敛为 Codex 单 Agent 链路（彻底删除 Claude 引擎、Provider 选择与全部残留），随后把 Codex 引擎的传输层从一次性 `codex exec` 子进程升级为 `codex app-server`（JSON-RPC over stdio），获得真增量流式输出、协议级中断与模型/推理强度控制能力。

**Architecture:** 两个可独立交付的 Part。Part A 先做：backfill 迁移保证历史数据兼容 → 删纯 Claude 文件 → 收窄 `AiProvider` 类型让 `tsc` 逼出全部死分支 → 逐层清理服务/API/UI/测试/文档。Part B 后做：新增 `codex-app-server-client.ts`（JSON-RPC 协议客户端）与 `codex-app-server-engine.ts`（实现现有 `AiEngineAdapter` 接口），事件归一化层把 app-server 通知翻译回现有 `AiStreamEvent` 契约，一次性切换后删除 exec 传输路径。每个 run 仍是独立子进程（`codex app-server` per run），完整保留现有 pid 租约、心跳、崩溃恢复语义。

**Tech Stack:** TypeScript / Next.js 16 / better-sqlite3 + drizzle / node:test（经 `scripts/run-tests-isolated.ts` 隔离跑）/ codex CLI ≥ 0.144（app-server 子命令与 `codex exec --json` 同一二进制打包）。

## Global Constraints

- **测试必须隔离跑**：`pnpm test <file>`（走 `scripts/run-tests-isolated.ts`）。裸 `npx tsx --test` 会写生产库 `server/db/ship.db`。
- **测试结论看计数不看退出码**：`pnpm test` 全量可能 exit 0 但有失败；必须确认 `ℹ fail 0` 且 `ℹ cancelled 0`。
- **`tsc --noEmit` 不覆盖 `**/*.test.ts`**（tsconfig exclude）；改公共类型后必须真跑受影响测试。`.typecheck.ts` 文件（如 `briefing-question-store.typecheck.ts`）在 tsc 覆盖范围内，可用作类型契约哨兵。
- **`server/services/rubric-service.ts` 含两个字面 NUL 字节**：任何全仓 grep 审计必须用 `grep -a`，否则该文件被静默跳过（已确认它不含 claude 引用，但审计步骤必须覆盖它）。
- **新增/删除会写库的测试文件必须同步 `server/db/db-write-policy.json` 的 `testFixtures`**（按 `file` 排序），并重跑 `npx tsx scripts/generate-db-write-inventory-snapshot.ts`。
- **历史迁移文件（0000–0026）一律不改**；新迁移只能追加。
- **`docs/superpowers/plans|specs` 下的历史文档是决策记录，不改**；活文档（README、docs/ship/*）要改。
- 提交信息遵循仓库现有 conventional 风格（`feat|fix|test|docs(scope): 中文描述`）。
- 工作分支：`feat/remove-claude-provider`（已创建）。Part B 可在同分支继续，也可合入后另开 `feat/codex-app-server`。

## 已验证事实（方案撰写时实测，执行者可直接信赖）

1. **实时库无 claude 行**：`ship.db` 的 `changes` / `provider_run_processes` / `change_provider_sessions` 全部只有 `codex`。backfill 是纯防御性的。
2. **Task A1 的迁移已在临时库上试跑通过**（完整 28 个迁移全部 applied）。
3. **`server/db/migrate.test.ts:449` 有写死的迁移计数断言**：新增 0027 后该断言 `28 !== 27` 失败，必须把期望值 27 改成 28。
4. **App Server 与 CLI 同一二进制**：`codex app-server` 是 `codex` 的子命令，`STAGEPASS_CODEX_BIN` 现有解析逻辑可直接复用。
5. **crash-resilience 的 hung/offline 型 fixture 是协议无关的**（挂死 = 不输出任何东西；离线 = 立即非零退出），Part A 把它们从 claude 改到 codex 后，Part B 不需要再动它们；只有需要"成功完成"的 fixture 才要讲 app-server 协议。

---

# Part A：删除 Claude，收敛单 Provider

> 影响面来源：2026-07-23 全仓盘点。约 60+ 文件，净删 ~3000 行，改写 ~1500 行。
> 顺序有依赖：A1（数据兼容）必须先于 A3（枚举收窄）；A2 先删文件让后续编译错误集中出现；A3 用 `tsc --noEmit` 当清单生成器。

### Task A1: backfill 迁移 provider claude→codex

**Files:**
- Create: `server/db/migrations/0027_provider_codex_backfill.sql`
- Modify: `server/db/migrations/meta/_journal.json`（追加 entry）
- Modify: `server/db/migrate.test.ts:449`（迁移计数 27→28）

**Interfaces:**
- Produces: 数据库中不再存在任何 `provider='claude'` 行 → A3 的 Zod 枚举收窄对历史库安全。

- [x] **Step 1: 写迁移 SQL**（内容已实测可用）：

```sql
-- server/db/migrations/0027_provider_codex_backfill.sql
-- Converge historical provider values to codex before the AiProvider enum narrows.
-- Claude sessions are deleted (a Claude session id cannot be resumed by Codex);
-- all other rows are relabeled so strict read-path validation keeps accepting them.
DELETE FROM `change_provider_sessions` WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `projects` SET `context_provider` = 'codex' WHERE `context_provider` = 'claude';
--> statement-breakpoint
UPDATE `projects` SET `prd_provider` = 'codex' WHERE `prd_provider` = 'claude';
--> statement-breakpoint
UPDATE `changes` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `runs` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `provider_run_processes` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `pipeline_jobs` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `review_attempts` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `stage_runs` SET `provider` = 'codex' WHERE `provider` = 'claude';
```

注意：`change_provider_sessions` 的主键是 `(change_id, provider, session_kind)`，claude 行改成 codex 可能撞主键，且 Claude session id 对 Codex 无恢复价值，所以是 DELETE 不是 UPDATE。8 张表、9 个 provider 列的清单已核对过 `schema.ts`（projects 两列、changes、runs、provider_run_processes、pipeline_jobs、change_provider_sessions、review_attempts、stage_runs）；`events` 表**没有** provider 列。

- [x] **Step 2: 追加 journal entry**（`_journal.json` 的 `entries` 数组末尾）：

```json
{ "idx": 27, "version": "7", "when": 1784764800000, "tag": "0027_provider_codex_backfill", "breakpoints": true }
```

- [x] **Step 3: 修计数断言**：`server/db/migrate.test.ts:449` 的期望值 `27` → `28`（"is idempotent when run repeatedly" 测试）。

- [x] **Step 4: 临时库验证迁移**

```bash
DB=$(mktemp -d)/t.db
STAGEPASS_DB_PATH=$DB npx tsx scripts/migrate-db.ts
```
Expected: JSON 日志 `database_migrated`，`applied` 数组末尾是 `0027_provider_codex_backfill`。

- [x] **Step 5: 跑迁移测试**

```bash
pnpm test server/db/migrate.test.ts server/services/db-migrations.test.ts
```
Expected: `ℹ fail 0`、`ℹ cancelled 0`。（db-migrations.test.ts 若也有计数/清单断言，同样更新。）

- [x] **Step 6: Commit** — `git commit -m "feat(db): backfill provider claude→codex 为枚举收窄铺路"`

### Task A2: 删除 claude-engine、依赖与注入配置

**Files:**
- Delete: `server/services/claude-engine.ts`（1210 行）、`server/services/claude-engine.test.ts`（1427 行）
- Modify: `server/services/ai-engine-adapter.ts`（去 claude loader）、`package.json`（去 `@anthropic-ai/claude-code`）、`.env.example:16-18`（去 ANTHROPIC_API_KEY 块）
- Modify: `server/services/acceptance-injection-service.ts:7,50`（删 `claudeTransportBin` 字段与 `claude_transport_invalid` 错误码）

**Interfaces:**
- Produces: `getAiEngine()` 仅返回 codex 引擎；`AiEngineLoader` 机制保留（测试注入仍用 `setAiEngineLoaderForTest`）。

- [x] **Step 1: 删文件**

```bash
git rm server/services/claude-engine.ts server/services/claude-engine.test.ts
```

- [x] **Step 2: 改写 `ai-engine-adapter.ts`**（52 行 → 简化；保留懒加载注释理由与测试注入口，签名不再需要 provider 参数，但为减少本 Task 的波及面，**暂时保留参数**，A4 再统一收窄签名）：

```typescript
import type { AiEngineAdapter, AiProvider } from "./ai-engine-types";

type AiEngineLoader = () => AiEngineAdapter;

/**
 * The require() is deliberate: it defers loading codex-cli-engine (which
 * lazily spawns the codex CLI) until an engine is actually requested, and
 * keeps getAiEngine synchronous. Keep the sync require until the engine API
 * is intentionally made async.
 */
const defaultLoader: AiEngineLoader = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCodexCliEngine } = require("./codex-cli-engine");
  return getCodexCliEngine();
};

let loaderOverride: AiEngineLoader | null = null;

export function getAiEngine(_provider?: AiProvider): AiEngineAdapter {
  return (loaderOverride ?? defaultLoader)();
}

export function setAiEngineLoaderForTest(
  _provider: AiProvider,
  loader: AiEngineLoader | null,
): () => void {
  const previous = loaderOverride;
  loaderOverride = loader;
  return () => {
    loaderOverride = previous;
  };
}
```

- [x] **Step 3: `package.json` 删依赖行 + `pnpm install` 刷 lockfile**；`.env.example` 删 `ANTHROPIC_API_KEY` 注释块（保留 `STAGEPASS_CODEX_BIN`）。
- [x] **Step 4: `acceptance-injection-service.ts`** 删 `claudeTransportBin` 字段、其解析逻辑与 `claude_transport_invalid` 错误码（消费者 claude-engine.ts:83 已删）。同文件 codex 侧注入保持不动。
- [x] **Step 5: 跑 `pnpm test server/services/ai-engine-adapter.test.ts`** — 预期**失败**（双引擎断言还在），这是 A8 的输入；先跑 `npx tsc --noEmit` 收集编译错误清单，确认只剩 claude 相关引用报错。
- [x] **Step 6: Commit** — `git commit -m "feat(engine): 删除 claude-engine 与依赖，引擎适配器收敛为 codex 单载入"`

### Task A3: 收窄 AiProvider 类型，清理死分支

**Files:**
- Modify: `server/types/enums.ts:7`、`server/services/ai-engine-types.ts:8`
- Modify: 全部 `"codex" | "claude"` 字面量联合（~15 处）：`app/projects/[id]/changes/[changeId]/pipeline-action-contract.ts:19`、`server/services/action-contract-types.ts:15`、`server/services/provider-run-lifecycle-service.ts:53`、`stage-ai-output-contract.ts` 等——统一改引用 `AiProvider` 类型而不是各自内联联合
- Modify: 内联死分支清单（改成常量 `"codex"` 并删条件）：`server/services/recovery-executors.ts:307`、`pipeline-review-stage-service.ts:663`、`job-dispatch-service.ts:275`、`pipeline-job-types.ts:108`、`action-contract-service.ts:194,262`、`pipeline-build-stage-service.ts:418,829,1120`（`provider as "codex" | "claude"` 强转）、`pipeline-plan-stage-service.ts:256`、`pipeline-document-stage-runner-service.ts:622`（注释里的 Claude slot 说明一并更新）

**Interfaces:**
- Produces: `export const AiProvider = z.enum(["codex"])`；全仓类型层不存在 `"claude"` 字面量。

- [x] **Step 1: 收窄两处真源**：

```typescript
// server/types/enums.ts:7
export const AiProvider = z.enum(["codex"]);
// server/services/ai-engine-types.ts:8
export type AiProvider = "codex";
```

- [x] **Step 2: `npx tsc --noEmit` 生成错误清单**，逐个修复：`"claude"` 字面量赋值处删除或改 `"codex"`；`=== "claude" ? A : B` 三元全部塌缩成 B 并删除条件。上面 Files 列出的行号是盘点已知点，tsc 会找出剩余的。
- [x] **Step 3: tsc 清零后跑最相关服务测试**：

```bash
pnpm test server/services/pipeline-engine-service.test.ts server/services/provider-run-lifecycle-service.test.ts server/services/recovery-predicates.test.ts
```
Expected: 此时可能仍有 fixture 用 `"claude"` 的失败——记录清单，留给 A8；**编译类错误必须此步清零**。
- [x] **Step 4: Commit** — `git commit -m "feat(types): AiProvider 收窄为 codex 单值，塌缩全部 claude 死分支"`

### Task A4: 简化 provider 选择服务与 API

**Files:**
- Delete: `server/services/ai-provider-service.ts`（15 行，与 provider-selection-service 功能重复）+ `ai-provider-service.test.ts`
- Modify: `server/services/provider-selection-service.ts`（74 行）：保留 `PROVIDER_BACKED_ACTION_IDS` / `isProviderBackedAction`（其它服务在用）；`parseRequestedProvider` 收窄后仍保留——它现在的职责是**拒绝**任何非 "codex" 输入（错误信息改为 "provider must be codex"）；删 `assertProviderApplicable` 若无调用方，保留若有（tsc/grep 确认）
- Modify: `server/services/pipeline-engine-service.ts:25,202`（`EngineProvider` 收窄、`assertLifecycleProvider` 简化）
- Modify: `server/services/provider-session-service.ts:35`（删 claude 分支，注释改为"历史上此字段也存过 Claude session，0027 迁移已清除"）
- Modify: `app/api/projects/[id]/changes/route.ts:12`（`provider` 请求字段：保留但只接受 "codex"，或直接删除字段——**决定：删除字段**，客户端不再传 provider；Zod schema 去掉该 key）
- Modify: `server/services/ai-provider-service.ts` 的调用方改为直接用 `resolveProviderSelection` 或常量

- [x] **Step 1: 先 grep 调用方**：`grep -rn "ai-provider-service\|resolveProvider\|shouldPersistProvider\|assertProviderApplicable" server app --include="*.ts" --include="*.tsx"`，据实决定删除/保留。
- [x] **Step 2: 按上述 Files 修改**；`resolveProviderSelection(requested, changeDefault)` 保留签名但实现退化为 `return "codex"`——**不删函数**：调用点多，签名稳定比省 3 行值钱（YAGNI 的反面是无谓的调用点手术）。
- [x] **Step 3: 跑 `pnpm test server/services/provider-selection-service.test.ts`**（断言 parse claude 的用例此时改掉——它属于本 Task 不是 A8：断言从"接受 claude"改为"拒绝 claude 报 invalid_provider"）。Expected: `ℹ fail 0`。
- [x] **Step 4: Commit** — `git commit -m "feat(provider): 选择服务退化为 codex 常量，API 不再接受 provider 字段"`

### Task A5: 清理 UI provider 传递链与选择控件

**Files:**
- Delete: `app/projects/[id]/changes/[changeId]/provider-picker.tsx`（49 行）+ `provider-picker.test.ts`（41 行）
- Modify（删 Claude `<option>`/按钮/下拉整件控件）: `app/projects/[id]/page.tsx:116-117,352-357,423-429`、`app/projects/create-project-dialog.tsx:33-34,126-142`、`app/projects/[id]/create-change-dialog.tsx:35,111-118`、`app/projects/[id]/prd-editor.tsx:24-25,438-452`
- Modify（删 provider 显示文案）: `app/projects/[id]/changes/[changeId]/pipeline-page-shell.tsx:167-177`
- Modify（去 `selectedProvider` 传递链）: `pipeline-action-contract.ts:15-22,65`、`use-pipeline-actions.ts`、`use-change-commands.ts`、`pipeline-action-runner.ts`、`stage-action-bar.tsx`、`phase-stage-shell.tsx`、`stage-frame.tsx`、`refine-chat-panel.tsx`、`build-sandbox.tsx`、`prd-briefing-room.tsx`、`review-report-center.tsx`、`app/projects/[id]/changes/[changeId]/page.tsx:203`

**统一手法**：从叶子组件（picker）往上删——先删组件，再让 tsc 报"属性不存在/未使用"逐层剥 `selectedProvider` prop 与 state；请求体不再携带 `provider` 键（与 A4 的 API 收窄对齐）。

- [x] **Step 1: 删 picker 组件与测试**；`npx tsc --noEmit` 逐层清 prop 链直至清零。
- [x] **Step 2: 跑 UI 相关测试**：

```bash
pnpm test app/projects/[id]/changes/[changeId]/build-action-policy.test.ts app/projects/[id]/changes/[changeId]/pipeline-action-runner.test.ts app/projects/[id]/changes/[changeId]/prd-briefing-job-scope.test.ts
```
Expected: `ℹ fail 0`（注意路径里的 `[id]`，必须经 `pnpm test` 的 `escapeGlobLiteral`，不能裸跑）。
- [x] **Step 3: 手工冒烟**：`pnpm dev` 起 supervisor，浏览器确认项目页/Change 页无 Provider 字样、创建 Change 流程可用。
- [x] **Step 4: Commit** — `git commit -m "feat(web): 移除 Provider 选择控件与 selectedProvider 传递链"`

### Task A6: commit-message-service 切换到 codex

**Files:**
- Modify: `server/services/commit-message-service.ts`（81 行）

**Interfaces:**
- Consumes: 现有 `suggestCommitMessage(repoPath, context?)` 签名不变；模板 `server/templates/prompts/commit-message.md` 不变。
- Produces: 不再依赖外部 `claude` CLI；改用 `codex exec` 一次性调用（App Server 迁移后此处保持 exec——一次性无状态小任务用 exec 是合理的，不走引擎）。

- [x] **Step 1: 改写 claude 调用为 codex**（保留全部 fallback 逻辑与超时；bin 解析对齐 codex-cli-engine 的 `STAGEPASS_CODEX_BIN` 惯例）：

```typescript
function getCodexBin(): string {
  const fromEnv = process.env.STAGEPASS_CODEX_BIN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync("which codex", {
      encoding: "utf-8",
      timeout: CLI_DISCOVERY_TIMEOUT_MS,
    }).trim();
  } catch {
    return "codex";
  }
}
```

调用处替换为（`--output-last-message` 拿最终答复，避免解析进度输出；stdin 传 prompt 对齐引擎惯例）：

```typescript
const outFile = path.join(os.tmpdir(), `stagepass-commit-msg-${process.pid}-${Date.now()}.txt`);
try {
  const result = spawnSync(getCodexBin(), [
    "exec",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--cd", repoPath,
    "--output-last-message", outFile,
    "-",
  ], {
    cwd: repoPath,
    input: prompt,
    encoding: "utf-8",
    stdio: ["pipe", "ignore", "pipe"],
    timeout: AI_COMMAND_TIMEOUT_MS,
  });
  if (result.status === 0 && fs.existsSync(outFile)) {
    const output = fs.readFileSync(outFile, "utf-8").trim();
    // 沿用原有 ``` 剥离与 0<len<500 校验
  }
} finally {
  fs.rmSync(outFile, { force: true });
}
```

（注意：`codex exec` 的 prompt 位置参数为 `-` 时读 stdin；执行时用 `codex exec --help` 复核当前版本旗标，若无 `-` 约定则把 prompt 作为位置参数传入。）
- [x] **Step 2: 若无现成测试，补一个**：mock `STAGEPASS_CODEX_BIN` 指向假脚本（echo 固定 message 到 `--output-last-message` 目标文件），断言成功路径与 fallback 路径（假脚本 exit 1 → `chore: update N files`）。
- [x] **Step 3: `pnpm test server/services/commit-message-service.test.ts`** → `ℹ fail 0`；**新测试若写库需登记 db-write-policy.json**（此服务不写库，预计不用）。
- [x] **Step 4: Commit** — `git commit -m "feat(git): commit message 生成从 claude CLI 切换到 codex exec"`

### Task A7: crash-resilience 框架 claude fixture 改 codex

**Files:**
- Modify: `server/services/crash-resilience-harness.ts`（1319 行；`:807` hung-claude-transport、`:1031` offline-claude-transport、`:1223` `getPipelineEngine("claude")`）
- Modify: `server/services/crash-resilience-acceptance.test.ts:51`、`scripts/acceptance-crash-resilience.ts`

**要点（已验证）**：hung（挂死不输出）与 offline（立即非零退出）fixture 是协议无关的假二进制，改名/改注入点从 `STAGEPASS_CLAUDE_TRANSPORT_BIN` 到 codex 侧注入（`STAGEPASS_CODEX_BIN` 指向假脚本）即可，**不需要**讲 exec 协议；Part B 也不需要再改它们。

- [x] **Step 1**: 全文件搜 `claude`，逐个场景把被杀/挂死进程 fixture 换成 codex 注入；`getPipelineEngine("claude")` 改 `getPipelineEngine("codex")`；场景名 `hung-claude-transport` → `hung-codex-transport` 等。
- [x] **Step 2**: `pnpm test server/services/crash-resilience-acceptance.test.ts` → `ℹ fail 0`、`ℹ cancelled 0`（**套件级 timeout 会静默取消尾部测试，cancelled 必须看**）。
- [x] **Step 3: Commit** — `git commit -m "test(crash): 崩溃演练 fixture 从 claude transport 收敛到 codex"`

### Task A8: 改写受影响测试的 claude fixture

**Files（改 fixture "claude"→"codex" 或删双 provider 断言）：**
- `server/services/ai-engine-adapter.test.ts:62-94`（双引擎断言 → 单引擎 + loader 注入断言）
- `server/services/provider-session-service.test.ts:82-116`（legacy claude session 用例改为"0027 后不存在"语义）
- `server/services/provider-process-lease-service.test.ts:188-218`、`provider-worker-protocol.test.ts:239`
- `server/services/stale-provider-run-recovery-service.test.ts:236,328,385,545,713,964,1035,4654`（`:2935` "derives synthetic provider from Codex change instead of hard-coding Claude" 这条**保留并简化**——它恰好验证收敛后的行为）
- `server/services/job-dispatch-service.test.ts:207-298`、`pipeline-service.test.ts:6697,8869,9089,9575,9850`
- `pipeline-job-runner-service.test.ts:72-80`、`change-service.test.ts:233`、`action-contract-self-heal-service.test.ts:15`、`stage-ai-output-ingestion-service.test.ts:45`、`prd-briefing-service.test.ts:869,934`、`prd-service.test.ts:1042-1222`、`static-analyzer.test.ts:54`、`next-stage-handoff.test.ts:77-128`、`pipeline-action-runner.test.ts:279-285`
- **保留不动**：`server/db/migrate.test.ts:423-434`（0019 backfill 历史测试，恰是数据兼容证据）；`ai-timeout-policy.test.ts`（仅函数名含 Provider，无 claude）

- [x] **Step 1**: 逐文件修改；判据统一为——测试意图是"多 provider 分派"的删用例，意图是"provider 无关行为恰好用 claude 做 fixture"的改成 codex。
- [x] **Step 2**: 删除的测试文件（ai-provider-service.test.ts、provider-picker.test.ts、claude-engine.test.ts）若在 `db-write-policy.json` `testFixtures` 里有条目则移除，重跑 `npx tsx scripts/generate-db-write-inventory-snapshot.ts`。
- [x] **Step 3**: `pnpm test`（全量）→ `ℹ fail 0`、`ℹ cancelled 0`。**别把输出管给 `tail`，重定向到文件再 grep 计数行**。
- [x] **Step 4: Commit** — `git commit -m "test(provider): 测试 fixture 收敛为 codex 单 provider"`

### Task A9: 活文档去双 Provider

**Files:**
- Modify: `README.md`、`README.zh-CN.md`、`docs/ship/prd.json:418`、`docs/ship/prd.md`、`docs/ship/architecture.md`、`docs/ship/tech-stack.md`、`docs/ship/file-guide.md`、`docs/ship/prd-sources.md`、`docs/ship/coding-rules.md`、`docs/data-model.md`、`docs/project-codebase-overview.md`、`docs/error-codes.md`（`claude_transport_invalid` 等已删错误码）
- 不改：`docs/superpowers/plans|specs/*`、`docs/HANDOFF-*`、`docs/DESIGN-*`（历史决策记录）

- [x] **Step 1**: `grep -rlia claude README.md README.zh-CN.md docs/ship docs/data-model.md docs/project-codebase-overview.md docs/error-codes.md` 逐文件清理双 Provider 表述，改为 Codex 单链路。
- [x] **Step 2: Commit** — `git commit -m "docs: 活文档收敛为 Codex 单 Provider 表述"`

### Task A10: 终验与残留审计

- [x] **Step 1**: `npx tsc --noEmit` → 0 错误。
- [x] **Step 2**: 全量 `pnpm test > /tmp/a10.log 2>&1`，`grep -aE "ℹ (fail|cancelled)" /tmp/a10.log` → 均为 0。
- [x] **Step 3**: 残留审计（**必须 `-a`**，覆盖 NUL 文件）：

```bash
grep -rnia claude server app lib scripts --include="*.ts" --include="*.tsx" --include="*.json" | grep -va "migrations/0019\|migrate.test\|_journal"
```
Expected: 仅剩历史迁移/其测试的合法命中；其余为 0。`package.json`/`pnpm-lock.yaml` 无 anthropic。
- [x] **Step 4**: 验收对照需求文档 §12：条目 5（仅 Codex 链路）、6（不见 Claude/Provider 选择）达成；条目 1、2、8–17 无回退。
- [x] **Step 5: Commit**（如有残修）+ 在分支上留 `docs/superpowers/plans/` 本文件的勾选状态。

---

# Part B：Codex 传输层 exec → App Server

> 动机：真 token 级流式（`item/agentMessage/delta`）、协议级中断（`turn/interrupt`）、模型与推理强度可控（`turn/start` 的 `model`/`effort` + `model/list`，直接解锁需求文档 6.2/12.7）、会话原生管理（`thread/resume` 支持逐 turn 覆盖 sandbox——顺带解决 exec `resume` 继承原会话 sandbox 导致 write 阶段不能 resume 的已知约束，见 codex-cli-engine.ts:150-174 注释）。
>
> **进程模型决定（本方案的核心取舍）**：每个 run 仍旧 spawn 一个独立的 `codex app-server` 子进程，run 结束即退出。理由：完整保留 `provider_run_processes` 的 per-run pid 语义、进程租约/围栏（lease/fencing）、心跳与崩溃恢复的全部现有机制——这套机制是 Stage Pass 可靠性的根基，共享常驻服务会把"一个 run 一个进程一个租约"的模型推翻，属于另一个 Change 的范围。常驻共享 app-server（连接复用、跨 run steering）列为未来可选优化，本方案不做。

## App Server 协议速查（Codex CLI 0.144.4；以 `codex app-server generate-json-schema` 生成的 schema 为准）

- 启动：`codex app-server`（stdio JSONL）；消息为 JSON-RPC 2.0（wire 上省略 `"jsonrpc":"2.0"`），request 带 `id`/`method`/`params`，notification 无 `id`。
- 握手：`initialize` 必须首调，且 params 必须含 `clientInfo: { name, version }`；`capabilities.experimentalApi` 可选，本方案不开启；成功后发送 `initialized` 通知。
- `thread/start`：`cwd`、`model`、`approvalPolicy`，以及 legacy `sandbox: "read-only"|"workspace-write"|"danger-full-access"`；`thread/resume` 需要 `threadId` 并支持同类覆盖。0.144.4 的稳定 schema 没有 `permissions` 字段。
- `turn/start`：必填 `threadId` 与 `input: [{type:"text", text}]`；可逐 turn 覆盖 `model`、`effort`、`cwd`、`approvalPolicy`、`outputSchema` 与 `sandboxPolicy`。`sandboxPolicy.type` 使用 camelCase：`readOnly|workspaceWrite|dangerFullAccess`。
- 其它核心方法：`turn/interrupt`（必填 `threadId`、`turnId`）、`model/list`（响应 `data[]`，模型含 `supportedReasoningEfforts`/`defaultReasoningEffort`/`isDefault`）。
- 关键通知：`thread/started {thread:{id}}`、`turn/started`、`item/started`、`item/completed`、增量流 `item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/commandExecution/outputDelta`、`turn/diff/updated`、`turn/completed {threadId,turn}`（`turn.status: completed|interrupted|failed|inProgress`）、`thread/tokenUsage/updated`。
- 服务端反向请求（需应答）：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 等——应答 `accept|acceptForSession|decline|cancel`。
- item 类型命名是 camelCase：`agentMessage`/`commandExecution`/`fileChange`/`reasoning`/`mcpToolCall` 等（exec `--json` 旧流是 snake_case `agent_message` 等——**必须归一化**）。
- 过载错误：JSON-RPC error `-32001`（"Server overloaded; retry later"）。
- Schema 生成：`codex app-server generate-ts --out ./schemas`（与二进制版本严格对应）。

### Task B0: 版本锚定与协议 schema 固化

- [x] **Step 1**: `codex --version` 记录版本；`codex app-server generate-json-schema --out /tmp/codex-schemas` 成功执行即证明子命令可用。
- [x] **Step 2**: 把版本floor写进 `.env.example` 注释（`STAGEPASS_CODEX_BIN` 旁）与 `docs/ship/tech-stack.md`；核对速查表中的方法名/参数casing与生成 schema 一致，不一致以 schema 为准并更新本文件。
- [x] **Step 3: Commit** — `git commit -m "docs(codex): 锚定 app-server 协议版本与 schema 生成流程"`

### Task B1: JSON-RPC 协议客户端

**Files:**
- Create: `server/services/codex-app-server-client.ts`
- Test: `server/services/codex-app-server-client.test.ts`
- Create(test fixture): `server/services/__fixtures__/fake-codex-app-server.cjs`

**Interfaces（Produces，B2 依赖）：**

```typescript
export interface AppServerClientOptions {
  bin: string;                    // codex 可执行文件路径
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onNotification: (method: string, params: Record<string, unknown>) => void;
  /** 服务端反向请求（审批等）；返回值作为 response.result 回写 */
  onServerRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onStderr?: (chunk: string) => void;
}

export class CodexAppServerClient {
  static spawn(options: AppServerClientOptions): CodexAppServerClient;
  readonly pid: number | null;
  /** initialize + initialized 握手；失败抛 CodexAppServerError */
  initialize(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  /** 等子进程退出（带 grace 上限），返回 {code, signal} */
  close(graceMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}
export class CodexAppServerError extends Error {
  readonly code: number | null;      // JSON-RPC error code（-32001 = overloaded）
  readonly data?: unknown;
}
```

实现要点：`spawn(bin, ["app-server"], {cwd, stdio:["pipe","pipe","pipe"]})`；stdout 按行 split 解析 JSON（沿用 codex-cli-engine 现有的行缓冲手法）；`id` 自增整数做 request/response 关联；带 `id`+`method` 的入站消息是**服务端反向请求**，路由到 `onServerRequest` 并把结果以 `{id, result}` 回写 stdin；无 `id` 的是通知，路由 `onNotification`；解析失败的行走 `onStderr` 同款告警日志不中断流。secrets 过滤复用 `sanitizeCodexErrorMessage`。

- [x] **Step 1: 写假 app-server fixture**（`fake-codex-app-server.cjs`，node 可执行脚本）：读 stdin 按行解析；对 `initialize` 回 `{id, result:{}}`；对 `thread/start` 回 `{id, result:{thread:{id:"THREAD-1"}}}` 并发 `thread/started` 通知；对 `turn/start` 依次发 `turn/started`、`item/started`(agentMessage)、两条 `item/agentMessage/delta`、`item/completed`、`turn/completed`，再回 `{id, result:{}}`。支持环境变量 `FAKE_MODE=hang|exit1|approval` 切换行为（approval 模式发一条 `item/commandExecution/requestApproval` 反向请求并断言收到 decline）。
- [x] **Step 2: 写失败测试**：spawn fake → initialize → thread/start → 断言通知回调收到 `thread/started`；`FAKE_MODE=exit1` 断言 request 拒绝且 `close()` 返回 code 1；`FAKE_MODE=approval` 断言 `onServerRequest` 被调用且应答回写。Run: `pnpm test server/services/codex-app-server-client.test.ts` → 先 FAIL（模块不存在）。
- [x] **Step 3: 实现客户端** → 同命令测试 PASS（`ℹ fail 0`）。
- [x] **Step 4: Commit** — `git commit -m "feat(codex): app-server JSON-RPC stdio 协议客户端"`

### Task B2: App Server 引擎（实现 AiEngineAdapter）

**Files:**
- Create: `server/services/codex-app-server-engine.ts`
- Test: `server/services/codex-app-server-engine.test.ts`（复用 B1 fixture）
- Modify: `server/services/codex-cli-engine.ts`（`getCodexCliEngine()` 工厂改为返回新引擎；exec 路径本 Task 保留，B4 删）

**Interfaces:**
- Consumes: B1 的 `CodexAppServerClient`；现有 `AiRunInput`/`AiRunResult`/`AiStreamEvent`/`AiRunLifecycleSink`（`ai-engine-types.ts`，签名不变——这是本迁移的硬边界，管道层零改动）。
- Produces: `export function getCodexAppServerEngine(): AiEngineAdapter`。

**逐项映射（run/runStreamed 的实现规格）：**

| 现 exec 行为 | App Server 对应 |
|---|---|
| spawn `codex exec --json`，prompt 走 stdin | spawn `codex app-server` → `initialize` → `thread/start` 或 `thread/resume` → `turn/start`（prompt 为 input） |
| `--sandbox <mode>` | 新 thread 的 `thread/start.sandbox` 仍用 `"read-only"|"workspace-write"|"danger-full-access"`；逐 turn 覆盖用 `turn/start.sandboxPolicy: {type:"readOnly"|"workspaceWrite"|"dangerFullAccess"}` |
| `--cd <repoPath>` | `thread/start.cwd` |
| `--output-schema <file>`（临时文件） | `turn/start.outputSchema`（内联 JSON，**删掉临时文件机制** `createCodexOutputSchemaFile`；`parseStructuredOutputText` 文本兜底保留） |
| resume 继承 sandbox（write 阶段禁 resume） | `thread/resume` + `turn/start` 逐 turn sandbox 覆盖。**本 Task 保持现有"write 阶段不 resume"策略不变**（行为零漂移）；解禁另立后续 Change |
| 无审批（sandbox 兜底） | `thread/start.approvalPolicy: "never"` + `onServerRequest` 默认应答 `decline` 并记 warn 日志（双保险） |
| JSONL 事件 `thread.started/item.*/turn.completed`（snake_case item） | 通知归一化层（见下） |
| 心跳：wall-clock 定时器 `startCodexHeartbeat` | **原样保留**（契约不变；App Server 通知只作为额外活性证据，不替代定时器） |
| `CodexRunFailure` 错误分类、`CODEX_TRANSPORT_ERROR_MARKERS`、stderrTail、exitCode/signal 采集 | 原样沿用；新增 `-32001` → `providerErrorCode: "provider_overloaded"`（error-codes.md 登记） |
| `.codex/agents/*.toml` 多 agent 文件（`ensureAgentFiles`） | 原样保留（文件机制与传输无关） |
| 超时 `timeoutMs` | 定时器到期 → `turn/interrupt` → grace 后 `kill()`；错误码仍 `provider_timeout` |

**通知归一化（新引擎内私有函数 `toLegacyStreamEvent`）**：
- `thread/started {thread:{id}}` → `{type:"thread.started", threadId: thread.id}`
- `item/started|completed {item}` → `{type:"item.started"|"item.completed", item: normalizeItem(item)}`；`normalizeItem` 做类型名映射 `agentMessage→agent_message`、`commandExecution→command_execution`、`fileChange→file_change`（`reasoning` 不变），其余字段透传
- `item/agentMessage/delta {delta}` → `{type:"item.updated", item:{type:"agent_message", text:<累计文本>}}`（引擎内按 itemId 累计）
- `item/commandExecution/outputDelta`、`item/reasoning/summaryTextDelta` 同理归并到 `item.updated`
- `turn/completed {threadId,turn}` → `{type:"turn.completed", usage:<最近一次 tokenUsage>}`；读取 `turn.status`，`"failed"` 走 `CodexRunFailure`，`"interrupted"` 走 stopped 语义；usage 来自独立的 `thread/tokenUsage/updated` 通知
- `turn/diff/updated` → 透传新事件类型 `"turn.diff.updated"`（`AiStreamEvent` 的开放联合已允许；changedFiles 仍以 `file_change` item 提取为准，diff 事件仅供展示层）

- [x] **Step 1: 写失败测试**（fixture 驱动）：`run()` 返回 `AiRunResult{ threadId:"THREAD-1", summary:<两条 delta 拼接>, success:true }`；`runStreamed()` 产出事件序列首个为 `thread.started`、含 `item.completed`(agent_message)、末为 `turn.completed`；lifecycle sink 收到 `onProcessStarted`（pid 非空）与 `onTerminal(completed)`；`FAKE_MODE=exit1` → `success:false` 且 `providerErrorCode` 非空。Run → FAIL。
- [x] **Step 2: 实现引擎** → PASS。
- [x] **Step 3**: `getCodexCliEngine()` 工厂切换为返回 app-server 引擎（保持导出名，调用方零改动）；跑引擎全测试：`pnpm test server/services/codex-app-server-client.test.ts server/services/codex-app-server-engine.test.ts server/services/codex-cli-engine.test.ts` —— 旧 exec 单测中纯测 `buildCodexArgs` 等 exec 细节的用例此时标记随 B4 删除，先确认不阻塞。
- [x] **Step 4: Commit** — `git commit -m "feat(codex): App Server 引擎上线，工厂切换，exec 路径待删"`

### Task B3: 模型与推理强度贯通（解锁需求 6.2 的引擎层）

**Files:**
- Modify: `server/services/ai-engine-types.ts`（`AiRunInput` 增加可选 `model?: string; reasoningEffort?: "low"|"medium"|"high"`）
- Modify: `server/services/codex-app-server-engine.ts`（透传到 `turn/start` 的 `model`/`effort`）
- Create: `server/services/codex-model-catalog-service.ts`（spawn 短命 app-server 调 `model/list`，带 TTL 缓存）+ 测试（fixture 增加 `model/list` 应答）
- Modify: `server/services/ai-timeout-policy.ts` 若按 phase 配置——不动；模型默认值不在本 Task 定策略，管道层暂不传参（UI/Change 级配置属需求 6.2 的独立 Change）

- [x] **Step 1**: 失败测试：`turn/start` 请求体含 `model:"gpt-x"`/`effort:"high"`（fixture 断言收到）；`listCodexModels()` 返回 fixture 目录。→ 实现 → PASS。
- [x] **Step 2: Commit** — `git commit -m "feat(codex): 引擎透传 model/effort，模型目录服务就绪"`

### Task B4: 删除 exec 传输路径

**Files:**
- Modify: `server/services/codex-cli-engine.ts` —— 删 `buildCodexArgs`、`spawnAndCollect`、exec 专属 JSONL 解析与 `createCodexOutputSchemaFile`；保留并迁出仍被共用的部分（`sanitizeCodexErrorMessage`、`codexStderrTail`、心跳、错误分类、agents TOML 机制）到 `codex-app-server-engine.ts` 或独立 `codex-engine-shared.ts`；文件最终只剩 `getCodexCliEngine` 兼容导出或整个更名删除（更名则全仓改 import）
- Modify: `server/services/codex-cli-engine.test.ts` / `codex-cli-engine.run.test.ts` —— exec 细节用例删除，共享工具用例迁移
- **决定**：保留文件名 `codex-cli-engine.ts` 作薄壳转发（`export { getCodexAppServerEngine as getCodexCliEngine }`）**不採用**——直接全仓改 import 到新名字，避免永久双名。`grep -rn "codex-cli-engine" server app scripts` 逐个改。

- [ ] **Step 1**: 迁移共享工具 → 改 import → 删 exec 代码与测试。
- [ ] **Step 2**: `npx tsc --noEmit` 清零；`pnpm test`（全量重定向文件）→ `ℹ fail 0`、`ℹ cancelled 0`。
- [ ] **Step 3: Commit** — `git commit -m "refactor(codex): 删除 exec 传输路径，App Server 成为唯一链路"`

### Task B5: 崩溃恢复与验收链路复核

**Files:**
- 复核（预期多数不改）：`stale-provider-run-recovery-service.ts`、`recovery-executors.ts`、`provider-process-lease-service.ts`、`supervisor-health-service.ts`、`crash-resilience-harness.ts`
- Modify: `server/services/acceptance-injection-service.ts` —— codex 注入点语义从"exec 假二进制"变为"app-server 假二进制"，A7 改过的 hung/offline fixture 协议无关、直接可用；若 harness 有"成功完成"型 codex fixture，替换为 B1 的 `fake-codex-app-server.cjs`

- [ ] **Step 1**: `pnpm test server/services/crash-resilience-acceptance.test.ts server/services/stale-provider-run-recovery-service.test.ts server/services/pipeline-crash-window.test.ts` → `ℹ fail 0`、`ℹ cancelled 0`。
- [ ] **Step 2**: 手动演练一次 `scripts/acceptance-crash-resilience.ts`（隔离库）确认 supervisor 杀/重启路径在新进程形态下语义不变（pid 仍每 run 唯一）。
- [ ] **Step 3: Commit**（如有修改）— `git commit -m "test(recovery): 崩溃恢复链路在 app-server 进程形态下复验"`

### Task B6: 真机冒烟 + 文档收尾

- [ ] **Step 1**: 真 codex CLI（非 fixture）在测试项目上跑一个最小 Change 的 PRD 阶段：`pnpm dev` 起 supervisor，浏览器发起 run，确认流式输出逐段出现在 Web、`provider_run_processes` 行有 pid 与 exit_code、事件里出现 delta 归一化后的 `item.updated`。
- [ ] **Step 2**: `docs/ship/architecture.md`、`docs/ship/tech-stack.md`、`docs/error-codes.md`（新增 `provider_overloaded`）、`.env.example` 更新为 App Server 表述；需求文档 §6.2 的"现状"注记更新（引擎层已支持 model/effort，UI 待独立 Change）。
- [ ] **Step 3**: 全量 `pnpm test` 终验（计数为准）+ `npx tsc --noEmit`。
- [ ] **Step 4: Commit** — `git commit -m "docs(codex): App Server 迁移收尾，冒烟证据与文档同步"`

---

## 验收对照（需求文档 §12）

| 条目 | 由哪个 Task 达成 |
|---|---|
| 5 只存在 Codex 一条链路 | A2/A3/A6/A7 |
| 6 不再看到 Claude/Provider 选择 | A4/A5 |
| 7 可为 Codex 选模型和推理强度 | B3 达成引擎层；UI 配置留给独立 Change（需求优先级第三项） |
| 9 看到执行状态/输出/失败原因 | B2 流式增强（delta 级） |
| 12/16 过期阻断与恢复 | A7/B5 复验不回退 |
| 1,2,8–11,13–15,17,18 | 不得回退——A10/B6 全量测试守住 |

## 风险与回滚

- **回滚单位是 git revert 整个 Task 的提交**：每个 Task 独立提交、全量测试绿才前进，任何 Task 失败可单独 revert 不牵连已合并部分。
- **最大技术风险在 B2 归一化层**：下游 ingestion（`stage-ai-output-contract`、事件流 UI）依赖 snake_case item 类型。缓解：归一化在引擎内完成，`AiStreamEvent` 契约冻结不动；B2 Step 1 的事件序列断言就是契约测试。
- **协议漂移风险**：app-server 标注部分能力 experimental。缓解：B0 锚定版本 + schema 生成固化；`initialize` 不开 `experimentalApi`（本方案用的方法全部在稳定面）。
- **过载/长连接失败**：`-32001` 显式归类 `provider_overloaded`，走现有失败→重试/Fix 流程，不伪装成功（需求 §10.3）。
- **`codex exec` 残留一处合法使用**：`commit-message-service`（A6）——一次性无状态调用，非 Agent 执行链路；在 docs/ship/architecture.md 里注明这个例外及理由。
