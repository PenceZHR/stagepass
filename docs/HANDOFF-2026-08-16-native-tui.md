# StagePass 无 tmux 原生 TUI 分支交接

日期：2026-08-16

分支：`codex/native-streaming-app-server`

worktree：`/Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server`

## 当前结论

这是当前交接文档；`HANDOFF-2026-08-15-app-server.md` 记录的是已被替代的浏览器原生渲染
阶段。本分支现已彻底移除 tmux、PTY、xterm 和浏览器终端：managed App Server daemon
保存 thread/turn/history，Terminal.app 中的官方 Codex TUI 是唯一交互客户端，StagePass
Web 只负责业务状态与打开、聚焦、关闭、恢复对应的系统终端。

原 worktree `/Users/zhanghr/Desktop/stagepass` 未被覆盖。真实数据库和全部既有 binding
继续原位复用，不复制、不读取 Codex 私有 session 文件；本分支只对真实库执行幂等 schema
迁移，新增 append-only 的 `stage_round_artifacts`，不回填或猜测旧轮次事实。

## 不可破坏的 MCP 所有权规则

App Server 的 `thread/start` / `thread/resume` 会让调用连接成为该 thread 的订阅者。若
StagePass 控制连接保持订阅，MCP approval/elicitation 可能被路由给 StagePass，而不是
原生 TUI；旧实现把所有反向请求统一拒绝，于是 TUI 显示 `user rejected MCP tool call`。
MCP server 实际没有失败，是反向请求 owner 错了。

永久规则：

1. StagePass 只在创建/恢复时短暂打开 App Server session，用当前 Change/seat config
   初始化 thread 并完成 binding。
2. 向 Terminal 投递任何文件信封前，同一控制连接必须完成 `thread/unsubscribe`，随后
   释放本地 session。
3. 已打开的 TUI 不允许被控制连接再次 `thread/resume`；只确认控制连接未订阅。
4. 状态用不含 turns 的 `thread/read` 查询；起止和结果只轮询 `thread/turns/list` 的
   有界最近页。新 turn 通过唯一文件信封精确匹配，完成通过同一 turnId 判断；精确中断
   只调用 `turn/interrupt`。
5. approval、MCP tool approval、MCP elicitation、快捷键和 Ctrl+C 只属于官方 TUI。
   StagePass 浏览器和控制连接都不代答。

## 运行链路

```text
StagePass Web -> StagePass backend -> managed App Server (provision/read/archive)
                         |
                         +-> Terminal.app -> official codex resume TUI
                                                   |
                                                   +-> StagePass MCP -> StagePass ledger
```

完整 prompt 只写入权限受限的临时文件。Terminal/TUI 只收到一行短文件信封；轮次明确终态
后删除文件。StagePass 不读取或渲染 Terminal 字节。

## MCP 故障与验收证据

故障线程为真实 `CHG-002 / PRD`，threadId
`01a0058a-f372-7d12-9ed5-3dad47c7718e`。修复前 TUI 明确显示
`Error: user rejected MCP tool call`；停掉 StagePass 控制连接而保留 daemon/TUI 后，同一
thread 立即由官方 TUI 显示一次性 MCP tool approval，随后显示 StagePass 的 10 字段业务
表单。这一对照证明 MCP server 正常，拒绝来自错误的 App Server 连接 owner。

修复后：

- 类型检查通过；本轮持久状态恢复修复后的完整测试为 1101/1101、250 suites、
  0 fail、0 skipped；
- 回归测试覆盖新 thread、关闭后 resume、已打开 TUI 三条路径，且在 Terminal 收到信封前
  强制断言最后一个所有权操作是 `thread/unsubscribe`；
- 真实 4173 实例对当前 `CHG-002 / PRD` 执行 `/api/terminal/open`，在不提交任何输入的
  前提下完成真实 daemon `thread/unsubscribe`，返回原 threadId、`thread=running`、
  `terminal=open`、`action=focus`；
- 验收代码没有调用 Terminal `submit`、没有写 `answers`、没有选择业务项。随后只读审计
  发现该问题已在 `2026-08-16T08:59:41.072Z` 经 TUI/MCP 路径变为 `answered/accept`，
  thread 也已 idle；仅凭账本无法判定是谁在 TUI 中完成了选择，因此不把它归因于验收。
当前仍没有 `CHG-002` 的 `change_briefs` 行。

## 进程重启后的状态流恢复（同日补记）

真实 `CHG-002 / PRD` 暴露了第二个独立故障：TUI/MCP 已经把 10 个回答完整写进
`questions`，但面板进程在等待协程把回答生成 brief 之前重启。HTTP 协程消失，持久库中
留下 `questions.status = answered`、`outcome_json = NULL`、无 `change_briefs`；旧实现下次
会重新跑模型、重新提问，所以页面看起来像整个状态流失效。

现在的恢复规则是：

1. clarification、gate decision、waive 都先找同 Change / phase 下已经回答但未消费的题；
2. 恢复只使用持久化的原题 schema 和原答案，不拿新模型提案套旧答案；两趟表单用确定的
   `-x` 子题 id 继续；
3. brief 与相关题的 settle 在同一个 SQLite 事务中提交；
4. 面板明确显示「恢复上次回答」，不会静默重问或静默应用；快速恢复也不会误闯
   Terminal、卡在旧页面；
5. 面板重启后不再拿进程内 `liveSeats` 冒充持久会话是否存在，按 binding / App Server
   thread 恢复；
6. retry 派发前检查失败会记录失败并把 `running` 回滚到 `blocked`，不会留下
   `running` 但没有 job 的假状态。

验收证据：

- 新增纯业务验收从 `PRD/pending → brief → running → settled → approve → Spec/pending`，
  并核对 ledger 只有 create/start/settle/approve；
- 用真实数据库的隔离副本在 4173 复现并恢复 `CHG-002`，页面、HTTP 与 SQLite 三层一致；
- 切回真实库后只读核对：页面显示「恢复上次回答」，运行按钮禁用；数据库仍为
  `briefs=0`、原题 `answered` 且未消费；没有自动应用那份可能不符合当前 Cocos 项目的
  历史回答；
- `/api/terminal/status` 返回同一 threadId，`thread=idle`、`terminal=open`、
  `action=focus`；服务日志无错误。

## Stage 产物驾驶舱（同日完成）

阶段页不再是一块空白终端入口。现在它是一张只读的产物驾驶舱，沿用项目既有黑洞/轨道
视觉语言，但把结构判断留给人、文件细节留给 Codex：

- 顶部固定显示阶段、持久状态、轮次、未决问题、下一步和显式的 macOS Terminal 控制；
- 左侧把结算轮次、搜索和按目录分组的完整文件树收进同一列；当前轮次与当前文件始终可见，
  不再依赖两条横向滚动带；中间主画布投影生产关系，右侧常驻正文、DIFF、来源/依赖和
  关联问题；
- PRD / Spec / Arch / BuildPlan / TestPlan / Build / Test / QA 各自有语义适配，默认选中对应角色
  的产物；Build 不再先打开 critic 文档；
- 历史轮次只有在 Git 证据可证明时才保守重建。证据不足会明确显示“历史清单不完整”，
  不拿当前工作树冒充过去；目录不是 Git 仓库时同样响亮降级；
- 新结算轮次的 manifest 与 evidence、gap、settle 在同一事务提交；重放幂等，冲突重放失败；
- 文件读取受 Change → Project → repository root、commit fence、路径白名单、realpath/symlink、
  2 MiB、binary 和历史删除约束保护。浏览器不能传 commit/ref；两个新接口只有 GET；
- 进入驾驶舱只刷新终端状态，不自动打开、聚焦 Terminal，也不启动 turn 或推动闸门；退出时
  原样恢复进入前的 Workspace 收起状态。

验收证据：

- `pnpm typecheck` 通过；`npm test` 为 1133/1133、259 suites、0 fail；
- 在 4173 用真实数据库的隔离副本完成搜索、轮次 1 回放、轮次 2 不完整提示、正文、DIFF、
  来源/依赖、返回阶段环和重新进入；浏览器控制台 0 error/warning；
- 浏览前后隔离库计数逐项相同：`66|0|110|89|174|10|0|76`，证明没有启动 turn、回答问题
  或推进闸门；
- 截图：`docs/evidence/screenshots/stage-artifact-cockpit-2026-08-16.png`；
- 真实库启动前备份到 `/private/tmp/stagepass-panel-before-cockpit-2026-08-16.db`，随后只新增
  `stage_round_artifacts` 表，当前 0 行；真实 `CHG-002` 启动和浏览前后始终为
  `PRD/blocked`，业务计数始终 `1|0|6|4|3|0|0`；最新 clarification 仍是
  `outcome={kind:unanswered, reason:session_died_before_answering}`，没有自动应用旧选择；
- 真实页面明确显示“请 Codex 问我”和上轮失败原因；浏览器控制台无错误。

设计与实施依据：

1. `docs/superpowers/specs/2026-08-16-stage-artifact-cockpit-design.md`；
2. `docs/superpowers/plans/2026-08-16-stage-artifact-cockpit.md`。

### 交互复核与返工（同日补记）

第一版虽然功能齐全，但用 22 轮、22 个文件的真实数据自己走一遍后确认交互不可用：当前
第 22 轮仍停在时间轴最左端，选中的根目录文件也停在文件横条最右端；用户必须同时拖两条
横向滚动条，退出后还会丢回阶段环。现已按实际使用路径返工：

- 轮次改成原生选择器，文件改成目录分组的垂直树；选中文件自动滚入视口，搜索同时收起
  空目录组；1280 px 下三列没有页面级或文件树横向溢出；
- “阶段产物 → 阶段详情”成为可逆路径，返回后重新打开同一 Stage 弹层，不再丢上下文；
- `loading / ready / incomplete / empty / unavailable` 五种投影状态显式化；没有可靠历史时
  轮次显示“轮次不可用”，空检查器收起，只保留一处可见原因；
- 顶部下一步原因可展示三行并保留完整 title；浏览、搜索、切轮次和切详情页签仍全部只读。

复核证据：

- `pnpm typecheck` 通过；完整测试 1137/1137、259 suites、0 fail、0 skipped；
- 隔离副本在 4173 实测第 22 轮、22 文件、搜索、文件选择、正文和来源/依赖页签、历史不完整
  轮次、返回与重进；浏览器日志为空，隔离库计数仍为 `66|0|110|89|174|10|76|0`；
- 真实 `CHG-002 / PRD` 实测非 Git 项目空态和返回；连续两次读前后业务计数均为
  `1|0|7|4|3|0|0|0`，其中 `stage_round_artifacts=0`；浏览器日志为空；
- 复杂数据截图：`docs/evidence/screenshots/stage-artifact-cockpit-2026-08-16.png`；真实空态截图：
  `docs/evidence/screenshots/stage-artifact-empty-2026-08-16.png`。

上述计数顺序统一为 `jobs|turns|questions|answers|change_events|change_evidence|gaps|stage_round_artifacts`。

### 2026-08-17 返工：星图从来没有真的显示过

上面「驾驶舱已验收」那两节**在图这一项上是假的**，两张截图记录的是坏掉的状态。

真相：`stage-artifact-scene.js` 用 `renderer.setSize(w, h, false)`。`updateStyle=false`
让 three 只改 drawing buffer，不写 canvas 的 CSS 尺寸；而 canvas 是**替换元素**，
`width: auto` 解析成 width 属性而不是包含块，所以样式表里的 `inset: 0` 对它无效。
retina 上 canvas 因此变成容器的 2 倍（实测 1274×1292 装在 637×646 里），
`.stage-artifact-canvas` 又是 `overflow: hidden` —— **人只看得见左上角四分之一，
而全部几何都落在看不见的右下角**。控制台一声不吭，1137 条测试全绿。

已经跑通的项目图谱 `graph-scene.js` 用的是默认 `updateStyle`，两边本来就不一致。

为什么测试挡不住：`stage-artifact-view.test.ts` 全部是对**源码文本的正则**，
`assert.match(scene, /new THREE.WebGLRenderer/)` 只证明这行字符串在文件里。
浏览器模块从来没有被套件解析过，更没有被渲染过。同一份文件里还有一条
`assert.doesNotMatch(css, /#stage-artifact-timeline|.stage-round-button/)` ——
它把设计 §3.4 明确要求的底部轮次时间轴**反过来钉死成禁止项**。

这一轮改了什么：

1. **canvas 尺寸**：样式表把 `.stage-artifact-canvas canvas` 钉成 `100%/100%`，
   `setSize` 只管 drawing buffer。几何不再依赖 JS 的时序 —— 实测把宿主宽度改成
   480 / 618 / 325 / 563，canvas 每次都精确等于容器。（先试过「让 three 写内联
   px」，但 ResizeObserver 会在布局只走了一半时回调：1440→1280 那一下它报的高度
   已是新的、宽度还是旧的，然后不再回调，canvas 从此比容器宽。）
2. **布局重写**（`stage-artifact-layout.ts`）：目录变成圆环上互不重叠的区域，
   文件按向日葵铺在**自己**目录的锚点周围；新增 `hub`（这一轮）和 `folder.radius`。
   谱系边从 `上游 × 目录` 的笛卡尔积（2 上游 × 3 目录 = 6 条一条也不成立的线）
   改成 `input-round` / `round-folder` / `folder-file`，每个节点一条。
3. **场景**：目录画成看得出来的地（圆盘 + 描边，整块可点即展开密目录），
   角色决定形状（producer 片 / critic 环 / delivery 晶体 / structured 多面体），
   相机按内容取景，且**只在图的形状变了时**取景。
4. **轮询不再打断人**：`setModel` 与文件树、详情面板都按签名跳过无变化的重建。
   实测 12 秒窗口内 `/api/stage-file` 请求数从「每 5 秒一次」变成 **0**。
5. **时间轴回来了**，但是换行排布，任何轮数下都不出现横向滚动条（22 轮排成 2 行，
   当前轮始终可见）；删掉那条禁止它的断言。
6. **右栏不再被长路径顶穿**（`overflow-wrap: anywhere` + `overflow-x: hidden`）。

新增的测试：`stage-artifact-layout.test.ts` 三条**真的几何断言**（文件离自己的目录
最近、目录区域两两不重叠、谱系边不是笛卡尔积），以及一组「浏览器模块必须按
ES module 解析」——用 `node --check` 之前要先抄成 `.mjs`，因为 `.js` 走的是
CommonJS 宽松模式，`let x` 撞 `function x(){}` 在那边合法、在浏览器里是 SyntaxError。
这条在返工过程中真的抓到过两次我自己写的重名声明。

验收：`pnpm typecheck` 通过；完整测试 1148/1148、260 suites、0 fail、0 skipped。
浏览器实测在 **4174** 用真实库的只读快照（`sqlite3 .backup`）跑，没有碰用户那份
`~/.stagepass/panel.db`，也没有动 4173 上正在跑的面板：CHG-001/Build 第 22 轮与
第 1 轮、22 个文件、角色形状可辨、时间轴切轮、1440 与 1280 两个窗口宽度、
CHG-002/PRD 的非 Git 空态，控制台 0 error。

**还没做**：`docs/evidence/screenshots/` 下那两张 8-16 的截图仍是坏掉的那一版，
没有替换；README 的能力表没有跟着改。

### 2026-08-17 复审：原生 TUI 迁移

按同样的方法查了一遍，结论和驾驶舱**相反** —— 这条链路建得是对的，几条核心主张
我没能证伪，而且是正面验过的：

- `thread/unsubscribe` 生产调用点只有一个（`native-sessions.ts:601`），在
  `terminal.open()` 之前，且包在 `try/finally` 里；
- 「同一控制连接」成立：`AppServerSessionHost` 和 `AppServerHistory` 在
  `scripts/panel.ts:308-309` 包的是同一个 `appServer.client`；
- `status()` 用 binding + 终端状态算，没拿进程内 `liveSeats` 冒充持久会话；
  而 `dispatchTurn` 一定先 `open()`，所以 `liveSeats` 不会在活轮下变陈，
  `session_died_before_answering` 不会被一个过期的集合误判出来；
- `native-sessions.test.ts` 是**真的行为测试**：假运行时记录调用顺序，
  断言在 Terminal 收到信封的那一刻触发（`calls.at(-1) === "thread/unsubscribe"`），
  配真 SQLite、真临时目录、真提示词文件。和前端那种正则 grep 不是一个量级。

补上的三道闸（都做过变异验证 —— 先把它弄坏，看见红，再修回来）：

1. **AppleScript 必须能编译**。它是 100 行静态脚本，单测全用假 osascript，
   假的永远同意；语法错一次，开/聚焦/投递/关窗会一起死在真机上而套件全绿。
   用 `osacompile` 只编译不执行。（注：`end 处理器名` 写错 AppleScript 本来就不管，
   所以那种改动测不出红；括号不配对可以。）
2. **只读动作要真只读**：`status/close/focus/submit` 必须在进
   `tell application "Terminal"` 之前用 `is not running` 短路，否则「看一眼」会把
   没在跑的 Terminal.app 拉起来。现在钉住了，`open` 不在此列（它本就该启动）。
3. **协议契约**（`src/codex/app-server-contract.test.ts`）。本文档上面那句
   「升级 Codex 后先生成并核对官方 schema」只是一句靠人记得的话，仓库里既没有
   基线也没有检查。现在对着本机 codex 的 `generate-json-schema` 核对我们用的
   11 个方法及其参数 —— **实测 0.147.0 全部对得上**（`thread/unsubscribe{threadId}`、
   `thread/read{threadId,includeTurns}`、`thread/turns/list{threadId,limit,sortDirection}`、
   `turn/interrupt{threadId,turnId}`）。只导 schema，不起线程、不跑 turn。
   codex 不在机器上时显式 skip，不静默通过。

另外，反向请求的拒绝改成**会出声**。`nativeTuiServerRequest` 仍然拒绝（对的，
绝不冒充官方客户端），但 8-16 那次故障的唯一症状在 TUI 里，StagePass 一声不吭，
于是排查从「MCP server 是不是坏了」开始、方向整个反了。收到反向请求就是所有权
交接回归的证据，现在会打出方法名和 threadId。

**没能验的**：没有跑真 turn，所以端到端的 MCP approval / elicitation 归属仍然只有
8-16 那次人工观察作证。另外，上面「MCP 故障与验收证据」那一节自己也承认，那次验收
**动了真实业务状态**（`/api/terminal/open` 会开窗，事后无法判定 CHG-002 的那道题
是谁答的）。验收流程本身需要一条不碰业务状态的路径，这一点还没解决。

## 唯一启动方式

```bash
cd /Users/zhanghr/Desktop/stagepass/.claude/worktrees/native-streaming-app-server
pnpm panel -- --db /Users/zhanghr/.stagepass/panel.db --port 4173
```

只能监听 `127.0.0.1:4173`。端口占用时先停止原实例，不换端口、不并行启动第二份。

## 继续开发前先读

1. `docs/CODEX-CONTRACT.md`：当前运行时与 MCP 所有权契约；
2. `docs/superpowers/specs/2026-08-16-native-tui-without-tmux-design.md`：无 tmux 设计；
3. `docs/superpowers/plans/2026-08-16-remove-tmux-native-tui.md`：迁移执行记录；
4. `docs/BACKLOG.md`：唯一遗留事项入口。

升级 Codex 后先生成并核对官方 App Server schema，再跑类型检查和完整测试，最后只在
4173 真机验证 start/resume、文件信封、MCP approval/elicitation、interrupt、窗口关闭与
恢复。任何实现都不得用“拒绝反向请求”冒充只读观察者。

### 2026-08-17 真机故障：TUI 里没有 StagePass 的工具

症状：TUI 在正确的线程上恢复了，题面也读到了，然后回一句
「无法调用：当前会话未提供 `stagepass_ask` 工具」并结束这一轮。

rollout（`01a0058a…` 第 441/442 行）里能看到它先自己找了一遍：

```js
const matches = ALL_TOOLS.filter(({name}) => /stagepass/i.test(name) && /ask/i.test(name));
if (matches.length !== 1) throw new Error(`Expected exactly one stagepass ask tool; found ${matches.length}.`);
```

→ `Script failed`。工具表里确实没有。

成因是和「MCP 所有权」同一条缝的另一半：StagePass 在 `thread/start` 时把
`mcp_servers.stagepass.*` 作为**线程配置**交给 app-server，但交给 Terminal 的
`codex resume` 只带了 `-c tui.terminal_title=[]`。官方 TUI 是**另一个客户端**，
不继承控制连接的会话配置，它读的是全局 `~/.codex/config.toml` —— 那里面没有
stagepass。控制连接握着配置，真正跑 turn 的却是 TUI。

8-16 那次验收之所以看得见表单，是因为那一轮是在 StagePass 自己那条已配置的会话上
跑的；一旦被 TUI 冷恢复，配置就没了。

修法：`TerminalTarget` 带上 `config`，`resumeCommand` 把每一项按 TOML 序列化成
`-c key=value`（位置参数仍在最后），`NativeSessions` 在 open 和 turn 派发两条路上
都把座位配置传下去。生成的命令与 `src/plugin/server.ts` 开头文档的格式一致。

注入这条单独验：安全的引用**会保留**危险字符、只是让它们变成字面量，所以
「断言字符串里没有那段文本」是错判据。测试改成用真的 `/bin/sh` 把命令拆开数参数，
并确认注入的 `touch` 没有被执行。

**遗留**：这次排查顺带看到 21 个 `src/plugin/server.ts` MCP 进程还活着 ——
每次 resume 起一个，没人回收。没有处理。
