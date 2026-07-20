# stagepass 架构文档

## 一、概述

**stagepass** 是一个本地优先的 Next.js 全栈应用，定位为**面向 vibe 编码者的 Stage-Gate 研发流水线控制台**。它管理项目、变更（Change）、AI 辅助流水线阶段、Review 关卡和本地构建/测试工作流。核心理念是"DB 当裁判，JSON/Markdown 当战报镜像"——从 PRD 到 Merge 全流程数据库权威化。

产品主张：**不替用户写代码，而是替用户把流程走对**。一句需求被押着走完 12 个阶段，每道 gate 由人拍板放行；对抗机制（PRD Briefing / Spec Battle / Review）负责把风险主动暴露给经验不足的使用者，让他们也能做出老手级的裁决。"管住 AI"（跑不掉、瞒不住、崩了能捞回来）是随之而来的第二层收益，不是第一主张。

## 二、整体架构层次

```
┌─────────────────────────────────────────────────────────┐
│                       前端层 (Frontend)                   │
│  Next.js 16 App Router + React 19 + shadcn/ui           │
│  - 页面路由: /projects, /projects/:id, /changes/:id     │
│  - UI 组件: button, card, dialog, alert-dialog, input   │
│  - Action Contract 驱动的按钮可用性                       │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP REST API (fetch)
┌──────────────────────▼──────────────────────────────────┐
│                    API 路由层 (API Routes)               │
│  Next.js Route Handlers (app/api/**/route.ts)            │
│  - 三层路由: /projects → /:id → /changes/:id → /{action} │
│  - PreflightService 前置校验                             │
│  - ActionContract 契约校验 (gateVersion + sourceDbHash)   │
└──────────────────────┬──────────────────────────────────┘
                       │ 函数调用
┌──────────────────────▼──────────────────────────────────┐
│                服务层 (Services)                          │
│  ┌──────────────┬──────────────┬──────────────────────┐ │
│  │ Pipeline     │ Gate Service │ ActionContract       │ │
│  │ Service      │              │ Service              │ │
│  ├──────────────┼──────────────┼──────────────────────┤ │
│  │ Stage        │ Stage Guard  │ Preflight            │ │
│  │ Authority     │ Service      │ Service              │ │
│  ├──────────────┼──────────────┼──────────────────────┤ │
│  │ Spec Battle  │ Review       │ Build Workspace      │ │
│  │ Service      │ Service      │ Service              │ │
│  ├──────────────┼──────────────┼──────────────────────┤ │
│  │ PRD Briefing │ Plan Sandbox │ Merge Readiness      │ │
│  │ Service      │ Service      │ Service              │ │
│  └──────────────┴──────────────┴──────────────────────┘ │
└──────────────────────┬──────────────────────────────────┘
                       │ SQL (Drizzle ORM)
┌──────────────────────▼──────────────────────────────────┐
│                 数据层 (Database)                         │
│  SQLite (better-sqlite3) + Drizzle ORM + WAL 模式         │
│  - server/db/ship.db (单一文件数据库)                     │
│  - 14+ 次增量迁移 (0000 ~ 0013)                          │
│  - 40+ 张表覆盖全阶段                                     │
└─────────────────────────────────────────────────────────┘
                       │ CLI / SDK 调用
┌─────────────────────────────────────────────────────────┐
│               AI 引擎抽象层 (AI Engine)                   │
│  AiEngineAdapter 接口 (ai-engine-types.ts)               │
│  ┌─────────────────────┬────────────────────────────┐   │
│  │ Codex Engine         │ Claude Engine               │   │
│  │ (codex CLI, spawn)   │ (@anthropic-ai/claude-code) │   │
│  └─────────────────────┴────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                       │ Git CLI
┌─────────────────────────────────────────────────────────┐
│               文件系统 & Git 层                            │
│  .ship/ 目录 (镜像产物、AI 上下文)                         │
│  Git worktree (Build 隔离施工区)                          │
│  server/templates/ (Prompt 模板 + Baseline 模板)          │
└─────────────────────────────────────────────────────────┘
```

## 三、架构模式

**整体模式：分层架构（Layered Architecture）+ 管线模式（Pipeline Pattern）**

- **单体应用**：单一 Next.js 进程承载全部功能（前端 SSR + API + 业务逻辑）
- **无外部 API 依赖**：本地 SQLite + 本地 Git + 本地 AI CLI/SDK
- **Action Contract 模式**：前端按钮可用性由后端 DB-first 的 `PipelineActionContract` 决定，杜绝"前端显示可点击但后端不认"的不一致
- **确定性结算模式**：所有 Gate（关卡）和 Report 由 deterministic service 从 DB 计算，AI 只产生输入，不做裁决
- **镜像模式**：DB 是唯一权威；`.ship/` 文件是从 DB 渲染的 AI/人工可读镜像
- **Preflight 模式**：所有有副作用的 API 操作必须通过 `PreflightService.assertActionAllowed()` 校验 action contract 的 gateVersion 和 sourceDbHash

## 四、目录结构说明

| 目录 | 职责 |
|---|---|
| `app/` | Next.js App Router 前端页面 + API 路由 |
| `app/api/projects/` | REST API 路由（按 `[id]/changes/[changeId]/{action}` 三层嵌套） |
| `app/projects/` | 前端页面组件（项目列表、详情、变更详情） |
| `app/fonts/` | Geist 字体文件 |
| `components/ui/` | shadcn/ui 组件（button, card, dialog, input, label, alert-dialog） |
| `lib/` | 工具函数（cn classname merge） |
| `server/db/` | 数据库层：Drizzle schema、迁移、运行时 `ship.db` |
| `server/services/` | 核心业务逻辑（100+ 文件，约 50+ 核心服务） |
| `server/templates/` | 静态模板和 Prompt 模板 |
| `server/templates/baseline/` | 项目基线文档模板（prd, tech-spec, api-spec 等 10 份） |
| `server/templates/prompts/` | AI Prompt 模板（intake, spec, plan, implement, review 等 20+ 份） |
| `server/types/` | 类型定义（enums, models, api, prd） |
| `docs/` | 项目文档（PRD, TechSpec, DataModel, StateMachine 等 15+ 份） |
| `docs/archive/` | 历史设计文档归档 |
| `tmp-playwright-*.mjs` | Playwright E2E 测试脚本 |

## 五、核心模块间调用链和数据流向

### 5.1 请求主干流

```
用户操作 (UI Button)
  → ActionContractService.getActions(changeId)  [获取 DB 契约，决定按钮是否可点击]
  → fetch(POST /api/projects/:id/changes/:id/xxx, { actionId, gateVersion, sourceDbHash })
  → Route Handler
  → PreflightService.assertActionAllowed(...)   [校验契约一致性]
  → Pipeline/Stage Service                      [执行业务逻辑]
  → StageAuthorityService                       [写入 stage_runs → stage_reports → stage_gates]
  → ActionContractService.persistActionContract  [持久化 action 快照到 stage_actions]
  → ArtifactMirrorService.renderMirrorsFromDb    [DB → .ship 镜像渲染]
  → Response (JSON DTO 或错误 + 新 action contract)
```

### 5.2 Pipeline 全阶段流程

```
创建 Change (INTAKE_PENDING)
  → runIntake() → INTAKE_READY (Gate◆)
  → approveGate("intake") → SPECCING
  → runSpec() (Spec Battle: 红方出招 → 蓝方反击 → 战报结算) → SPEC_READY (Gate◆)
  → approveGate("spec") → TECHSPECCING
  → runTechSpec() → TECHSPEC_READY (Gate◆)
  → approveGate("tech_spec") → PLANNING
  → generatePlan() → PLAN_READY (Gate◆)
  → approvePlan() → PLAN_APPROVED
  → runTestPlan() → TESTPLAN_DONE
  → confirm → PLAN_APPROVED
  → runImplement() (Build: worktree 隔离施工) → IMPLEMENTING
  → approveBuildAbsorb() → IMPLEMENTED
  → runReview() (Review 战报中心) → REVIEWING
  → runCheck() (QA: 本地检查) → CHECKING
  → markLocalReady() → LOCAL_READY
  → Merge Readiness Check → MERGE_READY (Gate◆)
  → approveGate("merge") → MERGING
  → runRelease() → RETRO_PENDING
  → runRetro() → DONE
```

### 5.3 DB 权威写入序

```
AI 输出 → Schema Validation → Normalize → DB Transaction
→ Recompute Gate → Recompute Action Contract
→ Render .ship Mirror from DB → Expose UI DTO
```

### 5.4 读取序

```
DB Authority Rows → Deterministic Gate Service
→ Latest Valid Selector → Action Contract → UI DTO / API Response
```

**禁止读取链路**：`.ship JSON → gate`，`.ship Markdown → gate`，`plan.json → Build scope authority`，前端本地推断 → action enabled

## 六、关键设计决策及其背景

### 决策 1：本地 SQLite + 全后端 DB 权威

**背景**：v1-v3 版本存在"文件产物驱动" → "局部 DB 化" → "JSON/Markdown 当 gate"的不一致。AI 输出直接写入 `.ship/` JSON，前端和后端各自读取不同来源。

**决定**：DB 是唯一流程裁判。`.ship/` 只作为镜像。所有 gate/preflight/action 从 DB 计算。镜像缺失不影响主状态。

**影响**：需要 40+ 张 DB 表、stage_* 通用权威表、artifact_mirrors 镜像索引、legacy_imports 审计表。

### 决策 2：Action Contract 模式

**背景**：历史上前端根据 `ChangeStatus`、artifact 文件存在、Markdown 文案自行推断按钮可用性，导致"页面显示可点但后端返回 409"。

**决定**：所有 UI 按钮来自 `ActionContractService.getActions(changeId)` 计算的 DB-first 契约。执行 API 复用同一套 `PreflightService.assertActionAllowed()`。契约包含 `gateVersion` + `sourceDbHash`，任何变化返回 `409` + 新 contract。

### 决策 3：对抗式 Spec Battle（红蓝双方回合制）

**背景**：需求阶段最容易被忽略问题。单次 AI 生成 PRD 缺乏质量保证。

**决定**：引入 Spec Battle——红方（SPEC_WRITER）出招，蓝方（REQUIREMENT_CRITIC）反击，BATTLE_REPORTER 结算战报，人类指挥官裁决。最多 3 轮对抗（可配 1-5 轮）。

### 决策 4：Build 隔离 Worktree

**背景**：AI 直接在主仓施工会污染用户工作区，失败后难以回滚。

**决定**：Build 必须在 Git worktree 隔离环境中执行。`git worktree add` 创建独立施工区，系统记录 `baseHeadSha`/`patchHash`/`changedFilesHash`，人类审批后才收编（adopt）到主仓。

### 决策 5：Review 独立战报中心（非 QA 附属）

**背景**：旧 Review 混用 QA 状态，用户看到 `CHECK_FAILED` 误以为是测试失败。

**决定**：Review 拥有独立产品状态：`not_started/running/passed/blocked_p0/blocked_p1/stale/failed/invalid_output/data_inconsistent`。即使底层兼容旧状态，UI 必须展示 Review 战报阻断语义。

### 决策 6：双 AI 引擎抽象

**背景**：需要支持 codex 和 claude 两种 AI provider。

**决定**：`AiEngineAdapter` 接口抽象 `run()` 和 `runStreamed()`。`getAiEngine(provider)` 工厂函数按 provider 加载对应引擎。支持测试时注入 mock 引擎。

### 决策 7：Stage Authority 通用层

**背景**：每个阶段（PRD/Spec/Plan/Build/Review/QA/Merge）都需要独立的 run/report/gate/state 记录。

**决定**：创建通用 `stage_runs`、`stage_reports`、`stage_gates`、`stage_states`、`stage_actions` 五张表，通过 `phase` 字段区分阶段。加上各阶段专用表（如 `battle_rounds`、`review_attempts`）。统一的 `computeSourceDbHash` ↔ latest valid selector ↔ gate 算法。

## 七、状态机与生命周期

### 7.1 Change 状态全集（26 个状态）

```
REFINING → DRAFT → INTAKE_PENDING → INTAKE_READY◆ → SPECCING → SPEC_READY◆
→ TECHSPECCING → TECHSPEC_READY◆ → PLANNING → PLAN_READY◆ → PLAN_APPROVED
→ TESTPLANNING → TESTPLAN_DONE → (回 PLAN_APPROVED)
→ IMPLEMENTING → IMPLEMENTED → REVIEWING → (CHECKING → LOCAL_READY)
↔ CHECK_FAILED ↔ FIXING (≤3轮) / SCOPE_FAILED → BLOCKED
→ MERGE_READY◆ → MERGING → RETRO_PENDING → DONE
```

`◆` 标记为人工门（Gate），必须主动批准才前进，不会自动跳转。

### 7.2 Phase 展示映射（16 个展示阶段）

| Phase | 对应状态范围 | State |
|---|---|---|
| Intake | INTAKE_PENDING → INTAKE_READY | running/waiting |
| Spec | SPECCING → SPEC_READY | running/waiting |
| TechSpec | TECHSPECCING → TECHSPEC_READY | running/waiting |
| Plan | PLANNING → PLAN_READY | running/waiting |
| TestPlan | TESTPLANNING → TESTPLAN_DONE | running/done |
| Build | IMPLEMENTING | running |
| Review | IMPLEMENTED → REVIEWING | waiting/running |
| QA | CHECKING → LOCAL_READY | running/done |
| Merge | MERGE_READY → MERGING | waiting/running |
| Retro | RETRO_PENDING → DONE | running/done |

### 7.3 Review Center 派生状态（Gate 状态机）

```
not_started → running → {
  passed         (fresh + 最新 Build + 无 open P0/P1)
  blocked_p0     (存在 open P0)
  blocked_p1     (存在 open P1)
  stale          (Build/HEAD/waiver 变化)
  failed         (provider 失败)
  invalid_output (AI 输出非法)
  data_inconsistent (DB 内部矛盾)
}
```

### 7.4 Spec Battle Round 状态机

```
not_started → red_running → red_done → blue_running → blue_done → report_ready
→ (继续对抗: 新 round) / (关闭: closed) / (被取代: superseded) / (失败: failed)
```

### 7.5 Build Run 生命周期

```
pending → running → {
  completed (产出 diff/patch) → {
    adopted (人类审批收编)
    rejected (拒绝)
  }
  failed (施工失败)
}
```

### 7.6 PRD Briefing 状态

```
intent_captured → questions_ready → draft_ready → final_review_ready → locked (→ INTAKE_READY)
```

### 7.7 关键不变式（Invariants）

1. 同一项目至多一个 Change 处于 RUNNING 类状态（`*ING`）
2. 门态（◆）永不自动前进，仅 gate 接口驱动
3. `MERGING` 仅当 `canMerge = QA绿 && Review通过 && 文档齐全`
4. `FIXING` 累计不超过 3 轮，超限强制 `BLOCKED`
5. `.ship/` 产物变更豁免 scope 判罚
6. 进入 QA 前必须 `ReviewCenterState.gate = passed`
7. P0 不可 waiver，P1 waiver 必须带 reason 且使 report stale
8. 镜像缺失/损坏不改变 DB gate 结论