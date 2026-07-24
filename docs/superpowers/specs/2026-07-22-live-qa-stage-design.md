# Live QA 阶段设计

日期:2026-07-22
状态:已定稿,未进入实施

## 目标

在 CHECKING(静态检查)之后、MERGE_READY 之前插入一个独立的 **Live QA** 阶段:AI 拉起真实浏览器,**严格按照使用说明**逐场景实测本次变更;后台并行一个监控 agent 实时判读错误;发现问题经人工门控后进 Fix 或回退重走;整体流程仍由状态机写死,QA 只产出"判定 + 提案",走哪条边永远由人决定。

架构分两层:**Live QA 阶段内部用 LangGraph.js 建图编排**(解析说明 → 逐场景测 → 监控判读 → 分诊提案,`interrupt()` 做门控驻留,SQLite checkpointer 做断点续跑);**图节点内真正干活的执行体是 spawn 的 Codex/Claude CLI agent**(带浏览器 MCP 工具),复用订阅授权与现有引擎架构。LangGraph 只编排、不直调模型 API,因此无需额外配置 API key。

## 非目标

- 不替代现有 CHECKING 阶段(lint/typecheck/test/build 静态门保持原样,继续作为便宜的前置门)。
- LangGraph 只用于 Live QA 阶段内部;外层 change 状态机与其他阶段不迁移到 LangGraph。
- 不做嵌入页面的浏览器画面流/帧回放。
- 不改动现有删除式 rework(`change-rework-service`);Live QA 的回退走独立的非破坏路径。

## 1. 状态机

新增 3 个 `ChangeStatus`:

| 状态 | 语义 |
| --- | --- |
| `LIVE_QA_RUNNING` | 运行态,加入 `RUNNING_CHANGE_STATUSES` |
| `LIVE_QA_BLOCKED` | 驻留态:急停 / 攒批清单 / 回退提案在此等人工审批 |
| `LIVE_QA_READY` | 通过,可进 `MERGE_READY` |

新增流转边(`ALLOWED_TRANSITIONS`):

```
CHECKING 通过 → LIVE_QA_RUNNING → LIVE_QA_READY → MERGE_READY
LIVE_QA_RUNNING → LIVE_QA_BLOCKED
LIVE_QA_BLOCKED → FIXING            实现问题,人工批准;修完经 FIXING → CHECKING 环,
                                    静态检查通过后自动回 LIVE_QA_RUNNING 续测失败场景
LIVE_QA_BLOCKED → SPECCING          结构性问题,人工批准;Spec → TechSpec → Plan → TestPlan
                                    四份文档全部重修,循环重走到 Live QA
LIVE_QA_BLOCKED → LIVE_QA_RUNNING   人工驳回误报,继续测
```

回退**只有一个目标**:回 Spec 起点,四阶段(Spec、TechSpec、Plan、TestPlan)依次重修后向前重走。不存在"只回 Plan"这类中间跳。

## 2. 非破坏回退

不复用删除式 rework。新增 `stage_rollbacks` 表:change_id、from_status、to_status、关联 findings、判定理由、决策人、时间。

- 回退后下游产物**全部保留**,重走的阶段产出新版本产物(追加)。
- 重走的每个阶段 prompt 注入"QA 回退上下文":判定、证据摘录、截图引用,让重写方知道为什么回来。
- 实施核查项:逐一确认各阶段服务读产物时取"最新版本",避免旧版本被误读。

## 3. 使用说明:QA 的唯一剧本

- Build/Implement 阶段新增**必交产物** `usage_guide`(usage.md,新 `ArtifactType`):HOW_TO_RUN + 逐功能的用户视角操作步骤(入口在哪、怎么操作、预期看到什么)。缺产物则 Build 不通过(复用现有产物校验机制)。
- Live QA 第一步:QA agent 将 usage.md 解析为场景清单写入 `qa_scenarios` 表,**每个场景必须锚定 usage.md 的具体章节**;无锚点的场景非法。
- 硬规则:
  - 说明写了但界面做不到 → 记"实现与说明不符"发现;
  - 说明缺漏 → 记"文档缺陷"发现,**不许自行脑补补测**;
  - QA agent 无权发明场景。

## 4. 浏览器执行层

- **不装内嵌 chromium**:用系统 Chrome 以 `--remote-debugging-port` 启动(独立 profile 目录,不碰日常浏览器数据),`playwright-core` 经 CDP 接管。
- 新服务 `qa-browser-service`:封装 navigate / click / type / read_page(a11y 树)/ screenshot / wait / console 快照。
- 动作日志落 `qa_browser_events` 表(seq、scenario_id、动作描述、console 错误快照);**截图只在产生发现时留证据**,存 `.ship/changes/<changeId>/qa/screens/`,不做全程帧流。
- dev server 由 Live QA job 按 usage.md 的 HOW_TO_RUN 拉起,日志 tee 到文件供监控 agent 读取。

## 5. 工具交付:引擎中立的 MCP(Claude CLI + Codex CLI 双支持)

- 浏览器工具只写一份:`stagepass-qa-mcp`(本地 stdio MCP server,封装 qa-browser-service 的工具 + `halt_qa`)。
- `AiEngine` run 输入新增可选字段 `extraMcpServers`(name → command/args),两个引擎各自翻译:
  - `claude-engine`:追加 `--mcp-config <临时 json>`,并放行 `mcp__stagepass_qa__*` 工具;
  - `codex-cli-engine`:追加 `-c mcp_servers.stagepass_qa.command=…` / `-c mcp_servers.stagepass_qa.args=…` 命令行覆写,不改动用户的 `~/.codex/config.toml`。
- QA 测试 agent 与监控 agent 均跟随现有 provider 选择机制(主用 Codex 则都跑 Codex),不为 Live QA 特设 provider 逻辑。
- 实施核查项:Codex `--sandbox` 模式下 MCP 子进程的权限边界需实测(浏览器 MCP 要连本机 CDP 端口、写截图文件);若被拦截,该阶段单独使用放宽的 sandbox 配置。

## 6. LangGraph 编排 + 双 agent 执行

Live QA job(现有 pipeline worker 领取)的 job 体是一张 **LangGraph.js 状态图**。新依赖:`@langchain/langgraph` + `@langchain/langgraph-checkpoint-sqlite`(仅编排,不引入 langchain 模型绑定)。

图结构(节点内干活的执行体 = spawn 的 CLI agent):

```
prepare_env(起 Chrome + dev server,非 LLM)
  → parse_usage(CLI agent:usage.md → 场景清单落 qa_scenarios)
  → run_scenario(CLI agent + browser MCP,逐场景照剧本测)──循环边:还有 pending 场景 → 回自身
  →(并行分支)monitor(第二个 CLI agent:实时读 server 日志 tail + console/network 错误流,
     判读严重度;持有 halt_qa 工具,阻断级可直接叫停 run_scenario 并写 blocking finding + 证据链)
  → triage(CLI agent:汇总发现,产出判定 + 提案:进 Fix / 回 Spec / 通过)
  → interrupt() 门控驻留(见第 7 节)
  → finalize(通过则收尾)
```

- **断点续跑**:图状态经 SqliteSaver 落盘;急停 / 门控 / job 重试后从 checkpoint 恢复,配合 `qa_scenarios` 表(DB 仍是场景状态的对外真相源,供 UI/SSE 读取;checkpointer 只管图内部状态)。
- **保险丝(非 LLM)**:dev server 崩溃、QA agent 进程死亡等硬故障由 `prepare_env`/节点包装层直接判阻断,不经监控 agent。监控 agent 自身崩溃时 QA 降级继续,标记"监控缺位",收尾时提示。

## 7. 门控与修复循环

- **阻断即停**:急停后图走到门控节点 `interrupt()`,checkpoint 落盘、job 退出,change → `LIVE_QA_BLOCKED`,gate 面板展示判定 + 提案 + 证据(截图、日志摘录)。
- **其余攒批**:非阻断问题继续测完;收尾时若有未决清单,同样经 `interrupt()` 驻留 `LIVE_QA_BLOCKED`,人工批量处理。
- **恢复**:decision API 把人工决定写库后投递一个 resume job,worker 以 `Command(resume=决定)` 从 checkpoint 续跑图——`dismiss` 回到 `run_scenario` 循环,`approve_fix`/`rollback_to_spec` 则图收尾、由外层状态机转移到 FIXING/SPECCING。
- 新 API `live-qa/decision`,actions:
  - `approve_fix` — 批准进 Fix;
  - `rollback_to_spec` — 批准结构性回退(四阶段重走);
  - `dismiss` — 驳回误报,回 `LIVE_QA_RUNNING` 继续;
  - `waive(reason)` — 带理由豁免放行。
- 决策写入现有 human_decisions 体系。

## 8. 场景恢复

`qa_scenarios` 表:锚点(usage.md 章节)、标题、状态(pending / passed / failed / blocked / skipped)、尝试次数、last_run_id。

- Fix 回来:只重测 failed + pending,passed 不重测;
- 大回退(回 Spec):场景表整体作废重生成(usage.md 已变)。

## 9. 前端

**不嵌浏览器画面。**

- 侧边栏(phase-rail)新增 Live QA 节点:运行时显示场景进度(passed/failed/pending),走现有 SSE + 轮询通道;
- 节点旁提供**"跳转到测试浏览器"按钮**:调用后端 API 将 QA 控制的 Chrome 窗口唤起置前(macOS 经 `open`/AppleScript 指向该 debug 实例),用户直接在真 Chrome 里旁观 AI 操作;
- `LIVE_QA_BLOCKED` 时 gate 面板复用现有决策 UI 样式,展示判定、提案与证据。

## 10. 预算与容错

- 每场景步数上限、整轮时长上限;超限驻留报告,不死磕;
- Chrome 连不上 / dev server 起不来 → 阻断发现(环境或 HOW_TO_RUN 文档问题);
- Playwright 元素找不到 / 超时 → 记"实现与说明不符",不无限重试;
- QA job 可重试,`qa_scenarios` 表保证幂等续跑。

## 11. 测试策略

- 状态机新边、场景恢复、回退记录:单测,走 `run-tests-isolated`(禁止裸跑测试,防写生产库);
- LangGraph 图:节点执行体全部 mock(不 spawn 真 CLI),单测图的流转——循环边、interrupt/resume、checkpoint 恢复、监控叫停路径;
- `qa-browser-service`:本地 fixture 静态页面测工具封装;
- 端到端:沙盒 change 手动走通全环(测→急停→门控→Fix→续测→通过)。

## 已决策记录

| 决策点 | 结论 |
| --- | --- |
| LangGraph | 引入,作为 Live QA 阶段内部编排层(图 + interrupt + checkpointer);执行体仍是 spawn 的 CLI agent,LangGraph 不直调模型 API |
| 使用说明来源 | Build 阶段必交产物,QA 前就有 |
| 浏览器可视化 | 不嵌页面,真 Chrome + 跳转按钮 |
| 错误监测形态 | 独立第二个 LLM agent 实时判读,可叫停 |
| 修复节奏 | 阻断即停,其余攒批 |
| 回退门控 | 回退必须人工门控,且非破坏(追加式) |
| 回退目标 | 仅回 Spec 起点,四阶段循环重走 |
| 引擎支持 | Claude CLI 与 Codex CLI 双适配,工具经 MCP 引擎中立交付 |
