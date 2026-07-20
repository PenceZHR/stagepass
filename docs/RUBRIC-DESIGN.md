# Rubric：给全流程每个阶段一份可编辑的是/否评判标准

状态：**设计已定，待实现。** 用户 2026-07-20 拍板并授权全部按推荐执行，不需要再裁决。
**执行前提：之前那批修复（batch-ui / prd / schema / gate）必须先正式测试验收并合并。**

---

## 1. 为什么是这个形状

**这套机制在仓库里已经跑通，只是只用在一处。** `server/templates/prompts/review.md`
要求对每条 prior finding 输出恰好一行 `PRIOR`，并且：

> 缺失的 verdict 记为 `not_rechecked` 并保持旧阻断项打开；未知 verdict 使整份 Review 输出作废。

这就是 rubric 的骨架 —— **枚举清单 + 每项必须显式判定 + 漏掉 fail-closed**。
引入 rubric 是把它从"上一轮 finding 这个动态清单"推广到"每个阶段的固定评判标准"。
**不是发明新范式，是复用一个已被生产验证过的机制。**

## 2. 用户拍板（不可推翻）

1. **全流程都要**，不是只有 Spec 对抗。
2. **用户可编辑**：rubric 在页面上显式可改，不是代码里的常量。
3. **每一轮对抗完，正方与反方各有自己的 rubric**；**另有一份 verdict rubric**，
   由 agent 依据正反方各自的产出来判定。
4. **判定必须是「是 / 否」，不要打分。**
   原话：「否则 AI 打分会出幻觉，用大量的 yes or no 来规范模型」。
   与仓库现状一致 —— 现有判定全是枚举 verdict，**没有一处让模型给分数**。

## 3. 把「正方/反方/裁决」推广到全流程

用户的模型来自 Spec 对抗，但**整条流水线本来就是producer/critic 结构**，只是大部分
阶段的 critic 是隐式的。所以三份 rubric 是通用的：

| rubric | 谁来答 | 作用 |
|---|---|---|
| `producer` | 产出该阶段产物的 agent | 交付前自证：我是否满足了这些条件 |
| `critic` | 审查方（有则用，无则空） | 独立复核：产物是否满足这些条件 |
| `verdict` | 裁决 agent，输入是 producer + critic 的产出 | 决定 gate 能不能过 |

**各阶段的 producer / critic 映射**（实现者需按代码复核，此表为设计意图）：

| 阶段 | producer | critic | 备注 |
|---|---|---|---|
| Refine | refine | — | |
| PRD | prd / briefing | briefing final review | 已有 final review 环节 |
| **Spec** | **红方 `spec`** | **蓝方 `spec_critic`** | 唯一显式对抗，用户原话所指 |
| Tech Spec | tech_spec | — | |
| Plan | generate_plan | — | 已有 plan risks |
| Test Plan | test_plan | — | |
| Build | implement | **review** | Review 就是 Build 的 critic |
| Fix | fix_findings | **review**（复跑） | 同上 |
| QA | local_check | — | 判定偏确定性 |
| Merge | — | merge readiness | 已是确定性检查 |
| Retro | retro | — | |

**没有 critic 的阶段，`verdict` 只读 producer 产出。** 结构不变，少一路输入而已。

## 4. 主控已决（用户授权，无需再问）

### 4.1 判定取值：三态

```
yes           满足
no            不满足
not_assessed  未评估（模型漏答）
```

**未知 verdict 值 → 作废整份输出，不是记 `not_assessed`。**（第 1 批实现时修正：
原文这里与 §1/§4.2「照抄 review.md」自相矛盾，review.md 是未知 verdict 作废整份输出。
作废可重试 —— 模型有机会改错字；`not_assessed` 是永久记账。两者都 fail-closed，
但作废更保守，且不会被误读成一次真实判定。**模型也不许自己写 `not_assessed`**。）

**用户要的是「是或否」；`not_assessed` 不是第三个答案，而是「模型没回答」的记账。**
它必须存在，否则漏答会被静默当成通过 —— 那正是 `not_rechecked` 在防的事。

### 4.2 fail-closed 规则（照抄 review.md 已验证的那套）

- 每条 criterion **必须恰好一行**输出
- **缺失 → 记为 `not_assessed`，视同阻断**
- **未知 criterion id → 整份输出作废**

### 4.3 `no` 怎么进 gate

- criterion 标 `blocking: true` 且判定 `no` → **生成一条该阶段既有形态的阻断项**
  （Spec → requirement gap；Build/Fix → review finding；文档阶段 → stage gate blocker）
- `blocking: false` 的 `no` → 只记录，不阻断
- 任何 `not_assessed` → **视同阻断**

**理由：不新建平行的阻断机制。** gate 已经会数 open P0/P1，rubric 只负责把
"模型没想到去看"的东西变成它数得着的东西。

### 4.4 可编辑 vs 哈希（**最容易翻车的一点**）

**rubric 正文绝不进 `sourceDbHash`。** 只有 `rubricVersionId` 和**判定结果**进。

这个项目踩过完全同类的坑：给 `briefing_questions` 加一列会让所有已盖章的 PRD gate
变 `prd_gate_stale`、卡死正在跑的 Spec Battle，最后用 `prdStageHashQuestionRows`
投影把新字段排除在哈希外解决（见 `204f3f5`）。

**规则：**
- 编辑 rubric 产生**新版本行**，不原地改旧行
- 每次 run / round 记录它当时用的 `rubricVersionId`
- 编辑 rubric **不使任何已完成的 run 或已盖章的 gate 失效**
- 实现后**必须在生产库副本上实测**：编辑一次 rubric，确认已存 gate 摘要不变

### 4.5 作用域

- **项目级 rubric 为默认**，change 级可覆盖
- 出厂自带一套默认 criteria（每阶段 5–12 条），用户可增删改
- 空 rubric 合法：等于该阶段不做 rubric 判定，行为退回现状

## 5. 数据模型（建议，实现者可调整但要说明理由）

```
rubrics            id, project_id, change_id(null=项目级默认), phase,
                   role(producer|critic|verdict), version, is_current,
                   created_at
rubric_criteria    id, rubric_id, ordinal, text, blocking(bool)
rubric_assessments id, change_id, run_id, round_id(null), rubric_id,
                   criterion_id, verdict(yes|no|not_assessed), evidence, created_at
```

**第 1 批实现时的两处修正（原设计有真实缺陷）：**

1. **`rubric_assessments` 必须有 `change_id`。** 否则针对「项目级 rubric」做出的判定，
   在删 change 时找不到 —— 它唯一的另一条链路 `rubric_id` 指向一个比 change 活得更久的
   对象，`run_id` 又不能加外键（各阶段的 run 分散在 `runs`/`stage_runs`/`battle_rounds`）。
2. **「每个 scope 只有一行 current」必须用两个部分唯一索引**（`change_id IS NOT NULL`
   与 `IS NULL` 各一），不能用单个。**SQLite 唯一索引里 NULL 互不相等**，单索引会让
   所有项目级 rubric 版本同时是 current —— 而且是静默失效。version 唯一性同理。
3. 顺带：`rubrics.project_id` 引用 `projects.id`，项目级 rubric 不属于任何 change，
   `deleteChangeRecords` 够不到它。**必须补 `PROJECT_RUBRIC_DELETE_PLAN`**，否则任何
   建过 rubric 的项目从此再也删不掉，且没有既有测试会发现（只有 change 删除计划有
   schema 推导的守卫，项目删除没有）。

### 5.1 criterion 必须有跨版本稳定身份（**第 3 批发现，第 5 批之前必须堵死**）

现状：`saveRubricVersion` 对每条 criterion 无条件生成新的 `RBC-<uuid>`，**哪怕正文
一个字没改**。这在第 5 批会造成**无出口的死锁**：

§4.3 要求 `blocking:true` 的 `no` 生成 requirement gap。若 gap id 从 criterion id 派生，
则**任何一次 rubric 编辑都会让所有已开的 rubric 派生 gap 变成孤儿** —— 蓝方复核不到
（它只认识自己报过的 gap），人类也解不掉（`human_cannot_resolve_gap` 明文禁止），
只有 P1 能 waive。**一条被编辑孤立的 P0 rubric gap 会永久卡死 Spec gate，没有任何出口。**

这正是本会话反复在治的那类病（死路 + 没有出口），不能再造一个。

**要求：**
- `rubric_criteria` 补 `criterion_key`（跨版本稳定）
- **「正文未变则沿用」这条按字面实现是不够的**（第 4 批实测）：只按正文匹配的话，
  改一次错别字仍会孤立已开的 gap，病一样只是触发条件变窄。**编辑器回传 key 必须是
  第一优先级规则，文本匹配只做后备**；且不属于本 scope 的 key 一律不信任 —— 信了
  就等于允许一个请求把新 criterion 绑到已开的 gap 上
- rubric 派生的 gap id **必须绑在 `criterion_key` 上**，不是版本内的行 id
- **criterion 正文必须快照进 gap，永不回溯派生** —— 否则改一次措辞就会移动
  `specSourceDbHash`，§4.3 与 §4.4 在这个边界上是冲突的

### 5.2 判定必须按 `roundId` 读，不能按 `runId` 读（第 3 批发现）

蓝方续跑（`resumeBlue`）那一轮不重跑红方，所以本次新 `runId` 下没有 producer 判定行，
旧行还在、带着**同一个 `roundId`**。按 `runId` 读会看到「producer 无判定」并读成
「没有 rubric」= 通过 —— **正是这套机制要防的失效**。第 4/5 批切记。

## 6. 输出契约（**AI 绝不亲手写 JSON** —— 项目成文规则）

走 `outputSchema` 结构化输出 + schema 校验 + raw capture，判定照 `PRIOR` 行的样子：

```
RUBRIC <criterionId> yes|no <evidence>
```

- 每条 criterion 恰好一行
- 缺失 → `not_assessed`
- 未知 id → 整份输出作废

## 7. UI

1. **rubric 编辑器**：每个阶段面板都有入口，三个 tab（正方 / 反方 / 裁决），
   没有 critic 的阶段隐藏中间 tab。
   **注意 §3 的阶段表与 UI 的 `ReviewPhase` 对不上**：UI 有 13 个阶段面板，而 §3 里
   `Review` 根本不是一个 phase（它是 Build 的 critic）。照 §3 直译会让 Review 阶段
   没有抽屉 —— 而它恰恰是产出 critic 判定的那个界面。**`Review` 面板映射到 `Build`
   rubric，且抽屉标题必须写明当前编辑的是哪个 phase**，避免误编辑。
2. 每个 tab 是可编辑清单：criterion 文本 + `blocking` 开关 + 增删改排序
3. **编辑入口显式可见，不藏进「高级详情」**
   —— 这一轮已经栽过两次「后端能做但 UI 藏起来」（`retry_spec` 无按钮、git 面板在 4.7 屏之下）
4. 跑完后同区域按 tab 显示本次判定：`✓ 是` / `✗ 否` / `— 未评估`
   **「同区域」不等于「看得见」**：第 4 批实测，放在 children 之后时 Plan 阶段会被顶到
   ~3900px，正是本会话批评过的「git 面板在 4.7 屏之下」。**必须在 stage header 之后、
   主内容之前**，并用断言钉住相对位置。
5. **`not_assessed` 视觉上必须和 `no` 一样刺眼** —— 它同样阻断。
   与上一条的 `—` 字形是互相拉扯的（破折号在任何视觉体系里都读作「这里没东西」）。
   调和办法：**字形照旧，色彩/边框/阻断标签与 `no` 共用同一常量**，并把「两者 class
   逐字相等」写成断言，而不是"碰巧现在长得像"。
6. 判定来自旧版本 rubric 时**显式标注**（沿用 `reportFresh` / 战报过期那套语言）
7. 项目级默认与 change 级覆盖要能一眼看出当前用的是哪个

## 8. 实现顺序（每批独立可验证，**逐批合并**，不要攒大爆炸）

1. **数据模型 + migration + 版本化写入**（先在有数据的生产库副本上验迁移）
2. **通用机制**：行协议 + schema + fail-closed 解析 + 判定落库（**与阶段无关**）
3. **Spec 对抗接入**（红/蓝/裁决三份全齐，是用户原话所指、也是最复杂的形态，
   打通它等于验证了通用机制）
4. **UI**：编辑器 + 判定展示
5. **`no` / `not_assessed` 接进各阶段既有阻断通道**
6. **推广到其余阶段**（按 §3 表，每个阶段一批，带默认 criteria）

## 9. 每批都要满足（无一例外）

- **双向变异验证**：还原方向转红；**过度放宽方向也必须转红**
  （漏答被当成通过、未知 id 被忽略、`no` 不阻断、rubric 正文进了哈希）
- 改/删任何既有断言，逐条说明「原本钉住什么、为什么那个行为是错的」
- **完整全量测试** —— worktree 里用 `npx tsx scripts/run-tests-isolated.ts` 和 `npx eslint`，
  **不要用 `pnpm test` / `pnpm lint`**（见 §10，会删掉 node_modules 软链）
- `npx tsc --noEmit`
- 新增生产 DB 写 → 登记 `db-write-policy.json` + 重算快照
- **真浏览器验证，不是只有测试绿** —— 但**第 1–3 批没有 UI 可点**（UI 是第 4 批），
  这几批用「生产库副本 + 真实服务函数重算」代替：先复现真实盖章的哈希以证明重算函数
  忠实，再证明改动前后哈希不变。第 4 批起才有界面可验。

## 10. worktree 陷阱（实测，别再踩）

**`.npmrc` 里的 `verify-deps-before-run=false` 对 pnpm 不生效。** 第 1 批实测：pnpm 仍会
在 `pnpm test` 前尝试 `pnpm install`，而那会**删掉指向主树的 node_modules 软链**；只因为
无 TTY 才中止（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。有 TTY 的会话里会真删。

**worktree 里一律改用 `npx tsx scripts/run-tests-isolated.ts`**（就是 `pnpm test` 指向的
同一个脚本，只是绕开 pnpm 的前置检查，隔离逻辑与临时库完全一致）。`pnpm lint` 同理，
改用 `npx eslint`。

**等待循环别用 `grep -q "[r]un-tests-isolated"` —— 它会匹配自己。** 外层 `zsh -c` 的
命令行里就含这个字面量，`[r]un` 照样命中，结果死循环。第 3 批实测卡了 15 分钟。
改成匹配不出现在等待命令自身里的串，例如：
`while pgrep -f "tsx scripts/run-tests" >/dev/null; do sleep 20; done`

## 11. 第 3 批发现但未修（推广前建议先处理）

1. **红方 `spec` 阶段仍亲手写 JSON，且失败静默。** `parseRedSpecOutput` 的 catch 直接
   返回 `{prdDeltaMarkdown: raw, fixClaims: []}` —— 无日志无事件无 gate 信号，任何杂质
   都会让**全部 fix claims 人间蒸发**，蓝方下一轮把已修的 gap 当没修。违反「AI 绝不
   亲手写 JSON」全项目规则。**第 6 批推广前建议先把 `spec` 迁到行协议。**
2. **`prd-delta.md` 里存的是 JSON blob 不是 markdown**，而它在 tech_spec 的可读 scope
   里 —— tech_spec agent 读到的「PRD delta」是一坨 JSON。既有问题。
3. **仓库里有两套互不相同的 Spec 哈希定义**（`specSourceDbHash` 含 `war_reports.Spec`，
   `reportSourceDbHash` 含 `findings.Spec`）。第 5 批若让 rubric 派生阻断项进哈希，
   **两边都要改**，否则战报新鲜度会和 gate 判断打架。
