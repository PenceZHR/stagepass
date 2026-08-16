# StagePass

[English](README.md) · **简体中文**

> **模型不能自己给自己放行。**

StagePass 是一个 **macOS 原生的 Codex 本地交付控制面**。它给一次软件改动一条可追溯的
流程、独立对抗审查、可见的阶段产物，以及每个闸门上由人掌握的最终决定。浏览器负责
把控结构和展示事实；Terminal.app 里的官方 Codex TUI 负责所有交互 turn、MCP 提问、
审批和中断。

StagePass 明确只定位于 macOS。它不提供浏览器终端、PTY 兼容层、tmux 会话管理，也不
承诺 Windows / Linux 的替代运行方式。

## 为什么需要它

让模型自己判断“这一阶段做完了吗”，等于让它给自己批卷。普通 Agent 流程里，上一轮
的问题可能因为下一轮没再提就消失；一句自信的“没有阻塞项”可能打开闸门；同一个推理
错误还可能同时进入实现和测试。

StagePass 用硬规则处理这些问题：

1. **沉默不能关闭问题。** gap 跨轮保留，只有带理由的复核或人的明确决定才能改变它。
2. **闸门读取持久事实。** 阶段只能通过状态机和账本推进，不能因为界面文本看起来成功。
3. **模型不拥有最终裁决。** 业务选择通过 Codex MCP elicitation 正面问人，再由唯一一条
   StagePass 用例写入账本。
4. **Build 与 Test 互盲。** 两轨只共享 Arch 契约，不读取对方实现，最后在 QA 对撞。
5. **模型不手抄标识符。** 精确 ID 来自协议和数据库事实；模型只输出枚举选择和散文。

## 八阶段钻石

```text
PRD → Spec → Arch → BuildPlan ─→ Build ─┐
                  └→ TestPlan  ─→ Test ─┴→ QA
```

Arch 是分叉点。BuildPlan/Build 与 TestPlan/Test 形成两条受控轨道。QA 运行真实测试、
用变异攻击测试本身，再把失败归因到 Build、Test 或 Arch。打回就是重走：依赖被否定事实
的下游批准不会被静默保留。

每个活动阶段都跑一轮对抗：

```text
红方产出 → 蓝方攻击 → 裁判裁定 → rubric 角色出分 → 人的闸门
```

## Stage 产物驾驶舱

打开阶段后，现在进入的是只读产物驾驶舱，不再是一整页空白的 Terminal 跳转入口。它
展示：

- 这一轮实际消费的上游 Stage 证据；
- 真实目录，以及每个新增、修改、沿用、删除或替换的文件；
- 以生产谱系为大结构的阶段星图；
- 选择代码文件后才出现的直接依赖、被依赖和爆炸半径；
- 历史轮次固定下来的正文与 Git diff；
- 文件级问题、Stage 级问题和明确的下一步；
- 始终可见、但与浏览动作分开的“打开 / 聚焦 Codex”按钮。

驾驶舱读取 append-only 的逐轮产物账本。旧轮次只能通过精确的 Stage 路径或已有 evidence
commit 保守重建；证据不够就明确标成“不完整”，不会拿当前工作树冒充过去。文件读取
同时受 Change → Project 归属、manifest 路径白名单、realpath、大小和账本 commit 限制；
浏览器不能提交任意 Git ref。

每个文件都能从键盘可聚焦的清单进入。WebGL 不可用时，空间场景会降级为二维目录投影，
不会丢文件，也不会丢详情入口。

## 项目黑洞图

阶段环中心的太阳打开整个项目的依赖图。依赖由 TypeScript 编译器解析，不靠正则猜：

- 黑洞代表依赖压力。被依赖得越多的层越靠中心，爆炸半径大的模块越向内沉；
- 健康依赖向内，向外爬的弧直接暴露分层违规；
- Arch 产出 `arch.graph.json`，StagePass 把图纸的概念和关系与真实代码机械对账并叠在图上；
- 素材与生成目录按项目持久判据留在代码场景之外。

项目黑洞回答“这个仓库是什么结构”；Stage 驾驶舱回答“这一轮生产了什么”。二者共享
美术语言，不共享业务状态。

## 原生 Codex 的所有权

StagePass 保存耐久的 Codex App Server thread 和归一化生命周期事实。Terminal.app 中
的官方 Codex TUI 始终是唯一交互客户端：

- 键盘输入、ANSI 颜色、MCP 表单、审批和 `Ctrl+C` 都由 Terminal 直接承载；
- 浏览器不接收、不重绘终端字节；
- 关闭 Terminal 窗口只丢弃这个客户端，再打开会 resume 同一个已绑定 thread；
- 进入 Stage 只刷新终端状态。只有人点击明确按钮时才打开或聚焦 Terminal。

第一次使用时，macOS 可能要求运行 StagePass 的进程获得 Terminal 自动化权限。请在
**系统设置 → 隐私与安全性 → 自动化**中允许。StagePass 无法唯一识别受管 Terminal
窗口时会失败关闭，不会猜一个窗口操作。

## 当前真实状态

| 能力 | 状态 |
|---|---|
| SQLite 状态机、闸门、租约与崩溃恢复 | 已实现，并由离线套件覆盖 |
| 八阶段钻石、两轨互盲、QA 归因与打回重走 | 已实现；真实 Change 走过这条环 |
| managed App Server thread + 官方原生 Codex TUI | 已实现，之前已在 macOS 真机验收 |
| 项目黑洞图 + Arch 对账 | 已实现，之前已在 macOS 真机验收 |
| append-only 逐轮产物 + Stage 驾驶舱 | 已在这个实验 worktree 实现；最终 4173 浏览器证据记录在当前交接文档 |
| StagePass 完整生产并交付自己的下一次 Change | 还没挣到；这仍是 bootstrap 的判据 |

这里没有任何跨平台运行承诺。渲染面只是投影，不是决策权威：查看 Stage、文件、轮次或
图谱都不能启动 turn，也不能写业务状态。

## 只在 4173 启动

环境要求：

- macOS 与 Terminal.app；
- Node.js 20+ 与 pnpm；
- 支持 `codex app-server` 的 Codex CLI；
- macOS 允许 StagePass 控制 Terminal 的自动化权限。

安装并校验：

```bash
pnpm install
pnpm check
```

在这个 worktree 启动真实本地控制面：

```bash
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```

然后打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)。**4173 是唯一支持的产品端口**：
如果被占用，先停掉旧 StagePass，再在 4173 重启；不要换端口并行起第二份。

不带 `--db` 时，面板会建立一个用于隔离查看的临时数据库。除非明确给出真实数据库路径，
它不会迁移或替换真实数据。

## 架构边界

| 区域 | 负责 | 明确不负责 |
|---|---|---|
| `src/domain`、`src/store`、`src/app` | 状态、闸门、证据、问题与裁决 | 渲染 |
| `src/work`、`src/codex`、`src/system` | job、Git 事实、App Server 协议、原生 Terminal 生命周期 | 浏览器 UI 决策 |
| `src/graph` | 编译器依赖图、确定性布局、安全产物读取 | 流程状态转移 |
| `src/web` | 只读投影、HTTP 边界、原生客户端控制 | 终端字节或第二条裁决路径 |
| `src/plugin` | MCP elicitation 桥 | 判断什么操作合法 |

SQLite 是唯一业务权威，状态更新必须在写入时带着匹配的账本事实。
`src/architecture.test.ts` 机械守护向下分层、生产 export 必须有调用者、阶段词汇唯一、生产
运行时没有 PTY / 私有状态路径，以及单函数和依赖闭包棘轮。

关键文档：

- [`docs/PRD-stagepass-rebuild-2026-07-28.md`](docs/PRD-stagepass-rebuild-2026-07-28.md) —— 产品唯一权威
- [`docs/BACKLOG.md`](docs/BACKLOG.md) —— 未完成事项的唯一清单
- [`docs/HANDOFF-2026-08-16-native-tui.md`](docs/HANDOFF-2026-08-16-native-tui.md) —— 当前 worktree 与验证交接
- [`docs/CODEX-CONTRACT.md`](docs/CODEX-CONTRACT.md) —— 实测 App Server 行为契约
- [`docs/superpowers/specs/2026-08-16-native-tui-without-tmux-design.md`](docs/superpowers/specs/2026-08-16-native-tui-without-tmux-design.md) —— 原生 TUI 所有权契约
- [`docs/superpowers/specs/2026-08-16-stage-artifact-cockpit-design.md`](docs/superpowers/specs/2026-08-16-stage-artifact-cockpit-design.md) —— 驾驶舱设计与验收标准

## 许可

[MIT](LICENSE)
