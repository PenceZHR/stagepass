# StagePass 纯 App Server 原生流式改造设计

## 1. 决策

本设计只作用于隔离分支 `codex/native-streaming-app-server`。原工作区继续保留官方
Codex TUI + PTY 路线，两条路不在同一运行时共存。

新分支的 Codex 边界只有一个：`codex app-server --listen stdio://`。StagePass 通过
App Server 的 JSONL JSON-RPC 协议创建或恢复 thread、启动 turn、接收增量事件、处理
审批与 MCP elicitation、发送 steer、执行 interrupt，并把这些结构化事件渲染成符合
StagePass 美术语言的原生界面。

新分支最终必须删除生产路径上的：

- `node-pty` 与 xterm；
- `codex resume`/TUI 子进程；
- 对 `~/.codex/sessions` rollout 文件的结果解析、活性探测和血缘识别；
- 对 `~/.codex/state_5.sqlite` 的可用性判断；
- `codex archive` / `codex unarchive` 命令包装。

App Server 进程仍是本地子进程，但它只充当公开的协议服务器，不充当终端画面。

## 2. 目标与非目标

### 2.1 目标

1. 模型正文按 `item/agentMessage/delta` 原生增量出现，不等待整轮结束。
2. 推理摘要、计划、命令、命令输出、文件修改、MCP 工具与子 Agent 都按结构化 item
   显示，不把 ANSI 文本反解析成卡片。
3. 用户可以在同一 turn 内发送 `turn/steer`，可以用 `turn/interrupt` 中断且保留
   thread。
4. 命令审批、文件审批和 `mcpServer/elicitation/request` 在 StagePass 内完成，回答
   直接回到原 JSON-RPC request id。
5. 浏览器断线重连时先收到 materialized snapshot，再从单调事件序号继续；StagePass
   服务重启时通过 `thread/resume`/`thread/read` 恢复，不读私有 rollout。
6. StagePass 的 Change、phase、binding、rubric、gap、gate 和人工裁决仍是业务权威；
   App Server 只拥有 Codex thread/turn/item 生命周期。
7. 视觉继续使用当前的暗紫云海、暖沙/灰粉、老式衬线、细描边圆环和克制的层级，
   不复制 Codex App 的品牌皮肤。

### 2.2 非目标

- 不在这个分支保留 TUI/PTY fallback。
- 不逐像素复制 Codex App 或 TUI。
- 不把 App Server 原始消息无校验地直通浏览器。
- 不把 StagePass 的 gate 决策移交给 Codex。
- 不实现远程、多租户或公网访问；面板仍只监听 `127.0.0.1:4173`。
- 不把整个 App Server 生成类型目录提交进仓库；只维护本功能用到的最小协议类型与
  运行时校验。

## 3. 协议基线

实现以本机 `codex-cli 0.147.0` 的
`codex app-server generate-ts --experimental` 输出为基线。所需稳定方法与通知：

- 握手：`initialize` → `initialized`；
- thread：`thread/start`、`thread/resume`、`thread/read`、`thread/archive`、
  `thread/unarchive`；
- turn：`turn/start`、`turn/steer`、`turn/interrupt`；
- 生命周期：`thread/started`、`turn/started`、`turn/completed`、`item/started`、
  `item/completed`；
- 增量：agent message、reasoning summary、plan、command output、file change 和 MCP
  progress 的 delta 通知；
- 反向请求：command approval、file change approval、permissions approval、MCP
  elicitation 和 tool user input。

App Server wire message省略 `jsonrpc: "2.0"`，每行一条 JSON。StagePass 必须容忍
stdout 分块和半行，按 request id 关联响应；stderr 只作诊断，不能混进协议流。

## 4. 组件与文件边界

### 4.1 协议客户端

`src/codex/app-server-protocol.ts`

- 定义本功能需要的 request、response、notification、server request 最小联合类型；
- 提供 `asRecord`、id/method 判别与 thread/turn/item 关键字段校验；
- 未识别通知允许进入诊断事件，但缺少关键身份字段的已识别通知必须拒绝。

`src/codex/app-server-client.ts`

- 唯一直接 spawn `codex app-server --listen stdio://` 的模块；
- 完成 initialize/initialized；
- 维护 pending request、超时、进程退出和 stderr tail；
- 把 notification 与 server request 分流；
- 关闭时先结束 stdin，再 SIGTERM，最后有界 SIGKILL；
- 不认识 StagePass 的 Change、phase、数据库或 UI。

### 4.2 Codex 会话与投影

`src/codex/app-server-session.ts`

- 一个长生命周期 App Server client 可承载多个 StagePass seat；
- `open` 根据 binding 调 `thread/resume`，没有 binding 调 `thread/start`；
- `startTurn`、`steer`、`interrupt` 使用当前 thread/turn id 的前置条件；
- 只接收属于本 session thread 的通知；
- 把 App Server 消息归一化为 `CodexStreamEvent`；
- 把 server request 保存为 pending interaction，等待 UI 回答后回写原 request id；
- turn terminal 后从完整 `turn.items` 得到最终 agent text，不靠 delta 拼接作为权威。

`src/codex/stream-state.ts`

- 定义 `CodexStreamEvent`、`StreamSnapshot`、`StreamItem`、`PendingInteraction`；
- 以 `item.id` upsert materialized state；
- 每个事件获得 session 内严格递增的 `seq`；
- 保留有界 replay ring，浏览器可按 `Last-Event-ID` 补发；
- terminal item 不允许被后续 delta 改写；未知 item 以 `unknown` 只读展示，不阻断整流。

`src/codex/app-server-transport.ts`

- 实现现有 `CodexTransport.runTurn`，让后台 round runner 也走 App Server；
- 新 thread 在 `thread/start` 返回后立刻调用 `onThread`；
- 等待目标 turn terminal，`completed` 返回最后 agent message，`failed`/`interrupted`
  分别抛具名错误；
- 不读取 rollout，不启动 TUI。

### 4.3 Web 边界

`src/web/stream-session.ts`

- 以 `(changeId, seat)` 注册 `AppServerSession`；seat 是 phase 或 `aside`；
- 与 `BindingStore` 对接，保证一 seat 一 thread、一 thread 不被两个 seat 共享；
- 提供 snapshot、subscribe、startTurn、steer、interrupt、respond、archive、close；
- `close` 只关闭当前订阅/会话对象，不杀共享 App Server 进程；
- 服务关闭时统一关闭 App Server client。

`src/web/panel-server.ts`

PTY 端点被以下结构化端点取代：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/codex/snapshot?change=&seat=` | 当前 materialized state |
| `GET` | `/api/codex/events?change=&seat=` | SSE 增量；使用 `Last-Event-ID` |
| `POST` | `/api/codex/open` | start/resume thread，不自动发 turn |
| `POST` | `/api/codex/turn` | 在 idle thread 发新 prompt |
| `POST` | `/api/codex/steer` | 给当前 inProgress turn 追加方向 |
| `POST` | `/api/codex/interrupt` | 中断当前 turn，保留 thread |
| `POST` | `/api/codex/respond` | 回答审批、elicitation 或 tool input |
| `POST` | `/api/codex/archive` | 仅在阶段批准后归档 thread |

所有写端点先校验 Change、seat、thread/turn precondition 和 JSON body。响应使用现有
`sendJson` 错误风格；协议错误有稳定 code，不把 stderr 或 token 暴露给浏览器。

### 4.4 浏览器渲染

`src/web/codex-stream.js`

- 加载 snapshot 后连接 SSE；
- 按 seq 幂等应用 event；
- 仅更新受影响 item，不重画整个对话；
- 断线以浏览器 EventSource 退避重连；若 replay gap，重新取 snapshot；
- composer 在 idle 时提交 turn、running 时提交 steer；
- interrupt 是显式按钮；Enter 提交、Shift+Enter 换行；
- interaction sheet 使用原生 `dialog`，保持键盘和焦点语义。

`src/web/panel.html`

- 保留三列工作区、阶段环、云海和现有 StagePass design tokens；
- stage view 的 xterm surface 换成结构化 stream surface；
- 正文使用现有 serif，元信息与命令使用 monospace；
- agent message 是正文流，不做卡片套卡片；tool/command/file change 以细分隔线折叠；
- running 用节点呼吸与细光标，不用高饱和 loading spinner；
- approval/problem 仍同时使用形状与文案，颜色不是唯一信号；
- 移除 xterm 脚本与 CSS。

## 5. 数据流

### 5.1 打开阶段

1. 浏览器 `POST /api/codex/open`。
2. `StreamSessions` 查 binding。
3. 有 binding：`thread/resume { threadId, cwd, ... }`；不存在或 App Server 明确返回
   not-found：原子 detach 后 `thread/start`。
4. 新 thread 立即 bind；resume 不改变 binding。
5. 服务端从 response 的 `thread.turns`/`initialTurnsPage` 建 snapshot。
6. 浏览器获取 snapshot 并订阅 SSE。

### 5.2 原生流式 turn

1. 浏览器提交 prompt，服务端调用 `turn/start`。
2. `turn/started` 建 turn；`item/started` 建 item；delta 追加局部内容。
3. 命令、文件修改、MCP 工具与子 Agent 以各自 item 类型更新。
4. server request 到来时生成 pending interaction，SSE 立即通知 UI。
5. 用户回答后 `respond` 回写原 JSON-RPC id，interaction 标记 resolved。
6. `turn/completed` 固化 terminal 状态；completed item/turn 是最终权威。

### 5.3 steer 与 interrupt

- steer 必须携带当前 `expectedTurnId`；turn 已变更返回 `stale_turn`，不得偷偷开新 turn。
- interrupt 必须携带当前 threadId/turnId；成功后等待 `turn/completed(status=interrupted)`。
- interrupted thread 保持 binding，下一条 prompt 仍在同 thread 上 `turn/start`。

### 5.4 断线与重启

- 浏览器断线：replay buffer 覆盖时补事件；超出窗口返回 snapshot-required 事件。
- App Server 进程意外退出：所有 pending RPC 和 interaction 失败为
  `app_server_disconnected`；本轮不得伪装完成。
- StagePass 服务重启：binding 仍在 SQLite；第一次打开时 `thread/resume` 重建完整
  snapshot。若 thread 正在运行，resume rejoin 并继续收事件。
- App Server 明确说 thread 不存在时才 detach；普通连接错误不 detach。

## 6. StagePass 业务权威

纯 App Server 改造只替换 Codex I/O 与展示，不改变：

- Change/phase 状态机；
- Job lease、deadline、recover 与 fence；
- artifact、gap、rubric、round note；
- 一次只问一个 StagePass question 的业务规则；
- 人类批准后才推进 gate；
- 批准阶段后才 archive 对应 thread。

`stagepass_*` MCP Server 继续存在。区别是它的 elicitation 不再由 TUI 画，而是作为
`mcpServer/elicitation/request` 进入 StagePass interaction sheet；模型仍不能替人
回答，UI 也不能绕过 `QuestionStore` 直接推进状态。

## 7. 错误模型

稳定错误码至少包括：

- `app_server_unavailable`：进程无法启动或握手失败；
- `app_server_disconnected`：运行中退出；
- `app_server_protocol_error`：已识别消息缺关键字段；
- `app_server_request_timeout`：单次 RPC 超时；
- `thread_missing`：App Server 明确找不到绑定 thread；
- `turn_busy`：已有 inProgress turn；
- `no_active_turn`：steer/interrupt 时没有活 turn；
- `stale_turn`：expected turn id 不匹配；
- `interaction_missing` / `interaction_already_resolved`；
- `unsupported_interaction`：当前版本出现尚未实现的反向请求，必须 fail closed。

错误显示在 stream 中并保留重试入口；不得以空白 surface、无限等待或自动开第二条
thread 掩盖。

## 8. 安全与资源边界

- 面板继续只监听 loopback。
- prompt、command 和 form answer 不经过 shell。
- App Server 子进程继承经过明确构造的环境；清除 `NO_COLOR`/`TERM=dumb` 已不再是
  渲染需求，但不得把 StagePass 私密配置写进日志。
- stderr、RPC error 和命令输出进入 UI 前做长度限制与敏感串清理。
- SSE 每个连接有关闭监听；浏览器离开即移除 subscriber。
- replay、command output 与 reasoning 均有字节上限，超限显示截断事实。
- 未知 server request 默认拒绝，不能自动批准。

## 9. 实施切片

1. JSON-RPC 客户端 + fake server：证明握手、分块、通知、反向请求、超时、退出。
2. stream state + session：证明 delta、item upsert、terminal、replay、steer、interrupt、
   interaction。
3. `CodexTransport` 迁移：后台 turn 不再走 TUI/rollout。
4. Web API + SSE：结构化端点贯通，旧 `/pty` 路径不再被调用。
5. StagePass renderer：真实正文流、tool/file/command、composer、interaction sheet。
6. archive/recovery/subagent 读取迁移到 App Server thread/items；移除私有 Codex 文件读取。
7. 删除 PTY/TUI/xterm/node-pty 与旧测试/探针，更新架构护栏和文档。
8. 4173 真机验收：start/resume、delta、MCP、审批、steer、interrupt、刷新、服务重启。

每个切片遵循 RED → GREEN → full relevant test → typecheck → atomic commit。新分支在最后
一个切片完成前不宣称“纯 App Server 已完成”。

## 10. 验收标准

1. `rg` 在生产源码中找不到 `node-pty`、xterm、`codex resume`、rollout parser、
   `state_5.sqlite`。
2. 首 token 在 turn terminal 之前出现在浏览器；delta 顺序与 App Server 一致。
3. command/file/MCP/subagent 不是 ANSI 文本，而是可辨识的结构化 item。
4. steer 不创建新 turn；interrupt 后 thread 可继续。
5. StagePass MCP elicitation 能在面板内回答，回答后原 turn 继续。
6. 浏览器刷新不丢历史；服务重启后从同一 thread 恢复，不重复 turn。
7. 所有 1235 项基线测试中仍适用的业务测试保持通过；被删除的只允许是明确绑定
   PTY/rollout 私有实现的测试，并由 App Server 等价行为测试替代。
8. `pnpm typecheck`、全量测试、架构护栏和浏览器 console 全绿。
9. 320、768、1024、1440 宽度可用；键盘可完成提交、中断、审批和 elicitation。
10. 端口仍只有 `4173`，服务只绑定 `127.0.0.1`。

## 11. 被拒绝的方案

### 把 Codex 封成 MCP

内置 `codex mcp-server` 只提供 start/reply 风格工具，没有 App Server 的完整事件、
`turn/steer`、`turn/interrupt` 与 server-request 生命周期。自建 MCP facade 最终仍要在
后面接 App Server，只会增加一层协议和故障面。

### 保留 PTY 当 fallback

这会让 thread/turn 所有权出现两套实现，并重新引入“终端进程还活着但协议状态不明”与
私有 rollout 解析。用户已明确要求两条路线分属两个 worktree，因此新分支不保留。

### 浏览器直连 App Server

浏览器无法安全地持有本地 Codex 进程、workspace 路径、审批权限与 StagePass 数据库
事务；断线后也无法维持单一 thread owner。App Server 必须由 StagePass Server 托管，
浏览器只消费收窄后的 snapshot/SSE/command API。
