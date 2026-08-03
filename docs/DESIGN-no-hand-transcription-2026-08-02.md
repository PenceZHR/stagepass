# 精确标识符绝不经由模型（2026-08-02）

> 起因是 `HANDOFF-2026-08-02.md` §三·A —— 裁判把一个 UUID 抄漏一段，四条答得整整
> 齐齐的判定一起作废。但那是症状。这份文档写的是病。

## 一、约束

> **凡是 StagePass 会拿去做精确相等匹配的字符串，都不许出现在模型必须生成的文本里。**

这条是机械可判的，不是口号：拿一条数据问「StagePass 会不会拿它去 `===`、或者当
map 的 key」，会，就不许模型生成它。

推论 —— **模型的输出里只允许有两种东西**：

- **枚举里的选择**（`yes`/`no`、`closed`/`still_open`）
- **散文**（依据、理由、结论）

「这是哪一条」的信息**永远由 StagePass 持有**。

### 为什么现有的补救都不够

`relayedTo` 的「原样转达」、`unknown_key` 的作废重试、`turn.ts` 的 JSON 修复层 ——
每一条都在提高手抄的成功率，**没有一条在削减手抄面**。而手抄面只要还在，就还会以
新的方式坏掉：07-31 坏在契约没送到，08-02 坏在 UUID 抄漏一段，下一次会是别的。

### 为什么 UUID 特别糟

`criterion_key` 存在的理由是**改写正文之后仍然活着的那个身份**（`db/schema.ts` 里
那段注释）：gap id 由它拼出来，`gate.snapshotOf` 哈希 blocker id，key 一移位，所有
开着的提问的围栏当场失效 —— 人正在回答到一半的问题会被拒收。对**这个**职责，UUID
满分。

问题是同一个字符串被派了第二份差事：**模型要手抄进答案的口令**。对那个职责它零分
—— 40 个没有意义、没有冗余、没有校验位的字符，要求零错。

实测出来的错法尤其说明问题：它不是打错一个字母，是**把 8-4-4-4-12 压成了
8-4-4-11**。它在重排一个它认得出是 UUID 的结构。**UUID 的分组格式本身就是诱因。**

## 二、盘点：七个面

| # | 数据 | 谁抄、从哪抄 | 长度 | 抄错的后果 | 烧过没有 |
|---|---|---|---|---|---|
| 1 | 子 Agent 线程 id | 裁判，从 `spawn_agent` 返回值 | 36 | **整轮作废**，正反两方的话谁也看不到 | ✅ `02059a8` 报成了自己 |
| 2 | rubric 派生 gap id | 裁判，抄进 **json 的 key** | **50** | 那条标准的表态丢失 | ✅ 交接 §五 |
| 3 | criterion key | 裁判/蓝方，抄进围栏 | 40 | **整份判定作废** | ✅ §三·A |
| 4 | 模型自铸 gap id | 红/蓝铸，之后每轮自己复用 | ~16 | 同一问题裂成两条 | 部分（§三·D） |
| 5 | 产出文件路径 | 红方报，蓝方用 | 不定 | 蓝方核验不了正文 | ✅ `f1d8252` |
| 6 | JSON 信封本身 | 三方手写 | — | 整轮作废 | ✅ 漏一个右括号 |
| 7 | `stagepass_ask` 的 questionId | 被叫的那条线程，从提示词抄 | ~20 | 问题递不到人手上 | 未观测 |

实测样本（`domain/round.ts` / `domain/rubric-protocol.ts` 真跑出来的）：

```
RB:critic:RBC-032ccd75-1795-409c-8fd7-2c8268939436   -> 50 字符   ← 当 json key 打出来
RBC-015fb29f-d0cb-49ca-acd8-94bf60d369ea             -> 40 字符   ← 在围栏里打出来
```

### 不在这份文档范围里的三个

- **#4 不是抄写问题**，是**跨轮记忆**问题（模型自铸的 id 要在下一轮复用）。
  归 `HANDOFF-2026-08-02.md` §三·C / §三·D。
- **#5 路径是语义的** —— 文件存不存在自己会说话，抄错会响亮失败。
- **#6 JSON 信封**已经有 `domain/turn.ts` 的修复层在管。

## 三、落点一 · 线程血缘认亲（#1）

### 现状

裁判从 `spawn_agent` 的返回值抄两个 36 字符 UUID 进 json；`readAgents` 精确匹配；
少一个、写错一个、两个一样 —— 全部抛，整轮作废。`judgePrompt` 里为此写了三段话
（记下这两个 id / 最后要填进 `agents` / 少一个写错一个这一轮就作废）。

当年改成「让裁判报」是有理由的：原来靠 `threads.agent_path` 认，而**那一列只有原生
`spawn_agent({task_name})` 会设**，那个工具不是每个会话都有 —— 没有它的会话里每个
阶段的每一轮都跑不了。

### 那个理由现在不成立了

rollout 的 `session_meta` 里带着血缘，而且和 `agent_path` 是两回事：

```json
"id": "019fc1c1-c6fb-7f02-84b1-25479d9365a6",
"parent_thread_id": "019fac13-bc4b-72e2-a20f-89ecd5fff7c4",
"thread_source": "subagent",
"source": { "subagent": { "thread_spawn": { "parent_thread_id": "…", "depth": 1 } } }
```

**CHG-003 那一趟的真数据，100 条线程：**

```
subagent 76 条
  parent_thread_id 有值：76/76      ← 100%
  agent_path       有值： 1/76      ← 当年放弃走库那条路的原因
```

`parent_thread_id` 在 StagePass 实际走的那条 spawn 路径上是 **100%** 设的。

### 改成

`runRound` 在 turn 开始时已经通过 `onThread` 拿到裁判线程 `J` 和时刻 `T0`。turn 跑完
后扫 rollout 目录，取 `session_meta` 同时满足三条的线程：

```
thread_source     == "subagent"
parent_thread_id  == J
timestamp          > T0        ← 必须有时间窗，见下
```

按创建时间排序，**先创建的是红方，后创建的是蓝方**。

- **时间窗不能省**：成功的轮复用裁判线程，所以一条裁判线程会累积多轮的子 Agent。
  实测数据里见过一条裁判线程挂着 7 个子 Agent（≈3.5 轮）。
- **红蓝靠创建顺序分**：依据是裁判被明确要求「一个跑完再派下一个，不要并行」，
  而 UUIDv7 时间有序、文件名也带时间戳 —— 创建顺序是**可读的事实**，不是推测。
- **去重按 thread id，不按文件**：补问会 resume 蓝方线程，产生第二个 rollout 文件。
  实测数据里见过同一个 id 出现两次。

### ⚠ 线程 id 绝不能用前缀匹配

这些 id 是 **UUIDv7，时间有序的** —— 前 8 位是时间戳，不是随机数：

```
019fc396 → 019fc39f, 019fc3a2, 019fc3a5, 019fc3a8, 019fc3a9, 019fc3ac, 019fc3ad
```

隔几秒生成的两条线程前缀就撞。`criterion_key` 那边用的是 `randomUUID()`（v4，真
随机），两者不能混为一谈。**这条写在这里是为了挡住下一个人的「顺手优化」。**

### 净拆掉的东西

- `readAgents` 整个函数、`UnreadableAgentsError`
- `judge_reported_itself` 守卫（`work/round-runner.ts`）—— 裁判自己那条线程
  `thread_source` 是 `user`，**结构上不可能**被认成子 Agent
- `judgePrompt` 里教它记 id / 报 id / 警告报错作废的三段话
- `RoundAgents` 从「裁判报的」变成「StagePass 认的」，形状不变

### 一处判断：派了超过两个怎么办

会发生的原因有两种：裁判重派（第一次子 Agent 失败了再来一个），或者它违反指令并行
派了。

**取最后两条，并把「这一轮实际派了 N 个子 Agent」记进这一轮的账让人看见。**

理由：抛出去会制造真实的行为回归 —— 今天裁判重派一次、报最后两个，那一轮是成功
的。但这确实是在猜哪次派发算数，所以 N>2 这个事实必须对人可见，不能静默。

找到 0 条或 1 条 → 抛，等价于今天「少一个就作废」。

## 四、落点二 · 结构化提交通道（#2 / #3 / #7）

### 载体是现成的

`src/plugin/` 是一个注册进 Codex 的 MCP server，走 stdio，读同一个 SQLite，
**已经跑通过真实调用**。它现在的哲学正是我们要的：

> 它只收一个 question id，别的什么都不收。它不能拟一个问题、不能选一个选项、不能
> 决定一个答案是什么意思 —— 每一个判断都留在 StagePass 那一侧。

要做的只是把**最后那个 id 也收回来**。

### 形状

```
库里：一次「提交会话」 = (change, phase, round, role) + 游标 + 状态
                          ↑ StagePass 开、StagePass 推进、StagePass 关

stagepass_next()                                      → 「第 3 条（共 4 条）：<正文>」
                                                         幂等，不推进
stagepass_answer({verdict: "yes"|"no", evidence: "…"})  → 记在游标那条上，推进

模型的输出里：零个标识符
```

`#7` 用同一把钥匙：`stagepass_ask({questionId})` → `stagepass_ask()` 无参，问
「当前开着的那个问题」。

`#2`（gap 表态）同理：`stagepass_next_gap()` / `stagepass_gap_verdict({kind, reason})`。

### 前置事实已验（2026-08-02，面板真跑三轮）

**子 Agent 不继承父会话命令行上的 `-c mcp_servers`，只继承全局配置文件里的。**

怎么验的：探针走 `change.brief` —— 裁判被要求「原样转达给正方，一个字都不要改」，
所以那段话原封不动到红方（一个子 Agent）手上。全是生产代码那条路。红方在 exec 里跑
`ALL_TOOLS.map(t => t.name)`，把自己的工具表倒出来：

```
工具总数 218，名字里带 stagepass 的：一个都没有
非 codex_apps 的那些：
  mcp__node_repl__js, mcp__openaiDeveloperDocs__search_openai_docs, …
```

**对照组是决定性的**：`node_repl` 和 `openaiDeveloperDocs` 在用户全局
`~/.codex/config.toml` 里（第 8、35 行），子 Agent **有**它们；`stagepass` 是
`panel-server.ts` 启动时用 `-c` 传的，子 Agent **没有**。而同一天早上那批 user 线程
用同样三行 `-c` 成功调过 `tools.mcp__stagepass__stagepass_ask`（rollout 里有
`mcp_tool_call_end`，`invocation.server = "stagepass"`）。

> **踩过的坑，记下来免得再踩**：第二版探针让红方跑
> `ALL_TOOLS.filter(x => x.name === "stagepass_ask")`，得到 `[]`，差点据此报「没有」。
> **那是问错了** —— 绑定名是 `mcp__stagepass__stagepass_ask`，工具在不在那个精确匹配
> 都返回空。判据必须是**把整张表倒出来自己看**，不是拿一个猜的名字去问。

### 因此：三个面裂成两半，一半今天就能做

判据是**这份 rubric 由谁判**（`work/rubric-round.ts` 的 `ASSESSED_BY`）：

| 面 | 答它的是谁 | 线程类型 | 能不能走工具 |
|---|---|---|---|
| #2 gap 表态（50 字符，最长的那个） | 裁判 | `user` | ✅ **今天就能** |
| #3 critic rubric | 裁判 | `user` | ✅ **今天就能** |
| #3 producer rubric | 反方 | `subagent` | ❌ 要先拍板 |
| #7 `stagepass_ask` | 被叫的那条 | `user` | ✅ **今天就能** |

**producer rubric 那一半不能靠改判官绕开** —— 让裁判去判红方会打破「没有人给自己
打分」排出来的那条链（蓝方判红方、裁判判蓝方，用户 2026-07-30 拍板）。

唯一的技术出路是**把插件写进用户全局 `~/.codex/config.toml`**，而现在的代码是刻意
不这么做的（`pluginConfigFor` 那句注释：每次启动才带，从不写进人的全局配置）。
**要不要破这条例，是人的决定，不是 StagePass 的。**

### 为什么不先退到「序号 + 位置互校」

那是 1~2 个字符的手抄（`B1 yes …`），位置和序号能互相校验，错位不可能静默发生。
它比现在好得多，但**它不满足第一节那条约束** —— 用户 2026-08-02 明确否掉了：
「不算，想办法做到真的 0」。

记在这里是为了让下一个人知道这条路被看过、被否过，理由是什么。

## 五、落点三 · 坏格式不许在线程里循环（A2）

### 现状

只有 `jobs.status === 'failed'` 才 detach（`web/panel-server.ts`）。而整份判定作废被
`assess` 吞成 `not_assessed`（`work/rubric-round.ts`），**轮次照样成功** → 线程留着
→ 裁判 resume 回去接着抄自己上一轮的坏格式。

实测：Build 阶段 critic 那份**连续三轮全部作废**，同一个抄错的 UUID 连抄三轮。

`domain/rubric-protocol.ts` 的模块文档说「作废而不是尽力而为，是因为**作废可以
重试** —— 模型有机会改一个错字」。而 `work/rubric-round.ts` 接着承认「重试的粒度是
下一轮，不是这一次」—— 下一轮 resume 的又是同一条中毒线程。**那句话目前是空头
支票，没有任何东西在兑现它。**

### 改成

轮次成功但**出现了结构性失败**时也 detach。判据不止 rubric 作废：

- 整份 rubric 判定作废（四种作废码任意一种）
- `verdicts` 读不出
- `conclusion` 读不出

三者是同一类东西：**一份坏格式留在了它自己的历史里**，而线程从来不是真相的载体
（开着的 gap、任务、契约每一轮都完整写在提示词里）。被作废的轮丢掉的只有毒。

技术上要把「本轮有结构性失败」这个事实从 L5 传到做 detach 决策的那一层。

### 落点二做完之后它仍然成立

工具提交能消灭 `unknown_key`，但裁判手写的 JSON 信封（#6）照样会坏。A2 管的是更
一般的那件事，不是 rubric 的专属补丁。

## 六、分层、依赖与验证

| 落点 | 新依赖 | 怎么证 |
|---|---|---|
| 一 | 只多读 `session_meta` 三个字段（`codex/rollout.ts` 已经在解析这个文件） | **纯离线**，喂假 rollout 记录 |
| 三 | 无 | **纯离线** |
| 二 | plugin 多两个工具 + 一张游标表 | `plugin/protocol.ts` 是纯函数，离线可证；**通道本身要真机验一次** |

三件**都不需要任何 Codex 私有接口** —— `session_meta` 是 rollout 文件的公开内容，
MCP 是 Codex 发布的协议。

基线：`pnpm check` **692 pass / 0 fail**（2026-08-02 开工前实测），一条红就是真回归。

## 七、执行顺序与现状

| | 状态 |
|---|---|
| **落点一** 线程血缘认亲 | ✅ 做完（`77f52ac` `402d82f`），**并已真机验过**（见下） |
| **落点三** 坏格式不许循环 | ✅ 做完（`e65bb6b`），纯离线 |
| **对抗路挂插件** | ✅ 做完（`0c83eca`），真机看过 argv |
| **落点二 · 裁判那半**（#2 / #3-critic / #7） | ✅ 做完（`6ca3ed0` `4c25957`），**已真机验过**（见下） |
| **落点二 · 反方那半**（#3-producer） | 卡在一个**人的决定**：要不要写全局配置 |

### 落点二 · 裁判那半的真机证据（2026-08-03，CHG-001 走完两轮落 settled）

**工具契约里一个标识符都没有**（`tools/list` 实测）：

```
stagepass_ask      required=[]                properties=[]
stagepass_next     required=[]                properties=[]
stagepass_answer   required=[answer, reason]  properties=[answer, reason]
```

`answer` 是枚举里的选择，`reason` 是散文 —— 正是 §一那条约束允许的两样东西。

两轮跑下来，裁判**一个 id 都没有打出来**，而账全都落对了：

- **gap 表态（#2）**：第 2 轮 4 条全经 `stagepass_answer` 落库，且**流回了 `gaps` 表** ——
  `HUMAN-1` / `SPEC-DECOUPLING-1` / `SPEC-EXTENSION-VALIDATION-1` 判 `closed` 并带上
  理由，`SPEC-VERIFY-BASELINE-1` 判 `still_open` 于是留着挡门。不是橡皮图章。
- **critic rubric（#3 的一半）**：两轮各 4 条，全经工具落进 `rubric_assessments`。
- **producer rubric**：仍走文本围栏（反方是子 Agent，用不了工具），两轮各有一条判 `no` ——
  说明老路没被这次改动碰坏。

### 落点一的真机证据（2026-08-02 / 08-03）

- `childThreadsOf` 从真轮里认出**恰好 2 条**子 Agent，红方在前、蓝方在后
- 第 2 轮**复用同一条裁判线程**（那时它已挂着第 1 轮的两个孩子），差集正确挑出了
  新的那一对 —— 证据是 `ARTIFACT-MISSING-1` 记在 `opened_round = 2`，出自第二对的蓝方
- **两条 spawn 入口都验过**：一趟是 exec 里的 `multi_agent_v1__spawn_agent`，
  一趟是原生 `spawn_agent({task_name})`。判据只看 `source.subagent.thread_spawn`，
  不看 `agent_path`，所以两条都认得出
- 裁判会话的 argv 里确实带着三行 `-c mcp_servers.stagepass.*`

### 真机才撞得出来的一个 bug（`b9a09e4`）

`WorklistStore.open` 里那句关旧名单是 `WHERE status = 'open'` —— **全库，没带
change_id**。一轮正等着裁判逐条表态时，同一个面板里给另一个 Change 派了一轮，就把
前一份**正在用的**名单一起关了。表现是「裁判一条都没答」（于是记
`worklist_unanswered`、放开线程），而它其实是被 StagePass 自己掐掉的。

离线测试撞不出来：它要两个 Change 的名单在时间上重叠。

### 落点一的真机证据（2026-08-02，同一次探针）

三轮真轮跑下来：

- `childThreadsOf` 从一轮真轮里认出**恰好 2 条**子 Agent，红方在前、蓝方在后，
  两边原文都读到了
- 第 2 轮**复用同一条裁判线程**（那时它已挂着第 1 轮的两个孩子），差集正确挑出了
  新的那一对 —— 证据是 `ARTIFACT-MISSING-1` 这条 gap 记在 `opened_round = 2`，
  而它出自第二对里的蓝方
- 裁判会话的 argv 里确实带着三行 `-c mcp_servers.stagepass.*`

所以「先出生的是红方」这条约定在真 Codex 上成立，差集也成立。

### 顺带查出来的一处潜在毛病

`pluginConfigFor` 把 `database.name` 原样塞进 `STAGEPASS_DB`。用相对路径启动面板时
（探针那次就是），配置里落的就是**相对路径**，而插件是 Codex 用工作区的 cwd 起的
`npx tsx`，找不到那个库。真库一直用绝对路径启动，所以没炸过。
