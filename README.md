# stagepass

> 把一句需求，押着走完一条真正的软件工程流程。本地优先，每一关都由你拍板。
>
> *A local-first Stage-Gate pipeline that walks you — and your AI — through real software delivery. You approve every gate.*

---

## 这是给谁的

**给想用 AI 写代码、但没受过工程训练的人。**

Codex 和 Claude Code 已经很能写代码了。真正的问题是：如果你没走过正规的开发流程，你**看不出它在哪里糊弄了你**——需求哪里还含糊、验收标准缺了哪条、这个技术方案埋了什么坑。你只能看着它吐出一大段代码，然后点一下"看起来不错"。

stagepass 做的是另一件事：**它不替你写代码，它替你把流程走对。**

你给一句需求，它押着你和 AI 一起走完 12 个阶段，在每个关键路口停下来等你拍板。走完一遍，这条流程你就学会了；而 AI 在这条流程里跑不掉、瞒不住、崩了能捞回来。

> 这套"分阶段推进、每个阶段之间设一道人工决策点"的方法论叫 **Stage-Gate**，是产品开发界用了几十年的成熟流程。stagepass 没有发明什么新规矩，只是把它套在了 AI 编码上——所以你学到的是真行业流程，不是某个工具编出来的玩法。

---

## 和直接用 Codex / Claude Code 有什么不同

直接用 CLI，你得到的是**一个 AI 写代码，然后告诉你它写完了**。

stagepass 给你的是**第二个 AI，它唯一的职责是证明第一个 AI 错了**——外加一整套不允许任何一方给自己打分的流程。

### 1. 你是红方。不是旁观者，是裁决者

这不是宣传语，是写死在 prompt 里的硬约束（`server/templates/prompts/spec.md`）：

> 红方只指人类用户本人，也就是需求源头和最终裁决者。
> 你不是红方本人，而是服务红方的我方执行代理。
> 反方负责质询、挑刺和复核。

写规格的 AI（`SPEC_WRITER`）是**你的**执行代理。另有一个反方 AI（`REQUIREMENT_CRITIC`）专职挑它的刺。裁决权只在你手里——反方 AI 的 prompt 里甚至明确写死了一句：**"你不能批准 PRD；锁定只能由人类执行"**。

对新手来说这才是关键：你不需要自己就能看出需求里的坑，**有个 AI 专门负责把坑指给你看**，你只需要拍板。

### 2. 规格要过对抗，默认 3 轮

Spec 阶段不是"AI 写完规格就下一步"，而是一轮轮打（默认 3 轮，可设 1–5 轮）：

- `SPEC_WRITER` 产出 PRD delta，并对上一轮的缺口给出"我已修复"的声明；
- `REQUIREMENT_CRITIC` **必须先复核旧缺口，才准提新问题**，逐条给出结论（已解决 / 仍未解决 / 已降级 / 需人工决策），再输出新发现的需求缺口。

缺口分三级，规则是硬的：**P0 阻断且不可豁免**；**P1 阻断，但你可以人工豁免**；**P2 不阻断，但必须摆到你面前**。

在这之前还有一道 **PRD Briefing（简报室）**：反方 AI 先对你的需求本身发起质询，最多 7 张"疑点卡"（critical / important / optional）。被你暂缓的问题不会消失——它们必须被写进 PRD delta 的"人工门"章节，**不允许静默忽略**。

### 3. AI 不能给自己打分

- **战报是算出来的，不是 AI 写的。** Spec 战报（`spec-report.md` / `war-report.md`）由确定性代码依据 DB 里的对抗记录生成，不是让 AI 自评"我觉得我做得不错"。
- **报告过期就不给批准。** 战报按源数据 hash 判新鲜度，源数据变了报告即 `stale`，批准按钮直接不可用。
- **旧问题默认仍然有效。** Review 阶段的硬规则是 `prior blocker remains authoritative`——上一轮的阻断项如果没被显式复核，默认它**还在**。AI 没法靠"忘了提"来蒙混过关。

### 4. 门禁防的不只是 AI，还有你手滑

每次放行，服务端都会拿你界面上那份契约快照和 DB 里重算的结果对三样东西（`server/services/preflight-service.ts`）：

| 校验 | 漂移时报错 | 防的是 |
|---|---|---|
| `gateVersion` | `gate_version_drift` | 门禁判定在你点击前被重算过 |
| `sourceDbHash` | `source_db_hash_drift` | 判定所依据的 DB 数据变了 |
| git `HEAD` | `git_head_drift` | 界面渲染后仓库 HEAD 动过 |

也就是说：**你不可能基于一个已经过期的界面状态点下放行。** 页面开着放了一小时、期间后台状态变了，点下去会被挡住，而不是默默按旧状态执行。

### 5. Build 不碰你的工作区

Build 阶段 AI 不在你的仓库里写文件，而是在**仓库的兄弟目录**：

```text
<你的仓库的父目录>/.stagepass-workspaces/<仓库名>/<changeId>/build-<次数>/
```

由 `git worktree add` 基于指定基线创建独立分支，产出以 patch 回流。你的主 checkout 全程不被触碰。路径层面禁 symlink、双重 realpath 越界检查，跑飞了也逃不出隔离区。

### 6. 双引擎真平级，且崩得掉、捞得回

Codex CLI 和 Claude Code **都是本地 spawn 的真进程**，都强制要求拿到真实 pid（拿不到就自杀并报错），都写进同一张进程表、进同一套恢复扫描。没有二等公民——这是刻意做的，代码注释里留着原因：

> Codex 原先用 `@openai/codex-sdk`，那个 SDK 把子进程封死（不暴露 pid、只给 AbortSignal）。自己 spawn 才能拿到真实 pid + 身份 + 信号控制，让 codex 和 claude 进同一套生命周期/恢复机制，而不是当那个 `pid === null` 的二等公民。

崩溃恢复由流水线 worker 的定时 sweep 负责（默认 15 秒一轮）：心跳超 45 秒判定失联，探活 pid，必要时 SIGTERM → SIGKILL，**终止前会二次确认进程所有权和身份没变**，然后把 run/job 置为失败、provider 置为 orphaned。杀掉 AI 进程、关掉终端、重启机器，业务状态都能自己收敛。

### 7. DB 是裁判，文件只是镜像

SQLite 是唯一的业务权威。`.ship/` 目录下的 JSON / Markdown 只是给你和 AI 看的镜像与审计材料——它们和 DB 不一致时，**以 DB 为准**。

---

## 12 个阶段 · 4 道正式门禁

```text
Refine → PRD → Spec → Tech Spec → Plan → Test Plan
       → Build → Review → Fix → QA → Merge → Retro
```

| 阶段 | AI 产出什么 | 你要做什么 |
|---|---|---|
| **Refine** | —（纯你自己描述需求） | 用大白话说清楚你想要什么 |
| **PRD** | 追问 → 草稿 → 终审；简报室质询 | 🚦 **Intake Gate**：批准 PRD／退回 |
| **Spec** | 红蓝对抗产出 PRD delta + 缺口清单 | 🚦 **Spec Gate**：批准／退回／再打一轮／豁免 P1 |
| **Tech Spec** | 技术方案 delta | 🚦 **Tech Spec Gate**：批准／退回 |
| **Plan** | 作战计划：预期改哪些文件、禁止碰哪些、分几步 | 批准作战计划 |
| **Test Plan** | 测试用例 | 确认测试计划 |
| **Build** | 在隔离 worktree 里写代码 | 收编本轮施工／拒绝本轮施工 |
| **Review** | P0／P1／P2 findings，P0/P1 必须给出修复方案 | 看 findings，决定放不放 |
| **Fix** | 修复阻断项 | 同上 |
| **QA** | QA 记录 | 同上 |
| **Merge** | 就绪检查（QA／Review／Docs／Requirements） | 🚦 **Merge Gate**：批准 Merge／打回 |
| **Retro** | Release note + 复盘 | 收下 |

**打回重做**分两种：

- **Rework（打回本阶段重做）**只在 **Refine / Plan / Test Plan / Build / Fix** 这些产出文档的阶段可用（内部另含 `Implement` / `Check` 两个执行态）。
- **Intake / Spec / Tech Spec / Review / Merge / Retro 没有 rework 路径**——要退回得走 gate 的驳回按钮，它会把状态退到上一个关卡。

---

## 环境要求

| 依赖 | 要求 |
|---|---|
| Node.js | ≥ 20（开发于 25） |
| pnpm | 已安装（`npm i -g pnpm`） |
| 端口 | `3000` 空闲 |
| **OpenAI Codex CLI** | 自行安装并登录；默认引擎 |
| **Claude Code** | 随依赖 `@anthropic-ai/claude-code` 装好，只需配置鉴权（`ANTHROPIC_API_KEY` 或 `claude` 登录） |

> 两个引擎**至少要有一个**可用。新建项目时可以逐项选择用哪个。

---

## 快速开始

```bash
git clone https://github.com/PenceZHR/stagepass.git && cd stagepass
pnpm install
pnpm dev            # 启动 Next + 流水线 worker（自动跑 db 迁移）
```

打开 <http://localhost:3000> → 进入 **/projects** → **新建项目**：

- **名称**：随意
- **仓库路径 (repoPath)**：你要让流水线操作的**本地仓库绝对路径**。该目录必须已存在，且**还没有** `.ship/` 目录。

创建后 stagepass 会在那个仓库里 scaffold 一个 `.ship/` 目录，并用 AI 分析代码库生成 baseline 文档。

> **你唯一必须"改"的东西就是把项目指向你自己的仓库路径**，其余开箱即用。

也可以直接调 API 注册项目（适合脚本化）：

```bash
curl -X POST http://localhost:3000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-app","repoPath":"/absolute/path/to/your/repo","gitEnabled":true}'
```

### 不想手动配？把这段贴给 AI

在**克隆好的仓库目录里**，把下面这段贴给 Claude Code（或任意能跑命令的编码 agent）：

```text
你在帮我在本机搭建并运行 "stagepass"（一个本地 Next.js 的 AI 开发流水线控制台）。请按步骤执行，只有某步真的失败时才停下来问我：
1. 确认 Node ≥ 20、pnpm 已安装（缺 pnpm 就 `npm i -g pnpm`）。
2. 依次运行 `pnpm install`、`pnpm db:migrate`。
3. 确认 AI 引擎 CLI 可用且已登录（至少一个）：
   - Codex：跑 `codex --version`；缺失就按 OpenAI Codex CLI 文档安装并登录；若不在 PATH，提示我设置 `export STAGEPASS_CODEX_BIN=<路径>`。
   - Claude Code：随 `@anthropic-ai/claude-code` 依赖已装好，确认鉴权（`ANTHROPIC_API_KEY` 或 `claude` 登录）。
4. 确认 3000 端口空闲，运行 `pnpm dev`，并验证 http://localhost:3000/api/health 返回 {"ok":true}。
5. 提示我打开 http://localhost:3000/projects 新建项目，把 repoPath 填成我要处理的仓库绝对路径。
把你做了什么、以及还需要我手动做什么（例如给某个 CLI 登录）都清楚地告诉我。
```

---

## 怎么用

1. **建项目** → 指向你的本地仓库，等 baseline 生成完。
2. **建一个 Change**（一次改动 = 一条流水线）。
3. **Refine**：用大白话描述你想要什么。这一步没有 AI 动作，就是你说话。
4. **PRD**：AI 追问你、写草稿；简报室的反方 AI 会对你的需求发起质询（最多 7 张疑点卡）。看完 → 过 **Intake Gate**。
5. **Spec**：红蓝对抗默认打 3 轮。看缺口清单：P0 必须解决，P1 你可以豁免，P2 至少得看一眼。不满意就点"继续对抗一轮"。满意 → 过 **Spec Gate**。
6. **Tech Spec → Plan → Test Plan**：技术方案、作战计划（会明确列出预期改哪些文件、禁止碰哪些）、测试用例。逐个确认。
7. **Build**：AI 在隔离 worktree 里施工。你可以收编，也可以拒绝本轮。
8. **Review → Fix → QA**：findings 分 P0/P1/P2，阻断项没清干净过不了。
9. **Merge Gate**：就绪检查全绿才放行。
10. **Retro**：收下 release note 和复盘。

全程每个阶段的**产出文件都是可点击的**——变更文件、计划、Spec 战报、审查发现，点开即看内容，不用自己去翻目录。

---

## 配置

所有配置都是**可选**的环境变量，默认值开箱即用。需要时在启动前 `export`（Next 与 worker 都会继承你的 shell 环境），可参考 [`.env.example`](.env.example)：

| 变量 | 默认 | 用途 |
|---|---|---|
| `STAGEPASS_CODEX_BIN` | `codex`（走 PATH） | codex 二进制路径（不在 PATH 时才需设置） |
| `ANTHROPIC_API_KEY` | 无 | Claude Code 鉴权（或改用 `claude` 登录） |
| `STAGEPASS_DB_PATH` | `server/db/ship.db` | 本地 SQLite 业务库位置 |
| `STAGEPASS_LOG_DIR` | 仓库内默认日志目录 | 日志目录 |
| `PIPELINE_WORKER_RECOVERY_SWEEP_MS` | `15000` | 崩溃恢复扫描间隔 |

一次性导出：

```bash
cp .env.example .env      # 按需填写
set -a && source .env && set +a && pnpm dev
```

> 还有一批 `STAGEPASS_*` 超时/内部旋钮（见代码），正常不用动。

---

## 常用命令

```bash
pnpm dev              # 开发：Next + 流水线 worker（含自动迁移）
pnpm build            # 生产构建
pnpm test             # 单元测试
pnpm test:acceptance  # 重型验收测试（会真起服务/进程）
pnpm lint             # ESLint
```

---

## 结构与文档

- `app/` — Next 前端 + API 路由
- `server/` — 服务层、SQLite + Drizzle schema、流水线执行、AI 引擎适配
- `server/templates/prompts/` — 各阶段和红蓝双方的 prompt 模板
- `scripts/` — 开发监督进程 / 流水线 worker / 迁移脚本
- 架构与逐文件说明见 [`docs/ship/`](docs/ship/)（`architecture.md` · `file-guide.md` · `tech-stack.md`）

---

## 本地文件（勿提交）

- 运行时 SQLite 库在 `server/db/ship.db`（连同 `-wal` / `-shm` sidecar 一并忽略）。不要提交 `dev.db`、`server/db/db.sqlite`、`server/db/ship.db*`。
- Build 隔离区在仓库的兄弟目录 `.stagepass-workspaces/`，不在版本控制内。
- 不要提交临时截图 `tmp-review-*.png`、`tmp-user-flow-*.png`、`tmp-spec-battle-*.png`。
- 生成的产物与本地运行态一律挡在 git 外，除非有意提升为项目文档。
