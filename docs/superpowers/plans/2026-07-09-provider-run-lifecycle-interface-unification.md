# Provider Run 生命周期接口统一与崩溃韧性修复实施计划

> **面向执行代理：** 必须使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，按任务逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪；只有对应测试、验收证据和独立审核均通过后才能勾选完成。

**目标：** 统一 Provider Run 生命周期接口，并把当前“服务经常崩掉、running 半截残留、日志丢失、SQLite 锁竞争”作为 P0 事故修复，保证 Next dev 主服务、Claude/Codex worker、SQLite 写入和恢复逻辑在崩溃后可追踪、可恢复、可验证。

**架构：** 保留原主题的双层状态机：业务 run/stage 状态仍由 `runs`、`stage_runs`、`battle_rounds`、`changes.status` 表达；Provider 进程生命周期新增统一接口负责 `provider_process_started`、heartbeat、ended/failed/aborted、父子退出协议和 stale recovery。P0 完成路径必须把长时间 AI pipeline 移出 Next 进程：Next API 只入队，`scripts/pipeline-worker.ts` 独立 lease job 并执行，`scripts/dev-supervisor.ts` 同时守护 Next 和 worker。

**技术栈：** Next.js App Router、TypeScript、Node `child_process`/`process` signals、better-sqlite3 + Drizzle、Pino、`tsx --test --test-concurrency=1`、SQLite migrations、本地 dev supervisor 脚本。

## 执行状态（2026-07-11）

**当前唯一状态源：COMPLETE。** Task 10-14 均已通过执行审核与独立质量审核，Task 9 与 Task 14A 的前置交付也已由后续闭环证据覆盖。Task 1-8 的旧阻塞判定保留为历史审查结论，并已由 Task 9-14（含 Task 14A）逐项解除。本计划不虚构或补写 commit；完成结论以测试、类型检查、diff 检查、事故验收和独立双审记录为准。

**最终独立审核：** 本线程的真实审核 Agent、逐项结论、最终验证数字与证据边界已落盘至 [`docs/reports/2026-07-11-provider-lifecycle-final-independent-review.md`](../../reports/2026-07-11-provider-lifecycle-final-independent-review.md)。本次文档收尾只允许修改本计划与该报告，不修改代码。

**Git 证据边界：** 工作树在本次文档收尾前已经包含大量既有改动，且本计划文件当前未被 Git 跟踪，因此无法使用 Git 证明“单一 Agent 只修改了某个文件”，也不把单 Agent 归因或 commit 作为完成证据。本文只陈述本线程工具约束、可见内容审查、真实审核 Agent ID 与其返回结论。

| Task | 当前状态 | 历史结论解除依据 |
| --- | --- | --- |
| Task 1 dev supervisor/logs | 历史阻塞已解除 | Task 12 已完成真实进程身份、健康与重启闭环 |
| Task 2 provider lifecycle | 历史阻塞已解除 | Task 10 已完成 execution context、lease 与 fencing |
| Task 3 engine lifecycle callback | 历史阻塞已解除 | Task 10 已覆盖 Build/Fix、registry 与 Codex heartbeat |
| Task 4 stale provider recovery | 历史阻塞已解除 | Task 11 已完成三方对账、完整状态空间与逐 run 隔离 |
| Task 5 SQLite write boundary | 历史阻塞已解除 | Task 11、14、14A 已完成 typed diagnostic、逐写扫描与隔离 |
| Task 6 pipeline job queue/worker | 历史阻塞已解除 | Task 9、10 已完成全部 AI route 入队和独立 worker 执行 |
| Task 7 startup recovery/health | 历史阻塞已解除 | Task 11、12 已完成 liveness 与 GET/SSE/action 回退闭环 |
| Task 8 强制事故验收 | 历史阻塞已解除 | Task 13 已通过 14/14 隔离事故验收 |
| Task 9 全 AI route 入队 | COMPLETE | 前置交付已被 Task 10-14 全量闭环验证覆盖 |
| Task 10 lifecycle context 与 fencing | COMPLETE，双审 PASS | Build/Fix、execution context、provider lease、registry、Codex heartbeat 已闭环 |
| Task 11 recovery 完整状态空间 | COMPLETE，双审 PASS | 完整状态空间、CAS、逐 run 隔离与 GET/SSE/action 已闭环 |
| Task 12 supervisor/worker 身份与活性 | COMPLETE，双审 PASS | 真实进程组身份、nonce、start time、cwd、command、worker heartbeat 已闭环 |
| Task 13 无假阳性事故验收 | COMPLETE，双审 PASS | 隔离事故验收 14/14，通过临时进程、端口、DB 与联合断言 |
| Task 14A SQLite typed error 基础 | COMPLETE | `SqliteWriteBusyError` 契约与锁竞争验证已被 Task 13/14 闭环覆盖 |
| Task 14 SQLite 写路径与 UI/action 收口 | COMPLETE，双审 PASS | 固定 owner、AST inventory、UI/action closure 与全量证据均通过 |

因此，计划整体为 **COMPLETE**。下列 2026-07-10 内容仅作为“历史审查结论/已解除”的追溯记录，不再代表当前状态。Task 1-8 章节中的复选框均由 Task 9-14（含 Task 14A）的后续闭环证据追认完成；勾选表示“后续证据已覆盖该要求”，不表示原始 Task 1-8 曾按原顺序独立提交或存在可归因 commit。
- 返工前已有落地基线：
  - 部分 pipeline API route 已改为入队，但 Intake 与 PRD Briefing 仍在 Next 内异步执行，待 Task 9 修正。
  - `scripts/dev-supervisor.ts` 已尝试同时守护 Next 与 pipeline worker，但真实进程身份与 worker liveness 待 Task 12 修正。
  - `provider_run_processes` 与 lifecycle sink 已建立，但 Build/Fix、execution context、fencing、Codex heartbeat 待 Task 10 修正。
  - `/api/health`、change detail GET、events GET/SSE 会触发 lazy startup/stale recovery，避免 DB 永久卡在 `running`。
  - SQLite 高频写入路径已接入 `withSqliteWriteRetry`，Stage Authority 组合写入已收进短事务。
- 返工前历史验证（必须由 Task 9-14 的新证据替代）：
  - `CI=true pnpm exec tsx --test --test-concurrency=1 server/services/startup-recovery-service.test.ts app/api/health/route.test.ts server/services/change-route-guard.test.ts server/services/stale-provider-run-recovery-service.test.ts server/db/sqlite-lock-retry.test.ts server/services/stage-authority-service.test.ts server/services/provider-run-lifecycle-service.test.ts server/services/provider-process-lease-service.test.ts server/services/job-dispatch-service.test.ts server/services/pipeline-job-lease-service.test.ts server/services/pipeline-job-runner-service.test.ts server/services/dev-supervisor.test.ts server/services/supervisor-health-service.test.ts`
  - 结果：67 tests passed。
  - `CI=true pnpm exec tsx --test --test-concurrency=1 server/services/crash-resilience-acceptance.test.ts`
  - 结果：8 tests passed。
  - `CI=true pnpm exec tsx scripts/acceptance-crash-resilience.ts --case delete-logs`
  - 结果：passed，使用临时 logs 目录，不删除真实 `logs/`。
  - `CI=true pnpm exec tsx scripts/acceptance-crash-resilience.ts --case sqlite-lock`
  - 结果：passed，短锁 retry 成功，长锁返回 typed diagnostic。
  - `CI=true pnpm exec tsx scripts/acceptance-crash-resilience.ts --case restart-recovery`
  - 结果：passed，dry-run 当前 stale rows 为 0。
  - `CI=true pnpm exec tsc --noEmit --pretty false` 通过。
  - 2026-07-10 的 `CI=true pnpm test` 曾失败；该历史阻塞现已解除。2026-07-11 最终隔离全量验证为 104 个测试文件、1306/1306 通过、0 fail、0 cancelled，TypeScript 与 diff 检查均通过。

**真实 kill 场景说明：** `kill-next`、`kill-worker`、`kill-provider` 是受控事故演练。2026-07-10 尚未形成可信证据是历史审查结论；Task 13 最终 14/14 已解除该阻塞。`kill-provider` 仍必须显式传入 `--change <changeId> --run <runId> --execute`，并完成进程身份校验后才可发信号；禁止从任意 live provider 中选一个 PID。找不到唯一且可验证目标时只输出诊断并退出。

---

## 最新事故结论

2026-07-09 至 2026-07-10 的现场不是单一 prompt 或 blue/red 逻辑问题，而是运行模型问题：

1. Next dev 主服务会退出：`screen` 没有会话，`3000` 无监听，页面打不开。
2. 日志不可靠：`logs/` 目录和 `logs/dev-server.log` 消失，主服务退出 stack 丢失。
3. DB 留下半截 running：最新例子 `RUN-mrdpj1ud-7096080c`，`runs.status=running`，`battle_rounds.status=red_running`，事件有 `provider_process_started(pid 72925)`，没有 `provider_process_ended`，且 PID 已不存在。
4. 崩溃期间出现过 `sqlite database is locked`，说明 Next 主进程、Claude worker、手动查询/恢复逻辑存在 SQLite 锁竞争风险。
5. 根因组合是 Web dev server 直接承载长时间 AI pipeline、SQLite 多进程写入、无 supervisor、无可靠日志、无启动恢复、无父子进程终止协议，导致反复崩溃后 DB 与真实进程世界分叉。

## P0 修复目标

P0 不只修 provider lifecycle 接口，还必须同时修稳定运行模型、可靠日志、启动/刷新恢复、SQLite 写入边界、父子进程退出协议：

- Next dev 进程退出必须留下可读日志、退出码、最后心跳和最近 provider run。
- `logs/` 不存在时启动脚本必须自动创建，日志文件不能依赖手工 `screen`。
- 服务启动和状态刷新必须自动扫描 stale running：`runs.status=running` 且 provider PID 不存在时，统一恢复 red/spec、blue/spec_critic、build、review、local_check、fix 等阶段，并刷新 QA gate 派生状态。
- Provider worker 结束、异常、超时、父进程退出时必须写 terminal/ended 事件；写不成功时也必须能被 recovery 通过 PID/heartbeat 检出。
- SQLite 写入必须短事务、可重试、单入口，避免 Next request handler、worker、手动 repair 同时长时间持有写锁。
- API route 不能直接承载长任务；P0 必须落地 job queue + 独立 pipeline worker，禁止以 Next 进程内异步执行作为完成路径。

## 设计边界

### 双层状态机保留

业务状态机继续表达用户可见阶段：

- `runs`: 通用 run ledger，`running | completed | failed | stopped`。
- `stage_runs`: DB-first stage attempt，`running | passed | failed | invalid_output | data_inconsistent | stale`。
- `battle_rounds`: Spec Battle 内部红蓝状态，`red_running | red_done | blue_running | blue_done | report_ready | failed`。
- `changes.status`: 页面主阶段，如 `SPECCING`、`SPEC_READY`、`BLOCKED`。

Provider 进程状态机新增为系统事实：

- `starting`: parent 已决定启动 provider，还未拿到 PID。
- `running`: 已记录 PID、ppid、provider、phase、runId、roundId、heartbeat。
- `ended`: provider 正常结束，已写 `provider_process_ended`。
- `failed`: provider 抛错或返回失败，已写 terminal event。
- `aborted`: 父进程收到 stop/exit，主动终止子进程。
- `orphaned`: DB 显示 running，但 PID 不存在或 heartbeat 超时，由 recovery 标记。

业务 terminal 与 provider terminal 必须互相补偿：业务 run 可以因为 provider failed 而 fail；provider event 缺失时，recovery 通过 PID/heartbeat 把业务 run 终止。

### 统一接口形态

新增 `server/services/provider-run-lifecycle-service.ts`，所有 AI provider 启动、结束、异常、父进程退出都必须经过它：

```ts
export type ProviderRunPhase =
  | "spec"
  | "spec_critic"
  | "tech_spec"
  | "generate_plan"
  | "test_plan"
  | "implement"
  | "review"
  | "local_check"
  | "fix_findings"
  | "release"
  | "retro";

export interface ProviderRunStartInput {
  changeId: string;
  runId: string;
  phase: ProviderRunPhase;
  provider: "codex" | "claude";
  pid: number | null;
  ppid: number;
  roundId?: string | null;
  idempotencyKey?: string | null;
}

export interface ProviderRunTerminalInput {
  runId: string;
  phase: ProviderRunPhase;
  status: "completed" | "failed" | "stopped" | "orphaned";
  pid?: number | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  summary: string;
}

export interface ProviderProcessLeaseInput {
  jobId: string;
  workerId: string;
  changeId: string;
  runId: string;
  phase: ProviderRunPhase;
  provider: "codex" | "claude";
  pid: number | null;
  externalRef?: string | null;
}
```

事件仍写入 `events`，并新增专用表承载可查询元数据，避免仅靠 JSON 解析：

- 新增迁移：`server/db/migrations/0014_provider_run_lifecycle.sql`
- 修改 schema：`server/db/schema.ts`
- 新表：`provider_run_processes`
  - `id text primary key`
  - `change_id text not null`
  - `run_id text not null`
  - `phase text not null`
  - `provider text not null`
  - `pid integer`
  - `ppid integer not null`
  - `round_id text`
  - `status text not null`
  - `started_at text not null`
  - `last_heartbeat_at text`
  - `ended_at text`
  - `exit_code integer`
  - `signal text`
  - `summary text`
  - indexes: `idx_provider_run_processes_status_pid`、`idx_provider_run_processes_change_run`

## 历史实施任务（Task 1-8，阻塞已由后续任务解除）

### Task 1: 稳定 dev runner 与可靠日志（由后续证据追认完成）

> 本节历史复选框由 Task 9-14（含 Task 14A）的最终闭环证据追认完成，不代表存在 Task 1 独立 commit。

**目的：** 消除 `screen` 启动失败但无日志、`logs/` 消失后主服务退出原因丢失的问题，并让 dev supervisor 自动重启 Next。worker 守护在 Task 6 创建 `scripts/pipeline-worker.ts` 后接入，同一计划最终验收覆盖 worker 自动重启。

**Files:**

- Create: `scripts/dev-supervisor.ts`
- Modify: `package.json`
- Create: `server/services/dev-supervisor.test.ts`
- Create: `server/services/supervisor-health-service.ts`
- Create: `server/services/supervisor-health-service.test.ts`
- Create: `logs/.gitkeep`

**实施步骤：**

- [x] 新增 `scripts/dev-supervisor.ts`，启动前执行 `fs.mkdirSync("logs", { recursive: true })`，打开 `logs/dev-server.log` 和 `logs/dev-supervisor.log`，spawn `npm run dev:next`，把 stdout/stderr 同时写 console 和对应文件。
- [x] 在 `package.json` 中改脚本：

```json
{
  "scripts": {
    "dev": "tsx scripts/dev-supervisor.ts",
    "dev:next": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "tsx --test --test-concurrency=1 \"app/**/*.test.ts\" \"server/services/*.test.ts\" \"server/db/*.test.ts\""
  }
}
```

- [x] supervisor 对 Next 记录 `dev_server_starting`、`dev_server_started`、`dev_server_exit`、`dev_server_restarting`；字段包含 `pid`、`exitCode`、`signal`、`restartCount`、`backoffMs`、`startedAt`、`endedAt`。
- [x] 实现 restart/backoff：Next 异常退出后按 `500ms, 1000ms, 2000ms, 5000ms, 10000ms` 重启；10 分钟内连续崩溃 5 次后停止重启 Next，写 `supervisor_child_crash_loop`。
- [x] Next 每次重启后必须验证端口重新监听：轮询 `http://127.0.0.1:3000/api/health`，最多等待 30 秒；成功写 `dev_server_port_listening`，失败写 `dev_server_port_not_listening` 并按 backoff 重启 Next。
- [x] `server/services/supervisor-health-service.ts` 维护 `supervisor_health` 状态文件 `logs/supervisor-health.json`，包含 Next pid、restartCount、lastExit、lastHealthAt、portListening、crashLoop。
- [x] supervisor 收到 `SIGINT`、`SIGTERM`、`SIGHUP` 时先写 `dev_supervisor_signal`，再向 Next 转发信号，并等待子进程退出。
- [x] `server/services/dev-supervisor.test.ts` 用临时目录验证 `logs/` 缺失时会创建、子进程退出事件落盘、异常退出后按 backoff 重启、连续崩溃达到上限后标记 crash loop。
- [x] `server/services/supervisor-health-service.test.ts` 验证 health JSON 原子写入和 Next 端口监听状态更新。

**测试命令：**

```bash
npx tsx --test --test-concurrency=1 server/services/dev-supervisor.test.ts server/services/supervisor-health-service.test.ts
npm run dev
```

**验收标准：**

- 删除 `logs/` 后执行 `npm run dev`，目录与 `logs/dev-server.log` 自动重建。
- Next dev 异常退出后，`logs/dev-supervisor.log` 至少包含退出码、signal、子进程 pid、restartCount、backoffMs。
- `kill -TERM <next-pid>` 后 supervisor 自动拉起 Next，`http://127.0.0.1:3000/api/health` 在 30 秒内恢复 200。
- Task 1 完成后，`kill -TERM <next-pid>` 可独立验收 Next 自动重启；Task 6 完成后再验收 worker 自动重启。
- 不再依赖 `screen` 判断服务是否存在；用 `lsof -nP -iTCP:3000 -sTCP:LISTEN` 和日志共同判断。

### Task 2: Provider Run 生命周期表、接口与事件（由后续证据追认完成）

> 本节历史复选框由 Task 9-14（含 Task 14A）的最终闭环证据追认完成，不代表存在 Task 2 独立 commit。

**目的：** 把 `provider_process_started` / ended / heartbeat / orphaned 从零散事件变成可恢复的系统事实。

**Files:**

- Create: `server/db/migrations/0014_provider_run_lifecycle.sql`
- Modify: `server/db/schema.ts`
- Create: `server/services/provider-run-lifecycle-service.ts`
- Create: `server/services/provider-process-lease-service.ts`
- Create: `server/services/provider-run-lifecycle-service.test.ts`
- Create: `server/services/provider-process-lease-service.test.ts`
- Modify: `server/repositories/run-ledger-repository.ts`

**实施步骤：**

- [x] migration 创建 `provider_run_processes` 表和索引。
- [x] `server/db/schema.ts` 增加 Drizzle table 定义，字段与上文一致。
- [x] `provider-run-lifecycle-service.ts` 实现：
  - `startProviderRun(input)`：insert/upsert `provider_run_processes(status="running")`，写 `events.type="provider_process_started"`。
  - `heartbeatProviderRun(runId, pid)`：更新 `last_heartbeat_at`，写入频率由调用方控制为 15 秒一次。
  - `finishProviderRun(input)`：更新 terminal 状态，写 `provider_process_ended`、`provider_process_failed`、`provider_process_stopped` 或 `provider_process_orphaned`。
  - `isPidAlive(pid)`：使用 `process.kill(pid, 0)`，`ESRCH` 为 false，`EPERM` 为 true。
  - `withProviderRun(input, fn)`：try/catch/finally 包住 provider 调用，确保正常、异常都写 terminal。
- [x] `provider-process-lease-service.ts` 实现 worker 进程租约：
  - `leaseProviderProcess(input: ProviderProcessLeaseInput)`：把 jobId、workerId、runId、phase、provider、pid/externalRef 绑定。
  - `heartbeatProviderLease({ jobId, workerId, runId })`：更新 provider 与 job 双 heartbeat。
  - `releaseProviderLease({ jobId, runId, status })`：terminal 时释放 lease，防止新 worker 抢占同一 run。
- [x] `run-ledger-repository.ts` 增加 `insertEventWithRetry` 或调用 `server/db/write-boundary.ts` 中的重试写入，事件写失败时抛出 typed error，不能静默吞掉 terminal event。
- [x] 测试覆盖正常结束、异常结束、PID 不存在、重复 ended 幂等、事件与表状态一致、worker lease heartbeat 和 release。

**测试命令：**

```bash
npx tsx --test --test-concurrency=1 server/db/migrate.test.ts server/services/provider-run-lifecycle-service.test.ts server/services/provider-process-lease-service.test.ts
npm test
```

**验收标准：**

- 对同一 `runId` 调用 `startProviderRun` 后 DB 有 `provider_run_processes.status=running`，events 有 `provider_process_started`。
- provider throw 后 DB terminal 为 `failed`，events 有 `provider_process_failed`，`runs.status` 不再保持 running。
- 当前事故形态 `started(pid=72925)` 且 PID 不存在时，恢复服务能标记 `orphaned`。

### Task 3: 父子进程退出协议与 provider adapter 包装（由后续证据追认完成）

> 本节历史复选框由 Task 9-14（含 Task 14A）的最终闭环证据追认完成，不代表存在 Task 3 独立 commit。

**目的：** Provider worker 结束、异常、父进程退出时必须写 terminal/ended 事件，父进程死掉时也能被 recovery 检出。

**Files:**

- Modify: `server/services/ai-engine-types.ts`
- Modify: `server/services/pipeline-engine-service.ts`
- Modify: `server/services/ai-engine-adapter.ts`
- Modify: `server/services/claude-engine.ts`
- Modify: `server/services/codex-engine.ts`
- Modify: `server/services/pipeline-document-stage-runner-service.ts`
- Modify: `server/services/pipeline-service.ts`
- Modify: `server/services/claude-engine.test.ts`
- Modify: `server/services/codex-engine.test.ts`
- Modify: `server/services/ai-engine-adapter.test.ts`
- Create: `server/services/provider-worker-protocol.test.ts`

**实施步骤：**

- [x] `server/services/ai-engine-types.ts` 增加 lifecycle callback 接口，并把它挂到 `AiRunInput`：

```ts
export interface AiRunLifecycleProcessStarted {
  provider: AiProvider;
  pid: number | null;
  ppid: number;
  externalRef?: string | null;
  startedAt: string;
}

export interface AiRunLifecycleTerminal {
  provider: AiProvider;
  pid: number | null;
  exitCode?: number | null;
  signal?: string | null;
  status: "completed" | "failed" | "stopped";
  summary: string;
  endedAt: string;
}

export interface AiRunLifecycleSink {
  onProcessStarted(event: AiRunLifecycleProcessStarted): void | Promise<void>;
  onHeartbeat(event: {
    provider: AiProvider;
    pid: number | null;
    externalRef?: string | null;
    observedAt: string;
  }): void | Promise<void>;
  onTerminal(event: AiRunLifecycleTerminal): void | Promise<void>;
}

export interface AiRunInput {
  // existing fields stay unchanged
  lifecycle?: AiRunLifecycleSink;
}
```

- [x] `pipeline-engine-service.ts` 暴露 `createProviderLifecycleSink({ jobId, workerId, changeId, runId, phase, provider, roundId })`，sink 内部调用 Task 2 的 `startProviderRun`、`heartbeatProviderRun`、`finishProviderRun` 和 `provider-process-lease-service.ts`。
- [x] `pipeline-document-stage-runner-service.ts` 对所有 `engine.run` 构造 lifecycle sink，传入 `changeId`、`runId`、`phase`、`provider`、`roundId`、`jobId`、`workerId`。
- [x] 在 `pipeline-service.ts` 的 `runSpecCritic` 单独传 `phase: "spec_critic"`，不能继续用 `phase: "plan"` 掩盖蓝方 critic。
- [x] `claude-engine.ts` 在 `spawn(...)` 返回 `proc` 后立即调用 `input.lifecycle?.onProcessStarted({ provider: "claude", pid: proc.pid ?? null, ppid: process.pid, startedAt })`，不能等 `engine.run` 结束后才返回 PID。
- [x] `claude-engine.ts` 在 stdout/stderr 数据到达或定时器 tick 时调用 `onHeartbeat`；`close` 事件调用 `onTerminal({ status: code === 0 ? "completed" : "failed", exitCode: code, signal })`；timeout 强杀先写 `stopped` 或 `failed` terminal。
- [x] `codex-engine.ts` 如果 Codex SDK 不暴露本地 PID，必须在 thread 创建后立即调用 `onProcessStarted({ provider: "codex", pid: null, ppid: process.pid, externalRef: thread.id ?? null })`；每次 stream event 或 run polling tick 调用 `onHeartbeat({ pid: null, externalRef: thread.id })`；run 完成/异常调用 `onTerminal`。
- [x] `ai-engine-adapter.ts` 保持 loader 透传，不吞掉 `AiRunInput.lifecycle`；`ai-engine-adapter.test.ts` 验证 fake engine 收到 lifecycle sink。
- [x] 父进程监听 `beforeExit`、`SIGINT`、`SIGTERM`，对本进程持有的 active provider runs 写 `aborted` best-effort event。
- [x] `claude-engine.test.ts` 使用 fake spawn 验证 spawn 后立即触发 `onProcessStarted`，并在 close 前至少触发一次 heartbeat。
- [x] `codex-engine.test.ts` 使用 fake Codex constructor 验证无 PID 时写 `pid=null`、`externalRef=thread.id`、heartbeat 和 terminal。
- [x] `provider-worker-protocol.test.ts` 使用 fake engine 验证：正常返回写 ended，throw 写 failed，父进程 signal handler 写 stopped/aborted。

**测试命令：**

```bash
npx tsx --test --test-concurrency=1 server/services/provider-worker-protocol.test.ts server/services/claude-engine.test.ts server/services/codex-engine.test.ts server/services/ai-engine-adapter.test.ts server/services/pipeline-service.test.ts
npm test
```

**验收标准：**

- Spec red 和 blue critic 都有各自 provider lifecycle 记录。
- Claude provider 在 spawn 后、AI 输出前已经记录真实 PID。
- Codex provider 在无法获得 PID 时记录 `pid=null`、`externalRef=thread.id`，并依靠 heartbeat 判断活性。
- `RUN-mrdpj1ud-7096080c` 这种只有 started 没 ended 的状态，在进程仍活时显示 active，在 PID 死亡时 recovery 统一终止。
- 父进程收到 SIGTERM 后，active provider run 至少出现 `provider_process_stopped` 或可由下一次 recovery 标为 `orphaned`。

### Task 4: 启动与状态刷新自动恢复全部 stale running（由后续证据追认完成）

> 本节历史复选框由 Task 9-14（含 Task 14A）的最终闭环证据追认完成，不代表存在 Task 4 独立 commit。

**目的：** Next 启动、health 检查、页面状态刷新、SSE 连接建立时，自动恢复 DB 半截 running，覆盖 Spec red/blue、TechSpec、Plan、TestPlan、Build、Review、local_check、Fix、Release、Retro；QA 只作为 gate/domain 派生状态，不作为 provider run phase。

**Files:**

- Create: `server/services/stale-provider-run-recovery-service.ts`
- Modify: `server/services/spec-battle-repair-service.ts`
- Modify: `server/services/build-stale-run-recovery-service.ts`
- Modify: `server/services/action-contract-self-heal-service.ts`
- Modify: `server/services/review-run-service.ts`
- Modify: `server/services/review-center-state-service.ts`
- Modify: `server/services/review-qa-gate-service.ts`
- Modify: `server/services/stage-authority-service.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/events/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/events/stream/route.ts`
- Create: `server/services/stale-provider-run-recovery-service.test.ts`
- Create: `server/scripts/repair-stale-provider-runs.ts`

**实施步骤：**

- [x] `stale-provider-run-recovery-service.ts` 实现 `recoverStaleProviderRuns({ changeId?, execute, staleAfterMs })`。
- [x] 查询条件：
  - `runs.status = "running"`；
  - provider lifecycle 为 `running` 或只有 `provider_process_started`；
  - `pid` 为 null 且 heartbeat 超过阈值，或 `pid` 非 null 且 `isPidAlive(pid) === false`。
- [x] Spec red 恢复规则：
  - `runs.phase="spec"` 且 `battle_rounds.status="red_running"`；
  - 无 red artifact、无 blue artifact、无 report；
  - 将 `runs.status` 置 `failed`，写 summary `Provider process disappeared during spec red run`；
  - 将 `battle_rounds.status` 置 `failed`，写 `ended_at`；
  - 将 `changes.status` 置 `BLOCKED`、`blocked_phase="spec"`，并刷新 action contract。
- [x] Spec blue 恢复规则：
  - `battle_rounds.status="blue_running"` 或 provider phase `spec_critic`；
  - red artifact 存在时保留 red 成果，蓝方失败时将 round 置 `failed`，用户可 retry spec；
  - 写 `provider_process_orphaned` 和 `spec_round_failed` 事件。
- [x] 通用 document stage 恢复规则覆盖 `tech_spec`、`generate_plan`、`test_plan`、`release`、`retro`：
  - 将 `runs.status="running"` 的 run 置 `failed`，`ended_at=now`，summary 写 `Provider process disappeared during <phase>`；
  - 若存在 `stage_runs.status="running"`，调用 `completeStageRun({ status: "failed", errorCode: "provider_process_orphaned" })` 或等价 repository 更新；
  - `tech_spec` 将 `changes.status` 回到 `SPEC_READY` 并刷新 TechSpec action contract；
  - `generate_plan` 将 `changes.status` 回到 `TECHSPEC_READY` 或当前合法 Plan 前置 gate，刷新 Plan action contract；
  - `test_plan` 将 `changes.status` 回到 `PLAN_APPROVED`，刷新 TestPlan action contract；
  - `release` 将 `changes.status` 回到 `MERGE_READY` 或 release 前置 gate，刷新 Release action contract；
  - `retro` 将 `changes.status` 保持或回到 `RETRO_PENDING`，刷新 Retro action contract；
  - 以上回滚必须使用合法 transition；不合法时将 change 置 `BLOCKED` 并写 `blocked_phase=<phase>`。
- [x] Build 恢复复用 `recoverStaleBuildRun`，但改用 provider lifecycle PID 判断替代 `lsof +D` 作为优先信号；恢复后 `runs.failed`、build run file/record failed、`changes.status="PLAN_APPROVED"`，action contract 允许 retry build。
- [x] Review 恢复规则覆盖 `runs.phase="review"`：
  - `runs.running` 置 `failed`；
  - `review_attempts.status="running"` 和 `review_attempts.review_status="running"` 置 `failed`，写 `ended_at/completed_at`、`error_code="provider_process_orphaned"`、`sanitized_error_summary`；
  - `review_state.review_status` 置 `failed`，`gate_status` 置 `blocked` 或保留 latest valid report gate；
  - 重新计算 review center state 和 action contract，使 `run_review` 可 retry，QA 不可继续。
- [x] local_check 恢复规则覆盖 `runs.phase="local_check"`；当前代码没有 QA run phase，QA 是 gate/domain 名称：
  - `runs.running` 置 `failed`；
  - `stage_runs.phase="QA"` running 置 `failed`，`errorCode="provider_process_orphaned"`；
  - QA gate 置 blocked，required action 写 retry/check rerun；
  - `changes.status` 置 `CHECK_FAILED`，如果没有 QA run 产物则保留或回到 `IMPLEMENTED` 并写 recovery event 说明未产生检查结果；
  - 刷新 `action-contract-qa-policy.ts` 与 `review-qa-gate-service.ts` 派生状态。
- [x] Fix 恢复规则覆盖 `runs.phase="fix_findings"`：
  - `runs.running` 置 `failed`；
  - `stage_runs.phase="Fix"` running 置 `failed`；
  - 不递增 `fixIterations`；
  - `changes.status` 回到进入 fix 前的 `CHECK_FAILED`、`SCOPE_FAILED` 或 `IMPLEMENTED`；若无法确定 pre-fix 状态则置 `BLOCKED`、`blocked_phase="fix"`；
  - 刷新 Fix action contract，使用户可以 retry fix 或回到 review/check。
- [x] `action-contract-self-heal-service.ts` 在计算 action 前调用 dry-run inspection；发现 stale running 时执行恢复，再重新计算 action。
- [x] `app/api/projects/[id]/changes/[changeId]/route.ts`、`events/route.ts` 和 `events/stream/route.ts` 在 GET/SSE start 前调用 `recoverStaleProviderRuns({ changeId, execute: true })`，避免页面刷新或 SSE 重连仍显示永久 running。
- [x] `server/scripts/repair-stale-provider-runs.ts` 支持：

```bash
npx tsx server/scripts/repair-stale-provider-runs.ts --dry-run
npx tsx server/scripts/repair-stale-provider-runs.ts --execute
npx tsx server/scripts/repair-stale-provider-runs.ts --change CHG-xxx --execute
```

**测试命令：**

```bash
npx tsx --test --test-concurrency=1 server/services/stale-provider-run-recovery-service.test.ts server/services/spec-battle-repair-service.test.ts server/services/build-stale-run-recovery-service.test.ts server/services/review-run-service.test.ts server/services/review-qa-gate-service.test.ts
npx tsx server/scripts/repair-stale-provider-runs.ts --dry-run
npm test
```

**验收标准：**

- 构造 `runs.running + battle_rounds.red_running + provider pid dead`，执行恢复后 `runs.failed`、`battle_rounds.failed`、`changes.BLOCKED`。
- 构造 `blue_running + red artifact present + provider pid dead`，恢复后 red artifact 不删除，round failed，action 允许 retry。
- 构造 `tech_spec`、`generate_plan`、`test_plan`、`release`、`retro` running + dead provider，恢复后 run/stage_run terminal，change 回到对应前置 gate 或 BLOCKED，action contract 可重新发起该阶段。
- 构造 Review running + dead provider，恢复后 `review_attempts.failed`、`review_state.review_status=failed`，QA action 不可继续，Review retry 可用。
- 构造 `local_check` running + dead provider，恢复后 QA gate blocked，change 为 `CHECK_FAILED` 或合法前置状态，retry check 可用。
- 构造 Fix running + dead provider，恢复后不递增 `fixIterations`，change 回到 fix 前置状态或 BLOCKED，retry fix 可用。
- 页面刷新 GET 与 SSE 连接建立都能触发恢复，刷新后不再展示永久 `spec_round_running`。
- dry-run 不写 DB，execute 写 DB，结果行包含 `runId`、`phase`、`pid`、`action`、`reason`。

### Task 5: SQLite 锁竞争 P0 治理（由后续证据追认完成）

> 本节历史复选框由 Task 9-14（含 Task 14A）的最终闭环证据追认完成，不代表存在 Task 5 独立 commit。

**目的：** 降低 Next 主进程、provider worker、手动 repair 同时访问 SQLite 时的 `database is locked` 风险。

**Files:**

- Create: `server/db/write-boundary.ts`
- Modify: `server/db/index.ts`
- Modify: `server/repositories/run-ledger-repository.ts`
- Modify: `server/repositories/stage-authority-repository.ts`
- Modify: `server/services/change-status-service.ts`
- Modify: `server/services/pipeline-run-ledger-service.ts`
- Modify: `server/services/stage-raw-capture-service.ts`
- Modify: `server/services/provider-process-lease-service.ts`
- Modify: `server/services/spec-battle-service.ts`
- Modify: `server/services/stale-provider-run-recovery-service.ts`
- Create: `server/db/sqlite-lock-retry.test.ts`
- Create: `scripts/acceptance-crash-resilience.ts` 中的 `sqlite-lock` case

**实施步骤：**

- [x] `server/db/index.ts` 保留 WAL、`foreign_keys=ON`，将 `busy_timeout` 从固定 5000 改为环境变量 `CC_AI_SQLITE_BUSY_TIMEOUT_MS`，默认 10000。
- [x] `write-boundary.ts` 提供：

```ts
export function withSqliteWriteRetry<T>(
  label: string,
  write: () => T,
  options?: { attempts?: number; baseDelayMs?: number }
): T;
```

遇到 `SQLITE_BUSY`、`SQLITE_LOCKED`、`database is locked` 时最多重试 5 次，延迟 50ms、100ms、200ms、400ms、800ms，并写结构化日志。

- [x] `server/repositories/run-ledger-repository.ts` 中 `createRun`、`endRun`、`updateChangeStatus`、`insertEvent`、`insertArtifact`、`insertFinding` 全部通过 `withSqliteWriteRetry`。
- [x] `server/services/pipeline-run-ledger-service.ts` 中 `createRun`、`endRun`、`insertArtifact`、post-commit side-effect event 写入全部通过 repository retry，不保留绕过 repository 的直接 `db.insert`。
- [x] `server/services/change-status-service.ts` 中 `transitionChangeStatus` 的 transaction 通过 `withSqliteWriteRetry("change-status.transition", ...)` 包裹；`transitionChangeStatusWithDb` 保持可注入 tx，但所有生产调用必须走 retry wrapper。
- [x] `server/repositories/stage-authority-repository.ts` 的 stage state/run/report/gate/action 写入全部通过 `withSqliteWriteRetry`；`withStageAuthorityTransaction` 只包短 DB 更新。
- [x] `server/services/stage-raw-capture-service.ts` 的 raw capture artifact/event 写入通过 retry；文件写入先完成，DB 写入短事务记录，失败时返回 typed `stage_raw_capture_db_write_failed`。
- [x] `server/services/provider-process-lease-service.ts` 的 lease、heartbeat、release 全部通过 retry，heartbeat 写失败时 worker 记录日志并在下一 tick 重试，不延长 provider run 的 DB transaction。
- [x] `spec-battle-service.ts` 检查 `transitionChangeStatusWithDb`、round 更新、gap/claim/review/report 写入，事务只包 DB 更新，不包文件写入、provider 调用、report 生成。
- [x] `stale-provider-run-recovery-service.ts` 对每个 run 的恢复使用小事务；单个 run 恢复失败不能阻塞其它 stale run，结果里返回 `failed_to_recover` 和 typed reason。
- [x] 添加迁移检查脚本或测试扫描直接写路径：`server/db/sqlite-lock-retry.test.ts` 读取 `server/**/*.ts`，允许 schema/migration/test/fake db，生产代码中 `db.insert(`、`db.update(`、`db.transaction(` 必须出现在 approved write boundary、repository 或明确 tx 注入函数中。
- [x] `scripts/acceptance-crash-resilience.ts --case sqlite-lock` 打开独立 better-sqlite3 connection 持有短写锁，同时触发 provider terminal event 写入，验证 retry 后成功或返回 typed lock error。

**测试命令：**

```bash
npx tsx --test --test-concurrency=1 server/db/sqlite-lock-retry.test.ts server/services/provider-run-lifecycle-service.test.ts
npx tsx scripts/acceptance-crash-resilience.ts --case sqlite-lock
npm test
```

**验收标准：**

- 模拟 300ms 写锁时 terminal event 最终写入成功。
- 模拟超过重试预算的锁时 API/worker 返回明确 `sqlite_write_busy`，日志有 label、attempt、duration。
- 代码审查确认 provider 调用期间不持有 SQLite transaction。
- 生产路径直接 `db.insert`、`db.update`、`db.transaction` 的扫描结果只剩 DB 初始化、migration、测试夹具和 approved write boundary。

### Task 6: API 从直接执行 pipeline 改为入队/dispatch（由后续证据追认完成）

> 本节历史复选框由 Task 9-14（含 Task 14A）的最终闭环证据追认完成，不代表存在 Task 6 独立 commit。

**目的：** Next API 不再直接承载长时间 AI pipeline，避免 HTTP dev server 与 provider 长任务同生共死。

**Files:**

- Create: `server/db/migrations/0015_pipeline_jobs.sql`
- Modify: `server/db/schema.ts`
- Create: `server/services/job-dispatch-service.ts`
- Create: `server/services/pipeline-job-lease-service.ts`
- Create: `server/services/pipeline-job-runner-service.ts`
- Create: `server/services/job-dispatch-service.test.ts`
- Create: `server/services/pipeline-job-lease-service.test.ts`
- Create: `server/services/pipeline-job-runner-service.test.ts`
- Create: `scripts/pipeline-worker.ts`
- Modify: `package.json`
- Modify: `scripts/dev-supervisor.ts`
- Modify: `server/services/supervisor-health-service.ts`
- Modify: `server/services/supervisor-health-service.test.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/spec/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/tech-spec/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/plan/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/test-plan/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/implement/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/review/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/check/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/fix/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/release/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/retro/route.ts`

**实施步骤：**

- [x] `server/db/migrations/0015_pipeline_jobs.sql` 新增 `pipeline_jobs` 表：
  - `id text primary key`
  - `change_id text not null`
  - `phase text not null`
  - `action_id text not null`
  - `idempotency_key text`
  - `status text not null`，取值 `queued | leased | running | succeeded | failed | canceled`
  - `leased_by text`
  - `lease_expires_at text`
  - `heartbeat_at text`
  - `attempt_no integer not null default 1`
  - `error_code text`
  - `error_summary text`
  - `created_at text not null`
  - `started_at text`
  - `ended_at text`
  - unique index: `(change_id, action_id, idempotency_key)` where idempotency_key is not null。
- [x] `server/db/schema.ts` 增加 `pipelineJobs` table。
- [x] `job-dispatch-service.ts` 提供 `enqueuePipelineJob({ changeId, phase, actionId, idempotencyKey })`，只写 `queued` job 和 `pipeline_job_queued` event，不执行 pipeline。
- [x] `pipeline-job-lease-service.ts` 提供 `leaseNextPipelineJob({ workerId, now })`、`heartbeatPipelineJob({ jobId, workerId })`、`completePipelineJob(...)`、`failPipelineJob(...)`；lease 使用短事务和 `withSqliteWriteRetry`。
- [x] `pipeline-job-runner-service.ts` 根据 job phase 调用 `runSpec`、`runTechSpec`、`generatePlan`、`runTestPlan`、`runImplementStreamed`、`runReview`、`runCheck`、`runFixStreamed`、`runRelease`、`runRetro`；每次 provider 调用必须传入 `jobId` 和 `workerId` 给 lifecycle sink。
- [x] `scripts/pipeline-worker.ts` 独立进程循环 lease job，执行 `pipeline-job-runner-service.ts`，写 `logs/pipeline-worker.log`，每 10 秒 job heartbeat，空队列时 sleep 1000ms。
- [x] `package.json` 增加 `"worker:pipeline": "tsx scripts/pipeline-worker.ts"`。
- [x] `scripts/dev-supervisor.ts` 在 Task 1 的 Next supervisor 基础上扩展为同时启动并守护 `npm run worker:pipeline`；worker stdout/stderr 写 `logs/pipeline-worker.log`；worker 崩溃使用 Task 1 同一套 backoff 和 crash-loop 上限；worker crash-loop 时只停止重启 worker，Next 继续监听 3000。
- [x] `server/services/supervisor-health-service.ts` 的 `logs/supervisor-health.json` 增加 worker pid、restartCount、lastExit、lastHealthAt、crashLoop。
- [x] API route 只做 guard、preflight、idempotency key，然后调用 dispatch，返回 `202 { success: true, jobId, accepted: true }`。
- [x] `spec/route.ts`、`tech-spec/route.ts`、`plan/route.ts`、`test-plan/route.ts`、`implement/route.ts`、`review/route.ts`、`check/route.ts`、`fix/route.ts`、`release/route.ts`、`retro/route.ts` 都必须只调用 `enqueuePipelineJob`。
- [x] 上述 route 不直接 import 或 call `runSpec`、`runTechSpec`、`generatePlan`、`runTestPlan`、`runImplementStreamed`、`runReview`、`runCheck`、`runFixStreamed`、`runRelease`、`runRetro` 等长任务函数。
- [x] 禁止把 Next 进程内异步执行作为验收方式；如果测试需要 fake runner，只能注入到 `pipeline-job-runner-service.test.ts`，生产 API route 仍只入队。

**测试命令：**

```bash
npx tsx --test --test-concurrency=1 server/services/job-dispatch-service.test.ts server/services/pipeline-job-lease-service.test.ts server/services/pipeline-job-runner-service.test.ts server/services/supervisor-health-service.test.ts server/services/dev-supervisor.test.ts server/services/pipeline-routes.test.ts
npm test
```

**验收标准：**

- `app/api/.../spec/route.ts` 不再直接调用 `runSpec`。
- API 返回 202 时 DB 已有 `pipeline_jobs.status="queued"` 和 `pipeline_job_queued` 事件。
- `scripts/pipeline-worker.ts` 能 lease job，将 job 从 `queued` 推进到 `running`，执行完成后写 `succeeded` 或 `failed`。
- `release/route.ts` 和 `retro/route.ts` 返回 202 queued job，源码中没有 `runRelease` 或 `runRetro` 的直接 import/call。
- 杀 pipeline worker 后，Next dev 仍监听 3000；supervisor 自动拉起 worker；刷新页面能显示 stale run 已恢复或可恢复。
- 不启动 worker 时，API 仍能入队并返回 202，但不会在 Next 进程执行长任务。

### Task 7: 启动自检与健康检查（由后续证据追认完成）

> 本节历史复选框由 Task 9-14（含 Task 14A）的最终闭环证据追认完成，不代表存在 Task 7 独立 commit。

**目的：** 服务启动时主动修复 stale state，并让 `/api/health` 报告 DB、日志、worker、recovery 状态。

**Files:**

- Create: `server/services/startup-recovery-service.ts`
- Modify: `app/api/health/route.ts`
- Modify: `app/api/health/route.test.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/events/stream/route.ts`
- Modify: `scripts/dev-supervisor.ts`
- Create: `server/services/startup-recovery-service.test.ts`

**实施步骤：**

- [x] `startup-recovery-service.ts` 实现 lazy singleton：

```ts
export async function ensureStartupRecovery(): Promise<StartupRecoveryResult>;
export function getStartupRecoverySnapshot(): StartupRecoverySnapshot;
export function resetStartupRecoveryForTest(): void;
```

- [x] `ensureStartupRecovery()` 在每个 Next 进程内只执行一次；并发调用共享同一个 promise，步骤为：
  - ensure `logs/` exists；
  - 检查 DB 可打开；
  - 执行 `recoverStaleProviderRuns({ execute: true })`；
  - 写 `startup_recovery_completed` 事件或日志。
- [x] 明确入口约束：Next App Router 没有传统 server startup hook，因此启动恢复使用 lazy singleton，由健康检查和读路由触发。
- [x] `app/api/health/route.ts` 的 GET 第一行必须 `await ensureStartupRecovery()`，失败时返回 `ok: false` 和 recovery error，不能静默成功。
- [x] `app/api/projects/[id]/changes/[changeId]/route.ts` 的 GET 必须先 `await ensureStartupRecovery()`，再调用 `recoverStaleProviderRuns({ changeId, execute: true })`。
- [x] `app/api/projects/[id]/changes/[changeId]/events/stream/route.ts` 的 GET/SSE start 必须先 `await ensureStartupRecovery()`，再调用 `recoverStaleProviderRuns({ changeId, execute: true })`，然后再读取 existing events 和开启 polling。
- [x] `app/api/health/route.ts` 返回：
  - `ok`
  - `db.ok`
  - `logs.exists`
  - `recovery.lastRunAt`
  - `staleRunning.count`
  - `worker.mode`: `external_worker`
  - `worker.healthy`
  - `worker.lastHeartbeatAt`
  - `supervisor.next.portListening`
  - `supervisor.worker.crashLoop`
- [x] `dev-supervisor.ts` 启动 Next 后轮询 `/api/health`，失败时写 `dev_server_health_failed`。

**测试命令：**

```bash
npx tsx --test --test-concurrency=1 server/services/startup-recovery-service.test.ts app/api/health/route.test.ts
npm test
```

**验收标准：**

- 服务重启后 stale running 不需要手动 SQL 修。
- `/api/health`、change detail GET、SSE 连接建立都能触发 lazy startup recovery。
- `/api/health` 能指出 `logs/` 缺失、DB 不可写、stale running 数量。
- recovery 失败不会让 health 静默 `ok: true`。
- health 响应中的 worker mode 必须是 `external_worker`。

### Task 8: 强制事故验收脚本（由后续证据追认完成）

> 本节历史复选框由 Task 9-14（含 Task 14A）的最终闭环证据追认完成，不代表存在 Task 8 独立 commit。

**目的：** 把本次事故场景固化为可重复验收，防止再次只修局部 prompt。

**Files:**

- Create: `scripts/acceptance-crash-resilience.ts`
- Create: `server/services/crash-resilience-acceptance.test.ts`
- Modify: `docs/test-plan.md`

**实施步骤：**

- [x] `crash-resilience-acceptance.test.ts` 构造 SQLite fixture 覆盖：
  - dead PID + `runs.running` + `battle_rounds.red_running`
  - dead PID + `blue_running`
  - dead PID + `tech_spec`、`generate_plan`、`test_plan`、`review`、`local_check`、`fix_findings`、`release`、`retro`
  - `logs/` 缺失
  - `SQLITE_BUSY`
  - parent signal before provider ended
  - Next killed while worker remains supervised
  - worker killed while Next remains listening
- [x] `scripts/acceptance-crash-resilience.ts` 提供本地人工验收命令：

```bash
npx tsx scripts/acceptance-crash-resilience.ts --case kill-next
npx tsx scripts/acceptance-crash-resilience.ts --case kill-worker
npx tsx scripts/acceptance-crash-resilience.ts --case kill-provider --change <changeId> --run <runId> --execute
npx tsx scripts/acceptance-crash-resilience.ts --case delete-logs
npx tsx scripts/acceptance-crash-resilience.ts --case sqlite-lock
npx tsx scripts/acceptance-crash-resilience.ts --case restart-recovery
```

- [x] `docs/test-plan.md` 增加 Crash Resilience 章节，列出 `kill-next`、`kill-worker`、`kill-provider`、`delete-logs`、`sqlite-lock`、`restart-recovery` 六个 case、预期 DB 状态、预期日志文件、预期 UI 行为。

**测试命令：**

```bash
npx tsx --test --test-concurrency=1 server/services/crash-resilience-acceptance.test.ts
npx tsx scripts/acceptance-crash-resilience.ts --case kill-worker
npx tsx scripts/acceptance-crash-resilience.ts --case delete-logs
npm test
```

**验收标准：**

- 杀 Next 主进程：`logs/dev-supervisor.log` 有退出记录；重启后页面可打开；stale running 被恢复。
- 杀 Next 主进程：supervisor 自动拉起 Next，3000 在 30 秒内恢复监听，worker 不被误杀。
- 杀 pipeline worker：Next 仍监听 3000，supervisor 自动拉起 worker，`logs/pipeline-worker.log` 记录新 pid。
- 杀 Claude/Codex provider 子进程：provider lifecycle 标为 failed/orphaned；业务 run 不再永久 running。
- 删除 `logs/`：下一次 `npm run dev` 自动重建，并保留新的 startup 日志。
- DB lock 模拟：短锁自动重试成功；长锁返回可诊断错误。
- 重启后恢复：`runs.status=running` 且 PID 已死的记录被置为 terminal，Spec action 不再卡在 running。

## 独立审核返工任务

以下 Task 9-14 是 2026-07-10 独立审核判定 BLOCKED 后新增的返工项；该历史阻塞现已全部解除。每个任务的“写集”是实施时采用的并行边界：执行代理不得修改其它任务的写集；共享文件只能由标注的唯一任务持有，跨任务需求通过已定义接口交接。

### Task 9: Intake 与 PRD Briefing 全部入队（P0）

**目的：** 清除 Next route 内所有 `setImmediate`、fire-and-forget Promise 或直接 AI 调用，使 Intake 及 PRD Briefing 的 questions/draft/final-review 与其它 pipeline phase 一样只入队并返回 202。

**独占写集：**

- `app/api/projects/[id]/changes/[changeId]/intake/route.ts`
- `app/api/projects/[id]/changes/[changeId]/prd-briefing/questions/route.ts`
- `app/api/projects/[id]/changes/[changeId]/prd-briefing/draft/route.ts`
- `app/api/projects/[id]/changes/[changeId]/prd-briefing/final-review/route.ts`
- `server/services/job-dispatch-service.ts`
- 新建 `server/services/pipeline-job-types.ts`
- `server/services/pipeline-job-runner-service.ts`
- `server/services/job-dispatch-service.test.ts`
- `server/services/pipeline-job-runner-service.test.ts`
- `server/services/pipeline-routes.test.ts`

**接口与实施：**

- [x] 当前代码不存在独立 `PipelineJobPhase`；Task 9 只新建 `server/services/pipeline-job-types.ts` 并导出 `PipelineJobPhase`、`PipelineJobActionId`、`EnqueuePipelineJobInput`、`PipelineJobPayload`、`parsePipelineJobPayload(row)`。`PipelineJobPhase` 明确包含 `intake`、`prd_briefing_questions`、`prd_briefing_draft`、`prd_briefing_final_review` 及现有全部 phase；本任务仅修改 `job-dispatch-service.ts`、`pipeline-job-runner-service.ts` 和四个 route 消费该类型。`pipeline-job-lease-service.ts`、`server/db/schema.ts` 与 migration 明确留给 Task 10，Task 9 不修改。
- [x] Task 9 过渡签名固定为 `enqueuePipelineJob(input: EnqueuePipelineJobInput): PipelineJobPayload` 和 `runPipelineJob(job: PipelineJob | PipelineJobPayload, options?: RunPipelineJobOptions): Promise<void>`；runner 入口第一步必须调用 `parsePipelineJobPayload`，对 schema/lease 暂时返回的裸 string phase 做穷举运行时校验，未知 phase fail closed。测试通过 `options.runnerMap` 注入 runner。Task 9 不引入伪造 `JobExecutionContext`，也不修改 worker/lease/schema。
- [x] `runPipelineJob(job, options)` 在 runner map 中新增 `runIntake`、`runPrdBriefingQuestions`、`runPrdBriefingDraft`、`runPrdBriefingFinalReview` 映射，route 不得 import 这些 runner。
- [x] Task 9 完成证据记录 `pipeline-job-types.ts` 导出、未知 phase 拒绝测试和 runner 过渡签名的 commit。Task 10 接收后让 lease/schema 映射直接产出 `PipelineJobPayload`，删除 `PipelineJob | PipelineJobPayload` 联合兼容分支，并一次性切换为 `runPipelineJob(job: PipelineJobPayload, context: JobExecutionContext, options?: RunPipelineJobOptions): Promise<void>`；同步修改 worker及所有调用点，两个签名不得长期并存。
- [x] 四个 POST route 只执行 payload/action guard、preflight、dispatch，返回 `202 { success: true, accepted: true, jobId, status: "queued" }`。
- [x] 使用 TypeScript AST 增加 route 扫描测试：对 `app/api/**/route.ts` 拒绝 `setImmediate` CallExpression；拒绝从 `pipeline-service`、`prd-briefing-service`、`pipeline-*-stage-service` 导入 runner；拒绝 expression statement 形式的 Promise/async runner 调用。精确 allowlist 仅为 `GET` 查询 handler、`setTimeout` 用于 SSE 等待、`queueMicrotask` 不涉及 AI 的响应清理；allowlist 以 AST node kind + 文件 + symbol 三元组列出，禁止目录级或正则整文件放行。

**测试与完成证据：**

```bash
CI=true pnpm exec tsx --test --test-concurrency=1 server/services/job-dispatch-service.test.ts server/services/pipeline-job-runner-service.test.ts server/services/pipeline-routes.test.ts
rg -n "setImmediate|runIntake|runPrdBriefingQuestions|runPrdBriefingDraft|runPrdBriefingFinalReview" app/api
```

- 四个 route 行为测试证明只新增 queued job，响应返回后 runner 调用次数仍为 0；worker 消费后才变为 1。
- `rg` 结果不得显示 route 内 `setImmediate` 或上述 runner 调用。
- 保存测试命令、退出码、通过数和四类 job 的 DB 行/event 摘要，作为 Task 9 完成证据。

### Task 10: Provider lifecycle 上下文、fencing 与全路径覆盖（P0/P1）

**目的：** 让每个 worker job 和每次 provider 执行具备不可混淆的 execution identity，修复 lease 恒为 false，并覆盖 Build/Fix streamed path、signal registry 与 Codex 无 PID 场景。

**独占写集：**

- `server/services/pipeline-job-runner-service.ts` 仅 Task 9 完成后顺序交接
- `server/services/pipeline-job-lease-service.ts`
- `scripts/pipeline-worker.ts`（Task 10 完成后顺序交接给 Task 12，禁止并行修改）
- `server/services/pipeline-service.ts`
- `server/services/pipeline-engine-service.ts`
- `server/services/pipeline-build-stage-service.ts`
- `server/services/pipeline-document-stage-runner-service.ts`
- `server/services/provider-process-lease-service.ts`
- `server/services/provider-run-lifecycle-service.ts`
- `server/services/ai-engine-types.ts`
- `server/services/claude-engine.ts`
- `server/services/codex-engine.ts`
- 新建 `server/services/job-execution-context.ts`
- 新建 `server/services/process-identity-service.ts`
- `server/db/schema.ts`
- 新建 `server/db/migrations/0016_process_identity_fencing.sql`（编号若已占用，以 `_journal.json` 的下一个可用序号为准并记录实际文件名）
- `server/db/migrations/meta/_journal.json`
- `server/services/pipeline-job-runner-service.test.ts`
- `server/services/pipeline-job-lease-service.test.ts`
- `server/services/pipeline-service.test.ts`
- `server/services/provider-process-lease-service.test.ts`
- `server/services/provider-run-lifecycle-service.test.ts`
- `server/services/ai-engine-adapter.test.ts`
- `server/services/claude-engine.test.ts`
- `server/services/codex-engine.test.ts`
- `server/services/provider-worker-protocol.test.ts`
- 新建 `server/services/process-identity-service.test.ts`
- `server/db/migrate.test.ts`

**接口与实施：**

```ts
export interface JobExecutionContext {
  jobId: string;
  workerId: string;
  leaseToken: string;
  attemptNo: number;
}

export interface ProviderLifecycleContext extends JobExecutionContext {
  changeId: string;
  runId: string;
  phase: ProviderRunPhase;
  provider: AiProvider;
  roundId?: string | null;
}

export interface ProcessIdentity {
  pid: number;
  ppid: number | null;
  pgid: number | null;
  nonce: string;
  processStartTime: string;
  cwd: string;
  command: string[];
}

export interface ProcessIdentityProbe {
  capture(pid: number, expected?: Partial<ProcessIdentity>): Promise<ProcessIdentity>;
  validate(expected: ProcessIdentity): Promise<
    | { ok: true; observed: ProcessIdentity }
    | { ok: false; reason: "pid_missing" | "pid_reused" | "ppid_dead" | "ppid_mismatch" | "cwd_mismatch" | "command_mismatch" | "nonce_mismatch"; observed?: Partial<ProcessIdentity> }
  >;
}
```

- [x] `job-execution-context.ts` 独占定义 `JobExecutionContext`；`process-identity-service.ts` 独占定义 `ProcessIdentity`、`ProcessIdentityProbe` 和平台适配实现。Task 10 完成后接口冻结：Task 12 只能消费并写 supervisor identity，Task 11/13 只能调用 `validate`，不得复制或另建 identity 类型。
- [x] migration 为 `pipeline_jobs` 增加 `lease_token`、`worker_nonce`，为 `provider_run_processes` 增加 `job_id`、`worker_id`、`lease_token`、`attempt_no`、`process_nonce`、`process_start_time`、`process_ppid`、`process_pgid`、`process_cwd`、`process_command_json`；索引覆盖 `(job_id, lease_token, attempt_no)` 与 `(pid, process_start_time, process_nonce)`。
- [x] worker lease 成功时在 `pipeline-job-lease-service.ts` 原子生成不可复用 `leaseToken`；`scripts/pipeline-worker.ts` 构造必填 `JobExecutionContext` 并调用 `runPipelineJob(job, context)`。该 context 必须传到 `pipeline-service.ts` 的所有入口、所有 stage runner 和 `createProviderLifecycleSink`，生产代码不得使用 optional context 让 `hasLease` 静默变 false。
- [x] `leaseProviderProcess`、heartbeat、release 均 compare-and-set `jobId + workerId + leaseToken + attemptNo`；旧 worker 的 heartbeat/terminal 写返回 typed `stale_lease_fence`，不得覆盖新 attempt。
- [x] Provider start 时调用共享 `ProcessIdentityProbe.capture`，把完整 provider identity 与 execution context 写入 `provider_run_processes`；Build 与 Fix 的每个 `engine.runStreamed` 都接收 lifecycle sink，started、周期 heartbeat、terminal 与业务 run 使用同一 `runId`。
- [x] 增加进程级 active-provider registry；signal handler 只终止本进程注册且身份仍匹配的 provider，并 best-effort 写 stopped，注册/注销必须幂等。
- [x] Codex 在拿到 thread 后持久化 `externalRef=thread.id`，即使 stream 静默也由独立定时器周期 heartbeat；terminal/finally 必须停止 timer。

**测试与完成证据：**

- Build/Fix streamed fake engine 断言 lifecycle 顺序为 exactly one started、至少一个 heartbeat、exactly one terminal。
- 两个 worker 竞争同一 job：旧 token 的 heartbeat、release、terminal 全部被 fencing 拒绝，新 token 状态不受影响。
- signal registry 测试证明只处理本进程 active entry；Codex 静默 stream 测试证明周期 heartbeat 且 timer 最终释放。
- 证据包含 DB 中 job、provider、run 三者相同 identity 的查询结果，以及上述定向测试退出码。
- 交接证据：Task 10 提交后记录 `scripts/pipeline-worker.ts` 的基线 commit；Task 12 从该 commit 开始只增加 supervisor/worker identity 与 liveness，不得改 fencing、lease token 或 runner context 语义。

### Task 11: Recovery 完整状态空间与逐 run 隔离（P0/P1）

**目的：** recovery 从“只扫 provider running”升级为业务 run、provider lifecycle、job lease 三方对账，覆盖所有崩溃窗口和身份失效条件。

**独占写集：**

- `server/services/stale-provider-run-recovery-service.ts`
- `server/services/startup-recovery-service.ts`
- `server/services/action-contract-self-heal-service.ts`
- `server/scripts/repair-stale-provider-runs.ts`
- `server/services/stale-provider-run-recovery-service.test.ts`
- `server/services/startup-recovery-service.test.ts`
- 新建 `server/services/action-contract-self-heal-service.test.ts`
- `app/api/health/route.ts`
- `app/api/projects/[id]/changes/[changeId]/route.ts`
- `app/api/projects/[id]/changes/[changeId]/events/route.ts`
- `app/api/projects/[id]/changes/[changeId]/events/stream/route.ts`
- Task 10 冻结后的 `server/services/process-identity-service.ts` 只读消费，不在本任务修改

**接口与状态矩阵：**

```ts
recoverStaleProviderRuns(input): Promise<{
  recovered: RecoveryResult[];
  failed: RecoveryFailure[];
}>;
```

- [x] 扫描 `runs.status=running`，不能以存在 `provider_run_processes.status=running` 为前置条件；同时反向扫描 provider/job terminal 但业务 run 未 terminal 的记录。所有判断使用同一次 `observedAt`，避免扫描过程中阈值漂移。
- [x] 固定信号优先级：`provider terminal` > `fencing/lease 已失效` > `ProcessIdentityProbe.validate 失败（含 ppid_mismatch）` > `pid missing/ppid dead` > `provider heartbeat stale` > `provider 未 start grace 超时` > `Build/Fix legacy no-lifecycle grace 超时`。`ppid_mismatch` 与其它 identity mismatch 一样立即 fail closed，高优先级 terminal 结论不得被低优先级“PID 尚活”覆盖。
- [x] 固定默认阈值并允许测试注入：`providerStartGraceMs=30_000`、`providerHeartbeatStaleMs=45_000`、`legacyLifecycleGraceMs=60_000`；job stale 以持久化 `lease_expires_at <= observedAt` 为准，不另设隐式阈值。
- [x] 每个恢复动作使用 CAS：业务 run 条件为 `id + status=running + updatedAt/startedAt expected`；provider 条件为 `id + status=running + leaseToken/attemptNo expected`；job 条件为 `id + status in (leased,running) + leaseToken/attemptNo expected`。CAS 影响 0 行返回 `already_reconciled`，不得重复写 terminal/event 或覆盖新 attempt。

**八行 recovery 矩阵：**

| # | 触发信号与阈值 | Before | provider / job / run | stage / change | event / action After |
| --- | --- | --- | --- | --- | --- |
| 1 | business run 已创建，provider 未 start，超过 30s | provider=missing；job=running；run=running | provider 写 synthetic `orphaned(no_start)`；job/run CAS -> failed | stage/round CAS -> failed；change 回合法前置 gate 或 BLOCKED | exactly one `provider_start_missing`；retry action enabled |
| 2 | provider 已 terminal，立即处理 | provider=completed/failed/stopped/orphaned；job/run 仍 running | 保留 provider terminal。`failed/stopped/orphaned` 一律令 job/run CAS -> failed；`completed` 只有在阶段提交证据已完整持久化时才令 job/run CAS -> succeeded/completed，否则按 `provider_completed_business_incomplete` 失败补偿 | 有完整提交证据时 stage/round/review/build 与 change 按现有 transition policy 推进；缺少 structured output、artifact、Spec blue/report、Review report/finding、Build collect/adoption 等任一阶段证据时，附属记录失败并回合法前置 gate | exactly one `business_run_reconciled`；事件 rawJson 记录 `providerTerminal`、`businessEvidenceComplete` 与缺失证据；action 与最终业务 terminal 一致，证据不完整时 retry enabled |
| 3 | Build/Fix 无 lifecycle，超过 60s | provider=missing；job/run=running；phase=implement/fix_findings | synthetic provider orphaned；job/run CAS -> failed | Build/Fix stage -> failed；change 回 build/fix 合法前置状态 | `legacy_lifecycle_missing`；retry_build/retry_fix enabled |
| 4 | PID 不存在，立即处理 | provider=running 且 identity pid missing | provider CAS -> orphaned；job/run CAS -> failed | stage/round -> failed；change 回合法 gate | `provider_process_orphaned(pid_missing)`；retry enabled |
| 5 | PID 存在但 start time/nonce/cwd/command 不符，立即处理 | provider=running，`validate=pid_reused/*_mismatch` | provider CAS -> orphaned；job/run CAS -> failed，不 signal observed PID | stage/round -> failed；change 回合法 gate | `provider_identity_mismatch`；retry enabled |
| 6 | `ppid` 不存在或与记录不匹配，立即处理 | provider=running，child PID 可活，`validate=ppid_dead` 或 `ppid_mismatch` | provider CAS -> orphaned；job/run CAS -> failed；仅对 identity 仍匹配 child 执行受控终止 | stage/round -> failed；change 回合法 gate | `provider_parent_missing` 或 `provider_parent_mismatch` exactly once；retry enabled |
| 7 | heartbeat 超过 45s，且无更高优先级信号 | provider/job/run=running，identity 可匹配 | provider CAS -> orphaned；job/run CAS -> failed；受控终止匹配进程 | stage/round -> failed；change 回合法 gate | `provider_heartbeat_stale`；retry enabled |
| 8 | job lease 到期或 token/attempt 已 fenced，立即处理 | provider/run 仍 running；job stale 或已有新 attempt | 旧 provider CAS -> stopped/orphaned；旧 job/run CAS -> failed；新 attempt 不变 | 旧 stage -> failed；change 仅在无新 active attempt 时回退 | `stale_lease_fenced` exactly once；新 attempt action/running 不受影响 |

- [x] 每行必须断言 provider/job/run/stage(or round/review)/change/event/action 的 before→after；表中“合法前置 gate”由现有 phase transition policy 计算，不允许直接写任意 status。
- [x] `provider completed` 只表示 provider/SDK 调用结束，不等于业务阶段提交完成。恢复必须使用阶段专属的持久化证据判定业务成功，禁止仅凭 provider terminal 跳过 structured output 校验、artifact 写入、Spec blue/report、Review report/finding、Build result collection/adoption 或其它 provider 返回后的后处理。
- [x] PID 活性必须通过共享 `ProcessIdentityProbe.validate`，仅 `process.kill(pid, 0)` 不足以判定同一进程。
- [x] 每个 run 使用独立短事务与 try/catch；一个 run 恢复失败写 typed failure 并继续后续 run，返回 `recovered[]` 与 `failed[]`，health 不得把部分失败报告为全成功。
- [x] 恢复后重新计算 action contract，并验证 change detail GET、events GET、SSE initial snapshot 都不再暴露旧 running；UI 对应 action 回到 retry/合法前置 gate。

**测试与完成证据：**

- 表驱动测试逐项覆盖上述八行状态；第 6 行必须拆成 `ppid_dead` 与 `ppid_mismatch` 两个子用例，并断言 mismatch 时不误杀 observed parent/child。另加“第一个 run 写失败、第二个 run 仍恢复”和“重复 recovery 返回 already_reconciled 且不重复 event”的隔离/幂等测试。
- 对每个 fixture 断言 provider、business run、stage/review/round、change status、event、action contract 一致。
- 通过真实 route handler 测试断言 GET、SSE initial events 和 action response，不接受只调用内部函数的假对象断言。
- 证据包含矩阵每行的 before/after DB 摘要、失败隔离结果与定向测试退出码。

### Task 12: Supervisor 真实身份与 worker liveness（P0/P1）

**目的：** supervisor 不再把 npm wrapper PID 当作 Next/worker 身份，并能证明被观察、被 kill、被重启的是同一个真实进程组实例。

**独占写集：**

- `scripts/dev-supervisor.ts`
- `scripts/pipeline-worker.ts`（仅在 Task 10 完成并交接基线后修改 identity/liveness 部分）
- `server/services/supervisor-health-service.ts`
- `server/services/dev-supervisor.test.ts`
- `server/services/supervisor-health-service.test.ts`

**接口与实施：**

```ts
interface SupervisedProcessRecord {
  role: "next" | "pipeline-worker";
  identity: ProcessIdentity;
  startedAt: string;
  lastHeartbeatAt: string | null;
}
```

- [x] Task 12 不新建 identity 类型；从 Task 10 的 `process-identity-service.ts` import `ProcessIdentity` 与 `ProcessIdentityProbe`。supervisor 直接 spawn 可识别的 Next/worker executable 或建立独立 process group，调用 `capture` 写 supervisor identity；health 文件不得只记录 npm wrapper。
- [x] 每次 health/kill/restart 前调用共享 `validate` 校验 nonce、OS process start time、cwd、command、pgid；任一不匹配返回 `process_identity_mismatch` 且不发 signal。
- [x] worker 独立周期 heartbeat 写入 health/DB，包含 workerId、leaseToken 摘要、lastJobAt；supervisor 同时检查 OS identity 和 heartbeat freshness。
- [x] worker 假死但 PID 尚在时按明确阈值终止进程组并重启；旧实例后续写入由 Task 10 fencing 拒绝。

**测试与完成证据：**

- 使用真实临时子进程和临时端口验证 wrapper/child 区分、进程组退出、PID identity mismatch 拒杀、worker heartbeat stale 重启。
- 证据包含重启前后不同 nonce/start time、端口恢复、旧 worker fenced 的日志与测试退出码。

### Task 14A: SQLite typed error 基础（P0 前置）

**目的：** 在事故 harness 和后续写路径治理之前稳定 SQLite busy/locked 的公共错误契约，Task 10-13 只消费该接口。

**独占写集：**

- `server/db/write-boundary.ts`
- `server/db/sqlite-lock-retry.test.ts`

**接口与实施：**

```ts
export class SqliteWriteBusyError extends Error {
  readonly code = "sqlite_write_busy";
  readonly label: string;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly sqliteCode: "SQLITE_BUSY" | "SQLITE_LOCKED" | "UNKNOWN_LOCK";
}
```

- [x] `withSqliteWriteRetry` 只把可识别的 busy/locked 错误包装为 `SqliteWriteBusyError`，其它错误原样抛出；日志包含 label/attempt/elapsed/sqliteCode，不包含 SQL、参数、路径或业务内容。
- [x] 测试使用两个临时连接验证短锁重试成功、长锁抛 typed error、非锁错误不被误包装、日志脱敏。
- [x] Task 14A 完成后接口冻结并先交接给 Task 10/11，再交接 Task 13；Task 14 后续只能扩展扫描测试，不得改变错误字段语义。

**完成证据：** 定向测试命令与退出码、短锁实际等待时长、typed error 字段快照、脱敏日志快照。

### Task 13: 无假阳性事故验收与临时 DB 注入（P0）

**目的：** 把事故脚本和测试改为可证明发生真实故障的隔离验收，杜绝写 `server/db/ship.db`、任取真实 PID、仅看脚本自报 passed 等假阳性。

**独占写集：**

- `scripts/acceptance-crash-resilience.ts`
- `server/services/crash-resilience-acceptance.test.ts`
- 新增 `server/services/crash-resilience-harness.ts`
- `server/db/index.ts` 仅增加测试 DB 注入接口，不改 write retry 策略
- `docs/test-plan.md`（由本任务唯一持有）
- Task 10 冻结后的 `process-identity-service.ts` 与 Task 14A 的 `write-boundary.ts` 只读消费

**接口与实施：**

- [x] DB 初始化支持显式 `CC_AI_DB_PATH` 或 injected connection；测试为每个 case 创建临时目录/临时 SQLite，断言解析后的绝对路径不等于 `server/db/ship.db`，finally 清理。
- [x] harness 启动加载实际 route handler 的临时应用服务、真实 worker process、provider process 和随机空闲端口；验收先证明 PID/端口活着，再 kill，再证明退出/恢复，禁止 mock `process.kill` 充当事故证据。
- [x] SQLite case 使用两个独立 better-sqlite3 connection；一个真实持写锁，另一个执行生产 write boundary，分别证明短锁成功与长锁 typed failure。
- [x] `kill-provider` CLI 必须要求 `--change`、`--run`、`--execute`；默认 dry-run，查询必须唯一匹配且通过 Task 12 identity 校验，禁止自动选择任意 PID。
- [x] 每个 case 同时断言进程/端口事实、DB before/after、日志事件、change detail GET、SSE 初始事件、action contract；缺任一断言不得输出 passed。

**六 case 明细：**

| Case / 命令 | 隔离 fixture | 必须联合断言 | `finally` 清理 |
| --- | --- | --- | --- |
| `--case delete-logs` | temp root、temp logs、临时应用+worker、随机端口、temp DB | 删除前服务活；删除后 supervisor 重建三类日志；GET 200、SSE 可连、action 不变；真实 `logs/`/ship.db 不变 | TERM 临时进程组，关闭 DB，释放端口，删除 temp root |
| `--case sqlite-lock` | temp DB、两个独立 better-sqlite3 connection、短锁与长锁两轮 | 短锁生产写成功且 DB/event 可见；长锁返回 Task 14A typed error；GET/SSE/action 仍可诊断且无脏 terminal | rollback/关闭两连接，清 timer，删除 temp DB/root |
| `--case restart-recovery` | temp DB 八行 recovery fixture、临时应用、随机端口 | 重启前均为指定 before；重启后八行 DB/event/action 矩阵成立；GET/SSE 无 stale running | TERM 进程组，关闭 DB/SSE，删除 temp root |
| `--case kill-worker` | 临时应用、worker、queued/running job、identity+lease token、随机端口 | kill 前 identity/heartbeat/端口有效；kill 后应用端口不断、worker 新 nonce/start time、旧写 fenced、job 被新 worker 接管；GET/SSE/action 一致 | TERM 新旧进程组，等待退出，关闭 DB/SSE，删除 temp root |
| `--case kill-next` | 临时应用、独立 worker、running job、随机端口 | kill 前两 identity 有效；kill 后应用新 identity/端口恢复、worker identity 不变且 heartbeat 继续；DB/GET/SSE/action 无永久 running | TERM 应用/worker 进程组，关闭 DB/SSE，删除 temp root |
| `--case kill-provider --change <fixture-change> --run <fixture-run> --execute` | temp DB 中唯一 change/run、真实临时 provider、完整 identity、应用+worker、随机端口 | dry-run 不 signal；execute 前唯一匹配；execute 后目标退出且非目标存活；provider/job/run/stage/change/event/action、GET、SSE 全部符合 recovery | TERM 所有临时进程组，关闭 DB/SSE，清 timer，删除 temp root；任何断言失败也执行 |

**测试与完成证据：**

```bash
CI=true pnpm exec tsx --test --test-concurrency=1 server/services/crash-resilience-acceptance.test.ts
CI=true pnpm exec tsx scripts/acceptance-crash-resilience.ts --case delete-logs
CI=true pnpm exec tsx scripts/acceptance-crash-resilience.ts --case sqlite-lock
CI=true pnpm exec tsx scripts/acceptance-crash-resilience.ts --case restart-recovery
CI=true pnpm exec tsx scripts/acceptance-crash-resilience.ts --case kill-worker
CI=true pnpm exec tsx scripts/acceptance-crash-resilience.ts --case kill-next
CI=true pnpm exec tsx scripts/acceptance-crash-resilience.ts --case kill-provider --change <fixture-change> --run <fixture-run> --execute
```

- 测试前后记录真实 `ship.db` checksum/mtime，必须完全不变；临时 DB 路径写入测试日志。
- kill case 证据必须含选定 identity、signal 前后存活检查、端口检查、DB/GET/SSE/action 断言摘要。
- harness 维护资源 registry（process groups、servers、ports、DB connections、SSE readers、timers、temp paths），顶层 `try/finally` 逆序释放；清理后断言所有 PID 已退出、端口可重新 bind、连接已关闭、temp root 不存在。
- 所有事故演练只作用于 harness 创建的资源；任何 identity 不确定都 fail closed。

### Task 14: SQLite 诊断、写路径扫描与 UI/action 收口（P1）

**2026-07-11 完成状态：** 原子逐写 fencing、Program+TypeChecker inventory、固定逐写点 snapshot、provider worker ledger 裸写清零、可恢复 rework、原子 action check+enqueue 与 UI/action closure 已完成。最终隔离全量验证覆盖 104 个测试文件，1306/1306 通过、0 fail、0 cancelled；TypeScript 与 diff 检查通过，Task 14 双审 PASS。证据见 `docs/reports/2026-07-11-task-14-write-boundary-inventory-report.md`。

**目的：** 补齐 SQLite typed diagnostic、逐写路径治理和用户可见回退，形成全量审核证据。

**独占写集：**

- `server/repositories/run-ledger-repository.ts`
- `server/services/artifact-mirror-service.ts`
- `server/services/build-run-record-service.ts`
- `server/services/change-service.ts`
- `server/services/change-rework-service.ts`
- `server/services/change-status-service.ts`
- `server/services/context-init-service.ts`
- `server/services/event-service.ts`
- `server/services/execution-fence-service.ts`
- `server/services/gate-service.ts`
- `server/services/graph-runner.ts`
- `server/services/merge-readiness-service.ts`
- `server/services/pipeline-plan-stage-service.ts`
- `server/services/pipeline-prd-briefing-stage-service.ts`
- `server/services/pipeline-qa-stage-service.ts`
- `server/services/pipeline-release-retro-stage-service.ts`
- `server/services/plan-approval-service.ts`
- `server/services/plan-snapshot-service.ts`
- `server/services/prd-briefing-service.ts`
- `server/services/prd-document-service.ts`
- `server/services/prd-service.ts`
- `server/services/project-git-state-service.ts`
- `server/services/project-service.ts`
- `server/services/qa-run-service.ts`
- `server/services/refine-service.ts`
- `server/services/review-artifact-mirror-service.ts`
- `server/services/review-report-service.ts`
- `server/services/review-run-service.ts`
- `server/services/review-waiver-service.ts`
- `server/services/spec-battle-repair-service.ts`
- `server/services/spec-battle-report-service.ts`
- `server/services/spec-battle-service.ts`
- `server/services/techspec-api-snapshot-service.ts`
- `server/services/testplan-snapshot-service.ts`
- `server/services/action-contract-service.ts`
- `server/services/action-contract-build-policy.ts`
- `server/services/action-contract-qa-policy.ts`
- `server/services/action-contract-review-policy.ts`
- `app/projects/[id]/changes/[changeId]/use-change-detail-data.ts`
- `app/projects/[id]/changes/[changeId]/pipeline-ui-model.ts`
- `server/db/sqlite-lock-retry.test.ts`（Task 14A 完成后顺序交接，仅增加 AST inventory，不改变 typed error）
- `server/services/action-contract-service.test.ts`
- `server/services/change-route-guard.test.ts`
- `app/projects/[id]/changes/[changeId]/pipeline-ui-model.test.ts`

**当前直接写 inventory 与 owner（2026-07-10）：** 使用
`rg -l --glob '*.ts' --glob '!*.test.ts' --glob '!server/db/migrations/**' '\bdb\.(insert|update|delete|transaction)\s*\(' server app scripts | sort` 得到固定基线。两个非生产脚本 `scripts/test-retry-always-available.ts`、`scripts/test-state-machine-closure.ts` 进入精确 test-script allowlist，不属于生产写集。

- **Task 9 owner：** `server/services/job-dispatch-service.ts`。
- **Task 10 owner：** `server/services/pipeline-build-stage-service.ts`、`server/services/pipeline-document-stage-runner-service.ts`、`server/services/pipeline-job-lease-service.ts`、`server/services/pipeline-service.ts`、`server/services/provider-process-lease-service.ts`、`server/services/provider-run-lifecycle-service.ts`。
- **Task 11 owner：** `server/services/action-contract-self-heal-service.ts`、`server/services/stale-provider-run-recovery-service.ts`。
- **Task 14 owner：** 本节“独占写集”列出的直接写生产文件；其中 `execution-fence-service.ts` 是原子逐写 fencing transaction 的唯一 owner，`change-rework-service.ts` 是人工 rework 删除历史并回退状态的唯一短事务聚合 owner。action/UI 文件是 P1 回退消费方，不计入直接写基线。
- 交接顺序固定为 Task 9 -> Task 10 -> Task 11 -> Task 14。Task 14 先重跑同一 inventory；若出现新文件，必须先更新计划、指定唯一 owner 并经审核，不得临时扩大 glob 写集。

**接口与实施：**

- [x] 使用 TypeScript Program+TypeChecker 扫描 `server/**/*.ts`、`app/**/*.ts`、`scripts/**/*.ts`，追踪 DB/transaction/repository 完整 alias 数据流并排除无关方法。
- [x] 固定逐写点 snapshot；每项记录 `{ file, symbol, nodeKind, table, owner, reason }`。测试写入必须显式登记并证明隔离内存 DB 注入。
- [x] 扫描发现的生产写入全部进入精确 owner/write boundary，transaction 内无 provider、文件或网络 IO。
- [x] Task 11 recovery 已补齐 action contract、GET、SSE、UI model 闭环矩阵。

**测试与完成证据：**

- Task 14A typed error 测试继续通过；逐写 AST 扫描输出零个未分类生产写路径，并输出固定 inventory 与 owner diff。
- UI/action 表驱动测试覆盖 Intake、Spec red/blue、Build、Fix、Review、Check 和 PRD Briefing 回退。
- [x] 已完成最终隔离全量验证：104 个测试文件，1306/1306 通过、0 fail、0 cancelled；`CI=true pnpm exec tsc --noEmit --pretty false` 与 diff 检查通过。

## 返工验收顺序

1. **Task 9** 先封死所有 Next 内 AI 执行入口，建立 `pipeline-job-types.ts` 和完整 job phase 集合。
2. **Task 14A** 稳定 typed SQLite error；完成后把只读接口交给 Task 10/11/13。
3. **Task 10** 接收 Task 9 的 runner 写集，修改 lease/schema/migration/worker，贯通 execution context、fencing、provider identity、Build/Fix lifecycle、registry 与 Codex heartbeat；完成后把 `pipeline-worker.ts` 和共享 identity 接口交给 Task 12。
4. **Task 12** 只在 Task 10 交接后修改 worker identity/liveness，完成 supervisor/worker 真实身份；Task 11 可同时实现不依赖 identity 的纯 recovery matrix。
5. **Task 11** 消费冻结的 identity 接口，完成八行三方对账、CAS 幂等、逐 run 隔离以及 GET/SSE/action 回退。
6. **Task 13** 只在 Task 9、14A、10、12、11 全部定向通过后运行真实隔离事故验收，按 `delete-logs`、`sqlite-lock`、`restart-recovery`、`kill-worker`、`kill-next`、显式 fixture target 的 `kill-provider --execute` 顺序执行。
7. **Task 14** 接收前序任务固定 inventory，收口剩余 SQLite/UI/action，并最后运行全量 `pnpm test`、TypeScript 检查和独立审核。

**任务完成证据统一格式：** diff 范围、实际命令、退出码、通过/失败数、临时资源路径、关键 DB before/after、进程 identity、GET/SSE/action 摘要；不虚构 commit。上述证据已齐全，Task 10-14 独立双审均 PASS，历史 BLOCKED 已解除。

## 原实施顺序（历史基线，已由返工验收顺序取代）

以下顺序仅解释 Task 1-8 的原设计，不得作为当前执行顺序或完成证据：

1. Task 1 先落地，只守护 Next，保证 dev server 崩溃有日志且可自动重启。
2. Task 6 落地独立 pipeline worker 和 job queue，并在 worker 可启动后扩展 supervisor 守护 worker，立即停止由 Next API 执行长任务。
3. Task 2 和 Task 3 落地 provider lifecycle、lease 和 engine lifecycle callbacks。
4. Task 5 处理 SQLite 锁竞争，避免 worker/recovery/provider terminal 写入互相打架。
5. Task 4 把当前现场 `RUN-mrdpj1ud-7096080c` 类半截 running 和所有其它阶段纳入统一恢复。
6. Task 7 与 Task 8 完成启动自检、健康检查和事故验收闭环。

## P0 验收矩阵

| 事故场景 | 触发方式 | 必须看到的结果 | 验证命令 |
| --- | --- | --- | --- |
| Next dev 主服务退出 | harness 创建临时应用进程/端口并校验 identity 后发 TERM | 临时日志有 exit/restart，临时端口恢复，worker identity 未变化，真实开发服务不受影响 | `npx tsx scripts/acceptance-crash-resilience.ts --case kill-next` |
| pipeline worker 被杀 | harness 创建临时 worker 并校验 identity 后发 TERM | 临时应用端口持续监听，worker 以新 nonce/start time 重启，旧 lease 写被 fenced | `npx tsx scripts/acceptance-crash-resilience.ts --case kill-worker` |
| logs 目录消失 | 删除 harness 临时 logs 后启动 | 三类临时日志自动创建，真实 `logs/` 不变 | `npx tsx scripts/acceptance-crash-resilience.ts --case delete-logs` |
| Provider 子进程被杀 | harness 创建 provider 后，显式选择 change/run 并校验 identity | `provider_run_processes.status=orphaned` 或 `failed`，`runs.status=failed`，action 可 retry；真实 `ship.db` 不变 | `npx tsx scripts/acceptance-crash-resilience.ts --case kill-provider --change <fixture-change> --run <fixture-run> --execute` |
| red/spec 半截 running | fixture: `runs.running` + `battle_rounds.red_running` + dead PID | round failed，change blocked at spec，events 有 orphaned | `npx tsx --test --test-concurrency=1 server/services/stale-provider-run-recovery-service.test.ts` |
| blue/spec_critic 半截 running | fixture: `battle_rounds.blue_running` + red artifact + dead PID | red artifact 保留，round failed，retry_spec 可用 | `npx tsx --test --test-concurrency=1 server/services/stale-provider-run-recovery-service.test.ts` |
| 其它阶段半截 running | fixture: `tech_spec/generate_plan/test_plan/review/local_check/fix_findings/release/retro` + dead provider | run/stage/review/QA gate/action contract 全部 terminal 或回到合法前置 gate | `npx tsx --test --test-concurrency=1 server/services/stale-provider-run-recovery-service.test.ts` |
| SQLite lock | 独立 connection 持写锁 | 短锁 retry 成功，长锁 typed error | `npx tsx scripts/acceptance-crash-resilience.ts --case sqlite-lock` |
| 重启恢复 | 先制造 stale running，再重启 | `/api/health` 触发 lazy recovery 并报告 lastRunAt，页面与 SSE 不再 running | `npx tsx scripts/acceptance-crash-resilience.ts --case restart-recovery` |

## 非目标与容量升级路线

- 本计划不重写 Spec Battle 业务规则，不改变红方/蓝方输出 schema，不把 `battle_rounds` 替换为新表。
- P0 仍使用 SQLite，但所有写入通过短事务、busy timeout、retry 和统一 write boundary 收敛。
- 独立 worker 队列是 P0 必交付项；Next API 只入队，`scripts/pipeline-worker.ts` 执行长任务。
- 当并发写入、多人使用或长任务数量超过 SQLite 可靠边界时，迁移到 Postgres；迁移触发条件是连续一周仍出现 `sqlite_write_busy` terminal 写失败，或需要多个 worker 并发 lease job。

## 完成定义

本计划已满足以下全部完成条件：

- [x] Task 1-8 的历史审核阻塞全部由 Task 9-14（含 Task 14A）闭环，状态表有逐项完成证据，Task 10-14 独立双审均 PASS。
- [x] 所有 AI route，包括 Intake 与 PRD Briefing，只入队并返回 202；源码与行为测试均证明 Next route 不执行 AI。
- [x] 所有 provider AI 调用，包括 Build/Fix `runStreamed`，都有 lifecycle started、周期 heartbeat 与唯一 terminal；缺失 terminal 可被 recovery 检出。
- [x] `JobExecutionContext` 的 `jobId/workerId/leaseToken/attemptNo` 贯穿 job、run、provider lease；旧 attempt 的写入被 fencing 拒绝。
- [x] Claude spawn 后立即记录受校验的进程 identity；Codex 无 PID 时记录 thread externalRef，并在 stream 静默期间保持周期 heartbeat。
- [x] supervisor 和事故脚本基于真实 pid/pgid、nonce、start time、cwd、command 校验身份；不得依赖 npm wrapper PID 或任取 live PID。
- [x] recovery 完成业务 run、provider lifecycle、job lease 三方对账，覆盖未 start、provider terminal/business running、无 lifecycle Build/Fix、PID 复用、ppid 死亡、heartbeat stale，并逐 run 隔离失败。
- [x] `RUN-mrdpj1ud-7096080c` 同类 stale running 不需要手工 SQL 就能恢复。
- [x] crash resilience 自动化只使用临时 DB、临时进程和随机端口，真实 `server/db/ship.db` checksum/mtime 在测试前后不变。
- [x] 删除 `logs/`、杀 Next、杀 pipeline worker、显式选择并杀 provider、双连接模拟 DB lock、重启恢复六类事故均有进程/端口、DB、日志、GET、SSE、action contract 联合证据。
- [x] SQLite busy 返回稳定 typed diagnostic，结构化逐写路径扫描为零个未分类生产写入；provider/文件/网络操作不持有 DB transaction。
- [x] 每种 recovery 回退在 change detail、SSE 与 UI/action contract 中一致显示 terminal、retry 或合法前置 gate，不再显示陈旧 running。
- [x] 最终隔离全量验证覆盖 104 个测试文件，1306/1306 通过、0 fail、0 cancelled；2026-07-10 的全量失败仅保留为已解除的历史审查结论。
- [x] `pnpm exec tsc --noEmit --pretty false` 与 diff 检查通过；Task 13 事故验收 14/14，Task 14 报告及 Task 10-14 双审记录构成最终验收证据。

**最终验收结论（2026-07-11）：COMPLETE。** 当前无 P0/P1/P2 阻塞项。完成证据为 Task 11 SPEC/QUALITY PASS、Task 13 SPEC/QUALITY PASS、Task 14 SPEC PASS 与 FINAL FINAL QUALITY PASS、104 个测试文件 1306/1306 通过（0 fail、0 cancelled）、authority 路由 67/67、TypeScript/diff 检查通过、Task 13 14/14 事故验收及 Task 14 报告。审核 Agent ID、原始结论措辞与证据限制见[最终独立审核报告](../../reports/2026-07-11-provider-lifecycle-final-independent-review.md)；本计划未补写或虚构 commit。
