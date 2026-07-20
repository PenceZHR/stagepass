# Error Codes：stagepass 错误码

| 项 | 值 |
|---|---|
| 文档状态 | Draft（待 Interface Review） |
| 版本 | v2.0 |
| 关联 | [docs/api-spec.md](./api-spec.md) |

> 统一错误响应：`{ "error": string }` + HTTP 状态码。下表为常见错误的分类与处理建议。

---

## 一、HTTP 状态码语义

| HTTP | 类别 | 含义 |
|---|---|---|
| 400 | 客户端 | 参数非法 / 状态机不允许该操作 |
| 404 | 客户端 | 资源不存在 |
| 409 | 客户端 | 并发冲突 / 幂等冲突 |
| 500 | 服务端 | 内部错误（AI/IO/DB）|

## 二、状态机类错误（400）

| 场景 | 错误信息样例 | 处理 |
|---|---|---|
| 状态不匹配 | `Invalid status: DRAFT. Expected: PLAN_READY` | 前端禁用非法操作按钮 |
| 门态非法 approve | `Not at gate: current status SPECCING` | 等阶段跑完到门态再 approve |
| Merge 前置不满足 | `Cannot merge: missing [review_passed, test-plan-delta]` | 提示补齐缺失项 |
| Fix 超限 | `Max fix iterations (99) reached` | 转人工，BLOCKED |

## 三、并发类错误（409）

| 场景 | 错误信息样例 | 处理 |
|---|---|---|
| 已有 change 在跑 | `Another change is active: CHG-002 (IMPLEMENTING)` | 等其完成或中止 |
| 门已离开 | `Gate already passed: spec` | 刷新状态 |
| 重复合并 | `Change already merged` | 幂等返回 |

## 四、Scope 越界（导致 BLOCKED）

| 场景 | 错误信息样例 | 处理 |
|---|---|---|
| read-only 阶段改了源码 | `generate_plan stage is read-only but modified files: [...]` | 回退越界改动，重跑 |
| 越出 plan.allowedFiles | `Implement modified files outside scope: [...]` | 修正 plan 或回退 |
| 越出 plannedChanges | `Mutation outside declared plannedChanges: [...]` | 重新声明本轮变更 |
| Fix 改了非 finding 文件 | `Fix touched files unrelated to findings: [...]` | 限定在 finding 范围 |

> `.ship/` 路径下的变更**豁免**，不触发 scope 错误（不变式 5）。

## 五、AI / 引擎类错误（500）

| 场景 | 错误信息样例 | 处理 |
|---|---|---|
| Claude CLI prompt 传递 | `Input must be provided through stdin...` | 已修（stdin 传 prompt），见 memory |
| Codex 用量超限 | `You've hit your usage limit... try again at HH:MM` | 等额度恢复 / 切 provider |
| AI 输出非法 JSON | `Failed to parse structured output` | 重跑该阶段 |
| 产物为空 | `Stage produced empty delta` | 阶段 failed，可重跑 |

## 六、DB / IO 类错误（500）

| 场景 | 错误信息样例 | 处理 |
|---|---|---|
| 迁移失败 | `Migration 0008_xxx failed: ...` | 检查迁移 SQL，runner 已对 already-exists 幂等 |
| 列缺失（历史） | `no such column: xxx` | 由迁移 runner 兜底（Phase 0）|
| 产物文件缺失 | `plan.json not found. Generate plan first.` | 先跑前置阶段 |

## 七、错误处理原则

1. 阶段级失败 → `endRun(false)` + 回退到进入前状态，不污染状态机。
2. Scope 越界 → 抛 `StageBoundaryViolationError` → BLOCKED + 生成 P0 finding。
3. 门态错误不自动前进，需人工修正后重触发。
4. AI/网络错误由 engine 内部重试；耗尽后上抛由用户决定。

---

*评审：Approve *
