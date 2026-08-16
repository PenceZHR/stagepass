# StagePass 无 tmux 原生 Codex TUI 设计

日期：2026-08-16

分支：`codex/native-streaming-app-server`

worktree：`/Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server`

## 1. 决策

本分支彻底移除 tmux。Codex managed App Server daemon 是 thread、turn 与历史的耐久
所有者；Terminal.app 中的官方 Codex TUI 是可关闭、可重建的原生客户端；StagePass
保存 `(Change, seat) -> threadId` binding，并负责打开、聚焦、关闭和恢复对应窗口。

唯一运行链路是：

```text
StagePass Web
    │ 只发本机窗口生命周期动作
    ▼
StagePass 后端 ── WebSocket ──> Codex App Server daemon
    │                                  ▲
    │ macOS Automation                 │ remote unix:// + threadId
    ▼                                  │
Terminal.app ──> 官方 codex resume TUI ┘
    │
    └────────────> StagePass MCP / SQLite
```

这里要求的是“会话连续”，不是“终端进程连续”。关闭 Terminal 窗口会结束该 TUI 客户端；
thread、历史和 daemon 状态不删除。再次打开时使用同一个 threadId 执行：

```bash
codex resume -c 'tui.terminal_title=[]' --remote unix:// --cd <project-path> <thread-id> [prompt-envelope]
```

Codex CLI 0.147.0 的本机帮助已验证 `resume` 同时接受 `[SESSION_ID] [PROMPT]`、
`--remote unix://` 和 `--cd`。

## 2. 已批准的产品语义

1. 每个 `(Change, seat)` 最多一个 bound thread、一个带 StagePass marker 的 Terminal tab。
2. 点击主操作：窗口存在且 TUI 活着时只聚焦；窗口关闭或 tab 已回到 shell 时，用同一个
   threadId 重新执行 `codex resume`。
3. 关闭窗口只结束 TUI 客户端，不归档、不解绑、不删除 thread。
4. 下一次打开直接恢复同一个 thread；不创建替代 thread，不复制历史，不重复已完成 turn。
5. thread archived 时先 unarchive；只有 App Server 明确认定 missing 才 detach binding 并
   fresh start。
6. 浏览器永远不渲染终端字节，不发送键盘事件，不代答 approval 或 MCP elicitation。
7. 面板仍只监听 `127.0.0.1:4173`，不新增产品端口。
8. 原 worktree 不修改；真实 StagePass 数据库和 binding 原样复用。

## 3. 运行时所有权

### 3.1 App Server daemon

StagePass 用 `codex app-server daemon start` 获取官方 `socketPath`，通过该 Unix socket 的
WebSocket 连接 App Server。此连接创建、恢复、读取和归档 thread，并观察结构化 turn
状态；它不替官方 TUI 发起交互 turn，也不回答反向交互请求。

新 thread 仅在用户显式打开阶段或派发阶段任务时创建，并用当前 Change/seat 的 cwd、
sandbox、approval policy、model、effort 与 StagePass MCP config 初始化。已有 binding
永远优先恢复。

### 3.2 Terminal.app 与官方 TUI

Terminal marker 继续由 `(changeId, seat)` 的固定哈希生成，但它只代表 StagePass 原生
客户端身份，不再代表 tmux session。marker 不含标题、路径、提示词或其他用户文本。
marker 写在 StagePass 创建的专用 Terminal tab `custom title` 中；resume 命令显式把
`tui.terminal_title` 设为空列表，避免 Codex 的 OSC 0 标题刷新覆盖 marker。状态判断使用
tab 的 `processes` 是否含 `codex`，不依赖 Terminal 的 `busy` 标志或易失的窗口 id。

Terminal 控制层提供五个能力：

- `status`：按 marker 返回 `closed`、`open` 或 `stale`；`stale` 表示 tab 仍在但 Codex
  前台进程已经退出。
- `open`：没有 marker 时新开 tab；stale 表示 `exec codex` 已结束、原 tab 没有 shell，
  因此安全关闭该专用 dead 窗口并新开 TUI；open 时只聚焦。两种恢复都沿用同一 threadId。
- `focus`：只抬起唯一目标窗口/tab，不创建客户端。
- `submit`：仅在目标 TUI 已打开、App Server 显示 thread idle 且 StagePass 持有输入
 lease 时，把短文件信封递交给该 tab。Terminal 把正文作为一次 paste 送入后等待 0.2 秒，
 再发送独立空回车，跨过 Codex bracketed-paste 边界并真正提交。
- `close`：只关闭唯一 marker 窗口；不触碰 thread binding。

AppleScript 源码固定不插值。动态值全部通过 argv 进入，随后由严格校验和统一 POSIX
shell quoting 生成固定命令。threadId 必须是 UUID；marker 必须符合 StagePass 格式；cwd
必须是绝对路径；完整 prompt 永远只存在于私有临时文件中。

### 3.3 StagePass binding

唯一耐久映射仍是现有 `change_bindings`。不新增窗口 id、进程 id、terminal tab id 或
tmux 字段。StagePass 重启后从 binding + App Server thread + Terminal marker 重建状态。

## 4. 任务派发

官方 TUI 继续是每条交互 turn 的唯一 owner。StagePass 不回退到浏览器 composer，也不
通过自己的 App Server 控制连接调用 `turn/start`。

派发流程：

1. 打开/恢复 bound thread，并记录 baseline lastTurnId；activeTurnId 非空则拒绝重复派发。
2. 把详尽 prompt 写入权限受限的临时文件，得到只含文件路径与动作的短信封。
3. 获取 `(Change, seat)` 输入 lease。
4. 若 TUI 未打开或 stale，执行带可选 `[PROMPT]` 的 `codex resume`；若 TUI 已打开，
   Terminal 控制层向唯一 marker tab 递交信封。
5. 从 App Server 等待同一 thread 出现 baseline 之后的新 turn，并观察明确终态。
6. 终态后释放 prompt 文件和输入 lease；失败时不写“已完成”的假状态。

审批、文件修改确认、权限请求、MCP tool approval、StagePass elicitation、快捷键和 Ctrl+C
仍全部出现在官方 TUI。StagePass 不解析 ANSI/屏幕文本作为业务事实。

关闭窗口时如果 turn 已在 daemon 中运行，StagePass 保留 binding 与结构化观察；重新打开
后 TUI resume 同一 thread。若当前 Codex 版本把特定交互请求绑定到已断开的客户端，turn
可保持 pending，重新连接后由官方 TUI 恢复；验收必须实测这一断连路径，不能仅靠单测
宣称。

## 5. Web API 与界面

`GET /api/terminal/status` 返回：

```text
changeId, seat, threadId, thread, terminal, action
```

不再返回 `tmuxSession` 或 `tmux`。`terminal` 是 `closed | open | stale | unavailable`；
`action` 是 `open | focus | resume`。

保留：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/api/terminal/status?change=&seat=` | thread 与原生客户端状态 |
| `POST` | `/api/terminal/open` | 创建/恢复 thread，并打开/恢复/聚焦官方 TUI |
| `POST` | `/api/terminal/focus` | 只聚焦已打开的唯一目标窗口 |
| `POST` | `/api/terminal/close-window` | 关闭 TUI 客户端，保留 thread/binding |

删除 `/api/terminal/end-session` 和浏览器里的“结束会话”按钮。无 tmux 后它与关闭窗口没有
独立运行时语义；归档仍由阶段批准、Change/项目删除等既有业务操作负责。

页面文案相应改为：

- 新 thread：打开系统终端；
- 已有 thread、窗口关闭/stale：恢复系统终端；
- TUI 已开：聚焦系统终端；
- 关闭按钮：关闭终端窗口，会话可再次恢复。

## 6. 清理、归档与恢复

- 普通 close-window：只关 Terminal，不归档、不解绑、不关闭 daemon thread。
- 阶段批准：关闭目标 Terminal，归档 thread，释放 StagePass observer。
- 删除 Change/项目：逐个关闭目标 Terminal，再按既有规则归档 thread；任何清理失败都
  阻止伪装删除成功。
- StagePass 退出：不关闭 Terminal、不归档 thread、不停止 daemon，只关闭自己的控制
  WebSocket。
- Terminal.app 被退出：状态变 closed；下次 resume 同一 thread。
- TUI 自己退出且 `exec` 进程完成：tab 状态变 stale；下次关闭 dead 窗口并用新客户端
  resume 同一 thread。
- daemon 重启：StagePass 用原 config 恢复 bound thread，Terminal 客户端重新连接。
- thread missing：明确 detach 旧 binding 后创建并绑定新 thread。

现有 `change_bindings` 无 schema 变化，不执行数据重写。旧 tmux session 是实验期瞬时运行
时，不是业务数据；切换时只终止能由 binding 映射出的 `sp_<hash>` session，绝不匹配或
清理用户的其他 tmux session。迁移完成后生产代码、测试、启动检查和文档中不再依赖 tmux。

## 7. 安全边界

- Web API 继续只绑定 loopback，并校验 Change 与 seat。
- AppleScript 只按唯一 marker 操作；重复 marker fail closed，不误关其他 Terminal 窗口。
- `codex resume` 命令只由固定 token、已校验 UUID、绝对 cwd 和已转义短信封组成。
- 详细 prompt 保存在私有临时文件，不进入 AppleScript 源码、日志或 marker。
- StagePass 不读取 Terminal 字节，不保存按键，不记录 MCP 回答或 approval 内容。
- Terminal Automation 权限缺失返回稳定 `terminal_automation_denied`，binding 保留。

## 8. 迁移删除面

必须删除：

- `src/codex/tmux.ts`、`src/codex/tmux.test.ts`；
- `NativeTuiTurnPort` 和所有 tmux ensure/submit/detach/kill 调用；
- 启动时 tmux version 检查与注入；
- status/API/UI 中 `tmux`、`tmuxSession`、`reopen via tmux` 文案；
- `/api/terminal/end-session` 与对应按钮、确认框和测试；
- 文档和架构护栏中把 tmux 当生产依赖的描述。

必须保留：

- managed App Server daemon WebSocket；
- binding、history、archive、session recovery；
- prompt file 与输入 lease；
- StagePass MCP、rubric、gate、job、artifact 与业务账本；
- 原生 Terminal marker 定位和 4173 视觉界面。

## 9. 验收标准

自动验证：

1. `rg -i tmux src scripts` 为零；生产依赖、API 类型和浏览器文案均无 tmux。
2. Terminal 命令构造、UUID/cwd/marker 校验、shell quoting 和错误映射有单元测试。
3. open/focus/close-window 对目标 seat 幂等，重复 marker fail closed。
4. close-window 后 binding/threadId 不变；再次 open 使用同一 threadId。
5. closed/stale TUI 的任务通过 resume `[PROMPT]` 发起；open/idle TUI 通过目标 tab 递交；
   busy 时拒绝重复输入。
6. 浏览器没有终端渲染、键盘、approval 或 `/api/terminal/end-session` 路径。
7. `pnpm typecheck`、全量测试和架构护栏全部通过。

macOS 真机验证：

1. 只在 4173 启动，点击阶段打开真实 Terminal.app 官方 Codex TUI。
2. 再点同阶段只聚焦，不创建第二窗口或 thread。
3. 关闭 Terminal 窗口后状态变 resume；再次打开恢复同一 threadId 和历史。
4. TUI 主动退出留下 stale dead tab 后，再打开会替换客户端并 resume 同一 threadId。
5. 运行中关闭窗口，再打开后结构化 turn 状态和 approval/MCP 行为可继续或明确恢复。
6. 文件信封任务能从 closed 和 open 两种状态各成功发起一次。
7. 原生颜色、方向键、斜杠命令、MCP、approval 与 Ctrl+C 可用。
8. 真实 binding/历史保留；原 worktree git 状态前后完全一致。

## 10. 方案比较与结论

### 采用：daemon 持久会话 + 可丢弃 Terminal TUI

组件最少，符合“关窗后按 threadId resume”的真实需求；代价是窗口关闭后不保留同一屏幕
进程，但这不是产品目标。

### 拒绝：tmux 持久 TUI

能保留原屏幕，但增加 session、attach/detach、输入 buffer、额外安装依赖与恢复矩阵。
这些复杂度只服务于“进程连续”，不服务于“会话连续”。

### 拒绝：StagePass 自持 PTY 或浏览器 xterm

重新引入终端模拟、ANSI 渲染、键盘和中断所有权，偏离原生 Codex TUI。

### 拒绝：StagePass App Server 直接 `turn/start`

会把 approval/MCP 反向请求的所有权拉回控制连接，破坏官方 TUI 是唯一交互面的约束。
