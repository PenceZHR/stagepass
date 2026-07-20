# API Spec：stagepass 接口契约

| 项 | 值 |
|---|---|
| 文档状态 | Draft（待 Interface Review） |
| 版本 | v2.0 |
| 关联 | [docs/prd.md](./prd.md)、[docs/tech-spec.md](./tech-spec.md) |
| 创建日期 | 2026-06-23 |

> 约定：所有路由前缀 `/api/projects/[id]`，`[id]` = 项目 ID（PRJ-xxx）。change 级路由再加 `/changes/[changeId]`。成功返回 `200`，错误返回 `4xx/5xx` + `{ error: string }`。

---

## 一、错误响应统一格式

```json
{ "error": "Invalid status: DRAFT. Expected: PLAN_READY" }
```

| HTTP | 含义 |
|---|---|
| 400 | 参数非法 / 状态机不允许该操作 |
| 404 | 资源不存在 |
| 409 | 并发冲突（已有 change 在 IMPLEMENTING/FIXING）|
| 500 | 内部错误 |

详见 `.ship/baseline/error-codes.md`。

## 二、现有接口（v1，保留）

### 项目

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/projects` | — | `Project[]` |
| POST | `/api/projects` | `{ name, repoPath, gitEnabled?, contextProvider?, prdProvider? }` | `Project` |
| GET | `/api/projects/[id]` | — | `Project` |
| DELETE | `/api/projects/[id]` | — | `{ ok: true }` |

### Context（基线文档生成）

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/projects/[id]/context` | — | `{ contextStatus, contextProvider, docs }` |
| POST | `/api/projects/[id]/context` | `{ provider? }` | `{ status: "generating", provider }` |
| GET | `/api/projects/[id]/context/[docName]` | — | `{ content }` |

### PRD

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/projects/[id]/prd` | — | `{ prdStatus, prdJson, prdMarkdown, history }` |
| POST | `/api/projects/[id]/prd/revise` | `{ message }` | `{ prdMarkdown, chatHistory }` |
| POST | `/api/projects/[id]/prd/confirm` | — | `{ prdStatus: "ready" }` |
| POST | `/api/projects/[id]/prd/upgrade` | — | `{ prdJson }` |

### Change 生命周期（v1）

| 方法 | 路径 | 状态前置 → 后置 |
|---|---|---|
| GET/POST | `/changes` | 列表 / 创建（→ REFINING）|
| GET | `/changes/[changeId]` | 详情 |
| POST | `/changes/[changeId]/plan` | DRAFT/PLAN_READY → PLANNING → PLAN_READY |
| POST | `/changes/[changeId]/approve-plan` | PLAN_READY → PLAN_APPROVED |
| POST | `/changes/[changeId]/implement` | PLAN_APPROVED → IMPLEMENTING | 创建 Build workspace，等待人工吸附后才进入 IMPLEMENTED |
| POST | `/changes/[changeId]/check` | → CHECKING → LOCAL_READY/CHECK_FAILED/SCOPE_FAILED |
| POST | `/changes/[changeId]/fix` | CHECK_FAILED/SCOPE_FAILED → FIXING → CHECKING |
| POST | `/changes/[changeId]/confirm` | 确认 change |
| POST | `/changes/[changeId]/block` | → BLOCKED |
| POST | `/changes/[changeId]/stop` | 中止运行中的 run |
| POST | `/changes/[changeId]/rework` | 回退到指定阶段重做 |
| GET | `/changes/[changeId]/chat` | 对话历史 |
| GET | `/changes/[changeId]/phases` | 阶段聚合视图 |
| GET | `/changes/[changeId]/events` | 事件列表 |
| GET | `/changes/[changeId]/events/stream` | SSE 事件流 |
| GET | `/changes/[changeId]/diff` | 工作区 diff |
| GET | `/changes/[changeId]/artifacts` | 产物列表 |
| GET | `/changes/[changeId]/artifacts/[artifactId]/content` | 产物内容 |
| GET | `/changes/[changeId]/findings` | findings 列表 |
| POST | `/changes/[changeId]/findings/[findingId]/waive` | finding → waived |

### Git

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/git` | git 状态 / 初始化 |
| GET | `/git/workspace` | 工作区状态（porcelain）|
| POST | `/git/suggest-message` | AI 生成 commit message |

## 三、新增接口（v2，9 阶段 + 人工门）

### 3.1 阶段执行接口

| 方法 | 路径 | 状态前置 → 后置 | 说明 |
|---|---|---|---|
| POST | `/changes/[changeId]/intake` | （创建）→ INTAKE_PENDING → INTAKE_READY | AI 评估值不值得做 |
| POST | `/changes/[changeId]/spec` | INTAKE_READY → SPECCING → SPEC_READY | 产出 prd-delta（可反复调用迭代）|
| POST | `/changes/[changeId]/tech-spec` | SPEC_READY(approved) → TECHSPECCING → TECHSPEC_READY | 产出 tech-spec-delta / api-spec-delta |
| POST | `/changes/[changeId]/plan` | TECHSPEC_READY(approved) → PLANNING → PLAN_READY | 产出 plan.json / plan.md |
| POST | `/changes/[changeId]/approve-plan` | PLAN_READY → PLAN_APPROVED | 人工批准 Plan |
| POST | `/changes/[changeId]/test-plan` | PLAN_APPROVED → TESTPLANNING → TESTPLAN_DONE | 产出 test-plan-delta，不自动进入 Build |
| POST | `/changes/[changeId]/implement` | PLAN_APPROVED → IMPLEMENTING | 创建 Build workspace，等待 Build sandbox 人工吸附 |
| POST | `/changes/[changeId]/release` | MERGE_READY(approved) → MERGING → RETRO_PENDING | 合并基线 + changelog |
| POST | `/changes/[changeId]/retro` | RETRO_PENDING → DONE | 产出 retro + 回流 backlog |

> Build/Review/QA 复用现有 `implement` / `check` / `fix`，新增 `review` 触发接口（已有 runReview，补路由）。

### 3.2 人工门接口（核心新增）

| 方法 | 路径 | 入参 | 行为 |
|---|---|---|---|
| POST | `/changes/[changeId]/gate/approve` | `{ gate: GateName }` | 校验当前门并记录批准；状态保持为 T2.7 stage 函数入口态 |
| POST | `/changes/[changeId]/gate/reject` | `{ gate: GateName, reason?: string }` | 门态 → 对应 stage 函数可重跑的入口态 |
| GET | `/changes/[changeId]/gate` | — | 当前门状态 + 待审产物 + canMerge 校验结果 |

```ts
type GateName = "intake" | "spec" | "tech_spec" | "merge";

// GET /gate 出参
interface GateStatus {
  atGate: boolean;
  gate: GateName | null;
  status: ChangeStatus;
  pendingArtifact: string | null;   // 待审产物路径
  mergeChecks?: {                    // 仅 merge 门
    qaPassed: boolean;
    reviewPassed: boolean;
    docsComplete: boolean;
    canMerge: boolean;
    missing: string[];
  };
}
```

### 3.3 Baseline 接口

| 方法 | 路径 | 出参 |
|---|---|---|
| GET | `/api/projects/[id]/baseline` | `{ docs: BaselineDoc[] }`（10 份文档列表 + 状态）|
| GET | `/api/projects/[id]/baseline/[docName]` | `{ content }` |

### 3.4 Stage Scope 接口（I/O 契约）

| 方法 | 路径 | 出参 |
|---|---|---|
| GET | `/changes/[changeId]/scope/[phase]` | `StageScope`（readableFiles / writableFiles / plannedChanges）|

## 四、字段类型

```ts
type ChangeStatus =
  // v1
  | "REFINING" | "DRAFT" | "PLANNING" | "PLAN_READY" | "PLAN_APPROVED"
  | "IMPLEMENTING" | "IMPLEMENTED" | "REVIEWING" | "CHECKING"
  | "CHECK_FAILED" | "FIXING" | "SCOPE_FAILED" | "LOCAL_READY" | "BLOCKED"
  // v2 新增
  | "INTAKE_PENDING" | "INTAKE_READY"
  | "SPECCING" | "SPEC_READY"
  | "TECHSPECCING" | "TECHSPEC_READY"
  | "TESTPLANNING" | "TESTPLAN_DONE"
  | "MERGE_READY" | "MERGING" | "RETRO_PENDING" | "DONE";

type RunPhase =
  | "refine" | "generate_plan" | "implement" | "review"
  | "local_check" | "fix_findings"
  | "intake" | "spec" | "tech_spec" | "test_plan" | "release" | "retro";

interface StageScope {
  phase: RunPhase;
  readableFiles: string[];
  writableFiles: string[];
  plannedChanges?: string[];
}
```

## 五、幂等性 / 重试策略

| 接口 | 幂等 | 说明 |
|---|---|---|
| 阶段执行（intake/spec/...）| 否 | 重复调用会重跑该阶段、新建 run |
| `gate/approve` | 是 | 已前进的门重复 approve 返回 409（已离开门态）|
| `gate/reject` | 否 | 每次回退一级 |
| `spec` | 部分 | 可反复调用迭代 delta（设计如此）|
| `release` | 是 | 已合并的 change 重复调用返回 409 |

- **并发约束**：同一项目同时只允许一个 change 处于 RUNNING 态（IMPLEMENTING/FIXING/各 *ING），违反返回 409。
- **重试**：AI 调用失败由 engine 内部重试；阶段级失败回退到进入前状态，由用户手动重触发。

## 六、兼容策略

- v1 接口路径与语义不变。
- 新状态对旧 change 不出现（旧 change 停在 v1 状态）。
- `GET /phases` 出参扩展为 9 段，旧 change 未到的阶段标 `waiting`。
- 前端按 `atGate` 字段决定是否渲染人工门 UI，旧 change 该字段恒 false。

## 七、待 Interface Review 决策点

1. 人工门用 `/gate/approve` 统一入口（带 gate 参数），还是每个门一个独立路由？
2. `scope/[phase]` 是只读查询，还是允许 PATCH 收窄边界？
3. 阶段执行接口是否需要统一为 `/changes/[changeId]/run` + `{ phase }`，减少路由数量？

---

*评审：Approve *
