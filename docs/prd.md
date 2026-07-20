# PRD：stagepass 设计草案（v4.0）

> **⚠️ 这是一份设计草案，不是现状描述。**
>
> 本文是 2026-06-29 的 v4.0 扩展草案，价值在于记录**当初的设计意图与取舍过程**。文中保留了草案原貌，因此有些实现细节与最终落地的代码并不一致——**以代码为准**。两个已知的例子（刻意不改，以免把"当年的提议"伪装成"现在的事实"）：
>
> - 草案里的 Build 分支名 `cc-ai/change/<changeId>`，实际实现是 `stagepass/build/<changeId>/build-<n>`（见 `buildBranchName`）；
> - 草案里的施工区路径 `~/.cc-ai/workspaces/<projectId>/<changeId>`，实际实现是 `<仓库父目录>/.stagepass-workspaces/<仓库名>/<changeId>/build-<n>`（见 `workspacePathFor`）。
>
> **描述现状的权威 PRD 是 [`docs/ship/prd.md`](ship/prd.md)**（依据仓库当前状态生成）；产品说明见 [`README.md`](../README.md)。

| 项 | 值 |
|---|---|
| 文档状态 | v4.0 扩展草案（设计意图存档，实现细节可能已漂移） |
| 版本 | v4.0 |
| 创建日期 | 2026-06-25 |
| 最后更新 | 2026-06-29 |
| 最后校订 | 2026-07-16（产品更名 cc-ai → **stagepass**；定位对齐为「面向没受过工程训练的 vibe 编码者的 Stage-Gate 流水线控制台」。仅校订名称与定位，其余内容仍是 2026-06-29 的草案原貌） |
| 关联 | `docs/state-machine.md`、现有 pipeline / artifacts / findings / gate / `.ship` 基础 |
| MVP 范围 | PRD Briefing Room + Spec Battle + Requirement Gap + Gate + War Report |
| 待审批扩展 | Plan 作战沙盘 + Git Base Camp + Build 施工沙盘 + Review 战报中心 + Review 阶段数据库化 + 全后端数据库化 |
| 生成方式 | 我方 PRD Agent 起草，反方 Critic Agent 审查并给出 Reject，我方 PRD Agent 根据 P0/P1/P2 findings 修订；v3.2 根据用户批准收敛为 SLG 回合制 Spec Battle；v3.3 增加 Requirement Gap 逐项消账协议；v3.4 增加 PRD Briefing Room，明确 PRD 阶段由人类作为红方、AI 作为反方质询官；v3.5 增加待审批的 Plan 作战沙盘方案；v3.6 由我方 PRD Agent 起草 Build 施工沙盘，反方 Critic Agent 审查为 REVISE 后按 P0/P1 修订：Build 必须基于 Git Base Camp、隔离 worktree、确定性 Build Gate、反方 Audit 和人类审批收编；v3.7 由我方 Review PRD Agent 起草 Review 战报中心，反方 Review Critic Agent 审查为 REVISE 后按 P0/P1 修订：Review 必须拥有独立战报状态、freshness gate、P0/P1/P2 裁决规则和默认折叠日志的 UI；v3.8 由我方 Review DB PRD Agent 起草 Review 阶段数据库化，反方 Review DB Critic Agent 审查为 REVISE 后按 P0/P1 修订：Review 主状态、gate、findings、waiver、attempt、report 结算均以 DB 为权威，JSON / Markdown 只作为可重建审计镜像；v3.9 根据用户要求升级为全后端数据库化；v4.0 由蓝方 Pipeline DB PRD Agent 重新起草、红方 Critic Agent 审查为 REVISE 后按 P0/P1 修订：从 PRD 到 Merge 全部后端数据库化，JSON / Markdown / `.ship` 只用于 AI 上下文、人工阅读、审计和导出，不能作为后端流程权威 |

---

## 一、对抗生成记录

本 PRD 由两个实际子 agent 对抗生成：

| Agent | 阵营 | 输出 |
|---|---|---|
| 我方 PRD Agent | 我方代理 | 起草 v3.0 PRD，提出固定单位、有限模板、对抗、Requirement Gap 回流和战报裁决 |
| 反方 Critic Agent | 反方 | 审查我方草案，结论为 Reject，指出 MVP 过大、状态机不可实施、Requirement Gap 生命周期冲突等 P0/P1/P2 findings |
| 我方 PRD Agent | 我方代理修订 | 将 MVP 收缩为 Spec Battle 垂直闭环，并补充状态矩阵、数据模型、裁决矩阵和 Given/When/Then 验收标准 |
| 我方 Build PRD Agent | 我方代理 | 起草 v3.6 Build 施工沙盘：A+B 轻量 Build Runner + RTS 施工沙盘、Git Base Camp、worktree、反方 Audit、人类审批收编 |
| 反方 Build Critic Agent | 反方 | 审查 v3.6 Build 草案，结论为 REVISE，指出 `allowedFiles` 迁移、worktree 安全契约、Build/Implement 状态边界等 P0/P1 问题 |
| 我方 Review PRD Agent | 我方代理 | 起草 v3.7 Review 战报中心：将现有 `runReview`、findings、review report、gate 包装成反方战报默认界面 |
| 反方 Review Critic Agent | 反方 | 审查 v3.7 Review 草案，结论为 REVISE，指出 Review 状态混用 QA、战报 freshness、P1 waiver 后旧报告、旧 finding 复核等 P0/P1 问题 |
| 我方 Review DB PRD Agent | 我方代理 | 起草 v3.8 Review 阶段数据库化：DB 当裁判，JSON / Markdown 只做审计镜像和 AI 上下文快照 |
| 反方 Review DB Critic Agent | 反方 | 审查 v3.8 草案，结论为 REVISE，指出 DB 表边界、latestAttempt/latestValidReview 持久化算法、镜像重建、QA 全入口 gate、Build freshness、迁移幂等等 P0/P1 问题 |
| 我方 Pipeline DB PRD Agent | 我方代理 | 起草 v3.9 全后端数据库化：PRD / Spec / Plan / TestPlan / Build / Review / QA / Merge 的主状态全部进入 DB |
| 反方 Pipeline DB Critic Agent | 反方 | 审查 v3.9 草案，结论为 REVISE，指出阶段迁移边界、旧 JSON 权威残留、UI action 与后端 preflight 不一致、AI 上下文镜像污染状态源等 P0/P1 问题 |

### 反方核心问题

| 严重度 | 问题 | 修订结果 |
|---|---|---|
| P0 | MVP 过大，不是最小可运行闭环 | MVP 收缩为 `Spec Battle + Requirement Gap + Gate + War Report` |
| P0 | 状态机不可实施 | 增加 Round / Gate 状态矩阵与非法转移规则 |
| P0 | Requirement Gap 生命周期冲突 | 明确 `open / resolved / waived / downgraded` 状态和阻断规则；`overridden` 仅作为未来扩展枚举保留，MVP 不产生、不依赖 |
| P1 | 现有模型映射不足 | 增加 DB、`.ship`、artifacts、events 的权威存储映射 |
| P1 | 人类裁决动作过多 | MVP 主界面仅保留“继续对抗一轮 / 刷新战报 / 接受风险并通过 / 终止 Battle” |
| P1 | P1 问题可能只增不减，我方代理没有被强制逐项修复 | 增加 Requirement Gap 消账协议：我方代理逐项认领修复，反方先复核旧 gap，再允许新增 gap |
| P1 | PRD 阶段不适合 AI 多方互搏 | 增加 PRD Briefing Room：人类是红方需求源头，AI 是反方质询官，用疑点卡清除需求迷雾 |
| P1 | Plan 阶段如果继续沿用普通 JSON 计划，会缺少产品上的趣味和执行前拦截 | 新增待审批的 Plan 作战沙盘：AI 参谋排兵布阵，反方做一次执行风险拦截，人类审批作战计划 |
| P0 | Build 如果直接在主仓库施工，会污染用户工作区，失败后难以回滚 | 新增 Git Base Camp 与 change 级 worktree；Build Runner 只能在隔离施工区执行，主仓只接收审批后的 patch |
| P0 | `allowedFiles` 不能只改口径，否则会破坏现有 Plan Gate / Implement scope guard 契约 | v3.6 明确迁移为 `expectedFiles`；旧 `allowedFiles` 仅作为 legacy alias；计划外 diff 进入 Build Audit，不自动失败 |
| P0 | Build/Implement 状态插入点不清会让 Review 绕过 Audit | v3.6 不默认新增顶层 pipeline phase；Build 是现有 Implement 阶段的产品层名称，但进入 Review 前必须满足 `BuildRun.status = adopted` |
| P1 | Build Audit 不能只依赖 AI 自然语言 | 增加 deterministic Build Gate：forbiddenFiles、policy、路径逃逸、report stale、base commit 漂移等由系统硬判定，AI 反方只做风险解释和分类 |
| P0 | Review 问题借用 QA 失败态，会让用户误以为是 QA failed | v3.7 明确 Review 产品状态必须独立派生：`not_started / running / failed / blocked_p0 / blocked_p1 / stale / passed`；即使底层暂时兼容旧状态，UI 不得显示为 QA 失败 |
| P0 | Review 战报没有权威聚合模型，UI 会拼凑 run、findings、report、summary | 新增 Review Center API / Review 战报中心聚合契约，由 deterministic service 计算 gate、counts、freshness 和按钮可用性 |
| P0 | P1 waiver 后继续沿用旧 `review-report.md` 会让旧战报被当成可放行依据 | 明确 P1 waiver 必须标记 Review 战报 stale，并重新结算或重新审查后才能进入 QA |
| P1 | 旧 P0/P1 finding 可能因新一轮反方漏报而被自动关闭 | Review 必须保留旧阻断项复核协议：未被明确复核的旧 P0/P1 不得自动关闭 |
| P1 | Review UI 仍可能暴露 run id、artifact 路径、events stream | 第一屏只展示关卡状态、反方战报和指挥按钮；原始记录默认折叠到高级详情 |
| P0 | Review 数据库化如果只有原则没有表边界，落地仍会拼 JSON / Markdown / run summary | v3.8 明确 `review_runs`、`review_reports`、DB findings、human decisions / waivers、artifacts 的权威边界 |
| P0 | latestAttempt / latestValidReview 没有确定算法，会导致失败尝试覆盖有效战报或旧战报继续放行 | v3.8 明确 latestAttempt 取最新 Review run，latestValidReview 只取满足 DB 完整性、freshness 和 report 结算条件的最新有效 report |
| P0 | `.ship` 镜像不一致时如果反向覆盖 DB，会破坏 gate 真相 | v3.8 明确镜像只能从 DB 重建，不得覆盖 DB；镜像异常只进入审计状态和高级详情 |
| P0 | QA 入口可能绕过 UI 直接调用旧 runCheck / continue | v3.8 要求所有进入 QA 的入口统一调用 Review QA Gate service |
| P1 | 历史 JSON-only Review 数据可能被误导入为有效战报 | v3.8 增加幂等迁移规则：不完整数据只显示为 `legacy_incomplete`，不得参与 latestValidReview / QA / Merge |
| P0 | 只有 Review 数据库化仍会在 Build、Plan、Spec 等阶段留下 JSON 权威残留 | v3.9 升级为全后端数据库化：所有阶段主状态、gate、action、审批、run、report、finding、artifact metadata 均以 DB 为权威 |
| P0 | UI 可能根据旧 `.ship` / JSON 显示可点击动作，但后端 preflight 只认 DB 而拒绝 | v3.9 要求所有 UI action contract 来自 DB-first gate service；如果后端会拒绝，UI 必须禁用并展示同源 reason |
| P1 | JSON / Markdown 同时给 AI 看又参与流程裁决，会让 AI 上下文污染状态机 | v3.9 明确 JSON / Markdown 只能作为 AI 上下文快照和人工战报，不得成为后端流程判断依据 |
| P1 | 验收标准不可执行 | 改为 Given/When/Then 场景 |
| P1 | 实施顺序偏 UI/编排优先 | 调整为 severity/findings schema、Requirement Gap/gate invariant、单阶段 battle 优先 |

反方最终可接受方向：固定单位、有限模板、P2 默认不阻断、单人 owner 裁决、复用现有 `.ship` / artifacts / findings / gate。第一版最重要的验证目标是：

> 一个 P0/P1 需求漏洞能被反方发现、阻断、回流 Spec、被人类裁决、修订后重新验证，并在 Merge 前被机器可靠检查。

---

## 二、背景

stagepass 当前是一个本地 Web 控制台，用于监督 AI 编码 agent 在用户项目中执行研发流水线。现有系统已经具备可复用基础：阶段状态机、pipeline service、artifacts、findings、gate、`.ship/changes/<id>/`、`.ship/baseline/`、Review / Check / Fix、Retro 回流等。

下一版产品愿景是将 stagepass 从“固定流水线执行器”升级为**用对抗机制把风险暴露给使用者的 Stage-Gate 控制台**：

- 用户像 RTS 一样选择固定单位和固定战术模板。
- AI 不是单路产出，而是通过对抗暴露风险。
- 人类不追日志，而是查看战报并做裁决。
- 需求漏洞 P0/P1 必须回流 Spec，不能在后续阶段被局部修补掩盖。

但第一版必须克制。MVP 不做全阶段对抗体系，只做最小垂直闭环：

> PRD Briefing Room → Spec Battle → Requirement Gap → Gate → War Report

## 三、产品定位

stagepass 是一个**固定单位、有限模板、可裁决的 Stage-Gate 研发流水线控制台**：它不替用户写代码，而是替用户把流程走对——面向没受过系统工程训练的 vibe 编码者，用对抗机制把风险主动摆到他们面前，让他们也能做出老手级的裁决。

它不是：

- 自由低代码平台。
- 任意 workflow builder。
- prompt marketplace。
- agent marketplace。
- 用户可编辑节点、边、阶段的编排器。

第一版中，用户只能：

- 输入作战意图。
- 处理 AI 反方疑点卡。
- 锁定 PRD 基线。
- 选择系统内置模板。
- 调整少量安全参数。
- 设置 Spec Battle 最大交手轮数。
- 查看每轮战报。
- 执行有限裁决动作。

用户不能：

- 编辑单位 prompt。
- 新增单位。
- 新增阶段。
- 修改状态机边。
- 自定义对抗回合流程。

## 四、目标

1. 在现有系统基础上实现 PRD Briefing Room 到 Spec Battle 的垂直闭环。
2. 让 PRD 阶段由人类作为红方需求源头，AI 作为反方质询官，先清除需求迷雾。
3. 生成可审查、可锁定、可进入 Spec Battle 的 PRD 基线。
4. 引入统一 P0/P1/P2 severity，并让 findings 与 Requirement Gap 使用一致语义。
5. 建立 Requirement Gap 的结构化模型与 gate invariant。
6. 将 Spec gate 从“审核单个 PRD artifact”升级为“审核 Spec 战报”。
7. 让 War Report 由 deterministic service 聚合生成，AI 只可做摘要润色。
8. 将 Spec 阶段主界面收敛为 SLG 回合战斗：战场 + 本轮战报。
9. 建立 Requirement Gap 逐项消账协议，防止反方无限新增问题而我方代理无法关闭旧问题。
10. 为后续 TechSpec / TestPlan / Review / QA 多阶段对抗保留模型扩展点，但不塞入 MVP。
11. 待审批扩展：将 Plan 阶段包装为作战沙盘，让实施计划从普通 JSON 变成可审查、可审批、可执行约束的任务地图。
12. 待审批扩展：建立 Git Base Camp，把 Git 初始化、有效 HEAD、baseline commit 和 worktree 能力作为正式 Build 前置条件。
13. 待审批扩展：将 Build 阶段包装为施工沙盘，Build Runner 在隔离 worktree 中自由施工，系统生成 diff / patch / 战报。
14. 待审批扩展：在 Build 阶段采用红蓝对抗审计：人类是红方指挥官，AI 反方审查施工结果，系统用确定性规则裁决硬边界。
15. 待审批扩展：将 Build 收编改为人工审批动作，未审批的 workspace diff 不得进入主仓。
16. 待审批扩展：将 Review 阶段包装为战报中心，让反方 Reviewer 的结构化结论成为默认界面。
17. 待审批扩展：Review 进入 QA 前必须拥有 fresh、绑定最新 Build run、无 open P0/P1 的有效战报。
18. 待审批扩展：Review UI 默认隐藏底层 run/history/artifacts/events，只让人类处理“修复、豁免、继续 QA、重试审查”四类裁决。
19. 待审批扩展：从 PRD 到 Merge 的后端流程全部数据库化，DB 是唯一流程权威；JSON / Markdown 只作为 AI 可读上下文和人工可读战报。
20. 待审批扩展：所有阶段按钮、gate、preflight、下一步动作统一由 DB-first action contract 派生，避免页面可点但后端不认。

## 五、非目标

- 不在 MVP 中实现全阶段对抗。
- 不在 PRD 阶段实现 AI 多方互搏。
- 不让 AI 替人类决定核心业务目标。
- 不在 MVP 中实现多模板自由组合。
- 不做用户自定义 prompt、单位、边、阶段。
- 不做多人审批流。
- 不替换现有 pipeline、artifacts、findings、gate、`.ship`。
- 不让关键门禁依赖自然语言总结。
- 不承诺 AI 自动合并或绕过人类 gate。
- 不在 Plan 阶段做 Spec Battle 那种多轮攻防，除非人类明确要求重排计划。
- 不让 Plan 阶段自动开始实现；Plan 只决定实施范围、步骤顺序、验证命令和风险拦截。
- 不支持无 Git 项目进入正式 Build / Review / Check / Fix；无 Git 只能做需求草稿、上下文整理和初始化引导。
- 不让 Build Runner 在主仓工作区直接施工。
- 不在 Build MVP 做无限回合对抗、拖拽编排、多施工队并发或用户自定义 Build 单位。
- 不让 AI 反方 Audit 替代确定性 Build Gate；自然语言审查只能解释风险，不能作为唯一放行依据。
- 不把 Review 做成 Spec Battle 那种多轮对抗；Review MVP 只做一次反方审查、一次 deterministic 战报结算和人类裁决。
- 不让 Review AI 修改源码；Review 只允许写 `.ship` 产物、review report 和 findings。
- 不让 Review 替代 QA；Review 决定是否值得进入 QA，QA 仍负责测试、类型检查和本地验证。
- 不允许 P0 waiver / override；P0 Review finding 必须修复或终止 change。
- 不允许 P1 waiver 后直接沿用旧 Review 战报进入 QA。
- 不在 Review 第一屏展示原始 JSON、run id、artifact 绝对路径或 events stream。
- 不允许任何新阶段继续产生 JSON-only 后端状态。
- 不允许 `.ship` JSON / Markdown 作为 PRD、Spec、Plan、TestPlan、Build、Review、QA、Merge 的流程权威。
- 不允许前端绕过 DB action contract 自行猜测按钮是否可点。

## 六、现有资产复用

| 资产 | MVP 复用方式 |
|---|---|
| `ChangeStatus` / `RunPhase` / 展示层状态映射 | 继续作为 change 主状态机 |
| `pipeline-service` | 增加 Spec Battle 执行入口，不重写 pipeline |
| `artifacts` | 索引 battle 产物和 report 文件 |
| `findings` | 扩展 severity 到 P0/P1/P2，统一状态语义 |
| `gate-service` | 增加 Spec Battle gate invariant |
| `.ship/changes/<id>/` | 保存 PRD briefing、round、gap、decision、report 的镜像文件；不作为流程权威 |
| `.ship/baseline/prd.md` | 作为人工阅读和 AI 上下文镜像；PRD Briefing / Spec Battle 的后端基线输入来自 DB |
| `phase-artifact-service` | 展示 Spec report 与相关产物 |
| `stage-guard` | 约束 Spec Battle 只写 `.ship/changes/<id>/` 下允许产物 |
| `generate_plan` / `plan.json` / `plan.md` | `generate_plan` 写 DB Plan snapshot；`plan.json` / `plan.md` 仅作为镜像产物，不推翻现有 Plan 体验 |
| `git-service` / 工作区状态能力 | 待扩展为 Git Base Camp、worktree 创建、diff / patch、base commit 校验和收编能力 |
| `validateImplementScope` / `validateFixScope` | v3.6 待迁移为 Build Gate / Fix Gate：`forbiddenFiles`、policy、路径逃逸继续硬阻断；`expectedFiles` 外 diff 进入 Audit 和人类审批 |

### 6.1 全后端数据库化契约（v4.0 待审批增量）

v4.0 将系统从“文件驱动 + 局部 DB 化”升级为“全后端 DB 权威”。从 PRD 到 Merge，任何后端状态推进、gate、preflight、action enablement、freshness、latest valid 选择、QA / Merge 准入，都只能读取 DB 权威表和当前仓库事实。

JSON / Markdown / `.ship` 文件只能作为 AI 上下文、人工阅读、导出、审计镜像或 legacy import 的只读输入；除显式 legacy import 外，不得反向写入 DB；legacy import 也不得直接产生 latest valid state 或可执行 action。

一句话原则：

```text
DB 当裁判。
JSON / Markdown / .ship 当战报镜像。
AI 可以读镜像，但 AI 输出必须重新校验后写 DB。
人类可以看镜像，但所有按钮和后端推进只认 DB。
```

#### 6.1.1 产品原则

1. DB 是系统裁判；`.ship`、JSON、Markdown 是战报镜像。
2. 新流程不得产生 JSON-only、Markdown-only、`.ship`-only 后端状态。
3. 所有阶段必须先写 DB transaction，再从 DB 生成镜像文件。
4. 所有 gate、preflight、下一步 action 必须由 DB-first service 计算。
5. AI 可以读取镜像作为上下文，但 AI 输出必须重新 parse、validate、normalize 后写入 DB。
6. 人类可以阅读镜像理解过程，但按钮是否可点必须只看 DB action contract。
7. 镜像缺失、损坏、过期时不得影响 DB 真相，只能产生 mirror warning。
8. DB 缺少权威记录时，系统必须阻断推进，而不是回退读取旧 JSON。

#### 6.1.2 权威边界

以下内容必须以 DB 为唯一权威：

| 类型 | DB 权威内容 |
|---|---|
| Change | 当前阶段、阶段状态、owner decision、latest valid phase result |
| Run / Attempt / Round | 每次阶段执行、输入 hash、输出 hash、状态、失败原因 |
| Gate | 阶段 gate 结论、阻断项、freshness、required next action |
| Action | UI 可执行动作、enabled、disabled reason、idempotency key、gate version |
| Approval | 人类批准、拒绝、豁免、终止、重跑、收编决策 |
| Finding | P0/P1/P2、状态、来源、复核记录、waiver |
| Report | report 结算结果、source run、source artifact hash、fresh/stale |
| Artifact | artifact type、path、hash、schema version、mirror status |

以下内容不得作为流程权威：

```text
.ship/changes/<id>/**/*.json
.ship/changes/<id>/**/*.md
.ship/baseline/**/*.md
AI raw output
人工战报 Markdown
导出的 JSON 快照
本地文件是否存在
前端根据文件内容自行推断的状态
```

#### 6.1.3 各阶段 DB 化要求

| 阶段 | 必须进入 DB 的权威数据 | 明确禁止 |
|---|---|---|
| PRD | 作战意图、疑点卡、用户回答、AI 假设、人类确认、deferred 问题、PRD draft version、PRD lock state、PRD gate | 不得把 `prd-draft.md`、`briefing-questions.json` 当作锁定依据 |
| Spec | battle round、我方修复声明、反方 gap review、Requirement Gap、gap status、Spec gate、human decision、spec report metadata | 不得把 round JSON、spec report Markdown 当作 gate |
| Plan | approved Plan snapshot、steps、expectedFiles、forbiddenFiles、validationCommands、Plan Risk、Plan approval、Plan gate、plan report metadata | 不得把 `plan.json` / `plan.md` 当作批准或 Build 输入依据 |
| TestPlan | test intent、coverage item、risk mapping、required commands、manual checks、approval state、TestPlan gate | 不得把 Markdown 测试计划当作 QA 准入依据 |
| Build | Git base commit、worktree metadata、Build run、diff metadata、changed files hash、BuildDeviation、validation result、Build Audit、adoption approval、adoptedHeadSha、Build gate | 不得把 patch 文件、build report、worktree 文件状态当作收编依据 |
| Review | Review attempt、Review finding、prior finding review、waiver、latestAttempt、latestValidReview、Review gate、QA gate | 不得把 `review-findings.json`、`review-report.md` 当作进入 QA 依据 |
| QA | QA run、命令结果、测试证据、失败项、重试记录、QA gate、修复要求 | 不得把测试日志 Markdown 当作 QA passed 依据 |
| Merge | merge readiness、blocking findings 汇总、HEAD freshness、required approvals、final gate、merge decision | 不得把 war report Markdown 或 `.ship` 文件存在当作 Merge passed 依据 |

每个阶段最少必须拥有以下 DB 边界：`stage_state`、`stage_runs/attempts`、`stage_gate`、`stage_actions`、`human_decisions`、`artifact_mirrors`、`freshness/source lineage`。阶段专用表可以命名为 PRD / Spec / Plan / TestPlan / Build / Review / QA / Merge 专属模型，但不得缺少这些职责。

#### 6.1.4 写入与读取顺序

所有阶段统一写入顺序：

```text
AI / deterministic output
  -> schema validation
  -> normalize
  -> DB transaction
  -> recompute gate
  -> recompute action contract
  -> render JSON / Markdown / .ship mirror from DB
  -> expose UI DTO from DB
```

所有阶段统一读取顺序：

```text
DB state
  -> deterministic gate service
  -> action contract
  -> UI DTO / API response
```

如果 DB 写入失败，本阶段不得通过。

如果镜像写入失败，DB 状态仍然有效，但 artifact mirror status 必须记录 warning，并提供“从 DB 重建镜像”动作。

禁止以下读取方式：

```text
.ship JSON -> gate
.ship Markdown -> gate
AI natural language summary -> gate
frontend local inference -> action enabled
artifact existence -> stage passed
plan.json -> Build scope authority
war-report.md -> Merge readiness
```

#### 6.1.5 AI 与人工可读 JSON 的定位

JSON / Markdown 的目标用户只有两类：

| 读者 | 用途 | 是否可裁决流程 |
|---|---|---|
| AI | 作为上下文快照，帮助下一阶段生成、审查、总结 | 否 |
| 人类 | 作为战报、审计、解释、导出材料 | 否 |

AI 可以读取 JSON / Markdown，但 AI 输出必须重新经过 schema validation 和 DB transaction，不能直接把旧 JSON 当作后端状态继续沿用。

人类可以阅读 JSON / Markdown，但页面按钮必须以 DB action contract 为准。即使 Markdown 写着“通过”，只要 DB gate 不是 passed，按钮也必须禁用。

#### 6.1.6 UI Action Contract

所有页面按钮必须来自同一个 DB-first `ActionContractService`。前端不得自行根据 `.ship`、JSON、Markdown、artifact 是否存在、阶段文案或本地推断决定业务按钮是否可点。

```ts
type PipelineAction = {
  actionId: string;
  phase:
    | "PRD"
    | "Spec"
    | "Plan"
    | "TestPlan"
    | "Build"
    | "Review"
    | "QA"
    | "Merge";
  label: string;
  enabled: boolean;
  reasonCode: string | null;
  reason: string | null;
  blockers: Array<{ id: string; severity: "P0" | "P1" | "P2"; title: string }>;
  gateVersion: string;
  sourceDbHash: string;
  requiresIdempotencyKey: boolean;
};
```

如果后端 preflight 会拒绝动作，UI 必须收到并展示同源 disabled reason：

```ts
{
  actionId: "enter_qa",
  phase: "Review",
  label: "进入 QA",
  enabled: false,
  reasonCode: "review_open_p0",
  reason: "Review gate 未通过：存在 open P0 finding",
  blockers: [{ id: "FND-1", severity: "P0", title: "数据迁移会丢失用户记录" }],
  gateVersion: "review-gate-v3",
  sourceDbHash: "sha256:...",
  requiresIdempotencyKey: true
}
```

执行 action 的 API 必须复用同一套 DB-first preflight / gate service。若 UI 获取 action contract 后 DB 状态发生变化，执行 API 必须返回 `409`，并返回新的 action contract。禁止出现“前端显示可点击，后端 preflight 才给出新理由拒绝”的长期不一致状态。

#### 6.1.7 Legacy JSON / Markdown / `.ship` 迁移策略

历史数据不得默认升级为有效流程状态。旧 `.ship`、JSON、Markdown 只能通过显式 legacy import 作为只读输入进入 DB。

legacy import 必须满足：

1. 幂等，可重复执行。
2. 记录 `sourceArtifactHash`、`schemaVersion`、`importedAt`、`importResult`。
3. 默认只能创建 `legacy_imported_readonly` 或 `legacy_candidate` 记录。
4. 字段缺失、schema 不明、无法证明 freshness 的数据，只能标记为 `legacy_incomplete`。
5. `legacy_imported_readonly`、`legacy_candidate`、`legacy_incomplete` 均不得直接参与 latest valid state、QA gate、Merge gate 或 action enablement。
6. import 不得绕过当前 HEAD freshness、Build adopted record、人类审批和 P0/P1 阻断规则。
7. 若人类要求把 legacy candidate 恢复为权威，必须通过当前版本 DB preflight、当前 HEAD / source lineage / freshness 校验，并记录显式迁移确认；默认推荐从最近可信 DB 阶段重新执行。

对于旧 JSON-only change，系统必须提供三种明确路径：

| 路径 | 使用条件 | 结果 |
|---|---|---|
| 只读导入 | 数据不完整或 freshness 不可信 | 展示历史战报，不允许推进 |
| 候选迁移 | 字段完整、hash 可验证、状态闭环 | 写入 legacy candidate，等待当前版本 preflight 和人类迁移确认 |
| 重新执行 | HEAD 漂移、Build / Review / QA 缺少权威记录 | 从最近可信 DB 阶段重新运行后续阶段 |

不得用旧 JSON 或 Markdown 直接恢复为 passed gate。

#### 6.1.8 镜像产物命名规则

PRD、Spec、Plan、TestPlan、Build、Review、QA、Merge 各章节中列出的 `.ship` 路径统一视为“镜像产物”。它们不得作为状态、gate、action、preflight、freshness 的读取源；后端只保存 artifact metadata、content hash、schema version、mirror status 和可重建来源。

如果局部章节出现“读取 `*.json` / `*.md`”“`*.json` 是权威输入”“检查最新 `*.md` 才能通过”等表述，应按本节解释为：读取 DB 中对应快照；文件仅作为由 DB 渲染出的 AI / 人类可读镜像。

#### 6.1.9 验收标准

1. Given 一个全新 change，When 从 PRD 推进到 Merge，Then 每个阶段都能在 DB 找到权威状态、gate、action、run/report metadata。
2. Given 删除 `.ship` 下所有阶段 JSON / Markdown，When 打开页面，Then UI 仍按 DB 展示真实状态，并只显示 mirror warning。
3. Given 篡改 `.ship` JSON 写成 passed，When 后端计算 gate，Then 系统不得读取该 passed 作为放行依据。
4. Given DB gate blocked，When Markdown 战报写着“通过”，Then UI action 仍必须 disabled，并展示 DB 阻断原因。
5. Given 后端 preflight 会拒绝某动作，When 前端获取 action contract，Then 该 action 必须 disabled，且 reason 与 preflight 同源。
6. Given AI 读取了旧 JSON 作为上下文，When AI 输出下一阶段结果，Then 结果必须重新 validate 并写 DB，不得沿用旧 JSON 状态。
7. Given 历史 JSON-only 数据，When 用户尝试进入 QA 或 Merge，Then 系统必须阻断，并要求迁移或重新执行。
8. Given 镜像文件缺失但 DB 完整，When 用户点击“重建镜像”，Then 系统从 DB 重新生成 JSON / Markdown，而不是反向补写 DB。
9. Given Merge gate 执行，When 任一阶段存在 open P0/P1 blocking finding 或 stale gate，Then Merge 不可通过，即使 war report Markdown 显示可合并。
10. Given DB 缺少 QA result 或 merge readiness，When `.ship` 中 QA / Merge 战报显示 passed，Then QA / Merge action 必须 disabled，执行 API 必须返回 DB gate 的阻断原因。

## 七、MVP 范围

### 7.1 MVP 闭环

```
Intake / existing change input
  -> PRD Briefing Room
      -> 用户输入作战意图
      -> AI 反方生成疑点卡
      -> 用户回答、采用 AI 假设或暂缓疑点
      -> 系统生成 PRD 草案
      -> AI 反方最终质询一次
      -> 人类锁定 PRD 基线
  -> Spec Battle
      -> Round N
          -> 我方代理出招：生成或修订 prd-delta.md，并逐项认领 open P0/P1 gap
          -> 反方反击：先复核旧 gap，再识别新增 requirement gaps / findings
          -> 战报官结算：生成本轮 report
          -> 人类裁决：继续一轮 / 接受风险通过 / 终止
  -> Spec Gate
      -> 人类通过后进入后续 pipeline
  -> 通过后回到现有后续 pipeline
```

### 7.2 MVP 包含

1. PRD Briefing Room：作战意图、反方疑点卡、PRD 草案、PRD Gate。
2. 系统内置单位 enum。
3. 系统内置模板 enum。
4. 单阶段 Spec Battle round。
5. Requirement Gap schema、状态、关闭规则。
6. Requirement Gap 逐项消账协议：我方代理认领、反方复核、系统关闭或保留。
7. P0/P1/P2 severity schema。
8. Spec Gate invariant。
9. 人类裁决动作矩阵。
10. 阶段级 report：`reports/spec-report.md`。
11. change 总战报聚合：`reports/war-report.md`。
12. Given/When/Then 验收场景。
13. SLG 回合战斗主界面。
14. 用户可配置最大交手轮数。

### 7.3 MVP 不包含

- PRD 阶段 AI 多方互搏。
- TechSpec Battle。
- TestPlan Battle。
- Review Battle。
- QA/Fix Battle 的新对抗模型。
- 多阶段模板编排。
- 用户编辑单位 prompt。
- 用户编辑流程边。
- 用户自定义阶段。
- P0 override UI。

### 7.4 PRD Briefing Room

PRD 阶段不做 AI 多方互搏。PRD 阶段的需求源头在人类手里，AI 的价值是追问、拆风险、暴露假设，而不是替用户决定产品目标。

PRD Briefing Room 的角色模型：

```text
人类 = 红方 / 需求源头 / 作战指挥官
AI = 反方 / 需求质询官 / 情报侦察员
系统 = 记录员 / 清晰度结算器 / Gate 裁判
```

PRD 阶段主界面应像战前会议室，而不是长表单。第一屏只保留：

```text
左侧：作战意图
中间：反方疑点卡
右侧：PRD 草案
底部：清晰度 / 风险 / 未决问题
```

用户先输入自然语言作战意图：

```text
我想做一个【功能或工具】，因为【目标用户】现在遇到【具体问题】。
我希望它能【达成的结果】，不希望它变成【明确非目标】。
```

AI 反方读取作战意图后，生成一组疑点卡。每张疑点卡必须是一个可以被用户处理的具体问题，而不是泛泛而谈的建议。

疑点卡类型：

| 类型 | 说明 |
|---|---|
| 目标不清 | 需求想解决的问题不够明确 |
| 用户不清 | 谁使用、谁审批、谁受影响不明确 |
| 范围不清 | 做什么和不做什么边界不明确 |
| 成功标准不清 | 何时算成功不可验证 |
| 反例缺失 | 没定义什么情况下不应该做 |
| 风险缺失 | 数据、安全、权限、成本、误用风险不清 |
| 约束缺失 | 技术、时间、资源、兼容约束不清 |
| 后续阻断 | 如果不回答，会在 Spec Battle 变成 P0/P1 gap |

疑点卡严重度：

```ts
type BriefingQuestionSeverity = "critical" | "important" | "optional";
```

| 严重度 | 含义 | 是否阻断锁定 PRD |
|---|---|---|
| `critical` | 不回答会导致方向错误或核心验收无法判断 | 阻断 |
| `important` | 不回答会导致 Spec 阶段高概率返工 | 可人工暂缓 |
| `optional` | 对体验或细节有帮助，但不影响进入 Spec | 不阻断 |

每张疑点卡只允许三个主动作：

| 动作 | 含义 |
|---|---|
| 回答 | 用户亲自补充事实或决策 |
| 用 AI 假设 | AI 给出明确默认假设，用户确认采用 |
| 暂缓 | 记录为未决问题，进入后续 Spec Battle 上下文 |

PRD 草案由系统根据以下输入生成：

- 用户作战意图。
- 用户对疑点卡的回答。
- 用户接受的 AI 假设。
- 被暂缓的未决问题。

PRD 草案必须包含：

1. 背景。
2. 目标。
3. 用户与场景。
4. 范围。
5. 非目标。
6. 核心流程。
7. 成功标准。
8. 风险与约束。
9. 未决问题。
10. 进入 Spec Battle 的建议。

AI 反方最终质询只执行一次。它可以检查 critical 疑点是否仍未处理、标记 important 暂缓风险、给出进入 Spec Battle 的风险提示，但不得直接修改 PRD，也不得锁定 PRD。锁定动作必须由人类执行。

PRD Gate 必须由确定性规则计算。允许锁定 PRD 的条件：

1. 已存在 PRD 草案。
2. 不存在 `open` 状态的 critical 疑点卡。
3. 每个 accepted AI assumption 都有用户确认记录。
4. 所有 deferred important 疑点被写入 PRD 的“未决问题”章节。
5. PRD 草案版本与最新疑点卡处理状态一致。

不得锁定 PRD 的情况：

- 仍有 critical 疑点未回答。
- PRD 草案生成后，用户又修改了作战意图但未重新生成草案。
- AI 假设未被用户确认。
- PRD 草案缺少目标、范围、成功标准任一核心章节。

锁定动作的产品语义是：

```text
锁定作战目标，进入 Spec Battle
```

后台语义是：

```text
confirm PRD baseline -> start / enable Spec Battle
```

前端主按钮不得写成 `confirm`、`approve gate`、`run spec` 这类后台词。

PRD Briefing Room 镜像产物：

```text
.ship/changes/<changeId>/prd-intent.md
.ship/changes/<changeId>/briefing-questions.json
.ship/changes/<changeId>/prd-draft.md
.ship/changes/<changeId>/prd-gate.json
```

Spec Battle 后端读取 DB 中的 locked PRD baseline、briefing questions、deferred questions、PRD gate 和 source hash。以下文件只作为 AI 上下文镜像和人工阅读战报，不得作为 Spec gate 或 Battle Reporter 的后端读取源：

- `prd-draft.md` 镜像 locked PRD baseline。
- `briefing-questions.json` 镜像 deferred important 疑点。
- `prd-gate.json` 镜像 clarity / risk 摘要。

如果 PRD 阶段存在 deferred important 疑点，Spec Battle 反方可以将其升级为 Requirement Gap，但必须引用来源，不能当成无来源的新问题。

### 7.5 Plan 作战沙盘（v3.5 待审批扩展）

Plan 阶段不再只是后台渲染 `plan.json` 和 `plan.md` 镜像，而是变成一张执行前的作战沙盘。它的目标不是继续拉长对抗，而是把已经通过 Spec Gate 的方案拆成 DB Plan snapshot，让人类在实现开始前看懂：

- 要改哪些文件。
- 每一步谁先谁后。
- 哪些文件绝对不能碰。
- 哪些验证命令必须跑。
- 反方认为这个计划哪里会翻车。

Plan 阶段的角色模型：

```text
人类 = 红方 / 作战指挥官 / 最终审批者
AI = 我方计划参谋 / 排兵布阵者
反方 = 执行风险审查官 / 拦截隐藏风险
系统 = 沙盘裁判 / scope guard / gate keeper
```

Plan 阶段只做一次标准拦截，不做无限回合战斗。推荐流程：

```text
Spec Gate approved
  -> Plan 作战沙盘
      -> 我方计划参谋生成任务地图
      -> 反方执行风险审查一次
      -> 系统结算 Plan Gate
      -> 人类裁决：批准作战计划 / 要求重排 / 拆小任务 / 终止
  -> Plan approved
  -> Build 施工沙盘
```

为什么不做多轮 Plan Battle：

| 方案 | 优点 | 问题 | 结论 |
|---|---|---|---|
| 沿用现有普通 Plan | 实现成本最低 | 没有游戏感，用户难以看懂执行风险 | 不推荐作为最终体验 |
| Plan 也做完整多轮对抗 | 和 Spec Battle 形式统一 | token 消耗大，状态复杂，容易拖慢进入 Build | 暂不做 |
| Plan 作战沙盘 | 有 SLG 的排兵布阵感，且实现可控 | 需要新增一次反方审查和 UI 包装 | 推荐方案 |

Plan 作战沙盘的主界面只保留三块：

```text
左侧：任务地图
中间：反方拦截
右侧：执行许可
```

任务地图不是自由拖拽 workflow builder。MVP 只允许系统根据计划自动分组，把任务棋子放到固定泳道：

| 泳道 | 含义 |
|---|---|
| 数据 / Schema | 数据库、迁移、模型、存储 |
| 服务 / API | server service、route、接口契约 |
| 前端 / UI | 页面、组件、交互状态 |
| 测试 / 验证 | 单测、集成测试、Playwright、lint/build |
| 文档 / 迁移 | PRD、spec、迁移说明、兼容说明 |

用户可以做的事：

- 查看任务地图。
- 调整优先级或要求 AI 重排。
- 要求拆小某个过大的任务。
- 审批 expectedFiles / forbiddenFiles。
- 审批 validationCommands。
- 对 P1 执行风险填写接受理由。
- 批准作战计划，进入 Build。

用户不能做的事：

- 自由新增流程节点或边。
- 编辑底层 agent prompt。
- 绕过 forbiddenFiles。
- 在存在 open P0 Plan Risk 时批准计划。
- 绕过 Build Audit 和人类审批，直接把施工结果收编进主仓。

Plan 作战沙盘的趣味点不来自“多几个按钮”，而来自明确的战术语义：

| 产品文案 | 后台含义 |
|---|---|
| 排兵布阵 | 生成 `implementationSteps` |
| 火力覆盖 | `expectedFiles` / legacy `allowedFiles` 描述预计施工范围 |
| 禁区 | `forbiddenFiles` 和 policy blocked globs |
| 补给线 | `validationCommands` 与测试计划 |
| 反方拦截 | Plan Risk 审查 |
| 批准作战计划 | `PLAN_APPROVED` |
| 要求重排 | regenerate / revise plan |
| 拆小任务 | 让计划参谋重写过粗 step |

### 7.6 Git Base Camp 与 Build 施工沙盘（v3.6 待审批扩展）

Build 阶段采用 A+B：

- A：轻量 Build Runner，在隔离 workspace 中执行一次实现、验证、产出 diff / patch / 战报。
- B：RTS 施工沙盘，让人类看到施工区、变更范围、验证结果、反方审计和收编许可。

Build 不是让 AI 直接在主仓库改代码。正式 Build 必须先通过 Git Base Camp：项目必须是 Git 仓库，必须存在有效 `HEAD`，并且系统能记录 `baseCommit`。没有 Git 时，系统只能进入初始化引导，不能进入正式 Build。

Build 阶段的红蓝对抗语义固定为：

```text
红方 = 人类用户 / 作战指挥官 / 收编审批者
我方施工代理 = Build Runner / 施工队
反方 = Build Auditor / 审查官
系统 = Git Base Camp / worktree 裁判 / deterministic Build Gate
```

中文产品界面统一使用“反方”，不再使用“蓝方”作为用户可见文案。Build Runner 不是红方；红方只有人类。

推荐流程：

```text
PLAN_APPROVED
  -> Git Base Camp 检查
  -> 创建隔离 Build workspace，默认使用 git worktree
  -> Build Runner 在施工区实现一次
  -> 系统收集 git diff / patch / validation result / build-report
  -> deterministic Build Gate 判定硬边界
  -> 反方执行一次 Build Audit
  -> 人类裁决：批准收编 / 要求返工 / 回到 Plan / 放弃 Build
  -> 人类批准后，系统才允许将 patch 收编回主仓
  -> 进入 Review / Check
```

Build 阶段不做无限多轮对抗。MVP 只做“一次施工 + 一次 deterministic gate + 一次反方审计 + 一次人类审批”。如果用户要求返工，系统创建新的 Build run，而不是在同一 run 中无限循环。

#### Git Base Camp

Git Base Camp 是 Build 前置门槛。系统必须检查：

1. 当前项目是 Git 仓库。
2. 能读取 `HEAD` / `baseCommit`。
3. 能创建隔离 workspace，优先使用 `git worktree`。
4. 主仓当前状态被记录，包括 branch、HEAD、dirty files。
5. Build Runner 不会直接写入主仓工作区。

无 Git 时：

- 不允许进入正式 Build。
- UI 显示“建立 Git Base Camp”。
- 系统可提示用户执行 `git init`、创建 initial commit 或选择已有 Git 仓库。
- 不提供“临时目录直接施工后覆盖主仓”的 fallback。

主仓存在未提交变更时：

- MVP 默认阻断正式 Build，并提示用户先 commit / stash / discard。
- 未来可允许用户显式选择 dirty baseline，但必须先写清快照和回滚策略。

#### Build Workspace / Git Worktree Contract

每个 Change 必须拥有独立 Build workspace。默认策略：

```text
git worktree add -b cc-ai/change/<changeId> <workspacePath> <baseCommit>
```

worktree 建议放在项目外部的系统目录，避免污染主项目：

```text
~/.cc-ai/workspaces/<projectId>/<changeId>
```

`BuildRun` 必须记录 `workspacePath`、`branchName`、`baseCommit`、`createdAt`。Build Runner 的所有代码修改、依赖安装、测试命令都在 workspace 内执行。主仓只作为 baseline 和最终收编目标。

收编前系统必须确认：

1. 主仓 workspace clean。
2. 主仓 `HEAD === baseCommit`，没有漂移。
3. patch 来自已登记的 Build workspace。
4. Build Gate 通过，且没有 open P0 Build Audit finding。
5. 人类已经批准收编。

若主仓 dirty、HEAD 漂移或 patch apply 冲突，系统必须阻断收编，要求用户 re-run、rebase 或手动处理。

#### expectedFiles / allowedFiles 迁移

v3.6 起，`allowedFiles` 不再作为 Build 实际 diff 的硬白名单。为避免破坏旧数据，新增 `expectedFiles` 表示预计施工范围；旧 `allowedFiles` 仅作为迁移期 legacy alias 读取。

兼容规则：

```ts
expectedFiles = plan.expectedFiles ?? plan.allowedFiles;
```

Build Runner 可以在隔离 workspace 中修改 `expectedFiles` 之外的文件，但系统必须：

1. 在 build report 中标记 `BuildDeviation`。
2. 让反方审计该偏离是否合理。
3. 在人类审批收编前展示偏离文件、原因和风险。
4. 对 `forbiddenFiles`、policy blocked globs、密钥、路径逃逸和 Git 安全边界继续硬阻断。

`forbiddenFiles` 仍是硬边界。触碰 forbidden files 的 Build 结果不得收编；MVP 不提供高危 override。

#### Build 反方审计

Build Audit 只执行一次标准审计。反方必须审查：

- diff 是否满足 PRD / Spec / Plan / TestPlan 意图。
- 是否出现 `expectedFiles` 之外的合理或异常变更。
- 是否触碰 `forbiddenFiles` / policy blocked globs。
- validationCommands 是否执行且结果可信。
- 是否存在测试缺口、回归风险、迁移风险、安全风险。
- patch 是否可被人类理解和收编。

AI 反方 Audit 不能成为唯一 gate。硬边界必须由 deterministic Build Gate 计算；AI 反方只产出风险分类、证据和解释。

### 7.7 Review 战报中心（v3.7 待审批扩展）

Review 位于 Build 收编之后、QA 之前。它不写代码、不执行测试、不替代 QA；它只审查刚刚 Build 并已吸收进主仓的代码包，判断这包代码是否值得进入 QA。

Review 阶段的对抗语义固定为：

```text
红方 = 人类用户 / 作战指挥官 / 风险裁决者
反方 = AI Reviewer / 审查官
系统 = 战报结算器 / Review Gate 裁判 / freshness 裁判
```

Review 战报中心不是新编排器，也不是 Spec Battle 的多轮版本。它的产品目标是把反方 Reviewer 的结构化结论提升为默认界面，让人类先看战报，再做裁决。

本节是后续实现的产品契约，不表示当前系统已经完成该能力。Review 阶段的唯一真相必须是数据库中的 Review findings：Review、Fix、Waive、Merge、QA gate 都以 DB findings 的主状态为准；`.ship/changes/<id>/review-findings.json`、`.ship/changes/<id>/review-report.md`、`.ship/changes/<id>/raw-review-output.json` 只是镜像和审计产物，不参与核心判断。

默认第一屏必须回答四个问题：

1. 这包代码能不能进入 QA。
2. 反方拦住了什么。
3. 哪些必须修、哪些可由人类接受风险、哪些只是记录。
4. 指挥官现在能按哪个按钮。

推荐流程：

```text
BuildRun.status = adopted
  -> Review 待审
  -> 人类点击“开始反方审查”
  -> AI 反方 Reviewer 只读 Build patch / changed files / PRD / Spec / Plan / TestPlan
  -> 系统解析结构化 Review findings
  -> deterministic Review Reporter 生成 Review 战报中心状态
  -> 人类裁决：修复阻断项 / 接受 P1 风险 / 重新审查 / 进入 QA / 终止 Change
```

Review 严重级别语义：

| 级别 | Review 语义 | Gate 规则 |
|---|---|---|
| P0 | 会导致核心功能错误、安全问题、数据损坏、明显违背计划或不可审查 | 必须修复，不可豁免，不得进入 QA |
| P1 | 重要缺陷、关键边界缺失、主要风险，但人类可承担 | 默认阻断；可修复，或人类填写理由后豁免 |
| P2 | 次要质量、可维护性、轻微边界或建议 | 只记录，不阻断 QA |

Review finding 的用户可见字段必须统一为：`id`、`changeId`、`runId`、`source`、`severity`、`category`、`title`、`file`、`line`、`evidence`、`requiredFix`、`status`、`waivable`、`createdAt`、`updatedAt`。其中 `source` 固定为 `review`；`severity` 只允许 `P0 / P1 / P2`；`status` 只允许 `open / fixed / waived`。新接口、prompt、schema、parser、DB、UI 都只认 `requiredFix`；`suggestion` / `recommendation` 只允许作为短期旧数据兼容输入，不得作为新契约字段出现在 Review 新产物或 UI 主路径。

严重级别字段完整性规则：

1. P0 必须有 `evidence` 和 `requiredFix`，不可豁免。
2. P1 必须有 `evidence` 和 `requiredFix`，可以由人类填写理由后豁免。
3. P2 必须有 `evidence`，`requiredFix` 可以为空。

Review 进入 QA 的必要条件：

1. 最新有效 Review run 已完成。
2. Review 战报绑定的 `sourceBuildRunId` 等于最新 adopted Build run。
3. Review 战报不是 stale。
4. 不存在 open P0。
5. 不存在 open P1；或所有 P1 已由人类填写 reason 后豁免，并重新结算出 fresh 战报。
6. P2 可以存在，但必须展示在战报中并聚合进总战报。

Review 失败、输出不合格或数据不一致时都不能伪装成通过。provider 失败属于 `failed`；report / DB findings / `.ship` 镜像不一致属于 `data_inconsistent`；AI 输出非法 JSON、缺少必填字段、严重级别规则不满足属于 `invalid_output`，必须作为独立状态展示，不再伪装成 `failed`。发生 `invalid_output` 时必须保存 `raw-review-output.json`，Review 战报中心必须展示错误原因，并提供进入原始输出的高级详情入口；系统不得把它当作无 findings。

Review 战报中心必须同时展示两层战报：

- `latestAttempt`：最近一次 Review 尝试，可能是 `passed`、`issues_found`、`failed`、`invalid_output` 或 `data_inconsistent`。
- `latestValidReview`：最近一次有效战报，只能来自成功解析且数据一致的 Review 尝试。

最新尝试为 `failed`、`invalid_output` 或 `data_inconsistent` 时，都不能覆盖上一轮有效战报。用户应能看到“最近尝试失败/输出不合格/数据不一致”和“上一轮有效战报仍是什么”两个事实；QA gate 只能基于 `latestValidReview`、DB findings 和 `sourceBuildRunId` freshness 判断。

Review 旧问题复核协议：

- 新一轮 Review 必须先复核上一轮仍 open 的 P0/P1 Review finding，再允许新增 findings。
- 旧 P0/P1 在新一轮反方输出中缺失时，不得自动关闭。
- 旧 P0/P1 只有在反方明确复核并由系统确认 `fixed` 或人类带理由豁免为 `waived` 后，系统才可改变其状态。
- P1 waiver 会让当前 Review 战报 stale；系统必须重新结算或重新审查后，才允许进入 QA。

Review 战报中心第一屏只展示三块：

1. **关卡状态**：Build 已收编、Review 待审/审查中/失败/阻断/通过、QA 是否可进入、P0/P1/P2 计数。
2. **反方战报**：一句话结论、P0 必修项、P1 风险项、P2 记录项；每条 finding 必须显示证据、影响、必需修复。
3. **指挥按钮**：开始反方审查、修复阻断项、接受 P1 风险、重新审查、进入 QA、终止 Change。

旧数据兼容的用户可见结果：

- 历史 Review 数据只有 `suggestion` / `recommendation`、或 `requiredFix:null` 且严重级别需要修复说明时，页面不得直接崩溃。
- 这类战报必须标为“历史不完整战报”，并要求重新 Review 或人工处理。
- 历史不完整战报不能作为进入 QA、Merge 或关闭阻断项的依据。

默认折叠：

- 原始 run history。
- provider 原文。
- artifacts 文件路径。
- events stream。
- raw JSON。

这些信息只能在“高级详情”里查看。Review 第一屏不得出现 `CHECK_FAILED`、`REVIEWING`、`approve`、`waive_p1`、route 名称或 artifact 绝对路径等后台词。

### 7.8 Review 阶段数据库化（v3.8 待审批增量）

v3.8 对 v3.7 Review 战报中心做存储权威收敛：Review 阶段的主状态、attempt、latest valid review、findings、waiver、raw output metadata、artifact mirror status、gate state 和可重建战报均以数据库为唯一权威。JSON / Markdown / `.ship` 文件只作为审计镜像和 AI 上下文快照存在，不能参与主状态裁决。

本增量的产品原则是：

```text
DB 当裁判。
JSON / Markdown 当战报副本。
.ship 当审计镜像和 AI 上下文快照。
镜像可以丢，可以重建，但不能反向改写裁判结果。
```

#### 7.8.1 目标

1. 降低 Review 阶段因 JSON 文件缺失、格式错误、写入中断或镜像不一致导致的主流程失败。
2. 明确 Review run、Review attempt、Review report、latest valid review、findings、waiver、raw output metadata、artifact mirror status、gate state 的数据库权威边界。
3. 允许系统从数据库 deterministic 重建 `review-report.md` 与 `review-findings.json`，保证镜像是可再生结果，而不是主状态来源。
4. 保证进入 QA 只能依赖 DB Review gate，不能依赖 `.ship` 下的 JSON / Markdown 文案。
5. 对历史 JSON-only Review 数据做显式降级标记，避免旧数据被误当作完整有效战报。

#### 7.8.2 非目标

1. 不取消 `.ship/changes/<id>/review-report.md`、`review-findings.json`、`raw-review-output.json` 等审计产物。
2. 不要求 v3.8 一次性修复所有历史 JSON-only 数据。
3. 不改变 v3.7 的 P0 / P1 / P2 gate 语义。
4. 不允许 Review AI 直接写数据库主状态；AI 只能输出候选结构化结果，由 deterministic service 校验、归一化并入库。
5. 不把镜像写入失败视为 Review gate 失败；镜像状态只影响审计完整性提示和高级详情。

#### 7.8.3 用户流程

1. 用户在 Build 已收编后点击“开始反方审查”。
2. 系统创建 DB Review run，绑定 `changeId`、`sourceBuildRunId`、`buildHeadSha`、当前 `HEAD`、Review schema version 和 idempotency key。
3. 每次调用 AI Reviewer 创建或更新 DB Review attempt，记录 attempt 状态、provider、模型、开始/结束时间、raw output metadata、error envelope 和解析结果。
4. AI 输出先进入解析与校验流程；只有通过 schema、severity、`requiredFix`、旧 P0/P1 复核等校验的 attempt，才能进入 Review report 结算。
5. `REVIEW_REPORTER` 从 DB run、DB findings、waiver / human decisions、latest adopted BuildRun、artifact hash metadata 和当前 `HEAD` deterministic 生成 DB Review report。
6. 系统 best-effort 生成 `.ship` 审计镜像，包括 `review-report.md`、`review-findings.json`、`raw-review-output.json` 或其引用信息。
7. 如果镜像缺失、写入失败或与 DB 不一致，Review 战报中心显示“审计镜像异常”，但 QA gate 继续只按 DB 主状态裁决。
8. 用户可在高级详情中触发“重建审计镜像”，系统从 DB 重建 `review-report.md` 与 `review-findings.json`。

#### 7.8.4 DB 权威边界

Review 阶段必须新增或明确复用以下权威 DB 边界：

| 边界 | 职责 | 是否参与 gate |
|---|---|---|
| `review_runs` 或现有 `runs(phase="review")` 的 Review 专用投影 | 记录每次 Review attempt 的生命周期、provider、状态和错误，不单独承载 gate 结论 | 是，作为 latestAttempt 来源 |
| `review_reports` | 记录 deterministic Review Center 结算结果、counts、freshness、`sourceBuildRunId`、`buildHeadSha`、`latestAttemptId`、`latestValidReviewId`、stale reason、allowed actions、mirror status | 是，作为 latestValidReview / gate 来源 |
| DB `findings` | 承载 Review findings 主状态，`source="review"` 且满足 ReviewFinding 专用约束 | 是 |
| `human_decisions` 或 `review_waivers` | 承载 P1 waiver 审计记录和人类 reason | 是 |
| `artifacts` | 只索引 `.ship` 镜像、raw output 和 report 文件 | 否 |
| artifact mirror metadata | 记录 `artifactId`、`contentHash`、`schemaVersion`、`generatedFromRunId`、`sourceDbHash`、`mirrorStatus` | 否，只展示审计风险 |

Review gate、QA entry、Fix/Waive/Merge 判断只能读取 Review runs、DB findings、Review reports、human decisions / waivers 和 latest adopted BuildRun，不得读取 `.ship` JSON / Markdown 作为状态源。

#### 7.8.5 latestAttempt / latestValidReview 选择算法

`latestAttempt` = 当前 change 下创建时间最新、且属于 Review 阶段的一条 Review run，无论结果成功、失败、`invalid_output` 或 `data_inconsistent`。

`latestValidReview` = 最新一条满足以下条件的 Review report：

1. 对应 Review run 已结束，且 AI 输出成功解析。
2. Findings 已写入 DB，且 ReviewFinding 专用约束全部满足。
3. Report 由 deterministic `REVIEW_REPORTER` 从 DB 结算生成。
4. `sourceBuildRunId` 与该次 Review 审查对象一致。
5. `buildHeadSha`、Build patch hash / changed files hash 与 latest adopted BuildRun 一致。
6. 不处于 `legacy_incomplete`。
7. Artifact 镜像一致，或 artifact 镜像缺失但 DB report 明确标记为 `rebuildable`。

`failed`、`invalid_output`、`data_inconsistent` attempt 必须保存在 DB 中，但不得覆盖 `latestValidReview` 候选集合。UI 必须同时展示“最近尝试”和“上一轮有效战报”两个事实。

#### 7.8.6 镜像检测、重建和 data_inconsistent

`.ship/changes/<id>/review-findings.json`、`review-report.md`、`raw-review-output.json` 是 DB 的审计镜像。镜像写入时必须记录 `artifactId`、`contentHash`、`schemaVersion` 和 `generatedFromRunId`。

当 DB 与镜像不一致时，系统不得用 `.ship` 镜像反向覆盖 DB 主状态。允许的修复方向只有：

1. 从 DB 重建镜像。
2. 重新 Review。
3. 人工终止 change。

Review Center 必须提供 deterministic “重建审计镜像”能力。输入为 DB Review runs、DB Review findings、Review reports、human decisions、latest BuildRun；输出为 `review-findings.json`、`review-report.md` 和 artifacts 索引更新。重建镜像不得改变 finding 状态、waiver 状态、gate 结论或 run 状态，只能更新镜像文件、hash 和 artifact 索引。

`data_inconsistent` 的产品含义是“DB 主状态与审计镜像或结算 metadata 发生冲突，系统不能确认当前战报完整可审计”。第一屏只显示“审计镜像与数据库不一致，不能进入 QA”，并给出“重建镜像 / 重新审查 / 终止 Change”按钮；具体 hash、artifact 路径、diff 只放高级详情。

#### 7.8.7 QA 全入口 Gate

所有进入 QA 的入口，包括 UI 按钮、pipeline service、API route、旧 `runCheck` / `continue` 路径和任何自动推进逻辑，都必须调用同一个 Review QA Gate service。

该 service 必须拒绝以下情况：

1. 没有 `latestValidReview`。
2. `latestValidReview.sourceBuildRunId` 不是 latest adopted BuildRun。
3. `latestValidReview.buildHeadSha` 不是 latest adopted BuildRun 的 `adoptedHeadSha`。
4. 当前主仓 `HEAD` 不等于 latest adopted BuildRun 的 `adoptedHeadSha`。
5. BuildRun 记录了 patch hash / changed files hash，但 Review report 中的 hash 不一致。
6. latestAttempt 为 `running`。
7. Review report stale。
8. 存在 open P0。
9. 存在 open P1 且没有有效 P1 waiver + fresh recomputed report。
10. 当前 change 只存在 `legacy_incomplete` Review 数据。

#### 7.8.8 Freshness 和状态变更

Review freshness 不只比较 `sourceBuildRunId`。fresh 必须同时满足：

1. `review_reports.sourceBuildRunId === latest adopted BuildRun.id`。
2. `review_reports.buildHeadSha === BuildRun.adoptedHeadSha`。
3. 当前主仓 `HEAD === BuildRun.adoptedHeadSha`。
4. 若 BuildRun 记录了 patch hash / changed files hash，Review report 中的 hash 必须一致。
5. P1 waiver、finding 状态变更、Build adoption 变更都会让既有 Review report stale。

任一条件不满足，Review Center gate 必须为 `stale`，不得进入 QA。

#### 7.8.9 P1 Waiver 与 Fix

P1 waiver 必须是独立审计事件，至少包含：

- `decisionId`
- `findingId`
- `changeId`
- `reviewRunId`
- `actor`
- `reason`
- `createdAt`
- `findingSnapshot`
- `previousReportId`
- `resultingReportId`

Waiver 写入、finding 标记 `waived`、report 标记 stale 必须在同一事务或可恢复事务链中完成。失败时不得出现 finding 已 waived 但 report 未 stale 的状态。

Review finding 的修复不得直接把旧 finding 改成 fixed。修复必须产生新的 BuildRun 或 FixRun，并在其 adopted 后触发新 Review。只有新 Review 对旧 finding 给出明确 `fixed` 复核结果，系统才可关闭该 finding。在新 BuildRun adopted 前，旧 Review findings 继续阻断 QA。

#### 7.8.10 旧 P0/P1 复核 Schema

新一轮 Review 输出必须包含 `reviewedPriorFindings` 或等价结构。对每个上一轮 open P0/P1，Reviewer 必须返回：

- `findingId`
- `verdict: still_open | fixed | downgraded | not_reviewable`
- `evidence`
- `reason`

未出现于复核结果的旧 P0/P1 必须保持 open，并在 Review Center 标记为“未被复核”。

#### 7.8.11 历史数据迁移

迁移期启动时，系统必须扫描历史 `.ship` Review JSON / Markdown：

1. 可解析且字段满足 ReviewFinding 约束的，导入 DB，标记 `importedFromArtifact=true`、`legacy=true`、`sourceArtifactHash`、`schemaVersion`、`importedAt`。
2. 缺少 `requiredFix`、`evidence`、`runId`、`sourceBuildRunId` 或 severity 不合法的，只创建“历史不完整战报”只读记录，不得作为 `latestValidReview`。
3. 迁移必须可重复执行且幂等，不得重复创建 findings。
4. 自 Review DB schema 启用后，新 Review run 禁止生成 JSON-only 状态；所有新状态必须先写 DB，再由 DB 生成镜像。
5. 兼容期结束后，缺 DB 记录的历史 Review 只能显示为 legacy artifact，不得影响 gate。

历史不完整战报不得混入 fresh Review 战报主列表。UI 应把它放在“历史记录 / 需迁移处理”区域，并明确标注“不参与 QA gate”。

#### 7.8.12 Raw Output 审计

每一次 Review attempt 都必须先保存 provider raw output 或 provider error envelope，再执行 parser。成功、失败、`invalid_output` 都必须有可审计记录：

1. 成功：保存 raw output artifact hash，用于追溯 parser 行为。
2. Provider 失败：保存 error code、message、provider metadata 的脱敏 envelope。
3. `invalid_output`：保存原始输出全文或安全截断版本，并记录截断标记。

Raw output 永远不参与 gate，只能在高级详情查看。Raw output artifact 必须支持大小上限、截断标记和敏感信息提示；UI 展示前必须提示这是 provider 原始输出，仅用于调试和审计。

#### 7.8.13 并发、幂等和 UI DTO

同一 change 同一时间只能存在一个 `review_runs.status="running"`。`run_review` 必须具备 idempotency key，重复点击不得创建多个 active run。`recompute_report` 和“重建审计镜像”必须是 deterministic、可重复执行的操作。

Review Center API 返回面向 UI 的 DTO，不直接暴露 DB enum、artifact 绝对路径、run 内部状态或 raw JSON。后台字段只能出现在 `advancedDetails` 中，且默认折叠。第一屏 DTO 字段只包括：`headlineStatus`、`qaAllowed`、`counts`、`freshnessLabel`、`blockingFindings`、`riskFindings`、`recordOnlyFindings`、`primaryAction`、`secondaryActions`。

## 八、系统内置 Unit / Template

### 8.1 Unit Enum

```ts
type BattleUnit =
  | "SPEC_WRITER"
  | "REQUIREMENT_CRITIC"
  | "BATTLE_REPORTER"
  | "HUMAN_COMMANDER";
```

| Unit | 类型 | MVP 职责 |
|---|---|---|
| `SPEC_WRITER` | 我方执行代理 | 生成或修订 `prd-delta.md`；读取当前 open P0/P1 gap，逐项给出修复声明和最小规格补丁 |
| `REQUIREMENT_CRITIC` | 反方 AI | 先复核上一轮 open gap 是否已被我方修复，再识别新增 Requirement Gap 与 Spec findings |
| `BATTLE_REPORTER` | deterministic service | 聚合 facts、counts、状态、门禁结论，生成 report |
| `HUMAN_COMMANDER` | 人类 | 在 gate 上做有限裁决 |

Plan 待审批扩展可新增系统内置单位，但仍必须是 enum，不允许用户自定义：

```ts
type PlanUnit =
  | "IMPLEMENTATION_PLANNER"
  | "PLAN_CRITIC"
  | "PLAN_REPORTER"
  | "HUMAN_COMMANDER";
```

| Unit | 类型 | Plan 职责 |
|---|---|---|
| `IMPLEMENTATION_PLANNER` | 我方计划参谋 | 读取 DB PRD / Spec report / TechSpec / TestPlan 上下文，生成 DB Plan snapshot，并渲染 `plan.json` 与 `plan.md` 镜像 |
| `PLAN_CRITIC` | 反方 AI | 审查计划粒度、文件范围、顺序依赖、验证缺口、隐藏风险 |
| `PLAN_REPORTER` | deterministic service | 聚合 DB 计划、风险、审批状态，生成 Plan Report metadata，并渲染 `reports/plan-report.md` 镜像 |
| `HUMAN_COMMANDER` | 人类 | 批准、要求重排、拆小任务、接受 P1 风险或终止 |

Build 待审批扩展可新增系统内置单位：

```ts
type BuildUnit =
  | "BUILD_RUNNER"
  | "BUILD_AUDITOR"
  | "BUILD_REPORTER"
  | "HUMAN_COMMANDER";
```

| Unit | 类型 | Build 职责 |
|---|---|---|
| `BUILD_RUNNER` | 我方施工代理 | 在 change 级 worktree 内按 Plan / TestPlan 实现代码，不直接修改主仓 |
| `BUILD_AUDITOR` | 反方 AI | 审计 diff、计划外改动、硬禁止文件、测试可信度、收编风险 |
| `BUILD_REPORTER` | deterministic service | 聚合 changed files、patch、Build Gate、Audit、验证结果，生成 `reports/build-report.md` |
| `HUMAN_COMMANDER` | 人类红方 | 审批收编、拒绝收编、要求重新 Build、退回 Plan 或丢弃施工区 |

Review 待审批扩展可新增系统内置单位：

```ts
type ReviewUnit =
  | "REVIEWER"
  | "REVIEW_REPORTER"
  | "HUMAN_COMMANDER";
```

| Unit | 类型 | Review 职责 |
|---|---|---|
| `REVIEWER` | 反方 AI | 只读已收编 Build 结果、changed files 和上游文档，输出结构化 P0/P1/P2 Review findings |
| `REVIEW_REPORTER` | deterministic service | 聚合最新 Review run、Build freshness、findings、waiver 和 gate，生成 Review 战报中心状态 |
| `HUMAN_COMMANDER` | 人类红方 | 裁决修复、接受 P1 风险、重新审查、进入 QA 或终止 Change |

### 8.2 Template Enum

```ts
type BattleTemplate =
  | "SPEC_BATTLE_MVP";
```

MVP 只允许 `SPEC_BATTLE_MVP`。后续可新增系统内置模板，但仍必须是 enum，不允许用户自由编辑。

Plan 待审批扩展新增：

```ts
type PlanTemplate =
  | "PLAN_SANDBOX_MVP";
```

`PLAN_SANDBOX_MVP` 只负责把实施计划沙盘化，不负责执行代码修改。

Build 待审批扩展新增：

```ts
type BuildTemplate =
  | "BUILD_WORKSPACE_MVP";
```

`BUILD_WORKSPACE_MVP` 只负责 Git Base Camp、隔离 worktree、一次 Build Runner、一次 Build Audit 和人类审批收编；不包含拖拽编排、多施工队并发或自定义单位。

Review 待审批扩展新增：

```ts
type ReviewTemplate =
  | "REVIEW_REPORT_CENTER_MVP";
```

`REVIEW_REPORT_CENTER_MVP` 只负责一次反方 Review、deterministic 战报结算、P0/P1/P2 裁决和进入 QA 前 gate；不包含多 Reviewer 投票、自定义 prompt、多轮 Review Battle 或自动修复闭环。

### 8.3 允许的少量参数

```ts
interface BattleParams {
  maxSpecRounds: 1 | 2 | 3 | 4 | 5;
  allowP1Waiver: boolean;
}
```

默认值：

```json
{
  "maxSpecRounds": 3,
  "allowP1Waiver": true
}
```

用户不能通过参数改变 severity 规则、gate invariant、单位 prompt、阶段边。

### 8.4 SLG 回合制交互模型

Spec Battle 在产品层必须表现为一场有限回合 SLG 对战，而不是后台审批表单。

每一轮固定为：

```text
Round N
我方代理出招：SPEC_WRITER 生成或修订 Spec / PRD Delta，并对当前 open P0/P1 gap 逐项声明修复、保留或请求人工裁决
反方反击：REQUIREMENT_CRITIC 先验证旧 gap 的修复声明，再挑刺、攻击新增漏洞、产出 Gap
战报结算：BATTLE_REPORTER 汇总胜负、阻断项和建议动作
人类裁决：继续对抗一轮 / 接受风险并通过 / 终止 Battle
```

用户在开始或重新开战前可以定义 `maxSpecRounds`，默认 3 轮，MVP 上限 5 轮。回合数上限只约束自动连续推进，不得让人类陷入无路可选的死局。到达最终轮后，如果仍存在 P1 阻断，用户仍可追加一轮或接受风险；如果存在 P0 阻断，则必须继续修订或终止，不能直接通过。

开战前状态必须足够简单：当 change 进入 Spec Battle 且尚未创建 round 时，主界面显示“开战前战场”。开战前只允许用户设置 `maxSpecRounds` 并启动第 1 轮，不得展示审批表、Requirement Gap 原始 JSON、artifact 绝对路径或后台 gate 枚举。

### 8.5 Spec 主界面只保留两个主区域

Spec 阶段主界面只保留两个核心区域：

1. **战场**：展示当前轮数、我方代理状态、反方状态、战报状态和当前局势。
2. **本轮战报**：展示我方本轮改进、反方本轮攻击、P0/P1/P2 计数、gap 消账结果、系统建议。

以下信息默认折叠到“高级详情”，不得作为主界面第一层信息：

- `roundId` / `gateState` / `reportFresh` / `ChangeStatus` 枚举。
- artifact 绝对路径。
- Requirement Gap 原始 JSON。
- phase rail 的全部阶段细节。
- events stream 和运行日志。

主操作只保留：

| 按钮 | 产品语义 | 后台动作 |
|---|---|---|
| 继续对抗一轮 | 基于本轮战报让我方代理继续修、反方继续审；已到默认上限时显示为“继续追加一轮” | `request_changes` 或 `return_to_spec` |
| 刷新战报 | 只重新结算当前轮 facts 和 counts，不重跑我方代理和反方 | regenerate report |
| 接受风险并通过 | 人类接受非 P0 风险并批准进入 TechSpec | direct approve，或受控执行 `waive_p1 -> regenerate -> approve fresh report` |
| 终止 Battle | 停止本 change 的 Spec 推进 | block / reject |

前端不得把后台动作名作为主按钮文案。`Request Changes`、`Return to Spec`、`Waive P1` 只允许出现在高级详情或审计记录中。

当当前轮次已达到 `maxSpecRounds` 时，“继续对抗一轮”文案变为“继续追加一轮”。追加一轮必须记录 human decision reason，并将新 round 标记为 `humanExtended = true`。`maxSpecRounds` 不得作为拒绝人类追加轮的理由。

“接受风险并通过”是受控工作流，不是单个绕过动作。当不存在 P0 且存在 open P1 时，系统必须先收集 reason，再写入 P1 waiver decision，标记 report stale，刷新 fresh report，最后 approve fresh report。任一步失败都必须停在可恢复状态，禁止在 P1 waiver 后 approve 旧 report。

“刷新战报”只触发 `BATTLE_REPORTER` 的确定性重结算。刷新战报不得重新运行 `SPEC_WRITER` 或 `REQUIREMENT_CRITIC`，不得改变 Requirement Gap 业务状态，只能更新 report metadata、source hashes、counts 和 markdown 内容。

### 8.6 Requirement Gap 逐项消账协议

Spec Battle 必须是“逐项消账”的攻防，而不是反方无限新增问题、我方代理泛化改文档。

每一轮我方代理开始前，系统必须把当前仍为 open / downgraded / overridden 且会阻断 Spec 的 P0/P1 Requirement Gap 注入我方代理上下文。我方代理不得只输出新的 PRD Delta；我方代理必须对每个阻断 gap 给出结构化修复声明：

```ts
interface RedFixClaim {
  gapId: string;
  canonicalGapId: string;
  action: "fixed" | "partially_fixed" | "not_fixed" | "needs_human_decision";
  specPatch: string | null;
  evidence: string;
}
```

我方代理输出规则：

- 对每个 open P0/P1 必须有且只有一个 `RedFixClaim`。
- `fixed` 必须给出已写入或建议写入 `prd-delta.md` 的最小文本。
- `partially_fixed` 必须说明仍缺什么，并给出下一轮建议。
- `not_fixed` 必须说明无法修复的原因。
- `needs_human_decision` 只能用于产品取舍，不得用于逃避明确的验收缺口。

反方开始审查时，必须先复核上一轮仍 open 的 P0/P1，再评估新增问题。反方输出必须区分“旧 gap 复核”和“新增 gap”：

```ts
interface BlueGapReview {
  canonicalGapId: string;
  verdict: "resolved" | "still_open" | "downgraded" | "needs_human_decision";
  severity: "P0" | "P1" | "P2";
  evidence: string;
  resolutionEvidence?: string;
  downgradedTo?: "P1" | "P2";
}
```

反方输出规则：

- 对我方本轮声明修复的每个 P0/P1，必须返回一个 `BlueGapReview`。
- `resolved` 是唯一能由 AI 关闭 gap 的 verdict，且必须提供 `resolutionEvidence`。
- `still_open` 必须复用原 `canonicalGapId`，不能换 ID 造成重复开单。
- `downgraded` 必须给出降级理由；P0 不能直接降到 P2。
- `needs_human_decision` 会保持 gap 阻断，等待人类裁决或下一轮修订。
- 反方只有完成旧 gap 复核后，才允许在 `requirementGaps` 中新增问题。

系统消账规则：

- 旧 gap 在新一轮反方输出中缺失时，不得自动关闭；必须保持 open，并在战报中标记为“未被复核”。
- 反方 verdict 为 `resolved` 时，系统将 gap 置为 `resolved`，写入 `resolvedByRoundId`、`resolutionEvidence`、`closedAt`。
- 反方 verdict 为 `still_open` 时，系统更新 `lastEvaluatedRoundId` 和 evidence，保持阻断。
- 反方 verdict 为 `downgraded` 时，系统写入 `downgradedTo` 和 `downgradeReason`，并按新 severity 重新计算 gate。
- 反方新增 gap 必须使用稳定 `canonicalGapId`；同一语义问题跨轮必须复用 ID。

战报必须显示本轮“消账结果”：

| 指标 | 含义 |
|---|---|
| Resolved This Round | 本轮被反方确认关闭的 gap |
| Still Open | 本轮复核后仍阻断的 gap |
| Newly Found | 本轮新发现的 gap |
| Not Rechecked | 旧 gap 本轮未被反方复核，必须继续阻断 |

MVP 成功标准不是“反方发现的问题越来越多”，而是每一轮都能解释：

- 我方代理修了哪些旧问题。
- 反方确认关闭了哪些旧问题。
- 哪些旧问题仍然阻断。
- 新增问题为什么不是旧问题的重复描述。

## 九、统一 Severity

```ts
type Severity = "P0" | "P1" | "P2";
```

| Severity | 定义 | 默认门禁 |
|---|---|---|
| P0 | 阻断级。需求根本缺失、核心验收不可判定、方向错误、安全/数据损坏风险 | 必须阻断 |
| P1 | 重大级。关键歧义、重要边界缺失、主要验收缺口 | 默认阻断，可由人类填写 reason 后接受风险 |
| P2 | 建议级。轻微歧义、文案、非关键优化 | 不阻断，进入 report/backlog |

## 十、统一数据模型

### 10.1 权威存储原则

| 数据 | 权威位置 | 镜像 / 展示 |
|---|---|---|
| change 主状态 | DB `changes.status` | UI phase rail |
| gate 状态 | DB `changes.gateState` + gate service 计算 | `human-decisions.json` |
| findings 状态 | DB `findings` | `.ship/changes/<id>/findings.json` |
| PRD 作战意图 | DB PRD briefing state | `.ship/changes/<id>/prd-intent.md` |
| PRD 疑点卡 | DB PRD briefing questions | `.ship/changes/<id>/briefing-questions.json` |
| PRD 草案 | DB PRD draft / locked baseline state | `.ship/changes/<id>/prd-draft.md`、artifacts 表索引 |
| PRD Gate | DB / deterministic service | `.ship/changes/<id>/prd-gate.json` |
| Requirement Gap 状态 | DB `requirement_gaps` | `.ship/changes/<id>/requirement-gaps.json` |
| battle round 状态 | DB `battle_rounds` | `.ship/changes/<id>/rounds/*.json` |
| human decision | DB `human_decisions` | `.ship/changes/<id>/human-decisions.json` |
| war report metadata | DB `war_reports` | `.ship/changes/<id>/reports/*.md` |
| report markdown 内容 | DB report body / report metadata | `.ship/changes/<id>/reports/*.md`、artifacts 表索引 |
| Review run / attempt | DB `review_runs` 或 `runs(phase="review")` Review 专用投影 | `.ship/changes/<id>/runs/<runId>/` 摘要 |
| Review report / gate 结算 | DB `review_reports` | `.ship/changes/<id>/review-report.md`、`.ship/changes/<id>/reports/review-report.md` |
| Review findings 主状态 | DB `findings`（`source="review"`） | `.ship/changes/<id>/review-findings.json` |
| Review P1 waiver | DB `human_decisions` 或 `review_waivers` | `.ship/changes/<id>/human-decisions.json` |
| Review raw output metadata | DB review attempt / artifact metadata | `.ship/changes/<id>/raw-review-output.json` 或截断审计文件 |
| Review artifact mirror status | DB artifact metadata / review report mirror status | `.ship` 文件 hash、schemaVersion、generatedFromRunId |

关键门禁、阶段推进、按钮可用性和后端 preflight 只读取 DB 状态和 deterministic counts，不读取 AI 自然语言摘要，也不读取 `.ship` JSON / Markdown 作为权威。

全链路额外约束：`.ship` 下的 JSON / Markdown 永远不是 PRD、Spec、Plan、TestPlan、Build、Review、QA、Merge 的状态源。它们只能由 DB 主状态生成、重建或作为迁移期只读导入输入。除明确的一次性 legacy import 外，系统不得用镜像反向覆盖 DB。

### 10.1.1 PRD Briefing Schema

PRD Briefing Room 的结构化状态必须写入 DB，并同步到 `.ship/changes/<id>/` 下的 AI / 人工可读镜像。

```ts
interface PrdIntent {
  changeId: string;
  rawText: string;
  createdAt: string;
  updatedAt: string;
}

interface BriefingQuestion {
  id: string;
  changeId: string;
  category:
    | "goal"
    | "user"
    | "scope"
    | "success"
    | "negative_case"
    | "risk"
    | "constraint"
    | "spec_blocker";
  severity: "critical" | "important" | "optional";
  question: string;
  whyItMatters: string;
  suggestedDefault: string | null;
  status: "open" | "answered" | "assumption_accepted" | "deferred";
  answer: string | null;
  source: "ai_blue";
}

interface PrdDraft {
  changeId: string;
  version: number;
  markdown: string;
  sourceQuestionIds: string[];
  unresolvedQuestionIds: string[];
  createdAt: string;
}

interface PrdGate {
  changeId: string;
  canLock: boolean;
  blockingQuestionIds: string[];
  deferredQuestionIds: string[];
  clarityLevel: "low" | "medium" | "high";
  riskLevel: "low" | "medium" | "high";
}
```

`clarityLevel` 和 `riskLevel` 是界面引导，不作为硬编码质量分数宣传。PRD Gate 的阻断依据必须是具体疑点卡状态，而不是抽象分数。

### 10.2 Finding Schema

现有 `findings` 表保留并扩展为通用 base model。该通用模型服务 Spec / Review / QA 等多个来源，因此允许部分字段为空；它不是 Review 阶段的新接口契约。Review 阶段必须额外满足 7.7 中定义的 `ReviewFinding` 专用约束：`runId` 必须存在，`source` 必须为 `review`，`evidence` 必须存在，P0/P1 必须有 `requiredFix`，并且必须派生 `waivable`。

```ts
interface Finding {
  id: string;
  changeId: string;
  runId: string | null;
  roundId: string | null;
  phase: "Spec" | "TechSpec" | "TestPlan" | "Review" | "QA";
  source: "requirement_critic" | "review" | "lint" | "test" | "build" | "scope" | "human";
  severity: "P0" | "P1" | "P2";
  category: string;
  title: string;
  file: string | null;
  line: number | null;
  evidence: string | null;
  requiredFix: string | null;
  status: "open" | "fixed" | "waived";
  createdAt: string;
  updatedAt: string;
}
```

MVP 中，Spec Battle 的需求类问题优先写入 `requirement_gaps`；普通问题可写入 `findings`。

### 10.3 Requirement Gap Schema

```ts
interface RequirementGap {
  id: string;
  changeId: string;
  roundId: string;
  firstSeenRoundId: string;
  lastEvaluatedRoundId: string;
  resolvedByRoundId: string | null;
  sourcePhase: "Spec";
  sourceUnit: "REQUIREMENT_CRITIC" | "HUMAN_COMMANDER";
  severity: "P0" | "P1" | "P2";
  originalSeverity: "P0" | "P1" | "P2";
  title: string;
  evidence: string;
  affectedArtifacts: string[];
  proposedSpecPatch: string | null;
  status:
    | "open"
    | "resolved"
    | "waived"
    | "downgraded"
    | "overridden";
  waiverReason: string | null;
  overrideReason: string | null;
  downgradedTo: "P1" | "P2" | null;
  downgradeReason: string | null;
  resolutionEvidence: string | null;
  mergeBlocking: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
```

### 10.3.1 Red Fix Claim Schema

我方代理每轮必须对当前 open P0/P1 输出修复声明。该声明不直接关闭 gap，只作为反方复核和战报展示的输入。

```ts
interface RedFixClaim {
  id: string;
  changeId: string;
  roundId: string;
  gapId: string;
  canonicalGapId: string;
  action: "fixed" | "partially_fixed" | "not_fixed" | "needs_human_decision";
  specPatch: string | null;
  evidence: string;
  createdAt: string;
}
```

### 10.3.2 Blue Gap Review Schema

反方每轮必须对我方声明修复的旧 P0/P1 输出复核结果。只有 `resolved` verdict 可以关闭 Requirement Gap。

```ts
interface BlueGapReview {
  id: string;
  changeId: string;
  roundId: string;
  gapId: string;
  canonicalGapId: string;
  verdict: "resolved" | "still_open" | "downgraded" | "needs_human_decision";
  severity: "P0" | "P1" | "P2";
  evidence: string;
  resolutionEvidence: string | null;
  downgradedTo: "P1" | "P2" | null;
  createdAt: string;
}
```

### 10.4 Battle Round Schema

```ts
interface BattleRound {
  id: string;
  changeId: string;
  phase: "Spec";
  template: "SPEC_BATTLE_MVP";
  roundNo: number;
  status:
    | "not_started"
    | "red_running"
    | "red_done"
    | "blue_running"
    | "blue_done"
    | "report_ready"
    | "superseded"
    | "closed"
    | "failed";
  humanExtended: boolean;
  extensionReason: string | null;
  redUnit: "SPEC_WRITER";
  blueUnit: "REQUIREMENT_CRITIC";
  inputArtifacts: string[];
  outputArtifacts: string[];
  findingIds: string[];
  requirementGapIds: string[];
  reportPath: string | null;
  startedAt: string;
  endedAt: string | null;
}
```

### 10.5 Human Decision Schema

```ts
interface HumanDecision {
  id: string;
  changeId: string;
  gate: "prd" | "spec" | "plan" | "test_plan" | "build" | "review" | "qa" | "merge";
  action:
    | "approve"
    | "request_changes"
    | "return_to_spec"
    | "waive_p1"
    | "refresh_report"
    | "stop_battle";
  targetType: "gate" | "requirement_gap" | "finding";
  targetId: string | null;
  reason: string | null;
  createdBy: "human";
  createdAt: string;
}
```

MVP 不提供 `p0_override` 按钮，也不得通过 API、UI 或验收场景产生 P0 `overridden`。`overridden` 仅作为未来迁移和扩展枚举保留；若遗留数据中出现，MVP 必须在高级详情中标记为非 MVP 状态，并保守阻断 Spec / Merge。

### 10.6 War Report Schema

```ts
interface WarReport {
  id: string;
  changeId: string;
  phase: "PRD" | "Spec" | "Plan" | "TestPlan" | "Build" | "Review" | "QA" | "Merge" | "Change";
  roundId: string | null;
  type: "phase_report" | "change_report";
  status: "generated" | "stale" | "approved";
  path: string;
  sourceHashes: Record<string, string>;
  blockingP0: number;
  blockingP1: number;
  nonBlockingP2: number;
  openRequirementGaps: number;
  generatedBy: "BATTLE_REPORTER";
  aiPolished: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 10.7 Plan 作战沙盘 Schema（待审批扩展）

Plan 作战沙盘必须以 DB 中的 approved Plan snapshot 作为唯一计划权威。`plan.json` / `plan.md` 只作为从 DB 渲染出的镜像产物，用于 AI 上下文和人工阅读；Build 不得读取 `plan.json` 来决定施工范围、gate 或 action。

```ts
interface PlanSandbox {
  id: string;
  changeId: string;
  template: "PLAN_SANDBOX_MVP";
  status:
    | "not_started"
    | "planning"
    | "plan_ready"
    | "critic_running"
    | "critic_done"
    | "report_ready"
    | "approved"
    | "changes_requested"
    | "blocked"
    | "failed";
  planRunId: string | null;
  planArtifactId: string | null;
  planMarkdownArtifactId: string | null;
  critiqueArtifactId: string | null;
  reportArtifactId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Plan DB snapshot 在 v3.6 起拆分预计施工范围和硬禁区。`expectedFiles` 是 Build 的预计施工范围；`allowedFiles` 仅作为 legacy import 的只读兼容输入，导入后必须映射到 DB `expectedFiles`。新后端不得把 `allowedFiles` 或 `plan.json` 当作 Build 权威。

```ts
interface PlanSnapshot {
  expectedFiles?: string[];
  allowedFiles?: string[]; // legacy alias for expectedFiles
  forbiddenFiles: string[];
  implementationSteps: Array<{
    step: number;
    file: string;
    description: string;
  }>;
  testPlan: string[];
  validationCommands: string[];
  risks: string[];
}
```

反方输出结构化 Plan Risk：

```ts
interface PlanRisk {
  id: string;
  changeId: string;
  planSandboxId: string;
  severity: "P0" | "P1" | "P2";
  category:
    | "scope"
    | "ordering"
    | "granularity"
    | "missing_test"
    | "migration"
    | "security"
    | "dependency"
    | "rollback"
    | "unknown";
  title: string;
  evidence: string;
  requiredPlanChange: string | null;
  affectedStepNumbers: number[];
  status: "open" | "resolved" | "waived";
  waiverReason: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Plan Gate 由确定性规则计算：

```ts
interface PlanGate {
  changeId: string;
  canApprove: boolean;
  blockingP0: number;
  blockingP1: number;
  nonBlockingP2: number;
  missingFields: string[];
  stale: boolean;
}
```

Plan Gate 允许批准的条件：

1. DB 中存在 latest Plan snapshot 和对应 Plan Gate source hash。
2. `implementationSteps` 非空，并且 step 编号连续。
3. 每个 step 的 `file` 都被 DB `expectedFiles` 覆盖。
4. DB `expectedFiles` 与 `forbiddenFiles` 不冲突。
5. `validationCommands` 非空。
6. 不存在 open P0 Plan Risk。
7. open P1 Plan Risk 要么已 resolved，要么由人类填写 reason 后 waived。
8. Plan Report metadata 与 latest Plan snapshot hash 一致。

不得批准的情况：

- 计划缺少 expectedFiles、implementationSteps 或 validationCommands。
- 反方指出 P0 scope / ordering / migration 风险仍 open。
- DB Plan snapshot 修改后未重新生成 Plan Report metadata。
- 用户尝试批准会修改 forbiddenFiles 的计划。

Plan 作战沙盘镜像产物：

```text
.ship/changes/<changeId>/plan.json
.ship/changes/<changeId>/plan.md
.ship/changes/<changeId>/plan-critique.json
.ship/changes/<changeId>/reports/plan-report.md
```

这些路径只镜像 DB Plan snapshot、Plan Risk 和 Plan Gate 结算，不得作为状态、gate、action、preflight、freshness 或 Build scope 的读取源。Build 只能读取 DB 中 approved Plan snapshot；`plan-report.md` 只解释为什么能批或不能批，不替代 gate 判断。Build 实际 diff 是否可收编由 DB Build Gate、Build Audit 和人类审批共同决定。

### 10.8 Build 施工沙盘 Schema（v3.6 待审批扩展）

```ts
interface GitBaseCamp {
  changeId: string;
  repoRoot: string;
  isGitRepo: boolean;
  baseCommit: string | null;
  currentBranch: string | null;
  dirtyFiles: string[];
  status:
    | "ready"
    | "blocked_no_git"
    | "blocked_no_head"
    | "blocked_dirty_main"
    | "blocked_worktree_unavailable";
}

interface BuildWorkspace {
  id: string;
  changeId: string;
  strategy: "git_worktree";
  path: string;
  branchName: string;
  baseCommit: string;
  createdAt: string;
  status: "creating" | "ready" | "dirty" | "archived" | "failed";
}

interface BuildRun {
  id: string;
  changeId: string;
  workspaceId: string;
  sourcePlanSnapshotId: string;
  sourcePlanHash: string;
  baseCommit: string;
  status:
    | "not_started"
    | "preparing_workspace"
    | "running"
    | "validating"
    | "diff_ready"
    | "gate_blocked"
    | "audit_running"
    | "awaiting_human"
    | "approved_for_absorb"
    | "adopted"
    | "rejected"
    | "failed";
  expectedFiles: string[];
  forbiddenFiles: string[];
  changedFiles: string[];
  changedFilesHash: string;
  deviations: BuildDeviation[];
  gateResultId: string | null;
  validationResultIds: string[];
  auditFindingIds: string[];
  adoptionDecisionId: string | null;
  patchPath: string | null;
  patchSha256: string | null;
  adoptedHeadSha: string | null;
  reportPath: string | null;
  auditPath: string | null;
}

interface BuildDeviation {
  file: string;
  reason: "outside_expected_files" | "new_dependency" | "migration" | "lockfile" | "generated_file" | "unknown";
  severityHint: "P1" | "P2";
}

interface BuildAuditFinding {
  id: string;
  changeId: string;
  buildRunId: string;
  severity: "P0" | "P1" | "P2";
  category:
    | "forbidden_file"
    | "scope_deviation"
    | "requirement_miss"
    | "test_failure"
    | "missing_test"
    | "security"
    | "migration"
    | "dependency"
    | "merge_risk"
    | "quality";
  file: string | null;
  evidence: string;
  requiredAction: string | null;
  status: "open" | "waived" | "resolved";
}
```

Build DB 权威模型必须至少包含：

| DB 边界 | 权威职责 |
|---|---|
| `build_runs` | Build run 状态、source Plan snapshot、base commit、changed files hash、adopted head |
| `build_gate_results` | forbiddenFiles、policy、路径逃逸、base commit、HEAD freshness 等确定性硬裁决 |
| `build_validation_results` | Build / lint / test / typecheck 等命令结果和证据 |
| `build_audit_findings` | 反方 Build Audit 的 P0/P1/P2 风险 |
| `build_adoption_decisions` | 人类批准收编、拒绝收编、要求返工的裁决 |
| `build_artifact_mirrors` | patch、diff、report、audit Markdown / JSON 的镜像 metadata、hash、status |

`patchPath`、`reportPath`、`auditPath` 只定位镜像文件，不得作为 Build adopted、Build gate 或 Review preflight 的权威依据。Review 前置只能读取 DB `build_runs.status = adopted`、`adoptedHeadSha`、source hash 和当前仓库 HEAD。

Build 镜像产物：

```text
.ship/changes/<changeId>/build/build-run-<n>.json
.ship/changes/<changeId>/build/build.diff
.ship/changes/<changeId>/build/build.patch
.ship/changes/<changeId>/build/build-audit.json
.ship/changes/<changeId>/reports/build-report.md
```

## 十一、Requirement Gap 关闭规则

### 11.1 阻断判定

```ts
function isRequirementGapBlocking(gap: RequirementGap): boolean {
  if (gap.status === "resolved") return false;
  if (gap.severity === "P2") return false;
  if (gap.severity === "P1" && gap.status === "waived") return false;
  if (gap.severity === "P1" && gap.status === "downgraded" && gap.downgradedTo === "P2") return false;
  return true;
}
```

### 11.2 P0

| 状态 | 是否关闭 | 是否阻断 Spec Gate | 是否阻断 Merge |
|---|---:|---:|---:|
| `open` | 否 | 是 | 是 |
| `resolved` | 是 | 否 | 否 |
| `overridden` | 未来扩展；MVP 不产生 | 是 | 是 |
| `downgraded` 到 P1 | 否 | 按 P1 规则 | 按 P1 规则 |
| `downgraded` 到 P2 | MVP 不允许 | 是 | 是 |

MVP 不暴露 P0 override UI，也不允许 P0 override 让 Spec Gate 放行。若数据中出现 P0 `overridden`，按阻断处理，并在战报高级详情中显示高风险和非 MVP 状态。

### 11.3 P1

| 状态 | 是否关闭 | 是否阻断 Spec Gate | 是否阻断 Merge |
|---|---:|---:|---:|
| `open` | 否 | 是 | 是 |
| `resolved` | 是 | 否 | 否 |
| `waived` | 是 | 否 | 否 |
| `downgraded` 到 P2 | 是 | 否 | 否 |

P1 waiver 必须有人类 reason。

### 11.4 P2

| 状态 | 是否关闭 | 是否阻断 Spec Gate | 是否阻断 Merge |
|---|---:|---:|---:|
| `open` | 否 | 否 | 否 |
| `resolved` | 是 | 否 | 否 |
| `waived` | 是 | 否 | 否 |

P2 进入 `reports/spec-report.md` 和 `reports/war-report.md`，后续可在 Retro 中进入 backlog。

### 11.5 跨轮消账关闭规则

Requirement Gap 的关闭必须由结构化复核驱动，不允许通过“反方本轮没有再次提到”来隐式关闭。

| 输入 | 系统动作 |
|---|---|
| 我方代理没有为 open P0/P1 给出 `RedFixClaim` | gap 保持 open，战报标记为 `not_rechecked_by_red` |
| 我方声明 `fixed`，反方 verdict 为 `resolved` | gap 变为 `resolved`，写入 `resolvedByRoundId`、`resolutionEvidence`、`closedAt` |
| 我方声明 `fixed`，反方 verdict 为 `still_open` | gap 保持 open，更新 `lastEvaluatedRoundId` 和 evidence |
| 我方声明 `partially_fixed` | gap 默认保持 open，除非反方明确 `downgraded` 或 `resolved` |
| 反方没有复核旧 open P0/P1 | gap 保持 open，战报标记为 `not_rechecked_by_blue` |
| 反方新增与旧 gap 同义但不同 ID 的问题 | 系统应合并到旧 `canonicalGapId` 或拒绝为重复 gap |
| 反方 verdict 为 `downgraded` | 写入 `downgradedTo`、`downgradeReason`，并重新计算阻断 |

只有 `resolved`、合法 `waived`、合法 `downgraded to P2` 可以让 P1 不再阻断 Spec Gate。P0 只能通过 `resolved` 解除阻断。

## 十二、状态机转移矩阵

MVP 不新增大量 `ChangeStatus`。change 主状态继续使用现有 `SPECCING` / `SPEC_READY` 等状态；Spec Battle 的细粒度状态由 `battle_rounds.status`、gate status、gap status 表达。

### 12.1 Round / Gate Matrix

| Phase | Round Status | Gate Status | Finding / Gap Status | Allowed Event | Next State | Illegal Transition |
|---|---|---|---|---|---|---|
| Spec | `not_started` | none | none | `start_spec_battle` | `red_running` | approve、waive、generate_report |
| Spec | `red_running` | none | open P0/P1 注入我方代理上下文 | `red_complete` with `RedFixClaim[]` | `red_done` | approve、blue_complete、request_changes、skip open P0/P1 claims |
| Spec | `red_done` | none | none | `start_blue_critique` | `blue_running` | approve、generate_report |
| Spec | `blue_running` | none | pending old-gap review + new gaps | `blue_complete` with `BlueGapReview[]` + new gaps | `blue_done` | approve、waive、red_complete、skip old P0/P1 review |
| Spec | `blue_done` | none | any | `generate_spec_report` | `report_ready` | approve before report |
| Spec | `report_ready` | `pending` | no blocking P0/P1 | `approve` | round `closed`, change remains/enters `SPEC_READY` approved | request_changes without open target |
| Spec | `report_ready` | `blocked` | open P0 | `return_to_spec` / continue round | current round `superseded`, new round `red_running` | approve、waive_p1 |
| Spec | `report_ready` | `blocked` | open P0 且人类终止 | `stop_battle` | change `BLOCKED`，round 保留 | approve、waive_p1 |
| Spec | `report_ready` | `blocked` | open P1 | `waive_p1` | gap `waived`, report stale, gate recompute | approve before fresh report |
| Spec | `report_ready` | `blocked` | open P1 | `request_changes` / continue round | current round `superseded`, new round `red_running` | direct approve |
| Spec | `report_ready` | `pending` | only P2 open | `approve` | round `closed`, gate approved | return_to_spec required=false |
| Spec | `report_ready` | `approved` | no blocking P0/P1 | `continue_pipeline` | next existing pipeline phase | mutate closed round |
| Spec | any | any | stale report | `generate_spec_report` | `report_ready` | approve stale report |
| Spec | `failed` | `blocked` | 我方代理、反方或战报官失败 | retry / continue round / stop battle | 失败战报保持可见，新 round 或 `BLOCKED` | treat missing blue JSON as no gap |

### 12.2 Gate Status

```ts
type GateStatus =
  | "none"
  | "pending"
  | "blocked"
  | "approved"
  | "changes_requested";
```

Gate status 由系统计算，不信任前端传入值：

- `pending`: report exists and awaits human decision.
- `blocked`: open blocking P0/P1 exists.
- `approved`: human approved latest non-stale report.
- `changes_requested`: human requested changes or returned to Spec.

### 12.3 Illegal Transition Rules

1. Cannot approve without latest DB Spec report metadata.
2. Cannot approve if report is stale.
3. Cannot approve with open P0 Requirement Gap.
4. Cannot approve with open P1 Requirement Gap unless waived or resolved.
5. Cannot waive P0 in MVP.
6. Cannot waive P2 as a gate requirement; P2 is non-blocking.
7. Cannot start a new Spec round while one is `red_running` or `blue_running`.
8. Cannot mutate a `closed` round.
9. Cannot continue pipeline if Spec gate is not `approved`.
10. Cannot allow Merge if any blocking Requirement Gap remains.
11. Cannot close a Requirement Gap only because it disappeared from blue output.
12. Cannot let blue create new gaps before it reviews all old open P0/P1 gaps included in the round.

### 12.4 Plan 作战沙盘状态矩阵（待审批扩展）

Plan 阶段继续复用现有 `DRAFT` / `PLANNING` / `PLAN_READY` / `PLAN_APPROVED` 主状态；沙盘内部状态由 `PlanSandbox.status`、Plan Risk 和 Plan Gate 表达。

| Phase | Plan Status | Gate Status | Risk Status | Allowed Event | Next State | Illegal Transition |
|---|---|---|---|---|---|---|
| Plan | `not_started` | none | none | `start_plan_sandbox` | `planning` | approve、implement |
| Plan | `planning` | none | none | `planner_complete` with valid DB Plan snapshot | `plan_ready` | approve before plan exists |
| Plan | `plan_ready` | none | none | `start_plan_critic` | `critic_running` | approve before critic |
| Plan | `critic_running` | none | pending risks | `critic_complete` with Plan Risk list | `critic_done` | approve、implement |
| Plan | `critic_done` | pending / blocked | any | `generate_plan_report` | `report_ready` | approve before report |
| Plan | `report_ready` | blocked | open P0 | `request_replan` / `split_task` / `stop` | `changes_requested` or `blocked` | approve、waive_p1 |
| Plan | `report_ready` | blocked | open P1 | `waive_p1_plan_risk` or `request_replan` | report stale or `changes_requested` | direct approve old report |
| Plan | `report_ready` | pending | no open P0/P1 | `approve_plan` | `approved` / `PLAN_APPROVED` | mutate approved plan |
| Plan | any | any | stale report | `generate_plan_report` | `report_ready` | approve stale report |
| Plan | `failed` | blocked | unknown | retry / stop | `planning` or `blocked` | treat critic failure as no risk |

Plan 阶段的非法转移规则：

1. Cannot approve Plan without a DB Plan snapshot.
2. Cannot approve Plan without DB Plan Gate metadata.
3. Cannot approve Plan before Plan Critic has run, unless user explicitly chooses emergency bypass in a future non-MVP mode.
4. Cannot approve Plan with open P0 Plan Risk.
5. Cannot approve stale Plan Report.
6. Cannot approve if any implementation step file is outside DB `expectedFiles`.
7. Cannot approve if DB `expectedFiles` overlaps `forbiddenFiles`.
8. Cannot start Build unless Plan is `PLAN_APPROVED`.
9. Cannot absorb Build output without Build Gate, Build Audit, and human approval.
10. Cannot treat Plan Critic failure as approval.

### 12.5 Build 施工沙盘状态矩阵（v3.6 待审批扩展）

Build 是现有 Implement 阶段的产品层名称，v3.6 默认不新增顶层 pipeline phase。主状态可以继续复用 `PLAN_APPROVED` / `IMPLEMENTING` / `IMPLEMENTED`；Build 内部细粒度状态由 `BuildWorkspace.status` 与 `BuildRun.status` 表达。进入 Review 前必须满足 `BuildRun.status = "adopted"`，且当前主仓 `HEAD` 必须等于收编时记录的 `adoptedHeadSha`，不能只依赖 `ChangeStatus = "IMPLEMENTED"`。

| Phase | BuildRun Status | Gate / Audit | Allowed Event | Next State | Illegal Transition |
|---|---|---|---|---|---|
| Build | `not_started` | Git Base Camp unknown | `check_git_base_camp` | `preparing_workspace` or blocked | run in main workspace |
| Build | `preparing_workspace` | Git Base Camp ready | `create_worktree` | workspace `ready` | create without valid `baseCommit` |
| Build | `running` | none | `build_runner_complete` | `validating` | review、absorb |
| Build | `validating` | validation running | `validation_complete` | `diff_ready` | absorb before diff |
| Build | `diff_ready` | deterministic Build Gate | `run_build_gate` | `gate_blocked` or `audit_running` | treat gate failure as audit pass |
| Build | `audit_running` | AI 反方审计 | `audit_complete` | `awaiting_human` | absorb before audit |
| Build | `awaiting_human` | no open P0 | `approve_absorb` | `approved_for_absorb` | approve with stale report |
| Build | `awaiting_human` | open P0 | `request_rebuild` / `return_to_plan` / `reject_build` | new run or rejected | approve_absorb |
| Build | `approved_for_absorb` | baseCommit still current | `apply_patch` | `adopted` | apply when main dirty or HEAD drifted |
| Build | `approved_for_absorb` | conflict / HEAD drift | `block_absorb` | `awaiting_human` | silently merge conflict |
| Build | `adopted` | absorbed and HEAD matches `adoptedHeadSha` | `continue_to_review` | Review | mutate adopted run or commit drift after adoption |

Build 阶段的非法转移规则：

1. Cannot start Build without Git Base Camp ready.
2. Cannot run Build in main repo workspace.
3. Cannot approve absorb without patch / diff.
4. Cannot approve absorb before deterministic Build Gate completes.
5. Cannot approve absorb before Build Audit completes.
6. Cannot approve absorb with open P0 Build Audit Finding.
7. Cannot approve stale build report.
8. Cannot absorb changes touching `forbiddenFiles`, policy blocked globs, path escape, `.git`, secrets, or workspace external paths.
9. Cannot absorb when main workspace is dirty.
10. Cannot absorb when main `HEAD !== baseCommit`.
11. Cannot enter Review if main workspace `HEAD` drifted after Build adoption.
12. Cannot treat Build Runner failure or Build Audit failure as approval.
13. `expectedFiles` deviation is not automatic failure, but must be audited and shown before absorb.

### 12.6 Review 战报中心状态矩阵（v3.7 待审批扩展）

Review 是 Build 与 QA 之间的产品 gate。MVP 可以暂时兼容现有 `IMPLEMENTED` / `REVIEWING` / `CHECK_FAILED` 底层状态，但产品 UI 与 gate 必须使用 Review Center 聚合服务派生的 gate，不得把 Review finding 显示成 QA 失败。

```ts
type ReviewCenterGate =
  | "not_started"
  | "running"
  | "passed"
  | "blocked_p0"
  | "blocked_p1"
  | "failed"
  | "invalid_output"
  | "data_inconsistent"
  | "stale";
```

| Phase | ReviewCenterGate | Condition | Allowed Event | Next State | Illegal Transition |
|---|---|---|---|---|---|
| Review | `not_started` | latest BuildRun adopted and fresh | `run_review` | `running` | enter QA without Review |
| Review | `running` | Review run active | `review_complete` | `passed` / `blocked_p0` / `blocked_p1` / `failed` / `invalid_output` / `data_inconsistent` | start second Review run |
| Review | `failed` | provider failure or execution failure | `retry_review` / `stop_change` | `running` or blocked by latest valid review | treat failure as no findings |
| Review | `invalid_output` | AI output illegal or missing required fields | `retry_review` / `stop_change` / view raw output | `running` or blocked by latest valid review | treat invalid output as failed or no findings |
| Review | `data_inconsistent` | DB findings and mirrored artifacts disagree | `recompute_report` / `retry_review` / `stop_change` | `running` or blocked by latest valid review | use mirrored artifacts as source of truth |
| Review | `blocked_p0` | open P0 exists | `fix_blockers` / `retry_review` / `stop_change` | Build/Fix path or `running` | waive P0、enter QA |
| Review | `blocked_p1` | open P1 exists, no accepted reason | `waive_p1_with_reason` / `fix_blockers` / `retry_review` | `stale` or Build/Fix path | enter QA on old report |
| Review | `stale` | latest valid review does not match latest adopted Build run, or P1 waiver changed report facts | `recompute_report` / `retry_review` | `passed` / `blocked_p0` / `blocked_p1` / `failed` / `invalid_output` / `data_inconsistent` | enter QA |
| Review | `passed` | fresh report, no open P0/P1, latest Build source | `enter_qa` | QA | mutate report without stale |

Review 战报中心非法转移规则：

1. Cannot enter QA without a latest valid Review run.
2. Cannot enter QA with stale Review report.
3. Cannot enter QA when `sourceBuildRunId` is not the latest adopted Build run.
4. Cannot waive P0.
5. Cannot enter QA with open P0.
6. Cannot enter QA with open P1 unless every P1 has human reason and the Review report is recomputed fresh.
7. Cannot treat P2 as blocking.
8. Cannot treat provider failure, invalid JSON, missing required fix, missing evidence, or report / DB mismatch as approval.
9. Cannot close previous open P0/P1 Review finding unless the latest Review explicitly rechecks it.
10. Cannot show Review finding as QA failure in the product UI.
11. Cannot use AI natural language summary as the gate source of truth; gate must derive from structured DB findings, Review run metadata, latest valid review and `sourceBuildRunId` freshness.
12. Cannot let latest failed / invalid_output / data_inconsistent attempt overwrite `latestValidReview`.
13. Cannot use `.ship` mirrored files as the source of truth for Review/Fix/Waive/Merge/QA gate.

v3.8 数据库化补充规则：

1. 所有进入 QA 的入口必须调用同一个 Review QA Gate service；UI 禁用状态不能作为唯一防线。
2. Review QA Gate service 只能读取 DB Review runs、DB Review reports、DB findings、human decisions / waivers、latest adopted BuildRun 和当前 HEAD。
3. Review fresh 必须同时校验 `sourceBuildRunId`、`buildHeadSha`、latest adopted BuildRun、当前 HEAD，以及可选 patch hash / changed files hash。
4. `.ship` Review 镜像缺失、落后或损坏时，不得用镜像覆盖 DB；只能重建镜像、重新 Review 或终止 Change。
5. `recompute_report` 只能重算 DB Review report 和 allowed actions；不得改变 finding 状态、waiver 状态或 run 结果。
6. `rebuild_review_mirror` 只能从 DB 生成 JSON / Markdown / artifacts 索引；不得改变 gate、finding、waiver 或 run。
7. 自 Review DB schema 启用后，新 Review run 禁止产生 JSON-only 状态。
8. 历史 JSON-only Review 数据只能通过幂等迁移导入 DB，或显示为 `legacy_incomplete`；不得直接参与 latestValidReview、QA 或 Merge。
9. 同一 change 同一时间只能有一个 running Review；重复点击 `run_review` 必须复用 idempotency key 或返回当前 running run。

## 十三、人类裁决合法动作矩阵

MVP 主界面只保留四个产品动作；后台动作可以更细，但必须映射到这四个主动作或折叠到高级详情：

```ts
type HumanAction =
  | "approve"
  | "request_changes"
  | "return_to_spec"
  | "waive_p1"
  | "refresh_report"
  | "stop_battle";
```

| Phase / Gate | Severity | Target Status | 通过 | 继续对抗一轮 | 接受风险并通过 | 终止 Battle |
|---|---|---|---:|---:|---:|---:|
| Spec Gate | none | no open gap | yes | no | no | yes |
| Spec Gate | P0 | open | no | yes | no | yes |
| Spec Gate | P0 | resolved | yes if no other blockers | no | no | yes |
| Spec Gate | P1 | open | no | yes | yes if `allowP1Waiver=true` | yes |
| Spec Gate | P1 | waived | yes if no other blockers | no | no | yes |
| Spec Gate | P1 | resolved | yes if no other blockers | no | no | yes |
| Spec Gate | P1 | downgraded to P2 | yes if no other blockers | yes optional | no | yes |
| Spec Gate | P2 | open | yes | yes optional | no | yes |
| Merge Gate | P0 | open | no | yes | no | yes |
| Merge Gate | P1 | open | no | yes | yes if `allowP1Waiver=true` | yes |
| Merge Gate | P1 | waived / resolved | yes if other merge checks pass | no | no | yes |
| Merge Gate | P2 | open | yes if other merge checks pass | yes optional | no | yes |

MVP UI 必须隐藏非法按钮，API 即使被直接调用也必须拒绝非法动作。当 `allowP1Waiver=false` 且存在 open P1 时，“接受风险并通过”不可用，但“继续追加一轮”和“终止 Battle”必须可用。

Plan 作战沙盘待审批扩展的主操作：

| 主按钮 | 显示条件 | 后台动作 |
|---|---|---|
| 批准作战计划 | 无 open P0/P1 Plan Risk，且 Plan Report fresh | `approve_plan` |
| 要求重排 | 存在 P0/P1 风险，或用户不认可任务顺序 | regenerate / revise plan |
| 拆小任务 | 反方指出 step 粒度过粗，或用户认为任务不可执行 | revise selected step |
| 接受 P1 风险并批准 | 无 P0，存在 open P1 且用户填写 reason | `waive_p1_plan_risk` + regenerate report + `approve_plan` |
| 终止 | 用户决定本 change 不进入 Build | block / reject |

Plan 主界面不得出现 `approve_plan`、`waive_p1_plan_risk` 等后台词；这些只能出现在高级详情或审计记录中。

Build 施工沙盘待审批扩展的主操作：

| 主按钮 | 显示条件 | 后台动作 |
|---|---|---|
| 建立 Git Base Camp | 项目未完成 Git 初始化或无有效 baseline | git setup guidance / initial commit guidance |
| 建立施工区 | Git Base Camp ready，且没有 ready workspace | create git worktree |
| 开始施工 | workspace ready，且无 running BuildRun | run Build Runner |
| 生成战报 | Build Runner 完成，diff 尚未结算 | collect diff / patch / validation |
| 反方审计 | deterministic Build Gate 未阻断，且 Audit 未运行 | run Build Audit |
| 批准收编 | Build Audit 完成，无 open P0，主仓 clean 且 HEAD 未漂移 | apply patch / mark adopted |
| 要求返工 | 用户不认可 diff 或 P0/P1 需要修复 | create new BuildRun |
| 回到 Plan | 计划范围或步骤需要重排 | return to Plan sandbox |
| 放弃 Build | 用户决定本次施工不继续 | reject BuildRun / optionally remove worktree |

Build 主界面不得出现 `IMPLEMENTING`、`IMPLEMENTED`、`approve_absorb`、`apply_patch` 等后台词；这些只能出现在高级详情或审计记录中。

Review 战报中心待审批扩展的主操作：

| 主按钮 | 出现条件 | 后台动作 |
|---|---|---|
| 开始反方审查 | Build 已收编、无 running Review | run Review |
| 重新审查 | Review failed、stale，或用户修复后需要复核 | run Review / retry Review |
| 修复阻断项 | 存在 open P0/P1 | create fix/rework path |
| 接受 P1 风险 | 无 P0，存在 open P1，且用户填写 reason | waive P1 + mark report stale + recompute report |
| 进入 QA | Review fresh、无 open P0/P1，或所有 P1 已豁免且 fresh | run QA |
| 终止 Change | 用户决定不继续处理 Review 风险 | block / reject |

Review 主界面不得出现 `CHECK_FAILED`、`REVIEWING`、`waive_p1`、`runReview`、`review-findings.json` 等后台词；这些只能出现在高级详情或审计记录中。

## 十四、War Report

### 14.1 路径规范

阶段级 report 镜像：

```
.ship/changes/<changeId>/reports/spec-report.md
```

change 总战报镜像：

```
.ship/changes/<changeId>/reports/war-report.md
```

round 级原始数据镜像：

```
.ship/changes/<changeId>/rounds/spec-round-01.json
.ship/changes/<changeId>/rounds/spec-round-01-red.md
.ship/changes/<changeId>/rounds/spec-round-01-blue.json
```

Plan 作战沙盘待审批扩展新增：

```
.ship/changes/<changeId>/plan-critique.json
.ship/changes/<changeId>/reports/plan-report.md
```

### 14.2 聚合规则

`BATTLE_REPORTER` 优先是 deterministic service。

输入：

- `battle_rounds`
- `findings`
- `requirement_gaps`
- `red_fix_claims`
- `blue_gap_reviews`
- `human_decisions`
- `artifacts`
- `prd-delta.md`
- `.ship/baseline/prd.md`

输出：

- blocking counts。
- gap 状态表。
- gap 消账结果。
- 人类裁决表。
- 可继续 / 不可继续结论。
- report markdown。

AI 只允许对以下区域做润色：

```md
## 摘要
```

AI 不允许决定：

- 是否阻断。
- P0/P1/P2 counts。
- gap 是否关闭。
- gate 是否可 approve。
- Merge 是否可继续。

### 14.3 `spec-report.md` 必含章节

```md
# Spec Battle Report

## Gate Verdict
- Status:
- Blocking P0:
- Blocking P1:
- Non-blocking P2:
- 可通过:

## Red Output
- Artifact:
- Summary:
- Changes Since Previous Round:

## Blue Findings
| ID | Severity | Status | Title | Blocking |

## Requirement Gaps
| ID | Severity | Status | Merge Blocking | Title |

## Round Delta
- New Gaps:
- Resolved Since Last Round:
- Still Blocking:
- Not Rechecked:
- Failed Unit:
- Recovery Options:

## Gap Ledger
| ID | Previous Status | Red Claim | Blue Verdict | Current Status | Evidence |

## Human Decisions
| Time | Action | Target | Reason |

## Required Next Action
- 继续对抗一轮 / 刷新战报 / 接受风险并通过 / 终止 Battle
```

### 14.4 `war-report.md` 聚合

MVP 中 DB War Report metadata 只聚合 Spec Battle；`war-report.md` 是从 DB 渲染出的人工阅读镜像：

- change 基本信息。
- latest DB Spec report verdict。
- 所有 Requirement Gap 当前状态。
- 所有人类裁决。
- 是否允许进入后续 pipeline。
- 是否存在未来 Merge blocker。

后续多阶段实现后，DB War Report metadata 再聚合 TechSpec/TestPlan/Review/QA 等阶段报告，并渲染 `war-report.md` 镜像。

Plan 作战沙盘审批后，DB War Report metadata 应同时聚合：

- latest DB Plan report verdict。
- Plan Risk 当前状态。
- approved `expectedFiles` / legacy `allowedFiles` / `forbiddenFiles` 摘要。
- validationCommands 摘要。
- 是否允许进入 Build。

Build 施工沙盘收编后，DB War Report metadata 应同时聚合：

- latest DB Build report verdict。
- Git Base Camp 状态和 `baseCommit`。
- Build workspace / branch 摘要。
- changed files 与 `BuildDeviation` 摘要。
- Build Gate 硬阻断结果。
- Build Audit P0/P1/P2 当前状态。
- 人类是否批准收编。
- 是否允许进入 Review / Check。

## 十五、业务规则

1. MVP 只实现 PRD Briefing Room 和 Spec Battle。
2. Unit 和 Template 只能是系统内置 enum。
3. 用户不能编辑 prompt、阶段、边、单位。
4. Spec Battle 默认最多 3 轮，用户可配置 1-5 轮。
5. P0/P1 Requirement Gap 默认阻断 Spec Gate。
6. P1 可 waiver，必须记录 reason。
7. P0 override 不在 MVP UI 暴露，也不允许作为 MVP 放行路径。
8. P2 不阻断，但必须进入 report。
9. Gate 判断必须使用结构化 DB 状态，不依赖 report 自然语言。
10. Report 由 deterministic service 生成，AI 只润色摘要。
11. Report stale 时不能 approve。
12. Merge 前仍必须检查 blocking Requirement Gap。
13. 我方代理每轮必须读取并逐项认领当前 open P0/P1 Requirement Gap。
14. 反方每轮必须先复核旧 open P0/P1，再允许新增 Requirement Gap。
15. 旧 gap 没有被反方明确 `resolved` 时，系统必须继续按 open 处理。
16. PRD 阶段 open critical 疑点必须阻断 PRD 锁定。
17. PRD 阶段 AI 假设必须经过人类确认后才能进入 PRD 草案。
18. PRD 阶段 deferred important 疑点必须进入 Spec Battle 上下文。
19. 待审批扩展中，Plan 阶段必须复用现有 `plan.json` / `plan.md` 作为镜像产物；执行计划权威源只能是 DB Plan snapshot。
20. Plan 反方只做一次标准审查；只有人类点击“要求重排”或“拆小任务”时才重新生成计划。
21. Plan P0 风险必须阻断批准。
22. Plan P1 风险可以由人类填写 reason 后接受。
23. Plan Report stale 时不能批准。
24. Build 必须在 Git Base Camp 之后、隔离 worktree 中执行；Build Runner 不得直接修改主仓。
25. Plan 的 `expectedFiles` / legacy `allowedFiles` 只表示预计施工范围，不再硬卡死 Build Runner。
26. Build 实际 diff 若超出 `expectedFiles`，系统必须生成 `BuildDeviation`，进入反方 Audit 和人类审批，不得仅因 deviation 自动失败。
27. `forbiddenFiles`、policy blocked globs、路径逃逸、`.git`、secrets、workspace 外部路径仍为 Build Gate 硬阻断。
28. 收编前必须确认主仓 clean 且 `HEAD === baseCommit`；否则不得 apply patch。
29. Build Audit 失败或 Build Runner 失败不得被当作通过。
30. 进入 Review 前必须满足 `BuildRun.status = "adopted"`，且当前 `HEAD === adoptedHeadSha`，避免收编后又提交计划外代码再绕过 Build Audit。
31. Plan 阶段不得自动开始 Build。

## 十六、页面 / 交互

### 16.1 Spec 页面主界面

Spec 阶段主界面必须从“审批后台”改为“SLG 回合战场”。默认只展示两个区域：

1. **战场**：当前轮次、最大轮次、我方代理出招状态、反方反击状态、本轮结算状态。
2. **本轮战报**：我方本轮改进、反方本轮攻击、P0/P1/P2 计数、gap 消账结果、系统建议。

主界面不得默认展示完整 Requirement Gap 表、artifact 路径、events、phase rail 全量状态、DB 枚举名。它们只能放在折叠的“高级详情”里。

本轮战报必须用用户能理解的语言展示四个消账计数：

| 指标 | 主界面文案 |
|---|---|
| `resolvedThisRound` | 本轮已解决 |
| `stillOpen` | 仍在阻断 |
| `newlyFound` | 新发现 |
| `notRechecked` | 未复核 |

如果 `stillOpen + newlyFound + notRechecked` 持续增加，UI 必须提示“我方代理未完成逐项修复”或“反方未完成旧 gap 复核”，不能只显示一个越来越大的 P1 总数。

### 16.2 主操作按钮

默认只显示四个主按钮：

| 主按钮 | 显示条件 | 后台动作 |
|---|---|---|
| 继续对抗一轮 / 继续追加一轮 | 当前 report 存在未解决问题，且无 running round；达到默认上限后必须填写追加原因 | `request_changes` 或 `return_to_spec` |
| 刷新战报 | report stale，或用户需要重新结算 | regenerate report，不重跑我方代理和反方 |
| 接受风险并通过 | 无 P0；无 P1 时直接通过，有 P1 时逐项收集 reason 后执行受控工作流 | direct approve，或 `waive_p1` + regenerate + `approve fresh report` |
| 终止 Battle | 用户决定该 change 不继续 | block / reject |

后台动作名 `Approve`、`Request Changes`、`Return to Spec`、`Waive P1` 只作为审计和高级详情出现，不作为主按钮文案。

非法动作不显示；API 仍需做硬校验。最终轮如果存在 P1 阻断，UI 必须给出“继续追加一轮”或“接受风险并通过”，不能只剩禁用态。

最终轮如果存在 P0 阻断，UI 必须给出“继续追加一轮”或“终止 Battle”，不得自动把 change 置为 `BLOCKED`。只有用户点击“终止 Battle”并填写 reason 后，change 才进入 `BLOCKED` 或等价停止态。

当我方代理、反方或战报官失败时，主界面仍必须显示“战场”和“本轮战报”。失败战报至少展示失败单位、已有可用产物、当前能否刷新战报、能否继续对抗一轮、能否终止 Battle。失败状态不得把缺失或非法的反方输出当作“无 gap”。

### 16.3 Report 展示

默认展示“本轮战报”摘要，而不是完整 Markdown report。完整 deterministic sections 可在高级详情打开。AI 摘要只能作为辅助文案，不作为 gate 判断依据。

### 16.4 Plan 作战沙盘（待审批扩展）

Plan 页面不应再展示成“生成计划 / 批准计划”的普通后台页。它应该像一张战术地图，但交互仍保持轻量。

第一屏只展示三块：

1. **任务地图**：按固定泳道展示 step 棋子，显示 step 编号、目标文件、动作摘要、依赖提示。
2. **反方拦截**：展示 Plan Risk，按 P0/P1/P2 分组，突出必须重排的问题。
3. **执行许可**：展示 expectedFiles / legacy allowedFiles、forbiddenFiles、validationCommands 的摘要和批准按钮。

任务棋子的最小展示信息：

| 字段 | 文案 |
|---|---|
| `step` | 行动序号 |
| `file` | 目标阵地 |
| `description` | 行动内容 |
| inferred lane | 所属兵种 |
| risk badge | 反方是否拦截 |

Plan 主按钮：

| 按钮 | 产品语义 |
|---|---|
| 批准作战计划 | 计划可信，可以进入 Build |
| 要求重排 | 当前计划有结构性问题，让 AI 重新排兵布阵 |
| 拆小任务 | 某个 step 太大，要求拆成更小任务 |
| 接受 P1 风险并批准 | 人类理解风险，仍决定进入 Build |
| 终止 | 当前 change 不继续 |

默认不展示：

- 原始 JSON 全文。
- DB 状态枚举。
- route 名称。
- agent prompt。
- 完整 events stream。

这些信息只能在“高级详情”中查看。用户第一眼看到的必须是“接下来怎么打”，不是“后台生成了什么字段”。

### 16.5 Build 施工沙盘（v3.6 待审批扩展）

Build 页面不应展示成普通日志流。它应该像一张施工现场战报，但交互保持克制。

第一屏只展示三块：

1. **Git Base Camp**：Git 是否就绪、当前 branch、`baseCommit`、主仓 dirty 阻断原因。
2. **施工进度 / 差异**：worktree 状态、Build Runner 状态、validationCommands、changed files、`BuildDeviation`。
3. **反方 Audit / 收编许可**：Build Gate 结果、反方 P0/P1/P2 findings、人类裁决按钮。

Build 主按钮：

| 按钮 | 产品语义 |
|---|---|
| 建立 Git Base Camp | 完成 Git 初始化、initial commit 或 baseline 检查 |
| 建立施工区 | 创建 change 级 git worktree |
| 开始施工 | 运行 Build Runner |
| 生成战报 | 收集 diff / patch / validation result |
| 反方审计 | 执行一次 Build Audit |
| 批准收编 | 人类批准 patch 进入主仓 |
| 要求返工 | 创建新的 Build run |
| 回到 Plan | 计划范围或步骤需要重排 |
| 放弃 Build | 终止本次施工 |

默认不展示：

- 原始 patch 全文。
- route 名称。
- agent prompt。
- DB 状态枚举。
- worktree 内部路径细节。

这些信息只能在“高级详情”中查看。用户第一眼看到的必须是“施工到哪了、哪里越界、反方拦住了什么、能不能收编”。

### 16.6 Review 战报中心（v3.7 待审批扩展）

Review 页面不应展示成普通日志流，也不应复刻 Spec Battle 的多轮战场。它应该像 Build 之后的一次反方审查结算：反方已经攻击过代码包，用户现在只需要看战报并下命令。

第一屏只展示三块：

1. **关卡状态**：Build 包、Review 结论、QA 许可、P0/P1/P2 计数、战报是否 fresh。
2. **反方战报**：按 P0/P1/P2 分组的 findings；每条必须包含证据、影响、必需修复和当前处置状态。
3. **指挥动作**：开始/重新审查、修复阻断项、接受 P1 风险、进入 QA、终止 Change。

Review 主按钮：

| 按钮 | 产品语义 |
|---|---|
| 开始反方审查 | 让 AI Reviewer 审查最新已收编 Build 包 |
| 重新审查 | 失败、stale 或修复后再次复核 |
| 修复阻断项 | 将 P0/P1 转入可执行修复路径 |
| 接受 P1 风险 | 人类填写 reason，承认风险并请求重新结算 |
| 进入 QA | Review 已通过，可以开始测试验证 |
| 终止 Change | 人类决定当前风险不可接受或不继续 |

默认不展示：

- 原始 run 列表。
- provider 输出全文。
- artifact 绝对路径。
- raw JSON。
- events stream。
- 后台状态枚举。

当最新尝试为 `failed`、`invalid_output` 或 `data_inconsistent` 时，第一屏必须同时展示“最近尝试失败/输出不合格/数据不一致”和“上一轮有效战报”。错误原因留在第一屏，`raw-review-output.json` 或数据不一致详情入口放在高级详情，不把原始输出铺在默认界面。

Review UI 可以保留轻量 RTS 氛围，例如把反方 Reviewer 显示成“正确性审查 / 安全审查 / 范围漂移 / 测试充分性”等攻击来源，但交互必须保持战报中心，不允许变成拖拽编排或多单位自定义。

Review 页面最重要的体验标准：用户第一眼知道“能不能进 QA、为什么不能、现在按哪个按钮”。

## 十七、验收标准：Given / When / Then

### 场景 0A：创建 PRD Briefing

Given 用户创建一个 change
When 用户输入一段作战意图
Then 系统将作战意图写入 DB PRD Briefing state
And `prd-intent.md` 只作为镜像产物从 DB 生成
And 允许触发反方疑点生成

### 场景 0B：生成反方疑点卡

Given 已存在作战意图
When AI 反方完成需求侦察
Then 系统将结构化疑点卡写入 DB
And `briefing-questions.json` 只作为镜像产物从 DB 生成
And 每张疑点卡包含 category、severity、question、whyItMatters、suggestedDefault 和 status

### 场景 0C：处理疑点卡

Given 存在 open 疑点卡
When 用户选择回答、用 AI 假设或暂缓
Then 系统更新疑点卡状态
And 记录用户动作

### 场景 0D：阻断未处理 critical 疑点

Given 存在 open critical 疑点卡
When 用户尝试锁定 PRD
Then 系统拒绝锁定
And 展示阻断原因

### 场景 0E：锁定 PRD 后进入 Spec Battle

Given 不存在 open critical 疑点
And PRD 草案是 fresh
When 用户点击“锁定作战目标，进入 Spec Battle”
Then 系统锁定 PRD 基线
And 进入 Spec Battle

### 场景 1：无阻断 gap，可通过

Given 一个 change 已完成 Spec Battle
And 反方未产生 P0/P1 Requirement Gap
And DB Spec report metadata 是 fresh
When 人类点击“接受风险并通过”或“通过”
Then Spec gate 状态变为 approved
And 系统允许进入现有后续 pipeline
And `human_decisions` 记录 approve
And `war-report.md` 聚合最新 verdict

### 场景 2：存在 P0 gap，不能通过

Given Spec Battle 产生一个 open P0 Requirement Gap
And DB Spec report metadata 显示 blocking P0 = 1
When 人类尝试通过
Then API 返回非法 transition
And gate 不变为 approved
And UI 不展示通过按钮
And “继续对抗一轮”与“终止 Battle”可用

### 场景 3：P0 gap 回流 Spec 后关闭

Given 一个 open P0 Requirement Gap
When 人类点击“继续对抗一轮”
Then 系统创建下一轮 Spec Battle
And 我方代理上下文包含该 P0 gap
When 我方代理修订 `prd-delta.md` 并输出对应 `RedFixClaim`
And 反方输出该 gap 的 `BlueGapReview=resolved`
Then gap 状态变为 resolved
And 新 DB Spec report metadata 显示 blocking P0 = 0

### 场景 3A：旧 P1 未复核时不得消失

Given 一个 open P1 Requirement Gap
When 人类点击“继续对抗一轮”
And 我方代理没有为该 gap 输出 `RedFixClaim`
Or 反方没有为该 gap 输出 `BlueGapReview`
Then gap 必须保持 open
And DB Gap Ledger 标记该 gap 为 `not_rechecked`
And Spec Gate 仍然 blocked

### 场景 3B：反方必须先复核旧 gap 再新增

Given 存在 3 个 open P1 Requirement Gap
When 新一轮反方输出只包含新增 gap，没有覆盖旧 3 个 P1 的 `BlueGapReview`
Then 系统不得把旧 P1 当作 resolved
And 新 DB Spec report metadata 必须显示旧 3 个 P1 为 `Not Rechecked`
And UI 提示“反方未完成旧 gap 复核”

### 场景 4：P1 gap 可接受风险

Given Spec Battle 产生一个 open P1 Requirement Gap
When 人类点击“接受风险并通过”并填写 reason
Then gap 状态变为 waived
And `human_decisions` 记录 waive_p1
And DB Spec report 先被标记 stale，再重新结算为 fresh report
And 系统只对 fresh report 执行 approve

### 场景 5：P2 gap 不阻断

Given Spec Battle 只产生 P2 Requirement Gap
When `BATTLE_REPORTER` 结算 DB Spec report
Then report 显示 Non-blocking P2 数量
And 通过可用
And P2 gap 被写入 `war-report.md`

### 场景 6：report stale 时不能通过

Given DB Spec report 已生成
And 之后 `prd-delta.md` 或 Requirement Gap 状态发生变化
When 人类尝试通过
Then API 拒绝 approve
And 提示 report stale
And 必须重新结算 DB Spec report

### 场景 7：非法按钮 API 也拒绝

Given UI 被绕过直接调用 `waive_p1`
And target gap 是 P0
When API 收到请求
Then 返回 400 或 409
And gap 状态不变
And 记录非法 transition 事件或错误响应

### 场景 8：总战报聚合 Spec 报告

Given 最新 DB Spec report 已生成
When 系统生成 DB War Report metadata 并渲染 `reports/war-report.md` 镜像
Then 总战报镜像包含 Spec verdict、gap 列表、human decisions
And blocking counts 与 DB 状态一致
And AI 摘要不影响 gate verdict

### 场景 9：Merge 前仍检查 Requirement Gap

Given Spec Gate 已通过
And 后续或遗留数据中仍存在 merge-blocking Requirement Gap
When change 到达 Merge Gate
Then Merge Gate 检查到该 gap 仍 mergeBlocking
And Merge 不可 approve
And war report 显示“继续对抗一轮”是 required next action

### 场景 10：最终轮 P0 不自动 BLOCKED

Given 当前 roundNo 已达到 `maxSpecRounds`
And 仍存在 open P0 Requirement Gap
When 本轮战报生成
Then 系统不得自动将 change 置为 `BLOCKED`
And “继续追加一轮”和“终止 Battle”可用
And 只有点击“终止 Battle”并填写 reason 后，change 才进入 `BLOCKED`

### 场景 11A：生成 Plan 作战沙盘

Given Spec Gate 已 approved
When 用户进入 Plan 阶段并点击“排兵布阵”
Then 系统生成 DB Plan snapshot
And `plan.json` 和 `plan.md` 只作为镜像产物从 DB 生成
And DB Plan snapshot 包含 expectedFiles、forbiddenFiles、implementationSteps、validationCommands
And UI 以任务地图展示 implementationSteps

### 场景 11B：反方拦截计划风险

Given 已存在 DB Plan snapshot
When Plan Critic 完成审查
Then 系统将 Plan Risk 写入 DB
And `plan-critique.json` 只作为镜像产物从 DB 生成
And 每个 Plan Risk 包含 severity、category、evidence、requiredPlanChange
And `reports/plan-report.md` 镜像展示可批准或不可批准原因

### 场景 11C：P0 Plan Risk 阻断批准

Given 反方产生 open P0 Plan Risk
When 用户尝试批准作战计划
Then API 拒绝批准
And UI 不展示“批准作战计划”主按钮
And “要求重排”“拆小任务”“终止”可用

### 场景 11D：P1 Plan Risk 可接受风险

Given 反方产生 open P1 Plan Risk
And 不存在 open P0 Plan Risk
When 用户点击“接受 P1 风险并批准”并填写 reason
Then 系统将该 P1 Plan Risk 标记为 waived
And 重新结算 fresh DB Plan Report
And Plan 状态变为 `PLAN_APPROVED`

### 场景 11E：批准计划后进入 Build

Given Plan 已 approved
And DB approved Plan snapshot 声明 expectedFiles
When 用户点击进入 Build
Then 系统必须先执行 Git Base Camp 检查
And 不得直接在主仓 workspace 中执行 Build Runner

### 场景 12A：无 Git 不能进入正式 Build

Given 当前项目不是 Git 仓库
When 用户尝试开始 Build
Then 系统拒绝进入正式 Build
And UI 显示“建立 Git Base Camp”
And 不创建 Build workspace

### 场景 12B：Build 不直接修改主仓

Given Git Base Camp ready
When 用户点击“建立施工区”
Then 系统创建独立 git worktree
And Build Runner 的工作目录是该 worktree
And 主仓工作区文件不被直接修改

### 场景 12C：expectedFiles 之外变更进入审计

Given Plan 的 expectedFiles 或 legacy allowedFiles 声明了预计施工范围
When Build Runner 修改了预计范围之外但非 forbidden 的文件
Then Build Report 标记 BuildDeviation
And 反方必须审计该 deviation
And 系统不得仅因 deviation 自动判定失败

### 场景 12D：forbiddenFiles 阻断收编

Given Plan 声明 forbiddenFiles
When Build diff 触碰 forbiddenFiles
Then deterministic Build Gate 产生 P0 阻断
And “批准收编”不可用

### 场景 12E：主仓 HEAD 漂移阻断收编

Given Build workspace 的 baseCommit 是 `abc123`
And Build Audit 不存在 open P0
When 主仓 HEAD 已不等于 `abc123`
And 用户尝试批准收编
Then 系统阻断 apply patch
And 提示用户 re-run、rebase 或手动处理

### 场景 12F：反方审计后人类审批收编

Given Build diff / patch 已生成
And deterministic Build Gate 通过
And Build Audit 不存在 open P0
And 主仓 clean 且 HEAD 等于 baseCommit
When 人类点击“批准收编”
Then 系统记录 human decision
And 允许将 patch 收编回主仓
And BuildRun 状态变为 adopted
And BuildRun 记录 adoptedHeadSha
And war-report 聚合 Build verdict

### 场景 13A：Review 战报中心默认显示

Given 最新 BuildRun 已经 adopted
When 用户进入 Review 阶段
Then 页面默认显示 Review 战报中心
And 第一屏展示 Build 包、Review gate、P0/P1/P2 计数和当前主按钮
And 原始 run/history/artifacts/events 默认折叠

### 场景 13B：Review P0 阻断进入 QA

Given Review 产生一个 open P0 finding
When 用户尝试进入 QA
Then 系统拒绝进入 QA
And “接受风险”不可用
And 页面提示 P0 必须修复或终止 Change

### 场景 13C：Review P1 可以带理由接受，但旧战报不得放行

Given Review 产生一个 open P1 finding
And 不存在 open P0
When 用户填写 reason 并点击“接受 P1 风险”
Then 系统将该 P1 标记为 waived
And 当前 Review 战报标记 stale
And 系统必须重新结算或重新审查后才允许进入 QA

### 场景 13D：Review P2 不阻断 QA

Given Review 只产生 P2 findings
When Review 战报结算完成
Then 页面显示 Non-blocking P2 数量
And “进入 QA”可用
And P2 findings 被写入 Review 战报和总战报

### 场景 13E：Review 战报过期时不能进入 QA

Given Review 战报绑定的 `sourceBuildRunId` 是 `build-2`
And 最新 adopted BuildRun 已变为 `build-3`
When 用户尝试进入 QA
Then 系统拒绝进入 QA
And Review 战报中心显示 stale
And 主按钮显示“重新审查”

### 场景 13F：Review 失败不能伪装成通过

Given Review provider 失败
When Review run 结束
Then Review 战报中心显示“反方审查失败”
And “进入 QA”不可用
And 用户可以点击“重新审查”

### 场景 13F-1：Review 输出不合格必须是 invalid_output

Given AI Reviewer 返回非法 JSON
Or P0/P1 finding 缺少 `evidence` 或 `requiredFix`
Or P2 finding 缺少 `evidence`
When Review run 结束
Then Review 战报中心显示“反方输出不合格”
And 系统保存 `raw-review-output.json`
And 原始输出入口出现在高级详情
And 该尝试不得覆盖上一轮有效战报

### 场景 13G：旧 P0/P1 未复核不得自动消失

Given 上一轮 Review 有一个 open P1 finding
When 新一轮 Review 没有输出该 finding 的复核结果
Then 系统不得把旧 P1 标记为 resolved
And Review 战报必须显示该 P1 为“未被复核”
And 进入 QA 仍被阻断，除非人类接受风险并重新结算 fresh 战报

### 场景 13H：Review gate 只能使用 DB findings

Given DB 中有一个 open P0 Review finding
And `.ship/changes/<id>/review-findings.json` 缺少该 finding
When 用户尝试进入 QA
Then 系统拒绝进入 QA
And Review 战报中心标记镜像数据不一致
And 不得以 `.ship` 镜像覆盖 DB 主状态

### 场景 13I：历史不完整战报不得炸 UI

Given 历史 Review finding 只有 `suggestion`
Or P1 的 `requiredFix` 为空
When 用户打开 Review 战报中心
Then 页面正常展示该记录为“历史不完整战报”
And 主按钮要求重新 Review 或人工处理
And 该战报不得作为进入 QA 或 Merge 的依据

### 场景 13J：最近失败尝试不能覆盖上一轮有效战报

Given 上一轮有效 Review 战报为 `issues_found`
And 其中存在 open P1 finding
When 最新一次 Review 尝试返回 `invalid_output` 或 `data_inconsistent`
Then Review 战报中心同时展示 latestAttempt 和 latestValidReview
And QA gate 继续基于上一轮有效战报与 DB findings 阻断
And 页面提示用户可以重新审查或处理上一轮有效 findings

### 场景 14A：Review gate 只认 DB

Given DB 中存在一个 open P0 Review finding
And `.ship/changes/<id>/review-findings.json` 缺少该 finding
When 用户尝试进入 QA
Then 系统拒绝进入 QA
And Review 战报中心显示 DB 中的 P0 阻断
And 系统不得用 `.ship` 镜像覆盖 DB finding 状态

### 场景 14B：镜像缺失不影响主状态

Given DB Review gate state 为 `passed`
And `review-report.md` 写入失败或被删除
When 用户打开 Review 战报中心
Then 页面仍显示 Review 已通过
And “进入 QA”仍按 DB gate 可用
And 高级详情显示 `artifactMirrorStatus = missing` 或 `generation_failed`

### 场景 14C：镜像不一致只能修镜像或重审

Given DB 中有 2 个 Review findings
And `review-findings.json` 中有 1 个 finding
When 系统检测镜像 hash 或内容不一致
Then DB findings 不被修改
And 系统不得把镜像里的缺失 finding 当作已关闭
And 页面提示用户可“重建审计镜像 / 重新审查 / 终止 Change”

### 场景 14D：可从 DB 重建 Review 镜像

Given DB 中存在完整 Review run、latest valid review、findings、waiver 和 gate state
And `.ship` 下的 `review-report.md` 与 `review-findings.json` 缺失
When 用户触发“重建审计镜像”
Then 系统从 DB 重新生成 `review-report.md`
And 系统从 DB 重新生成 `review-findings.json`
And 重建后的镜像记录 DB source hash / schemaVersion
And finding 状态、waiver 状态、gate 结论和 run 状态都不改变

### 场景 14E：latest attempt 失败不覆盖 latest valid review

Given DB 中已有一个 `latestValidReview`，gate 为 `blocked_p1`
When 最新 Review attempt 返回非法 JSON
Then 系统记录 attempt 状态为 `invalid_output`
And `latestValidReview` 不被覆盖
And QA gate 继续基于 DB latest valid review 和 DB findings 阻断

### 场景 14F：P1 waiver 必须进入 DB 并重新结算

Given DB 中存在一个 open P1 Review finding
When 用户接受 P1 风险并填写 reason
Then 系统写入 DB waiver / human decision
And finding 标记 `waived`
And 当前 Review report 标记 stale
And waiver、finding、report stale 必须在同一事务或可恢复事务链中完成
And 只有 DB gate 重新计算为 `passed` 后才允许进入 QA
And Markdown report 中的 waiver 文案不作为 gate 依据

### 场景 14G：历史 JSON-only 数据标记 legacy_incomplete

Given 某 change 只有历史 `review-findings.json`
And DB 中没有对应 Review run、attempt 或 findings
When 用户打开 Review 战报中心
Then 页面显示“历史不完整战报”
And 当前 Review gate 不得为 `passed`
And “进入 QA”不可用
And 页面主操作建议重新 Review 或人工处理

### 场景 14H：进入 QA 必须使用 DB gate

Given `review-report.md` 文案显示“Review passed”
But DB Review gate state 不是 `passed`
When 用户尝试进入 QA
Then 系统拒绝进入 QA
And 页面提示“报告镜像不是放行依据，需以 DB Review gate 为准”

### 场景 14I：所有 QA 入口都被 Review QA Gate 拦截

Given Review DB gate 不是 `passed`
When 用户通过 UI、API route、旧 `runCheck` / `continue` 路径或自动推进逻辑尝试进入 QA
Then 所有入口都调用同一个 Review QA Gate service
And 所有入口都返回相同的阻断原因
And 不得存在只靠前端按钮 disabled 的绕过路径

### 场景 14J：Build freshness 必须校验 HEAD

Given `latestValidReview.sourceBuildRunId` 等于 latest adopted BuildRun
But 当前主仓 `HEAD` 不等于 BuildRun 的 `adoptedHeadSha`
When 用户尝试进入 QA
Then Review Center gate 为 `stale`
And “进入 QA”不可用
And 页面提示需要重新审查最新已收编代码包

### 场景 14K：新 Review run 禁止 JSON-only 状态

Given Review DB schema 已启用
When 系统执行新的 Review run
Then 所有 Review 主状态必须先写 DB
And `.ship` JSON / Markdown 必须由 DB 主状态生成
And 如果 DB 写入失败，本轮 Review 不得通过
And 如果镜像写入失败，只能记录 artifact mirror status，不得生成 JSON-only pass

### 场景 15A：全阶段状态必须进入 DB

Given 一个全新 change
When 用户从 PRD 推进到 Merge
Then PRD、Spec、Plan、TestPlan、Build、Review、QA、Merge 每个阶段都存在 DB stage state、gate、action contract、run / report metadata
And `.ship` 文件只记录 mirror metadata、hash 和可读内容
And 任一阶段不得只有 JSON / Markdown 状态而缺少 DB 权威记录

### 场景 15B：DB 完整但镜像缺失时不改变 gate

Given DB 中 PRD、Spec、Plan、TestPlan、Build、Review、QA 或 Merge 的 gate 为 passed
And 对应 `.ship` JSON / Markdown 镜像被删除
When 用户打开页面或后端重新计算 gate
Then gate 仍按 DB 显示 passed
And 页面只显示 mirror warning
And 用户可以触发“从 DB 重建镜像”

### 场景 15C：镜像显示 passed 但 DB 缺记录时必须阻断

Given `.ship` 中某阶段 JSON / Markdown 写着 passed
But DB 中缺少该阶段的权威 stage state、gate 或 source lineage
When 用户尝试执行下一阶段 action
Then action contract 必须 disabled
And 执行 API 必须返回 409 或 400
And reason 必须提示需要迁移或重新执行该阶段

### 场景 15D：UI action 与后端 preflight 同源

Given DB gate 当前阻断某个 action
When 前端请求 action contract
Then 该 action 的 `enabled=false`
And `reasonCode`、`reason`、`blockers`、`gateVersion` 来自同一个 DB-first gate service
When 用户绕过 UI 直接调用执行 API
Then API 复用同一个 preflight service
And 返回相同阻断原因或返回包含新 action contract 的 409

### 场景 15E：Plan 镜像不得成为 Build 输入

Given DB approved Plan snapshot 的 expectedFiles 为 `server/a.ts`
And `.ship/changes/<id>/plan.json` 被篡改为 expectedFiles = `server/b.ts`
When 用户开始 Build
Then Build 只能读取 DB approved Plan snapshot
And Build Gate 按 `server/a.ts` 判断 expectedFiles
And 系统记录 plan mirror mismatch warning

### 场景 15F：QA / Merge 只认 DB gate

Given QA report Markdown 或 war report Markdown 写着 passed
But DB QA result 或 Merge readiness 不存在、stale 或 blocked
When 用户尝试进入 Merge 或执行 Merge action
Then 系统拒绝
And Merge Gate 只读取 DB QA result、Review gate、blocking findings、HEAD freshness 和 required approvals
And 不得读取 Markdown 作为 passed 依据

## 十八、实施顺序

| Phase | 内容 | 目标 |
|---|---|---|
| Phase 0：资产对齐 | 对齐现有 docs、state-machine、findings、gate、artifacts 的真实能力 | 消除文档与代码模型不一致 |
| Phase 1：PRD Briefing Room | 实现作战意图、反方疑点卡、PRD 草案、PRD Gate、锁定 PRD 基线 | 让人类需求源头先被结构化澄清 |
| Phase 2：severity / findings schema | 扩展 P0/P1/P2，统一 findings 状态语义 | 为 gap/gate 提供基础 |
| Phase 3：Requirement Gap / gate invariant | 增加 Requirement Gap schema、关闭规则、Spec gate 校验、跨轮消账字段 | 建立阻断核心 |
| Phase 4：单阶段 Battle | 实现 `SPEC_BATTLE_MVP`：我方代理 Spec Writer、反方 Requirement Critic、round 记录、RedFixClaim、BlueGapReview | 完成最小对抗闭环 |
| Phase 5：战报 UI | deterministic `BATTLE_REPORTER` 生成 DB Spec / War Report metadata，并渲染 `reports/spec-report.md` 和 `reports/war-report.md` 镜像，页面展示合法裁决 | 人类从 DB report 派生的战报做裁决 |
| Phase 6：Plan 作战沙盘 | 包装现有 Plan：任务地图、反方 Plan Risk、Plan Report、Plan Gate、人类审批 | 在进入 Build 前完成排兵布阵 |
| Phase 7：Git Base Camp | Git 检测、initial commit 引导、baseCommit、dirty main 阻断、worktree 创建 | 保证 Build 有可审计基础 |
| Phase 8：Build 施工沙盘 | 在隔离 workspace 中施工、验证、生成 diff / patch / build report | 实现不直接污染主仓 |
| Phase 9：Build 反方审计与收编 | deterministic Build Gate、Build Audit、人类审批、patch 收编 | 让实现结果先被审计再进入主仓 |
| Phase 10：Review 战报中心 | 聚合最新 Review run、findings、Build freshness 和人类 waiver，默认展示反方战报并控制进入 QA | 让 Review 不再像日志页，也不再混成 QA 失败 |
| Phase 11：多阶段模板 | 在 MVP、Plan 沙盘、Build 沙盘和 Review 战报中心稳定后，再扩展 TechSpec/TestPlan/QA battle | 不提前塞入第一版 |

## 十九、成功标准

MVP 成功的判断不是“全流程都对抗化”，而是：

1. 一个 change 能从 PRD Briefing Room 进入 Spec Battle。
2. PRD 阶段 open critical 疑点会阻断 PRD 锁定。
3. PRD 阶段 important 疑点可以被人类暂缓，并作为 Spec Battle 上下文继续暴露。
4. 一个 change 能完成 Spec Battle。
5. 反方能产生结构化 Requirement Gap。
6. P0/P1 gate invariant 生效。
7. 人类只能执行合法裁决动作。
8. deterministic report 能解释为什么能过或不能过。
9. 通过 Spec Gate 后能回到现有 pipeline。
10. 所有关键状态有权威存储位置和可审计 artifact。
11. PRD 主界面像战前会议室，Spec 主界面像 SLG 回合战斗，而不是后台审批表。
12. 连续对抗轮次中，旧 P0/P1 必须被明确复核；如果我方修复有效，P0/P1 数量应能下降，而不是只增不减。
13. 待审批 Plan 扩展完成后，Plan 主界面应像作战沙盘：用户能在一分钟内看懂任务顺序、目标文件、反方拦截点和执行许可。
14. 待审批 Build 扩展完成后，无 Git 项目不能进入正式 Build，Git Base Camp 能清楚解释阻断原因。
15. 待审批 Build 扩展完成后，Build Runner 必须在隔离 worktree 中施工，不能直接污染主仓。
16. 待审批 Build 扩展完成后，`expectedFiles` 外 diff 会进入 BuildDeviation 和反方 Audit，而不是被静默吞掉或自动收编。
17. 待审批 Build 扩展完成后，`forbiddenFiles` / policy / Git 安全边界会硬阻断收编。
18. 待审批 Build 扩展完成后，只有 deterministic Build Gate 通过、反方 Audit 无 open P0、人类批准、主仓 clean 且 HEAD 未漂移时，patch 才能收编。
19. 待审批 Review 扩展完成后，Review 主界面应像反方战报结算页：用户能一眼看懂能否进入 QA、阻断原因和下一步按钮。
20. 待审批 Review 扩展完成后，Review 问题不得显示成 QA failed；Review gate 必须有独立产品语义。
21. 待审批 Review 扩展完成后，P0 不可豁免，P1 必须带 reason 且重新结算 fresh 战报后才能进入 QA，P2 不阻断。
22. 待审批 Review 扩展完成后，旧 P0/P1 Review finding 未被反方明确复核时不得自动消失。

## 二十、核心结论

stagepass 的产品愿景仍然是用对抗机制把风险暴露给使用者、由人拍板的 Stage-Gate 控制台，但第一版必须以最小闭环落地：

> PRD Briefing Room + Spec Battle + Requirement Gap + Gate + War Report

Plan 阶段的下一步不是做完整多轮对抗，而是做 Plan 作战沙盘：

> AI 负责排兵布阵，反方负责执行前拦截，人类负责批准作战计划，系统负责生成可审计的 expected scope。

Build 阶段的下一步不是直接放开 AI 改主仓，而是做 Git Base Camp + Build 施工沙盘：

> Build Runner 在隔离 worktree 施工，反方负责审计 diff 和收编风险，人类负责批准收编，系统负责 deterministic Build Gate 和 patch 安全落地。

Review 阶段的下一步不是做完整多轮对抗，而是做 Review 战报中心：

> 反方 Reviewer 审查最新已收编 Build 包，系统用结构化 findings、Build freshness 和人类 waiver 结算战报，人类只负责修复、接受 P1 风险、重新审查或进入 QA。

先把“人类真实需求能被反方质询澄清、PRD 能被锁定、需求层漏洞能被反方发现、被结构化记录、被 gate 阻断、被我方代理逐项修复、被反方逐项复核、被人类裁决、被战报解释”做扎实；再把 Plan 做成轻量、有趣、能审查执行风险的作战沙盘；再把 Build 做成 Git 驱动、隔离施工、反方审计、人类收编的工程化沙盘；再把 Review 做成反方战报中心，保证进入 QA 前有清晰、fresh、可裁决的审查结论；最后再扩展到 TechSpec、TestPlan、QA 等阶段。这样才是架构中枢升级，而不是把全阶段愿景一次性塞进不可验证的 MVP。
