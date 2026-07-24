# PRD Briefing 追问：粒度重锚与收敛出口

日期：2026-07-22
状态：待实现

## 问题

PRD Briefing 的追问阶段产出的疑点卡粒度过细，问的是实现层问题（数据结构、接口、边界值），
而 PRD 阶段应当只问方向性问题——人类需要拍板"要不要做、给谁做、做到什么算成功"的问题。

且追问没有终点：每轮最多 7 张卡，轮次无上限，模型永远无法声明"已经问清楚了"。

## 根因

### 1. 优先级锚点挂在下游阶段

`server/templates/prompts/prd-briefing-questions.md` 中四处把"重要"定义为"对 Spec 有用"：

| 行 | 原文 | 效果 |
|---|---|---|
| :15 | `优先输出会影响 Spec Battle 的关键问题` | 优先级直接锚在详细设计阶段 |
| :51 | `important 用于不回答会导致 Spec 阶段高概率返工的问题` | 严重度阶梯按 Spec 返工标定 |
| :22 | `请在用户的回答之上继续深挖，问下一层还没被回答清楚的问题` | 每轮被明令下钻一层 |
| :35 | 类别含 `negative_case` / `constraint` / `spec_blocker` | 细节类别是一等公民 |

Spec 是详细设计阶段。锚在那里，"重要"的定义天然就是实现细节。

### 2. 模型被结构性禁止收敛

`至少输出 1 行 QUESTION` 这条规则有两份拷贝：
- 提示词 `prd-briefing-questions.md:47`
- 解析器 `server/services/prd-briefing-line-protocol.ts:105`

方向性问题是有限的——一个 change 级 PRD 大约 5～10 个，两轮问完。但系统强制每轮产出 ≥1 个
问题。方向的井枯了，唯一取之不尽的井就是细节。**粒度下滑不是模型的缺陷，是这套提示词结构的必然产物。**

### 3. 阶段粒度契约从未被定义

`docs/` 全部文档中没有任何一处规定 PRD 阶段该问到多粗。
`docs/project-codebase-overview.md:337` 只描述机制，不含粒度契约。
边界从未被规定，提示词自然锚到了它唯一能看见的下游目标。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 重要性锚点改为**人类的裁决权** | 判据：不回答，PRD 方向会不会错、人类还能不能拍板 |
| 2 | 细节问题**丢弃**，不传递给 Spec | Spec Battle 有独立质询机制，同一个坑它会自己挖出来 |
| 3 | 每轮上限 7 → **10**，**期望值而非硬上限** | 方向性问题应一次铺开，而非挤牙膏 |
| 3b | 模型超出 10 张时**全部保留**，不截断、不驳回 | 见「明确不做」——多出来的方向性疑点是有价值的，砍掉它才是损失 |
| 4 | 疑点卡改为**一行一张** | 10 张有优先级之分的卡，双栏会打乱阅读顺序 |
| 5 | 允许收敛：**首轮 ≥1，次轮起可为 0** | 决策 1 的直接后果——方向问完后 min-1 会逼模型编细节 |
| 6 | 收敛后"追问"按钮**保持可点** | 改了 intent 之后本就应能再追一轮；收敛不是终态 |
| 7 | 类别枚举建**单一事实源** | 当前有 6 份拷贝，本次要改其中 5 份 |

## 三颗雷：为什么"0 张卡"不能直接放行

系统把**卡片**当作"追问发生过"的唯一证据，收敛这件事没有载体。因此让某轮产出 0 卡会同时触发：

| # | 雷 | 位置 | 触发后果 |
|---|---|---|---|
| 1 | 首轮 0 卡 → 草稿门永久焊死 | `prd-briefing-service.ts:383` `assertQuestionsGenerated` | 用户再也进不了 PRD 草稿 |
| 2 | 0 卡 → 被报成故障 | `prd-briefing-room.tsx:113` `jobMarker` | 弹出"产物没有更新，请重试" |
| 3 | 0 卡那轮不存在 | `prd-briefing-service.ts:231` 轮次从卡片反推 | 无处记录"已收敛" |

三颗雷的拆法分别是：首轮强制出卡（雷 1）、marker 增加收敛分量（雷 2）、收敛走 `stage_progress`
事件而非持久化状态（雷 3 不需要解）。**零 schema 改动，零 migration，不动 `db-write-policy.json`。**

## 数量：为什么 10 是期望值而不是硬上限

本次讨论中一度考虑过硬截断，最终否决。留档以免后人重新走一遍：

**方向性问题不是噪音。** 模型若真提出第 11 个影响 PRD 方向的疑点，那张卡的价值和前 10 张同级——砍掉它是损失，不是收益。「细节太多」由锚点重写（第 1 节）解决，不该用数量刀去砍。

**而且 schema 层面本来也拦不住。** 两个引擎的强制力根本不同：

| 引擎 | 实现 | `schemaDelivery` 常量 | 强度 |
|---|---|---|---|
| Codex | `--output-schema <file>`（`codex-cli-engine.ts:194`） | `provider_native` | CLI 层强制 |
| Claude | `--append-system-prompt "You MUST respond with valid JSON…"`（`claude-engine.ts:208`） | `schema_prompt` | **就是一句提示词** |

这两个常量名如实记录了该差异，而 provider 在 UI 上可切换。更关键的是 Anthropic 结构化输出的官方限制清单里**「复杂数组约束」在不支持一栏**——`maxItems` 会被 SDK 从 schema 剥离、改为客户端校验。即：数量约束从来不在结构化输出的管辖范围内，它管形状不管规模。

（Claude Code CLI 另有未被本 repo 使用的 `--json-schema` 参数，属独立的引擎能力议题，与数量无关，已另立任务跟踪。）

## 设计

### 第 1 节：提示词重锚

文件：`server/templates/prompts/prd-briefing-questions.md`

**① 优先级锚点（:15）**

```
现在：请发现 PRD 前期需求漏洞，最多输出 7 张疑点卡。优先输出会影响 Spec Battle 的关键问题。
改为：最多输出 10 张疑点卡。只提出「不回答就无法裁决 PRD 方向」的问题。
```

补一段可执行判据（形容词管不住粒度，判据才行）：

> 提问前先自检：如果人类不回答这个问题，PRD 的**方向**会不会错？
> - 会错 → 提。
> - 方向已定，只是还没展开成实现细节 → **不提**，那是 Spec Battle 的职责。
>
> 反例（一律不问）：用什么数据结构、接口怎么设计、边界值怎么处理、并发怎么办、失败了怎么回滚。
> 这些不影响人类判断"要不要做、给谁做、做到什么算成功"。

**② 深挖指令（:22）——纵向改横向**

```
现在：请在用户的回答之上继续深挖，问下一层还没被回答清楚的问题。
改为：在用户已确认的方向之外，检查还有哪些方向性维度尚未覆盖。
      不要就同一个方向追问下一层实现细节——那属于 Spec 阶段。
```

**③ 类别裁剪（:35）** — 八个砍到四个：

保留 `goal` / `user` / `scope` / `success`。
删除 `negative_case` / `constraint` / `spec_blocker` / `risk`。

前三个天然是实现层；`risk` 虽有方向性风险的正当用法，但最易滑向实现风险，一并砍掉以免留口子。

**④ 严重度重定义（:50-52）** — 切断与 Spec 的绑定：

| | 现在 | 改为 |
|---|---|---|
| critical | 方向错或核心验收无法判断 | 不回答，PRD 方向可能整个错，人类无法裁决 |
| important | **Spec 阶段高概率返工** | 不回答，PRD 的范围或成功标准会含糊 |
| optional | 不阻断 PRD 锁定 | 澄清了更好，但不影响方向裁决 |

### 第 2 节：收敛出口

**新增协议关键字 `NO_NEW_QUESTIONS: true`**

不用"0 行 QUESTION"隐式表示收敛。理由见 `prd-line-protocol.ts:328` 已记录的同类教训：
`PRD_DONE` 写在最后，是为了让**截断的回复必然失败**而不是被当成完整产物。

同理：一个刚要写 QUESTION 就被截断的回复，与一个真正无话可问的回复，在"0 行 QUESTION"这个
观测上完全一样。没有显式标记，系统分不出"想通了"和"网断了"，而后者会被静默当成收敛、吞掉一整轮追问。

**解析器**（`prd-briefing-line-protocol.ts:105`）从"至少 1 个"改为三态判定：

| 问题数 | 标记 | 结果 |
|---|---|---|
| 0 | 有 `NO_NEW_QUESTIONS: true` | ✅ 收敛 |
| 0 | 无 | ❌ 驳回——截断或跑偏 |
| ≥1 | 有 | ❌ 驳回——自相矛盾 |
| ≥1 | 无 | ✅ 正常一轮 |

**服务层门禁**（`prd-briefing-service.ts:729` `completeQuestionGeneration`）：

首轮不许收敛。若 `nextQuestionRoundNo === 1` 且收到收敛标记，该轮按
**invalid_output 失败**处理——与现有其他协议驳回走同一条路径（写 `stage_progress`
失败态，前端 `runFailed` 显示错误，用户可自行再点"追问"）。**不自动重试**：
自动重试会把"模型判断首轮无方向性疑点"这个值得人看见的信号静默吃掉。

这条专拆雷 1：首轮强制出卡后 `getQuestions()` 永远非空，草稿门再也锁不上。

**分工**：解析器只判语法（标记在不在、与问题数矛不矛盾），服务层判业务规则（第几轮能否收敛）。
解析器保持纯函数便于测试；轮次是数据库状态，本就属于服务层。

**提示词侧同步改**（那两份拷贝的另一份）：

```
现在：- 至少输出 1 行 QUESTION。
改为：- 若发现新的方向性疑点：输出 1～10 行 QUESTION，不要输出 NO_NEW_QUESTIONS。
      - 若确实没有：只输出一行 NO_NEW_QUESTIONS: true，不要输出任何 QUESTION。
        无话可问是正当结论，不要为了凑数而降低粒度去问实现细节。
```

最后一句是有意加的：模型在"必须产出点什么"的压力下，最省力的出路永远是往细里问。
把"可以什么都不问"写成正当选项，才真正拆掉逼它编的压力。

### 第 3 节：UI

**① 轮询完成判定**（`prd-briefing-room.tsx:111` `jobMarker`）

保留卡片 marker，**增加收敛分量**：

```
questions marker = 卡片集合(现有) + 收敛分量
收敛分量 = stageProgress.phase === "prd_briefing_questions" && status === "completed"
           ? `${runId}:${status}` : ""
```

- 正常轮：卡片集合变化 → 结束
- 收敛轮：卡片不变但 runId 是新的 → marker 变化 → 正常结束
- 运行中：`status !== "completed"`，两分量都不动 → 继续轮询

必须卡 `status === "completed"`：`stage_progress` 在运行途中也会发
（`pipeline-prd-briefing-stage-service.ts:494`），只认 runId 会让轮询提前收工。

**② 一行一卡**（`prd-briefing-room.tsx:690`）

```
现在：<div className="grid gap-3 p-3 pt-0 xl:grid-cols-2">
改为：<div className="space-y-3 p-3 pt-0">
```

**③ 收敛提示**

复用既有通道：收敛时服务层往 `stage_progress` 写 message
"本轮未发现新的方向性疑点，可以进入 PRD 草稿"。
前端 `stageProgressNotice`（`prd-briefing-room.tsx:129`）已在渲染它，`completed` 走绿色调。
**前端此项零改动。**

收敛轮不产卡，故不会出现"第 N 轮（0 张）"的空折叠块；轮次分组天然跳过。
按钮保持可点（决策 6）。

### 第 4 节：类别枚举单一事实源

当前 `category` 枚举有 6 份代码拷贝 + 1 份文档：

| # | 位置 | 角色 | 漏改后果 |
|---|---|---|---|
| 1 | `prd-briefing-questions.md:35` | 告诉模型 | **改动彻底失效** |
| 2 | `prd-briefing-line-protocol.ts:35` `QUESTION_CATEGORIES` | 解析器判定 | 旧类别仍被接受 |
| 3 | `prd-briefing-line-protocol.ts:75` | **错误消息里另一份硬编码** | 报错列出系统不收的类别 |
| 4 | `prd-briefing-ledger.ts:5` zod enum | 落库校验 | 同 #2 |
| 5 | `pipeline-prd-briefing-stage-service.ts:176` JSON schema | provider 约束 | 同 #2 |
| 6 | `prd-briefing-prompt.test.ts:24` | 测试断言 | 测试红（这个是好的） |
| — | `docs/prd.md:1372` | 文档 | 文档过时 |

第 3 处最危险：它与第 2 处是两份各自独立的字面量，本就能漂移，且无任何测试会发现。

**改法**：在 `prd-briefing-ledger.ts` 定义 `BRIEFING_QUESTION_CATEGORIES` 常量数组，其余全部派生——
zod `z.enum(...)`、解析器 `new Set(...)`、错误消息 `.join("/")`、JSON schema 展开。6 处塌缩成 1 处。

提示词是 `.md`，无法 import，必然是第二份拷贝——用测试锁住：
测试断言从常量派生，而非像现在这样硬编码字面量。将来改枚举忘同步提示词，测试立刻红。

### 第 5 节：测试策略

| 层 | 文件 | 关键用例 |
|---|---|---|
| 提示词 | `prd-briefing-prompt.test.ts` | :24 断言改为从常量派生；含 `NO_NEW_QUESTIONS` 说明；**反向断言**不含 `优先输出会影响 Spec Battle` / `Spec 阶段高概率返工` / 被砍的四个类别 |
| 解析器 | `prd-briefing-line-protocol.test.ts` | 四态全覆盖；错误消息列出的类别 === 常量 |
| 服务层 | `prd-briefing-service.test.ts` | 首轮收敛→驳回；次轮收敛→接受且不写卡；**次轮收敛后 `assertCanStartPrdBriefingDraft` 仍通过** |
| 一致性 | `prd-briefing-ledger.test.ts` | zod enum / 解析器 Set / JSON schema 三者 === 常量 |
| UI | `prd-briefing-room.test.ts` | 导出 `jobMarker` 单测：0 卡 + 新 runId → marker 变化；渲染断言卡片容器单列 |

那组**反向断言**是主要防线：正向断言只能证明新词句在，证明不了旧锚点已拔除，
而本次改动的全部价值正在于旧锚点必须消失。

**验证方式**：`pnpm test <文件>`（走 `scripts/run-tests-isolated.ts` 隔离库）。
看 `ℹ fail` / `ℹ cancelled` 计数而非 exit code——全量跑会 exit 0 但藏着失败。
本次只改既有测试文件、不新增写库测试，`db-write-policy.json` 无需变更。

## 改动面清单

| 文件 | 改动 |
|---|---|
| `server/templates/prompts/prd-briefing-questions.md` | 锚点、判据、深挖指令、类别、严重度、收敛出口 |
| `server/services/prd-briefing-ledger.ts` | 新增 `BRIEFING_QUESTION_CATEGORIES` 常量；zod 派生 |
| `server/services/prd-briefing-line-protocol.ts` | 类别 Set 与错误消息派生；min-1 改三态判定 |
| `server/services/prd-briefing-service.ts` | 首轮收敛门禁；收敛写 `stage_progress` message |
| `server/services/pipeline-prd-briefing-stage-service.ts` | JSON schema enum 派生 |
| `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx` | `jobMarker` 收敛分量 + 导出；卡片容器改单列 |
| 上表 5 个测试文件 | 见第 5 节 |
| `docs/prd.md:1372` | 同步类别枚举 |

零 schema、零 migration、零 `db-write-policy.json` 变更。

## 明确不做

- **不设轮次硬上限**。锚点改对后量会自然收敛；硬封顶是治症状，且会误伤真正需要第四轮方向澄清的复杂 change。
- **不持久化收敛状态**。收敛不是终态——改了 intent 就该能再追（决策 6）。不持久化反而是正确的。
- **不给细节问题建传递通道**（决策 2）。
- **不做数量截断，不设数量硬校验**。10 是写给模型的期望值；模型给多少就存多少。理由见「数量：为什么 10 是期望值而不是硬上限」。
- **不改引擎层的 schema 投递方式**。本次不引入 `maxItems`，也不把 `claude-engine` 换到 `--json-schema`——前者管不了数量，后者是独立议题。
- **不把 line-protocol 阶段改成 JSON 输出**。line protocol 的存在就是为了让模型无法编写结构（见 `prd-service.ts:220-237`、`pipeline-prd-briefing-stage-service.ts:380-383` 的注释）；换成填 JSON 会把字段名重新交回模型手里，是倒退。
- **不改 Spec Battle**。本次只动 PRD Briefing 边界。
