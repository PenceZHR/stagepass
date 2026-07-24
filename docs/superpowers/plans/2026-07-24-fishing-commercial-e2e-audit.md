# Fishing Master Commercial E2E Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用真实 StagePass Web、App Server、Codex Desktop 常驻任务、独立审核任务和浏览器回归，从零跑通一个复杂的“捕鱼达人商业版”项目，并对沿途发现的缺陷逐项修复、审核或删除。

**Architecture:** E2E 使用独立 SQLite 数据库和独立嵌套 Git 仓库，避免污染现有项目数据。StagePass Web 只承担操作和证据查看，所有正式实现与审核都落在可见的 Codex Desktop 任务中；每个 StagePass 缺陷单独进入复现、修复、规格审核、质量审核、回归和提交闭环。

**Tech Stack:** StagePass Next.js/SQLite/Drizzle、Codex App Server 与 Desktop follower、MCP Apps、浏览器自动化、目标应用 React/TypeScript/Canvas 2D、Vitest、Playwright。

---

## File Map

- Create: `${FISHING_RUN_ROOT}/repo/` — 独立目标 Git 仓库。
- Create: `${FISHING_RUN_ROOT}/ship.db` — 独立 StagePass 权威数据库。
- Create: `${FISHING_RUN_ROOT}/evidence/` — 截图、任务 ID、turn ID、测试和提交记录。
- Create in target repo: `README.md` — 产品目标与运行方式。
- Create in target repo: `package.json` — React/TypeScript/Canvas 测试依赖。
- Create through managed Codex implementation: `src/game/`, `src/economy/`, `src/ui/`, `tests/`, `e2e/`.
- Modify when defects are found: only the StagePass files proven responsible by the reproduction.
- Create per StagePass defect: `docs/superpowers/specs/2026-07-24-fishing-e2e-${FISHING_ISSUE_SLUG}-design.md`.
- Create per StagePass defect: `docs/superpowers/plans/2026-07-24-fishing-e2e-${FISHING_ISSUE_SLUG}.md`.

### Task 1: Establish isolated test authority

**Files:**
- Create: `${FISHING_REPO_PATH}/README.md`
- Create: `${FISHING_REPO_PATH}/.gitignore`
- Create: `${FISHING_RUN_ROOT}/evidence/run.json`

- [ ] **Step 1: Allocate a run ID and fail closed on collision**

Use a UUID run ID. From the StagePass repository root, set:

```bash
FISHING_RUN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
FISHING_RUN_ROOT="$PWD/.stagepass/e2e/fishing-master-commercial-$FISHING_RUN_ID"
FISHING_REPO_PATH="$FISHING_RUN_ROOT/repo"
FISHING_DB_PATH="$FISHING_RUN_ROOT/ship.db"
```

Abort if `FISHING_RUN_ROOT` already exists; never delete or reuse a prior run.

- [ ] **Step 2: Create a minimal target repository**

Create `README.md`:

```markdown
# 捕鱼达人商业版

StagePass 端到端商业游戏样例。目标是验证从复杂产品意图到实现、审核、QA 和交付的完整控制面。

本地演示不接入真实支付、不销售虚拟货币，也不收集真实用户数据。
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
playwright-report/
test-results/
.env*
```

- [ ] **Step 3: Initialize and commit the baseline**

Run:

```bash
git init
git add README.md .gitignore
git commit -m "chore: initialize fishing commercial demo"
```

Expected: clean repository with one baseline commit.

- [ ] **Step 4: Create the run evidence manifest**

Write:

```json
{
  "schemaVersion": "stagepass.fishing-commercial-e2e/v1",
  "runId": "$FISHING_RUN_ID",
  "projectName": "捕鱼达人商业版",
  "repoPath": "$FISHING_REPO_PATH",
  "databasePath": "$FISHING_DB_PATH",
  "issues": [],
  "status": "initialized"
}
```

After resolving the four variables, use `apply_patch` to write their exact printed values rather than the literal `$FISHING_*` strings.

### Task 2: Start StagePass with the exact Desktop boundary

**Files:**
- Create: `${FISHING_RUN_ROOT}/runtime.log`

- [ ] **Step 1: Run bridge preflight**

Verify:

- official `/Applications/ChatGPT.app` signature and Team ID `2DC432GLL2`;
- Desktop follower discovery succeeds;
- `stagepass-card@personal` is installed and enabled;
- plugin card new-task verification from the native-style plan passed.

Any failure blocks E2E progress and must not be downgraded to a warning.

- [ ] **Step 2: Migrate the isolated database**

Run with only the run-specific DB path:

```bash
STAGEPASS_DB_PATH="$FISHING_DB_PATH" pnpm db:migrate
```

Expected: migrations succeed and only the isolated database is created.

- [ ] **Step 3: Start StagePass**

Run:

```bash
STAGEPASS_DB_PATH="$FISHING_DB_PATH" \
STAGEPASS_CODEX_DESKTOP_BRIDGE=on \
STAGEPASS_MCP_INTERACTIONS=on \
STAGEPASS_CODEX_DECISION_SURFACE=on \
STAGEPASS_CODEX_DECISION_PHASES=PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge \
pnpm dev
```

Expected: `/api/health` returns success, the worker is running, and `/projects` loads.

- [ ] **Step 4: Capture initial browser evidence**

Use a real browser to open `/projects`; record screenshot, console errors, failed network requests and initial project count in the run evidence directory.

### Task 3: Create the commercial fishing project through Web

**Files:**
- Modify: isolated SQLite authority only through StagePass Web/API.
- Create: `${FISHING_RUN_ROOT}/evidence/project-created.json`

- [ ] **Step 1: Create the Project with real browser clicks**

On `/projects`, click `New Project` and submit:

```text
Project Name: 捕鱼达人商业版
Repository Path: the exact value printed by `printf '%s\n' "$FISHING_REPO_PATH"`
```

Do not create it by direct SQL.

- [ ] **Step 2: Verify Project persistence**

Reload `/projects`, reopen the project, and record Project ID, displayed repository path and URL. Confirm the Project survives a page reload.

- [ ] **Step 3: Verify reusable Project tasks**

Start or reuse the real Project Context and Project PRD Codex tasks. Record:

- Project name and Project ID;
- task titles;
- thread IDs;
- materialization turn IDs;
- sidebar presence.

An empty shell without a completed turn is a failure.

### Task 4: Define the complex commercial product intent

**Files:**
- Modify through StagePass: Project PRD and first Change.
- Create: `${FISHING_RUN_ROOT}/evidence/product-intent.md`

- [ ] **Step 1: Enter the product intent**

Use this exact intent in the StagePass PRD surface:

```markdown
构建一个可本地运行、响应式的“捕鱼达人商业版”Web 游戏。核心玩法是鼠标或触控瞄准、发射炮弹、命中不同鱼类并结算金币；包含普通鱼、稀有鱼、Boss、连击、炮台等级、能量、每日任务、签到、限时活动、背包、图鉴和仅使用演示货币的商店。需要新手引导、暂停/恢复、音效开关、降低动态效果、中文界面、本地存档和数据重置。商业化只做沙盒经济与转化漏斗演示，不接真实支付、不采集真实个人信息、不使用赌博式概率购买。游戏引擎必须可确定性测试，Canvas 渲染与经济规则分离；提供 Vitest 单元测试、Playwright 关键旅程测试和生产构建。
```

- [ ] **Step 2: Complete PRD briefing in the real Project PRD task**

Require the Codex task to resolve:

- target user and session length;
- deterministic fish spawning and collision rules;
- coin sinks/sources and anti-negative-balance invariants;
- Boss and event success criteria;
- accessibility and reduced-motion behavior;
- local persistence schema and reset behavior;
- explicit non-goals for payment, accounts, ads and live backend.

Record every real turn and any MCP decision card.

- [ ] **Step 3: Create one Change**

Create:

```text
实现捕鱼达人商业版完整本地可玩垂直切片
```

Record Change ID and the newly bound persistent Codex task/thread ID.
Set `FISHING_CHANGE_ID` to that exact returned Change ID before constructing any review task title.

### Task 5: Run every StagePass gate

**Files:**
- Create through managed turns: StagePass artifacts and target repository implementation.
- Create: `${FISHING_RUN_ROOT}/evidence/stages.jsonl`

- [ ] **Step 1: Run PRD and Intake**

Use browser controls to start the stage. Wait for the real Desktop turn. Require fresh artifacts and a visible terminal status before advancing.

- [ ] **Step 2: Run Spec and Tech Spec**

Require the spec to define:

```ts
type FishKind = "small" | "school" | "rare" | "boss";
type SessionState = "tutorial" | "playing" | "paused" | "settled";
interface EconomyState {
  coins: number;
  energy: number;
  cannonLevel: number;
  dailyMissionProgress: number;
}
```

Require deterministic seeded spawning, collision contracts, persistence versioning and no-negative-balance invariants.

- [ ] **Step 3: Run Plan and Test Plan**

The Plan must separate:

- deterministic game engine;
- Canvas renderer and input adapter;
- economy and progression;
- UI overlays and accessibility;
- persistence;
- unit and browser tests.

The Test Plan must cover tutorial completion, fish hit/miss, Boss settlement, insufficient coins, persistence reload, reset, reduced motion, touch controls and production build.

- [ ] **Step 4: Run Build**

The implementation turn must operate in the bound Codex task and target repository. Record worktree/cwd, model, reasoning effort, turn ID, changed files, test commands and commit.

- [ ] **Step 5: Run independent Review and Fix loops**

Use two independent persistent Codex review tasks:

```text
[捕鱼达人商业版][SPEC REVIEW] ${FISHING_CHANGE_ID}
[捕鱼达人商业版][QUALITY REVIEW] ${FISHING_CHANGE_ID}
```

Spec review runs first. Quality review starts only after spec review passes. Findings return to the original fix task; after changes, both applicable reviews rerun.

- [ ] **Step 6: Run QA, Merge, Retro and Done**

QA must execute target repository tests and real browser journeys. Merge/adoption must preserve exact source SHA. Retro must list remaining risks without reclassifying blockers as follow-ups.

### Task 6: Defect interception protocol

**Files:**
- Create per defect: `${FISHING_RUN_ROOT}/evidence/issues/${FISHING_ISSUE_NUMBER}/`
- Create per StagePass code defect: one design spec and one implementation plan under `docs/superpowers/`.

- [ ] **Step 1: Freeze workflow advancement**

On any incorrect UI, stale state, missing Desktop task, missing turn, wrong artifact, timeout, duplicate action, confusing control or dead feature, stop the current business stage.

- [ ] **Step 2: Reproduce with a real browser**

Save:

- starting URL and exact clicks;
- screenshot before and after;
- console/network evidence;
- expected versus actual behavior;
- affected Project/Change/stage IDs.

- [ ] **Step 3: Create three visible Desktop tasks**

Set `FISHING_ISSUE_NUMBER` to the next zero-padded issue sequence, set `FISHING_ISSUE_TITLE` to the exact short title recorded by the reproduction, and set `FISHING_ISSUE_SLUG` to its lower-case hyphenated form. Persist all three values in the issue evidence directory before creating tasks.

Use:

```text
[FISHING E2E][FIX-${FISHING_ISSUE_NUMBER}] ${FISHING_ISSUE_TITLE}
[FISHING E2E][SPEC-REVIEW-${FISHING_ISSUE_NUMBER}] ${FISHING_ISSUE_TITLE}
[FISHING E2E][QUALITY-REVIEW-${FISHING_ISSUE_NUMBER}] ${FISHING_ISSUE_TITLE}
```

Each must be in the StagePass Project context, have a thread ID, appear in the sidebar and produce a real turn.

- [ ] **Step 4: Repair with TDD**

The fix task first adds a failing regression test, runs it red, applies the minimum fix, runs focused and related tests, and commits only relevant files.

- [ ] **Step 5: Run both reviews**

Spec review verifies the reproduction and expected behavior. Quality review verifies correctness, simplicity, security, recovery and test coverage. Any rejection returns to the original fix task.

- [ ] **Step 6: Regress with the real browser**

Repeat the original click path and save new screenshots plus console/network results.

- [ ] **Step 7: Close only with complete evidence**

Require:

- Project name;
- fix task name/thread ID/turn IDs;
- spec review task name/thread ID/turn IDs;
- quality review task name/thread ID/turn IDs;
- browser reproduction and regression;
- test commands/results;
- commit SHA.

If one field is missing, record `代码已修改、桌面端未验收` instead of `完成`.

### Task 7: Evidence-driven deletion

**Files:**
- Modify only components proven redundant during the E2E run.
- Test corresponding UI or service contract.

- [ ] **Step 1: Qualify a deletion**

Delete only when one of these is proven:

- duplicate control performs the same command;
- legacy control bypasses the Codex-native boundary;
- preview exposes an action that cannot safely execute;
- dead component has no route, import or test consumer;
- text or control repeatedly causes the operator to choose the wrong stage.

- [ ] **Step 2: Record pre-deletion evidence**

Save browser evidence, repository references from `rg`, affected tests and the intended surviving path.

- [ ] **Step 3: Delete in an isolated fix loop**

Use the same three Desktop tasks and two-review protocol as Task 6. Add or update a test that proves the surviving path remains available.

- [ ] **Step 4: Verify absence and replacement**

Use browser regression and `rg` to prove the deleted surface is gone and the intended path remains.

### Task 8: Final commercial-release audit

**Files:**
- Create: `${FISHING_RUN_ROOT}/evidence/final-report.md`

- [ ] **Step 1: Run StagePass repository verification**

Run:

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm test:acceptance
pnpm build
```

Record exact pass/fail counts and durations.

- [ ] **Step 2: Run target repository verification**

Run in the fishing repository:

```bash
pnpm lint
pnpm test
pnpm exec playwright test
pnpm build
```

Record exact output and final commit SHA.

- [ ] **Step 3: Perform final browser journeys**

Verify:

- new game and tutorial;
- aim/fire/hit/settle;
- Boss encounter;
- shop with demo currency;
- insufficient-balance rejection;
- daily mission progression;
- reload persistence;
- reduced motion;
- mobile viewport;
- reset data.

- [ ] **Step 4: Audit Desktop evidence**

List every Project, task name, thread ID, real turn ID, review outcome and MCP card. Verify the final Change task remains visible and persistent.

- [ ] **Step 5: Classify the result**

Use exactly one:

- `完整验收` — all gates, two reviews, Desktop tasks, tests and browser journeys passed.
- `代码已修改、桌面端未验收` — code exists but any Desktop/review evidence is missing.
- `阻断` — a safety, bridge, data-authority or release-blocking issue remains.

Do not use a softer label to conceal missing evidence.
