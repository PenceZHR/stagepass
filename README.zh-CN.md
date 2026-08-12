# StagePass

[English](README.md) · **简体中文**

> **模型不能自己给自己放行。**

StagePass 是一个本地运行的交付控制面：它把一次改动摆上一条**八阶段的钻石环**，
每个阶段跑 Codex 的对抗轮（红方产出、蓝方挑错、裁判判定），产出证据、找出问题，
然后**停下来等人裁决**。裁决发生在 Codex 自己的选择器里，不在网页上。人选完，
StagePass 才推进状态。

```
PRD → Spec → Arch → ⟨BuildPlan ∥ TestPlan⟩ → ⟨Build ∥ Test⟩ → QA
                 └────────── 两轨互盲 ──────────┘
```

Arch 是钻石的分叉点：计划轨和测试轨从这里分开、**互相看不见**（Build 连读测试
都不许），到 QA 对撞 —— QA 读代码、跑测试、做两方向变异攻击，发现的问题按
三向归因打回 Build / Test / Arch，打回就是**重走**（中间被跳过的阶段不再被默认
正确），并行攒的座位全部清掉重来。

---

## ⚠️ 状态：地基全绿，环已闭合，自举还没发生

这还不是可以拿来用的软件。**下面这张表是真的**，没做的就是没做：

| 层 | 内容 | 状态 |
|---|---|---|
| **L0–L5** | schema、状态机、闸门、租约、崩溃恢复、Codex TUI 托管、原生选择器裁决、对抗轮、rubric 出分 | ✅ 全部离线验收 + 真机各走通过（2026-07-28 起逐层） |
| **环 v3** | 八阶段钻石环、两轨互盲、QA 三攻、打回重走、并行座位 | ✅ 六批落地（2026-08-09），CHG-001 真机沿新环走到 QA、又按打回重走 |
| **项目图谱** | 黑洞 + 土星环的 3D 依赖图，Arch 图纸对账叠影 | ✅ 真机验过（2026-08-12）；判据的语义边界还有一个待拍板 |
| **自举** | 用 StagePass 跑一个 Change，产出 StagePass 自己的下一个改动 | ❌ 还没发生 —— 这是「能不能叫 bootstrap」的判据 |

**下层验收不通过，不许动上层。** 这是这个仓库的建造纪律，不是建议 —— 它也是这份
README 存在的方式：每一行都对应一件真的跑过的事。

> 重建之前那版 README 描述的是一套**从未运行过**的架构。那套东西已经连同旧代码
> 一起删掉了，重建从 2026-07-28 开始。把没跑通的东西写成完成态，正是那份 README
> 变成废纸的原因。十二阶段的旧主线也已退休（TechSpec 并进 Arch、Review 收编进
> QA、Fix 变成打回交互）—— 名字留给历史，账本里的旧行永不改写。

---

## 它要解决的问题

让模型自己判断"这一阶段做完了没有"，等于让它给自己打分。真实的失败长这样：

- 第二轮重新生成了文档，**上一轮的问题没被提起，于是就算解决了**；
- 模型报告"没有阻塞项"，闸门打开，问题带进下一阶段；
- 写代码的和写测试的是同一个脑子，测试钉住的是实现文本，不是行为。

StagePass 对这些各有一条硬规则：

1. **沉默不能关闭一个问题。** `gaps` 表里的问题跨轮存活，关掉它必须说明理由 ——
   "这一轮没提到"和"这一轮说它已经修好了"在库里是两种不同的行。
2. **闸门读证据，不读模型的自我评价。** 阶段节点变绿只因为**账本里有人批准过它**，
   不是因为哪一轮报告说没问题。
3. **裁决只有一条路径。** 人的选择发生在 Codex 自己画的 elicitation 选择器里。
   网页上没有、也不会有一个能推动闸门的按钮。
4. **写代码的和写测试的互盲。** 两轨只共享 Arch 契约，在 QA 对撞；QA 用变异攻击
   验测试本身（不改行为的变异必须全绿、还原改动必须变红）。

### 第五条，是花大代价换来的

**凡是 StagePass 会拿去做精确相等匹配的字符串，都不许出现在模型必须写出来的文本里。**
起因是一个裁判把 36 字符的 UUID 抄漏了一段，四条答得整整齐齐的判定一起作废。之后
盘完全系统，这样的面有七个，其中五个已经烧过至少一次。

于是模型的输出里现在只允许有**枚举里的选择**和**散文**。标识符一律不经模型的嘴：
线程 id 从 rollout 的 `parent_thread_id` 自己认；插件的三个工具没有一个收标识符；
反方要判的 rubric 按 `1..N` 编号，缺号或重号整份作废，而不是错位挂到别的标准上。

---

## 项目图谱：黑洞、土星环、和 Arch 的图纸

面板环心的太阳，点开是这个项目的**真实依赖图**（用真 TS 编译器解析，不是正则）：

- **中心是黑洞，引力就是依赖方向** —— 被依赖得越狠的层，环带越靠内；同一环带里
  爆炸半径越大的星越沉向内缘。`tests` 谁也不被依赖，在最外圈。
- **违规一眼可见**：正常依赖全部指向内，向外爬的弧就是"依赖了比自己外层的东西"。
- **Arch 阶段必须产出机器可读的图纸**（`arch.graph.json`：概念 / 关系 / 认领），
  图纸和真代码机械对账，结果叠在环上 —— 规划的概念悬在承载它的星正上方，
  需求里有、代码里没有的概念是玫瑰色幽灵，挂在最外环之外的规划轨道上。
- 对账不判红，它摊事实：概念未落地、概念散落、模块超载、模块无主、关系没实现、
  计划外依赖 —— 六类发现侧栏逐条可读，图上各有画法。

哪些目录算"关键代码"由人在面板上勾（存进库），素材和生成物按目录聚成一张门牌
清单，不进场景。图**不缓存**：全程 ~200ms，永远等于磁盘上那棵树。

---

## 三个部分，职责不重叠

| | 干什么 | **明确不干什么** |
|---|---|---|
| **状态机与闸门**（`src/domain`、`src/store`、`src/app`） | 状态转移、gate、fence、租约、恢复；组题、验答案、推进状态 | **不渲染任何东西** |
| **终端面板**（`src/web`） | 看和启动：阶段环、证据、图谱；**托管 Codex TUI 真正运行在里面的那块 pty** | **不承载任何业务决策入口** |
| **Codex 插件**（`src/plugin`） | 通过 MCP `elicitation` 向人提问，把答案发回来 | 不决策、不组题、不判断合法性 |

**终端面板是宿主，不是入口。** 你在浏览器里看到的执行过程和选择界面，每一个像素
都是 `codex` 二进制自己用转义序列画的；StagePass 只把字节从 pty 搬到 xterm.js。

这条不靠自觉。`src/architecture.test.ts` 里的常驻护栏任何时候都不许红，起家的五条：

1. 每个模块声明自己属于哪一层；
2. 下层不许 import 上层；
3. 没有零调用者的 export；
4. 一个概念一个名字（阶段名不许有别名）；
5. **`src/web/` 里不许出现 `TextDecoder` / `.toString(` / `JSON.parse` /
   `String.fromCharCode`** —— 把 pty 字节变成字符串的四条路，一条都不留。

后来又长出了几条**棘轮**：单函数行数、单模块依赖闭包占比、配料单占全树比例 ——
现行违例逐个钉死在例外表里，只许缩、不许涨。图谱那批路由就是被闭包棘轮打红后
改成注入接线的：护栏红得对，就照它说的改。

### 看状态不该有副作用

打开一个阶段的终端不会起进程；进图谱不写库、不碰 Codex。**看一眼就是看一眼。**
要起进程的按钮明确写着"开一个终端"。

---

## 现在能跑什么

```bash
pnpm install
pnpm check            # 1209 个测试 + 严格 typecheck，全离线，不需要 Codex
```

需要真 Codex 的：

```bash
pnpm panel                 # 终端面板：阶段环 + 图谱 + 每阶段一个终端
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
  --ask-timeout <分钟> --turn-timeout <分钟> --round-budget <轮数>
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
上实测。任何"直接驱动子 Agent 线程"的设计都不成立。

---

## 仓库长什么样

```
src/
  domain/     纯逻辑：阶段、状态机、gate、gap、租约、轮次、提问、模板与出厂标准
              —— 无 IO，可穷举证明
  store/      SQLite 读写：change、evidence、gap、binding、rubric、并行座位、旁路账本
  app/        用例层：问人、录需求、裁决、接受风险、新建与删除
  work/       长任务：job 租约、turn 循环、对抗轮次与 rubric 轮次的接线、git
  graph/      图谱引擎：真编译器解析依赖、判据、布局、配料单、图纸对账 —— 全部纯函数
  codex/      调 Codex：invocation、TUI transport、rollout 解析、目录信任、归档
  plugin/     MCP 插件：唯一的写入是"记下人说了什么"
  web/        终端面板：pty 会话、面板服务端、图谱 API（注入接线）、浏览器那半边
  architecture.test.ts   常驻护栏
docs/         PRD、BACKLOG、设计稿、交接。**PRD 是唯一权威，BACKLOG 是待办的唯一入口。**
scripts/      panel、verify:*、probe:*、dump-rubrics、regen-prompt-golden
```

生产代码 22644 行、66 个模块，测试 21606 行，面板前端另有 4355 行带类型检查的 JS。
SQLite 是唯一权威 —— `changes` 表上有触发器，任何一次没有配套账本行的状态更新都会
被数据库**当场**拒绝。

有两样东西是逐字节钉死的，这是故意的：

- `src/domain/round-prompt.golden.txt` —— 各阶段的裁判提示词。改其中一个阶段，
  其余的必须一字不差；正是这一条挡着它们重新长回一份共用模板。
- 插件的工具契约 —— 三个工具，**没有一个收标识符**。

主要文档：

- [`docs/PRD-stagepass-rebuild-2026-07-28.md`](docs/PRD-stagepass-rebuild-2026-07-28.md) —— **唯一权威**，包括为什么重建
- [`docs/BACKLOG.md`](docs/BACKLOG.md) —— 还没做的 + 为什么这么做，跨会话累积
- [`docs/PLAN-2026-08-09-ring-v3.md`](docs/PLAN-2026-08-09-ring-v3.md) —— 环 v3：八条拍板 + 七批落地
- [`docs/superpowers/specs/2026-08-12-project-graph-3d-design.md`](docs/superpowers/specs/2026-08-12-project-graph-3d-design.md) —— 项目图谱的设计与判据
- [`docs/DESIGN-no-hand-transcription-2026-08-02.md`](docs/DESIGN-no-hand-transcription-2026-08-02.md) —— 模型手抄标识符的七个面，以及每一个是怎么归零的

---

## 许可

[MIT](LICENSE)
