# Spec Battle 介入室：把人接回对抗

日期：2026-07-22
状态：待实现
范围：**仅 Spec 阶段**。跑通后再复制给 TechSpec / Plan / TestPlan。

## 问题

Spec Battle 的对抗真在跑——红方 `SPEC_WRITER` 出招、蓝方 `REQUIREMENT_CRITIC` 挑刺、多轮、
P0/P1/P2 gap 台账齐全。但人在这场对抗里只有**四个总开关**
（`spec-battlefield.tsx:470-500`）：继续对抗 / 刷新战报 / 通过 / 终止。

没有任何一条 gap 是你能碰的。你不能说「这条蓝方理解错了」，不能说「我知道答案是 X」，
不能说「这条我认了，往下走」。**你只能让它整个再跑一轮，或者整个停掉。**

这不是 UI 缺按钮。是**这个阶段从来没有为人的输入留过位置**：没有表存人的话，
没有协议让蓝方问人，没有动作让人表态。UI 难看只是这件事的表征——
gap 今天被折在「高级详情」的 `<details>` 里，因为你对它无能为力，它只配当附录。

## 现状核实：三个已建成但从未接线的地方

### ① 蓝方早就能说「这得你拍板」——系统装没听见

`needs_human_decision` 是合法的复核结论，三处都认它：

| 位置 | 角色 |
|---|---|
| `spec-critique-line-protocol.ts:31` | 解析器接受 |
| `spec-battle-ledger.ts:83` | zod 判别联合里有独立分支 |
| `spec-critic.md` | 提示词明文教蓝方写 |

而 `spec-battle-service.ts:1127` 把它和 `still_open` 一起压成 `status: "open"`——
变成又一条你碰不到的阻断项。**蓝方喊过了，落库时被压掉了。**

（`spec-battle-service.ts:1153` 的 `const unreachable: never` 穷尽守卫是好东西：
把这个 verdict 拆出独立分支时，漏改会编译失败而不是静默 no-op。）

### ② `overridden` 那扇门只装了一半

| 已建成 | 位置 |
|---|---|
| gap 状态枚举含 `overridden` | `enums.ts:173`、`spec-battle-ledger.ts:4` |
| `override_reason` 列 | `schema.ts:517` |
| 不再阻断 Spec | `spec-battle-rules.ts:60` |
| 战报排除它 | `spec-battle-report-service.ts:362` |
| `war_reports.overridden_p0` 计数列 | `schema.ts:1122` |
| 自动进交付单「已知限制」 | `delivery-known-limits-service.ts:101` |

**全仓库零个写入点。** 设计好、测试绕着走、从来没装门。

### ③ 但那扇门通向一堵墙（本次必须一并解决）

`spec-battle-rules.ts:71` 明写着：否决的**原 P0 仍然阻断 Merge**。
而 `merge-readiness-service.ts:641` 只认 `status === "resolved"` 才放行——
那是只有蓝方能给的结论。同时 `spec-battle-service.ts:452` 把 `overridden`
排除出了「待蓝方复核」名单。

连起来：**否决一条 P0 → Spec 放行 → 一路到 Merge → 被永久挡住，而蓝方已不再看它。**
这正是 `RUBRIC-DESIGN.md` §4.3.1 反复在治的那种病（死路 + 没有出口）。

P1 没这个问题，:71 只对 `originalSeverity === "P0"` 生效。

## 贯穿原则

> **人的介入是往对抗里注入事实，不是替模型下判定。**

判定是对产物的**事实陈述**（「这条已解决」），只有查证过的一方能说。
输入是**判断**（「这不该由你定」「我知道答案是 X」「这条标准我不认」），人可以说。

`spec-battle-service.ts:1374` 的 `human_cannot_resolve_gap` 保护的正是这条线，
`RUBRIC-DESIGN.md:132` 已把理由写死：

> 这个出口**不需要人说谎**：它不声称产物满足了标准，它撤销标准。

**本次设计不破这条线，它本来就站在人这边。** PRD 的追问机制之所以能成立，
正是因为它天然合规：你的回答是草稿的*输入*，草稿仍由模型写。
所以「对齐 PRD 的形式」和「不破那条线」是同一件事。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 蓝方审查时**顺手**产出问题卡，不设独立前置轮 | 蓝方正是那个会发现「这个决定不该由模型做」的角色；不多跑一次 AI |
| 2 | `needs_human_decision` 挂一张问题卡，**gap 继续阻断** | 蓝方说的是「需要人裁决」，不是「不算问题」 |
| 3 | 问题卡复用 `briefing_questions`，加 `phase` 列 | 见「为什么不建新表」 |
| 4 | 人对 gap 的动作：补充事实 / 异议 / 接受风险 / 否决 / 撤销否决 | **没有「已解决」**——那条线不破 |
| 5 | 异议**先强制对质**：蓝方下一轮必须逐条正面回应 | 蓝方可能真看到了你没看到的东西，这是一次免费纠错 |
| 6 | 对质一轮仍不撤 → 允许否决，写理由，转 `overridden` | 门槛再高就是折磨人 |
| 7 | `disputed` **不做成新状态**，用派生 | 见「为什么 disputed 不进枚举」 |
| 8 | P0 否决要**两把钥匙**：Spec 一把，Merge 一把 | 拆③的墙，同时不让一次点击把 P0 送上线 |
| 9 | gap 卡从「高级详情」升到主平面 | 你能操作它了，它不再是附录 |

## 设计

### 第 1 节：协议——蓝方多说一种话

`spec-critic.md` 与 `spec-critique-line-protocol.ts` 同步新增一种行，与 `GAP:` 平行：

```
QUESTION: category | severity | 问题 | 为什么重要 | 建议默认值
```

严格 5 字段，文本内不得含 `|`——与既有 `REVIEW`/`GAP` 同规格
（`spec-critique-line-protocol.ts:37-39` 的 `*_FIELDS` 常量旁加一个）。

提示词补一段判据（形容词管不住粒度，判据才行）：

> 写 GAP 还是写 QUESTION？
> - 规格**写错了或写漏了**，你知道该补什么 → `GAP`。
> - 规格没写错，但**这个决定本就不该由模型做**（取舍、优先级、对外承诺、
>   用户不可见但影响体验的默认值）→ `QUESTION`。
>
> 判据：你能不能替人类给出正确答案？能 → GAP。不能，只能列出选项 → QUESTION。

`severity` 沿用 P0/P1/P2 还是沿用 PRD 的 critical/important/optional？
**沿用 PRD 的三档**（`critical` / `important` / `optional`），因为落库进的是
`briefing_questions.severity`，与 PRD 卡同表同渲染。P0/P1/P2 是 gap 的语言，
问题卡不是 gap，混用会让「关键问题未处理」这类计数含义漂移。

### 第 2 节：数据——复用 `briefing_questions`，加一列

```sql
ALTER TABLE briefing_questions ADD COLUMN phase TEXT NOT NULL DEFAULT 'PRD';
```

**零新表。** 这张表的列已经完全对得上问题卡的形状
（`schema.ts:1144-1166`）：`roundNo` / `category` / `severity` / `question` /
`whyItMatters` / `suggestedDefault` / `status` / `answer` / `source`。
而且它**只 FK 到 `changes.id`**，不绑 `prd_briefings`——Spec 的卡直接能进。

#### 为什么不建新表

不是为了省事：

1. **同一张表 = 同一套读写 = 同一套 UI 组件。** 你要的「对齐 PRD 的形式」，
   最可靠的实现方式是它们本来就是同一个东西，而不是两个长得像的东西。
2. **推给另外三个阶段时，是多一个 `phase` 值，不是多三张表。**
3. `roundNo` 的 append-only 语义（`schema.ts:1149-1154` 的注释）在 Spec 同样成立，
   而且 Spec 本来就有轮次概念（`battle_rounds.roundNo`）。

代价：动了 PRD 在用的表。但只加一列且有默认值，**PRD 侧读路径一行不改**——
所有现存行读作 `phase = 'PRD'`。新增的 Spec 读路径按 `phase = 'Spec'` 过滤。

**这里有一颗雷必须一起拆：** PRD 侧现有查询若不加 `phase` 过滤，Spec 的卡会漏进
PRD 房间，并被 `computePrdGate`（`prd-briefing-ledger.ts:277`）当成未处理的
critical 问题，把 PRD 的锁定门焊死。**所有既有 `briefingQuestions` 查询点都必须
补 `phase` 条件**，这是本次改动风险最高的一处，测试须正面打这个症状
（建一张 Spec 卡，断言 PRD gate 不受影响）。

`roundNo` 存 `battle_rounds.roundNo`，与 gap 的轮次对齐。

### 第 3 节：人的四个动作

每条 gap 一张卡，四个动作。**没有「标记已解决」。**

| 动作 | 落库 | 效果 |
|---|---|---|
| **补充事实** | `human_decisions`，action `supply_fact` | gap 保持原状，你的话进入下一轮红蓝双方上下文 |
| **异议** | `human_decisions`，action `dispute`，`reason` 必填 | gap 保持阻断；蓝方下一轮**必须**逐条正面回应 |
| **接受风险** | 既有 `waive_p1` | 仅 P1，不变 |
| **否决** | gap → `overridden`，写 `override_reason` | 不再阻断 Spec；Merge 侧见第 4 节 |
| **撤销否决** | gap → `open`，清 `override_reason` | 点错了能退回去 |

`human_decisions.action` 是无 CHECK 约束的 text 列（`schema.ts:572`），
新 action 值**零 schema 改动**。要改的是三处 TypeScript 约束：
`SpecBattleDecisionInput`（`spec-battle-service.ts:73`）、
`HumanDecisionAction` zod enum（`enums.ts:177`）、
`getSpecActionAvailability`（`spec-battle-rules.ts:109`）。

#### 否决的解锁条件

`否决` 按钮只在**该 gap 已有一条 `dispute` 决定，且此后蓝方跑过至少一轮**时可用。
判据是纯函数，进 `spec-battle-rules.ts`，便于单测：

```
disputeUnanswered(gap) = 存在 dispute 决定
                       ∧ ¬∃ blue_gap_review(gap, roundId > dispute.roundId)
canOverride(gap)       = 存在 dispute 决定
                       ∧ ∃ blue_gap_review(gap, roundId > dispute.roundId)
                       ∧ gap 仍阻断
```

即：**提过异议 + 蓝方回应过 + 它没撤**。蓝方若在回应轮里 `resolved` 或
`downgraded` 到不阻断，`canOverride` 自然为假——你不需要否决了。

#### 为什么 disputed 不进 GapStatus 枚举

`GapStatus` 加一个值要改所有读路径：`isSpecBlockingGap` / `isMergeBlockingGap` /
`ACTIVE_GAP_STATUSES` / `computeGapCounts` / `activeSpecBlocking` /
`delivery-known-limits-service` / 战报 / 迁移。而 `disputed` 在**阻断语义上与
`open` 完全一致**——它不改变这条 gap 拦不拦你，只改变界面显示和蓝方的义务。

用派生：`disputed` = 有 dispute 决定且蓝方尚未回应。数据来源是
`human_decisions` + `blue_gap_reviews` 的 `roundId` 比较，两张表都已就位。

代价：判定是隐式的，看 DB 单行看不出来。**用一个具名导出函数把它显式化**
（`disputeUnanswered`，位置同上），而不是散在调用点里写内联条件。
这是本仓库「同一规则不要留两份拷贝」教训的直接应用。

#### 蓝方怎么知道有异议

`pipeline-spec-stage-service.ts` 组装蓝方输入时，把「未回应的异议」和
「已回答的问题卡」一并写进上下文，并在 `spec-critic.md` 加一条硬性规则：

> 若上下文中存在人类异议（`HUMAN_DISPUTE`），你**必须**对每一条写一行 REVIEW：
> 要么 `resolved` / `downgraded`（接受异议），要么 `still_open` 并在
> `reviewSummary` 里说清人类哪里判断错了。**不允许沉默略过。**

「沉默即未回应」的判定已经由 `disputeUnanswered` 覆盖——蓝方装没看见，
`canOverride` 不成立，你仍然卡着。所以这条规则的强制力不靠提示词自觉，
靠的是**不回应就解锁不了否决**这个结构。

（`computeRoundDelta` 的 `notRechecked` 计数已有同构逻辑，
`spec-battle-service.ts:449-465`，UI 已经会显示「未复核」——沿用同一表达。）

### 第 4 节：两把钥匙——拆掉 Merge 那堵墙

否决一条**原 P0**：第一把钥匙开 Spec，Merge 门口还有第二把。

`requirement_gaps` 加一列：

```sql
ALTER TABLE requirement_gaps ADD COLUMN merge_override_reason TEXT;
```

`spec-battle-rules.ts:71` 那条规则改为读它：

```
现在：if (status === "overridden" && originalSeverity === "P0") return true;
改为：if (status === "overridden" && originalSeverity === "P0")
        return mergeOverrideReason === null;
```

`RuleGap` 随之加一个字段。**规则函数仍是唯一事实源**——
`requirement_gaps.merge_blocking` 列是它的缓存，不是第二份判定
（`completeBlueCritique` 已经是这个模式：`spec-battle-service.ts:1137-1138`
从 `isSpecBlockingGap`/`isMergeBlockingGap` 派生，不信模型的输出）。

Merge 阶段 UI 列出所有「已在 Spec 否决、仍挡 Merge」的 gap，每条一个
「确认带病上线」动作，写 `merge_override_reason` + 一条 `human_decisions`
（action `override_merge`）。**只对已经是 `overridden` 的 gap 可用**——
不能拿它绕过一条从没对质过的 P0。

这超出了「只做 Spec」的约定，是有意的：**不能交付一个会把流水线焊死的功能。**
Merge 侧的改动刻意做到最小——`operational-phase-panel.tsx` 加一个列表 + 一个动作，
不重做 Merge 界面。

撤销否决时一并清 `merge_override_reason`，避免「撤销后重新否决，
第二把钥匙还留着」这种残留放行。

### 第 5 节：UI——照搬 PRD 房间的骨架

`spec-battlefield.tsx` 重构。目标形状：

```
┌ 五步导航   红方出招 → 蓝方审查 → 你的裁决 → 战报 → 通过
│            （替换现在的「战况面板」；对应 PRD 的 Intent→Questions→Draft→Review→Locked）
├ 三块摘要   待你拍板 N · 阻断 P0/P1 · 战报新鲜度
├ 卡片流     主体，单列，按轮分组，最新轮展开，其余轮全部处理完才折叠
│   · 问题卡  [回答] [接受假设] [推迟]
│   · gap 卡  [补充事实] [异议] [接受风险] [否决] / [撤销否决]
├ 折叠区     回合历史 / 红方修复声明 / 蓝方复核 / 审计路径
└ 底部 bar   继续对抗 / 刷新战报 / 通过 / 终止
```

几条具体规则：

- **单列，不用 `xl:grid-cols-2`。** 卡片有优先级之分，双栏会打乱阅读顺序。
  （PRD 侧同一处正在做同样的改动，见
  `2026-07-22-prd-briefing-question-granularity-design.md` 第 3 节。）
- **轮次折叠沿用 PRD 的规则**（`prd-briefing-room.tsx:677-681`）：
  一轮里只要还有未处理项就保持展开——藏起来等于藏起了门禁不放行的原因。
- **问题卡组件从 `prd-briefing-room.tsx` 抽出**为共享组件。它今天是 `QuestionCard`
  （`prd-briefing-room.tsx:175`），已经是纯展示 + 回调，抽出成本低。
  抽出后 PRD 房间从共享位置 import，**两边永远长一样**——这是「对齐 PRD 的 UI」
  这个目标唯一不会随时间漂移的实现方式。
- **底部四个总开关不再是主角。** 它们是 `PhaseStageShell` 已提供的 stage action bar
  （`page.tsx:1376` 传 `gateStageActions`），不用新建容器。
- **状态文案统一中文。** 现在 gap 卡直接把 `gap.status`、`review.verdict`
  这些英文枚举裸露在界面上（`spec-battlefield.tsx:576`、`:544`），
  照 PRD 的 `STATUS_LABELS` / `SEVERITY_LABELS` 建映射表。

### 第 6 节：测试策略

| 层 | 文件 | 关键用例 |
|---|---|---|
| 协议 | `spec-critique-line-protocol.test.ts` | `QUESTION` 五字段解析；字段数不符驳回；含 `|` 驳回 |
| 提示词 | `spec-battle-prompt.test.ts` | `spec-critic.md` 含 QUESTION 格式与 GAP/QUESTION 判据；含异议必答规则 |
| 落库 | `spec-battle-service.test.ts` | `needs_human_decision` 建卡且 gap 仍阻断；QUESTION 落 `phase='Spec'`；dispute/override/撤销的状态流转 |
| **串扰** | `prd-briefing-service.test.ts` | **建一条 `phase='Spec'` 的卡，断言 PRD gate 与 `getQuestions()` 不受影响**——正面打第 2 节那颗雷 |
| 规则 | `spec-battle-rules.test.ts` | `disputeUnanswered` / `canOverride` 四态；否决后 `isSpecBlockingGap` 假而 `isMergeBlockingGap` 真；补第二把钥匙后转假 |
| Merge | `merge-readiness-service.test.ts` | 否决的 P0 仍列为 blocker；写 `merge_override_reason` 后消失 |
| 交付单 | `delivery-known-limits-service.test.ts` | 否决项进「已知限制」并带 `override_reason` |
| UI | `spec-battlefield.test.ts`（新建） | 卡片容器单列；gap 卡在主平面而非 `<details>` 内 |

**反向断言**同样是主防线：断言 `spec-battlefield.tsx` 不再把 gap 渲染在
「高级详情」内，断言蓝方分支不再把 `needs_human_decision` 压成 `open`。
正向断言只能证明新东西在，证明不了旧行为已消失。

**验证方式**：

```bash
npx tsx scripts/run-tests-isolated.ts server/services/spec-battle-service.test.ts
```

看 `ℹ fail` / `ℹ cancelled` 计数而非 exit code——全量跑会 exit 0 但藏着失败。

**新增 DB 写入点必须同步登记**（`db-write-policy.json` 的 `productionEntries`，
新写库测试进 `testFixtures`），然后：

```bash
npx tsx scripts/generate-db-write-inventory-snapshot.ts
```

`db-write-inventory.test.ts:133` 会做 AST 扫描比对，漏登记直接红。

## 改动面清单

| 文件 | 改动 |
|---|---|
| `server/db/migrations/0026_spec_battle_human_intervention.sql` | `briefing_questions.phase`；`requirement_gaps.merge_override_reason` |
| `server/db/schema.ts` | 同上两列 |
| `server/templates/prompts/spec-critic.md` | QUESTION 行格式、GAP/QUESTION 判据、异议必答规则 |
| `server/services/spec-critique-line-protocol.ts` | `QUESTION` 关键字与字段校验 |
| `server/services/spec-battle-ledger.ts` | `BlueCritiqueOutputSchema` 加 questions；JSON schema 同步 |
| `server/services/spec-battle-service.ts` | `needs_human_decision` 独立分支；问题卡落库；dispute / override / revoke / supply_fact 处理 |
| `server/services/spec-battle-rules.ts` | `disputeUnanswered` / `canOverride`；`isMergeBlockingGap` 读第二把钥匙；可用性表加新动作 |
| `server/services/pipeline-spec-stage-service.ts` | 蓝方输入注入未回应异议 + 已回答问题卡 |
| `server/services/prd-briefing-*.ts` | **所有 `briefingQuestions` 查询补 `phase` 过滤** |
| `server/types/enums.ts` | `HumanDecisionAction` 加四个值 |
| `app/api/.../spec-battle/*` | 新动作的路由 |
| `app/.../spec-battlefield.tsx` | 按第 5 节重构 |
| `app/.../question-card.tsx`（新建） | 从 `prd-briefing-room.tsx` 抽出，两边共用 |
| `app/.../operational-phase-panel.tsx` | Merge 侧第二把钥匙列表 |
| `server/db/db-write-policy.json` + snapshot | 新写入点登记 + 重算 |
| 第 6 节的测试文件 | 见上表 |

## 明确不做

- **不破 `human_cannot_resolve_gap`。** 人永远不能把 gap 标成 `resolved`。
  `override` 不声称问题解决了，它声称「我知情并承担」——落在那条线的正确一侧。
- **不发 `stage_progress` 事件。** PRD 房间用它做轮询标记，但
  `spec-battle-repair-service.ts:77` 消费它：Spec 一旦开始发，运行中的
  stranded-round 修复会被连带抑制（`spec-battle-repair-service.test.ts:168`
  覆盖着这个行为）。Spec 已有自己的状态轮询，不引入这个副作用。
- **不设独立的 Spec 前置追问轮。** 蓝方审查时顺手产出，零额外 AI 调用；
  此时已有 spec 草稿，问出的东西比空手问具体得多。
- **不让 `disputed` 进 `GapStatus`。** 理由见第 3 节。
- **不做异议轮数上限。** 对质一轮即可解锁否决，人本来就随时能退出。
- **不改 TechSpec / Plan / TestPlan。** 本次跑通后再复制。
  （Plan 的 `plan-critique.json` 全仓库无生产者、「接受 P1」按钮永远点不亮，
  TestPlan 面板零按钮——这两件事在复制阶段处理，已知，不在本次范围。）
- **不重做 Merge 界面。** 只加第二把钥匙所需的最小列表和动作。
- **不改红方（`SPEC_WRITER`）的协议。** 人的输入通过上下文抵达，不需要新的红方输出类型。
