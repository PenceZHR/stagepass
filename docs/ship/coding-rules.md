# CC-AI 编码规范

## 一、命名约定

### 1.1 文件命名

| 类型 | 范式 | 示例 |
|---|---|---|
| 服务模块 | `kebab-case` + `-service.ts` 或 `-service.ts` 后缀 | `action-contract-service.ts`, `prd-briefing-ledger.ts` |
| 测试文件 | 同源文件名 + `.test.ts` | `action-contract-service.test.ts` |
| 类型文件 | `kebab-case` + `-types.ts` | `action-contract-types.ts`, `build-types.ts` |
| API 路由 | `route.ts` (Next.js 约定) | `app/api/projects/[id]/route.ts` |
| React 组件 | `kebab-case.tsx` | `create-change-dialog.tsx`, `prd-editor.tsx` |
| 页面组件 | `page.tsx` (Next.js 约定) | `app/projects/[id]/page.tsx` |
| DB 迁移 | `NNNN_description.sql` | `0013_db_first_pipeline.sql` |
| Prompt 模板 | `kebab-case.md` | `prd-briefing-questions.md` |

### 1.2 标识符命名

| 类型 | 范式 | 示例 |
|---|---|---|
| 函数 | `camelCase` | `getActions`, `assertCanMerge`, `runImplementStreamed` |
| 类 | `PascalCase` | `BuildWorkspaceError`, `GraphRunner`, `StageBoundaryViolationError` |
| 常量 | `UPPER_SNAKE_CASE` | `DEFAULT_BATTLE_PARAMS`, `DEFAULT_DOCUMENT_STAGE_TIMEOUT_MS`, `MISSING_GATE_SOURCE_DB_HASH` |
| 接口/类型 | `PascalCase` | `PipelineActionContract`, `StageAuthoritySnapshot` |
| 枚举值 | `PascalCase` (Zod enum) | `INTAKE_PENDING`, `SPECCING`, `MERGE_READY` |
| DB 表名 | `snake_case` (Drizzle 表) | `build_run_records`, `review_attempts`, `stage_authority` |
| DB 列名 | `snake_case` | `change_id`, `created_at`, `source_db_hash` |

### 1.3 ID 命名规则

| 实体 | 前缀 | 示例 |
|---|---|---|
| Project | `PRJ-` | `PRJ-001` |
| Change | `CHG-` | `CHG-001` |
| Run | `RUN-` | `RUN-001` |
| Event | `EVT-` | `EVT-001` |
| Artifact | `ART-` | `ART-001` |
| Finding | `FND-` | `FND-001` |
| Stage Run | `STG-RUN-{UUID}` | `STG-RUN-xxx` |
| Stage Report | `STG-RPT-` | `STG-RPT-001` |
| Stage Gate | `STG-GATE-` | `STG-GATE-001` |
| Human Decision | `HD-{UUID}` | `HD-MERGE-xxx` |
| PRD Briefing | `PBR-` | `PBR-xxx` |
| Briefing Question | `BQ-` | `BQ-xxx` |
| PRD Draft | `PDR-` | `PDR-xxx` |

### 1.4 分支命名

- Change 分支：由 `generateChangeBranchName(changeId, title)` 生成
- Build worktree 分支：`buildBranchName(changeId, runNumber)` → `stagepass/build/{changeId}/build-{n}`

## 二、代码风格

### 2.1 TypeScript 约定

- **严格模式**：`tsconfig.json` 中 `strict: true`
- **显式返回类型**：服务函数尽量写返回类型
- **Zod 类型导出模式**：同时导出 schema const 和 type（`export const AiProvider = z.enum(...); export type AiProvider = z.infer<typeof AiProvider>`）
- **import 风格**：使用 `node:` 前缀 (`import fs from "node:fs"`)
- **动态 import**：通过 `createRequire` + `require()` 解决循环依赖（如 `stage-authority-service.ts` 和 `action-contract-service.ts`）

```typescript
// 解决循环依赖的标准模式
const requireDefaultDb = createRequire(import.meta.url);
function getStageAuthorityDb(): StageAuthorityDb {
  if (stageAuthorityDbForTest) return stageAuthorityDbForTest;
  if (!defaultStageAuthorityDb) {
    defaultStageAuthorityDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultStageAuthorityDb;
}
```

- **ESLint 规则**：Next.js 16 ESLint config + 自定义
- **target ES2017**：`tsconfig.json` 中 `"target": "ES2017"`

### 2.2 错误处理模式

```typescript
// 自定义错误类
export class BuildWorkspaceError extends Error {
  constructor(message: string, public readonly statusCode: 404 | 409) {
    super(message);
    this.name = "BuildWorkspaceError";
  }
}

export class PrdBriefingError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "PrdBriefingError";
  }
}
```

- **全链路错误码**：错误类携带 `statusCode` 或 `code` 字段用于分类处理
- **409 Conflict**：gate version / sourceDbHash / HEAD 漂移返回 `409` + 新 action contract
- **422 Unprocessable**：非法 schema 输入

### 2.3 日志

```typescript
import { createChildLogger } from "../logger";
const log = createChildLogger("pipeline-service");
log.info({ changeId, phase }, "Plan generated");
log.warn({ projectId, files: violation.files }, "Stage boundary violation");
```

使用 `pino` 结构化日志，子 logger 带模块名。

### 2.4 测试可注入模式

大量服务使用 `setXxxForTest` 模式支持测试注入：

```typescript
let pipelineEngineFactory: EngineFactory | null = null;
export function setPipelineEngineFactoryForTest(factory: EngineFactory | null): void {
  pipelineEngineFactory = factory;
}
```

返回恢复函数（cleanup pattern）：

```typescript
export function setActionContractServiceDbForTest(nextDb: ActionContractDb): () => void {
  const previous = actionContractDbForTest;
  actionContractDbForTest = nextDb;
  return () => { actionContractDbForTest = previous; };
}
```

## 三、API 约定

### 3.1 路由结构

三层嵌套路由：`/api/projects/:id/changes/:changeId/{action}`

| 层级 | 资源 | 示例 |
|---|---|---|
| `/api/projects` | 项目 CRUD | `GET/POST` |
| `/api/projects/:id` | 单项目 | `GET/DELETE` |
| `/api/projects/:id/baseline` | 基线文档 | `GET /:docName` |
| `/api/projects/:id/context` | 上下文 | `GET/POST/PUT /:docName` |
| `/api/projects/:id/prd` | PRD | `GET/POST/confirm/revise/upgrade` |
| `/api/projects/:id/git` | Git | `GET/POST/suggest-message/workspace` |
| `/api/projects/:id/changes` | 变更列表 | `GET/POST` |
| `/api/projects/:id/changes/:changeId` | 单变更 | `GET/PATCH/DELETE` |
| `.../changes/:changeId/{action}` | 阶段动作 | `intake/spec/plan/implement/review/check/fix/release/retro/rework/stop/block` |
| `.../changes/:changeId/gate/{action}` | 门禁动作 | `approve/reject` |
| `.../changes/:changeId/{sub-system}` | 子系统 | `prd-briefing/spec-battle/plan-sandbox/build-workspace/review-center` |

### 3.2 请求/响应格式

**Action 执行请求**：
```json
{
  "actionId": "enter_qa",
  "gateVersion": "3",
  "sourceDbHash": "sha256:...",
  "idempotencyKey": "uuid-xxx"
}
```

**成功响应**：标准 JSON DTO
**409 冲突响应**：
```json
{
  "error": "action_not_allowed",
  "action": { "enabled": false, "reasonCode": "review_stale", ... }
}
```

### 3.3 HTTP 方法语义

| 方法 | 语义 |
|---|---|
| `GET` | 读取资源/状态 |
| `POST` | 创建资源 / 执行阶段动作 / 触发 AI run |
| `PUT` | 全量更新（如 artifacts 内容） |
| `PATCH` | 部分更新（如 briefing question 回答） |
| `DELETE` | 删除资源 |

### 3.4 重要约定

- **Preflight 校验**：所有写操作路由必须调用 `PreflightService.assertActionAllowed()` 或等价校验
- **幂等性**：`run_*`、`retry_*`、`adopt_*`、`waive_*`、`enter_qa`、`merge` 必须携带 `idempotencyKey`
- **AI provider 透传**：支持按请求指定 `provider: "codex" | "claude"`
- **SSE 事件流**：`GET /events/stream` 提供 Server-Sent Events 实时流

## 四、测试规范

### 4.1 框架

- **测试运行器**：`tsx --test`（Node.js 原生 test runner，非 Jest）
- **E2E**：`@playwright/test`（`tmp-playwright-*.mjs` 脚本）
- **测试命令**：`pnpm test` → `tsx --test --test-concurrency=1 "app/**/*.test.ts" "server/services/*.test.ts" "server/db/*.test.ts"`

### 4.2 测试组织

- 测试文件与源文件同目录，后缀 `.test.ts`
- 测试覆盖：`app/` 前端组件测试、`server/services/` 服务单元测试、`server/db/` 数据库测试
- 测试并发限制为 1（SQLite 单文件数据库约束）

### 4.3 测试模式

```typescript
// 使用 DB 注入隔离测试
import { setActionContractServiceDbForTest } from "./action-contract-service";
const restore = setActionContractServiceDbForTest(testDb);
// ... test
restore();

// 使用引擎 mock
import { setPipelineEngineFactoryForTest } from "./pipeline-engine-service";
setPipelineEngineFactoryForTest((provider) => mockEngine);
```

## 五、数据库约定

### 5.1 Schema 管理

- ORM：Drizzle ORM (`drizzle-orm`)
- 数据库：SQLite via `better-sqlite3`
- 迁移：增量式，文件命名 `NNNN_description.sql`
- 迁移目录：`server/db/migrations/`
- Drizzle Kit 配置：`drizzle.config.ts`

### 5.2 表设计约定

- 所有表统一包含 `created_at`（必要时 `updated_at`）
- ID 为主键 TEXT 类型，使用自增前缀格式
- 外键使用 Drizzle `.references()` 声明
- 使用 `check()` 约束确保数据完整性
- 使用 `uniqueIndex()` 和 `index()` 优化查询

### 5.3 DB-first 契约

- 写入顺序：schema validation → normalize → DB transaction → recompute gate → action contract → render mirrors
- 读取顺序：DB authority → gate service → action contract → UI DTO
- `.ship/` 文件永不作为流程权威

## 六、AI Prompt 约定

- Prompt 模板位于 `server/templates/prompts/`，`.md` 格式
- 通过 `assemblePrompt(phase, vars, scope?)` 函数拼装
- 支持 `{changeId}`、`{repoPath}` 等变量替换
- Prompt 可携带 `outputSchema`（JSON Schema）要求 AI 输出结构化 JSON
- `plan` 阶段要求结构化 JSON（`PLAN_JSON_SCHEMA`），必须校验通过

## 七、禁止事项（从代码中发现的约束）

### 7.1 文件权威禁止

- ❌ 不得将 `.ship/` JSON/Markdown 作为 PRD、Spec、Plan、Build、Review、QA、Merge 的流程权威
- ❌ 不得将 `plan.json` 作为 Build scope 权威
- ❌ 不得将 `review-report.md`、`review-findings.json` 作为 QA gate 权威
- ❌ 不得将 `war-report.md` 作为 Merge readiness 依据
- ❌ 不得从 JSON/Markdown 文件反向覆盖 DB 主状态

### 7.2 AI 边界禁止

- ❌ AI 不得直接写 DB 主状态（必须经过 parser/validator/reporter）
- ❌ AI 反方 Audit 不得替代 deterministic Build Gate
- ❌ 不得让 AI 自然语言总结成为 gate 依据
- ❌ Review AI 不得修改源码（只能写 `.ship` 产物和 findings）

### 7.3 安全边界禁止

- ❌ Read-only 阶段（refine, generate_plan）不得修改源码
- ❌ Build/Fix 不得在主仓工作区直接施工（必须在隔离 workspace/worktree）
- ❌ `forbiddenFiles`、policy blocked globs、path escape、secret 必须硬阻断
- ❌ Build 在无 Git 项目中被正式动作阻断
- ❌ P0 不可 waiver，P0 override 不提供

### 7.4 前端禁止

- ❌ 前端不得根据 `ChangeStatus`、artifact 文件存在、Markdown 内容自行推断按钮可用性
- ❌ 前端不得绕过 DB action contract
- ❌ 禁止出现"前端显示可点击，后端 preflight 才给出新理由拒绝"的长期不一致

### 7.5 数据禁止

- ❌ 不提交本地数据库文件（`server/db/ship.db*`）
- ❌ 不提交临时截图（`tmp-review-*.png` 等）
- ❌ 不产生 JSON-only 后端状态