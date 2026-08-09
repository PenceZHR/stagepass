# CHG-001 实测账导出（2026-08-06 晚，批 3 动地基之前）

> PLAN-2026-08-06 §2.2 那份账的**完整导出**。上一份取证（21 轮 / 139 条 finding）
> 已被删除且不可恢复；这一份是「模板 + rubric 收口」那套机制**唯一的证据**，
> 所以在批 3（`change_states` 改 schema，账随之作废）之前先落在仓库里。
>
> 来源：`~/.stagepass/panel.db`（含 WAL），**只读**：先整库拷贝到临时目录，
> 从拷贝导出，原库一个字节没动。

## 文件

| 文件 | 内容 |
|---|---|
| `summary.json` | 逐阶段逐轮逐角色的判定分布、8 条 gap、18 条轮注、48 条账本事件、15 条 job |
| `full-dump.json` | 十五张表的整表原样导出（含 rubric 全文、worklist、questions/answers） |

## 和 PLAN §2.2 的对账

| 阶段 | 轮 | 判定（producer+critic） | no |
|---|---|---|---|
| PRD | r6 | 13 + 4 = 17 | 0 |
| Spec | r2 | 8 + 4 = 12 | 0 |
| TechSpec | r1 → r2 | 12 → 12 | 1 → 0 |
| Plan | r1 | 5 + 4 = 9 | 0 |
| TestPlan | r1 | 7 + 4 = 11 | 0 |
| Build | r1 | 13 + 5 = 18 | **7**（producer 6 + critic 1） |

逐项等于 §2.2 表格 —— 「七轮有效对抗，`finding` 累计 0、模板缺节累计 0」在
`gaps` 表里可复核（8 条 gap 全是 rubric 派生的 `standard`，没有一条自由 finding）。

导出时 CHG-001 停在 **Build / blocked**（Build 后续轮的争议见
`~/Desktop/demo` 工作树上的 Build-r7 文档，那部分没进库，不在这份账里）。
