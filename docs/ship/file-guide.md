# CC-AI 文件索引

## 一、入口与配置

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `package.json` | 项目元数据、依赖、脚本 | `name: "stagepass"`, `version: "0.1.0"` |
| `tsconfig.json` | TypeScript 编译配置 | target: ES2017, strict: true, paths: `@/*` |
| `next.config.ts` | Next.js 框架配置 | — |
| `drizzle.config.ts` | Drizzle Kit 迁移配置 | — |
| `components.json` | shadcn/ui 配置 | — |
| `eslint.config.mjs` | ESLint 规则 | — |
| `postcss.config.mjs` | PostCSS 插件 | Tailwind CSS |

---

## 二、数据库层（server/db/）

### `server/db/schema.ts`
**职责**：定义全部 40+ 张 Drizzle ORM 表的 schema。

**核心表**：
- `projects`, `changes`, `runs`, `events`, `artifacts` — 基础 CRUD
- `buildRunRecords` — Build 运行记录（patchHash, adoptedHeadSha 等）
- `reviewAttempts`, `reviewReports`, `reviewState`, `reviewArtifactMirrors`, `reviewPriorFindingReviews` — Review 阶段
- `findings` — 通用 findings（P0/P1/P2，source=review/lint/test/scope 等）
- `battleRounds`, `requirementGaps`, `redFixClaims`, `blueGapReviews`, `humanDecisions`, `warReports` — Spec Battle
- `stageStates`, `stageRuns`, `stageReports`, `stageGates`, `stageActions` — Stage Authority 通用层
- `artifactMirrors`, `legacyImports` — 镜像和审计
- `planSnapshots`, `planSteps`, `planRisks`, `planApprovals` — Plan 沙盘
- `techspecSnapshots`, `apiSnapshots`, `requiredValidationCommands` — 技术规格
- `testplanSnapshots`, `testplanCoverageItems`, `testplanRiskMappings`, `testplanManualChecks` — 测试计划
- `qaRuns`, `qaCommandResults`, `qaFailures`, `qaEvidence` — QA 阶段
- `mergeReadiness`, `mergeBlockers`, `mergeApprovals`, `mergeDecisions` — Merge 阶段
- `prdBriefings`, `briefingQuestions`, `prdDrafts` — PRD Briefing Room

### `server/db/index.ts`
**职责**：初始化并导出 `db` 实例（better-sqlite3 + Drizzle ORM + 自动迁移）。

**导出**：`db: Database`

**依赖链**：`./schema` → `./migrate` → WAL 模式启用 → 迁移执行 → 返回 db

### `server/db/migrate.ts`
**职责**：运行增量 SQL 迁移。

**导出**：`runMigrations(sqlite: Database): { applied: string[] }`

### `server/db/db-first-foundation-assertions.ts`
**职责**：验证 DB-first pipeline 所需的基础表结构存在且完整。

**导出**：
- `tableNames(sqlite): string[]`
- `columnNames(sqlite, tableName): string[]`
- `assertColumns(sqlite, tableName, expectedColumns): void`
- `assertDbFirstPipelineFoundation(sqlite): void`

---

## 三、类型定义（server/types/）

### `server/types/enums.ts`
**职责**：定义所有 Zod enum 和对应 TypeScript type。

**导出**：`AiProvider`, `ChangeStatus`(26个), `RunPhase`(12个), `RunStatus`, `EventType`(18个), `FindingSeverity`, `FindingSource`, `FindingStatus`, `PrdStatus`, `ArtifactType`(30+个), `BattleUnit`, `BattleTemplate`, `BattleRoundStatus`, `RequirementGapStatus`, `HumanDecisionAction`, `WarReportStatus`, `Phase`(16个), `PhaseState`

### `server/types/models.ts`
**职责**：定义 Zod schema 和对应 TypeScript type（Project, Change, Run, Event, Artifact, Finding, BattleRound, RequirementGap, HumanDecision, WarReport）。

### `server/types/api.ts`
**职责**：定义 API 请求输入的 Zod schema。

**导出**：`CreateProjectInput`, `ProviderSelectionInput`, `PrdActionInput`, `CreateChangeInput`, `ReworkChangeInput`

### `server/types/prd.ts`
**职责**：PRD 文档结构定义。

**导出**：`StructuredPrd`, `PrdBody`, `PrdUserStory`, `PrdFunctionalRequirement`, `PrdAcceptanceCriterion`, `PrdOpenQuestion`, `PrdSourceReference`, `PrdAiAppendix`, `PrdValidationResult`, `PrdValidationIssue`

---

## 四、核心业务服务（server/services/）

### 4.1 Pipeline 核心

#### `server/services/pipeline-service.ts`
**职责**：Pipeline 总入口，编排全阶段 AI 执行流程。

**关键导出**：
- `runIntake(changeId): Promise<AiRunResult>` — 运行 Intake 评估
- `runSpec(changeId): Promise<AiRunResult>` — 运行 Spec Battle（红方出招 + 蓝方反击 + 战报）
- `runImplement(changeId): Promise<AiRunResult>` — 运行 Build 实现
- `runFix(changeId): Promise<AiRunResult>` — 运行 Fix
- `runReview(changeId, options?): Promise<ReviewResult>` — 运行 Review
- `preflightReviewRun(changeId): ReviewRunPreflight` — Review 前置检查
- **Re-export**: `approveBuildAbsorb`, `approveFixAbsorb`, `rejectBuildRun`, `runImplementStreamed`, `runFixStreamed`, `approvePlan`, `generatePlan`, `runTechSpec`, `runTestPlan`, `assertCanRunCheck`, `runCheck`, `runPrdBriefingQuestions/Draft/FinalReview`, `runRelease`, `runRetro`

**设计思路**：作为 pipeline 的总协调器，将各阶段编排委托给对应的 stage service。同时从多个子模块 re-export 以简化 API 路由的 import。

#### `server/services/pipeline-document-stage-runner-service.ts`
**职责**：通用文档阶段执行器（被 intake/spec/tech_spec/test_plan/prd briefing 等复用）。

**关键导出**：
- `runDocumentStage(changeId, config: DocumentStageConfig): Promise<AiRunResult>` — 通用文档阶段执行
  - 状态校验 → 创建 run → 组装 prompt → AI engine.run() → stage guard 边界校验 → 写 artifact → 更新状态
- `defaultScopeForPhase(phase: RunPhase): StageScope` — 按阶段获取默认 scope
- `DocumentStageConfig` — 配置接口（phase, promptPhase, allowedStatuses, successStatus, artifactType 等）

#### `server/services/pipeline-engine-service.ts`
**职责**：AI 引擎工厂和超时配置。

**关键导出**：
- `getPipelineEngine(provider): Promise<AiEngineAdapter>` — 按 provider 获取引擎
- `documentStageTimeoutMs(phase?): number` — 文档阶段超时（env: `STAGEPASS_DOCUMENT_STAGE_TIMEOUT_MS`）
- `resolveReviewTimeoutMs(): number` — Review 超时（env: `STAGEPASS_REVIEW_TIMEOUT_MS`）
- `buildStreamStartTimeoutMs(): number` — Build 流启动超时
- `DEFAULT_DOCUMENT_STAGE_TIMEOUT_MS = 5min`, `DEFAULT_REVIEW_TIMEOUT_MS = 15min`, `DEFAULT_BUILD_STREAM_START_TIMEOUT_MS = 30s`

#### `server/services/pipeline-run-ledger-service.ts`
**职责**：Run/Artifact 的 DB 和文件系统记账。

**关键导出**：
- `createRun(changeId, phase): string` — 创建新 run 记录
- `endRun(runId, summary, success): void` — 结束 run
- `setStatus(changeId, status, blockedPhase?): Promise<void>` — 更新 change 状态
- `writeRunArtifact(repoPath, changeId, runId, type, fileName, content)` — 写入 run artifact（DB + 文件）
- `writeRunOnlyArtifact(repoPath, changeId, runId, type, fileName, content)` — 只写 run 目录（不覆盖 current）
- `blockStageViolation(changeId, runId, violation): Promise<never>` — stage guard 违规阻断
- `nowISO(): string`

#### `server/services/pipeline-plan-stage-service.ts`
**职责**：Plan 阶段（生成实施计划 + 审批）。

**关键导出**：
- `generatePlan(changeId): Promise<AiRunResult>` — 生成结构化实施计划（要求 JSON outputSchema）
- `approvePlan(changeId): Promise<void>` — 审批计划
- `PLAN_JSON_SCHEMA` — Plan 输出的 JSON Schema（planName, expectedFiles, forbiddenFiles, implementationSteps, testPlan, validationCommands, risks）
- `PlanStep`, `PlanJson` 类型
- `formatPlanAsMarkdown(plan, fallbackSummary): string` — Plan JSON → Markdown
- `requireValidPlanStructuredOutput(value): PlanJson` — 校验 AI 输出的 Plan JSON

#### `server/services/pipeline-design-stage-service.ts`
**职责**：技术设计阶段（TechSpec + TestPlan）。

**关键导出**：
- `runTechSpec(changeId): Promise<AiRunResult>` — 生成 TechSpec 和 API Spec
- `runTestPlan(changeId): Promise<AiRunResult>` — 生成测试计划

#### `server/services/pipeline-prd-briefing-stage-service.ts`
**职责**：PRD Briefing Room 三个阶段。

**关键导出**：
- `runPrdBriefingQuestions(changeId): Promise<AiRunResult>` — AI 反方生成疑点卡
- `runPrdBriefingDraft(changeId): Promise<AiRunResult>` — 生成 PRD 草案
- `runPrdBriefingFinalReview(changeId): Promise<AiRunResult>` — AI 反方最终质询

#### `server/services/pipeline-build-stage-service.ts`
**职责**：Build 阶段（流式实现 + Fix 流式修复 + 收编/拒绝）。

**关键导出**：
- `runImplementStreamed(changeId): Promise<void>` — 流式 Build 实现
- `runFixStreamed(changeId): Promise<void>` — 流式 Fix
- `approveBuildAbsorb(changeId): Promise<void>` — 审批并收编 Build 结果
- `approveFixAbsorb(changeId): Promise<void>` — 审批并收编 Fix 结果
- `rejectBuildRun(changeId): Promise<BuildRunFile>` — 拒绝 Build run
- `recoverCurrentBuildRun(changeId): Promise<BuildRunFile>` — 恢复未完成的 Build run

#### `server/services/pipeline-qa-stage-service.ts`
**职责**：QA 阶段（本地检查）。

**关键导出**：
- `runCheck(changeId, options?): Promise<void>` — 运行本地检查
- `assertCanRunCheck(changeId, options?): ReviewQaGateResult` — 断言可以进入 QA

#### `server/services/pipeline-release-retro-stage-service.ts`
**职责**：发布和复盘阶段。

**关键导出**：
- `runRelease(changeId): Promise<void>` — 运行发布
- `runRetro(changeId): Promise<AiRunResult>` — 生成复盘文档

#### `server/services/pipeline-review-artifact-service.ts`
**职责**：Review 阶段的产物管理（raw output 安全处理、错误脱敏、总结写入）。

**关键导出**：
- `sanitizeReviewError(error, fallbackCode?, options?): { errorCode, summary }` — 脱敏错误
- `redactSecrets(input): string` — 密钥脱敏
- `writeRawReviewOutput(repoPath, changeId, runId, output)` — 保存 raw output
- `writeReviewErrorEnvelope(repoPath, changeId, runId, input)` — 保存错误信封
- `writeReviewRunSummary(runId, summary, success)` — 写 run summary

#### `server/services/pipeline-prompt-context-service.ts`
**职责**：为 Build/Review Prompt 组装设计上下文（TechSpec/API/TestPlan）。

**关键导出**：
- `renderDbPlanScopeForPrompt(changeId): string` — 渲染 DB Plan scope
- `renderDesignInputsForPrompt({techSpec, api}): string` — 渲染设计输入
- `renderDbTestPlanForPrompt(changeId): string` — 渲染测试计划
- `loadBuildDesignInputs(changeId)` / `loadReviewDesignInputs(changeId)` — 加载设计输入

### 4.2 Action Contract 系统

#### `server/services/action-contract-types.ts`
**职责**：Action Contract 核心类型定义。

**导出**：
- `PipelineActionContract` — { actionId, phase, enabled, reasonCode, reason, blockers[], gateVersion, sourceDbHash, requiresIdempotencyKey }
- `ActionDefinition` — { actionId, phase, label, snapshotPhase?, requiredStatus? }
- `ActionDecision` — { enabled, reasonCode, reason, blockers[] }

#### `server/services/action-contract-service.ts`
**职责**：Action Contract 总入口——聚合各阶段 policy 计算每个 action 的可执行性。

**关键导出**：
- `getActions(changeId): PipelineActionContract[]` — 获取当前所有可执行 action 的契约
- `persistActionContract(changeId, action, computedAt?)` — 持久化 action 快照
- `actionRequiresIdempotencyKey(actionId): boolean` — 判断 action 是否需要幂等键

**设计思路**：遍历 `ACTION_DEFINITIONS` 注册表，对每个 action 调用对应的 policy 函数（build/review/qa/merge policy），聚合为 `PipelineActionContract[]`。集成 spec battle blockers、build base camp 检查、self-heal 逻辑。**驱动关系**：是 UI 按钮可用性和 API preflight 的唯一真相源。

#### `server/services/action-contract-registry-service.ts`
**职责**：Action 定义注册表。

**导出**：`ACTION_DEFINITIONS: ActionDefinition[]` — 所有阶段 action 的定义列表

#### `server/services/action-contract-build-policy.ts`
**导出**：`adoptBuildRunDecision`, `rejectBuildRunDecision`, `reviewBuildAdoptionDecision`

#### `server/services/action-contract-common-policy.ts`
**导出**：`gateDecision(phase, snapshot): ActionDecision` — 通用 gate 决策；`normalizeSeverity`, `normalizeBlockers`

#### `server/services/action-contract-merge-policy.ts`
**导出**：`mergeDecision`, `approveMergeDecision`

#### `server/services/action-contract-qa-policy.ts`
**导出**：`enterQaDecision`, `retryQaDecision`, `testPlanDecisionForQa`, `hasRunningQaCheck`

#### `server/services/action-contract-review-policy.ts`
**导出**：`reviewControlDecision`, `reviewFindingBlockers`, `latestReviewAttemptId`, `hasWaivableOpenReviewP1`

#### `server/services/action-contract-self-heal-service.ts`
**导出**：`selfHealLegacyTestPlanApprovalForBuild`, `selfHealStuckCheckingQa`

#### `server/services/action-contract-persistence-service.ts`
**导出**：`persistActionContractRow(db, changeId, action, computedAt)` — 写入 `stage_actions` 表

#### `server/services/preflight-service.ts`
**职责**：Action 执行前的 preflight 校验。

**关键导出**：
- `assertActionAllowed(input: AssertActionAllowedInput): PipelineActionContract` — 校验 action 可执行性（gate version + sourceDbHash 匹配）
- `actionNotAllowedEnvelope(changeId, actionId, override?): PreflightErrorEnvelope` — 生成不允许执行的信封
- `PreflightValidationError` / `PreflightBlockedError` — 错误类

**驱动关系**：所有 API route handler 在执行前必须调用此服务 → 读取 `action-contract-service` 的契约 → 比对 gaterVersion 和 sourceDbHash

### 4.3 Stage Authority 系统

#### `server/services/stage-authority-service.ts`
**职责**：通用阶段权威层——管理 `stage_runs`、`stage_reports`、`stage_gates`、`stage_states`。

**关键导出**：
- `getStageAuthority(changeId, phase: PipelinePhase): StageAuthoritySnapshot` — 获取阶段权威快照（state + latestAttempt + latestReport + latestValidReport + latestGate）
- `startStageRun(input): StageRunRecord` — 开始一次 stage run
- `completeStageRun(input): StageReportRecord` — 完成一次 stage run（写入 report）
- `recomputeStageGate(input): StageGateRecord` — 重新计算 stage gate
- `computeSourceDbHash(input): string` — 计算 source DB hash（决定 freshness）
- `StageAuthoritySnapshot` — { changeId, phase, state, latestAttempt, latestReport, latestValidReport, latestGate }

**设计思路**：所有阶段（PRD/Spec/Plan/Build/Review/QA/Merge）共享同一套 run/report/gate/state 管理算法。latest valid 选择算法：必须满足 `isFresh=true` + `reportDbHash` 存在 + status 为 passed/issues_found/passed_with_warnings。

#### `server/services/stage-guard-service.ts`
**职责**：阶段边界守卫——限制每个阶段 AI 能读写的文件范围。

**关键导出**：
- `captureWorkspaceSnapshot(repoPath): WorkspaceSnapshot` — 拍摄工作区快照（hash + size）
- `diffWorkspaceSnapshots(before, after, ignoredPatterns?): WorkspaceMutation[]` — 计算差异
- `validatePlannedChanges(mutations, scope): StageViolationResult` — 检查变更是否在 scope 内
- `validateReadOnlyStage(stage, mutations): StageViolationResult` — 只读阶段校验
- `validateImplementScope(mutations, plan, policy): StageViolationResult` — Build 阶段 scope 校验
- `validateFixScope(mutations, findings, plan, policy): StageViolationResult` — Fix 阶段 scope 校验
- `validateLocalCheckScope(changeId, mutations): StageViolationResult` — 本地检查 scope 校验
- `DEFAULT_STAGE_SCOPES` — 每个 RunPhase 的默认可读/可写文件模式

### 4.4 Gate 服务

#### `server/services/gate-service.ts`
**职责**：人工门禁（Intake/Spec/TechSpec/Merge Gate）的审批/拒绝/状态查询。

**关键导出**：
- `getGateStatus(changeId): GateStatus` — 获取当前门禁状态（含 stageAuthority, actions[], mergeChecks?, specBattle?）
- `approveGate(changeId, gate, preflight?): Promise<void>` — 批准通过门
- `rejectGate(changeId, gate, reason?): Promise<void>` — 拒绝回到前一步
- `canMerge(changeId): MergeChecks` — 检查是否可合并

### 4.5 Spec Battle 系统

#### `server/services/spec-battle-service.ts`
**职责**：Spec Battle 回合制对抗核心引擎。

**关键导出**：
- `startSpecBattleRound(changeId, params?): Promise<StartSpecBattleRoundResult>` — 开始新一轮
- `completeRedSpecRound({changeId, roundId, markdown}): Promise<void>` — 我方 SPEC_WRITER 完成出招
- `completeBlueCritique({changeId, roundId, blueJson}): Promise<void>` — 反方完成审查
- `failSpecBattleRound({changeId, roundId, reason}): void` — 标记本轮失败
- `applySpecBattleDecision(input): Promise<void>` — 人类裁决执行
- `getSpecBattleState(changeId): SpecBattleState` — 当前战斗状态
- `markSpecBattleReportsStale(changeId, reason): void` — 标记战报过期

#### `server/services/spec-battle-rules.ts`
**职责**：Spec Battle 规则引擎。

**导出**：`effectiveSeverity`, `isSpecBlockingGap`, `isMergeBlockingGap`, `isLegalDowngrade`, `computeGapCounts`, `getSpecActionAvailability`

#### `server/services/spec-battle-ledger.ts`
**职责**：Spec Battle 账本解析（Red output / Blue output 结构化解析）。

**导出**：`parseRedSpecOutput`, `parseBlueCritiqueOutput`, `computeRoundDelta`, `activeSpecBlocking`

#### `server/services/spec-battle-row-readers.ts`
**职责**：Spec Battle DB 行读取辅助函数。

**导出**：`latestRound`, `allRounds`, `getGaps`, `getDecisions`, `getRedFixClaims`, `getBlueGapReviews`, `currentBlockingGaps`

#### `server/services/spec-battle-report-service.ts`
**职责**：Spec Battle 战报生成。

**导出**：`generateSpecReport`, `generateWarReport`, `getSpecReportFreshness`, `getLatestSpecReportForDecision`

### 4.6 PRD Briefing 系统

#### `server/services/prd-briefing-service.ts`
**职责**：PRD Briefing Room 状态管理（作战意图 → 疑点卡 → 草案 → 最终质询 → 锁定）。

**关键导出**：
- `getPrdBriefingState(changeId): PrdBriefingState` — 获取当前 briefing 完整状态
- `savePrdIntent({changeId, rawText}): Promise<PrdBriefingState>` — 保存作战意图
- `completeQuestionGeneration({changeId, blueJson}): Promise<PrdBriefingState>` — 保存 AI 生成的疑点卡
- `applyBriefingQuestionAction({changeId, questionId, action, value}): Promise<PrdBriefingState>` — 处理疑点卡（回答/接受假设/暂缓）
- `completePrdDraft({changeId, markdown}): Promise<PrdBriefingState>` — 保存 PRD 草案
- `completeFinalReview({changeId, reviewJson}): Promise<PrdBriefingState>` — 保存最终质询结果
- `lockPrdBriefing({changeId}): Promise<PrdBriefingState>` — 锁定 PRD 基线 → INTAKE_READY

#### `server/services/prd-briefing-ledger.ts`
**职责**：PRD Briefing 的 AI 输出解析和 Gate 计算。

**导出**：`parseBriefingQuestionsOutput`, `parseFinalReviewOutput`, `applyQuestionAction`, `computePrdGate`

#### `server/services/prd-document-service.ts`
**职责**：PRD 文档的结构化读写和升级。

**导出**：`readStructuredPrd`, `readPrdMarkdown`, `savePrd`, `validatePrd`, `upgradeLegacyMarkdown`, `renderMarkdown`

#### `server/services/prd-service.ts`
**职责**：项目级 PRD 对话式生成服务。

**导出**：`startPrd`, `prdTurn`, `confirmPrd`, `startPrdRevision`, `confirmPrdRevision`, `getPrdStatus`, `upgradePrd`, `saveStructuredPrd`, `getPrdHistory`

### 4.7 Plan 沙盘系统

#### `server/services/plan-sandbox-service.ts`
**职责**：Plan 作战沙盘状态管理。

**导出**：`getPlanSandboxState`, `regeneratePlanReport`, `waivePlanRisk`

#### `server/services/plan-snapshot-service.ts`
**职责**：DB Plan snapshot 的持久化和渲染。

**导出**：`persistPlanSnapshot`, `latestPlanSnapshot`, `latestApprovedPlanSnapshot`, `renderPlanJsonMirror`, `renderPlanMarkdownMirror`, `planFromDbSnapshot`, `writePlanMirrorsFromDb`

#### `server/services/plan-approval-service.ts`
**职责**：Plan 审批逻辑。

**导出**：`assertPlanCanApprove`, `approvePlanSnapshot`

#### `server/services/plan-glob-policy-service.ts`
**职责**：Plan 文件 glob 匹配和重叠检测。

**导出**：`matchesPattern`, `matchesAnyPattern`, `patternsOverlap`, `isUnsafePlanPath`

#### `server/services/plan-safe-file-service.ts`
**职责**：Plan 相关文件的安全读写（防止路径穿越）。

**导出**：`planPath`, `planMarkdownPath`, `critiquePath`, `reportPath`, `readJson`, `readText`, `writeFileNoFollow`

#### `server/services/plan-report-service.ts`
**职责**：Plan Report 的 source hash 管理和格式化。

**导出**：`currentSourceHashes`, `readReportSourceHashes`, `sameHashes`, `formatReport`

### 4.8 Build Workspace 系统

#### `server/services/build-workspace-service.ts`
**职责**：Build 隔离 workspace/worktree 管理（核心安全边界）。

**关键导出**：
- `createBuildWorkspace(input): BuildRunFile` — 创建 Build workspace（Git worktree）
- `collectBuildResult(input): BuildRunFile` — 收集 Build 结果（diff/patch/hash）
- `approveBuildForAbsorb(input): BuildRunFile` — 审批 Build 补丁
- `absorbBuildPatch(input): BuildRunFile` — 收编 Build 补丁到主仓
- `adoptFixPatch(input): BuildRunFile` — 收编 Fix 补丁
- `rejectLatestBuildRun(input): BuildRunFile` — 拒绝 Build run
- `checkGitBaseCamp(repoPath, options?): GitBaseCampStatus` — Git 前置条件检查
- `assertAdoptedBuildRunMatchesWorkspace(input): BuildRunFile` — 校验 adopted BuildRun 与 workspace 一致

#### `server/services/build-workspace-paths.ts`
**职责**：Build workspace 路径管理和安全检查。

**导出**：`workspacePathFor`, `buildBranchName`, `buildRunPath`, `assertSafeChangeId`, `assertControlledWorkspacePath`, `assertSafeArtifactPath`, `assertBuildArtifactPath`, `assertChangeArtifactPath`, `writeBuildArtifact`, `buildResultArtifactPathsForRun`

#### `server/services/build-workspace-run-store.ts`
**职责**：Build run 文件系统的读写。

**导出**：`readLatestBuildRun`, `readBuildRunByNumber`, `readPreviousAdoptedBuildRun`, `writeBuildRun`, `markBuildRunRunning`, `markBuildRunFailed`

#### `server/services/build-workspace-ignored-prefixes.ts`
**职责**：Build/Fix/Change 阶段应被忽略的文件前缀（防止 AI 误改系统文件）。

#### `server/services/build-run-record-service.ts`
**职责**：Build run 的 DB 记录管理。

**导出**：`recordBuildRunRecord`, `recordBuildRunFromWorkspaceFile`, `getBuildRunRecord`, `getLatestAdoptedBuildRecord`, `assertBuildRecordFresh`, `hashBuildChangedFiles`

#### `server/services/build-gate-service.ts`
**职责**：Build 阶段的确定性 Gate。

**导出**：`isShipArtifact`, `evaluateBuildGate(input): BuildGateResult`

### 4.9 Review 系统

#### `server/services/review-run-service.ts`
**职责**：Review run/attempt 的 DB 生命周期管理。

**导出**：`startReviewRun`, `completeReviewAttempt`, `completeReviewAttemptFromStructuredOutput`, `failReviewAttempt`, `recordInvalidReviewOutput`

#### `server/services/review-report-service.ts`
**职责**：Review Report 的确定性结算。

**导出**：`recomputeReviewReport(changeId, attemptId): RecomputeReviewReportResult`, `settlementFindingsForReviewAttempt`

#### `server/services/review-qa-gate-service.ts`
**职责**：Review QA Gate——进入 QA 的前置条件检查。

**导出**：`assertCanEnterQa(input): ReviewQaGateResult`

#### `server/services/review-structured-output-parser.ts`
**职责**：AI Review 结构化输出的严格解析器。

**导出**：`parseReviewStructuredOutput`, `parseReviewSeverity`, `parseReviewFinding`, `parsePriorFindingReview`, `completePriorFindingCoverage`, `InvalidReviewOutputError`

#### `server/services/review-center-service.ts`
**职责**：Review 战报中心——聚合 Review attempts/reports/findings/waivers。

**导出**：`getReviewCenterState(changeId): ReviewCenterState` — 返回完整的 Review 战报中心状态

#### `server/services/review-artifact-mirror-service.ts`
**职责**：Review 镜像的检测和重建。

**导出**：`inspectReviewMirrors`, `rebuildReviewMirrors`, `recordReviewMirrorFailure`

#### `server/services/review-waiver-service.ts`
**职责**：Review P1 finding 的豁免管理。

**导出**：`waiveReviewFinding(input): WaiveReviewFindingResult`

### 4.10 QA 与 Merge 系统

#### `server/services/qa-run-service.ts`
**职责**：QA run 的 DB 生命周期管理。

**导出**：`startQaRun`, `recordQaCommandResult`, `failQaRun`, `recordQaDeliveryHead`, `recomputeQaGate`

#### `server/services/merge-readiness-service.ts`
**职责**：Merge readiness 的确定性计算（全阶段 gate 汇总）。

**导出**：`computeMergeReadiness(input): MergeReadiness`, `assertCanMerge(input): MergeReadiness`

### 4.11 项目与变更管理

#### `server/services/project-service.ts`
**职责**：项目 CRUD + 上下文初始化。

**导出**：`createProject`, `getProject`, `listProjects`, `deleteProject`, `updateProjectProviders`, `regenerateProjectContext`

**调用链**：→ `template-service` (scaffold `.ship/`) → `context-init-service` → `git-service` → `change-service`

#### `server/services/change-service.ts`
**职责**：变更 CRUD + 级联删除。

**导出**：`createChange`, `getChange`, `getChangeForProject`, `listChangesByProject`, `updateChangeStatus`, `deleteChange`, `deleteChangeRecords`

`deleteChangeRecords` 级联删除 30+ 张关联表的数据。

#### `server/services/change-phase-service.ts`
**职责**：按 Phase 聚合变更的审查信息。

**导出**：`getChangePhaseReview(projectId, changeId, phase, runId?): Promise<PhaseReviewResponse>`

#### `server/services/change-rework-service.ts`
**职责**：变更重做（从指定 Phase 重新开始）。

**导出**：`reworkChange(projectId, changeId, phase): Promise<Change>`

### 4.12 AI 引擎适配

#### `server/services/ai-engine-types.ts`
**职责**：AI 引擎抽象接口定义。

**导出**：
- `AiEngineAdapter` — { `run(input): Promise<AiRunResult>`, `runStreamed(input): AsyncGenerator<ThreadEvent>` }
- `AiRunInput` — { changeId, repoPath, phase, threadId?, prompt, outputSchema?, sandboxMode?, timeoutMs? }
- `AiRunResult` — { threadId, runId, summary, success, changedFiles, structuredOutput?, items[] }

#### `server/services/ai-engine-adapter.ts`
**职责**：AI 引擎工厂——按 provider 加载对应引擎。

**导出**：`getAiEngine(provider): AiEngineAdapter`, `setAiEngineLoaderForTest(provider, loader)`

#### `server/services/claude-engine.ts`
**职责**：Claude Code 引擎（通过 CLI spawn 调用）。

**导出**：`getClaudeEngine(): AiEngineAdapter`（返回 `ClaudeSdkEngine` 实例，实现 `run()` 和 `runStreamed()`）

**重要**：claude-engine 必须用 stdin 传 prompt，放 argv 会被错解析成 `--allowedTools`。

#### `server/services/codex-cli-engine.ts`
**职责**：Codex CLI 引擎（直接 spawn `codex exec --json` 二进制，替代已删除的 `@openai/codex-sdk`）。

**导出**：`getCodexCliEngine(): AiEngineAdapter`（返回 `CodexCliEngine` 实例）

#### `server/services/ai-provider-service.ts`
**职责**：AI Provider 的解析和持久化策略。

**导出**：`resolveProvider(explicitProvider?, defaultProvider?): AiProvider`, `shouldPersistProvider(explicitProvider, saveAsDefault?): boolean`

### 4.13 上下文初始化

#### `server/services/context-init-service.ts`
**职责**：项目上下文初始化——分析代码库生成 baseline 文档。

**导出**：`initializeProjectContext(projectId, provider?): Promise<void>`

**调用链**：→ `static-analyzer` (分析代码库) → `context-parsers` (解析 AI 输出) → `ai-engine-adapter` (调用 AI 生成文档)

#### `server/services/static-analyzer.ts`
**职责**：代码库静态分析器。

**导出**：`runStaticAnalysis(rootPath, onProgress?): Promise<AnalysisResult>`, `formatAnalysisForPrompt(result): string`

#### `server/services/context-parsers.ts`
**职责**：AI 输出的解析器。

**导出**：`parseDocBlock(output, tag): string | null`, `parseFileSelectionJson(output): string[]`

### 4.14 模板与基线

#### `server/services/template-service.ts`
**职责**：项目初始化——scaffold `.ship/` 目录。

**导出**：`scaffoldShipDir(repoPath): void`

#### `server/services/baseline-service.ts`
**职责**：Baseline 文档管理（10 份稳定基线文档）。

**导出**：`scaffoldBaseline`, `listBaselineDocs`, `readBaselineDoc`, `updateChangelog`, `recordDecision`

#### `server/services/prompt-service.ts`
**职责**：Prompt 模板拼装。

**导出**：`assemblePrompt(phase: PromptPhase, vars: PromptVariables, scope?: StageScope): string`

### 4.15 Git 服务

#### `server/services/git-service.ts`
**职责**：封装所有 Git CLI 操作。

**导出**（30+ 函数）：`isGitRepo`, `initRepo`, `createBranch`, `checkoutBranch`, `commitAll`, `getHeadSha`, `createGitWorktree`, `removeGitWorktree`, `applyPatch`, `gitApplyExcludeArgs`, `getBinaryDiff`, `getNameStatusDiff`, `isWorkingTreeClean`, `getWorkingTreeStatus`, 等

#### `server/services/commit-message-service.ts`
**职责**：AI 生成 commit message。

**导出**：`suggestCommitMessage(repoPath, context?): Promise<string>`

### 4.16 其他工具服务

#### `server/services/graph-runner.ts`
**职责**：旧版状态机编排器（`GraphRunner` 单例）。

**导出**：`GraphRunner` 类：`generatePlan`, `approvePlan`, `implement`, `runLocalCheck`, `review`, `fixFindings`, `stopCurrentRun`, `blockChange`, `markLocalReady`

#### `server/services/event-service.ts`
**职责**：事件发射。

**导出**：`emitEvent(input: EmitEventInput): Promise<string>`

#### `server/services/artifact-mirror-service.ts`
**职责**：DB → `.ship/` 镜像渲染。

**导出**：`renderMirrorsFromDb`, `inspectArtifactMirrors`, `rebuildArtifactMirror`

#### `server/services/phase-artifact-service.ts`
**职责**：阶段产物定义和路径管理。

**导出**：`PHASE_ARTIFACT_DEFINITIONS`, `getDefinitionForFileName`, `isEditablePhaseArtifactFileName`, `resolveEditablePhaseArtifactPath`, `savePhaseArtifactContent`

#### `server/services/local-check-service.ts`
**职责**：本地质量检查（lint/typecheck/test/semgrep）。

**导出**：`runLocalChecks(repoPath, changeId, outputDir?, options?): LocalCheckResult`

#### `server/services/scope-check-service.ts`
**职责**：Scope 边界检查。

**导出**：`runScopeCheck(repoPath, changeId, outputDir?): ScopeCheckResult`

#### `server/services/refine-service.ts`
**职责**：需求澄清对话（旧版 Refine 阶段）。

**导出**：`refineTurn`, `confirmRequirements`

#### `server/services/retro-service.ts`
**职责**：复盘债务提取和 backlog 追加。

**导出**：`extractRetroDebtItems`, `appendRetroDebtsToBacklog`

#### `server/services/techspec-api-snapshot-service.ts`
**职责**：TechSpec 和 API Spec 的 DB 快照管理。

**导出**：`createTechSpecSnapshot`, `createApiSnapshot`, `createTechSpecAndApiSnapshots`, `getLatestTechSpecSnapshot`, `getLatestApiSnapshot`, `getBuildDesignInputs`, `getReviewDesignInputs`

#### `server/services/testplan-snapshot-service.ts`
**职责**：TestPlan 的 DB 快照管理。

**导出**：`createTestPlanSnapshot`, `approveTestPlan`, `getRequiredValidationCommands`

---

## 五、前端层

### 5.1 页面

| 文件 | 组件 | 路由 |
|---|---|---|
| `app/page.tsx` | 首页 | `/` |
| `app/projects/page.tsx` | `ProjectsPage` | `/projects` |
| `app/projects/[id]/page.tsx` | `ProjectDetailPage` | `/projects/:id` |
| `app/projects/[id]/changes/[changeId]/page.tsx` | `ChangeDetailPage` | `/projects/:id/changes/:changeId` |
| `app/layout.tsx` | 根布局 | — |
| `app/global-error.tsx` | 全局错误边界 | — |

### 5.2 组件

| 目录 | 文件 | 职责 |
|---|---|---|
| `app/projects/[id]/` | `create-change-dialog.tsx` | 创建变更弹窗 |
| | `git-setup-panel.tsx` | Git 设置面板 |
| | `git-workspace-panel.tsx` | Git 工作区面板 |
| | `prd-editor.tsx` | PRD 编辑器 |
| `app/projects/` | `create-project-dialog.tsx` | 创建项目弹窗 |
| `components/ui/` | `button.tsx` | 按钮（CVA variants） |
| | `card.tsx` | 卡片容器 |
| | `dialog.tsx` | 弹窗对话框（Radix-based） |
| | `input.tsx` | 输入框 |
| | `label.tsx` | 标签 |
| | `alert-dialog.tsx` | 警告弹窗 |
| `lib/` | `utils.ts` | `cn()` 类名合并函数（clsx + tailwind-merge） |

---

## 六、服务间核心调用关系图

```
API Route
  ├─→ PreflightService.assertActionAllowed()
  │     └─→ ActionContractService.getActions(changeId)
  │           ├─→ StageAuthorityService.getStageAuthority(changeId, phase)
  │           ├─→ BuildPolicy / ReviewPolicy / QAPolicy / MergePolicy
  │           ├─→ SpecBattleService (spec blockers)
  │           └─→ BuildWorkspaceService (base camp check)
  │
  ├─→ PipelineService.runXxx(changeId)
  │     └─→ PipelineDocumentStageRunner.runDocumentStage()
  │           ├─→ PromptService.assemblePrompt()
  │           ├─→ StageGuardService (snapshot → diff → validate)
  │           ├─→ PipelineEngineService.getPipelineEngine(provider)
  │           │     └─→ AiEngineAdapter.run(input)
  │           │           ├─→ CodexCliEngine (codex CLI, bare-spawn)
  │           │           └─→ ClaudeSdkEngine (claude-code CLI)
  │           ├─→ PipelineRunLedgerService (createRun, writeArtifact, setStatus)
  │           └─→ ArtifactMirrorService.renderMirrorsFromDb()
  │
  └─→ GateService.approveGate(changeId, gate)
        ├─→ StageAuthorityService (gate blocking reason)
        ├─→ SpecBattleService (applyDecision for spec gate)
        └─→ MergeReadinessService (for merge gate)
```

## server/services/review-center-summary-parser.ts

**Exports (from static analysis):**
- `REVIEW_SUMMARY_STATUSES`
- `VALID_REVIEW_STATUSES`
- `runSequence(runId: string): number`
- `compareRunsDesc(left: { id: string; startedAt: string | null; endedAt: string | null }, right: { id: string; startedAt: string | null; endedAt: string | null }): number`
- `stringOrNull(value: unknown): string | null`
- `parseReviewSummary(summary: string | null): ParsedReviewSummary`
- `emptyParsedSummary(valid: boolean): ParsedReviewSummary`