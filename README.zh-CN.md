# StagePass

[English](README.md) · **简体中文**

StagePass 是一套本地运行、深度融合 Codex 的软件交付控制面。它把一个 Change 从需求推进到交付，并用阶段、证据、审查、人工决策和可恢复执行约束全过程。

Web 是运营总控；真实工作在 Codex Desktop 的持久 task 中执行；StagePass MCP App 在同一个 task 中呈现人工决策卡；StagePass Server 是流程状态、命令、幂等、审计和恢复的唯一权威。

> 当前状态：开发者预览版。生产构建与 Codex-native 边界测试已经通过，但正式发布前仍需针对目标 Codex Desktop 精确版本完成 Phase 0 真实客户端验证。

## Codex-native 版本的核心变化

- 每个 Change 对应一个持久、可复用的 Codex task。
- 每个 Project 另有一个 Project PRD task 和一个 Project Context task。
- Codex app-server 负责创建、命名、列出和读取持久 task shell。
- 只有 Codex Desktop follower IPC 可以启动或中断受管 turn。
- 批准、拒绝、接受风险、采纳 Build/Fix 等人工决定在绑定 task 的 StagePass MCP App 中完成。
- Web 只保留状态、证据、健康度、设置、start/retry、interrupt 和 recover 等运营能力。
- StagePass 不再提供 Git 初始化、暂存、提交、推送或远端管理 UI；这些操作直接使用 Codex 或你原有的 Git 工具。
- SQLite 是业务权威，`.ship/` 文件只是可读镜像和审计材料。

## 架构

```text
                               ┌────────────────────────────┐
                               │ 持久 Codex task            │
                               │ 执行工作 + MCP 决策卡      │
                               └─────────────┬──────────────┘
                                             │
                       follower IPC / Host ui/message / task 读取
                                             │
┌──────────────────┐       命令         ┌────▼───────────────────┐
│ StagePass Web    ├────────────────────► StagePass Server        │
│ 运营与总控       │◄────────────────────┤ 唯一流程与命令权威     │
└──────────────────┘     状态与证据      └────┬──────────┬───────┘
                                              │          │
                                   app-server │          │ SQLite
                                   shell/read │          │ 权威数据
                                              ▼          ▼
                                         持久 task   状态、审计、
                                         shell       幂等与恢复
```

关键边界：

- app-server 只管理持久 shell、读取 turn、列出模型；
- app-server 不启动 StagePass managed turn；
- Desktop follower IPC 只能在 durable fenced attempt 已写入后启动 turn；
- Web 与 MCP 共用同一个 Server 命令网关；
- ambiguous attempt 只能只读对账或隔离，不能再次 dispatch。

完整设计见 [Codex-native 架构说明](docs/superpowers/specs/2026-07-23-codex-native-control-plane-design.md)。

## 工作流

```text
PRD → Spec → Tech Spec → Plan → Test Plan
    → Build → Review → Fix → QA → Merge → Retro → Done
```

Codex 负责产出候选结果和执行工作；StagePass 负责记录事实、验证新鲜度、计算 gate，并把只能由人类完成的决定呈现出来。

P0 阻断且不可豁免。P1 阻断，除非人类明确接受风险并填写理由。卡片过期、gate 版本漂移、源数据 hash 变化或 task 绑定不匹配时，系统都会 fail closed。

## 运行要求

- macOS，已安装、启动并登录 Codex Desktop
- Node.js 20 或更高版本
- pnpm
- 每个 Project 对应一个已经存在的本地 Git 仓库

Hybrid Bridge 使用受能力探测和版本门禁保护的 Codex Desktop 私有接口。当前支持的精确版本指纹记录在[设计文档](docs/superpowers/specs/2026-07-23-codex-native-control-plane-design.md)中。未验证版本会被拒绝，而不是静默降级。

## 快速开始

```bash
git clone https://github.com/PenceZHR/stagepass.git
cd stagepass
pnpm install
cp .env.example .env
```

在 `.env` 中开启 Codex-native 能力：

```dotenv
STAGEPASS_CODEX_DESKTOP_BRIDGE=on
STAGEPASS_MCP_INTERACTIONS=on
STAGEPASS_CODEX_DECISION_SURFACE=on
STAGEPASS_CODEX_DECISION_PHASES=PRD,Intake,Spec,TechSpec,Plan,TestPlan,Build,Fix,Review,QA,Merge
```

构建 MCP App 并启动 StagePass：

```bash
pnpm db:migrate
pnpm mcp:build
pnpm dev
```

打开 [http://localhost:3000/projects](http://localhost:3000/projects)，创建 Project，并填写一个已经存在的本地 Git 仓库绝对路径。

`mcp:start` 只用于 Codex Host 认证后的启动。任意终端直接运行时，因为拿不到继承的 broker channel 和 Host evidence，会按设计 fail closed。

## 配置

| 变量 | 用途 |
|---|---|
| `STAGEPASS_CODEX_DESKTOP_BRIDGE` | 值为 `on` 时开启 Desktop bridge 持久 task 执行。 |
| `STAGEPASS_MCP_INTERACTIONS` | 值为 `on` 时开启 MCP 人工交互卡。 |
| `STAGEPASS_CODEX_DECISION_SURFACE` | Codex 人工决策面的总开关。 |
| `STAGEPASS_CODEX_DECISION_PHASES` | 严格的阶段 allowlist；空 token 或未知阶段会 fail closed。 |
| `STAGEPASS_CODEX_BIN` | 可选，app-server shell/read 使用的 Codex binary 路径。 |
| `STAGEPASS_DB_PATH` | 可选，SQLite 路径；默认 `server/db/ship.db`。 |
| `STAGEPASS_LOG_DIR` | 可选，运行日志目录。 |

所有 Codex-native 开关只有字面量 `on` 才表示开启。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 启动 Next.js、迁移和 pipeline worker。 |
| `pnpm build` | 构建生产版本 Web。 |
| `pnpm start` | 启动生产 Web 服务。 |
| `pnpm test` | 运行隔离的单元测试。 |
| `pnpm test:acceptance` | 运行真实进程和恢复类重型验收。 |
| `pnpm lint` | 对源码运行 ESLint。 |
| `pnpm exec tsc --noEmit` | TypeScript 类型检查。 |
| `pnpm mcp:build` | 构建 StagePass MCP Server 与 App UI bundle。 |
| `pnpm test:phase0-verifier` | 运行 Phase 0 bridge contract 测试。 |

真实客户端发布验证器必须读取明确的证据文件，不会输出伪造 PASS：

```bash
STAGEPASS_REAL_CODEX_NATIVE_E2E_EVIDENCE=/absolute/path/evidence.json \
  node --import tsx scripts/verify-codex-native-e2e.ts
```

没有真实客户端证据时，它会以 skip/fail-closed 状态退出。

## 目录

| 路径 | 职责 |
|---|---|
| `app/` | Next.js 运营总控和 HTTP API。 |
| `server/` | 流程权威、SQLite/Drizzle、Codex bridge、命令网关、恢复和证据服务。 |
| `mcp/` | StagePass MCP server、supervisor、签名器和交互 App UI。 |
| `scripts/` | 开发、构建、迁移、bridge 验证和 E2E 工具。 |
| `docs/` | 产品需求、架构、迁移计划和后续加固项。 |
| `spikes/` | 作为兼容性证据保留的自包含 bridge 实验。 |

## 安全模型

- Server-owned logical turn 防止调用方指定任意 task 或 slot。
- 每次外部 follower start 前都必须有 durable prepared/dispatching attempt。
- dispatch、settlement 和 recovery 前都会重新读取 canonical task binding。
- 已知 turn 暂时不可见时只读等待，不推进 cursor，也不启动第二个 turn。
- ambiguous dispatch 只能通过 app-server snapshot 对账或隔离。
- Build 继续在受控 worktree 中隔离；StagePass 只保留仓库证据和内部 adoption versioning，不再提供 Git 操作界面。
- MCP 决策提交绑定 interaction、command、来源 task、nonce 和 Host 认证传输。

## 文档

- [实际产品需求](docs/STAGEPASS-ACTUAL-REQUIREMENTS.md)
- [Codex-native 架构](docs/superpowers/specs/2026-07-23-codex-native-control-plane-design.md)
- [迁移实施计划](docs/superpowers/plans/2026-07-23-codex-native-control-plane-migration.md)
- [后续加固清单](docs/superpowers/plans/2026-07-23-codex-native-control-plane-migration-followups.md)

## 本地文件

不要提交本地数据库、`.env`、`.next/`、MCP 构建产物、运行日志或宿主机专用的 plugin/agent bundle。具体见 [`.gitignore`](.gitignore)。

## License

[MIT](LICENSE)
