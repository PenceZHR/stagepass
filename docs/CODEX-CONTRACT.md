# Codex 行为契约

> **这不是抽象层。**「只做 Codex」那条决定没动。这是把代码已经依赖的 Codex 行为
> **显式化成一张表**：每条假设写明它塌了会砸到哪、用哪个探针验。
>
> 为什么要有它：2026-08-03 一条假设（子 Agent 线程可外部驱动）被 `0.146.0` 正式版
> 单方面推翻，代价是一整套围栏协议作废（`3d32ea3` 净减 670 行）加一天的排查 ——
> 而当时要翻遍注释才能找全哪些地方依赖了它。**Codex 升级后跑一遍 `pnpm probe:all`，
> 就知道哪条死了**，不是等某一轮静默烧满超时才发现。
>
> 最近全面核对：**2026-08-05，codex 0.146.0**。

## 怎么读这张表

- **塌了会怎样** 是每条最值钱的一栏 —— 它决定了升级后先查什么。
- 探针分两类：`pnpm probe:all` 能无人值守跑的，和**要人到场**的（烧 turn、
  要按许可框、要真线程）。手动的那几条在 probe:all 的输出里会列出跑法。

## 契约

### C1 · 子 Agent 线程拒绝外部输入

`codex resume <子Agent线程>` 起得来，但一提交就是
`■ This sub-agent is controlled by its parent. Direct input is disabled.`
**和父线程活不活着无关**；判据是 rollout `session_meta` 的 `thread_source: "subagent"`。

- **依赖点**：`domain/round.ts`（blueRubric 走文件的全部理由）、
  `work/rubric-round.ts` `blueRubricFiles`
- **探针**：`pnpm probe:subagent`（要真线程，手动）
- **塌了会怎样**：反着塌（重新允许直接驱动）**不坏任何东西** —— 文件通道照样工作，
  只是多了一条可选的直连路。正着没得再塌。
- 首次实测 2026-08-03（`0.146.0-alpha.3.1` 还允许，正式版禁止 —— 这条自己就是
  「Codex 会单方面改行为」的铁证）。

### C2 · 先派正方、后派反方 —— 出生顺序就是身份

裁判被要求串行派发（`judgePrompt`），StagePass 按子线程出生时刻认红蓝
（`codex/subagent.ts` `childThreadsOf`，差集取最后两条）。

- **依赖点**：`work/round-runner.ts`（`fresh[length-2]` = 红方）
- **探针**：无独立探针 —— 每一轮对抗本身就在验（认反了两边的话会记到对方头上，
  蓝方 rubric 判定会一眼荒谬）
- **塌了会怎样**：如果 Codex 改成并行派发或乱序落盘，红蓝身份互换，
  **整个取证层作废**。症状：红方的产出被当成蓝方的意见。

### C3 · 子 Agent fork 父线程的全部历史

`forked_from_id` = 父线程；第 5 轮的反方 rollout 里有 15 条继承来的裁判提示词。

- **依赖点**：「同一个问题沿用同一个 id」靠它才 work（模型记得用过什么 id）；
  「每轮新反方从零怀疑」**只在跨阶段成立**
- **探针**：离线可验 —— `pnpm probe:all` 扫最近的子 Agent rollout，
  数继承的 `user_message`
- **塌了会怎样**：改成干净 fork 的话，同阶段的 id 稳定性会退化
  （critic rubric 第 4 条会开始红），settled 清单变成唯一的记忆通道。

### C4 · rollout 的 `session_meta` 里有线程血缘

第一行就有 `parent_thread_id`（76/76 实测有值）；UUIDv7 **绝不能前缀匹配**。

- **依赖点**：`codex/subagent.ts` 认子线程的唯一依据
- **探针**：离线可验 —— `pnpm probe:all` 扫会话目录核字段还在不在
- **塌了会怎样**：字段没了取证层就瞎了 —— 这是全系统**最脆的一条**，
  它只是 rollout 的实现细节，Codex 没有任何义务保持。

### C5 · MCP 许可按「会话」弹一次，不按线程

`-a on-request` 下每个新 `codex resume` 进程第一次调某 MCP 服务器的工具都会弹框。
判据是会话，所以**每一轮对抗都弹一次**。没人按 = 静默烧满 turn 超时。

- **依赖点**：挡着「无人值守」这件事本身（BACKLOG §2.1）
- **探针**：手动 —— 起一轮看第一次 `stagepass_*` 调用弹不弹
- **塌了会怎样**：反着塌（记住放行）是**好事**，§2.1 直接关掉。
- **在 rollout 里认它的三条反直觉判据**（2026-08-05 校准）：
  ① MCP 调用的 `name` 是 `exec`，真名在 `input` 里；② `status:"completed"`
  只说明发出去了，判据是**有没有配对的 `custom_tool_call_output`**；
  ③ 按晚了的门留下一条完全正常的 completed 调用，破绽在它**前面那段空白**。

### C6 · elicitation 选择器在 pty 里能用

- **依赖点**：整个终端面板（road B）的前提
- **探针**：`pnpm probe:pty`（起真 Codex，全自动，约一分钟）
- **塌了会怎样**：面板的问人通道全断 —— 这是「面板被接受的前提」级别的塌方。
- 附带的三条表单坑（字段按名字排序、required 是硬闸门、空文本格吃回车）
  由 `pnpm probe:brief` 盯。

### C7 · elicitation 不用跑 turn 就能触发

MCP 握手完成即可 elicit，零 token。

- **依赖点**：问人那条路的成本模型（问人不烧 turn）
- **探针**：`pnpm probe:elicit`（无人值守，不花钱）

### C8 · `-a never` 会自动 decline elicitation

审批模式和问人通道**在类型上互斥** —— 换 `-a never` 治许可门是死路。

- **依赖点**：§2.1 的出路清单里排除了一条
- **探针**：手动（改一次参数起一个会话即可验）

### C9 · 目录信任挡整轮，判据是 git 根

没信任的目录，Codex 停在「Do you trust…」上等人按，这一侧只见「没有新线程」。
判据是 **git 根**，不是 cwd 也不是祖先目录。

- **依赖点**：`codex/trust.ts` + 派发预检 `workspace_not_trusted`
- **探针**：手动（`trust.ts` 的读取逻辑有离线测试盯格式）
- **塌了会怎样**：config.toml 里 `[projects."…"] trust_level` 的格式变了，
  预检会**放行然后静默等满超时** —— 预检故意「查不出来就放行」。

### C10 · Codex 会把绑着的线程归档；resume 归档线程一起来就死

解药 `codex unarchive`。批准阶段后 StagePass 主动归档（`archiveFinished`）。

- **依赖点**：`codex/archive.ts`；`panel.js` 那句「跑 codex unarchive」的提示
- **探针**：手动

### C11 · 子 Agent 只继承全局 `config.toml`，不继承命令行 `-c`

- **依赖点**：插件对子 Agent 不可见的全部解释；查工具表别拿猜的名字问
- **探针**：手动（起一轮看反方手上有哪些工具）

### C12 · TUI 粘贴态：一次写入「文字+回车」回车会被吃掉

分两次写、中间隔 400ms，回车才算提交（`PanelSessions.type`）。

- **依赖点**：`web/panel-server.ts` `type()`
- **探针**：`pnpm probe:pty` 顺带覆盖（它就是靠这个机制答题的）

## 修订规矩

- Codex 升级后：先 `pnpm probe:all`，红了的条目对着「依赖点」栏排查。
- 新发现一条行为假设：**先写进这张表再写代码** —— 代码注释可以引用这里，
  别再把假设只埋在注释里（2026-08-03 的教训就是翻注释翻了半天）。
- 每条塌方都值一条 HANDOFF 记录 + 这里的日期更新。
