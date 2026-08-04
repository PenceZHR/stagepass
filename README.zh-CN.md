# StagePass

[English](README.md) · **简体中文**

> **模型不能自己给自己放行。**

StagePass 是一个本地运行的交付控制面：它把一次改动拆成十二个阶段，每个阶段跑一次
Codex，产出证据、找出问题，然后**停下来等人裁决**。裁决发生在 Codex 自己的选择器
里，不在网页上。人选完，StagePass 才推进状态。

---

## ⚠️ 状态：建造中，六层里做完五层

这还不是可以拿来用的软件。**下面这张表是真的**，没做的就是没做：

| 层 | 内容 | 状态 |
|---|---|---|
| **L0** | schema、状态机、状态转移、审计账本 | ✅ 完全离线验收 |
| **L1** | gate 计算、fence、租约、心跳、幂等、崩溃恢复 | ✅ 离线验收；崩溃恢复 2026-08-03 真机撞到并跑通 |
| **L2** | 调起 Codex TUI、thread 绑定、turn 记录、从 rollout 读结果 | ✅ 真 turn 验过（osascript 版与 pty 版各一次） |
| **L3** | 组题 → Codex 原生选择器 → 人选 → 答案回来 → 状态前进 | ✅ 真人真选过 |
| **L4** | 红方 / 蓝方 / 裁判的对抗轮次，结算成可裁决的结果 | ✅ 真跑过多轮：gap 落库、闸门关上、后续轮次把 gap 关掉 |
| **L5** | rubric 出分、gap 跟踪 | ✅ 2026-08-03 真机端到端跑通（PRD 第 3 轮） |
| **L6** | 铺开到其余阶段 | 🟡 十一个里**两个**真机走通了（2026-08-04 批准 PRD，接着跑 Spec）。其余九个共用同一条代码路径和出厂标准，但没跑过。 |

**下层验收不通过，不许动上层。** 这是这个仓库的建造纪律，不是建议 —— 它也是这份
README 存在的方式：每一行都对应一件真的跑过的事。

> 重建之前那版 README 描述的是一套**从未运行过**的架构（MCP App 决策卡、
> follower IPC、一个独立的 Web dashboard）。那套东西已经连同旧代码一起删掉了，
> 重建从 2026-07-28 开始。把没跑通的东西写成完成态，正是那份 README 变成废纸的原因。

---

## 它要解决的问题

让模型自己判断"这一阶段做完了没有"，等于让它给自己打分。真实的失败长这样：

- 第二轮重新生成了文档，**上一轮的问题没被提起，于是就算解决了**；
- 模型报告"没有阻塞项"，闸门打开，问题带进下一阶段；
- 人想介入，但介入的入口是一个网页按钮 —— 而网页上的按钮点下去，只有网页知道。

StagePass 对这三件事各有一条硬规则：

1. **沉默不能关闭一个问题。** `gaps` 表里的问题跨轮存活，关掉它必须说明理由 ——
   "这一轮没提到"和"这一轮说它已经修好了"在库里是两种不同的行。
2. **闸门读证据，不读模型的自我评价。** 阶段节点变绿只因为**账本里有人批准过它**，
   不是因为哪一轮报告说没问题。
3. **裁决只有一条路径。** 人的选择发生在 Codex 自己画的 elicitation 选择器里。
   网页上没有、也不会有一个能推动闸门的按钮。

### 第四条，是花大代价换来的

**凡是 StagePass 会拿去做精确相等匹配的字符串，都不许出现在模型必须写出来的文本里。**
起因是一个裁判把 36 字符的 UUID 抄漏了一段，四条答得整整齐齐的判定一起作废。之后
盘完全系统，这样的面有七个，其中五个已经烧过至少一次。

于是模型的输出里现在只允许有**枚举里的选择**和**散文**。标识符一律不经模型的嘴：

- 这一轮跑在哪两条线程上 —— StagePass 从 rollout 的 `parent_thread_id` 自己认，
  而不是让裁判把 id 报上来；
- 逐条表态 —— 模型调 `stagepass_next` 取下一条、`stagepass_answer` 作答。
  **插件那三个工具没有一个收标识符**：两个一个入参都不收，`stagepass_answer` 只收
  `answer` 和 `reason`。答的是**哪一条**是 StagePass 的事，不是模型的事；
- 反方要判的 rubric —— 写进一份按 `1..N` 编号的文件，答案按序号写回。**缺一个号或者
  重一个号就整份作废**，而不是让每一条判定错位挂到别的标准上。

---

## 三个部分，职责不重叠

| | 干什么 | **明确不干什么** |
|---|---|---|
| **状态机与闸门**（`src/domain`、`src/store`） | 状态转移、gate、fence、租约、恢复；组题、验答案、推进状态 | **不渲染任何东西** |
| **终端面板**（`src/web`） | 看和启动：阶段环、证据、风险；**托管 Codex TUI 真正运行在里面的那块 pty** | **不承载任何业务决策入口** |
| **Codex 插件**（`src/plugin`） | 通过 MCP `elicitation` 向人提问，把答案发回来 | 不决策、不组题、不判断合法性 |

**终端面板是宿主，不是入口。** 你在浏览器里看到的执行过程和选择界面，每一个像素
都是 `codex` 二进制自己用转义序列画的；StagePass 只把字节从 pty 搬到 xterm.js。
换掉的是"那块玻璃谁拥有"，不是"谁在画"。

这条不靠自觉。`src/architecture.test.ts` 里有五条常驻护栏，任何时候都不许红：

1. 每个模块声明自己属于哪一层；
2. 下层不许 import 上层；
3. 没有零调用者的 export；
4. 一个概念一个名字（阶段名不许有别名）；
5. **`src/web/` 里不许出现 `TextDecoder` / `.toString(` / `JSON.parse` /
   `String.fromCharCode`** —— 把 pty 字节变成字符串的四条路，一条都不留。

第 5 条是终端面板当初被接受的前提：一旦开始解析 Codex 的输出去画自己的界面，就
退回到了被否掉的那个方案。这不是风格问题，所以不能交给判断力。

### 看状态不该有副作用

打开一个阶段的终端原来会**起一个 Codex 进程**。于是只想看一眼的人凭空起了一个 ——
而一个活进程占着这个阶段唯一的座位，之后这个阶段的每个动作都被拒。现在拆成两个
按钮，各有各的名字：

| | |
|---|---|
| **看这个终端** | 有进程就接上；进程死了给最后一屏；从没跑过就说**「这个阶段还没有进程」**。不起任何东西。 |
| **开一个终端** | 明确起一个，**带着插件**。已经有进程时它是藏起来的。 |

---

## 现在能跑什么

```bash
pnpm install
pnpm check            # 751 个测试 + 严格 typecheck，全离线，不需要 Codex
```

需要真 Codex 的：

```bash
pnpm panel                 # 终端面板：阶段环 + 每阶段一个终端
pnpm verify:rebuild        # L0–L2 整条链路（离线）
pnpm verify:decision       # L3：组题 → 选择器 → 人选 → 闸门前进
pnpm verify:round          # L4：真跑一轮红蓝对抗
pnpm verify:rubric-round   # L5：跑一轮，并且给 rubric 出分
```

`pnpm panel` 的参数全都是可选的：

```bash
node --import tsx scripts/panel.ts \
  --db <路径> --port 4173 \
  --project-name <名字> --project-path <目录> \
  --model <模型名> --effort minimal|low|medium|high|xhigh \
  --ask-timeout <分钟> --turn-timeout <分钟>
```

思考预算默认 `xhigh`：一轮对抗反正要几分钟起步，省那点预算换回一份判得更浅的结论
不划算。不带 `--db` 会建一个临时库，可以随便点，不碰任何真数据。

探针每个只回答一个关于 Codex 的事实问题，并把量到的东西打出来：

```bash
pnpm probe:pty        # elicitation 选择器在 pty 里能不能用？
pnpm probe:elicit     # -a never 会不会静默 decline 掉 elicitation？（会）
pnpm probe:sandbox    # read-only 与 workspace-write：哪一个会卡在审批上？
pnpm probe:subagent   # 哪些线程拒绝来自父线程之外的输入？
```

### 环境要求

- **macOS。** node-pty 用预编译产物，`verify:decision` 走 `osascript`。其它平台
  没有验证过，别假设能跑。
- **Node 20+**（开发用的是 25.9）、**pnpm**。
- **Codex CLI**（开发用的是 0.146.0）。L2 以上每一条命令都需要它。

### 两个会咬人的坑

**`-a never` 会掐断唯一的问人通道。** 它不只管 shell 审批 —— 它会让 Codex
**自动 decline 掉 MCP 的 `elicitation/create`**。失败是静默的：回来一个格式完全
合法的 `{"action":"decline"}`，和"人按了 Esc"一模一样。代码里这个值**在类型上已经
不可表达**（`CodexInvocation.approval` 只接受 `"untrusted" | "on-request"`）。
写注释叮嘱下一个人，不如让它编译不过。

**子 Agent 的线程拒绝父线程之外的任何输入。** `codex resume <子Agent线程>` 起得来、
MCP server 也照常加载，但一提交就是 `■ This sub-agent is controlled by its parent.
Direct input is disabled.` —— 而且**和父线程还活着没有关系**。2026-08-03 在 0.146.0
上实测（`pnpm probe:subagent`：两条子 Agent 线程被拒，一条普通线程接受并作答）。
任何"直接驱动子 Agent 线程"的设计都不成立；唯一还通的通道是它的父线程 —— 这正是
反方那份 rubric 现在改成"两个文件路径由裁判原样转达"的原因。

---

## 仓库长什么样

```
src/
  domain/     纯逻辑：阶段、状态机、gate、gap、租约、轮次、提问、每个阶段的提示词
              —— 无 IO，可穷举证明
  store/      SQLite 读写：change、evidence、gap、command、binding、turn、question、
              rubric、worklist
  work/       长任务：job 租约、turn 循环、对抗轮次与 rubric 轮次的接线
  codex/      调 Codex：invocation、TUI transport、rollout 解析、子 Agent、目录信任、归档
  plugin/     MCP 插件：唯一的写入是"记下人说了什么"
  web/        终端面板：pty 会话、面板服务端、浏览器那半边
  architecture.test.ts   五条常驻护栏
docs/         PRD、交接、设计稿。**PRD 是唯一权威。**
scripts/      panel、verify:*、probe:*
```

生产代码 13586 行、45 个模块，测试 13125 行。SQLite 是唯一权威 —— `changes` 表上有
触发器，任何一次没有配套账本行的状态更新都会被数据库**当场**拒绝，而不是事后才
发现少了一条审计记录。

有两样东西是逐字节钉死的，这是故意的：

- `src/domain/round-prompt.golden.txt` —— 十一个阶段各自的裁判提示词。改其中一个
  阶段，另外十个必须一字不差；正是这一条挡着它们重新长回一份共用模板。
- 插件的工具契约 —— 三个工具，**没有一个收标识符**。`stagepass_ask` 原来收一个
  `questionId`，那正是七个手抄面之一；拿掉它之后，模型不可能再答错对象。

主要文档：

- [`docs/PRD-stagepass-rebuild-2026-07-28.md`](docs/PRD-stagepass-rebuild-2026-07-28.md) —— **唯一权威**，包括为什么重建
- [`docs/HANDOFF-2026-08-03.md`](docs/HANDOFF-2026-08-03.md) —— 最新进度、验出来的坑、还没做的事
- [`docs/DESIGN-no-hand-transcription-2026-08-02.md`](docs/DESIGN-no-hand-transcription-2026-08-02.md) —— 模型手抄标识符的七个面，以及每一个是怎么归零的
- [`docs/STAGEPASS-ACTUAL-REQUIREMENTS.md`](docs/STAGEPASS-ACTUAL-REQUIREMENTS.md) —— 产品要解决什么、十二个阶段各自产出什么

---

## 许可

[MIT](LICENSE)
