# StagePass 纯 App Server 分支交接

日期：2026-08-15

分支：`codex/native-streaming-app-server`

worktree：`/Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server`

## 当前结论

这个 worktree 是两条路线中的纯 App Server 路线。原工作区没有被合并或覆盖；本分支的
生产 Codex 边界只有 `codex app-server --listen stdio://`，没有 TUI、PTY、xterm、
rollout 文件或 `state_5.sqlite` fallback。

StagePass 继续拥有 Change、阶段、rubric、gap、job 和 gate。App Server 只拥有
thread、turn、item 以及协议级审批/elicitation。模型 turn 完成不会自动推进 StagePass
阶段，人的业务裁决仍走 StagePass 账本和 gate。

## 已落地

- App Server 的 initialize、thread start/resume/read/archive/unarchive、turn
  start/steer/interrupt、结构化 item/delta 和反向请求均有协议层实现与测试。
- 浏览器通过 snapshot + SSE 显示正文、推理、计划、命令、文件修改、MCP 和子 Agent，
  不解析 ANSI 终端画面。
- 归档 binding 先走公开的 `thread/list` / `thread/unarchive` / `thread/resume`；只有
  App Server 明确返回 missing 才解绑，超时或断线不会误删 session binding。
- 历史和子 Agent 血缘只从 `thread/read` 读取，不碰 Codex 私有目录或数据库。
- 浏览器只接收最小归一化数据：单 item 256 KiB，replay 512 条且 2 MiB；未知 payload、
  JSON-RPC id 和协议额外字段不透传；MCP 链接只允许 HTTP(S)。
- 旧 `/pty/...` 路由已移除，`node-pty` 与 xterm 依赖已移除。

## 真实数据恢复证据

使用真实数据库 `/Users/zhanghr/.stagepass/panel.db` 打开 `CHG-001 / PRD`：

- StagePass binding：`019fd6d4-0a71-7052-92ae-71a09e7b197e`；
- App Server 恢复后的 thread id 与 binding 完全相同；
- last turn：`019fd70e-528c-7eb0-912d-a1a6eff70779`，状态 `completed`；
- 恢复出 42 个结构化历史 item，当前没有 active turn 或 pending interaction；
- 验收只读历史，没有发送新 prompt，也没有推动 StagePass gate。

这证明“全部 session 被 archive 后无法恢复”的永久修复走的是公开 App Server 协议，
不是读取私有 session 文件的临时补丁。

## 唯一启动方式

先在旧进程所在终端按 `Ctrl-C`，再执行：

```bash
cd /Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```

面板只监听 `127.0.0.1:4173`。不要在这个 worktree 另起其他 StagePass 端口。

## 继续开发前先读

1. `docs/CODEX-CONTRACT.md`：当前运行时契约和安全边界；
2. `docs/superpowers/specs/2026-08-15-app-server-native-streaming-design.md`：架构决策；
3. `docs/evidence/app-server-native-streaming-2026-08-15.md`：本轮验收证据；
4. `docs/superpowers/plans/2026-08-15-app-server-native-streaming.md`：实现步骤与提交边界。

升级 Codex 后先运行 `pnpm schema:app-server`，再运行 `pnpm check`，随后只在 4173 做
真实 start/resume/stream/interaction/interrupt/restart 验收。
