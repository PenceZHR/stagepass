# Rubric：给 Spec 对抗的每一方一份可编辑的是/否清单

状态：**设计已定，待实现**。用户 2026-07-20 拍板，授权按推荐方案先做一版。

---

## 1. 为什么是这个形状

**这套机制在仓库里已经跑通了，只是只用在一处。** `server/templates/prompts/review.md`
要求对每条 prior finding 输出恰好一行 `PRIOR`，并且：

> 缺失的 verdict 记为 `not_rechecked` 并保持旧阻断项打开；未知 verdict 使整份 Review 输出作废。

这就是 rubric 的骨架 —— **枚举清单 + 每项必须显式判定 + 漏掉 fail-closed**。
Rubric 是把它从"上一轮 finding 这个动态清单"推广到"固定的评判标准清单"。
**不是发明新范式，是复用一个已被生产验证过的机制。**

## 2. 用户拍板的四条（不可推翻）

1. **用户可编辑**：rubric 在页面上显式可改，不是代码里的常量。
2. **每轮对抗，正方（红）与反方（蓝）各有自己的 rubric。** 不是一份通用清单。
3. **另有一份 verdict rubric**：由 agent 依据正反方各自的产出来判定。
4. **判定必须是「是 / 否」，不要打分。**
   原话：「否则 AI 打分会出幻觉，用大量的 yes or no 来规范模型」。
   与仓库现状一致 —— 现有判定全是枚举 verdict，**没有一处让模型给分数**。

## 3. 主控已决（用户授权按推荐先做）

### 3.1 落点：Spec 对抗（`spec` / `spec_critic`），不是 Review

"每一轮对抗完"指的是 Spec 回合战场。Review 阶段可作为后续推广目标，本版不动。

### 3.2 判定取值：三态，不是二态

```
yes          满足
no           不满足
not_assessed 未评估（模型没给 / 给了未知值）
```

**用户要的是"是或否"，`not_assessed` 不是第三个答案，而是"模型没回答"的记账。**
它必须存在，否则漏答会被静默当成通过 —— 那正是 `not_rechecked` 在防的事。

### 3.3 fail-closed 规则（照抄 review.md 已验证的那套）

- 每条 criterion **必须恰好一行**输出
- **缺失 → 记为 `not_assessed`，视同阻断**
- **未知 criterion id → 整份输出作废**（与"未知 verdict 使整份 Review 输出作废"一致）

### 3.4 `no` 进不进 gate

- criterion 标记 `blocking: true` 且判定为 `no` → **生成一条真的 requirement gap**，走现有 severity 通道
- `blocking: false` 的 `no` → 只记录，不阻断
- 任何 `not_assessed` → **视同阻断**（与 `not_rechecked` 一致）

**理由**：不新建一条平行的阻断机制。gate 已经会数 open P0/P1，rubric 只负责把
"模型没想到去看"的东西变成它数得着的东西。

### 3.5 可编辑 vs 哈希（**最容易翻车的一点**）

**rubric 正文绝不进 `sourceDbHash`。** 只有 `rubricVersionId` 和**判定结果**进。

这个项目踩过完全同类的坑：给 `briefing_questions` 加一列会让所有已盖章的 PRD gate
变 `prd_gate_stale`、卡死正在跑的 Spec Battle，最后是用 `prdStageHashQuestionRows`
投影把新字段排除在哈希外解决的（见 `204f3f5`）。

**规则**：
- rubric 编辑产生**新版本行**，不原地改旧行
- 每个 round 记录它当时用的 `rubricVersionId`
- 编辑 rubric **不使任何已完成的 round 或已盖章的 gate 失效**
- 实现后**必须在生产库副本上实测**：编辑一次 rubric，确认 `0ab2ffe4…` 这类已存
  gate 摘要不变（手法见 `docs/`／交接文档里的 probe 配方）

## 4. 数据模型（建议，实现者可调整但要说明理由）

```
rubrics                 id, change_id(null=项目级), side(red|blue|verdict),
                        version, created_at, is_current
rubric_criteria         id, rubric_id, ordinal, text, blocking(bool)
rubric_assessments      id, round_id, rubric_id, criterion_id,
                        verdict(yes|no|not_assessed), evidence, created_at
```

- `side=verdict` 那份由 agent 在红蓝都产出之后跑，输入是双方的产出
- 三份 rubric 各自独立版本化

## 5. 输出契约（照现有行协议，**AI 绝不亲手写 JSON**）

项目有成文规则：模型不手写 JSON，走 `outputSchema` 结构化输出 + schema 校验 + raw capture。
rubric 判定照 `PRIOR` 行的样子：

```
RUBRIC <criterionId> yes|no <evidence>
```

- 每条 criterion 恰好一行
- 缺失 → `not_assessed`
- 未知 id → 整份输出作废

## 6. UI（Spec 回合战场页）

1. **战场面板内新增「评判标准」区**，三个 tab：正方 / 反方 / 裁决
2. 每个 tab 是一个可编辑清单：criterion 文本 + `blocking` 开关 + 增删改排序
3. **编辑入口显式可见**，不藏在「高级详情」里
   —— 这一轮已经栽过两次"后端能做但 UI 藏起来"（`retry_spec` 无按钮、git 面板在 4.7 屏之下）
4. 回合跑完后，同一区域按 tab 显示本轮判定：
   `✓ 是` / `✗ 否` / `— 未评估`，`否` 与 `未评估` 高亮，并显示 evidence
5. **`not_assessed` 必须视觉上和 `no` 一样刺眼** —— 它同样阻断
6. rubric 被编辑过而本轮判定来自旧版本时，**必须显式标注**（沿用 `reportFresh` / 战报过期那套语言）

## 7. 实现顺序（分批，每批独立可验证）

1. 数据模型 + migration + 版本化写入（**先在有数据的生产库副本上验迁移**）
2. 输出契约（行协议 + schema + fail-closed 解析）
3. 红/蓝 rubric 接入 Spec 对抗，判定落库
4. verdict rubric（读红蓝产出后判定）
5. UI：编辑 + 本轮判定展示
6. `no`/`not_assessed` 接进 gate 的 requirement gap 通道

## 8. 每批都要满足

- **双向变异验证**：还原方向转红；**过度放宽方向**（漏答被当成通过、未知 id 被忽略、
  `no` 不阻断）**也必须转红**
- 改/删任何既有断言，逐条说明「原本钉住什么、为什么那个行为是错的」
- 完整 `pnpm test` + `tsc --noEmit` + `pnpm lint`
- 新增生产 DB 写 → 登记 `db-write-policy.json` + 重算快照
- **真浏览器验证**，不是只有测试绿
