# Tech Spec：stagepass 全后端数据库化流水线

| 项 | 值 |
|---|---|
| 文档状态 | v4.0 待 Tech Review 草案 |
| 版本 | v4.0 |
| 关联 PRD | [docs/prd.md](./prd.md) |
| 最后更新 | 2026-06-29 |
| 核心原则 | PRD 到 Merge 全流程 DB 权威；JSON / Markdown / `.ship` 只作镜像 |

---

## 一、总原则

v4.0 的目标是把 stagepass 从“文件产物 + 局部 DB 化”升级为“全后端 DB 权威”。从 PRD、Spec、Plan、TestPlan、Build、Review、QA 到 Merge，所有状态推进、gate、preflight、action enablement、freshness、latest valid 选择和准入判断，只能读取 DB 权威表与 Git 当前事实。

一句话原则：

```text
DB 当裁判。
Git 当前事实当现场。
JSON / Markdown / .ship 当 AI / 人工可读镜像。
AI 可以读镜像，但 AI 输出必须重新 validate 后写 DB。
人类可以看镜像，但所有按钮和后端推进只认 DB。
```

硬边界：

1. 新流程不得产生 JSON-only、Markdown-only、`.ship`-only 后端状态。
2. 所有阶段必须先写 DB transaction，再从 DB 渲染镜像。
3. DB 写入失败，本阶段不得通过。
4. 镜像缺失、损坏、过期只产生 mirror warning，不改变主状态。
5. DB 缺少权威记录时必须阻断推进，不得回退读取旧 JSON / Markdown。
6. 任何旧文件恢复为权威前，必须走当前 DB preflight、HEAD freshness、source lineage、人类确认和 `legacy_imports` 审计记录；当前代码库没有正式导入 / 恢复服务入口。

## 二、系统架构

### 2.1 现状

```text
Next.js 16 (App Router + API Routes)
  ├─ app/                   前端页面 + API routes
  ├─ server/
  │   ├─ db/                SQLite + Drizzle ORM
  │   ├─ services/          pipeline / engine / scope / git / gate
  │   ├─ types/             enums + zod schema
  │   └─ templates/prompts/
  └─ .ship/                 现有 AI / 人工可读产物目录
```

现有 pipeline 仍保留，但 v4.0 后端流程不得再把 `.ship`、`plan.json`、`findings.json`、Markdown report 当作阶段真相。

### 2.2 改造后

```text
API route / UI action
  -> ActionContractService.getActions(changeId)
  -> PreflightService.assertActionAllowed(...)
  -> Stage service transaction
  -> DB authority tables
  -> deterministic gate + latest valid
  -> ArtifactMirrorService.renderFromDb(...)
  -> UI DTO / action contract
```

`.ship/` 保留，但定位改为：

```text
.ship/baseline/*              人工阅读、AI 上下文镜像
.ship/changes/<id>/**/*.json  审计导出、AI 上下文镜像
.ship/changes/<id>/**/*.md    人工战报镜像
```

这些文件不得作为后端流程权威。

## 三、模块划分

| 模块 | 服务 / 文件建议 | 职责 |
|---|---|---|
| 阶段状态 | `stage-state-service.ts` | 维护 `stage_states`，提供阶段当前权威状态 |
| 阶段执行 | `stage-run-service.ts` | 创建 / 结束 `stage_runs`，处理幂等、失败、source lineage |
| 阶段报告 | `stage-report-service.ts` | 从 DB deterministic 结算 `stage_reports` |
| 阶段 Gate | `stage-gate-service.ts` | 从 DB + Git facts 计算 `stage_gates` |
| Action 契约 | `action-contract-service.ts` | 生成 UI 按钮和执行 API 共用的 action contract |
| Preflight | `preflight-service.ts` | 执行动作前复用同源 gate / action contract |
| 镜像 | `artifact-mirror-service.ts` | 只允许 DB -> `.ship` / JSON / Markdown |
| Legacy import audit | `legacy_imports` table + phase display blockers | 保留历史导入审计、展示和阻断语义；当前没有正式导入 / 恢复服务入口 |
| Git Base Camp | `git-base-camp-service.ts` | Git 初始化检查、HEAD、worktree、baseline、adoption freshness |
| Build | `build-run-service.ts` | 隔离 workspace / worktree 中施工、校验、收编 |
| Review | `review-run-service.ts` / `review-report-service.ts` / `review-qa-gate-service.ts` | Review v3.8 DB 化专项 |
| Merge | `merge-readiness-service.ts` | 汇总所有阶段 gate、findings、HEAD freshness、审批 |

## 四、核心 DB 技术契约

### 4.1 通用权威表

| 表 | 核心字段 | 职责 |
|---|---|---|
| `stage_states` | `id`, `changeId`, `phase`, `status`, `latestRunId`, `latestReportId`, `latestGateId`, `latestValidReportId`, `dbHash`, `version`, `updatedAt` | 每阶段当前权威状态 |
| `stage_runs` | `id`, `changeId`, `phase`, `attemptNo`, `status`, `idempotencyKey`, `inputDbHash`, `outputDbHash`, `sourceLineageJson`, `errorCode`, `startedAt`, `completedAt` | 阶段执行 / 尝试 |
| `stage_reports` | `id`, `changeId`, `phase`, `sourceRunId`, `status`, `countsJson`, `isFresh`, `staleReason`, `reportDbHash`, `generatedAt` | deterministic report 结算 |
| `stage_gates` | `id`, `changeId`, `phase`, `status`, `blockersJson`, `freshnessJson`, `requiredActionsJson`, `sourceDbHash`, `gateVersion`, `computedAt` | 阶段 gate 裁决 |
| `stage_actions` | `id`, `changeId`, `phase`, `actionId`, `enabled`, `reasonCode`, `reason`, `blockersJson`, `gateVersion`, `sourceDbHash`, `requiresIdempotencyKey`, `computedAt` | UI / API 共用 action 快照 |
| `human_decisions` | `id`, `changeId`, `phase`, `decisionType`, `targetType`, `targetId`, `reason`, `actor`, `createdAt` | 人类批准、拒绝、豁免、终止、重跑、收编 |
| `findings` | `id`, `changeId`, `phase`, `source`, `severity`, `status`, `title`, `evidenceJson`, `requiredFix`, `waivable`, `sourceRunId`, `sourceReportId`, `createdAt`, `updatedAt` | P0/P1/P2 阻断和风险 |
| `artifact_mirrors` | `id`, `changeId`, `phase`, `artifactType`, `path`, `contentHash`, `sourceDbHash`, `schemaVersion`, `mirrorStatus`, `generatedAt` | 镜像索引和审计状态 |
| `legacy_imports` | `id`, `changeId`, `phase`, `sourcePath`, `sourceArtifactHash`, `schemaVersion`, `importStatus`, `importResultJson`, `importedAt` | 历史文件导入审计 |

`stage_states.latestValidReportId` 不得指向 `failed`、`invalid_output`、`data_inconsistent`、`legacy_incomplete` 或 freshness 不可判定的 report。latest valid 可以是 stale 的历史有效 report，但 action / QA / Merge gate 必须额外要求 fresh。

### 4.2 阶段专用表建议

| 阶段 | 表建议 |
|---|---|
| PRD | `prd_briefings`, `prd_questions`, `prd_answers`, `prd_assumptions`, `prd_drafts`, `prd_locks` |
| Spec | `spec_rounds`, `requirement_gaps`, `gap_reviews`, `spec_reports` |
| Plan | `plan_snapshots`, `plan_steps`, `plan_risks`, `plan_approvals` |
| TestPlan | `testplan_snapshots`, `test_coverage_items`, `test_risk_mappings`, `required_validation_commands` |
| Build | `build_runs`, `build_worktrees`, `build_diffs`, `build_deviations`, `build_validations`, `build_adoptions` |
| Review | `review_attempts`, `review_reports`, `review_prior_finding_reviews`, `review_waivers` |
| QA | `qa_runs`, `qa_command_results`, `qa_failures`, `qa_evidence`, `qa_fix_requirements` |
| Merge | `merge_readiness`, `merge_blockers`, `merge_approvals`, `merge_decisions` |

阶段专用表可以按实现调整命名，但不得缺少通用职责：state、run、report、gate、action、human decision、finding、mirror、freshness / source lineage。

## 五、全阶段读写顺序

### 5.1 写入顺序

```text
AI / deterministic output
  -> schema validation
  -> normalize
  -> DB transaction
  -> recompute report
  -> recompute gate
  -> recompute action contract
  -> render mirrors from DB
  -> expose UI DTO from DB
```

### 5.2 读取顺序

```text
DB authority rows
  -> Git current facts when required
  -> deterministic gate service
  -> latest valid selector
  -> action contract
  -> UI DTO / API response
```

禁止读取链路：

```text
.ship JSON -> gate
.ship Markdown -> gate
plan.json -> Build scope authority
findings.json -> QA / Merge blocker authority
review-report.md -> QA gate
review-findings.json -> Review finding authority
war-report.md -> Merge readiness
artifact existence -> stage passed
AI natural language summary -> gate
frontend local inference -> action enabled
```

## 六、ActionContractService 与 PreflightService

所有 UI 按钮必须来自 `ActionContractService.getActions(changeId)`。执行 API 必须复用同一套 `PreflightService.assertActionAllowed(changeId, actionId, expectedGateVersion, expectedSourceDbHash)`。

```ts
interface PipelineActionContract {
  actionId: string;
  phase: "PRD" | "Spec" | "Plan" | "TestPlan" | "Build" | "Review" | "QA" | "Merge";
  enabled: boolean;
  reasonCode: string | null;
  reason: string | null;
  blockers: Array<{ id: string; severity: "P0" | "P1" | "P2"; title: string }>;
  gateVersion: string;
  sourceDbHash: string;
  requiresIdempotencyKey: boolean;
}
```

契约要求：

1. 如果后端 preflight 会拒绝动作，UI contract 必须提前 `enabled=false`，并展示同源 `reasonCode` / `reason` / `blockers`。
2. 如果 UI 获取 contract 后 DB 状态、Git HEAD、gate version 或 source DB hash 已变化，执行 API 必须返回 `409`，并带新的 action contract。
3. 需要产生 side effect 的动作必须 `requiresIdempotencyKey=true`，包括 run、retry、waive、adopt、enter QA、merge。
4. 前端不得根据 `ChangeStatus`、阶段文案、artifact 是否存在、JSON / Markdown 内容或 ReviewCenter boolean 自行推断按钮可用性。
5. Action contract 必须持久化到 `stage_actions`，方便审计 UI 当时为什么可点或不可点。

## 七、ArtifactMirrorService

`ArtifactMirrorService` 只允许从 DB 渲染 `.ship`、JSON、Markdown，并写入 `artifact_mirrors`。重建镜像不得改变以下主状态：

```text
stage_states
stage_runs
stage_reports
stage_gates
stage_actions
human_decisions
findings
latest valid 指针
Build adoption / adoptedHeadSha
QA / Merge readiness
```

镜像状态：

| 状态 | 含义 | 是否影响 gate |
|---|---|---|
| `ok` | 镜像内容与 `sourceDbHash` 匹配 | 否 |
| `missing` | 文件不存在，可从 DB 重建 | 否 |
| `mismatch` | 文件内容与 DB hash 不一致 | 否 |
| `corrupt` | 文件不可解析或损坏 | 否 |
| `generation_failed` | DB 完整但渲染失败 | 否 |
| `not_indexed` | 历史文件未纳入镜像索引 | 否 |

`mismatch` / `corrupt` 不得反向覆盖 DB。它们只进入审计、warning 和“从 DB 重建镜像”动作。

## 八、Legacy Import 审计边界

历史 `.ship`、JSON、Markdown 不得作为后端权威直接参与流程推进。`legacy_imports` 表保留历史导入审计、UI 展示和阻断语义，但当前代码库没有正式的 legacy import / restore 服务入口；新增入口前必须重新设计并接入当前 DB preflight、HEAD freshness、source lineage 和人类确认。

`legacy_imports.importStatus` 至少支持：

| 状态 | 含义 | 是否可参与 latest valid / action / QA / Merge |
|---|---|---|
| `legacy_imported_readonly` | 可展示的历史只读记录 | 否 |
| `legacy_candidate` | 字段较完整，但尚未恢复权威 | 否 |
| `legacy_incomplete` | 字段缺失、schema 不明、freshness 不可信 | 否 |

未来如果恢复正式导入 / 恢复入口，恢复权威必须同时满足：

1. 当前版本 DB preflight 通过。
2. 当前 HEAD 与 source lineage / Build adoption freshness 可证明一致。
3. `sourceArtifactHash`、schemaVersion、导入时间和 normalized payload 可审计。
4. P0/P1 blocking finding、审批和人类决策规则没有被绕过。
5. 人类提交显式迁移确认，写入 `human_decisions`。
6. 系统用当前 schema 重新 normalize legacy candidate，并生成新的 DB 权威 row / report / gate；`legacy_imports` 只保留审计 lineage。

任何 legacy 记录本身不得直接参与 latest valid state、action enablement、QA gate 或 Merge gate。即使 `legacy_candidate` 通过校验，参与后续流程的也只能是新生成的当前 schema DB 权威记录，而不是 `legacy_imports` 行或旧镜像内容。

## 九、阶段权威边界

| 阶段 | 后端权威读取 | 后端权威写入 | 禁止 |
|---|---|---|---|
| PRD | DB change intent、用户输入、既有 PRD state | briefing、疑点卡、回答、AI 假设、draft、lock、gate、action | 不得把 `prd-draft.md`、`briefing-questions.json` 当锁定依据 |
| Spec | DB locked PRD baseline、deferred questions、历史 gap ledger | rounds、Requirement Gap、gap review、Spec report、Spec gate | 不得把 round JSON、spec report Markdown 当 gate |
| Plan | DB approved Spec / TechSpec snapshot、open/waived findings、source lineage | approved Plan snapshot、steps、expectedFiles、forbiddenFiles、validationCommands、Plan Risk、approval、gate | 不得把 `plan.json` / `plan.md` 当批准或 Build 输入 |
| TestPlan | DB PRD / Spec / Plan snapshot、risk mapping | coverage items、required commands、manual checks、TestPlan gate | 不得把 Markdown 测试计划当 QA 准入 |
| Build | DB approved Plan snapshot、DB TestPlan、DB TechSpec/API snapshot、Git facts、允许读取的源码文件 | BuildRun、worktree metadata、diff hash、changedFiles hash、deviation、validation、audit、adoption | 不得读取 `plan.json`；不得在无 Git 项目正式 Build |
| Review | DB latest adopted BuildRun、Build diff metadata、DB Plan/TestPlan/TechSpec、源码快照、DB historical findings | Review attempts、findings、prior finding review、waiver、report、Review gate | 不得读 `review-report.md` / `review-findings.json` / `findings.json` 当 gate |
| QA | DB Review QA gate、DB TestPlan commands、DB open findings、latest adopted Build/Fix lineage、Git facts | QA run、command result、test evidence、failure、fix requirement、QA gate | 不得把测试日志 Markdown 当 QA passed |
| Merge | DB 全阶段 gates、blocking findings、approvals、QA result、HEAD freshness | merge readiness、final gate、merge decision | 不得把 war report Markdown 或 `.ship` 文件存在当 passed |

## 十、Plan-Build 边界

Plan 阶段输出的是 DB approved Plan snapshot，不是 `plan.json` 权威文件。

Build 必须遵守：

1. Build 不得读取 `plan.json` 作为 scope、步骤、`expectedFiles`、`forbiddenFiles` 或 validation commands 权威。
2. Build 只能读取 DB approved Plan snapshot、DB TestPlan、DB TechSpec / API snapshot 和 Git 当前事实。
3. `expectedFiles` 表示预计改动范围，expected 外 diff 只产生 `BuildDeviation`、audit finding 或人工确认项，不自动失败。
4. `forbiddenFiles`、policy violation、path escape、secret、Git safety violation 是硬阻断，必须阻止 adoption。
5. 旧 `allowedFiles` 如需兼容，只能作为 legacy alias 导入 DB Plan snapshot；Build 运行时不得直接读旧 JSON 字段。

## 十一、Build / Git Base Camp

正式 Build 的前置条件：

1. 项目必须是有效 Git 仓库；无 Git 只能做需求草稿、上下文整理和初始化引导。
2. 必须存在可记录的 base commit / current HEAD。
3. 必须能创建隔离 workspace / worktree，Build Runner 不得在主仓工作区直接施工。
4. worktree path 必须在受控目录，禁止 path escape、覆盖用户未提交改动或复用不可信目录。
5. BuildRun 必须记录 `baseHeadSha`、`worktreePath`、`patchHash`、`changedFilesHash`、validation results 和 audit findings。

Build adoption：

1. 只有人类审批 adoption 后，Build 结果才能进入主仓或被标记为 adopted。
2. `adopt_*` preflight 必须确认主仓工作区 clean，且当前 HEAD 等于 BuildRun 记录的 `baseHeadSha` / `baseCommit`。
3. 如果主仓有未提交改动、当前 HEAD 漂移，或 BuildRun base 与当前 HEAD 不一致，`adopt_*` preflight 必须返回 `409` 或 blocked contract，禁止收编。
4. adoption 成功后必须写入 `BuildRun.status="adopted"`、`adoptedHeadSha`、`adoptionDecisionId`。
5. Review 只能基于 latest adopted BuildRun 开始。
6. Review、QA、Merge 都必须校验 `adoptedHeadSha` 与当前 HEAD freshness。
7. HEAD drift、patch hash drift、changed files hash drift 或新 Build adoption 后，相关 Review / QA / Merge action contract 必须 stale；执行 API 返回 `409` + 新 contract。

## 十二、Review / QA / Merge 边界

Review v3.8 的有价值内容保留为本专项，但它必须服从前文全阶段 DB 权威契约。

### 12.1 Review 状态与模型

Review 不再由前端拼凑 `runs.summary`、`review-report.md`、`review-findings.json` 和 DB findings。Review Center API 只能聚合 DB Review attempts / reports / findings、latest adopted BuildRun、waiver、prior finding review 和 artifact mirror metadata。

核心状态：

```ts
type ReviewRunStatus =
  | "passed"
  | "issues_found"
  | "failed"
  | "invalid_output"
  | "data_inconsistent";

type ReviewGateStatus =
  | "not_started"
  | "running"
  | "passed"
  | "blocked_p0"
  | "blocked_p1"
  | "failed"
  | "invalid_output"
  | "data_inconsistent"
  | "stale"
  | "legacy_incomplete";
```

`invalid_output` 表示 AI 输出非法 JSON、缺少必填字段、P0/P1 缺少 `evidence` 或 `requiredFix`、P2 缺少 `evidence`。该状态必须保存脱敏 raw output metadata，但不得伪装成无 findings。

`data_inconsistent` 只表示 DB 主状态内部矛盾，例如 report counts 与 DB findings 不一致、latest valid 指针无效、waiver 与 finding 状态冲突。`.ship` 镜像缺失或不一致不得写成 `data_inconsistent`。

### 12.2 ReviewFinding 契约

```ts
interface ReviewFinding {
  id: string;
  changeId: string;
  source: "review";
  severity: "P0" | "P1" | "P2";
  status: "open" | "fixed" | "waived";
  title: string;
  file: string | null;
  line: number | null;
  evidence: string;
  requiredFix: string | null;
  waivable: boolean;
  sourceRunId: string;
  sourceReportId: string | null;
}
```

校验规则：

1. P0 必须有 `evidence` 和 `requiredFix`，`waivable=false`，不能豁免。
2. P1 必须有 `evidence` 和 `requiredFix`，`waivable=true`，可由人类带 reason 豁免。
3. P2 必须有 `evidence`，`requiredFix` 可为空，默认不阻断 gate。
4. 旧 `suggestion` / `recommendation` 只允许作为 legacy parser 输入，新 DB / API / UI 主路径只输出 `requiredFix`。

### 12.3 latestAttempt / latestValidReview

`latestAttempt`：

1. 从 `review_attempts` 按 `attemptNo DESC, startedAt DESC, id DESC` 选择。
2. 可返回 running、passed、issues_found、failed、invalid_output、data_inconsistent。
3. 失败、输出非法、数据不一致必须持久化，但不得覆盖上一轮有效战报。

`latestValidReview`：

1. 候选只能来自 DB `review_reports`，不得从 Markdown / JSON 反推。
2. 候选必须对应已结束 attempt，AI 输出已成功解析，findings 已写 DB，report 由 `review-report-service` 从 DB 生成。
3. 候选 `status` 只能是 `passed` 或 `issues_found`。
4. `failed`、`invalid_output`、`data_inconsistent`、`legacy_incomplete`、running attempt 不得进入候选集合。
5. Fresh 判定必须同时满足：`sourceBuildRunId === latest adopted BuildRun.id`、`buildHeadSha === BuildRun.adoptedHeadSha`、当前 `HEAD === BuildRun.adoptedHeadSha`、patch / changed files hash 一致、report 未因 waiver / finding 状态变化 / Build adoption 变化而 stale。

### 12.4 QA Gate

所有进入 QA 的入口，包括 UI、API、pipeline、旧 `runCheck` / `continue` / auto-advance，都必须调用同一个 Review QA Gate service 或统一 `PreflightService` action。

进入 QA 的必要条件：

1. 存在 fresh `latestValidReview`。
2. 无 running Review attempt。
3. 无 open P0 Review finding。
4. 无 open P1 Review finding；P1 waiver 后必须重新结算或重新 Review，不能沿用旧 fresh report。
5. Review 绑定 latest adopted BuildRun，且当前 HEAD 与 `adoptedHeadSha` 一致。
6. 非 legacy incomplete / legacy candidate 状态。
7. DB 主状态一致。

禁止任何 route / service 直接读取 `review-report.md`、`review-findings.json`、`findings.json` 或 `runs.summary` 来进入 QA。

### 12.5 Fix 后复核边界

Fix 必须产生新的 FixRun / BuildRun adoption。Review 不得把“用户说已修复”或旧 report 当作复核依据。

流程要求：

```text
open P0/P1
  -> fix_blockers action
  -> FixRun / BuildRun in isolated workspace
  -> human adoption
  -> new adoptedHeadSha
  -> new Review attempt
  -> prior finding review
  -> new Review gate
```

新一轮 Review 必须对旧 open P0/P1 写入 `review_prior_finding_reviews`：

| 字段 | 说明 |
|---|---|
| `attemptId` | 当前 Review attempt |
| `priorFindingId` | 上一轮 open P0/P1 |
| `verdict` | `still_open` / `fixed` / `downgraded` / `not_reviewable` |
| `evidence` | 复核证据，必填 |
| `reason` | 复核理由，必填 |
| `resultingFindingId` | 降级或仍 open 时可关联新 finding |

未被复核的旧 P0/P1 保持 open，并标记 `not_rechecked`；不得因新一轮反方漏报而自动关闭。

### 12.6 P1 Waiver

P1 waiver 必须在事务内完成：

1. 校验 finding 属于当前 change、`source="review"`、`severity="P1"`、`status="open"`、`waivable=true`。
2. 校验 reason 非空，写入 actor、timestamp、finding snapshot 和 previous report。
3. Conditional update finding `open -> waived`。
4. 写入 `human_decisions` 或 `review_waivers`。
5. 将相关 `review_reports` 标记 stale，`staleReason="p1_waiver_changed_findings"`。
6. 重新结算或重新 Review 成功前，QA gate 不得通过。

P0 waiver 必须拒绝。P2 不需要 waiver。

### 12.7 Merge Gate

Merge readiness 必须只读 DB 和 Git 当前事实：

```text
canMerge(changeId) =
  PRD / Spec / Plan / TestPlan / Build / Review / QA required gates passed
  && required human approvals complete
  && latest adopted BuildRun fresh
  && QA result fresh
  && current HEAD == latest adoptedHeadSha / QA source HEAD
  && no open P0/P1 blocking findings
  && no stale latest valid gate required for Merge
```

`war-report.md`、Review report、QA log、`.ship` 文件存在与否都不得作为 Merge passed 依据。

## 十三、错误、并发与安全

错误语义：

| 场景 | 响应 |
|---|---|
| 输入非法 / schema 不合法 | `422` |
| 状态变化、gateVersion / sourceDbHash / HEAD 漂移 | `409` + 新 action contract |
| 无权限 / 项目不匹配 | `403` / `404` |
| provider 失败 | run 写 `failed`，不当作无 findings |
| AI 输出不合法 | run 写 `invalid_output`，保存脱敏 raw output metadata |
| DB 主状态内部矛盾 | report / run 写 `data_inconsistent`，要求重新结算或重跑 |
| 镜像缺失 / 损坏 | 更新 `artifact_mirrors.mirrorStatus`，不改变 gate |

并发要求：

1. 同一 change 同一阶段同一时间只允许一个 running run，除非阶段明确支持并发并有隔离 key。
2. `run_*`、`retry_*`、`adopt_*`、`waive_*`、`enter_qa`、`merge` 必须要求 idempotency key。
3. 重算 report 和重建 mirror 必须 deterministic，可重复执行。
4. P1 waiver、finding 状态变更、report stale、Build adoption 必须事务化。

安全要求：

1. read-only 阶段不得修改源码，只能写 DB 和镜像。
2. Build / Fix 只能在隔离 workspace / worktree 中修改源码。
3. `forbiddenFiles`、path escape、secret、Git safety violation 必须硬阻断。
4. Raw output 默认不返回全文；保存前必须脱敏、截断，UI 展示必须 escape。
5. 默认 DTO 不暴露绝对 artifact 路径、raw JSON、provider secret、内部 DB enum。

## 十四、迁移顺序

1. Additive migration 新增通用 `stage_*`、`artifact_mirrors`、`legacy_imports` 表。
2. 新增 `ActionContractService` 与 `PreflightService`，让 UI 与执行 API 同源。
3. 新增 `ArtifactMirrorService`，把现有 `.ship` 写入改成 DB -> mirror。
4. 将 Plan 权威从 `plan.json` 迁移到 DB Plan snapshot，保留 `plan.json` / `plan.md` 镜像。
5. 将 Build scope、validation、adoption 全部改读 DB + Git facts。
6. 落地 Git Base Camp、隔离 worktree、BuildRun adoption、`adoptedHeadSha` freshness。
7. 将 Review v3.8 专项表、latestAttempt / latestValidReview、QA Gate service 接入。
8. 将 QA / Merge gate 改为只读 DB Review / QA / Merge readiness。
9. 保留 `legacy_imports` 审计、展示和阻断能力；正式 legacy import / restore 入口需另行设计，默认不放行历史 JSON-only change。

## 十五、验收测试

必须覆盖：

1. 删除所有 `.ship` JSON / Markdown 后，DB gate 和 action 仍正确，只显示 mirror warning。
2. 篡改 `.ship` JSON 写成 passed，后端 gate 不读取该结果。
3. 篡改 `plan.json` 后，Build 仍读取 DB approved Plan snapshot。
4. DB blocked 但 `review-report.md` 写 passed 时，UI、API、QA、Merge 全部拒绝且 reason 同源。
5. `review-findings.json` 缺少 DB open P0/P1 时，不覆盖 DB findings。
6. DB 完整但镜像缺失时，可从 DB 重建镜像，且不改变主状态或 gate。
7. legacy imported readonly / candidate / incomplete 均不得直接进入 latest valid、action、QA gate、Merge gate。
8. UI action disabled reason 与执行 API preflight 拒绝 reason 来自同一 action contract。
9. UI 获取 contract 后 DB 或 HEAD 变化，执行 API 返回 `409` + 新 contract。
10. Build 在无 Git 项目中被正式动作阻断。
11. Build 在隔离 worktree 完成后，未 adoption 不得进入 Review。
12. Review 绑定旧 `adoptedHeadSha` 时，QA gate 返回 stale。
13. Fix 后未产生新 BuildRun adoption 时，不得用旧 Review 关闭旧 blocker。
14. P1 waiver 后 report stale，重新结算或重新 Review 前不能进入 QA。
15. Merge gate 在任一阶段 gate stale、缺审批、HEAD drift、open P0/P1 时拒绝，即使 Markdown 战报显示可合并。

## 十六、明确非目标

1. 不取消 `.ship`、JSON、Markdown 作为 AI / 人工可读材料。
2. 不让 `.ship`、JSON、Markdown 恢复为流程权威。
3. 不让 Review AI 直接写 DB 主状态；AI 输出必须经 parser / validator / reporter 结算。
4. 不支持无 Git 项目进入正式 Build / Review / QA / Merge。
5. 不允许 P0 waiver / override。
6. 不允许前端绕过 DB action contract 自行猜测按钮是否可点。
7. 不一次性强制修复全部历史数据；不完整历史数据可展示，但不得参与 gate。
