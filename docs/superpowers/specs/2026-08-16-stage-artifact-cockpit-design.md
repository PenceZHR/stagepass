# Stage 产物星图驾驶舱设计

日期：2026-08-16

分支：`codex/native-streaming-app-server`

状态：用户已通过逐项选择确认；最终布局选择 A「产物星图驾驶舱」。

## 一、目标

StagePass 明确定位为 **macOS 本地交付控制面**。浏览器负责流程、事实与产物投影，
Terminal.app 中的官方 Codex TUI 负责所有交互 turn、MCP approval / elicitation 与
Ctrl+C。Stage 页面不再用一整页只承载一个 Terminal 跳转按钮，而要同时回答两件事：

1. **这个 Stage 产出了什么**：文件架构、生产关系、目录结构、代码依赖和具体内容；
2. **现在该做什么**：当前状态、阻断项、下一步与固定的“打开 / 聚焦 Codex”入口。

文件图是主角，状态驾驶栏固定存在。页面只读；看文件、切轮次、展开依赖都不能启动
turn、改变闸门或写业务状态。

## 二、已确认的产品决定

1. 主体展示本 Stage 本轮生产或修改的文件；上游输入以弱化的入口节点出现，点开才展开。
2. 生产关系决定大结构，真实目录决定产物分组，代码依赖在选择文件之后显示。
3. 默认展示最新轮次；底部时间轴可以切换旧轮次，并标识新增、修改、沿用、删除与替换。
4. 点击文件在页面内打开只读详情，不把主动作交给默认应用或 Finder。
5. 八个 Stage 共用同一页面骨架，但按产物类型调整视觉重点和默认详情。
6. Codex 入口固定在顶部驾驶栏，打开系统 Terminal 后仍留在当前文件页面。
7. 采用“产物星图驾驶舱”：画布和文件详情并列，而不是全屏画布抽屉或传统三栏 IDE。

## 三、页面结构

### 3.1 顶部状态驾驶栏

高度固定，不随文件滚动。只放会影响此刻判断的信息：

- Stage 名、阶段状态与第几轮；
- 当前问题数和闸门事实；
- 一句明确的下一步；
- `打开 Codex` / `聚焦 Codex`；
- 返回阶段环。

Terminal 状态是一个事实标签，不再单独占一页。关闭 Terminal 只退出可丢弃客户端，
App Server thread 与业务状态仍按现有契约保留。

### 3.2 产物星图（主区域约 68%）

画布不复制整个项目黑洞图，而是复用它的视觉语言和底层图算法，建立一个阶段级投影：

- 左侧是弱化的上游入口节点，按上游 Stage 分组；
- 中央是本轮产物；真实目录形成可辨认的区域，文件是可点击节点；
- 入口到产物的线表示生产谱系，不伪装成代码 import；
- 默认不画全部代码边；选择一个代码文件后，才亮出直接依赖、直接被依赖和爆炸半径；
- 非代码文件保留目录与生产谱系，不编造代码依赖；
- 节点用形状和文字同时表达新增、修改、沿用、删除与替换，不只靠颜色。

文件数量过多时先按目录聚合；放大或点目录才展开。搜索能直接定位任一清单内文件，
与画布共用同一个选中状态。没有 WebGL 时降级为平面分组图 + 完整文件列表，不得白屏。

### 3.3 文件详情（右侧约 32%）

选择文件后常驻显示，不覆盖星图：

- 仓库相对路径、文件角色、所属目录和轮次；
- 当前轮次的正文或 diff；
- 来源：哪些上游产物或阶段约束喂给了它；
- 代码文件的依赖、被依赖和爆炸半径；
- 与该文件有位置关联的 gap、rubric 判定和反方意见；
- 历史状态：由哪一轮新增，在哪一轮被修改、删除或替换。

Markdown 默认显示渲染结果，并可切换原文 / diff；代码默认 diff，并可切换完整只读正文；
JSON 显示结构化树与原文；二进制文件只显示类型、大小和 Git 状态，不尝试把乱码当正文。

### 3.4 底部轮次时间轴

时间轴默认选中最新完成轮次。每个轮次显示结算状态和文件变化摘要。正在运行的新轮只显示
“进行中”，继续展示上一轮已结算产物；工作树里尚未结算的半成品不冒充正式产物。

切换旧轮次只切投影，不改变 Stage 当前状态。旧文件若在工作树中已经不存在，优先从
该轮的 Git commit 读取；确实无法重建时明确显示“历史内容不可用”，不能画成空文件。

## 四、阶段差异

同一骨架通过只读适配器决定默认焦点，不生长八套页面：

| Stage | 默认重点 |
|---|---|
| PRD | 需求正文、章节结构、上游 brief、反方意见 |
| Spec | 行为契约、边界与 PRD 对应关系 |
| Arch | 架构文档、`arch.graph.json` 与项目黑洞图的规划 / 真实对账 |
| BuildPlan | 实施拆分、目标代码区域与依赖入口 |
| TestPlan | 测试策略、目标行为与计划测试文件 |
| Build | 本轮代码 diff、目录分组、依赖与爆炸半径 |
| Test | 测试代码 diff、覆盖目标及其与生产代码的关系 |
| QA | 运行证据、问题归属、被验证的 Build / Test 产物 |

适配器只能选择默认页签、标签和强调层级，不能改变产物事实或另算一份状态。

## 五、持久事实与数据模型

### 5.1 为什么不能只扫描目录

现有 `change_evidence` 的语义是“闸门当前看到的证据”，主键为 `(change, phase)`；后一轮
会替换前一轮。目录中的 `Phase-rN.md` 能找回设计文档，却无法可靠说明 Build / Test
每轮修改了哪些代码；解析 Git 提交文案则是在拿约定猜业务事实。

因此新增 append-only 的轮次产物清单。概念结构如下：

```text
stage_round_artifacts
  change_id + phase + round          唯一键
  job_id                              对应真实工作
  artifact_ids                        这一轮交给闸门的稳定证据 id
  files                               路径、角色、change kind、可选 commit
  upstream                            运行时真正使用的上游 evidence 快照
  settled_at
```

`files` 至少区分 producer 文档、critic 文档、代码 / 测试交付与结构化证据。
Build / Test 的文件清单来自这一轮实际生成的 commit diff；报告类阶段包含 StagePass 指定的
producer / opposition 路径和红方报告的合法附加产物。路径必须是仓库相对路径。

记录发生在 Git commit 已经产生之后；manifest insert、`change_evidence` replacement
与这一轮的 settle 必须在同一个 SQLite 事务中提交。相同 `(change, phase, round)` 重放
必须幂等。它是展示历史，不参与 gate snapshot，不能成为第二条推进状态机的路。

### 5.2 旧数据

迁移不伪造旧轮次。对没有 manifest 的历史：

- 能由确定的 `Phase-rN` / opposition 路径，或当前 evidence 已经保存的 commit SHA
  证明的，标为 `reconstructed`；不解析 Git 提交文案来猜旧轮归属；
- 只能知道有过一轮、无法证明文件集合的，显示“这一轮没有完整产物清单”；
- 不把当前工作树倒灌成过去的文件集合。

## 六、接口与模块边界

新增独立的 Stage artifact API 模块，沿用 `graph-api.ts` 的注入方式，避免继续扩大
`panel-server.ts` 的依赖闭包。

建议只读接口：

```text
GET /api/stage-artifacts?change=<id>&phase=<phase>
GET /api/stage-file?change=<id>&phase=<phase>&round=<n>&path=<repo-relative>
```

第一条返回轮次清单、上游入口、目录分组和用于画图的节点；第二条只允许读取该轮 manifest
已经列出的文件，返回正文 / diff / 依赖 / 关联事实。gap 的 `where` 只有在包含完整、
边界明确的仓库相对路径时才绑定到文件；其余仍显示为 Stage 级问题，不做模糊猜测。
服务端必须同时验证：

1. Change 属于 Project；
2. Project 有真实路径且是 Git 仓库；
3. 请求 phase 和 round 存在；
4. path 在该轮 manifest 白名单内；
5. 工作树读取经过 realpath 后仍在项目根内；
6. 历史读取只能使用 manifest 记录的 commit，不接受浏览器传入任意 ref。

前端拆为独立模块：

- `stage-artifact-view.js`：页面状态、时间轴、搜索、详情；
- `stage-artifact-scene.js`：Stage 级场景与选择高亮；
- 纯布局模块：输入是 manifest + 项目图的受限子图，输出确定坐标；
- 既有 `terminal-bridge.js` 只提供顶部按钮状态，不拥有整张 Stage view。

## 七、数据流

```text
一轮完成
  → commit / 固定文档路径产生稳定证据
  → 当前 evidence 更新 + append-only round manifest
  → Stage artifact API 读取 manifest
  → 只对 manifest 中的代码路径取项目依赖子图
  → 纯布局生成场景
  → 浏览器画星图与轮次时间轴
  → 点击文件后按 manifest 白名单读取正文 / diff / 关联事实
```

页面轮询只刷新投影。打开或聚焦 Codex 仍走现有 Terminal API；任何文件 API 都不能触发
App Server thread/start、turn/start、MCP 或 Change transition。

## 八、错误与空状态

- Stage 从未跑过：显示上游入口、明确的“尚无产物”和下一步，不显示空黑画布；
- 当前轮正在运行：显示运行事实，继续保留上个已结算版本；
- manifest 缺失：说明是旧数据不可完整重建，不拿工作树猜；
- 文件已删除：节点保留删除标记，详情尝试读取历史 commit；
- 文件不可读 / 二进制：显示元数据和原因；
- Project 无路径、不是 Git 仓库、路径越界、commit 不存在：分别返回稳定错误码；
- 依赖解析失败：文件仍可读，依赖层单独报错，不让整个 Stage 页面白屏；
- WebGL 不可用：降级为二维图和列表。

## 九、README 重写

README 不再暗示跨平台支持，开头明确：

> StagePass is a macOS-native local delivery control plane for Codex.

运行要求明确列出 macOS、Terminal.app、Codex CLI `app-server`、Node 与 pnpm。README 的
主体顺序调整为：定位 → 为什么存在 → 八阶段环 → Stage 产物驾驶舱与项目黑洞图 →
macOS 原生 TUI 所有权 → 当前真实状态 → 4173 唯一启动方式 → 架构边界与关键文档。

仍遵守“没真机通过就不写成已经完成”：驾驶舱只有在实现、全量测试和真实 4173 浏览器
验收之后才能进入已完成能力表。README 不写 Windows / Linux 的替代启动路径。

## 十、验收

1. 纯测试：轮次 manifest 幂等、目录分组、生产谱系、代码子图、历史 diff 与五种文件状态；
2. 数据库：旧库迁移、删除 Change / Project 的级联、并行 Build / Test 轮次不串位；
3. API：归属校验、manifest 白名单、realpath / symlink 越界、任意 Git ref 注入全部失败关闭；
4. 浏览器：空状态、运行中、最新轮、历史轮、文件详情、搜索、WebGL 降级、Codex 聚焦；
5. 状态红线：浏览 Stage 页面和文件绝不新增 job / turn / question / event；
6. 视觉：沿用现有雾紫、沙金、剪纸 / 星体语言，画布与详情在常用 macOS 窗口尺寸不互相遮挡；
7. 完整回归、类型检查、架构棘轮全绿；
8. 只用隔离数据库在 `127.0.0.1:4173` 跑浏览器验收，再切真实库只读确认；
9. README 中的每个完成态陈述都有对应测试或真机证据。

## 十一、不做

- 不把 Terminal 字节重新嵌回浏览器；
- 不在文件详情里编辑或保存项目文件；
- 不给 Stage 页面增加 approve / reject 等第二套裁决入口；
- 不展示未结算工作树半成品；
- 不把完整项目黑洞图复制成第二份；
- 不实现 Windows / Linux 兼容层；
- 不让 README 先于验收宣称能力完成。
