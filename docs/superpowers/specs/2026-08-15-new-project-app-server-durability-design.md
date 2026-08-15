# StagePass 新项目 App Server 可用性与持久化修复设计

## 1. 目标

纯 App Server 分支上的新项目必须从空状态完整可用：人打开当前阶段、发送首个 turn、
看到结构化流、处理 MCP 提问、刷新页面、重启 StagePass 后，仍然回到同一条已经产生
业务内容的 thread。`turn/steer` 和 `turn/interrupt` 必须作用于当前精确 turn。

本设计只修新项目和今后新建会话的可靠性。已经从 Codex 存储中消失的旧 thread 不在
本轮伪造或重建；StagePass 的既有 Change、artifact、rubric、gap 和 gate 数据不改写。

## 2. 已复现的根因

### 2.1 端口所有权取得得太晚

`scripts/panel.ts` 当前先打开真实数据库、执行恢复、启动 App Server 并调用
`reconcileBindings()`，最后才执行 `server.listen(4173)`。当另一个实例已经占用 4173
时，第二个实例会先改变共享数据库，最后才以 `EADDRINUSE` 退出。

2026-08-15 在真实 `CHG-002 / PRD` 上已复现：占用 4173 的实例正常运行；第二个实例
启动失败前，仍把第一实例刚创建的 binding 改成了 `detached`。

### 2.2 空 thread 被误当成 durable binding

App Server 的 `thread/start` 可以返回一个尚未产生 turn 的进程内 thread；此时新的
App Server 进程不一定能通过 `thread/list` 找到它。StagePass 当前在 `open()` 后立即
写 durable binding。第二实例或重启巡检因此把一条“尚未持久化”而非“已经丢失”的
thread 判成 missing 并 detach。

### 2.3 浏览器绕过了恢复边界

`/api/codex/open` 和 `/api/codex/turn` 直接调用底层 `StreamSessions`。真正负责
availability、unarchive、复核和 fail-closed 语义的 `PanelSessions` 没有进入浏览器
路径。结果是离线测试证明了恢复函数本身，却没有证明产品实际入口会调用它。

## 3. 不变量

1. 只有成功占有 `127.0.0.1:4173` 的进程可以打开或修改真实 StagePass 数据库。
2. `EADDRINUSE` 必须发生在数据库连接、schema 迁移、binding 恢复和 App Server spawn
   之前；失败实例对真实状态零写入。
3. 仅 `thread/start`、没有 turn 的 thread 是 ephemeral，不进入 durable binding。
4. 首个 `turn/start` 成功返回后，StagePass 才把新 thread 绑定到 `(Change, seat)`。
5. 已有 durable binding 必须先通过公开 App Server availability；archived 必须
   unarchive 并二次确认，missing 才允许 fresh。
6. 浏览器、后台 round、ask-human 和恢复巡检共用同一套 binding 语义，不能各有入口。
7. App Server turn 完成不改变 StagePass gate；业务状态仍由 StagePass 裁决。

## 4. 组件设计

### 4.1 启动端口卫兵

在 `scripts/panel.ts` 的任何持久化动作之前创建并监听一个 HTTP server。它立即占有
4173；初始化完成前统一返回 `503 stagepass_initializing`。如果 listen 失败，进程直接
退出，尚未打开数据库，也没有启动 App Server。

`createPanelServer` 不再强制创建自己的 `http.Server`，而是向已占端口的 server 安装
正式 request handler。现有测试仍可让工厂自行创建未监听 server，保持测试调用兼容。
正式 handler 安装后，初始化 503 handler 被移除。初始化中途失败时关闭监听器、
App Server 和数据库，再退出。

### 4.2 单一产品级 session facade

浏览器 stream API 依赖产品级 facade，而不是直接依赖 `StreamSessions`。facade 提供：

- `open`：检查 binding；open 直接 resume；archived 先 unarchive/复核；missing detach
  后创建 ephemeral thread；
- `startTurn`：保证 seat 已打开，启动 turn；新 thread 在成功后 durable bind；
- `snapshot/events/subscribe/steer/interrupt/respond`：委托给同一条已打开 session；
- `close`：只关闭进程内投影，不删除 durable binding。

底层 `StreamSessions` 只管理进程内 App Server session 和结构化投影，不再自行决定
何时把新 thread 写成 durable binding。binding 的持久化时机由 facade 唯一拥有。

### 4.3 首 turn 持久化

新 seat 的 `open` 返回可输入的空 snapshot，但数据库仍没有 bound row。首个
`turn/start` 成功后，facade 用 session 的 thread id 执行幂等 bind。绑定失败时 turn
不能伪装成未发生：API 返回具名 `thread_binding_failed_after_turn_start`，日志保留
change、seat、thread 和 turn id，下一次同进程调用可重试同一 bind。

若进程在 open 与首 turn 之间退出，没有业务内容需要恢复，下一次 open 创建新的空
thread。若进程在 turn/start 成功后、bind 前崩溃，App Server 已持久化 thread；启动
诊断必须报告孤儿 turn，但本轮不引入按内容猜测 seat 的自动认领。

### 4.4 既有 detached 同进程修复

如果进程内已经持有某 seat 的 session，而数据库因旧竞态处于 detached，首个成功
turn 后的幂等 bind 会把同一 thread 恢复为 bound。这让当前已复现的 `CHG-002 / PRD`
可在不生成第二条 thread 的情况下修复。

## 5. 错误和安全语义

- 4173 被占：打印占用错误并退出；不碰数据库。
- App Server unavailable：保留已有 bound binding，UI 显示不可用原因，不 fresh。
- archived 解归档失败：保留 binding，拒绝打开，不伪装成功。
- missing：只有 App Server 明确确认后才 detach；新建 ephemeral session。
- 首 turn 失败：不写 durable binding；失败 item 留在当前进程 snapshot 中供人查看。
- 所有接口继续只监听 loopback；原始 JSON-RPC payload 和 id 不进入浏览器。

## 6. 测试设计

先写失败测试，再改实现：

1. 端口已占时启动入口退出，注入数据库探针证明 schema/recovery 零调用。
2. 新 seat `open` 返回 thread，但 `BindingStore.find()` 仍为空或 detached。
3. 首个 `turn/start` 成功后同一 thread 变为 bound。
4. 首 turn 失败不产生 durable binding。
5. 同进程 session + detached row 在首 turn 后恢复为 bound，不创建第二 thread。
6. 浏览器 `/api/codex/open` 对 archived binding 调 unarchive 后 resume 同一 id。
7. App Server unavailable 时浏览器收到具名错误且 binding 保留。
8. 刷新、SSE 重连、steer、interrupt 和 interaction 仍使用精确 thread/turn。
9. 架构测试禁止 Codex stream API 直接依赖裸 `StreamSessions` 产品入口。

全量门禁为 `pnpm check`，必须 0 fail、0 cancelled、0 skipped。

## 7. 真实验收

只运行一个 4173 实例，使用真实数据库的 `CHG-002`：

1. 打开 PRD，确认空 thread 尚未 durable bind；
2. 从浏览器发送一条不改文件的验收 prompt，观察原生 delta；
3. 确认首 turn 后 binding 为 bound；
4. 发起并回答一次 StagePass MCP 提问；
5. 发起长 turn，分别验证 steer 和 exact-turn interrupt；
6. 刷新页面，确认没有重复 item；
7. 停止并重启同一 4173，确认 resume 同一 thread、历史和最终状态；
8. 再尝试启动第二实例，确认它在任何数据库写入前以 `EADDRINUSE` 退出；
9. 检查浏览器控制台、网络、焦点和 StagePass 视觉；
10. 留下 4173 的明确运行状态，并记录唯一重启命令。

真实验收 prompt 明确禁止修改项目文件。测试产生的 session 和回答属于用户授权的
CHG-002 新项目验收数据，不推进 gate、不批准阶段。
