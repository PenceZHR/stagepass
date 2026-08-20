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

新项目会话的耐久规则已经补齐：进入一个没有 binding 的阶段只创建临时 thread，
`turn/start` 成功后才由 `PanelSessions` 写 binding。恢复、直接输入、brief/aside 和阶段
执行都经过同一个产品 facade；归档 thread 先解归档再恢复，missing 才解绑，unavailable
继续 fail closed。启动顺序则是先独占 `127.0.0.1:4173`，再碰 SQLite、恢复状态和启动
App Server，所以双启动不会先改真库再发现端口冲突。

`turn/start` 已成功、binding 却写失败时也不再退化成一个裸 SQLite 500：HTTP 返回
`thread_binding_failed_after_turn_start`，日志带 change/seat/thread/turn；同进程后续重试
沿用原 thread，不会为了补 binding 再开一条。

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
- 空历史 `userMessage` 占位不会再被画成“未识别项目”；favicon 已内联，健康页面不会
  额外请求一个不存在的 `/favicon.ico`。

## 真实数据恢复证据

使用真实数据库 `/Users/zhanghr/.stagepass/panel.db` 打开 `CHG-001 / PRD`：

- StagePass binding：`019fd6d4-0a71-7052-92ae-71a09e7b197e`；
- App Server 恢复后的 thread id 与 binding 完全相同；
- last turn：`019fd70e-528c-7eb0-912d-a1a6eff70779`，状态 `completed`；
- 恢复出 42 个结构化历史 item，当前没有 active turn 或 pending interaction；
- 验收只读历史，没有发送新 prompt，也没有推动 StagePass gate。

这证明“全部 session 被 archive 后无法恢复”的永久修复走的是公开 App Server 协议，
不是读取私有 session 文件的临时补丁。

## 新项目 CHG-002 真实验收

使用真实数据库打开 `CHG-002 / PRD`，进入阶段时新 thread 不落 binding；从浏览器发出
首个真实 turn 且 `turn/start` 成功后，StagePass 才绑定
`01a0058a-f372-7d12-9ed5-3dad47c7718e`。服务重启及全新 Chrome profile 再进 PRD，
恢复出的仍是这个完整 thread，10 个历史 item id 全部唯一，正文
`STAGEPASS_STREAM_OK` 仍在。

真实浏览器还走过 start、原生 delta、steer、exact-turn interrupt 和 StagePass MCP
human checkpoint。MCP 提问处选择了“不回答”，因此没有替用户编造产品要求：
`brief` 仍为 null、Change 仍在 `PRD / pending`，产品目录没有被写入。

最终 `pnpm check` 为 1,073/1,073 tests、243 suites、0 fail、0 skipped；全新浏览器的
控制台错误、运行时异常、失败网络请求和失败资源均为 0。双启动真实实验返回
`EADDRINUSE`，binding 前后完全相同，原服务保持可用。完整记录见
`docs/evidence/new-project-app-server-durability-2026-08-15.md`。

## 唯一启动方式

先在旧进程所在终端按 `Ctrl-C`，再执行：

```bash
cd /Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```

面板只监听 `127.0.0.1:4173`。不要在这个 worktree 另起其他 StagePass 端口。
端口已经占用时不要“再试一次”或换端口；第二个实例会在打开数据库之前以
`EADDRINUSE` 退出。先回到正在运行的那个 4173，或在它的终端按 `Ctrl-C` 后再执行
上面的唯一命令。

## 继续开发前先读

1. `docs/CODEX-CONTRACT.md`：当前运行时契约和安全边界；
2. `docs/superpowers/specs/2026-08-15-app-server-native-streaming-design.md`：架构决策；
3. `docs/evidence/app-server-native-streaming-2026-08-15.md`：本轮验收证据；
4. `docs/superpowers/plans/2026-08-15-app-server-native-streaming.md`：实现步骤与提交边界。
5. `docs/evidence/new-project-app-server-durability-2026-08-15.md`：新项目首 turn、重启、
   MCP 交互和端口碰撞的真机证据；
6. `docs/superpowers/specs/2026-08-15-new-project-app-server-durability-design.md`：耐久边界；
7. `docs/superpowers/plans/2026-08-15-new-project-app-server-durability.md`：本轮执行记录。

升级 Codex 后先运行 `pnpm schema:app-server`，再运行 `pnpm check`，随后只在 4173 做
真实 start/resume/stream/interaction/interrupt/restart 验收。
