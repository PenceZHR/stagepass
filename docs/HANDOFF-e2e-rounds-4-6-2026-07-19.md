# 交接：Codex 全链路 E2E Round 3–6 收尾（2026-07-19 下午）

> 分支 `codex/build-onwards-blocker-repair`。前序文档：
> - `docs/HANDOFF-e2e-rounds-2026-07-19.md`（上午交接，Round 3 卡在 CHECK_FAILED）
> - `docs/HANDOFF-failure-attribution-2026-07-18.md`
> - `docs/HANDOFF-audit-cleanup-2026-07-15.md`

---

## 一、结果

**四轮全部 12 阶段走完，全部 DONE。**

| Round | Project | Change | 仓库 | runs | 结果 |
|---|---|---|---|---|---|
| 3 | PRJ-014 e2e-semver-cx | CHG-015 | `/private/tmp/e2e-semver` | 19 | DONE |
| 4 | PRJ-015 e2e-backoff-cx | CHG-016 | `/private/tmp/e2e-backoff` | 15 | DONE |
| 5 | PRJ-016 e2e-bytesize-cx | CHG-017 | `/private/tmp/e2e-bytesize` | 18 | DONE |
| 6 | PRJ-017 e2e-globmatch-cx | CHG-018 | `/private/tmp/e2e-globmatch` | 15 | DONE |

所有 change 的 `stage_states` 全部 pass/passed。行协议 Round 4/5/6 分别 10/10、11/11、10/10 干净
（`structuredOutputSource=line_protocol`、`schemaDelivery=none`、rawText 无 `{"`、无 ` ```json `）。
**tech_spec 仍然完全不产生 raw capture**（老问题，见前序文档 §四.5，本轮未修）。

**测试基线：1923 → 1955 pass / 0 fail**（+32：本次 5 个修复自带的测试）。tsc / lint 干净。

**fix 阶段首次真正跑通**（详见 §三）。

---

## 二、本轮提交的 5 个修复

全部经过子代理双向变异验证（把 bug 放回去测试转红 + 反向过度放宽也转红），逐个 commit：

| commit | 修复 |
|---|---|
| `bfae7796` | `fix.md` 让模型去读 4 个 `.ship/changes/{id}/*` 文件，而构建工作区是 git 派生的、`.ship/` 被 gitignore，这些文件**结构上不可能存在** |
| `63db7793` | `retry_plan` 幻影动作：契约无 `requiredStatus` + `PLANNING` 无恢复 + UI 从不渲染按钮，三个缺陷一个死路 |
| `fb446f18` | QA 与 merge：解析**已批准**的 BuildRun，而不是磁盘上编号最大的 |
| `4a738e88` | Review：失败的 fix run 在**三个层次**上阻断重新审查 |
| `a11df777` | merge 脏工作区信任检查绑定到已批准的 BuildRun |

### 贯穿全部 5 个修复的同一个病根

**gate 读 DB，executor 读文件系统，两边对"哪个 BuildRun 是权威"给出不同答案。**

每一次 fix run 失败都会写一个编号更大的 `build-N.json`（status=failed），它会**遮蔽**真正被收编的 build。
gate 侧（`latestApprovedBuild`）按 DB 过滤 approved/adopted → build-1；
executor 侧（`readLatestBuildRun`）按文件名取最大编号、不过滤状态 → build-3（failed）。

于是 gate 承诺一个动作，POST 返回 202，worker 每次拒绝，**静默、永久、UI 无出路**。
QA、merge、re-Review 全是同一处分歧的不同表现。

普通用法就能撞到：review 报 P1 → 用户点「修复阻断项」→ fix 失败 → QA 和 merge 同时永久死掉。

`fb446f18` 加了 `readLatestApprovedBuildRun`（降序扫描，停在第一个 approved/adopted），
`4a738e88` 加了 `isDeadBuildRunStatus` 白名单（只跳过 `failed`/`rejected`——`gate_blocked` 是**可裁决**状态，
是 `rejectLatestBuildRun` 只接受的两个状态之一；`audit_ready` 声明了但没有任何服务端路径会写它），
`a11df777` 给 `assertAdoptedBuildRunMatchesWorkspace` 加了可选 `runNumber` 让调用方钉住自己已解析的 run。

**`readLatestBuildRun` 的语义没有改**——它的其它 11 个调用方（collect / approve / absorb / adopt / recovery）
真的就是要"我正在操作的那个 run"。子代理逐个审了全部 22 个调用点。

一句值得记住的话（来自 `a11df777` 的子代理）：

> 修复前的行为不是保护，是 gitignore 的意外。`e2e-semver` gitignore 了 `.ship/`，工作区是干净的，
> 这条分支根本不会执行。**一条只在用户碰巧 gitignore 某个目录时才成立的安全性质，不是安全性质。**

---

## 三、fix 阶段：从"从未跑通"到"完整闭环"

前序文档说 fix 是 12 阶段里唯一没被 E2E 过的。现在跑通了，过程值得记录。

**Round 3 的两次 fix 都正确地拒绝了动手**，但原因不同：
- RUN-251（修复前）：codex 花整轮去找 `.ship/changes/CHG-015/*` 四个文件，找不到，说"工作区没有注入所列文件"，提问后停手。
- RUN-252（修 `fix.md` 后）：codex 直接读注入的权威输入，给出精确理由——**注入的 DB TechSpec/API 自己就写着 `pending_human_decision`**。

两次都以 `Build workspace produced no changes` 失败，但只有第二次是正当理由。
FND-068 要求的是"补设计文档 + 拿人工 gate 决策"，fix 阶段（只能改代码）结构上关不掉，最终 waive。

**Round 5 才是真正的闭环**：review 报了 3 条真 P1，其中 FND-069 是**反方抓到的真 bug**——
`formatBytes(MAX_SAFE_INTEGER, binary, precision 0)` 返回 `"8 PiB"`，
但 `parseBytes("8 PiB")` = 9007199254740992 超出安全整数被拒，往返不变量实际被破坏。
（这段代码自带的 16 个测试全绿。）

fix → 收编 → 重新审查 → **三条全部标记 `fixed`**。这是 review→fix→adopt→re-review 完整走通。

### 但也撞到一个新问题：fix ↔ review 会振荡

Round 5 后续实测（两轮 fix，反方措辞里直接出现 "again"）：

```
fix#1 加 clamp   → FND-069/070 关闭，引入 FND-072/073（字面量特例："8 PiB" 可解析而 "8.0 PiB" 抛错）
fix#2 去掉 clamp → FND-072/073 关闭，行为一致，但 FND-069/070 原样复现为 FND-074/075
```

根因是 **Spec 自相矛盾**：同时要求 (a) parseBytes 拒绝非 safe integer 与 (b) 往返不变量恒成立，
而在 MAX_SAFE_INTEGER/binary/p0 处量化值恰为 2^53，两者数学上不可同时满足。

**fix 阶段没有任何通道能接收人工的 Spec 级裁决**，`MAX_FIX_ITERATIONS = 99`，
所以它会老老实实振荡 ~99 次。最后以 waiver 记录裁决放行（选择 (a)，把 (b) 的适用域显式收窄）。

> **给下一轮的判断准则**：fix 连续两轮把同一组 finding 换个编号退回来，就不要再点第三次。
> 那是 Spec 冲突，不是代码缺陷。直接 waive 并写清冲突在哪、选了哪一支。

---

## 四、操作纪律（前序文档那几条依然成立，这里只补新的）

1. **`运行 Retro` 第一次点击必然失败，返回 409 `gate_version_drift`，而 UI 不显示任何错误。**
   Round 3/4/5/6 **四轮全中**。merge 完成后 gate version 会 bump，而 UI 手里还是旧版本号。
   解法：重新加载页面 → 重新选 Retro 面板 → 再点，就是 202。
   前两轮我误判成"点击丢了"，是在 Round 5 挂了 fetch 钩子才看到 409 的。
   **这是一个真 bug，值得修**（要么 UI 拿到 409 后自动刷新重试，要么至少把错误显示出来）。

2. **阶段导航会自动跳到"最新 run 所属阶段"，不是你正在操作的阶段。**
   fix run 跑完后页面停在 Fix 面板，Review 的「接受 P1 风险」「进入 QA」全都不在 DOM 里。
   我一度据此判定"死锁了"——**是错的**，点一下导航栏的 Review 就全回来了。
   判断动作到底能不能用，去查 `GET /api/projects/{p}/changes/{c}/gate`，不要看按钮在不在。

3. **`批准 Merge` 会自动级联触发 merge**（约 2 秒后）。它不是只读的一步。
   Round 3 就是这样在我点 merge 之前先撞出了 `runRelease` 的 bug。

4. **模板类 prompt 改完不需要重启 worker**（`assemblePrompt` 每次调用 `fs.readFileSync`），
   但**服务端代码改完必须重启**。本轮重启点：38981 ← 2104 ← 15511 ← 31383 ← 48440。

5. **E2E 仓库的 gitignore 差异要保留，别"修"它。**
   `e2e-semver` gitignore 了 `.ship/`（工作区干净），另外三个没有（`?? .ship/` → 脏工作区）。
   正是这个差异暴露了 `a11df777`。**两种仓库各留一个**，比统一了更有价值。

---

## 五、Spec 对抗：怎么用才对（这条直接解决前序文档 §四.7）

前序文档记录的现象是"spec battle 里 waive 掉的 P1，其决议不会传播进 tech_spec"。
本轮找到了操作层面的解法，并且**实测验证**了：

- **`继续对抗一轮` 就是 `return_to_spec`，它的「处理意见」是把人工裁决喂进下一轮 Spec 修订的通道。**
  裁决会被写进 Spec 正文。
- **`waive_p1` 只写一条 decision 记录，不会进入 Spec 正文**，因此 tech_spec 看不见。

对照证据：

| | Round 3（waive） | Round 4/5/6（return_to_spec） |
|---|---|---|
| tech-spec-delta.json | `PublicExportContract: pending_human_decision`<br>`compareSemver public export: blocked_pending_human_decision` | **零个 pending_human_decision** |
| 下游后果 | review 报出无法关闭的 P1，fix 关不掉，只能 waive | review 干净（R4/R6）或只报真代码问题（R5） |

Round 3 的 `DEC-mrraj2ao`（04:23 决定 `src/index.js` 具名 ESM 导出）到 08:19 生成 tech_spec 时**仍未传播**，
中间隔了四个小时。这就是整条阻塞链的源头。

**代价**：多跑几轮对抗（Round 4 四轮、Round 5 三轮、Round 6 四轮），每轮 1–4 分钟。很划算。

**对抗循环会收敛，但会越来越细**。Round 4 的链条是
「普通对象判定 → 继承属性 → 属性读取次数」——每一条都是我上一条裁决的合理收窄，不是空转。
Round 6 反方甚至**正确驳回了我自己的一条规则**：我把「每个参数恰好读取一次」从 Round 4/5 的
options 对象场景照抄到 `matchGlob(pattern, path)`，反方指出 JS 在进入函数前已求值全部实参、
按值传入的字符串形参读取次数不可观察，该条款不可验收（P0）。**这条驳回是对的，我撤销了原条款。**

写 PRD / intent 时**提前把公共入口、对象校验、undefined 语义、校验顺序拍死**，能显著减少对抗轮数
（Round 5 只报 2 个 P1，Round 4 报了 3 P1 + 1 P2）。

---

## 六、还没修的（按优先级）

1. **`运行 Retro` 的 409 `gate_version_drift` 静默失败**（§四.1）。四轮全中，用户视角是"点了没反应"。
   最省事的修法：UI 收到 409 `gate_version_drift` 时自动重取 gate 并重试一次；至少要把错误显示出来。

2. **fix 阶段没有人工裁决通道**（§三）。Spec 级冲突会让 fix↔review 无限振荡，
   而 `MAX_FIX_ITERATIONS = 99` 不会救你。考虑：给 fix 注入 human_decisions，
   或在同一组 finding 二次退回时自动停下并提示"这是 Spec 冲突"。

3. **`retry_test_plan` 现在太窄，是镜像死路。** `registry:57` 钉死 `PLAN_APPROVED`，
   但 `runTestPlan` 走 `runDocumentStage`（running 态 `TESTPLANNING`），自 `8ac5c4ec` 起 runner
   **能**恢复 `TESTPLANNING`，而契约不肯入队。正是 `8ac5c4ec` 自己注释里警告的那个形状。
   另外它也有 UI 渲染缺口（`pipeline-ui-model.ts:138` 声明了，`page.tsx:676-681` 的 TestPlan 分支没渲染）。

4. **`retry_build` 是这一族的第四例。** `registry:59` 无 `requiredStatus`，
   而 `retryBuildStreamed` 只接受 `PLAN_APPROVED`/`IMPLEMENTING`。不是照抄就能修：
   它的 `recoverStaleBuildRun` 在清扫器把 run 置 failed 之后就放弃了，需要单独分析。

5. **`tech_spec` 完全不产生 raw capture**（前序 §四.5，四轮依旧）。它不设 `outputSchema`，
   `runDocumentStage:410` 直接跳过 `ingestStageAiOutput`：没有 raw capture、没有 lineage。出漂移无从 diff。

6. **`latestApprovedBuild` 的 tie-break 用 `id.localeCompare`**（`merge-readiness-service.ts:204`），
   而 `id` 是 `BRR-<sha256 前缀>`，与 run number 无关。两个 adopted run 同毫秒时可能选中较老的那个。
   已存在缺陷，`a11df777` 没有加重它（实测两条 HEAD 检查都会拦下），修法是按 run number tie-break。

7. **`graph-runner.ts` 的 `fixFindings()` 无人调用**，它指向的 `runFix`（非流式，
   `pipeline-build-stage-service.ts:898`）是死代码，且用 `project.repoPath` 会读到项目里那份**旧的**
   `.ship/prompts/fix.md`。live 路径是 `runFixStreamed`，已由 `bfae7796` 修好。死代码值得删。

8. **`refine` 阶段模型仍亲手写 JSON 且无 schema 校验**（前序 §四.4，未动）。
   `GENERAL_ACTION_IDS` 的兜底动作栏（`page.tsx:1342`）现在几乎所有阶段都够不到，是死代码，也会掩盖类似缺口。

9. **`pnpm test:acceptance` 12/14**（前序 §四.6，未动）。已定位为测试夹具缺口不是产品 bug。

---

## 七、数据清理（未做）

E2E 项目仍在库里：PRJ-004…PRJ-017。
清理时用项目自己的 `deleteProject` 服务级联删除，**保留 PRJ-001 某个本地项目、PRJ-013 小游戏**。
对应仓库：`/private/tmp/e2e-{semver,backoff,bytesize,globmatch}`。

---

## 八、四轮之后补充发现（已修）

**Codex 心跳的生命周期失败会杀掉整个 worker 进程。**

`codex-cli-engine.ts` 的两个心跳定时器直接调用 `lifecycle.onHeartbeat`，没有任何捕获。
`onHeartbeat` 声明是 `void | Promise<void>`，而流水线传入的是**同步分支**
（`heartbeatProviderLease` 底下全是 better-sqlite3，`withSqliteWriteRetry` 甚至用 `Atomics.wait` 阻塞），
所以 `StaleLeaseFenceError` 在返回 promise **之前**就抛出，成为 `uncaughtException`，worker 直接死。

**它会自我循环**：job 被围栏 → 心跳抛错 → worker 死 → supervisor 拉起 →
新 worker 围栏掉旧 worker 的在途 job → 再抛 → 再死。一次短会话里录到 3 次 fatal、4 次启动。

两处要点，都是当时判断错的：

- **`.catch()` 接不住** —— 必须 `Promise.resolve().then(...)` 包一层才能把同步抛转成 rejection。
  `claude-engine.ts:1008` 早就是这么写的，只是原因没被写下来。
- **心跳有两个位点**（`spawnAndCollect` 与 `runStreamed`），只修一个的话所有流式 Build/Fix 阶段照样死。

修复见 commit `fix(codex): stop a heartbeat lifecycle failure from killing the worker`。

> **顺带更正一条经验**：四轮 E2E 期间观察到的 worker 重启，此前被归因为机器睡眠（DarkWake）。
> 现在看，至少有一部分是这个自我循环造成的。「插电别合盖」仍然值得做，但它不是全部原因。
