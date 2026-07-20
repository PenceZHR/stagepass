# 设计：把传输层故障从「模型输出错误」里分离出来（2026-07-18）

> 任务 A 的设计文档。实现落在分支 `codex/build-onwards-blocker-repair`。

## 一、问题陈述

网络/基础设施故障当前被归因成**模型输出格式错误**或**进程身份错误**，用户看到的信息指向错的方向，会去修错的东西。

实证（RUN-230，CHG-013 draft 阶段）：

```json
{"rawTextLength": 0, "providerErrorCode": null,
 "errorCode": "file_candidate_invalid",
 "sanitizedErrorSummary": "line_protocol schema invalid: expected a MARKDOWN<< … >>MARKDOWN block"}
```

模型**一个字都没产生**，系统却在指责它的输出格式。

## 二、根因（已用证据锁定，非推测）

### 2.1 触发源：MacBook 休眠

`pmset -g log` 与 worker 日志比对：**19 次 worker SIGTERM 中有 10 次落在 macOS DarkWake 事件的 0–2 秒内**，其中 9 次在 1 秒内。机器用电池进入 Deep Idle，休眠 15–17 分钟。

两次关键失败都在此列：

| 唤醒时刻（本地 -0400） | 后果 |
|---|---|
| `06:42:43` | RUN-230 —— 「跑了 16 分钟返回空」的那次 |
| `12:51:35` | RUN-mrqlgjbd —— `stale_lease_fenced` 的那次 spec |

**所以「网络中断」「SIGTERM 之谜」「基础设施抖动」是同一件事**：机器睡了。

### 2.2 传导链

```
macOS Deep Idle 休眠 15–17 分钟
  → worker 进程被冻结，心跳停发
  → DarkWake 时 dev-supervisor 的健康检查 tick 触发
     （dev-supervisor.ts:985-1024，workerStaleAfterMs = 30_000）
  → 判定心跳陈旧 15 分钟 >> 30 秒阈值 → SIGTERM worker
  → 在跑的 codex 子进程随之死亡
  → codex 退出时只发过 reasoning item，从未发出 agent_message
  → codex-cli-engine.ts:634 的三重 AND 不成立 → 不抛错
  → :430 无条件 success: true，summary: ""
  → ai-line-protocol.ts:390 只挡 !result.success → 空串进入解析
  → :403 打上 structuredOutputSource: "line_protocol" ← 伪造来源
  → 下游一路归因为「模型输出格式错误」
```

同一场休眠还并发产生另外两条错误归因：

- **租约在休眠期间过期** → 清扫器报 `stale_lease_fenced`
- **唤醒风暴中 `ps`/`lsof` 探针超过 750ms 预算** → `probe_timeout` 掉进兜底分支，报成 `provider_identity_mismatch`

### 2.3 关键代码位置

| 位置 | 问题 |
|---|---|
| `codex-cli-engine.ts:634` | 三重 AND 要求 `items.length === 0`；有 reasoning item 时不成立，空回复被放行 |
| `codex-cli-engine.ts:430` | 非抛错路径无条件 `success: true` |
| `codex-cli-engine.ts:640` | `exitCode` / `signal` 算出来了，`run()` 从不读取 → **codex 全部 145 条运行 `exit_code` 为 NULL** |
| `ai-line-protocol.ts:390` | 唯一短路只测 `result.success`，不测「有没有回复」 |
| `ai-line-protocol.ts:403` | 空回复被标记为 `line_protocol` 来源，**伪造了模型产出过内容的证据** |
| `stage-ai-output-ingestion-service.ts:636` | 兜底默认 `invalid_stage_output`，「不知道发生了什么」与「模型写错了」不可区分 |
| `stale-provider-run-recovery-service.ts:563` | `validation.reason` 被丢弃，`probe_timeout` 报成 `provider_identity_mismatch` |
| `stale-provider-run-recovery-service.ts:454-463` | `leaseExpired`（符合停顿）与 `fenceInvalid`（新尝试接管）分别算出后**塌缩成同一个码** |

### 2.4 已排除

- **`pnpm test` 杀 dev worker：证伪。** `scripts/run-tests-isolated.ts` 全文 112 行，**无任何 kill 逻辑**——没有 pkill/killall/treeKill/process.kill/端口杀进程/信号处理器。第 101 行的守卫只做 sha256 前后比对并抛错，不发信号。
- **并发 agent 改文件触发热重载：证伪**（时间戳不符，且 SIGTERM 有明确日志理由 `worker_heartbeat_stale`）。

## 三、设计

### 3.1 原则

**协议解析器不该为一个从未产生的回复背锅。** 判定顺序必须是：先问「provider 有没有交付回复」，再问「回复是否合规」。

同时**不许过度归因**：只有拿到硬证据才说「传输层故障」；拿不到就说「没有回复」并列出常见原因，不假装知道是网络。

### 3.2 新增错误码

**引擎层 `providerErrorCode`（字符串）**

| 码 | 判定依据（必须有硬证据） |
|---|---|
| `provider_transport_error` | codex：`turn.failed` 消息含 `stream disconnected` / `error sending request`；claude：`apiErrorStatus` ∈ {408,429,500,502,503,504,529} 或含 `Unable to connect` / `ConnectionRefused` |
| `provider_empty_response` | 进程结束但从未产出 assistant message，且无上述传输证据。**不宣称原因。** |

保留既有 `provider_timeout`、`provider_run_failed`。

**摄取层 `StageAiOutputErrorCode`**：同名新增两个成员。

### 3.3 判定顺序（核心改动）

1. `codex-cli-engine.ts:634` — 去掉 `items.length === 0` 这个条件。**退出时没有 agent_message 就是失败**，无论有没有 reasoning item、无论退出码是否为 0。有传输证据时置 `provider_transport_error`，否则 `provider_empty_response`。
2. `ai-line-protocol.ts:390` — 短路条件从 `!result.success` 扩展为「失败**或**无文本」，让 `:391` 永不解析不存在的文档。
3. `inferErrorCode` — 空回复判定**排在** review 分支与 file-candidate 前缀匹配之前。

### 3.4 取证管线

`exitCode` / `signal` / `stderr` 尾巴接进 `AiRunResult` → `emitTerminal` → `provider_run_processes` → `StageAiRawCaptureEnvelope`。目前 envelope 根本没有字段承载这些证据，下次故障仍然只能靠猜。

### 3.5 用户可见文案

两个新码在 `StageProgressStatus` 必须映射到 `failed`，**不是 `invalid_output`**（后者的语义是「模型的错」）。

- `provider_transport_error` → 「与模型服务的连接中断（传输层故障），可直接重试。」
- `provider_empty_response` → 「本次运行没有返回任何内容。常见原因：网络中断、机器休眠、进程被重启。可直接重试。」

### 3.6 恢复层归因

- 传播 `validation.reason`：`probe_timeout` / `probe_failed` / `probe_output_limit` 不再报成 `provider_identity_mismatch`。
- 拆开 `stale_lease_fenced`：区分「租约超时」（符合停顿/休眠）与「新尝试已接管」。

**明确不做**：不把 `stale_lease_fenced` / `provider_identity_mismatch` 折进传输层桶。它们是恢复清扫器的判定，是传输故障的**下游症状**而非传输故障本身——折进去就是新一轮过度归因。

## 四、验收与测试

两个方向都必须有变异验证过的测试：

1. **网络故障不被误报为格式错误**：空回复（含「有 reasoning item 但无 agent_message」这一真实形态）→ `provider_empty_response`，且 `structuredOutputSource` 不得为 `line_protocol`。
2. **格式错误不被误报为网络问题**：模型真的返回了文本但违反行协议 → 仍然是 `invalid_stage_output` / `file_candidate_invalid`。

## 五、实现注意

⚠️ **RUN-230 的产物早于 commit `d8a3dafa`**，该提交把三个 briefing 阶段的 `allowedCandidateFiles` 置空，删掉了产生 `file candidate missing` 的候选列表。**在 HEAD 上同样的故障现在报的是 `invalid_stage_output` 而不是 `file_candidate_invalid`**。写测试请针对 HEAD 行为，不要钉死在旧码上。

## 六、运维结论（非代码）

跑长时 E2E 前用 `caffeinate -dimsu` 阻止休眠，或接电源。否则每 15 分钟一次的 Deep Idle 会持续击杀在跑的 provider 运行——这是三轮 E2E 里全部 4 次「基础设施抖动」的真实来源。
