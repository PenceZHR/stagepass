# Task Breakdown：stagepass 流水线改造任务拆分

| 项 | 值 |
|---|---|
| 文档状态 | Draft（施工任务清单，供 Codex 接管） |
| 版本 | v2.0 |
| 关联 | [docs/implementation-anchors.md](./implementation-anchors.md)、[docs/test-plan.md](./test-plan.md) |

> 每个任务标注：改动文件、依赖前置任务、完成判定。Codex 按 ID 顺序施工，每完成一个跑对应验收。**一个任务一个小步，一个 commit 一个逻辑动作。**

---

## Phase 0：稳定化（地基，可独立）

### T0.1 迁移 runner（部分已实施）
- **文件**：`server/db/migrate.ts`（已建）、`server/db/index.ts`（已接入）
- **依赖**：无
- **完成判定**：全新内存 DB 跑完所有迁移后 schema 完整；重复运行不报错；现有 `ship.db` 正常加载
- **状态**：代码已写，**缺测试 + 验证**

### T0.2 迁移 runner 测试
- **文件**：`server/db/migrate.test.ts`（新建）
- **依赖**：T0.1
- **完成判定**：`pnpm test` 含 migrate 用例通过

### T0.3 解 3 个 skip 测试
- **文件**：`stage-guard-service.test.ts`、`change-phase-service.test.ts`
- **依赖**：无
- **决策已定**：snapshot 记录 `.ship/` 变化，scope 判罚豁免 `.ship/`
- **完成判定**：3 个 `it.skip` 改为对齐实现的断言并通过

---

## Phase 1：文档基线脚手架（纯可逆，零风险）

### T1.1 baseline-service
- **文件**：`server/services/baseline-service.ts`（新建）
- **依赖**：无
- **内容**：`scaffoldBaseline(repoPath)` 创建 `.ship/baseline/` 下 10 份空模板；`updateChangelog(repoPath, entry)` 追加变更
- **完成判定**：调用后 `.ship/baseline/` 下 10 份文件存在

### T1.2 模板文件
- **文件**：`server/templates/baseline/*.md`（10 份模板）
- **依赖**：无
- **完成判定**：模板齐全，含标准 frontmatter

### T1.3 baseline API + 前端入口
- **文件**：`app/api/projects/[id]/baseline/route.ts`、`baseline/[docName]/route.ts`、前端侧边栏加「基线文档」
- **依赖**：T1.1
- **完成判定**：前端能列出并查看 10 份 baseline 文档

---

## Phase 2：状态机 + 阶段扩展（核心）

### T2.1 enums 扩展
- **文件**：`server/types/enums.ts`
- **依赖**：无
- **改动**：`ChangeStatus` 加 11 态、`RunPhase` 加 6 个、`Phase` 加 9 段、`ArtifactType` 加产物类型（见 anchors §0）
- **完成判定**：`pnpm build` 不报枚举相关错

### T2.2 展示层状态映射扩展
- **文件**：前端 / 展示层阶段映射
- **依赖**：T2.1
- **改动**：展示层状态映射补全 11 个新状态，避免新增状态回退到默认阶段
- **完成判定**：TS 编译通过，相关页面测试覆盖新增状态的展示阶段

### T2.3 change-phase / change-rework 映射补全
- **文件**：`change-phase-service.ts`、`change-rework-service.ts`
- **依赖**：T2.1
- **改动**：`ROOT_FILES_BY_PHASE`（严格 Record，必补 6 个新 phase）、`PHASE_ORDER`、`STATUS_TO_REVIEW_PHASE`、`RUN_PHASE_TO_REVIEW_PHASE`、`CONTENT_PHASES`（见 anchors §0）
- **完成判定**：`pnpm build` 通过

### T2.4 DB schema + 迁移 0008
- **文件**：`server/db/schema.ts`、`migrations/0008_add_gate_fields.sql`、`meta/_journal.json`
- **依赖**：T2.1（理想上也依赖 T0.1 迁移 runner）
- **完成判定**：迁移后 changes 表有 gate_state/docs_complete/retro_done

### T2.5 stage-guard 读写边界
- **文件**：`stage-guard-service.ts`
- **依赖**：T2.1
- **改动**：加 `StageScope`、`DEFAULT_STAGE_SCOPES`、`resolveReadableFiles`、`validatePlannedChanges`（见 anchors §3）
- **完成判定**：现有 scope 测试不回归 + 新边界单测通过

### T2.6 prompt-service 扩展 + 模板
- **文件**：`prompt-service.ts`、`templates/prompts/{intake,spec,tech-spec,test-plan,release,retro}.md`
- **依赖**：T2.1
- **改动**：`PromptPhase` union 加 6 个、按 StageScope 注入上下文
- **完成判定**：每个新 phase 能组装出 prompt

### T2.7 pipeline 新 stage 函数
- **文件**：`pipeline-service.ts`
- **依赖**：T2.1–T2.6
- **改动**：加 `runIntake/runSpec/runTechSpec/runTestPlan/runRelease/runRetro`（见 anchors §1）
- **完成判定**：每个 stage 函数单测（mock engine）通过状态转移

### T2.8 阶段 API 路由
- **文件**：`app/api/.../{intake,spec,tech-spec,test-plan,release,retro,review}/route.ts`
- **依赖**：T2.7
- **完成判定**：每个路由能触发对应 stage

---

## Phase 3：人工门 + Retro 闭环

### T3.1 gate-service
- **文件**：`server/services/gate-service.ts`（新建）
- **依赖**：T2.1–T2.7
- **改动**：`getGateStatus/approveGate/rejectGate/canMerge`（见 anchors §2）
- **完成判定**：4 个门的 approve/reject + canMerge 校验单测通过

### T3.2 gate API
- **文件**：`gate/route.ts`、`gate/approve/route.ts`、`gate/reject/route.ts`
- **依赖**：T3.1
- **完成判定**：门接口可驱动状态转移

### T3.3 人工门前端 UI
- **文件**：`app/projects/[id]/...` 阶段栏 + 门确认组件
- **依赖**：T3.2
- **完成判定**：到门态显示「待确认」+ Approve/打回 + 产物预览

### T3.4 Retro → backlog/memory 接线
- **文件**：`server/services/retro-service.ts`（新建）
- **依赖**：T2.7
- **完成判定**：retro.md 的债务段追加到 backlog.md

---

## Phase 4：打磨

### T4.1 changelog 自动化
- **文件**：`baseline-service.ts`、`pipeline-service.runRelease`
- **完成判定**：Release 后 changelog 自动追加条目

### T4.2 ADR 决策日志
- **文件**：`baseline/decisions.md` 写入机制
- **完成判定**：Tech 决策可记录为 ADR

### T4.3 release-note 生成
- **文件**：`pipeline-service.runRelease`
- **完成判定**：合并时生成 release-note.md

---

## 依赖图（关键路径）

```
T2.1(enums) ─┬─ T2.2(展示映射)
             ├─ T2.3(映射补全)
             ├─ T2.4(schema/迁移)  ←理想依赖 T0.1
             ├─ T2.5(stage-guard)
             └─ T2.6(prompt) ─→ T2.7(pipeline) ─→ T2.8(API)
                                      │
                                      └─→ T3.1(gate) ─→ T3.2(API) ─→ T3.3(UI)
                                      └─→ T3.4(retro)
```

## 施工原则（给 Codex）

1. 按 Phase → 任务 ID 顺序，每任务一个 commit。
2. 每个任务完成后跑 `pnpm build` + 相关测试，绿色才进下一个。
3. 改枚举后**立即** `pnpm build`，让 TS 指出漏改的 Record 映射表。
4. 发现 spec 与代码冲突 → **停下报告**，不自行偏离设计。
5. 不做无关重构。

---

*供 Codex 施工，逐任务对应 test-plan.md 的验收。*
