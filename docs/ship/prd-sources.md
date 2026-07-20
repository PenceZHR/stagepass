# PRD 参考来源

## 项目 README

链接: README.md

**采纳：**
- 产品定位（local-first control surface）
- 运行/测试命令（pnpm dev/lint/test/build）
- .ship/ 与本地数据库不入 git 的约定

## 数据库 Schema

链接: server/db/schema.ts

**采纳：**
- 全部实体与表结构（约 48 张表）
- 不变式约束（CHECK/UNIQUE INDEX）
- .ship/ 文件产物布局

## 类型枚举

链接: server/types/enums.ts

**采纳：**
- ChangeStatus 全集
- RunPhase/Phase/ArtifactType
- Battle*/Finding*/PrdStatus 等枚举

## PRD 数据结构

链接: server/types/prd.ts

**采纳：**
- 本 PRD 采用的结构化 schema（body/aiAppendix/sources）
- AC 可测试字段与优先级枚举

## 状态机文档

链接: docs/state-machine.md

**采纳：**
- 完整状态转移图
- 状态→展示 Phase 映射
- 门态（◆）不自动前进等不变式

## 数据模型文档

链接: docs/data-model.md

**采纳：**
- 实体关系
- ID 规则（PRJ/CHG/RUN…）
- 文件系统产物布局

## AI 引擎接口

链接: server/services/ai-engine-types.ts

**采纳：**
- AiProvider（codex/claude）
- AiRunInput/AiRunResult
- AiEngineAdapter 契约

## 服务清单

链接: server/services/*.ts

**采纳：**
- 流水线各阶段、门禁、评审、QA、合并、spec-battle、prd-briefing 等模块划分（85 个 service 文件）

## API 路由

链接: app/api/projects/[id]/changes/[changeId]/*

**采纳：**
- REST 端点（intake/spec/plan/implement/review/qa/gate/merge/retro）
- SSE 事件流
- 专项视图端点

## 策略与规范

链接: .ship/policy.json + .ship/coding-rules.md

**采纳：**
- 必检命令（lint/typecheck/test/build）
- blockedGlobs
- 函数 ≤50 行
- 禁止 any

**舍弃：**
- tech-stack/architecture/file-guide 内容 — 原因: 这些是模板占位（待生成），尚无有效内容

## 项目代码认知报告

链接: docs/project-codebase-overview.md

**采纳：**
- 产品主流程
- 后端服务分层
- 数据库表族
- 当前架构判断与模块化建议

## 产品愿景 PRD

链接: docs/prd.md

**采纳：**
- 对抗式指挥板愿景
- DB-first 契约（v4.0）
- Spec Battle/PRD Briefing/Build/Review 各阶段产品语义与 schema

**舍弃：**
- 其 AI 编排细节 — 原因: stagepass 已有自有编排，不照搬外部编排

## Spec Kit（GitHub）

链接: https://github.com/openai/spec-kit

**采纳：**
- 用户故事结构
- 功能需求拆解
- 验收标准格式

**舍弃：**
- 其 AI 编排细节 — 原因: stagepass 已有自有编排，不照搬外部编排

## Kiro / EARS

链接: https://aws.amazon.com/dev/0/kiro

**采纳：**
- Given-When-Then / 条件式可测试验收标准写法

## PRD Template（ProductPlan）

链接: https://www.productplan.com

**采纳：**
- 成功指标、out-of-scope、风险的表述方式

**舍弃：**
- 其商业指标模板 — 原因: stagepass 是本地工程工具，指标偏工程纪律而非商业漏斗
