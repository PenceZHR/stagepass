# 交接：把阶段对抗改造成「裁决者 + 子 Agent」形态（2026-07-27）

> 分支：`codex/abstract-cloud-sea-ui`
>
> 演示 change：`http://localhost:3000/projects/PRJ-004/changes/CHG-006`
>
> 前序交接：`docs/HANDOFF-codex-all-stage-card-loop-2026-07-26.md`

---

## 一、这份交接要做什么

把 Spec（以及后续所有对抗型阶段）从**服务端编排三个独立 turn**，改成**Codex 任务内一个裁决者用子 Agent 跑正反方**，同时**不丢失现有的确定性特色**。

用户原话的理想形态：

> 在 App 里开一个裁决者，然后让这个裁决者分别调用子 Agent，一个正方一个反方，然后裁决者来裁决，然后裁决者最后再调用卡牌，让我来确认。

这是**折中方案**：形态按用户要求改，但裁决结果必须按固定协议输出、由服务端解析并落库，P0/P1 统计与阻断判定仍由代码执行，不交给模型自述。

---

## 二、不可丢弃的既有特色（改造中必须原样保留）

这几条是产品的核心，任何形态改造都不能让它们退化成「模型说了算」：

### 1. Rubric 分级与恒阻断

`server/services/rubric-assessment.ts`：

- 每条 criterion 有 `blocking` 标志；
- `no` + blocking → **阻断**；
- `no` + 非 blocking → 记录但不阻断；
- **漏答等同于 `no`**（`not_assessed` 不是第三种取值）；
- 一级 criterion 是「确定性守卫」，UI 明示「由代码强制执行，此处仅呈现，关不掉」。

改造后：裁决者仍必须逐条输出 `RUBRIC: <criterionId> | yes|no | evidence`，由服务端解析入 `rubric_assessments`，阻断判定仍由代码算。

### 2. 确定性文件守卫

`server/services/stage-guard-service.ts` 的 `validatePlannedChanges`：阶段结束时对比工作区快照，落在 `StageScope.writableFiles` 之外的改动一律阻断。

改造后：**不得因为对抗收进单个 turn 而跳过这道校验**。注意当前 `pipeline-document-stage-runner-service.ts` 的领养路径（`adoptedResult`）已经绕过了它（见该文件注释），这是已知缺口，新形态下要重新评估。

### 3. Gap 生命周期

表：`requirement_gaps`、`red_fix_claims`、`blue_gap_reviews`。

- 反方提出 gap（含稳定 `canonicalGapId`、P0/P1/P2 严重度）；
- 我方对每个旧 P0/P1 给出 `FIXCLAIM: gapId | fixed|partially_fixed|not_fixed|needs_human_decision | summary | evidence | artifactPath`；
- 反方复核每条 claim，产出 `blue_gap_reviews`；
- **同一 gapId 不得重复声明**；未复核的 gap 记为未关闭。

改造后：这三张表仍必须写入，裁决者的输出要能还原出「谁提的、怎么修的、复核结论」。

### 4. 战报与回合

表：`battle_rounds`（注意不是 `spec_rounds`）、`war_reports`。

- 每轮记录 P0/P1/P2 计数、已解决/仍阻断/新发现/未复核；
- 战报**过期**概念：产物变化后战报要重新结算才可信；
- 支持「只重新结算，不重跑双方」（UI 的「刷新战报」）。

### 5. 模型不许自造结构

`PRD_DELTA<<` … `>>PRD_DELTA` 块 + 前缀行（`FIXCLAIM:` / `RUBRIC:` / `SPEC_DONE:`），由确定性解析器组装结构化结果。

> **口径更正（2026-07-27，用户澄清）**：这条规则**不是「禁止模型输出 JSON」**。
> 真正的规则是：**模型只能往一个固定的 Schema 里填，不允许自己构造一个 JSON 结构出来。**
> 行协议是满足这条规则的一种实现，不是规则本身。
>
> 因此另一种同样合规的实现是 `TurnStartParams.outputSchema` —— app-server 协议原生支持
> 「用一份 JSON Schema 约束本 turn 的最终回复」（见运行时证据文档 §5）。选哪一种是
> 第 3 步要定的事，判据是「结构由谁决定」，不是「是不是 JSON」。
>
> 无论选哪种：**分段可解析**（§4.4 的中间态可见性）和**协议违规即整轮驳回**（§4.3）都不变。

---

## 三、现状（改造的起点）

### 当前对抗形态

服务端编排三个独立 logical turn，角色由提示词区分：

```
pipeline-spec-stage-service.ts
  ├─ logicalRole: "spec_writer"  我方，产 PRD delta + FIXCLAIM
  ├─ logicalRole: "spec_critic"  反方，挑 gap
  └─ logicalRole: "spec_verdict" 裁决，结算战报
```

三者对同一个 Codex 任务发三次调用，彼此看不到对方推理，只看到落库产物。

### Codex 子 Agent 能力：已确认原生支持

对 `/Applications/ChatGPT.app/Contents/Resources/codex` 取 strings 的实测结果：

```
spawnAgent            subAgentThreadSpawn
SubagentStart         SubagentStop
subAgentReview        subAgentActivity
multi_agent_version   SUBAGENTS（出现在 codex_app_server_protocol 能力命名空间）
```

结论：**不需要自造子 Agent 机制**。但接手人必须先验证「主 Agent 在一次 turn 内 spawn 子 Agent 并取回结果」在当前版本（`codex-cli 0.146.0-alpha.3.1`）上真实可用——上面只是二进制里的符号证据，不是运行时证据。

> **✅ 已验证（2026-07-27）**，完整证据见
> `docs/CODEX-SUBAGENT-RUNTIME-EVIDENCE-2026-07-27.md`，复现脚本
> `scripts/probe-codex-subagent.mjs`。三句话版本：
>
> 1. **app-server 路径可用**，`multi_agent` 默认开启，不用改 config。每个子 Agent 有自己的
>    thread id，产出带着它自己的 `threadId` 推过来 —— 服务端可以按 thread 归属正反方产出，
>    **不需要采信裁决者的转述**。`agentPath`（`/root/red`、`/root/blue`）可直接映射 `logicalRole`。
> 2. **CLI `codex exec` 路径不可用**，不能拿它搭夹具。
> 3. **spawn 失败是静默的**：CLI 实测中一个子 Agent 都没起，主 Agent 自己把两方的答案写了出来，
>    turn 以**成功**终态结束。任何读「裁决者最终回复」的验收都会判它通过 —— 见证据文档 §4。

---

## 四、折中方案设计

### 目标形态

```
Codex 任务（一个，裁决者为主 Agent）
  ├─ spawnAgent → 正方子 Agent：产 PRD delta + FIXCLAIM
  ├─ spawnAgent → 反方子 Agent：产 gap 列表
  ├─ 裁决者裁决，按固定协议输出全部结构化行
  └─ present_stagepass_choices → 用户确认
```

### 守住 DB first 的关键约束

用户明确要求：「我依旧要保证我的项目是 DB first，只是改了一下形式而已」。

因此：

1. **裁决者的输出是唯一入口，但不是唯一真相**。服务端解析它的协议行，写入 `battle_rounds` / `requirement_gaps` / `red_fix_claims` / `blue_gap_reviews` / `war_reports` / `rubric_assessments`，形态与现在**逐字段同构**。
2. **P0/P1 统计、阻断判定、gap 关闭判定由服务端代码算**，不采信裁决者自述的结论数字。
3. **协议违规 = 整轮驳回并重试**，与现在行协议的失败处理一致（不得「尽力解析」）。
4. 中间态可见性：建议裁决者在每个子 Agent 结束后立即输出该方的协议块，服务端**分段落库**，而不是等整轮结束一次性吐出——否则一个长 turn 崩了会丢掉全部中间证据（当前形态的可恢复性优势就是这么来的）。

### 建议的输出协议（草案，接手人可调整）

```
RED_DELTA<<
（我方 PRD delta 正文）
>>RED_DELTA
FIXCLAIM: <gapId> | fixed | <summary> | <evidence> | <artifactPath>

BLUE_GAPS<<
GAP: <canonicalGapId> | P0|P1|P2 | <title> | <rationale>
>>BLUE_GAPS

VERDICT<<
（裁决理由正文）
>>VERDICT
GAP_REVIEW: <canonicalGapId> | closed|open|not_rechecked | <evidence>
RUBRIC: <criterionId> | yes|no | <evidence>
ROUND_DONE: true
```

要点：每一段都能独立解析和落库；`GAP_REVIEW` 与 `FIXCLAIM` 的 gapId 必须能对上，对不上就是协议违规。

---

## 五、当前阻塞（接手第一件事）— ✅ 已修（2026-07-27）

> **状态更新**：本节描述的「等人被当成失败」已修复，第 2 步（子 Agent 运行时验证）也已完成，
> 结论见 `docs/CODEX-SUBAGENT-RUNTIME-EVIDENCE-2026-07-27.md`。
> 下面保留原始诊断，因为它解释了为什么要这么改。修法记在本节末尾的「已落地的修法」。

**Spec 服务端从未跑通过一次完整对抗。** 实测证据（CHG-006）：

```
battle_rounds:      1 行，status=failed
requirement_gaps:   0
red_fix_claims:     0
blue_gap_reviews:   0
war_reports:        0
rubric_assessments: 0
```

最近一次 Spec job 的失败原因：

```
StageAwaitingClarificationError: spec stage is waiting for the human to answer its questions in Codex
```

### 这是什么

`pipeline-document-stage-runner-service.ts` 里新增的守卫：一个以「调用卡片提问」结束的 turn 产出的是确认语、不是阶段产物，直接落库会把「我已展示十个问题」写成 PRD 并放行门禁（这个错误真实发生过）。守卫本身是对的。

### 问题在哪

「等待人工回答」被表达成**抛异常**，于是：

- pipeline job 记为 `failed`；
- `battle_rounds` 第 1 轮记为 `failed`；
- 门禁把 `run_spec` 关掉、只留 `retry_spec`（`spec_round_failed_retry_required`）。

**「等人」不是失败。** 新形态开工前必须先给澄清交接一个非失败终态，否则每次问问题都会污染回合状态。这也是当前「点了 Spec 但没有对抗」的直接原因。

建议方向：给 stage runner 一个 `awaiting_clarification` 终态，job 记为成功但阶段不推进、回合不标失败；澄清收敛后由 wakeup 领养路径接手完成该阶段（领养链路已经建好，见下节）。

### 已落地的修法（2026-07-27）

按上面的方向做了，落点如下。

**新回合状态 `awaiting_clarification`**（`server/types/battle-round-status.ts`）

- **不在** `RUNNING_BATTLE_ROUND_STATUSES` 里。这条是硬约束：`recoverStrandedBattleRounds`
  正是扫这个集合、把「没有在跑的 run」的回合标 `failed`。把暂停态放进去，等于让恢复
  链路从另一侧把「等人 = 失败」重新造出来。
- **在** `OCCUPIED_BATTLE_ROUND_STATUSES` 里：回合真实存在且未完成，旁边不能再开一个。

**暂停与恢复**（`spec-battle-service.ts`）

- `pauseSpecBattleRoundForClarification`：只对正在跑的一方生效，`endedAt` 保持 null
  （回合没结束）。同时记一条 `spec_round_clarification_paused` 事件，**记住是哪一方停的**
  —— 状态字段已经被 `awaiting_clarification` 覆盖掉了，红蓝都可能提问，猜「红方」会把
  一个已经产出的红方腿重跑一遍，连同它的 PRD delta 和 fix claim 一起丢掉。
- `resumeSpecBattleRoundFromClarification`：回到停的那一方，并在同一个事务里开一条新的
  business run（原来那条在暂停时已经落 `stopped`，终态的 run 扛不了后续账）。重复领养返回
  `resumed: false`，不会重跑。
- `claimSpecBattleRedRun` 拒绝认领暂停中的回合，除非调用方是 `retry_spec`
  （`abandonClarification: true`）—— 这是用户放弃问答循环的唯一出口。

**runSpec 吸收异常**（`pipeline-spec-stage-service.ts`）

`StageAwaitingClarificationError` 不再往上抛：回合暂停、run 落 `stopped`、change 留在
`SPECCING`、job 记成功。顺带给蓝方补了同一个守卫 —— 蓝方原本没有这道检查，它以提问卡结束
的 turn 会被当成 gap 列表落库。

**门禁**（`action-contract-design-policy.ts`）

`run_spec` 关（`spec_round_awaiting_clarification`），`retry_spec` 开。没有这个分支，新状态
会落到 `spec_round_not_actionable` 把两个都关掉 —— 一个比原来更糟的死角。

**领养**（`stage-result-adoption-service.ts`）

注册了 `spec` adopter。在此之前只有 `prd`，也就是说 Spec 回合一旦提问，就只能被
`retry_spec` 放弃，用户已经给出的答案没有任何东西可以完成。

**测试**：`spec-battle-service.test.ts` +6、`spec-rubric-battle.test.ts` +2（其中一条是端到端：
红方以提问卡结束 → 回合暂停而非失败 → 领养收敛回复 → 回合走完 `report_ready`，fix claim、
gap、rubric 判决全部落库）、`enums.test.ts` 与 `action-contract-service.test.ts` 的状态表同步。

---

## 六、已经建好、新形态可直接复用的机制

这些是 2026-07-26～27 两轮会话建成的，**不要重复造**：

| 机制 | 文件 | 作用 |
|---|---|---|
| 收敛判定 | `stage-convergence-service.ts` | 判断一个已结束的 turn 是「还在提问」「已收敛」还是「不可采信」；能区分追问卡与确认卡 |
| 结果领养 | `stage-result-adoption-service.ts` | 把收敛后的回复交给该阶段自己的 runner 走完整落库链路 |
| 阶段落库入口 | `pipeline-document-stage-runner-service.ts` 的 `adoptedResult` | 领养的回复走与直跑**完全相同**的 rubric/校验/产物/门禁路径 |
| 观察已派发 turn | `codex-desktop-engine.ts` 的 `observeDispatchedTurn` | 观察 `host_ui_message` 派发的 turn（`run()` 只认 `follower_ipc`） |
| 每阶段独立任务 | `codex-stage-binding-resolver.ts`、迁移 `0029` | `change_stage` 作用域，键 `<changeId>:<stageId>`；阶段间隔离 |
| PRD 基线 | `clarified-prd-baseline-service.ts` | 卡片流产物写入 `prd_briefings`/`prd_drafts` 并用 `syncPrdStageAuthority` 封门禁，保持 DB first |
| 确认卡 | `stage-convergence-service.ts` 的 `STAGE_APPROVAL_QUESTION_ID` + `stage-approval-command-service.ts` | 收敛时同一 turn 内弹单题确认卡，答案路由到真实门禁命令 |
| 阶段启动动作 | `pipeline-ui-model.ts` 的 `startActionIds` | 每阶段显式声明启动动作（Fix 是 `fix_blockers`、Merge 是 `merge`），不靠命名前缀 |

---

## 七、上一轮修掉的缺陷（避免接手人重踩）

这些都有测试守着，改造时**不要回退**：

1. app-server 在 turn 启动初期把 turn 报成 `interrupted` + 空完成字段 → 归一化为 inProgress
2. stage job 观察预算被钉死在 30 秒租约 → `pipeline-owner-deadline.ts`（`startedAt + 阶段预算`，租约为下限）
3. 卡片确认语被当阶段产物落库并放行门禁 → `StageAwaitingClarificationError` 守卫（副作用见第五节）
4. `InteractionWakeupRecoveryService` 生产从未接线 → 已接入 worker 恢复扫描
5. 恢复扫描不心跳，与自己互抢导致 livelock → 已加心跳
6. 重试时终态判定被事件去重挡住 → `changed` 只决定是否推流，终态独立判定
7. 观察用 binding 当前线程而非派发线程 → 按 attempt 的 `thread_id` 观察
8. 重试导致 attempt / execution 行的 owner 盖章失配 → 重新领取时接管盖章
9. 快照续读把终态快照重放成「进行中」→ 仅在观察仍在进行时带续读凭据
10. `provider_start_missing` 误杀正在起步的 logical turn → `logical_turn_starting` 延后处理

---

## 八、验收标准

新形态跑通一轮 Spec，必须同时满足：

- [ ] Codex App 中只出现**一个** Spec 任务，任务内可见裁决者与两个子 Agent 的活动
- [ ] `battle_rounds` 有一条 `status` 非 failed 的回合
- [ ] `requirement_gaps` 有反方提出的 gap，含稳定 `canonicalGapId` 与严重度
- [ ] `red_fix_claims` 与 `blue_gap_reviews` 能按 gapId 对上
- [ ] `war_reports` 的 P0/P1 计数由**服务端**统计得出，与裁决者自述无关
- [ ] `rubric_assessments` 每条 criterion 都有裁决，漏答记为 `not_assessed` 且按 `no` 处理
- [ ] 阻断判定与现有 `rubric-assessment.ts` 语义一致
- [ ] 收敛后弹确认卡，用户确认后门禁推进
- [ ] 提问期间阶段处于「等待人工」而非 `failed`
- [ ] 全量单测失败数不超过基线 50 条，且失败文件与基线一一对应

---

## 九、环境与既有约束

### 启动命令（这两个环境变量必需）

```bash
TERM=dumb CODEX_INTERNAL_ORIGINATOR_OVERRIDE='Codex Desktop' \
STAGEPASS_CODEX_DESKTOP_BRIDGE=on STAGEPASS_MCP_INTERACTIONS=on \
STAGEPASS_CODEX_DECISION_SURFACE=on \
STAGEPASS_CODEX_DECISION_PHASES=PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge \
pnpm dev
```

**为什么必需**：`KNOWN_APP_SERVER_RUNTIMES` 白名单钉死的 userAgent 字符串里，`Codex Desktop/` 这个 originator 和 `dumb` 这个终端类型都来自**本进程的环境**，不是 app-server 的身份。缺任一个，能力探测返回空、UI 显示 `App unsupported`、阶段直接失败。

这本身是个设计缺陷（支持门禁依赖调用方环境），已知未修。

### 测试

- **不要**裸跑 `tsx --test`，会写生产库。用 `pnpm exec tsx scripts/run-tests-isolated.ts <file>`。
- 基线：全量 **2813 跑 / 50 失败**，失败集中在 `review-report-service`(26)、`pipeline-service`(9)、`prd-service`(4) 等既有红灯。

### 生产库

`server/db/ship.db`，迁移 0029 已应用。备份在 `/private/tmp/ship-backup-before-0029-*.db`。

---

## 十、CHG-006 现状快照

| 项 | 值 |
|---|---|
| 状态 | `INTAKE_READY`，`gate_state=intake` |
| PRD 产物 | `.ship/changes/CHG-006/change-request.md`（4426 字节，真实收敛结果） |
| PRD 基线 | `prd_briefings.status=locked`，1 份 `prd_drafts`，门禁哈希与基线一致 |
| PRD 任务 | thread `019fa162-21f3…`（change 级遗留绑定） |
| Spec 任务 | thread `019fa1c3-b710…`（`change_stage` 作用域 `CHG-006:spec`） |
| Spec 回合 | 1 轮，`failed`（成因见第五节，非真实对抗失败） |
| 门禁 | `run_spec` 关闭、`retry_spec` 开启 |

产物开头带有「第三批决策已确认：…」的过渡语，正文从 `# CHG-006 变更请求` 开始——模型把本批小结和正式结果写在同一条消息里，领养采用整条回复。是否给正式产物加显式包裹块（类似 `PRD_DELTA<<`）是个待定项。

---

## 十一、给接手人的建议顺序

1. ~~**先修「等待人工」终态**（第五节）~~ ✅ 已完成，修法见第五节末尾。
2. ~~**验证子 Agent 运行时可用性**~~ ✅ 已完成，见 `docs/CODEX-SUBAGENT-RUNTIME-EVIDENCE-2026-07-27.md`。
3. **定协议**（第四节草案），先写解析器和落库测试，再动提示词。**← 下一步在这里**
4. **单阶段跑通 Spec**，用第八节验收。
5. 通过后再推广到 TechSpec / Plan / Review 等其余对抗型阶段。

### 第 3 步：运行时证据改变了协议的选型条件

第四节的草案协议假设「裁决者把三方的东西全部转述出来，服务端解析裁决者的一条回复」。
运行时证据说明这个假设比实际能力**弱**，而且弱在最危险的地方：

- 子 Agent 的产出**带着它自己的 threadId** 独立推送。正方产出、反方产出可以按 thread
  直接归属，**根本不必经过裁决者的嘴**。让裁决者转述红蓝内容，等于把一个本来确定的事实
  重新交给模型复述一遍。
- 反过来，**「这一方到底有没有真的跑过」也必须由服务端从 `subAgentActivity` 判定**。实测里
  主 Agent 在一个子 Agent 都没起的情况下，把两方的答案都编了出来，turn 还是成功终态。

### 第 3 步的两个决定（2026-07-27，用户已拍板）

**决定一：按 thread 归属，不让裁决者转述。**

裁决者的输出只负责**裁决**（`GAP_REVIEW` / `RUBRIC` / `ROUND_DONE`）。正方的 PRD delta +
FIXCLAIM、反方的 GAP 列表，**各自从它自己的子 Agent thread 里取**。服务端不采信裁决者对
红蓝内容的任何转述。代价是服务端要按 thread 收齐产出，收不齐即协议违规、整轮驳回重试。

**决定二：用原生 `outputSchema` 约束 JSON，废弃这条路径上的行协议解析链。**

理由（用户原话大意）：有原生能力就用原生能力；GPT 写 JSON 是稳的，因为它不是自己构造结构，
而是拿到 Schema 之后往里填。

**决定三：指派仍由裁决者发起，服务端事后强校验（2026-07-27 用户拍板）。**

先查过「能不能由 StagePass 用 Codex 原生指令确定性指派」——**这个版本没有这个能力**，
三条路全堵（app-server 89 个方法、App 全部斜杠命令、@ mention 目标类型，证据见运行时证据
文档 §5）。所以取舍是：**「子 Agent 形态」和「确定性指派」不能同时要**。

选了保留子 Agent 形态：Codex App 里只有一个 Spec 任务，任务内可见裁决者和两个子 Agent。
指派动作由裁决者执行，但「真的起了 / 顺序对 / 每轮是新的 / 内容合规」四件事全部由服务端验，
任何一条不满足就整轮驳回重试。

**决定四：每一轮是同一个任务里的新 turn + 新提示词 + 新的子 Agent。**
不是开新任务，也不是复用上一轮的红蓝。

### ⚠️ 两个决定之间有一个必须先解决的约束

`spawn_agent` 的参数是 `task_name` / `agent_type` / `model` / `reasoning_effort` /
`fork_turns` / `fork_context` / `nickname` / `service_tier` / `message`，**没有 `output_schema`**。
`outputSchema` 只存在于 `TurnStartParams`，也就是**只有根 turn（裁决者）的最终回复能被运行时强制约束**。

子 Agent 的回复拿不到运行时强制。于是决定一（红蓝内容从子 Agent thread 取）和决定二
（用 outputSchema）不能同时靠运行时满足。可行的落法是：

- **红蓝子 Agent**：Schema 由服务端写死并**原样放进它们的提示词**，服务端拿到回复后
  **严格校验**，不符合就是协议违规 → 整轮驳回重试（不得「尽力解析」）。结构仍然由服务端
  定死、模型只负责填，符合第六节第 5 条的口径，只是「强制」发生在服务端而不是运行时。
- **裁决者**：走 `TurnStartParams.outputSchema`，运行时强制。

这条约束是实测出来的（见运行时证据文档 §2 工具面），不是推测。

### 第 3 步已落地的部分（2026-07-27）—— 解析器与落库前校验

按上面两个决定 + 那条约束写完了，**没有动提示词，也没有动 runSpec 的编排**。

| 文件 | 作用 |
|---|---|
| `codex-app-server-shell-control.ts` | 归一化器认识 `subAgentActivity` 与 `collabAgentToolCall` |
| `codex-subagent-attribution.ts` | 按 thread 把「哪一方真的跑过」和「它说了什么」变成服务端事实 |
| `server-owned-json-output.ts` | 严格读取「服务端定义 Schema、模型只负责填」的回复 |
| `spec-judge-output-schema.ts` | 裁决者的 Schema（只有裁决，没有红蓝内容，没有任何计数） |
| `spec-judge-round-ingestion.ts` | 三方合成一轮；**全部通过才算一轮，否则整轮驳回** |

几个不显然但重要的点：

1. **归一化器原本会把带子 Agent 的 turn 整个扔掉。** 它对未知 item kind 是 fail-closed 的
   （`default: throw snapshotInvalid`），所以第一个 spawn 子 Agent 的 Spec turn 会被判成
   `turn_snapshot_invalid`，把「委派」报成「快照损坏」。

2. **`collabAgentToolCall` 被故意折叠进 `tool_call`，它的字段一个都没进 semantic。**
   `receiverThreadIds` 和 `agentsStates` 在两个子 Agent 确实跑完的那次实测里**也是空的**。
   把它们投影出来，等于在真正的归属字段旁边放一个长得像归属、但恒为空的字段。

3. **裁决者的 Schema 里没有任何计数字段，而且不能加。** P0/P1 统计、阻断、gap 关闭仍由
   `requirement_gaps` / `red_fix_claims` / `blue_gap_reviews` 算（§2.1）。裁决者对「还剩几个
   阻断项」的看法不是「还剩几个阻断项」的证据。

4. **`not_assessed` 不在裁决者可写的取值里。** 漏答本来就会被服务端记成 `not_assessed` 并阻断；
   让裁决者能主动写它，等于把「我不判」变成一个它可以花在不想判的 criterion 上的动作。

5. **读 JSON 是严格的：不修复、不从散文里挖。** 那些恢复手段恢复的正是「模型自己决定的结构」，
   而且是静默恢复——一个无视 Schema 的子 Agent 照样把这轮结算掉。整条回复必须就是一份 JSON
   （允许整体包一层 ``` 围栏，那是排版习惯不是结构选择）。

6. **一轮要么整体成立，要么整体驳回。** 三个部分落三张表、走三个 writer；边验边写会让「蓝方失败」
   的那一轮留下一条已提交的红方腿——对后面所有查询来说，那读起来就是「反方没挑出问题」，
   比原来的 bug 更糟。

7. **每一轮必须起新的子 Agent，而且由服务端验证。** 裁决者的 Codex 任务跨轮保持打开，每轮是
   同一个任务里的**新 turn + 新提示词**。但 `close_agent` 的文档明写「完成的 agent 仍保持打开
   直到被关闭」，而且 `resume_agent` / `send_input` 都在——**第二轮完全可以复用第一轮的红蓝**，
   而且回复格式完全正常，下游看不出来。那不是第二轮对抗，是让同一个反方重新看一遍它自己已经
   放行过的东西。
   判据：本轮的 `agentThreadId` 不得出现在此前任何一轮里，否则
   `sub_agent_reused_from_earlier_round` 整轮驳回。
   还有一条一起守：`judgeItems` 必须是**本轮那个 turn** 的 items，不是整条 thread 的——
   thread 会累积每一轮的 `subAgentActivity`，整条传进去会让第二轮拿第一轮的子 Agent 蒙混过关。

8. **红蓝必须串行，而且由服务端验证。** 红方产出时蓝方不许动，蓝方复核时红方不许动。这不是
   效率问题是语义问题：蓝方复核的是红方产出的东西，两方同时跑意味着蓝方在评审一份还不存在的
   草稿，而它照样会返回一份自信、格式正确、Schema 合法的「对空气的评审」。
   **光在提示词里要求是抓不到的**——并行和串行跑出来的回复长得一模一样。判据取自两个子 Agent
   各自 thread 的时间：`蓝方.startedAt ≥ 红方.completedAt`，否则 `sub_agent_ran_out_of_turn`
   整轮驳回。读不到时间也驳回（`sub_agent_timing_unknown`）：「说不清」不能读成「做到了」。

### 顺带修掉的一个哑弹

`output-schema-validator.ts` 从来不认识 `minLength`，而它对不认识的关键字是**静默忽略**。
于是 `{ type: "string", minLength: 1 }` 这个写法在 **4 处生产 Schema** 里（spec-battle-ledger
的红方 `markdown`、两个 prd-briefing schema、delivery 的每个字符串）写了等于没写——那些阶段
一直在通过一条读起来像「不许为空」的规则接受空文档。已实现该关键字，让这 4 个既有意图成真。

### 还没做的（第 3 步的剩余部分 → 第 4 步）

- 把 `readSpecJudgeRound` 接进 runSpec 的编排（现在还是三 turn 形态）；
- 写提示词：裁决者的 spawn 指令、红蓝子 Agent 的 Schema 提示词；
- 给裁决者的 turn 带上 `TurnStartParams.outputSchema`（bridge 目前不传这个字段）。
