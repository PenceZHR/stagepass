# Spec：Spec Battle MVP

| 项 | 值 |
|---|---|
| 文档状态 | 最终草案 |
| 日期 | 2026-06-25 |
| 来源 PRD | `docs/prd.md` v3.3 |
| MVP 范围 | Spec Battle + Requirement Gap + Spec Gate + War Report |
| 生成方式 | 我方 Spec Agent 起草；反方 Requirement Critic 提出 Request Changes；我方代理修订后定稿；v3.2 根据用户批准收敛为 SLG 回合战斗界面；v3.3 根据 PRD 审批加入 Requirement Gap 逐项消账协议 |

---

## 当前实现状态（2026-06-25）

本 MVP 已落地为现有 pipeline 的有限扩展，而不是独立重写：

- Spec 阶段会创建 `SPEC_BATTLE_MVP` round，并产出 `rounds/spec-round-XX-red.md` 与 `rounds/spec-round-XX-blue.json`。
- 反方 `REQUIREMENT_CRITIC` 必须输出结构化 JSON；非 JSON 输出会让 round 标记为 `failed`，不会被当成“无缺口”。
- 我方执行代理 `SPEC_WRITER` 必须读取当前 open P0/P1 Requirement Gap，并逐项输出修复声明；反方必须先复核旧 gap，再新增 gap。
- `requirement_gaps`、`battle_rounds`、`human_decisions`、`war_reports` 已进入数据库迁移与 Drizzle schema。
- `spec-report.md` 与 `war-report.md` 位于 `reports/` 目录，报告 verdict/counts 由确定性规则生成。
- Spec Gate approve 会校验 fresh report、P0/P1 blocker、最终轮规则，并记录被审批的 `reportHash`。
- Merge Gate 会再次检查 merge-blocking Requirement Gap；MVP 不产生 P0 override，也不得依赖 P0 override 放过 Spec。
- 前端下一版必须将 Spec Battle 从复杂审批面板收敛为 SLG 回合战场：默认只展示“战场”和“本轮战报”，后台状态和原始 Gap 进入高级详情。

后续“战棋 / RTS 地图式编排”可以在这些固定单位和状态表上继续包装：单位模板固定，用户负责摆放和调整交互关系，脚本负责执行与裁决。

---

## 对抗生成记录

| Agent | 角色 | 结果 |
|---|---|---|
| 我方 Spec Agent | `SPEC_WRITER` | 起草第一版可执行 Spec。 |
| 反方 Requirement Critic | `REQUIREMENT_CRITIC` | 以 Request Changes 结论指出状态转移、DB 权威、Gap 生命周期、Merge Gate、stale report、非法动作、report counts 等问题。 |
| 我方 Spec Agent | `SPEC_WRITER` | 根据反方 P0/P1/P2 修订，补齐状态矩阵、DB source of truth、Gap 关闭/降级、`canMerge` 集成、stale 顺序和 API 非法动作语义。 |
| 我方 Spec Agent | `SPEC_WRITER` | 根据用户批准的 PRD v3.3 增补逐项消账协议，明确 RedFixClaim / BlueGapReview 与 gap 关闭条件。 |

反方验收门槛：

> 一个 P0/P1 需求漏洞必须能被反方发现、结构化记录、阻断 Spec Gate，通过合法人工裁决回流 Spec，在下一轮被复核，并且在 Merge 前再次被机器检查。

## 目标

在现有 stagepass pipeline 上实现最小对抗式研发闭环：固定模板的 Spec Battle 在 TechSpec / Build 之前运行，用反方审查发现需求层漏洞，并让人工审批依赖结构化状态，而不是依赖 AI 自然语言总结。

成功状态：

- `SPEC_WRITER` 能生成或修订 `.ship/changes/<changeId>/prd-delta.md`。
- `SPEC_WRITER` 能读取当前 open P0/P1 Requirement Gap，并为每个阻断 gap 输出结构化 `RedFixClaim`。
- `REQUIREMENT_CRITIC` 能先复核旧 gap 的 `RedFixClaim`，再生成新增结构化 Requirement Gap。
- P0/P1 Requirement Gap 默认阻断 Spec Gate，除非被解决或合法 waiver。
- P2 Requirement Gap 展示但不阻断。
- 人类主界面只允许“继续对抗一轮 / 刷新战报 / 接受风险并通过 / 终止 Battle”，后台 API 保留 `approve`、`request_changes`、`return_to_spec`、`waive_p1` 等审计动作。
- `BATTLE_REPORTER` 用确定性规则生成 counts、action availability 和报告。
- Spec Gate 通过后回到现有 pipeline。
- Merge Gate 在合并前再次检查 Requirement Gap。
- 用户可以配置最大交手轮数，默认 3 轮，MVP 上限 5 轮。
- 主界面操作使用产品语言：`继续对抗一轮`、`刷新战报`、`接受风险并通过`、`终止 Battle`。
- 连续对抗时，旧 P0/P1 不能只增不减；每轮必须展示已解决、仍阻断、新发现和未复核的 gap 消账结果。

## 技术栈

- Next.js App Router：API routes 与 change 详情页。
- TypeScript：domain service、schema、UI contract。
- Drizzle ORM + SQLite + `better-sqlite3`。
- 复用现有 `.ship/changes/<changeId>/` 产物布局。
- 复用 `gate-service.ts`、`pipeline-service.ts`、`phase-artifact-service.ts`、`stage-guard-service.ts`、`findings` 表等现有基础。
- 测试沿用仓库当前 `pnpm test`，也就是 Node 内置 test runner + `tsx`。

## 命令

现有项目命令：

```bash
pnpm dev
pnpm test
pnpm build
```

实现阶段的重点验证命令：

```bash
pnpm exec tsx --test server/services/gate-service.test.ts
pnpm exec tsx --test server/db/migrate.test.ts
pnpm exec tsx --test server/services/spec-battle-service.test.ts
pnpm test
pnpm build
```

## 项目结构

需要扩展的现有文件：

```text
server/types/enums.ts
server/types/models.ts
server/db/schema.ts
server/db/migrate.ts
server/services/gate-service.ts
server/services/pipeline-service.ts
server/services/phase-artifact-service.ts
server/services/prompt-service.ts
app/projects/[id]/changes/[changeId]/page.tsx
app/api/projects/[id]/changes/[changeId]/gate/*
```

计划新增文件：

```text
server/services/spec-battle-rules.ts
server/services/spec-battle-service.ts
server/services/spec-battle-report-service.ts
server/templates/prompts/spec-critic.md
app/api/projects/[id]/changes/[changeId]/spec-battle/route.ts
app/api/projects/[id]/changes/[changeId]/spec-battle/report/route.ts
app/api/projects/[id]/changes/[changeId]/spec-battle/decision/route.ts
app/projects/[id]/changes/[changeId]/spec-battle-panel.tsx
docs/archive/superpowers-plans/2026-06-25-spec-battle-mvp.md
```

产物布局：

```text
.ship/changes/<changeId>/prd-delta.md
.ship/changes/<changeId>/requirement-gaps.json
.ship/changes/<changeId>/human-decisions.json
.ship/changes/<changeId>/rounds/spec-round-01.json
.ship/changes/<changeId>/rounds/spec-round-01-red.md
.ship/changes/<changeId>/rounds/spec-round-01-blue.json
.ship/changes/<changeId>/reports/spec-report.md
.ship/changes/<changeId>/reports/war-report.md
```

## 代码风格

领域规则优先写成纯函数，再由 service 调用：

```ts
type Severity = "P0" | "P1" | "P2";
type GapStatus = "open" | "resolved" | "waived" | "downgraded" | "overridden";

export function effectiveSeverity(gap: {
  severity: Severity;
  downgradedTo: "P1" | "P2" | null;
}): Severity {
  return gap.downgradedTo ?? gap.severity;
}

export function isSpecBlockingGap(gap: {
  severity: Severity;
  originalSeverity: Severity;
  downgradedTo: "P1" | "P2" | null;
  status: GapStatus;
}): boolean {
  const severity = effectiveSeverity(gap);
  if (gap.status === "resolved") return false;
  if (gap.status === "waived" && severity === "P1") return false;
  if (gap.status === "overridden") return severity !== "P2";
  if (severity === "P2") return false;
  return severity === "P0" || severity === "P1";
}
```

约定：

- DB 是权威源；JSON / Markdown 是展示和审计镜像。
- Gate 判断读取结构化 DB 状态，不读取 Markdown 文案。
- 报告可以有 AI 润色摘要，但 verdict、counts、legal actions 必须由确定性代码计算。
- 新 service 遵循现有 `server/services/*-service.ts` 风格。

## 边界

- Always：先写 DB，再刷新 mirror 文件。
- Always：即使 UI 隐藏按钮，API 也必须拒绝非法动作。
- Always：任何改变 gate counts 的决策都要让 report stale 或立即刷新 report。
- Always：保留现有 pipeline 主状态，Spec Battle 细状态放在新表里。
- Ask first：用户可编辑 prompt、unit、edge、阶段或模板。
- Ask first：引入新的 workflow engine 或替换现有 pipeline。
- Never：让 AI 自然语言决定 gate 结果。
- Never：MVP 中允许 P0 waiver。
- Never：把 P2 当阻断项。
- Never：修改 closed round。
- Never：已有 running round 时启动新 round。

## 固定单位与模板

MVP 只有一个模板：

```ts
type BattleTemplate = "SPEC_BATTLE_MVP";
```

固定单位：

| Unit | 类型 | 职责 |
|---|---|---|
| `SPEC_WRITER` | 我方执行代理 | 创建或修订 `prd-delta.md`；读取当前 open P0/P1 Requirement Gap，并逐项输出 `RedFixClaim`。 |
| `REQUIREMENT_CRITIC` | 反方 AI | 先复核旧 gap 的 `RedFixClaim`，输出 `BlueGapReview`，再发现新增需求层 gap 和普通 Spec finding。 |
| `BATTLE_REPORTER` | 确定性服务 | 计算 counts、action availability、stale 状态和报告。 |
| `HUMAN_COMMANDER` | 人类 | 审批、要求修改、退回 Spec、waive P1。 |

允许参数：

```ts
interface BattleParams {
  maxSpecRounds: 1 | 2 | 3 | 4 | 5;
  allowP1Waiver: boolean;
}
```

默认值：

```json
{
  "maxSpecRounds": 3,
  "allowP1Waiver": true
}
```

## SLG 回合战斗界面

Spec 阶段的主界面不是审批后台，而是一场有限回合 SLG 对战。用户第一眼只能看到两个核心区域。

### 开战前战场

当 change 进入 Spec Battle 且尚未创建 round 时，主界面显示“开战前战场”。

开战前只允许用户设置 `maxSpecRounds`，默认 3，范围 1-5。用户确认后系统创建 `roundNo = 1` 的 Spec Battle round，并进入我方代理出招状态。

开战前不得展示审批表、Requirement Gap 原始 JSON、artifact 绝对路径或后台 gate 枚举。

### 战场

战场区域展示：

- 当前轮次：`Round N / maxSpecRounds`。
- 我方代理 `SPEC_WRITER` 状态：未出招 / 出招中 / 已出招 / 失败。
- 反方 `REQUIREMENT_CRITIC` 状态：未反击 / 反击中 / 已反击 / 失败。
- 战报官 `BATTLE_REPORTER` 状态：待结算 / 已生成 / 已过期。
- 当前局势：可继续对抗 / 可接受风险 / 可通过 / P0 阻断。

战场区域不得展示 DB id、artifact 绝对路径、原始 JSON、完整 event stream。

### 本轮战报

本轮战报区域展示：

```text
第 N 轮战报

我方本轮改进：
- ...

反方本轮攻击：
- ...

本轮结论：
- P0: x
- P1: y
- P2: z
- 本轮已解决: a
- 仍在阻断: b
- 新发现: c
- 未复核: d

建议：
- 继续对抗一轮 / 接受风险并通过 / 终止 Battle
```

本轮战报必须优先展示相对上一轮的变化，而不是只展示累计 counts：

- 我方本轮新增或修改的 Spec 要点。
- 我方本轮对旧 open P0/P1 的修复声明。
- 反方本轮对旧 gap 的复核结果。
- 反方本轮新增 gap。
- 上一轮遗留 gap 的状态变化，包括 resolved / still_open / downgraded / not_rechecked。
- 本轮仍阻断的 P0/P1 数量。
- 本轮非阻断 P2 数量。
- 系统建议的唯一主动作或优先动作。

完整 `spec-report.md`、`war-report.md`、Requirement Gap 表、human decisions、round JSON 只能放在折叠的“高级详情”中。

### 主按钮

主界面只允许四个主按钮：

| 主按钮 | 后台动作 | 说明 |
|---|---|---|
| 继续对抗一轮 / 继续追加一轮 | `request_changes` 或 `return_to_spec` | 基于本轮战报创建下一轮我方代理和反方交手；达到 `maxSpecRounds` 后必须填写追加 reason。 |
| 刷新战报 | regenerate report | 只重新结算 deterministic counts 和 report freshness，不重跑我方代理和反方。 |
| 接受风险并通过 | `waive_p1` + report refresh + `approve`，或 direct approve | 仅在无 P0 时可用；P1 必须逐项记录 reason，并且只能 approve fresh report。 |
| 终止 Battle | block / reject | 停止该 change 的 Spec 推进。 |

后台动作名不能作为主按钮文案。`Request Changes`、`Return to Spec`、`Waive P1` 只用于 API、审计记录和高级详情。

### 最终轮规则

`maxSpecRounds` 只限制自动对抗轮数，不得制造用户死局。

- 最终轮存在 P0：不能通过；用户可终止或继续追加一轮修订。
- 最终轮存在 P1：用户可继续追加一轮；当 `allowP1Waiver=true` 时也可接受风险并通过。
- 当 `allowP1Waiver=false` 且存在 open P1 时，“接受风险并通过”不可用，但“继续追加一轮”和“终止 Battle”必须可用。
- 最终轮只剩 P2：用户可直接通过。
- UI 不得出现所有主操作都不可用的状态。

### 失败轮展示

当我方代理、反方或战报官失败时，主界面仍必须显示“战场”和“本轮战报”。

失败战报至少包含：

- 失败发生在哪个单位。
- 是否已有可用我方代理/反方产物。
- 当前是否可刷新战报。
- 当前是否可继续对抗一轮或重试本轮。
- 当前是否可终止 Battle。

失败状态不得把缺失的反方 JSON 当作“无 gap”。

## 权威存储与镜像

DB 权威数据：

- Change status。
- Round status。
- Requirement Gap status / severity。
- Human decisions。
- Gate approval state。
- Report metadata / source hashes。

文件镜像：

- `requirement-gaps.json`
- `human-decisions.json`
- `rounds/spec-round-XX*.json|md`
- `reports/spec-report.md`
- `reports/war-report.md`

镜像规则：

1. DB 写入成功后刷新文件。
2. 文件必须包含 `generatedAt` 和 `sourceHashes`。
3. DB 与文件冲突时 DB 胜出。
4. 文件缺失时可以从 DB 重新生成。
5. JSON mirror stale 只展示，不阻断 Approve。
6. `spec-report.md` stale 必须阻断 Approve。

## Battle 输入快照

每轮必须保存输入事实或 artifact 引用：

- 用户需求或 `change-request.md`。
- `.ship/baseline/prd.md`。
- 当前 `prd-delta.md`。
- 当前所有 open / downgraded / overridden 且会阻断 Spec 的 P0/P1 Requirement Gap。
- 上一轮 RedFixClaim 和 BlueGapReview。
- 上一轮 report。
- Battle params。
- 输入文件 hash。

用途：

- 判断 report stale。
- 支持审计。
- 支持跨轮 gap 匹配。
- 证明我方代理/反方结论来自哪些输入。
- 确保我方代理不是泛化重写 PRD，而是基于旧 gap 逐项修复。

## Agent 输出契约

### 我方代理 `SPEC_WRITER`

我方代理输出必须同时包含 PRD Delta 内容和结构化修复声明。系统可以接受 Markdown 主体，但必须能从输出中解析出 `fixClaims`。

```json
{
  "unit": "SPEC_WRITER",
  "changeId": "<changeId>",
  "phase": "Spec",
  "prdDeltaMarkdown": "# PRD Delta...",
  "fixClaims": [
    {
      "canonicalGapId": "gap-existing-id",
      "action": "fixed",
      "specPatch": "补入 PRD Delta 的最小文本",
      "evidence": "说明该文本如何覆盖 gap"
    }
  ],
  "summary": {
    "fixed": 1,
    "partiallyFixed": 0,
    "notFixed": 0,
    "needsHumanDecision": 0
  }
}
```

我方代理缺少任一 open P0/P1 的 `fixClaims` 时，本轮不得进入“反方已完整复核”的完成态；系统可以继续运行反方，但战报必须标记缺失 claim 的 gap 为 `not_rechecked_by_red`。

### 反方 `REQUIREMENT_CRITIC`

反方输出必须先包含旧 gap 复核，再包含新增 gap。`gapReviews` 覆盖本轮我方 `fixClaims`；`requirementGaps` 只放新增或仍需新建 canonical gap 的问题。

```json
{
  "unit": "REQUIREMENT_CRITIC",
  "changeId": "<changeId>",
  "phase": "Spec",
  "gapReviews": [
    {
      "canonicalGapId": "gap-existing-id",
      "verdict": "resolved",
      "severity": "P1",
      "evidence": "复核证据",
      "resolutionEvidence": "PRD Delta 中的新验收标准",
      "downgradedTo": null
    }
  ],
  "requirementGaps": [
    {
      "canonicalGapId": "gap-new-id",
      "title": "新增问题",
      "category": "acceptance",
      "severity": "P1",
      "evidence": "证据",
      "affectedArtifacts": ["<prdDeltaPath>"],
      "proposedSpecPatch": "建议修复文本",
      "specBlocking": true,
      "mergeBlocking": true
    }
  ],
  "summary": {
    "resolvedThisRound": 1,
    "stillOpen": 0,
    "newlyFound": 1,
    "notRechecked": 0,
    "recommendedNextAction": "request_changes"
  }
}
```

反方缺失旧 open P0/P1 的 `gapReviews` 时，系统不得关闭这些 gap，也不得把缺失视为通过。

## Battle Round 状态

```ts
type BattleRoundStatus =
  | "not_started"
  | "red_running"
  | "red_done"
  | "blue_running"
  | "blue_done"
  | "report_ready"
  | "superseded"
  | "closed"
  | "failed";
```

`superseded` 表示该轮已被后续 round 取代；不可修改、不可 approve，可用于 stale 判断和审计。

人工追加轮必须记录：

```ts
interface RoundExtensionFields {
  humanExtended: boolean;
  extensionReason: string | null;
}
```

当 `roundNo > maxSpecRounds` 时，`humanExtended` 必须为 `true`，`extensionReason` 必须非空。

## Requirement Gap 模型

MVP 必需字段：

```ts
interface RequirementGap {
  id: string;
  changeId: string;
  canonicalGapId: string;
  firstSeenRoundId: string;
  lastEvaluatedRoundId: string;
  resolvedByRoundId: string | null;
  sourcePhase: "Spec";
  sourceUnit: "REQUIREMENT_CRITIC" | "HUMAN_COMMANDER";
  title: string;
  category: string;
  evidence: string;
  affectedArtifacts: string[];
  proposedSpecPatch: string | null;
  severity: "P0" | "P1" | "P2";
  originalSeverity: "P0" | "P1" | "P2";
  downgradedTo: "P1" | "P2" | null;
  status: "open" | "resolved" | "waived" | "downgraded" | "overridden";
  resolutionEvidence: string | null;
  waiverReason: string | null;
  downgradeReason: string | null;
  overrideReason: string | null;
  specBlocking: boolean;
  mergeBlocking: boolean;
  sourceHashes: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
```

## RedFixClaim 模型

我方代理每轮必须对当前 open P0/P1 输出修复声明。`RedFixClaim` 不直接关闭 gap，只作为反方复核和战报展示的输入。

```ts
interface RedFixClaim {
  id: string;
  changeId: string;
  roundId: string;
  gapId: string;
  canonicalGapId: string;
  action: "fixed" | "partially_fixed" | "not_fixed" | "needs_human_decision";
  specPatch: string | null;
  evidence: string;
  createdAt: string;
}
```

规则：

- 每个 open P0/P1 必须有且只有一个 `RedFixClaim`。
- `fixed` 必须给出写入或建议写入 `prd-delta.md` 的最小文本。
- `partially_fixed` 必须说明仍缺什么。
- `not_fixed` 必须说明为什么本轮没有修。
- `needs_human_decision` 只能用于产品取舍，不得用于跳过明确验收缺口。

## BlueGapReview 模型

反方每轮必须先复核旧 open P0/P1，再允许新增 gap。只有 `verdict = "resolved"` 可以关闭 Requirement Gap。

```ts
interface BlueGapReview {
  id: string;
  changeId: string;
  roundId: string;
  gapId: string;
  canonicalGapId: string;
  verdict: "resolved" | "still_open" | "downgraded" | "needs_human_decision";
  severity: "P0" | "P1" | "P2";
  evidence: string;
  resolutionEvidence: string | null;
  downgradedTo: "P1" | "P2" | null;
  createdAt: string;
}
```

规则：

- 反方必须覆盖本轮我方声明修复的全部 open P0/P1。
- `resolved` 必须提供 `resolutionEvidence`，引用新的 Spec 内容或 artifact hash。
- `still_open` 必须复用原 `canonicalGapId`，不能换 ID 造成重复开单。
- `downgraded` 必须提供降级理由；P0 不允许直接降到 P2。
- `needs_human_decision` 保持 gap 阻断，等待人类裁决或下一轮修订。

严重度：

| Severity | 含义 | Gate 行为 |
|---|---|---|
| P0 | 核心需求缺失、方向错误、核心验收无法判断、安全或数据损坏风险。 | 阻断 Spec 和 Merge；MVP 不可 waiver。 |
| P1 | 重要歧义、关键边界缺失、主要验收缺口。 | 阻断 Spec 和 Merge；可由人类填写 reason 后接受风险。 |
| P2 | 轻微歧义、文案、非关键优化。 | 不阻断；必须展示在报告中。 |

生命周期：

| 状态 | 含义 | 是否关闭 |
|---|---|---|
| `open` | 仍需处理。 | 否 |
| `resolved` | 后续 Spec 证据证明已解决。 | 是 |
| `waived` | 人类接受 P1 风险。 | 是 |
| `downgraded` | 严重度合法降低。 | 取决于目标严重度 |
| `overridden` | 未来扩展状态；MVP 不产生、不依赖。若遗留数据出现，按阻断处理。 | 否 |

关闭规则：

- 只有反方 `BlueGapReview.verdict = "resolved"` 能让 AI 自动关闭 gap。
- 关闭必须引用旧 canonical gap，不能创建新 ID 后把旧问题遗忘。
- 关闭必须提供新的 `prd-delta.md` 证据或 artifact hash。
- 反方本轮没有再次提到旧 gap，不能视为关闭；必须标记为 `not_rechecked` 并继续阻断。
- MVP 中 `HUMAN_COMMANDER` 不能直接 Mark Resolved。

降级规则：

- 合法路径：P0 -> P1，P1 -> P2。
- 非法路径：P0 -> P2。
- 降级必须有 `downgradeReason` 和新的 Spec 证据。
- P0 -> P1 仍阻断，除非后续按 P1 waiver。
- P1 -> P2 不再阻断。

跨轮匹配：

1. 优先使用 `canonicalGapId` 或显式 `previousGapId`。
2. 否则用 title、category、affectedArtifacts、evidence hash 匹配。
3. 匹配成功则更新同一 canonical gap。
4. 匹配失败则创建新 canonical gap。
5. counts 只统计每个 canonical gap 的当前 DB 状态。

逐项消账规则：

| 输入 | 系统动作 |
|---|---|
| 我方代理没有为 open P0/P1 输出 `RedFixClaim` | gap 保持 open，report 标记 `not_rechecked_by_red` |
| 我方声明 `fixed`，反方 verdict 为 `resolved` | gap 变为 `resolved`，写入 `resolvedByRoundId`、`resolutionEvidence`、`closedAt` |
| 我方声明 `fixed`，反方 verdict 为 `still_open` | gap 保持 open，更新 `lastEvaluatedRoundId` 和 evidence |
| 我方声明 `partially_fixed` | gap 默认保持 open，除非反方明确 `downgraded` 或 `resolved` |
| 反方没有复核旧 open P0/P1 | gap 保持 open，report 标记 `not_rechecked_by_blue` |
| 反方新增与旧 gap 同义但不同 ID 的问题 | 系统应合并到旧 canonical gap，或拒绝为 duplicate gap |

## Finding 与 Requirement Gap 边界

需求层问题写 Requirement Gap。普通 Spec 问题可以写 finding。

规则：

- Spec finding 可见，但不阻断。
- Spec finding 可作为 Request Changes 的 target。
- Spec finding 不计入 Requirement Gap counts。
- Spec finding 不参与 Merge Gate gap 检查。
- 同一问题同时有 finding 和 gap 时，gate 和 report counts 只使用 gap。

## Reporter Counts 算法

`BATTLE_REPORTER` 只统计 Requirement Gap：

```ts
function effectiveSeverity(gap: RequirementGap) {
  return gap.downgradedTo ?? gap.severity;
}

function isSpecBlocking(gap: RequirementGap) {
  const severity = effectiveSeverity(gap);
  if (gap.status === "resolved") return false;
  if (gap.status === "waived" && severity === "P1") return false;
  if (gap.status === "overridden") return severity !== "P2";
  if (severity === "P2") return false;
  return severity === "P0" || severity === "P1";
}

function isMergeBlocking(gap: RequirementGap) {
  const severity = effectiveSeverity(gap);
  if (gap.status === "resolved") return false;
  if (gap.status === "waived" && severity === "P1") return false;
  if (severity === "P2") return false;
  if (gap.status === "overridden") return true;
  return severity === "P0" || severity === "P1";
}
```

报告 counts：

```text
blockingP0 = count(gap where isSpecBlocking(gap) and effectiveSeverity(gap) == P0)
blockingP1 = count(gap where isSpecBlocking(gap) and effectiveSeverity(gap) == P1)
nonBlockingP2 = count(gap where !isSpecBlocking(gap) and effectiveSeverity(gap) == P2 and status != resolved)
nonMvpOverridden = count(gap where status == overridden)
openRequirementGaps = count(gap where status in [open, downgraded, overridden])
```

## Stale 与 Source Hash

`spec-report.md` 的 source hashes 至少包含：

- round metadata hash。
- red artifact hash。
- blue artifact hash。
- `prd-delta.md` hash。
- canonical Requirement Gap rows hash。
- human decisions hash。
- battle params hash。
- baseline PRD hash。
- input artifact refs hash。

`spec-report.md` stale 条件：

- `prd-delta.md` 改变。
- Requirement Gap 字段改变。
- human decision 改变。
- 当前 round 被 superseded。
- blue output 重写。
- battle params 改变。
- baseline PRD 输入 hash 改变。

`war-report.md` stale 条件：

- spec report 新生成或 stale。
- Requirement Gap 改变。
- human decision 改变。
- ChangeStatus / GateStatus 改变。
- Merge readiness 改变。

接受风险并通过顺序：

```text
fresh spec report
-> collect reason for each open P1
-> Waive P1 decisions
-> spec-report stale
-> regenerate spec-report
-> Approve fresh report
-> war-report stale
-> regenerate war-report
```

禁止：

```text
Waive P1 -> Approve old report
```

API 必须返回 `409 report_stale`。

若任一步失败，系统必须停止在当前已完成步骤之后，并在本轮战报中显示下一步恢复动作。例如 report regenerate 失败时，P1 可保持 waived，但 approve 不得执行，用户可刷新战报、继续对抗一轮或终止 Battle。

刷新战报只触发 `BATTLE_REPORTER` 的确定性重结算，不得重新运行 `SPEC_WRITER` 或 `REQUIREMENT_CRITIC`，不得改变 Requirement Gap 业务状态，除非只是更新 report metadata、source hashes、counts 和 markdown 内容。

## 人类动作

### Approve

语义：接受当前 fresh Spec Report，并允许离开 Spec Gate。

条件：

- `ChangeStatus = SPEC_READY`。
- 当前 round status = `report_ready`。
- `spec-report.md` fresh。
- `blockingP0 = 0`。
- `blockingP1 = 0`。

结果：

- 记录 decision 和 `reportHash`。
- 当前 round -> `closed`。
- Gate status -> `approved`。
- ChangeStatus 保持 `SPEC_READY`。
- 继续 TechSpec 的动作可用。

### Request Changes

语义：后台动作，产品主界面表现为“继续对抗一轮”。针对本轮战报中的具体问题做下一轮我方代理修订和反方复审。

条件：

- 当前 round 为 `report_ready`。
- 没有其它 `red_running` / `blue_running` round。
- 有 target gap/finding，或明确 reason。
- 若已达到 `maxSpecRounds`，必须由人类显式确认“追加一轮”。

结果：

- 当前 round -> `superseded`。
- 新 round -> `red_running`。
- 若 `roundNo > maxSpecRounds`，新 round 记录 `humanExtended = true` 和 `extensionReason`。
- ChangeStatus -> `SPECCING`。

### Return To Spec

语义：后台动作，产品主界面同样表现为“继续对抗一轮”。当前 Spec 方向或基础不可靠，需要整体回到 Spec 阶段重新打一轮。

条件：

- Spec Gate 有阻断 gap，或
- Merge Gate 有 merge-blocking gap。
- 人类 reason 非空。
- 若已达到 `maxSpecRounds`，必须由人类显式确认“追加一轮”。

结果：

- 从 Spec Gate 返回时，当前 round -> `superseded`。
- 新 Spec round 启动。
- 若 `roundNo > maxSpecRounds`，新 round 记录 `humanExtended = true` 和 `extensionReason`。
- ChangeStatus -> `SPECCING`。
- 从 Merge 返回时，下游 artifacts 标记 stale。

### Waive P1

语义：人类接受 P1 风险。

条件：

- target effective severity 是 P1。
- target status 是 `open` 或 P0->P1 的 `downgraded`。
- `allowP1Waiver = true`。
- reason 非空。

结果：

- gap -> `waived`。
- `specBlocking = false`。
- `mergeBlocking = false`。
- spec report 和 war report stale。
- 刷新 report 前 Approve 仍非法。

## 状态转移矩阵

| ChangeStatus | Round | Gate | 条件 | Action | 目标 ChangeStatus | Round 结果 | 是否 BLOCKED |
|---|---|---|---|---|---|---|---|
| `SPECCING` | `not_started` | `none` | round 创建 | start_spec_battle | `SPECCING` | `red_running` | 否 |
| `SPECCING` | `red_running` | `none` | 我方代理完成，且覆盖所有 open P0/P1 的 `fixClaims` 或标记缺失 | red_complete | `SPECCING` | `red_done` | 否 |
| `SPECCING` | `red_done` | `none` | 反方开始 | start_blue | `SPECCING` | `blue_running` | 否 |
| `SPECCING` | `blue_running` | `none` | 反方完成，且对旧 open P0/P1 输出 `gapReviews` 或标记未复核 | blue_complete | `SPECCING` | `blue_done` | 否 |
| `SPECCING` | `blue_done` | `none` | reporter 成功 | generate_report | `SPEC_READY` | `report_ready` | 否 |
| `SPEC_READY` | `report_ready` | `pending` | fresh 且无 P0/P1 blocker | approve | `SPEC_READY` | `closed` | 否 |
| `SPEC_READY` | `report_ready` | `blocked` | open P0，人工追加一轮 | Continue Round | `SPECCING` | superseded + new red_running | 否 |
| `SPEC_READY` | `report_ready` | `blocked` | open P0，人工终止 | Stop Battle | `BLOCKED` | 不变 | 是 |
| `SPEC_READY` | `report_ready` | `blocked` | open P1，允许 waiver | Accept Risk and Approve | `SPEC_READY` | waive + fresh report + closed | 否 |
| `SPEC_READY` | `report_ready` | `blocked` | open P1，继续对抗 | Continue Round | `SPECCING` | superseded + new red_running | 否 |
| `SPEC_READY` | `report_ready` | `blocked` | open P1，`allowP1Waiver=false` | Continue Round / Stop Battle | `SPECCING` 或 `BLOCKED` | new red_running 或不变 | 取决于动作 |
| `SPEC_READY` | `report_ready` | `pending` | only P2，人工继续 | Continue Round | `SPECCING` | superseded + new red_running | 否 |
| `SPEC_READY` | `report_ready` | `pending` | only P2，fresh report | approve | `SPEC_READY` | `closed` | 否 |
| `SPEC_READY` | `failed` | `blocked` | 我方代理/反方/战报官失败 | Retry / Continue Round / Stop Battle | `SPECCING` 或 `BLOCKED` | retry、new red_running 或不变 | 取决于动作 |
| `SPEC_READY` | `closed` | `approved` | 用户继续 | continue_pipeline | `TECHSPECCING` | closed | 否 |
| `SPEC_READY` | 任意 | 任意 | report stale | approve | 不变 | 拒绝 | 否 |
| 任意 | `red_running` / `blue_running` | 任意 | 请求新 round | start_new_round | 不变 | 拒绝 | 否 |

## Max Rounds 行为

- `maxSpecRounds` 是默认自动交手上限，不是人类裁决上限。
- 到达最终轮后，UI 必须进入“最终裁决”状态，而不是死局。
- 最终轮 open P0：不能通过；用户可“继续追加一轮”或“终止 Battle”。
- 最终轮 open P1：用户可“继续追加一轮”，也可在记录 reason 后“接受风险并通过”。
- 最终轮 only P2：通过可用，也可继续追加一轮。
- “追加一轮”会创建 roundNo = previous + 1，并在战报中记录为 human-extended round。
- 最终轮 open P0 不得自动进入 `BLOCKED`；只有用户点击“终止 Battle”并填写 reason 后才进入 `BLOCKED`。

## Merge Gate 集成

现有 Merge 逻辑：

```text
existingCanMerge = QA green && Review passed && required delta docs exist
```

MVP 扩展：

```text
canMerge = existingCanMerge && count(gap where isMergeBlocking(gap)) == 0
```

Merge invariant：

- open P0 阻断 Merge。
- MVP 不产生 P0 `overridden`；若遗留数据出现，按 merge-blocking gap 处理。
- open P1 阻断 Merge，除非 waived、resolved 或 downgraded to P2。
- P2 不阻断 Merge。
- findings 不参与 Requirement Gap merge check。

从 Merge Return to Spec：

- 合法条件：`ChangeStatus = MERGE_READY`，存在 merge-blocking gap，reason 非空。
- 结果：`ChangeStatus = SPECCING`，创建新 Spec round。
- 标记 Spec report、War report 和下游 artifacts stale。
- 不删除历史文件，不自动 revert 源码。

## Reports

`reports/spec-report.md` 必须包含：

```md
# Spec Battle Report

## Gate Verdict
- Status:
- Report Fresh:
- Blocking P0:
- Blocking P1:
- Non-blocking P2:
- Non-MVP Overridden Gaps:
- 可通过:
- Reason:

## Required Next Action
| Action | Available | Reason |
|---|---:|---|

## Red Output
- Artifact:
- Hash:
- Summary:
- Fix Claims:

## Blue Output
- Artifact:
- Hash:
- Summary:
- Gap Reviews:

## Round Delta
- Resolved This Round:
- Still Open:
- Newly Found:
- Not Rechecked:

## Gap Ledger
| ID | Previous Status | Red Claim | Blue Verdict | Current Status | Evidence |

## Requirement Gaps
| ID | Severity | Original | Status | Spec Blocking | Merge Blocking | Title | Evidence |

## Spec Findings
| ID | Severity | Status | Title | Note |

## Human Decisions
| Time | Action | Target | Report Hash | Reason |

## Round History
| Round | Status | Red | Blue | Report |
```

`reports/war-report.md` 必须包含：

```md
# War Report

## Change Summary
- Change:
- Current ChangeStatus:
- Current Gate:
- Latest Spec Round:
- Latest Spec Report:

## Pipeline Readiness
- Can Continue Pipeline:
- Can Merge:
- Blocking Reason:

## Spec Battle Verdict
- Blocking P0:
- Blocking P1:
- Non-blocking P2:
- Non-MVP Overridden Gaps:
- Resolved This Round:
- Still Open:
- Newly Found:
- Not Rechecked:

## Requirement Gap Ledger
| ID | Severity | Original | Status | Spec Blocking | Merge Blocking | First Seen | Last Evaluated |

## Human Decision History
| Time | Gate | Action | Target | Reason |

## Stale Status
- Spec Report:
- War Report:
- Downstream Artifacts:
```

## UI 要求

Spec 主界面默认必须展示：

- 战场：当前轮次、我方代理状态、反方状态、战报状态、当前局势。
- 本轮战报：我方本轮改进、反方本轮攻击、P0/P1/P2 counts、建议下一步。
- 本轮消账：已解决、仍阻断、新发现、未复核。
- 四个主按钮：继续对抗一轮、刷新战报、接受风险并通过、终止 Battle。

以下内容默认折叠在“高级详情”：

- Requirement Gap 列表，按阻断风险排序。
- Spec findings 单独列表。
- report freshness 原始状态。
- 后台合法动作和禁用原因。
- human decision history。
- round history。
- 后续 Merge 可能被 gap 阻断的 warning。
- artifact 路径、DB id、raw JSON、event stream。

高级详情中的 Gap 默认排序：

1. open Spec-blocking P0。
2. open Spec-blocking P1。
3. P0->P1 downgraded 但仍 blocking。
4. open P2。
5. waived P1。
6. resolved gaps。
7. non-MVP overridden gaps。
8. Spec findings 单独展示。

Chip 规则：

- P0：`P0 Blocking`。
- P1：`P1 Blocking` 或 `P1 Waivable`。
- P2：`P2 Non-blocking`。
- Downgraded：显示原始 severity。
- Non-MVP Overridden：显示 `Non-MVP State, Blocking`。
- Blocking 标记：`Blocks Spec`、`Blocks Merge`、`Non-blocking`。

## API 非法动作

API 必须拒绝：

1. stale Spec report approve。
2. open P0 approve。
3. open P1 未 waived/resolved approve。
4. 对 P0 调用 `waive_p1`。
5. 对 P2 调用 `waive_p1`。
6. `allowP1Waiver = false` 时调用 `waive_p1`。
7. round running 时 approve / waive / return。
8. 修改 closed round。
9. 已有 running round 时 start new round。
10. 达到 `maxSpecRounds` 后，未携带 human extension confirmation 和 reason 就创建新 round。
11. only P2 且无 target / reason 时调用后台 `return_to_spec`。
12. Spec Gate 未 approved 时 continue pipeline。
13. Merge Gate 有 merge-blocking gap 时 merge approve。
14. Request Changes 无 target 且无 reason。
15. Return to Spec from Merge 无 reason。
16. 反方缺失旧 open P0/P1 的 `gapReviews` 时把 gap 置为 resolved。
17. 我方代理缺失旧 open P0/P1 的 `fixClaims` 时隐藏或忽略该 gap。
18. 反方在未复核旧 open P0/P1 前新增 gap 并声称 Spec 可通过。

错误语义：

```text
400 invalid_action
409 illegal_transition
409 report_stale
409 gate_blocked
409 extension_reason_required
```

## 测试策略

优先覆盖纯规则，再覆盖 DB service、reporter、gate、API、UI。

必须测试：

- round 创建与固定文件名。
- blue output 创建 Requirement Gap。
- Spec report 生成与 stale detection。
- P0/P1 阻断通过。
- P1 waiver 让 report stale。
- max rounds 与 human-extended round 行为。
- Merge Gate gap check 进入 `canMerge`。
- UI 展示合法动作、禁用原因和 stale 状态。
- RedFixClaim 覆盖所有 open P0/P1。
- BlueGapReview 先复核旧 gap，再新增 gap。
- 旧 gap 缺失于 blue output 时保持 open 并出现在 Not Rechecked。

## 验收标准

1. 无阻断 Requirement Gap 且 report fresh 时，“接受风险并通过”或“通过”记录 decision、关闭当前 round、允许继续 TechSpec。
2. open P0 Requirement Gap 存在时，Approve 返回 `409 gate_blocked`，round 不关闭，UI 显示阻断原因。
3. open P0 时，“继续对抗一轮”会 supersede 当前 round，创建下一轮并把 ChangeStatus 设为 `SPECCING`。
4. 最终轮 open P0 时，系统不得自动进入 `BLOCKED`；“继续追加一轮”和“终止 Battle”必须可用。
5. 用户点击“终止 Battle”并填写 reason 后，change 进入 `BLOCKED`，历史 round、gap、report 不被删除。
6. open P1 且允许 waiver 时，“接受风险并通过”逐项收集 reason，执行 waiver，刷新 fresh report，再 approve。
7. P1 已 waived 但 report stale 时，Approve 返回 `409 report_stale`。
8. 最终轮 only P2 时，通过合法且不进入 `BLOCKED`。
9. 只有 Spec findings、没有 Requirement Gaps 时，通过合法。
10. `MERGE_READY` 且存在 merge-blocking gap 时，Merge Approve 返回 `409 gate_blocked`。
11. 从 Merge Return to Spec 后，Change 回到 `SPECCING`，创建新 round，并标记下游 artifacts stale。
12. 我方代理、反方或战报官失败时，UI 仍显示战场和失败战报，并提供重试本轮、继续对抗一轮或终止 Battle 的可恢复路径。
13. 新一轮我方代理必须收到所有 open P0/P1，并为每个 gap 输出 `RedFixClaim`；缺失 claim 的 gap 保持 open。
14. 反方必须为每个旧 open P0/P1 输出 `BlueGapReview`；缺失 review 的 gap 保持 open，并在 report 中显示为 `Not Rechecked`。
15. 反方输出 `BlueGapReview.verdict = resolved` 且带 `resolutionEvidence` 时，系统才把旧 gap 置为 `resolved`。
16. 反方新增与旧 gap 同义但不同 `canonicalGapId` 的问题时，系统不得让 counts 产生重复阻断。

## 未决问题

1. `BLOCKED` 后是否需要人工 unblock，MVP 暂不定义。
2. P0->P1 后是否允许 Waive P1：本文按允许处理，但 report 必须高亮 `originalSeverity = P0`。
3. 从 Merge Return to Spec 后是否自动处理源码回滚：MVP 不自动 revert，只标记下游 artifacts stale。
