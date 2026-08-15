# StagePass 原生 Codex TUI 与系统终端桥接设计

日期：2026-08-15

分支：`codex/native-streaming-app-server`

worktree：`/Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server`

## 1. 决策

本分支从“StagePass 在浏览器重画 App Server 结构化流”迁移为“StagePass 管流程，系统
Terminal.app 展示官方 Codex TUI”。原 worktree 与其他 worktree 不修改、不合并。

唯一生产链路是：

```text
StagePass Web
    │ 打开 / 聚焦 / 关闭
    ▼
StagePass 本机后端 ── macOS Automation ──> Terminal.app
    │                                      │ attach / detach
    │ 业务状态与线程绑定                    ▼
    ├──────────────> Codex App Server daemon <── tmux 中的官方 remote TUI
    │                                                   │
    └──────────────> StagePass SQLite <── StagePass MCP ┘
```

App Server daemon 拥有 thread、turn 与历史；tmux 拥有长生命周期 TUI 进程；官方 Codex
TUI 是输入、审批、MCP elicitation、快捷键、颜色与中断的唯一交互面；Terminal.app 只是
可关闭、可重开的系统窗口；StagePass 继续拥有 Change、阶段、rubric、gap、job、gate
与 binding。

StagePass 不再：

- 在浏览器渲染 Codex 正文、命令、推理或审批表单；
- 通过另一条 App Server 客户端为交互线程调用 `turn/start`；
- 解析 TUI ANSI 输出作为业务事实；
- 把关闭 Terminal 窗口解释为终止 Codex 或解绑 thread。

## 2. 已批准的产品语义

1. 点击阶段的主操作会打开对应的系统 Terminal.app 窗口；窗口已经存在时只聚焦。
2. 每个 `(Change, seat)` 最多一个 tmux session、一个 Codex thread、一个可见终端窗口。
3. “跳转终端”激活 Terminal.app 并只抬起目标窗口或标签页。
4. “关闭终端”只关闭目标 Terminal 窗口；tmux、TUI、进行中的 turn、pending approval
   与 MCP elicitation 继续存在。
5. 再次打开时 attach 原 tmux session，回到原 TUI 画面，不创建 thread、不重复 turn。
6. 真正终止 tmux 只发生在明确的阶段归档、Change 删除、项目删除或用户选择的
   “结束会话”操作；普通关闭窗口绝不终止。
7. StagePass 面板仍只监听 `127.0.0.1:4173`，不另开产品端口。

## 3. 三层运行时

### 3.1 Managed App Server daemon

StagePass 启动时检查并启动 Codex 自带的 managed daemon。StagePass 的结构化控制连接
通过 `codex app-server proxy` 接入默认 daemon socket；官方 TUI 使用：

```bash
codex resume --remote unix:// <thread-id>
```

新 thread 由 StagePass 在显式“打开终端/开始阶段”时通过 App Server 创建，并在创建时
注入该 Change/phase 的 StagePass MCP 配置。daemon 重启或 thread 尚未加载时，StagePass
先用同一配置执行 `thread/resume`；随后 remote TUI 只连接已加载 thread，不自行覆盖
config。StagePass 不对 daemon 中已经加载的 thread 重复 resume，因为这类 override
不保证生效。这样也避免 MCP tool approval 与业务 elicitation 落到错误客户端。

绑定规则相应收窄为：仅浏览阶段仍不创建 thread；用户显式打开原生终端时创建并绑定
空 thread 是有效意图。已有 binding 必须原样恢复；archived 先 unarchive；只有 App
Server 明确认定 missing 才 detach 并新建。

### 3.2 tmux 会话

tmux session 名由 `(changeId, seat)` 经过固定哈希得到，只含安全字符，不把标题、路径或
提示词放进名字。tmux 在项目目录启动官方 Codex remote TUI，并使 TUI 在 Terminal 窗口
关闭后继续运行。

StagePass 只使用 tmux 的公开命令做：

- `has-session`：探测是否存在；
- `new-session -d`：创建唯一 session；
- `attach-session`：由 Terminal.app 窗口 attach；
- `list-clients` / `display-message`：只读状态；
- `load-buffer` + `paste-buffer`，再单独 `send-keys Enter`：给已就绪 TUI 递交任务；
- `detach-client`：关闭可见窗口前安全 detach；
- `kill-session`：仅用于明确终止。

提示词正文继续遵守 StagePass 的文件契约：详尽内容写入临时文件，交给 TUI 的只有短
信封与文件路径。提示词不进入 tmux/Terminal 启动命令，也不从终端输出反解析结果。

### 3.3 Terminal.app 窗口

StagePass 后端使用固定 AppleScript 模板控制 Terminal.app。动态值只能通过 argv 进入
模板，且 tmux 名、窗口 marker 都先经过白名单校验。Terminal `do script` 与 tmux 的
`shell-command` 边界只允许固定 launcher 和白名单 token；统一编码器负责 shell quoting，
禁止标题、路径、提示词或其他自由文本进入命令串。

窗口标题包含不可与普通终端混淆的 StagePass marker。窗口 id 只作进程内加速缓存，
不是持久身份；StagePass 重启后按 marker 重新发现。所有操作在执行前同时核对 marker
与 tmux session，防止窗口 id 重用后误关用户的其他终端。

首次控制 Terminal.app 时，macOS 可能要求 Automation 权限。拒绝或撤销权限必须返回
稳定错误，不得假装窗口已经打开。

## 4. 交互所有权与任务派发

官方 remote TUI 是每条交互 thread 唯一的 turn owner。StagePass 的 App Server 连接
只创建/恢复/读取/归档 thread 和观察终态，不替 TUI 回答反向请求。

首个自动任务可以作为 `codex resume ... <prompt>` 的 argv 交给 TUI；已经运行的 TUI
通过 tmux buffer 粘贴文本，再以独立按键发送 Enter。StagePass 为每个 seat 持有输入
lease，只有 TUI 已存在、thread idle、没有 pending StagePass 输入时才允许递交。输入
失败不能留下“已派发”的假账。

后台 runner 的完成判据继续来自 App Server 的 thread/turn 结构化事实：派发前记住
baseline turn id，输入后等待同 thread 出现新的 turn，并只接受该 turn 的明确 terminal
状态。StagePass 不读取屏幕字符判断是否完成。

审批、文件修改确认、权限请求、MCP tool approval 和 StagePass 业务 elicitation 全部
由官方 TUI 原生显示并回答。StagePass MCP 仍从 SQLite 读取当前 question/worklist，模型
不接触 question id、Change id 或 criterion key。

## 5. Web API 与界面

浏览器保留 StagePass 三列结构、阶段环、rubric、artifact 与业务状态，但移除
`codex-stream.js` 的正文流、composer、steer、interrupt 与 interaction dialog。

新增本机终端桥端点：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/api/terminal/status?change=&seat=` | thread、tmux、窗口与 turn 的归一化状态 |
| `POST` | `/api/terminal/open` | 创建/恢复 thread 与 tmux；打开或聚焦 Terminal |
| `POST` | `/api/terminal/focus` | 只聚焦已存在窗口；窗口已关则返回可恢复状态 |
| `POST` | `/api/terminal/close-window` | detach 并关闭对应 Terminal 窗口，保留 tmux/TUI |
| `POST` | `/api/terminal/end-session` | 显式确认后终止 tmux；不自动删除 thread binding |

阶段主操作按状态显示“打开终端”“跳转终端”或“重新打开终端”。关闭窗口是次要操作；
结束会话是破坏性操作，必须显式确认。界面不展示或模拟 Terminal 内容。

## 6. 状态与恢复

不新增持久化窗口 id。耐久事实来自现有 binding 与可重建的确定性名字：

- thread：`change_bindings`；
- tmux：由 `(changeId, seat)` 确定性生成；
- Terminal 窗口：由 marker 发现；
- turn：App Server `thread/read` / notification；
- StagePass 业务：现有 SQLite 账本。

启动巡检按以下顺序：

1. 启动/连接 managed App Server daemon；
2. 读取 binding 并区分 open、archived、missing、unavailable；
3. 探测对应 tmux session；
4. 发现 Terminal marker；
5. 只报告组合状态，不因窗口缺席杀 tmux，也不因 daemon 暂不可用解绑。

异常恢复：

- Terminal 窗口被手动关闭：状态变为 `detached`，tmux/TUI 不动；
- Terminal.app 被退出：同上；
- StagePass 重启：从 binding + tmux + marker 重建状态；
- tmux session 消失但 thread 存在：新建 tmux 并 remote resume 同 thread；
- daemon 重启：StagePass 等 daemon 恢复后，用原 config resume 尚未加载的 thread，再让
  TUI reconnect/attach；
- thread archived：unarchive 后恢复；
- thread missing：明确 detach，创建新 thread，并记录迁移原因；
- Automation 权限缺失：返回 `terminal_automation_denied`，tmux/TUI 状态不伪装；
- tmux 未安装：启动检查返回 `tmux_unavailable`，面板给出唯一安装指引。

## 7. 删除与归档

普通窗口关闭不改变业务状态。以下业务操作才清理运行时：

- 阶段被人的 gate 裁决批准：归档 thread，关闭 marker 窗口，终止对应 tmux；
- 删除 Change/项目：先尝试关闭窗口和 tmux，再按既有规则归档 thread；清理失败记录
  警告但不伪装成功；
- 用户显式“结束会话”：终止 tmux、关闭窗口，但保留 binding，下一次可以 remote
  resume；
- StagePass 服务退出：不终止 tmux、TUI 或 daemon，只关闭自己的控制连接。

## 8. 安全边界

- 所有 Web 端点继续只接受 loopback 请求，并校验 Change、seat 与 binding。
- `osascript`、`tmux`、`codex` 由进程 API 以 argv 启动；Terminal/tmux 必需的 shell
  command 只由固定 launcher 与白名单 token 生成，并有逐字符 quoting 测试。
- tmux session 名和 Terminal marker 是固定格式；用户输入、标题、路径不能进入命令名。
- prompt 走临时文件与 tmux buffer；不出现在进程标题、日志或 AppleScript 源码。
- 关闭窗口前必须重新验证 marker；任何歧义都 fail closed。
- 不记录 MCP 回答内容、token、环境变量或完整 prompt。
- App Server、Terminal 与 tmux 错误都映射为稳定 code，并保留原 binding。

## 9. 迁移边界

本次只改实验 worktree。现有真实数据库与 binding 全部复用，不修改产品项目源码。

生产路径将删除或退役：

- 浏览器 Codex stream surface、composer 与 interaction dialog；
- `/api/codex/turn`、`steer`、`interrupt`、`respond` 等由浏览器拥有 turn 的路径；
- StagePass 自己响应 App Server approval/elicitation 的会话逻辑；
- “只有 App Server client 能 spawn Codex”的旧架构护栏。

保留：

- App Server protocol/client/history/archive 与结构化终态读取；
- BindingStore、QuestionStore、WorklistStore、StagePass MCP；
- 现有阶段状态机、rubric、job、gate、artifact、归档与恢复规则；
- 4173 loopback 面板与现有视觉系统。

## 10. 验收标准

自动验证：

1. tmux 名生成、argv、AppleScript 参数、marker 校验与错误映射均有单元测试。
2. open/focus/close-window/end-session 是幂等的，且只作用于目标 seat。
3. close-window 后 tmux session 仍在；再次 open attach 同 session/thread。
4. StagePass 重启后不依赖内存 window id，仍能发现或恢复目标。
5. prompt 分两步写入与 Enter，输入 lease 防止重复派发。
6. browser 不再存在 Codex stream composer 或交互回答路径。
7. `pnpm typecheck` 与全量测试通过，架构护栏与新运行时一致。

macOS 真机验证：

1. 只在 4173 启动 StagePass；点击 PRD 打开真实 Terminal.app 与官方 Codex TUI。
2. 再点同阶段只聚焦，不新建 thread、tmux 或窗口。
3. 关闭窗口后真实 turn 继续；重新打开回到同一 TUI。
4. 原生颜色、方向键、斜杠命令、MCP tool approval、StagePass elicitation 与 Ctrl+C
   全部可用。
5. 浏览器“跳转终端”准确抬起目标窗口；“关闭终端”不误关其他 Terminal 窗口。
6. StagePass 重启、Terminal.app 退出和 daemon 重启后均能恢复同 thread。
7. 现有真实 binding 与历史保留；原 worktree 的 git 状态前后完全一致。

## 11. 依赖与官方接口

- Codex CLI 0.147.0：本机已验证 `codex resume --remote` 接受 `unix://`，并提供
  `codex app-server daemon` 与 `codex app-server proxy`。
- tmux：本机当前未安装；本方案经用户批准使用 Homebrew 安装并在启动时做版本检查。
- Terminal.app：通过 `/usr/bin/osascript` 的系统 Automation 接口控制。
- App Server 协议：
  `https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`。
- Codex TUI 与 resume：
  `https://github.com/openai/codex/blob/main/codex-rs/tui/tooltips.txt`。

## 12. 被拒绝的方案

### 浏览器嵌入 xterm

仍需 StagePass 持有 PTY 和终端渲染层，不能满足“系统原生终端、不在浏览器渲染”。

### 直接运行 Terminal 中的 Codex、不使用 tmux

关闭窗口会结束 TUI 客户端；pending approval/MCP 无法稳定保留，恢复只剩 thread 历史，
不等价于原地继续。

### 仅依赖 App Server daemon

线程可能继续，但关闭 TUI 时反向请求的交互 owner 消失；不满足关闭窗口后完整继续。

### macOS 自带 screen

无需安装依赖，但脚本控制、状态探测、窗口复用和颜色能力弱于 tmux，不作为生产路径。
