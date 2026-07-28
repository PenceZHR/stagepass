# 交接：把「裁决者 + 红蓝子 Agent」形态从 Spec 推广到 TechSpec / Plan / TestPlan（2026-07-27）

> 分支：`codex/abstract-cloud-sea-ui`
>
> 前序交接：`docs/HANDOFF-judge-subagent-spec-battle-2026-07-27.md`
> 运行时证据：`docs/CODEX-SUBAGENT-RUNTIME-EVIDENCE-2026-07-27.md`
>
> **Spec 单轮已经真实跑通两次。** 通用层四个阶段都已就绪。
> **续轮（round 2 起）曾经被自己的守卫误杀，见下面「三之零」，已修，但还没有实测复验。**

---

## 一、现在是什么状态

### Spec：单轮已验证，续轮待复验

CHG-006 实测（不是测试夹具，是真实模型、真实 Codex App）：

```
round 1  superseded    结算 → 人工点「继续对抗」，理由「不够清晰」
round 2  superseded    结算 → 人工点「继续对抗」，理由「继续」
round 3  failed        红蓝都真的跑了、文件都按时写了，被归属守卫误杀
```

一轮结算时的落库：`requirement_gaps` / `red_fix_claims` / `blue_gap_reviews` /
`war_reports` / `rubric_assessments` 全部有行，run 是 `completed`，
change 到 `SPEC_READY`。

注意 round 1 → round 2 之间走的是 `retry_spec`（**换了新的裁决者 thread**），
所以它绕开了续轮的那个 bug。真正的续轮只有 round 3 跑过一次，而且被误杀了。
**「连续三轮跑通」这句话在第一版交接里写错了。**

产物长这样（在**目标仓库**里，不是 stagepass）：

```
.ship/changes/CHG-006/rounds/spec/
  roles/{judge,red,blue}.md          服务端写，模型只读
  round-01/{red,blue,verdict}.json   三方各写各的
  round-02/…
```

### TechSpec / Plan / TestPlan：通用层就绪，回合未接

三个阶段现在仍是**单 turn 的 `runDocumentStage`**，只有 producer rubric，
代码注释写得很直白：「the phase has no critic」。

---

## 二、通用层已经建好的东西（不要重造）

四个阶段共用，`SPEC_DELEGATED_ROUND` 只是其中一个条目。

| 文件 | 作用 |
|---|---|
| `delegated-round-phases.ts` | 四个阶段的描述符：rubric phase、红方 schema、任务书模板、红蓝代号、裁决清单 |
| `delegated-round-workspace.ts` | 路径布局、任务书物化、产出文件读取（带写入时间）、可写 glob |
| `delegated-round-briefs.ts` | 组装三份任务书（Schema 注入）+ 短调度提示词 |
| `delegated-round-attribution.ts` | 按证据认领角色、串行校验 |
| `delegated-round-ingestion.ts` | 三方合成一轮，**全部通过才算一轮** |
| `delegated-round-side-history.ts` | 记录每轮用掉的子 Agent 线程，防止下一轮复用 |
| `pipeline-delegated-round.ts` | 跑一轮：物化任务书 → 发调度 turn → 读取校验 |
| `server-owned-json-output.ts` | 严格读取「服务端定 Schema、模型只填」的 JSON |
| `spec-judge-output-schema.ts` | 裁决者 Schema（四阶段共用） |

模板：`delegated-round-judge.md`（**四阶段共用一份**）+ 8 份红蓝任务书
（`{spec,tech-spec,plan,test-plan}-{red,blue}-subagent.md`）。

裁决者模板只有一份是刻意的：反造假纪律（串行、不许代答、不许报计数）
只应该存在一处，复制四遍等于给它四个地方各自漂移一次的机会。

开关：`STAGEPASS_SPEC_JUDGE_SUBAGENTS=on`（名字里的 spec 是历史遗留，
它控制的是整个 delegated 形态；接三个阶段时可以考虑改名）。

---

## 三、必须知道的运行时事实（都是踩出来的）

### 0. 裁决者是连续的，所以它的子 Agent 列表只会变长

这条是**「连续裁决者」这个需求本身带出来的**，而且四个阶段会一起中招，所以放最前面。

`thread/list` 按 `parent_thread_id` 拿子 Agent，拿到的是这个裁决者**有史以来**
spawn 过的全部子 Agent。裁决者跨轮不换 thread，于是 round 3 去数子 Agent 的时候，
round 2 的红蓝还在名单里。

第一版归属把这个当成了违规：

- `usedAgentThreadIds` 里的 thread 一旦出现在候选里，就报
  `sub_agent_reused_from_earlier_round`，整轮作废；
- 还没记录 used 的时候，它们就直接把数量顶上去，报
  `sub_agent_count_unexpected`（需要 2 个，实际 4 个）。

**结果是每一个续轮都必然被拒**。CHG-006 round 3 就是这么死的：红蓝两个**新**子 Agent
（`019fa4e3…` 14:43 起、`019fa4e6…` 14:46 起）真的跑了，红蓝的 json 也按时写了，
refuse 的理由却点名 round 2 的两个 thread。

修法（`delegated-round-attribution.ts`）：**上一轮用过的 thread 从候选池里剔除，
而不是当违规**。牙齿一颗没少——被剔除的 thread 不在池子里，就没有任何窗口能罩住本轮
的文件写入时间，于是照样报 `side_output_foreign`；一个新的都没 spawn 就报
`no_sub_agents`。这两个描述都比「reused」更准。

判断这条有没有被改回去的最快办法：`retry_spec` 能过、点「继续对抗」必挂，就是它。

### 1. `subAgentActivity` 不进快照

`thread/read` 的 turn 快照里 **0 条** `subAgentActivity` / `collabAgentToolCall`，
它们只活在实时通知流里。而 StagePass 观察 turn 用的是快照。

第一版归属就栽在这里：一轮真实委派被判成「红蓝从未启动」。
**探针验的通道和产品用的通道不是一回事**，这是本次最贵的一课。

### 2. 角色标签不进持久记录

`thread/list` 拿到的子线程，`agent_path` 和 `agent_role` **都是 null**，
昵称是自动生成的（Linnaeus、Raman）。`task_name` 只在通知流里有。

所以角色**不能靠标签**认。现在的做法是按证据推导：
哪个产出文件写在哪个子线程的运行区间内，那个线程就是那一方。

### 3. 子 Agent 线程默认被过滤掉

`thread/list` 不带 `sourceKinds` 时只返回 interactive sources，
子 Agent 线程一条都不返回——看起来像「从没 spawn 过」。
必须带 `sourceKinds: ["subAgentThreadSpawn"]`，
再按 `source.subAgent.thread_spawn.parent_thread_id` 过滤
（**不是**行上那个平铺的 `parentThreadId`，实测它恒为 null）。

### 4. spawn 失败是静默的

主 Agent 会替子 Agent 编答案，turn 以**成功**终态结束。
所以「这一方跑过没有」永远不能取自裁决者的文字。

### 5. `outputSchema` 只能给根 turn

`spawn_agent` 没有这个参数。子 Agent 的 Schema 只能写进任务书 + 服务端严格校验。
改成三方都写文件之后，这个不对称消失了——现在三方走同一条校验路径。

---

## 四、三道判据，缺一不可

一轮能成立，要同时满足：

| 判据 | 证据来源 | 挡住什么 |
|---|---|---|
| 这一方存在 | `thread/list` 的 `parent_thread_id`，**减去上一轮用过的** | 裁决者代答两方 |
| 双方轮流发言 | 两个子线程各自的起止时间 | 并行对抗（蓝方评审不存在的草稿） |
| 文件是本人写的 | 文件 mtime × 该线程运行区间 | 裁决者替子 Agent 写文件 |

三样裁决者都控制不了。去掉任何一道，剩下两道都能放进一个从没发生过的回合。

两处容易把正常回合误杀的地方，都已经踩过了：

- **时间匹配要先精确、容差只做兜底**：10 秒的时钟容差在两个子 Agent 挨得近时
  会让窗口互相吞并，把正常回合误判成「同一个 Agent 写了两方」。
- **上一轮的子 Agent 是背景，不是证据**：剔出候选池，不要当违规。见三之零。

---

## 五、剩下要做的（按这个顺序，顺序有原因）

### 0. 不要改造 `spec-battle-service`

它有 **45 处写死 Spec**，散在 13 个导出函数里。Spec 那条路是唯一被真实验证过的，
把它拆成参数化服务等于拿它冒险。三个新阶段走**独立的通用回合账本**。

好消息是可复用的比例很高：

- 蓝方 gap 账本几乎是阶段无关的——`completeBlueCritique` 里只有一处
  `sourcePhase: "Spec"`，整套 canonicalGapId 去重 + 复核逻辑可以直接复用
- 红方结算也大体通用，Spec 专属的只有字段名（`prdDeltaMarkdown`）
  和产物路径（`spec-round-NN/red.md`）
- 三个阶段各自**已有 producer schema 和产物持久化器**
  （`persistTechSpecAndApiSnapshots` 等），红方直接接上

### 1. 通用回合账本

`open / settle / fail / pause / resume`，写 `battle_rounds`（`phase` 列本来就在，
现在只有 `Spec` 行）。复用蓝方 gap upsert（给它加 phase 参数，默认 `"Spec"`，
不动现有行为）。

### 2. 每阶段红方产物落库

接各自已有的持久化器。

### 3. rubric + `RUBRIC_ROLE_ANSWERED_BY`（**必须和 1–2 同批上**）

三个阶段现在只有 producer rubric。critic + verdict 我写过一版又撤回了，
因为 `rubric-rollout` 里这条守卫拦住了，而它是对的：

> ships criteria but nothing answers it — the drawer would hold a checklist
> that stays blank forever, and blank reads as 'no rubric', which reads as a pass

**没人回答的 rubric 比没有 rubric 更危险。** 所以 rubric 必须和回合接线同批落地。
每个 scope 还要 5–12 条（我那版 verdict 只写了 4 条，会被另一条守卫拦下）。

### 4. 门禁 / 动作契约按阶段回合感知

照 `specRunDecision` 的形状：`run_*` 在回合跑着/结算后关闭，
`retry_*` 只对 failed 开，`awaiting_clarification` 要有自己的分支
（否则会落到 `not_actionable` 把所有出口都关掉）。

### 5. UI

- `pipeline-ui-model.ts` 里各阶段的 `actionIds` / `startActionIds`
- 「继续对抗」入口：Spec 用的是 `request_spec_changes` → `/spec-battle/next-round`，
  三个阶段各需要对应动作和路由

**踩过的坑**：按钮标签原本写死「重新运行本阶段」，不管它实际会执行哪个动作。
回合结算后那个按钮已经绑到「另开一轮」，字却还是「重新运行」——
一个会作废回合、烧掉一整轮的按钮写着「重新运行」，比按钮缺失更糟。
现在按钮由契约的 `label` 命名，有测试钉着。

### 6. 领养 + `awaiting_clarification` 各阶段接线

`stage-result-adoption-service.ts` 现在只有 `prd` 和 `spec`。

---

## 六、验证方式

```bash
# 全量（基线：2896 跑 / 53 失败，失败集合固定）
pnpm test:all

# 单文件（不要裸跑 tsx --test，会写生产库）
pnpm exec tsx scripts/run-tests-isolated.ts <file>

# 子 Agent 运行时探针（真实模型，会花钱）
node scripts/probe-codex-subagent.mjs /tmp/probe /tmp/probe/out.jsonl
```

判断有没有回归，**不要看失败条数**，要 diff 失败集合：

```bash
comm -13 <基线失败清单> <本次失败清单>
```

`kill-provider` / `delete-logs` / `kill-worker` 那族验收用例对 CPU 敏感，
全量里偶发红，单独跑通过——先单独复跑再下结论。

### 启动命令（两个环境变量必需）

```bash
TERM=dumb CODEX_INTERNAL_ORIGINATOR_OVERRIDE='Codex Desktop' \
STAGEPASS_CODEX_DESKTOP_BRIDGE=on STAGEPASS_MCP_INTERACTIONS=on \
STAGEPASS_CODEX_DECISION_SURFACE=on STAGEPASS_SPEC_JUDGE_SUBAGENTS=on \
STAGEPASS_CODEX_DECISION_PHASES=PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge \
pnpm dev
```

**改完代码必须重启 worker**：`tsx` 不热重载它，而 `next dev` 会热重载路由——
这个组合会造成门禁认识新状态、worker 不认识的 split-brain，结果无法解读。

---

## 七、给接手人的提醒

1. **验通道，不要验「一个通道」。** 探针走通知流验通了子 Agent，产品走快照，
   两者对 `subAgentActivity` 的可见性完全相反。验证时要走产品实际用的那条路。
2. **模型没有的东西不要问它。** 裁决者曾用 criterion 的语义名当 id 填，
   因为任务书里根本没给它 id 清单。它的行为是合理的，缺的是输入。
3. **落库前把所有判据做完。** 曾经 rubric 的 id 校验在 `recordRubricAssessments` 里，
   那时红方和蓝方已经提交——一轮失败却留下 2 条 gap，正是「半成品回合」。
4. **可写范围要窄。** turn 现在是 `workspace-write`，拦住设计阶段碰源码的是
   `validatePlannedChanges` + 一条只覆盖 `rounds/**/round-*/*.json` 的 glob。
   `roles/` 刻意在可写范围之外：能改自己任务书的回合就能改自己的 Schema。
