# State Machine：stagepass Change 状态机

| 项 | 值 |
|---|---|
| 文档状态 | Draft（待 Interface Review） |
| 版本 | v2.1 |
| 关联 | [docs/api-spec.md](./api-spec.md)、[docs/tech-spec.md](./tech-spec.md) |

> 源：`server/types/enums.ts`（ChangeStatus）+ 展示层状态映射（→ 展示 Phase）。

---

## 一、状态全集

### v1 状态（保留）

```
REFINING DRAFT PLANNING PLAN_READY PLAN_APPROVED
IMPLEMENTING IMPLEMENTED REVIEWING CHECKING
CHECK_FAILED FIXING SCOPE_FAILED LOCAL_READY BLOCKED
```

### v2 新增状态

```
INTAKE_PENDING  INTAKE_READY◆
SPECCING        SPEC_READY◆
TECHSPECCING    TECHSPEC_READY◆
TESTPLANNING    TESTPLAN_DONE
MERGE_READY◆    MERGING  RETRO_PENDING  DONE
```

`◆` = 人工门（waiting，不自动前进）。

## 二、完整转移图

```
[创建]
  │
  ▼
INTAKE_PENDING ──(AI评估)──▶ INTAKE_READY ◆
                                  │ approve              │ reject
                                  ▼                      ▼
                              SPECCING ◀──────────── (丢回需求池/关闭)
                                  │ (产出 prd-delta)
                                  ▼
                              SPEC_READY ◆ ──reject──▶ INTAKE_READY（回到 Spec 入口）
                                  │ approve
                                  ▼
                              TECHSPECCING
                                  │ (产出 tech-spec-delta / api-spec-delta)
                                  ▼
                              TECHSPEC_READY ◆ ──reject──▶ SPEC_READY
                                  │ approve
                                  ▼
                              PLANNING
                                  │ (产出 plan.json / plan.md)
                                  ▼
                              PLAN_READY ◆ ──reject──▶ TECHSPEC_READY
                                  │ approve
                                  ▼
                              PLAN_APPROVED
                                  │ run test-plan
                                  ▼
                              TESTPLANNING
                                  │ (产出 test-plan-delta)
                                  ▼
                              TESTPLAN_DONE ──confirm build──▶ PLAN_APPROVED
                                                            │ run Build
        ┌───────────────────────────────────────────────────┘
        ▼
   IMPLEMENTING ──human absorb──▶ IMPLEMENTED ──▶ REVIEWING
                                       │
                       approved ◀──────┤────▶ 有findings
                       │                       │
                       ▼                       ▼
                   CHECKING                CHECK_FAILED
                   │   │   │                   │
       LOCAL_READY ◀┘   │   └▶ SCOPE_FAILED    │
            │           │            │         │
            │           ▼            └────┬────┘
            │      CHECK_FAILED           ▼
            │                          FIXING ──(≤3轮)──▶ CHECKING
            │                             │ >3轮
            │                             ▼
            │                          BLOCKED
            ▼
       MERGE_READY ◆ ──reject──▶ LOCAL_READY
            │ approve (canMerge=true)
            ▼
        MERGING ──▶ RETRO_PENDING ──(产出 retro)──▶ DONE
```

> 门态 approve 只记录 `gateState` / 人工决策，不直接改变 `ChangeStatus`；下一阶段 route 读取门态与 action contract 后启动。门态 reject 必须回到对应 stage 的可重跑入口态，不直接进入 `*ING` 执行中状态。

## 三、状态 → 展示 Phase 映射（v2）

| ChangeStatus | Phase | State |
|---|---|---|
| INTAKE_PENDING | Intake | running |
| INTAKE_READY | Intake | waiting（门）|
| SPECCING | Spec | running |
| SPEC_READY | Spec | waiting（门）|
| TECHSPECCING | TechSpec | running |
| TECHSPEC_READY | TechSpec | waiting（门）|
| PLANNING | Plan | running |
| PLAN_READY | Plan | waiting（门）|
| PLAN_APPROVED | TestPlan / Build | ready |
| TESTPLANNING | TestPlan | running |
| TESTPLAN_DONE | TestPlan | done |
| IMPLEMENTING | Build | running |
| IMPLEMENTED | Review | waiting |
| REVIEWING | Review | running |
| CHECKING | QA | running |
| CHECK_FAILED / SCOPE_FAILED | QA | failed |
| FIXING | QA | running |
| LOCAL_READY | QA | done |
| MERGE_READY | Merge | waiting（门）|
| MERGING | Merge | running |
| RETRO_PENDING | Retro | running |
| DONE | Retro | done |
| BLOCKED | （记录 blocked_phase）| blocked |

> Review v2.1 说明：底层可暂时兼容 `IMPLEMENTED` / `REVIEWING` / `CHECK_FAILED`，但产品 UI 不得直接把 Review findings 显示成 QA failed。当前展示 Phase 必须结合 `ReviewCenterState` 派生：若最新失败来源是 Review，或存在 open Review P0/P1，则优先显示 Review 战报阻断，而不是 QA failed。

> Phase enum 同时包含 UI 阶段和内部 review / control 阶段；`Refine`、`Approve`、`Implement`、`Check`、`Fix`、`Ready` 这类值只作为内部或兼容阶段使用。前端展示必须以本表和 `ReviewCenterState` 派生结果为准。

### 3.1 ReviewCenterState 派生状态

Review 战报中心是 Build 与 QA 之间的派生 gate，不要求第一版新增顶层 `ChangeStatus`，但必须拥有独立产品语义。

| ReviewCenterGate | 触发条件 | 产品展示 | 是否可进入 QA |
|---|---|---|---|
| `not_started` | 最新 Build 已收编，但没有有效 Review run | Review 待审 | 否 |
| `running` | Review run 运行中 | 反方审查中 | 否 |
| `failed` | provider 失败、非法输出、report / DB 不一致 | 反方审查失败 | 否 |
| `blocked_p0` | 存在 open P0 Review finding | P0 阻断 | 否 |
| `blocked_p1` | 存在 open P1 Review finding，且未全部 waiver | P1 待裁决 | 否 |
| `stale` | Build run / HEAD / waiver 使战报过期 | 战报过期 | 否 |
| `passed` | fresh、最新 Build、无 open P0/P1 或 P1 已带 reason waiver 且重算 | 可进入 QA | 是 |

## 四、转移合法性表（节选关键）

| 当前 | 允许操作 | 目标 | 守卫条件 |
|---|---|---|---|
| INTAKE_READY | gate/approve | INTAKE_READY | 记录批准；下一步由 spec route 从门态启动 |
| INTAKE_READY | gate/reject | （关闭/backlog）| — |
| SPEC_READY | gate/approve | SPEC_READY | 记录批准；下一步由 tech-spec route 从门态启动 |
| SPEC_READY | gate/reject | INTAKE_READY | 回到 runSpec 可重跑入口 |
| TECHSPEC_READY | gate/approve | TECHSPEC_READY | 记录批准；下一步由 plan route 从门态启动 |
| TECHSPEC_READY | gate/reject | SPEC_READY | 回到 runTechSpec 可重跑入口 |
| PLAN_READY | approve-plan | PLAN_APPROVED | plan-report 通过，无 open P1/P0 |
| PLAN_APPROVED | test-plan | TESTPLAN_DONE | 产出 test-plan-delta，不自动进入 Build |
| TESTPLAN_DONE | confirm | PLAN_APPROVED | 人工确认测试计划，回到 Build 待开工 |
| PLAN_APPROVED | implement | IMPLEMENTING | Git Base Camp 干净，创建 Build workspace |
| IMPLEMENTING | approve-build | IMPLEMENTED | 人工吸附 Build patch 到主工作区 |
| IMPLEMENTED | review | REVIEWING | latest BuildRun adopted，HEAD 未漂移，无 running Review |
| REVIEWING | review-complete | IMPLEMENTED | fresh Review 战报通过；或 Review 失败后回到 Review 待处理 |
| REVIEWING | review-issues | CHECK_FAILED（兼容旧状态） | 存在 Review P0/P1；产品 UI 必须显示 Review 战报阻断，不显示 QA failed |
| IMPLEMENTED / CHECK_FAILED | enter-qa | CHECKING | `ReviewCenterState.gate = passed` |
| MERGE_READY | gate/approve | MERGE_READY | 记录批准；下一步由 release route 从门态启动，**canMerge=true** |
| MERGE_READY | gate/reject | LOCAL_READY | 回到 merge 前入口 |
| FIXING | （自动）| CHECKING | — |
| FIXING | — | BLOCKED | fix_iterations >= 99 |
| RETRO_PENDING | retro | DONE | retro.md 产出 |

## 五、不变式（Invariants）

1. 同一项目至多一个 change 处于 RUNNING 类状态（*ING）。
2. 门态（◆）永不自动前进，仅 gate 接口驱动。
3. `MERGING` 仅当 `canMerge = QA绿 && Review通过 && 文档齐全`。
4. `FIXING` 累计不超过 3 轮，超限强制 BLOCKED。
5. `.ship/` 产物变更豁免 scope 判罚（不触发 SCOPE_FAILED）。
6. 任何 *_READY 门态可 reject 回退到对应 stage 函数可重跑的入口态。
7. 进入 QA 前必须满足 `ReviewCenterState.gate = passed`。
8. Review provider 失败、非法输出、report / DB findings 不一致不得当作 Review 通过。
9. Review P0 不可 waiver，Review P1 waiver 必须带 reason 且使 report stale，fresh 重算前不得进入 QA。
10. 新 Review 未明确复核旧 open P0/P1 时，不得自动关闭旧 finding。
11. Review findings 不得在产品 UI 中展示为 QA failed；`CHECK_FAILED` 仅作为兼容底层状态。

---

*评审：approve *
