# Test Plan：stagepass 流水线改造测试计划

| 项 | 值 |
|---|---|
| 文档状态 | Draft（测试前置，供 Codex 自验） |
| 版本 | v2.0 |
| 关联 | [docs/task-breakdown.md](./task-breakdown.md)、[docs/implementation-anchors.md](./implementation-anchors.md) |

> 测试框架：`node:test` + `tsx`（`pnpm test`）。每个任务完成后必须跑对应用例 + `pnpm build` 绿色才算完成。

---

## 一、测试范围

| 范围 | 测什么 |
|---|---|
| 状态机 | 新状态转移合法性、门态不自动前进、不变式 |
| stage 函数 | 各 stage 的状态转移、产物落地、scope 校验（mock engine）|
| 人工门 | approve/reject 转移、canMerge 三条件校验 |
| stage-guard | 读写边界、plannedChanges 预声明、`.ship/` 豁免 |
| 迁移 | 全新 DB 迁移完整、幂等 |
| API 路由 | 触发 service、错误响应格式 |

### 不测范围

- 真实 AI 调用（engine 用 mock，不打真实 Codex/Claude）
- 前端渲染（手动验收）
- git 真实推送（已有 git-service 测试覆盖基础）

## 二、单元测试用例

### UT-1 迁移 runner（T0.1/T0.2）
- 全新内存 DB 跑 `runMigrations` → 6 张表 + 所有列存在
- 重复 `runMigrations` → 不报错、`__migrations` 不重复
- 已手动加过列的 DB → 跳过该语句不崩（幂等自愈）

### UT-2 状态机映射（T2.1–T2.3）
- 每个新 `ChangeStatus` 在展示层状态映射中有对应阶段（无 undefined）
- 每个新 `RunPhase` 在 `ROOT_FILES_BY_PHASE` 有条目
- `PHASE_ORDER` 包含全部 RunPhase

### UT-3 stage 函数转移（T2.7）— mock engine
| 用例 | 前置态 | 调用 | 期望后置 |
|---|---|---|---|
| intake 正常 | INTAKE_PENDING | runIntake | INTAKE_READY + change-request.md |
| spec 正常 | INTAKE_READY | runSpec | SPEC_READY + prd-delta.md |
| tech-spec 正常 | SPEC_READY | runTechSpec | TECHSPEC_READY + tech-spec-delta.md |
| plan 正常 | TECHSPEC_READY | generatePlan | PLAN_READY + plan.json/plan.md |
| test-plan 正常 | PLAN_APPROVED | runTestPlan | TESTPLAN_DONE + test-plan-delta.md，不自动 Build |
| build 正常 | PLAN_APPROVED | runImplementStreamed | IMPLEMENTING + BuildRun(awaiting_human)，吸附后 IMPLEMENTED |
| 错误前置态 | DRAFT | runSpec | 抛 Invalid status |
| engine 失败 | INTAKE_READY | runSpec(mock throw) | 回退 INTAKE_READY + run failed |

### UT-4 人工门（T3.1）
- approve intake 门：INTAKE_READY 保持不变（以 T2.7 stage 入口态为准）
- reject spec 门：SPEC_READY → INTAKE_READY（回到 runSpec 可重跑入口）
- 非门态 approve：抛 "Not at gate"
- canMerge：QA绿+Review通过+文档齐 → true
- canMerge 缺 test-plan-delta → false + missing 含该项
- canMerge 有 open P0 review finding → reviewPassed=false

### UT-5 stage-guard 读写边界（T2.5）
- `resolveReadableFiles`：只返回 readableFiles 命中的文件
- `validatePlannedChanges`：diff ⊆ plannedChanges → 不阻断
- diff 超出 plannedChanges → 阻断 + 列出越界文件
- `.ship/**` 变更 → 永不阻断（豁免）
- 现有 `validateImplementScope`/`validateFixScope` 不回归

## 三、集成测试用例

### IT-1 完整 9 阶段串联（mock engine）
INTAKE_PENDING 起，依次 runIntake → approve → runSpec → approve → runTechSpec → approve → runTestPlan →（自动）runImplement → runReview → runCheck → MERGE_READY → approve → runRelease → runRetro → DONE。
断言：每步状态正确、每阶段产物落地、最终 DONE。

### IT-2 QA 失败回环
runCheck 产生 findings → CHECK_FAILED → runFix → 自动 runCheck → 通过 → LOCAL_READY。
断言：fix_iterations 递增；达到 99 轮 → BLOCKED。

### IT-3 打回路径
SPEC_READY → reject → SPECCING → 重跑 runSpec → SPEC_READY。

## 四、Crash Resilience 事故验收

自动化基线：

```bash
CI=true pnpm exec tsx --test --test-concurrency=1 server/services/crash-resilience-acceptance.test.ts
```

人工/本地验收脚本统一入口：

```bash
pnpm exec tsx scripts/acceptance-crash-resilience.ts --case kill-next
pnpm exec tsx scripts/acceptance-crash-resilience.ts --case kill-worker
pnpm exec tsx scripts/acceptance-crash-resilience.ts --case kill-provider --change CHG-FIXTURE --run RUN-FIXTURE
pnpm exec tsx scripts/acceptance-crash-resilience.ts --case delete-logs
pnpm exec tsx scripts/acceptance-crash-resilience.ts --case sqlite-lock
pnpm exec tsx scripts/acceptance-crash-resilience.ts --case restart-recovery --execute
```

| Case | 命令 | 预期 DB 状态 | 预期日志 | 预期 UI 行为 |
|---|---|---|---|---|
| `kill-next` | `pnpm exec tsx scripts/acceptance-crash-resilience.ts --case kill-next` | 业务 DB 不新增半截 `running`；若已有 stale provider run，后续 health/lazy recovery 可恢复为 terminal | `logs/dev-supervisor.log` 有 `dev_server_exit`、`dev_server_restarting`；`logs/supervisor-health.json` 的 Next pid 更新且 `portListening=true` | 页面短暂不可用后 30 秒内恢复；worker 不因 Next 被杀而丢失监督 |
| `kill-worker` | `pnpm exec tsx scripts/acceptance-crash-resilience.ts --case kill-worker` | `pipeline_jobs` 中已 lease job 不被 Next 接管执行；lease 过期后可由新 worker 接管；provider run 仍由 lifecycle/recovery 收口 | `logs/dev-supervisor.log` 有 `pipeline_worker_exit`、`pipeline_worker_restarting`；`logs/pipeline-worker.log` 出现新 worker pid | 页面和 `/api/health` 持续可用；正在运行的变更不会永久卡在按钮禁用态 |
| `kill-provider` | dry-run：`pnpm exec tsx scripts/acceptance-crash-resilience.ts --case kill-provider --change CHG-FIXTURE --run RUN-FIXTURE`；执行：追加 `--execute` | 必须唯一匹配显式 change/run 且 identity 验证通过；dry-run 不发信号；执行后 provider/run/stage/job 回到 terminal 或合法前置 gate | events 至少有 orphaned/failed/recovered 证据，输出包含 identity 与 signal 前后存活状态 | GET、SSE 和 action contract 与 DB terminal 状态一致 |
| `delete-logs` | `pnpm exec tsx scripts/acceptance-crash-resilience.ts --case delete-logs` | 每案例使用 `STAGEPASS_DB_PATH` 临时 SQLite，真实 `ship.db` checksum/mtime 不变 | 删除临时 logs 后，真实 app/worker 进程重建 `dev-supervisor.log`、`dev-server.log`、`pipeline-worker.log` | 随机端口 GET 200、SSE 可连、action contract 不变 |
| `sqlite-lock` | `pnpm exec tsx scripts/acceptance-crash-resilience.ts --case sqlite-lock` | 短暂 `SQLITE_BUSY`/`SQLITE_LOCKED` 通过 `withSqliteWriteRetry` 成功；超过 attempt budget 返回 typed diagnostic，不静默吞写失败 | test/脚本输出包含 retry attempts；logger 可见 `SQLite write locked; retrying` | UI 不应因短锁直接失败；长锁失败时显示可诊断错误而不是无限 loading |
| `restart-recovery` | `pnpm exec tsx scripts/acceptance-crash-resilience.ts --case restart-recovery --execute` | 仅操作临时 DB；真实执行九 fixture（Task 11 八行矩阵，parent 两类拆分）并精确收口 provider/job/run/stage/change | 每行 expected snapshot 与 exactly-once event 均进入结构化 evidence | 真实 Next GET、SSE 与 action contract 必须和最终 DB 一致；未传 `--execute` fail closed |

隔离与清理硬门：每个 case 使用独立 temp root、随机端口和临时 SQLite；启动前断言 DB 绝对路径不等于 `server/db/ship.db`，前后校验真实 DB checksum/mtime。harness 只对自己创建且通过 process identity 校验的进程组发信号，并在 `finally` 逆序关闭进程、连接、reader、timer、端口和临时目录；identity 不确定时 fail closed。

Task 13 当前验收契约：

- 主验收进程只能静态导入无 DB 副作用模块；`server/db/config.ts` 提供纯路径解析。加载任何项目运行模块前后，均比较 `ship.db`、`ship.db-wal`、`ship.db-shm` 的 existence、SHA-256 与 mtime。
- `delete-logs`、`kill-next`、`kill-worker` 由真实 `createSupervisor` 管理 route app 与生产 `scripts/pipeline-worker.ts`；harness 不手工 replacement，必须观察 supervisor health 中的新 identity 和生产 restart/log 事件。
- `restart-recovery` 建立 Task 11 八行矩阵；parent failure 拆成 `ppid_dead`、`ppid_mismatch`，共九个 fixture。每行检查 provider/job/run/stage/change/event/action、detail GET、events GET、SSE initial，并重复恢复验证事件 exactly-once。
- `kill-worker` 由生产 worker 领取 lease；旧 context 的 heartbeat、complete、fail、execution fence 均必须返回 `stale_lease_fence`，新 worker 必须以新 nonce、workerId、leaseToken 和递增 attempt 接管。
- `kill-provider` dry-run/execute 共用唯一 selector；目标与非目标都验证 identity，所有 signal 前再次 validate。execute 只允许目标退出，非目标必须保持相同 nonce/start time。
- `sqlite-lock` 的短锁必须提交业务 terminal 与 exactly-one event；长锁必须返回含 `code/label/attempts/elapsedMs/sqliteCode` 的 typed error，且失败前后 DB 快照零漂移。
- 每个 fetch 与 SSE 都有独立 AbortSignal deadline；结果输出结构化 `evidence[]`，包含 DB、GET、SSE、action、process identity 与生产日志摘要。cleanup 对全部资源 best-effort，最后聚合错误，禁止首错后跳过后续清理。

补充自动化覆盖：

- `crash-resilience-acceptance.test.ts` 覆盖 dead PID + `red_running`、dead PID + `blue_running`、`tech_spec/generate_plan/test_plan/implement/review/local_check/fix_findings/release/retro` recovery。
- 同一测试覆盖 logs 缺失重建、SQLite retry、provider terminal，以及真实 supervisor 管理的 Next/worker 独立重启；若 `supervisor.stop()` 失败，注册表必须按 replacement identity 安全兜底，无法确认清理完成时保留临时目录。

## 五、回归范围

改动触及以下现有测试，必须保持通过：

| 现有测试 | 为何受影响 |
|---|---|
| `stage-guard-service.test.ts` | 边界函数扩展（含 3 个解 skip 用例）|
| `change-phase-service.test.ts` | CONTENT_PHASES / 映射扩展 |
| `change-rework-service.test.ts` | PHASE_ORDER / ROOT_FILES 扩展 |
| `prd-service.test.ts` | 状态机邻接（PRD 挂起逻辑）|
| `project-service.test.ts` | schema 加列后 seed 需同步 |
| `ai-provider-service.test.ts` | 不受影响（应保持绿）|
| `static-analyzer.test.ts` | 不受影响 |

**回归命令**：`pnpm test`（全量）+ `pnpm build`。

## 六、测试数据

- 用 `:memory:` SQLite + 手建表（参照现有 `project-service.test.ts` 的 `setupTestDb`），schema 需同步加 v2 新列。
- mock engine：返回固定 `CodexRunResult`，`structuredOutput` 按各 stage 期望产物构造。
- 临时仓库：`fs.mkdtempSync` 建 `.ship/` 结构。

## 七、通过标准

1. 全部 UT/IT 用例通过。
2. `pnpm test`：0 fail（skip 仅限明确标注 TODO 的）。
3. `pnpm build`：编译 0 error。
4. 回归测试无新增失败。
5. 现有 `ship.db` 启动后能正常加载（迁移不破坏存量数据）。

## 八、每任务验收对照

| 任务 | 验收用例 |
|---|---|
| T0.1/T0.2 | UT-1 |
| T0.3 | 3 个解 skip 用例 |
| T2.1–T2.3 | UT-2 + `pnpm build` |
| T2.5 | UT-5 |
| T2.7 | UT-3 |
| T3.1 | UT-4 |
| 全 Phase 2/3 完成 | IT-1/IT-2/IT-3 |

---

*测试前置：Codex 实现每个任务时同步写对应用例，红 → 绿。*
