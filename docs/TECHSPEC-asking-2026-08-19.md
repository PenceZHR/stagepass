# TechSpec · 提问面 / 判据单 / 闸门

> 实现 `PRD-stagepass-2026-08-19.md`。读之前先看 §0 —— **PRD §3.2 有一处必须改**。

---

## 〇、对已批复 PRD 的一处更正（要你点头）

PRD §3.2 写的是：

```
stagepass_ask(rubricId, question, options[], why?)
```

**这条违反了你自己 2026-08-02 立的硬规矩**（`DESIGN-no-hand-transcription-2026-08-02.md`，
`domain/worklist.ts` 开头逐字复述）：

> 凡是 StagePass 会拿去做精确匹配的字符串，都不许出现在模型必须生成的文本里。
> 推论：模型的输出里只允许有两种东西 —— 枚举里的选择，和散文。

`rubricId` 正是「StagePass 拿去做精确匹配的字符串」。让模型生成它，就是第八个手抄面
（实测代价：同一个抄错的 UUID 连抄三轮，整份判定作废），批复：这个绝对不允许。

**改成序号：**

```
stagepass_ask(ordinal, question, options[], why?)
```

判据单是一份**文件**，模型读它、看见的是 `1. 2. 3.`。`ordinal → rubricId` 的映射在
StagePass 这一侧，从 `HandedRound.rubricIds` 取（那里存的是**备这一轮那一刻**生效的
版本 —— 人可能在跑的过程中改了标准）。

**「不许问别的阶段」的判据不变，反而更硬**：`ordinal ∈ 1..count`，越界当场拒。
从「引用完整性」降级成「范围检查」，代码判得更死，批复：可行。

---

## 一、中心决定：什么走文件，什么走 MCP

树上 2026-08-19 刚把名单从 MCP 工具改成文件，理由写在 `domain/worklist.ts`：

> 换来的是它在任何一个 Codex 会话里都跑得动，不需要装、不需要注册、
> **不需要每轮按一次 MCP 许可**。

加回 MCP 会把这个代价买回来。所以分界必须说死：

| | 走哪条 | 为什么 |
|---|---|---|
| 名单逐条表态、反方标准判定、判据单 | **文件** | 批量、一次看得全、不需要等人 |
| **提问（asking）** | **MCP** | 交互、要等人回答，文件做不到 |

**判据**：**要不要等一个人**。等人的走 MCP，不等人的走文件。

代价照直说：装了 MCP 之后，每个会话第一次调用要按一次许可（按会话算，不是按线程）。
**在这个用法里它可以接受** —— 提问时你本来就坐在那儿。但这条要写进 README，
因为它是「为什么第一次问会慢一拍」的唯一解释。

---

## 二、模块清单

### 新建

```
src/mcp/server.ts        MCP server 进程入口。薄客户端，零业务。
src/mcp/ask-tool.ts      stagepass_ask 的参数校验 + 转成 HTTP 调用
src/domain/ask.ts        提问这件事的形状（纯模块，无 IO）
src/store/ask-store.ts   留档：写 JSONL + 库索引
src/web/ask-route.ts     POST /api/ask-from-model、GET /api/asks
```

### 改

```
src/web/actions.ts       接 /api/ask-from-model
src/web/api.ts           接 /api/asks
src/domain/gate.ts       computeGate 多收一个 sheet 输入（§六）
src/web/panel.js/html    渲染 asking 流（§七）
scripts/stagepass.ts     起来时打印 MCP 注册片段
```

### 复用（一行都不重写）

```
domain/question.ts       选项措辞（RESPONSE_AGREE 那组）、P0 拿不到 WAIVE
domain/worklist.ts       序号↔身份 映射的既有范式
store/handoff-store.ts   HandedRound：round 身份、rubricIds、文件路径
web/serve.ts             GET/POST 分岔
```

### 不碰

`web/runtime.ts` / `web/seats.ts` / `codex/app-server-*` —— 执行通道。P4 之后按依赖
闭包取证再删，这份 spec 一个字都不改它们。

---

## 三、`stagepass_ask` 契约

### 入参

```ts
{
  ordinal: number,          // 判据单上的序号。1..count。必填
  question: string,         // 问句。散文
  options: string[],        // 2..6 条。散文
  why?: string,             // 为什么要问。散文
}
```

**模型能生成的只有：一个小整数 + 散文。** 没有 id、没有路径、没有阶段名。

### 校验（全部在 StagePass 侧，失败**不弹表单**）

| 判据 | 失败返回 |
|---|---|
| 有且只有一条 `waiting` 的 HandedRound（当前项目） | `no_open_round` |
| `ordinal` 是整数且 `1 ≤ ordinal ≤ count` | `ordinal_out_of_range`，**带上 count** |
| `options.length` 在 2..6 | `bad_options` |
| `question` 非空 | `empty_question` |

**错误要能自救**：返回文本里带上正确范围和这一条判据的原文，模型自己改得过来
（`worklist.ts` 的 `bad_answer` 就是这个范式 —— 答错不抛异常，把允许值原样回给它）。

### 回参

```ts
{ chosen: string, note?: string }       // 人答了
{ pending: true, askId: "ASK-0007" }    // 人没答（表单被关/超时）
```

**`pending` 不是错误。** 模型该把它当成「这条没答上」继续走，跟名单里没答上的那几条
一个待遇。留档照落。

### 谁弹表单

MCP elicitation。**未验事项**：elicitation 大概率是 pull-only（server 只能在处理一次
工具调用的过程中发起）。这不影响 asking（它本来就在一次工具调用里），但意味着
**轮间裁决推不进会话**，面板必须留着。**P0 第一件事就是验这条。**

---

## 四、MCP server 的形状

```
codex 会话 ──MCP stdio──> src/mcp/server.ts ──HTTP──> 127.0.0.1:4399 (工作台)
                            (薄客户端，无状态)            (唯一有状态的进程)
```

**零业务逻辑在 MCP 进程里。** 它只做三件：收工具调用 → 转成一次 HTTP → 把
elicitation 弹出来。

这治的是 08-19 夜里六个失败中唯一还活着的那个：**MCP server 按会话起，一台机器上
三个进程各锁着不同版本的代码**。薄客户端起几个都无所谓 —— 它们只是电话线，
状态在 4399 那一个进程里。

**不打包成插件、不走 marketplace、不用 widget。** 直接写 `~/.codex/config.toml`：

```toml
[mcp_servers.stagepass]
command = "node"
args = ["/Users/zhanghr/Desktop/stagepass/dist/mcp/server.js"]
```

工作台没起来时：工具返回 `workbench_not_running` + 起它的命令。**不自动拉起**
——「看状态不该有副作用」，反过来「问一句话」也不该顺手起一个进程。

依赖：需要 MCP SDK。**加之前先确认它 ESM 干净**（`ws` 是 CJS，打进 ESM 就抛，
三次构建从来没启动成功过，烧掉一整夜）。

---

## 五、留档

### 形状（`domain/ask.ts`）

```ts
interface Ask {
  readonly id: string;              // ASK-0007，StagePass 生成
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  readonly rubricId: string | null; // ordinal 映射回来的。判据单为空时 null
  readonly ordinal: number | null;
  readonly question: string;
  readonly why: string | null;
  readonly options: readonly string[];
  readonly askedAt: string;
  readonly chosen: string | null;   // 没答就是 null
  readonly note: string | null;
  readonly answeredAt: string | null;
}
```

### 落到哪

- **文件为准**：`<项目>/.stagepass/asks.jsonl`。**只追加，一行一条 JSON。**
  答案回来时**追加一条 `{id, chosen, note, answeredAt}` 的补记**，不改原行 ——
  只追加的文件不能有原地改写，否则 diff 会撒谎。
- **库为索引**：`asks` 表，只存查询投影。**库丢了能从文件重建，反过来不行。**
  重建入口：`AskStore.rebuildFrom(path)`，有测试钉着。

### 为什么在项目仓库里

跟着 Change 走、可 commit、可 diff。**代价：StagePass 会往你的项目里写文件。**
`.stagepass/` 一个目录，建议进 `.gitignore` 由你决定 —— 不由 StagePass 替你写。

---

## 六、判据单与闸门

### 判据单是文件，不是新表

复用 `HandedRound.blueRubric`：`criteriaPath`（代码铺）+ `answersPath`（模型填）+
`count` + `rubricIds`（版本钉死）。**不新建存储。**

一条判据在答案文件里长这样（和 `worklist` 逐字同形 —— 一个人手里两种格式，
就是两次答错的机会）：

```
3: pass  spec.md §2.3 已经写明「不做多人协作」
4: blocked  这条我判不了，见 ASK-0007
```

`claim` 是枚举（`pass` / `blocked` / `n_a`），后面是散文。**和 `worklist` 完全同构。**

### `computeGate` 的改动

现在：

```ts
if (evidence.artifactIds.length === 0)  refuse("nothing_was_produced")
if (unresolved(evidence).length > 0)    refuse("blocking_problem_outstanding")
```

加第三条：

```ts
if (sheet.missing.length > 0)           refuse("rubric_sheet_incomplete")
```

`sheet.missing` 由**代码**算，判据三条：

1. 每条判据都有 `claim`
2. `claim = pass` 的，后面的散文非空
3. 散文里若出现路径，那个路径真的存在（**只判存在，不解析格式** ——
   `where` 那条注释说清了为什么不做 `{file,line}`：十一个阶段共用，设计阶段写
   「PRD §3.2」塞不进去）

**`refusals` 必须说得出缺哪几条**（带序号 + 判据原文）。现在的 `RefusalReason` 是个
字符串枚举，装不下 —— 要扩成带 payload。少了这一步，面板上是一个灰按钮和一句
「判据单不全」，人不知道去补哪一条。

### 不动的

`unresolved()` 一个字不改。**P2 不挡闸门这件事这一期不治** —— PRD §七 挂着，
它要求先给每条 rubric 定分量。判据单是**另一条**闸门，和它并列。

---

## 七、面板

三块新的，全是只读渲染 + 一个动作：

1. **asking 流** —— 按时间倒序，每条显示阶段/轮次/判据原文/问句/选项/你选了哪个。
   **未答的高亮**。数据源 `GET /api/asks?change=…`。
2. **判据单** —— 逐条 `claim` + 散文，缺的标红。数据源接在 `/api/panel` 里。
3. **闸门理由** —— `refusals.approve` 的 payload 直接摆出来。

刷新：**轮询，2 秒一次，页面可见时才轮**。不上 SSE / websocket ——
`ws` 那一课太贵，而 2 秒延迟对「旁边看着」这个用法完全够。

**面板不是阻塞路径**：面板没开，asking 照样问、照样落档。

---

## 八、测试策略

沿用现有形状（`pnpm check`，1177 条基线，`*.test.ts` 和源码同目录）。

**必须有的三类：**

1. **纯域**（`domain/ask.ts`）—— 参数校验、ordinal 映射、错误文本带不带范围。
2. **留档往返** —— 写 N 条 → 删库 → `rebuildFrom` → 逐字节相等。
   这条是「文件为准」的唯一证明。
3. **闸门** —— 判据单缺一条 → `approve` 不在 `permitted` 里，且 `refusals.approve`
   **说得出缺的是第几条**。

**一条必须是真机、不能用测试代替**：模型在真实 Codex 会话里调 `stagepass_ask`、
表单真的弹、人真的点、答案真的回到模型。

理由写在 `round-runner.test.ts` 里，用血换的：`stagepass_next` / `stagepass_answer`
随 `src/plugin/` 一起删掉之后，**题面还在叫裁判去调它们，而 1177 条测试全绿** ——
每一轮的表态全丢、每条标准记 `not_assessed`，而那是把闸门**沉默地**关死。

所以补一条护栏（照 08-19 那两道的样子）：**题面里提到的每一个工具名，
必须在 MCP server 的工具表里真的存在。** 构建时跑，对不上就红着退出。

---

## 九、分期

| 期 | 做什么 | 验收（对应 PRD §五） |
|---|---|---|
| **P0a** | 验 elicitation 是不是 pull-only。**纯实验，不写产品代码** | 决定面板存亡 |
| **P0b** | `src/mcp/server.ts` + `stagepass_ask` + JSONL 留档 | 1、5 |
| **P1** | 面板渲染 asking 流 | 2 |
| **P2** | 判据单答案文件读回 + ordinal 校验 | 3、4 |
| **P3** | `computeGate` 加第三条 + `refusals` 带 payload | 4 |
| **P4** | 结算改成只读产物（`/api/settle` 已在，把认线程那段拆掉） | 6 |

**P0b 独立可用**：判据单为空时 `ordinal` 允许为 null，退化成「随便问」。
做完当天每条会话都用得上。

---

## 十、风险

| 风险 | 现在的判断 |
|---|---|
| elicitation 是 pull-only | **P0a 先验。** 若是，面板留着，轮间裁决继续走面板 |
| MCP SDK 是 CJS | 加依赖前先验一次真启动。`ws` 那次三次构建没起来过 |
| 每会话一次许可 | 接受。提问时人本来就在。写进 README |
| 模型不用工具、继续打字问 | **强制不了**（`PreToolUse` 看不见「决定打字」）。只能靠题面 + AGENTS.md 约定。**这是软的，别假装它硬** |
| 判据单版本漂移 | `HandedRound.rubricIds` 已经钉死。别再取一次 |
| 往用户项目里写 `.stagepass/` | 已在 §五 说明。要你点头 |

---

## 十一、还没定的

1. **§0 那处更正**（`rubricId` → `ordinal`）要你点头。不点头我不动。
2. `.stagepass/asks.jsonl` 写进项目仓库 —— 确认。
3. 一个项目同时只允许一条 `waiting` 的 HandedRound。**并行座位（`ParallelStore`）
   在这个前提下没有位置** —— 是不是就此退休，不退休，阶段依旧允许并行，逻辑上说得通。
4. 判据单为空时 `ordinal=null` 的「随便问」要不要长期保留，还是只在 P0b 当脚手架，可以随便问。
