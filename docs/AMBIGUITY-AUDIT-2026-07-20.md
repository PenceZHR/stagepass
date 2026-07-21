# 歧义审计 2026-07-20

收录标准：**同一个东西能被读成两种意思，且读错有具体后果。** 纯命名品味、纯风格问题不收。

每条格式：位置 / 两种读法 / 读错的后果 / 现状（是否已在生产发生）。

审计由五路并行子代理完成，四路交付，第五路「名字在说谎」未回（见 §6 未覆盖）。所有条目均带 `文件:行号`，可直接跳转核对。

---

## §1 一级：现在就在发生的静默失效

这一档的共同形状与刚修完的 `parseRedSpecOutput` 完全一致——**一个值同时表示「没有」和「没问题」**。

### 1.1 `rubric-gate-service.ts:197` — 「没判过」被当成「全过了」

```ts
const verdicts = [...latestRubricVerdictsByKey(scope).values()];
if (verdicts.length === 0) return [];
```

- 读法 A：所有 blocking criterion 都判了 `yes`，没什么可拦。
- 读法 B：这个 scope 根本没有判定批次——provider 死了、回复为空、harvest 被跳过。

**后果**：`pipeline-document-stage-runner-service.ts:532` 在回复为空时整个跳过 rubric harvest（条件是 `result.success && summary.trim().length > 0`），而这正是 codex 被 SIGTERM 后的形状（`success:true, summary:""`）。于是零条 assessment → `derived = []` → gate 停在 `passed`，不落行、不记事件。**一个本该被 81 条出厂标准评判的阶段，零条被评判地通过了，返回值与「全数通过」逐字节相同。**

**现状（实证更正，2026-07-21）**：**潜伏，不是活的。** 定性偏强了：

- 能阻断的阶段（Spec / TechSpec / TestPlan / Plan）**都有 `outputSchema`**，空回复先被 schema 拒掉、阶段大声失败，rubric 轮不到。
- `Retro` 是唯一有 rubric 却既无 `outputSchema` 也无 `lineProtocol` 的阶段，空回复确实一路走通——但生产库验证 `stage_gates` 没有 Retro 行，它的 rubric **本来就永远不能阻断**（`pipeline-release-retro-stage-service.ts:150-153` 明写）。
- 真实损害与 rubric 无关：**change 带着一个空的 retro.md 进 DONE**，六条 Retro 标准零条被判。

`:261-264` 那段大写原则（「ABSENCE IS NOT A THIRD WAY」）描述的是**关闭**路径，而 `:197` 在**开启**路径上，两者并不矛盾——开启需要 verdict 本来就是设计。

**已修（`92e6a74`）**：修的不是 `deriveRubricBlockers`，是更上一层——runner 现在拒绝「成功但空」的回复。`applyLineProtocol` 写着「callers already handle it」，而只有设了 `outputSchema` 的调用方真的 handle，没有任何东西强制这个配对。守卫放在 runner 让那句契约对每个阶段成立，包括还没写的。

> 仍是三级 rubric 设计的前置条件：一级标准若落在没有 schema 兜底的阶段上，空回复就是现成的绕过口。

### 1.2 `review-report-service.ts:233-242` — 上一轮的阻断 finding 蒸发

`parsePriorBlockingFindingIds` 在 `catch` 和 `!Array.isArray` 两条路上都 `return new Set()`。

- 读法 A：这次尝试确实没有遗留的阻断 finding。
- 读法 B：我们读不出遗留的阻断 finding 是哪些。

**后果**：`:279` 是把上一轮仍未关闭的 P0/P1 带进本轮结算集的**唯一**机制。空集合 → `blockingP0` 数到 0 → `action-contract-review-policy.ts:132-147` 把 `gateStatus` 从 `blocked_p0` 翻成 `passed` → `qaAllowed` 变 true → **带着未解决 P0 进 QA**。无日志无事件。

**现状**：同一列的另外三个读者全部 fail-loud 或 fail-closed（`review-structured-output-parser.ts:180-192` 抛异常、`action-contract-review-policy.ts:118-123` 作废缓存、`pipeline-review-stage-service.ts:743` 裸 `JSON.parse`）。**这一个是异类，而且正好是喂给门禁算术的那个。**

### 1.3 `local-check-service.ts:188` — QA 一条命令没跑就报 PASS

```ts
const success = results.every((r) => r.success);   // [].every(...) === true
```

- 读法 A：跑过的检查全过了。
- 读法 B：一条都没跑（`allChecks` 为空，或每个名字在 `commands` 里都没有对应命令——`:163` 的 `if (!cmd) continue`）。

**后果**：QA 工作区是 git worktree；没有 `.ship/policy.json` 且没有 lint/typecheck/test/build 脚本时 `results = []` → `success = true` → `pipeline-qa-stage-service.ts:287` 写 `MERGE_READY`。`:163` 更锋利：声明了 `requiredChecks: ["typecheck","test"]` 但没有对应命令时两条被静默跳过，「必需检查没有命令」与「必需检查通过了」不可区分。

**对照**：`testplan-snapshot-service.ts:260-265` 对同一份 TestPlan 数据把空集合判成 P0 blocker。**两个服务对「空」的含义相反。**

### 1.4 `scope-check-service.ts:42` — 范围检查检的是一个恒为空的变更集

```ts
const output = execSync("git diff --name-only", { cwd: repoPath, ... });
```

- 读法 A：git 说没有文件变动。
- 读法 B：git 调用失败（`:48` 的 catch 只 `log.warn`），或者我们问错了问题。

**现状（实证更正，2026-07-21）**：**「恒为空」是错的**，但缺陷真实存在，且更尖锐。

生产验证：CHG-001 的 build-5 / build-6 / build-7 三个工作区各有 12–13 个未提交文件，`git diff --name-only` **看得见它们**。所以不是恒为空。

临时仓库逐形态实测，`git diff --name-only` 只列「已追踪文件的未暂存改动」：

| 改动形态 | `git diff --name-only` | `git status --porcelain` |
|---|---|---|
| 改已追踪文件 | ✅ | ✅ |
| **新建文件** | **❌ 完全看不见** | ✅ |
| 已暂存 | ❌ | ✅ |

**真实缺陷**：新建文件对范围检查完全隐形。agent 新写一个范围外的 `src/secrets/leak.ts` 可以干净通过——而「不许在范围外新建文件」恰恰是这个检查最该拦的那种僭越。该文件原有的 4 个用例**全部改的是已追踪文件**，所以一个都没抓到。

**已修（`9c6a1d2`）**：改用 `git status --porcelain`（经 `getWorkingTreeStatus` 复用仓库唯一的 porcelain 解析），加 `-uall` 防止未追踪目录被折叠成一条匹配不上任何 glob 的条目，并用 `isShipArtifact` 排除 stagepass 自己的记账。另修一处 fail-open：仓库读不出时不再回落成空集——注意挂点不是 catch，`isGitRepo` / `hasCommits` 都吞异常返回 false，`getWorkingTreeStatus` 对坏仓库提前返回 `{clean:true}`，异常根本不抛。

> 这条同样是三级设计的前置条件：一级「绝对不能僭越写文件」的确定性执行，此前对新建文件是瞎的。

### 1.5 `build_run_records.run_id` 恒为 NULL — 成功的 run 被恢复路径判为失败

- 写：`build-run-record-service.ts:134` 硬编码 `runId: null`
- 读：`recovery-business-evidence.ts:382` `eq(buildRunRecords.runId, run.id)`

**生产验证**：7/7 行 `run_id` 全 NULL（对照 `review_attempts` 5/5 全有值），这个 join **永远返回 null**。

**后果**：`build` 恒为 null → `:404/:418/:425` 三个检查全部触发 → `complete=false` → `recovery-executors.ts:814` 把决策改写成 `runStatus:"failed"`。**任何 implement / fix_findings 的 provider run 只要走进 stale recovery 就被无条件判失败。** CHG-001 正好有 1 个 implement + 6 个 fix_findings。

**保留哪套**：`build-N`（其余所有消费者都用 `record.buildRunId ?? record.id`）。改读取端，不要去填 `run_id`——一个 provider run 可产生多个 build run。

### 1.6 `spec-battle-service.ts:1089` — `downgraded` 但没有目标严重度时，什么都不更新

- 读法 A：`downgradedTo: null` 表示「这不是一次降级」（对 resolved / still_open 成立）。
- 读法 B：「这是一次降级，但目标严重度缺失」。

**后果**：两个分支都不命中 → `blue_gap_reviews` 行写入并记录 verdict=downgraded，但 `requirement_gaps` **一个字段都没动**：status 仍 open、specBlocking 仍 1。报告里 `formatReview` 打印 `[downgraded]`、`formatGap` 打印 `[P0/open/blocks-spec]`——**同一份文档自相矛盾**，无报错无事件。

**现状**：`spec-critique-line-protocol.ts:102-104` 明文写着这个后果，但那是**解析器层**的防御；`BlueGapReviewSchema` 没有 cross-field refinement，生产路径用的 `validateBlueCritiqueOutput` 照单全收。**防线只有一层，且不在写入处。**

---

## §2 二级：同一概念的多套定义

### 2.1 `sourceDbHash` — Spec 阶段有**三套**活跃定义（不是两套）

| # | 定义位置 | 行集 | 生产值（CHG-001） | 落库处 |
|---|---|---|---|---|
| 1 | `spec-battle-service.ts:336` `specSourceDbHash` | 7 行，含 **`war_reports.Spec`** | `81f6ff13…` | STG-GATE-062 + 4 个 mirror |
| 2 | `spec-battle-report-service.ts:187` `reportSourceDbHash` | 7 行，含 **`findings.Spec`** | `781b64d6…` | STG-GATE-061 + `spec_report` mirror |
| 3 | `spec-battle-service.ts:358` `readDbAuthoritySnapshot` | **10 行**，另加 PRD briefing/draft/deferred questions | `69691b90…` 等 | `battle_rounds.input_snapshot_json` |

**代码层面它们必然不等**：`computeSourceDbHash`（`stage-authority-service.ts:328`）把 `{table:"war_reports.Spec"}` 这个**标签字符串本身**也塞进哈希输入，所以无论数据如何，1 和 2 永远算不出同一个值。

**生产佐证**（用 `stage_runs.source_lineage_json` 区分写入方）：同一 change、同一 phase、相隔 14 毫秒，两个哈希不同；全部 5 组配对无一例外。

**影响面**：`provider-action-authority-service.ts` 的 `SNAPSHOT_SOURCE_RESOLVERS` 有 TechSpec/Plan/TestPlan/QA，**独缺 Spec**（注释自陈「until Spec gets a content resolver」）。Spec 因此掉进 legacy 兜底：按 `stage_runs.output_db_hash = gate.sourceDbHash` 找，必须恰好 1 条否则禁用动作。**当前恰好 1 条纯属运气——库里已有 6 个哈希值各对应 2 条 stage_run。**

**该保留哪套**：以 2 的行集为基础、去掉已死的 `findings.Spec`（生产 25 行 findings 的 `phase` 全是 NULL），即 6 张核心表。理由：把 `war_reports`（阶段的**产物**）放进**来源**哈希是自指的——生产库里 6 份战报被批量标 stale 后 40 秒，gate 就被重盖了一版；CHG-001 的 Spec gate 已滚到 **36 版**。

> **更正交接文档**：`docs/RUBRIC-DESIGN.md:298` 说 `STG-GATE-062` 存的是「前者算不出的值」，说反了。062（`81f6ff13`）恰恰**就是** `specSourceDbHash` 算得出的；存着 report 味哈希的是 **061**。核心论断（两套定义、生产已不一致）完全成立。

### 2.2 `stage_gates.status` — `pass` vs `passed`，生产零重叠

- `spec-battle-service.ts:512` 写 `"pass"`；`plan-snapshot-service.ts:441` 写 `"passed"`
- 生产：PRD/Spec 只写 `pass`（5 行），Plan/TechSpec/TestPlan/Build 只写 `passed`（7 行）
- `spec-battle-service.ts:525` 更在同一函数里用同一个布尔向相邻两张表写出两种拼法

**分歧场景**：判定「是否通过」的六处成员集不同——`merge-readiness-service.ts:83` 与 `action-contract-common-policy.ts:13-18` 认四个值，`gate-service.ts:167` 认三个，而 `graph-runner.ts:138` 与 `pipeline-qa-stage-service.ts:68` **只认 `passed`**。

**陷阱**：`recovery-business-evidence.ts:309` 读 Spec gate 只认 `["pass","blocked"]`——**把 Spec 写入端归一化成 `passed` 会静默改坏它**。根因是 `stage-authority-service.ts:84` 和 schema 两端都是 `status: string`，类型系统完全不设防。

**保留**：`"passed"`（唯一在 `StageRunStatus` 里声明过的值）。

### 2.3 `RUNNING_CHANGE_STATUSES` — 两份定义，成员不同，极性相反

- `state-machine/transitions.ts:21`（10 个，权威） vs `phase-artifact-service.ts:84`（12 个，多 `REFINING`、`INTAKE_PENDING`）

**分歧行**：`status="REFINING"` 的 change——权威集说「不在跑」，于是 `deleteChange` / `reworkChange` 放行**删除和返工**；影子集说「在跑」，于是只拦住了**改一个 markdown**。**破坏性操作信的是窄的那份。**

**保留**：`transitions.ts:21`。`change-rework-service.ts:214-218` 的注释记录了同款漂移的上一次事故，修法就是 import 权威集——`phase-artifact-service.ts:84` 是唯一漏网的手抄本。

### 2.4 `freshness_json` — 两套 key 词汇，73 行生产数据对通用读取者不可见

- 读取方按 `fresh`：`gate-service.ts:170`、`merge-readiness-service.ts:372`
- 写入方从不发 `fresh`：Spec 发 `reportFresh`/`staleReason`，PRD 发 `draftFresh`，Plan 发 `reportFresh`
- 生产：PRD(24) + Plan(2) + Spec(47) = **73 行无 `fresh` 键**

**最扎眼的一行**：30+ 个 `Spec|blocked` gate 带着 `{"reportFresh":false,"staleReason":"source_changed"}`，两个通用读取者一致判定为「新鲜」——**载荷把自己的陈旧写在了没人看的键里**。

### 2.5 其余（证据较薄，标注可信度）

- `artifact_mirrors.source_db_hash` 两套约定，在 `testplan-snapshot-service.ts:726/734` **相邻两行**同时出现：一个是复合门哈希、一个是快照内容哈希，两个 `mirror_status` 都是 `ok`
- `findingsDbHash` 两套定义（潜伏）：`review-report-service.ts:96` 是 13 字段 compact，`review-artifact-mirror-service.ts:301` 兜底是 23 字段 pretty，连 `waivable` 都是 `true` vs `1`
- `stableJson` 同名两种编码（上一条的根因）：compact 7 处、pretty 2 处
- 四套互不兼容的 `Phase` union，生产值三不沾：`"PRD"`（66+ 行）不在 zod `Phase` 里，`"Change"`（8 行）不在任何 union 里
- rubric 阻断项 ID 两套：其他阶段 `RUBRIC:<criterionKey>`，Spec 用 `GAP-<uuid>`，`isRubricBlockerId` 对后者返回 false（当前无调用者传 `"Spec"`，潜伏）

> **更正我自己的 brief**：我曾断言 `battle_rounds.phase` 大小写混用。hex 验证否定了这一点——只有 `Spec` 一种写法。那 4 处 `inArray(battleRounds.phase, ["Spec","spec"])` 防的是没有任何写入方会产生的值。混淆是真的（隔壁 `runs.phase` 确实小写），但真正出问题的是 §2.2 的 `stage_gates.status`。

---

## §3 三级：注释/文档与代码不符（会导致改错代码）

### 3.1 `rubric-gate-service.ts:189-191` — 错误注释压在「决定什么会阻断」的函数头上

原话：「…and **ANY `not_assessed` blocks whatever the flag says** (§4.3)」

实际（`rubric-assessment.ts:200-205`）：`not_assessed` 命中 advisory 时进 `advisoryCriterionIds`，**不进** `blockingCriterionIds`。非阻断 criterion 漏答什么都不拦。同一函数往下 25 行的 `:215-218` 自己又写了相反的话。

**后果**：有人排查「这条漏答了怎么没拦」，读头注释判定是 bug，把 `deriveRubricBlockers` 改成取并集——重新引入 `rubric-assessment.ts:162-177` 记录的两个**实测过**的回归，其中一个会在**已盖章的 gate** 上凭陈旧沉默开出 P0。**改动只有一行、看起来像修 bug、测试未必拦得住。**

### 3.2 `rubric-defaults.ts:68-70` 与 `:254` — 两处都保证「重排安全」，两处都是反话

原话：「a reordering cannot silently re-key a row」、「The tests pin the full key set for exactly this reason.」

实际：key 就是纯位置派生（`:262` `RBK-factory-${phase}-${role}-${index+1}`），中间插一行**必然**把后面每条重新编号；且全仓唯一相关测试 `rubric-rollout.test.ts:170-183` 只断言条数 5–12、key 不重复、形状正则——**没有任何一处把 key 和正文绑定**。中间插一行，测试全绿。

**后果**：`criterionKey` 是派生阻断项持久化的身份（`rubric-gate-service.ts:117` `RUBRIC:<criterionKey>`），也是 §4.3.1 出口挂靠的东西。**选定 C 方案（文件管文本）后，这个洞从「维护面风险」升级为「用户随手改一行就废掉已盖章的阻断项」。**

### 3.3 `ai-line-protocol.ts:24-27` — 新接阶段的入门指引会教出一个静默空转的阶段

原话：「keep the engine's `outputSchema` off the request **in every case**」，而讲 runDocumentStage 路径的第 1 条只说「set `lineProtocol`」，**只字未提 `outputSchema` 仍须设**。

实际：`pipeline-document-stage-runner-service.ts:509` 已自动把 schema 从引擎请求摘掉；`:537` 用 `if (config.outputSchema)` 把**整个解析/校验/raw-capture 块**关在门后。两个字段都是可选的，只设 `lineProtocol` **能通过类型检查**。

**后果**：照「读我」段接新阶段 → 省掉 `outputSchema` → 解析器一次都不跑，模型原始回复原封不动流下去，没有 raw capture，编译器不报错、无错误日志。`pipeline-design-stage-service.ts:417-421` 的注释记录了这已经真出过一次。

### 3.4 文档层

| 位置 | 问题 |
|---|---|
| `docs/RUBRIC-DESIGN.md:3-4` | 自称「设计已定，待实现」，实际全部已落地（0023/0024 迁移、九个 rubric 服务、UI 面板都在） |
| `docs/RUBRIC-DESIGN.md:94` vs `:102` | 相隔八行互相矛盾（§4.2 说「缺失即阻断」，§4.3 说「**标了阻断的**缺失才阻断」）。这是 3.1 的文档侧孪生 |
| `docs/RUBRIC-DESIGN.md:219` | 给的线格式 `RUBRIC <id> yes\|no <evidence>` 不是真格式，实际是竖线分隔的 3 字段 |
| `docs/RUBRIC-DESIGN.md:292-300` | §11 三条都已过期，其中第 3 条「两套哈希都要改」照做正是 §4.4 警告会让**每个已盖章 gate 失效**的动作 |
| `docs/ship/file-guide.md` | 六个不存在的导出（含本轮刚删的 `parseRedSpecOutput`）；`completeRedSpecRound` 签名已过时，照文档接新调用方会静默产出零 claim 的轮次 |
| `README.md:87` / `README.zh-CN.md:85` | 「你的主 checkout 全程不被触碰」是假的——收编会 `commitAll(project.repoPath)`、Fix 前会 `checkoutBranch` 切分支。读者据此把无关脏文件留在仓库里，会被 `git add -A` 扫进提交 |
| 两份 README | **整个 rubric 子系统零文档**，两个文件里 "rubric" 一词都不出现 |
| 14 处代码注释 | 引用一份从未存在过的 `docs/state-projection-audit-2026-07-14.md`（遍历全部 37 个 commit 的 tree 确认）。这些注释是若干防御性 guard 的唯一存在理由 |

---

## §4 四级：prompt 模板歧义

### 4.1 `prd-briefing-draft.md:38` — 「块外的文字会被忽略」把 RUBRIC 行推进块内

模板说「不要写前后缀说明」「块外的文字会被忽略」，而 rubric 段落（`rubric-prompt.ts:51`）要求「在你其余全部输出的最后面」写 RUBRIC 行，**没有一个字说「必须在块外」**。

**后果三重**：`scanProtocolLines` 排除块体 → ① 零条 judgment 但返回 `ok:true` → 全体记 `not_assessed`；② `stripRubricLines` 用同一个扫描，**摘不掉**，协议行原样写进 `prd-draft.md`；③ `prd-draft.md` 是 spec 阶段的可读上下文，下一阶段 agent 回声一个属于**别的 rubric** 的 criterion id → unknown id → **那份输出整份作废**。

**关键佐证**：`rubric-line-protocol.ts:194-197` 自己写着「**That is why the prompts place rubric lines outside every block and last**」——**这句话今天只对 `spec.md` 成立**，`prd-briefing-draft.md` 写的是反话。补一句话即可，且不被任何测试钉住。

### 4.2 出厂 rubric 用「红方/蓝方」指 AI，而三个 Spec 模板定义「红方 = 人类」

- `rubric-defaults.ts:104`（Spec critic）：「**红方**声称修复的每一个 gap，我都逐条复核过」
- `rubric-defaults.ts:113`（Spec verdict）：「**蓝方**提出的每一个 open gap，**红方**都有过回应」
- `rubric-defaults.ts:97`（Spec producer）：「上一轮**蓝方**提出的每一个 gap…」

而 `spec.md:4`、`spec-critic.md:4`、`spec-verdict.md:4` 三处一字不差：「红方只指人类用户本人」；`spec-critic.md:5` 再加「SPEC_WRITER…**不是红方本人**」。**「蓝方」在任何模板里都没有定义**——模板一律用「反方」。

**后果**：critic 遵守模板 → 红方=人类 → 人类不产出修复声明 → 这条标准描述的事没发生 → 按 rubric 自己的规则（`rubric-prompt.ts:60`「无法确定就是 `no`」）→ **对一条实际做到了的标准答 `no`**。

**现状**：出厂全非阻断，所以今天只是记录。**用户在抽屉里勾一次 `blocking` 就变成假 P0**——而勾选正是设计中的正常工作流。三级设计把它升为一级（无出口）则是永久死锁。

### 4.3 `spec.md:66` 与 `:71` 都要求「放在最后」

`:66` 要求 `SPEC_DONE: true` 放最后；`:71` 要求 RUBRIC 行「放在全部输出的最后」。模型无法同时满足。

**后果**：两种都不会被驳回（解析器不查顺序），但「RUBRIC 在最后」这一支**废掉了一个明写的设计意图**——`spec-red-line-protocol.ts:143-148` 说 SPEC_DONE 写在最后正是为了「截断会连它一起吃掉」。若 RUBRIC 在其后，只截断到 RUBRIC 的回复仍带完整 SPEC_DONE 通过，失败原因被误报成「模型拒答 rubric」。

**修法**：`:71` 改成「放在 SPEC_DONE 之前」。（`spec-battle-prompt.test.ts:62-65` 只钉了「块外」这一半，改顺序措辞不破测试。）

### 4.4 其余模板条目

| 位置 | 问题 | 被测试钉住？ |
|---|---|---|
| `review.md:60-68` | 是 Build critic rubric 的宿主、有 SUMMARY 块，但 Hard rules 通篇不提 RUBRIC 行位置 | 否 |
| `api-spec.md:23` | 示例里的 `{changeId}` 会被 `:388` 无条件替换，模型看到的是 `POST /api/changes/CHG-001/actions`——从「路由模板」变成「写死的 id」，parser 全放行，落进 `api_snapshots` 再喂给 Build 与 Review | 否 |
| `spec-critic.md:65` | 示例自己用错了它上面刚消歧过的「红方」 | 否 |
| `spec-verdict.md:11` | 「红蓝双方都已产出完毕」与同文件 `:4` 冲突；这份模板唯一的工作就是归属判定（`:24`「正方的自证不等于事实」），混淆红方与人类会当场废掉它 | 否 |
| `plan.md:56-57` | 把一条 parser 根本不执行的规则（「非 trivial 至少 5 个 STEP」）写在「违反会被系统整体驳回」标题下，且触发条件「非 trivial」模型无从判定 | **是**（`prompt-templates.test.ts:23-25`，改措辞会连带改测试） |
| `refine.md:52` | 在以 `\|` 分隔的协议里用 ` \| ` 写枚举的「或」，同文件 `:20` 用的是斜杠 | 否 |

---

## §5 五级：潜伏但锋利（有具体后果，尚未触发）

- `stage-guard-service.ts:393-395` — 同一个 `[]` 在两个消费者里极性相反：空 `expectedFiles` 在 `validateImplementScope:498` 是 fail-closed，空 `forbiddenFiles` 在 `:490` 是 **fail-open**；而 `scope-check-service.ts:75` 与 `build-gate-service.ts:86` 对同一表达式又给出相反裁决
- `action-contract-merge-policy.ts:70-76` — 读不出 blocker 就允许合并；`readiness.status` 只被用来短路成 `[]`，**从来不用来阻断**
- `action-contract-merge-policy.ts:8-9` — 一个裸位置布尔 `requireApproval` 同时驱动三件不相干的事（是否算 blocker / 是否写库 / 是否自愈缺失 gate），导致同一屏上 approve_merge 显示「Build gate is missing」而 merge 显示 ready
- `merge-readiness-service.ts:571-575` — `computeMergeReadiness` 接受 `string | Options`，**字符串形态硬编码 `persist: true`**：最简单的写法是副作用最大的那种。`assertCanMerge:759` 用的正是字符串形态
- `review_attempts` 有两个 status 列且都能取 `"running"`（`schema.ts:268/270`）；写成 `attempt.status === "completed"`——最自然的拼法——会把带 P0 的 change 放进 QA
- `verdict` 在三张表里是三套不相交词汇：表示「已满足」的分别是 `fixed` / `resolved` / `yes`。另外 `review-run-service.ts:542` 往该表写 `"pending"`，**一个不在联合里的值**
- `prd-document-service.ts:31-40` — 「没有结构化 PRD」与「有但读不出」都返回 `null`，后者**完全跳过 `validatePrd`** 直落 `ready`。`server/types/prd.ts:74` 钉死 `version: z.literal(1)`——版本升到 2 时**所有**存量 PRD 立刻返回 null 并被静默盖上 ready
- `gate-service.ts:334-341` — 参数读不出就退回宽松默认（`allowP1Waiver: true`），于是配置了 `false` 的轮次会把「豁免 P1」通告为可用
- `spec-battle-report-service.ts:271` — `severity` 列不是真严重度（降级只写 `downgradedTo` 不改 `severity`），同一份 War Report 里同时出现「P0」和「可批准」。已有两次事故和配套回归测试；`effectiveSeverity` 目前在四处各有一份拷贝

---

## §6 未覆盖 / 已知盲区

- **第五路「名字在说谎」未交付**。已知种子样本两条待核实：`computeMergeReadiness` 是读路径但会写库（§5 已独立证实）、`resyncSpecStageAfterGapChange` 每次调用追加一行 Spec gate。这一路的完整结果需要补跑。
- `rubric-service.ts` 含两个字面 NUL 字节（第 363 行第 62 列、第 685 行第 69 列，本该写 `\0` 转义）。**这让 `file(1)` 判其为二进制、`grep` 静默跳过整个文件**——任何基于 grep 的全仓审计都会漏掉它。本次五路均已用 `grep -a` 处理。分隔符选 NUL 本身是正确的反歧义设计，只是写法让工具链失明。
- 明确查过且干净的部分：README 的命令/环境变量/路径/阶段清单全部核对无误；`ALLOWED_TRANSITIONS` 确实单一来源；每个 prompt 模板的示例都人工喂过对应 parser，全部能过；枚举拼写与 parser 的 Set 逐字一致；占位符无孤儿。

---

## 附：与三级 rubric 设计的关系

选定 C 方案（文件管文本、DB 管状态）后，下列条目从「待办」升级为「前置条件」：

| 条目 | 为什么是前置 |
|---|---|
| §1.1 `rubric-gate-service.ts:197` | 空回复能让阶段零条判定地通过。不修，一级标准写多硬都是纸的 |
| §1.4 `scope-check-service.ts:42` | 一级「绝对不能僭越写文件」的确定性执行在 QA 路径上现在是死的 |
| §3.2 `criterionKey` 位置派生 | key 进了用户可编辑文件后，改一行会废掉已盖章的阻断项 |
| §4.2 出厂 rubric 的「红方」 | 一级无出口，一次误判即永久死锁；这条现在就会产生误判。**已修 `8d59eb8`**，但存量项目库里仍是旧措辞 |
| §3.1 / §3.4 rubric 文档矛盾 | 三级语义要写进文档，而现有文档自相矛盾且自称未实现 |
