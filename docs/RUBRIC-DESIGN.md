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
not_assessed  未评估（模型没给 / 给了未知值）
```

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
rubric_assessments id, run_id, round_id(null), rubric_id, criterion_id,
                   verdict(yes|no|not_assessed), evidence, created_at
```

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
   没有 critic 的阶段隐藏中间 tab
2. 每个 tab 是可编辑清单：criterion 文本 + `blocking` 开关 + 增删改排序
3. **编辑入口显式可见，不藏进「高级详情」**
   —— 这一轮已经栽过两次「后端能做但 UI 藏起来」（`retry_spec` 无按钮、git 面板在 4.7 屏之下）
4. 跑完后同区域按 tab 显示本次判定：`✓ 是` / `✗ 否` / `— 未评估`
5. **`not_assessed` 视觉上必须和 `no` 一样刺眼** —— 它同样阻断
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
- 完整 `pnpm test` + `tsc --noEmit` + `pnpm lint`
- 新增生产 DB 写 → 登记 `db-write-policy.json` + 重算快照
- **真浏览器验证，不是只有测试绿**
