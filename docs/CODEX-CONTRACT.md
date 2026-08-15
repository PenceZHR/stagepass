# Codex App Server 行为契约

> 本文只适用于隔离分支 `codex/native-streaming-app-server`。原分支保留 TUI 路线；
> 这个分支没有 PTY/TUI fallback，也不读取 Codex 私有 rollout 或状态数据库。
>
> 最近核对：2026-08-15，本机 `codex-cli 0.147.0`。协议基线来自
> `codex app-server generate-json-schema --experimental --out <dir>` 与真进程探测。

## 1. 所有权

StagePass 拥有 Change、phase、job、binding、artifact、gap、rubric、question 和 gate。
Codex App Server 只拥有 thread、turn、item 及协议级审批/elicitation 生命周期。

- App Server 的 `turn/completed` 不会自动批准阶段。
- 人的答案仍先进入 StagePass 用例和账本，再由 gate 决定是否合法。
- Web renderer 只显示归一化事件，不能从模型正文反推业务状态。

## 2. 进程和握手

唯一可启动 Codex 的生产模块是 `src/codex/app-server-client.ts`，启动形状固定为：

```text
codex app-server --listen stdio://
```

stdout 是逐行 JSON 协议；stderr 只作有界、脱敏诊断。启动顺序是
`initialize` → `initialized`。stdout 分块、半行、并发 request id、单请求超时、进程退出
和有界关闭都有离线协议测试。

## 3. thread 与持久绑定

- 没有 binding：`thread/start`，返回 id 后立即写 binding，不自动发 turn。
- 有 binding：先用 `thread/list` 的公开 archived/source 过滤判断可用性，再
  `thread/resume`。
- archived：`thread/unarchive` 后复核，再 resume。
- 只有 App Server 明确确认 missing 才 detach；断线、超时和协议错误保留 binding。
- 人批准一个阶段后才调用 `thread/archive`；失败不能伪装成成功。
- 完整历史只用 `thread/read { includeTurns: true }`，不读 `~/.codex/sessions`。

## 4. turn、steer 与 interrupt

- idle thread 用 `turn/start`；一个 thread 同时最多一个 active turn。
- running 时的追加方向用 `turn/steer`，必须带当前 `expectedTurnId`。
- 中断用 `turn/interrupt`，必须带当前 turn id；中断不删除 thread 或 binding。
- `completed`、`failed`、`interrupted` 是三个不同终态，只有 completed 交付正文。
- App Server 断开时，所有 pending request/turn 失败为具名错误，绝不伪装完成。

## 5. 结构化流

StagePass 归一化 `turn/*`、`item/*`、delta 和反向请求，浏览器只得到：

- materialized snapshot；
- 带单调 `seq` 的 SSE event；
- agent prose，以及 reasoning、plan、command、file change、MCP、sub-agent 等语义 item；
- pending interaction 的最小 UI 字段。

资源边界：

- 单个 item 的正文或输出最多 256 KiB，截断会在界面明确显示；
- replay 最多 512 条且最多 2 MiB，任一上限命中就淘汰最旧事件；
- replay gap 返回 `snapshot.required`，浏览器重新取完整 snapshot；
- 未知通知只暴露方法名，不转发原始 payload；
- item 原始对象、JSON-RPC id、thread/turn 协议身份和额外字段不进入浏览器；
- MCP URL 只允许 `http:` / `https:`，并使用 `noopener noreferrer`。

## 6. 反向请求

支持并 fail-closed 路由：

- `item/commandExecution/requestApproval`；
- `item/fileChange/requestApproval`；
- `item/permissions/requestApproval`；
- `mcpServer/elicitation/request`；
- `item/tool/requestUserInput`。

App Server 的 JSON-RPC id 只保存在服务端 pending map。浏览器看到 StagePass 自己生成的
interaction id；回答后服务端把结果回到原 request。未知反向请求拒绝，绝不自动批准。

## 7. 子 Agent 与取证

裁判仍按指令先派红方、再派蓝方。StagePass 不让模型手抄线程 id，而从
`thread/read` 返回的 `collabAgentToolCall` / `subAgentActivity` item 取得子线程顺序。
红蓝正文直接读取各自 thread；读不到、未完成和空/坏契约都不能被解释为“没有问题”。

## 8. MCP 配置

StagePass MCP 通过每条 thread 的 App Server `config` 注入，不写用户全局配置。配置包含
当前数据库、Change，跑轮时还包含 phase。MCP elicitation 由 App Server 作为反向请求
送入 StagePass interaction sheet，答案直接回到原 turn。

## 9. 升级核对

Codex 升级后执行：

```bash
pnpm schema:app-server
pnpm check
```

并在 4173 真机核对 start/resume、历史、原生 delta、command/file/MCP item、审批、
elicitation、steer、interrupt、刷新重连和服务重启。协议变化必须先更新本契约和对应测试，
不能靠读取私有文件兜底。
