# stagepass 项目代码认知报告

| 项 | 值 |
|---|---|
| 文档目的 | 记录当前代码库全景认知，作为后续开发、重构、评审和 agent 接手上下文 |
| 生成时间 | 2026-06-30 |
| 最后校订 | 2026-07-16（产品更名 cc-ai / Codex Local Control Board → **stagepass**；定位改写；修正已过期的 AI provider 描述）。**除这几处外，本文其余内容仍是 2026-06-30 的快照，可能已经漂移。** |
| 代码库路径 | `<repo>` |
| 当前判断 | 项目方向清晰，正在从文件产物驱动迁移到 DB-first pipeline；核心复杂度集中在 pipeline 编排、change 主页面、DB schema 和阶段权威边界 |

---

## 1. 项目定位

**stagepass** 是一个本地优先的 AI 研发流水线控制台，采用 **Stage-Gate** 方法论（分阶段推进、每个阶段之间设一道人工决策 gate）。它用于管理本地项目、PRD、change、AI 辅助研发阶段、人工 gate、Build/Review/QA/Merge 流程。

产品主张是**不替用户写代码，而是替用户把流程走对**，面向**想用 AI 写代码、但没受过系统工程训练的开发者**：

- 一句需求被押着走完 12 个阶段，每道 gate 由人拍板放行；走完一遍，这条真实的工程流程本身也就学会了。
- 用户不是追日志，而是在一个控制台里处理战报、风险、gate 和人工裁决。
- AI 不只是单路生成，而是通过 PRD Briefing、Spec Battle、Review 等对抗机制**主动把风险暴露给使用者**——用户不需要自己就能看出坑，有个 AI 专门负责把坑指给他看，他只需要裁决。语义上**红方只指人类用户本人**（需求源头与最终裁决者），批准权只在人类手里。
- “管住 AI”（跑不掉、瞒不住、崩了能捞回来）是随之而来的第二层收益，不是第一主张。
- 后端流程逐步迁移为 DB 权威：DB 是裁判，Git 当前事实是现场，`.ship` / JSON / Markdown 只作为镜像、AI 上下文、人工阅读和审计材料。

核心文档入口：

- `docs/prd.md`：产品愿景和阶段定义。
- `docs/tech-spec.md`：DB-first pipeline 技术方向。
- `docs/api-spec.md`：API 契约。
- `docs/state-machine.md`：Change 状态机。
- `docs/data-model.md`：数据模型说明。
- `docs/test-plan.md`：测试策略。

## 2. 技术栈

项目是 Next.js App Router 应用：

- Next.js 16 + React 19 + TypeScript
- SQLite + better-sqlite3 + Drizzle ORM
- `node:test` + `tsx` 测试
- Codex CLI / Claude Code CLI 作为 AI provider（两者都是本地 `spawn` 的真实子进程、有真实 pid，进同一套生命周期/恢复机制；`@openai/codex-sdk` 已于 2026-07 移除）
- Tailwind + shadcn 风格基础组件
- lucide-react 用于图标

主要命令来自 `package.json`：

```bash
pnpm dev
pnpm lint
pnpm test
pnpm build
```

测试命令目前为：

```bash
pnpm test              # 单元测试：scripts/run-tests-isolated.ts 迁移一个临时 suite.db，全部用例对它跑（--test-concurrency=1）
pnpm test:acceptance   # 重型验收测试：会真起服务和进程
```

## 3. 顶层目录认知

```text
app/
  Next.js 页面和 API routes。

components/
  基础 UI 组件。

docs/
  产品、技术、API、状态机、测试计划和归档计划文档。

lib/
  前端/共享轻量工具。

server/
  后端核心：DB、服务、AI engine、prompt、类型。

server/db/
  SQLite/Drizzle schema、迁移 runner、迁移 SQL。

server/services/
  项目主要业务逻辑。当前最重要的复杂度都在这里。

server/templates/
  `.ship` 脚手架模板、baseline 文档模板、AI prompt 模板。
```

## 4. 产品主流程

代码中的主流程可以概括为：

```text
Project
  -> Project PRD ready
  -> Change
  -> PRD Briefing Room
  -> Spec Battle
  -> TechSpec/API snapshot
  -> Plan Sandbox
  -> TestPlan snapshot
  -> Build Sandbox
  -> Review Center
  -> QA
  -> Merge
  -> Retro
```

核心状态在 `server/types/enums.ts`：

```text
INTAKE_PENDING / INTAKE_READY
SPECCING / SPEC_READY
TECHSPECCING / TECHSPEC_READY
PLANNING / PLAN_READY / PLAN_APPROVED
TESTPLANNING / TESTPLAN_DONE
IMPLEMENTING / IMPLEMENTED
REVIEWING
CHECKING / CHECK_FAILED / LOCAL_READY
FIXING / SCOPE_FAILED / BLOCKED
MERGE_READY / MERGING
RETRO_PENDING / DONE
```

关键产品不变式：

- 门态不自动前进，必须由人工 gate 或明确 action 推进。
- UI 按钮应来自 action contract，而不是前端自行猜状态。
- 执行 API 应复用 preflight，校验 gateVersion、sourceDbHash、必要时校验 Git HEAD。
- 进入 QA 前必须 Review gate passed。
- Merge 前需要 PRD/Spec/Plan/TestPlan/Build/Review/QA 等阶段 gate 和当前 Git 事实满足要求。

## 5. API 接口地图

实际 API 在 `app/api` 下，约 60 个 route。主要接口族如下。

### 5.1 Project

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/[id]`
- `DELETE /api/projects/[id]`

背后主要服务：

- `server/services/project-service.ts`
- `server/services/template-service.ts`
- `server/services/context-init-service.ts`
- `server/services/git-service.ts`

### 5.2 Project PRD / Context / Baseline

- `GET/POST /api/projects/[id]/prd`
- `POST /api/projects/[id]/prd/revise`
- `POST /api/projects/[id]/prd/confirm`
- `POST /api/projects/[id]/prd/upgrade`
- `GET/POST /api/projects/[id]/context`
- `PUT /api/projects/[id]/context/[docName]`
- `GET /api/projects/[id]/baseline`
- `GET /api/projects/[id]/baseline/[docName]`

背后主要服务：

- `server/services/prd-service.ts`
- `server/services/prd-document-service.ts`
- `server/services/context-init-service.ts`
- `server/services/baseline-service.ts`

### 5.3 Change 生命周期

- `GET/POST /api/projects/[id]/changes`
- `GET/PATCH/DELETE /api/projects/[id]/changes/[changeId]`
- `POST /confirm`
- `POST /block`
- `POST /rework`
- `POST /stop`

背后主要服务：

- `server/services/change-service.ts`
- `server/services/change-rework-service.ts`
- `server/services/graph-runner.ts`
- `app/api/projects/[id]/changes/[changeId]/route-guard.ts`

### 5.4 阶段执行

- `POST /intake`
- `POST /spec`
- `POST /tech-spec`
- `POST /plan`
- `POST /test-plan`
- `POST /implement`
- `POST /review`
- `POST /check`
- `POST /fix`
- `POST /release`
- `POST /retro`

背后总入口主要是：

- `server/services/pipeline-service.ts`

该文件目前是阶段编排核心，负责 AI prompt、engine 调用、状态转移、run 记录、产物写入、scope guard、DB snapshot、gate 更新、Build/Review/QA 串联等。

### 5.5 Gate 和 action contract

- `GET /gate`
- `POST /gate/approve`
- `POST /gate/reject`

背后主要服务：

- `server/services/gate-service.ts`
- `server/services/action-contract-service.ts`
- `server/services/preflight-service.ts`
- `server/services/stage-authority-service.ts`

这里是 DB-first pipeline 的关键链路：

```text
ActionContractService.getActions(changeId)
  -> persist stage_actions
  -> UI 按钮展示 enabled/reason/blockers/gateVersion/sourceDbHash
  -> API 提交 action contract snapshot
  -> PreflightService.assertActionAllowed(...)
  -> 业务 route 执行动作
```

### 5.6 专项视图

- `GET/POST /prd-briefing`
- `POST /prd-briefing/questions`
- `PATCH /prd-briefing/questions/[questionId]`
- `POST /prd-briefing/draft`
- `POST /prd-briefing/final-review`
- `POST /prd-briefing/lock`
- `GET /spec-battle`
- `POST /spec-battle/report`
- `POST /spec-battle/decision`
- `GET /plan-sandbox`
- `POST /plan-sandbox/report`
- `POST /plan-sandbox/decision`
- `GET/POST /build-workspace`
- `GET /review-center`
- `POST /review-report/recompute`
- `POST /review-artifacts/rebuild`

这些接口分别服务 PRD Briefing Room、Spec Battle、Plan Sandbox、Build Sandbox 和 Review Center。

### 5.7 审计和产物

- `GET /events`
- `GET /events/stream`
- `GET /artifacts`
- `GET/PUT /artifacts/[artifactId]/content`
- `PUT /phase-artifacts`
- `GET /findings`
- `POST /findings/[findingId]/waive`
- `GET /diff`

## 6. 后端核心服务分层

### 6.1 基础实体

`project-service.ts`

- 注册本地项目路径。
- 初始化 `.ship`。
- 可选 Git 校验和默认分支读取。
- 删除项目时清理关联 change 和 `.ship`。

`change-service.ts`

- 创建 change。
- 要求项目 PRD ready 后才能创建 change。
- 初始状态为 `INTAKE_PENDING`。
- Git enabled 时创建/切换 change branch。
- 删除 change 时显式清理大量关联 DB 表。

### 6.2 Pipeline 总编排

`pipeline-service.ts` 是当前最大核心文件，职责包括：

- 通用 document stage 执行。
- AI engine 选择和调用。
- prompt 组装。
- workspace snapshot / scope guard。
- run / event / artifact 写入。
- Intake、PRD briefing、Spec、TechSpec、Plan、TestPlan、Build、Review、QA、Fix、Release、Retro 的阶段推进。
- Build adoption 校验。
- Review attempt / report / QA gate 串联。
- TestPlan required commands 串联 QA。
- Git commit / release / changelog / retro backlog。

判断：它是当前最重要的编排器，但也已经承载了过多阶段内部细节。后续最适合先拆 Plan/TechSpec/TestPlan/Review/Build 这些 stage service。

### 6.3 Stage authority

`stage-authority-service.ts`

提供通用 DB 权威层：

- `stage_runs`
- `stage_reports`
- `stage_gates`
- `stage_states`

核心函数：

- `startStageRun`
- `completeStageRun`
- `recomputeStageGate`
- `getStageAuthority`
- `computeSourceDbHash`

它负责选择 latest attempt、latest report、latest valid report、latest gate，并派生当前 stage state。

### 6.4 Action contract 和 preflight

`action-contract-service.ts`

- 定义所有 UI/API 可执行动作，如 `run_plan`、`approve_plan`、`run_build`、`adopt_build`、`run_review`、`enter_qa`、`merge`。
- 计算每个 action 是否 enabled。
- 给出 reasonCode、reason、blockers、gateVersion、sourceDbHash。
- 持久化到 `stage_actions` 以供审计。

`preflight-service.ts`

- 校验 action contract snapshot。
- 校验 idempotency key。
- 校验 gateVersion/sourceDbHash 漂移。
- 可选校验 Git HEAD 漂移。
- 返回结构化 `action_not_allowed` envelope。

这是当前架构最有价值的安全边界之一。

### 6.5 PRD Briefing

`prd-briefing-service.ts`

Change 级 PRD Briefing Room：

- 保存用户 intent。
- 生成/解析 AI question cards。
- 用户回答、defer、accept default。
- 生成 PRD draft。
- final review。
- lock briefing。
- 写 PRD stage gate。
- 从 DB 渲染 `.ship` 镜像。

配套 `prd-briefing-ledger.ts` 负责问题和 gate 的 deterministic 规则。

### 6.6 Spec Battle

`spec-battle-service.ts`

- 校验 locked PRD DB baseline。
- 创建 battle round。
- 保存 Red 输出和 Blue critique。
- 维护 requirement gaps、red fix claims、blue gap reviews、human decisions。
- 根据 DB source hash 判断 report freshness。

`spec-battle-ledger.ts`

- 解析 Red/Blue 结构化输出。
- 计算上一轮 gap 是否 resolved、still open、not rechecked。

`spec-battle-rules.ts`

- 计算 P0/P1/P2 阻断。
- 判断 Spec gate / Merge gate 是否被 requirement gap 阻断。
- 计算 action availability。

`spec-battle-report-service.ts`

- 从 DB 生成 deterministic report。
- 同步 Spec stage gate。
- 渲染 war report / mirror。

### 6.7 Plan / TechSpec / TestPlan

`techspec-api-snapshot-service.ts`

- 标准化 TechSpec/API 结构。
- 要求 `interfaces`、`dataContracts`、`migrationNotes`、`buildInputs`、`reviewInputs`。
- 持久化 `techspec_snapshots` 和 `api_snapshots`。
- 为 Build/Review 提供设计输入。

`plan-sandbox-service.ts`

- 读取/写入 Plan 相关镜像。
- 维护 `plan_snapshots`、`plan_steps`、`plan_risks`、`plan_approvals`。
- 生成 Plan Sandbox report。
- 支持 P1 risk waiver。
- 计算 Plan gate。

注意：Plan Sandbox 仍有较多文件读写逻辑，包括 `plan.json`、`plan.md`、`plan-critique.json`，后续应继续向 DB authority 收口。

`testplan-snapshot-service.ts`

- 维护 `testplan_snapshots`。
- 写 coverage items、risk mappings、required validation commands、manual checks。
- 生成 TestPlan gate。
- 提供 QA required commands。

### 6.8 Build

`build-workspace-service.ts`

- 基于 Git worktree 创建隔离施工区。
- 生成 build run JSON 文件。
- 评估 Build Gate：expectedFiles、forbiddenFiles、hard block patterns、policy、路径逃逸、deviation。
- 生成 patch/diff/audit/report。
- 支持 approve absorb、reject、fix adoption。

`build-run-record-service.ts`

- 将 Build 文件型结果记录为 DB 权威 `build_run_records`。
- 计算 changedFiles hash。
- 校验 latest adopted build 是否和当前 HEAD 一致。

Build 是少数必须同时管理文件系统、Git、DB 的模块。文件型 workspace 不是问题，但 Build adoption 的权威应该持续保持在 DB。

### 6.9 Review

Review 是当前 DB 化最完整的模块。

`review-run-service.ts`

- 创建 review attempt。
- 支持 idempotency。
- 绑定 source build run/head sha。
- 解析结构化 Review 输出。
- 写入 review findings 和 prior finding reviews。
- 防止旧 P0/P1 未复核就自动关闭。

`review-report-service.ts`

- 从 DB findings、attempt、build record 重新结算 review report。
- 维护 `review_reports` 和 `review_state`。
- 计算 latestAttempt、latestValidReview、gateStatus、qaAllowed。
- 识别 legacy incomplete、data inconsistent、stale。

`review-center-service.ts`

- 给前端 Review Center 聚合 DTO。
- 产出 headlineStatus、qaAllowed、counts、findings、waivers、mirrorWarnings、actions、advancedDetails。

`review-qa-gate-service.ts`

- 进入 QA 的硬 gate。
- 校验 latest valid review。
- 校验 source build freshness 和 HEAD。
- 校验 open P0/P1 blockers、waiver reason、legacy incomplete。

`review-waiver-service.ts`

- 处理 Review P1 waiver。
- P0 不允许 waiver。
- waiver 后需要重新结算 report。

`review-artifact-mirror-service.ts`

- 管理 review report / findings 镜像检查和重建。

### 6.10 QA / Merge

`qa-run-service.ts`

- 从 TestPlan required commands 初始化 QA run。
- 记录 command result、evidence、failure。
- 重新计算 QA gate。

`merge-readiness-service.ts`

- 汇总 PRD、Spec、Plan、TestPlan、Build、Review、QA gate。
- 检查 latest adopted build。
- 检查 latest QA run。
- 检查 review state。
- 检查 requirement gaps。
- 检查 Git HEAD。
- 写 `merge_readiness` 和 `merge_blockers`。

`gate-service.ts` 在 merge approve 时会调用 merge readiness，并写 human decision、merge approval、merge decision。

## 7. 数据库模型

所有 schema 当前集中在 `server/db/schema.ts`。主要表族：

### 基础表

- `projects`
- `changes`
- `runs`
- `events`
- `artifacts`
- `findings`

### DB-first stage authority

- `stage_states`
- `stage_runs`
- `stage_reports`
- `stage_gates`
- `stage_actions`

### Spec Battle

- `battle_rounds`
- `requirement_gaps`
- `red_fix_claims`
- `blue_gap_reviews`
- `human_decisions`
- `war_reports`

### PRD Briefing

- `prd_briefings`
- `briefing_questions`
- `prd_drafts`

### Plan / TechSpec / TestPlan

- `plan_snapshots`
- `plan_steps`
- `plan_risks`
- `plan_approvals`
- `techspec_snapshots`
- `api_snapshots`
- `testplan_snapshots`
- `testplan_coverage_items`
- `testplan_risk_mappings`
- `testplan_manual_checks`
- `required_validation_commands`

### Build / Review / QA / Merge

- `build_run_records`
- `review_attempts`
- `review_reports`
- `review_state`
- `review_artifact_mirrors`
- `review_prior_finding_reviews`
- `qa_runs`
- `qa_command_results`
- `qa_failures`
- `qa_evidence`
- `merge_readiness`
- `merge_blockers`
- `merge_approvals`
- `merge_decisions`

### Mirror / legacy

- `artifact_mirrors`
- `legacy_imports`

判断：schema 已经覆盖 DB-first pipeline 的大多数关键实体，但所有表集中在一个 1000 行文件中。长期建议按领域拆分 schema，再用 barrel 统一导出。

## 8. 前端结构

主要页面：

- `app/projects/page.tsx`：项目列表。
- `app/projects/[id]/page.tsx`：项目详情，包含 changes、PRD、context、baseline、Git。
- `app/projects/[id]/changes/[changeId]/page.tsx`：change 主控制台。

Change 主控制台职责很重：

- 轮询 change/gate/specBattle/planSandbox/prdBriefing/reviewCenter。
- 展示 Pipeline rail。
- 渲染 PRD Briefing、Spec Battlefield、Plan Sandbox、Build Sandbox、Review Center。
- 处理 gate approve/reject。
- 处理 run_plan、run_build、run_review、enter_qa、merge 等 action。
- 展示 events、findings、artifacts、diff、phase review。

专项组件：

- `prd-briefing-room.tsx`
- `spec-battlefield.tsx`
- `plan-sandbox.tsx`
- `build-sandbox.tsx`
- `review-report-center.tsx`
- `editable-phase-artifact.tsx`
- `pipeline-action-contract.ts`

前端已经在逐步消费后端 action contract。例如 Build Sandbox 和 Review Center 都通过 `pipeline-action-contract.ts` 组装 preflight payload。

## 9. 测试覆盖

当前有 64 个测试文件，覆盖面较好，尤其集中在 service 层。

重点测试对象：

- DB migrations
- pipeline-service
- stage-authority-service
- action-contract-service
- preflight-service
- gate-service
- spec-battle-service / rules / ledger / report
- plan-sandbox-service
- build-workspace-service / build-run-record-service
- review-run-service / review-report-service / review-center-service / review-qa-gate-service / review-waiver-service
- qa-run-service
- merge-readiness-service
- artifact-mirror-service / review-artifact-mirror-service
- route security / route contract
- 关键前端组件逻辑测试

测试数量说明项目对 DB-first 和 gate 边界比较重视。后续重构时应优先保持这些测试绿色。

## 10. 当前架构判断

### 做得好的地方

1. 产品和技术方向清楚：从文件驱动迁移到 DB-first。
2. Review DB 化完成度较高，是其他阶段可参考的样板。
3. Stage authority / action contract / preflight 是很好的核心边界。
4. Spec Battle 的 gap ledger 和 deterministic report 思路清晰。
5. Build 使用隔离 worktree，避免直接污染主仓。
6. 测试覆盖面较广，适合支撑后续模块化重构。

### 主要复杂度

1. `pipeline-service.ts` 过重。
   - 它既是编排器，又包含多个阶段的 schema、校验、渲染、snapshot、mirror 逻辑。
   - 最适合优先拆出 Plan/TechSpec/TestPlan/Review/Build stage service。

2. `app/projects/[id]/changes/[changeId]/page.tsx` 过重。
   - 它同时承担数据拉取、轮询、状态映射、gate 动作、多个 panel 和错误处理。
   - 后续建议抽 hooks、API client、phase constants、action handlers。

3. `server/db/schema.ts` 过大。
   - 当前所有表都在一个文件。
   - 建议后续按 `core`、`stage`、`prd`、`spec`、`plan`、`build`、`review`、`qa`、`merge`、`mirror` 拆分。

4. Plan Sandbox 仍存在文件权威残留。
   - 当前仍读取/写入 `plan.json`、`plan.md`、`plan-critique.json` 再同步 DB。
   - 应继续迁移为 DB snapshot 是权威，文件只从 DB render。

5. API preflight 接入不完全统一。
   - `plan`、`check`、`build-workspace` 等已经较好接入 action contract。
   - `review` route 有自己的 idempotency/preflight 流程，后续可进一步统一到 action contract。

## 11. 建议后续模块化顺序

建议避免“大搬家式重构”，采用垂直、可测试的小步拆分。

### 第一优先级：拆 pipeline-service

目标是让 `pipeline-service.ts` 回到“总编排 facade”，阶段细节下沉。

建议拆分：

- `document-stage-runner.ts`
  - `runDocumentStage`
  - timeout
  - run lifecycle
  - workspace mutation guard

- `plan-stage-service.ts`
  - Plan structured schema
  - Plan 校验
  - Plan markdown 渲染
  - `generatePlan`
  - `approvePlan`

- `techspec-stage-service.ts`
  - TechSpec/API candidate 选择
  - snapshot 持久化
  - mirror 渲染
  - `runTechSpec`

- `testplan-stage-service.ts`
  - TestPlan output schema
  - TestPlan snapshot 持久化
  - `runTestPlan`

- `review-stage-service.ts`
  - `preflightReviewRun`
  - `runReview`
  - Review raw output/error envelope 写入

### 第二优先级：拆 change 主页面

建议拆分：

- `change-phase-map.ts`
- `use-change-detail-state.ts`
- `use-gate-actions.ts`
- `use-pipeline-polling.ts`
- `phase-review-panel.tsx`
- `event-stream-panel.tsx`
- `findings-panel.tsx`
- `artifacts-panel.tsx`
- `changed-files-panel.tsx`
- `refine-chat-panel.tsx`

### 第三优先级：schema 分域

先不改变 DB 行为，只做导出结构调整：

```text
server/db/schema/
  core.ts
  stage.ts
  prd.ts
  spec.ts
  plan.ts
  build.ts
  review.ts
  qa.ts
  merge.ts
  mirror.ts
  index.ts
```

## 12. 后续开发注意事项

1. 新功能不要绕过 `ActionContractService` 和 `PreflightService`。
2. 新阶段不要让 `.ship`、JSON、Markdown 成为后端权威。
3. 进入 QA / Merge 的判断必须从 DB gate 和 Git facts 来。
4. Review P0 不允许 waiver；P1 waiver 必须有 reason，并重新结算 report。
5. Build 必须保持隔离 worktree / patch / adoption record 这条线。
6. 修改 route 时注意 App Router 方括号路径在 shell 中需要加引号。
7. 大文件重构前先跑对应 service 测试，再跑 `pnpm test`。

## 13. 当前工作区状态

本次阅读时 `git status --short` 无输出，说明工作区干净。

本报告只做静态阅读和结构分析，没有运行 `pnpm test` 或 `pnpm build`。

