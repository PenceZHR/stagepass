# Data Model：stagepass 数据模型

| 项 | 值 |
|---|---|
| 文档状态 | Draft（待 Interface Review） |
| 版本 | v2.0 |
| 关联 | [docs/api-spec.md](./api-spec.md) |

> 实现：SQLite（better-sqlite3）+ Drizzle ORM，WAL 模式。源 schema：`server/db/schema.ts`。

---

## 一、实体关系

```
projects (1) ──< (N) changes (1) ──< (N) runs (1) ──< (N) events
                        │                  │
                        ├──< artifacts ────┤
                        └──< findings ─────┘
```

## 二、表定义

### projects

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | PRJ-xxx |
| name | TEXT | NOT NULL | 项目名 |
| repo_path | TEXT | NOT NULL UNIQUE | 本地仓库路径 |
| context_status | TEXT | NOT NULL default 'pending' | pending/generating/ready/failed |
| context_provider | TEXT | NOT NULL default 'codex' | codex/claude |
| prd_status | TEXT | NOT NULL default 'none' | none/drafting/ready/revising/failed |
| prd_provider | TEXT | NOT NULL default 'codex' | codex/claude |
| prd_json / prd_markdown | TEXT | nullable | 结构化/markdown PRD |
| git_enabled | INTEGER | NOT NULL default 0 | 0/1；仅当 repo_path 是 Git repo 且已有 commit 时为 1 |
| git_default_branch | TEXT | nullable | Git 启用时同步真实默认分支，否则为 null |
| created_at / updated_at | TEXT | NOT NULL | ISO 时间戳 |

### changes

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | TEXT | PK | CHG-xxx |
| project_id | TEXT | NOT NULL FK→projects | |
| title | TEXT | NOT NULL | |
| status | TEXT | NOT NULL | ChangeStatus（见 state-machine.md）|
| provider | TEXT | NOT NULL default 'codex' | |
| codex_thread_id | TEXT | nullable | AI 会话续接 |
| fix_iterations | INTEGER | default 0 | Fix 轮次（上限 99）|
| blocked_phase | TEXT | nullable | BLOCKED 时记录阶段 |
| rework_from_phase | TEXT | nullable | 重做起点 |
| suspended_by_prd / pre_suspend_status | INTEGER/TEXT | | PRD 修订挂起 |
| git_branch | TEXT | nullable | change 分支 |
| created_at / updated_at | TEXT | NOT NULL | |

#### v2 新增列（迁移 0008）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| gate_state | TEXT | nullable | 当前所处人工门（intake/spec/tech_spec/merge），非门态为 null |
| docs_complete | INTEGER | default 0 | delta 文档是否齐全（merge 前置）|
| retro_done | INTEGER | default 0 | 复盘是否完成 |

### runs

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | RUN-xxx |
| change_id | TEXT FK | |
| phase | TEXT | RunPhase（v2 扩展为 12 个）|
| status | TEXT | running/completed/failed/stopped |
| started_at / ended_at | TEXT | |
| summary | TEXT | |

### events

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | EVT-xxx |
| change_id / run_id | TEXT FK nullable | 项目级事件 change_id 为 null |
| type | TEXT | EventType（见 enums）|
| message / raw_json | TEXT | |
| created_at | TEXT | |

### artifacts

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | ART-xxx |
| change_id | TEXT FK | |
| run_id | TEXT FK nullable | |
| type | TEXT | ArtifactType（v2 扩展：change_request/prd_delta/tech_spec_delta/api_spec_delta/test_plan_delta/review_report/release_note/retro/stage_scope）|
| path | TEXT | 文件路径 |
| created_at | TEXT | |

### findings

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | FND-xxx |
| change_id / run_id | TEXT FK | |
| source | TEXT | lint/typecheck/test/build/semgrep/scope/review/human |
| severity | TEXT | P0/P1 |
| category / title | TEXT | |
| file / line | TEXT/INTEGER nullable | |
| evidence / required_fix | TEXT nullable | |
| status | TEXT | open/fixed/waived |
| created_at | TEXT | |

### __migrations（Phase 0 新增）

| 列 | 类型 | 说明 |
|---|---|---|
| tag | TEXT PK | 迁移文件 tag（如 0008_xxx）|
| applied_at | TEXT NOT NULL | 应用时间 |

## 三、ID 规则

各表 ID = 前缀 + 自增 3 位数字（PRJ/CHG/RUN/EVT/ART/FND）。`nextId()` 扫表取末尾数字最大值 +1。

## 四、文件系统产物（非 DB）

```
.ship/
  baseline/          # v2 新增：稳定基线（10 份）
    prd.md / tech-spec.md / api-spec.md / data-model.md
    state-machine.md / error-codes.md / test-plan.md
    decisions.md / changelog.md / backlog.md
  changes/<id>/
    change-request.md / prd-delta.md / tech-spec-delta.md
    api-spec-delta.md / test-plan-delta.md
    plan.json / <phase>-scope.json
    changed-files.json / findings.json
    review-report.md / test-report.md / release-note.md / retro.md
    runs/<runId>/...   # 每轮快照
  context/             # v1：项目基线文档（context 生成）
  context-progress.json
```

---

*评审：Aprrove *
