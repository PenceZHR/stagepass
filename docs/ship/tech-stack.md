# CC-AI 技术栈

## 一、运行时与语言

| 技术 | 版本 | 用途 |
|---|---|---|
| TypeScript | ^5 | 主要编程语言 |
| Node.js | ≥20 (运行时) | 服务端运行时 |
| tsx | ^4.22.4 | TypeScript 执行器和测试运行器 |

## 二、框架

| 依赖 | 版本 | 用途 |
|---|---|---|
| Next.js | 16.2.9 | 全栈应用框架（App Router + API Routes） |
| React | 19.2.4 | UI 库 |
| React DOM | 19.2.4 | React DOM 渲染 |

## 三、数据库与 ORM

| 依赖 | 版本 | 用途 |
|---|---|---|
| better-sqlite3 | ^12.11.1 | SQLite 数据库驱动（同步 API, WAL 模式） |
| drizzle-orm | ^0.45.2 | TypeScript ORM（Schema 定义、查询构建） |
| drizzle-kit | ^0.31.10 | Drizzle 迁移工具（开发依赖） |
| @types/better-sqlite3 | ^7.6.13 | TypeScript 类型定义 |

## 四、AI 引擎

| 依赖 | 版本 | 用途 |
|---|---|---|
| codex CLI（bare-spawn） | — | Codex AI 引擎：直接 spawn `codex exec --json` 二进制（非 npm 依赖；路径由 STAGEPASS_CODEX_BIN 或 PATH 解析） |
| @anthropic-ai/claude-code | ^2.1.181 | Claude Code CLI 引擎 |

## 五、UI 与样式

| 依赖 | 版本 | 用途 |
|---|---|---|
| @base-ui/react | ^1.5.0 | 基础 UI 组件库 |
| shadcn | ^4.11.0 | UI 组件库（button, card, dialog, input, label, alert-dialog） |
| lucide-react | ^1.20.0 | 图标库 |
| tailwindcss | ^4 | CSS 工具类框架 |
| @tailwindcss/postcss | ^4 | Tailwind CSS PostCSS 插件 |
| class-variance-authority | ^0.7.1 | CSS 变体管理（CVA） |
| clsx | ^2.1.1 | 类名拼接工具 |
| tailwind-merge | ^3.6.0 | Tailwind 类名合并（避免冲突） |
| tw-animate-css | ^1.4.0 | Tailwind 动画扩展 |

## 六、数据校验与类型

| 依赖 | 版本 | 用途 |
|---|---|---|
| zod | ^4.4.3 | Schema 声明和运行时数据校验 |

## 七、日志

| 依赖 | 版本 | 用途 |
|---|---|---|
| pino | ^10.3.1 | 结构化日志（低开销） |
| pino-pretty | ^13.1.3 | 开发环境日志美化 |

## 八、测试

| 依赖 | 版本 | 用途 |
|---|---|---|
| tsx | ^4.22.4 | 测试运行器（`tsx --test`） |
| @playwright/test | ^1.61.1 | E2E 浏览器自动化测试 |

## 九、构建与工具

| 依赖 | 版本 | 用途 |
|---|---|---|
| TypeScript | ^5 | 类型检查 |
| ESLint | ^9 | 代码质量检查 |
| eslint-config-next | 16.2.9 | Next.js ESLint 规则集 |
| tsx | ^4.22.4 | 执行 TS 文件（devDependencies） |
| @types/node | ^20 | Node.js 类型定义 |
| @types/react | ^19 | React 类型定义 |
| @types/react-dom | ^19 | React DOM 类型定义 |

## 十、配置文件

| 文件 | 用途 |
|---|---|
| `package.json` | 依赖管理、脚本定义（pnpm） |
| `pnpm-workspace.yaml` | pnpm workspace 配置 |
| `tsconfig.json` | TypeScript 编译配置 |
| `next.config.ts` | Next.js 配置 |
| `postcss.config.mjs` | PostCSS 配置（Tailwind） |
| `drizzle.config.ts` | Drizzle Kit 迁移配置 |
| `components.json` | shadcn/ui 组件配置 |
| `eslint.config.mjs` | ESLint 配置 |

## 十一、tsconfig 编译选项

| 选项 | 值 |
|---|---|
| target | ES2017 |
| module | esnext |
| moduleResolution | bundler |
| jsx | react-jsx |
| strict | true |
| noEmit | true |
| esModuleInterop | true |
| skipLibCheck | true |
| resolveJsonModule | true |
| isolatedModules | true |
| incremental | true |
| paths | `@/*` → `./*` |

## 十二、脚本命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 启动开发服务器 (next dev) |
| `pnpm build` | 生产构建 (next build) |
| `pnpm start` | 启动生产服务 (next start) |
| `pnpm lint` | 代码检查 (eslint) |
| `pnpm test` | 运行所有测试 (tsx --test --test-concurrency=1) |

## 十三、运行时配置（环境变量）

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `STAGEPASS_DOCUMENT_STAGE_TIMEOUT_MS` | 300000 (5min) | 文档阶段超时 |
| `STAGEPASS_TEST_PLAN_TIMEOUT_MS` | 900000 (15min) | 测试计划阶段超时 |
| `STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS` | 30000 (30s) | Build 流启动超时 |
| `STAGEPASS_REVIEW_TIMEOUT_MS` | 900000 (15min) | Review 超时 |