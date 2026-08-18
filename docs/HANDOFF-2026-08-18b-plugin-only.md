# StagePass 交接 · 2026-08-18b —— 定案：只做插件，网页端退休

> 接 `HANDOFF-2026-08-18.md`。那份记的是「插件这条路能不能走」，这份记的是
> **走定了之后，什么被推翻、什么还站得住、下一步按什么顺序动**。

## 一、用户的定案（2026-08-18 晚）

原话：

> 「彻底改变了思路，确定了以插件形式存在，我需要你彻底适配 codex 的客户端
> （可能以后也要适配 claude 的客户端），**不再维护网页端了**。」

以及执行通道的选择（当场确认）：

> 一轮 turn **换成 app-server 开真会话**，不再走面板里的终端 TUI 座位。

## 二、这两句话推翻了什么

| 旧前提 | 现在 |
|---|---|
| 面板 HTTP 服务（`src/web/panel-server.ts` + 4173）是产品的一部分 | **退休**。widget 的数据要由 MCP server 直接读库 |
| 「面板必须从真终端起」 | 失去意义 —— 没有面板进程了 |
| 三列 2:2:6 桌面版式 | **没有落地的地方**。widget 宽度上限约 700px，而它是唯一表面 |
| 「turn 必须在面板里的 TUI 跑」（`stagepass-no-exec-only-tui`） | 目的不变、通道换掉，见下 |

关于最后一条要说清楚：那条规矩的**理由**是「人要看得见它跑」，反对的是 headless 的
不可见 turn。app-server 开出来的是**一条人能在 App 里点开、接着打字的真会话** ——
同一个目的，换了条更好的路。**不是废掉那条规矩，是它的实现变了。**

## 三、还站得住的（一个字没白写）

领域层全部照旧：`phase` / `change-state` / `rubric` / `brief` / `question` /
`stage-artifact`、`store`、以及座位交接那套判据。变的是**表面**和**执行通道**，不是规则。

`src/codex/app-server-*`（client / session / transport / daemon / stream-state，
约 1500 行带测试）也全部保留 —— 它本来就是为这条路写的，现在从备选变成主路。

## 四、今天真机验到的硬事实

### 4.1 从外部开一条真 Codex 会话（公开协议，零私有依赖）

```
spawn(<codex 二进制>, ["app-server"])
  initialize → thread/start { cwd, threadSource: "user" }
             → thread/name/set
             → turn/start { input:[{type:"text",text}] }
             → turn/completed
```

- 时序：`thread/start` 0.2s → `turn/start` 1.8s → `turn/completed` **9~12s**
- 纯文本 turn **没有任何审批弹窗**
- 协议有官方 schema 生成器：`codex app-server generate-json-schema --experimental`
- **新线程里插件的 MCP server 会自动加载**（0.4s 内 `stagepass` / `node_repl` /
  `codex_apps` / `openaiDeveloperDocs` 全部 ready）—— 座位一出生就带着 StagePass 的工具

### 4.2 `threadSource: "user"` 决定它进不进 App 的项目分类

| | `threads.thread_source` | App 里 |
|---|---|---|
| 不传 | `null` | **只在 Recents** |
| 传 `"user"` | `"user"` | 落进项目分类，和 App 自己开的一样 |

**这个差异在 API 层完全看不出来** —— 两条线程的 `thread/read` 返回一模一样，一个字节
都不差。只有 `~/.codex/state_5.sqlite` 的 `threads` 表里差一列。排这类问题的方法论：
**API 层看不出来就下到存储层比，别停在 API。**

已落地：`src/codex/app-server-session.ts` 的 `threadParams` 补上了 `threadSource`，
测试打的是真实症状（「项目分类里看不见」）而不是「函数有没有被调用」。

### 4.3 widget 沙箱的边界（详见 `codex-widget-sandbox-limits` 记忆）

- 整套面板可打包成 **1 MB 自包含 HTML**，`resources/read` 整块送达，**0 报错**
- **three.js 在 widget 里能跑**：真 `WebGLRenderer` 画一帧，`readPixels` = `#f0c674`
- **不许导航**：`location.search = …` 会把 widget 打死（panel.js 有 5 处）
- **全局只读**：改 `window.setTimeout` / `document.addEventListener` 直接抛
  `Cannot assign to read only property`，整个脚本当场死
- **外部源全封死**：`fetch https` / `img https` / `fetch localhost` 全 ✗
- 尺寸：inline `736×(240→720)`；fullscreen 是**右侧面板标签页**，`657~687×644`，
  可手动拖到 1280

### 4.4 换了 `server.mjs` 之后旧会话还在跑老代码

MCP server 按会话起。覆盖插件文件后，**已开着的会话继续跑老进程** —— 卡还活着、
还回传，但连的是老代码。判据：`ps` 里没有插件进程 ＋ `probe.log` 里没有新 `tools/call`
＝ 新代码一次都没跑过，**先开新会话，别 debug 代码**。

## 五、已经落地的（2026-08-18 晚）

### 插件自给自足了 —— 4173 这条依赖断了

```
pnpm plugin        # 构建 + 直接装到 ~/.codex/plugins/cache/stagepass-local/stagepass/0.0.1
```

产物两块：`server.mjs`（169 KB，零运行时依赖）和 `widget/panel-widget.html`（1004 KB，
CSS / JS / three.js / 背景图全内联）。**用户机器上不需要任何东西在后台跑着。**

离线冒烟（喂真 metadata、读真库）：

```
认项目  PRJ-002 海战小游戏      ← 从 Codex 的工作目录认出来的
change  CHG-002                ← 项目下第一条，没让人选
预取    3 条，键和 panel.js 将要请求的 URL 逐字对上 → 首屏零往返
面板    workspace=海战小游戏  phases=8  changes=1
未接口  {"error":"not_wired_yet","path":"/api/run"}
```

树上多了这些（`pnpm check` 1195 passed）：

| 文件 | 是什么 |
|---|---|
| `src/plugin/sqlite-handle.ts` | 用 Node 内置 `node:sqlite` 顶 better-sqlite3 的形状。插件是裸 node 进程、没有 node_modules，而原生模块打不进 bundle。测试打的是「换驱动行为不许变」：真 `ChangeStore` + 真 `SCHEMA_SQL`，两个驱动逐字段比 |
| `src/plugin/node-sqlite.d.ts` | `@types/node@20` 没有 `node:sqlite` 的类型。没升依赖（跨大版本会牵出一片不相干的错），手写只声明用得到的表面 —— 它同时就是依赖清单 |
| `src/plugin/panel-data.ts` | `/api/panel` 载荷的插件版。**不是第二份 view**，调的就是 `panelView` |
| `src/plugin/api.ts` | 数据口。三种回答：能读、404、`501 not_wired_yet` |
| `src/plugin/workspace.ts` | 从 `x-codex-turn-metadata.workspaces`（**以路径为键的对象**）认项目，取最长匹配，认不出返回 null 不猜 |
| `src/plugin/server.ts` | 进程边界。**几乎没有逻辑** —— 拿主意的都搬进上面几个可测模块了 |
| `scripts/plugin-build.ts` | `pnpm plugin` |

### 顺手改掉的两处历史包袱

- **`panel.js` 不再靠整页重载换 Change。** 五处 `location.search = …` 换成 `goTo()`：
  改两个模块变量 + 重跑 `load()`（它本来就是整屏重画）。widget 里那是导航会白屏，
  浏览器里那只是慢 —— **两边都变好了，没有一边是迁就**。
- **`/graph-scene.js` 这类绝对说明符改成相对的。** 它们本来靠面板服务器喂；改完
  `tsconfig.panel.json` 里那条 `paths` 变通也一起删了。

### 两处「没有就说没有」，都带测试

- 每个阶段一律显示**没在跑** —— 第 1 步没有执行通道，这是事实不是占位。
- `blocked` 给 **null** —— 它是「现在派发会被哪条预检拒」，插件还不能派发，
  这个问题没有答案。编一个「可以派」会让人按下去然后撞墙。

### 还没接上的路径（明着 501，不静默）

`/api/run`、`/api/ask`、`/api/answer`、`/api/waive`、`/api/brief*`、`/api/rubric`、
`/api/artifact`、`/api/stage-*`、`/api/graph*`、`/api/progress`、`/api/terminal`。

前面几条要执行通道（第 3 步）；产物、图谱、rubric 那几条是**纯读，接得上，只是还没接**
—— 那是下一轮最省力的收益。

### 欠的一笔：产物可见性

现在 `pnpm plugin` **直接写进 `~/.codex/plugins/…`**，以迭代速度为准（用户 2026-08-18 定）。
代价是产物不在仓库里、不进 review。**下一步该改成先输出到 `dist/plugin/`，再由一条
单独的命令安装。** 在那之前，「装到哪、装了什么」只有 `scripts/plugin-build.ts` 知道。

另外提示词模板现在被装到**版本目录的上一级**（`…/stagepass/prompts/`），因为
`domain/phase-template.ts` 在模块加载时就按 `join(HERE, "..", "prompts")` 去读。
那是当下的事实不是设计 —— 等它能被注入基准路径，这段就该改成装进版本目录里。

## 六、下一步（按依赖顺序）

### ~~第 1 步 · 砍掉 4173 依赖~~ —— 已完成，见上

### 第 2 步 · 版式按 ~700px 重新设计

现在的窄版（`src/plugin/widget/widget.css`，作用域 `html.sp-widget`）**已经落库**，
但它仍然是「把三列压扁」：整个三列面板的 DOM 和 JS 都还带着，只是用 CSS 收起了两列。

真正的「彻底适配」应该从「环 + 状态 + 判据」出发按 700px 重新设计。判据：**打开
widget 时不该有任何一块是「为了另一种宽度存在的」**。

### 第 3 步 · 执行通道切到 app-server

`AppServerSession` 已经能 `thread/start` + `turn/start` + 流式 + 审批转发。要做的是
把 `PanelSessions` / pty / TUI transport 那条链从主路上摘下来。

**一个必须先想清楚的**：审批归**订阅者**。非订阅连接发 `turn/start` 收不到审批请求 ——
这正好意味着**审批落到 App（人）手里**，是我们要的。但如果人还没打开那条线程，
就没人接审批，turn 会挂住。要么给 StagePass 起的 turn 设 `approvalPolicy`，要么
先让人打开。**这条没验过。**

### 第 4 步 · Claude 客户端预留

MCP server 是两边共用那一层，差别只在 widget 怎么渲染。所以**别把 `openai/*` 那套
`_meta` 写死在领域接口上**，把「渲染表面」和「领域接口」分开。

## 七、还没解决的

- **海战小游戏那个目录在 App 里点开是空的** —— 连带 `threadSource:"user"` 的新线程
  也没出现。数据上那个目录只有 `source=cli` 的会话（都是从终端开的），一条 App
  开的都没有，**怀疑那个文件夹压根没被 App 登记成 project**。用户说先不管。
- **实验留下 5 条测试线程**（都是那句「插件开的」），等用户定归档还是删：
  `01a01512`(海战)、`01a01506`、`01a014fc`(stagepass)、`01a014f6`、`01a014ef`(海战)。
- **`sp_api` 的项目解析没被真机验到** —— 按 Codex 工作目录认项目那段写完了，但用户
  最后一次是复用了 App 恢复的旧卡（没产生新的 `tools/call`），所以那段代码一次都没跑过。

## 八、机器上现在开着什么

| 端口 / 位置 | 是什么 | 要不要留 |
|---|---|---|
| 4188 | 面板副本（已停）| 插件不再需要它 —— 数据直接读库 |
| 4399 | widget 本地沙箱（`harness.html`） | 迭代 widget 时要 |
| 47311 | widget 回传兜底口 | 同上 |
| 4173 | **用户自己的面板** | 没动过 |
| `~/.codex/plugins/cache/stagepass-local/stagepass/0.0.1/` | 装着的插件（server.mjs + widget/） | 主战场 |
| scratchpad `wb/` | 只剩本地沙箱（`harness.html` + 桥替身）| 构建脚本 / prelude / widget.css **都已落库**，这里只是沙箱 |
