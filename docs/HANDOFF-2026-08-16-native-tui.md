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
继续原位复用，不复制、不读取 Codex 私有 session 文件；本分支只对真实库执行幂等 schema
迁移，新增 append-only 的 `stage_round_artifacts`，不回填或猜测旧轮次事实。

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

- 类型检查通过；本轮持久状态恢复修复后的完整测试为 1101/1101、250 suites、
  0 fail、0 skipped；
- 回归测试覆盖新 thread、关闭后 resume、已打开 TUI 三条路径，且在 Terminal 收到信封前
  强制断言最后一个所有权操作是 `thread/unsubscribe`；
- 真实 4173 实例对当前 `CHG-002 / PRD` 执行 `/api/terminal/open`，在不提交任何输入的
  前提下完成真实 daemon `thread/unsubscribe`，返回原 threadId、`thread=running`、
  `terminal=open`、`action=focus`；
- 验收代码没有调用 Terminal `submit`、没有写 `answers`、没有选择业务项。随后只读审计
  发现该问题已在 `2026-08-16T08:59:41.072Z` 经 TUI/MCP 路径变为 `answered/accept`，
  thread 也已 idle；仅凭账本无法判定是谁在 TUI 中完成了选择，因此不把它归因于验收。
当前仍没有 `CHG-002` 的 `change_briefs` 行。

## 进程重启后的状态流恢复（同日补记）

真实 `CHG-002 / PRD` 暴露了第二个独立故障：TUI/MCP 已经把 10 个回答完整写进
`questions`，但面板进程在等待协程把回答生成 brief 之前重启。HTTP 协程消失，持久库中
留下 `questions.status = answered`、`outcome_json = NULL`、无 `change_briefs`；旧实现下次
会重新跑模型、重新提问，所以页面看起来像整个状态流失效。

现在的恢复规则是：

1. clarification、gate decision、waive 都先找同 Change / phase 下已经回答但未消费的题；
2. 恢复只使用持久化的原题 schema 和原答案，不拿新模型提案套旧答案；两趟表单用确定的
   `-x` 子题 id 继续；
3. brief 与相关题的 settle 在同一个 SQLite 事务中提交；
4. 面板明确显示「恢复上次回答」，不会静默重问或静默应用；快速恢复也不会误闯
   Terminal、卡在旧页面；
5. 面板重启后不再拿进程内 `liveSeats` 冒充持久会话是否存在，按 binding / App Server
   thread 恢复；
6. retry 派发前检查失败会记录失败并把 `running` 回滚到 `blocked`，不会留下
   `running` 但没有 job 的假状态。

验收证据：

- 新增纯业务验收从 `PRD/pending → brief → running → settled → approve → Spec/pending`，
  并核对 ledger 只有 create/start/settle/approve；
- 用真实数据库的隔离副本在 4173 复现并恢复 `CHG-002`，页面、HTTP 与 SQLite 三层一致；
- 切回真实库后只读核对：页面显示「恢复上次回答」，运行按钮禁用；数据库仍为
  `briefs=0`、原题 `answered` 且未消费；没有自动应用那份可能不符合当前 Cocos 项目的
  历史回答；
- `/api/terminal/status` 返回同一 threadId，`thread=idle`、`terminal=open`、
  `action=focus`；服务日志无错误。

## Stage 产物驾驶舱（同日完成）

阶段页不再是一块空白终端入口。现在它是一张只读的产物驾驶舱，沿用项目既有黑洞/轨道
视觉语言，但把结构判断留给人、文件细节留给 Codex：

- 顶部固定显示阶段、持久状态、轮次、未决问题、下一步和显式的 macOS Terminal 控制；
- 主画布按本轮文件、目录和生产关系投影结构，文件多时聚合目录，完整文件始终可从键盘可用
  的横向清单进入；右侧常驻正文、DIFF、来源/依赖和关联问题；底部能回放已结算轮次；
- PRD / Spec / Arch / BuildPlan / TestPlan / Build / Test / QA 各自有语义适配，默认选中对应角色
  的产物；Build 不再先打开 critic 文档；
- 历史轮次只有在 Git 证据可证明时才保守重建。证据不足会明确显示“历史清单不完整”，
  不拿当前工作树冒充过去；目录不是 Git 仓库时同样响亮降级；
- 新结算轮次的 manifest 与 evidence、gap、settle 在同一事务提交；重放幂等，冲突重放失败；
- 文件读取受 Change → Project → repository root、commit fence、路径白名单、realpath/symlink、
  2 MiB、binary 和历史删除约束保护。浏览器不能传 commit/ref；两个新接口只有 GET；
- 进入驾驶舱只刷新终端状态，不自动打开、聚焦 Terminal，也不启动 turn 或推动闸门；退出时
  原样恢复进入前的 Workspace 收起状态。

验收证据：

- `pnpm typecheck` 通过；`npm test` 为 1133/1133、259 suites、0 fail；
- 在 4173 用真实数据库的隔离副本完成搜索、轮次 1 回放、轮次 2 不完整提示、正文、DIFF、
  来源/依赖、返回阶段环和重新进入；浏览器控制台 0 error/warning；
- 浏览前后隔离库计数逐项相同：`66|0|110|89|174|10|0|76`，证明没有启动 turn、回答问题
  或推进闸门；
- 截图：`docs/evidence/screenshots/stage-artifact-cockpit-2026-08-16.png`；
- 真实库启动前备份到 `/private/tmp/stagepass-panel-before-cockpit-2026-08-16.db`，随后只新增
  `stage_round_artifacts` 表，当前 0 行；真实 `CHG-002` 启动和浏览前后始终为
  `PRD/blocked`，业务计数始终 `1|0|6|4|3|0|0`；最新 clarification 仍是
  `outcome={kind:unanswered, reason:session_died_before_answering}`，没有自动应用旧选择；
- 真实页面明确显示“请 Codex 问我”和上轮失败原因；浏览器控制台无错误。

设计与实施依据：

1. `docs/superpowers/specs/2026-08-16-stage-artifact-cockpit-design.md`；
2. `docs/superpowers/plans/2026-08-16-stage-artifact-cockpit.md`。

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
