# 实现锚点附录（Implementation Anchors）

| 项 | 值 |
|---|---|
| 文档状态 | Draft（施工蓝图，供 Codex 接管） |
| 版本 | v2.0 |
| 关联 | [docs/tech-spec.md](./tech-spec.md)、[docs/task-breakdown.md](./task-breakdown.md) |

> 本文档把设计下沉到代码层：函数签名、要改的精确文件、加新状态后**会编译报错的映射表清单**。Codex 照此施工可避开「漏改某个 Record 映射表导致编译崩」的反复踩坑。

---

## 〇、加新 ChangeStatus 后必须同步的映射表（最易漏，全列）

每新增一个 `ChangeStatus`，以下 `Record<ChangeStatus, ...>` 或以 status 为键的表**全部要补**，漏一个 TS 编译报错或运行时 undefined：

| 文件 | 标识符 | 行 | 类型 | 必须补 |
|---|---|---|---|---|
| `server/types/enums.ts` | `ChangeStatus` z.enum | 6 | 枚举定义 | ✅ 加值 |
| `server/services/change-phase-service.ts` | `STATUS_TO_REVIEW_PHASE` | 117 | `Record<string,...>` | ⚠️ string 键不报错但需补 |

每新增一个 `RunPhase`，以下要补：

| 文件 | 标识符 | 行 | 类型 |
|---|---|---|---|
| `server/types/enums.ts` | `RunPhase` z.enum | 24 | 枚举 |
| `server/services/change-rework-service.ts` | `ROOT_FILES_BY_PHASE` | 40 | `Record<RunPhase,string[]>` ✅ 严格 |
| `server/services/change-rework-service.ts` | `PHASE_ORDER` | 31 | `RunPhase[]` |
| `server/services/change-phase-service.ts` | `RUN_PHASE_TO_REVIEW_PHASE` | 98 | `Record<string,...>` |
| `server/services/prompt-service.ts` | `PromptPhase` | 7 | union 类型（加阶段需加 case）|

每新增一个展示 `Phase`：

| 文件 | 标识符 | 类型 |
|---|---|---|
| `server/types/enums.ts` | `Phase` z.enum (97) | 枚举 |
| `server/services/change-phase-service.ts` | `CONTENT_PHASES` | 数组 |
| 前端阶段栏组件 | NAV/阶段定义 | 展示 |

> **施工自检**：改完跑 `pnpm build`，TS 会精确指出哪个 `Record<ChangeStatus/RunPhase/Phase>` 没覆盖全。严格 Record（非 string 键）是免费的编译期保险，优先依赖它。

## 一、新 stage 函数签名（pipeline-service.ts）

参照现有 `generatePlan`/`runImplement`/`runReview` 的统一范式：

```ts
// 统一范式（每个 stage 都遵循）：
// 1. getChange + assertStatus(前置态)
// 2. getProject
// 3. setStatus(RUNNING态) + createRun(phase)
// 4. try: assemblePrompt → engine.run → snapshot diff → stage-guard 校验
//         → writeRunArtifact → endRun(true) → setStatus(下一态/门态)
//    catch: endRun(false) → setStatus(回退态)

export async function runIntake(changeId: string): Promise<CodexRunResult>;
// 前置: (创建) → INTAKE_PENDING → INTAKE_READY(门)
// 产物: change-request.md  | sandboxMode: read-only

export async function runSpec(changeId: string): Promise<CodexRunResult>;
// 前置: INTAKE_READY(approved) → SPECCING → SPEC_READY(门)
// 产物: prd-delta.md  | 可反复调用迭代 | read-only

export async function runTechSpec(changeId: string): Promise<CodexRunResult>;
// 前置: SPEC_READY(approved) → TECHSPECCING → TECHSPEC_READY(门)
// 产物: tech-spec-delta.md (+ api-spec-delta.md 接口变更时) | read-only

export async function runTestPlan(changeId: string): Promise<CodexRunResult>;
// 前置: TECHSPEC_READY(approved) → TESTPLANNING → TESTPLAN_DONE
// 产物: test-plan-delta.md | read-only | 完成后自动前进 IMPLEMENTING

export async function runRelease(changeId: string): Promise<void>;
// 前置: MERGE_READY(approved, canMerge) → MERGING → RETRO_PENDING
// 行为: commit + 更新 .ship/baseline/changelog.md + 写 release-note.md

export async function runRetro(changeId: string): Promise<CodexRunResult>;
// 前置: RETRO_PENDING → DONE
// 产物: retro.md + 追加 .ship/baseline/backlog.md
```

复用的现有工具函数（同文件内，直接调）：`getChange`、`getProject`、`assertStatus`、`setStatus`、`createRun`、`endRun`、`writeRunArtifact`、`assemblePrompt`、`getEngine`、`captureWorkspaceSnapshot`、`diffWorkspaceSnapshots`。

## 二、人工门 service（新建 gate-service.ts）

```ts
export type GateName = "intake" | "spec" | "tech_spec" | "merge";

const GATE_STATES: Record<GateName, ChangeStatus> = {
  intake: "INTAKE_READY",
  spec: "SPEC_READY",
  tech_spec: "TECHSPEC_READY",
  merge: "MERGE_READY",
};

export function getGateStatus(changeId: string): GateStatus;
export async function approveGate(changeId: string, gate: GateName): Promise<void>;
// 以 T2.7 stage 函数入口态为准：approve 只校验/记录门已批准，不抢先改成 RUNNING 态
// 校验 change.status === GATE_STATES[gate]，否则抛 "Not at gate"
// merge 门额外校验 canMerge()
export async function rejectGate(changeId: string, gate: GateName, reason?: string): Promise<void>;
// reject 回到对应 stage 函数可重跑的入口态：spec -> INTAKE_READY，tech_spec -> SPEC_READY，merge -> LOCAL_READY

export function canMerge(changeId: string): {
  qaPassed: boolean; reviewPassed: boolean; docsComplete: boolean;
  canMerge: boolean; missing: string[];
};
// qaPassed = status===MERGE_READY（与 merge 门状态字段统一）
// reviewPassed = 无 source==='review' && severity==='P0' && status==='open' 的 finding
// docsComplete = prd-delta/tech-spec-delta/test-plan-delta 三文件均存在
```

## 三、stage-guard 读写边界扩展（stage-guard-service.ts）

现有写边界函数（行号见源）：`validateReadOnlyStage`(254)、`validateImplementScope`(267)、`validateFixScope`(290)、`validateLocalCheckScope`(328)。

新增（向后兼容，不改现有签名，新增重载/新函数）：

```ts
export interface StageScope {
  phase: RunPhase;
  readableFiles: string[];
  writableFiles: string[];
  plannedChanges?: string[];
}

// 默认契约表（集中定义，change 只能收窄）
export const DEFAULT_STAGE_SCOPES: Record<RunPhase, Omit<StageScope,"phase">>;

// 读边界：进场时 prompt-service 调用，过滤可注入上下文的文件
export function resolveReadableFiles(repoPath: string, scope: StageScope): string[];

// 本轮预声明校验：实际 diff 必须 ⊆ plannedChanges ∪ writableFiles
export function validatePlannedChanges(
  mutations: WorkspaceMutation[],
  scope: StageScope
): StageViolationResult;
```

> `.ship/` 豁免：所有 scope 校验对 `.ship/**` 路径返回不阻断（现有 `localCheckAllowedPatterns` 已是此模式，复用 `filterIgnoredMutations`）。

## 四、prompt-service 扩展（prompt-service.ts）

```ts
// PromptPhase union 加: "intake" | "spec" | "tech_spec" | "test_plan" | "release" | "retro"
// assemblePrompt 内按 phase 读对应模板 + 按 StageScope.readableFiles 注入上下文
```

模板新增（`server/templates/prompts/`）：`intake.md`、`spec.md`、`tech-spec.md`、`test-plan.md`、`release.md`、`retro.md`。

## 五、DB schema + 迁移

```ts
// server/db/schema.ts changes 表加：
gateState: text("gate_state"),                       // nullable
docsComplete: integer("docs_complete").notNull().default(0),
retroDone: integer("retro_done").notNull().default(0),
```

```sql
-- server/db/migrations/0008_add_gate_fields.sql
ALTER TABLE changes ADD COLUMN gate_state TEXT;
ALTER TABLE changes ADD COLUMN docs_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE changes ADD COLUMN retro_done INTEGER NOT NULL DEFAULT 0;
```
同步更新 `server/db/migrations/meta/_journal.json`（加 0008 条目，idx=8）。

> ⚠️ 依赖迁移 runner（Phase 0）。Phase 0 未做时，新列需手动 ALTER 或先建 runner。

## 六、API 路由文件（新建）

```
app/api/projects/[id]/changes/[changeId]/
  intake/route.ts       POST → runIntake
  spec/route.ts         POST → runSpec
  tech-spec/route.ts    POST → runTechSpec
  test-plan/route.ts    POST → runTestPlan
  release/route.ts      POST → runRelease
  retro/route.ts        POST → runRetro
  review/route.ts       POST → runReview（补路由，函数已存在）
  gate/route.ts         GET → getGateStatus
  gate/approve/route.ts POST → approveGate
  gate/reject/route.ts  POST → rejectGate
  scope/[phase]/route.ts GET → 返回 StageScope
app/api/projects/[id]/
  baseline/route.ts             GET → baseline 文档列表
  baseline/[docName]/route.ts   GET → 单文档内容
```

参照现有 `implement/route.ts` 的 handler 范式（解析 params → 调 service → try/catch 返回 JSON）。

---

*供 Codex 施工，逐节对应 task-breakdown.md 的任务。*
