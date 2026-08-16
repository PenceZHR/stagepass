# StagePass 无 tmux 原生 TUI 分支交接

日期：2026-08-16

分支：`codex/native-streaming-app-server`

worktree：`/Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server`

## 当前结论

这是当前交接文档；`HANDOFF-2026-08-15-app-server.md` 记录的是已被替代的浏览器原生渲染
阶段。本分支现已彻底移除 tmux、PTY、xterm 和浏览器终端：managed App Server daemon
保存 thread/turn/history，Terminal.app 中的官方 Codex TUI 是唯一交互客户端，StagePass
Web 只负责业务状态与打开、聚焦、关闭、恢复对应的系统终端。

原 worktree `/Users/zhanghr/Desktop/stagepass` 未被覆盖。真实数据库和全部既有 binding
继续复用，不迁移、不复制、不读取 Codex 私有 session 文件。

## 不可破坏的 MCP 所有权规则

App Server 的 `thread/start` / `thread/resume` 会让调用连接成为该 thread 的订阅者。若
StagePass 控制连接保持订阅，MCP approval/elicitation 可能被路由给 StagePass，而不是
原生 TUI；旧实现把所有反向请求统一拒绝，于是 TUI 显示 `user rejected MCP tool call`。
MCP server 实际没有失败，是反向请求 owner 错了。

永久规则：

1. StagePass 只在创建/恢复时短暂打开 App Server session，用当前 Change/seat config
   初始化 thread 并完成 binding。
2. 向 Terminal 投递任何文件信封前，同一控制连接必须完成 `thread/unsubscribe`，随后
   释放本地 session。
3. 已打开的 TUI 不允许被控制连接再次 `thread/resume`；只确认控制连接未订阅。
4. 状态用不含 turns 的 `thread/read` 查询；起止和结果只轮询 `thread/turns/list` 的
   有界最近页。新 turn 通过唯一文件信封精确匹配，完成通过同一 turnId 判断；精确中断
   只调用 `turn/interrupt`。
5. approval、MCP tool approval、MCP elicitation、快捷键和 Ctrl+C 只属于官方 TUI。
   StagePass 浏览器和控制连接都不代答。

## 运行链路

```text
StagePass Web -> StagePass backend -> managed App Server (provision/read/archive)
                         |
                         +-> Terminal.app -> official codex resume TUI
                                                   |
                                                   +-> StagePass MCP -> StagePass ledger
```

完整 prompt 只写入权限受限的临时文件。Terminal/TUI 只收到一行短文件信封；轮次明确终态
后删除文件。StagePass 不读取或渲染 Terminal 字节。

## MCP 故障与验收证据

故障线程为真实 `CHG-002 / PRD`，threadId
`01a0058a-f372-7d12-9ed5-3dad47c7718e`。修复前 TUI 明确显示
`Error: user rejected MCP tool call`；停掉 StagePass 控制连接而保留 daemon/TUI 后，同一
thread 立即由官方 TUI 显示一次性 MCP tool approval，随后显示 StagePass 的 10 字段业务
表单。这一对照证明 MCP server 正常，拒绝来自错误的 App Server 连接 owner。

修复后：

- 类型检查通过；完整测试为 1093/1093、249 suites、0 fail、0 skipped；
- 回归测试覆盖新 thread、关闭后 resume、已打开 TUI 三条路径，且在 Terminal 收到信封前
  强制断言最后一个所有权操作是 `thread/unsubscribe`；
- 真实 4173 实例对当前 `CHG-002 / PRD` 执行 `/api/terminal/open`，在不提交任何输入的
  前提下完成真实 daemon `thread/unsubscribe`，返回原 threadId、`thread=running`、
  `terminal=open`、`action=focus`；
- 当前业务选择保持 pending，验收没有替用户选择任何产品答案。

## 唯一启动方式

```bash
cd /Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```

只能监听 `127.0.0.1:4173`。端口占用时先停止原实例，不换端口、不并行启动第二份。

## 继续开发前先读

1. `docs/CODEX-CONTRACT.md`：当前运行时与 MCP 所有权契约；
2. `docs/superpowers/specs/2026-08-16-native-tui-without-tmux-design.md`：无 tmux 设计；
3. `docs/superpowers/plans/2026-08-16-remove-tmux-native-tui.md`：迁移执行记录；
4. `docs/BACKLOG.md`：唯一遗留事项入口。

升级 Codex 后先生成并核对官方 App Server schema，再跑类型检查和完整测试，最后只在
4173 真机验证 start/resume、文件信封、MCP approval/elicitation、interrupt、窗口关闭与
恢复。任何实现都不得用“拒绝反向请求”冒充只读观察者。
